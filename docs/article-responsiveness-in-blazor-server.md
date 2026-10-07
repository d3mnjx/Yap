# Your Fingers Never Wait for the Circuit

### How we made a Blazor Server chat app fast on a 900 ms connection

Blazor Server has a property that most tutorials do not make clear: each UI interaction is a network round trip. When you click a button, the click goes to the server. When you type a character into a bound input, the keystroke goes to the server. When you open a dropdown, the request goes to the server. On localhost, you do not see the delay. For a real user on a phone, behind carrier NAT, three countries away from your server, the delay is the full user experience.

We operate [Yap](https://github.com/urza/Yap), a small self-hosted chat application built with Blazor Server (.NET 10). It has rooms, direct messages, reactions, GIFs, emoji, and push notifications. The app was fast in tests. In production, it was slow for exactly the users a chat app exists for: people far from the server, on bad connections. Text input was slow. The send button became active a moment after the user started to type. Sent messages appeared after a delay long enough to cause a second tap. The emoji picker opened after approximately one second.

This article tells how we corrected this and kept Blazor Server. It gives the small set of patterns that came out of the work. Real users in production have validated these patterns. The primary rule:

> The user's fingers never wait for the circuit. Feedback that the user watches during an action comes from local state (CSS or JS). The client reconciles that state with the server after the action. The server stays the source of truth.

## Measure before you optimize: the wire is the problem

Our first idea was the usual one: profile the server. We instrumented the send pipeline from end to end. We also added a client-side RTT probe that times a no-op circuit call every 10 seconds:

```js
const ping = () => {
    const t0 = performance.now();
    telemetryRef.invokeMethodAsync('ProbePing', lastRtt, visible, idleSeconds)
        .then(() => { lastRtt = Math.round(performance.now() - t0); });
};
```

The probe measures the full round trip that the user gets: the transport plus the Blazor dispatcher queue. This is the latency that the user feels, not the ping that ICMP reports.

The numbers gave a clear answer:

| | Worst case measured in prod |
|---|---|
| Server work per message send (incl. SQLite persist) | **≤ 71 ms** |
| Circuit round trip for our remote users | **~904 ms** |

The server was fast. The wire cost 13 times more than the server, and the wire is the one thing we do not control. Each possible server-side optimization could only decrease 7 percent of the problem. The correction had to be architectural: remove the round trip from the perceived-feedback path.

One more effect made it worse. SignalR processes circuit messages in sequence, and Blazor sets a limit on unacknowledged batches. On a slow link, per-keystroke traffic does not only add delay. It makes a queue, and all messages behind it wait, which includes your message send. Each dispatch that you remove helps each dispatch that stays.

## The doctrine

There is a risk of too much correction here: you remove the Blazor model and build half of the app again in JavaScript. At that point, Blazor Server gives you no advantage. We wanted a narrower rule. After we applied it across the full main chat loop, the rule holds:

- Feedback that the user watches during an action is local, by default. This includes button enablement, keystroke effects, picker open and close, search while the user types, and the user's own sent message. All of these are client-side and immediate. The client reconciles them with the server after the action.
- The server stays the source of truth. State, validation, guards, persistence, and fan-out to other users stay on the server. Optimistic UI reconciles to the server decision. Local state must not lie about permissions or results.
- Do not fight Blazor. The client layer is thin: CSS selectors, `data-*` attributes, a few event listeners. Components, binding, services, and events stay idiomatic Blazor. If the local version becomes a state machine that fights the framework, examine the design again.

The five patterns below apply this rule. The code is the shipped code.

## Pattern 1: CSS state from the input value

The send button must look enabled exactly when the textarea has content. The usual Blazor method binds the input and computes `disabled` from the bound value. That method renders the button again one round trip after each keystroke. On our slow link, the button was visibly late behind the user's keys.

The correction has zero lines of C# and zero lines of JS. The DOM knows if the textarea is empty. CSS can react to the value itself with `:placeholder-shown`:

```css
/* Client-side visibility, no circuit round trip: the button collapses while
   the box is empty AND no picker is open. :placeholder-shown reacts to the
   value itself; data-picker is the client-owned picker state (Pattern 5). */
.message-input-container:not([data-picker]):has(.message-input:placeholder-shown) .send-button {
    flex-basis: 0;
    width: 0;
    margin-left: 0;
    transform: scale(0);
}

/* Picker open over an empty box: visible but dimmed. Nothing to send yet. */
.message-input-container[data-picker]:has(.message-input:placeholder-shown) .send-button {
    background: var(--bg-muted);
    opacity: 0.5;
    cursor: not-allowed;
}
```

The button is gone when the box is empty. It grows in at the first character, at monitor refresh rate. The first version of this rule only dimmed the button. It now collapses it, Discord style, and dims it only when a picker is open over an empty box, because users wanted to see the button while they browse emojis. The collapse uses `width: 0` and `scale(0)` instead of `display: none`, so the width animates and the Enter handler (Pattern 2) keeps a live target to click. There is one requirement: the placeholder must not be an empty string. If there is no placeholder, `:placeholder-shown` never matches.

The search box of our emoji picker uses the same method. The clear button (✕) shows only while a query exists. Again `:placeholder-shown`, again no round trip.

This is the least expensive pattern in the set, and the lesson applies widely. Before you add component state, ask if the DOM already knows.

## Pattern 2: Client-routed events

Enter-to-send is timing-critical. In Blazor, `@onkeydown:preventDefault` makes its decision on the server. The decision to block a newline thus takes a full round trip. The newline is in the textarea long before the answer arrives. Also, a subscription to `@onkeydown` sends each keystroke to the server.

Instead, the key handling lives on the client, and the send goes through the existing button:

```js
textarea._enterKeyHandler = (e) => {
    // Desktop: Enter sends, Shift+Enter newline. Touch: Enter is newline.
    if (e.key !== 'Enter' || e.shiftKey || isTouch) return;
    // An IME commit also arrives as Enter — sending would eat the composed text.
    if (e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    if (!textarea.value.trim()) return;
    textarea.closest('.message-input-container')
        ?.querySelector('.send-button')?.click();
};
```

The last line is the important one. We do not invoke a .NET method from JS. We click the send button. The button's `@onclick="HandleSend"` stays the single server entry point, for a click and for the Enter key. There is exactly one code path into the server, and it is idiomatic Blazor. All the client-side immediate feedback (the next two patterns) connects to that one physical click.

## Pattern 3: Bind at change granularity, and commit before the click

The default Blazor pattern for an input costs one circuit dispatch per keystroke. This applies to `@bind-Value` with `@oninput` granularity, and to an `@onkeydown` handler. On a 900 ms link, a 20-character message makes a queue of 20 server events. All other traffic waits behind them.

Thus the message box binds at change granularity: plain `@bind`, which syncs on the `change` event, normally on blur:

```razor
<textarea @bind="messageText" placeholder="@placeholder" class="message-input"
          rows="1" id="@TextareaId"></textarea>
```

Text input now costs zero circuit dispatches. Only the typing indicator needs the server in the middle of a burst, because other users see it. A small JS tracker calls the server approximately two times per burst: at the start, and at the stop after 3 seconds without input. It does not call on each key:

```js
textarea._typingInputHandler = () => {
    if (!textarea.value.trim()) { stop(); return; }
    if (!typing) {
        typing = true;
        dotNetRef.invokeMethodAsync('ReportTypingStarted');
    }
    clearTimeout(timer);
    timer = setTimeout(stop, 3000);   // stop() reports ReportTypingStopped
};
```

But change granularity makes a problem. When the user sends, the server's `messageText` can be stale. No blur occurred, thus the client did not commit the draft. The solution uses a guarantee that Blazor gives you: the circuit processes messages in sequence. A capture-phase listener on the send button dispatches a synthetic `change` event, which commits the full draft, immediately before the RPC of the click:

```js
// Capture phase: runs before Blazor's delegated @onclick.
document.addEventListener('click', (e) => {
    const btn = e.target.closest('.send-button');
    if (!btn) return;
    const textarea = btn.closest('.message-input-container')
        ?.querySelector('.message-input');
    if (!textarea?.value.trim()) return;

    // Commit the draft BEFORE the click's RPC. In-order circuit processing
    // lands the change ahead of the click, so HandleSend reads fresh text.
    textarea.dispatchEvent(new Event('change', { bubbles: true }));

    showPendingEcho(textarea.value);   // Pattern 4

    // Instant clear — the draft above was already committed.
    textarea.value = '';
}, true);
```

The result is two dispatches per send (change, then click) and zero per keystroke. `HandleSend` keeps its authoritative guard:

```csharp
private async Task HandleSend()
{
    if (string.IsNullOrWhiteSpace(messageText) || !channelId.HasValue) return;
    // ...validation, persistence, broadcast — all server-side, all authoritative
}
```

Note what the pattern does not do. It does not take message state away from Blazor. `messageText` stays the bound field, and `HandleSend` still validates it. We only changed when the value syncs, and we used the event sequence to make the late sync correct.

## Pattern 4: Optimistic echo with reconciliation

The send itself had the largest perceived latency. The user tapped send, then saw no change for a full round trip, until the message rendered. Users sent messages two times, because the app gave no signal that the tap worked.

The correction is a ghost. When the user clicks the send button, the same capture listener as above adds a dim, plain-text copy of the message at the bottom of the list. The real message replaces it one round trip later:

```js
const showPendingEcho = (text) => {
    const ghost = document.createElement('div');
    ghost.className = 'pending-message';
    ghost.textContent = text;          // textContent only — never parsed as HTML
    appendPendingEcho(ghost);
};

const appendPendingEcho = (ghost) => {
    document.querySelector('.pending-echoes')?.appendChild(ghost);
    setTimeout(() => ghost.remove(), 15000);  // a send that never echoes fades out
    watchForEchoConfirm();
};
```

Reconciliation is a `MutationObserver` that watches the message list. When one of the sender's own messages renders, the observer removes the oldest ghost. The sequence is FIFO, thus many sends inside a single round trip all drain correctly. `MutationObserver` callbacks run before paint, thus the swap from ghost to real message shows no flicker:

```js
const flow = document.querySelector('.messages-flow');
echoObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations)
        for (const node of mutation.addedNodes) {
            if (node.nodeType !== 1 || !node.matches?.('.message-group')) continue;
            if (!currentUser || node.dataset.author !== currentUser) continue;
            document.querySelector('.pending-echoes .pending-message')?.remove();
        }
});
echoObserver.observe(flow, { childList: true });
```

One detail cost us an afternoon. The observer watches direct children only, no `subtree`. So it must bind to the element that directly contains the message nodes. When a wrapper was added inside the list for the theme pattern layer, the observer still bound to the outer list and went blind. Ghosts lingered to the 15 second timeout next to the real message. Bind to the element that holds the children, and re-bind when navigation replaces it.

The failure mode is honest by construction. If the send never echoes (the circuit dropped, or the server rejected the message), the ghost disappears after 15 seconds. The ghost that disappeared is the signal that the message did not send. No false message entered the authoritative message list.

Where does the ghost live? That is the load-bearing detail. See the coexistence rules below:

```razor
@* RoomChat.razor / DmChat.razor — Blazor renders the ghost container, always empty *@
<div class="messages">
    <div class="messages-flow">
        @foreach (var message in messages) { ... }
        <div class="messages-spacer"></div>
        <div class="pending-echoes"></div>
    </div>
</div>
```

The same machinery applies to GIFs. When the user taps a card in the GIF picker, the picker closes immediately (Pattern 5), and the ghost shows the same preview the user looked at. That preview is already in the browser cache, thus it paints in the same frame. The card's inline `aspect-ratio` copies over, thus the list does not jump when the real message arrives. Before this change, the user tapped a GIF and then waited through the full round trip. Now the selection feels immediate.

## Pattern 5: Client-owned UI state in `data-*` attributes

Before, the emoji picker opened in these steps: click, round trip, the server flips `showEmojiPicker`, a render mounts a large component tree, the picker appears. On the bad link, this took approximately one second, for pure local UI state. The server has no reason to know if your picker is open.

Now the pickers mount one time and stay hidden. Open and close are an attribute flip that never leaves the browser:

```js
document.addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-picker-toggle]');
    if (!toggle) return;
    const container = toggle.closest('.message-input-container');
    const which = toggle.dataset.pickerToggle;          // "emoji" | "gif"
    if (container.dataset.picker === which)
        container.removeAttribute('data-picker');
    else
        container.dataset.picker = which;               // also swaps picker→picker
});
```

```css
.emoji-picker-container[data-picker-pane] { display: none; }

.message-input-container[data-picker="gif"]   [data-picker-pane="gif"],
.message-input-container[data-picker="emoji"] [data-picker-pane="emoji"] {
    display: flex;   /* opening costs one attribute flip, zero round trips */
}
```

Blazor renders the picker content. The client owns the picker visibility. The same idea covers "is the user composing" (`data-composing`, flipped on focusin and focusout; the mobile CSS trades the upload button for textarea width) and the active tab of the mobile picker (`data-active-tab`).

Two more parts make the always-mounted picker possible.

The first part is a render firewall. `MessageInput` renders again constantly (typing indicators, the reply bar, upload progress), and each render would diff the large hidden picker subtrees again. A small wrapper component blocks exactly those parent-cascade renders:

```razor
@* PickerPane.razor — ShouldRender=false blocks parent cascades; the pickers'
   own interactions still render, because Blazor renders from the component
   that handled the event, not from the root. *@
@ChildContent

@code {
    [Parameter] public RenderFragment? ChildContent { get; set; }
    protected override bool ShouldRender() => false;
}
```

The second part is client-side search. With the grid always mounted, emoji search does not send a query to the server for a new render. It becomes an in-place filter. Each emoji cell has a prerendered lowercase `data-kw` keyword string, and JS toggles attributes that Blazor never renders. Thus a Blazor render cannot overwrite the filter state:

```js
const filterEmojiPicker = (picker, rawQuery) => {
    const q = (rawQuery || '').trim().toLowerCase();
    picker.querySelectorAll('.emoji-section').forEach(section => {
        let hits = 0;
        section.querySelectorAll('.emoji-btn[data-emoji]').forEach(btn => {
            const hit = !q || (btn.dataset.kw || '').includes(q);
            btn.toggleAttribute('data-search-miss', !hit);
            if (hit) hits++;
        });
        section.toggleAttribute('data-search-empty', hits === 0);
    });
};
```

The result is search while the user types, across approximately 900 emoji, at keystroke speed, on any connection. One more detail is important. Picker cells render with `loading="lazy"`, and `display: none` plus lazy images means the hidden pickers download zero images until the first open. Thus the always-mounted pickers have no image cost before the user opens them.

Blazor still does what Blazor does well here. The recent-emoji lists refresh behind the open picker, through a small `[JSInvokable]` open hook. The data arrives one round trip after the picker opened. It does not delay the open.

This pattern has many parts: the render firewall, the open hook, and the race between a fast tap and the mount. Thus it has its own article: [The Mounted-Hidden Picker Pattern](article-mounted-hidden-picker-pattern.md).

## The rules of coexistence

JS and Blazor share one DOM. This is where the approach stays clean or decays. Each bug we hit came from a violation of one of four rules:

1. JS-owned DOM lives in containers that Blazor renders empty. The ghosts go in `<div class="pending-echoes"></div>`. Blazor diffs it as an empty, unchanged div on each render, thus Blazor never touches the JS-appended children. If JS inserts elements between Blazor-rendered siblings, the next diff destroys or duplicates them.
2. If JS toggles an attribute, the Blazor side of that attribute must be static. `class="messages @someFlag"` interpolates again on each render and overwrites what JS set. Our rule: Blazor owns `class`, and JS owns the `data-*` state attributes, plus attributes on elements that Blazor made but never updates.
3. The capture phase runs before Blazor. Blazor delegates its event handlers at the root, in the bubble phase. A capture-phase listener always runs first. This lets the send listener paint the ghost and clear the input while the browser serializes the click RPC. The Blazor handler still fires after it. You add behavior before Blazor. You do not replace it.
4. In-sequence circuit processing is an API that you can trust. Dispatch a `change` before a `click`, and the server processes them in that sequence, always. The commit-before-click handshake in Pattern 3 is correct only because of this guarantee.

One more rule: continue to measure the truth. The send-to-appear telemetry (a `MutationObserver` that times the real message render against the click) reported the honest ~900 ms round trip through all of this. The perceived latency improved because the feedback became local. The telemetry makes sure that the good feeling does not hide a real link problem.

## What stayed on the server

We deliberately did not change these, because a visible round trip there is honest:

- Settings saves, admin actions, and channel management. The user expects a save to take a moment. Optimistic UI would add risk and no felt speed.
- All state where an optimistic value could lie in a way that matters: permissions, moderation, account state.
- All validation and guards. `HandleSend` still checks for empty text, channel membership, and write permissions. If a hand-made request goes around the client behavior, only the server verdict counts.

## Results

Each interaction in the main chat loop now occurs at local speed, on a connection where each round trip costs approximately 900 ms. This includes text input, send feedback, the message echo, picker open and close, tab switches, emoji search, category jumps, and GIF selection. Before, one message caused tens of dispatches (keystrokes, picker state, key handling). Now it causes approximately three: typing-started, the draft commit, and the send click.

The app has run in production with real users on truly bad connections: the first round of corrections for weeks, the full set for days. The verdict from the field is what you would hope. Users say the app stopped feeling like a remote terminal and started feeling like a chat app.

If you operate Blazor Server with users outside your LAN, keep these points:

1. Measure the split first. Our server work was ≤ 71 ms. The wire was ~904 ms. Know your numbers before you optimize the wrong side.
2. The user's fingers never wait for the circuit. Feedback that the user watches during an action comes from local state, and reconciles with the server afterward.
3. Increase complexity only in small steps. Start with CSS that reacts to values (`:placeholder-shown`). Then route client events into one Blazor entry point. Then bind at change granularity, with a commit before the click. Then add optimistic ghosts with observer reconciliation. Then put client-owned UI state in `data-*` attributes.
4. Obey the coexistence rules. Keep JS-owned DOM in containers that Blazor renders empty. Keep the Blazor side static where JS toggles an attribute. Use the capture phase to run before Blazor. Trust the in-sequence processing to stay correct.
5. Do not fight Blazor. State, truth, validation, and fan-out stay on the server. If your JS grows a state machine, you went too far.

The Blazor Server programming model is a real pleasure: one language, no API layer, real-time updates included. But you must respect the one thing it cannot remove: the speed of light, plus the queue. Keep the wire out of the feedback path, and the model is worth its cost, even at 900 ms.

---

*Yap is open source. The patterns above live mostly in [`chat.js`](https://github.com/urza/Yap/blob/main/Yap/wwwroot/js/chat.js), [`MessageInput.razor`](https://github.com/urza/Yap/blob/main/Yap/Components/MessageInput.razor), and the components' scoped CSS.*
