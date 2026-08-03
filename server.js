const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const push = require('./push');

const PORT = process.env.PORT || 3000;
// Set this in the hosting dashboard, never in the repo — the repo is public.
const FAMILY_CODE = (process.env.FAMILY_CODE || '').trim();
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const MAX_MESSAGES = 1000;

if (!FAMILY_CODE) {
  console.warn(
    'WARNING: FAMILY_CODE is not set. Nobody can sign in until you add it ' +
    'as an environment variable on your host.'
  );
}

// ---------------------------------------------------------------- storage --

let data = { users: {}, messages: [], push: {} };

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      data.users = raw.users || {};
      data.messages = Array.isArray(raw.messages) ? raw.messages : [];
      data.push = raw.push || {};
    }
  } catch (err) {
    console.error('Could not read data file, starting fresh:', err.message);
  }
}

let saveTimer = null;
function saveData() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(data));
    } catch (err) {
      console.error('Could not save data:', err.message);
    }
  }, 500);
}

loadData();

// ------------------------------------------------------------ live state --

const sockets = new Map(); // userId -> Set<ws>   (a person may have several devices)
const inCall = new Map(); // userId -> peerId
const ringing = new Map(); // calleeId -> callerId

function isOnline(userId) {
  const set = sockets.get(userId);
  return !!set && set.size > 0;
}

function roster() {
  return Object.values(data.users).map((user) => ({
    id: user.id,
    name: user.name,
    online: isOnline(user.id),
    busy: inCall.has(user.id)
  }));
}

function sendTo(userId, msg) {
  const set = sockets.get(userId);
  if (!set) return false;
  const payload = JSON.stringify(msg);
  let delivered = false;
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) {
      ws.send(payload);
      delivered = true;
    }
  }
  return delivered;
}

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  for (const set of sockets.values()) {
    for (const ws of set) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }
}

function broadcastRoster() {
  broadcast({ type: 'roster', users: roster() });
}

function historyFor(userId) {
  return data.messages.filter((m) => m.from === userId || m.to === userId);
}

// ------------------------------------------------------------ push subs --

function subsFor(userId) {
  if (!data.push[userId]) data.push[userId] = { web: [], fcm: [] };
  const subs = data.push[userId];
  if (!Array.isArray(subs.web)) subs.web = [];
  if (!Array.isArray(subs.fcm)) subs.fcm = [];
  return subs;
}

function addSubscription(userId, msg) {
  const subs = subsFor(userId);

  if (msg.kind === 'web' && msg.subscription && msg.subscription.endpoint) {
    const already = subs.web.some((s) => s.endpoint === msg.subscription.endpoint);
    if (!already) subs.web.push(msg.subscription);
  } else if (msg.kind === 'fcm' && typeof msg.token === 'string' && msg.token) {
    if (!subs.fcm.includes(msg.token)) subs.fcm.push(msg.token);
  } else {
    return;
  }
  saveData();
}

function removeSubscription(userId, msg) {
  const subs = subsFor(userId);
  if (msg.kind === 'web' && msg.endpoint) {
    subs.web = subs.web.filter((s) => s.endpoint !== msg.endpoint);
  } else if (msg.kind === 'fcm' && msg.token) {
    subs.fcm = subs.fcm.filter((t) => t !== msg.token);
  }
  saveData();
}

function pruneSubscriptions(userId, dead) {
  const subs = subsFor(userId);
  if (dead.web.length) {
    subs.web = subs.web.filter((s) => !dead.web.includes(s.endpoint));
  }
  if (dead.fcm.length) {
    subs.fcm = subs.fcm.filter((t) => !dead.fcm.includes(t));
  }
  saveData();
}

function pushToUser(userId, payload) {
  if (!push.isConfigured()) return;
  const subs = subsFor(userId);
  if (!subs.web.length && !subs.fcm.length) return;
  push
    .sendToSubscriptions(subs, payload, (dead) => pruneSubscriptions(userId, dead))
    .catch((err) => console.warn('Push send failed:', err.message));
}

// Drop the other side of a call, whatever state it was in.
function clearCall(userId, reason) {
  const peerId = inCall.get(userId);
  if (peerId) {
    inCall.delete(userId);
    inCall.delete(peerId);
    sendTo(peerId, { type: 'call-ended', from: userId, reason });
  }

  // If this user was ringing someone (or being rung), cancel that too.
  for (const [callee, caller] of ringing) {
    if (callee === userId || caller === userId) {
      ringing.delete(callee);
      clearRingTimeout(callee);
      const other = callee === userId ? caller : callee;
      sendTo(other, { type: 'call-ended', from: userId, reason });
    }
  }
}

// ------------------------------------------------------------- websocket --

push.init();

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/push-config', (_req, res) => res.json(push.publicConfig()));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.userId = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'auth') return handleAuth(ws, msg);
    if (!ws.userId) return; // everything else requires a signed-in socket

    switch (msg.type) {
      case 'rename':
        return handleRename(ws, msg);
      case 'message':
        return handleMessage(ws, msg);
      case 'mark-read':
        return handleMarkRead(ws, msg);
      case 'call-invite':
        return handleCallInvite(ws, msg);
      case 'call-accept':
        return handleCallAccept(ws, msg);
      case 'call-decline':
        return handleCallDecline(ws, msg);
      case 'call-cancel':
      case 'call-end':
        return clearCall(ws.userId, msg.type);
      case 'signal':
        return handleSignal(ws, msg);
      case 'push-subscribe':
        return addSubscription(ws.userId, msg);
      case 'push-unsubscribe':
        return removeSubscription(ws.userId, msg);
    }
  });

  ws.on('close', () => {
    const userId = ws.userId;
    if (!userId) return;

    const set = sockets.get(userId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) sockets.delete(userId);
    }

    // Only tear the call down when their last device disconnects.
    if (!isOnline(userId)) {
      clearCall(userId, 'disconnected');
      broadcastRoster();
    }
  });
});

function handleAuth(ws, msg) {
  if (!FAMILY_CODE) {
    return sendWs(ws, {
      type: 'auth-error',
      reason: 'This server has no family passcode set up yet.'
    });
  }
  if ((msg.code || '').trim() !== FAMILY_CODE) {
    return sendWs(ws, { type: 'auth-error', reason: 'Wrong family passcode.' });
  }

  const name = (msg.name || '').trim().slice(0, 40);
  if (!name) {
    return sendWs(ws, { type: 'auth-error', reason: 'Please enter your name.' });
  }

  // Returning devices send the id they were given the first time. If that is
  // gone (reinstall, cleared data, new phone) fall back to matching on name so
  // the same person keeps one identity and their history, instead of turning
  // into a second contact card.
  let userId = typeof msg.userId === 'string' && data.users[msg.userId]
    ? msg.userId
    : null;

  if (!userId) {
    const existing = Object.values(data.users).find(
      (u) => u.name.toLowerCase() === name.toLowerCase()
    );
    userId = existing ? existing.id : crypto.randomUUID();
  }

  data.users[userId] = {
    id: userId,
    name,
    createdAt: data.users[userId]?.createdAt || Date.now()
  };
  saveData();

  ws.userId = userId;
  if (!sockets.has(userId)) sockets.set(userId, new Set());
  sockets.get(userId).add(ws);

  sendWs(ws, {
    type: 'auth-ok',
    you: data.users[userId],
    users: roster(),
    messages: historyFor(userId),
    pushConfig: push.publicConfig()
  });

  // Woken by a call notification: the call is still waiting, so ring now.
  const pendingCaller = ringing.get(userId);
  if (pendingCaller && data.users[pendingCaller]) {
    sendWs(ws, {
      type: 'incoming-call',
      from: pendingCaller,
      name: data.users[pendingCaller].name
    });
  }

  broadcastRoster();
}

function handleRename(ws, msg) {
  const name = (msg.name || '').trim().slice(0, 40);
  if (!name) return;
  data.users[ws.userId].name = name;
  saveData();
  broadcastRoster();
}

function handleMessage(ws, msg) {
  const text = (msg.text || '').trim().slice(0, 4000);
  if (!text || !data.users[msg.to]) return;

  const message = {
    id: crypto.randomUUID(),
    from: ws.userId,
    to: msg.to,
    text,
    ts: Date.now(),
    read: false
  };

  data.messages.push(message);
  if (data.messages.length > MAX_MESSAGES) {
    data.messages = data.messages.slice(-MAX_MESSAGES);
  }
  saveData();

  sendTo(msg.to, { type: 'message', message });
  sendTo(ws.userId, { type: 'message', message }); // echo to all my devices

  // Their app is shut — reach them through the phone's notification system.
  if (!isOnline(msg.to)) {
    pushToUser(msg.to, {
      type: 'message',
      title: data.users[ws.userId].name,
      body: text.length > 120 ? text.slice(0, 117) + '…' : text,
      fromId: ws.userId,
      fromName: data.users[ws.userId].name
    });
  }
}

function handleMarkRead(ws, msg) {
  let changed = false;
  for (const m of data.messages) {
    if (m.to === ws.userId && m.from === msg.from && !m.read) {
      m.read = true;
      changed = true;
    }
  }
  if (changed) {
    saveData();
    sendTo(msg.from, { type: 'read-receipt', by: ws.userId });
  }
}

function handleCallInvite(ws, msg) {
  const target = msg.to;
  if (!data.users[target] || target === ws.userId) return;

  if (inCall.has(target) || ringing.has(target)) {
    return sendWs(ws, { type: 'call-busy', target });
  }
  if (inCall.has(ws.userId)) return;

  const online = isOnline(target);
  const hasPush = subsFor(target).web.length > 0 || subsFor(target).fcm.length > 0;

  // With no live app and no way to wake the phone, there is nothing to ring.
  if (!online && !(hasPush && push.isConfigured())) {
    return sendWs(ws, { type: 'call-unavailable', target });
  }

  ringing.set(target, ws.userId);
  scheduleRingTimeout(target);

  if (online) {
    sendTo(target, {
      type: 'incoming-call',
      from: ws.userId,
      name: data.users[ws.userId].name
    });
  }

  // Always push for calls: the app may be holding a stale socket while it is
  // actually backgrounded, in which case the in-app ring is never seen.
  pushToUser(target, {
    type: 'call',
    title: 'Incoming call',
    body: `${data.users[ws.userId].name} is calling you`,
    fromId: ws.userId,
    fromName: data.users[ws.userId].name
  });

  sendWs(ws, { type: 'call-ringing', target });
}

// Stop a call ringing forever when nobody picks up.
const RING_TIMEOUT_MS = 45000;
const ringTimers = new Map();

function scheduleRingTimeout(calleeId) {
  clearRingTimeout(calleeId);
  ringTimers.set(
    calleeId,
    setTimeout(() => {
      const callerId = ringing.get(calleeId);
      if (!callerId) return;
      ringing.delete(calleeId);
      ringTimers.delete(calleeId);
      sendTo(callerId, { type: 'call-ended', from: calleeId, reason: 'no-answer' });
      sendTo(calleeId, { type: 'call-ended', from: callerId, reason: 'no-answer' });
    }, RING_TIMEOUT_MS)
  );
}

function clearRingTimeout(calleeId) {
  const timer = ringTimers.get(calleeId);
  if (timer) {
    clearTimeout(timer);
    ringTimers.delete(calleeId);
  }
}

function handleCallAccept(ws, msg) {
  const callerId = ringing.get(ws.userId);
  if (!callerId || callerId !== msg.to) return;

  // The caller may have hung up while the callee's phone was waking up.
  if (!isOnline(callerId)) {
    ringing.delete(ws.userId);
    clearRingTimeout(ws.userId);
    return sendWs(ws, { type: 'call-ended', from: callerId, reason: 'caller-gone' });
  }

  ringing.delete(ws.userId);
  clearRingTimeout(ws.userId);
  inCall.set(ws.userId, callerId);
  inCall.set(callerId, ws.userId);

  sendTo(callerId, { type: 'call-accepted', from: ws.userId });
  broadcastRoster();
}

function handleCallDecline(ws, msg) {
  const callerId = ringing.get(ws.userId);
  if (!callerId) return;
  ringing.delete(ws.userId);
  clearRingTimeout(ws.userId);
  sendTo(callerId, { type: 'call-declined', from: ws.userId });
}

// Relay WebRTC offer/answer/ICE, but only between two people already paired up.
function handleSignal(ws, msg) {
  const peerId = inCall.get(ws.userId);
  if (!peerId || peerId !== msg.to) return;
  sendTo(msg.to, { type: 'signal', from: ws.userId, payload: msg.payload });
}

function sendWs(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

server.listen(PORT, () => {
  console.log(`Family call server running on port ${PORT}`);
});
