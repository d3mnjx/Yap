# E08 phone probe: send on a phone (390x800, dpr 3, touch, CPU x4), no proxy

2026-11-04 12:22 UTC. 3 pages x 10 sends per side, sides alternating per page. Times in ms from the tap on Send (the click's time stamp), in the page's clock.

- A (main): /home/agent/yap-perf/harness, port 5313, PID 630334
- B (E08-send-confirm): /home/agent/yap-perf/exp/08-send-confirm-path, port 5314, PID 630415

| metric | A median | A min | A max | B median | B min | B max | Δ median | Δ % |
| --- | --: | --: | --: | --: | --: | --: | --: | --: |
| own row ms | 24.6 | 18.5 | 42.5 | 25.1 | 17.2 | 50.4 | +0.5 | +2.2% |
| confirmed ms | 52.4 | 44.1 | 79.4 | 54.4 | 34.7 | 112 | +2.0 | +3.9% |
| hub copy at ms | 49.1 | 41.7 | 76.2 | 52.1 | 34.1 | 102 | +2.9 | +5.9% |
| POST answer at ms | 32.2 | 24.7 | 53.4 | 32.4 | 28.2 | 59.6 | +0.3 | +0.8% |
| store add at ms | 51.7 | 43.1 | 78.1 | 53.4 | 34.5 | 111 | +1.7 | +3.3% |
| main thread busy ms (CDP TaskDuration) | 187 | 151 | 290 | 197 | 143 | 356 | +9.7 | +5.2% |
| script ms (CDP) | 11.5 | 8.0 | 23.5 | 12.6 | 7.5 | 30.4 | +1.1 | +9.8% |
| layout+style ms (CDP) | 36.2 | 23.3 | 61.2 | 37.6 | 23.5 | 59.7 | +1.5 | +4.0% |
| long tasks per send | 0 | 0 | 0 | 0 | 0 | 0 | +0 | — |
| long task ms per send | 0 | 0 | 0 | 0 | 0 | 0 | +0 | — |

| proof (count over the sends) | A | B |
| --- | --: | --: |
| confirmed row's node detached after both copies (replaced) | 30 of 30 | 0 of 30 |
| pending row's node detached after the confirmation | 30 of 30 | 30 of 30 |
| first watched node was the pending row | 30 of 30 | 30 of 30 |
| store 'replace' events for the own message (sends with at least one) | 30 of 30 | 0 of 30 |
| hub copy came before the POST answer's add | 30 of 30 | 30 of 30 |
