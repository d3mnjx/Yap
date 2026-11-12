// The message search of the open conversation (search.md, SR-01 to SR-32). The server finds the messages; this module
// owns the two fields, the result list and the two ways it shows:
//   above 768 px   the field is in the header, and the results take the place of the sidebar (SR-19, SR-20). The
//                  conversation stays beside them, so a result is one click away from the next.
//   768 px or less the sidebar's search row opens the search screen over the frame (SR-24, SR-25). A tap on a result
//                  shows the conversation at the message under a search header (SR-26), and Back returns to the list.
// One search at a time, of the conversation it started in; it ends when that conversation closes (SR-22).
//
// The search is never on the overlay stack (overlays.js). The stack has one way off, close(), which ends the layer,
// and the narrow screen must hide for a message and come back with its list. Escape has its own rule here (onKey),
// and the Back of the phone goes through the router's steps (router.js, SR-27).

import { state, on, displayName, roomById } from '../store.js';
import { clone, el, replace } from '../render/dom.js';
import { pickTemplate, fill } from '../render/text.js';
import { messageTime } from '../render/time.js';
import * as hub from '../hub.js';
import * as overlays from './overlays.js';
import * as router from '../router.js';
import { jumpTo } from './timeline.js';
import { messageEntry } from './entry.js';
import { narrow } from './sidebar.js';

const MIN = 2;          // SR-05; the server refuses a shorter query too (ChatService.MinQueryLength)
const DELAY_MS = 250;   // SR-07: the pause after the last key, as in the GIF search (PK-24)
const SLIDE_MS = 200;   // the screen's move in search.css; the screen leaves the page after it
// SR-21: the find key is Cmd+F on Apple systems and Ctrl+F elsewhere. On a Mac, Ctrl+F in a text field is "one
// character forward", and taking it would move the focus out of the input box in the middle of a text.
const APPLE = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
const isFindKey = e => e.key?.toLowerCase() === 'f' && !e.altKey && !e.shiftKey && (APPLE ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);

// frame: the mounted .chat-container. closeSidebar: the frame's, because the search row sits in the slide-in sidebar.
// Returns { end, unmount }; end is for the frame's mailbox (SR-22).
export function Search(frame, { closeSidebar }) {
  const field = frame.querySelector('.search-field-header');
  const headerInput = field.querySelector('.search-input');
  const screen = frame.querySelector('.search-screen');
  const screenInput = screen.querySelector('.search-input');
  const panel = frame.querySelector('.search-panel');
  const row = frame.querySelector('.search-row');
  const atResult = frame.querySelector('.search-at-result');
  const sidebar = frame.querySelector('.users-sidebar');
  const under = [frame.querySelector('.chat-header'), frame.querySelector('.chat-main')];   // what the search screen covers at 768 px or less
  const results = clone('t-search-results');   // one node: begin() puts it into the panel or into the screen
  const countLine = results.querySelector('.search-count');
  const statusLine = results.querySelector('.search-status');   // the same state for a screen reader (t-search-results)
  const list = results.querySelector('.search-list');
  const aborter = new AbortController();
  const { signal } = aborter;

  // The active search, null when there is none:
  //   channelId, query   what is searched; query is trimmed
  //   phase              'hint' (under 2 characters), 'loading', 'done' or 'error'
  //   hits, total, hasMore, since, error, emptyText   the answer (SearchPage in wire-contract.md) and what stands for it
  //   at                 768 px or less: 'results', or 'message' while the conversation at a result shows
  let s = null;
  let query = '';          // what the fields hold; a desktop search starts only at 2 characters (SR-20)
  let timer = 0;
  let token = 0;           // an answer counts only for the newest call
  let placeholder = null;  // the picked template (SR-32); the name of the conversation goes in at every open
  let sidebarTop = 0;      // the sidebar's scroll position while the panel has its place: a hidden box loses it

  const ready = () => query.trim().length >= MIN;

  // "# general" or the partner's name; plain: the room's name alone, as the room titles get it (SH-05).
  function conversationName(plain = false) {
    const open = state.open;
    if (!open) return '';
    if (open.partner) return displayName(open.partner);
    const room = roomById(open.channelId);
    return room ? (plain ? room.name : `# ${room.name}`) : '';
  }

  // ---- the way in (SR-19, SR-24) ----

  // The field and the row do not hide here while no conversation is open: a switch of the conversation closes one
  // and opens the next after a read from the device, and a field that left for that moment moved the status chip
  // and the mailbox 200 px and back. A page without a conversation hides both by a class of the frame (frame.js
  // renderTitle, search.css .no-conversation).
  function renderEntry() {
    if (s && state.open?.channelId !== s.channelId) end();   // the conversation changed or closed (SR-22)
    if (!placeholder && state.texts) placeholder = pickTemplate(state.texts.searchPlaceholders, 'Search');
    headerInput.placeholder = screenInput.placeholder = fill(placeholder ?? 'Search', conversationName(true));
  }

  function clearFields() {
    query = ''; headerInput.value = ''; screenInput.value = '';
    syncClear();
  }
  function syncClear() {
    // Above 768 px the X ends the search, so it stays while a search is open: the panel outlives an emptied field
    // (SR-20), and a tablet with a wide window has no Escape key to end it.
    field.querySelector('.search-clear').hidden = !query && !s;
    screen.querySelector('.search-clear').hidden = !query;   // on the screen the X only empties the field (SR-29)
  }

  // 768 px or less: what the search screen covers must not take the focus or be read under it. Not while the
  // conversation at a result shows: then the screen is the hidden part.
  function cover(on) { for (const part of under) part.inert = on; }

  function onInput(e) {
    query = e.target.value;
    syncClear();
    if (!s && !narrow.matches && ready()) begin();   // SR-20: above 768 px the results show from 2 characters
    if (s) schedule();
  }

  // 768 px or less: the sidebar row and Ctrl+F. The focus goes into the field inside the tap itself; a phone opens
  // its keyboard only for a focus that a tap made (SR-30).
  function openScreen() {
    closeSidebar();   // SH-37
    if (!s) { clearFields(); begin(); }
    if (s) screenInput.focus({ preventScroll: true });
  }

  function begin() {
    if (!state.open?.channelId) return;
    s = { channelId: state.open.channelId, query: query.trim(), phase: 'hint', hits: [], total: 0, hasMore: false, since: null, error: null, emptyText: '', at: 'results', loadingMore: false };
    if (narrow.matches) {
      screen.querySelector('.search-screen-body').append(results);
      screen.querySelector('.header-line').src = frame.querySelector(':scope > .header-line').src;   // the room's or the direct message's line (SH-01)
      screen.hidden = false; screen.inert = false; screen.classList.remove('away');
      void screen.offsetWidth;          // the screen has a box before the class arrives, so the move runs (SR-30)
      screen.classList.add('in');
      cover(true);
      router.pushStep(() => { overlays.closeAll(); end(); });   // SR-27: Back from the results ends the search. The layers first, as every history move closes them (main.js)
    } else {
      panel.append(results);
      panel.hidden = false;
      sidebarTop = sidebar.scrollTop;
      frame.classList.add('search-open');   // search.css: the sidebar gives its place to the panel
    }
    syncClear();
    draw();
  }

  // ---- the query and the answers (SR-07, SR-11, SR-14) ----

  function schedule() {
    clearTimeout(timer);
    token++;   // an answer on its way belongs to the old query
    s.query = query.trim();
    s.loadingMore = false;
    if (!ready()) { s.phase = 'hint'; s.hits = []; draw(); return; }   // SR-15
    s.phase = 'loading';
    draw();    // SR-14: "Searching…" over the results of the old query
    timer = setTimeout(run, DELAY_MS);
  }

  async function run() {
    const mine = ++token, search = s;
    const page = await hub.invoke('search', search.channelId, search.query, null, null);   // without a connection: { error: 'Needs a connection' } (SR-18)
    if (mine !== token || s !== search) return;
    if (page?.error) { Object.assign(s, { phase: 'error', error: page.error, hits: [] }); draw(); return; }
    Object.assign(s, { phase: 'done', hits: page.hits, total: page.total, hasMore: page.hasMore, since: page.since,
      emptyText: page.hits.length ? '' : fill(pickTemplate(state.texts?.searchEmpty, 'No results'), s.query) });   // SR-13, SR-32
    draw();
    list.scrollTop = 0;
    fillView();
  }

  // The next 25, after the last result on screen (SR-11). The total stays the first answer's: a count taken again
  // would move while messages arrive.
  async function more() {
    if (!s || s.phase !== 'done' || !s.hasMore || s.loadingMore) return;
    const mine = token, search = s, last = s.hits.at(-1);
    s.loadingMore = true;
    const page = await hub.invoke('search', s.channelId, s.query, last.timestamp, last.messageId);
    if (mine !== token || s !== search) return;
    s.loadingMore = false;
    if (page?.error) { overlays.reason(results, page.error); return; }   // the list stays; the next scroll asks again
    s.hits.push(...page.hits);
    s.hasMore = page.hasMore;
    const nodes = page.hits.map(entry);
    removeTail();
    list.append(...nodes, ...tail());
    nodes.forEach(reveal);
    fillView();
  }

  // A list shorter than its box gives no scroll event: it asks for the next page itself.
  function fillView() { if (s?.hasMore && list.scrollHeight <= list.clientHeight) more(); }

  // ---- drawing (SR-08 to SR-15) ----

  function countText() {
    if (s.phase === 'loading') return 'Searching…';
    if (s.phase !== 'done' || !s.hits.length) return '';
    const count = s.total === 1 ? '1 result' : `${s.total} results`;
    return narrow.matches ? `${count} · ${conversationName()}` : count;   // SR-25: the screen's header shows the field, so the count line names the conversation
  }

  function draw() {
    const count = countText(), after = tail();
    countLine.textContent = count;
    if (s.at === 'message') drawAt();
    statusLine.textContent = count || after.map(n => n.textContent).join(' ');   // without a count: the hint, a refusal, or the empty text with the reach
    if (s.phase === 'loading' && s.hits.length) return;   // SR-14: the old results stay until the answer comes
    const nodes = s.hits.map(entry);
    replace(list, [...nodes, ...after]);
    nodes.forEach(reveal);   // needs the box, so after the nodes are in the page
  }

  // The header of the conversation at a result (SR-26). It follows the search: a result of the query before can be
  // tapped while the answer to a longer query loads, and that answer then replaces "Searching…" here too.
  function drawAt() {
    atResult.querySelector('.search-at-query span').textContent = s.query;
    atResult.querySelector('.search-at-count').textContent = countText();
  }

  function entry(hit) {
    const node = messageEntry('t-search-result', hit, { onOpen: () => open(node, hit) });   // no openShots: a picture belongs to the entry, and its tap goes to the message
    const text = node.querySelector('.pin-text');
    if (text) highlight(text, wordsOf(s.query));
    return node;
  }

  // What follows the results: the hint, a refusal, the empty text, and the line that says how far back the search
  // reaches (SR-12). No reach line while more results can load: it is the end of the list.
  const note = (kind, text) => el('div', { class: `search-note ${kind}` }, text);
  function tail() {
    if (s.phase === 'hint') return [note('search-hint', 'Type 2 or more characters')];
    if (s.phase === 'error') return [note('search-error', s.error)];
    if (s.phase !== 'done' || s.hasMore) return [];
    const reach = s.since ? [note('search-since', `Search covers messages in ${conversationName()} since ${messageTime(s.since).replace(/^Yesterday/, 'yesterday')}.`)] : [];   // a row's time label, here inside a sentence   // no date: the reader sees no message at all
    return s.hits.length ? reach : [note('search-empty', s.emptyText), ...reach];
  }
  function removeTail() { for (const n of list.querySelectorAll('.search-note')) n.remove(); }

  // SR-09: a result shows 6 lines of its text (search.css). When the first match is below them, the box scrolls so
  // that the match is on its second line; the text itself is whole and unchanged, so a link or an emoji needs no
  // rule of its own. The classes put a fade on an edge where text is cut.
  function reveal(node) {
    const text = node.querySelector('.pin-text');
    if (!text) return;
    const mark = text.querySelector('mark');
    if (mark && mark.offsetTop + mark.offsetHeight > text.clientHeight) text.scrollTop = mark.offsetTop - parseFloat(getComputedStyle(text).lineHeight);
    text.classList.toggle('cut-top', text.scrollTop > 0);
    text.classList.toggle('cut-bottom', text.scrollTop + text.clientHeight < text.scrollHeight - 1);
  }

  // ---- a result (SR-17, SR-26) ----

  async function open(node, hit) {
    if (node.classList.contains('jumping')) return;
    const search = s;
    node.classList.add('jumping');
    const reason = await jumpTo(hit.messageId);   // the pins' jump (TL-41): a loaded row is centred, any other comes in a window
    node.classList.remove('jumping');
    if (s !== search) return;
    if (reason) { overlays.reason(node, reason); return; }
    if (narrow.matches && s.at === 'results') showMessage();
  }

  // 768 px or less: the conversation at the result, under a header that says search (SR-26). The screen fades and
  // keeps its list and its scroll position for the way back.
  function showMessage() {
    s.at = 'message';
    drawAt();
    atResult.hidden = false;
    frame.classList.add('search-at');   // search.css: the title and the controls give their place to the search header
    screenInput.blur();
    for (const playing of list.querySelectorAll('video')) playing.pause();   // a video of a result must not play on with sound under the conversation
    screen.classList.add('away');
    screen.inert = true;                // faded is not gone: no tap and no Tab reaches it
    cover(false);
    router.pushStep(() => { overlays.closeAll(); showResults(); });   // SR-27: Back from the message shows the results
  }

  function showResults() {
    if (!s) return;   // the search ended first, and the router dropped this step with it
    s.at = 'results';
    atResult.hidden = true;
    frame.classList.remove('search-at');
    screen.classList.remove('away');
    screen.inert = false;
    cover(true);
  }

  // ---- the end (SR-22, SR-28) ----

  // Every end comes here: the X and Escape, Back from the results, a return to the newest messages at a result, a
  // change of the conversation, a change of the width tier. The state goes first and the history after it: the
  // router moves only when steps are open, so an end that a navigation caused moves nothing (router.js dropSteps).
  function end() {
    clearTimeout(timer);
    token++;
    const was = s;
    s = null;
    clearFields();
    if (document.activeElement === headerInput || document.activeElement === screenInput) document.activeElement.blur();
    if (!was) return;
    panel.hidden = true;
    atResult.hidden = true;
    cover(false);
    const hadPanel = frame.classList.contains('search-open');
    frame.classList.remove('search-open', 'search-at');
    if (hadPanel) sidebar.scrollTop = sidebarTop;   // the sidebar had no box under the panel, and a box that comes back starts at the top
    // The rows leave with the search: a video or a voice message that plays in a result must not play on in a list
    // that nobody sees.
    const empty = () => { if (!s) replace(list, []); };
    const sliding = !screen.hidden && !screen.classList.contains('away');   // the result list is on screen and leaves with the move (SR-30)
    if (!screen.hidden) {
      screen.inert = true;
      screen.classList.remove('in', 'away');
      if (sliding) setTimeout(() => { if (!s) screen.hidden = true; empty(); }, SLIDE_MS);
      else screen.hidden = true;   // faded: the conversation is on screen already, there is no move to show
    }
    if (!sliding) empty();
    router.dropSteps();
  }

  // ---- keys (SR-21, SR-23) ----

  function onKey(e) {
    if (e.key === 'Escape') {
      // SR-23: Escape ends the search only when this key press closed nothing else. A layer of the stack and the
      // inline edit mark the event as handled; the composer's pickers are not on the stack and close on a listener
      // that can run after this one, so their flag is read here.
      if ((!s && !query) || e.defaultPrevented || e.isComposing || frame.querySelector('.message-input-container[data-picker]')) return;
      end();
      return;
    }
    if (!isFindKey(e)) return;
    if (!state.open?.channelId || overlays.anyOpen()) return;   // no conversation, or a layer has the keys: the browser's find
    const input = narrow.matches ? screenInput : headerInput;
    if (document.activeElement === input) return;               // SR-21: a second press is the browser's find
    e.preventDefault();
    if (!narrow.matches) { headerInput.focus(); headerInput.select(); }
    else if (s?.at === 'message') history.back();               // one step back, to the results
    else openScreen();
  }

  // ---- wiring ----

  headerInput.addEventListener('input', onInput);
  screenInput.addEventListener('input', onInput);
  field.querySelector('.search-clear').addEventListener('click', end);   // SR-22: above 768 px the X ends the search
  screen.querySelector('.search-clear').addEventListener('click', () => {   // SR-29: on the screen the X empties the field, and the arrow ends the search
    clearFields();
    if (s) schedule();
    screenInput.focus();
  });
  // The Search key of a phone keyboard (enterkeyhint in the template): the search ran already, so the key only puts
  // the keyboard away, which covers the lower half of the list.
  screenInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) screenInput.blur(); });
  for (const back of frame.querySelectorAll('.search-back')) back.addEventListener('click', () => history.back());   // SR-27: the arrow is the Back of the browser
  row.addEventListener('click', openScreen);
  list.addEventListener('scroll', () => { if (list.scrollTop + list.clientHeight > list.scrollHeight - 400) more(); }, { passive: true, signal });
  document.addEventListener('keydown', onKey, { signal });
  narrow.addEventListener('change', end, { signal });   // SR-31: the two tiers show the search in different places

  const offs = [
    on('open', renderEntry), on('rooms', renderEntry), on('users', renderEntry), on('texts', renderEntry),
    on('tail', () => { if (s?.at === 'message') end(); }),   // SR-28: only at a result; under the list a reconnect must not lose the query
    // SR-18: "Needs a connection" is true only while there is none. When the connection is back, the query on screen
    // is searched again; without this the refusal stays until the person changes the query.
    on('connection', () => { if (s?.error === 'Needs a connection' && s.phase === 'error' && state.connection === 'connected') schedule(); }),
  ];
  renderEntry();

  return { end, unmount() { end(); aborter.abort(); offs.forEach(off => off()); } };
}

// ---- the highlight (SR-10) ----

// The fold of the server (Helpers/TextFold.cs): case and accent marks do not count. One character at a time, so a
// position in the folded text maps back to a position in the text on screen.
const fold = ch => ch.normalize('NFD').replace(/\p{Mn}/gu, '').toLowerCase();
const wordsOf = query => query.split(/\s+/).map(word => [...word].map(fold).join('')).filter(Boolean);

// Wraps every occurrence of a word in <mark>. Only text nodes are read and split, and the mark is a made element: a
// message text is what a person typed, and it never becomes markup.
function highlight(root, words) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) markIn(node, words);
}

function markIn(node, words) {
  const raw = node.data;
  let folded = '';
  const rawAt = [];   // rawAt[i]: where the i-th folded character starts in the text. A decomposed letter is longer than its fold, so the two positions differ
  for (let i = 0; i < raw.length; i++) for (const c of fold(raw[i])) { folded += c; rawAt.push(i); }
  const ranges = [];
  for (const word of words)
    for (let at = folded.indexOf(word); at >= 0; at = folded.indexOf(word, at + word.length))
      ranges.push([rawAt[at], at + word.length < rawAt.length ? rawAt[at + word.length] : raw.length]);   // up to the next folded character: a mark that follows the last letter stays with it
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged.at(-1);
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else merged.push(r);
  }
  for (const [start, end] of merged.reverse()) {   // from the end: the positions before a split stay valid
    node.splitText(end);
    const match = node.splitText(start);
    const mark = document.createElement('mark');
    match.replaceWith(mark);
    mark.append(match);
  }
}
