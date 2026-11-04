# Yap responsiveness: A = main, B = E03-modulepreload

2026-11-04 11:52 UTC. Wall time 4 min 18 s. 5 repetitions.

- A (main): /home/agent/yap-perf/harness, cb074cfa Tests: perf.mjs measures how responsive Yap feels, build A against build B; the server answered 3916 ms after its start (the seed loads into memory first).
- B (E03-modulepreload): /home/agent/yap-perf/exp/03-modulepreload-boot-graph, c3a3bbde Shell: no modulepreload for Settings, Admin, Channel settings and their own modules; the server answered 5978 ms after its start (the seed loads into memory first).
- Seed: 50000 messages, 2814 reactions, 50 pictures, 20 GIFs (/home/agent/yap-perf/seed, built 2026-11-04T09:55:06.645Z). The person: ada.
- Times in ms. Opens: phases from the navigation start; the other journeys: from the click, the key or the scroll, in the page's clock.

## far (900 ms round trip, 1 Mbit/s)

Journeys: cold-open, warm-open.

| journey | metric | A: main | B: E03-modulepreload | Δ | Δ % |
| --- | --- | --: | --: | --: | --: |
| cold-open | html ms | 1191 | 1189 | -1.6 | -0.1% |
| cold-open | scripts ms | 13492 | 12269 | -1223 | -9.1% |
| cold-open | bootstrap ms | 14515 | 13291 | -1223 | -8.4% |
| cold-open | paint ms | 18102 | 17033 | -1069 | -5.9% |
| cold-open | socket ms | 16721 | 15859 | -862 | -5.2% |
| cold-open | rows ms | 18102 | 17033 | -1069 | -5.9% |
| cold-open | requests | 60 | 54 | -6 | -10.0% |
| cold-open | cached | 0 | 0 | +0 | — |
| cold-open | KB | 815 | 755 | -59.5 | -7.3% |
| cold-open | wire requests | 72 | 69 | -3 | -4.2% |
| cold-open | wire KB | 1006 | 959 | -47.4 | -4.7% |
| cold-open | long tasks | 0 | 0 | +0 | — |
| cold-open | long task ms | 0 | 0 | +0 | — |
| cold-open | heap MB | 1.9 | 1.9 | +0 | +0.0% |
| warm-open | html ms | 2.8 | 2.7 | -0.1 | -3.6% |
| warm-open | scripts ms | 32.6 | 22.6 | -10 | -30.7% |
| warm-open | bootstrap ms | 3005 | 3006 | +0.6 | +0.0% |
| warm-open | paint ms | 69.3 | 60.4 | -8.9 | -12.8% |
| warm-open | socket ms | 1849 | 1847 | -2.6 | -0.1% |
| warm-open | rows ms | 3002 | 3002 | +0.3 | +0.0% |
| warm-open | requests | 60 | 54 | -6 | -10.0% |
| warm-open | cached | 59 | 53 | -6 | -10.2% |
| warm-open | KB | 2.9 | 2.9 | +0 | +0.0% |
| warm-open | wire requests | 3 | 3 | +0 | +0.0% |
| warm-open | wire KB | 35.7 | 35.7 | +0 | +0.0% |
| warm-open | long tasks | 0 | 0 | +0 | — |
| warm-open | long task ms | 0 | 0 | +0 | — |
| warm-open | heap MB | 2.1 | 2.1 | +0 | +0.0% |

Spread (far): min and max of every sample, n samples per side.

| journey | metric | A min | A max | B min | B max | n |
| --- | --- | --: | --: | --: | --: | --: |
| cold-open | html ms | 1190 | 1200 | 1189 | 1191 | 5/5 |
| cold-open | scripts ms | 13398 | 13686 | 12144 | 12298 | 5/5 |
| cold-open | bootstrap ms | 14420 | 14726 | 13167 | 13331 | 5/5 |
| cold-open | paint ms | 17933 | 18321 | 16910 | 17090 | 5/5 |
| cold-open | socket ms | 16624 | 16950 | 15744 | 15923 | 5/5 |
| cold-open | rows ms | 17933 | 18321 | 16910 | 17090 | 5/5 |
| cold-open | requests | 60 | 60 | 54 | 54 | 5/5 |
| cold-open | cached | 0 | 0 | 0 | 0 | 5/5 |
| cold-open | KB | 815 | 815 | 755 | 755 | 5/5 |
| cold-open | wire requests | 72 | 72 | 69 | 69 | 5/5 |
| cold-open | wire KB | 1006 | 1006 | 959 | 959 | 5/5 |
| cold-open | long tasks | 0 | 0 | 0 | 0 | 5/5 |
| cold-open | long task ms | 0 | 0 | 0 | 0 | 5/5 |
| cold-open | heap MB | 1.9 | 1.9 | 1.9 | 1.9 | 5/5 |
| warm-open | html ms | 2.1 | 3.1 | 2.3 | 3.6 | 5/5 |
| warm-open | scripts ms | 22 | 60.7 | 18.7 | 63.7 | 5/5 |
| warm-open | bootstrap ms | 2983 | 3056 | 3002 | 3049 | 5/5 |
| warm-open | paint ms | 58.3 | 99.8 | 57.2 | 96.1 | 5/5 |
| warm-open | socket ms | 1843 | 1881 | 1841 | 1882 | 5/5 |
| warm-open | rows ms | 2964 | 3052 | 2998 | 3041 | 5/5 |
| warm-open | requests | 60 | 60 | 54 | 54 | 5/5 |
| warm-open | cached | 59 | 59 | 53 | 53 | 5/5 |
| warm-open | KB | 2.9 | 2.9 | 2.9 | 2.9 | 5/5 |
| warm-open | wire requests | 3 | 3 | 3 | 3 | 5/5 |
| warm-open | wire KB | 35.7 | 35.7 | 35.7 | 35.7 | 5/5 |
| warm-open | long tasks | 0 | 0 | 0 | 0 | 5/5 |
| warm-open | long task ms | 0 | 0 | 0 | 0 | 5/5 |
| warm-open | heap MB | 2 | 2.1 | 1.9 | 2.1 | 5/5 |

## near (60 ms round trip, 20 Mbit/s)

Journeys: cold-open, warm-open.

| journey | metric | A: main | B: E03-modulepreload | Δ | Δ % |
| --- | --- | --: | --: | --: | --: |
| cold-open | html ms | 79.3 | 78.9 | -0.4 | -0.5% |
| cold-open | scripts ms | 972 | 871 | -101 | -10.4% |
| cold-open | bootstrap ms | 1092 | 996 | -95.7 | -8.8% |
| cold-open | paint ms | 1539 | 1389 | -149 | -9.7% |
| cold-open | socket ms | 1350 | 1212 | -138 | -10.2% |
| cold-open | rows ms | 1539 | 1389 | -149 | -9.7% |
| cold-open | requests | 60 | 54 | -6 | -10.0% |
| cold-open | cached | 0 | 0 | +0 | — |
| cold-open | KB | 815 | 755 | -59.5 | -7.3% |
| cold-open | wire requests | 71 | 65 | -6 | -8.5% |
| cold-open | wire KB | 1004 | 938 | -66.5 | -6.6% |
| cold-open | long tasks | 0 | 0 | +0 | — |
| cold-open | long task ms | 0 | 0 | +0 | — |
| cold-open | heap MB | 1.9 | 1.9 | +0 | +0.0% |
| warm-open | html ms | 2.3 | 3 | +0.7 | +30.4% |
| warm-open | scripts ms | 26.1 | 21.5 | -4.6 | -17.6% |
| warm-open | bootstrap ms | 294 | 301 | +6.4 | +2.2% |
| warm-open | paint ms | 58.1 | 61.9 | +3.8 | +6.5% |
| warm-open | socket ms | 160 | 161 | +1.4 | +0.9% |
| warm-open | rows ms | 291 | 298 | +6.8 | +2.3% |
| warm-open | requests | 60 | 54 | -6 | -10.0% |
| warm-open | cached | 59 | 53 | -6 | -10.2% |
| warm-open | KB | 2.9 | 2.9 | +0 | +0.0% |
| warm-open | wire requests | 2 | 2 | +0 | +0.0% |
| warm-open | wire KB | 28.7 | 28.7 | +0 | +0.0% |
| warm-open | long tasks | 0 | 0 | +0 | — |
| warm-open | long task ms | 0 | 0 | +0 | — |
| warm-open | heap MB | 2.1 | 2.1 | +0 | +0.0% |

Spread (near): min and max of every sample, n samples per side.

| journey | metric | A min | A max | B min | B max | n |
| --- | --- | --: | --: | --: | --: | --: |
| cold-open | html ms | 76.5 | 82.6 | 77.1 | 82 | 5/5 |
| cold-open | scripts ms | 933 | 1388 | 823 | 1347 | 5/5 |
| cold-open | bootstrap ms | 1053 | 1521 | 945 | 1506 | 5/5 |
| cold-open | paint ms | 1334 | 1989 | 1242 | 1916 | 5/5 |
| cold-open | socket ms | 1199 | 1845 | 1098 | 1774 | 5/5 |
| cold-open | rows ms | 1334 | 1989 | 1242 | 1916 | 5/5 |
| cold-open | requests | 60 | 60 | 54 | 54 | 5/5 |
| cold-open | cached | 0 | 0 | 0 | 0 | 5/5 |
| cold-open | KB | 815 | 815 | 755 | 755 | 5/5 |
| cold-open | wire requests | 65 | 72 | 62 | 69 | 5/5 |
| cold-open | wire KB | 939 | 1007 | 930 | 1002 | 5/5 |
| cold-open | long tasks | 0 | 0 | 0 | 0 | 5/5 |
| cold-open | long task ms | 0 | 0 | 0 | 0 | 5/5 |
| cold-open | heap MB | 1.9 | 1.9 | 1.9 | 1.9 | 5/5 |
| warm-open | html ms | 2.1 | 3.6 | 2.3 | 4.3 | 5/5 |
| warm-open | scripts ms | 20.4 | 65.1 | 18.1 | 54.4 | 5/5 |
| warm-open | bootstrap ms | 287 | 331 | 292 | 328 | 5/5 |
| warm-open | paint ms | 54.8 | 99.5 | 53.4 | 91.8 | 5/5 |
| warm-open | socket ms | 153 | 198 | 153 | 193 | 5/5 |
| warm-open | rows ms | 284 | 327 | 289 | 325 | 5/5 |
| warm-open | requests | 60 | 60 | 54 | 54 | 5/5 |
| warm-open | cached | 59 | 59 | 53 | 53 | 5/5 |
| warm-open | KB | 2.9 | 2.9 | 2.9 | 2.9 | 5/5 |
| warm-open | wire requests | 2 | 2 | 2 | 2 | 5/5 |
| warm-open | wire KB | 28.7 | 28.7 | 28.7 | 28.7 | 5/5 |
| warm-open | long tasks | 0 | 0 | 0 | 0 | 5/5 |
| warm-open | long task ms | 0 | 0 | 0 | 0 | 5/5 |
| warm-open | heap MB | 1.9 | 2.1 | 1.9 | 2.1 | 5/5 |

## lan (no proxy: the server and the page)

Journeys: cold-open, warm-open.

| journey | metric | A: main | B: E03-modulepreload | Δ | Δ % |
| --- | --- | --: | --: | --: | --: |
| cold-open | html ms | 3.5 | 3.9 | +0.4 | +11.4% |
| cold-open | scripts ms | 80.1 | 82.1 | +2 | +2.5% |
| cold-open | bootstrap ms | 101 | 105 | +3.5 | +3.5% |
| cold-open | paint ms | 182 | 182 | +0 | +0.0% |
| cold-open | socket ms | 142 | 143 | +0.9 | +0.6% |
| cold-open | rows ms | 182 | 182 | +0 | +0.0% |
| cold-open | requests | 60 | 54 | -6 | -10.0% |
| cold-open | cached | 0 | 0 | +0 | — |
| cold-open | KB | 815 | 755 | -59.5 | -7.3% |
| cold-open | long tasks | 0 | 0 | +0 | — |
| cold-open | long task ms | 0 | 0 | +0 | — |
| cold-open | heap MB | 1.9 | 1.9 | +0 | +0.0% |
| warm-open | html ms | 2.2 | 2.2 | +0 | +0.0% |
| warm-open | scripts ms | 26.6 | 26.5 | -0.1 | -0.4% |
| warm-open | bootstrap ms | 92.2 | 92.7 | +0.5 | +0.5% |
| warm-open | paint ms | 61 | 64.1 | +3.1 | +5.1% |
| warm-open | socket ms | 37.3 | 39.8 | +2.5 | +6.7% |
| warm-open | rows ms | 79.9 | 81.9 | +2 | +2.5% |
| warm-open | requests | 60 | 54 | -6 | -10.0% |
| warm-open | cached | 59 | 53 | -6 | -10.2% |
| warm-open | KB | 2.9 | 2.9 | +0 | +0.0% |
| warm-open | long tasks | 0 | 0 | +0 | — |
| warm-open | long task ms | 0 | 0 | +0 | — |
| warm-open | heap MB | 2.2 | 2.1 | -0.1 | -4.5% |

Spread (lan): min and max of every sample, n samples per side.

| journey | metric | A min | A max | B min | B max | n |
| --- | --- | --: | --: | --: | --: | --: |
| cold-open | html ms | 3.2 | 5.1 | 3.3 | 4.2 | 5/5 |
| cold-open | scripts ms | 74.3 | 85.9 | 64.5 | 112 | 5/5 |
| cold-open | bootstrap ms | 95.4 | 110 | 84.8 | 136 | 5/5 |
| cold-open | paint ms | 172 | 224 | 150 | 220 | 5/5 |
| cold-open | socket ms | 132 | 158 | 118 | 180 | 5/5 |
| cold-open | rows ms | 172 | 224 | 150 | 220 | 5/5 |
| cold-open | requests | 60 | 60 | 54 | 54 | 5/5 |
| cold-open | cached | 0 | 0 | 0 | 0 | 5/5 |
| cold-open | KB | 815 | 815 | 755 | 755 | 5/5 |
| cold-open | long tasks | 0 | 1 | 0 | 0 | 5/5 |
| cold-open | long task ms | 0 | 54 | 0 | 0 | 5/5 |
| cold-open | heap MB | 1.9 | 2.1 | 1.9 | 2 | 5/5 |
| warm-open | html ms | 2.1 | 3.4 | 2.1 | 2.9 | 5/5 |
| warm-open | scripts ms | 24.6 | 60.1 | 22.6 | 51.4 | 5/5 |
| warm-open | bootstrap ms | 85 | 134 | 86.7 | 125 | 5/5 |
| warm-open | paint ms | 56.5 | 96 | 59.6 | 86.9 | 5/5 |
| warm-open | socket ms | 33.8 | 74.8 | 37.3 | 67.3 | 5/5 |
| warm-open | rows ms | 75.5 | 123 | 77.6 | 113 | 5/5 |
| warm-open | requests | 60 | 60 | 54 | 54 | 5/5 |
| warm-open | cached | 59 | 59 | 53 | 53 | 5/5 |
| warm-open | KB | 2.9 | 2.9 | 2.9 | 2.9 | 5/5 |
| warm-open | long tasks | 0 | 0 | 0 | 0 | 5/5 |
| warm-open | long task ms | 0 | 0 | 0 | 0 | 5/5 |
| warm-open | heap MB | 2.1 | 2.2 | 1.9 | 2.1 | 5/5 |

All runs ended.
