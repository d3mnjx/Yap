// The GIF library manager (settings.md ST-21 to ST-24; admin.md AD-21): the person's pool, or the server
// library for the admin. Folders, tags, add, import, export, delete. The same component in both places;
// `server` picks the routes and the wording. The file also exports size(), a byte count as text, which the
// admin page and the debug card of Settings use.

import { state, on } from '../store.js';
import { api } from '../api.js';
import { clone, el, replace, classes } from '../render/dom.js';
import * as overlays from './overlays.js';
import { uploadOne } from '../upload.js';

const FIRST = { user: 6, server: 28 };   // cards shown first (ST-24, AD-22)
const BATCH = 24;

// GifLibrary(host, { server }) returns the function that unmounts it.
export function GifLibrary(host, { server = false } = {}) {
  const root = clone('t-gif-library');
  host.append(root);
  const chips = root.querySelector('.gif-lib-folders');
  const filter = root.querySelector('.gif-lib-filter');
  const grid = root.querySelector('.gif-lib-grid');
  const empty = root.querySelector('.gif-lib-empty');
  const more = root.querySelector('.show-more');
  const strips = root.querySelector('.gif-lib-strips');
  const filesInput = root.querySelector('.files'), packInput = root.querySelector('.pack');
  const addLabel = root.querySelector('.add'), importLabel = root.querySelector('.import'), exportLink = root.querySelector('.export');
  exportLink.href = server ? '/api/admin/gifs/export' : '/api/gifs/export';

  let data = { folders: [], gifs: [], usedBytes: 0, quotaBytes: 0 };
  let folder = null;        // null = All, '' = Unsorted
  let query = '';
  let visible = FIRST[server ? 'server' : 'user'];
  let armed = null;         // the card with "Sure?" shown
  let loadSeq = 0;
  let busy = false;

  // the two hidden inputs: the label opens the input, the attribute `for` is dropped while busy (a label with `for` still opens the dialog)
  const ids = { files: `gif-lib-files-${crypto.randomUUID()}`, pack: `gif-lib-pack-${crypto.randomUUID()}` };
  filesInput.id = ids.files; packInput.id = ids.pack;
  addLabel.htmlFor = ids.files; importLabel.htmlFor = ids.pack;

  async function load() {
    const my = ++loadSeq;
    try {
      const fresh = server ? await api.get('/api/admin/gifs') : await api.get('/api/gifs/library');
      if (my !== loadSeq) return;
      data = server ? { folders: fresh.serverFolders ?? [], gifs: (fresh.entries ?? []).map(e => e.card).filter(c => c.isServer).map(serverCard), usedBytes: 0, quotaBytes: 0 } : fresh;
    } catch (e) { notice(e.message, 'error'); }
    render();
  }

  // A server-library card: its folder is the server folder, and the admin may delete it.
  function serverCard(c) { return { ...c, folder: c.serverFolder ?? null, mine: true }; }

  function shown() {
    let list = data.gifs;
    if (folder !== null) list = list.filter(g => (g.folder ?? '') === folder);
    const q = query.trim().toLowerCase();
    if (q) list = list.filter(g => (g.tags ?? []).some(t => t.includes(q)) || (g.folder ?? '').toLowerCase().includes(q));
    return list;
  }

  function render() {
    const folders = [...new Set(data.folders.concat(data.gifs.map(g => g.folder).filter(Boolean)))].sort((a, b) => a.localeCompare(b));
    const chip = (label, value) => el('button', { class: 'folder-chip', type: 'button', onclick: () => { folder = value; visible = FIRST[server ? 'server' : 'user']; render(); } }, label);
    replace(chips, [chip('All', null), ...(folders.length ? [chip('Unsorted', ''), ...folders.map(f => chip(f, f))] : [])]);
    for (const c of chips.children) c.classList.toggle('active', (c.textContent === 'All' && folder === null) || (c.textContent === 'Unsorted' && folder === '') || (folder && c.textContent === folder));
    filter.hidden = data.gifs.length < 9;                                      // ST-21
    exportLink.hidden = data.gifs.length === 0;

    const quota = root.querySelector('.gif-lib-quota');
    if (!server && data.quotaBytes > 0 && !state.user?.isAdmin) {
      quota.hidden = false;
      const pct = Math.min(100, Math.round(data.usedBytes / data.quotaBytes * 100));
      const fill = quota.querySelector('.gif-lib-quota-fill');
      fill.style.width = `${pct}%`; fill.classList.toggle('hot', pct >= 90);
      quota.querySelector('.gif-lib-quota-label').textContent = `${size(data.usedBytes)} of ${size(data.quotaBytes)} used`;
    } else quota.hidden = true;

    const list = shown();
    if (!list.length) {
      empty.hidden = false;
      empty.textContent = query.trim() ? 'No GIFs match your filter.' : folder !== null ? 'Nothing in this folder.'
        : server ? 'The server library is empty — add GIFs above to give everyone a curated set.' : 'Nothing here yet — star GIFs in the picker, or add your collection above.';
      replace(grid, []); more.hidden = true;
      return;
    }
    empty.hidden = true;
    replace(grid, list.slice(0, visible).map(g => card(g, folders)));
    const left = list.length - visible;
    more.hidden = left <= 0 && visible <= FIRST[server ? 'server' : 'user'];
    more.textContent = left > 0 ? (left > BATCH ? `Show ${BATCH} more (${left - BATCH} left)` : `Show ${left} more`) : 'Show less';
    more.onclick = () => { visible = left > 0 ? visible + BATCH : FIRST[server ? 'server' : 'user']; render(); };
  }

  function card(g, folders) {
    const node = clone('t-gif-lib-card');
    const thumb = node.querySelector('.gif-lib-thumb');
    const url = g.preview ?? g.src;
    thumb.append(url ? el('img', { src: url, loading: 'lazy', alt: '' }) : el('div', { class: 'gif-lib-processing' }, 'processing…'));

    // tags (ST-23)
    const view = node.querySelector('.gif-tags-view'), edit = node.querySelector('.gif-tags-edit'), input = edit.querySelector('.gif-tags-input');
    const tags = g.tags ?? [];
    replace(view, tags.length ? [...tags.slice(0, 4).map(t => el('span', { class: 'gif-tag-chip' }, t)), tags.length > 4 ? el('span', { class: 'gif-tag-chip more' }, `+${tags.length - 4}`) : null] : [el('span', { class: 'gif-tags-empty' }, 'add keywords…')]);
    view.addEventListener('click', () => { view.hidden = true; edit.hidden = false; input.value = tags.join(', '); input.focus(); });
    const cancel = () => { edit.hidden = true; view.hidden = false; };
    const save = async () => {
      const next = [...new Set(input.value.split(',').map(t => t.trim().toLowerCase()).filter(t => t.length >= 2 && t.length <= 64))];
      try { await api.put(`/api/gifs/${g.id}/tags`, { tags: next }); g.tags = next; cancel(); render(); }
      catch (e) { notice(e.message, 'error'); }
    };
    edit.querySelector('.save').addEventListener('click', save);
    edit.querySelector('.cancel').addEventListener('click', cancel);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save(); } else if (e.key === 'Escape') cancel(); });

    // the folder (PK-34, ST-23)
    const select = node.querySelector('.gif-lib-folder-select'), newInput = node.querySelector('.gif-lib-newfolder');
    replace(select, [el('option', { value: '' }, '(unsorted)'), ...folders.map(f => el('option', { value: f }, f)), el('option', { value: '__new__' }, '＋ New folder…')]);
    select.value = g.folder ?? '';
    const move = async target => {
      try {
        if (server) await api.put(`/api/admin/gifs/${g.id}/server`, { on: true, folder: target || null });
        else await api.put(`/api/gifs/${g.id}/favorite`, { on: true, folder: target || null });
        g.folder = target || null; render();
      } catch (e) { notice(e.message, 'error'); select.value = g.folder ?? ''; }
    };
    select.addEventListener('change', () => {
      if (select.value === '__new__') { select.hidden = true; newInput.hidden = false; newInput.value = ''; newInput.focus(); return; }
      move(select.value);
    });
    newInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { const name = newInput.value.trim().slice(0, 64); newInput.hidden = true; select.hidden = false; if (name) move(name); else select.value = g.folder ?? ''; }
      else if (e.key === 'Escape') { newInput.hidden = true; select.hidden = false; select.value = g.folder ?? ''; }
    });

    // delete (two taps) and unstar (ST-24, AD-21)
    const del = node.querySelector('.delete'), unstar = node.querySelector('.unstar');
    if (server || (g.mine && !g.provider)) {
      del.hidden = false;
      del.addEventListener('click', async () => {
        if (armed !== g) { armed = g; del.textContent = 'Sure?'; return; }
        armed = null;
        try {
          const answer = server ? await api.delete(`/api/admin/gifs/${g.id}`) : await api.delete(`/api/gifs/${g.id}`);
          if (answer?.note) notice(answer.note);
          await load();
        } catch (e) { notice(e.message, 'error'); del.textContent = 'Delete'; }
      });
    }
    unstar.title = server ? 'Remove from server library' : 'Remove from your library';
    unstar.addEventListener('click', async () => {
      try {
        if (server) await api.put(`/api/admin/gifs/${g.id}/server`, { on: false });
        else await api.put(`/api/gifs/${g.id}/favorite`, { on: false });
        await load();
      } catch (e) { notice(e.message, 'error'); }
    });
    return node;
  }

  // ---- strips: progress, import, notices, errors ----

  function notice(text, kind = null) {
    const strip = el('div', { class: `gif-lib-strip${kind ? ' ' + kind : ''}` }, el('span', { class: 'gif-lib-strip-text' }, text), el('button', { class: 'gif-lib-strip-dismiss', type: 'button', onclick: () => strip.remove() }, '✕'));
    strips.append(strip);
    return strip;
  }

  // ---- add files (ST-22, PK-38 to PK-42) ----

  filesInput.addEventListener('change', async () => {
    const files = [...filesInput.files]; filesInput.value = '';
    if (!files.length) return;
    setBusy(true);
    const progress = el('div', { class: 'gif-lib-strip' }, 'Uploading…');
    strips.append(progress);
    const errors = [];
    let done = 0;
    for (const file of files) {
      progress.textContent = `Uploading… ${Math.round(done / files.length * 100)}% (${done} of ${files.length})`;
      if (file.size > 50 * 1024 * 1024) { errors.push(`"${file.name}" — too large (${(file.size / 1024 / 1024).toFixed(0)} MB, max 50 MB)`); done++; continue; }
      try {
        const info = await uploadOne(file, state.config?.uploadUrl || '/api/tus', { kind: 'gif', target: server ? 'server' : 'user', folder: folder || '' });
        if (info.type === 'error') errors.push(`"${file.name}" — ${info.error ?? 'upload failed'}`);
      } catch (e) { errors.push(`"${file.name}" — ${e?.message || 'upload failed'}`); }
      done++;
    }
    progress.remove();
    if (errors.length) notice(errors.join('\n'), 'error');
    setBusy(false);
    load();
  });

  // ---- import a zip (ST-22): the gifImport hub message carries the progress ----

  packInput.addEventListener('change', async () => {
    const file = packInput.files?.[0]; packInput.value = '';
    if (!file) return;
    setBusy(true);
    const strip = el('div', { class: 'gif-lib-strip' }, el('span', null, 'Importing…'));
    strips.append(strip);
    try {
      const info = await uploadOne(file, state.config?.uploadUrl || '/api/tus', { kind: 'gif-pack', target: server ? 'server' : 'user' });
      if (info.type === 'error') { strip.remove(); notice(info.error ?? 'import failed — the zip could not be read', 'error'); }
      else importStrip = { id: info.importId, strip };
    } catch { strip.remove(); notice('import failed — the zip could not be read', 'error'); }
    setBusy(false);
  });
  let importStrip = null;
  const offImport = on('gifImport', p => {
    if (!importStrip || p.importId !== importStrip.id) return;
    const text = importStrip.strip.querySelector('span');
    if (!p.completed) { text.textContent = `Importing… ${p.done} of ${p.total}${p.skippedOrFailed ? ` (${p.skippedOrFailed} skipped)` : ''}`; return; }
    importStrip.strip.classList.add(p.error ? 'error' : 'done');
    text.textContent = p.error ?? `Imported ${p.done} of ${p.total}${p.skippedOrFailed ? ` — ${p.skippedOrFailed} skipped` : ''}`;
    importStrip.strip.append(el('button', { class: 'gif-lib-strip-dismiss', type: 'button', onclick: () => importStrip?.strip.remove() }, '✕'));
    importStrip = null;
    load();
  });

  function setBusy(value) {
    busy = value;
    for (const label of [addLabel, importLabel]) {
      label.classList.toggle('disabled', busy);
      if (busy) label.removeAttribute('for'); else label.htmlFor = label === addLabel ? ids.files : ids.pack;
    }
    addLabel.textContent = busy ? 'Uploading…' : '＋ Add GIFs';
  }

  filter.addEventListener('input', () => { query = filter.value; visible = FIRST[server ? 'server' : 'user']; render(); });

  // A star elsewhere, or an upload from the picker, changes the pool at once (ST-23).
  const offFavorites = on('favoriteGifIds', () => { if (!server) load(); });
  load();
  return () => { offImport(); offFavorites(); root.remove(); };
}

export function size(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
