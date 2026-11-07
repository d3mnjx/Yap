// The GIF picker (pickers.md, PK-13 to PK-42): the rail, the search row, the results, favourites with
// folders, the server library, Browse (the provider's trending GIFs), the upload. A card tap sends; a star only stars.

import { state, on, toggleFavoriteLocally } from '../store.js';
import { uploadOne } from '../upload.js';
import { api } from '../api.js';
import { clone, el, replace } from '../render/dom.js';
import * as overlays from './overlays.js';
import * as router from '../router.js';

// GifPicker({ onSend(gif), onWarn(title, text) }) returns { element, opened() }.
// onSend gets { entryId, preview, isImage, width, height } for a library card, or
// { provider: item, searchText, preview, isImage, width, height } for a provider card.
export function GifPicker({ onSend, onWarn }) {
  const picker = clone('t-gif-picker');
  const rail = picker.querySelector('.gif-sidebar');
  const search = picker.querySelector('.gif-search input');
  const clear = picker.querySelector('.gif-search-clear');
  const spinner = picker.querySelector('.gif-search > .gif-spinner');
  const uploadLabel = picker.querySelector('.gif-upload-btn');
  const uploadInput = uploadLabel.querySelector('input');
  const results = picker.querySelector('.gif-results');
  const attribution = picker.querySelector('.gif-attribution');
  const overlay = picker.querySelector('.gif-upload-overlay');

  const provider = () => state.config?.gifProvider;
  const configured = () => !!provider()?.configured;

  let tab = null;                 // 'recent' | 'favorites' | 'server' | 'browse'
  let folder = null;              // the open folder of favorites or server
  let cache = { recent: null, favorites: null, server: null, trending: null };
  let trendingCursor = null, trendingFailed = false;
  let searchTimer = 0, searchSeq = 0, searching = null;   // searching: { q, library, provider, cursor }
  let everOpened = false;

  // ---- opening and tabs (PK-14, PK-15) ----

  // Recent only when it is the one list with something in it. An empty Recent would hide the
  // no-provider note that Browse shows on a fresh server (PK-14).
  function firstTab() { return !configured() && !cache.favorites?.gifs.length && !cache.server?.gifs.length && cache.recent?.gifs.length ? 'recent' : 'browse'; }

  async function opened() {
    search.value = ''; searching = null; clear.hidden = true;
    search.placeholder = configured() ? `Search ${provider().name}...` : 'Search your library...';   // PK-23
    if (!everOpened) {
      everOpened = true;
      await Promise.all([load('recent'), load('favorites'), load('server')]);
      tab = firstTab();
      if (configured()) loadTrending();
    } else {
      load('recent');                                                                                 // a reopen refreshes Recent (PK-14)
      if (trendingFailed && configured()) loadTrending();
    }
    render();
  }

  for (const b of rail.querySelectorAll('.category-btn')) {
    b.addEventListener('click', () => {
      if (b.dataset.tab === tab) return;                                                              // PK-15
      tab = b.dataset.tab; folder = null;
      search.value = ''; searching = null; clear.hidden = true;
      load(tab === 'browse' ? null : tab);
      if (tab === 'browse' && configured()) loadTrending(true);
      render();
    });
  }

  async function load(name) {
    if (!name) return;
    try {
      const data = await api.get(`/api/gifs/${name}`);
      cache[name] = name === 'recent' ? { folders: [], gifs: data } : data;
      render();
    } catch { /* the last loaded data stays (PK-49) */ }
  }

  async function loadTrending(reset = false) {
    try {
      const page = await api.get(`/api/gifs/trending${reset || !trendingCursor ? '' : `?cursor=${encodeURIComponent(trendingCursor)}`}`);
      cache.trending = reset || !cache.trending ? page.items : [...cache.trending, ...page.items];
      trendingCursor = page.nextCursor; trendingFailed = false;
    } catch { trendingFailed = true; }
    render();
  }

  // ---- search (PK-24, PK-28, PK-31) ----

  search.addEventListener('input', () => {
    clear.hidden = !search.value;
    clearTimeout(searchTimer);
    const q = search.value.trim();
    if (!q) { searching = null; render(); return; }
    searchTimer = setTimeout(() => runSearch(q), 250);   // a quarter second after the last keystroke (PK-24)
  });
  clear.addEventListener('click', () => { search.value = ''; clear.hidden = true; searching = null; render(); });

  async function runSearch(q, cursor = null) {
    const seq = ++searchSeq;
    if (state.connection !== 'connected') { overlays.reason(picker, 'Needs a connection'); return; }
    spinner.hidden = !configured();
    try {
      const data = await api.get(`/api/gifs/search?q=${encodeURIComponent(q)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      if (seq !== searchSeq) return;
      searching = cursor && searching ? { q, library: searching.library, provider: [...searching.provider, ...data.provider], cursor: data.nextCursor }
                                      : { q, library: data.library, provider: data.provider, cursor: data.nextCursor };
    } catch { if (seq === searchSeq) searching = { q, library: [], provider: [], cursor: null }; }
    if (seq === searchSeq) { spinner.hidden = true; render(); }
  }

  // ---- drawing ----

  function render() {
    for (const b of rail.querySelectorAll('.category-btn')) b.classList.toggle('active', b.dataset.tab === tab);
    picker.querySelector('[data-tab="server"]').hidden = !cache.server?.gifs.length;                   // PK-13
    const showAttribution = configured() && (searching || tab === 'browse');                           // PK-30
    attribution.hidden = !showAttribution;
    if (showAttribution) { const img = attribution.querySelector('img'); img.src = provider().attributionImageUrl; img.alt = provider().name; }

    if (searching) { replace(results, searchView()); return; }
    switch (tab) {
      case 'recent': replace(results, cache.recent?.gifs.length ? [grid(cache.recent.gifs, true)] : [empty('No recent GIFs yet')]); break;
      case 'favorites': replace(results, folderedView(cache.favorites, { empty: '⭐ Tap the star on any GIF to save it here', back: 'Back to Favorites', manage: true })); break;
      case 'server': replace(results, folderedView(cache.server, { empty: 'No server GIFs yet', back: 'Back to the server library', manage: false })); break;
      case 'browse': replace(results, browseView()); break;
    }
  }

  const empty = text => el('div', { class: 'gif-empty' }, text);
  const header = text => el('div', { class: 'gif-section-header' }, text);

  function searchView() {
    const nodes = [];
    if (searching.library.length) nodes.push(header('From your library'), grid(searching.library, true));
    if (searching.provider.length) nodes.push(header(provider()?.name ?? ''), grid(searching.provider, false));
    if (searching.cursor) nodes.push(loadMore(() => runSearch(searching.q, searching.cursor)));
    if (!nodes.length) nodes.push(empty(spinner.hidden ? 'No matches' : 'Loading…'));
    return nodes;
  }

  function folderedView(data, { empty: emptyText, back, manage }) {
    const nodes = [];
    if (!data) nodes.push(empty('Loading…'));
    else if (folder) {
      const row = el('button', { class: 'gif-folder-back', type: 'button', title: back, onclick: () => { folder = null; render(); } }, '← ', el('span', null, folder));
      nodes.push(row, grid(data.gifs.filter(g => (g.folder ?? g.serverFolder) === folder), true));
    } else if (!data.gifs.length) nodes.push(empty(emptyText));
    else {
      const folders = (data.folders ?? []).slice().sort((a, b) => a.localeCompare(b));                 // PK-34
      if (folders.length) nodes.push(el('div', { class: 'gif-tile-grid' }, folders.map(f => folderTile(f, data.gifs.filter(g => (g.folder ?? g.serverFolder) === f)))));
      const unsorted = data.gifs.filter(g => !(g.folder ?? g.serverFolder));
      if (unsorted.length) { if (folders.length) nodes.push(header('Unsorted')); nodes.push(grid(unsorted, true)); }
    }
    if (manage) nodes.push(el('a', { class: 'gif-manage-link', href: '/settings#my-gifs' }, 'Manage your GIFs in Settings'));   // ST-01: opens at My GIFs
    return nodes;
  }

  function folderTile(name, gifs, onOpen = () => { folder = name; render(); }) {
    const tile = clone('t-gif-folder-tile');
    const images = gifs.filter(g => g.isImage && g.preview);
    const sample = images[Math.floor(Math.random() * images.length)];
    const img = tile.querySelector('img');
    if (sample) { img.hidden = false; img.src = sample.preview; } else img.remove();
    tile.querySelector('span').textContent = name;
    tile.addEventListener('click', onOpen);
    return tile;
  }

  // The trending feed has no tab of its own; it is the lower part of Browse (PK-18).
  function trendingView() {
    if (trendingFailed) return [empty(state.connection === 'connected' ? 'Could not load GIFs' : 'Needs a connection')];   // PK-49
    if (!cache.trending) return [empty('Loading…')];
    const nodes = [header('Trending')];
    nodes.push(grid(cache.trending, false));
    if (trendingCursor) nodes.push(loadMore(() => loadTrending()));
    return nodes;
  }

  // Without a provider key, Browse says what still works and, for the admin, where the key goes (PK-29).
  function noProviderNote() {
    const lines = [el('p', null, `${provider()?.name ?? 'The GIF provider'} is not set up on this server, so there is no GIF search.`),
      el('p', null, 'Add your own GIFs with the + button next to the search field. Tap the star on any GIF in the chat to keep it in Favorites.')];
    if (state.user?.isAdmin) {
      // The page swap unmounts the composer, so the picker needs no close of its own.
      const link = (text, href) => el('a', { href, onclick: e => { e.preventDefault(); router.navigate(href); } }, text);
      lines.push(el('p', null, ['Admin: ', link('set up the API key', '/admin#settings'), ' for search and trending, or ', link('build the server library', '/admin#gifs'), ', which works without a provider.']));
    }
    return el('div', { class: 'gif-empty gif-no-provider' }, lines);
  }

  function browseView() {
    const nodes = [];
    const tiles = [];
    if (cache.favorites?.gifs.length) tiles.push(folderTile('Favorites', cache.favorites.gifs, () => { tab = 'favorites'; render(); }));
    if (cache.server?.gifs.length) tiles.push(folderTile(state.config?.projectName ?? 'Yap', cache.server.gifs, () => { tab = 'server'; render(); }));
    if (tiles.length) nodes.push(el('div', { class: 'gif-tile-grid' }, tiles));
    if (configured()) nodes.push(...trendingView());
    else nodes.push(noProviderNote());
    return nodes;
  }

  function loadMore(fn) {
    return el('button', { class: 'show-more', type: 'button', onclick: () => { if (state.connection !== 'connected') overlays.reason(picker, 'Needs a connection'); else fn(); } }, 'Load more');
  }

  function grid(items, library) { return el('div', { class: 'gif-grid' }, items.map(item => library ? libraryCard(item) : providerCard(item))); }

  // Enter or Space on the card itself sends. The star is a button inside the card: its own Enter and Space
  // bubble up here and must not send (U01 of the 2026-10-15 user test).
  function sendOnKey(card, send) {
    card.addEventListener('keydown', e => { if (e.target === card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); send(); } });
  }

  // A library card: preview, star (PK-21).
  function libraryCard(g) {
    const card = clone('t-gif-card');
    if (g.width && g.height) card.style.aspectRatio = `${g.width} / ${g.height}`;
    card.prepend(preview(g.preview ?? g.src, g.isImage, 'GIF'));
    const star = card.querySelector('.gif-fav-btn');
    const drawStar = () => { const on = state.favoriteGifIds.has(g.id); star.classList.toggle('favorited', on); star.title = on ? 'Remove from favorites' : 'Add to favorites'; };
    drawStar();
    star.addEventListener('click', async e => {
      e.stopPropagation();
      if (state.connection !== 'connected') { overlays.reason(picker, 'Needs a connection'); return; }   // PK-49
      const on = !state.favoriteGifIds.has(g.id);
      const undo = toggleFavoriteLocally(g.id);                                                   // the star changes now (PK-21)
      try { await api.put(`/api/gifs/${g.id}/favorite`, { on }); } catch (err) { undo(); overlays.reason(picker, err.message); }
    });
    card.tabIndex = 0;
    const send = () => onSend({ entryId: g.id, preview: g.preview ?? g.src, isImage: g.isImage, width: g.width, height: g.height, searchText: searching?.q ?? null });
    card.addEventListener('click', send);
    sendOnKey(card, send);
    return card;
  }

  // A provider card: no star (PK-21). The formats carry several variants; the smallest video preview wins.
  function providerCard(item) {
    const card = clone('t-gif-card');
    card.querySelector('.gif-fav-btn').remove();
    if (item.width && item.height) card.style.aspectRatio = `${item.width} / ${item.height}`;
    const p = bestPreview(item);
    card.prepend(preview(p.url, p.isImage, item.title ?? 'GIF'));
    card.tabIndex = 0;
    const send = () => onSend({ provider: item, searchText: searching?.q ?? null, preview: p.url, isImage: p.isImage, width: item.width, height: item.height });
    card.addEventListener('click', send);
    sendOnKey(card, send);
    return card;
  }

  function bestPreview(item) {
    const formats = item.previewFormats?.length ? item.previewFormats : item.formats ?? [];
    const video = formats.find(f => /^video\//i.test(f.contentType ?? '') || /\.(mp4|webm)(\?|$)/i.test(f.url));
    const chosen = video ?? formats[0];
    return { url: chosen?.url ?? '', isImage: !video };
  }

  function preview(url, isImage, alt) {
    if (isImage) return el('img', { src: url, alt, loading: 'lazy' });
    const video = el('video', { src: url, autoplay: true, muted: true, loop: true, playsinline: true, preload: 'metadata', class: 'gif-card-video' });
    // The attribute alone is not enough: Chrome reads the muted attribute into the muted state only when the
    // parser creates the element, not when script does. Without the property, a Klipy MP4 with an audio track
    // played out loud when the picker opened (PK-19: a muted preview).
    video.muted = true;
    return video;
  }

  // ---- upload (PK-38 to PK-42) ----

  uploadInput.addEventListener('change', async () => {
    const file = uploadInput.files?.[0];
    uploadInput.value = '';
    if (!file) return;
    if (state.connection !== 'connected') { overlays.reason(picker, 'Needs a connection'); return; }
    if (file.size > 50 * 1024 * 1024) { onWarn("Couldn't send GIF", 'File is too large (max 50MB)'); return; }   // PK-38
    uploadLabel.classList.add('is-busy'); uploadLabel.title = 'Adding GIF…';
    uploadLabel.querySelector('.gif-spinner').hidden = false; uploadLabel.querySelector('.gif-upload-icon').setAttribute('hidden', '');
    overlay.hidden = false;
    try {
      const info = await uploadOne(file, state.config?.uploadUrl || '/api/tus', { kind: 'gif', target: 'user', folder: '' });   // favourited as unsorted, within the quota (PK-41, PK-42)
      if (info.type === 'error') { onWarn("Couldn't send GIF", info.error ?? 'Upload failed'); return; }
      if (info.type !== 'gif') { onWarn("Couldn't send GIF", 'Could not process this file as a GIF'); return; }
      onSend({ entryId: info.gifEntryId, preview: null, isImage: true, width: info.width, height: info.height, searchText: null });   // PK-41
      load('favorites'); load('recent');
    } catch {
      onWarn("Couldn't send GIF", 'Upload failed');
    } finally {
      uploadLabel.classList.remove('is-busy'); uploadLabel.title = 'Upload a GIF';
      uploadLabel.querySelector('.gif-spinner').hidden = true; uploadLabel.querySelector('.gif-upload-icon').removeAttribute('hidden');
      overlay.hidden = true;
    }
  });

  // A star elsewhere shows at once (PK-36); the lists refresh when the favourites change.
  on('favoriteGifIds', () => { if (everOpened) load('favorites').then(() => { if (folder && !(cache.favorites?.folders ?? []).includes(folder) && tab === 'favorites') { folder = null; render(); } }); render(); });   // PK-36

  return { element: picker, opened };
}
