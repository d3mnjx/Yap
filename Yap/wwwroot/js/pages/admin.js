// Administration (admin.md): ten tabs over the admin API, outside the frame (AD-01). Users, Bot, Invites and
// Settings load with the page; Logs, Media and Visitors on their first open; GIFs on every open; Diagnostics
// every 30 s while open (AD-02).

import { state, on, setRegistrations } from '../store.js';
import { api } from '../api.js';
import { clone, el, replace, classes, append } from '../render/dom.js';
import { inline } from '../render/text.js';
import { avatar } from '../render/avatar.js';
import { ago, messageTime } from '../render/time.js';
import * as router from '../router.js';
import { setTitle } from '../notify.js';
import { GifLibrary, size } from '../ui/gif-library.js';
import { tooltips } from '../ui/tooltip.js';
import { confirm, notice } from '../ui/confirm.js';

const TABS = [['users', 'Users'], ['invites', 'Invites'], ['diagnostics', 'Diagnostics'], ['media', 'Media'], ['gifs', 'GIFs'], ['settings', 'Settings'], ['bot', 'Bot'], ['logs', 'Logs'], ['visitors', 'Visitors'], ['debug', 'Debug']];
const CHART_CDN = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js';

const stamp = iso => iso ? new Date(iso).toISOString().slice(0, 16).replace('T', ' ') : '—';
const header = (title, count, extra) => el('div', { class: 'section-header' }, el('h3', null, title), el('span', { class: 'section-count' }, count ?? ''), extra ?? null);
// A table wider than its box slides sideways when the header row is dragged with the mouse; the header is sticky,
// so it is always there to take. Only the header: a drag across the body selects text, and the admin copies IPs
// and invite links from these tables. Touch pans the box natively, and the wheel with Shift scrolls it sideways;
// this is the mouse's third way. The hand cursor (.can-pan) is decided as the pointer comes in, not watched.
const pannable = wrap => {
  wrap.addEventListener('pointerenter', () => wrap.classList.toggle('can-pan', wrap.scrollWidth > wrap.clientWidth));
  wrap.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'mouse' || e.button !== 0 || !e.target.closest('thead') || wrap.scrollWidth <= wrap.clientWidth) return;
    const x0 = e.clientX, left0 = wrap.scrollLeft;
    const move = ev => { wrap.scrollLeft = left0 + x0 - ev.clientX; };
    const end = () => { wrap.classList.remove('panning'); wrap.removeEventListener('pointermove', move); wrap.removeEventListener('pointerup', end); wrap.removeEventListener('pointercancel', end); };
    wrap.setPointerCapture(e.pointerId);   // the slide goes on outside the box; the release lands on the box, not on a header cell, so no tooltip tap
    wrap.classList.add('panning');
    wrap.addEventListener('pointermove', move);
    wrap.addEventListener('pointerup', end);
    wrap.addEventListener('pointercancel', end);
    e.preventDefault();   // no text selection of the header while it slides
  });
  return wrap;
};
const table = (headers, rows, cls = 'users-table') => pannable(el('div', { class: 'table-wrapper' }, el('table', { class: cls }, el('thead', null, el('tr', null, headers.map(h => el('th', typeof h === 'string' ? null : { 'data-tip': h.title }, typeof h === 'string' ? h : h.text)))), el('tbody', null, rows))));   // { text, title }: the bubble of tooltip.js
const td = (content, cls) => el('td', cls ? { class: cls } : null, content);
const pill = (text, cls) => el('span', { class: `action-pill ${cls ?? ''}` }, text);
const fail = e => notice({ title: 'That did not work', text: e.message });   // an action the server refused: the app's dialog, not the browser's alert
const statCard = (label, value) => el('div', { class: 'media-stat-card' }, el('span', { class: 'media-stat-label' }, label), el('span', { class: 'media-stat-value' }, value));
const hint = text => el('span', { class: 'form-hint' }, text);
const empty = text => el('div', { class: 'log-empty' }, text);

export function mount(root, route) {
  if (!state.user?.isAdmin) { router.navigate('/lobby', { replace: true }); return () => {}; }   // AD-01
  const page = clone('t-admin');
  const host = page.querySelector('.tab-host');
  const timers = {};
  const offs = [];
  let unmountTab = () => {};
  let active = null;
  const seen = {};   // tab -> loaded once
  setTitle('Admin');
  const offTips = tooltips(page);   // every data-tip on the page shows in the bubble (AD-25)

  page.querySelector('.back-button').addEventListener('click', () => router.navigate('/lobby'));
  replace(page.querySelector('.admin-tabs'), TABS.map(([id, label]) => el('button', { class: 'tab-item', type: 'button', 'data-tab': id, onclick: () => open(id) }, label)));
  for (const b of page.querySelectorAll('.nav-item')) b.addEventListener('click', () => open(b.dataset.tab));

  function open(tab) {
    unmountTab(); unmountTab = () => {};
    active = tab;
    for (const b of page.querySelectorAll('.nav-item, .tab-item')) b.classList.toggle('active', b.dataset.tab === tab);
    host.replaceChildren();
    unmountTab = tabs[tab](host) ?? (() => {});
  }

  // ---- Users (AD-04, AD-05, AD-07, AD-38 to AD-40) ----
  function users(host) {
    let data = null;
    const danger = dangerZone();
    const draw = () => {
      if (!data) { host.append(empty('Loading...')); return; }
      danger.fill();
      let selected = null;
      const rows = [];
      const render = () => replace(host, [
        header('Users', `${data.total} registered`),
        table(['User', 'Status', 'PWA', 'Created', 'Last Action', 'Locale', 'Recent IPs'], data.users.flatMap(u => {
          const tr = el('tr', { class: 'clickable-row', onclick: () => { selected = selected === u ? null : u; render(); } },
            td([avatar(u.username, u.avatarUrl, 'small'), el('div', { class: 'user-info' }, el('span', { class: 'user-name' }, inline(u.displayName || u.username), u.isAdmin ? el('span', { class: 'admin-badge', title: 'Admin' }, inline('👑')) : null), u.displayName ? el('span', { class: 'user-username' }, u.username) : null)], 'user-cell'),
            td(el('span', { class: `status-pill ${u.status}` }, el('span', { class: 'status-dot' }), u.status[0].toUpperCase() + u.status.slice(1))),
            td(u.pwaInstalledAt ? el('span', { class: 'pwa-badge', 'data-tip': `Last seen as installed PWA: ${stamp(u.pwaInstalledAt)}` }, 'Installed') : el('span', { class: 'no-data' }, '—'), 'pwa-cell'),
            td(stamp(u.createdAt), 'date-cell'),
            td(u.lastAction ? [el('span', { class: 'action-type' }, u.lastAction.action), el('span', { class: 'action-date' }, stamp(u.lastAction.at))] : el('span', { class: 'no-data' }, '—'), 'action-cell'),
            td(u.timeZone || u.locale ? [el('span', { class: 'locale-tz', 'data-tip': u.timeZone ?? null }, u.timeZone ?? ''), el('span', { class: 'locale-lang' }, u.locale ?? '')] : el('span', { class: 'no-data' }, '—'), 'locale-cell'),
            td(u.recentIps.length ? u.recentIps.map(ip => el('span', { class: 'ip-tag', 'data-tip': ip.country ?? null }, ip.ip)) : el('span', { class: 'no-data' }, '—'), 'ip-cell'));
          tr.classList.toggle('selected', selected === u);
          const out = [tr];
          if (selected === u) out.push(el('tr', { class: 'detail-row' }, el('td', { colspan: 7 }, detail(u))));
          return out;
        })),
        el('div', { class: 'section-header theme-stats-header' }, el('h3', null, 'Themes'), el('span', { class: 'section-count' }, 'effective theme per user (unset counts as default)')),
        el('div', { class: 'theme-stats' }, data.themes.map(t => el('div', { class: `theme-stat-card${t.count ? '' : ' unused'}` },
          el('span', { class: 'theme-stat-swatch', style: { background: t.previewBg } }, el('span', { class: 'theme-stat-accent', style: { background: t.previewAccent } })),
          el('div', { class: 'theme-stat-info' }, el('span', { class: 'media-stat-label' }, t.name), el('span', { class: 'media-stat-value' }, String(t.count), t.count ? el('span', { class: 'theme-stat-pct' }, `${Math.round(t.count / Math.max(1, data.total) * 100)}%`) : null))))),
        danger.node,
      ]);
      render();
    };
    function detail(u) {
      const panel = el('div', { class: 'user-detail-panel' },
        el('div', { class: 'detail-header' }, avatar(u.username, u.avatarUrl, 'medium'), el('div', { class: 'detail-header-info' }, el('h4', null, inline(u.displayName || u.username)), u.displayName ? el('span', { class: 'user-username' }, u.username) : null),
          el('button', { class: 'detail-close', type: 'button', title: 'Close', onclick: e => { e.stopPropagation(); host.querySelector('.detail-row')?.remove(); } }, '×')),
        el('div', { class: 'detail-loading' }, 'Loading...'));
      api.get(`/api/admin/users/${encodeURIComponent(u.username)}`).then(d => {
        panel.querySelector('.detail-loading').replaceWith(
          el('div', { class: 'detail-tags' },
            el('span', { class: `detail-tag ${d.pushSubscriptions ? 'tag-green' : 'tag-muted'}` }, el('span', null, d.pushSubscriptions ? `Push ${d.pushSubscriptions} sub(s)` : 'No push')),
            el('span', { class: `detail-tag ${d.pwaInstalledAt ? 'tag-green' : 'tag-muted'}` }, el('span', null, d.pwaInstalledAt ? `PWA installed (${stamp(d.pwaInstalledAt).slice(0, 10)})` : 'No PWA')),
            el('span', { class: 'detail-tag tag-muted', 'data-tip': d.theme.chosen ?? 'never picked a theme' }, el('span', { class: 'theme-swatch', style: { background: (state.config.themes.find(t => t.id === d.theme.effective) ?? {}).previewBg ?? '' } }), el('span', null, `${d.theme.name}${d.theme.chosen ? '' : ' (default)'}`))),
          el('div', { class: 'detail-tables' },
            el('div', { class: 'detail-section' }, el('h5', null, 'IP Addresses'), d.ips.length ? table(['IP Address', 'Location', 'Last Seen'], d.ips.map(i => el('tr', null, td(i.ip, 'ip-mono'), td(i.country ?? '—', 'geo-cell'), td(stamp(i.lastSeen), 'date-cell'))), 'detail-table') : el('span', { class: 'no-data' }, 'No IP data')),
            el('div', { class: 'detail-section' }, el('h5', null, 'User Agents'), d.userAgents.length ? table(['User Agent', 'Last Seen'], d.userAgents.map(a => el('tr', null, td(a.userAgent, 'ua-cell'), td(stamp(a.lastSeen), 'date-cell'))), 'detail-table') : el('span', { class: 'no-data' }, 'No user agent data'))));
      }).catch(e => { panel.querySelector('.detail-loading').textContent = e.message; });
      return panel;
    }
    const load = () => api.get('/api/admin/users').then(d => { data = d; draw(); }).catch(e => replace(host, [empty(e.message)]));   // read once per page load (AD-04, GEN-22)
    load();
    draw();

    // The Danger Zone (AD-38 to AD-40): one account by name, or every account inactive for a number of days, each
    // behind a red question that names who goes. One node for the tab's life: a row tap renders the tab again and
    // puts it back, so a found list and a result line survive the tap.
    function dangerZone() {
      const result = el('p', { class: 'danger-result', hidden: true });
      const account = el('select', { class: 'form-input danger-select' });
      const days = el('input', { class: 'form-input danger-days', type: 'number', min: 1, max: 3650, value: 90 });
      const found = el('div', { class: 'danger-found', hidden: true });
      const plural = n => n === 1 ? 'account' : 'accounts';
      const dayWord = n => n === 1 ? 'day' : 'days';
      const say = (text) => { result.textContent = text; result.hidden = false; };
      const remove = async names => {
        const one = names.length === 1;
        const ok = await confirm({ danger: true, title: one ? `Delete ${names[0]}?` : `Delete ${names.length} accounts?`, action: one ? 'Delete account' : `Delete ${names.length} accounts`,
          text: `${one ? '' : `${names.join(', ')}\n\n`}${one ? 'The person is' : 'They are'} signed out everywhere. Their direct messages are deleted on both sides. Room messages stay, signed "${one ? names[0] : 'name'} (deleted)". The ${one ? 'name is' : 'names are'} free again. This cannot be undone.` });
        if (!ok) return;
        try {
          const r = await api.post('/api/admin/users/delete', { usernames: names });
          found.hidden = true;
          say(r.deleted === 1 ? `Deleted ${names[0]}.` : `Deleted ${r.deleted} accounts.`);
          await load();   // the table, the themes and the account list again (AD-04: a load, never a patch)
        } catch (e) { say(e.message); }
      };
      const find = async () => {
        const n = Math.max(1, parseInt(days.value, 10) || 90);
        try {
          const { users: rows } = await api.get(`/api/admin/inactive?days=${n}`);
          replace(found, rows.length ? [
            el('p', { class: 'danger-found-title' }, `${rows.length} ${plural(rows.length)} with no visit for ${n} ${dayWord(n)}:`),
            el('ul', null, rows.map(u => el('li', null, avatar(u.username, u.avatarUrl, 'small'), inline(u.displayName || u.username), u.displayName ? el('span', { class: 'danger-found-username' }, u.username) : null, el('span', { class: 'danger-found-ago' }, `last seen ${ago(u.lastActiveAt)}`)))),
            el('button', { class: 'delete-button', type: 'button', onclick: () => remove(rows.map(u => u.username)) }, `Delete ${rows.length} ${plural(rows.length)}`),
          ] : [el('p', { class: 'danger-found-title' }, `Every account was active in the last ${n} ${dayWord(n)}.`)]);
          found.hidden = false; result.hidden = true;
        } catch (e) { say(e.message); }
      };
      const node = el('section', { class: 'danger-section' },
        el('h3', null, 'Danger Zone'),
        el('div', { class: 'danger-item' },
          el('div', { class: 'danger-text' }, el('span', { class: 'danger-title' }, 'Delete an account'),
            el('span', { class: 'danger-desc' }, 'The person is signed out everywhere and the name is free again. Their direct messages are deleted on both sides; their room messages stay, signed "name (deleted)".')),
          el('div', { class: 'danger-controls' }, account, el('button', { class: 'delete-button', type: 'button', onclick: () => { if (account.value) remove([account.value]); } }, 'Delete account'))),
        el('div', { class: 'danger-item' },
          el('div', { class: 'danger-text' }, el('span', { class: 'danger-title' }, 'Delete inactive accounts'),
            el('span', { class: 'danger-desc' }, 'Accounts with no visit for this many days. A connected person never counts. Find shows who goes before anything is deleted.')),
          el('div', { class: 'danger-controls' }, days, el('span', { class: 'danger-unit' }, 'days'), el('button', { class: 'delete-button', type: 'button', onclick: find }, 'Find'))),
        found, result);
      // The admin and the bot are never offered (AD-40); the list follows every load.
      const fill = () => {
        const options = (data?.users ?? []).filter(u => !u.isAdmin && !u.isBot).map(u => el('option', { value: u.username }, u.displayName ? `${u.displayName} (${u.username})` : u.username));
        replace(account, options.length ? options : [el('option', { value: '' }, 'No accounts')]);
        account.disabled = node.querySelector('.danger-select + .delete-button').disabled = !options.length;
      };
      return { node, fill };
    }
  }

  // ---- Debug (AD-08) ----
  function debug(host) {
    const channel = el('select', null, state.rooms.map(r => el('option', { value: r.id }, r.name)));
    const count = el('input', { type: 'number', min: 1, max: 5000, value: 200 });
    const span = el('select', null, [[1, 'Last 1 hour'], [6, 'Last 6 hours'], [24, 'Last 1 day'], [72, 'Last 3 days'], [168, 'Last 1 week'], [336, 'Last 2 weeks'], [720, 'Last 1 month'], [2160, 'Last 3 months'], [8760, 'Last 1 year']].map(([v, l]) => el('option', { value: v }, l)));
    span.value = '168';
    const result = el('div', { class: 'debug-result' });
    const button = el('button', { class: 'generate-btn', type: 'button' }, el('span', null, `Generate ${count.value} messages`));
    count.addEventListener('input', () => { button.firstChild.textContent = `Generate ${count.value} messages`; });
    button.addEventListener('click', async () => {
      button.disabled = true; button.firstChild.textContent = 'Generating...';
      try { const r = await api.post('/api/admin/generate', { channelId: channel.value, count: Number(count.value), hours: Number(span.value) }); result.textContent = `Generated ${r.generated} messages spread across ${r.hours}h`; }
      catch (e) { result.textContent = `Error: ${e.message}`; }
      button.disabled = false; button.firstChild.textContent = `Generate ${count.value} messages`;
    });
    host.append(header('Message Generator', 'Generate test messages for debugging'),
      el('div', { class: 'debug-form' }, el('div', { class: 'form-group' }, el('label', null, 'Channel'), channel), el('div', { class: 'form-group' }, el('label', null, 'Number of messages'), count), el('div', { class: 'form-group' }, el('label', null, 'Spread across'), span), button, result));
  }

  // ---- Bot (AD-09): the picture, the display name, and the three parts of the welcome DM ----
  function bot(host) {
    let b = null;
    const name = el('input', { type: 'text', class: 'form-input', maxlength: 32 });
    const username = el('input', { type: 'text', class: 'form-input disabled', disabled: true });
    const part = rows => el('textarea', { class: 'form-input form-textarea', rows, maxlength: 1000 });
    const welcome = part(3), phone = part(3), link = part(4);
    const returnAfter = el('input', { type: 'number', class: 'form-input bot-hours', min: 0, max: 720, step: 1 });   // the server clamps to the same range
    const result = el('span', { class: 'save-result' });
    const preview = el('pre', { class: 'bot-preview' });
    const avatarHost = el('div', { class: 'bot-avatar' });
    const avatarResult = el('span', { class: 'form-hint' });
    // The DM as a phone user with a login link would get it, from the parts as typed. The same fill as the server's.
    const drawPreview = () => {
      const server = b?.serverName ?? 'Yap';
      const fill = t => t.replaceAll('{server}', server).replaceAll('{0}', server).replaceAll('{link}', `${location.origin}/invite/CODE-1234`).replaceAll('{code}', 'CODE-1234');
      preview.textContent = [welcome.value, phone.value, link.value].map(t => t.trim()).filter(Boolean).map(fill).join('\n\n');
    };
    for (const t of [welcome, phone, link]) t.addEventListener('input', drawPreview);
    // The picture goes the way a person's own does (ST-04); the profile broadcast redraws it in every open chat.
    const drawAvatar = () => replace(avatarHost, [
      avatar(b?.username ?? '', b?.avatarUrl, 'large'),
      el('div', { class: 'bot-avatar-actions' },
        el('label', { class: 'upload-button' }, 'Upload picture', el('input', { type: 'file', accept: 'image/*', hidden: true, onchange: async e => {
          const file = e.target.files?.[0]; e.target.value = '';
          if (!file) return;
          if (!file.type.startsWith('image/') || file.size > 10 * 1024 * 1024) { avatarResult.textContent = 'Choose an image up to 10 MB'; return; }
          const form = new FormData(); form.append('file', file);
          avatarResult.textContent = 'Uploading...';
          try { const r = await api.put('/api/admin/bot/avatar', form); b.avatarUrl = r.avatarUrl; b.customAvatar = true; avatarResult.textContent = 'Picture saved'; drawAvatar(); }
          catch (err) { avatarResult.textContent = err.message; }
        } })),
        b?.customAvatar ? el('button', { class: 'reject-btn', type: 'button', onclick: async () => {
          try { await api.delete('/api/admin/bot/avatar'); const fresh = await api.get('/api/admin/bot'); b.avatarUrl = fresh.avatarUrl; b.customAvatar = false; avatarResult.textContent = 'Default picture restored'; drawAvatar(); }
          catch (err) { avatarResult.textContent = err.message; }
        } }, 'Use the default') : null,
        avatarResult)]);
    const save = el('button', { class: 'save-btn', type: 'button', onclick: async () => {
      save.disabled = true; save.textContent = 'Saving...';
      try {
        await api.put('/api/admin/bot', { displayName: name.value, welcomeMessage: welcome.value, phoneMessage: phone.value, linkMessage: link.value,
          returnAfterHours: returnAfter.value === '' ? null : Number(returnAfter.value) });
        result.textContent = 'Saved!';
      }
      catch (e) { result.textContent = e.message; }
      save.disabled = false; save.textContent = 'Save';
    } }, 'Save');
    api.get('/api/admin/bot').then(d => {
      b = d; username.value = b.username ?? ''; name.value = b.displayName ?? '';
      welcome.value = b.welcomeMessage ?? ''; phone.value = b.phoneMessage ?? ''; link.value = b.linkMessage ?? '';
      returnAfter.value = b.returnAfterHours ?? '';
      drawAvatar(); drawPreview();
    }).catch(e => { result.textContent = e.message; });
    host.append(header('Bot Settings', 'System bot configuration'),
      el('div', { class: 'bot-settings' },
        el('div', { class: 'form-group' }, el('label', null, 'Picture'), avatarHost),
        el('div', { class: 'form-group' }, el('label', null, 'Username'), username, hint('Username cannot be changed after creation')),
        el('div', { class: 'form-group' }, el('label', null, 'Display Name'), name),
        el('div', { class: 'form-group' }, el('label', null, 'Welcome Message'), welcome, hint('Sent to every new user as a DM, one minute after their first session. {server} is the server name.')),
        el('div', { class: 'form-group' }, el('label', null, 'Phone part'), phone, hint('Added when the new user is on a phone. [pwa-install] becomes the install link. Empty: nothing is added.')),
        el('div', { class: 'form-group' }, el('label', null, 'Login link part'), link, hint('Added when the new user has a login link. {link} is the link, {code} its code. Empty: nothing is added.')),
        el('div', { class: 'form-group' }, el('label', null, 'Preview'), preview, hint('As a phone user with a login link receives it.')),
        el('div', { class: 'form-group' }, el('label', null, 'Return notice (hours)'), returnAfter, hint('Hours a person must be away before the bot tells you that the person is back. 0 turns it off.')),
        el('div', { class: 'bot-actions' }, save, result)));
  }

  // ---- Settings (AD-10 to AD-14) and the pending requests (AD-11) ----
  function settings(host) {
    let s = null;
    const toggle = (label, hintText, key, { disabled = false, note = null } = {}) => {
      const row = clone('t-toggle-row');
      row.querySelector('.toggle-label').textContent = label;
      const h = row.querySelector('.toggle-hint'); h.textContent = hintText;
      if (note) h.append(el('br'), el('strong', { style: { color: 'var(--status-away)' } }, note));
      const input = row.querySelector('input'); input.checked = !!s[key]; input.disabled = disabled;
      input.addEventListener('change', async () => { try { await api.put('/api/admin/settings', { [key]: input.checked }); } catch (e) { input.checked = !input.checked; fail(e); } });
      return row;
    };
    // Reverse proxy and Cloudflare (AU-09): what is trusted, what the server sees, and the lines to paste. Always
    // shown, unlike the red notice above the tabs, which only appears while a proxy is not trusted.
    const proxyHost = el('div');
    const drawProxy = ({ proxy, cloudflare, you }) => {
      const peer = proxy.untrustedPeer;
      const trusted = proxy.trusted.length ? proxy.trusted.join(', ') : '';
      const seen = you.address
        ? `Your address as the server sees it: ${you.address}${you.viaCloudflare ? ' (through Cloudflare)' : ''}, connection from ${you.peer}, scheme ${you.scheme}.`
        : `Your address is unknown to the server (connection from ${you.peer}, scheme ${you.scheme}). A forwarded header came from a peer that is not trusted.`;
      // The lines with the values this very request shows: the origin the admin's browser used, and the peer the
      // connection came from (the proxy or the Docker gateway). Shown inside the block they belong to.
      const snippet = `"ChatSettings": {\n  "PublicOrigin": "${location.origin}",\n  "TrustedProxies": ["${peer ?? you.peer ?? '172.17.0.1'}"],\n  ...\n}`;
      replace(proxyHost, [el('details', { class: 'howto-box', open: !!peer },
        el('summary', null, el('span', { class: 'toggle-label' }, 'Reverse proxy and Cloudflare'),
          el('span', { class: `howto-status${trusted && !peer ? ' on' : ''}` }, trusted ? `trusted: ${trusted}` : 'no proxy trusted')),
        el('div', { class: 'howto-body' },
          el('p', null, seen),
          peer ? el('p', null, `Requests come from ${peer}, which is not in TrustedProxies (forwarded chain: ${proxy.forwardedFor}). Every client address counts as unknown and smart login is off. ${proxy.count} such requests since ${stamp(proxy.firstSeenAt)}.`) : null,
          el('p', null, `Cloudflare needs no entry: ${cloudflare.count} Cloudflare networks are known (${cloudflare.source}${cloudflare.refreshedAt ? ', ' + stamp(cloudflare.refreshedAt) : ''}). Behind a Cloudflare hop the visitor comes from CF-Connecting-IP, also through Caddy or nginx.`),
          el('p', null, 'List the proxy next to this server, or the Docker gateway when this server runs in a container. The values below are detected from this request. Add the two lines to the "ChatSettings" block of Data/appsettings.json, keep the rest of the block, and restart. A network in CIDR form (172.17.0.0/16) survives a gateway change; the single address works too.'),
          el('pre', null, snippet),
          el('p', null, you.address ? 'The chain works when the address above is your own public address, not a Docker gateway and not a Cloudflare address.' : 'List the peer above, restart, and reload this page. Your address should then be your own public address.'))),
      ]);
    };
    api.get('/api/admin/status').then(drawProxy).catch(() => {});
    const pendingHost = el('div');
    const drawPending = () => {
      const list = state.registrations;   // the hub's `pending` message keeps it current; the page's answer seeds it
      replace(pendingHost, list.length ? [
        el('div', { class: 'section-header', style: { marginTop: '2rem' } }, el('h3', null, 'Pending Requests'), el('span', { class: 'section-count' }, `${list.length} waiting`)),
        el('div', { class: 'pending-list' }, list.map(p => el('div', { class: 'pending-item' },
          el('div', { class: 'pending-info' }, el('span', { class: 'pending-username' }, p.username), el('span', { class: 'pending-time' }, ago(p.requestedAt))),
          el('div', { class: 'pending-actions' },
            el('button', { class: 'approve-btn', type: 'button', onclick: () => api.post(`/api/admin/pending/${encodeURIComponent(p.username)}/approve`).catch(e => fail(e)) }, 'Approve'),
            el('button', { class: 'reject-btn', type: 'button', onclick: () => api.post(`/api/admin/pending/${encodeURIComponent(p.username)}/reject`).catch(e => fail(e)) }, 'Reject')))))] : []);
    };
    const draw = () => replace(host, [
      header('Registration', 'Control who can join'),
      el('div', { class: 'registration-settings' },
        toggle('Close registration', 'Block all new signups. Login page shows "temporarily closed".', 'registrationClosed'),
        toggle('Require approval', 'New users must wait for admin approval before joining.', 'requireApproval'),
        toggle('Smart login', 'Auto-login returning users from the same IP address without a code. Users can disable it individually in Settings.', 'smartLogin')),
      el('div', { class: 'section-header', style: { marginTop: '2rem' } }, el('h3', null, 'Link Previews'), el('span', { class: 'section-count' }, 'OpenGraph preview cards')),
      el('div', { class: 'registration-settings' },
        toggle('Enable link previews', 'Show OpenGraph preview cards below messages with URLs.', 'linkPreviews'),
        toggle('Enable media caching', 'Auto-download videos/audio from YouTube, Spotify, SoundCloud (under 10 min) for inline playback.', 'mediaCaching', { disabled: !s.mediaCachingAvailable, note: s.mediaCachingAvailable ? null : 'yt-dlp not found on this system.' })),
      el('div', { class: 'section-header', style: { marginTop: '2rem' } }, el('h3', null, 'GIFs'), el('span', { class: 'section-count' }, 'Klipy content rating')),
      el('div', { class: 'registration-settings' }, el('label', { class: 'toggle-row' },
        el('div', { class: 'toggle-info' }, el('span', { class: 'toggle-label' }, 'Content rating'), el('span', { class: 'toggle-hint' }, 'How strictly Klipy filters search and trending results. G = strictest (kid-friendly). PG = mild (default). PG-13 = some edgy content. R = anything goes.')),
        Object.assign(el('select', { class: 'log-filter-select', onchange: e => api.put('/api/admin/settings', { gifRating: e.target.value }).catch(err => fail(err)) }, [['g', 'G'], ['pg', 'PG'], ['pg13', 'PG-13'], ['r', 'R']].map(([v, l]) => el('option', { value: v }, l))), { value: s.gifRating ?? 'pg' })),
        el('div', { class: `provider-status${s.gifProviderConfigured ? ' on' : ''}` }, el('span', { class: `status-dot ${s.gifProviderConfigured ? 'status-online' : 'status-offline'}` }), s.gifProviderConfigured ? 'Provider: configured' : 'Provider: not configured')),
      el('div', { class: 'howto-list' }, howto('Klipy API key', s.gifProviderConfigured ? 'configured' : '', 'off — no GIF search, no trending', [
        'Without a key the picker has no search and no trending. Own uploads, favourites and the server library (the GIFs tab here) work without it.',
        ['Make a free account at partner.klipy.com and create an app. Copy its API key.', 'Put the key in appsettings.json under ChatSettings:GifSettings:Klipy:ApiKey, or set the environment variable ChatSettings__GifSettings__Klipy__ApiKey.', 'Restart Yap. The picker then searches Klipy and shows trending GIFs.'],
        'The content rating above applies to the key once it works.'])),
      el('div', { class: 'section-header', style: { marginTop: '2rem' } }, el('h3', null, 'Deployment'), el('span', { class: 'section-count' }, 'Set in appsettings.json, per instance')),
      el('div', { class: 'howto-list' },
        proxyHost,
        howto('Upload subdomain (tus)', s.uploadUrl, 'off — uploads use /api/tus on this domain', [
          'Uploads that pass through the Cloudflare proxy hit its request size limit. A direct subdomain avoids that limit, so large files upload without errors.',
          ['Add a DNS record for upload.your-domain.com. Make it DNS-only (grey cloud). Point it at this server.', "Give this server a trusted TLS certificate for that hostname (for example Let's Encrypt). Cloudflare origin certificates do not work here, because the browser connects directly.", 'Set ChatSettings:UploadUrl to https://upload.your-domain.com/api/tus and restart. In Docker, set the env var ChatSettings__UploadUrl instead.'],
          'Leave the setting empty to upload through the main domain.']),
        howto('IPv4 beacon', s.beaconUrl, 'off — dualstack clients show IPv6 only', [
          "A dualstack client connects over IPv6, so its IPv4 never reaches the server. The beacon makes the browser send one background request to an IPv4-only hostname. That request reveals the client's IPv4, and the Diagnostics sessions table then shows both addresses.",
          ['Add a DNS A record only (no AAAA) for ip4.your-domain.com. Make it DNS-only (grey cloud). Point it at this server.', 'Give this server a trusted TLS certificate for that hostname, same as for the upload subdomain.', 'Set ChatSettings:Ipv4BeaconUrl to https://ip4.your-domain.com and restart. In Docker, set the env var ChatSettings__Ipv4BeaconUrl instead.'],
          'Leave the setting empty to disable. The value is display-only and never affects login decisions.'])),
      pendingHost,
    ]);
    const howto = (label, value, off, [intro, steps, outro]) => el('details', { class: 'howto-box' },
      el('summary', null, el('span', { class: 'toggle-label' }, label), el('span', { class: `howto-status${value ? ' on' : ''}` }, value || off)),
      el('div', { class: 'howto-body' }, el('p', null, intro), el('ol', null, steps.map(t => el('li', null, t))), el('p', null, outro)));
    api.get('/api/admin/settings').then(d => { s = d; if (!state.registrations.length && d.pending?.length) setRegistrations(d.pending); draw(); drawPending(); }).catch(e => replace(host, [empty(e.message)]));
    const off = on('registrations', drawPending);   // the hub's `pending` message (AD-11)
    return () => off();
  }

  // ---- Invites and login links (AD-15 to AD-17) ----
  function invites(host) {
    let data = null, users = [];
    const forSelect = el('select', null, el('option', { value: '' }, 'Someone new (invite)'));
    const note = el('input', { type: 'text', maxlength: 64, placeholder: 'for Tom' });
    const expires = el('select', null, [[0, 'Never'], [1, 'In 1 day'], [7, 'In 7 days'], [30, 'In 30 days']].map(([v, l]) => el('option', { value: v }, l)));
    const result = el('span', { class: 'save-result' });
    const noteGroup = el('div', { class: 'form-group' }, el('label', null, 'Note'), note);
    forSelect.addEventListener('change', () => { noteGroup.hidden = forSelect.value !== ''; });
    const create = el('button', { class: 'save-btn', type: 'button', onclick: async () => {
      create.disabled = true; create.textContent = 'Creating...';
      const days = Number(expires.value);
      try {
        const made = await api.post('/api/admin/links', { userId: forSelect.value || null, note: forSelect.value ? null : note.value || null, expiresAt: days ? new Date(Date.now() + days * 86_400_000).toISOString() : null });
        result.textContent = forSelect.value ? `New link for ${made.username} created. Their old one no longer works.` : 'Invite created';
        await load();
      } catch (e) { result.textContent = e.message; }
      create.disabled = false; create.textContent = 'Create link';
    } }, 'Create link');
    const copyButton = url => { const b = el('button', { class: 'refresh-btn', type: 'button', title: 'Copy link' }, '⧉'); b.addEventListener('click', async () => { try { await navigator.clipboard.writeText(url); } catch { /* no clipboard */ } b.title = 'Copied!'; b.textContent = '✓'; setTimeout(() => { b.title = 'Copy link'; b.textContent = '⧉'; }, 2000); }); return b; };
    const expiryLabel = l => l.expiresAt ? (l.expired ? `expired ${l.expiresAt.slice(0, 10)}` : l.expiresAt.slice(0, 10)) : 'never';
    const actions = l => el('div', { class: 'link-actions' },
      Object.assign(el('select', { class: 'link-expiry', title: 'Change expiry', onchange: async e => { const v = e.target.value; if (v === 'current') return; try { await api.put(`/api/admin/links/${l.id}/expiry`, { expiresAt: v === 'never' ? null : new Date(Date.now() + Number(v) * 86_400_000).toISOString() }); await load(); } catch (err) { fail(err); } } },
        l.expiresAt ? el('option', { value: 'current' }, expiryLabel(l)) : null, [['never', 'Never'], ['1', 'In 1 day'], ['7', 'In 7 days'], ['30', 'In 30 days']].map(([v, t]) => el('option', { value: v }, t))), { value: l.expiresAt ? 'current' : 'never' }),
      el('button', { class: 'reject-btn', type: 'button', onclick: async () => { try { await api.delete(`/api/admin/links/${l.id}`); await load(); } catch (e) { fail(e); } } }, 'Revoke'));
    const draw = () => {
      if (!data) { replace(host, [empty('Loading...')]); return; }
      const chosen = forSelect.value;   // the redraw after Create keeps the person; no change event fires, so the note row is synced by hand
      replace(forSelect, [el('option', { value: '' }, 'Someone new (invite)'), ...users.filter(u => !u.isBot).map(u => el('option', { value: u.id }, u.username))]);
      forSelect.value = chosen;
      noteGroup.hidden = forSelect.value !== '';
      replace(host, [
        header('Invite & Login Links', `${data.open.length} open · ${data.users.filter(l => l.active).length} active`),
        el('div', { class: 'invite-create' }, el('div', { class: 'form-group' }, el('label', null, 'For'), forSelect), noteGroup, el('div', { class: 'form-group' }, el('label', null, 'Expires'), expires), create, result),
        el('span', { class: 'form-hint invite-hint' }, 'An invite lets whoever opens it pick a username and join, even while registration is closed. A link for an existing user replaces their current one (the rescue for someone locked out of every device); they get a bot DM about it. Codes stay readable here only until the link is first used.'),
        el('div', { class: 'section-header', style: { marginTop: '2rem' } }, el('h3', null, 'Open invites'), el('span', { class: 'section-count' }, `${data.open.length} waiting`)),
        data.open.length ? table(['Link', 'Note', 'Created', 'Expires', ''], data.open.map(l => el('tr', null,
          td([el('span', { class: 'link-code' }, l.url), copyButton(l.url)], 'link-cell'), td(l.note ?? '—'), td(ago(l.createdAt), 'date-cell'), td(expiryLabel(l), 'date-cell'), td(actions(l))))) : hint('No open invites.'),
        el('div', { class: 'section-header', style: { marginTop: '2rem' } }, el('h3', null, 'User login links'), el('span', { class: 'section-count' }, `${data.users.filter(l => l.active).length} active`)),
        data.users.length ? table(['User', 'Status', 'Link', 'Created', 'Used', 'Expires', ''], data.users.map(l => el('tr', null,
          td(l.username ?? '(deleted)'),
          td(el('span', { class: `status-pill ${l.active ? 'online' : 'offline'}` }, el('span', { class: 'status-dot' }), l.revoked ? 'Revoked' : l.expired ? 'Expired' : 'Active')),
          td(l.url ? [el('span', { class: 'link-code' }, l.url), copyButton(l.url)] : el('span', { class: 'link-hidden', 'data-tip': 'Only the user can see this code' }, '🔒 hidden'), 'link-cell'),   // AD-17
          td(`${ago(l.createdAt)}${l.byAdmin ? ' by admin' : ''}`, 'date-cell'), td(l.useCount ? `${l.useCount}× · ${ago(l.lastUsedAt)}` : 'never', 'date-cell'), td(expiryLabel(l), 'date-cell'), td(l.active ? actions(l) : null)))) : hint('No user links yet.'),
      ]);
    };
    async function load() { data = await api.get('/api/admin/links'); draw(); }
    // One draw after both answers. The people fill the "For" select, and they arrive after the links (two log
    // queries against links in memory); a draw on the links alone left the select with only "Someone new".
    Promise.all([api.get('/api/admin/links'), api.get('/api/admin/users').catch(() => ({ users: [] }))])
      .then(([links, people]) => { data = links; users = people.users; draw(); })
      .catch(e => replace(host, [empty(e.message)]));
    draw();
  }

  // ---- Logs (AD-18), Media (AD-19), Visitors (AD-20): one page of 100, Load more for the next ----
  function paged(host, { title, route, filters, stats, toolbar, columns, rowOf, emptyText, countOf, onRemove }) {
    let rows = [], skip = 0, data = null, selected = null;
    const filterValues = {};
    const list = el('div');
    const more = el('div', { class: 'log-load-more' }, el('button', { class: 'upload-button', type: 'button', onclick: () => load(false) }, 'Load more'));
    const detailHost = el('div');
    const countNode = el('span', { class: 'section-count' }, '');
    async function load(reset = true) {
      if (reset) { rows = []; skip = 0; }
      const q = new URLSearchParams({ ...filterValues, skip: String(skip) });
      for (const [k, v] of [...q]) if (!v) q.delete(k);
      try { data = await api.get(`${route}?${q}`); } catch (e) { replace(list, [empty(e.message)]); return; }
      if (data.available === false) { replace(list, [empty('Not available without persistence.')]); more.hidden = true; return; }   // AD-03
      rows = rows.concat(data.rows ?? []);
      skip = rows.length;
      draw();
    }
    // A row the admin deleted leaves the list at once; the stats are fixed up by the tab, not read again,
    // because the writer drops the row a moment after the answer.
    const removeRow = r => { rows = rows.filter(x => x !== r); if (data?.stats) onRemove?.(r, data.stats); draw(); drawStats(); };
    const draw = () => {
      countNode.textContent = countOf(rows, data);
      replace(list, rows.length ? [table(columns, rows.map(r => rowOf(r, () => { selected = selected === r ? null : r; drawDetail(); }, () => removeRow(r))), 'users-table logs-table')] : [empty(emptyText)]);
      more.hidden = !(rows.length && rows.length % 100 === 0);
      drawDetail();
    };
    const drawDetail = () => replace(detailHost, selected && rowOf.detail ? [rowOf.detail(selected)] : []);
    const filterNodes = filters.map(f => {
      if (f.options) { const s = el('select', { class: 'log-filter-select', onchange: () => { filterValues[f.key] = s.value; load(); } }, f.options.map(([v, l]) => el('option', { value: v }, l))); return s; }
      let t = 0; const i = el('input', { type: 'text', class: 'log-filter-input', placeholder: f.placeholder, oninput: () => { clearTimeout(t); t = setTimeout(() => { filterValues[f.key] = i.value.trim(); load(); }, 500); } }); return i;
    });
    const statsHost = el('div', { class: 'media-stats' });
    const drawStats = () => { if (stats && data?.stats) replace(statsHost, stats(data.stats)); };
    const originalDraw = draw;
    const reload = () => load().then(drawStats);
    append(host, [el('div', { class: 'section-header' }, el('h3', null, title), countNode), statsHost, toolbar ? toolbar({ reload }) : null, el('div', { class: 'log-filters' }, filterNodes), list, more, detailHost]);   // dom.js append skips the null
    reload();
    return () => {};
  }
  const logs = host => paged(host, { title: 'Action Logs', route: '/api/admin/logs', emptyText: 'No log entries found.', countOf: rows => `${rows.length} loaded`,
    filters: [{ key: 'action', options: [['', 'All actions'], ['LOGIN', 'LOGIN'], ['LOGOUT', 'LOGOUT'], ['SMART_LOGIN', 'SMART_LOGIN'], ['JOIN', 'JOIN']] }, { key: 'user', placeholder: 'Filter by username...' }],
    columns: ['Date', 'User', 'Action', 'IP', 'Info'],
    rowOf: r => el('tr', null, td(stamp(r.date), 'date-cell'), td(r.username), td(pill(r.action, actionClass(r.action))), td(r.ip ?? '-', 'ip-mono'), td(r.info ?? '-', 'info-cell')) });
  const actionClass = a => a === 'LOGIN' ? 'action-login' : a === 'LOGOUT' || a === 'LOGIN_FAIL' ? 'action-logout' : a === 'SMART_LOGIN' ? 'action-smart' : a === 'JOIN' ? 'action-join' : 'action-default';
  // A row's delete that asks with a second tap: the first turns the button into "Sure?" for four seconds, the
  // second runs the action. The Media and the GIFs rows share it (AD-19, AD-23).
  const armedDelete = (action, title) => {
    let armed = null;
    const b = el('button', { class: 'gif-row-btn danger', type: 'button', title, onclick: async () => {
      if (!armed) { b.textContent = 'Sure?'; armed = setTimeout(() => { armed = null; b.textContent = 'Delete'; }, 4000); return; }
      clearTimeout(armed); armed = null; b.textContent = 'Delete';
      await action();
    } }, 'Delete');
    return b;
  };
  // One upload's delete (AD-19). A 409 means a message still shows the file, with the count in its text; the admin
  // decides in a dialog. A GIF goes the GIFs tab's way (AD-23): its file stays while those messages show it, so its
  // dialog promises no broken picture.
  const deleteButton = (r, remove) => armedDelete(async () => {
    let inUse;
    try { await api.delete(`/api/admin/media/${r.id}`); remove(); return; }
    catch (e) { if (e.status !== 409) { fail(e); return; } inUse = e.message; }
    const gif = r.fileType === 'gif';
    if (!await confirm({ title: gif ? 'Delete this GIF?' : 'Delete this file?', text: `${r.originalFileName}: ${inUse.toLowerCase()} ${gif ? 'It leaves every library; the file stays while those messages show it.' : 'The messages keep a broken picture.'}` })) return;
    try { await api.delete(`/api/admin/media/${r.id}?force=true`); remove(); } catch (err) { fail(err); }
  });
  // The uploads no message shows any more (AD-19): a count first, then the delete. Memory may hold only the
  // newest messages (AD-03), so the box also scans the saved history; without it an upload whose message the
  // start did not load counts as unused.
  const prunePanel = ({ reload }) => {
    const scan = el('input', { type: 'checkbox' });
    const status = el('span', { class: 'form-hint' });
    const find = el('button', { class: 'upload-button', type: 'button' }, 'Find unused uploads');
    const del = el('button', { class: 'danger-btn', type: 'button', hidden: true });
    const plural = n => `${n} upload${n === 1 ? '' : 's'}`;
    let found = null;
    find.addEventListener('click', async () => {
      find.disabled = true; del.hidden = true; status.textContent = 'Scanning...';
      try {
        found = { ...await api.get(`/api/admin/media/unreferenced?database=${scan.checked}`), database: scan.checked };   // the delete goes with the scan the count came from
        status.textContent = found.files ? `${plural(found.files)} in no message, ${size(found.bytes)} on disk.` : 'Every upload is in a message.';
        if (found.recent) status.textContent += ` ${plural(found.recent)} from the last hour kept: their messages may still be on the way.`;
        del.textContent = `Delete ${plural(found.files)}`; del.hidden = !found.files;
      } catch (e) { status.textContent = e.message; }
      find.disabled = false;
    });
    del.addEventListener('click', async () => {
      if (!await confirm({ title: 'Delete unused uploads?', text: `${plural(found.files)}, ${size(found.bytes)}, with their thumbnails. No message${found.database ? '' : ' in memory'} shows them. This cannot be undone.` })) return;
      del.disabled = true;
      try { const r = await api.post('/api/admin/media/prune', { database: found.database }); status.textContent = `Deleted ${plural(r.files)}, ${size(r.bytes)} freed.`; del.hidden = true; setTimeout(reload, 1500); }   // the writer drops the rows a moment later
      catch (e) { status.textContent = e.message; }
      del.disabled = false;
    });
    scan.addEventListener('change', () => { del.hidden = true; });   // a changed scan needs a new count before a delete
    return el('div', { class: 'media-prune' },
      el('div', { class: 'media-prune-row' }, find, del, el('label', { class: 'media-prune-scan' }, scan, 'Scan the whole database'), status),
      el('p', { class: 'section-hint' }, 'Deleting a message keeps its files. This finds the uploads that no message shows any more, in rooms and in direct messages, and deletes them with their thumbnails. Memory may hold only the newest messages: tick the box to scan the saved history too, so an upload in an older message stays.'));
  };
  const media = host => paged(host, { title: 'Media', route: '/api/admin/media', emptyText: 'No media uploads found.', countOf: (rows, d) => `${d?.stats?.totalFiles ?? rows.length} files`,
    stats: s => [statCard('FFmpeg', el('span', null, el('span', { class: `status-dot ${s.ffmpeg ? 'status-online' : 'status-offline'}` }), s.ffmpeg ? 'Available' : 'Unavailable')), statCard('Total Storage', size(s.totalBytes ?? 0)), statCard('Images', String(s.images ?? 0)), statCard('Videos', String(s.videos ?? 0)), statCard('Voice messages', String(s.voices ?? 0))],
    toolbar: prunePanel,
    onRemove: (r, s) => { s.totalFiles--; s.totalBytes -= r.fileSize ?? 0; if (r.fileType === 'image') s.images--; if (r.fileType === 'video') s.videos--; if (r.fileType === 'voice') s.voices--; },
    filters: [{ key: 'type', options: [['', 'All types'], ['image', 'Image'], ['video', 'Video'], ['voice', 'Voice'], ['gif', 'GIF']] }, { key: 'user', placeholder: 'Filter by username...' }],
    columns: ['Preview', 'Date', 'User', 'File', 'Type', 'Size', 'Processing', ''],
    // A voice message has no picture: a small player stands in the preview cell (AD-19).
    rowOf: (r, _, remove) => el('tr', null, td(r.thumb ? el('a', { href: r.link ?? r.thumb, target: '_blank', rel: 'noopener' }, el('img', { src: r.thumb, alt: '', class: 'admin-thumb', loading: 'lazy' }))
                                              : r.fileType === 'voice' && r.link ? el('audio', { controls: true, preload: 'none', src: r.link, class: 'admin-audio' }) : null),
      td(stamp(r.date), 'date-cell'), td(r.username), td(r.originalFileName, 'info-cell'), td(pill(r.fileType, r.fileType === 'video' ? 'action-video' : 'action-default')), td(size(r.fileSize ?? 0)), td(r.compressDurationMs ? `${(r.compressDurationMs / 1000).toFixed(1)}s` : '-'),
      td(deleteButton(r, remove), 'gif-actions-cell')) });
  const visitorsRow = (r, toggle) => el('tr', { class: 'clickable-row', onclick: toggle }, td(stamp(r.date), 'date-cell'), td(r.ip ?? '---', 'ip-mono'), td(r.country ?? '—', 'geo-cell'), td(pill(r.action, actionClass(r.action))), td(r.reason ?? r.url ?? r.info ?? ''), td((r.userAgent ?? '').slice(0, 60), 'ua-cell'));
  visitorsRow.detail = r => el('div', { class: 'user-detail-panel' },
    el('div', { class: 'detail-header' }, el('div', { class: 'detail-header-info' }, el('h4', null, r.ip ?? 'Unknown IP'), r.country ? el('span', { class: 'user-username' }, r.country) : null)),
    el('div', { class: 'detail-tags' }, el('span', { class: 'detail-tag tag-muted' }, ago(r.date)), el('span', { class: 'detail-tag tag-muted' }, r.action), r.reason ? el('span', { class: 'detail-tag tag-muted' }, r.reason) : null),
    el('div', { class: 'detail-section' }, el('h5', null, 'User Agent'), el('span', { class: 'ua-cell', style: { wordBreak: 'break-all' } }, r.userAgent ?? '---')));
  const visitors = host => paged(host, { title: 'Visitors', route: '/api/admin/visitors', emptyText: 'No visitor data yet. Visitors are tracked when they load the login page or an invite while signed out.', countOf: (rows, d) => `${d?.stats?.visits ?? rows.length} visits tracked`,
    stats: s => [statCard('Total Visits', String(s.visits ?? 0)), statCard('Login Failures', String(s.failures ?? 0)), statCard('Unique IPs', String(s.uniqueIps ?? 0)), statCard('Today', String(s.today ?? 0))],
    filters: [{ key: 'action', options: [['', 'All'], ['VISIT', 'Visits only'], ['LOGIN_FAIL', 'Login failures only']] }],
    columns: ['Date', 'IP', 'Country', 'Action', 'Details', 'User-Agent'], rowOf: visitorsRow });

  // ---- GIFs (AD-21 to AD-23) ----
  function gifs(host) {
    let data = null, filterValue = 'all', visible = 24;
    const libraryHost = el('div');
    const unmountLibrary = GifLibrary(libraryHost, { server: true });
    const tableHost = el('div');
    const draw = () => {
      if (!data) return;
      const rows = data.entries.filter(e => filterValue === 'all' || (filterValue === 'custom' && e.source === 'custom') || (filterValue === 'provider' && e.source !== 'custom') || (filterValue === 'favorited' && e.favorites > 0) || (filterValue === 'server' && e.card.isServer));
      replace(host.querySelector('.section-count'), [`${Math.min(visible, rows.length)} of ${data.entries.length} entries`]);
      replace(tableHost, rows.length ? [table(['Preview', 'Date', 'Source', 'Uploader', 'Format', 'Dimensions', 'Size', 'Uses', 'Favs', 'Tags', 'Actions'], rows.slice(0, visible).map(e => el('tr', null,
        td((e.card.preview ?? e.card.src) ? el('a', { href: e.card.src ?? e.card.preview, target: '_blank', rel: 'noopener' }, el('img', { src: e.card.preview ?? e.card.src, alt: '', class: 'admin-thumb', loading: 'lazy' })) : null),
        td(stamp(e.createdAt), 'date-cell'), td([pill(e.source, 'action-default'), e.card.isServer ? pill('server', 'server-pill') : null]), td(e.card.uploader ?? ''), td(pill(e.format ?? '', 'action-default')), td(`${e.card.width} × ${e.card.height}`), td(size(e.card.sizeBytes ?? 0)), td(String(e.uses ?? 0)), td(e.favorites ? `⭐ ${e.favorites}` : '—'),
        tagsCell(e.card), td([
          el('button', { class: `gif-row-btn${e.card.isServer ? ' active' : ''}`, type: 'button', title: e.card.isServer ? 'Remove from server library' : 'Add to server library', onclick: async () => { try { await api.put(`/api/admin/gifs/${e.card.id}/server`, { on: !e.card.isServer }); await load(); } catch (err) { fail(err); } } }, e.card.isServer ? '★ server' : '☆ server'),
          armedDelete(async () => { try { const r = await api.delete(`/api/admin/gifs/${e.card.id}`); note.textContent = r?.note ?? 'Deleted.'; await load(); } catch (err) { fail(err); } }, 'Delete this GIF everywhere')], 'gif-actions-cell')))),
        rows.length > visible ? el('button', { class: 'show-more', type: 'button', onclick: () => { visible += 24; draw(); } }, `Show ${Math.min(24, rows.length - visible)} more (${Math.max(0, rows.length - visible - 24)} left)`) : null]
        : [empty(data.entries.length ? 'No GIFs match this filter.' : 'No GIFs in the library yet.')]);
    };
    const tagsCell = e => {
      const cell = el('td', { class: 'gif-tags-cell' });   // the Admin tag rules live under .page-admin .gif-tags-cell
      const view = el('div', { class: 'gif-tags-view', title: 'Click to edit tags' }, (e.tags ?? []).length ? e.tags.map(t => el('span', { class: 'gif-tag-chip' }, t)) : el('span', { class: 'gif-tags-empty' }, 'add tags…'));
      view.addEventListener('click', () => {
        const input = el('input', { class: 'gif-tags-input', placeholder: 'comma, separated, tags', value: (e.tags ?? []).join(', ') });
        const save = async () => { const tags = [...new Set(input.value.split(',').map(t => t.trim().toLowerCase()).filter(t => t.length >= 2 && t.length <= 64))]; try { await api.put(`/api/gifs/${e.id}/tags`, { tags }); e.tags = tags; draw(); } catch (err) { fail(err); } };
        replace(cell, [el('div', { class: 'gif-tags-edit' }, input, el('button', { class: 'gif-tags-btn save', type: 'button', title: 'Save', onclick: save }, '✓'), el('button', { class: 'gif-tags-btn', type: 'button', title: 'Cancel', onclick: draw }, '✕'))]);
        input.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); save(); } else if (ev.key === 'Escape') draw(); });
        input.focus();
      });
      cell.append(view);
      return cell;
    };
    const note = el('div', { class: 'form-hint' });
    const statsHost = el('div', { class: 'media-stats' });
    async function load() {
      data = await api.get('/api/admin/gifs');
      replace(statsHost, [statCard('FFmpeg', el('span', null, el('span', { class: `status-dot ${data.stats.ffmpeg ? 'status-online' : 'status-offline'}` }), data.stats.ffmpeg ? 'Available' : 'Unavailable')), statCard('Total Storage', size(data.stats.totalBytes ?? 0)), statCard('Custom GIFs', String(data.stats.custom ?? 0)), statCard('Provider Cache', String(data.stats.provider ?? 0))]);
      draw();
    }
    host.append(header('GIFs', ''), statsHost,
      el('div', { class: 'server-gif-library' }, el('h4', null, 'Server library'), el('p', { class: 'section-hint' }, 'A curated GIF set every user sees: its own picker tab, searchable by everyone, ranked above the general pool. Import files or a zip, organize with folders. Promote existing entries from the table below.'), libraryHost),
      el('div', { class: 'log-filters' }, el('select', { class: 'log-filter-select', onchange: e => { filterValue = e.target.value; visible = 24; draw(); } }, [['all', 'All entries'], ['custom', 'Custom uploads'], ['provider', 'Provider cache'], ['favorited', '⭐ Favorited'], ['server', 'Server library']].map(([v, l]) => el('option', { value: v }, l)))),
      note, tableHost);
    load().catch(e => replace(tableHost, [empty(e.message)]));
    return () => unmountLibrary();
  }

  // ---- Diagnostics (AD-24 to AD-28) ----
  function diagnostics(host) {
    let charts = {};
    const body = el('div');
    const load = loadCard();
    host.append(header('Diagnostics', 'Live system metrics'), load.node, body);
    const ms = v => v == null ? '—' : `${Math.round(v)}`;
    const sessionRow = s => el('tr', s.ghost ? { style: { color: 'var(--color-warning)' } } : null,
      td(s.username), td([s.isMobile ? '📱' : '🖥️', ' ', s.clientIp ?? '—', s.clientIpv4 && s.clientIpv4 !== s.clientIp ? el('span', { style: { color: 'var(--text-secondary)' }, 'data-tip': 'IPv4 reported by the beacon' }, ` · v4 ${s.clientIpv4}`) : null]),
      td(s.transport === 'WebSockets' ? 'WS' : s.transport ? '⚠ Fallback' : '—'), td(s.connected ? '✓' : `✗ ${ago(s.closedAt ?? s.droppedAt)}`), td(s.visible ? '👁 yes' : 'no'), td(s.status ?? '—'), td(s.viewing ?? '—'), td(ago(s.lastInputAt)), td(ago(s.lastHeartbeatAt)), td(ago(s.connectedAt)));
    // The waits per person (AD-26): a row per user with the numbers since the restart, then that user's live
    // connections, then the closed ones in grey. The same cells serve all three rows; a connection never has
    // 'post', because a send carries no connection id.
    const WAITS = [
      { key: 'rtt', text: 'RTT last/avg/max', show: ['last', 'avg', 'max'], title: "Round trip of the client's own heartbeat, measured by the client. Hidden tabs do not sample." },
      { key: 'send', text: 'Send avg/max', show: ['avg', 'max'], title: 'Send tap until the own message is rendered. Text and GIF sends only; a send with files would measure the upload.' },
      { key: 'post', text: 'Server send avg/max', show: ['avg', 'max'], title: "The server's own time inside a message send. Per person only: the request carries no connection id." },
      { key: 'open', text: 'Open room avg/max', show: ['avg', 'max'], title: "Tap on a conversation until the server's messages are on screen. Cached rows may show earlier; that is the device, not the wire." },
      { key: 'older', text: 'Older avg/max', show: ['avg', 'max'], title: 'Scroll to the top until the older messages are in place.' },
      { key: 'jump', text: 'Jump avg/max', show: ['avg', 'max'], title: 'A tap on a pin or a quote until the message is on screen. A message that is loaded already scrolls and is not counted.' },
      { key: 'start', text: 'Start last/max', show: ['last', 'max'], title: "Page load until the first conversation shows the server's messages: scripts, bootstrap, connection and room." },
      { key: 'reconnect', text: 'Reconnect last/max', show: ['last', 'max'], title: 'Connection lost, or the tab back from sleep, until the room is in sync again.' },
    ];
    const waitCell = (latency, w) => {
      const s = latency.stats?.[w.key];
      return el('td', s ? { 'data-tip': `${s.count} sample${s.count === 1 ? '' : 's'}, last ${ms(s.last)} ms ${ago(s.at)}` } : null, s ? w.show.map(k => ms(s[k])).join(' / ') : '—');
    };
    const waitCells = latency => [...WAITS.map(w => waitCell(latency, w)), td(latency.slowEventCount ? `${latency.slowEventCount}× (max ${ms(latency.maxEventMs)}ms)` : '—')];
    const laggy = latency => (latency.stats?.rtt?.avg ?? 0) > 250;
    const transportText = s => s.transport === 'WebSockets' ? 'WS' : s.transport ? '⚠ Fallback' : '—';
    const userRow = g => {
      const live = g.sessions.filter(s => s.connected).length;
      return el('tr', laggy(g.latency) ? { style: { color: 'var(--color-warning)' } } : null, td(el('strong', null, g.username)), td(live ? `${live} live` : 'no connection'), ...waitCells(g.latency));
    };
    const connectionRow = s => el('tr', { style: !s.connected ? { opacity: 0.55 } : (s.transport !== 'WebSockets' || laggy(s.latency)) ? { color: 'var(--color-warning)' } : null },   // grey: dropped or closed
      td([s.isMobile ? '📱' : '🖥️', ' ', s.clientIp ?? '—'], 'diag-indent'), td(s.connected ? `${transportText(s)} · ${ago(s.connectedAt)}` : `${transportText(s)} · closed ${ago(s.closedAt ?? s.droppedAt)}`), ...waitCells(s.latency));
    const latencyRows = d => {
      const groups = new Map(d.users.map(u => [u.userId, { ...u, sessions: [] }]));   // worst round trip first, as the server orders them
      const groupOf = s => { let g = groups.get(s.userId); if (!g) groups.set(s.userId, g = { username: s.username, latency: { stats: {} }, sessions: [] }); return g; };   // connected, no beat yet
      [...d.sessions, ...d.recentlyClosed].forEach(s => groupOf(s).sessions.push(s));   // live first, then the ring of closed ones
      return [...groups.values()].flatMap(g => [userRow(g), ...g.sessions.map(connectionRow)]);
    };
    // The load-time table (AD-41): one row per page load that reported, from the live sessions and the ring of closed
    // ones, the slowest server rows first. A load in a hidden tab is grey: the numbers are real, the wait was nobody's.
    const PHASES = [
      { key: 'html', text: 'HTML', title: 'The page has arrived.' },
      { key: 'scripts', text: 'Scripts', title: 'Every module loaded and run.' },
      { key: 'bootstrap', text: 'Account', title: 'The account data (the bootstrap answer) applied.' },
      { key: 'paint', text: 'Paint', title: 'The first rows on screen, from the device or from the server.' },
      { key: 'socket', text: 'Socket', title: 'The live connection is up.' },
      { key: 'rows', text: 'Rows', title: "The server's rows of the first conversation on screen." },
    ];
    // The build the page ran, red when this server runs a newer one, with the build that registered its service worker
    // when that one differs. On 2026-10-30 an iPhone's installed app stayed on an old build through every Reload tap and
    // nothing here could show it; now a device left behind is one red cell. An old client reports no build.
    const buildCell = load => {
      if (!load.build) return td('—');
      const text = load.worker && load.worker !== load.build ? `${load.build} · worker ${load.worker}` : load.build;
      return el('td', load.build !== state.config?.buildStamp ? { style: { color: 'var(--color-danger)', fontWeight: 600 } } : null, text);
    };
    const loadRow = s => el('tr', s.load.hidden ? { style: { opacity: 0.55 } } : null,
      td(s.username), td(`${s.isMobile ? '📱' : '🖥️'} ${[s.browser, s.os].filter(Boolean).join(' · ') || '—'}${s.pwa ? ' · app' : ''}`), buildCell(s.load),
      td(s.load.protocol ?? '—'), ...PHASES.map(p => td(ms(s.load[p.key]))), td(`${s.load.cached} / ${s.load.requests}`), td(ms(s.load.bytes / 1024)), td(ago(s.load.at)));
    const loadRows = d => [...d.sessions, ...d.recentlyClosed].filter(s => s.load).sort((a, b) => (b.load.rows ?? -1) - (a.load.rows ?? -1)).map(loadRow);
    async function refresh() {
      let d;
      try { d = await api.get('/api/admin/diagnostics'); } catch (e) { replace(body, [empty(e.message)]); return; }
      const latest = d.latest ?? {};
      const loads = loadRows(d);
      replace(body, [
        el('div', { class: 'diag-stats' }, statCard('Users', String(latest.uniqueUsers ?? 0)), statCard('Sessions', String(latest.userSessions ?? 0)), statCard('Messages', String(latest.totalMessages ?? 0)), statCard('Connections', String((latest.activeConnections ?? 0) + (latest.disconnectedConnections ?? 0))), statCard('Channels', String(latest.channels ?? latest.totalChannels ?? 0))),
        el('div', { class: 'diag-chart-card', style: { marginBottom: '16px' } }, el('h4', null, 'Sessions — presence truth table'), d.sessions.length ? table(['User', 'Device', 'Transport', 'Connected', { text: 'Visible', title: 'Page visibility as last reported — a visible session suppresses push for the whole account' }, 'Status', { text: 'Viewing', title: 'Channel this session has open' }, { text: 'Last input', title: 'Time since last real user input (client-reported)' }, { text: 'Heartbeat', title: 'Time since last client-state report' }, 'Age'], d.sessions.map(sessionRow)) : el('p', { style: { color: 'var(--text-secondary)', margin: 0 } }, 'No active sessions.')),
        el('div', { class: 'diag-chart-card', style: { marginBottom: '16px' } }, el('h4', null, 'Latency by user'),
          el('p', { class: 'section-hint', style: { margin: '0 0 8px' } }, 'Milliseconds since the last restart. A user row covers all their connections; under it are the live connections, in grey the recently closed. Hover or tap a header for what it measures.'),
          d.users.length || d.sessions.length || d.recentlyClosed.length ? table(['Who', { text: 'Connection', title: 'Fallback (SSE/long-polling) instead of WebSockets is the first latency suspect' }, ...WAITS.map(w => ({ text: w.text, title: w.title })), { text: 'Slow calls', title: 'Hub calls and message sends the server took ≥100 ms to process' }],
            latencyRows(d), 'users-table logs-table') : el('p', { style: { color: 'var(--text-secondary)', margin: 0 } }, 'No connections tracked yet.')),
        el('div', { class: 'diag-chart-card', style: { marginBottom: '16px' } }, el('h4', null, 'Load time'),
          el('p', { class: 'section-hint', style: { margin: '0 0 8px' } }, 'One row per page load since the restart, milliseconds from the start of the load, the slowest server rows first. Grey: the tab was hidden while it loaded.'),
          loads.length ? table(['Who', 'Device', { text: 'Build', title: "The build the page ran; red when this server runs a newer one. 'worker' names the build that registered the service worker when it is not the same." }, { text: 'HTTP', title: 'h2, h3 or http/1.1: how the page came' }, ...PHASES.map(p => ({ text: p.text, title: p.title })), { text: 'Cached / files', title: 'Same-origin files a cache answered with no bytes on the wire / all files of the load, the page included' }, { text: 'KB', title: 'Kilobytes on the wire, same-origin files' }, 'When'],
            loads, 'users-table logs-table') : el('p', { style: { color: 'var(--text-secondary)', margin: 0 } }, 'No load reported yet.')),
        el('div', { class: 'diag-chart-card', style: { marginBottom: '16px' } }, el('h4', null, 'Push notifications'),
          d.push.keyStatus === 'valid' ? el('p', { style: { color: 'var(--color-success)', margin: 0 } }, '✅ Configured — VAPID keypair verified at startup.')
          : d.push.keyStatus === 'invalid' ? [el('p', { style: { color: 'var(--color-danger)', margin: 0, fontWeight: 600 } }, '❌ DISABLED — VAPID keypair is invalid.'), el('p', { style: { color: 'var(--text-secondary)', margin: '4px 0 0' } }, d.push.detail ?? '')]
          : el('p', { style: { color: 'var(--text-secondary)', margin: 0 } }, '⚠️ Not configured — no VAPID keys set.')),
        el('div', { class: 'diag-chart-card', style: { marginBottom: '16px' } }, el('h4', null, 'Push audit — decisions & results'),
          d.push.decisions.length || d.push.results.length ? [
            table(['When', 'DM', 'Decision', { text: 'Unread', title: "Recipient's total unread DMs at decision time" }, { text: 'Subs', title: "Recipient's push subscriptions at decision time" }, { text: 'Sessions', title: "Recipient's sessions at decision time" }], d.push.decisions.map(x => el('tr', String(x.outcome ?? '').startsWith('suppressed') ? { style: { color: 'var(--color-warning)' } } : null, td(ago(x.at)), td(`${x.from} → ${x.to}`), td(x.outcome ?? ''), td(String(x.totalUnread ?? '')), td(String(x.subscriptions ?? '')), td(x.sessions ?? '', null)))),
            table(['When', 'To', { text: 'Sent/Failed/Total', title: 'Devices the push service accepted / rejected / total attempted' }, 'Muted', 'Note'], d.push.results.map(x => el('tr', (x.failed > 0 || x.total === 0) ? { style: { color: 'var(--color-warning)' } } : null, td(ago(x.at)), td(x.to), td(`${x.sent} / ${x.failed} / ${x.total}`), td(x.muted ? '🔕' : '—'), td(x.note ?? '—'))))]
          : el('p', { style: { color: 'var(--text-secondary)', margin: 0 } }, 'No push activity since restart.')),
        el('div', { class: 'diag-chart-card', style: { marginBottom: '16px' } }, el('h4', null, 'Unread audit — DM badge changes'),
          d.unread.length ? table(['When', 'User', 'Channel', 'Change', 'Trigger', 'Device state'], d.unread.map(x => el('tr', null, td(ago(x.at)), td(x.user), td(x.channel ?? ''), td(x.kind === 'clear' ? `clear (${x.count})` : `+1 → ${x.count}`), td(x.source ?? ''), td(x.sessionState ?? '', null)))) : el('p', { style: { color: 'var(--text-secondary)', margin: 0 } }, 'No DM unread activity since restart.')),
        el('div', { class: 'diag-chart-card', style: { marginBottom: '16px' } }, el('h4', null, 'Persistence writer'),
          el('p', { style: { margin: 0 } }, d.writer.enabled ? `queue depth ${d.writer.depth}${d.writer.lastError ? ` · last error ${ago(d.writer.lastErrorAt)}: ${d.writer.lastError}` : ''}` : 'off (memory only)'),
          d.writer.enabled ? el('p', { style: { color: 'var(--text-secondary)', margin: '8px 0 0' } }, d.writer.sqlLogged
            ? 'SQL commands are in the server log: one line per database write. For normal use set "Microsoft.EntityFrameworkCore" to "Warning" under Logging → LogLevel in Data/appsettings.json and restart.'
            : 'SQL commands are not in the server log. To see every command for a while, set "Microsoft.EntityFrameworkCore" to "Information" under Logging → LogLevel in Data/appsettings.json and restart. Each write is then one log line.') : null),
        el('div', { class: 'diag-charts' },
          el('div', { class: 'diag-chart-card' }, el('h4', null, 'Users & Sessions'), el('div', { class: 'diag-chart-wrapper' }, el('canvas', { id: 'diag-chart-users' }))),
          el('div', { class: 'diag-chart-card' }, el('h4', null, 'Connections: Active vs Disconnected'), el('div', { class: 'diag-chart-wrapper' }, el('canvas', { id: 'diag-chart-connections' }))),
          el('div', { class: 'diag-chart-card' }, el('h4', null, 'Messages'), el('div', { class: 'diag-chart-wrapper' }, el('canvas', { id: 'diag-chart-messages' })))),
      ]);
      drawCharts(d.series);
    }
    async function drawCharts(series) {   // AD-28: Chart.js from the CDN, loaded on the first open of the tab
      if (!window.Chart) { await new Promise(resolve => { const s = el('script', { src: CHART_CDN }); s.addEventListener('load', resolve); s.addEventListener('error', resolve); document.head.append(s); }); }
      if (!window.Chart) return;
      const labels = series.map(s => new Date(s.timestamp).toTimeString().slice(0, 5));
      const css = getComputedStyle(document.documentElement);
      const color = (name, fallback) => css.getPropertyValue(name).trim() || fallback;   // the theme's colours (AD-28)
      const green = color('--status-online', '#3ba55c'), blue = color('--accent', '#5865f2'), orange = color('--status-away', '#faa61a');
      const make = (id, datasets) => {
        const canvas = body.querySelector(`#${id}`); if (!canvas) return;
        charts[id]?.destroy();
        charts[id] = new window.Chart(canvas, { type: 'line', data: { labels, datasets: datasets.map(ds => ({ ...ds, pointRadius: 0, borderWidth: 2, tension: 0.2 })) },
          options: { animation: false, maintainAspectRatio: false, scales: { x: { ticks: { maxTicksLimit: 8 } }, y: { beginAtZero: true } } } });
      };
      make('diag-chart-users', [{ label: 'Unique Users', data: series.map(s => s.uniqueUsers), borderColor: green }, { label: 'Sessions', data: series.map(s => s.userSessions), borderColor: blue }]);
      make('diag-chart-connections', [{ label: 'Active', data: series.map(s => s.activeConnections), borderColor: green }, { label: 'Disconnected', data: series.map(s => s.disconnectedConnections), borderColor: orange }]);
      make('diag-chart-messages', [{ label: 'Total Messages', data: series.map(s => s.totalMessages), borderColor: blue, backgroundColor: 'rgba(88,101,242,0.15)', fill: true }]);
    }
    refresh();
    const timer = setInterval(refresh, 30_000);   // AD-02
    return () => { clearInterval(timer); load.stop(); Object.values(charts).forEach(c => c.destroy()); };
  }

  // Server load: the 1 s samples of /api/admin/load, polled every 2 s. Built for stress tests, so it has its own
  // clock; the 30 s rhythm of the rest of the tab would hide the moment the server bends. The range select asks
  // for up to an hour; the server buckets a long range so the chart gets at most 300 points.
  function loadCard() {
    const stats = el('div', { class: 'diag-stats', style: { marginBottom: '0.75rem' } });
    const canvas = el('canvas');
    let seconds = 60, chart = null, timer = null;
    const range = el('select', { class: 'log-filter-select diag-range', onchange: () => { seconds = Number(range.value); chart?.destroy(); chart = null; restart(); } },
      [[60, 'Last minute'], [300, 'Last 5 minutes'], [900, 'Last 15 minutes'], [3600, 'Last hour']].map(([v, l]) => el('option', { value: v }, l)));
    const node = el('div', { class: 'diag-chart-card', style: { marginBottom: '16px' } }, el('div', { class: 'diag-card-head' }, el('h4', null, 'Server load'), range), stats, el('div', { class: 'diag-chart-wrapper' }, canvas));
    const n = v => v == null ? '—' : String(v);
    async function tick() {
      let d;
      const step = Math.ceil(seconds / 300);
      try { d = await api.get(`/api/admin/load?seconds=${seconds}&step=${step}`); } catch (e) { replace(stats, [empty(e.message)]); return; }
      const l = d.latest;
      if (!l) { replace(stats, [empty('No samples yet.')]); return; }
      replace(stats, [
        statCard('CPU', `${l.cpuPercent} %`), statCard('Working set', `${l.workingSetMB} MB`), statCard('Heap', `${l.heapMB} MB`),
        statCard('GC 0/1/2', `${l.gen0}/${l.gen1}/${l.gen2}`), statCard('Pool queue', n(l.threadPoolQueue)), statCard('Connections', n(l.connections)),
        statCard('Msg/s', n(l.messagesPerSec)), statCard('Hub sends/s', n(l.hubSendsPerSec)), statCard('Req/s', n(l.requestsPerSec)),
        statCard('Req p95', `${l.requestP95Ms} ms`), statCard('Writer depth', n(l.writerDepth)), statCard('Sweep', `${l.sweepMs.toFixed(1)} ms`),
        statCard('Host load', n(l.machineLoad1)), statCard('Host free', l.machineMemAvailableMB == null ? '—' : `${l.machineMemAvailableMB} MB`),
      ]);
      if (!window.Chart) return;   // the diagnostics tab loads Chart.js on its first draw; until then the numbers alone
      const labels = d.series.map(s => new Date(s.at).toTimeString().slice(seconds > 300 ? 0 : 3, seconds > 300 ? 5 : 8));   // mm:ss up to 5 min, then hh:mm
      const data = [
        { label: 'CPU %', data: d.series.map(s => s.cpuPercent), borderColor: '#faa61a', yAxisID: 'y' },
        { label: 'Hub sends/s', data: d.series.map(s => s.hubSendsPerSec), borderColor: '#5865f2', yAxisID: 'y1' },
        { label: 'Msg/s', data: d.series.map(s => s.messagesPerSec), borderColor: '#3ba55c', yAxisID: 'y1' },
        { label: 'Writer depth', data: d.series.map(s => s.writerDepth), borderColor: '#ed4245', yAxisID: 'y1' },
      ];
      if (chart) { chart.data.labels = labels; data.forEach((ds, i) => { chart.data.datasets[i].data = ds.data; }); chart.update('none'); return; }
      chart = new window.Chart(canvas, { type: 'line', data: { labels, datasets: data.map(ds => ({ ...ds, pointRadius: 0, borderWidth: 2, tension: 0.2 })) },
        options: { animation: false, maintainAspectRatio: false, scales: { x: { ticks: { maxTicksLimit: 6 } }, y: { beginAtZero: true, max: 100, position: 'left' }, y1: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false } } } } });
    }
    function restart() { clearInterval(timer); tick(); timer = setInterval(tick, seconds > 300 ? 5_000 : 2_000); }   // a long range moves slowly; poll it less
    restart();
    return { node, stop: () => { clearInterval(timer); chart?.destroy(); } };
  }

  const tabs = { users, debug, bot, settings, invites, logs, media, gifs, diagnostics, visitors };
  api.get('/api/admin/settings').then(s => { page.querySelector('.no-persistence-note').hidden = !!s.persistence; }).catch(() => {});   // AD-03
  // Requests arrive through a proxy that is not in ChatSettings:TrustedProxies (ProxyWatch): client addresses are
  // unknown and smart login is off until the admin lists it. Above every tab, in red, because it is easy to forget.
  api.get('/api/admin/status').then(({ proxy }) => {
    if (!proxy?.untrustedPeer) return;
    const box = page.querySelector('.admin-warning');
    replace(box, [
      el('strong', null, 'Requests reach this server through a proxy that is not trusted.'),
      el('p', null, `The peer ${proxy.untrustedPeer} is not in ChatSettings:TrustedProxies (forwarded chain: ${proxy.forwardedFor}). Every client address counts as unknown and smart login is off for everyone. ${proxy.count} such requests since ${stamp(proxy.firstSeenAt)}.`),
      el('p', null, "Add the proxy's address or its network (CIDR) to Data/appsettings.json and restart. Cloudflare needs no entry: its ranges are built in."),
      el('pre', null, `"TrustedProxies": ["${proxy.untrustedPeer}"]`),
      proxy.trusted.length ? el('p', null, `Trusted now: ${proxy.trusted.join(', ')}`) : null,
    ]);
    box.hidden = false;
  }).catch(() => {});
  root.replaceChildren(page);
  open(route?.hash && TABS.some(([id]) => id === route.hash) ? route.hash : 'users');   // /admin#settings opens that tab (AD-02)
  return () => { unmountTab(); offTips(); offs.forEach(off => off()); Object.values(timers).forEach(clearInterval); page.remove(); };
}
