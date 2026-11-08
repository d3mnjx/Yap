// The server's build against this page's: the strip that asks for a reload (SH-20, OF-04) and the fresh load that
// gets the new build (OF-18). main.js shows the strip and fresh-loads a page not loaded yet (SH-50); the Settings
// page shows the version and has a button for the same move (ST-28).
import { state, on, setUpdateAvailable, clearUpdateAvailable } from './store.js';
import * as router from './router.js';

// The build this page runs: the server writes it into the page (ShellEndpoints, data-build).
export const build = document.documentElement.dataset.build;

// A new build on the server: the strip asks for a reload and nothing reloads by itself. Only the server's answer
// sets buildStamp: start() drops the stamp from the stored copy (main.js, OF-04), because that stamp names the build
// at the device's last connection, not the server's build now. Until the hub answers, there is no stamp and no strip.
on('config', () => {
  const server = state.config?.buildStamp;
  if (!server || !build) return;
  if (server !== build) { notice('You are awesome and so is the new version of this app. Please refresh.', 'Reload', reloadForNewBuild); setUpdateAvailable(); }
  else if (state.updateAvailable) { document.getElementById('notice').hidden = true; clearUpdateAvailable(); }
});

// The page of the new build comes from the server, not from the worker. The shell is cache-first (OF-18): a plain
// reload asks the worker, and a worker that did not update answers with the old page and the strip again. On
// 2026-10-30 an iPhone's installed app did exactly that through every Reload tap after a deploy, while the same code
// updated in Chrome; iOS gave no reason. The worker passes '/' and the login paths to the server (service-worker.js
// SERVER_FIRST), every worker since 2026-10-22 included, so the new page arrives whatever the worker did, and the
// route is kept for the router (SH-43). Before the move the page asks the browser for the update and gives the new
// worker up to 15 s to take over, so the common case finds the new shell cache in place. Every worker promise is
// bounded: navigator.serviceWorker.ready has hung on iOS before (push.js), and a tap must end in a page. The strip
// changes at the tap, because a button that does nothing reads as broken (SH-51).
const SERVER_FIRST = /^\/(?:login|verify\/[^/]+|invite\/[^/]+)?$/;   // the worker's own list; keep the two the same
export async function reloadForNewBuild() {
  notice('Getting the new version…', 'Updating…');
  document.querySelector('#notice .notice-action').disabled = true;   // the page reloads next, so nothing enables it again
  const within = (promise, ms) => Promise.race([promise, new Promise(r => setTimeout(r, ms))]);
  const reg = 'serviceWorker' in navigator ? await within(navigator.serviceWorker.getRegistration().catch(() => null), 3000) : null;
  if (reg) {
    await within(reg.update().catch(() => {}), 10_000);
    if (reg.installing || reg.waiting) await within(new Promise(r => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true })), 15_000);
  }
  const route = router.current.path + (router.current.hash ? `#${router.current.hash}` : '');
  if (SERVER_FIRST.test(router.current.path)) { location.replace(route); return; }
  router.keepForFreshLoad(route);
  location.replace('/');
}

function notice(text, action, onAction) {
  const strip = document.getElementById('notice');
  strip.querySelector('.notice-text').textContent = text;
  const button = strip.querySelector('.notice-action');
  button.textContent = action ?? '';
  button.onclick = onAction ?? null;
  strip.hidden = false;
}
