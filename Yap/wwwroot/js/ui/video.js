// The video player of a row (MR-27): the poster under a tint with a play icon; a tap shows the controls and plays.
// The row and the pins panel (SH-48) draw this one player, so the two cannot drift. It sits beside voice.js for the
// same reason.

import { clone } from '../render/dom.js';

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
