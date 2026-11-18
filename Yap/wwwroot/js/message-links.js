// Message links (TL-43, TL-44, MR-84 to MR-86): the address of one message, the way from an address to the message,
// and the label that a row shows in the place of the address.
//
// An address is {origin}/m/{code}. The code is the message id, a Guid, in 22 characters: the 16 bytes in the order
// of the hex digits of the usual writing, as base64url without padding. Only this file changes between the two
// writings. The server always gets the id as a Guid, so the byte order of .NET's Guid.ToByteArray, which is a
// different one, never meets this code. The server knows the form of the path for one purpose only: it makes no
// link card for it (LinkPreviewService.IsMessageLink).

import { state, lobby, roomById, displayName } from './store.js';
import * as hub from './hub.js';
import * as router from './router.js';
import { icon } from './render/dom.js';
import { messageTime } from './render/time.js';
import * as overlays from './ui/overlays.js';
import { jumpTo } from './ui/timeline.js';
import { notice } from './ui/confirm.js';

const NOT_FOUND = 'Message not found.';   // the sentence of a refused jump (TL-41); TL-44 says why it is the only one
const MAX_IDS = 50;                              // the server reads the first 50 ids of a call (ChatService.MaxMessageLinks)

// ---- the two writings of a message id ----

export function codeOf(id) {
  const bytes = id.replaceAll('-', '').match(/../g).map(hex => parseInt(hex, 16));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

// The id of a code, or null for a text that is no code.
export function idOf(code) {
  if (!/^[A-Za-z0-9_-]{22}$/.test(code)) return null;
  const bytes = atob(code.replaceAll('-', '+').replaceAll('_', '/') + '==');
  const hex = [...bytes].map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// The address that Copy Message Link copies (MR-84). The origin is the one of this tab: a person who uses the server
// under a second address copies a link with that address.
export const linkOf = id => `${location.origin}/m/${codeOf(id)}`;

// The message id of a message link of this server, or null for every other address. The URL class reads the origin:
// a comparison of the start of the text would take https://{this host}@other.example/m/{code} for a link of this
// server, and a click with Ctrl on it opens the other site.
export function messageIdOf(href) {
  let url;
  try { url = new URL(href); } catch { return null; }
  if (url.origin !== location.origin) return null;
  const code = /^\/m\/([^/]+)$/.exec(url.pathname)?.[1];
  return code ? idOf(code) : null;
}

// ---- the server's answer about a message ----
// state.messageLinks holds one promise for each id that was asked about. It resolves to the server's entry
// ({ id, channelId, dmUser, username, timestamp }), to null when the server gave no entry (the reader may not read the
// message, or it does not exist), or to { error } when the call failed. A failed call leaves the map, so the next
// question asks the server again; an entry and a null stay until the page loads again or the session ends.

// Asks the server about the ids that have no promise yet, in one call. Ids after the first 50 wait for the next call.
function ask(ids) {
  const links = state.messageLinks;
  const unknown = [...new Set(ids)].filter(id => !links.has(id)).slice(0, MAX_IDS);
  if (!unknown.length) return;
  const call = hub.invoke('messageLinks', unknown);
  for (const id of unknown) {
    const answer = call.then(result => {
      if (!result?.error) return result.find(entry => entry.id === id) ?? null;
      if (links.get(id) === answer) links.delete(id);   // not after a sign-out: the map is then a new one
      return { error: result.error };
    });
    links.set(id, answer);
  }
}

// ---- the open of a link (TL-43) ----

// The jump that waits for the open of its conversation. A link to another conversation navigates there, and the
// chat page takes the jump when the server's rows are in the timeline (pages/chat.js). A jump straight after the
// navigation would meet the device's stored rows, and jumpTo answers 'Try again' when the rows change under it.
// It is state.waitingJump ({ channelId, id }), in the store for the reason the answers are there: reset() takes it
// away with the account, so the next person on the device never gets the jump of the one before.

// The chat page calls this after each open that the server answered. The message to jump to, when the waiting jump
// belongs to this conversation. Nothing waits afterwards in every case: a reconnect opens the conversation again and
// must not jump a second time, and the open of another conversation ends the wait.
export function takeJump(channelId) {
  const jump = state.waitingJump;
  state.waitingJump = null;
  return jump?.channelId === channelId ? jump.id : null;
}

// Opens the message of a link. `link` is the clicked element; without one, the address itself was opened
// (pages/message-link.js), and `id` is null when the text after /m/ was no code.
export async function open(id, link) {
  if (id) ask([id]);
  const answer = id && await state.messageLinks.get(id);
  if (!answer || answer.error) { refuse(answer?.error ?? NOT_FOUND, link); return; }
  if (router.current.page === 'chat' && state.open?.channelId === answer.channelId) {
    const reason = await jumpTo(id);
    if (reason) refuse(reason, link);
    return;
  }
  state.waitingJump = { channelId: answer.channelId, id };
  // An opened address leaves no entry of its own in the history: Back must not come back to /m/{code} and open the
  // link a second time.
  router.navigate(answer.dmUser ? router.dmPath(answer.dmUser) : router.roomPath({ id: answer.channelId }, lobby()?.id), { replace: !link });
}

// GEN-02: the reason shows at the place of the action. A clicked link stays where it is, and the reason shows for
// two seconds at the element that holds it: reason() puts its text into the element it gets, and inside the link the
// text would be a part of the link. An opened address has no place, so the lobby opens and a dialog says the reason.
// A clicked link can be gone when the answer comes: a reaction drew its row again during the wait. The reader then
// stays where they are, as after every click (TL-44), and the dialog says the reason.
function refuse(reason, link) {
  if (link?.isConnected) { overlays.reason(link.parentElement, reason); return; }
  if (!link) router.navigate('/lobby', { replace: true });   // before the dialog: a navigation closes every overlay
  failed(reason);
}

// A jump that the chat page could not make after it opened the conversation of a link. The reader is in the right
// conversation and stays there.
export function failed(reason) { notice({ title: 'Message link', text: reason }); }

// ---- the label of a link in a row (MR-86) ----

// Turns the message links of one drawn row into labels: the room, the author and the time of the linked message in
// the place of the address. The address stays until the server's answer is there, and for good when the server gave
// no entry or the call failed. One call asks about all links of the row that have no promise yet. No queue collects
// the rows of a page: message links are rare, and a queue would need a moment that empties it.
// The timeline draws a row again after each reaction, edit and card (ui/timeline.js), with new nodes. Every drawing
// calls this, and the promise of an id is the same one each time, so the new nodes get their label from it, with no
// second call, also when the answer comes after the redraw.
export function decorate(node) {
  const found = [];
  for (const link of node.querySelectorAll('a.message-link')) {
    const id = messageIdOf(link.href);
    if (id) found.push({ link, id });
  }
  if (!found.length) return;
  ask(found.map(f => f.id));
  for (const { link, id } of found) state.messageLinks.get(id)?.then(answer => { if (answer?.id) label(link, answer); });
}

// The names go in as text, never as markup: a person chooses the name of a room and a display name.
function label(link, { channelId, dmUser, username, timestamp }) {
  const room = dmUser ? null : roomById(channelId);
  if (!dmUser && !room) return;   // a room that this page does not know: the address stays
  // A direct message has no room to name. Its label is the author and the time.
  const parts = [...(room ? [`# ${room.name}`] : []), displayName(username), messageTime(timestamp)];
  link.classList.add('message-link-label');
  link.replaceChildren(icon('link', { width: 14, height: 14 }), parts.join(' · '));
}

// ---- the click on a link in a message ----
// One listener for the document. messageText (render/text.js) draws every link, and it only draws: it serves the
// rows, the captions, the pins panel and the search results, and none of them has a handler for links. A link to a
// message of this server opens here, in this tab. Every other click keeps the browser's behaviour: another link
// opens its new tab (MR-13), and Ctrl, Shift, Alt, the Command key or the middle button on a message link do
// what the browser does with a link.
document.addEventListener('click', e => {
  if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  const link = e.target.closest?.('a.message-link');
  const id = link && messageIdOf(link.href);
  if (!id) return;
  e.preventDefault();
  open(id, link);
});
