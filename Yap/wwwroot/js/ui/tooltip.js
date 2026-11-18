// The explanation bubbles of the admin pages (admin.md, AD-25). The native title tooltip is small type on a
// wide box, waits a second, and never shows on a touch screen. This one is a single node on <body> in the
// theme's colours: it wraps at 280 px, opens at once on hover or focus, and on a touch screen a tap opens
// it and the next tap closes it. Fixed coordinates, so a table that scrolls sideways cannot clip it.
//
// Usage: give an element `data-tip` with the text; call tooltips(root) once per page and the returned
// function at unmount.

import { el } from '../render/dom.js';
import { isTouch, positionUnder } from './overlays.js';

export function tooltips(root) {
  let bubble = null, current = null;

  const place = target => positionUnder(bubble, target, { align: 'center', gap: 8 });
  const show = target => {
    const text = target.dataset.tip;
    if (!text) return;
    if (!bubble) { bubble = el('div', { class: 'admin-tip', role: 'tooltip' }); document.body.append(bubble); }
    bubble.textContent = text;
    bubble.hidden = false;
    current = target;
    place(target);
  };
  const hide = () => { if (bubble) bubble.hidden = true; current = null; };
  const tipOf = e => e.target instanceof Element ? e.target.closest('[data-tip]') : null;

  // A touch screen synthesizes pointerover before the tap; only the tap counts there, or the tap would
  // open and close the bubble in one go.
  const over = e => { if (e.pointerType === 'touch') return; const t = tipOf(e); if (t && t !== current) show(t); };
  const out = e => { if (e.pointerType === 'touch') return; const t = tipOf(e); if (t && t === current && !t.contains(e.relatedTarget)) hide(); };
  const tap = e => { if (!isTouch()) return; const t = tipOf(e); if (!t || t === current) hide(); else show(t); };
  const focus = e => { const t = tipOf(e); if (t) show(t); };
  const blur = e => { if (tipOf(e) === current) hide(); };

  const listeners = new AbortController();   // one abort at unmount removes all six
  const { signal } = listeners;
  root.addEventListener('pointerover', over, { signal });
  root.addEventListener('pointerout', out, { signal });
  root.addEventListener('click', tap, { signal });
  root.addEventListener('focusin', focus, { signal });
  root.addEventListener('focusout', blur, { signal });
  document.addEventListener('scroll', hide, { capture: true, signal });   // the element moved under the bubble
  return () => {
    listeners.abort();
    bubble?.remove();
    bubble = null; current = null;
  };
}
