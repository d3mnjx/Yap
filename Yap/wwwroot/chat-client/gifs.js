import { closePickers } from './pickers.js';
import { get, post } from './api.js';
import { warmMedia } from './media.js';
import * as storage from './storage.js';
const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
};
const paths = {
    recent: 'M12 8v4l3 3m6-3a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
    star: 'M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z',
    server: 'M11.99 18.54l-7.37-5.73L3 14.07l9 7 9-7-1.63-1.27-7.38 5.74zM12 16l7.36-5.73L21 9l-9-7-9 7 1.63 1.27L12 16z',
    trending:
        'M13.5.67s.74 2.65.74 4.8c0 2.06-1.35 3.73-3.41 3.73-2.07 0-3.63-1.67-3.63-3.73l.03-.36C5.21 7.51 4 10.62 4 14c0 4.42 3.58 8 8 8s8-3.58 8-8C20 8.61 17.41 3.8 13.5.67z',
    browse: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
    upload: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
};
function icon(key, size = 20) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'),
        path = document.createElementNS(svg.namespaceURI, 'path');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('fill', 'currentColor');
    path.setAttribute('d', paths[key]);
    if (key === 'recent') {
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', 'currentColor');
        path.setAttribute('stroke-width', '2');
    }
    svg.append(path);
    return svg;
}
export async function favorite(gif, button, owner) {
    const session = await get('session');
    if (session.userId !== owner.userId) throw Error('Account changed');
    const next = !gif.favorite;
    await post('gifs/favorite', { id: gif.id, active: next }, session);
    gif.favorite = next;
    button.classList.toggle('favorited', next);
    button.title = next ? 'Remove from favorites' : 'Add to favorites';
    document.dispatchEvent(new Event('client-gifs-changed'));
}
function preview(item) {
    if (item.preview)
        return { url: item.preview, video: /\.(mp4|webm)(?:\?|$)/i.test(item.preview) };
    const formats = item.previewFormats || [],
        chosen =
            formats.find((f) => f.contentType === 'image/webp') ||
            formats.find((f) => f.contentType === 'image/gif') ||
            formats.find((f) => f.contentType === 'video/mp4') ||
            item.formats?.[0];
    return chosen
        ? { url: chosen.url, video: chosen.contentType.startsWith('video/') }
        : { url: item.url, video: /\.(mp4|webm)(?:\?|$)/i.test(item.url || '') };
}
export function createGifPicker(identity, send, notice, upload) {
    const owner = identity(),
        node = el('div', 'gif-picker'),
        sidebar = el('div', 'gif-sidebar'),
        content = el('div', 'gif-content');
    node.setAttribute('role', 'dialog');
    node.setAttribute('aria-label', 'GIF picker');
    node.append(sidebar, content);
    let library,
        tab,
        query = '',
        folder = null,
        trending,
        remote,
        local = [],
        timer,
        searchController,
        searching = false,
        error = '',
        opened = false;
    const tabs = new Map(),
        previews = new Map(),
        warmed = new Set();
    const searchBox = el('div', 'gif-search'),
        input = el('input', ''),
        clear = el('button', 'gif-search-clear', '✕'),
        spinner = el('span', 'gif-spinner');
    input.placeholder = 'Search your library...';
    input.setAttribute('aria-label', 'Search GIFs');
    clear.title = 'Clear';
    clear.hidden = true;
    spinner.title = 'Searching...';
    spinner.hidden = true;
    const add = el('button', 'gif-upload-btn');
    add.title = 'Upload a GIF';
    add.append(icon('upload', 16));
    add.onclick = upload;
    searchBox.append(input, clear, spinner, add);
    content.append(searchBox);
    const results = el('div', 'gif-results'),
        attribution = el('div', 'gif-attribution');
    content.append(results, attribution);
    for (const [key, label, symbol] of [
        ['recent', 'Recent', 'recent'],
        ['favorites', 'Favorites', 'star'],
        ['server', 'Server library', 'server'],
        ['trending', 'Trending', 'trending'],
        ['browse', 'Browse', 'browse'],
    ]) {
        const button = el('button', 'category-btn');
        button.title = label;
        button.setAttribute('aria-label', label);
        button.append(icon(symbol));
        button.onclick = () => selectTab(key);
        sidebar.append(button);
        tabs.set(key, button);
    }
    function resetSearch() {
        clearTimeout(timer);
        searchController?.abort();
        query = '';
        input.value = '';
        local = [];
        remote = null;
        searching = false;
        error = '';
    }
    function selectTab(key) {
        if (tab === key && !query) return;
        resetSearch();
        tab = key;
        folder = null;
        render();
        results.scrollTop = 0;
        if (key === 'trending' || key === 'browse') loadTrending();
    }
    clear.onclick = () => {
        resetSearch();
        render();
    };
    function media(item, decorative = false) {
        const source = preview(item),
            m = el(source.video ? 'video' : 'img', source.video ? 'gif-card-video' : '');
        m.src = source.url || '';
        if (source.video) {
            m.muted = true;
            m.autoplay = true;
            m.loop = true;
            m.playsInline = true;
            m.preload = 'metadata';
        } else {
            m.alt = decorative ? '' : item.title || 'GIF';
            m.loading = 'lazy';
            m.onload = () => {
                if (source.url && !warmed.has(source.url)) {
                    warmed.add(source.url);
                    warmMedia([source.url], owner).catch(() => {});
                }
            };
        }
        return m;
    }
    function card(item) {
        const card = el('div', 'gif-card');
        if (item.width && item.height) card.style.aspectRatio = item.width + '/' + item.height;
        card.setAttribute('role', 'button');
        card.setAttribute('aria-label', 'Send GIF');
        card.tabIndex = 0;
        card.title = item.title || 'Send GIF';
        card.append(media(item));
        const select = () => {
            const source = item.sourceId
                ? {
                      sourceId: item.sourceId,
                      query: item.selectionQuery ?? '',
                      cursor: item.selectionCursor ?? null,
                  }
                : null;
            const image = preview(item);
            closePickers();
            // Persist the selection before provider resolution; offline/retry uses the same outgoing operation.
            send({
                ...(source ? { gifSource: source } : { gifEntryId: item.id }),
                gifPreview: { ...item, url: item.url || image.url },
            }).catch((e) => notice(e.message));
        };
        card.onclick = select;
        card.onkeydown = (e) => {
            if (e.target === card && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault();
                select();
            }
        };
        if (!item.sourceId) {
            const star = el('button', 'gif-fav-btn' + (item.favorite ? ' favorited' : ''));
            star.title = item.favorite ? 'Remove from favorites' : 'Add to favorites';
            star.append(icon('star', 14));
            star.onclick = (e) => {
                e.stopPropagation();
                favorite(item, star, owner).catch((e) => notice(e.message));
            };
            card.append(star);
        }
        return card;
    }
    function grid(items) {
        const n = el('div', 'gif-grid');
        for (const item of items) n.append(card(item));
        return n;
    }
    function tile(label, items, action) {
        const button = el('button', 'gif-folder-tile');
        button.onclick = action;
        if (!previews.has(label) && items.length)
            previews.set(label, items[Math.floor(Math.random() * items.length)]);
        const item = previews.get(label);
        if (item && !preview(item).video) button.append(media(item, true));
        button.append(el('span', '', label));
        return button;
    }
    function remoteRows(data, title) {
        if (data?.items?.length) {
            if (title) results.append(el('div', 'gif-section-header', title));
            results.append(grid(data.items));
        }
        if (data?.nextCursor) {
            const more = el('button', 'gif-load-more', 'Load more');
            more.onclick = () => (query ? search(data.nextCursor) : loadTrending(data.nextCursor));
            results.append(more);
        }
    }
    function render() {
        const top = results.scrollTop;
        clear.hidden = !input.value;
        spinner.hidden = !searching;
        for (const [key, button] of tabs) {
            button.classList.toggle('active', key === tab);
            button.hidden = key === 'server' && !library?.server.length;
            button.disabled = key === 'trending' && !library?.configured;
        }
        input.placeholder = library?.configured
            ? 'Search ' + library.provider + '...'
            : 'Search your library...';
        attribution.replaceChildren();
        attribution.hidden = !(
            library?.configured &&
            (query || ['trending', 'browse'].includes(tab))
        );
        if (!attribution.hidden && library.attribution) {
            const img = el('img', '');
            img.src = library.attribution;
            img.alt = library.provider;
            attribution.append(img);
        }
        results.replaceChildren();
        if (!library) {
            results.append(el('div', 'gif-empty', error || 'Loading…'));
            return;
        }
        if (query) {
            if (local.length)
                results.append(el('div', 'gif-section-header', 'From your library'), grid(local));
            remoteRows(remote, library.provider);
            if (error) results.append(el('div', 'gif-empty', error));
            else if (!local.length && !remote?.items?.length && !searching)
                results.append(el('div', 'gif-empty', 'No matches'));
        } else if (tab === 'recent') {
            results.append(
                library.recent.length
                    ? grid(library.recent)
                    : el('div', 'gif-empty', 'No recent GIFs yet'),
            );
        } else if (tab === 'favorites' || tab === 'server') {
            const favoriteTab = tab === 'favorites',
                items = favoriteTab ? library.favorites : library.server,
                folders = favoriteTab ? library.favoriteFolders : library.serverFolders;
            const folderOf = (item) =>
                favoriteTab ? library.favoriteFolderMap[item.id] : item.serverFolder;
            if (folder) {
                const back = el('button', 'gif-folder-back', '← ' + folder);
                back.title = favoriteTab ? 'Back to Favorites' : 'Back to the server library';
                back.onclick = () => {
                    folder = null;
                    render();
                    results.scrollTop = 0;
                };
                results.append(
                    back,
                    grid(
                        items.filter(
                            (i) => (folderOf(i) || '').toLowerCase() === folder.toLowerCase(),
                        ),
                    ),
                );
            } else {
                if (folders.length) {
                    const tiles = el('div', 'gif-tile-grid');
                    for (const name of folders)
                        tiles.append(
                            tile(
                                name,
                                items.filter(
                                    (i) => (folderOf(i) || '').toLowerCase() === name.toLowerCase(),
                                ),
                                () => {
                                    folder = name;
                                    render();
                                    results.scrollTop = 0;
                                },
                            ),
                        );
                    results.append(tiles);
                }
                const unsorted = items.filter((i) => !folderOf(i));
                if (unsorted.length) {
                    if (folders.length) results.append(el('div', 'gif-section-header', 'Unsorted'));
                    results.append(grid(unsorted));
                }
                if (!items.length)
                    results.append(
                        el(
                            'div',
                            'gif-empty',
                            favoriteTab
                                ? '⭐ Tap the star on any GIF to save it here'
                                : 'No server GIFs yet',
                        ),
                    );
            }
            if (favoriteTab) {
                const link = el('a', 'gif-manage-link', 'Manage your GIFs in Settings');
                link.href = '/settings#gif-library';
                results.append(link);
            }
        } else {
            if (tab === 'browse' && (library.favorites.length || library.server.length)) {
                const tiles = el('div', 'gif-tile-grid');
                if (library.favorites.length)
                    tiles.append(
                        tile('Favorites', library.favorites, () => selectTab('favorites')),
                    );
                if (library.server.length)
                    tiles.append(
                        tile(library.projectName, library.server, () => selectTab('server')),
                    );
                results.append(tiles);
            }
            remoteRows(trending, tab === 'browse' ? 'Trending' : null);
            if (
                !trending?.items?.length &&
                (library.configured ||
                    tab !== 'browse' ||
                    (!library.favorites.length && !library.server.length))
            )
                results.append(
                    el(
                        'div',
                        'gif-empty',
                        error ||
                            (library.configured
                                ? 'Loading…'
                                : tab === 'browse'
                                  ? 'Nothing here yet'
                                  : 'GIF provider is not configured.'),
                    ),
                );
        }
        results.scrollTop = top;
    }
    function enrich(data, selectionQuery, cursor) {
        return {
            ...data,
            items: (data?.items || []).map((item) => ({
                ...item,
                selectionQuery,
                selectionCursor: cursor,
            })),
        };
    }
    async function loadTrending(cursor = null) {
        if (!library?.configured || (!cursor && trending?.items?.length)) return;
        try {
            let data;
            try {
                data = await get(
                    'gifs?' + new URLSearchParams({ mode: 'trending', cursor: cursor || '' }),
                );
                await storage.saveMetadata('gif-trending:' + (cursor || ''), data, owner);
            } catch (e) {
                data = await storage.metadata('gif-trending:' + (cursor || ''));
                if (!data) throw e;
            }
            const next = enrich(data.remote || { items: [] }, '', cursor);
            trending = cursor
                ? { ...next, items: [...(trending?.items || []), ...next.items] }
                : next;
            error = data.error || '';
            render();
        } catch {
            error = 'Connect to load GIFs.';
            render();
        }
    }
    async function refresh() {
        try {
            library = await get('gifs/library');
            await storage.saveMetadata('gif-library', library, owner);
            previews.clear();
            error = '';
        } catch {
            if (!library) library = await storage.metadata('gif-library');
            if (!library) error = 'Connect to load GIFs.';
        }
        if (identity()?.epoch !== owner.epoch) return;
        tab ??=
            library && (library.configured || library.favorites.length || library.server.length)
                ? 'browse'
                : 'recent';
        render();
        loadTrending();
    }
    function cachedMatches() {
        return [
            ...new Map(
                [
                    ...(library?.favorites || []),
                    ...(library?.server || []),
                    ...(library?.recent || []),
                ].map((i) => [i.id, i]),
            ).values(),
        ].filter((i) => (i.title || '').toLowerCase().includes(query.toLowerCase()));
    }
    async function search(cursor = null) {
        searchController?.abort();
        const controller = (searchController = new AbortController()),
            term = query;
        searching = !!library?.configured;
        render();
        // Local matches can arrive while a slow provider is still working; they never wait behind it.
        if (library?.configured && !cursor)
            get('gifs?' + new URLSearchParams({ mode: 'local', q: term }), {
                signal: controller.signal,
            })
                .then((data) => {
                    if (!controller.signal.aborted && term === query) {
                        local = data.items;
                        render();
                    }
                })
                .catch(() => {});
        try {
            const params = new URLSearchParams({
                mode: library?.configured ? 'search' : 'local',
                q: term,
                cursor: cursor || '',
            });
            let data;
            try {
                data = await get('gifs?' + params, { signal: controller.signal });
                await storage.saveMetadata(
                    'gif-search:' + term + ':' + (cursor || ''),
                    data,
                    owner,
                );
            } catch (e) {
                if (controller.signal.aborted) return;
                data = await storage.metadata('gif-search:' + term + ':' + (cursor || ''));
                if (!data) throw e;
            }
            if (controller.signal.aborted || term !== query) return;
            local = data.items;
            const next = enrich(data.remote || { items: [] }, term, cursor);
            remote = cursor ? { ...next, items: [...(remote?.items || []), ...next.items] } : next;
            error = data.error || '';
        } catch {
            if (!controller.signal.aborted)
                error = library?.configured ? 'Connect to search GIFs.' : '';
        } finally {
            if (!controller.signal.aborted) {
                searching = false;
                render();
            }
        }
    }
    input.oninput = () => {
        clearTimeout(timer);
        searchController?.abort();
        query = input.value.trim();
        remote = null;
        error = '';
        local = cachedMatches();
        searching = !!(query && library?.configured);
        render();
        results.scrollTop = 0;
        if (query) timer = setTimeout(() => search(), 250);
    };
    const overlay = el('div', 'gif-upload-overlay');
    overlay.hidden = true;
    overlay.append(
        el('span', 'gif-upload-spinner'),
        el('span', 'gif-upload-overlay-text', 'Adding GIF…'),
    );
    content.append(overlay);
    let uploading = false;
    const onOutgoing = (event) => {
        const job = event.detail.find(
            (item) => item.gifUpload && !item.cancelled && item.status !== 'failed',
        );
        const busy = !!job && navigator.onLine;
        overlay.hidden = !busy;
        add.disabled = busy;
        add.classList.toggle('is-busy', busy);
        if (uploading && !busy && node.offsetWidth) closePickers();
        uploading = busy;
    };
    document.addEventListener('client-outbox', onOutgoing);
    const onChanged = () => {
        if (opened && node.isConnected) refresh();
    };
    document.addEventListener('client-gifs-changed', onChanged);
    document.addEventListener(
        'chat-clear',
        () => {
            clearTimeout(timer);
            searchController?.abort();
            document.removeEventListener('client-gifs-changed', onChanged);
            document.removeEventListener('client-outbox', onOutgoing);
        },
        { once: true },
    );
    return {
        node,
        opened() {
            opened = true;
            resetSearch();
            render();
            refresh();
        },
    };
}
