// The video player of a row (MR-27): the poster under a tint with a play icon; a tap shows the controls and plays.
// And the loop of a GIF that is a video file (MR-29). The row and the pins panel (SH-48) draw these, so the two cannot
// drift. It sits beside voice.js for the same reason.

import { clone, el } from '../render/dom.js';

export function video(v) {
  const node = clone('t-video');
  const player = node.querySelector('video');
  if (v.poster) player.poster = v.poster;   // a pinned link video can have none, and undefined would load the URL "undefined"
  player.src = v.src;
  if (v.width && v.height) { player.classList.add('sized'); player.style.setProperty('--w', v.width); player.style.setProperty('--h', v.height); }   // the poster's shape before it loads (MR-27)
  const overlay = node.querySelector('.video-play-overlay');
  overlay.addEventListener('click', () => { player.controls = true; overlay.hidden = true; player.play().catch(() => {}); });
  const back = () => { if (player.currentTime === 0 || player.ended) overlay.hidden = false; };
  player.addEventListener('ended', () => { overlay.hidden = false; });
  player.addEventListener('pause', back);
  return node;
}

// A GIF that is a video file: muted, looping, inline. The muted attribute alone does not satisfy every autoplay rule,
// so the property is set too.
export function gifLoop(src, cls) {
  const loop = el('video', { src, autoplay: true, loop: true, muted: true, playsinline: true, preload: 'auto', class: cls });
  loop.muted = true;
  loop.play?.().catch(noteAutoplayBlocked);
  return loop;
}

// A browser that blocks autoplay: the next tap or key starts every paused GIF (MR-29, TL-31). Every looping video of
// the page is a GIF: in a row, in the picker, in the pins panel.
let autoplayBlocked = false;
function noteAutoplayBlocked() {
  if (autoplayBlocked) return;
  autoplayBlocked = true;
  const resume = () => { autoplayBlocked = false; for (const v of document.querySelectorAll('video[loop]')) v.play().catch(() => {}); };
  document.addEventListener('pointerdown', resume, { once: true, capture: true });
  document.addEventListener('keydown', resume, { once: true, capture: true });
}
