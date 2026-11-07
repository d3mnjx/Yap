// One message row (message-row.md): the header, the reply quote, the content, the cards, the reaction pills,
// the action bar with its popups, the editor, and the pending and failed states. The row draws from a
// message object; a pending row is a message object with `pending` from sender.js.

import { state, displayName, hasMedia, toggleReactionLocally, editLocally, removeLocally, toggleFavoriteLocally, redrawMessage, mayPin, isPinned, pinLocally, unpinLocally } from '../store.js';
import { clone, el, replace, classes } from '../render/dom.js';
import { inline, messageText, imageFailed, safeHref } from '../render/text.js';
import { messageTime } from '../render/time.js';
import { avatar } from '../render/avatar.js';
import * as hub from '../hub.js';
import * as overlays from './overlays.js';
import * as sender from '../sender.js';
import { jumpTo } from './timeline.js';
import { openGallery } from './gallery.js';
import { reactionPicker } from './emoji-picker.js';
import { api } from '../api.js';
import { openInstallDialog } from '../pwa.js';
import { voicePlayer } from './voice.js';
import { video, gifLoop } from './video.js';

const MAX_TEXT = 4000;   // MR-11

// The message the composer replies to: its row keeps the tint through every redraw (MR-37).
let replyTargetId = null;
export function setReplyTarget(id) {
  if (replyTargetId) document.getElementById(`msg-${replyTargetId}`)?.classList.remove('reply-target');
  replyTargetId = id;
  if (id) document.getElementById(`msg-${id}`)?.classList.add('reply-target');
}

// MR-01: a header when the row is the first, the author changed, the row is a reply, or 30 minutes passed.
// The gap is from the previous row, not from the first row of the group: a slow steady talk stays one group.
export function needsHeader(prev, m) {
  if (!prev || prev.kind) return true;   // the first row, and the row after a system line, start a group (MR-01, MR-80)
  if (prev.username !== m.username) return true;
  if (m.replyTo) return true;
  return new Date(m.timestamp) - new Date(prev.timestamp) >= 30 * 60_000;
}

const isOwn = m => m.username === state.user?.username;

export function renderRow(m, { header }) {
  if (m.kind) return systemRow(m);
  const row = clone('t-message');
  row.id = `msg-${m.id}`;
  classes(row, { 'has-header': header, 'has-reply': !!m.replyTo, pending: !!m.pending, failed: !!m.failed, 'reply-target': m.id === replyTargetId });
  const u = state.users[m.username];

  // the reply quote (MR-32 to MR-35)
  const quote = row.querySelector('.reply-preview');
  if (m.replyTo) {
    quote.hidden = false;
    if (m.replyTo.unavailable) {
      quote.querySelector('.reply-author').remove();
      quote.querySelector('.reply-text').textContent = 'Original message unavailable';
    } else {
      const ru = state.users[m.replyTo.username];
      quote.prepend(avatar(m.replyTo.username, ru?.avatarUrl, 'small', displayName(m.replyTo.username)));
      replace(quote.querySelector('.reply-author'), inline(displayName(m.replyTo.username)));
      replace(quote.querySelector('.reply-text'), m.replyTo.text ? inline(m.replyTo.text, 'inline') : [m.replyTo.voice ? 'Voice message' : 'Click to see attachment']);   // MR-32
      quote.addEventListener('click', async () => { const reason = await jumpTo(m.replyTo.id); if (reason) overlays.reason(quote, reason); });   // MR-34, TL-41
    }
  } else quote.remove();

  // the header (MR-01 to MR-05)
  const body = row.querySelector('.message-body');
  const meta = body.querySelector('.message-meta');
  if (header) {
    row.insertBefore(avatar(m.username, u?.avatarUrl, 'medium', displayName(m.username)), body);
    replace(meta.querySelector('.message-username'), inline(displayName(m.username)));
    const bot = meta.querySelector('.bot-badge');
    if (u?.isBot) { bot.hidden = false; replace(bot, inline('🤖')); }
    meta.querySelector('.message-time').textContent = messageTime(m.timestamp);
  } else meta.remove();

  renderContent(row, m);
  renderCards(row, m);
  renderReactions(row, m);
  renderPending(row, m);
  renderActions(row, m);
  return row;
}

// A stored system line (MR-80): a row of the list with the message's id, so the timeline keeps, moves and removes
// it like any row. No header, no time, no actions: rowOf skips .system-message, so no bar attaches to it.
function systemRow(m) {
  const row = clone('t-system-line');
  row.id = `msg-${m.id}`;
  row.classList.add(`${m.kind}-line`);
  const did = m.kind === 'pin' ? 'pinned a message' : m.kind;   // a kind from a newer server still reads as something
  replace(row.querySelector('.message-content'), inline(`${displayName(m.username)} ${did}`));
  return row;
}

// ---- content (MR-10 to MR-18, MR-24 to MR-31) ----

function renderContent(row, m) {
  const content = row.querySelector('.message-content');
  if (hasMedia(m)) {
    if (m.text) content.append(caption(m));                                                  // the text above the media (MR-24)
    if (m.voice) content.append(voicePlayer(m.voice, m.clientId ?? m.id));                   // alone in its row (MR-76); the key survives the pending-to-accepted swap
    if (m.images.length) content.append(imageGallery(m));
    if (m.videos.length) content.append(el('div', { class: 'video-gallery' }, m.videos.map(video)));
    if (m.gifs.length) content.append(el('div', { class: 'gif-message-gallery' }, m.gifs.map(g => gif(g, m))));
    return;
  }
  const text = m.text ?? '';
  if (state.users[m.username]?.isBot && text.includes('[pwa-install]')) {                   // MR-74
    const [before, after] = text.split('[pwa-install]');
    content.append(...messageText(before).nodes, el('span', { class: 'bot-action-link', onclick: openInstallDialog }, 'install it'), ...messageText(after ?? '').nodes);
    return;
  }
  const { nodes, emojiOnly } = messageText(text);
  content.classList.toggle('emoji-only', emojiOnly);
  content.append(...nodes);
  if (m.edited) content.append(' ', el('span', { class: 'edited-indicator' }, '(edited)'));
}

// The caption of a media row: the text, never in the big emoji-only form; Edit changes it in place (MR-57).
function caption(m) {
  const node = el('div', { class: 'message-caption' }, ...messageText(m.text).nodes);
  if (m.edited) node.append(' ', el('span', { class: 'edited-indicator' }, '(edited)'));
  return node;
}

// MR-25: rows of two or three, never a row of one.
const ROWS = { 2: [2], 3: [3], 4: [2, 2], 5: [2, 3], 6: [3, 3], 7: [2, 2, 3], 8: [2, 3, 3], 9: [3, 3, 3], 10: [2, 2, 3, 3] };

function imageGallery(m) {
  const open = index => openGallery(m.images, index, { ownerId: m.id });
  const item = (img, index, single) => {
    // draggable=false: on Android a long press whose menu is suppressed (below) would start a drag of the picture instead
    const attrs = { src: img.medium, alt: 'Uploaded image', class: 'gallery-image', loading: 'lazy', width: 800, height: single ? 600 : 800, draggable: 'false', onerror: imageFailed };   // a poor connection: load again (MR-24)
    if (img.width && img.height) { attrs.class += ' sized'; attrs.style = `--w: ${img.width}; --h: ${img.height}`; }   // the box before the file loads (MR-24); an old stored row has no size
    // No browser menu on a long press or a right click (MR-53): users who meant to show the row's bar long-pressed the
    // picture and got the save menu instead; the viewer's Download control replaces it. iOS needs the CSS touch-callout too.
    return el('div', { class: 'gallery-item', onclick: () => open(index), oncontextmenu: e => e.preventDefault() }, el('img', attrs));
  };
  if (m.images.length === 1) return el('div', { class: 'image-gallery gallery-single' }, item(m.images[0], 0, true));
  const rows = [];
  let index = 0;
  for (const size of ROWS[Math.min(m.images.length, 10)] ?? [3]) {
    const cells = [];
    for (let i = 0; i < size && index < m.images.length; i++, index++) cells.push(item(m.images[index], index, false));
    rows.push(el('div', { class: 'gallery-row' }, cells));
  }
  return el('div', { class: 'image-gallery' }, rows);
}

// MR-28 to MR-31
function gif(g, m) {
  const node = clone('t-gif');
  if (g.width && g.height) { node.style.aspectRatio = `${g.width} / ${g.height}`; node.style.maxWidth = `min(360px, ${g.width}px)`; }
  else { node.style.aspectRatio = '1'; node.style.maxWidth = '240px'; }
  const missing = node.querySelector('.gif-message-missing');
  if (!g.src) missing.hidden = false;
  else {
    const media = g.isImage
      ? el('img', { src: g.src, alt: 'GIF', width: g.width || null, height: g.height || null, loading: 'lazy', onerror: imageFailed })
      : gifLoop(g.src, 'gif-message-video');
    media.addEventListener(g.isImage ? 'load' : 'canplay', () => node.classList.add('gif-loaded'), { once: true });
    media.addEventListener('error', () => node.classList.add('gif-loaded'), { once: true });
    node.prepend(media);
  }
  if (g.entryId) {
    const star = node.querySelector('.gif-message-fav');
    star.hidden = false;
    drawStar(star, g.entryId);
    star.addEventListener('click', e => { e.stopPropagation(); toggleFavorite(g.entryId, row(node)); });
  }
  if (g.uploader) {
    const by = node.querySelector('.gif-message-uploader');
    by.hidden = false; by.textContent = `via ${displayName(g.uploader)}`; by.title = `Uploaded by ${displayName(g.uploader)}`;
  }
  return node;
}

const row = node => node.closest('.message-group');

// A star reads its state from the store; `data-entry` lets redrawStars find it again (MR-30).
function drawStar(star, entryId) {
  const on = state.favoriteGifIds.has(entryId);
  star.dataset.entry = entryId;
  star.classList.toggle('favorited', on);
  star.title = on ? 'Remove from favorites' : 'Add to favorites';
}

// Every star on the page follows the account (PK-36). Only the stars repaint: a rebuild of every row
// re-decodes every GIF and video and cost ~800 ms per click, twice per click (the local flip, then
// the server's gifFavorites answer).
export function redrawStars() {
  for (const star of document.querySelectorAll('.gif-message-fav[data-entry], .action-gif-fav[data-entry]')) drawStar(star, star.dataset.entry);
}

async function toggleFavorite(entryId, rowNode) {
  if (state.connection !== 'connected') { overlays.reason(rowNode, 'Needs a connection'); return; }   // MR-75
  const on = !state.favoriteGifIds.has(entryId);
  const undo = toggleFavoriteLocally(entryId);                        // the star changes now (MR-30)
  try { await api.put(`/api/gifs/${entryId}/favorite`, { on }); }   // the gifFavorites message confirms it (PK-36)
  catch (e) { undo(); overlays.reason(document.getElementById(rowNode.id) ?? rowNode, e.message); }
}

// ---- cards (MR-19 to MR-23) ----

function renderCards(rowNode, m) {
  const host = rowNode.querySelector('.message-cards');
  if (hasMedia(m) || !m.previews?.length) { host.remove(); return; }
  for (const p of m.previews.slice(0, 5)) host.append(p.media ? mediaPlayer(p) : linkCard(p));
}

function linkCard(p) {
  const card = clone('t-link-card');
  card.href = safeHref(p.url);
  const set = (cls, text) => { const n = card.querySelector(cls); if (text) n.textContent = text; else n.remove(); };
  set('.link-preview-site', p.siteName); set('.link-preview-title', p.title); set('.link-preview-description', p.description);
  const thumb = card.querySelector('.link-preview-thumbnail');
  if (p.imageUrl) { thumb.hidden = false; thumb.querySelector('img').src = p.imageUrl; } else thumb.remove();
  return card;
}

function mediaPlayer(p) {
  const node = clone('t-media-player');
  const info = node.querySelector('.video-info');
  const site = info.querySelector('.video-site'), title = info.querySelector('.video-title');
  if (p.siteName) site.textContent = p.siteName; else site.remove();
  if (p.title) { title.textContent = p.title; title.href = safeHref(p.url); } else title.remove();
  const videoNode = node.querySelector('.cached-video-player');
  const audio = node.querySelector('.cached-audio-player');
  if (p.media.type === 'audio') {
    videoNode.remove(); info.remove(); audio.hidden = false;
    const img = audio.querySelector('.audio-thumbnail');
    if (p.imageUrl) { img.hidden = false; img.src = p.imageUrl; } else img.remove();
    audio.querySelector('.audio-title').textContent = p.title ?? '';
    audio.querySelector('.audio-site').textContent = p.siteName ?? '';
    audio.querySelector('.audio-element').src = p.media.src;
  } else {
    audio.remove();
    if (!p.siteName && !p.title) info.remove();
    videoNode.poster = p.media.poster ?? p.imageUrl ?? '';
    videoNode.src = p.media.src;
    if (p.media.width && p.media.height) videoNode.style.aspectRatio = `${p.media.width} / ${p.media.height}`;
  }
  return node;
}

// ---- reactions (MR-38 to MR-45) ----

function renderReactions(rowNode, m) {
  const host = rowNode.querySelector('.reactions-display');
  if (m.pending || !m.reactions?.length) { host.remove(); return; }
  for (const r of m.reactions) {
    const pill = clone('t-reaction-pill');
    replace(pill.querySelector('.reaction-emoji'), inline(r.emoji, 'pill'));
    pill.querySelector('.reaction-count').textContent = String(r.users.length);
    pill.title = r.users.map(displayName).join(', ');
    pill.classList.toggle('reacted', r.users.includes(state.user.username));
    pill.addEventListener('click', e => { e.stopPropagation(); react(rowNode, m, r.emoji); });
    host.append(pill);
  }
}

async function react(rowNode, m, emoji) {
  if (state.connection !== 'connected') { overlays.reason(rowNode, 'Needs a connection'); return; }   // MR-75
  toggleReactionLocally(m.id, emoji, state.user.username);                                           // MR-40
  const result = await hub.invoke('react', m.id, emoji);
  if (result?.error) { toggleReactionLocally(m.id, emoji, state.user.username); overlays.reason(document.getElementById(`msg-${m.id}`) ?? rowNode, result.error); }
}

// ---- pending and failed rows (MR-69 to MR-72, IB-34) ----

function renderPending(rowNode, m) {
  const box = rowNode.querySelector('.message-pending');
  if (!m.pending) { box.remove(); return; }
  if (m.uploading) {
    box.hidden = false;
    box.querySelector('.pending-files').textContent = m.uploading.names.join(', ');
    box.querySelector('.upload-progress-fill').style.width = `${m.uploading.percent ?? 0}%`;
    box.querySelector('.pending-status').textContent = ''; box.querySelector('.pending-reason').textContent = '';
    box.querySelector('.pending-retry').remove(); box.querySelector('.pending-remove').remove();
    box.querySelector('.pending-cancel').addEventListener('click', () => sender.remove(m));
    return;
  }
  if (m.failed) {
    box.hidden = false;
    box.querySelector('.pending-files').remove(); box.querySelector('.upload-progress-track').remove(); box.querySelector('.pending-cancel').remove();
    box.querySelector('.pending-status').textContent = 'Failed';
    box.querySelector('.pending-reason').textContent = m.failed;
    box.querySelector('.pending-retry').addEventListener('click', () => sender.retry(m));
    box.querySelector('.pending-remove').addEventListener('click', () => sender.remove(m));
    return;
  }
  box.remove();
}

// ---- the action bar and its popups (MR-46 to MR-68) ----

// The three quick reaction buttons are built when the bar first shows, not when the row is drawn. The bar is
// invisible until a hover, a tap or keyboard focus, and fifty rows times three emoji images was the largest share
// of a cold open's image requests on the iPhone, where every <img> is a request of its own (2026-10-31). The filler
// waits per row; showTouched, the pointerover and focusin listeners below and rowReplaced run it.
const quickFillers = new WeakMap();   // rowNode -> () => void, until the bar first shows
function fillQuick(rowNode) {
  const fill = quickFillers.get(rowNode);
  if (!fill) return;
  quickFillers.delete(rowNode);
  fill();
}

function renderActions(rowNode, m) {
  const bar = rowNode.querySelector('.message-actions');
  const quick = bar.querySelector('.quick-reactions');
  if (m.pending) { quick.remove(); bar.querySelector('.action-divider').remove(); bar.querySelector('.action-picker').remove(); bar.querySelector('.action-reply').remove(); }
  else {
    quickFillers.set(rowNode, () => {
      for (const emoji of state.emoji?.quickReactions ?? []) {
        const b = clone('t-action-reaction');
        b.title = emoji;
        replace(b, inline(emoji, 'pill'));
        b.addEventListener('click', () => react(rowNode, m, emoji));
        quick.append(b);
      }
    });
    bar.querySelector('.action-picker').addEventListener('click', e => openReactionPicker(rowNode, m, e.currentTarget));
    bar.querySelector('.action-reply').addEventListener('click', () => document.dispatchEvent(new CustomEvent('yap:reply', { detail: m })));   // IB-49
  }
  const firstGif = m.gifs[0];
  const star = bar.querySelector('.action-gif-fav');
  if (firstGif?.entryId && !m.pending) {
    star.hidden = false;
    drawStar(star, firstGif.entryId);
    star.addEventListener('click', () => toggleFavorite(firstGif.entryId, rowNode));
  } else star.remove();
  const edit = bar.querySelector('.action-edit');
  // a failed row is pending too: Edit corrects the text and sends it again (MR-72)
  if (isOwn(m) && (m.text || !hasMedia(m))) { edit.hidden = false; edit.addEventListener('click', () => startEdit(rowNode, m)); } else edit.remove();   // a text row, or a media row with a caption (MR-57)
  const more = bar.querySelector('.action-more');
  if (m.text || isOwn(m) || (!m.pending && mayPin())) { more.hidden = false; more.addEventListener('click', e => openMore(rowNode, m, e.currentTarget, e)); } else more.remove();   // MR-47; Pin for a media row of someone else (MR-77)
}

function openReactionPicker(rowNode, m, anchor) {
  rowNode.classList.add('picker-open');   // the bar and the tint stay (MR-43)
  reactionPicker(rowNode, anchor, emoji => react(live(rowNode), m, emoji), () => live(rowNode).classList.remove('picker-open'));
}

function openMore(rowNode, m, anchor, event) {
  const layer = clone('t-more-menu');
  const menu = layer.querySelector('.more-menu');
  const copy = layer.querySelector('[data-action="copy"]'), del = layer.querySelector('[data-action="delete"]'), remove = layer.querySelector('[data-action="remove"]');
  const pin = layer.querySelector('[data-action="pin"]');
  if (m.pending || !mayPin()) pin.remove();
  else {   // MR-77
    const pinned = isPinned(m.id);
    pin.querySelector('span').textContent = pinned ? 'Unpin Message' : 'Pin Message';
    pin.addEventListener('click', () => { close(); togglePin(rowNode, m, pinned); });
  }
  if (!m.text) copy.remove();   // the caption of a media row copies too (MR-56)
  if (!isOwn(m) || m.pending) del.remove();
  if (!m.pending) remove.remove();
  copy.addEventListener('click', () => { navigator.clipboard?.writeText(m.text).catch(() => {}); close(); });   // MR-56
  del.addEventListener('click', e => { close(); if (e.shiftKey) deleteNow(rowNode, m); else confirmDelete(rowNode, m); });   // MR-67
  remove.addEventListener('click', () => { close(); sender.remove(m); });
  layer.querySelector('.more-menu-backdrop').addEventListener('click', () => close());
  rowNode.append(layer);
  rowNode.classList.add('menu-open');
  overlays.place(menu, anchor);
  const close = overlays.open({ element: menu, keep: [anchor], onClose: () => { layer.remove(); live(rowNode).classList.remove('menu-open'); } });
}

function confirmDelete(rowNode, m) {
  const overlay = clone('t-delete-dialog');
  const preview = overlay.querySelector('.delete-confirm-preview');
  const u = state.users[m.username];
  preview.querySelector('.preview-avatar').append(avatar(m.username, u?.avatarUrl, 'small', displayName(m.username)));
  replace(preview.querySelector('.preview-username'), inline(displayName(m.username)));
  preview.querySelector('.preview-time').textContent = messageTime(m.timestamp);
  const text = preview.querySelector('.preview-content');
  if (m.text) replace(text, inline(m.text)); else text.remove();
  const thumb = preview.querySelector('.preview-thumb'), label = preview.querySelector('.preview-attachment-label');
  if (m.images[0]) { thumb.hidden = false; thumb.src = m.images[0].medium; label.remove(); }
  else if (m.videos[0]) { thumb.hidden = false; thumb.src = m.videos[0].poster; thumb.alt = 'Video attachment'; label.remove(); }
  else if (m.gifs[0]) { thumb.remove(); label.hidden = false; }
  else if (m.voice) { thumb.remove(); label.hidden = false; label.textContent = 'Voice message'; }
  else { thumb.remove(); label.remove(); }
  if (overlays.isTouch()) overlay.querySelector('.delete-confirm-tip').remove();   // MR-66
  overlay.querySelector('.confirm-cancel').addEventListener('click', () => close());
  overlay.querySelector('.confirm-delete').addEventListener('click', () => { close(); deleteNow(rowNode, m); });
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.body.append(overlay);
  rowNode.classList.add('menu-open');   // the tint and the bar stay while the dialog is open (MR-08, MR-46)
  const close = overlays.open({ element: overlay.querySelector('.delete-confirm-dialog'), outsideCloses: false, onClose: () => { overlay.remove(); live(rowNode).classList.remove('menu-open'); } });
  overlay.querySelector('.confirm-delete').focus();   // Enter confirms (MR-66)
}

async function deleteNow(rowNode, m) {
  if (state.connection !== 'connected') { overlays.reason(rowNode, 'Needs a connection'); return; }   // MR-75
  const undo = removeLocally(m.id);                                                                // MR-68, at once
  const result = await hub.invoke('delete', m.id);
  if (result?.error) { undo?.(); overlays.reason(document.getElementById(`msg-${m.id}`) ?? rowNode, result.error); }
}

// MR-77, MR-78: the header count and the panel change at once; the server's refusal undoes it and shows at the row.
async function togglePin(rowNode, m, pinned) {
  if (state.connection !== 'connected') { overlays.reason(rowNode, 'Needs a connection'); return; }   // MR-75
  const channelId = state.open.channelId;
  const undo = pinned ? unpinLocally(m.id) : pinLocally(m);
  const result = await hub.invoke(pinned ? 'unpin' : 'pin', channelId, m.id);
  if (result?.error) { undo?.(); overlays.reason(document.getElementById(`msg-${m.id}`) ?? rowNode, result.error); }
}

// ---- editing (MR-57 to MR-63) ----

let editing = null;   // { rowNode, close }: one editor at a time (MR-62)

function startEdit(rowNode, m) {
  editing?.close();
  const content = rowNode.querySelector('.message-caption') ?? rowNode.querySelector('.message-content');   // a media row keeps its gallery; the editor takes the caption's place
  const saved = [...content.childNodes];
  const box = clone('t-edit-box');
  const area = box.querySelector('.edit-input');
  area.value = m.text ?? '';
  area.maxLength = MAX_TEXT;
  content.replaceChildren(box);
  rowNode.classList.add('editing');
  const grow = () => { area.style.height = 'auto'; area.style.height = `${Math.min(area.scrollHeight, 200)}px`; };
  area.addEventListener('input', grow);
  // The row skipped every redraw while the editor was open, so it is drawn once now: a reaction or an edit from
  // elsewhere shows, and after Save the new text shows at once, not after the server's answer (MR-62).
  const close = () => { if (editing?.rowNode !== rowNode) return; content.replaceChildren(...saved); rowNode.classList.remove('editing'); editing = null; redrawMessage(m.id); };
  const save = async () => {
    const text = area.value;
    if (!text.trim() || text === m.text) { close(); return; }                                      // MR-61
    if (m.pending) { sender.edit(m, text); close(); return; }                                      // MR-72
    if (state.connection !== 'connected') { overlays.reason(rowNode, 'Needs a connection'); return; }
    const undo = editLocally(m.id, text);
    close();
    const result = await hub.invoke('edit', m.id, text);
    if (result?.error) { undo?.(); overlays.reason(document.getElementById(`msg-${m.id}`) ?? rowNode, result.error); }
  };
  box.querySelector('.edit-save').addEventListener('click', save);
  box.querySelector('.edit-cancel').addEventListener('click', close);
  if (overlays.isTouch()) box.querySelector('.edit-hint').remove();
  area.addEventListener('keydown', e => {
    if (e.isComposing) return;                                                                      // MR-60
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Enter' && !e.shiftKey && !overlays.isTouch()) { e.preventDefault(); save(); }
  });
  editing = { rowNode, close };
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);                                   // MR-59
  grow();
}

// ---- touch: a tap shows the bar, 5 s or a scroll hides it (MR-50, MR-51) ----
//
// The bar is shown by the click of the tap, not by pointerup: the click's target is fixed before the bar
// becomes hit-testable, so the tap that shows the bar can never press one of its buttons (MR-50, "never under
// the finger"). The browser's own pan detection tells a tap from a scroll: a scroll ends in pointercancel and
// no click follows. pointerdown only notes the row under the finger. The listeners sit on the document in the
// capture phase because the bar's buttons stop propagation of their clicks.

const TOUCH_IDLE_MS = 5000, TOUCH_SCROLL_PX = 50;
let touched = null, touchTimer = 0, touchRow = null, scrollStart = 0;

const rowOf = target => target instanceof Element ? target.closest('.message-group:not(.system-message)') : null;
const keepsBar = rowNode => rowNode.classList.contains('picker-open') || rowNode.classList.contains('menu-open');   // MR-51: never hidden while open
const listOf = rowNode => rowNode.closest('.messages');

function showTouched(rowNode) {
  fillQuick(rowNode);   // the bar shows: its quick reactions exist from here
  if (touched && touched !== rowNode) touched.classList.remove('touched');   // one bar at a time (MR-50)
  touched = rowNode;
  rowNode.classList.add('touched');
  scrollStart = listOf(rowNode)?.scrollTop ?? 0;
  armTouchTimer();
}

function hideTouched() {
  clearTimeout(touchTimer);
  touched?.classList.remove('touched');
  touched = null;
}

// 5 s after the last touch in the row. While the picker, the menu or the dialog is open the timer waits
// for another 5 s instead of giving up: the bar stays, and goes 5 s after the layer closed (MR-51).
function armTouchTimer() {
  clearTimeout(touchTimer);
  touchTimer = setTimeout(() => { if (touched && keepsBar(touched)) armTouchTimer(); else hideTouched(); }, TOUCH_IDLE_MS);
}

document.addEventListener('pointerdown', e => {
  if (e.pointerType !== 'touch') return;
  touchRow = rowOf(e.target);
  if (touchRow) return;
  // Outside every row: inside the touched row's own layer (the picker, the menu, the dialog on body) the touch
  // counts as a touch in the row; anywhere else it hides the bar. A target that is no longer in the document
  // was a backdrop: the overlay stack's own pointerdown listener runs first and removed the layer with it, so
  // the tap that closed the picker or the menu is a touch in the row too (MR-51).
  if (!e.target.isConnected || (touched && keepsBar(touched))) armTouchTimer(); else hideTouched();
}, { capture: true, passive: true });
document.addEventListener('pointercancel', () => { touchRow = null; });
// A pointer that can hover shows the bar through CSS (:hover); its quick reactions are built as the pointer enters
// the row. Keyboard focus in a row (tabbing to its buttons) builds them too.
document.addEventListener('pointerover', e => { if (e.pointerType !== 'touch') { const rowNode = rowOf(e.target); if (rowNode) fillQuick(rowNode); } }, { passive: true });
document.addEventListener('focusin', e => { const rowNode = rowOf(e.target); if (rowNode) fillQuick(rowNode); });
document.addEventListener('click', e => {
  const rowNode = touchRow; touchRow = null;
  if (!rowNode?.isConnected || !rowNode.contains(e.target)) return;
  showTouched(rowNode);
}, true);

// The list scrolled: more than 50 px since the bar appeared hides it (MR-51). Called by the timeline.
export function touchScrolled(scrollTop) {
  if (touched && !keepsBar(touched) && Math.abs(scrollTop - scrollStart) > TOUCH_SCROLL_PX) hideTouched();
}

// A row drawn again in place (a reaction, an edit, a header change): the bar, the open picker or menu and
// its state move to the new node, so a redraw never takes the bar away under the finger (MR-51). The closures
// of the open layer still hold the old node; they look the live row up by id when they close.
export function rowReplaced(oldNode, newNode) {
  for (const cls of ['touched', 'picker-open', 'menu-open']) if (oldNode.classList.contains(cls)) newNode.classList.add(cls);
  if (!quickFillers.has(oldNode)) fillQuick(newNode);   // a bar the person has seen keeps its quick reactions
  newNode.append(...oldNode.querySelectorAll(':scope > .emoji-picker-backdrop, :scope > .emoji-picker-wrapper, :scope > .more-menu-layer'));
  if (touched === oldNode) touched = newNode;
}

const live = rowNode => document.getElementById(rowNode.id) ?? rowNode;
