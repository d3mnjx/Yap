// Message text to DOM nodes. The only transformations are links (MR-12, MR-13) and emoji (MR-15 to MR-17):
// Unicode emoji become images from one set, ":shortcode:" becomes a pack image, the rest is text nodes
// (MR-10). Nothing here uses innerHTML.

import { el } from './dom.js';

// One random pick from a configured list, with {0} {1} filled in; the caller keeps it while its context lasts (GEN-12).
export function pick(list, fallback, ...args) { return fill(pickTemplate(list, fallback), ...args); }

// The pick alone, unfilled: for a caller that keeps the template and fills in a value that can change (the room header).
export function pickTemplate(list, fallback) {
  const texts = Array.isArray(list) && list.length ? list : [fallback];
  return texts[Math.floor(Math.random() * texts.length)] || fallback;
}

export function fill(text, ...args) { return text.replace(/\{(\d)\}/g, (_, i) => args[+i] ?? ''); }

// The emoji matcher of the old server renderer, kept as it was: it decides what is "an emoji".
const EMOJI = /(?:[✀-➿]|(?:\ud83c[\udde6-\uddff]){2}|[\ud800-\udbff][\udc00-\udfff]|[#-9]️?⃣|㊙|㊗|〽|〰|Ⓜ|\ud83c[\udd70-\udd71]|\ud83c[\udd7e-\udd7f]|🆎|\ud83c[\udd91-\udd9a]|\ud83c[\udde6-\uddff]|\ud83c[\ude01-\ude02]|🈚|🈯|\ud83c[\ude32-\ude3a]|\ud83c[\ude50-\ude51]|‼|⁉|[▪-▫]|▶|◀|[◻-◾]|©|®|™|ℹ|🀄|[☀-⛿]|⬅|⬆|⬇|⬛|⬜|⭐|⭕|⌚|⌛|⌨|⏏|[⏩-⏳]|[⏸-⏺]|🃏|⤴|⤵|[←-⇿])/g;
const SKIN_TONE = /^[\ud83c][\udffb-\udfff]/;      // U+1F3FB..1F3FF
const ZWJ = '‍';
const VS16 = '️';

// One emoji sequence: a match, then any run of skin tone, ZWJ + next emoji, variation selectors (MR-15).
// Returns [{ text } | { emoji }] segments.
function splitEmoji(text) {
  const out = [];
  let last = 0;
  EMOJI.lastIndex = 0;
  let m;
  while ((m = EMOJI.exec(text))) {
    const start = m.index;
    let end = start + m[0].length;
    for (;;) {
      const rest = text.slice(end);
      if (rest.startsWith(VS16)) { end += 1; continue; }
      const tone = SKIN_TONE.exec(rest);
      if (tone) { end += tone[0].length; continue; }
      if (rest.startsWith(ZWJ)) {
        EMOJI.lastIndex = 0;
        const next = EMOJI.exec(rest.slice(1));
        if (next && next.index === 0) { end += 1 + next[0].length; continue; }
      }
      break;
    }
    if (start > last) out.push({ text: text.slice(last, start) });
    out.push({ emoji: text.slice(start, end) });
    last = end;
    EMOJI.lastIndex = end;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

// Twemoji's file name: hex code points joined with "-", FE0F dropped unless the sequence has a ZWJ.
function twemojiName(emoji) {
  const hasZwj = emoji.includes(ZWJ);
  const points = [];
  for (const ch of emoji) {
    const cp = ch.codePointAt(0);
    if (cp === 0xfe0f && !hasZwj) continue;
    points.push(cp.toString(16));
  }
  return points.join('-');
}

// The self-hosted override's file name: every code point, FE0F kept, padded to four digits.
function overrideName(emoji) {
  return [...emoji].map(ch => ch.codePointAt(0).toString(16).padStart(4, '0')).join('-');
}

let images = null;           // { twemojiBase, overridesBase, overrides: Set }
let packs = new Map();       // shortcode -> url

// Called with the bootstrap's emojiImages (store.js), before the first paint: the stored copy carries them, so no
// row is ever drawn with the device's own emoji font and then redrawn (GEN-20). Null before any bootstrap: text.
export function useImages(rules) {
  images = rules && { ...rules, overrides: new Set(rules.overrides) };
  packs = new Map(rules?.packs.flatMap(p => p.emojis.map(e => [e.shortcode, e.url])) ?? []);
}

function emojiUrl(emoji) {
  if (!images) return null;
  const key = overrideName(emoji);
  if (images.overrides.has(key)) return `${images.overridesBase}/${key}.png`;
  return `${images.twemojiBase}/${twemojiName(emoji)}.svg`;
}

// <img class="emoji" ...>: the size classes are emoji-inline (names, 1em), emoji-text (1.2em), emoji-big
// (emoji-only rows, 3em) and emoji-pill (18px). Eager by default so emoji never pop in while reading (MR-18).
export function emojiImage(emoji, size = 'text', { lazy = false } = {}) {
  const src = emojiUrl(emoji);
  if (!src) return document.createTextNode(emoji);
  // crossorigin: the CDN answers with CORS headers, so the service worker can store a real response, not an opaque one.
  return el('img', { class: `emoji emoji-${size}`, src, alt: emoji, draggable: 'false', crossorigin: 'anonymous', loading: lazy ? 'lazy' : null, onerror: imageFailed });
}

// An image that did not arrive (a poor connection, a short outage of the CDN, the device offline) would stay a
// broken picture or a grey box for as long as the row is on screen: the browser never retries an <img> on its own.
// The service worker only caches a good answer, so a retry is a real second chance. Retries at growing delays
// while the device believes it is online (a poor connection keeps the hub up, so nothing else would fire), then
// a retry when the network comes back (hub.js calls retryFailedImages). Emoji, gallery images and GIFs share it
// (MR-15, MR-24); message.js passes it as the onerror of its pictures.
const RETRY_DELAYS = [3000, 10000, 30000];
const failed = new Set();
export function imageFailed(event) {
  const img = event.target;
  const attempts = (Number(img.dataset.attempts) || 0) + 1;
  img.dataset.attempts = attempts;
  const delay = RETRY_DELAYS[attempts - 1];
  if (delay && navigator.onLine) { setTimeout(() => reload(img), delay); return; }
  failed.add(img);
}
function reload(img) { if (img.isConnected) { const src = img.src; img.removeAttribute('src'); img.src = src; } }

// Every image that failed and is still on screen loads again, with its attempts reset so the delays start over.
// Called when the connection returns.
export function retryFailedImages() {
  for (const img of failed) { delete img.dataset.attempts; reload(img); }
  failed.clear();
}

export function packImage(shortcode, size = 'text', { lazy = false } = {}) {
  const url = packs.get(shortcode);
  return url ? el('img', { class: `emoji emoji-${size} emoji-custom`, src: url, alt: `:${shortcode}:`, draggable: 'false', loading: lazy ? 'lazy' : null, onerror: imageFailed }) : null;
}

const SHORTCODE = /:([a-zA-Z0-9_-]+):/g;

// Text and emoji only, no links: display names, room names, the typing strip, the reply quote (MR-03, MR-32).
export function inline(text, size = 'inline') {
  const nodes = [];
  for (const part of splitShortcodes(text)) {
    if (part.shortcode) { nodes.push(packImage(part.shortcode, size) ?? document.createTextNode(`:${part.shortcode}:`)); continue; }
    for (const seg of splitEmoji(part.text)) nodes.push(seg.emoji ? emojiImage(seg.emoji, size) : document.createTextNode(seg.text));
  }
  return nodes;
}

function splitShortcodes(text) {
  const out = [];
  let last = 0;
  SHORTCODE.lastIndex = 0;
  let m;
  while ((m = SHORTCODE.exec(text))) {
    if (!packs.has(m[1])) continue;                 // an unknown shortcode stays text (MR-17)
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ shortcode: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

// ---- links (MR-12) ----

// Named LINK, not URL: a const named URL would hide the global URL class for the whole module.
const LINK = /(?:https?:\/\/|www\.)[^\s<>"']*[^\s<>"'.,;:!?-]|(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+(?:com|org|net|io|dev|app|co|me|info|edu|gov)\b(?:\/[^\s<>"']*)?/gi;

// Trailing punctuation stays outside the link; a ")" that balances a "(" in the address stays inside.
function trimLink(url) {
  let open = 0, close = 0;
  for (const c of url) { if (c === '(') open++; else if (c === ')') close++; }
  while (close > open && url.endsWith(')')) { url = url.slice(0, -1); close--; }
  while (url.length && '.,:;!?'.includes(url.at(-1))) url = url.slice(0, -1);
  return url;
}

// Addresses in text, as the server finds them for the preview cards.
function findLinks(text) {
  const links = [];
  LINK.lastIndex = 0;
  let m;
  while ((m = LINK.exec(text))) {
    const url = trimLink(m[0]);
    if (!url) continue;
    if (text[m.index - 1] === '@') continue;        // the domain of an e-mail address is not a link (MR-13)
    links.push({ start: m.index, end: m.index + url.length, text: url, href: /^https?:\/\//i.test(url) ? url : `https://${url}` });
  }
  return links;
}

// The message body: links as <a>, emoji and pack images, plain text between. Returns the nodes and whether
// the message is emoji only (MR-16). Line breaks stay as text; CSS pre-wraps them (MR-10).
export function messageText(text) {
  const links = findLinks(text);
  const emojiOnly = links.length === 0 && isEmojiOnly(text);
  const size = emojiOnly ? 'big' : 'text';
  const nodes = [];
  let last = 0;
  for (const link of links) {
    if (link.start > last) nodes.push(...inline(text.slice(last, link.start), size));
    nodes.push(el('a', { class: 'message-link', href: link.href, target: '_blank', rel: 'noopener noreferrer' }, link.text));
    last = link.end;
  }
  if (last < text.length) nodes.push(...inline(text.slice(last), size));
  return { nodes, emojiOnly };
}

function isEmojiOnly(text) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const withoutPacks = trimmed.replace(SHORTCODE, (m, code) => packs.has(code) ? '' : m);
  const withoutEmoji = withoutPacks.replace(EMOJI, '');
  const rest = withoutEmoji.replace(/[️‍\s]|[\ud83c][\udffb-\udfff]/g, '');
  const hadEmoji = withoutPacks !== trimmed || withoutEmoji !== withoutPacks;
  return rest.length === 0 && hadEmoji;
}
