const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// A single room. Max 2 participants, ever.
const room = new Map(); // id -> ws

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcastOthers(selfId, msg) {
  for (const [id, peer] of room) {
    if (id !== selfId) send(peer, msg);
  }
}

wss.on('connection', (ws) => {
  if (room.size >= 2) {
    send(ws, { type: 'room-full' });
    ws.close();
    return;
  }

  const id = crypto.randomUUID();
  room.set(id, ws);
  ws.id = id;

  // Tell the newcomer whether a peer is already waiting.
  send(ws, { type: 'welcome', id, peerPresent: room.size === 2 });
  // Tell the existing peer someone joined, so it can start the offer.
  broadcastOthers(id, { type: 'peer-joined' });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    // Relay signaling messages (offer/answer/ice-candidate) to the other peer only.
    broadcastOthers(id, msg);
  });

  ws.on('close', () => {
    room.delete(id);
    broadcastOthers(id, { type: 'peer-left' });
  });
});

server.listen(PORT, () => {
  console.log(`Family video call server running at http://localhost:${PORT}`);
});
