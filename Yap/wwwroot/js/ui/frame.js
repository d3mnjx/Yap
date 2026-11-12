// The frame around a conversation (frame.md): the header with the title, the connection dot, the status
// chip and its menu, the pin button, the mailbox and the hamburger; the header line; the profile card.
// The sidebar with the rooms and the people is ui/sidebar.js, and the message search with its field in the header
// is ui/search.js; both are mounted here with the frame. Mounted once; the pages change only the content column (SH-01).

import { state, on, displayName, unreadTotal, mergeMe, serverMuted } from '../store.js';
import { clone, el, replace, classes } from '../render/dom.js';
import { inline, pickTemplate, fill } from '../render/text.js';
import { avatar, gradient } from '../render/avatar.js';
import { roleBadge } from '../render/badge.js';
import * as hub from '../hub.js';
import * as overlays from './overlays.js';
import { confirm } from './confirm.js';
import { openPins } from './pins.js';
import * as router from '../router.js';
import * as session from '../session.js';
import { hasQueued } from '../sender.js';
import { Sidebar, narrow } from './sidebar.js';
import { Search } from './search.js';

let frame = null;          // the mounted .chat-container
let sidebar = null;        // its sidebar: { toggle, unmount }
let search = null;         // its message search: { end, unmount }
let offs = [];
let title = { kind: 'room', text: '', partner: null };   // what the header shows
let headerPick = { channelId: null, template: '' };

export function mount(appRoot) {
  if (frame) return frame.querySelector('.messages-container');
  frame = clone('t-frame');
  appRoot.replaceChildren(frame);
  sidebar = Sidebar(frame, { openProfile, closeProfile, toggleProfile });
  search = Search(frame, { closeSidebar: () => sidebar.toggle(false) });

  const header = frame.querySelector('.chat-header');
  header.querySelector('.status-button').addEventListener('click', openStatusMenu);
  // SH-09: the mailbox leads to the unread marks of the sidebar. At 768 px or less it opens the sidebar. Above that
  // the sidebar is there, except under the results of a search: the click then ends the search (SR-22).
  header.querySelector('.mailbox-button').addEventListener('click', () => { if (narrow.matches) sidebar.toggle(true); else search.end(); });
  header.querySelector('.pins-button').addEventListener('click', togglePins);   // SH-47
  header.querySelector('.users-toggle').addEventListener('click', () => sidebar.toggle());
  wireConnectionDot(header.querySelector('.connection-dot'));

  offs = [
    sidebar.unmount,
    search.unmount,
    on('user', renderChip), on('users', renderChip), on('presence', renderChip), on('connection', renderChip),
    on('unread', renderMailbox), on('mutes', renderMailbox), on('open', renderMailbox),
    on('pins', renderPins), on('open', renderPins),
    on('connection', renderConnection), on('users', renderTitle), on('texts', renderTitle),
  ];
  renderAll();
  return frame.querySelector('.messages-container');
}

export function unmount() {
  offs.forEach(off => off()); offs = [];
  closeProfile();
  frame?.remove(); frame = null; sidebar = null; search = null;
}

function renderAll() { renderChip(); renderMailbox(); renderPins(); renderConnection(); renderTitle(); }

// ---- the title area (SH-05, SH-06, SH-07) and the context (SH-04) ----

// kind: 'room' | 'dm' | 'page'. For a room the template is picked once per channel (SH-05) and the name is
// filled in on every call, so a rename of the open room reaches the header (U04 of the 2026-10-15 user test).
// For a page the text is the page's title.
export function setTitle(kind, { channelId = null, roomName = '', partner = null, text = '' } = {}) {
  if (kind === 'room' && headerPick.channelId !== channelId) headerPick = { channelId, template: pickTemplate(state.texts?.roomHeaders, '# {0}') };
  title = { kind, text: kind === 'room' ? fill(headerPick.template, roomName) : text, partner };
  renderTitle();
}

function renderTitle() {
  if (!frame) return;
  frame.dataset.context = title.kind === 'dm' ? 'dm' : 'room';
  frame.classList.toggle('no-conversation', title.kind === 'page');   // search.css: Settings and the channel pages have nothing to search (SR-19)
  frame.querySelector('.header-line').src = title.kind === 'dm' ? '/images/purpleline01_3px.png' : '/images/turqline01_3px.png';
  const host = frame.querySelector('.header-title');
  if (title.kind === 'room') {
    const h3 = clone('t-header-room');
    replace(h3, inline(title.text));
    replace(host, [h3]);
    return;
  }
  const block = clone('t-header-back');
  block.querySelector('.back-button').addEventListener('click', () => router.navigate('/lobby'));   // SH-44
  const h3 = block.querySelector('h3');
  if (title.kind === 'dm') {
    const u = state.users[title.partner];
    block.insertBefore(avatar(title.partner, u?.avatarUrl, 'small'), h3);
    replace(h3, inline(displayName(title.partner)));
  } else h3.textContent = title.text;
  replace(host, [block]);
}

// ---- the status chip and its menu (SH-11 to SH-15) ----

function ownStatus() {
  const me = state.user;
  if (!me) return 'online';
  if (me.status === 'invisible') return 'invisible';
  return state.presence[me.username] ?? (me.status === 'away' ? 'away' : 'online');
}

function renderChip() {
  if (!frame || !state.user) return;
  const button = frame.querySelector('.status-button');
  button.className = `status-button status-${ownStatus()}`;
  replace(button.querySelector('.status-username'), inline(displayName(state.user.username)));
}

let closeMenu = null;

function openStatusMenu() {
  if (closeMenu) { closeMenu(); return; }   // a second tap on the chip closes it (SH-12)
  const container = frame.querySelector('.status-dropdown-container');
  const menu = clone('t-status-menu');
  const connected = state.connection === 'connected';
  for (const item of menu.querySelectorAll('[data-status]')) {
    item.classList.toggle('active', item.dataset.status === state.user.status);
    item.disabled = !connected;                                      // SH-13
    item.addEventListener('click', async () => {
      closeMenu();
      const before = state.user.status;
      mergeMe({ status: item.dataset.status });                                      // the chip changes now (GEN-01)
      const result = await hub.invoke('setStatus', item.dataset.status);
      if (result?.error) { mergeMe({ status: before }); overlays.reason(frame.querySelector('.status-dropdown-container'), result.error); }
    });
  }
  menu.querySelector('.bell').toggleAttribute('hidden', serverMuted());        // SH-14 (an SVG has no `hidden` property)
  menu.querySelector('.bell-muted').toggleAttribute('hidden', !serverMuted());
  menu.querySelector('[data-action="admin"]').hidden = !state.user.isAdmin;
  menu.querySelector('[data-action="settings"]').addEventListener('click', () => { closeMenu(); sidebar.toggle(false); router.navigate('/settings'); });
  menu.querySelector('[data-action="notifications"]').addEventListener('click', () => { closeMenu(); sidebar.toggle(false); router.navigate('/settings#notification-settings'); });
  menu.querySelector('[data-action="admin"]').addEventListener('click', () => { closeMenu(); sidebar.toggle(false); router.navigate('/admin'); });
  menu.querySelector('[data-action="signout"]').addEventListener('click', () => { closeMenu(); confirmSignOut(); });
  menu.querySelector('.dropdown-backdrop').addEventListener('click', () => closeMenu());
  container.append(menu);
  closeMenu = overlays.open({ element: menu.querySelector('.status-dropdown'), keep: [frame.querySelector('.status-button')], onClose: () => { menu.remove(); closeMenu = null; } });
}

// SH-15: a warning when the account has no link, and one when unsent messages exist. Yap's own dialogs, not the
// browser's: those ignore the theme.
async function confirmSignOut() {
  const me = state.user;
  if (!me.hasLink && !me.hasPassphrase && !await confirm({ title: 'Sign out without a login link?', text: waysBack(me), action: 'Sign out' })) return;
  if (hasQueued() && !await confirm({ title: 'Unsent messages', text: 'Unsent messages on this device will be lost.', action: 'Sign out' })) return;
  if (!await session.signOut()) overlays.reason(frame.querySelector('.status-dropdown-container'), 'Needs a connection');   // GEN-10: the server removes the cookie
}

// What is left after a sign-out without a link, so the warning tells the truth (AU-22): smart login from the same
// network for 14 days when the server and the account allow it (AU-09), then a new link from an admin (AD-06).
// The only admin has nobody to ask. hasPassphrase is a legacy secret code; it counts as a way back (AU-13).
function waysBack(me) {
  const smart = state.config?.smartLoginAllowed && !me.smartLoginOptOut;
  const alone = me.isAdmin && !Object.values(state.users).some(u => u.isAdmin && u.username !== me.username);
  return 'You have no login link. '
    + (smart ? 'Smart login can still sign you in from this network for 14 days. After that, ' : 'Without one, ')
    + (alone ? 'nobody can make you a new link, because you are the only admin.' : 'only an admin can make you a new link.')
    + ' Create a link in Settings before you sign out.';
}

// ---- the pin button and its panel (SH-47 to SH-49) ----

let closePins = null;

function renderPins() {
  if (!frame) return;
  const count = state.open?.pins?.length ?? 0;
  const button = frame.querySelector('.pins-button');
  button.hidden = count === 0;   // a conversation without pins shows no button (SH-47); a page has no open conversation
  button.title = count === 1 ? '1 pinned message' : `${count} pinned messages`;
  button.querySelector('.pins-badge').textContent = String(count);
}

function togglePins() {
  if (closePins) { closePins(); return; }   // a second tap closes it, like the status chip (SH-12)
  closePins = openPins(frame.querySelector('.pins-button'), () => { closePins = null; });
}

// ---- the mailbox (SH-09) ----

function renderMailbox() {
  if (!frame) return;
  const total = unreadTotal({ exceptOpen: true });
  const button = frame.querySelector('.mailbox-button');
  button.hidden = total === 0;
  button.title = `${total} unread messages`;
  button.querySelector('.mailbox-badge').textContent = String(total);
}

// ---- the connection dot (SH-16 to SH-18) ----

const BUBBLES = { connecting: 'Connecting…', reconnecting: 'Reconnecting…', offline: 'Offline. Messages are sent when the connection returns.', signedOut: 'Signed out' };

function renderConnection() {
  if (!frame) return;
  const c = state.connection;
  const dot = frame.querySelector('.connection-dot');
  dot.hidden = c === 'connected' && !state.updateAvailable;
  classes(dot, { offline: c === 'offline', action: c === 'signedOut' || (c === 'connected' && state.updateAvailable) });   // red: the person must act (SH-17)
  const line = frame.querySelector('.header-line');
  classes(line, { connecting: c === 'connecting' || c === 'reconnecting', offline: c === 'offline' });
}

function wireConnectionDot(dot) {
  let bubble = null;
  const show = () => {
    if (bubble) return;
    bubble = el('span', { class: 'connection-bubble' }, state.connection === 'connected' && state.updateAvailable ? 'Update available' : (BUBBLES[state.connection] ?? ''));
    dot.append(bubble);
  };
  const hide = () => { bubble?.remove(); bubble = null; };
  dot.addEventListener('pointerenter', show);
  dot.addEventListener('pointerleave', () => { if (!overlays.isTouch()) hide(); });
  dot.addEventListener('click', () => {
    if (state.connection !== 'connected') hub.reconnectNow();
    show();
    const next = () => { hide(); document.removeEventListener('pointerdown', next, true); };
    setTimeout(() => document.addEventListener('pointerdown', next, true), 0);   // the next tap elsewhere closes it
  });
}

// ---- the profile card (SH-34, SH-35), opened from the people list of the sidebar ----

let profile = null;   // { username, close }

export function closeProfile() { profile?.close(); }

// A second tap on the same person's info button closes the card (SH-34).
export function toggleProfile(username, status, button) {
  if (profile?.username === username) closeProfile(); else openProfile(username, status, null, button);
}

// A hover card next to the pointer, or a centred sheet when the call carries the button that opened it.
export function openProfile(username, status, pointerEvent, button = null) {
  closeProfile();
  if (!frame) return;
  const asSheet = !pointerEvent;
  const u = state.users[username] ?? (username === state.user.username ? state.user : null);
  const popup = clone('t-profile-popup');
  const card = popup.querySelector('.profile-card');
  card.querySelector('.profile-card-banner').style.background = gradient(username, 120);
  card.querySelector('.profile-card-avatar').append(avatar(username, u?.avatarUrl, 'large'));
  const nameNode = card.querySelector('.profile-card-name');
  replace(nameNode, inline(displayName(username)));
  if (u?.isAdmin) nameNode.append(roleBadge('admin'));
  if (u?.isBot) nameNode.append(roleBadge('bot'));
  card.querySelector('.profile-card-username').textContent = `@${username}`;
  const shown = status === 'online' || status === 'away' ? status : 'offline';
  card.querySelector('.profile-card-status-dot').className = `profile-card-status-dot ${shown}`;
  card.querySelector('.profile-card-status').textContent = shown[0].toUpperCase() + shown.slice(1);
  const about = card.querySelector('.profile-card-about'), empty = card.querySelector('.profile-card-empty');
  if (u?.bio) { replace(about.querySelector('.profile-card-bio'), inline(u.bio)); empty.remove(); }
  else { about.remove(); replace(empty, inline('No bio yet — a person of mystery 🕵️')); }
  // The location line is commented out in index.html (the Location field of Settings is off), so `location` is
  // null for now. The `location &&` and the `?.` look removable, but without them no profile card opens.
  const location = card.querySelector('.profile-card-location');
  if (location && u?.location) { replace(location.querySelector('.meta-icon'), inline('📍')); location.querySelector('.meta-text').textContent = u.location; }
  else location?.remove();
  const since = card.querySelector('.profile-card-since');
  if (u?.createdAt) {
    replace(since.querySelector('.meta-icon'), inline('🗓️'));
    since.querySelector('.meta-text').textContent = `Member since ${new Date(u.createdAt).toLocaleDateString('en', { month: 'long', year: 'numeric' })}`;   // SH-35 wording
  } else since.remove();

  let backdrop = null;
  if (asSheet) {
    popup.classList.add('is-mobile');
    backdrop = el('div', { class: 'profile-popup-backdrop' });
    frame.querySelector('.chat-main').append(backdrop);
  } else {
    popup.style.left = `clamp(8px, ${pointerEvent.clientX - 292}px, calc(100vw - 288px))`;
    popup.style.top = `clamp(8px, ${pointerEvent.clientY - 56}px, calc(100dvh - 348px))`;
  }
  frame.querySelector('.chat-main').append(popup);
  const closeLayer = asSheet ? overlays.open({ element: popup, keep: button ? [button] : [], onClose: () => teardown() }) : null;
  function teardown() { popup.remove(); backdrop?.remove(); profile = null; }
  profile = { username, close: () => { if (closeLayer) closeLayer(); else teardown(); } };
}
