# Yap responsiveness: A = main, B = E08-send-confirm

2026-11-04 12:08 UTC. Wall time 1 min 9 s. 5 repetitions.

- A (main): /home/agent/yap-perf/harness, cb074cfa Tests: perf.mjs measures how responsive Yap feels, build A against build B; the server answered 3135 ms after its start (the seed loads into memory first).
- B (E08-send-confirm): /home/agent/yap-perf/exp/08-send-confirm-path, 59944dea Send: the own row confirms before the outbox delete, and an identical second copy draws nothing; the server answered 3128 ms after its start (the seed loads into memory first).
- Seed: 50000 messages, 2814 reactions, 50 pictures, 20 GIFs (/home/agent/yap-perf/seed, built 2026-11-04T09:55:06.645Z). The person: ada.
- Times in ms. Opens: phases from the navigation start; the other journeys: from the click, the key or the scroll, in the page's clock.

## near (60 ms round trip, 20 Mbit/s)

Journeys: send.

| journey | metric | A: main | B: E08-send-confirm | Δ | Δ % |
| --- | --- | --: | --: | --: | --: |
| send | own row ms | 1.3 | 1.3 | +0 | +0.0% |
| send | confirmed ms | 68.4 | 67.9 | -0.5 | -0.7% |

Spread (near): min and max of every sample, n samples per side.

| journey | metric | A min | A max | B min | B max | n |
| --- | --- | --: | --: | --: | --: | --: |
| send | own row ms | 1 | 26.1 | 1 | 10.7 | 50/50 |
| send | confirmed ms | 65.8 | 94.4 | 65.8 | 81.5 | 50/50 |

## lan (no proxy: the server and the page)

Journeys: send.

| journey | metric | A: main | B: E08-send-confirm | Δ | Δ % |
| --- | --- | --: | --: | --: | --: |
| send | own row ms | 1.5 | 1.4 | -0.1 | -6.7% |
| send | confirmed ms | 5.8 | 4.8 | -1.0 | -16.4% |

Spread (lan): min and max of every sample, n samples per side.

| journey | metric | A min | A max | B min | B max | n |
| --- | --- | --: | --: | --: | --: | --: |
| send | own row ms | 0.9 | 10.7 | 1 | 4.2 | 50/50 |
| send | confirmed ms | 3.2 | 18.5 | 3.2 | 9.8 | 50/50 |

All runs ended.
