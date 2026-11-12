// The entry of one message outside the timeline. The pinned messages panel (SH-48) and the search results (SR-08) show
// a message the same way: the author, the time, the whole text and the media under it. Both get the same fields from
// the server (Pin and SearchHit in wire-contract.md: messageId, username, text, timestamp, media), so this one
// drawing serves both and neither converts its data. What differs is in the template and in the caller: the pin
// entry adds the unpin control and "Pinned by", the search result adds the highlight.

import { state, displayName } from '../store.js';
import { clone, el, replace } from '../render/dom.js';
import { inline, messageText, safeHref } from '../render/text.js';
import { messageTime } from '../render/time.js';
import { avatar } from '../render/avatar.js';
import { voicePlayer } from './voice.js';
import { video, gifLoop } from './video.js';

// The filled entry. onOpen runs on a tap, or on Enter or Space on the entry itself, except on what has its own
// action: a link opens, a button does its own action, and the voice player and a video play in place. With
// openShots(shots, index) each picture is a button that opens the viewer; without it a picture belongs to the entry.
export function messageEntry(template, m, { onOpen, openShots }) {
  const node = clone(template);
  node.dataset.messageId = m.messageId;   // the viewer's focus return finds the entry again after a redraw
  node.querySelector('.pin-avatar').append(avatar(m.username, state.users[m.username]?.avatarUrl, 'small', displayName(m.username)));
  replace(node.querySelector('.pin-author'), inline(displayName(m.username)));
  node.querySelector('.pin-time').textContent = messageTime(m.timestamp);
  const text = node.querySelector('.pin-text');
  if (m.text) text.append(...messageText(m.text).nodes); else text.remove();
  const media = node.querySelector('.pin-media');
  const shown = attachments(m.media, m.messageId, openShots);
  if (shown.length) { media.hidden = false; media.append(...shown); } else media.remove();
  node.addEventListener('click', e => { if (!e.target.closest('a, button, .voice-message, .video-container')) onOpen(); });
  node.addEventListener('keydown', e => { if (e.target === node && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen(); } });   // a button and a link inside handle their own keys
  return node;
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
  if (shots.length) nodes.push(pictures(shots, openShots && (index => openShots(shots, index))));   // without openShots a picture is part of the entry (search results)
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
