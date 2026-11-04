# Yap responsiveness: A = main, B = E02-lazy-tus

2026-11-04 11:59 UTC. Wall time 4 min 15 s. 5 repetitions.

- A (main): /home/agent/yap-perf/harness, cb074cfa Tests: perf.mjs measures how responsive Yap feels, build A against build B; the server answered 3176 ms after its start (the seed loads into memory first).
- B (E02-lazy-tus): /home/agent/yap-perf/exp/02-lazy-tus, fdb8b933 Upload: tus.min.js loads at the first upload, not as a script tag in the page; the server answered 3131 ms after its start (the seed loads into memory first).
- Seed: 50000 messages, 2814 reactions, 50 pictures, 20 GIFs (/home/agent/yap-perf/seed, built 2026-11-04T09:55:06.645Z). The person: ada.
- Times in ms. Opens: phases from the navigation start; the other journeys: from the click, the key or the scroll, in the page's clock.

## far (900 ms round trip, 1 Mbit/s)

Journeys: cold-open, warm-open.

| journey | metric | A: main | B: E02-lazy-tus | Δ | Δ % |
| --- | --- | --: | --: | --: | --: |
| cold-open | html ms | 1193 | 1191 | -1.7 | -0.1% |
| cold-open | scripts ms | 13723 | 12952 | -772 | -5.6% |
| cold-open | bootstrap ms | 14754 | 13972 | -781 | -5.3% |
| cold-open | paint ms | 18252 | 17814 | -438 | -2.4% |
| cold-open | socket ms | 16950 | 16231 | -719 | -4.2% |
| cold-open | rows ms | 18252 | 17814 | -438 | -2.4% |
| cold-open | requests | 60 | 59 | -1 | -1.7% |
| cold-open | cached | 0 | 0 | +0 | — |
| cold-open | KB | 815 | 784 | -31.2 | -3.8% |
| cold-open | wire requests | 72 | 72 | +0 | +0.0% |
| cold-open | wire KB | 1006 | 1007 | +0.6 | +0.1% |
| cold-open | long tasks | 0 | 0 | +0 | — |
| cold-open | long task ms | 0 | 0 | +0 | — |
| cold-open | heap MB | 1.9 | 1.8 | -0.1 | -5.3% |
| warm-open | html ms | 2.8 | 2.5 | -0.3 | -10.7% |
| warm-open | scripts ms | 30.6 | 26.6 | -4 | -13.1% |
| warm-open | bootstrap ms | 3010 | 3010 | +0.3 | +0.0% |
| warm-open | paint ms | 65.1 | 69.8 | +4.7 | +7.2% |
| warm-open | socket ms | 1849 | 1850 | +1 | +0.1% |
| warm-open | rows ms | 3007 | 3006 | -1 | -0.0% |
| warm-open | requests | 60 | 59 | -1 | -1.7% |
| warm-open | cached | 59 | 58 | -1 | -1.7% |
| warm-open | KB | 2.9 | 2.9 | +0 | +0.0% |
| warm-open | wire requests | 3 | 3 | +0 | +0.0% |
| warm-open | wire KB | 35.7 | 35.7 | +0 | +0.0% |
| warm-open | long tasks | 0 | 0 | +0 | — |
| warm-open | long task ms | 0 | 0 | +0 | — |
| warm-open | heap MB | 2.1 | 1.9 | -0.2 | -9.5% |

Spread (far): min and max of every sample, n samples per side.

| journey | metric | A min | A max | B min | B max | n |
| --- | --- | --: | --: | --: | --: | --: |
| cold-open | html ms | 1191 | 1241 | 1191 | 1199 | 5/5 |
| cold-open | scripts ms | 13445 | 13866 | 12833 | 13059 | 5/5 |
| cold-open | bootstrap ms | 14467 | 14891 | 13867 | 14083 | 5/5 |
| cold-open | paint ms | 18050 | 18469 | 17733 | 17945 | 5/5 |
| cold-open | socket ms | 16664 | 17088 | 16152 | 16541 | 5/5 |
| cold-open | rows ms | 18050 | 18469 | 17733 | 17945 | 5/5 |
| cold-open | requests | 60 | 60 | 59 | 59 | 5/5 |
| cold-open | cached | 0 | 0 | 0 | 0 | 5/5 |
| cold-open | KB | 815 | 815 | 784 | 784 | 5/5 |
| cold-open | wire requests | 72 | 72 | 72 | 72 | 5/5 |
| cold-open | wire KB | 1006 | 1006 | 1007 | 1007 | 5/5 |
| cold-open | long tasks | 0 | 0 | 0 | 1 | 5/5 |
| cold-open | long task ms | 0 | 0 | 0 | 55 | 5/5 |
| cold-open | heap MB | 1.9 | 1.9 | 1.8 | 1.8 | 5/5 |
| warm-open | html ms | 1.8 | 3.7 | 2.3 | 3.6 | 5/5 |
| warm-open | scripts ms | 19.2 | 54.2 | 22 | 51.5 | 5/5 |
| warm-open | bootstrap ms | 3002 | 3044 | 3003 | 3029 | 5/5 |
| warm-open | paint ms | 55 | 116 | 63.9 | 86 | 5/5 |
| warm-open | socket ms | 1840 | 1878 | 1844 | 1872 | 5/5 |
| warm-open | rows ms | 2997 | 3041 | 3000 | 3025 | 5/5 |
| warm-open | requests | 60 | 60 | 59 | 59 | 5/5 |
| warm-open | cached | 59 | 59 | 58 | 58 | 5/5 |
| warm-open | KB | 2.9 | 2.9 | 2.9 | 2.9 | 5/5 |
| warm-open | wire requests | 3 | 3 | 3 | 3 | 5/5 |
| warm-open | wire KB | 35.7 | 35.7 | 35.7 | 35.7 | 5/5 |
| warm-open | long tasks | 0 | 0 | 0 | 0 | 5/5 |
| warm-open | long task ms | 0 | 0 | 0 | 0 | 5/5 |
| warm-open | heap MB | 2 | 2.1 | 1.8 | 3.3 | 5/5 |

## near (60 ms round trip, 20 Mbit/s)

Journeys: cold-open, warm-open.

| journey | metric | A: main | B: E02-lazy-tus | Δ | Δ % |
| --- | --- | --: | --: | --: | --: |
| cold-open | html ms | 79.2 | 81.7 | +2.5 | +3.2% |
| cold-open | scripts ms | 991 | 980 | -11.4 | -1.2% |
| cold-open | bootstrap ms | 1090 | 1059 | -31.3 | -2.9% |
| cold-open | paint ms | 1383 | 1340 | -42.6 | -3.1% |
| cold-open | socket ms | 1240 | 1199 | -41.5 | -3.3% |
| cold-open | rows ms | 1383 | 1340 | -42.6 | -3.1% |
| cold-open | requests | 60 | 59 | -1 | -1.7% |
| cold-open | cached | 0 | 0 | +0 | — |
| cold-open | KB | 815 | 784 | -31.2 | -3.8% |
| cold-open | wire requests | 72 | 72 | +0 | +0.0% |
| cold-open | wire KB | 1007 | 1007 | +0.4 | +0.0% |
| cold-open | long tasks | 0 | 0 | +0 | — |
| cold-open | long task ms | 0 | 0 | +0 | — |
| cold-open | heap MB | 1.9 | 1.8 | -0.1 | -5.3% |
| warm-open | html ms | 2.2 | 3.6 | +1.4 | +63.6% |
| warm-open | scripts ms | 24.9 | 25.7 | +0.8 | +3.2% |
| warm-open | bootstrap ms | 288 | 295 | +6.5 | +2.3% |
| warm-open | paint ms | 64.2 | 67.7 | +3.5 | +5.5% |
| warm-open | socket ms | 161 | 160 | -1 | -0.6% |
| warm-open | rows ms | 285 | 292 | +6.2 | +2.2% |
| warm-open | requests | 60 | 59 | -1 | -1.7% |
| warm-open | cached | 59 | 58 | -1 | -1.7% |
| warm-open | KB | 2.9 | 2.9 | +0 | +0.0% |
| warm-open | wire requests | 2 | 2 | +0 | +0.0% |
| warm-open | wire KB | 28.7 | 28.7 | +0 | +0.0% |
| warm-open | long tasks | 0 | 0 | +0 | — |
| warm-open | long task ms | 0 | 0 | +0 | — |
| warm-open | heap MB | 2.1 | 1.9 | -0.2 | -9.5% |

Spread (near): min and max of every sample, n samples per side.

| journey | metric | A min | A max | B min | B max | n |
| --- | --- | --: | --: | --: | --: | --: |
| cold-open | html ms | 77.6 | 81.3 | 80.5 | 82.8 | 5/5 |
| cold-open | scripts ms | 927 | 1009 | 911 | 1012 | 5/5 |
| cold-open | bootstrap ms | 1046 | 1127 | 1016 | 1140 | 5/5 |
| cold-open | paint ms | 1330 | 1409 | 1318 | 1439 | 5/5 |
| cold-open | socket ms | 1190 | 1269 | 1160 | 1297 | 5/5 |
| cold-open | rows ms | 1330 | 1409 | 1318 | 1439 | 5/5 |
| cold-open | requests | 60 | 60 | 59 | 59 | 5/5 |
| cold-open | cached | 0 | 1 | 0 | 0 | 5/5 |
| cold-open | KB | 770 | 815 | 784 | 784 | 5/5 |
| cold-open | wire requests | 72 | 72 | 71 | 72 | 5/5 |
| cold-open | wire KB | 1007 | 1007 | 1006 | 1013 | 5/5 |
| cold-open | long tasks | 0 | 0 | 0 | 1 | 5/5 |
| cold-open | long task ms | 0 | 0 | 0 | 53 | 5/5 |
| cold-open | heap MB | 1.9 | 1.9 | 1.8 | 1.8 | 5/5 |
| warm-open | html ms | 2.2 | 11.2 | 2.5 | 7 | 5/5 |
| warm-open | scripts ms | 23.8 | 113 | 22.3 | 79.2 | 5/5 |
| warm-open | bootstrap ms | 284 | 435 | 290 | 359 | 5/5 |
| warm-open | paint ms | 57.2 | 210 | 58.7 | 127 | 5/5 |
| warm-open | socket ms | 157 | 301 | 159 | 217 | 5/5 |
| warm-open | rows ms | 282 | 414 | 286 | 354 | 5/5 |
| warm-open | requests | 60 | 60 | 59 | 59 | 5/5 |
| warm-open | cached | 59 | 59 | 58 | 58 | 5/5 |
| warm-open | KB | 2.9 | 2.9 | 2.9 | 2.9 | 5/5 |
| warm-open | wire requests | 2 | 2 | 2 | 2 | 5/5 |
| warm-open | wire KB | 28.5 | 28.7 | 28.7 | 28.7 | 5/5 |
| warm-open | long tasks | 0 | 1 | 0 | 0 | 5/5 |
| warm-open | long task ms | 0 | 67 | 0 | 0 | 5/5 |
| warm-open | heap MB | 1.9 | 2.1 | 1.8 | 1.9 | 5/5 |

## lan (no proxy: the server and the page)

Journeys: cold-open, warm-open.

| journey | metric | A: main | B: E02-lazy-tus | Δ | Δ % |
| --- | --- | --: | --: | --: | --: |
| cold-open | html ms | 3.6 | 4.2 | +0.6 | +16.7% |
| cold-open | scripts ms | 77.3 | 78.9 | +1.6 | +2.1% |
| cold-open | bootstrap ms | 97.8 | 97.2 | -0.6 | -0.6% |
| cold-open | paint ms | 167 | 173 | +5.6 | +3.3% |
| cold-open | socket ms | 128 | 130 | +2.6 | +2.0% |
| cold-open | rows ms | 167 | 173 | +5.6 | +3.3% |
| cold-open | requests | 60 | 59 | -1 | -1.7% |
| cold-open | cached | 0 | 0 | +0 | — |
| cold-open | KB | 815 | 784 | -31.2 | -3.8% |
| cold-open | long tasks | 0 | 0 | +0 | — |
| cold-open | long task ms | 0 | 0 | +0 | — |
| cold-open | heap MB | 1.9 | 1.7 | -0.2 | -10.5% |
| warm-open | html ms | 3.2 | 2.7 | -0.5 | -15.6% |
| warm-open | scripts ms | 38.1 | 25.5 | -12.6 | -33.1% |
| warm-open | bootstrap ms | 115 | 89.4 | -25.1 | -21.9% |
| warm-open | paint ms | 87.7 | 61.8 | -25.9 | -29.5% |
| warm-open | socket ms | 47.3 | 37.9 | -9.4 | -19.9% |
| warm-open | rows ms | 97 | 79.5 | -17.5 | -18.0% |
| warm-open | requests | 60 | 59 | -1 | -1.7% |
| warm-open | cached | 59 | 58 | -1 | -1.7% |
| warm-open | KB | 2.9 | 2.9 | +0 | +0.0% |
| warm-open | long tasks | 0 | 0 | +0 | — |
| warm-open | long task ms | 0 | 0 | +0 | — |
| warm-open | heap MB | 2.1 | 1.9 | -0.2 | -9.5% |

Spread (lan): min and max of every sample, n samples per side.

| journey | metric | A min | A max | B min | B max | n |
| --- | --- | --: | --: | --: | --: | --: |
| cold-open | html ms | 3 | 4.3 | 3.1 | 4.8 | 5/5 |
| cold-open | scripts ms | 74.5 | 107 | 75.1 | 97.1 | 5/5 |
| cold-open | bootstrap ms | 91.4 | 126 | 90.9 | 118 | 5/5 |
| cold-open | paint ms | 155 | 223 | 156 | 230 | 5/5 |
| cold-open | socket ms | 120 | 169 | 120 | 167 | 5/5 |
| cold-open | rows ms | 155 | 223 | 156 | 230 | 5/5 |
| cold-open | requests | 60 | 60 | 59 | 59 | 5/5 |
| cold-open | cached | 0 | 0 | 0 | 0 | 5/5 |
| cold-open | KB | 815 | 815 | 784 | 784 | 5/5 |
| cold-open | long tasks | 0 | 0 | 0 | 0 | 5/5 |
| cold-open | long task ms | 0 | 0 | 0 | 0 | 5/5 |
| cold-open | heap MB | 1.9 | 2 | 1.7 | 1.9 | 5/5 |
| warm-open | html ms | 2.3 | 5.7 | 2.2 | 2.8 | 5/5 |
| warm-open | scripts ms | 27.1 | 70.9 | 24.6 | 61.1 | 5/5 |
| warm-open | bootstrap ms | 101 | 154 | 86.1 | 153 | 5/5 |
| warm-open | paint ms | 64.5 | 107 | 58.1 | 121 | 5/5 |
| warm-open | socket ms | 37.8 | 85.8 | 37.4 | 82.1 | 5/5 |
| warm-open | rows ms | 90.1 | 139 | 75.8 | 121 | 5/5 |
| warm-open | requests | 60 | 60 | 58 | 59 | 5/5 |
| warm-open | cached | 59 | 59 | 57 | 58 | 5/5 |
| warm-open | KB | 2.9 | 2.9 | 2.9 | 2.9 | 5/5 |
| warm-open | long tasks | 0 | 0 | 0 | 0 | 5/5 |
| warm-open | long task ms | 0 | 0 | 0 | 0 | 5/5 |
| warm-open | heap MB | 1.9 | 2.1 | 1.8 | 1.9 | 5/5 |

All runs ended.
