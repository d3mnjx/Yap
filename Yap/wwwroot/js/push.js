// The push subscription of this device (NT-23, NT-24): subscribe with the server's key, tell the server,
// unsubscribe, and the prompt of the installed app (SH-38, SH-39). The old chat.js helpers, as a module.

import { api } from './api.js';
import { state, projectName } from './store.js';

const DISMISSALS = 'yap.pushPromptDismissals';

export const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
export const permission = () => (supported() ? Notification.permission : 'unsupported');
export const installed = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

// Where the person is, for the words of the Settings card and of the fix for a block (ST-17). The card speaks of what
// the person sees: a phone treats the installed app like any other app, a browser on an iPhone cannot show
// notifications at all, and a browser on a computer shows a pop-up. iPadOS reports a Mac; the touch points tell.
export function where() {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const android = !ios && /Android/.test(ua);
  const device = ios ? (/iPhone|iPod/.test(ua) ? 'iPhone' : 'iPad') : android ? 'phone' : 'computer';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\/|FxiOS/.test(ua) ? 'Firefox' : /Chrome\/|CriOS/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'This browser';
  return { ios, android, phone: ios || android, installed: installed(), device, browser };
}

// Only the installed app can show notifications on an iPhone or iPad (NT-23); elsewhere it is an old or locked-down browser.
function cannotHint() {
  const w = where(), name = projectName();
  return w.ios ? `${w.browser} cannot show ${name} notifications. Add ${name} to your home screen first.` : 'This browser cannot show notifications.';
}

// After a block, the steps that allow notifications again, for the place where that switch lives. The installed app
// has its own entry in the phone's Settings, like any other app; a browser keeps the switch at the address bar.
export function blockedHint() {
  const w = where(), name = projectName();
  if (w.installed && w.ios) return `Notifications for ${name} are turned off on this ${w.device}. Open the Settings app, tap Notifications, scroll to ${name}, and turn on Allow Notifications. Then come back here and tap Turn on.`;
  if (w.installed && w.android) return `Notifications for ${name} are turned off on this phone. Press and hold the ${name} icon on your home screen, tap App info, tap Notifications, and turn them on. Then come back here and tap Turn on.`;
  if (w.installed) return `Notifications for ${name} are turned off. Click the three dots at the top of the ${name} window, choose App info, set Notifications to Allow, and open the app again.`;
  if (w.android) return 'Notifications are blocked for this site. Tap the lock icon next to the address, tap Permissions, then Notifications, and choose Allow. Then reload this page.';
  if (w.browser === 'Firefox') return 'Notifications are blocked for this site. Click the icon on the left of the address bar, remove the Blocked entry next to Notifications, and reload this page.';
  if (w.browser === 'Safari') return 'Notifications are blocked for this site. In the Safari menu, open Settings, then Websites, then Notifications. Set this site to Allow and reload this page.';
  return 'Notifications are blocked for this site. Click the icon on the left of the address bar, set Notifications to Allow, and reload this page.';
}

function keyBytes(value) {
  const padded = value + '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}

// True when the subscription was made with this key. A browser that hides the key counts as a match,
// so a working subscription is never dropped for nothing.
function sameKey(subscription, bytes) {
  try {
    const current = subscription.options?.applicationServerKey;
    if (!current) return true;
    const actual = new Uint8Array(current);
    return actual.length === bytes.length && actual.every((b, i) => b === bytes[i]);
  } catch { return true; }
}

// navigator.serviceWorker.ready never settles when the registration failed (main.js swallows that error), and a
// sign-out waits on this call: after a short wait, "no subscription" is the answer.
export async function current() {
  if (!supported()) return null;
  try {
    const registration = await Promise.race([navigator.serviceWorker.ready, new Promise(r => setTimeout(r, 3000))]);
    return registration ? await registration.pushManager.getSubscription() : null;
  } catch { return null; }
}

// Subscribes (or keeps a subscription made with the same key) and registers it with the server.
// Returns { ok } or { ok: false, reason }.
export async function subscribe() {
  if (!supported()) return { ok: false, reason: cannotHint() };
  const key = state.config?.vapidPublicKey;
  if (!key) return { ok: false, reason: 'Notifications are not set up on this server.' };
  if (Notification.permission === 'denied') return { ok: false, reason: blockedHint() };
  if (Notification.permission !== 'granted') {
    const answer = await Notification.requestPermission();
    if (answer !== 'granted') return { ok: false, reason: 'Notifications stay off. You closed the question without choosing Allow.' };
  }
  const bytes = keyBytes(key);
  let subscription;
  try {
    const registration = await navigator.serviceWorker.ready;
    subscription = await registration.pushManager.getSubscription();
    if (subscription && !sameKey(subscription, bytes)) { await subscription.unsubscribe().catch(() => {}); subscription = null; }   // a rotated server key
    subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
  } catch (e) {
    const text = e ? `${e.name || 'Error'}: ${e.message || e}` : 'unknown error';
    return { ok: false, reason: `This browser could not reach its notification service (${text}). A firewall or an ad blocker can cause this. In Brave, turn on "Use Google services for push messaging".` };
  }
  const json = subscription.toJSON();
  try { await api.post('/api/push/subscribe', { username: state.user.username, endpoint: json.endpoint, p256dh: json.keys?.p256dh, auth: json.keys?.auth }); }
  catch (e) { return { ok: false, reason: e.message }; }
  return { ok: true, endpoint: json.endpoint };
}

// Ends push for this device only; the other devices stay subscribed (NT-24).
export async function unsubscribe() {
  const subscription = await current();
  if (!subscription) return false;
  try { await api.post('/api/push/unsubscribe', { endpoint: subscription.endpoint }); } catch { /* the server prunes a dead one later */ }
  try { await subscription.unsubscribe(); } catch { /* already gone */ }
  return true;
}

// ---- the prompt of the installed app (SH-38, SH-39, NT-31) ----

export function promptWanted() {
  if (!installed() || !supported() || !state.config?.vapidPublicKey) return false;
  if (Notification.permission !== 'default') return false;
  return dismissals() < 3;
}

function dismissals() { try { return Number(localStorage.getItem(DISMISSALS) ?? 0); } catch { return 3; } }
export function dismissPrompt() { try { localStorage.setItem(DISMISSALS, String(dismissals() + 1)); } catch { /* private mode */ } }
