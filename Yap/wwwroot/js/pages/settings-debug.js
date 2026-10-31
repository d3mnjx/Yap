// The DEBUG INFO card of the Settings page (ST-25): what this device holds in Cache Storage, and the emoji images
// of this page load with their timings. Tooling for the work on the cold open, not a setting.

import { build } from '../update.js';
import { clone, el, replace } from '../render/dom.js';
import { size } from '../ui/gif-library.js';

export function mountDebugInfo(page) {
  const $ = sel => page.querySelector(sel);
  $('.debug-info').addEventListener('toggle', e => { if (e.target.open) { cacheReport(); emojiTimings(); } }, { once: true });
  $('.emoji-timing-copy').addEventListener('click', copyEmojiTimings);

  // ---- the caches ----

  async function cacheReport() {
    const note = $('.cache-note'), report = $('.cache-report');
    if (!('caches' in window)) { note.textContent = 'Cache Storage API is not available in this browser.'; return; }
    try {
      const names = await caches.keys();
      const groups = [];
      let totalCount = 0, totalBytes = 0;
      for (const name of names) {
        const cache = await caches.open(name);
        const keys = await cache.keys();
        const entries = [];
        for (const req of keys.slice(0, 200)) {
          const res = await cache.match(req);
          const bytes = Number(res?.headers.get('content-length') ?? 0);
          entries.push({ url: req.url, bytes });
          totalBytes += bytes;
        }
        totalCount += keys.length;
        groups.push({ name, count: keys.length, bytes: entries.reduce((s, e) => s + e.bytes, 0), entries });
      }
      $('.cache-total').textContent = `${totalCount === 1 ? '1 file' : `${totalCount} files`} · ${size(totalBytes)}`;   // ST-25 wording
      if (navigator.storage?.estimate) { const est = await navigator.storage.estimate(); $('.cache-estimate-row').hidden = false; $('.cache-estimate').textContent = `${size(est.usage ?? 0)} of ${size(est.quota ?? 0)}`; }
      replace($('.cache-groups'), groups.map(g => {
        const node = clone('t-cache-group');
        node.querySelector('.cache-group-name').textContent = g.name.startsWith('yap-media') ? 'Media — saved chat attachments' : g.name.startsWith('yap-shell') ? 'App — offline interface' : g.name.startsWith('yap-emoji') ? 'Emoji — downloaded artwork' : g.name;
        node.querySelector('.cache-group-meta').textContent = `${g.count === 1 ? '1 file' : `${g.count} files`} · ${size(g.bytes)}`;
        const list = node.querySelector('.cache-entry-list');
        replace(list, g.entries.length ? g.entries.map(e => el('div', { class: 'cache-entry', title: e.url }, el('span', { class: 'cache-entry-name' }, e.url.split('/').pop() || e.url), el('span', { class: 'cache-entry-size' }, size(e.bytes)))) : [el('span', { class: 'form-hint' }, 'Empty')]);
        if (g.name.startsWith('yap-media') && g.count) { const clear = node.querySelector('.cache-clear'); clear.hidden = false; clear.addEventListener('click', async () => { await caches.delete(g.name); cacheReport(); }); }
        return node;
      }));
      note.hidden = true; report.hidden = false;
    } catch { note.textContent = 'Cache report unavailable.'; }
  }

  // ---- the emoji images of this page load ----
  // From the browser's resource timing: when each was asked for and answered, whether the service worker was in the
  // path (workerStart) and whether a cache answered (transferSize 0). The CDN sends Timing-Allow-Origin, so its
  // entries carry the details. Written for the cold-open wait of 2026-10-31: on the phone every emoji showed about a
  // second after the text, and two fixes from reasoning alone missed; these are the numbers to read there (main.js
  // widens the timing buffer so the entries are still here on the Settings page).

  function emojiTimings() {
    const { entries, cold, answered, marks } = emojiTimingData();
    const rows = [
      ['Emoji images (first 3 s / all)', `${cold.length} / ${entries.length}`],
      ['Rows painted (device / server)', `${ms(marks.paint)} / ${ms(marks.rows)}`],
      ['First 3 s: first asked', cold.length ? ms(cold[0].startTime) : '–'],
      ['First 3 s: half / all answered by', cold.length ? `${ms(answered[Math.floor(answered.length / 2)])} / ${ms(answered.at(-1))}` : '–'],
      ['Through the worker (first 3 s / all)', `${count(cold, viaWorker)} / ${count(entries, viaWorker)}`],
      ['From a cache, 0 B (first 3 s / all)', `${count(cold, fromCache)} / ${count(entries, fromCache)}`],
    ];
    replace($('.emoji-timing-summary'), rows.map(([label, value]) => el('div', { class: 'notification-row' }, el('span', { class: 'notification-label' }, label), el('span', { class: 'notification-value' }, value))));
    // The cold-open set in the order asked, then the rest: the name on its own line, the timing under it.
    const shown = [...cold, ...entries.filter(e => e.startTime >= 3000)].slice(0, 80);
    replace($('.emoji-timing-list'), shown.length ? shown.map(e => el('div', { class: 'emoji-timing-entry', title: e.name },
      el('span', { class: 'cache-entry-name' }, fileOf(e)),
      el('span', { class: 'cache-entry-size' }, `${ms(e.startTime)} → ${ms(e.responseEnd)}${viaWorker(e) ? ' · worker' : ''}${fromCache(e) ? ' · 0 B' : ` · ${size(e.transferSize)}`}`)))
      : [el('span', { class: 'form-hint' }, 'No emoji images loaded in this page yet')]);
  }

  // The same numbers as text for the clipboard, to paste instead of a screenshot: the summary, the requests asked and
  // answered per quarter second, the URLs asked for most, the first forty requests. Without a clipboard (an old
  // browser, a denied permission) the text appears in a box to select by hand.
  async function copyEmojiTimings() {
    const { entries, cold, answered, marks } = emojiTimingData();
    const asked = [], done = [], perUrl = new Map();
    for (const e of cold) {
      const a = Math.floor(e.startTime / 250), d = Math.floor(e.responseEnd / 250);
      asked[a] = (asked[a] ?? 0) + 1; done[d] = (done[d] ?? 0) + 1;
      perUrl.set(fileOf(e), (perUrl.get(fileOf(e)) ?? 0) + 1);
    }
    const buckets = Math.max(asked.length, done.length);
    const text = [
      `Yap emoji timings - build ${build ?? '?'} - ${innerWidth}x${innerHeight} - ${navigator.userAgent}`,
      `marks: paint ${ms(marks.paint)}, rows ${ms(marks.rows)}, bootstrap ${ms(marks.bootstrap)}`,
      `images: ${entries.length} (first 3 s: ${cold.length}); worker ${count(cold, viaWorker)}/${count(entries, viaWorker)}; cache 0 B ${count(cold, fromCache)}/${count(entries, fromCache)}`,
      cold.length ? `first 3 s: first asked ${ms(cold[0].startTime)}, half answered by ${ms(answered[Math.floor(answered.length / 2)])}, all by ${ms(answered.at(-1))}` : 'first 3 s: no emoji images',
      'per 250 ms, asked / answered:',
      ...Array.from({ length: buckets }, (_, b) => `  ${b * 250}-${(b + 1) * 250}: ${asked[b] ?? 0} / ${done[b] ?? 0}`),
      'most asked in the first 3 s:',
      ...[...perUrl].sort((x, y) => y[1] - x[1]).slice(0, 15).map(([name, n]) => `  ${name} x${n}`),
      'first 40 asked (name asked->answered worker bytes):',
      ...cold.slice(0, 40).map(e => `  ${fileOf(e)} ${Math.round(e.startTime)}->${Math.round(e.responseEnd)}${viaWorker(e) ? ' worker' : ''} ${fromCache(e) ? '0 B' : size(e.transferSize)}`),
      entries.length > cold.length ? `later: ${entries.length - cold.length} more, last answered ${ms(Math.max(...entries.map(e => e.responseEnd)))}` : '',
    ].filter(Boolean).join('\n');
    const button = $('.emoji-timing-copy');
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Copied'; setTimeout(() => { button.textContent = 'Copy timings'; }, 2000);
    } catch {
      let box = $('.emoji-timing-text');
      if (!box) { box = el('textarea', { class: 'emoji-timing-text', readonly: 'readonly', rows: '10' }); button.after(box); }
      box.value = text; box.select();
    }
  }
}

// An emoji image: an <img> from the CDN or one of the self-hosted paths (service-worker.js EMOJI_HOSTS and
// EMOJI_PATHS). <img> only, because the same CDN serves the admin's chart script and the install guide.
const isEmojiImage = e => {
  if (e.initiatorType !== 'img') return false;
  try { const u = new URL(e.name); return u.host === 'cdn.jsdelivr.net' || /^\/(emoji-fallback|emoji-packs|custom-emojis)\//.test(u.pathname); } catch { return false; }
};

function emojiTimingData() {
  const entries = performance.getEntriesByType('resource').filter(isEmojiImage).sort((a, b) => a.startTime - b.startTime);
  // The cold-open set: what was asked for in the first three seconds. Those are the images the person waits for;
  // the picker, a later room and the Settings page ask later, and the first report drowned the open in them.
  const cold = entries.filter(e => e.startTime < 3000);
  const answered = cold.map(e => e.responseEnd).sort((a, b) => a - b);
  const markAt = name => performance.getEntriesByName(name, 'mark')[0]?.startTime;
  return { entries, cold, answered, marks: { paint: markAt('paint'), rows: markAt('rows'), bootstrap: markAt('bootstrap') } };
}

const ms = v => v == null ? '–' : `${Math.round(v)} ms`;
const count = (list, test) => list.filter(test).length;
const viaWorker = e => e.workerStart > 0, fromCache = e => e.transferSize === 0;
const fileOf = e => e.name.split('/').pop();
