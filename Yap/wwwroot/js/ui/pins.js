// The pinned messages panel (SH-47 to SH-49): opened from the header's pin button, a popup under the button on
// desktop and a bottom sheet on a phone. One entry per pin, the newest first, with the author, the time, the whole
// text, the media under it, and who pinned it. A tap on an entry jumps to the message (SH-49), except on what has its
// own action: a picture opens the gallery viewer over the panel, a video and a voice message play in place, a link
// opens. The crossed-pin control unpins, for the people who may pin (MR-77). The panel draws from state.open.pins and
// keeps no copy; it follows every change while it is open, and it closes when the last pin goes.

import { state, on, mayPin, unpinLocally, displayName } from '../store.js';
import { clone, replace } from '../render/dom.js';
import { inline } from '../render/text.js';
import * as hub from '../hub.js';
import * as overlays from './overlays.js';
import { jumpTo } from './timeline.js';
import { openGallery } from './gallery.js';
import { messageEntry } from './entry.js';

// Opens the panel at the anchor and returns the function that closes it. onClose runs on every close.
export function openPins(anchor, onClose) {
  const layer = clone('t-pins-panel');
  const panel = layer.querySelector('.pins-panel');
  const list = layer.querySelector('.pins-list');
  const channelId = state.open?.channelId;
  let viewer = null;   // { messageId, close } of the gallery viewer this panel opened, while it is open

  function draw() {
    const pins = state.open?.pins ?? [];
    // TL-29 for a pin: the pinned message is often not loaded, so no 'messages' remove comes when it goes.
    if (viewer && !pins.some(p => p.messageId === viewer.messageId)) viewer.close();
    if (!pins.length) { close(); return; }   // the last pin went, and the header button with it (SH-47)
    const allowed = mayPin();
    replace(list, pins.map(p => entry(p, allowed)));
  }

  function entry(p, allowed) {
    // Everything else jumps (SH-49): the header, the text, the footer, a GIF, a link card's picture. A picture is a
    // button of its own that opens the viewer.
    const node = messageEntry('t-pin-entry', p, { onOpen: () => jump(node, p), openShots: (shots, index) => openShots(p, shots, index) });
    replace(node.querySelector('.pin-by'), inline(displayName(p.pinnedBy)));
    const unpin = node.querySelector('.pin-unpin');
    if (allowed) unpin.addEventListener('click', e => { e.stopPropagation(); unpinNow(node, p); }); else unpin.remove();
    return node;
  }

  // The viewer opens over the panel and closes back to it (TL-22). A pin made before 2026-11-04 whose message left the
  // memory has no original file (the server gives it the large one at start), and the medium picture stands in: the
  // viewer's Download needs a file (TL-24).
  function openShots(p, shots, index) {
    const images = shots.map(m => ({ medium: m.src, large: m.large ?? m.src, original: m.original ?? m.src }));
    const onClose = () => { viewer = null; refocus(p.messageId, index); };
    const close = openGallery(images, index, { ownerId: p.messageId, onClose });
    if (close) viewer = { messageId: p.messageId, close };
  }

  // The viewer gives the focus back to the picture that opened it (TL-28). A redraw while it was open replaced that
  // button, and the focus fell to the page: the same picture of the new entry takes it, so a keyboard user keeps
  // their place.
  function refocus(messageId, index) {
    if (document.activeElement && document.activeElement !== document.body) return;
    const entry = [...list.children].find(n => n.dataset.messageId === messageId);
    entry?.querySelectorAll('.pin-shot')[index]?.focus({ preventScroll: true });
  }

  // SH-49: the panel stays while the window around the row loads (TL-41); it closes once the row is on screen, or
  // stays and names the reason of a refusal.
  async function jump(node, p) {
    if (node.classList.contains('jumping')) return;
    node.classList.add('jumping');
    const reason = await jumpTo(p.messageId);
    node.classList.remove('jumping');
    if (reason) overlays.reason(node, reason); else close();
  }

  async function unpinNow(node, p) {
    if (state.connection !== 'connected') { overlays.reason(node, 'Needs a connection'); return; }   // MR-75
    const undo = unpinLocally(p.messageId);
    const result = await hub.invoke('unpin', channelId, p.messageId);
    if (result?.error) { undo?.(); overlays.reason(panel, result.error); }
  }

  layer.querySelector('.pins-close').addEventListener('click', () => close());
  layer.querySelector('.pins-backdrop').addEventListener('click', () => close());
  document.body.append(layer);   // the body, not the frame: a fixed popup must not sit in another stacking context
  const offs = [
    on('pins', draw), on('rooms', draw), on('users', draw),
    on('open', () => { if (state.open?.channelId !== channelId) close(); else draw(); }),   // a switch closes it; a reconnect redraws it
  ];
  const close = overlays.open({ element: panel, keep: [anchor], onClose: () => { offs.forEach(off => off()); layer.remove(); onClose?.(); } });
  draw();
  // After the entries exist: the height decides below or above. The button ends 8 px above the header's edge and the
  // 3 px header line follows, so a gap of 18 px leaves 7 px of air under the line (12 px touched it). The button sits
  // after the title on a desktop and on the right in a narrow window (SH-47): the panel grows from the button's side.
  if (layer.isConnected) {
    const align = anchor.getBoundingClientRect().left < innerWidth / 2 ? 'left' : 'right';
    overlays.place(panel, anchor, { align, gap: 18 });
  }
  return close;
}
