# Yap responsiveness: A = main, B = E04-etag

2026-11-04 12:01 UTC. Wall time 4 min 11 s. 5 repetitions.

- A (main): /home/agent/yap-perf/harness, cb074cfa Tests: perf.mjs measures how responsive Yap feels, build A against build B; the server answered 3140 ms after its start (the seed loads into memory first).
- B (E04-etag): /home/agent/yap-perf/exp/04-etag-page-worker, b8d5199f Shell: the page and the worker carry an ETag, so a revalidation is a 304; the server answered 3138 ms after its start (the seed loads into memory first).
- Seed: 50000 messages, 2814 reactions, 50 pictures, 20 GIFs (/home/agent/yap-perf/seed, built 2026-11-04T09:55:06.645Z). The person: ada.
- Times in ms. Opens: phases from the navigation start; the other journeys: from the click, the key or the scroll, in the page's clock.

## far (900 ms round trip, 1 Mbit/s)

Journeys: warm-open, cold-open.

| journey | metric | A: main | B: E04-etag | Δ | Δ % |
| --- | --- | --: | --: | --: | --: |
| warm-open | html ms | 2.6 | 2.7 | +0.1 | +3.8% |
| warm-open | scripts ms | 28 | 32 | +4 | +14.3% |
| warm-open | bootstrap ms | 3012 | 3010 | -1.2 | -0.0% |
| warm-open | paint ms | 64 | 68.9 | +4.9 | +7.7% |
| warm-open | socket ms | 1851 | 1852 | +1 | +0.1% |
| warm-open | rows ms | 3008 | 3007 | -1.3 | -0.0% |
| warm-open | requests | 60 | 60 | +0 | +0.0% |
| warm-open | cached | 59 | 59 | +0 | +0.0% |
| warm-open | KB | 2.9 | 2.9 | +0 | +0.0% |
| warm-open | wire requests | 3 | 3 | +0 | +0.0% |
| warm-open | wire KB | 35.7 | 29.4 | -6.3 | -17.6% |
| warm-open | long tasks | 0 | 0 | +0 | — |
| warm-open | long task ms | 0 | 0 | +0 | — |
| warm-open | heap MB | 2.1 | 2.2 | +0.1 | +4.8% |
| cold-open | html ms | 1194 | 1122 | -72 | -6.0% |
| cold-open | scripts ms | 13681 | 13621 | -60 | -0.4% |
| cold-open | bootstrap ms | 14705 | 14647 | -58.7 | -0.4% |
| cold-open | paint ms | 18258 | 18149 | -109 | -0.6% |
| cold-open | socket ms | 16905 | 16800 | -105 | -0.6% |
| cold-open | rows ms | 18258 | 18149 | -109 | -0.6% |
| cold-open | requests | 60 | 60 | +0 | +0.0% |
| cold-open | cached | 0 | 0 | +0 | — |
| cold-open | KB | 815 | 806 | -8.7 | -1.1% |
| cold-open | wire requests | 72 | 72 | +0 | +0.0% |
| cold-open | wire KB | 1007 | 988 | -18.4 | -1.8% |
| cold-open | long tasks | 0 | 0 | +0 | — |
| cold-open | long task ms | 0 | 0 | +0 | — |
| cold-open | heap MB | 1.9 | 1.9 | +0 | +0.0% |

Spread (far): min and max of every sample, n samples per side.

| journey | metric | A min | A max | B min | B max | n |
| --- | --- | --: | --: | --: | --: | --: |
| warm-open | html ms | 2.4 | 3.5 | 2.5 | 3.3 | 5/5 |
| warm-open | scripts ms | 21 | 97.2 | 22 | 110 | 5/5 |
| warm-open | bootstrap ms | 3003 | 3090 | 3005 | 3088 | 5/5 |
| warm-open | paint ms | 58.6 | 160 | 61.3 | 143 | 5/5 |
| warm-open | socket ms | 1842 | 1926 | 1847 | 1928 | 5/5 |
| warm-open | rows ms | 3000 | 3085 | 3002 | 3085 | 5/5 |
| warm-open | requests | 60 | 60 | 60 | 60 | 5/5 |
| warm-open | cached | 59 | 59 | 59 | 59 | 5/5 |
| warm-open | KB | 2.9 | 2.9 | 2.9 | 2.9 | 5/5 |
| warm-open | wire requests | 3 | 3 | 3 | 3 | 5/5 |
| warm-open | wire KB | 35.7 | 35.7 | 29.4 | 29.4 | 5/5 |
| warm-open | long tasks | 0 | 0 | 0 | 0 | 5/5 |
| warm-open | long task ms | 0 | 0 | 0 | 0 | 5/5 |
| warm-open | heap MB | 2 | 2.1 | 2 | 2.2 | 5/5 |
| cold-open | html ms | 1190 | 1200 | 1119 | 1126 | 5/5 |
| cold-open | scripts ms | 13427 | 13739 | 13608 | 13658 | 5/5 |
| cold-open | bootstrap ms | 14449 | 14766 | 14625 | 14687 | 5/5 |
| cold-open | paint ms | 18031 | 18318 | 18093 | 18185 | 5/5 |
| cold-open | socket ms | 16646 | 16956 | 16757 | 16808 | 5/5 |
| cold-open | rows ms | 18031 | 18318 | 18093 | 18185 | 5/5 |
| cold-open | requests | 60 | 60 | 60 | 60 | 5/5 |
| cold-open | cached | 0 | 0 | 0 | 0 | 5/5 |
| cold-open | KB | 815 | 815 | 806 | 806 | 5/5 |
| cold-open | wire requests | 72 | 72 | 72 | 72 | 5/5 |
| cold-open | wire KB | 1006 | 1007 | 987 | 988 | 5/5 |
| cold-open | long tasks | 0 | 0 | 0 | 0 | 5/5 |
| cold-open | long task ms | 0 | 0 | 0 | 0 | 5/5 |
| cold-open | heap MB | 1.9 | 1.9 | 1.9 | 1.9 | 5/5 |

## near (60 ms round trip, 20 Mbit/s)

Journeys: warm-open, cold-open.

| journey | metric | A: main | B: E04-etag | Δ | Δ % |
| --- | --- | --: | --: | --: | --: |
| warm-open | html ms | 2.4 | 2.7 | +0.3 | +12.5% |
| warm-open | scripts ms | 26.5 | 28.5 | +2 | +7.5% |
| warm-open | bootstrap ms | 296 | 299 | +3.1 | +1.0% |
| warm-open | paint ms | 58.3 | 68.1 | +9.8 | +16.8% |
| warm-open | socket ms | 161 | 168 | +7.3 | +4.5% |
| warm-open | rows ms | 292 | 296 | +3.7 | +1.3% |
| warm-open | requests | 60 | 60 | +0 | +0.0% |
| warm-open | cached | 59 | 59 | +0 | +0.0% |
| warm-open | KB | 2.9 | 2.9 | +0 | +0.0% |
| warm-open | wire requests | 2 | 2 | +0 | +0.0% |
| warm-open | wire KB | 28.7 | 28.7 | +0 | +0.0% |
| warm-open | long tasks | 0 | 0 | +0 | — |
| warm-open | long task ms | 0 | 0 | +0 | — |
| warm-open | heap MB | 2.1 | 2.1 | +0 | +0.0% |
| cold-open | html ms | 80.3 | 76.2 | -4.1 | -5.1% |
| cold-open | scripts ms | 981 | 950 | -31.4 | -3.2% |
| cold-open | bootstrap ms | 1078 | 1075 | -3 | -0.3% |
| cold-open | paint ms | 1379 | 1350 | -28.8 | -2.1% |
| cold-open | socket ms | 1235 | 1214 | -20.9 | -1.7% |
| cold-open | rows ms | 1379 | 1350 | -28.8 | -2.1% |
| cold-open | requests | 60 | 60 | +0 | +0.0% |
| cold-open | cached | 0 | 0 | +0 | — |
| cold-open | KB | 815 | 806 | -8.7 | -1.1% |
| cold-open | wire requests | 72 | 72 | +0 | +0.0% |
| cold-open | wire KB | 1007 | 988 | -18.4 | -1.8% |
| cold-open | long tasks | 0 | 0 | +0 | — |
| cold-open | long task ms | 0 | 0 | +0 | — |
| cold-open | heap MB | 1.9 | 1.9 | +0 | +0.0% |

Spread (near): min and max of every sample, n samples per side.

| journey | metric | A min | A max | B min | B max | n |
| --- | --- | --: | --: | --: | --: | --: |
| warm-open | html ms | 2 | 3.1 | 2.3 | 5.1 | 5/5 |
| warm-open | scripts ms | 24.8 | 64.3 | 20 | 49 | 5/5 |
| warm-open | bootstrap ms | 289 | 331 | 284 | 321 | 5/5 |
| warm-open | paint ms | 57.3 | 97.9 | 52.6 | 79.7 | 5/5 |
| warm-open | socket ms | 159 | 198 | 155 | 182 | 5/5 |
| warm-open | rows ms | 286 | 328 | 281 | 317 | 5/5 |
| warm-open | requests | 60 | 60 | 60 | 60 | 5/5 |
| warm-open | cached | 59 | 59 | 59 | 59 | 5/5 |
| warm-open | KB | 2.9 | 2.9 | 2.9 | 2.9 | 5/5 |
| warm-open | wire requests | 2 | 2 | 2 | 2 | 5/5 |
| warm-open | wire KB | 28.7 | 28.7 | 28.7 | 28.7 | 5/5 |
| warm-open | long tasks | 0 | 0 | 0 | 0 | 5/5 |
| warm-open | long task ms | 0 | 0 | 0 | 0 | 5/5 |
| warm-open | heap MB | 1.9 | 2.1 | 1.9 | 2.1 | 5/5 |
| cold-open | html ms | 77.5 | 81.5 | 75.5 | 80.6 | 5/5 |
| cold-open | scripts ms | 954 | 1075 | 933 | 1044 | 5/5 |
| cold-open | bootstrap ms | 1049 | 1194 | 1016 | 1164 | 5/5 |
| cold-open | paint ms | 1352 | 1476 | 1303 | 1447 | 5/5 |
| cold-open | socket ms | 1193 | 1341 | 1157 | 1304 | 5/5 |
| cold-open | rows ms | 1352 | 1476 | 1303 | 1447 | 5/5 |
| cold-open | requests | 60 | 60 | 60 | 60 | 5/5 |
| cold-open | cached | 0 | 1 | 0 | 1 | 5/5 |
| cold-open | KB | 770 | 815 | 761 | 806 | 5/5 |
| cold-open | wire requests | 72 | 73 | 72 | 73 | 5/5 |
| cold-open | wire KB | 1007 | 1007 | 988 | 989 | 5/5 |
| cold-open | long tasks | 0 | 0 | 0 | 0 | 5/5 |
| cold-open | long task ms | 0 | 0 | 0 | 0 | 5/5 |
| cold-open | heap MB | 1.9 | 1.9 | 1.9 | 1.9 | 5/5 |

All runs ended.
