// Installing Yap (OF-01, SH-40): the install dialog, the browser's own prompt when it offers one, and the
// add-to-home-screen guide for browsers without a prompt (iOS Safari). The guide library is loaded from the
// CDN only when the guide is needed.

import { el } from './render/dom.js';
import * as overlays from './ui/overlays.js';
import { installed } from './push.js';
import { projectName } from './store.js';

let deferredPrompt = null;   // the browser's install prompt, kept until the person asks (Chromium)
addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredPrompt = e; });

// The install guide is another project's script, and it runs in this page with the person's sign-in. So the URL
// names one commit (the one of the tag 3.5; a tag can move, a commit cannot), and the browser checks the bytes
// against the hashes below before it runs or applies them. A new version of the guide needs a new commit AND new hashes:
//   curl -s <url> | openssl dgst -sha384 -binary | openssl base64 -A
const GUIDE_CDN = 'https://cdn.jsdelivr.net/gh/philfung/add-to-homescreen@1033167baf095bb1fbe3b19f4e609e3b418eff88/dist';
const GUIDE_SCRIPT_HASH = 'sha384-6/A3whvakEx697GhdLzQEVYH+vfp9KbTOgY6LzQUJbmm3sSBDz3ztz6ZbObZj9Ct';
const GUIDE_STYLE_HASH = 'sha384-PIkABVwl02o9piowBl3l7xC3cKa3Yz8VZ4KN3sM6f157TIOWj61AZTrKJoPbGYDw';

// The dialog: first how to replace an older install, then the browser's install or the guide (SH-40).
export function openInstallDialog() {
  const already = installed();
  const card = el('div', { class: 'push-prompt-card install-dialog', role: 'dialog', 'aria-modal': 'true' },
    el('h2', { class: 'push-prompt-heading' }, already ? `${projectName()} is already installed` : `Add ${projectName()} to your home screen`),
    el('p', { class: 'push-prompt-body' }, already
      ? 'Keep using this app. You do not need to install it again.'
      : `Already have a ${projectName()} icon? Open it to keep using your app. To replace an older install, save your login link in Settings, remove the old icon, then install here.`),
    ...(already
      ? [el('button', { class: 'push-prompt-enable', type: 'button', onclick: () => close() }, 'Close')]
      : [el('button', { class: 'push-prompt-later', type: 'button', onclick: () => close() }, 'Use existing app'),
         el('button', { class: 'push-prompt-enable', type: 'button', onclick: () => { close(); install(); } }, 'Install app')]));
  const overlay = el('div', { class: 'push-prompt-overlay' }, card);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.body.append(overlay);
  const close = overlays.open({ element: card, outsideCloses: false, onClose: () => overlay.remove() });
}

async function install() {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    try { await deferredPrompt.userChoice; } catch { /* the person decides */ }
    deferredPrompt = null;
    return;
  }
  showGuide();
}

function showGuide() {
  const start = () => {
    if (!window.AddToHomeScreen) return;
    window.AddToHomeScreen({ appName: projectName(), appIconUrl: 'icon-192.png', assetUrl: `${GUIDE_CDN}/assets/img/`, allowClose: true, showArrow: true }).show('en');
  };
  if (window.AddToHomeScreen) { start(); return; }
  // crossorigin: without it the browser cannot read the bytes of another origin, and refuses a tag with an integrity.
  document.head.append(el('link', { rel: 'stylesheet', href: `${GUIDE_CDN}/add-to-homescreen.min.css`, integrity: GUIDE_STYLE_HASH, crossorigin: 'anonymous' }));
  const script = el('script', { src: `${GUIDE_CDN}/add-to-homescreen.min.js`, integrity: GUIDE_SCRIPT_HASH, crossorigin: 'anonymous' });
  script.addEventListener('load', start);
  document.body.append(script);
}
