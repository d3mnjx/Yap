# Work count: 50 rows at a reset and at an older page (client-render)

Reference note, not a finding. Counted from the code on 2026-11-04. No measurement; the ms figures in the findings say where a sandbox check was used.

## One row (`renderRow`, ui/message.js:51-91)

A text row by another person, with a header, no reply, no reactions, no media, no card:

| Work | Count |
| --- | --- |
| Template clone `t-message` | 84 nodes (39 elements, 44 whitespace text nodes, 1 comment), index.html:412-458 |
| Elements removed again | 20 (reply quote 3, cards 1, reactions 1, pending box 9, GIF star 3, Edit 3) |
| Avatar clone `t-avatar` | 1 div, 1 img or 1 initials span (plus whitespace) |
| `querySelector` calls | about 20 |
| Listeners added | 3 (picker, reply, more); 4 for an own row (edit); +1 per emoji image (onerror); +1 per reaction pill; +2 per gallery picture |
| Closures kept | 1 quick-reaction filler in a WeakMap (message.js:340) |
| `Date` parses | 2 in `needsHeader` |
| Intl calls (header rows only) | 1 `format` + 2 to 6 `formatToParts` (render/time.js:93-102) |
| `<img>` elements | 1 avatar (when the person has a picture) + 1 per emoji in the name and the text + 1 per reaction pill; pictures and link thumbnails are lazy |
| `<video>` elements | 1 per GIF video, `preload: 'auto'` and `play()` (message.js:183-186); 1 per uploaded video (`preload="none"`, poster eager) |

## 50 rows, new conversation (a switch, or the device's copy at a cold open)

- 50 row builds as above: about 4,200 cloned nodes, about 1,000 removed elements, about 1,000 `querySelector` calls, 150 to 200 listeners plus one per emoji image.
- 1 `rowFacts()` string of all accounts (timeline.js:71); 570 KB for 2,000 accounts.
- 1 frame callback: `list.scrollTop = list.scrollHeight` (one forced layout of the list), then `querySelectorAll('img')` over the flow and a `load` listener on every image still loading; each later image load schedules another such frame (at most one per frame).
- The `open` change also runs, in the frame: `renderRooms` (full rebuild), a people pass (signature changes with the open channel, so a full sort of all people), `renderMailbox`, `renderPins`; in the composer: `onOpen`.

## 50 rows, the server's answer after the device's copy (same conversation), or a reconnect

- 100 `JSON.stringify` calls (old and new message per kept row) in `unchanged` (timeline.js:43).
- 50 node moves (`flow.append(old.node)` for every kept row, timeline.js:66): every kept row leaves and re-enters the document.
- Changed rows rebuilt as above.
- 1 `rowFacts()` string, 1 scroll frame with the image walk.
- Then the bootstrap of the same connect fires `users` and `emoji`: 2 more `rowFacts()` strings; a full redraw only when they differ.

## 50 rows, an older page (timeline.js:158-173, 239-257)

- A wait for a still view: 200 ms after the last scroll event, longer while a finger is down.
- 50 row builds as above, plus 1 unconditional redraw of the old first row.
- 1 insertion (`spacer.after(...nodes)`).
- 1 forced layout (`renderTop` reads `scrollHeight`), 1 `scrollTop` write (with `overflow: hidden` around it after a caught fling).
- No image walk (no `scrollToBottom`). The `ResizeObserver` fires once more and calls `renderTop`.
- All emoji images and all GIF videos of the 50 rows load at once; pictures and link thumbnails load lazily.

## Requests a redraw issues

On WebKit every `<img>` element is a request of its own to the worker (memory `static-asset-caching`). Per redrawn row:

| Element | Path | Cost |
| --- | --- | --- |
| Emoji `<img>` (CDN or `/emoji-packs/`) | worker `rememberedFirst` | memory after the first request of a URL per worker life; the first one reads Cache Storage (about 3 ms each, one after another on the iPhone) or the CDN |
| Avatar `<img>` (`/uploads/profiles/`) | worker passes it on (no `respondWith`) | HTTP cache, `max-age=300`; after 5 minutes one revalidation round trip before it shows |
| Picture, link thumbnail, image GIF | worker `cacheFirst(MEDIA_CACHE)`, lazy | one Cache Storage read per element near the view; no memory layer |
| GIF `<video>` | `Range` request, the worker passes it on | HTTP cache (immutable) or the full file from the network, for every GIF row at draw |
| Video poster | eager | one request per video |
| Audio card | `preload="metadata"` | one metadata request per card |

Measured on the iPhone after the 2026-10-31 fixes (performance-notes, "Media"): 524 emoji requests in the first 3 s of a cold open, for two draws of the rows (about 260 per draw of 50 rows).
