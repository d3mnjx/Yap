---
id: C1-56
title: Ask IndexedDB for relaxed durability on writes and resolve reads at the request's success
category: 1
journey: all
effort: S
confidence: low
behaviour-change: none
estimated-gain: Unknown, needs measurement. Where a browser's default durability waits for the disk flush, every outbox write and snapshot write holds its transaction until the flush; `relaxed` drops that wait. Reads resolve one event later than needed today (at `complete` instead of `success`), a sub-ms to few-ms saving per read on the boot path (three reads before the paint, see client-core-07).
experiment: none
sources: [client-core-21]
files: [Yap/wwwroot/js/offline/db.js:27-44]
---

## What the code does now
`db.js:27-39` opens every transaction with the default options and resolves on `complete`:

```js
const tx = db.transaction(store, mode);
const req = fn(tx.objectStore(store));
tx.oncomplete = () => resolve(req ? req.result : true);
```

The file's own rule (db.js:3): "storage is a convenience, never a dependency". The offline doctrine (offline-best-effort-principle) accepts a lost queued message now and then.

## Why it costs the user time
- Writes: the default durability differs per browser; where it is strict, a `readwrite` commit waits for the data to reach the disk. The sender awaits one such commit on the send path today (client-core-09), and the snapshot writes hold a transaction on the database that a following read (the next open) may queue behind.
- Reads: the value is ready at the request's `success` event; `complete` follows after the transaction finishes. The boot path has three reads in series.

## The change
```js
const tx = db.transaction(store, mode, mode === 'readwrite' ? { durability: 'relaxed' } : undefined);
const req = fn(tx.objectStore(store));
if (mode === 'readonly' && req) req.onsuccess = () => resolve(req.result);
tx.oncomplete = () => resolve(req ? req.result : true);
```

Browsers that do not know the option ignore the third argument.

## Risks and what could break
- A power loss right after a relaxed commit can lose the last outbox row or snapshot; both are best effort by design.
- A second `resolve` is a no-op, so the `complete` handler can stay as the fallback.

## How to measure it
On a phone, time `db.put` of a 50-row tail and `db.get` of the bootstrap with and without the change (a small test page or marks in the Settings debug card), in Safari and Chrome. Firefox is the browser most likely to show a difference for writes.