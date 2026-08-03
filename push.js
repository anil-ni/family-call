/* Push delivery for people whose app is closed or in the background.
 *
 * Two mechanisms, because the two phones need different things:
 *   - Web Push (VAPID) reaches the iPhone home-screen app and any browser.
 *   - Firebase Cloud Messaging reaches the installed Android app.
 *
 * Everything here degrades quietly: if the credentials are not configured the
 * app still works, it just falls back to alerts while the app is open.
 */

const webpush = require('web-push');

const VAPID_PUBLIC_KEY = (process.env.VAPID_PUBLIC_KEY || '').trim();
const VAPID_PRIVATE_KEY = (process.env.VAPID_PRIVATE_KEY || '').trim();
const VAPID_SUBJECT = (process.env.VAPID_SUBJECT || 'mailto:family@example.com').trim();
const FIREBASE_SERVICE_ACCOUNT = (process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();

let webPushReady = false;
let fcm = null;

function init() {
  if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    try {
      webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
      webPushReady = true;
      console.log('Web push enabled (iPhone home-screen app, browsers).');
    } catch (err) {
      console.error('Web push disabled — bad VAPID keys:', err.message);
    }
  } else {
    console.log('Web push disabled — VAPID keys not set.');
  }

  if (FIREBASE_SERVICE_ACCOUNT) {
    try {
      const admin = require('firebase-admin');
      const credential = JSON.parse(FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({ credential: admin.credential.cert(credential) });
      fcm = admin.messaging();
      console.log('Firebase push enabled (Android app).');
    } catch (err) {
      console.error('Firebase push disabled — bad service account:', err.message);
    }
  } else {
    console.log('Firebase push disabled — FIREBASE_SERVICE_ACCOUNT not set.');
  }
}

function publicConfig() {
  return { vapidPublicKey: webPushReady ? VAPID_PUBLIC_KEY : null };
}

/* `subs` is the stored shape: { web: [subscription], fcm: [token] }.
 * `onPrune` is called with the subscriptions that the push services told us
 * are dead, so the caller can drop them from storage. */
async function sendToSubscriptions(subs, payload, onPrune) {
  const dead = { web: [], fcm: [] };
  const jobs = [];

  if (webPushReady && subs.web) {
    for (const sub of subs.web) {
      jobs.push(
        webpush.sendNotification(sub, JSON.stringify(payload)).catch((err) => {
          // 404/410 mean the browser threw the subscription away.
          if (err.statusCode === 404 || err.statusCode === 410) {
            dead.web.push(sub.endpoint);
          } else {
            console.warn('Web push failed:', err.statusCode || err.message);
          }
        })
      );
    }
  }

  if (fcm && subs.fcm) {
    for (const token of subs.fcm) {
      jobs.push(
        fcm
          .send({
            token,
            notification: { title: payload.title, body: payload.body },
            data: {
              type: String(payload.type || ''),
              fromId: String(payload.fromId || ''),
              fromName: String(payload.fromName || '')
            },
            android: {
              priority: 'high',
              notification: {
                channelId: payload.type === 'call' ? 'calls' : 'messages',
                sound: 'default',
                priority: 'max'
              }
            }
          })
          .catch((err) => {
            const code = err.errorInfo && err.errorInfo.code;
            if (
              code === 'messaging/registration-token-not-registered' ||
              code === 'messaging/invalid-registration-token'
            ) {
              dead.fcm.push(token);
            } else {
              console.warn('FCM push failed:', code || err.message);
            }
          })
      );
    }
  }

  await Promise.all(jobs);
  if ((dead.web.length || dead.fcm.length) && onPrune) onPrune(dead);
}

function isConfigured() {
  return webPushReady || !!fcm;
}

module.exports = { init, publicConfig, sendToSubscriptions, isConfigured };
