// The pinned messages panel (SH-47 to SH-49): opened from the header's pin button, a popup under the button on
// desktop and a bottom sheet on a phone. One entry per pin, the newest first, with the author, the time, the whole
// text, the media under it, and who pinned it. A tap on an entry jumps to the message (SH-49), except on what has its
// own action: a picture opens the gallery viewer over the panel, a video and a voice message play in place, a link
// opens. The crossed-pin control unpins, for the people who may pin (MR-77). The panel draws from state.open.pins and
// keeps no copy; it follows every change while it is open, and it closes when the last pin goes.

import { state, on, mayPin, unpinLocally, displayName } from '../store.js';
import { clone, el, replace } from '../render/dom.js';
import { inline, messageText, safeHref } from '../render/text.js';
import { messageTime } from '../render/time.js';
import { avatar } from '../render/avatar.js';
import * as hub from '../hub.js';
import * as overlays from './overlays.js';
import { jumpTo } from './timeline.js';
import { voicePlayer } from './voice.js';
import { video, gifLoop } from './video.js';
import { openGallery } from './gallery.js';

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
    const node = clone('t-pin-entry');
    node.dataset.messageId = p.messageId;   // the viewer's focus return finds the entry again after a redraw
    node.querySelector('.pin-avatar').append(avatar(p.username, state.users[p.username]?.avatarUrl, 'small', displayName(p.username)));
    replace(node.querySelector('.pin-author'), inline(displayName(p.username)));
    node.querySelector('.pin-time').textContent = messageTime(p.timestamp);
    const text = node.querySelector('.pin-text');
    if (p.text) text.append(...messageText(p.text).nodes); else text.remove();
    const media = node.querySelector('.pin-media');
    const shown = attachments(p.media, p.messageId, (shots, index) => openShots(p, shots, index));
    if (shown.length) { media.hidden = false; media.append(...shown); } else media.remove();
    replace(node.querySelector('.pin-by'), inline(displayName(p.pinnedBy)));
    // Everything else jumps (SH-49): the header, the text, the footer, a GIF, a link card's picture. A link opens, a
    // button does its own action (a picture, unpin), and the voice player and a video play in place.
    node.addEventListener('click', e => { if (!e.target.closest('a, button, .voice-message, .video-container')) jump(node, p); });
    node.addEventListener('keydown', e => { if (e.target === node && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); jump(node, p); } });   // the unpin button and a link handle their own keys
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

// What an entry shows under its text (SH-48, Pin.media), in the row's blocks (MR-24): the uploaded pictures, each video as
// the row's own player under them, the GIFs, the voice player, a link card. A video never goes into a grid: a cell is too
// small to play it (2026-11-04). Pictures and GIFs show alone at their own size and no taller than 240 px, or two or
// more as a grid of square cells in at most two rows, so three entries still fit in one view. A picture is a button
// that opens the viewer at that picture (openShots); a GIF is not, it stays out of the viewer as in the row (TL-22). A
// media item whose file is gone shows a label. An empty list when there is nothing to show.
function attachments(media, key, openShots) {
  const items = Array.isArray(media) ? media : [];   // an offline snapshot from before 2026-10-23 holds one object; the next connection replaces it
  const block = kind => items.filter(m => m.kind === kind && m.src);   // with a file; one without falls to the label below
  const shots = block('image'), videos = block('video'), gifs = block('gif');
  const nodes = [];
  if (shots.length) nodes.push(pictures(shots, index => openShots(shots, index)));
  for (const m of videos) nodes.push(m.title ? card(video(m), m) : video(m));   // a cached link video keeps its title and site
  if (gifs.length) nodes.push(pictures(gifs));
  const drawn = new Set([...shots, ...videos, ...gifs]);
  for (const m of items) {
    if (drawn.has(m)) continue;
    if (m.kind === 'voice' && m.src) nodes.push(voicePlayer(m, key));
    else if (m.kind === 'link' && m.poster) nodes.push(card(pictures([m]), m));
    else if (m.title) nodes.push(card(null, m));   // a link card without a picture, or a cached video whose file is gone
    else nodes.push(el('span', { class: 'pin-attachment-label' }, m.kind === 'voice' ? 'Voice message' : m.kind === 'gif' ? 'GIF attachment' : 'Attachment'));
  }
  return nodes;
}

// One item alone at its own size, two or more as a grid. With onOpen, each picture is in a button: the keyboard
// reaches it, and the entry's click rule leaves it to its own action. The square cell stays a <span> inside the
// button: a percentage height inside a button sized by aspect-ratio does not resolve in every engine (Safari).
function pictures(list, onOpen) {
  const button = (child, index) => {
    const label = list.length > 1 ? `Open picture ${index + 1} of ${list.length}` : 'Open picture';   // five cells, five names
    return el('button', { type: 'button', class: 'pin-shot', title: label, 'aria-label': label, onclick: () => onOpen(index) }, child);
  };
  if (list.length === 1) {
    const frame = el('span', { class: 'pin-frame' }, sized(list[0]));
    return onOpen ? button(frame, 0) : frame;
  }
  const cols = list.length <= 4 ? list.length : Math.ceil(list.length / 2);   // --cols (frame.css): one row up to four, two rows above that
  return el('span', { class: 'pin-grid', style: `--cols: ${cols}` }, list.map((m, i) => {
    const cell = el('span', { class: 'pin-cell' }, picture(m));
    return onOpen ? button(cell, i) : cell;
  }));
}

function sized(m) {
  const node = picture(m);
  if (m.width && m.height) {   // its own size (a GIF's pixels, a picture's or a poster's), no wider than the panel, no taller than the 240 px cap
    node.style.width = `${m.width}px`;   // not 100%: the frame fits its content
    node.style.aspectRatio = `${m.width} / ${m.height}`;
    node.style.maxWidth = `min(100%, ${m.width}px, ${Math.round(240 * m.width / m.height)}px)`;
  }
  return node;
}

// The picture itself: an uploaded picture, a link card's picture, or a GIF (a picture file, or a video file that loops).
function picture(m) {
  if (m.kind === 'link') return el('img', { class: 'pin-picture', src: m.poster, alt: '', loading: 'lazy' });
  if (m.kind === 'gif' && !m.isImage) return gifLoop(m.src, 'pin-gif');
  return el('img', { class: 'pin-picture', src: m.src, alt: '', loading: 'lazy' });
}

// A link card, or a cached link video: the picture or the player when there is one, then the title and the site
// (MR-20). The title opens the link, as the row's player title does (MR-23); the rest of the card jumps. A pin made
// before 2026-11-04 has no url, and its title is plain text.
const card = (media, m) => el('span', { class: 'pin-card' }, media,
  m.title && m.url ? el('a', { class: 'pin-card-title', href: safeHref(m.url), target: '_blank', rel: 'noopener noreferrer' }, m.title)
    : m.title ? el('span', { class: 'pin-card-title' }, m.title) : null,
  m.site ? el('span', { class: 'pin-card-site' }, m.site) : null);
