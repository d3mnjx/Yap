# Yap responsiveness: A = main, B = E06-worker-after-rows

2026-11-04 11:52 UTC. Wall time 4 min 15 s. 5 repetitions.

- A (main): /home/agent/yap-perf/harness, cb074cfa Tests: perf.mjs measures how responsive Yap feels, build A against build B; the server answered 4145 ms after its start (the seed loads into memory first).
- B (E06-worker-after-rows): /home/agent/yap-perf/exp/06-worker-after-rows, 273573e8 Worker: a first visit registers it after the hub's first sync, not at script start; the server answered 3376 ms after its start (the seed loads into memory first).
- Seed: 50000 messages, 2814 reactions, 50 pictures, 20 GIFs (/home/agent/yap-perf/seed, built 2026-11-04T09:55:06.645Z). The person: ada.
- Times in ms. Opens: phases from the navigation start; the other journeys: from the click, the key or the scroll, in the page's clock.

## far (900 ms round trip, 1 Mbit/s)

Journeys: cold-open, warm-open.

| journey | metric | A: main | B: E06-worker-after-rows | Δ | Δ % |
| --- | --- | --: | --: | --: | --: |
| cold-open | html ms | 1191 | 1190 | -0.7 | -0.1% |
| cold-open | scripts ms | 13480 | 13449 | -30.2 | -0.2% |
| cold-open | bootstrap ms | 14500 | 14451 | -48.9 | -0.3% |
| cold-open | paint ms | 18081 | 17443 | -638 | -3.5% |
| cold-open | socket ms | 16705 | 16277 | -428 | -2.6% |
| cold-open | rows ms | 18081 | 17443 | -638 | -3.5% |
| cold-open | requests | 60 | 60 | +0 | +0.0% |
| cold-open | cached | 0 | 0 | +0 | — |
| cold-open | KB | 815 | 815 | +0.4 | +0.0% |
| cold-open | wire requests | 72 | 63 | -9 | -12.5% |
| cold-open | wire KB | 1006 | 879 | -127 | -12.6% |
| cold-open | long tasks | 0 | 0 | +0 | — |
| cold-open | long task ms | 0 | 0 | +0 | — |
| cold-open | heap MB | 1.9 | 1.9 | +0 | +0.0% |
| warm-open | html ms | 4 | 2.7 | -1.3 | -32.5% |
| warm-open | scripts ms | 40 | 35 | -5 | -12.5% |
| warm-open | bootstrap ms | 3021 | 3022 | +0.7 | +0.0% |
| warm-open | paint ms | 97.1 | 76.4 | -20.7 | -21.3% |
| warm-open | socket ms | 1864 | 1866 | +1.4 | +0.1% |
| warm-open | rows ms | 3018 | 3019 | +0.8 | +0.0% |
| warm-open | requests | 60 | 60 | +0 | +0.0% |
| warm-open | cached | 59 | 59 | +0 | +0.0% |
| warm-open | KB | 2.9 | 2.9 | +0 | +0.0% |
| warm-open | wire requests | 3 | 3 | +0 | +0.0% |
| warm-open | wire KB | 35.7 | 35.7 | +0 | +0.0% |
| warm-open | long tasks | 0 | 0 | +0 | — |
| warm-open | long task ms | 0 | 0 | +0 | — |
| warm-open | heap MB | 2.2 | 2.1 | -0.1 | -4.5% |

Spread (far): min and max of every sample, n samples per side.

| journey | metric | A min | A max | B min | B max | n |
| --- | --- | --: | --: | --: | --: | --: |
| cold-open | html ms | 1189 | 1201 | 1188 | 1194 | 5/5 |
| cold-open | scripts ms | 13403 | 13692 | 13407 | 13705 | 5/5 |
| cold-open | bootstrap ms | 14427 | 14715 | 14428 | 14718 | 5/5 |
| cold-open | paint ms | 18004 | 18292 | 17422 | 17709 | 5/5 |
| cold-open | socket ms | 16659 | 16912 | 16254 | 16544 | 5/5 |
| cold-open | rows ms | 18004 | 18292 | 17422 | 17709 | 5/5 |
| cold-open | requests | 60 | 60 | 60 | 60 | 5/5 |
| cold-open | cached | 0 | 0 | 0 | 0 | 5/5 |
| cold-open | KB | 815 | 815 | 815 | 815 | 5/5 |
| cold-open | wire requests | 72 | 72 | 63 | 63 | 5/5 |
| cold-open | wire KB | 1005 | 1006 | 878 | 879 | 5/5 |
| cold-open | long tasks | 0 | 0 | 0 | 0 | 5/5 |
| cold-open | long task ms | 0 | 0 | 0 | 0 | 5/5 |
| cold-open | heap MB | 1.9 | 1.9 | 1.9 | 1.9 | 5/5 |
| warm-open | html ms | 2.5 | 6.6 | 2.5 | 6.6 | 5/5 |
| warm-open | scripts ms | 28.9 | 62.6 | 20.6 | 51.7 | 5/5 |
| warm-open | bootstrap ms | 3017 | 3050 | 2997 | 3028 | 5/5 |
| warm-open | paint ms | 68.6 | 107 | 56 | 88.8 | 5/5 |
| warm-open | socket ms | 1854 | 1884 | 1842 | 1871 | 5/5 |
| warm-open | rows ms | 3014 | 3043 | 2994 | 3025 | 5/5 |
| warm-open | requests | 60 | 60 | 60 | 60 | 5/5 |
| warm-open | cached | 59 | 59 | 59 | 59 | 5/5 |
| warm-open | KB | 2.9 | 2.9 | 2.9 | 2.9 | 5/5 |
| warm-open | wire requests | 3 | 3 | 3 | 3 | 5/5 |
| warm-open | wire KB | 35.7 | 35.7 | 35.7 | 35.7 | 5/5 |
| warm-open | long tasks | 0 | 0 | 0 | 0 | 5/5 |
| warm-open | long task ms | 0 | 0 | 0 | 0 | 5/5 |
| warm-open | heap MB | 2.1 | 2.2 | 2 | 2.1 | 5/5 |

## near (60 ms round trip, 20 Mbit/s)

Journeys: cold-open, warm-open.

| journey | metric | A: main | B: E06-worker-after-rows | Δ | Δ % |
| --- | --- | --: | --: | --: | --: |
| cold-open | html ms | 79.2 | 81.6 | +2.4 | +3.0% |
| cold-open | scripts ms | 984 | 955 | -28.7 | -2.9% |
| cold-open | bootstrap ms | 1103 | 1045 | -57.4 | -5.2% |
| cold-open | paint ms | 1399 | 1329 | -70 | -5.0% |
| cold-open | socket ms | 1258 | 1184 | -73.9 | -5.9% |
| cold-open | rows ms | 1399 | 1329 | -69.9 | -5.0% |
| cold-open | requests | 60 | 60 | +0 | +0.0% |
| cold-open | cached | 0 | 0 | +0 | — |
| cold-open | KB | 815 | 815 | +0.4 | +0.0% |
| cold-open | wire requests | 72 | 63 | -9 | -12.5% |
| cold-open | wire KB | 1007 | 879 | -127 | -12.7% |
| cold-open | long tasks | 0 | 0 | +0 | — |
| cold-open | long task ms | 0 | 0 | +0 | — |
| cold-open | heap MB | 1.9 | 1.9 | +0 | +0.0% |
| warm-open | html ms | 2.5 | 2.4 | -0.1 | -4.0% |
| warm-open | scripts ms | 27.3 | 29.2 | +1.9 | +7.0% |
| warm-open | bootstrap ms | 299 | 293 | -6.1 | -2.0% |
| warm-open | paint ms | 60.3 | 61.4 | +1.1 | +1.8% |
| warm-open | socket ms | 161 | 162 | +0.4 | +0.2% |
| warm-open | rows ms | 296 | 290 | -6.2 | -2.1% |
| warm-open | requests | 60 | 60 | +0 | +0.0% |
| warm-open | cached | 59 | 59 | +0 | +0.0% |
| warm-open | KB | 2.9 | 2.9 | +0 | +0.0% |
| warm-open | wire requests | 2 | 2 | +0 | +0.0% |
| warm-open | wire KB | 28.7 | 28.7 | +0 | +0.0% |
| warm-open | long tasks | 0 | 0 | +0 | — |
| warm-open | long task ms | 0 | 0 | +0 | — |
| warm-open | heap MB | 2.1 | 2.2 | +0.1 | +4.8% |

Spread (near): min and max of every sample, n samples per side.

| journey | metric | A min | A max | B min | B max | n |
| --- | --- | --: | --: | --: | --: | --: |
| cold-open | html ms | 78.3 | 83.6 | 79.7 | 84.1 | 5/5 |
| cold-open | scripts ms | 961 | 1023 | 898 | 991 | 5/5 |
| cold-open | bootstrap ms | 1063 | 1145 | 982 | 1111 | 5/5 |
| cold-open | paint ms | 1361 | 1456 | 1260 | 1393 | 5/5 |
| cold-open | socket ms | 1210 | 1286 | 1126 | 1250 | 5/5 |
| cold-open | rows ms | 1361 | 1456 | 1260 | 1393 | 5/5 |
| cold-open | requests | 60 | 60 | 60 | 60 | 5/5 |
| cold-open | cached | 0 | 1 | 0 | 0 | 5/5 |
| cold-open | KB | 770 | 815 | 815 | 815 | 5/5 |
| cold-open | wire requests | 72 | 72 | 62 | 63 | 5/5 |
| cold-open | wire KB | 1007 | 1007 | 879 | 879 | 5/5 |
| cold-open | long tasks | 0 | 0 | 0 | 0 | 5/5 |
| cold-open | long task ms | 0 | 0 | 0 | 0 | 5/5 |
| cold-open | heap MB | 1.9 | 1.9 | 1.9 | 1.9 | 5/5 |
| warm-open | html ms | 2.1 | 4.6 | 2.1 | 2.7 | 5/5 |
| warm-open | scripts ms | 18.4 | 63.8 | 25.8 | 61.8 | 5/5 |
| warm-open | bootstrap ms | 290 | 342 | 292 | 327 | 5/5 |
| warm-open | paint ms | 52.3 | 104 | 55.9 | 93.1 | 5/5 |
| warm-open | socket ms | 159 | 206 | 156 | 193 | 5/5 |
| warm-open | rows ms | 287 | 339 | 289 | 324 | 5/5 |
| warm-open | requests | 60 | 60 | 60 | 60 | 5/5 |
| warm-open | cached | 59 | 59 | 59 | 59 | 5/5 |
| warm-open | KB | 2.9 | 2.9 | 2.9 | 2.9 | 5/5 |
| warm-open | wire requests | 2 | 2 | 2 | 2 | 5/5 |
| warm-open | wire KB | 28.7 | 28.7 | 28.7 | 28.7 | 5/5 |
| warm-open | long tasks | 0 | 0 | 0 | 0 | 5/5 |
| warm-open | long task ms | 0 | 0 | 0 | 0 | 5/5 |
| warm-open | heap MB | 1.9 | 2.1 | 2.1 | 2.2 | 5/5 |

## lan (no proxy: the server and the page)

Journeys: cold-open, warm-open.

| journey | metric | A: main | B: E06-worker-after-rows | Δ | Δ % |
| --- | --- | --: | --: | --: | --: |
| cold-open | html ms | 3.6 | 3.5 | -0.1 | -2.8% |
| cold-open | scripts ms | 76.5 | 66.1 | -10.4 | -13.6% |
| cold-open | bootstrap ms | 93.5 | 79.7 | -13.8 | -14.8% |
| cold-open | paint ms | 152 | 135 | -17.3 | -11.4% |
| cold-open | socket ms | 121 | 105 | -16.8 | -13.8% |
| cold-open | rows ms | 152 | 135 | -17.3 | -11.4% |
| cold-open | requests | 60 | 60 | +0 | +0.0% |
| cold-open | cached | 0 | 0 | +0 | — |
| cold-open | KB | 815 | 815 | +0.4 | +0.0% |
| cold-open | long tasks | 0 | 0 | +0 | — |
| cold-open | long task ms | 0 | 0 | +0 | — |
| cold-open | heap MB | 1.9 | 1.9 | +0 | +0.0% |
| warm-open | html ms | 2.4 | 4.1 | +1.7 | +70.8% |
| warm-open | scripts ms | 28.5 | 32.8 | +4.3 | +15.1% |
| warm-open | bootstrap ms | 124 | 139 | +14.7 | +11.9% |
| warm-open | paint ms | 90 | 93.6 | +3.6 | +4.0% |
| warm-open | socket ms | 47.8 | 73.6 | +25.8 | +54.0% |
| warm-open | rows ms | 113 | 123 | +10.1 | +8.9% |
| warm-open | requests | 60 | 60 | +0 | +0.0% |
| warm-open | cached | 59 | 59 | +0 | +0.0% |
| warm-open | KB | 2.9 | 2.9 | +0 | +0.0% |
| warm-open | long tasks | 0 | 0 | +0 | — |
| warm-open | long task ms | 0 | 0 | +0 | — |
| warm-open | heap MB | 2.1 | 2.1 | +0 | +0.0% |

Spread (lan): min and max of every sample, n samples per side.

| journey | metric | A min | A max | B min | B max | n |
| --- | --- | --: | --: | --: | --: | --: |
| cold-open | html ms | 3.3 | 3.8 | 2.9 | 4.5 | 5/5 |
| cold-open | scripts ms | 70.7 | 82.5 | 62.9 | 78.8 | 5/5 |
| cold-open | bootstrap ms | 86.5 | 98.1 | 78.2 | 93.6 | 5/5 |
| cold-open | paint ms | 148 | 164 | 133 | 150 | 5/5 |
| cold-open | socket ms | 120 | 134 | 101 | 124 | 5/5 |
| cold-open | rows ms | 148 | 164 | 133 | 150 | 5/5 |
| cold-open | requests | 60 | 60 | 60 | 60 | 5/5 |
| cold-open | cached | 0 | 0 | 0 | 0 | 5/5 |
| cold-open | KB | 815 | 815 | 815 | 815 | 5/5 |
| cold-open | long tasks | 0 | 0 | 0 | 0 | 5/5 |
| cold-open | long task ms | 0 | 0 | 0 | 0 | 5/5 |
| cold-open | heap MB | 1.9 | 1.9 | 1.9 | 1.9 | 5/5 |
| warm-open | html ms | 2.2 | 4.3 | 2.4 | 6 | 5/5 |
| warm-open | scripts ms | 26.2 | 59.1 | 27.1 | 65.2 | 5/5 |
| warm-open | bootstrap ms | 70.1 | 135 | 95.4 | 162 | 5/5 |
| warm-open | paint ms | 64.7 | 93.7 | 66.6 | 142 | 5/5 |
| warm-open | socket ms | 33.6 | 72.8 | 42.9 | 86.2 | 5/5 |
| warm-open | rows ms | 85.6 | 120 | 85.5 | 142 | 5/5 |
| warm-open | requests | 60 | 60 | 59 | 60 | 5/5 |
| warm-open | cached | 59 | 59 | 58 | 59 | 5/5 |
| warm-open | KB | 2.9 | 2.9 | 2.9 | 2.9 | 5/5 |
| warm-open | long tasks | 0 | 0 | 0 | 1 | 5/5 |
| warm-open | long task ms | 0 | 0 | 0 | 52 | 5/5 |
| warm-open | heap MB | 1.9 | 2.1 | 1.9 | 2.1 | 5/5 |

All runs ended.
