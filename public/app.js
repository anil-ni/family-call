/* Family Call — app shell: sign-in, contacts, chat and call flow. */

const $ = (id) => document.getElementById(id);

const STORE_KEY = 'familycall.identity';

const state = {
  me: null,
  code: null,
  users: [],
  messages: [],
  openChatWith: null,
  incomingFrom: null,
  callingTo: null,
  activePeer: null,
  ws: null,
  reconnectDelay: 1000
};

// ------------------------------------------------------------- helpers --

function serverOrigin() {
  const native = window.Capacitor &&
    window.Capacitor.isNativePlatform &&
    window.Capacitor.isNativePlatform();
  if (native && window.FAMILY_CALL_SERVER) return window.FAMILY_CALL_SERVER;
  return location.origin;
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach((el) => {
    el.classList.toggle('hidden', el.id !== id);
  });
}

function userById(id) {
  return state.users.find((u) => u.id === id);
}

function initials(name) {
  return (name || '?').trim().charAt(0).toUpperCase();
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDay(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function send(msg) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(msg));
  }
}

// ------------------------------------------------------- ringtone/alerts --

const ringer = (() => {
  let ctx = null;
  let timer = null;

  function beep() {
    if (!ctx) return;
    const now = ctx.currentTime;
    [0, 0.4].forEach((offset) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 620;
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.25, now + offset + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.32);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.35);
    });
  }

  return {
    start() {
      try {
        if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (ctx.state === 'suspended') ctx.resume();
        beep();
        timer = setInterval(() => {
          beep();
          if (navigator.vibrate) navigator.vibrate([400, 200, 400]);
        }, 2000);
        if (navigator.vibrate) navigator.vibrate([400, 200, 400]);
      } catch (err) {
        console.warn('Ringtone unavailable', err);
      }
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      if (navigator.vibrate) navigator.vibrate(0);
    }
  };
})();

function notify(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible') return;
  try {
    new Notification(title, { body, icon: 'icon-192.png', tag: 'family-call' });
  } catch (err) {
    console.warn('Notification failed', err);
  }
}

// --------------------------------------------------------------- signin --

function loadIdentity() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
  } catch {
    return null;
  }
}

function saveIdentity(identity) {
  localStorage.setItem(STORE_KEY, JSON.stringify(identity));
}

$('setup-btn').addEventListener('click', () => {
  const name = $('setup-name').value.trim();
  const code = $('setup-code').value.trim();
  if (!name || !code) {
    $('setup-error').textContent = 'Enter both your name and the passcode.';
    return;
  }
  $('setup-error').textContent = '';
  $('setup-btn').disabled = true;
  state.code = code;
  connect({ name, code, userId: loadIdentity()?.userId || null });
});

$('setup-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('setup-btn').click();
});

// ----------------------------------------------------------- connection --

function connect(credentials) {
  // Never leave a previous socket running: switching between wi-fi and mobile
  // data can otherwise stack connections, which duplicates every message.
  if (state.ws) {
    state.ws.onclose = null;
    state.ws.onmessage = null;
    state.ws.onerror = null;
    try { state.ws.close(); } catch { /* already closing */ }
  }

  const url = serverOrigin().replace(/^http/, 'ws');
  const ws = new WebSocket(url);
  state.ws = ws;

  ws.onopen = () => {
    $('connection-state').textContent = 'Connected';
    ws.send(JSON.stringify({
      type: 'auth',
      name: credentials.name,
      code: credentials.code,
      userId: credentials.userId
    }));
  };

  ws.onmessage = (event) => handleServerMessage(JSON.parse(event.data));

  ws.onclose = () => {
    if (state.ws !== ws) return; // superseded by a newer connection
    $('connection-state').textContent = 'Reconnecting…';
    if (!state.me) {
      $('setup-btn').disabled = false;
      return;
    }
    setTimeout(() => {
      connect({ name: state.me.name, code: state.code, userId: state.me.id });
    }, state.reconnectDelay);
    state.reconnectDelay = Math.min(state.reconnectDelay * 1.6, 15000);
  };

  ws.onerror = () => {
    if (!state.me) {
      $('setup-error').textContent = 'Could not reach the server. Try again.';
      $('setup-btn').disabled = false;
    }
  };
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'auth-ok': {
      state.me = msg.you;
      state.users = msg.users;
      state.messages = msg.messages;
      state.reconnectDelay = 1000;
      FamilyCallPush.setPushConfig(msg.pushConfig);
      FamilyCallPush.refresh();
      saveIdentity({ userId: msg.you.id, name: msg.you.name, code: state.code });
      $('me-name').textContent = msg.you.name;
      $('connection-state').textContent = 'Connected';
      $('setup-btn').disabled = false;
      renderContacts();
      showScreen('contacts-screen');
      if (pendingFocusId) {
        const target = pendingFocusId;
        pendingFocusId = null;
        focusFrom(target);
      }
      break;
    }

    case 'auth-error':
      $('setup-error').textContent = msg.reason;
      $('setup-btn').disabled = false;
      localStorage.removeItem(STORE_KEY);
      state.me = null;
      showScreen('setup-screen');
      break;

    case 'roster':
      state.users = msg.users;
      renderContacts();
      if (state.openChatWith) renderChatHeader();
      break;

    case 'message': {
      if (state.messages.some((m) => m.id === msg.message.id)) break;
      state.messages.push(msg.message);
      const fromOther = msg.message.from !== state.me.id;
      if (fromOther && state.openChatWith === msg.message.from) {
        send({ type: 'mark-read', from: msg.message.from });
        msg.message.read = true;
      } else if (fromOther) {
        const sender = userById(msg.message.from);
        notify(sender ? sender.name : 'Family', msg.message.text);
        if (navigator.vibrate) navigator.vibrate(180);
      }
      if (state.openChatWith) renderMessages();
      renderContacts();
      break;
    }

    case 'read-receipt':
      state.messages.forEach((m) => {
        if (m.to === msg.by && m.from === state.me.id) m.read = true;
      });
      if (state.openChatWith === msg.by) renderMessages();
      break;

    case 'incoming-call':
      onIncomingCall(msg);
      break;

    case 'call-ringing':
      $('calling-status').textContent = 'Ringing…';
      break;

    case 'call-accepted':
      startCall(msg.from, true);
      break;

    case 'call-declined':
      endCall('Call declined');
      break;

    case 'call-busy':
      endCall('They are already on another call');
      break;

    case 'call-unavailable':
      endCall('They are not online right now');
      break;

    case 'call-ended':
      endCall('Call ended');
      break;

    case 'signal':
      if (msg.from === state.activePeer) FamilyCallRTC.handleSignal(msg.payload);
      break;
  }
}

// ------------------------------------------------------------ contacts --

function unreadFrom(userId) {
  return state.messages.filter(
    (m) => m.from === userId && m.to === state.me.id && !m.read
  ).length;
}

function lastMessageWith(userId) {
  const thread = state.messages.filter(
    (m) => (m.from === userId && m.to === state.me.id) ||
           (m.to === userId && m.from === state.me.id)
  );
  return thread[thread.length - 1] || null;
}

function renderContacts() {
  const list = $('contact-list');
  const others = state.users.filter((u) => u.id !== state.me.id);
  list.innerHTML = '';
  $('contacts-empty').classList.toggle('hidden', others.length > 0);

  others
    .slice()
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))
    .forEach((user) => {
      const unread = unreadFrom(user.id);
      const last = lastMessageWith(user.id);
      const sub = last
        ? (last.from === state.me.id ? 'You: ' : '') + last.text
        : (user.busy ? 'On another call' : user.online ? 'Online' : 'Offline');

      const li = document.createElement('li');
      li.className = 'contact';
      li.innerHTML = `
        <div class="avatar">${initials(user.name)}</div>
        <div class="contact-main">
          <div class="contact-name">${escapeHtml(user.name)}</div>
          <div class="contact-sub">${escapeHtml(sub)}</div>
        </div>
        ${unread ? `<span class="badge">${unread}</span>` : ''}
        <span class="status-dot ${user.busy ? 'busy' : user.online ? 'online' : ''}"></span>
      `;
      li.addEventListener('click', () => openChat(user.id));
      list.appendChild(li);
    });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------------------------------------------------------------- chat --

function openChat(userId) {
  state.openChatWith = userId;
  send({ type: 'mark-read', from: userId });
  state.messages.forEach((m) => {
    if (m.from === userId && m.to === state.me.id) m.read = true;
  });
  renderChatHeader();
  renderMessages();
  showScreen('chat-screen');
  $('chat-input').focus();
}

function renderChatHeader() {
  const user = userById(state.openChatWith);
  if (!user) return;
  $('chat-title').textContent = user.name;
  $('chat-presence').textContent = user.busy
    ? 'On another call'
    : user.online ? 'Online' : 'Offline';
}

function renderMessages() {
  const box = $('message-list');
  const thread = state.messages
    .filter((m) => (m.from === state.openChatWith && m.to === state.me.id) ||
                   (m.to === state.openChatWith && m.from === state.me.id))
    .sort((a, b) => a.ts - b.ts);

  box.innerHTML = '';
  let lastDay = null;

  thread.forEach((m) => {
    const day = formatDay(m.ts);
    if (day !== lastDay) {
      const divider = document.createElement('div');
      divider.className = 'day-divider';
      divider.textContent = day;
      box.appendChild(divider);
      lastDay = day;
    }

    const bubble = document.createElement('div');
    bubble.className = 'bubble ' + (m.from === state.me.id ? 'mine' : 'theirs');
    bubble.innerHTML =
      escapeHtml(m.text) +
      `<span class="bubble-time">${formatTime(m.ts)}` +
      (m.from === state.me.id && m.read ? ' ✓✓' : '') +
      '</span>';
    box.appendChild(bubble);
  });

  box.scrollTop = box.scrollHeight;
}

$('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('chat-input').value.trim();
  if (!text || !state.openChatWith) return;
  send({ type: 'message', to: state.openChatWith, text });
  $('chat-input').value = '';
});

$('chat-back').addEventListener('click', () => {
  state.openChatWith = null;
  renderContacts();
  showScreen('contacts-screen');
});

$('chat-call-btn').addEventListener('click', () => {
  if (state.openChatWith) placeCall(state.openChatWith);
});

// ---------------------------------------------------------------- calls --

function placeCall(targetId) {
  const user = userById(targetId);
  if (!user) return;
  state.callingTo = targetId;
  $('calling-name').textContent = user.name;
  $('calling-avatar').textContent = initials(user.name);
  $('calling-status').textContent = 'Calling…';
  showScreen('calling-screen');
  send({ type: 'call-invite', to: targetId });
}

function onIncomingCall(msg) {
  // Already busy elsewhere — let the server-side busy check handle the rest.
  if (state.activePeer) return;
  state.incomingFrom = msg.from;
  $('incoming-name').textContent = msg.name;
  $('incoming-avatar').textContent = initials(msg.name);
  showScreen('incoming-screen');
  ringer.start();
  notify('Incoming call', `${msg.name} is calling you`);
}

$('accept-btn').addEventListener('click', () => {
  ringer.stop();
  const from = state.incomingFrom;
  state.incomingFrom = null;
  send({ type: 'call-accept', to: from });
  startCall(from, false);
});

$('decline-btn').addEventListener('click', () => {
  ringer.stop();
  send({ type: 'call-decline', to: state.incomingFrom });
  state.incomingFrom = null;
  showScreen('contacts-screen');
});

$('cancel-call-btn').addEventListener('click', () => {
  send({ type: 'call-cancel', to: state.callingTo });
  endCall(null);
});

$('hangup-btn').addEventListener('click', () => {
  send({ type: 'call-end', to: state.activePeer });
  endCall(null);
});

async function startCall(peerId, isCaller) {
  state.activePeer = peerId;
  state.callingTo = null;
  const user = userById(peerId);
  $('call-banner').textContent = `Connecting to ${user ? user.name : 'family'}…`;
  $('call-banner').classList.remove('hidden');
  showScreen('call-screen');

  try {
    await FamilyCallRTC.setup(peerId, isCaller);
  } catch (err) {
    endCall('Could not start camera or microphone: ' + err.message);
  }
}

function endCall(reason) {
  ringer.stop();
  FamilyCallRTC.stop();
  state.activePeer = null;
  state.callingTo = null;
  state.incomingFrom = null;
  $('remote-video').srcObject = null;
  $('local-video').srcObject = null;

  if (reason) {
    $('calling-status').textContent = reason;
    setTimeout(() => {
      if (!state.activePeer) showScreen('contacts-screen');
    }, 1600);
    showScreen('calling-screen');
  } else {
    showScreen('contacts-screen');
  }
  renderContacts();
}

FamilyCallRTC.configure({
  onSignal: (to, payload) => send({ type: 'signal', to, payload }),
  onLocalStream: (stream) => { $('local-video').srcObject = stream; },
  onRemoteStream: (stream) => {
    $('remote-video').srcObject = stream;
    $('call-banner').classList.add('hidden');
  },
  onStateChange: (connState) => {
    if (connState === 'connected') {
      $('call-banner').classList.add('hidden');
    } else if (connState === 'failed') {
      endCall('Connection failed — try again');
    }
  }
});

$('mic-btn').addEventListener('click', () => {
  const on = FamilyCallRTC.toggleAudio();
  $('mic-btn').classList.toggle('off', !on);
  $('mic-btn').textContent = on ? '🎤' : '🔇';
});

$('cam-btn').addEventListener('click', () => {
  const on = FamilyCallRTC.toggleVideo();
  $('cam-btn').classList.toggle('off', !on);
  $('cam-btn').textContent = on ? '📷' : '🚫';
});

// ------------------------------------------------------------ settings --

$('settings-btn').addEventListener('click', () => {
  $('settings-name').value = state.me.name;
  $('share-url').value = serverOrigin();
  updateNotifState();
  showScreen('settings-screen');
});

$('settings-back').addEventListener('click', () => showScreen('contacts-screen'));

$('save-name-btn').addEventListener('click', () => {
  const name = $('settings-name').value.trim();
  if (!name) return;
  send({ type: 'rename', name });
  state.me.name = name;
  $('me-name').textContent = name;
  saveIdentity({ userId: state.me.id, name, code: state.code });
});

$('copy-url-btn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('share-url').value);
    $('copy-url-btn').textContent = 'Copied';
    setTimeout(() => { $('copy-url-btn').textContent = 'Copy'; }, 1500);
  } catch {
    $('share-url').select();
  }
});

function updateNotifState(message) {
  if (message) {
    $('notif-state').textContent = message;
    return;
  }
  if (!FamilyCallPush.supported()) {
    $('notif-state').textContent =
      'This browser cannot show notifications while the app is closed. ' +
      'On iPhone, add the app to your home screen first.';
    $('enable-notifs-btn').disabled = true;
    return;
  }
  const perm = ('Notification' in window) ? Notification.permission : 'default';
  if (perm === 'granted') {
    $('notif-state').textContent =
      'Notifications are on — you will be alerted even when the app is closed.';
    $('enable-notifs-btn').textContent = 'Re-register this device';
    $('enable-notifs-btn').disabled = false;
  } else if (perm === 'denied') {
    $('notif-state').textContent =
      'Blocked. Turn notifications back on for this app in your phone settings.';
    $('enable-notifs-btn').disabled = true;
  } else {
    $('notif-state').textContent =
      'Turn these on so calls and messages reach you when the app is closed.';
    $('enable-notifs-btn').disabled = false;
  }
}

$('enable-notifs-btn').addEventListener('click', async () => {
  $('enable-notifs-btn').disabled = true;
  updateNotifState('Setting up…');
  const result = await FamilyCallPush.enable();
  updateNotifState(
    result.ok
      ? 'Notifications are on — you will be alerted even when the app is closed.'
      : 'Could not turn on notifications: ' + result.reason
  );
  $('enable-notifs-btn').disabled = false;
});

$('sign-out-btn').addEventListener('click', () => {
  localStorage.removeItem(STORE_KEY);
  location.reload();
});

// ---------------------------------------------------- notification taps --

FamilyCallPush.configure({ send });

// Set when the app is launched cold from a notification, and consumed once
// sign-in finishes and the contact list actually exists.
let pendingFocusId = new URLSearchParams(location.search).get('from');

// Tapping a notification should land on the conversation it was about. An
// incoming call needs no help: the ring screen appears once we reconnect.
function focusFrom(fromId) {
  if (!fromId || !state.me) return;
  if (state.incomingFrom || state.activePeer) return;
  if (userById(fromId)) openChat(fromId);
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    const msg = event.data || {};
    if (msg.type === 'notification-click') focusFrom(msg.data && msg.data.fromId);
  });
}

if (FamilyCallPush.isNative() && window.Capacitor.Plugins.PushNotifications) {
  const Push = window.Capacitor.Plugins.PushNotifications;
  Push.addListener('pushNotificationActionPerformed', (action) => {
    const data = (action.notification && action.notification.data) || {};
    pendingFocusId = data.fromId || null;
    focusFrom(pendingFocusId);
  });
}

// --------------------------------------------------------------- start --

(function boot() {
  const saved = loadIdentity();
  $('share-url').value = serverOrigin();
  if (saved && saved.name && saved.code) {
    state.code = saved.code;
    $('setup-name').value = saved.name;
    connect({ name: saved.name, code: saved.code, userId: saved.userId });
  } else {
    showScreen('setup-screen');
  }
})();
