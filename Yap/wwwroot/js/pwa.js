// Installing Yap (OF-01, SH-40): the install dialog, the browser's own prompt when it offers one, and the
// add-to-home-screen guide for browsers without a prompt (iOS Safari). The guide library is loaded from the
// CDN only when the guide is needed.

import { clone, el } from './render/dom.js';
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
  const already = installed(), name = projectName();
  const overlay = clone('t-pwa-install');
  const card = overlay.querySelector('.install-dialog');
  card.querySelector('.push-prompt-heading').textContent = already ? `${name} is already installed` : `Add ${name} to your home screen`;
  card.querySelector('.push-prompt-body').textContent = already
    ? 'Keep using this app. You do not need to install it again.'
    : `Already have a ${name} icon? Open it to keep using your app. To replace an older install, save your login link in Settings, remove the old icon, then install here.`;
  const later = card.querySelector('.push-prompt-later'), main = card.querySelector('.push-prompt-enable');
  if (already) later.remove();   // an installed app has one button: Close
  else later.addEventListener('click', () => close());
  main.textContent = already ? 'Close' : 'Install app';
  main.addEventListener('click', () => { close(); if (!already) install(); });
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
