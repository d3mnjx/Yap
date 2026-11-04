---
id: client-render-07
title: Move the upload progress bar in place instead of rebuilding every pending row per progress event
area: client-render
journey: upload
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: Every upload progress callback now removes and rebuilds all pending rows and schedules a scroll with a forced layout. An upload of 3 MB at 1 Mbit/s takes about 24 s; at several progress events a second that is hundreds of row rebuilds and layouts during the upload. After the change, one style write per event. Exact event rate unknown (it depends on tus-js-client and the browser).
confidence: high
files: [Yap/wwwroot/js/sender.js:148-152, Yap/wwwroot/js/ui/timeline.js:178-185, Yap/wwwroot/js/ui/message.js:297-308]
---

## What the code does now
The upload callback changes the row and fires `pending` for every progress report (`sender.js:148-152`):

```js
live.job = upload.upload(row.files, ..., (percent, done, total) => {
  live.lastProgressAt = Date.now();
  row.uploading = { ...row.uploading, percent, label: `${done}/${total}` };
  changed('pending');
}, ...);
```

The timeline answers every `pending` change by removing all pending nodes and drawing them again (`timeline.js:179-184`):

```js
pendingNodes.forEach(n => n.remove()); pendingNodes = [];
for (const m of state.pending) { flow.append(makeRow(m, prev)); prev = m; }
...
else keepPlace();
```

`keepPlace()` schedules `scrollToBottom()` while following: a frame callback that reads `scrollHeight` and walks every `<img>` in the list (`timeline.js:268-280`). A voice message row also builds a new canvas and a new `ResizeObserver` on each rebuild (`voice.js:50-77`).

## Why it costs the user time
The person often types or scrolls while an upload runs. Each progress event costs a row clone (84 nodes), its content, a layout and a walk over all images. On a slow uplink the upload runs for tens of seconds, so this repeats hundreds of times and competes with typing and scrolling. Who pays: people who send pictures, videos or voice messages, most on phones on slow links.

## The change
- In `sender.js`, fire the progress with a detail: `changed('pending', { type: 'progress', row })`.
- In `timeline.js`, in `onPending`: when `detail?.type === 'progress'`, find the node of that row (keep a `Map` from the pending row object, or its `clientId`, to its node instead of the plain array) and set `.upload-progress-fill` width to `${row.uploading.percent}%`; return without a rebuild and without `keepPlace()` (the bar does not change the row's height).
- All other `pending` changes keep the full rebuild.

About 15 lines in two files.

## Risks and what could break
The timeline is the only listener of the store's `pending` part (`timeline.js:506`; `hub.js:54` is a hub event of the same name for registrations, not the store part). The row's label (`done/total`) is not drawn today (`message.js:302-303` draws names and percent only), so only the width needs the update.

## How to measure it
Send a 5 MB picture on a throttled link (Chrome DevTools, slow 3G or the `npm run load` link) and record a performance profile. Count `renderRow` calls during the upload and the scripting time per second. Also type in the composer during the upload and look at input delay.
