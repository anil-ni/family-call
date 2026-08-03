/* Registers this device to receive notifications while the app is closed.
 *
 * On the installed Android app this goes through Firebase; everywhere else
 * (iPhone home-screen app, desktop browsers) it uses the Web Push standard.
 * Both end up handing the server something it can push to later. */

(function (global) {
  let send = null;
  let vapidPublicKey = null;

  function isNative() {
    return !!(global.Capacitor &&
      global.Capacitor.isNativePlatform &&
      global.Capacitor.isNativePlatform());
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
  }

  function configure(opts) {
    send = opts.send;
  }

  function setPushConfig(config) {
    vapidPublicKey = config && config.vapidPublicKey;
  }

  // ------------------------------------------------------------- native --

  async function registerNative() {
    const Push = global.Capacitor.Plugins.PushNotifications;
    if (!Push) return { ok: false, reason: 'Push plugin unavailable.' };

    let status = await Push.checkPermissions();
    if (status.receive === 'prompt' || status.receive === 'prompt-with-rationale') {
      status = await Push.requestPermissions();
    }
    if (status.receive !== 'granted') {
      return { ok: false, reason: 'Notification permission was declined.' };
    }

    return new Promise((resolve) => {
      let settled = false;

      Push.addListener('registration', (token) => {
        if (settled) return;
        settled = true;
        send({ type: 'push-subscribe', kind: 'fcm', token: token.value });
        resolve({ ok: true });
      });

      Push.addListener('registrationError', (err) => {
        if (settled) return;
        settled = true;
        resolve({ ok: false, reason: 'Firebase registration failed: ' + (err.error || '') });
      });

      Push.register();

      setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve({ ok: false, reason: 'Firebase did not respond — is google-services.json set up?' });
        }
      }, 12000);
    });
  }

  // ---------------------------------------------------------------- web --

  async function registerWeb() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      return { ok: false, reason: 'This browser cannot receive background notifications.' };
    }
    if (!vapidPublicKey) {
      return { ok: false, reason: 'Server has no push keys configured yet.' };
    }

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      return { ok: false, reason: 'Notification permission was declined.' };
    }

    const registration = await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;

    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey)
      });
    }

    send({ type: 'push-subscribe', kind: 'web', subscription: subscription.toJSON() });
    return { ok: true };
  }

  async function enable() {
    try {
      return isNative() ? await registerNative() : await registerWeb();
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  // Quietly re-register on later launches so the token stays fresh.
  async function refresh() {
    if (isNative()) {
      const Push = global.Capacitor.Plugins.PushNotifications;
      if (!Push) return;
      const status = await Push.checkPermissions();
      if (status.receive === 'granted') await registerNative();
      return;
    }

    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    if (Notification.permission !== 'granted' || !vapidPublicKey) return;
    await registerWeb();
  }

  function supported() {
    if (isNative()) return true;
    return 'serviceWorker' in navigator && 'PushManager' in window;
  }

  global.FamilyCallPush = { configure, setPushConfig, enable, refresh, supported, isNative };
})(window);
