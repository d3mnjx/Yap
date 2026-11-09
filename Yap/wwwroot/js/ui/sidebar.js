// The sidebar of the frame (frame.md, SH-21 to SH-33, SH-36, SH-37): the rooms, then the people, in one panel
// that scrolls. Under the sidebar tier it slides in over the conversation. frame.js mounts it with the frame and
// opens it from the header.

import { state, on, displayName, isMuted, showsBell, dmByChannel, lobby, onlineCount } from '../store.js';
import { clone, replace, classes } from '../render/dom.js';
import { inline, pick } from '../render/text.js';
import * as overlays from './overlays.js';
import * as router from '../router.js';

export const narrow = matchMedia('(max-width: 768px)');   // the sidebar tier (SH-02, SH-03)

function lobbyId() { return lobby()?.id; }   // marked by the server; the sidebar order says nothing about it (SH-43)

// A sidebar row is a div with role=link and tabindex=0: Enter or Space on the row itself activates it. The gear
// and the info button inside it are buttons of their own; their keys bubble up here and must not navigate
// (U03 of the 2026-10-15 user test).
function activateOnKey(row, fn) {
  row.addEventListener('keydown', e => { if (e.target === row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); fn(); } });
}

// The fade at the bottom of the sidebar shows only while rows are hidden below the edge (frame.css .has-more).
// The observer covers the two things that change that besides a scroll: the panel's height and the lists' length.
// Returns the release for `offs`; the scroll listener needs none, it goes with the sidebar node in unmount.
function wireSidebarFade(sidebar) {
  const update = () => sidebar.classList.toggle('has-more', sidebar.scrollTop + sidebar.clientHeight < sidebar.scrollHeight - 1);
  sidebar.addEventListener('scroll', update, { passive: true });
  const sizes = new ResizeObserver(update);
  sizes.observe(sidebar);
  sidebar.querySelectorAll('.sidebar-section').forEach(s => sizes.observe(s));
  return () => sizes.disconnect();
}

// The order of SH-30: admins, the bot, the user, then everyone else by unread DMs, online, recent DM, name.
function peopleNames(dmOf) {
  const me = state.user.username;
  return [...new Set([...Object.keys(state.presence), ...Object.keys(dmOf), me])].filter(n => state.users[n] || n === me);
}

function peopleInOrder(names, dmOf) {
  const me = state.user.username;
  const rank = username => {
    const u = state.users[username];
    if (u?.isAdmin) return 0;
    if (u?.isBot) return 1;
    if (username === me) return 2;
    const dm = dmOf[username];
    if (dm && (state.unread[dm.channelId] ?? 0) > 0 && !isMuted(dm.channelId)) return 3;
    if (state.presence[username]) return 4;
    return 5;
  };
  return [...names].sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 5) {
      const ta = dmOf[a]?.lastMessageAt ?? '', tb = dmOf[b]?.lastMessageAt ?? '';
      if (ta !== tb) return ta < tb ? 1 : -1;
    }
    return displayName(a).localeCompare(displayName(b), undefined, { sensitivity: 'base' });
  });
}

// The people list is every account, two thousand on the test server, and the sidebar shows about a dozen of
// them. The list holds rows for the people in view plus a margin and stands in for the rest with padding of the
// right height, so a pass costs one sort and a few dozen clones whatever the number of people. Before, a pass
// rebuilt every row: at 1,500 people that was 6,000 clones a second and the tab stopped answering (2026-10-18
// load test, runs 3 and 4). A pass runs at most every 250 ms, one frame at a time, and not at all when nothing a
// row shows has changed; a scroll or a resize of the sidebar redraws the window on the next frame.
const PEOPLE_GAP_MS = 250;
const PEOPLE_OVERSCAN = 10;     // rows kept above and below the view, so a short scroll needs no redraw
const PEOPLE_FALLBACK = 40;     // rows when the sidebar has no size (a closed phone sheet) or no row was measured yet

// Everything a row shows, as one string: the same string means the same rows, and the rebuild is skipped.
function peopleSignature(names, dmOf, openDm) {
  let sig = `${state.open?.channelId ?? ''}|${state.open?.partner ?? ''}|${openDm?.partner ?? ''}|${overlays.isTouch() || narrow.matches}`;
  for (const n of names) {
    const u = state.users[n], dm = dmOf[n];
    sig += `\n${n}|${state.presence[n] ?? ''}|${displayName(n)}|${u?.isAdmin ? 1 : 0}${u?.isBot ? 1 : 0}`;
    if (dm) sig += `|${dm.lastMessageAt ?? ''}|${state.unread[dm.channelId] ?? 0}|${isMuted(dm.channelId) ? 1 : 0}${showsBell(dm.channelId) ? 1 : 0}`;
  }
  return sig;
}

// frame: the mounted .chat-container. profile: the functions of the frame's profile card (openProfile, closeProfile,
// toggleProfile). They come in as an argument because the card hangs in the frame, and an import of frame.js from
// this module would be a cycle. Returns { toggle, unmount }.
export function Sidebar(frame, profile) {
  const panel = frame.querySelector('.users-sidebar');     // the panel is also the scroller (frame.css)
  const backdrop = frame.querySelector('.sidebar-backdrop');
  let live = true;                                          // false after unmount: a late timer or frame draws nothing
  let peoplePick = { count: -1, text: '' };

  // Opens, closes or (without an argument) flips the panel. It shows as an overlay only under the sidebar tier.
  function toggle(force) {
    const open = force ?? !panel.classList.contains('sidebar-open');
    panel.classList.toggle('sidebar-open', open);
    backdrop.classList.toggle('show', open);
  }

  function renderHeader() {
    const count = onlineCount();
    if (peoplePick.count !== count) peoplePick = { count, text: pick(state.texts?.peopleHeaders, 'Online Users ({0})', count) };   // SH-28
    replace(frame.querySelector('.people-header'), inline(peoplePick.text));
  }

  function renderRooms() {
    if (!live || !state.user) return;
    const rows = state.rooms.map(room => {
      const row = clone('t-room-row');
      replace(row.querySelector('.room-name'), inline(room.name));
      const isOpen = state.open?.channelId === room.id;
      const count = isOpen ? 0 : (state.unread[room.id] ?? 0);   // the open room shows no mark (SH-22)
      const muted = isMuted(room.id);
      classes(row, { active: isOpen, 'has-unread': count > 0 && !muted });
      row.querySelector('.mute-bell').hidden = !showsBell(room.id);
      row.querySelector('.unread-dot').hidden = !(count > 0 && muted);
      const badge = row.querySelector('.unread-badge');
      badge.hidden = !(count > 0 && !muted);
      badge.textContent = String(count);
      const gear = row.querySelector('.room-settings');
      gear.hidden = !state.user.isAdmin;
      gear.addEventListener('click', e => { e.stopPropagation(); toggle(false); router.navigate(`/channel/${room.id}/settings`); });
      const open = () => { toggle(false); router.navigate(router.roomPath(room, lobbyId())); };   // SH-26
      row.addEventListener('click', open);
      activateOnKey(row, open);
      return row;
    });
    if (state.user.isAdmin) {
      const add = clone('t-add-room');
      const open = () => { toggle(false); router.navigate('/channel/new'); };
      add.addEventListener('click', open);
      activateOnKey(add, open);
      rows.push(add);
    }
    replace(frame.querySelector('.rooms-list'), rows);
  }

  let peopleTimer = 0, peopleAt = 0, peopleSig = '';
  let peopleOrder = [];                        // the usernames in order, from the last pass
  let peopleWindow = { start: -1, end: -1 };   // the rows that exist, as indexes into peopleOrder
  let peopleRowHeight = 0;                     // one row plus the list's gap, measured from a drawn row
  function renderPeople() {
    if (peopleTimer) return;
    const wait = Math.max(0, PEOPLE_GAP_MS - (performance.now() - peopleAt));
    peopleTimer = setTimeout(() => requestAnimationFrame(() => { peopleTimer = 0; peopleAt = performance.now(); peoplePass(); }), wait);
  }

  function peoplePass() {
    if (!live || !state.user) return;
    const dmOf = Object.fromEntries(state.dms.map(d => [d.partner, d]));
    const openDm = state.open && dmByChannel(state.open.channelId);
    const names = peopleNames(dmOf);
    const sig = peopleSignature(names, dmOf, openDm);
    if (sig === peopleSig) return;
    peopleSig = sig;
    peopleOrder = peopleInOrder(names, dmOf);
    drawPeopleWindow(true);
  }

  // The rows in view, plus the margin. `force` draws them again even when the window did not move: the facts changed.
  function drawPeopleWindow(force) {
    if (!live || !state.user) return;
    const list = frame.querySelector('.users-list');
    const n = peopleOrder.length;
    let start = 0, end = Math.min(n, PEOPLE_FALLBACK);
    if (peopleRowHeight && panel.clientHeight) {
      const listTop = list.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop;   // the list's own padding is inside its box
      const first = Math.floor((panel.scrollTop - listTop) / peopleRowHeight);
      const visible = Math.ceil(panel.clientHeight / peopleRowHeight);
      start = Math.max(0, Math.min(n, first - PEOPLE_OVERSCAN));
      end = Math.max(start, Math.min(n, first + visible + PEOPLE_OVERSCAN));
    }
    if (!force && start === peopleWindow.start && end === peopleWindow.end) return;
    const me = state.user.username;
    const dmOf = Object.fromEntries(state.dms.map(d => [d.partner, d]));
    const openDm = state.open && dmByChannel(state.open.channelId);
    const focused = document.activeElement?.closest?.('.user-item')?.dataset.username;
    const rows = peopleOrder.slice(start, end).map(username => makeUserRow(username, me, dmOf, openDm));
    list.style.paddingTop = `${start * peopleRowHeight}px`;
    list.style.paddingBottom = `${(n - end) * peopleRowHeight}px`;
    replace(list, rows);
    peopleWindow = { start, end };
    if (focused) list.querySelector(`.user-item[data-username="${CSS.escape(focused)}"]`)?.focus();   // the same person, a new element
    // The row height follows the text size setting (rem), so it is measured from a drawn row on every pass; a
    // change draws once more with the right window.
    const measured = rows.length ? rows[0].offsetHeight + (parseFloat(getComputedStyle(list).rowGap) || 0) : 0;
    if (measured && measured !== peopleRowHeight) { peopleRowHeight = measured; drawPeopleWindow(true); }
  }

  // A scroll or a resize of the sidebar moves the window of rows; the sidebar is the scroller (frame.css).
  function wirePeopleWindow(scroller) {
    let pending = 0;
    const redraw = () => { if (!pending) pending = requestAnimationFrame(() => { pending = 0; drawPeopleWindow(false); }); };
    scroller.addEventListener('scroll', redraw, { passive: true });
    const sizes = new ResizeObserver(redraw);
    sizes.observe(scroller);
    return () => { scroller.removeEventListener('scroll', redraw); sizes.disconnect(); if (pending) cancelAnimationFrame(pending); };
  }

  function makeUserRow(username, me, dmOf, openDm) {
    const u = state.users[username];
    const row = clone('t-user-row');
    const status = state.presence[username] ?? 'invisible';   // grey, as offline (SH-29, SH-31)
    row.querySelector('.user-status-dot').className = `user-status-dot ${status}`;
    replace(row.querySelector('.user-name'), [...inline(displayName(username)), username === me ? ' (you)' : null]);
    row.querySelector('.admin-badge').hidden = !u?.isAdmin;
    row.querySelector('.bot-badge').hidden = !u?.isBot;
    replace(row.querySelector('.admin-badge'), inline('👑'));
    replace(row.querySelector('.bot-badge'), inline('🤖'));
    const dm = dmOf[username];
    const count = dm && openDm?.channelId !== dm.channelId ? (state.unread[dm.channelId] ?? 0) : 0;
    const muted = dm ? isMuted(dm.channelId) : false;
    row.querySelector('.mute-bell').hidden = !(dm && showsBell(dm.channelId));
    row.querySelector('.unread-dot').hidden = !(count > 0 && muted);
    const badge = row.querySelector('.unread-badge');
    badge.hidden = !(count > 0 && !muted);
    badge.textContent = String(count);
    classes(row, { 'current-user': username === me, 'active-dm': openDm?.partner === username || state.open?.partner === username });   // a new DM has no row in dms yet (SH-32)

    const info = row.querySelector('.profile-info-btn');
    const needsButton = overlays.isTouch() || narrow.matches;   // SH-34
    info.hidden = !needsButton;
    info.addEventListener('click', e => { e.stopPropagation(); profile.toggleProfile(username, status, info); });   // a second tap closes (SH-34)
    const name = row.querySelector('.user-name');
    if (!needsButton) {
      name.addEventListener('pointerenter', e => profile.openProfile(username, status, e));
      name.addEventListener('pointerleave', profile.closeProfile);
    }
    if (username === me) { row.tabIndex = -1; row.removeAttribute('role'); }   // the own row opens nothing (SH-32)
    else {
      const open = () => { profile.closeProfile(); toggle(false); router.navigate(router.dmPath(username)); };
      row.addEventListener('click', open);
      activateOnKey(row, open);
    }
    row.dataset.username = username;   // the focus goes back to the same person after a redraw
    return row;
  }

  const onNarrow = () => { toggle(false); renderPeople(); };
  backdrop.addEventListener('click', () => toggle(false));
  narrow.addEventListener('change', onNarrow);
  const offs = [
    wireSidebarFade(panel),
    wirePeopleWindow(panel),
    on('presence', renderPeople), on('users', renderPeople), on('dms', renderPeople), on('unread', renderPeople), on('mutes', renderPeople), on('open', renderPeople),
    on('rooms', renderRooms), on('unread', renderRooms), on('mutes', renderRooms), on('open', renderRooms), on('user', renderRooms),
    on('presence', renderHeader), on('texts', renderHeader),
    () => narrow.removeEventListener('change', onNarrow),
  ];
  renderPeople(); renderRooms(); renderHeader();

  return { toggle, unmount() { live = false; offs.forEach(off => off()); } };
}
