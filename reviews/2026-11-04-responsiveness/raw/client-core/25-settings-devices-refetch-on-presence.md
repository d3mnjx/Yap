---
id: client-core-25
title: Stop refetching the device list on every presence change while Settings is open
area: client-core
journey: all
category-guess: 3
behaviour-change: The Active Sessions list on Settings would update when the person's own presence changes or when the page is shown again, not 500 ms after anyone's presence changes.
effort: S
estimated-gain: One `GET /api/account/devices` and a rebuild of the device list per presence pause while Settings is open. On a busy server presence batches arrive every 250 ms (the broadcaster's tick), so the request repeats roughly every 0.5 to a few seconds for as long as the page is open. On the far link each is a round trip that competes with the person's own saves (`PATCH /api/account`).
confidence: high
files: [Yap/wwwroot/js/pages/settings.js:177-210, Yap/wwwroot/js/store.js:304-312]
---

## What the code does now
`settings.js:210`:

```js
offs.push(on('presence', () => { clearTimeout(timers.devices); timers.devices = setTimeout(drawDevices, 500); }));
```

`drawDevices` (settings.js:180-198) fetches `/api/account/devices?device=...` and rebuilds the list. `setPresences` (store.js:307-312) fires `presence` with `{ changes: list }` for any person's change.

## Why it costs the user time
The trigger is anyone's presence, but the list shows only this person's devices. On a server with many people the page polls the server in a loop while the person edits their profile; on the far link those requests share the link with the profile saves, which the person waits for ("Saving..." chip).

## The change
Filter the trigger to the person's own presence:

```js
offs.push(on('presence', d => {
  if (!d?.changes?.some(c => c.username === state.user?.username)) return;
  clearTimeout(timers.devices); timers.devices = setTimeout(drawDevices, 500);
}));
```

and redraw on `visibilitychange` to visible, as the push card already does (settings.js:303). A second device that connects while the person is already online does not change the person's presence, so the list would show it at the next visibility change or Settings visit; that is the behaviour change.

## Risks and what could break
- The sessions list is less live. If live matters, a dedicated hub message (`devices`) when the person's own sessions change is the exact trigger (server work).

## How to measure it
Open Settings on the load-test server with presence churn and count `/api/account/devices` requests per minute (today many, after the change about none).
