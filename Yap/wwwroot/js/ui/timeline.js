// The list of messages (timeline.md): the rows, the follow rule, the New messages pill, the down arrow, older
// pages, the top note, the lobby lines. The rows themselves are drawn by ui/message.js. The timeline is the one
// component that updates rows in place, because it can hold hundreds of them.

import { state, on, prependOlder, setWindow, atTail, roomById, dmByChannel, lobby } from '../store.js';
import { clone, el, replace } from '../render/dom.js';
import { inline, pick } from '../render/text.js';
import { messageTime } from '../render/time.js';
import * as hub from '../hub.js';
import * as overlays from './overlays.js';
import { renderRow, needsHeader, rowReplaced, touchScrolled, redrawStars } from './message.js';

let current = null;   // the mounted instance, for jumpTo

// reopen: the chat page's open, the one a reconnect runs. In a window it is the way back to the newest messages (TL-41).
export function Timeline(root, { reopen }) {
  const list = clone('t-messages');
  const flow = list.querySelector('.messages-flow');
  const top = flow.querySelector('.messages-top');
  const spacer = flow.querySelector('.messages-spacer');
  root.append(list);
  const aborter = new AbortController();
  const { signal } = aborter;

  const rows = new Map();          // message id -> { node, message }
  let pendingNodes = [];
  let following = true;
  let loading = false;
  let pill = null;
  let pillPick = '';
  let down = null;                 // the down arrow (TL-40)
  let catching = null;             // the catching-up pill (TL-39)
  let loadingPill = null;          // the loading pill (TL-06)
  let stale = false;               // the rows on screen are the device's copy, or older than the connection (TL-39)
  let unread = false;              // the server counted a message in the open conversation and markRead has not answered yet (NT-07)
  let shownChannel = null;         // the channel the rows belong to
  let shownWindow = false;         // the rows on screen are a window that ends before the newest message (TL-41)
  let drawnFacts = '';             // what the rows were drawn with: the people and the quick reactions (redrawIfRowsChanged)

  // ---- drawing ----

  function ordered() { return [...(state.open?.messages ?? []), ...state.pending]; }

  // The same message under the same header rule: its node can stay through a reset.
  const unchanged = (r, m, prev) => r.node.classList.contains('has-header') === needsHeader(prev, m) && JSON.stringify(r.message) === JSON.stringify(m);

  // A reset for the same conversation (a reconnect, TL-35) keeps the view where it is; a new one opens at the bottom (TL-01).
  // A jump (TL-41) names its target: the new rows are a window, and the view goes to the target instead.
  function reset(target = null) {
    const same = state.open && state.open.channelId === shownChannel;
    const keptTop = list.scrollTop, keptFollowing = following;
    const leftWindow = shownWindow && atTail();   // the rows before this reset were a window: the kept place belongs to them (TL-41)
    shownWindow = !atTail();
    // The rows of the same conversation whose message did not change stay: the node moves into the new order instead
    // of being drawn again. At every open the server's rows follow the device's copy, nearly always the same fifty,
    // and drawing them again asked for every emoji image once more; on the iPhone every <img> is a request of its
    // own (2026-10-31). A row in the editor stays too while its message is the same.
    const kept = same ? new Map(rows) : new Map();
    if (!same) for (const r of rows.values()) r.node.remove();
    rows.clear();
    pendingNodes.forEach(n => n.remove()); pendingNodes = [];
    flow.querySelectorAll('.lobby-line').forEach(n => n.remove());
    hidePill(); hideDown();
    landed = null;   // the rows it measured are gone (the still view, below)
    shownChannel = state.open?.channelId ?? null;
    unread = state.unread[shownChannel] > 0;   // a count from before this open; chat.js marks it read on open, this is the fallback
    if (!state.open) { renderTop(); return; }
    let prev = null;
    for (const m of ordered()) {
      const old = m.pending ? null : kept.get(m.id);
      if (old && unchanged(old, m, prev)) { kept.delete(m.id); flow.append(old.node); rows.set(m.id, { node: old.node, message: m }); }
      else flow.append(makeRow(m, prev));
      prev = m;
    }
    for (const r of kept.values()) r.node.remove();   // the rows the new tail does not have
    drawnFacts = rowFacts();   // what these rows were drawn with (redrawIfRowsChanged)
    // An older page still in flight belongs to the rows just removed: its answer is dropped (loadOlder), and
    // the spinner must not outlive the rows it was loading for. Without this, a reconnect that re-opened the
    // conversation while a page was loading showed "loading older" for ever (the token was never released).
    loadToken++; loading = false;
    renderTop();
    const jumped = target && rows.get(target);
    if (jumped) {
      centre(jumped.node, { animate: false });   // the rows are new: an animation from the old place has no meaning
      syncDown();                           // the arrow is the way back, at any distance in a window (TL-40, TL-41)
      return;
    }
    if (same && !keptFollowing && !leftWindow) {   // a tail that replaces a window goes to the bottom, whatever the reader did meanwhile
      following = false; list.scrollTop = keptTop;
      syncDown();   // the same value as before gives no scroll event, so the arrow is checked here (TL-40)
      if (nearTop()) loadOlder();   // still at the top after a reconnect (the 100 px floor): the page the person waited for (TL-06)
      return;
    }
    following = true;
    scrollToBottom();
  }

  function makeRow(m, prev) {
    const node = renderRow(m, { header: needsHeader(prev, m) });
    if (m.pending) pendingNodes.push(node); else rows.set(m.id, { node, message: m });
    return node;
  }

  // Draws one row again in place, with the header rule applied (MR-01, MR-09).
  function redraw(m, prev) {
    const r = rows.get(m.id);
    if (!r || r.node.classList.contains('editing')) return;   // the editor and its text stay (MR-62); the row refreshes after
    const node = renderRow(m, { header: needsHeader(prev, m) });
    r.node.replaceWith(node);
    rowReplaced(r.node, node);   // the touch bar and an open picker or menu follow the row (MR-51)
    r.node = node; r.message = m;
  }

  function redrawAll() {
    const all = state.open?.messages ?? [];
    all.forEach((m, i) => redraw(m, all[i - 1] ?? null));
    keepPlace();
  }

  // The rows redraw when a person's name, picture or flags changed, or the quick reactions did (ST-07, MR-41). The
  // bootstrap fires both at every connect, nearly always with the same content, and each full redraw asked the
  // worker for every emoji image once more (on the iPhone every <img> is a request of its own, 2026-10-31). So the
  // rows remember what they were drawn with, and a bootstrap that brings the same facts leaves them alone.
  const rowFacts = () => JSON.stringify([Object.keys(state.users).sort().map(k => state.users[k]), state.emoji?.quickReactions]);
  function redrawIfRowsChanged() {
    const facts = rowFacts();
    if (facts === drawnFacts) return;
    drawnFacts = facts;
    redrawAll();
  }

  function neighbours(index) {
    const all = state.open.messages;
    return { prev: all[index - 1] ?? null, next: all[index + 1] ?? null };
  }

  function onMessages(detail) {
    if (!state.open) { reset(); return; }
    switch (detail?.type) {
      case 'reset': reset(); break;
      case 'window': reset(detail.target); break;     // a jump (TL-41); the kept map keeps rows of the same message
      case 'missed': arrived(detail.message); break;  // a window ends before it: the follow is off, so the pill shows for someone else's message (TL-16)
      case 'add': {
        const m = detail.message;
        const index = state.open.messages.indexOf(m);
        const { prev, next } = neighbours(index);
        const node = renderRow(m, { header: needsHeader(prev, m) });
        rows.set(m.id, { node, message: m });
        const nextNode = next ? rows.get(next.id)?.node : pendingNodes[0];
        if (nextNode) flow.insertBefore(node, nextNode); else flow.append(node);
        if (next) redraw(next, m);
        arrived(m);
        break;
      }
      case 'replace': {
        const m = detail.message;
        const { prev } = neighbours(state.open.messages.indexOf(m));
        redraw(m, prev);
        keepPlace();
        break;
      }
      case 'remove': {
        const r = rows.get(detail.id);
        if (!r) break;
        r.node.remove(); rows.delete(detail.id);
        const all = state.open.messages;
        const i = all.findIndex(x => x.timestamp >= r.message.timestamp && x.id !== detail.id);   // the row that followed may now start a group
        if (i >= 0) redraw(all[i], all[i - 1] ?? null);
        break;
      }
      case 'older': {
        const before = list.scrollHeight, beforeTop = list.scrollTop;
        const all = state.open.messages;
        const nodes = [];
        for (let i = 0; i < detail.count; i++) nodes.push(makeRow(all[i], all[i - 1] ?? null));
        if (all[detail.count]) redraw(all[detail.count], all[detail.count - 1]);   // the old first row may lose its header
        spacer.after(...nodes);
        loading = false;
        renderTop();   // the top slot changes (the note when history ended) BEFORE the measurement below. A change
                       // after it leaves the rows off from where the scroll put them, and Chrome then scores the whole
                       // prepend as a layout shift: it discounts a compensated move only when the scroll matches it
                       // within 3 px (the old spinner row did exactly that: 49 px off, 0.5 per page).
        const top = beforeTop + (list.scrollHeight - before);
        placeTop(top, caught);                                             // the view does not move (TL-06)
        if (touchWebKit && top - beforeTop >= 400) landed = { top, delta: top - beforeTop };   // checked at the next move
        break;
      }
    }
  }

  // The pending rows: a send goes to the bottom (TL-14); progress and other tabs do not move the view (TL-12).
  function onPending(detail) {
    // A send in a window goes to the present first (TL-14, TL-41): the reset of the fresh open draws the pending row at
    // the bottom. Without a connection there is no open: the row shows under the window at once (OF-08), and the
    // reconnect's open brings the present. Other changes draw here as usual: a failed row from before the jump stays.
    if (detail?.type === 'queued' && !atTail() && state.connection === 'connected') { reopen(); return; }
    pendingNodes.forEach(n => n.remove()); pendingNodes = [];
    let prev = state.open?.messages.at(-1) ?? null;
    for (const m of state.pending) { flow.append(makeRow(m, prev)); prev = m; }
    if (detail?.type === 'queued') { following = true; scrollToBottom(); hidePill(); }
    else keepPlace();
  }

  // A new row arrived: follow, or show the pill (TL-10, TL-16). The read mark is not sent from here: the server
  // gives a reader no count (NT-07), so for a person who is looking there is nothing to answer. The `unread`
  // event drives markRead instead (onUnread), one call per counted message and none per message in a busy room.
  function arrived(m) {
    const own = m.username === state.user?.username;
    if (following) scrollToBottom();
    else if (!own && !m.kind) showPill();   // a system line is not a new message (TL-16, MR-80)
  }

  // The server counted a message in the open conversation: the person was hidden, away or idle when it came.
  // Answer with markRead as soon as the person sees it (NT-07).
  function onUnread() {
    if (!state.open || !(state.unread[state.open.channelId] > 0)) return;
    unread = true;
    markReadIfSeen();
  }

  // ---- the top note (TL-07, TL-09, TL-34) ----

  function renderTop() {
    const open = state.open;
    renderLoadingOlder();
    if (!open) { replace(top, []); return; }
    if (open.loading && state.connection !== 'offline') { replace(top, [clone('t-loading-tail')]); return; }   // the first answer is on its way (TL-02)
    if (open.hasMore) {
      // "Needs a connection" only without one (TL-34): offline, or every try failed. While a connection is on its way the
      // slot stays empty: the pill of TL-39 says "Catching up…", and a link to older messages could not be served yet.
      if (state.connection === 'offline' || state.connectionFailed) { replace(top, [el('div', { class: 'history-start' }, 'Needs a connection')]); return; }
      if (state.connection !== 'connected') { replace(top, []); return; }
      if (!loading && list.scrollHeight <= list.clientHeight + 1) {   // the pill stands in for the link while the page loads
        const button = clone('t-load-earlier');
        button.addEventListener('click', loadOlder);
        replace(top, [button]);
      } else replace(top, []);
      return;
    }
    const dm = dmByChannel(open.channelId) ?? (open.partner ? { partner: open.partner } : null);
    if (dm) {
      const note = clone('t-dm-start');
      note.querySelector('strong').textContent = dm.partner;
      replace(top, [note]);
      return;
    }
    const room = roomById(open.channelId);
    const note = clone('t-history-start');
    if (open.restricted) note.append(el('span', null, 'Older messages are not available in this channel'));
    else if (room?.description) note.append(...room.description.split('\n').map(line => el('div', null, line)));
    else note.append(el('span', null, `This is the beginning of #${room?.name ?? ''}`));
    replace(top, [note]);
  }

  let loadToken = 0;   // the older request in flight; a reset invalidates it
  async function loadOlder() {
    const open = state.open;
    if (!open || loading || !open.hasMore || !open.messages.length || state.connection !== 'connected') return;
    const token = ++loadToken;
    loading = true; renderTop();
    const oldest = open.messages[0];
    const startedAt = performance.now();
    const page = await hub.invoke('older', open.channelId, oldest.timestamp, oldest.id);
    if (token !== loadToken || state.open !== open) return;   // the rows changed meanwhile; reset() released the spinner
    if (page?.error) { loading = false; renderTop(); overlays.reason(list.parentElement, page.error); return; }   // GEN-02
    const fetched = performance.now() - startedAt;
    await whenStill();                                                   // the rows go in while the view is still (TL-06)
    if (token !== loadToken || state.open !== open) return;              // a reset meanwhile: the page belongs to removed rows
    const placing = performance.now();
    prependOlder(page);
    // the rows are in place: the 'older' change ran inside prependOlder. The wait for a still view is the reader's
    // own time and is not counted (AD-26).
    hub.report('older', fetched + performance.now() - placing);
  }

  // ---- following and the pill (TL-10 to TL-18) ----

  const distanceFromBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight;

  // One scroll per frame, however many rows, reactions and cards asked for one: each scrollHeight read forces a
  // layout of the whole list, and on the 2026-10-18 load test those layouts were a share of a tab that stopped
  // answering. The frame callback runs before the paint, so the bottom is in view as early as before.
  let scrollFrame = 0;
  const watched = new WeakSet();   // images with a load listener already: a second call must not add another
  function scrollToBottom() {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      list.scrollTop = list.scrollHeight;
      // again after the images and posters of the newest rows load (TL-04)
      for (const img of flow.querySelectorAll('img')) {
        if (img.complete || watched.has(img)) continue;
        watched.add(img);
        img.addEventListener('load', () => { if (following) scrollToBottom(); }, { once: true });
      }
    });
  }

  function keepPlace() { if (following) scrollToBottom(); }   // a reaction or a card never moves the newest row out of view (TL-10)

  let lastTop = 0;
  list.addEventListener('scroll', () => {
    touchScrolled(list.scrollTop);                                            // MR-51: 50 px hides the touch bar
    const up = list.scrollTop < lastTop;
    lastTop = list.scrollTop;
    const distance = distanceFromBottom();
    if (up && distance > 80) following = false;                               // only an upward scroll stops the follow (TL-11)
    else if (distance <= 80 && !following && atTail()) { following = true; hidePill(); markReadIfSeen(); }   // TL-13; a window's last row is not the newest (TL-41)
    syncDown(distance);                                                       // TL-40
    if (nearTop(up)) loadOlder();                                             // TL-06
    moved(list.scrollTop);                                                    // the still view (TL-06)
  }, { passive: true, signal });

  // TL-06: the next page loads while the reader scrolls up and is still two screens from the top, so the prepend
  // lands out of sight and the pictures of the new page start loading before they reach the view. Every other way
  // to the top (the open, a reconnect, a jump, a downward scroll) keeps the 100 px floor: a short conversation sits
  // within two screens of its top at the bottom, and must not fetch a page nobody asked for.
  function nearTop(up = false) { return list.scrollTop <= (up ? Math.max(100, 2 * list.clientHeight) : 100); }

  // ---- the still view (TL-06) ----
  // A page lands only while the view is still: no finger on the list and no scroll event for 200 ms. iOS drops a
  // scrollTop write while a finger is on the glass, and before iOS 27 a write halts the fling. With the page two
  // screens early it landed mid-gesture, the compensating write was lost, and the view stayed on the new rows, a
  // whole page off (iPhone, 2026-10-23). A write at rest lands everywhere, and the hold shows nothing: the rows go
  // in above the view, and the pill covers a long one. 200 ms clears the rubber-band bounce at the top, whose
  // scroll events come up to 134 ms apart.
  const STILL_MS = 200;
  // iOS WebKit only (iPadOS reports a Mac, so the touch points tell): a finger that lands during a fling sends no
  // touch or pointer event at all, so the touch flag misses it. stoppedFromSpeed and verifyLanded cover that finger.
  const touchWebKit = navigator.maxTouchPoints > 0 && /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Android/.test(navigator.userAgent);
  let lastScrollAt = -Infinity, touching = false, caught = false, ownTop = null, landed = null, stillWaiter = null, stillTimer = 0;
  const samples = [];   // the last scroll positions with their times: the speed at the last event
  list.addEventListener('touchstart', () => { touching = true; caught = false; }, { passive: true, signal });   // a reported finger: the unreported one is gone
  for (const type of ['touchend', 'touchcancel']) list.addEventListener(type, () => {
    touching = false;
    samples.length = 0;   // the finger is up: a fling that follows sends new events, and a dead stop before the lift is no caught fling
    checkStill();
  }, { passive: true, signal });

  function moved(top) {
    if (top === ownTop) { ownTop = null; return; }   // the event of the handler's own write: the reader did not move
    ownTop = null;
    const now = performance.now();
    lastScrollAt = now;
    samples.push({ top, now });
    while (samples.length > 2 && now - samples[1].now > 40) samples.shift();   // the last 40 ms, two at least
    if (landed) verifyLanded(top);
    checkStill();
  }

  // Resolves when the view is still. An earlier waiter belongs to rows a reset removed; it resolves and its token check drops the page.
  function whenStill() { return new Promise(resolve => { stillWaiter?.(); stillWaiter = resolve; checkStill(); }); }

  function checkStill() {
    clearTimeout(stillTimer); stillTimer = 0;
    if (!stillWaiter || touching) return;                                       // touchend calls again
    const wait = STILL_MS - (performance.now() - lastScrollAt);
    if (wait > 0) { stillTimer = setTimeout(checkStill, wait); return; }
    if (touchWebKit && stoppedFromSpeed()) { caught = true; return; }            // a finger on the glass: the next scroll event calls again
    const resolve = stillWaiter; stillWaiter = null; resolve();
  }

  // A fling that ends by itself slows to a crawl first. One that stops from speed was caught by a finger, which iOS
  // does not report. Others measured the line at 0.05 px/ms over the last 40 ms (TanStack virtual #1307); 0.1 here,
  // because a crawl of one whole pixel per frame reads 0.06 when the browser reports whole pixels, and a fling
  // caught that slow is a case for verifyLanded. The top edge stops a fling from speed too, without a finger.
  function stoppedFromSpeed() {
    if (samples.length < 2) return false;
    const a = samples[0], b = samples[samples.length - 1];
    return b.top > 0 && Math.abs(b.top - a.top) / (b.now - a.now) >= 0.1;
  }

  // The compensating write. Its scroll event is no move of the reader (ownTop). Forced: iOS drops a write while a
  // finger is on the glass, and after a caught fling that unreported finger may still rest there. With overflow
  // hidden around the write the list is no scroll view for that moment, and the position is the page's alone. A
  // gesture under such a finger ends there; the next touch starts anew.
  function placeTop(top, force) {
    if (force) list.style.overflow = 'hidden';
    ownTop = top;
    list.scrollTop = top;
    if (force) list.style.overflow = '';
    caught = false;
  }

  // The first real scroll event after a prepend tells where the view is. Near the position from before the prepend
  // means iOS dropped the write (a finger was on the glass after all) and the view shows the new rows: the write
  // repeats, forced.
  function verifyLanded(top) {
    const { top: expected, delta } = landed; landed = null;
    if (Math.abs(top - (expected - delta)) > 150) return;
    placeTop(top + delta, true);
  }

  // The list and its container: a taller input box or an open sheet shrinks the list, and the bottom must stay in view (TL-10).
  // The pill and the arrow are placed again: the strip they sit above moved with the list's bottom edge.
  const sizes = new ResizeObserver(() => {
    if (following) list.scrollTop = list.scrollHeight;
    if (state.open?.hasMore && !loading) renderTop();
    if (pill) place(pill);
    if (down) place(down);
  });
  sizes.observe(flow); sizes.observe(list);

  // Above the typing strip and the input box, never over the draft (TL-16, TL-40). Measured against the positioned
  // column the node sits in: the timeline root has `display: contents` and so no box of its own.
  function place(node) {
    const column = node.offsetParent ?? list.parentElement;
    const strip = column.querySelector('.typing-indicator-container');
    const top = strip ? strip.getBoundingClientRect().top : list.getBoundingClientRect().bottom;
    node.style.bottom = `${Math.max(0, column.getBoundingClientRect().bottom - top) + 8}px`;
  }

  function showPill() {
    if (pill) return;
    hideDown();   // the pill says more and does the same (TL-40)
    pill = clone('t-pill');
    pillPick ||= pick(state.texts?.pillTexts, 'New messages');   // the phrase does not change while shown (TL-17)
    pill.querySelector('.pill-text').textContent = pillPick;
    pill.addEventListener('click', toBottom);
    list.parentElement.append(pill);
    place(pill);
  }
  function hidePill() { pill?.remove(); pill = null; pillPick = ''; }

  // TL-13, TL-40, TL-41: the pill and the arrow. At the tail, to the bottom. In a window the newest rows are not on
  // screen: the conversation opens again (the path of a reconnect), and its reset goes to the bottom (leftWindow).
  // The server marks the conversation read on that open, so the window needs no markRead of its own.
  function toBottom() {
    if (!atTail()) {
      if (state.connection !== 'connected') { overlays.reason(list.parentElement, 'Needs a connection'); return; }   // GEN-02; the reconnect's open goes to the bottom
      reopen(); return;
    }
    following = true; scrollToBottom(); hidePill(); hideDown(); markReadIfSeen();
  }

  // ---- the down arrow (TL-40) ----
  // The way back after a jump to a pinned message or a long read up: the view is more than a screen above the
  // bottom and there is no pill. The pill wins, because it also says that something new arrived. A few rows up
  // show nothing: the person can scroll that far by hand. In a window the arrow shows at any distance: the bottom
  // of the window is not the newest message, and scrolling there by hand does not lead back (TL-41).
  function syncDown(distance = distanceFromBottom()) {
    const hide = atTail() ? (following || pill || distance <= list.clientHeight) : !!pill;
    if (hide) { hideDown(); return; }
    if (down) return;
    down = clone('t-down-arrow');
    down.addEventListener('click', toBottom);
    list.parentElement.append(down);
    place(down);
  }
  function hideDown() { down?.remove(); down = null; }

  // ---- the loading pill (TL-06) ----
  // Over the top of the list like the catching-up pill, outside the scroller. A row in the flow moved the first rows
  // by its height when it came and went (the 'older' handler had to measure around it), and as the first box in the
  // flow it could become the browser's scroll anchor near the top, which froze the view while pictures loaded.
  function renderLoadingOlder() {
    if (!loading) { loadingPill?.remove(); loadingPill = null; return; }
    if (!loadingPill) { loadingPill = clone('t-loading-older'); list.parentElement.append(loadingPill); }
  }

  // ---- the catching-up pill (TL-39) ----
  // The rows came from the device, or the connection went away since they came: the server has not confirmed them.
  // The pill floats over the top of the list and takes no space, so no row moves. It ends with the server's answer
  // (setOpen from openRoom), not with the socket: the dot reports the socket, the pill reports the content.
  function renderCatchingUp() {
    const show = stale && !!state.open && !state.open.loading;
    if (!show) { catching?.remove(); catching = null; return; }
    if (!catching) { catching = clone('t-catching-up'); list.parentElement.append(catching); }
    const failed = state.connection === 'offline' || state.connectionFailed;
    catching.classList.toggle('failed', failed);
    catching.querySelector('.catching-up-text').textContent = failed ? 'No connection. Showing older messages.' : 'Catching up…';
  }

  // NT-07: unread rows, the view at the bottom, and the person looking (hub.looking: visible, not away, not idle).
  function markReadIfSeen() {
    if (!unread || !following || !hub.looking()) return;
    hub.send('markRead', state.open.channelId);
    unread = false;
  }

  document.addEventListener('visibilitychange', () => {   // TL-15, NT-07
    if (document.visibilityState === 'visible' && following) { scrollToBottom(); markReadIfSeen(); }
  }, { signal });
  const onInput = () => markReadIfSeen();                 // input after an idle away (PR-13)
  document.addEventListener('pointerdown', onInput, { capture: true, passive: true, signal });
  document.addEventListener('keydown', onInput, { capture: true, passive: true, signal });

  // ---- lobby lines (MR-73) ----
  function onPresence(detail) {
    if (!detail?.changes) return;                          // a bootstrap replaces the map without a detail
    if (!state.open || state.open.channelId !== lobby()?.id || !atTail()) return;   // a line belongs after the newest message, not under a window (TL-41)
    let added = false;
    for (const { username, kind } of detail.changes) {    // one tick of changes, a line per join or leave (MR-73)
      if (kind !== 'join' && kind !== 'leave') continue;
      const line = clone('t-system-line');
      line.classList.add('lobby-line');
      const text = kind === 'join' ? pick(state.texts?.joinLines, '{0} joined the chat', username) : pick(state.texts?.leaveLines, '{0} left the chat', username);
      replace(line.querySelector('.message-content'), inline(text));
      flow.append(line);
      added = true;
    }
    if (added && following) scrollToBottom();
  }

  // The labels follow the clock: at midnight "today" becomes "Yesterday" (MR-06).
  const clock = setInterval(() => {
    for (const { node, message } of rows.values()) {
      const time = node.querySelector('.message-time');
      if (time) time.textContent = messageTime(message.timestamp);
    }
  }, 60_000);

  // ---- jump to a message (MR-34, SH-49, TL-41) ----
  // A loaded row scrolls into view. Any other row comes in a window around it, one round trip at any distance, and
  // the window replaces the rows. Returns the reason of a refusal, or null.
  let jumpToken = 0;
  async function jumpTo(id) {
    const token = ++jumpToken;                         // every tap counts, a loaded row too: an older answer must not move the view after it
    const r = rows.get(id);
    if (r) { centre(r.node, { animate: true }); return null; }
    const open = state.open;
    if (!open) return 'Not available';
    if (state.connection !== 'connected') return 'Needs a connection';   // TL-34
    const startedAt = performance.now();
    const around = await hub.invoke('around', open.channelId, id);
    if (token !== jumpToken) return null;              // a later jump won; it answers for its own tap
    // A reconnect or a switch replaced the rows meanwhile. The page's own open, in flight under the stored rows (TL-39),
    // lands here too: it leaves before any tap, and the server runs one call per connection at a time (SignalR's
    // default MaximumParallelInvocationsPerClient of 1), so its answer replaces the rows before this answer arrives.
    // With parallel calls, a window could show and then give way to the tail with no reason.
    if (state.open !== open) return 'Try again';
    if (around?.error) return around.error;            // GEN-02: "Too old to load", "Message not found.", "Needs a connection"
    setWindow(around, id);                             // the 'window' change draws the rows and centres the target
    // AD-26: the timeout after the frame callback runs after the paint, so the wait ends with the rows on screen
    requestAnimationFrame(() => setTimeout(() => hub.report('jump', performance.now() - startedAt)));
    return null;
  }

  // The row in the middle of the view, highlighted (MR-34). The follow stops: the reader is at the row, not at the
  // newest message.
  function centre(node, { animate }) {
    following = false;
    cancelAnimationFrame(scrollFrame); scrollFrame = 0;   // a bottom scroll queued for an earlier row must not undo this
    const highlight = () => { node.classList.add('highlight-message'); setTimeout(() => node.classList.remove('highlight-message'), 2000); };
    const target = node.offsetTop - list.offsetTop - list.clientHeight / 2 + node.offsetHeight / 2;
    if (!animate) {
      const top = Math.round(Math.max(0, Math.min(target, list.scrollHeight - list.clientHeight)));
      // A jump is no scroll up by the reader: with lastTop here, the scroll event keeps the 100 px floor of nearTop and
      // asks for no older page two screens early. placeTop marks the write as the handler's own for the still view.
      lastTop = top;
      placeTop(top);
      highlight();
      return;
    }
    const start = list.scrollTop, distance = target - start, t0 = performance.now();
    const ease = t => 1 - Math.pow(1 - t, 3);
    const step = now => {
      const k = Math.min((now - t0) / 600, 1);
      list.scrollTop = start + distance * ease(k);
      if (k < 1) requestAnimationFrame(step);
      else highlight();
    };
    requestAnimationFrame(step);
  }

  const offs = [
    on('messages', onMessages), on('pending', onPending), on('presence', onPresence),
    on('connection', () => { if (state.connection !== 'connected') stale = true; renderTop(); renderCatchingUp(); }),   // a lost socket: the rows may be old (TL-39)
    on('open', () => { stale = !!state.open?.fromDevice; renderCatchingUp(); }),                                           // the server's answer ends the pill
    on('rooms', renderTop),
    on('unread', onUnread),
    on('user', () => markReadIfSeen()), on('presence', () => markReadIfSeen()),   // Away ended, here or on the server: the three conditions may hold again (NT-07)
    on('users', redrawIfRowsChanged),  // a new display name or avatar shows on every row (ST-07)
    on('favoriteGifIds', redrawStars), // the stars follow the account (PK-36); a full redraw here cost ~800 ms per click
    on('emoji', redrawIfRowsChanged),  // the quick reactions of the bar (MR-41)
  ];
  current = { jumpTo };
  reset();
  return () => {
    offs.forEach(off => off()); aborter.abort(); sizes.disconnect(); clearInterval(clock); hidePill(); hideDown(); catching?.remove(); loadingPill?.remove(); clearTimeout(stillTimer); list.remove();
    if (current?.jumpTo === jumpTo) current = null;
  };
}

export function jumpTo(id) { return current?.jumpTo(id) ?? Promise.resolve('Not available'); }
