const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

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

let data = { users: {}, messages: [] };

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      data.users = raw.users || {};
      data.messages = Array.isArray(raw.messages) ? raw.messages : [];
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
      const other = callee === userId ? caller : callee;
      sendTo(other, { type: 'call-ended', from: userId, reason });
    }
  }
}

// ------------------------------------------------------------- websocket --

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

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
    messages: historyFor(userId)
  });
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

  if (!isOnline(target)) {
    return sendWs(ws, { type: 'call-unavailable', target });
  }
  if (inCall.has(target) || ringing.has(target)) {
    return sendWs(ws, { type: 'call-busy', target });
  }
  if (inCall.has(ws.userId)) return;

  ringing.set(target, ws.userId);
  sendTo(target, {
    type: 'incoming-call',
    from: ws.userId,
    name: data.users[ws.userId].name
  });
  sendWs(ws, { type: 'call-ringing', target });
}

function handleCallAccept(ws, msg) {
  const callerId = ringing.get(ws.userId);
  if (!callerId || callerId !== msg.to) return;

  ringing.delete(ws.userId);
  inCall.set(ws.userId, callerId);
  inCall.set(callerId, ws.userId);

  sendTo(callerId, { type: 'call-accepted', from: ws.userId });
  broadcastRoster();
}

function handleCallDecline(ws, msg) {
  const callerId = ringing.get(ws.userId);
  if (!callerId) return;
  ringing.delete(ws.userId);
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
