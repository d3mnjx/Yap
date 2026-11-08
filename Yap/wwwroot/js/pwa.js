// Installing Yap (OF-01, SH-40): the install dialog, the browser's own prompt when it offers one, and the
// add-to-home-screen guide for browsers without a prompt (iOS Safari). The guide library is loaded from the
// CDN only when the guide is needed.

import { el } from './render/dom.js';
import * as overlays from './ui/overlays.js';
import { installed } from './push.js';
import { projectName } from './store.js';

let deferredPrompt = null;   // the browser's install prompt, kept until the person asks (Chromium)
addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredPrompt = e; });

const GUIDE_CDN = 'https://cdn.jsdelivr.net/gh/philfung/add-to-homescreen@3.5/dist';

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
  document.head.append(el('link', { rel: 'stylesheet', href: `${GUIDE_CDN}/add-to-homescreen.min.css` }));
  const script = el('script', { src: `${GUIDE_CDN}/add-to-homescreen.min.js` });
  script.addEventListener('load', start);
  document.body.append(script);
}
