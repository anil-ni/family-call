/* Which servers the browsers should use to find a path to each other.
 *
 * STUN is enough on most home networks. It is not enough when a network
 * refuses direct peer-to-peer traffic, which is common on workplace wi-fi and
 * on mobile carriers that put many customers behind one shared address. In
 * those cases the call has to be relayed through a TURN server instead.
 *
 * TURN is configured through environment variables so credentials never enter
 * the repository:
 *   TURN_URLS       comma separated, e.g.
 *                   turn:example.com:3478?transport=udp,turns:example.com:443?transport=tcp
 *   TURN_USERNAME
 *   TURN_CREDENTIAL
 */

const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

const TURN_URLS = (process.env.TURN_URLS || '')
  .split(',')
  .map((u) => u.trim())
  .filter(Boolean);
const TURN_USERNAME = (process.env.TURN_USERNAME || '').trim();
const TURN_CREDENTIAL = (process.env.TURN_CREDENTIAL || '').trim();

function hasTurn() {
  return TURN_URLS.length > 0 && !!TURN_USERNAME && !!TURN_CREDENTIAL;
}

function iceServers() {
  const servers = [...STUN_SERVERS];
  if (hasTurn()) {
    servers.push({
      urls: TURN_URLS,
      username: TURN_USERNAME,
      credential: TURN_CREDENTIAL
    });
  }
  return servers;
}

function describe() {
  if (hasTurn()) {
    const overTls = TURN_URLS.some((u) => u.startsWith('turns:') || u.includes('443'));
    return (
      `Call relay enabled (${TURN_URLS.length} TURN url(s))` +
      (overTls ? ', including TLS/443 for restrictive networks.' : '.')
    );
  }
  return 'No TURN relay configured — calls will fail on networks that block ' +
    'direct peer-to-peer traffic.';
}

module.exports = { iceServers, hasTurn, describe };
