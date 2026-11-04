# Yap responsiveness: A = main, B = E08-send-confirm

2026-11-04 12:10 UTC. Wall time 1 min 9 s. 5 repetitions.

- A (main): /home/agent/yap-perf/harness, cb074cfa Tests: perf.mjs measures how responsive Yap feels, build A against build B; the server answered 2900 ms after its start (the seed loads into memory first).
- B (E08-send-confirm): /home/agent/yap-perf/exp/08-send-confirm-path, 59944dea Send: the own row confirms before the outbox delete, and an identical second copy draws nothing; the server answered 3129 ms after its start (the seed loads into memory first).
- Seed: 50000 messages, 2814 reactions, 50 pictures, 20 GIFs (/home/agent/yap-perf/seed, built 2026-11-04T09:55:06.645Z). The person: ada.
- Times in ms. Opens: phases from the navigation start; the other journeys: from the click, the key or the scroll, in the page's clock.

## near (60 ms round trip, 20 Mbit/s)

Journeys: send.

| journey | metric | A: main | B: E08-send-confirm | Δ | Δ % |
| --- | --- | --: | --: | --: | --: |
| send | own row ms | 1.4 | 1.4 | +0 | +0.0% |
| send | confirmed ms | 68.2 | 68.8 | +0.5 | +0.8% |

Spread (near): min and max of every sample, n samples per side.

| journey | metric | A min | A max | B min | B max | n |
| --- | --- | --: | --: | --: | --: | --: |
| send | own row ms | 0.8 | 34.9 | 0.9 | 24 | 50/50 |
| send | confirmed ms | 65.8 | 102 | 65.3 | 91 | 50/50 |

## lan (no proxy: the server and the page)

Journeys: send.

| journey | metric | A: main | B: E08-send-confirm | Δ | Δ % |
| --- | --- | --: | --: | --: | --: |
| send | own row ms | 1.3 | 1.3 | +0 | +0.0% |
| send | confirmed ms | 4.7 | 4.8 | +0.2 | +4.3% |

Spread (lan): min and max of every sample, n samples per side.

| journey | metric | A min | A max | B min | B max | n |
| --- | --- | --: | --: | --: | --: | --: |
| send | own row ms | 1 | 7.5 | 1 | 2.8 | 50/50 |
| send | confirmed ms | 3.4 | 12.4 | 3.3 | 17.1 | 50/50 |

All runs ended.
