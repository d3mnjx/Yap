# Yap responsiveness: A = main, B = E01-compression-optimal

2026-11-04 11:52 UTC. Wall time 4 min 13 s. 5 repetitions.

- A (main): /home/agent/yap-perf/harness, cb074cfa Tests: perf.mjs measures how responsive Yap feels, build A against build B; the server answered 3187 ms after its start (the seed loads into memory first).
- B (E01-compression-optimal): /home/agent/yap-perf/exp/01-compression-optimal, 9c623d93 Response compression at the Optimal level instead of the framework's Fastest; the server answered 3392 ms after its start (the seed loads into memory first).
- Seed: 50000 messages, 2814 reactions, 50 pictures, 20 GIFs (/home/agent/yap-perf/seed, built 2026-11-04T09:55:06.645Z). The person: ada.
- Times in ms. Opens: phases from the navigation start; the other journeys: from the click, the key or the scroll, in the page's clock.

## far (900 ms round trip, 1 Mbit/s)

Journeys: cold-open, warm-open.

| journey | metric | A: main | B: E01-compression-optimal | Δ | Δ % |
| --- | --- | --: | --: | --: | --: |
| cold-open | html ms | 1190 | 1094 | -95.6 | -8.0% |
| cold-open | scripts ms | 13481 | 13217 | -263 | -2.0% |
| cold-open | bootstrap ms | 14504 | 14220 | -284 | -2.0% |
| cold-open | paint ms | 17996 | 17673 | -322 | -1.8% |
| cold-open | socket ms | 16700 | 16308 | -392 | -2.3% |
| cold-open | rows ms | 17996 | 17673 | -322 | -1.8% |
| cold-open | requests | 60 | 60 | +0 | +0.0% |
| cold-open | cached | 0 | 0 | +0 | — |
| cold-open | KB | 815 | 739 | -75.5 | -9.3% |
| cold-open | wire requests | 72 | 72 | +0 | +0.0% |
| cold-open | wire KB | 1006 | 914 | -92.6 | -9.2% |
| cold-open | long tasks | 0 | 0 | +0 | — |
| cold-open | long task ms | 0 | 0 | +0 | — |
| cold-open | heap MB | 1.9 | 1.9 | +0 | +0.0% |
| warm-open | html ms | 3.6 | 2.3 | -1.3 | -36.1% |
| warm-open | scripts ms | 35.5 | 32.3 | -3.2 | -9.0% |
| warm-open | bootstrap ms | 3019 | 3029 | +10.1 | +0.3% |
| warm-open | paint ms | 92.3 | 71 | -21.3 | -23.1% |
| warm-open | socket ms | 1863 | 1852 | -10.6 | -0.6% |
| warm-open | rows ms | 3016 | 3024 | +7.5 | +0.2% |
| warm-open | requests | 60 | 60 | +0 | +0.0% |
| warm-open | cached | 59 | 59 | +0 | +0.0% |
| warm-open | KB | 2.9 | 2.3 | -0.6 | -20.7% |
| warm-open | wire requests | 3 | 3 | +0 | +0.0% |
| warm-open | wire KB | 35.7 | 33.9 | -1.8 | -5.0% |
| warm-open | long tasks | 0 | 0 | +0 | — |
| warm-open | long task ms | 0 | 0 | +0 | — |
| warm-open | heap MB | 2.1 | 2.1 | +0 | +0.0% |

Spread (far): min and max of every sample, n samples per side.

| journey | metric | A min | A max | B min | B max | n |
| --- | --- | --: | --: | --: | --: | --: |
| cold-open | html ms | 1189 | 1192 | 1093 | 1099 | 5/5 |
| cold-open | scripts ms | 13423 | 13560 | 13202 | 13292 | 5/5 |
| cold-open | bootstrap ms | 14447 | 14592 | 14203 | 14295 | 5/5 |
| cold-open | paint ms | 17949 | 18078 | 17575 | 17685 | 5/5 |
| cold-open | socket ms | 16646 | 16783 | 16289 | 16374 | 5/5 |
| cold-open | rows ms | 17949 | 18078 | 17575 | 17685 | 5/5 |
| cold-open | requests | 60 | 60 | 60 | 60 | 5/5 |
| cold-open | cached | 0 | 0 | 0 | 0 | 5/5 |
| cold-open | KB | 815 | 815 | 739 | 739 | 5/5 |
| cold-open | wire requests | 72 | 72 | 72 | 72 | 5/5 |
| cold-open | wire KB | 1005 | 1006 | 914 | 914 | 5/5 |
| cold-open | long tasks | 0 | 0 | 0 | 0 | 5/5 |
| cold-open | long task ms | 0 | 0 | 0 | 0 | 5/5 |
| cold-open | heap MB | 1.9 | 1.9 | 1.9 | 1.9 | 5/5 |
| warm-open | html ms | 1.9 | 7.1 | 2.1 | 3.8 | 5/5 |
| warm-open | scripts ms | 30.3 | 66.6 | 22.3 | 69.4 | 5/5 |
| warm-open | bootstrap ms | 3018 | 3048 | 3003 | 3053 | 5/5 |
| warm-open | paint ms | 66.1 | 118 | 57 | 111 | 5/5 |
| warm-open | socket ms | 1849 | 1891 | 1843 | 1895 | 5/5 |
| warm-open | rows ms | 3002 | 3044 | 2999 | 3050 | 5/5 |
| warm-open | requests | 60 | 60 | 60 | 60 | 5/5 |
| warm-open | cached | 59 | 59 | 59 | 59 | 5/5 |
| warm-open | KB | 2.9 | 2.9 | 2.3 | 2.3 | 5/5 |
| warm-open | wire requests | 3 | 3 | 3 | 3 | 5/5 |
| warm-open | wire KB | 35.5 | 35.7 | 33.9 | 33.9 | 5/5 |
| warm-open | long tasks | 0 | 0 | 0 | 0 | 5/5 |
| warm-open | long task ms | 0 | 0 | 0 | 0 | 5/5 |
| warm-open | heap MB | 2 | 2.1 | 2 | 2.1 | 5/5 |

## near (60 ms round trip, 20 Mbit/s)

Journeys: cold-open, warm-open.

| journey | metric | A: main | B: E01-compression-optimal | Δ | Δ % |
| --- | --- | --: | --: | --: | --: |
| cold-open | html ms | 78.5 | 76.7 | -1.8 | -2.3% |
| cold-open | scripts ms | 935 | 858 | -77.1 | -8.2% |
| cold-open | bootstrap ms | 1057 | 978 | -79 | -7.5% |
| cold-open | paint ms | 1345 | 1277 | -67.6 | -5.0% |
| cold-open | socket ms | 1199 | 1118 | -80.7 | -6.7% |
| cold-open | rows ms | 1345 | 1277 | -67.6 | -5.0% |
| cold-open | requests | 60 | 60 | +0 | +0.0% |
| cold-open | cached | 0 | 0 | +0 | — |
| cold-open | KB | 815 | 739 | -75.5 | -9.3% |
| cold-open | wire requests | 72 | 72 | +0 | +0.0% |
| cold-open | wire KB | 1007 | 914 | -92.6 | -9.2% |
| cold-open | long tasks | 0 | 0 | +0 | — |
| cold-open | long task ms | 0 | 0 | +0 | — |
| cold-open | heap MB | 1.9 | 1.9 | +0 | +0.0% |
| warm-open | html ms | 2 | 2.6 | +0.6 | +30.0% |
| warm-open | scripts ms | 28.9 | 26.8 | -2.1 | -7.3% |
| warm-open | bootstrap ms | 298 | 302 | +4 | +1.3% |
| warm-open | paint ms | 59.3 | 58.5 | -0.8 | -1.3% |
| warm-open | socket ms | 162 | 167 | +4.3 | +2.6% |
| warm-open | rows ms | 295 | 299 | +4 | +1.4% |
| warm-open | requests | 60 | 60 | +0 | +0.0% |
| warm-open | cached | 59 | 59 | +0 | +0.0% |
| warm-open | KB | 2.9 | 2.3 | -0.6 | -20.7% |
| warm-open | wire requests | 2 | 2 | +0 | +0.0% |
| warm-open | wire KB | 28.7 | 28.1 | -0.6 | -2.1% |
| warm-open | long tasks | 0 | 0 | +0 | — |
| warm-open | long task ms | 0 | 0 | +0 | — |
| warm-open | heap MB | 2.2 | 2.1 | -0.1 | -4.5% |

Spread (near): min and max of every sample, n samples per side.

| journey | metric | A min | A max | B min | B max | n |
| --- | --- | --: | --: | --: | --: | --: |
| cold-open | html ms | 77.8 | 81.9 | 76.4 | 78.9 | 5/5 |
| cold-open | scripts ms | 892 | 974 | 850 | 880 | 5/5 |
| cold-open | bootstrap ms | 969 | 1060 | 938 | 999 | 5/5 |
| cold-open | paint ms | 1252 | 1353 | 1225 | 1317 | 5/5 |
| cold-open | socket ms | 1114 | 1212 | 1083 | 1138 | 5/5 |
| cold-open | rows ms | 1252 | 1353 | 1225 | 1317 | 5/5 |
| cold-open | requests | 60 | 60 | 60 | 60 | 5/5 |
| cold-open | cached | 0 | 1 | 0 | 2 | 5/5 |
| cold-open | KB | 770 | 815 | 656 | 739 | 5/5 |
| cold-open | wire requests | 72 | 72 | 72 | 72 | 5/5 |
| cold-open | wire KB | 1007 | 1007 | 914 | 914 | 5/5 |
| cold-open | long tasks | 0 | 0 | 0 | 0 | 5/5 |
| cold-open | long task ms | 0 | 0 | 0 | 0 | 5/5 |
| cold-open | heap MB | 1.9 | 1.9 | 1.9 | 2 | 5/5 |
| warm-open | html ms | 2 | 3 | 1.9 | 4.2 | 5/5 |
| warm-open | scripts ms | 26.1 | 45.4 | 21.6 | 58.1 | 5/5 |
| warm-open | bootstrap ms | 286 | 309 | 283 | 331 | 5/5 |
| warm-open | paint ms | 55.8 | 77.9 | 55.9 | 103 | 5/5 |
| warm-open | socket ms | 156 | 177 | 156 | 193 | 5/5 |
| warm-open | rows ms | 283 | 305 | 281 | 327 | 5/5 |
| warm-open | requests | 60 | 60 | 60 | 60 | 5/5 |
| warm-open | cached | 59 | 59 | 59 | 59 | 5/5 |
| warm-open | KB | 2.9 | 2.9 | 2.3 | 2.3 | 5/5 |
| warm-open | wire requests | 2 | 2 | 2 | 2 | 5/5 |
| warm-open | wire KB | 28.7 | 35.2 | 28.1 | 28.1 | 5/5 |
| warm-open | long tasks | 0 | 0 | 0 | 0 | 5/5 |
| warm-open | long task ms | 0 | 0 | 0 | 0 | 5/5 |
| warm-open | heap MB | 1.9 | 2.2 | 1.9 | 2.1 | 5/5 |

## lan (no proxy: the server and the page)

Journeys: cold-open, warm-open.

| journey | metric | A: main | B: E01-compression-optimal | Δ | Δ % |
| --- | --- | --: | --: | --: | --: |
| cold-open | html ms | 3.3 | 4.7 | +1.4 | +42.4% |
| cold-open | scripts ms | 70.9 | 71.8 | +0.9 | +1.3% |
| cold-open | bootstrap ms | 87.2 | 88.7 | +1.5 | +1.7% |
| cold-open | paint ms | 156 | 164 | +8.2 | +5.3% |
| cold-open | socket ms | 118 | 135 | +16.6 | +14.1% |
| cold-open | rows ms | 156 | 164 | +8.2 | +5.3% |
| cold-open | requests | 60 | 60 | +0 | +0.0% |
| cold-open | cached | 0 | 0 | +0 | — |
| cold-open | KB | 815 | 739 | -75.5 | -9.3% |
| cold-open | long tasks | 0 | 0 | +0 | — |
| cold-open | long task ms | 0 | 0 | +0 | — |
| cold-open | heap MB | 1.9 | 1.9 | +0 | +0.0% |
| warm-open | html ms | 2.5 | 2.5 | +0 | +0.0% |
| warm-open | scripts ms | 26.3 | 46.2 | +19.9 | +75.7% |
| warm-open | bootstrap ms | 97.7 | 104 | +6.6 | +6.8% |
| warm-open | paint ms | 64.8 | 86 | +21.2 | +32.7% |
| warm-open | socket ms | 36.6 | 57.2 | +20.6 | +56.3% |
| warm-open | rows ms | 83.7 | 96 | +12.3 | +14.7% |
| warm-open | requests | 60 | 60 | +0 | +0.0% |
| warm-open | cached | 59 | 59 | +0 | +0.0% |
| warm-open | KB | 2.9 | 2.3 | -0.6 | -20.7% |
| warm-open | long tasks | 0 | 0 | +0 | — |
| warm-open | long task ms | 0 | 0 | +0 | — |
| warm-open | heap MB | 2.1 | 2.1 | +0 | +0.0% |

Spread (lan): min and max of every sample, n samples per side.

| journey | metric | A min | A max | B min | B max | n |
| --- | --- | --: | --: | --: | --: | --: |
| cold-open | html ms | 3.1 | 4.3 | 4.3 | 4.8 | 5/5 |
| cold-open | scripts ms | 65.8 | 75.8 | 65.2 | 87.9 | 5/5 |
| cold-open | bootstrap ms | 84.3 | 92.4 | 84.7 | 105 | 5/5 |
| cold-open | paint ms | 147 | 171 | 149 | 188 | 5/5 |
| cold-open | socket ms | 114 | 130 | 117 | 142 | 5/5 |
| cold-open | rows ms | 147 | 171 | 149 | 188 | 5/5 |
| cold-open | requests | 60 | 60 | 60 | 60 | 5/5 |
| cold-open | cached | 0 | 0 | 0 | 0 | 5/5 |
| cold-open | KB | 815 | 815 | 739 | 739 | 5/5 |
| cold-open | long tasks | 0 | 0 | 0 | 0 | 5/5 |
| cold-open | long task ms | 0 | 0 | 0 | 0 | 5/5 |
| cold-open | heap MB | 1.9 | 2 | 1.9 | 1.9 | 5/5 |
| warm-open | html ms | 2.3 | 2.6 | 2 | 2.6 | 5/5 |
| warm-open | scripts ms | 25.5 | 53.9 | 24.4 | 50.8 | 5/5 |
| warm-open | bootstrap ms | 84.9 | 142 | 98.3 | 173 | 5/5 |
| warm-open | paint ms | 57.6 | 97.7 | 66.9 | 112 | 5/5 |
| warm-open | socket ms | 35.9 | 74.2 | 41.8 | 65.9 | 5/5 |
| warm-open | rows ms | 75.8 | 130 | 86.7 | 153 | 5/5 |
| warm-open | requests | 60 | 60 | 60 | 60 | 5/5 |
| warm-open | cached | 59 | 59 | 59 | 59 | 5/5 |
| warm-open | KB | 2.9 | 2.9 | 2.3 | 2.3 | 5/5 |
| warm-open | long tasks | 0 | 0 | 0 | 0 | 5/5 |
| warm-open | long task ms | 0 | 0 | 0 | 0 | 5/5 |
| warm-open | heap MB | 1.9 | 2.1 | 1.9 | 2.2 | 5/5 |

All runs ended.
