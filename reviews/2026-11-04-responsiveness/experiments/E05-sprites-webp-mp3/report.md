# Yap responsiveness: A = main, B = E05-sprites-mp3

2026-11-04 12:09 UTC. Wall time 7 min 52 s. 5 repetitions.

- A (main): /home/agent/yap-perf/harness, cb074cfa Tests: perf.mjs measures how responsive Yap feels, build A against build B; the server answered 3391 ms after its start (the seed loads into memory first).
- B (E05-sprites-mp3): /home/agent/yap-perf/exp/05-sprites-webp-mp3, e46721a3 Emoji-toggle sprites as lossless WebP, notif.mp3 without its cover art; the server answered 2886 ms after its start (the seed loads into memory first).
- Seed: 50000 messages, 2814 reactions, 50 pictures, 20 GIFs (/home/agent/yap-perf/seed, built 2026-11-04T09:55:06.645Z). The person: ada.
- Times in ms. Opens: phases from the navigation start; the other journeys: from the click, the key or the scroll, in the page's clock.

## far (900 ms round trip, 1 Mbit/s)

Journeys: cold-open, picker-emoji.

| journey | metric | A: main | B: E05-sprites-mp3 | Δ | Δ % |
| --- | --- | --: | --: | --: | --: |
| cold-open | html ms | 1192 | 1190 | -1.3 | -0.1% |
| cold-open | scripts ms | 13481 | 13526 | +44.3 | +0.3% |
| cold-open | bootstrap ms | 14503 | 14548 | +44.9 | +0.3% |
| cold-open | paint ms | 18111 | 17923 | -188 | -1.0% |
| cold-open | socket ms | 16727 | 16758 | +31.5 | +0.2% |
| cold-open | rows ms | 18111 | 17923 | -188 | -1.0% |
| cold-open | requests | 60 | 60 | +0 | +0.0% |
| cold-open | cached | 0 | 0 | +0 | — |
| cold-open | KB | 815 | 763 | -52.2 | -6.4% |
| cold-open | wire requests | 72 | 72 | +0 | +0.0% |
| cold-open | wire KB | 1006 | 943 | -62.8 | -6.2% |
| cold-open | long tasks | 0 | 0 | +0 | — |
| cold-open | long task ms | 0 | 0 | +0 | — |
| cold-open | heap MB | 1.9 | 1.9 | +0 | +0.0% |
| picker-emoji | first: grid ms | 26.6 | 27.6 | +1 | +3.8% |
| picker-emoji | first: images ms | 8649 | 8649 | -0.5 | -0.0% |
| picker-emoji | first: requests in 2 s | 408 | 408 | +0 | +0.0% |
| picker-emoji | again: grid ms | 21.7 | 21.5 | -0.2 | -0.9% |
| picker-emoji | again: images ms | 531 | 544 | +13 | +2.4% |
| picker-emoji | again: requests in 2 s | 434 | 434 | +0 | +0.0% |

Spread (far): min and max of every sample, n samples per side.

| journey | metric | A min | A max | B min | B max | n |
| --- | --- | --: | --: | --: | --: | --: |
| cold-open | html ms | 1189 | 1199 | 1189 | 1198 | 5/5 |
| cold-open | scripts ms | 13423 | 13658 | 13448 | 13676 | 5/5 |
| cold-open | bootstrap ms | 14448 | 14706 | 14470 | 14697 | 5/5 |
| cold-open | paint ms | 17996 | 18177 | 17844 | 18063 | 5/5 |
| cold-open | socket ms | 16684 | 16884 | 16669 | 16895 | 5/5 |
| cold-open | rows ms | 17996 | 18177 | 17844 | 18063 | 5/5 |
| cold-open | requests | 60 | 60 | 60 | 60 | 5/5 |
| cold-open | cached | 0 | 0 | 0 | 0 | 5/5 |
| cold-open | KB | 815 | 815 | 763 | 763 | 5/5 |
| cold-open | wire requests | 72 | 72 | 72 | 72 | 5/5 |
| cold-open | wire KB | 1006 | 1006 | 942 | 943 | 5/5 |
| cold-open | long tasks | 0 | 0 | 0 | 0 | 5/5 |
| cold-open | long task ms | 0 | 0 | 0 | 0 | 5/5 |
| cold-open | heap MB | 1.9 | 1.9 | 1.9 | 1.9 | 5/5 |
| picker-emoji | first: grid ms | 24.7 | 40.8 | 23.4 | 32.4 | 5/5 |
| picker-emoji | first: images ms | 8647 | 8665 | 8648 | 8662 | 5/5 |
| picker-emoji | first: requests in 2 s | 408 | 408 | 408 | 408 | 5/5 |
| picker-emoji | again: grid ms | 19.4 | 41.4 | 20.9 | 23.4 | 5/5 |
| picker-emoji | again: images ms | 508 | 549 | 506 | 592 | 5/5 |
| picker-emoji | again: requests in 2 s | 434 | 434 | 434 | 434 | 5/5 |

## near (60 ms round trip, 20 Mbit/s)

Journeys: cold-open, picker-emoji.

| journey | metric | A: main | B: E05-sprites-mp3 | Δ | Δ % |
| --- | --- | --: | --: | --: | --: |
| cold-open | html ms | 78.3 | 78.8 | +0.5 | +0.6% |
| cold-open | scripts ms | 990 | 940 | -50 | -5.0% |
| cold-open | bootstrap ms | 1088 | 1048 | -39.9 | -3.7% |
| cold-open | paint ms | 1381 | 1331 | -49.7 | -3.6% |
| cold-open | socket ms | 1238 | 1187 | -51.4 | -4.2% |
| cold-open | rows ms | 1381 | 1331 | -49.7 | -3.6% |
| cold-open | requests | 60 | 60 | +0 | +0.0% |
| cold-open | cached | 0 | 0 | +0 | — |
| cold-open | KB | 815 | 763 | -52.2 | -6.4% |
| cold-open | wire requests | 72 | 72 | +0 | +0.0% |
| cold-open | wire KB | 1007 | 943 | -63.4 | -6.3% |
| cold-open | long tasks | 0 | 0 | +0 | — |
| cold-open | long task ms | 0 | 0 | +0 | — |
| cold-open | heap MB | 1.9 | 1.9 | +0 | +0.0% |
| picker-emoji | first: grid ms | 25.5 | 24.5 | -1 | -3.9% |
| picker-emoji | first: images ms | 969 | 948 | -21.8 | -2.2% |
| picker-emoji | first: requests in 2 s | 435 | 435 | +0 | +0.0% |
| picker-emoji | again: grid ms | 21.1 | 23.8 | +2.7 | +12.8% |
| picker-emoji | again: images ms | 536 | 553 | +16.9 | +3.2% |
| picker-emoji | again: requests in 2 s | 434 | 434 | +0 | +0.0% |

Spread (near): min and max of every sample, n samples per side.

| journey | metric | A min | A max | B min | B max | n |
| --- | --- | --: | --: | --: | --: | --: |
| cold-open | html ms | 77.3 | 79.8 | 77.3 | 80.6 | 5/5 |
| cold-open | scripts ms | 961 | 1043 | 920 | 970 | 5/5 |
| cold-open | bootstrap ms | 1053 | 1168 | 1026 | 1053 | 5/5 |
| cold-open | paint ms | 1332 | 1466 | 1305 | 1341 | 5/5 |
| cold-open | socket ms | 1195 | 1316 | 1170 | 1194 | 5/5 |
| cold-open | rows ms | 1332 | 1466 | 1305 | 1341 | 5/5 |
| cold-open | requests | 60 | 60 | 60 | 60 | 5/5 |
| cold-open | cached | 0 | 0 | 0 | 0 | 5/5 |
| cold-open | KB | 815 | 815 | 763 | 763 | 5/5 |
| cold-open | wire requests | 72 | 72 | 72 | 72 | 5/5 |
| cold-open | wire KB | 1007 | 1007 | 942 | 943 | 5/5 |
| cold-open | long tasks | 0 | 0 | 0 | 0 | 5/5 |
| cold-open | long task ms | 0 | 0 | 0 | 0 | 5/5 |
| cold-open | heap MB | 1.9 | 1.9 | 1.9 | 1.9 | 5/5 |
| picker-emoji | first: grid ms | 22.1 | 34.8 | 22.1 | 27.9 | 5/5 |
| picker-emoji | first: images ms | 894 | 1036 | 917 | 1138 | 5/5 |
| picker-emoji | first: requests in 2 s | 434 | 435 | 435 | 435 | 5/5 |
| picker-emoji | again: grid ms | 20.2 | 21.9 | 20.5 | 28.5 | 5/5 |
| picker-emoji | again: images ms | 494 | 561 | 488 | 595 | 5/5 |
| picker-emoji | again: requests in 2 s | 433 | 434 | 434 | 434 | 5/5 |

All runs ended.
