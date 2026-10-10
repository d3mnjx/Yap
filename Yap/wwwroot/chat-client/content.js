import { categories, artworkKeys } from './emoji/catalog.js';
import { closePickers, showReactionPicker } from './pickers.js';
import { get, post } from './api.js';
import * as storage from './storage.js';
const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
};
const defaults = ['❤️', '😂', '👍'];
const artwork = new Set(artworkKeys);
const builtInCatalog = { categories, quick: defaults, recent: [] };
let catalogOwner,
    catalog = builtInCatalog,
    lookup,
    pattern;
let loadGeneration = 0,
    revision = 0;
const textSources = new WeakMap();
export const contentRevision = () => revision;
function indexCatalog() {
    const items = catalog.categories.flatMap((c) => c.items);
    lookup = new Map(items.map((e) => [e.value, e]));
    // Shortcodes use the same alphabet as CustomEmojiService; lookup decides which exist.
    pattern = /(:[a-zA-Z0-9_-]+:)/g;
}
indexCatalog();
function applyCatalog(next, owner) {
    catalogOwner = owner;
    catalog = next || builtInCatalog;
    indexCatalog();
    revision++;
    // Upgrade text without replacing message rows, playing media or active editors.
    for (const node of document.querySelectorAll('.message-text')) {
        const source = textSources.get(node);
        if (!source) continue;
        const replacement = richText(...source);
        node.className = replacement.className;
        node.replaceChildren(...replacement.childNodes);
    }
    document.dispatchEvent(new Event('chat-content'));
    warmEmoji();
}
export async function loadContent(owner, online = true) {
    const generation = ++loadGeneration,
        startingRecents = recentRevision;
    const current = async () => {
        const active = await storage.readIdentity();
        return generation === loadGeneration && !active?.locked && active?.epoch === owner.epoch;
    };
    const saved = await storage.metadata('catalog');
    if (!(await current())) return;
    if (catalogOwner?.epoch !== owner.epoch) applyCatalog(saved, owner);
    if (online) {
        try {
            const next = await get('catalog');
            if (!(await current())) return;
            // A selection made while this request was in flight is newer than the response.
            if (recentRevision !== startingRecents) next.recent = catalog.recent;
            await storage.saveMetadata('catalog', next, owner);
            if (!(await current())) return;
            if (recentRevision !== startingRecents) next.recent = catalog.recent;
            applyCatalog(next, owner);
        } catch {
            /* Cached and built-in metadata remain usable without the server. */
        }
    }
}
// Only a few common images are warmed, after the worker can retain them. No artwork
// response is parsed by the page, and this work never gates rendering or selection.
function warmEmoji() {
    if (!navigator.serviceWorker?.controller) return;
    const paths = [
        ...new Set(
            [...defaults, ...(catalog.quick || []), ...(catalog.recent || []).slice(0, 20)]
                .map((value) => emojiItem(value)?.src)
                .filter(Boolean),
        ),
    ];
    navigator.serviceWorker.controller.postMessage({ type: 'chat-warm-emoji', paths });
}
navigator.serviceWorker?.addEventListener('controllerchange', warmEmoji);
export const quickReactions = () => catalog?.quick || ['❤️', '😂', '👍'];
const labelChoices = new Map();
export function chatLabel(kind, fallback, key, ...values) {
    const choices =
        (catalog?.labels?.[kind] || []).filter(
            (value) => typeof value === 'string' && value.length,
        ) || [];
    if (!choices.length) choices.push(fallback);
    const id = kind + ':' + key;
    let selected = labelChoices.get(id);
    // Choose once per conversation; unrelated live snapshots must not reshuffle branding text.
    if (!choices.includes(selected)) {
        selected = choices[Math.floor(Math.random() * choices.length)];
        labelChoices.set(id, selected);
    }
    return selected.replace(/\{(\d+)\}/g, (match, index) => values[index] ?? match);
}
export const uploadLimit = () => catalog?.maxUploadBytes || 100 * 1024 * 1024;
function emojiItem(value) {
    const known = lookup.get(value);
    if (known) return known;
    const points = [...value].map((c) => c.codePointAt(0).toString(16)),
        exact = points.join('-'),
        bare = points.filter((c) => c !== 'fe0f').join('-');
    const key = artwork.has(exact) ? exact : artwork.has(bare) ? bare : null;
    return key ? { value, keywords: '', src: '/chat-client/emoji/' + key + '.svg' } : null;
}
function emojiImage(item) {
    const img = el('img', 'emoji');
    img.src = item.src;
    img.alt = item.value;
    img.loading = 'lazy';
    img.onerror = () => img.replaceWith(document.createTextNode(item.value));
    return img;
}
// Labels use inline emoji conversion; only message bodies create links (never nested links in names).
export function richText(text, small = false, links = !small) {
    const node = el('span', 'message-text' + (small ? ' emoji-small' : ''));
    textSources.set(node, [text, small, links]);
    let only = true,
        count = 0;
    for (const part of links ? text.split(/(https?:\/\/[^\s<>]+)/g) : [text]) {
        if (links && /^https?:\/\//.test(part)) {
            const a = el('a', 'message-link', part);
            a.href = part;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            node.append(a);
            only = false;
            continue;
        }
        for (const token of pattern ? part.split(pattern) : [part]) {
            if (lookup.has(token) && token.startsWith(':')) {
                node.append(emojiImage(lookup.get(token)));
                count++;
                continue;
            }
            // Grapheme segmentation keeps skin tones, flags and ZWJ families as one image.
            for (const { segment } of new Intl.Segmenter(undefined, {
                granularity: 'grapheme',
            }).segment(token)) {
                const item = emojiItem(segment);
                if (item) {
                    node.append(emojiImage(item));
                    count++;
                } else {
                    node.append(document.createTextNode(segment));
                    if (segment.trim()) only = false;
                }
            }
        }
    }
    if (!small && only && count > 0) node.classList.add('emoji-only');
    return node;
}
let recentTimer,
    recentRevision = 0;
export function recordEmoji(value, owner) {
    if (!catalog || !owner) return;
    recentRevision++;
    catalog = { ...catalog };
    catalog.recent = [value, ...(catalog.recent || []).filter((v) => v !== value)].slice(0, 20);
    storage.saveMetadata('catalog', catalog, owner).catch(() => {});
    warmEmoji();
    clearTimeout(recentTimer);
    recentTimer = setTimeout(async () => {
        try {
            if ((await storage.readIdentity())?.epoch !== owner.epoch) return;
            const session = await get('session');
            if (session.userId === owner.userId)
                await post('emoji/recent', { values: catalog.recent }, session);
        } catch {
            /* A preference update must not delay local composition. */
        }
    }, 500);
}
export function createEmojiPicker({ choose, identity, notice = () => {}, record = true }) {
    const picker = el('div', 'emoji-picker'),
        sidebar = el('div', 'emoji-sidebar'),
        content = el('div', 'emoji-content');
    picker.setAttribute('role', 'dialog');
    picker.setAttribute('aria-label', 'Choose emoji');
    picker.append(sidebar, content);
    const searchBox = el('div', 'emoji-search'),
        input = el('input', '');
    input.placeholder = 'Search emojis...';
    input.setAttribute('aria-label', 'Search emojis');
    searchBox.append(input);
    content.append(searchBox);
    const clear = el('button', 'emoji-search-clear', '✕');
    clear.title = 'Clear search';
    clear.onclick = () => {
        input.value = '';
        filter();
    };
    searchBox.append(clear);
    const empty = el('div', 'emoji-empty emoji-search-empty', 'No emojis found');
    empty.hidden = true;
    content.append(empty);
    const sections = new Map(),
        tabs = new Map();
    function cell(item) {
        const button = el('button', 'emoji-btn');
        button.title = item.value;
        button.dataset.emoji = item.value;
        button.dataset.kw = (item.keywords + ' ' + item.value).toLowerCase();
        button.append(emojiImage(item));
        button.onpointerdown = () => {
            if (document.activeElement === input) input.blur();
        };
        button.onclick = () => {
            const owner = identity();
            if (!owner) return;
            // Insertion is synchronous in the user gesture; storage/server bookkeeping must never gate it.
            Promise.resolve(choose(item.value)).catch((error) => notice(error.message));
            if (record) recordEmoji(item.value, owner);
        };
        return button;
    }
    function populate() {
        for (const cat of [
            { key: 'recent', name: 'Recent', icon: lookup.get('🕐')?.src, items: [] },
            ...(catalog?.categories || []),
        ]) {
            const section = el('div', 'emoji-section'),
                grid = el('div', 'emoji-grid');
            section.dataset.section = cat.key;
            section.append(el('div', 'section-header', cat.name), grid);
            content.append(section);
            sections.set(cat.key, section);
            const tab = el('button', 'category-btn');
            tab.title = cat.name[0].toUpperCase() + cat.name.slice(1);
            tab.setAttribute('aria-label', tab.title);
            tab.dataset.category = cat.key;
            if (cat.icon) {
                const img = el('img', 'emoji');
                img.src = cat.icon;
                tab.append(img);
            } else tab.append(richText('🕐', true));
            sidebar.append(tab);
            tabs.set(cat.key, tab);
            tab.onclick = () => {
                input.value = '';
                filter();
                if (cat.key === 'recent') content.scrollTop = 0;
                else {
                    section.scrollIntoView({ block: 'start', behavior: 'instant' });
                    content.scrollTop -= searchBox.offsetHeight;
                }
                highlight();
            };
            for (const item of cat.items) grid.append(cell(item));
        }
    }
    populate();
    let pickerRevision = revision;
    function refresh() {
        if (pickerRevision === revision) return;
        pickerRevision = revision;
        for (const section of sections.values()) section.remove();
        sections.clear();
        tabs.clear();
        sidebar.replaceChildren();
        populate();
        refreshRecents();
        filter();
    }
    function highlight() {
        const top = content.getBoundingClientRect().top + searchBox.offsetHeight + 12;
        let selected;
        for (const [key, section] of sections) {
            if (section.hidden) continue;
            if (!selected || section.getBoundingClientRect().top <= top) selected = key;
        }
        for (const [key, tab] of tabs) tab.classList.toggle('active', key === selected);
    }
    function filter() {
        const query = input.value.trim().toLowerCase();
        let total = 0;
        for (const section of sections.values()) {
            let hits = 0;
            for (const button of section.querySelectorAll('.emoji-btn')) {
                button.hidden = !!query && !button.dataset.kw.includes(query);
                if (!button.hidden) hits++;
            }
            section.hidden = !!query && !hits;
            total += hits;
        }
        empty.hidden = !query || total > 0;
        if (query) content.scrollTop = 0;
        highlight();
    }
    input.oninput = filter;
    content.onscroll = highlight;
    function refreshRecents() {
        // Freeze positions for the duration of this opening; repeated picks must not move the grid.
        const grid = sections.get('recent').querySelector('.emoji-grid');
        grid.replaceChildren();
        for (const value of catalog?.recent || []) {
            const item = emojiItem(value);
            if (item) grid.append(cell(item));
        }
        if (!grid.children.length) grid.append(el('div', 'emoji-empty', 'No recent emojis yet'));
    }
    function opened() {
        refresh();
        refreshRecents();
        input.value = '';
        filter();
        requestAnimationFrame(highlight);
    }
    return { node: picker, opened, refresh, shown: () => requestAnimationFrame(highlight) };
}
export function showEmoji(anchor, choose, owner) {
    const picker = createEmojiPicker({
        identity: () => owner,
        record: false,
        choose: (value) => {
            closePickers();
            return choose(value);
        },
    });
    showReactionPicker(anchor, picker.node, picker.refresh);
    picker.opened();
}
document.addEventListener('chat-clear', () => {
    loadGeneration++;
    clearTimeout(recentTimer);
    catalog = builtInCatalog;
    labelChoices.clear();
    catalogOwner = null;
    indexCatalog();
    revision++;
});
