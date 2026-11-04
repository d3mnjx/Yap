// The gallery viewer (TL-22 to TL-29): the images of one message on a black layer, with previous and next,
// fit and fill, the counter, swipe, drag to close. It opens from the message's row or from its pin (SH-48). No
// videos: they play in the row or in the pin entry (TL-29).

import { clone, el } from '../render/dom.js';
import * as overlays from './overlays.js';
import { on } from '../store.js';

const DOUBLE_TAP_MS = 300, DOUBLE_TAP_PX = 25, DRAG_CLOSE_PX = 120, DRAG_FADE_PX = 300, HINT_MS = 4000;

// The installed app on iOS: navigator.standalone is WebKit's own flag for it (web.dev advises it over the user agent).
// Only there Download goes through the share sheet; see the handler below.
const SHARE_FILES = navigator.standalone === true && typeof navigator.canShare === 'function';

let current = null;   // { modal, close, messageId }

// images: [{ medium, large, original }] of one message. ownerId: that message, for the close on a delete (TL-29).
// onClose runs on every close route. Returns the close function: the pins panel closes the viewer it opened when the
// pin goes. That rule stays in the panel; here it would also close a viewer opened from the row when someone unpins
// the message.
export function openGallery(images, startIndex = 0, { ownerId = null, onClose = null } = {}) {
  current?.close();
  const modal = clone('t-gallery');
  const strip = modal.querySelector('.gallery-strip');
  const items = images.map(i => ({ image: i }));
  if (!items.length) return;
  strip.append(...items.map((item, i) => {
    const stage = el('div', { class: 'modal-stage' });
    const img = el('img', { src: item.image.large, alt: 'Full size image', draggable: 'false', loading: i === startIndex ? 'eager' : 'lazy' });
    img.addEventListener('error', () => { img.src = item.image.medium; }, { once: true });   // the large file may still be in the making
    stage.append(img);
    return stage;
  }));
  if (items.length === 1) { modal.querySelector('.modal-nav.prev').remove(); modal.querySelector('.modal-nav.next').remove(); modal.querySelector('.modal-counter').remove(); }   // TL-24
  else modal.querySelector('.modal-counter-total').textContent = String(items.length);

  const stages = [...strip.children];
  const counter = modal.querySelector('.modal-counter-index');
  const download = modal.querySelector('.modal-download');
  const prev = modal.querySelector('.modal-nav.prev'), next = modal.querySelector('.modal-nav.next');
  const step = dir => strip.scrollBy({ left: dir * strip.clientWidth, behavior: 'smooth' });
  const visible = () => strip.children[Math.round(strip.scrollLeft / strip.clientWidth)];

  modal.addEventListener('click', e => {
    if (e.target.closest('.modal-nav.prev')) step(-1);
    else if (e.target.closest('.modal-nav.next')) step(1);
    else if (e.target.closest('.modal-fill')) toggleFill(visible());
    else if (!e.target.closest('img, video, .modal-download')) close();   // the backdrop, the counter or × (TL-27); Download keeps the viewer open
  });
  // A long press or a right click on the picture opens no browser menu, on a phone or on a PC: the Download
  // control is the one way to save (TL-24). The row's pictures do the same (MR-53).
  modal.addEventListener('contextmenu', e => { if (e.target.closest('img')) e.preventDefault(); });

  // The installed app on iOS has no download manager: the download attribute shows the Quick Look page there, a file
  // icon with "Open in Preview" and "More…", which nobody reads as a save (2026-10-23). The share sheet with the file
  // is the way: "Save Image" puts it in Photos. Safari allows share() only inside the tap, and a fetch keeps the tap
  // alive for a short time only (WebKit bug 197779), so a slow file ends in NotAllowedError. The file is kept, a hint
  // asks for a second tap, and that tap shares the ready file at once. Everywhere else the link downloads as is.
  const ready = new Map();   // original url → File, once fetched
  const hint = modal.querySelector('.modal-hint');
  let hintTimer = null, native = false;
  const showHint = () => { hint.hidden = false; clearTimeout(hintTimer); hintTimer = setTimeout(() => { hint.hidden = true; }, HINT_MS); };
  const fallback = () => { native = true; download.click(); native = false; };   // no file sharing on this WebKit: the Quick Look page beats nothing
  const share = file => navigator.share({ files: [file] }).catch(err => {
    if (err.name === 'NotAllowedError') showHint();   // the tap expired during the fetch
    else if (err.name !== 'AbortError') fallback();   // AbortError: the sheet was dismissed
  });
  download.addEventListener('click', e => {
    if (!SHARE_FILES || native) return;
    e.preventDefault();
    hint.hidden = true;
    const url = download.href;
    if (ready.has(url)) { share(ready.get(url)); return; }
    if (download.classList.contains('busy')) return;   // a tap during the fetch
    download.classList.add('busy');
    fetch(url).then(r => r.ok ? r.blob() : Promise.reject(new Error(r.statusText))).then(blob => {   // a 404 page is no picture to share
      const file = new File([blob], url.split('/').pop(), { type: blob.type });
      ready.set(url, file);
      if (download.href === url) return share(file);   // the user may have swiped on meanwhile
    }).catch(() => {}).finally(() => download.classList.remove('busy'));
  });
  const keys = e => {
    if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
  };
  document.addEventListener('keydown', keys);

  // fit and fill (TL-26)
  function toggleFill(stage, rx = 0.5, ry = 0.5) {
    const img = stage?.querySelector('img');
    if (!img?.naturalWidth) return;
    if (stage.classList.contains('fill')) { stage.classList.remove('fill', 'fill-w'); return; }
    const narrower = img.naturalWidth / img.naturalHeight < stage.clientWidth / stage.clientHeight;
    stage.classList.toggle('fill-w', narrower);
    stage.classList.add('fill');
    stage.scrollLeft = rx * img.clientWidth - stage.clientWidth / 2;
    stage.scrollTop = ry * img.clientHeight - stage.clientHeight / 2;
  }
  let lastTap = null;
  modal.addEventListener('pointerup', e => {
    const img = e.target.closest('.modal-stage > img');
    if (!img) { lastTap = null; return; }
    const r = img.getBoundingClientRect();
    const tap = { t: e.timeStamp, x: e.clientX, y: e.clientY, rx: (e.clientX - r.left) / r.width, ry: (e.clientY - r.top) / r.height };
    const isDouble = lastTap && tap.t - lastTap.t < DOUBLE_TAP_MS && Math.hypot(tap.x - lastTap.x, tap.y - lastTap.y) < DOUBLE_TAP_PX;
    lastTap = isDouble ? null : tap;
    if (isDouble) toggleFill(img.parentElement, tap.rx, tap.ry);
  });

  // drag down to close, fit mode on touch (TL-27)
  let drag = null;
  modal.addEventListener('pointerdown', e => {
    const stage = e.target.closest('.modal-stage:not(.fill)');
    if (!stage || e.pointerType !== 'touch' || !e.isPrimary) return;
    drag = { y: e.clientY, stage };
    stage.classList.add('dragging');
  });
  modal.addEventListener('pointermove', e => {
    if (!drag) return;
    const dy = Math.max(0, e.clientY - drag.y);
    drag.stage.style.transform = `translateY(${dy}px)`;
    modal.style.setProperty('--drag', String(Math.min(1, dy / DRAG_FADE_PX)));
  });
  const endDrag = e => {
    if (!drag) return;
    const { y, stage } = drag; drag = null;
    stage.classList.remove('dragging');
    if (e.type === 'pointerup' && e.clientY - y > DRAG_CLOSE_PX) { close(); return; }
    stage.style.transform = '';
    modal.style.removeProperty('--drag');
  };
  modal.addEventListener('pointerup', endDrag);
  modal.addEventListener('pointercancel', endDrag);

  // the counter and the end controls follow the stage in view (TL-25): no loop, so the control that would
  // lead past an end is hidden rather than shown as a button that does nothing
  const watcher = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        const index = stages.indexOf(entry.target);
        if (counter) counter.textContent = String(index + 1);
        download.href = items[index].image.original;   // the file as uploaded, under its own name (TL-24)
        if (prev) prev.hidden = index === 0;
        if (next) next.hidden = index === stages.length - 1;
      }
      else entry.target.classList.remove('fill', 'fill-w');   // a swipe lands on fit, like every native viewer
    }
  }, { root: strip, threshold: 0.6 });

  const active = document.activeElement;   // the viewer never moves the focus (TL-28)
  document.body.append(modal);
  strip.scrollLeft = startIndex * strip.clientWidth;
  stages.forEach(s => watcher.observe(s));

  let closed = false;
  const closeLayer = overlays.open({ element: modal, outsideCloses: false, onClose: () => teardown() });
  function teardown() {
    if (closed) return; closed = true;
    document.removeEventListener('keydown', keys);
    watcher.disconnect();
    modal.classList.add('closing');            // fades out over 0.15 s (TL-27)
    setTimeout(() => modal.remove(), 160);
    if (active instanceof HTMLElement && document.activeElement !== active) active.focus?.({ preventScroll: true });
    if (current?.modal === modal) current = null;
    onClose?.();
  }
  function close() { closeLayer(); }
  current = { modal, close, messageId: ownerId };
  return close;
}

// A deleted message or a switch closes the viewer (TL-29).
on('messages', detail => {
  if (!current) return;
  if (detail?.type === 'reset' || (detail?.type === 'remove' && detail.id === current.messageId)) current.close();
});
