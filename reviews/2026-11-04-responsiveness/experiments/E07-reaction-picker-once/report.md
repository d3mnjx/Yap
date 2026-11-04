# Yap responsiveness: A = main, B = E07-reaction-picker

2026-11-04 12:28 UTC. Wall time 12 min 37 s. 5 repetitions.

- A (main): /home/agent/yap-perf/harness, 345de009 Tests: picker-reaction times five reaction picker opens on one page, and counts the cells they build; the server answered 3135 ms after its start (the seed loads into memory first).
- B (E07-reaction-picker): /home/agent/yap-perf/exp/07-reaction-picker-once, c4ffb2fa Reactions: the emoji picker is built once per page and moves to the row of each open; the server answered 2876 ms after its start (the seed loads into memory first).
- Seed: 50000 messages, 2814 reactions, 50 pictures, 20 GIFs (/home/agent/yap-perf/seed, built 2026-11-04T09:55:06.645Z). The person: ada.
- Times in ms. Opens: phases from the navigation start; the other journeys: from the click, the key or the scroll, in the page's clock.

## lan (no proxy: the server and the page)

Journeys: picker-reaction, phone-picker-reaction.

| journey | metric | A: main | B: E07-reaction-picker | Δ | Δ % |
| --- | --- | --: | --: | --: | --: |
| picker-reaction | open 1: grid | 28.4 | 32 | +3.6 | +12.7% |
| picker-reaction | open 2: grid | 112 | 7.4 | -104 | -93.4% |
| picker-reaction | open 3: grid | 49.4 | 7.6 | -41.8 | -84.6% |
| picker-reaction | open 4: grid | 47.5 | 7.6 | -39.9 | -84.0% |
| picker-reaction | open 5: grid | 48 | 8.2 | -39.8 | -82.9% |
| picker-reaction | later opens: grid | 49.6 | 7.5 | -42.1 | -84.9% |
| picker-reaction | cells built | 5040 | 1008 | -4032 | -80.0% |
| picker-reaction | long tasks | 2 | 1 | -1 | -50.0% |
| picker-reaction | long task ms | 187 | 63 | -124 | -66.3% |
| phone-picker-reaction | open 1: grid | 138 | 136 | -1.7 | -1.2% |
| phone-picker-reaction | open 2: grid | 1091 | 47.8 | -1043 | -95.6% |
| phone-picker-reaction | open 3: grid | 416 | 63.8 | -352 | -84.6% |
| phone-picker-reaction | open 4: grid | 336 | 52.2 | -284 | -84.5% |
| phone-picker-reaction | open 5: grid | 323 | 49.2 | -273 | -84.7% |
| phone-picker-reaction | later opens: grid | 423 | 48.5 | -374 | -88.5% |
| phone-picker-reaction | cells built | 5040 | 1008 | -4032 | -80.0% |
| phone-picker-reaction | long tasks | 12 | 7 | -5 | -41.7% |
| phone-picker-reaction | long task ms | 3046 | 812 | -2234 | -73.3% |

Spread (lan): min and max of every sample, n samples per side.

| journey | metric | A min | A max | B min | B max | n |
| --- | --- | --: | --: | --: | --: | --: |
| picker-reaction | open 1: grid | 25.9 | 40.5 | 24.2 | 59.1 | 5/5 |
| picker-reaction | open 2: grid | 107 | 137 | 6.9 | 7.6 | 5/5 |
| picker-reaction | open 3: grid | 46.4 | 61.9 | 7 | 8 | 5/5 |
| picker-reaction | open 4: grid | 45.6 | 54.5 | 6.7 | 8.7 | 5/5 |
| picker-reaction | open 5: grid | 47.2 | 49.8 | 7 | 8.4 | 5/5 |
| picker-reaction | later opens: grid | 47.5 | 58.2 | 7 | 8.2 | 5/5 |
| picker-reaction | cells built | 5040 | 5040 | 1008 | 1008 | 5/5 |
| picker-reaction | long tasks | 2 | 3 | 0 | 2 | 5/5 |
| picker-reaction | long task ms | 164 | 210 | 0 | 129 | 5/5 |
| phone-picker-reaction | open 1: grid | 114 | 151 | 131 | 165 | 5/5 |
| phone-picker-reaction | open 2: grid | 902 | 1479 | 39.5 | 49.7 | 5/5 |
| phone-picker-reaction | open 3: grid | 293 | 745 | 46.5 | 66.8 | 5/5 |
| phone-picker-reaction | open 4: grid | 314 | 492 | 36.8 | 75.1 | 5/5 |
| phone-picker-reaction | open 5: grid | 265 | 430 | 46.6 | 61.1 | 5/5 |
| phone-picker-reaction | later opens: grid | 304 | 619 | 43.1 | 62.5 | 5/5 |
| phone-picker-reaction | cells built | 5040 | 5040 | 1008 | 1008 | 5/5 |
| phone-picker-reaction | long tasks | 10 | 12 | 7 | 9 | 5/5 |
| phone-picker-reaction | long task ms | 2509 | 3443 | 694 | 1068 | 5/5 |

## near (60 ms round trip, 20 Mbit/s)

Journeys: picker-reaction, phone-picker-reaction.

| journey | metric | A: main | B: E07-reaction-picker | Δ | Δ % |
| --- | --- | --: | --: | --: | --: |
| picker-reaction | open 1: grid | 27.2 | 25.4 | -1.8 | -6.6% |
| picker-reaction | open 2: grid | 136 | 7.6 | -128 | -94.4% |
| picker-reaction | open 3: grid | 46.6 | 7.7 | -38.9 | -83.5% |
| picker-reaction | open 4: grid | 47 | 8.4 | -38.6 | -82.1% |
| picker-reaction | open 5: grid | 51.1 | 8 | -43.1 | -84.3% |
| picker-reaction | later opens: grid | 48.8 | 8 | -40.8 | -83.6% |
| picker-reaction | cells built | 5040 | 1008 | -4032 | -80.0% |
| picker-reaction | long tasks | 2 | 1 | -1 | -50.0% |
| picker-reaction | long task ms | 207 | 58 | -149 | -72.0% |
| phone-picker-reaction | open 1: grid | 150 | 129 | -21.2 | -14.1% |
| phone-picker-reaction | open 2: grid | 894 | 56 | -838 | -93.7% |
| phone-picker-reaction | open 3: grid | 352 | 59.9 | -292 | -83.0% |
| phone-picker-reaction | open 4: grid | 335 | 51.7 | -283 | -84.6% |
| phone-picker-reaction | open 5: grid | 315 | 52.3 | -263 | -83.4% |
| phone-picker-reaction | later opens: grid | 338 | 54.7 | -283 | -83.8% |
| phone-picker-reaction | cells built | 5040 | 1008 | -4032 | -80.0% |
| phone-picker-reaction | long tasks | 11 | 7 | -4 | -36.4% |
| phone-picker-reaction | long task ms | 2644 | 809 | -1835 | -69.4% |

Spread (near): min and max of every sample, n samples per side.

| journey | metric | A min | A max | B min | B max | n |
| --- | --- | --: | --: | --: | --: | --: |
| picker-reaction | open 1: grid | 25.7 | 30.9 | 23.7 | 37.6 | 5/5 |
| picker-reaction | open 2: grid | 95.1 | 171 | 6.2 | 9.9 | 5/5 |
| picker-reaction | open 3: grid | 44.5 | 73.6 | 7.6 | 12.7 | 5/5 |
| picker-reaction | open 4: grid | 44.7 | 49.3 | 7.4 | 10.7 | 5/5 |
| picker-reaction | open 5: grid | 45.6 | 58.5 | 7.5 | 8.4 | 5/5 |
| picker-reaction | later opens: grid | 46.3 | 62.7 | 7.6 | 9 | 5/5 |
| picker-reaction | cells built | 5040 | 5040 | 1008 | 1008 | 5/5 |
| picker-reaction | long tasks | 1 | 3 | 0 | 1 | 5/5 |
| picker-reaction | long task ms | 94 | 309 | 0 | 76 | 5/5 |
| phone-picker-reaction | open 1: grid | 142 | 208 | 122 | 149 | 5/5 |
| phone-picker-reaction | open 2: grid | 714 | 1076 | 41 | 66.4 | 5/5 |
| phone-picker-reaction | open 3: grid | 269 | 422 | 47.8 | 74.2 | 5/5 |
| phone-picker-reaction | open 4: grid | 258 | 519 | 45.3 | 66.5 | 5/5 |
| phone-picker-reaction | open 5: grid | 311 | 386 | 46.3 | 60.6 | 5/5 |
| phone-picker-reaction | later opens: grid | 325 | 438 | 46.6 | 66.1 | 5/5 |
| phone-picker-reaction | cells built | 5040 | 5040 | 1008 | 1008 | 5/5 |
| phone-picker-reaction | long tasks | 10 | 13 | 6 | 8 | 5/5 |
| phone-picker-reaction | long task ms | 2345 | 3089 | 766 | 858 | 5/5 |

All runs ended.
