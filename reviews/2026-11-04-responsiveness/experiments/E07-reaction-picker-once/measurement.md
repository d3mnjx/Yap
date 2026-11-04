# E07 reaction-picker-once: measurement

## The change

Branch `perf/07-reaction-picker-once`, commit c4ffb2fa, one file: `Yap/wwwroot/js/ui/emoji-picker.js`. On main, every tap on a row's "Add Reaction" button builds a new emoji picker of about 1,000 cells (each a button with two listeners and a lazy image). E07 builds that picker once per page and moves it into the wrapper of each later open. The composer's picker does not change.

## The journey (added to the harness)

The harness had no journey that opens the reaction picker twice on one page. `picker-emoji` opens the composer's picker on a fresh page load each time. I added `picker-reaction` and `phone-picker-reaction` to `tests/browser/perf-journeys.mjs` on `perf/harness`, in commit **345de009**.

- One run is one page. The page is `site.prepared(kind)` with one reload on the profile's link, then networkidle and 300 ms, as `picker()` does.
- The journey marks the five lowest rows of plain text that are fully on screen. It opens the picker on each row, top to bottom. A desktop run hovers the row and clicks `.action-picker`. A phone run taps `.message-content`, waits for `.touched`, then taps `.action-picker`.
- After each open, the journey presses Escape and waits until `.emoji-picker-wrapper` is gone. Then it waits 1 s and two frames before the next open.
- `open k: grid` is the time from the click event's time stamp to the moment a smileys cell (`.emoji-picker-wrapper [data-section="smileys"] .emoji-btn`) is in the DOM and laid out (`offsetParent !== null`). It uses `window.__perf.watch`, as `measureEmoji` does.
- `later opens: grid` is the median of opens 2 to 5 on each page.
- `cells built` counts the distinct `.emoji-picker .emoji-btn` elements that entered the document during the five opens. A MutationObserver on `document` is installed before open 1 and keeps the added nodes. The count happens after open 5, and a set de-duplicates the buttons, so a moved picker counts once.
- The long tasks count from before open 1 to 700 ms after the last close.
- The phone row is the same function on `site.prepared('phone')`: 390x800, DPR 3, CPU x4 through CDP, touch on. That is the same `newPage('phone')` wrapper that `phone-cold-open` uses, so I added it.

The test asks for layout because the two sides add the cells at different points. On main, the cells land in the DOM before `opened()` lays them out, because `build()` is awaited. On E07, the later opens land after the layout, because nothing is awaited. A DOM-only test would leave the layout of about 1,000 cells out of main's time only.

The first version of the journey also timed the end of the frame after the grid (rAF, then setTimeout 0). The shake-out showed that this number measured the headless frame pipeline. On B's phone run, open 1 took 6,592 ms to that point, but the long tasks of all five opens added up to 2,194 ms. I removed that metric. The same shake-out timed out on A's phone run while it waited 5 s for the wrapper to close. The close wait is now 30 s, and each open starts after two frames.

## Commands

```
cd /d/PROJECTS/Yap && git worktree add /home/agent/yap-perf/exp/07-reaction-picker-once perf/07-reaction-picker-once
cd /home/agent/yap-perf/exp/07-reaction-picker-once/Yap && bash -l -c "dotnet build"
cd /home/agent/yap-perf/harness/tests/browser
# shake-out (twice: the first version, then the fixed one), n=1, lan, output in the scratch folder
node perf.mjs --a=/home/agent/yap-perf/harness:main --b=/home/agent/yap-perf/exp/07-reaction-picker-once:E07-reaction-picker --n=1 --profiles=lan --journeys=picker-reaction,phone-picker-reaction --out=<scratch>/shake2 --port-a=5351 --port-b=5352
# the measurement
node perf.mjs --a=/home/agent/yap-perf/harness:main --b=/home/agent/yap-perf/exp/07-reaction-picker-once:E07-reaction-picker --n=5 --profiles=lan,near --journeys=picker-reaction,phone-picker-reaction --out=/home/agent/yap-perf/results/E07-reaction-picker-once --port-a=5351 --port-b=5352
# proof and instrument check (this folder)
node mechanism.mjs > mechanism.txt
node probe-counter-cdn.mjs --pages=3 --port-a=5353 --port-b=5354 > probe-counter-cdn.log
```

The ports were 5351 and 5352 (proxies 5451 and 5452), and 5353 and 5354 for the probe. No port was taken. The wall time of the measurement was 12 min 37 s. All 40 runs ended, and `browser-log.txt` is empty. Side A shows as 345de009 in `report.md`: that is main 7f149be4 plus the harness test files.

## Result (from report.md, n=5 pages per side)

Times in ms, from the click to the laid-out grid.

| profile | journey | metric | A main | B E07 | Δ ms | Δ % | A min–max | B min–max |
| --- | --- | --- | --: | --: | --: | --: | --: | --: |
| lan | picker-reaction | open 1: grid | 28.4 | 32 | +3.6 | +12.7% | 25.9–40.5 | 24.2–59.1 |
| lan | picker-reaction | open 2: grid | 112 | 7.4 | −104 | −93.4% | 107–137 | 6.9–7.6 |
| lan | picker-reaction | later opens: grid | 49.6 | 7.5 | −42.1 | −84.9% | 47.5–58.2 | 7–8.2 |
| lan | picker-reaction | cells built | 5040 | 1008 | −4032 | −80.0% | 5040 | 1008 |
| lan | picker-reaction | long tasks / ms | 2 / 187 | 1 / 63 | −1 / −124 | −66.3% (ms) | 2–3 / 164–210 | 0–2 / 0–129 |
| lan | phone-picker-reaction | open 1: grid | 138 | 136 | −1.7 | −1.2% | 114–151 | 131–165 |
| lan | phone-picker-reaction | open 2: grid | 1091 | 47.8 | −1043 | −95.6% | 902–1479 | 39.5–49.7 |
| lan | phone-picker-reaction | later opens: grid | 423 | 48.5 | −374 | −88.5% | 304–619 | 43.1–62.5 |
| lan | phone-picker-reaction | cells built | 5040 | 1008 | −4032 | −80.0% | 5040 | 1008 |
| lan | phone-picker-reaction | long tasks / ms | 12 / 3046 | 7 / 812 | −5 / −2234 | −73.3% (ms) | 10–12 / 2509–3443 | 7–9 / 694–1068 |
| near | picker-reaction | open 1: grid | 27.2 | 25.4 | −1.8 | −6.6% | 25.7–30.9 | 23.7–37.6 |
| near | picker-reaction | open 2: grid | 136 | 7.6 | −128 | −94.4% | 95.1–171 | 6.2–9.9 |
| near | picker-reaction | later opens: grid | 48.8 | 8 | −40.8 | −83.6% | 46.3–62.7 | 7.6–9 |
| near | picker-reaction | cells built | 5040 | 1008 | −4032 | −80.0% | 5040 | 1008 |
| near | picker-reaction | long tasks / ms | 2 / 207 | 1 / 58 | −1 / −149 | −72.0% (ms) | 1–3 / 94–309 | 0–1 / 0–76 |
| near | phone-picker-reaction | open 1: grid | 150 | 129 | −21.2 | −14.1% | 142–208 | 122–149 |
| near | phone-picker-reaction | open 2: grid | 894 | 56 | −838 | −93.7% | 714–1076 | 41–66.4 |
| near | phone-picker-reaction | later opens: grid | 338 | 54.7 | −283 | −83.8% | 325–438 | 46.6–66.1 |
| near | phone-picker-reaction | cells built | 5040 | 1008 | −4032 | −80.0% | 5040 | 1008 |
| near | phone-picker-reaction | long tasks / ms | 11 / 2644 | 7 / 809 | −4 / −1835 | −69.4% (ms) | 10–13 / 2345–3089 | 6–8 / 766–858 |

Opens 3, 4 and 5 are in `report.md`. On A they are 46 to 51 ms on desktop and 315 to 416 ms on the phone. On B they are 7.6 to 8.4 ms on desktop and 49 to 64 ms on the phone.

All four `open 1` deltas are inside the noise: the min–max ranges of A and B overlap on every row. That is the expected result, because open 1 builds the picker on both sides. Every `later opens`, `open 2` and `cells built` delta is far outside the noise: the ranges do not touch (desktop: A min 46.3 against B max 9; phone: A min 304 against B max 66.1). The `lan` and `near` results agree. The change is client CPU work, so the link does not matter after open 1.

## Proof of mechanism

`mechanism.txt`, from `runs.json`:

- `cells built`: every page on A built 5,040 cell buttons in five opens (5 × 1,008). Every page on B built 1,008, which is one picker. This is the same on all 20 pages per side (lan and near, desktop and phone). B builds once and moves the picker; A builds on every open.
- The ratio of open 1 to later opens:

| profile, row | A open 1 / later | B open 1 / later |
| --- | --: | --: |
| lan desktop | 28.4 / 49.6 = 0.57 | 32 / 7.5 = 4.27 |
| lan phone | 137.5 / 422.7 = 0.33 | 135.8 / 48.5 = 2.80 |
| near desktop | 27.2 / 48.8 = 0.56 | 25.4 / 8.0 = 3.17 |
| near phone | 149.9 / 338 = 0.44 | 128.7 / 54.7 = 2.35 |

On B, a later open costs a quarter to a third of the first open (the move, Recent, the search reset and the layout). On A, a later open costs more than the first open. Its open 1 includes the import of `emoji-list.js` from the worker, and still its later opens are about twice as slow (about three times on the phone).

## Instrument check (`probe-counter-cdn.mjs`, `probe-counter-cdn.log`)

Desktop on `lan`, 3 pages per side and variant. Each value is the median per page, then the median over the pages.

| variant | side | open 1 | open 2 | opens 3–5 | opens 2–5 |
| --- | --- | --: | --: | --: | --: |
| counter (as the journey) | A | 42.9 | 138.2 | 46.6 | 48.7 |
| counter | B | 39.8 | 8.0 | 8.1 | 8.4 |
| plain (no MutationObserver) | A | 26.8 | 128.2 | 45.9 | 48.1 |
| plain | B | 25.7 | 7.5 | 7.7 | 7.7 |
| no-cdn (plain, CDN requests aborted) | A | 42.1 | 130.6 | 167.1 | 148.7 |
| no-cdn | B | 29.5 | 8.7 | 8.5 | 8.4 |

- The cell counter keeps main's four discarded pickers alive, but it does not inflate A: later opens are 48.7 ms with it and 48.1 ms without it.
- The images do not explain the gain. When the CDN fails, A's later opens get slower (149 ms), because each new `<img>` fails again and fires its error handler. B stays at about 8 ms. With the real CDN working, A pays about 46 ms per later open.
- A's slow open 2 (about 130 ms desktop, 0.9 to 1.1 s phone) is present in all three variants, so neither the counter nor the CDN causes it. I did not find the cause (possible causes are the JIT or a GC on the second build). E07 removes it with the rest.

## Verdict

**A clear gain, far above the noise, for everyone who opens the reaction picker more than once per page load.** The first open does not change: about 27 to 32 ms on desktop and 129 to 150 ms on the x4 phone, the same on both sides within the noise. Every later open on the same page goes from about 49 ms to 8 ms on desktop (−84%). On the x4 phone it goes from 338 to 423 ms to 49 to 55 ms (−84 to −89%). Main's second open is the worst case (112 to 136 ms desktop, 0.9 to 1.1 s phone), and E07 brings it to 7 to 8 ms and 48 to 56 ms. The long-task time over five opens falls by about 70% (desktop 187 to 207 ms → 58 to 63 ms; phone 2.6 to 3.0 s → 0.8 s). A phone user feels it most: 0.3 to 1 s of wait becomes about 50 ms. The network profile does not matter. `far` was not measured, because nothing in a later open uses the network.

## Caveats

- The grid time stops at the layout of the cells, not at the paint. The frame after it was removed from the journey, because in headless Chromium it measured the software raster of the emoji images (see "The journey").
- The phone is desktop Chromium at 390x800 with the CPU four times slower. It is not a real phone, and real GPU raster may change the absolute numbers.
- Recent appears to be empty for the seed's person: each build has 1,008 cells on both sides, and B adds no Recent cells per open. So the per-open Recent refill, which both sides do, adds almost nothing here. With a full Recent, both sides pay a few dozen cells more per open.
- A's later-open cost depends on the CDN state: about 46 ms with the CDN working, about 149 ms with it failing (probe). B does not depend on it.
- Other agents ran their measurements on the same machine at the same time. The A, B, B, A alternation spreads that load over both sides.
- The probe imports from the harness and from the B worktree, which is now removed. To run the probe again, add the worktree again and build it.
