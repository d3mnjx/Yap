// Signing in and out, as the client sees it: the bootstrap after a sign-in, the clean-up after a sign-out
// (GEN-05), and the return to the link the person wanted (SH-42).

import { api } from './api.js';
import * as hub from './hub.js';
import * as store from './store.js';
import * as router from './router.js';
import * as snapshot from './offline/snapshot.js';
import * as sender from './sender.js';
import * as push from './push.js';

const RETURN_TO = 'yap.returnTo';

// The tabs of one device share the cookie, so a sign-out or an account switch in one tab is one in all of them
// (GEN-05, AU-25). 'ended' goes out before the cookie changes: the other tabs stop their hub connection and their
// outbox at once, and nothing is sent under the next account's name. 'started' follows a sign-in: the other tabs
// load the account that holds the cookie now.
const tabs = 'BroadcastChannel' in self ? new BroadcastChannel('yap-session') : null;
tabs?.addEventListener('message', e => {
  if (e.data === 'ended' && store.state.user) signedOut();
  else if (e.data === 'started' && !store.state.user) signedIn({ tell: false });
});

export function rememberReturnTo(path) { try { sessionStorage.setItem(RETURN_TO, path); } catch { /* private mode */ } }

function takeReturnTo() {
  try { const p = sessionStorage.getItem(RETURN_TO); sessionStorage.removeItem(RETURN_TO); return p; } catch { return null; }
}

// After a successful sign-in: the full bootstrap, the hub, and the page the person came for.
export async function signedIn({ tell = true } = {}) {
  const doc = await api.get('/api/bootstrap');
  if (!doc.user) return false;
  setNotice(null);   // back in: the login page has nothing to say next time (AU-21)
  store.applyBootstrap(doc);
  hub.resume();
  hub.connect();
  router.navigate(takeReturnTo() || '/', { replace: true });
  if (tell) tabs?.postMessage('started');
  return true;
}

// The note of a sign-out from elsewhere (AU-21) stays until the next sign-in, not until the first login page: the
// clean-up of signedOut mounts that page twice (store.reset() sends the chat page to /lobby, the route guard sends it
// on to /login, then signedOut navigates once more), and a note taken by the first mount was lost. It also sits in
// sessionStorage: a tab from before a deploy loads the login page fresh (SH-50), and the note must survive that.
const NOTICE_KEY = 'yap.signInNotice';
let notice = null;
export const signInNotice = () => { try { return notice ?? sessionStorage.getItem(NOTICE_KEY); } catch { return notice; } };
const setNotice = value => { notice = value; try { if (value) sessionStorage.setItem(NOTICE_KEY, value); else sessionStorage.removeItem(NOTICE_KEY); } catch {} };
// The pictures and videos of the account's conversations, which the worker keeps for reading offline (GEN-05, OF-16).
// The name is the worker's MEDIA_CACHE without its version, as in the DEBUG INFO card. The emoji images and the
// app's own files stay: they belong to no account. `caches` is missing outside a secure context.
function clearMedia() {
  return globalThis.caches?.keys()
    .then(names => Promise.all(names.filter(n => n.startsWith('yap-media')).map(n => caches.delete(n))))
    .catch(() => {});
}

// The cookie is gone, here or elsewhere: stop the hub, forget the account's data on this device, show the login.
// `elsewhere` is a sign-out this device did not ask for: sign-out-others, or a cookie that died while the device
// was away. The login page then says so (AU-21).
export function signedOut({ elsewhere = false } = {}) {
  if (!store.state.user && router.current.page === 'login') return;   // done already: a 401 or an 'ended' that lands during the clean-up must not run it twice
  if (elsewhere) setNotice('elsewhere');
  hub.stop();
  store.reset();
  snapshot.clearAll();
  sender.clearAll();
  clearMedia();
  if (router.current.page !== 'login') {
    if (['chat', 'settings', 'channel-settings', 'admin'].includes(router.current.page)) rememberReturnTo(router.current.path);
    router.navigate('/login', { replace: true });
  } else router.navigate(router.current.path, { replace: true });   // redraw the login page in the signed-out state
}

// Before a different account signs in on this device: its data goes, the page stays (AU-25).
export async function forgetAccount() {
  tabs?.postMessage('ended');
  hub.stop();
  store.reset();
  await snapshot.clearAll();
  await sender.clearAll();
  await clearMedia();
}

// Sign Out in the status menu (SH-15). The confirmations are the caller's; this does the work. Returns false
// when the server could not be told: the cookie is HttpOnly, so only the server's answer removes it, and a
// local clean-up alone would bring the account back at the next reload (AU-22). A 401 means it is gone already.
export async function signOut() {
  const sub = await push.current();
  try { await api.post('/api/auth/signout', { pushEndpoint: sub?.endpoint ?? null, deviceId: hub.deviceId() }); }
  catch (e) { if (e.status !== 401) return false; }
  // The server ended this device's hub connections with the sign-out. Stop the hub before anything else, or its
  // retry would get 401 and report a sign-out from elsewhere (AU-21).
  hub.stop();
  tabs?.postMessage('ended');   // now, not after the unsubscribe: the other tabs' hub retries get 401 meanwhile and would read a sign-out from elsewhere (AU-21)
  // The server removed the push subscription in the same request (NT-24); only the browser's half is left. Not
  // push.unsubscribe(): its POST would get 401 now that the cookie is gone, and run the clean-up a second time.
  if (sub) await sub.unsubscribe().catch(() => {});
  signedOut();                         // the last route stays: a device convenience (GEN-05)
  return true;
}
