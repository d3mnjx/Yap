# Emoji warm-up: implementation plan

Written 2026-11-04. Status: set aside the same day, nothing is built. The empty box is covered since
2026-11-04 by the device's own emoji, drawn after one second in place of an image that is still on its
way (`render/text.js` emojiImage, app.css `.emoji-slot`, MR-15). That covers every emoji, the phone
keyboard's included, at no network cost. Revisit this plan only if the shared picture without a
connection matters for the listed emoji. The code facts below come from a read of the code on this
date, at commit 9d7d8b63.

## 1. The goal

Some seconds after Yap connects, the page fetches every emoji image of the picker's list in the
background. The worker's emoji cache then holds them. A person never waits for this work. After
it, an emoji from the list shows at once in a message, also without a connection.

Why: on 2026-11-03 the user opened the installed app on the iPhone. A message showed an empty box
for a few moments where an emoji belonged. That emoji was new to the device. The cache had no entry,
so the row waited for the CDN. Today the cache fills only by use: a row, a reaction, a name or a
picker cell asks for an image, and the worker stores the answer (`.claude-memory/static-asset-caching.md`).

## 2. Decisions taken

The user asked for a non-blocking background job that starts after a small delay. The choices below
are mine. Each one names the alternative.

1. **The scope is the picker's list.** That is 907 unique Unicode emoji, the 10 category icons and
   the Recent icon, then the packs the bootstrap names (today one pack, `wechat`, 75 files, plus the
   server's custom emoji folder, empty in the repo). The full Twemoji set has about 3,700 files and
   stays out. An emoji typed from the phone keyboard outside the list stays cold on its first sight
   and is stored by use. The alternative is the full set. It needs a list source (the Unicode emoji
   table or the CDN's file index) and about four times the requests.
2. **The warm-up runs in every browser.** The whole list is under 2 MB once per browser profile.
   The alternative is the installed app only, with `installed()` from `push.js`.
3. **It starts 20 seconds after the first sync.** It fetches 6 images at a time and pauses 100 ms
   between batches. The numbers are constants at the top of the module.
4. **The page runs it, not the worker.** iOS stops an idle worker within seconds. A job the worker
   starts by itself has no event to keep it alive. The worker cannot import the list module. The
   page is alive exactly when the result is useful.
5. **The page fetches and the worker stores.** The page calls `fetch(url)` with the same URL a row
   uses. The worker's existing `cacheFirst` stores the answer. The page never writes the cache
   itself. This keeps the rule of 2026-10-31: an image has one URL, one cache and one path.
6. **A page without network signals runs anyway.** iOS has no Save-Data or connection-type
   signal. Only Chrome on Android reports them, and the warm-up honours them there.

## 3. Facts the design rests on

- The worker routes a CDN request by `request.destination`. An `<img>` (destination `image`) goes
  through `rememberedFirst`, the worker's memory of up to 1000 answers. A page `fetch()` has an
  empty destination and goes through `cacheFirst(request, EMOJI_CACHE)`, which reads the cache and
  on a miss fetches and stores a `200` (`service-worker.js:54`, `:92-104`). So the warm-up fills the
  cache and leaves the rows' memory alone.
- Same-origin emoji paths (`/emoji-fallback/`, `/emoji-packs/`, `/custom-emojis/`) go through
  `rememberedFirst` whatever the destination (`service-worker.js:68`). Their bodies stay in the
  worker's memory. Today that is 8 override PNGs (181 KB) and 75 pack PNGs (471 KB). The memory
  clears itself at 1000 entries (`service-worker.js:121-124`).
- The CDN answers with `access-control-allow-origin: *`, `cache-control: immutable` and
  `vary: Accept-Encoding` only (curl on 2026-11-03). The cache matches by URL and by the `Vary`
  headers. A page fetch and an `<img crossorigin="anonymous">` send the same `Origin`, and neither
  carries `Accept-Encoding` in its `Request` object. So an entry the warm-up stored answers a later
  row image.
- The Twemoji files are SVGs. Samples measure 0.4 to 2.4 KB raw, about half on the wire. The list
  is under 1 MB raw.
- `emojiUrl(emoji)` builds the URL a row uses. It is private to `render/text.js` (`:82-87`). It
  returns null before the bootstrap rules arrive. The rules reach the page as
  `state.emojiImages` with the fields `twemojiBase`, `overridesBase`, `overrides`, `packs` and
  `stamp` (`EmojiImages.cs:59-63`, camelCase). The stamp is a hash of the bases, the overrides and
  the packs (`EmojiImages.cs:49`).
- The list module `js/data/emoji-list.js` (44 KB) exports `categories` and `keywords`. The picker
  imports it on its first open (`emoji-picker.js:31`). It is in the import map and in the worker's
  precache list, but not in the modulepreload links (`ShellAssets.cs:31-34`). Every other module
  under `js/` gets a modulepreload link.
- `hub.firstSync()` is a promise. It settles after the first successful connect applied its
  bootstrap, or when the first connect attempt failed (`hub.js:74-79`). It does not settle while
  the device is offline at the first attempt; it settles at the first connect that succeeds.
- `hub.onConnected(fn)` hooks run on every connect, reconnects included, with no argument. A slow
  hook delays the bootstrap apply, and a hook that throws aborts it (`hub.js:92-122`). The
  warm-up does not use this hook.
- `store.on('connection', fn)` fires when `state.connection` changes between `connecting`,
  `connected`, `reconnecting`, `offline` and `signedOut` (`store.js:6`, `:60-64`).
- The worker calls `skipWaiting()` at install and `clients.claim()` at activate
  (`service-worker.js:38`, `:44`). A first-ever page load starts uncontrolled and becomes
  controlled when activate finishes. A fetch sent before that bypasses the worker.
- The resource timing buffer holds 1000 entries (`main.js:24`). The debug card's emoji timings
  count `initiatorType === 'img'` entries of the first 3 seconds only (`settings-debug.js:115-124`).
  The card calls an entry "from cache" when `transferSize === 0` (`settings-debug.js:132`).
- The DEBUG INFO card lists each cache by group with a count and a size
  (`settings-debug.js:15-48`, markup at `index.html:1177-1183`).
- Device storage keys use the `yap.` prefix, a module constant and a try/catch around every
  access (`router.js:68-69`, `push.js:118-119`).
- The spec lint bans the words `worker`, `shell`, `hub`, `API`, `timer`, `bootstrap`, `poll`,
  `DOM`, `CSS`, `IndexedDB` and `localStorage` in a rule unless the line carries
  `<!-- lint: allow -->` (`docs/spec/tools/lint.py:21-28`).

## 4. The design

### 4.1 The module and its start

A new module `wwwroot/js/emoji-warmup.js` holds the whole feature. It exports `start()` and
`status()`. Its import runs no code. `main.js` loads it late:

```js
// main.js, at the end of start(): the emoji warm-up (OF-19) loads and starts 20 s after the first sync, so the
// boot pays nothing for it and a slow connection has its rows first.
hub.firstSync().then(() => setTimeout(() => import('./emoji-warmup.js').then(m => m.start()).catch(() => {}), 20_000));
```

The delay counts from the first sync, not from the page load. On a slow link the boot takes longer,
so the warm-up waits longer by itself.

The ShellAssets scan gives the new module a modulepreload link, like every module under `js/`
outside `js/data/`. The link fetches and compiles about 3 KB from the shell cache at each start and
runs nothing. I accept that. If the boot report shows a change, the preload exclusion in
`ShellAssets.cs:34` can take a second path.

`start()` runs these checks in order and returns when one fails:

1. `running` is true: a second call does nothing.
2. `navigator.serviceWorker` is missing: the browser has no worker, so there is no cache. The
   phase stays `off`.
3. `navigator.serviceWorker.controller` is null: this is a first-ever load. The module waits for
   one `controllerchange` event and then calls `start()` again.
4. `state.emojiImages` is null: the rules did not arrive. The module waits for one
   `'emojiImages'` store event and then calls `start()` again.

Then it builds the list, loads the cursor, runs the eviction check and enters the loop.

### 4.2 The list

The module imports `./data/emoji-list.js` with a dynamic import. The import map gives it the build
stamp, and the worker's precache answers it from the device.

```js
const { categories } = await import('./data/emoji-list.js');
const emoji = new Set(['🕐', ...categories.flatMap(c => [c.icon, ...c.emojis])]);
const unicode = [...emoji].map(emojiUrl).filter(Boolean);
const packs = (state.emojiImages.packs ?? []).flatMap(p => p.emojis.map(e => e.url));
urls = [...new Set([...unicode, ...packs])];
```

The order is the picker's order: smileys first, flags last, packs after the Unicode set. A person
picks from the first categories most, so an interrupted run has stored the useful part first.

`emojiUrl` becomes an export of `render/text.js`. Nothing else changes there.

The list has 907 to 918 Unicode URLs (907 emoji, plus the icons that are not already in a category)
and 75 pack URLs today. The module never hardcodes a count; `status()` reports `urls.length`.

### 4.3 The loop

```js
const BATCH = 6;                         // concurrent fetches; the CDN multiplexes them on one HTTP/2 connection
const PAUSE_MS = 100;                    // between batches, so the socket and a person's taps never queue behind it
const RESUME_MS = 5000;                  // after a pause: a reconnect's bootstrap goes first
const BACKOFF_MS = [3000, 10000, 30000]; // after a failed batch, as the row images retry (text.js)

async function run() {
  while (cursor.next < urls.length) {
    await gate();
    const batch = urls.slice(cursor.next, cursor.next + BATCH);
    const results = await Promise.all(batch.map(load));      // 'ok' | 'missing' | 'failed'
    if (results.includes('failed')) {
      failures++;
      if (failures > BACKOFF_MS.length) { phase = 'paused'; await nextConnect(); failures = 0; continue; }
      await sleep(BACKOFF_MS[failures - 1]);
      continue;                                              // the cursor does not move; the ok ones are cache hits next time
    }
    failures = 0;
    cursor.next += batch.length;
    cursor.missing += results.filter(r => r === 'missing').length;
    save();
    await sleep(PAUSE_MS);
  }
  cursor.done = true; save(); phase = 'done';
}

async function load(url) {
  try {
    const response = await fetch(url);
    await response.body?.cancel();                           // the worker kept its copy; the page needs none
    return response.ok ? 'ok' : response.status < 500 ? 'missing' : 'failed';
  } catch { return 'failed'; }                               // the worker answered Response.error(): no network
}
```

The loop follows these rules:

- A batch moves the cursor only when every fetch of it answered `ok` or `missing`. On a failure
  the same batch runs again after the backoff. The images that did arrive are cache hits then.
- A `4xx` answer is permanent: a missing file in the Twemoji release, or a path the CDN refuses.
  It counts as `missing` and the cursor moves on. A `404` on one file must never park the whole
  run. The row's own retry logic (`text.js:104-121`) stays the only handling of it at draw time.
- A `5xx` answer or a network error counts as `failed`. After three failed tries of one batch the
  loop parks. It continues after the next transition to `connected`, which means the network came
  back. A page load also continues from the cursor. The loop never skips a batch, so a dead CDN
  cannot mark the rest of the list as done.
- The estimate on a good link is about 165 batches of about 200 ms, 35 seconds in all. On a phone
  with a 200 ms round trip it is about one minute.

### 4.4 The gate

`gate()` resolves when all of these hold, and waits for the next change otherwise:

- `document.visibilityState === 'visible'`. iOS freezes a hidden page anyway. A hidden desktop tab
  also stops, so a background tab never spends the connection.
- `state.connection === 'connected'` and `navigator.onLine`. A signed-out page never runs.
- `navigator.connection?.saveData !== true` and `effectiveType` does not match `2g`. Chrome on
  Android reports these; iOS reports nothing, and the warm-up runs.

The gate subscribes to `store.on('connection')` and to `visibilitychange`. When it resolves after a
wait, the loop sleeps `RESUME_MS` and checks the gate once more. A reconnect's bootstrap request
goes out first that way.

### 4.5 The cursor

The module keeps one key in localStorage, `yap.emojiWarmup`, as JSON:

```json
{ "set": "<stamp>:<urls.length>", "next": 412, "missing": 2, "done": false }
```

- `set` names the list. A new Twemoji release or a changed override changes the stamp, a changed
  list module changes the length. A different `set` at `start()` resets the cursor to zero.
- `next` is the index of the next URL. The loop saves after every batch. A page that iOS stops in
  the background loses at most one batch.
- Every access sits in a try/catch. Without localStorage (a private window) the run still works
  and restarts at zero on the next open, which costs cache hits only.

The eviction check runs at every `start()`, before the loop. The browser can clear Cache Storage
for the whole origin. The cursor would then say `done` while the cache is empty.

```js
const names = await caches.keys();
const name = names.find(n => n.startsWith('yap-emoji'));            // the worker's emoji cache (service-worker.js)
const present = name && await (await caches.open(name)).match(urls[0]);
if (!present && cursor.next > 0) cursor = fresh();
```

This is three storage calls per open, 20 seconds after the boot. The probe is the first URL of the
list, the smileys' first emoji, which the CDN always has. The cache name is the only place where
the page names a worker cache; the DEBUG INFO card uses the same prefix test.

### 4.6 Two tabs

Two desktop tabs may both run the warm-up. Each one has its own cursor in memory and both save to
the same key. The second tab's fetches are cache hits through the worker. There is no lock.

### 4.7 The DEBUG INFO card

One new row in the cache part of the card (`index.html:1177-1183`):

```html
<div class="notification-row"><span class="notification-label">Emoji warm-up</span><span class="notification-value emoji-warmup"></span></div>
```

`settings-debug.js` imports `status()` from the module and fills the row when the card opens.
The wording is one of:

- `not started` (phase `off`)
- `412 of 993 · running`
- `412 of 993 · paused`
- `993 of 993 · done`
- `993 of 993 · done, 2 missing`

`status()` returns `{ phase, next, total, missing }`. The phase is one of `off`, `running`,
`paused`, `done`. Before `start()` ran, `status()` reads the saved cursor, so a device that finished
the run earlier reads `done` from the first second. The import map gives the module one URL, so the
card and `main.js` share one instance. The card reads the row once, when it opens, like the cache
report; a reopen of the settings page refreshes it.

### 4.8 What does not change

- The rows, the picker and the reactions keep their `<img>` path through `rememberedFirst`.
- `imageFailed` and `retryFailedImages` stay as they are.
- The worker's code does not change. The cache name, the routing and the memory stay.
- The picker still loads nothing while closed (PK-11). The warm-up is not the picker.
- The boot report counts resources up to the first rows, long before the warm-up starts. The card's
  emoji timings count `img` entries of the first 3 seconds only, so the warm-up's fetch entries never
  show there.

## 5. The steps

Each step is one commit, in this order.

1. **Export `emojiUrl` from `render/text.js`.** Add a comment at the function: the warm-up needs
   the URL without an element, and the function stays the single place that knows the two filename
   rules.
2. **Write `wwwroot/js/emoji-warmup.js`,** the module of section 4. The file comment states the
   purpose (OF-19), the three constants with their reasons, and the invariant: the page fetches and
   never writes the cache itself, because a page fetch of the CDN takes `cacheFirst` and leaves the
   worker's memory alone.
3. **Add the one line to `main.js`,** at the end of `start()`.
4. **Add the card row:** the markup in `index.html`, the fill in `settings-debug.js`.
5. **Update the spec and the docs** as section 8 lists them.
6. **Write the test** of section 6.
7. **Build, run, test and clean up** per `CLAUDE.local.md`. Then push.

## 6. The headless test

A new step in `tests/browser/offline.mjs`, after the service worker step. The suite already sets
`PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS`, so `context.route` sees the worker's requests.

1. Route `https://cdn.jsdelivr.net/**` to a stub answer: one small SVG body, `image/svg+xml`,
   `access-control-allow-origin: *`. Count the fulfilled requests. The test then needs no network
   and runs in seconds.
2. Sign in, wait for the controller, then start the run at once:
   `page.evaluate(() => import('/js/emoji-warmup.js').then(m => m.start()))`. The 20 second delay
   lives in `main.js`, so the test does not wait for it. The test's own call runs first, and the
   call from `main.js` returns at once because `running` is true.
3. `waitTrue` until `status().phase === 'done'`.
4. Checks: the `yap-emoji-v2` cache holds at least 900 entries; the stub served about the same
   number; `status().missing` is 0.
5. Note the stub's counter. Add an `<img crossorigin="anonymous">` of a warmed URL and wait for
   `load`. The checks: the counter did not change, and the image's resource timing entry has
   `transferSize === 0`, the test the DEBUG INFO card uses for "from cache" (`settings-debug.js:132`).
   This proves that a page fetch and an `<img>` request share one cache entry.
6. Set the cursor to `status().total - 12` through localStorage, reload, start again, and check
   that the stub served 12 requests at most. This proves the resume.
7. Set `done: true` in the cursor, delete the cache, reload, start, and check that the run began
   at zero. This proves the eviction check.

The test does not cover the visibility gate, the Save-Data gate or the iOS background. Those need a
device.

## 7. The phone retest

Headless tests miss phone behaviour (`.claude-memory/phone-regressions-after-rewrite.md`).

1. Deploy. Open the installed app on the iPhone. Keep it in front for two minutes.
2. Settings, DEBUG INFO: the row reads `… · done`. The emoji group counts about 1,000 files.
3. Pick an emoji from a category you never used (a flag, a tool) and send it. The row must draw
   it at once.
4. Turn on airplane mode, open the picker, scroll every category: every cell has its image.
5. Force close the app, open it, and read the row again: `done` stays. The cursor survived.
6. Report the DEBUG INFO row and, if a step fails, the Copy timings text.

## 8. Spec and docs

- **Add OF-19 to `docs/spec/offline.md`,** at the end of the section "Without a connection", next
  to OF-14, which says that Yap does not download a conversation in advance. OF-17 and OF-18 sit
  in the next section, "The promise and its limits". The number OF-19 is free. Draft:

  > **OF-19** Yap stores the emoji images of the picker's list on the device in the background,
  > about 20 seconds after it connects, a few at a time. Reading and typing never wait for this.
  > It pauses while Yap is hidden or has no connection, and it continues where it stopped at the
  > next open. After it, an emoji from the list shows at once in a message, also without a
  > connection. An emoji outside the list is stored when it first shows.
  > *Why:* a message that holds an emoji the device never saw drew an empty box until the image
  > arrived from the network.

  The draft uses none of the banned words. Run `docs/spec/tools/lint.py` and `build.py` before the
  commit.
- **Extend ST-25 in `docs/spec/settings.md`** by one sentence: the card also shows the progress of
  the emoji warm-up ([OF-19](offline.md#OF-19)).
- **Link OF-19 from PK-49 in `docs/spec/pickers.md`,** in the same sentence or in Related.
- **Add a dated paragraph to `docs/performance-notes.md`,** in the log after the 2026-10-31 entry:
  what the warm-up does, the path it takes through the worker, the measured sizes, and the two
  numbers (20 s, 6 at a time) with their reasons.
- **Extend `.claude-memory/static-asset-caching.md`** with a paragraph on the warm-up: the module,
  the destination rule it relies on, the cursor key, the eviction probe.

A finding from the exploration, outside this task: `ST-25` and `ST-28` in `settings.md` say
"service worker" with no lint marker. The lint should report them today. Check that when the lint
runs for step 5.

## 9. Risks and open points

- **The design relies on the CDN's `Vary` header.** The Cache API must treat a page fetch and an
  `<img>` request as the same entry. Step 5 of the test proves it in Chromium. WebKit needs the
  phone retest, step 3.
- **Same-origin images fill the worker's memory.** Pack and override fetches put 83 bodies, about
  650 KB, in the worker's memory for its life. That is the same cost a scroll through the picker's
  pack category has today. A server with a large custom folder raises it. A cap on the pack part
  of the list (for example 300 files) is a one-line change if a server needs it.
- **The cache grows to about 1,000 entries and under 2 MB.** The cache report reads sizes from
  the first 200 entries of a cache only (`settings-debug.js:19-35`), so its size for the emoji
  group stays an estimate.
- **About 1,000 fetch entries fill the resource timing buffer.** Nothing reads the buffer after
  the boot report, and the card filters `img` entries of the first 3 seconds. If a later diagnostic
  needs the buffer, `performance.clearResourceTimings()` after the boot report is the fix.
- **A new Twemoji release changes every URL.** It changes the stamp, the warm-up runs again from
  zero, and the old entries stay in the never-pruned cache. A release bump should go with a cache
  name bump in the worker (`yap-emoji-v3`), because the activate handler deletes old caches.
- **The scope stays open.** If empty boxes still appear after the warm-up, the next step is a
  bigger list. The CDN's file index (`data.jsdelivr.com/v1/package/gh/jdecked/twemoji@17.0.3/flat`)
  lists every file; the server could ship that list with the rules. That is a separate design.
