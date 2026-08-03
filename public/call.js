/* WebRTC peer connection handling.
   Audio and video travel directly between the two devices; the server only
   carries the offer/answer/ICE handshake. */

(function (global) {
  // STUN alone only helps both sides discover their public address. When a
  // network refuses direct peer traffic — many workplaces, and mobile carriers
  // that put customers behind shared NAT — the call needs a TURN relay to pass
  // through instead. The server tells us which ones to use.
  const FALLBACK_ICE = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];

  let iceServers = FALLBACK_ICE;
  let pc = null;
  let localStream = null;
  let peerId = null;
  let pendingSignals = [];
  let handlers = {};

  function configure(opts) {
    handlers = opts;
  }

  function setIceServers(servers) {
    iceServers = Array.isArray(servers) && servers.length ? servers : FALLBACK_ICE;
  }

  function hasRelay() {
    return iceServers.some((s) => {
      const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
      return urls.some((u) => typeof u === 'string' && u.startsWith('turn'));
    });
  }

  async function getLocalStream() {
    if (localStream) return localStream;
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user' },
      audio: { echoCancellation: true, noiseSuppression: true }
    });
    return localStream;
  }

  async function setup(targetId, isCaller) {
    peerId = targetId;
    pendingSignals = [];

    const stream = await getLocalStream();
    if (handlers.onLocalStream) handlers.onLocalStream(stream);

    pc = new RTCPeerConnection({
      iceServers,
      iceCandidatePoolSize: 4
    });
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        handlers.onSignal(peerId, { candidate: event.candidate });
      }
    };

    pc.ontrack = (event) => {
      if (handlers.onRemoteStream) handlers.onRemoteStream(event.streams[0]);
    };

    pc.onconnectionstatechange = () => {
      if (!pc) return;
      if (handlers.onStateChange) handlers.onStateChange(pc.connectionState);
    };

    // Signals that arrived before the connection existed.
    for (const payload of pendingSignals) await handleSignal(payload);
    pendingSignals = [];

    if (isCaller) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      handlers.onSignal(peerId, { sdp: pc.localDescription });
    }
  }

  async function handleSignal(payload) {
    if (!pc) {
      pendingSignals.push(payload);
      return;
    }

    if (payload.sdp) {
      await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
      if (payload.sdp.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        handlers.onSignal(peerId, { sdp: pc.localDescription });
      }
    } else if (payload.candidate) {
      try {
        await pc.addIceCandidate(payload.candidate);
      } catch (err) {
        console.warn('Could not add ICE candidate', err);
      }
    }
  }

  function toggleAudio() {
    const track = localStream && localStream.getAudioTracks()[0];
    if (!track) return true;
    track.enabled = !track.enabled;
    return track.enabled;
  }

  function toggleVideo() {
    const track = localStream && localStream.getVideoTracks()[0];
    if (!track) return true;
    track.enabled = !track.enabled;
    return track.enabled;
  }

  function stop() {
    if (pc) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      pc.close();
      pc = null;
    }
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    peerId = null;
    pendingSignals = [];
  }

  global.FamilyCallRTC = {
    configure,
    setIceServers,
    hasRelay,
    setup,
    handleSignal,
    toggleAudio,
    toggleVideo,
    stop,
    getLocalStream
  };
})(window);
