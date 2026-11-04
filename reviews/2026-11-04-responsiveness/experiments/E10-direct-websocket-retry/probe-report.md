# E10 probe: resume after a server outage, A = main, B = E10-ws-retry

2026-11-04 12:48 UTC. Wall time 23 min 37 s. 5 outage runs and 2 control runs per profile, two resumes per run.

- A (main): /home/agent/yap-perf/harness, 345de009 Tests: picker-reaction times five reaction picker opens on one page, and counts the cells they build; server starts 3144, 3387, 3635, 3374, 4389, 3890, 3380, 3123, 3124, 3132, 5781 ms.
- B (E10-ws-retry): /home/agent/yap-perf/exp/10-direct-websocket-retry, 920c7405 Hub: the next connect goes direct again after both attempts failed; server starts 3143, 3393, 3634, 3133, 4633, 3641, 3631, 3121, 3130, 2874, 5827 ms.
- The page: ada, /room/f9ef334e-8ce8-49c0-a287-daac4293a9dc (pets, 200 messages); the poster: ben.
- negotiate: POST /hub/negotiate requests per sample, in run order (for the reconnect: the ones that got a 200).

## far

| metric | A median | B median | A min–max | B min–max | n A/B | Δ ms | Δ % | negotiate A | negotiate B |
| --- | --: | --: | --: | --: | --: | --: | --: | --- | --- |
| resume after outage: rows ms (both resumes) | 4005 | 3086 | 3999–4025 | 3077–3098 | 10/10 | -919 | -22.9% | 1 1 1 1 1 1 1 1 1 1 | 0 0 0 0 0 0 0 0 0 0 |
| resume after outage: rows ms, resume 1 | 4006 | 3084 | 4003–4025 | 3077–3098 | 5/5 | -922 | -23.0% | 1 1 1 1 1 | 0 0 0 0 0 |
| resume after outage: rows ms, resume 2 | 4004 | 3088 | 3999–4012 | 3078–3090 | 5/5 | -915 | -22.9% | 1 1 1 1 1 | 0 0 0 0 0 |
| control resume: rows ms (both resumes) | 3085 | 3080 | 3073–3090 | 3073–3093 | 4/4 | -5 | -0.2% | 0 0 0 0 | 0 0 0 0 |
| server back to connected ms (secondary) | 5034 | 4195 | 4279–5322 | 3169–4613 | 5/5 | -839 | -16.7% | 1 1 1 1 1 | 0 0 0 0 0 |

## near

| metric | A median | B median | A min–max | B min–max | n A/B | Δ ms | Δ % | negotiate A | negotiate B |
| --- | --: | --: | --: | --: | --: | --: | --: | --- | --- |
| resume after outage: rows ms (both resumes) | 358 | 303 | 334–389 | 261–311 | 10/10 | -55 | -15.4% | 1 1 1 1 1 1 1 1 1 1 | 0 0 0 0 0 0 0 0 0 0 |
| resume after outage: rows ms, resume 1 | 369 | 306 | 349–373 | 297–311 | 5/5 | -63 | -17.1% | 1 1 1 1 1 | 0 0 0 0 0 |
| resume after outage: rows ms, resume 2 | 344 | 274 | 334–389 | 261–310 | 5/5 | -71 | -20.5% | 1 1 1 1 1 | 0 0 0 0 0 |
| control resume: rows ms (both resumes) | 273 | 271 | 269–286 | 267–287 | 4/4 | -3 | -1.0% | 0 0 0 0 | 0 0 0 0 |
| server back to connected ms (secondary) | 3060 | 2871 | 329–3074 | 140–3179 | 5/5 | -189 | -6.2% | 1 1 1 1 1 | 0 0 0 0 0 |

All runs ended.
