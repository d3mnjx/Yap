# Input-Locality Round-Trip Analysis

> **Status:** all four items shipped 2026-08-07 and were field-validated 2026-08-11 (users on slow
> connections reported the chat loop as much better). The per-item plans were removed; their
> invariants live in code comments (`MessageInput.razor`, `PickerPane.razor`, `chat.js`) and in the
> `input-locality-roadmap` memory. Line references below are as of 2026-08-06. The "Deliberately
> parked" list is the live backlog.

*2026-08-06 — follow-up to the July responsiveness round (`git show 841b7f5:docs/message-send-flow-analysis.md`, memory: `responsiveness-latency-analysis`). Scope: the main chat loop — typing, sending, opening the emoji/GIF pickers, selecting emojis/GIFs. Goal: make actions local; keep the server the source of truth.*

## Baseline — already local

The July round established: send-button enablement via `:placeholder-shown`, Enter routed to `sendBtn.click()`, optimistic text ghost in `.pending-echoes` with a MutationObserver reconciler, client-side autoresize/caret tracking, and instant emoji *insertion* (`setupEmojiPickerClick` splices into the textarea with no round trip). Prod telemetry: server work ≤71ms, slow-client RTT ~904ms — **the wire is the enemy, so everything below targets round trips, not server code.**

## 1. Typing — one dispatch *and one render batch* per keystroke

The textarea is `@bind:event="oninput"` (`MessageInput.razor:87`). Each keystroke sends an RPC and produces a non-empty render batch (the value attribute changed) needing an ACK. Nothing visible waits on it, but:

- A fast typist on a slow link exceeds the default 10-unacked-render-batch cap and **stalls the circuit's render pipeline** — incoming messages *and* the send click queued behind the keystroke backlog. Type-a-sentence-then-Enter pays for the whole backlog.
- Its only jobs are the server's draft copy and the typing indicator.

**Proposal:** switch to plain `@bind` (change granularity) + the **edit-box pattern already shipped**: the send capture listener dispatches a synthetic `change` (Blazor serializes the value synchronously at dispatch, *before* the listener clears the textarea), then the click RPC follows — in-order circuit processing guarantees `messageText` is fresh for `HandleSend`'s guard. Typing indicator moves to a small JS tracker (start dispatch once per burst, stop after 3s idle / empty / send). Net: typing burst = **2 dispatches instead of N**, zero per-keystroke batches. Emoji insertion's synthetic `input` also stops costing a server sync.

⚠️ Supersedes a documented invariant: "no synthetic input after the clear" becomes "synthetic `change` with the full value **before** the clear, nothing after". Update `responsiveness-latency-analysis` memory when this lands. Accepted edge: ReadOnly flip mid-composition restores a stale draft (rare).

## 2. Sending — done; leave the server pipeline alone

Text send is already optimistic end-to-end. `SendMessageAsync` awaiting persist + unread before events (`ChatService.cs:894-912`) is honest and cheap. The remaining win is indirect: item 1 unclogs the queue in front of the click RPC.

## 3. Opening the pickers — the worst remaining interaction

`ToggleEmojiPicker`/`ToggleGifPicker` are server round trips mounting the subtree from scratch: click → RTT → ~1000 emoji cells rendered (≈250KB markup in the batch) → DOM build → **~1000 CDN image fetches at once** (picker cells have no `loading` attribute — `BuildEmojiImg`, `EmojiService.Rendering.cs:228`). Realistically 1.5–2s to usable on the slow client. GIF picker similar plus trending load.

**Proposal — mount hidden once, toggle with CSS, JS owns open/close:**

- Render the picker subtree **once in the background** shortly after page load (flag flipped after first render), kept `display:none`. Open/close = JS capture listener flipping a `data-picker="emoji|gif"` **attribute** on the input container (attribute, not class — the container's class is Blazor-interpolated; `data-dragging` precedent).
- All close rules move to JS: backdrop click, textarea focus, send, GIF selected, mobile layout flip. `showEmojiPicker`/`showGifPicker` disappear — picker visibility is pure view state; the server keeps zero semantics. `emoji-open`/`picker-open` CSS becomes `[data-picker]` selectors; CombinedPicker tab switch becomes a client-side flip (both panes already stay mounted).
- Delete the `@onfocus`/`@onblur` round trips — their jobs were picker dismiss (now JS) and the mobile `input-focused` class (JS data-attribute; small JS touch on send preserves the "reveal upload button after send" behavior).
- **Companions that pay off either way:** `loading="lazy"` on picker-cell `<img>`s (kills the 1000-fetch burst; lazy images inside `display:none` don't load, keeping the hidden mount cheap) and `content-visibility: auto` + `contain-intrinsic-size` on `.emoji-section` (offscreen sections cost ~nothing).
- **Data freshness:** today each open remounts the component (fresh `frozenRecents`, GIF recents, trending). Always-mounted needs a fire-and-forget JSInvokable "picker opened" hook refreshing those *behind* the instantly-open UI — and lets GifPicker defer its trending fetch to first open instead of paying a Klipy call per page load.

Costs: picker markup ships in a background batch on each room↔DM page swap (off critical path); a click in the first ~1s can beat the background mount (CSS skeleton shell covers it, or a belt-and-braces "ensure mounted" invoke). Minimal fallback if this feels too big: just `loading="lazy"` + `content-visibility` — halves the pain, keeps the RTT.

## 4. Selecting emojis — done; search is the gap

Insertion is instant; `RecordEmojiUsed` is render-free fire-and-forget. But **picker search** is `@bind oninput`: one dispatch + full grid re-render per keystroke, results one RTT later.

Two tiers: **(a)** debounce with GifPicker's `_debounceCts` pattern (~5 lines, results still RTT-gated); **(b)** client-side filtering — cells already carry `data-emoji`; add a `data-kw` keywords attribute (~30–50KB riding the background mount) and let JS hide/show cells in place, hiding emptied sections. Zero round trips, instant results, composes with the always-mounted picker (server search would re-render the mounted grid). Custom emojis: shortcode as keyword. With (b), the emoji picker is 100% round-trip-free after mount; the shared reaction-mode picker inherits the fast search.

## 5. Selecting GIFs — one RTT of dead air

Tapping a GIF card: Blazor `@onclick` → RTT → server bookkeeping (fast — normalization backgrounded, `GifService.cs:322-370`) → `HandleGifSelected` closes picker + sends → render batch. **Nothing happens on screen until the batch returns** (~1s on the slow client), then everything jumps at once.

**Proposal:** capture-phase listener on `.gif-card` clicks (guard `!closest('.gif-fav-btn')`) that immediately (1) hides the picker client-side and (2) appends an **optimistic GIF ghost** to `.pending-echoes` — a `.pending-message` div containing an `<img>` built from the clicked card's own preview `src` + aspect-ratio (DOM-sourced, `createElement`, XSS-safe). The existing reconciler needs **zero changes** (FIFO removal on own `.message-group` arrival, 15s self-expiry, `clearPendingEchoes` on channel switch, `scrollToBottom` waits for late images). Tap → picker gone, GIF visible; the real message swaps in flicker-free one RTT later.

→ Detailed plan: removed; see `git show 9870997:docs/gif-select-instant-feedback-plan.md`.

## Deliberately parked

- **Reactions optimistic toggle** — aggregated pills make reconciliation fiddly; `:active` press feedback already acknowledges the tap. Revisit after the above.
- **Reaction picker opening** (per-message mount) — a single shared pre-mounted picker is a bigger refactor; client-side search (4b) already helps it.
- **O(N) re-render on receive** (memoize emoji HTML, `ShouldRender`, list trim) and **transport forcing / unacked-batch tuning** — render-cost items, not input-locality items.

## Implementation order

| # | Change | Effort | Perceived win |
|---|--------|--------|---------------|
| 1 | GIF select: instant close + GIF ghost | Small (JS only) | Large — worst "dead air" today |
| 2 | Pickers mounted-hidden + client open/close (+ lazy imgs, content-visibility, open-hook) | Medium | Large — slowest interaction today |
| 3 | Typing → change-granularity bind + JS typing tracker | Small–medium | Medium visible, large structural (kills batch-per-keystroke stalls) |
| 4 | Emoji search client-side (debounce as stopgap) | Small (a) / Medium (b) | Medium |

All four keep the doctrine intact: server stays source of truth with authoritative guards, JS owns only view state and optimistic previews, telemetry keeps measuring the true round trip, and every pattern used (capture-phase hook, data-attributes vs interpolated classes, synthetic-change-before-click, ghost + reconciler) already ships somewhere in this codebase. Items 1 and 4a are safe standalone bites; 2 wants a careful pass over the close-rule inventory (focus, send, backdrop, layout flip, GIF selected) currently spread across five server-side spots.
