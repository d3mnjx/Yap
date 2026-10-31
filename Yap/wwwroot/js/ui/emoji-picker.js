// The emoji picker (pickers.md, PK-01 to PK-12, PK-43, PK-44): the category bar, the search, the sections.
// Two modes: for the composer it inserts into the draft and stays open; for a reaction it toggles and closes.

import { state } from '../store.js';
import { clone, el, replace } from '../render/dom.js';
import { emojiImage, packImage } from '../render/text.js';
import * as hub from '../hub.js';
import * as overlays from './overlays.js';

const CATEGORY_NAMES = { smileys: 'Smileys', gestures: 'Gestures', animals: 'Animals', nature: 'Nature', food: 'Food', activities: 'Activities', travel: 'Travel', objects: 'Objects', symbols: 'Symbols', flags: 'Flags' };

// EmojiPicker({ onPick(emojiOrShortcode) }) returns { element, opened() }. opened() refreshes Recent and clears
// the search (PK-06, PK-08) and must be called on every open.
export function EmojiPicker({ onPick, recordUse = true }) {
  const picker = clone('t-emoji-picker');
  const sidebar = picker.querySelector('.emoji-sidebar');
  const content = picker.querySelector('.emoji-content');
  const sections = picker.querySelector('.emoji-sections');
  const search = picker.querySelector('.emoji-search input');
  const clear = picker.querySelector('.emoji-search-clear');
  const empty = picker.querySelector('.emoji-search-empty');
  let built = false;
  let keywords = {};   // the list's search words, kept for Recent (PK-07); filled by build()

  // The first open imports the picker's list (js/data/emoji-list.js). It ships with the shell and the worker has it, so
  // the wait is a cache hit, and a closed picker costs the start nothing (PK-11). The packs are runtime data and come
  // with the bootstrap.
  async function build() {
    built = true;
    let data;
    try { data = await import('../data/emoji-list.js'); }
    catch { built = false; return; }   // offline before the worker stored the shell: the next open tries again
    keywords = data.keywords;
    const list = [];   // { key, title, icon(), cells: [{ value, keywords, node() }] }
    list.push({ key: 'recent', title: 'Recent', icon: () => emojiImage('🕐', 'inline', { lazy: true }), cells: [] });
    for (const pack of state.emojiImages?.packs ?? []) {
      if (!pack.emojis.length) continue;
      list.push({ key: pack.key, title: pack.name, icon: () => packImage(pack.emojis[0].shortcode, 'inline'),
        cells: pack.emojis.map(e => ({ value: `:${e.shortcode}:`, keywords: `${e.shortcode} ${e.keywords ?? ''}`.toLowerCase(), title: `:${e.shortcode}:`, node: () => packImage(e.shortcode, 'text', { lazy: true }) })) });
    }
    for (const c of data.categories) {
      list.push({ key: c.id, title: CATEGORY_NAMES[c.id] ?? c.id, icon: () => emojiImage(c.icon, 'inline', { lazy: true }),
        cells: c.emojis.map(e => ({ value: e, keywords: (keywords[e] ?? '').toLowerCase(), node: () => emojiImage(e, 'text', { lazy: true }) })) });
    }
    replace(sidebar, list.map(s => el('button', { class: 'category-btn', type: 'button', 'data-category': s.key, title: s.title, onclick: () => goTo(s.key) }, s.icon())));
    replace(sections, list.map(s => {
      const section = clone('t-emoji-section');
      section.dataset.section = s.key;
      section.querySelector('.section-header').textContent = s.title;
      const grid = section.querySelector('.emoji-grid');
      replace(grid, s.cells.map(cell));
      return section;
    }));
    fillRecent();
  }

  function cell(c) {
    // Cells are lazy images: a closed picker loads nothing (PK-11).
    const button = el('button', { class: 'emoji-btn', type: 'button', 'data-emoji': c.value, 'data-kw': c.keywords, title: c.title ?? null }, c.node());
    // The tap moves no focus, and the phone keyboard closes only after the pick (PK-47). A search holds the focus, so
    // the keyboard is open and the sheet sits above it (resizes-content, index.html). A blur on pointerdown closed the
    // keyboard mid-tap: the sheet dropped by the keyboard's height, the tap ended on whatever took the cell's place,
    // and the click never reached the cell (2026-10-24, "a tap on a search result inserts nothing").
    button.addEventListener('pointerdown', e => e.preventDefault());
    button.addEventListener('click', () => {
      if (recordUse) hub.send('emojiUsed', c.value);                                 // PK-07
      onPick(c.value);                                                               // IB-44
      if (overlays.isPhone() && document.activeElement === search) search.blur();    // PK-47
    });
    return button;
  }

  // Recent is frozen while the picker is open; a reopen refreshes it (PK-08).
  function fillRecent() {
    const grid = sections.querySelector('[data-section="recent"] .emoji-grid');
    if (!grid) return;
    const recent = state.emoji?.recent ?? [];
    if (!recent.length) { replace(grid, [el('div', { class: 'emoji-empty' }, 'No recent emojis yet')]); return; }
    replace(grid, recent.map(v => cell(v.startsWith(':') ? { value: v, keywords: v.toLowerCase(), title: v, node: () => packImage(v.slice(1, -1), 'text') ?? document.createTextNode(v) }
                                                        : { value: v, keywords: (keywords[v] ?? '').toLowerCase(), node: () => emojiImage(v, 'text', { lazy: true }) })));
  }

  function goTo(key) {
    search.value = ''; filter('');
    const section = sections.querySelector(`[data-section="${key}"]`);
    if (section) content.scrollTop = section.offsetTop - sections.offsetTop;   // the header directly below the search (PK-04)
    highlight();
  }

  // The search marks cells and sections with attributes the CSS hides (PK-06).
  function filter(raw) {
    const q = raw.trim().toLowerCase();
    let total = 0;
    for (const section of sections.children) {
      let hits = 0;
      for (const b of section.querySelectorAll('.emoji-btn')) {
        const hit = !q || (b.dataset.kw ?? '').includes(q);
        b.toggleAttribute('data-search-miss', !hit);
        if (hit) hits++;
      }
      section.toggleAttribute('data-search-empty', !!q && hits === 0);
      total += hits;
    }
    empty.hidden = !q || total > 0;
    if (q) content.scrollTop = 0;
    highlight();
  }

  // The category button of the section at the top of the view (PK-03).
  function highlight() {
    let active = null;
    for (const section of sections.children) {
      if (section.offsetParent === null) continue;
      if (section.offsetTop - sections.offsetTop <= content.scrollTop + 8) active = section.dataset.section;
    }
    active ??= sections.firstElementChild?.dataset.section;
    for (const b of sidebar.children) b.classList.toggle('active', b.dataset.category === active);
  }

  search.addEventListener('input', () => filter(search.value));
  clear.addEventListener('click', () => { search.value = ''; filter(''); });
  content.addEventListener('scroll', highlight, { passive: true });

  return {
    element: picker,
    async opened() {
      if (!built) await build();
      fillRecent();
      search.value = ''; filter('');
      content.scrollTop = 0;
      highlight();
    },
  };
}

// The picker for a reaction (MR-42, PK-43, PK-44): placed below or above the button on desktop, a sheet on a phone.
export function reactionPicker(rowNode, anchor, onPick, onClose) {
  const wrapper = el('div', { class: 'emoji-picker-wrapper' });
  const backdrop = el('div', { class: 'emoji-picker-backdrop' });
  const picker = EmojiPicker({ onPick: emoji => { close(); onPick(emoji); }, recordUse: false });   // React records the use (MR-44)
  wrapper.append(picker.element);
  rowNode.append(backdrop, wrapper);
  picker.opened();
  placePicker(wrapper, anchor);
  backdrop.addEventListener('click', () => close());
  const close = overlays.open({ element: wrapper, keep: [anchor], onClose: () => { wrapper.remove(); backdrop.remove(); onClose?.(); } });
  return close;
}

// Below the anchor, right-aligned; above when the scrolling parent ends; always inside the window (MR-42).
function placePicker(wrapper, anchor) {
  if (overlays.isPhone()) return;
  const a = anchor.getBoundingClientRect();
  const width = wrapper.offsetWidth || 460, height = wrapper.offsetHeight || 384, margin = 4;   // the picker is 460 px wide (PK-01)
  let limit = innerHeight;
  for (let p = anchor.parentElement; p && p !== document.body; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === 'auto' || o === 'scroll') { limit = Math.min(p.getBoundingClientRect().bottom, innerHeight); break; }
  }
  let top = a.bottom + margin, left = a.right - width;
  if (top + height > limit - margin) top = a.top - height - margin;
  top = Math.max(margin, Math.min(top, innerHeight - height - margin));
  left = Math.max(margin, Math.min(left, innerWidth - width - margin));
  wrapper.style.top = `${top}px`; wrapper.style.left = `${left}px`;
}
