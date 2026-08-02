const statusScreen = document.getElementById('status-screen');
const statusText = document.getElementById('status-text');
const callScreen = document.getElementById('call-screen');
const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');
const micBtn = document.getElementById('mic-btn');
const camBtn = document.getElementById('cam-btn');
const hangupBtn = document.getElementById('hangup-btn');

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

let ws;
let pc;
let localStream;
let isOfferer = false;
let ended = false;

function setStatus(text) {
  statusText.textContent = text;
}

function showCallScreen() {
  statusScreen.classList.add('hidden');
  callScreen.classList.remove('hidden');
}

function showStatusScreen(text) {
  callScreen.classList.add('hidden');
  statusScreen.classList.remove('hidden');
  setStatus(text);
}

async function start() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
  } catch (err) {
    setStatus('Could not access camera/microphone: ' + err.message);
    return;
  }
  connectSignaling();
}

function connectSignaling() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => setStatus('Waiting for your family member to join…');

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === 'room-full') {
      setStatus('This call already has 2 people. Try again later.');
      return;
    }

    if (msg.type === 'welcome') {
      if (msg.peerPresent) {
        setStatus('Family member found. Connecting…');
        isOfferer = true;
        await createPeerConnection();
        await makeOffer();
      }
      return;
    }

    if (msg.type === 'peer-joined') {
      setStatus('Family member joined. Connecting…');
      return;
    }

    if (msg.type === 'peer-left') {
      setStatus('The other person left the call.');
      teardownPeerConnection();
      return;
    }

    if (msg.type === 'offer') {
      isOfferer = false;
      await createPeerConnection();
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      ws.send(JSON.stringify({ type: 'answer', sdp: pc.localDescription }));
      return;
    }

    if (msg.type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      return;
    }

    if (msg.type === 'ice-candidate') {
      if (msg.candidate && pc) {
        try {
          await pc.addIceCandidate(msg.candidate);
        } catch (err) {
          console.error('Failed to add ICE candidate', err);
        }
      }
      return;
    }
  };

  ws.onclose = () => {
    if (!ended) setStatus('Disconnected from server.');
  };
}

async function createPeerConnection() {
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      ws.send(JSON.stringify({ type: 'ice-candidate', candidate: event.candidate }));
    }
  };

  pc.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];
    showCallScreen();
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      showCallScreen();
    } else if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
      if (!ended) showStatusScreen('Connection lost. Waiting to reconnect…');
    }
  };
}

async function makeOffer() {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  ws.send(JSON.stringify({ type: 'offer', sdp: pc.localDescription }));
}

function teardownPeerConnection() {
  if (pc) {
    pc.close();
    pc = null;
  }
  remoteVideo.srcObject = null;
  showStatusScreen('Waiting for your family member to join…');
}

micBtn.addEventListener('click', () => {
  const track = localStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  micBtn.classList.toggle('off', !track.enabled);
  micBtn.textContent = track.enabled ? '🎤' : '🔇';
});

camBtn.addEventListener('click', () => {
  const track = localStream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  camBtn.classList.toggle('off', !track.enabled);
  camBtn.textContent = track.enabled ? '📷' : '🚫';
});

hangupBtn.addEventListener('click', () => {
  ended = true;
  if (pc) pc.close();
  if (ws) ws.close();
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  showStatusScreen('Call ended. You can close this tab.');
});

start();
