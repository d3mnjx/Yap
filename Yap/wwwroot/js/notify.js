// The sound and the tab title (NT-12, NT-13, SH-45), and the app badge (SH-46, NT-11). The rules: the
// conversation that receives decides (GEN-07); own messages never count (GEN-08); muted ones count nothing.

import { state, on, isMuted, unreadTotal, dmByChannel } from './store.js';

let baseTitle = document.title;   // the shell's <title>: the project name, stamped by the server (ShellEndpoints)
let arrivals = {};   // channelId -> messages counted since the tab hid; the title shows their sum (NT-12)
let audio = null;
let lastUnread = {};

export function setTitle(text) {
  baseTitle = text;
  render();
}

function render() {
  const total = Object.values(arrivals).reduce((sum, n) => sum + n, 0);
  document.title = total > 0 ? `(${total}) ${baseTitle}` : baseTitle;
}

// Pre-loaded on the first input, because a browser plays nothing before a gesture.
function ensureAudio() {
  if (audio) return;
  audio = new Audio('/notif.mp3');
  audio.preload = 'auto';
  audio.load();
}
for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, ensureAudio, { once: true, capture: true, passive: true });

const openIsDm = () => !!(state.open && (dmByChannel(state.open.channelId) || state.open.partner));

// The title: the arrivals since the tab hid, read off the unread counts, which every conversation sends (NT-12).
// On a room page every unmuted conversation counts; on a direct message page only direct messages.
on('unread', () => {
  const previous = lastUnread;
  lastUnread = { ...state.unread };
  if (document.visibilityState === 'visible' || !state.user) return;
  for (const [channelId, count] of Object.entries(state.unread)) {
    const before = previous[channelId] ?? 0;
    if (count <= before || isMuted(channelId)) continue;
    if (openIsDm() && !dmByChannel(channelId)) continue;
    arrivals[channelId] = (arrivals[channelId] ?? 0) + count - before;
  }
  // A read in another session sets the count to 0, and the store drops the key. The arrivals of a conversation
  // can never be more than its count. Without this cap, a hidden tab kept "(3)" for messages read on the phone.
  // The cap also covers a reconnect, where the bootstrap brings counts that fell while the socket was down.
  for (const [channelId, n] of Object.entries(arrivals)) {
    const count = state.unread[channelId] ?? 0;
    if (count === 0) delete arrivals[channelId];
    else if (n > count) arrivals[channelId] = count;
  }
  render();
});

// The sound: a direct message from someone else, on a direct message page, while the tab is hidden (NT-13).
// A Web Lock per message lets one tab play it, whatever the number of tabs (NT-14).
on('incoming', m => {
  if (!state.user || m.username === state.user.username || m.kind) return;   // own messages and system lines make no sound (MR-80)
  if (document.visibilityState === 'visible' || isMuted(m.channelId)) return;
  if (!openIsDm() || !(dmByChannel(m.channelId) || m.channelId === state.open?.channelId)) return;
  const play = () => { ensureAudio(); audio?.play().catch(() => {}); };
  if (navigator.locks) navigator.locks.request(`yap-sound-${m.id}`, { ifAvailable: true }, lock => { if (lock) { play(); return new Promise(r => setTimeout(r, 3000)); } });
  else play();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { arrivals = {}; render(); }
});

// The badge counts every unmuted conversation, the open one included (NT-11).
function badge() {
  if (!('setAppBadge' in navigator)) return;
  const total = unreadTotal();
  (total > 0 ? navigator.setAppBadge(total) : navigator.clearAppBadge()).catch(() => {});
}
on('unread', badge);
on('mutes', badge);
