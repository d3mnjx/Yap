// Interop for the retained Blazor pages (Login, Settings, Admin and their layout).
// Chat rendering, composition, media and delivery live in /chat-client/.

// Client locale detection (timezone + language)
window.getClientLocaleInfo = () => ({
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: navigator.language
});

// Welcome page: attach click handler to #yap-enter element
// Supports optional .welcome-bg transition (grayscale → color) before navigating
window.setupWelcomePage = (dotNetRef) => {
    const el = document.getElementById('yap-enter');
    if (!el) return;

    el.style.cursor = 'pointer';
    const handleClick = () => {
        el.removeEventListener('click', handleClick);

        const bg = document.querySelector('.welcome-bg');
        if (bg) {
            el.classList.add('lit');
            bg.classList.add('awaken');
            setTimeout(() => dotNetRef.invokeMethodAsync('OnEnterClicked'), 2200);
        } else {
            dotNetRef.invokeMethodAsync('OnEnterClicked');
        }
    };
    el.addEventListener('click', handleClick);
};


// Last real user input in this tab. The latency probe reports "seconds since input" every tick so
// the server derives presence (auto-away) from what the user actually does — not from circuit
// traffic, which the probe itself would otherwise keep "active" forever.
let lastInputTs = performance.now();
['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'].forEach((ev) =>
    document.addEventListener(ev, () => { lastInputTs = performance.now(); }, { capture: true, passive: true }));


window.isPageVisible = () => document.visibilityState === 'visible';


window.setAppBadge = async (count) => {
    if ('setAppBadge' in navigator) {
        try {
            // iOS requires notification permission for badges (only prompt inside PWA)
            if (window.isPwaInstalled() && 'Notification' in window && Notification.permission === 'default') {
                await Notification.requestPermission();
            }

            if (count > 0) {
                await navigator.setAppBadge(count);
            } else {
                await navigator.clearAppBadge();
            }
            return true;
        } catch (e) {
            console.warn('[PWA] Badge update failed:', e);
            return false;
        }
    }
    return false;
};

// ==========================================
// Push Notification Subscription
// ==========================================

// Check if push is supported
window.isPushSupported = () => {
    return 'PushManager' in window && 'serviceWorker' in navigator;
};

// Get current notification permission
window.getNotificationPermission = () => {
    if (!('Notification' in window)) return 'unsupported';
    return Notification.permission;
};

// Request notification permission
window.requestNotificationPermission = async () => {
    if (!('Notification' in window)) return 'unsupported';
    try {
        const result = await Notification.requestPermission();
        console.log('[Push] Permission result:', result);
        return result;
    } catch (e) {
        console.error('[Push] Permission request failed:', e);
        return 'error';
    }
};

// Check if app is installed as PWA
window.isPwaInstalled = () => {
    return window.matchMedia('(display-mode: standalone)').matches ||
           window.navigator.standalone === true;
};

window.getLastPwaRoute = () => {
    if (!window.isPwaInstalled()) return null;
    return localStorage.getItem('yap-last-route');
};

// PWA Install Banner helpers
window.isMessageInputFocused = () => {
    return document.activeElement?.classList.contains('message-input') === true;
};

window.shouldShowPwaInstallBanner = () => {
    if (window.isPwaInstalled()) return false;
    if (sessionStorage.getItem('pwa-banner-dismissed')) return false;
    return true;
};

window.dismissPwaInstallBanner = () => {
    sessionStorage.setItem('pwa-banner-dismissed', 'true');
};

// Push permission prompt (full-page overlay for PWA users)
window.shouldShowPushPermissionPrompt = () => {
    if (!window.isPwaInstalled()) return false;
    if (!window.isPushSupported()) return false;
    // Already granted or denied — no point showing
    if ('Notification' in window && Notification.permission !== 'default') return false;
    // Dismissed 3+ times — stop asking
    const dismissCount = parseInt(localStorage.getItem('push-prompt-dismiss-count') || '0');
    if (dismissCount >= 3) return false;
    return true;
};

window.dismissPushPermissionPrompt = () => {
    const count = parseInt(localStorage.getItem('push-prompt-dismiss-count') || '0');
    localStorage.setItem('push-prompt-dismiss-count', String(count + 1));
};

// Submit a hidden POST form. The browser navigates, so the endpoint can set the auth cookie
// (a Blazor circuit can't) and secrets stay out of the URL. Used by the passphrase page and
// by the invite / login-link page.
window.postForm = (action, fields) => {
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = action;
    form.style.display = 'none';

    for (const [name, value] of Object.entries(fields)) {
        if (value == null) continue;
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = name;
        input.value = value;
        form.appendChild(input);
    }

    document.body.appendChild(form);
    form.submit();
};

window.submitSigninForm = (username, password, returnUrl) =>
    window.postForm('/auth/signin', { username, password, returnUrl });

// Capture native install prompt (Chrome/Edge on desktop & Android)
let _deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    _deferredInstallPrompt = e;
});

window.showPwaInstallGuide = async () => {
    sessionStorage.setItem('pwa-banner-dismissed', 'true');

    // Use native prompt if available (desktop Chrome/Edge, Android Chrome)
    if (_deferredInstallPrompt) {
        _deferredInstallPrompt.prompt();
        const result = await _deferredInstallPrompt.userChoice;
        console.log('[PWA] Install prompt result:', result.outcome);
        _deferredInstallPrompt = null;
        return;
    }

    // Fallback: show add-to-homescreen guide (iOS Safari, etc.)
    const cdnBase = 'https://cdn.jsdelivr.net/gh/philfung/add-to-homescreen@3.5/dist';

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = cdnBase + '/add-to-homescreen.min.css';
    document.head.appendChild(link);

    const script = document.createElement('script');
    script.src = cdnBase + '/add-to-homescreen.min.js';
    script.onload = () => {
        if (window.AddToHomeScreen) {
            const instance = window.AddToHomeScreen({
                appName: 'Yap',
                appIconUrl: 'icon-192.png',
                assetUrl: cdnBase + '/assets/img/',
                allowClose: false,
                showArrow: true
            });
            instance.show('en');
        }
    };
    document.body.appendChild(script);
};

// Subscribe to push notifications
window.subscribeToPush = async (vapidPublicKey) => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        console.warn('[Push] Push not supported');
        return null;
    }

    try {
        const registration = await navigator.serviceWorker.ready;
        const convertedKey = urlBase64ToUint8Array(vapidPublicKey);

        // Check for existing subscription
        let subscription = await registration.pushManager.getSubscription();

        // If an existing subscription was created with a DIFFERENT applicationServerKey (e.g. the
        // server's VAPID key was rotated/fixed), it can never receive pushes signed by the new key.
        // Drop it and re-subscribe so users migrate automatically with no action on their part.
        if (subscription && !applicationServerKeyMatches(subscription, convertedKey)) {
            console.log('[Push] VAPID key changed — re-subscribing with the new key');
            try { await subscription.unsubscribe(); } catch (e) { console.warn('[Push] old unsubscribe failed', e); }
            subscription = null;
        }

        if (!subscription) {
            subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: convertedKey
            });
            console.log('[Push] New subscription created');
        } else {
            console.log('[Push] Using existing subscription');
        }

        // Return subscription as JSON string
        window.__lastPushError = null;
        const subJson = subscription.toJSON();
        return JSON.stringify({
            endpoint: subJson.endpoint,
            p256dh: subJson.keys.p256dh,
            auth: subJson.keys.auth
        });
    } catch (e) {
        console.error('[Push] Subscription failed:', e);
        window.__lastPushError = e ? `${e.name || 'Error'}: ${e.message || e}` : 'unknown error';
        return null;
    }
};

// Blazor reads this after a null subscribeToPush result. The DOMException text is the only
// clue that separates "this browser cannot reach its push service" from a bug of ours.
window.getLastPushError = () => window.__lastPushError || null;

// Unsubscribe from push notifications
window.unsubscribeFromPush = async () => {
    try {
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();

        if (subscription) {
            await subscription.unsubscribe();
            console.log('[Push] Unsubscribed');
            return true;
        }
        return false;
    } catch (e) {
        console.error('[Push] Unsubscribe failed:', e);
        return false;
    }
};

// Get current push subscription
window.getPushSubscription = async () => {
    try {
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();

        if (subscription) {
            const subJson = subscription.toJSON();
            return JSON.stringify({
                endpoint: subJson.endpoint,
                p256dh: subJson.keys.p256dh,
                auth: subJson.keys.auth
            });
        }
        return null;
    } catch (e) {
        console.error('[Push] Get subscription failed:', e);
        return null;
    }
};

// Helper: true if the subscription was created with the given applicationServerKey.
// If the browser doesn't expose options.applicationServerKey, assume a match so we never
// churn a working subscription on a browser that simply can't tell us what key it used.
function applicationServerKeyMatches(subscription, expectedKeyBytes) {
    try {
        const current = subscription.options && subscription.options.applicationServerKey;
        if (!current) return true;
        const actual = new Uint8Array(current);
        if (actual.length !== expectedKeyBytes.length) return false;
        for (let i = 0; i < actual.length; i++) {
            if (actual[i] !== expectedKeyBytes[i]) return false;
        }
        return true;
    } catch (e) {
        return true;
    }
}

// Helper: Convert VAPID key to Uint8Array
function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding)
        .replace(/-/g, '+')
        .replace(/_/g, '/');

    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);

    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

// Listen for notification clicks from service worker
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data?.type === 'NOTIFICATION_CLICK' && event.data?.url) {
            // Navigate to the URL from notification
            window.location.href = event.data.url;
        }
    });
}


// Jump to a settings anchor. Blazor does not act on a URL fragment for content that renders
// after navigation, so the page asks for the scroll once it has drawn the target.
window.scrollToElementId = (id) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
};


// Theme switching
// ==========================================

window.applyTheme = (themeId) => {
    window.yapAppearance.apply({ ...window.yapAppearance.current, theme: themeId });
    // Retint the phone's status bar / browser chrome (owned by appearance.js).
    window.syncThemeColorMeta?.();
};

// Root font size: scales every rem-based size in the app. Clearing the inline
// style (null/0) falls back to the browser default (16px).
window.applyFontSize = (px) => {
    window.yapAppearance.apply({ ...window.yapAppearance.current, fontSize: px });
};

// Circuit heartbeat/RTT for retained Blazor pages. Chat has its own presence owner.
let telemetryRef = null;

window.setupLatencyProbe = (dotNetRef) => {
    telemetryRef = dotNetRef;

    if (window._yapProbeTimer) clearInterval(window._yapProbeTimer);
    let lastRtt = null;

    const ping = () => {
        // Heartbeat + measurement in one call: visibility and input-idle keep the server's
        // per-session presence truthful even in tabs that never fire a visibilitychange event.
        // RTT is only measured while visible — hidden tabs get throttled timers, garbage samples.
        const visible = document.visibilityState === 'visible';
        const idleSeconds = Math.round((performance.now() - lastInputTs) / 1000);
        const t0 = performance.now();
        telemetryRef.invokeMethodAsync('ProbePing', lastRtt, visible, idleSeconds)
            .then(() => { lastRtt = visible ? Math.round(performance.now() - t0) : null; })
            .catch(() => { lastRtt = null; }); // circuit down — keep ticking, reporting resumes with the circuit
    };

    window._yapProbeTimer = setInterval(ping, 10000);
    ping();
};
