# E08 send-confirm-path: measurement

A = main (harness worktree, cb074cfa = main 7f149be4 plus the test files). B = `perf/08-send-confirm-path` (59944dea).
Measured 2026-11-04 by the measurement agent.

## The change

`store.js` `addMessage` does nothing when the message is already in the conversation with the same JSON. Before, the
second copy of an own message (the POST answer or the hub's `message` event, whichever came second) always called
`replaceMessage`, and the timeline redrew the own row. `sender.js` also adds the confirmed message and publishes
before the outbox row's IndexedDB delete, not after its commit.

## Commands

```
cd /d/PROJECTS/Yap && git worktree add /home/agent/yap-perf/exp/08-send-confirm-path perf/08-send-confirm-path
cd /home/agent/yap-perf/exp/08-send-confirm-path/Yap && dotnet build

cd /home/agent/yap-perf/harness/tests/browser
node perf.mjs --a=/home/agent/yap-perf/harness:main --b=/home/agent/yap-perf/exp/08-send-confirm-path:E08-send-confirm --n=5 --profiles=near,lan --journeys=send --out=/home/agent/yap-perf/results/E08-send-confirm-path --port-a=5311 --port-b=5312
# the same command once more, --out=/home/agent/yap-perf/results/E08-send-confirm-path/repeat-2 (a run takes 1 min 9 s)

# phone probe (servers on 5313 and 5314, stopped by PID), then the cost of one replace alone (server on 5313)
node /home/agent/yap-perf/results/E08-send-confirm-path/phone-probe.mjs
node /home/agent/yap-perf/results/E08-send-confirm-path/replace-cost.mjs
# the two harness runs pooled
node /home/agent/yap-perf/results/E08-send-confirm-path/pool.mjs /home/agent/yap-perf/results/E08-send-confirm-path/runs.json /home/agent/yap-perf/results/E08-send-confirm-path/repeat-2/runs.json
```

## Harness: send journey, desktop (1440x900), n=5, 10 sends per run (50 samples per side)

Run 1 (`report.md`, wall time 1 min 9 s):

| profile | metric | A | B | Δ ms | Δ % | A min..max | B min..max |
| --- | --- | --: | --: | --: | --: | --: | --: |
| near | own row ms | 1.3 | 1.3 | 0 | 0.0% | 1..26.1 | 1..10.7 |
| near | confirmed ms | 68.4 | 67.9 | -0.5 | -0.7% | 65.8..94.4 | 65.8..81.5 |
| lan | own row ms | 1.5 | 1.4 | -0.1 | -6.7% | 0.9..10.7 | 1..4.2 |
| lan | confirmed ms | 5.8 | 4.8 | -1.0 | -16.4% | 3.2..18.5 | 3.2..9.8 |

Run 2 (`repeat-2/report.md`, wall time 1 min 9 s):

| profile | metric | A | B | Δ ms | Δ % | A min..max | B min..max |
| --- | --- | --: | --: | --: | --: | --: | --: |
| near | own row ms | 1.4 | 1.4 | 0 | 0.0% | 0.8..34.9 | 0.9..24 |
| near | confirmed ms | 68.2 | 68.8 | +0.5 | +0.8% | 65.8..102 | 65.3..91 |
| lan | own row ms | 1.3 | 1.3 | 0 | 0.0% | 1..7.5 | 1..2.8 |
| lan | confirmed ms | 4.7 | 4.8 | +0.2 | +4.3% | 3.4..12.4 | 3.3..17.1 |

Both runs pooled (100 samples per side, Mann-Whitney z, |z| < 1.96 is no difference at 5%):

| profile | metric | A median | B median | Δ ms | z |
| --- | --- | --: | --: | --: | --: |
| near | confirmed ms | 68.25 | 68.35 | +0.10 | -0.38 |
| lan | own row ms | 1.40 | 1.30 | -0.10 | 1.33 |
| lan | confirmed ms | 5.30 | 4.85 | -0.45 | 1.75 |

The `send` journey reports no long tasks and no heap, so the report has no such rows. The -16.4% on `lan` in run 1
did not repeat (+4.3% in run 2). Every delta is inside the noise of the instrument (`near` 1.5%, `lan` and values
under 100 ms 5 to 17%).

## Phone probe: send on a phone, no proxy

`phone-probe.mjs`: 390x800, dpr 3, isMobile, hasTouch, CPU x4 (CDP `Emulation.setCPUThrottlingRate`). Per side 3
pages x 10 sends, sides alternating per page (A B B A A B), 1.5 s between sends. A phone sends with the Send button
(on a touch device Enter is a new line, IB-11), so t0 is the click's time stamp of the tap. Busy time and long tasks
cover the tap to 300 ms after both copies arrived. Results in `phone-probe/phone-probe.md` and `.json`.

| metric | A median | A min..max | B median | B min..max | Δ ms | Δ % |
| --- | --: | --: | --: | --: | --: | --: |
| own row ms | 24.6 | 18.5..42.5 | 25.1 | 17.2..50.4 | +0.5 | +2.2% |
| confirmed ms | 52.4 | 44.1..79.4 | 54.4 | 34.7..112 | +2.0 | +3.9% |
| hub copy at ms | 49.1 | 41.7..76.2 | 52.1 | 34.1..102 | +2.9 | +5.9% |
| POST responseEnd at ms | 32.2 | 24.7..53.4 | 32.4 | 28.2..59.6 | +0.3 | +0.8% |
| main thread busy ms (CDP TaskDuration) | 187 | 151..290 | 197 | 143..356 | +9.7 | +5.2% |
| script ms (CDP) | 11.5 | 8.0..23.5 | 12.6 | 7.5..30.4 | +1.1 | +9.8% |
| layout+style ms (CDP) | 36.2 | 23.3..61.2 | 37.6 | 23.5..59.7 | +1.5 | +4.0% |
| long tasks per send | 0 | 0..0 | 0 | 0..0 | 0 | |

Per page, B's first page was the slow one (confirmed 59.6, busy 224.5); on pages 2 and 3, B agrees with A within 1.3 ms
on confirmed and within 2 ms on busy time (confirmed A 52.4 / 51.1, B 51.1 / 50.6; busy A 189.5 / 176.8, B 191.5 / 177.6).

The cost of one replace alone (`replace-cost.mjs`, `phone-probe/replace-cost.md`): the same phone, build A, an own
row replaced by an identical copy 20 times. The synchronous redraw takes 2.45 ms (1.80..3.90), the forced style and
layout after it 4.35 ms (1.70..6.60), together 6.80 ms (3.90..10.50). Paint is not counted. A forced layout without a
replace takes 0.00 ms.

## Proof of mechanism

The probe keeps the node of the pending row (the first row with the text) and the node of the confirmed row (the
first row without `.pending` with the text). It checks `isConnected` for both 300 ms after both copies arrived, and
counts the store's `messages` events of type `replace` for the message's id.

| over 30 sends per side | A | B |
| --- | --: | --: |
| confirmed row's node detached (replaced by the second copy) | 30 of 30 | 0 of 30 |
| store `replace` events for the own message | 30 of 30 sends | 0 of 30 sends |
| pending row's node detached after the confirmation | 30 of 30 | 30 of 30 |
| the hub's copy confirmed the row (came before the POST answer's add) | 30 of 30 | 30 of 30 |

The pending node leaves on both sides: the timeline draws the confirmed row as a new node and `onPending` removes the
pending nodes. So the check of the pending node alone cannot tell A from B; the confirmed node does. On A the
replace runs a median 19.9 ms (6.2..54.0) after the confirmation, 72 ms after the tap.

## Verdict

No gain that a person feels, and every delta is inside the noise. On the desktop the confirmation moves -0.5 / +0.5 ms
on `near` and -1.0 / +0.2 ms on `lan` in two runs (pooled -0.45 ms, z 1.75). On the slow phone it moves +2.0 ms
(+3.9%), also noise. The mechanism works: B draws the own row once per send, A twice. The work B saves is one row
redraw, about 7 ms of main thread on a phone with CPU x4 (about a quarter of that on a desktop). That work runs about
20 ms after the confirmation, so it never delayed the confirmation, and the probe cannot separate 7 ms from the 150 to
350 ms of other main-thread work around each send. The phone user gains a few ms of main thread per send; nobody
sees it in these numbers.

## Caveats

- The hub's copy confirmed the row in 60 of 60 phone sends. The POST answer's body ends about 17 ms earlier, but its
  add came later. So the `sender.js` reorder (the add before the IndexedDB delete) did not move `confirmed` in this
  setup: the POST path was never the first copy. The harness does not record which copy wins on the desktop. On a
  link where the POST answer wins, the reorder can matter; no profile here showed it.
- The sent texts have no emoji. The commit names emoji images (a worker request per image on WebKit) as a cost of
  each redraw. Chromium is not WebKit, and these rows have only the avatar, so that part of the saving is not
  measured.
- The probe waits 1.5 s between sends (the harness waits 200 ms), so the conversation snapshot (800 ms after the last
  change) runs between the measured windows. A burst of sends would overlap the work more.
- Other measurement agents ran on this machine at the same time. B's first phone page was slower than the others.
- The probe imports `instruments` and `warmUp` from the live `perf-journeys.mjs`. During the probe the harness moved
  from cb074cfa to 345de009 (another agent added `picker-reaction`); that commit only adds lines and leaves those two
  functions unchanged.
- The phone probe's first shake-out pressed Enter and sent nothing (Enter is a new line on touch). The probe was
  changed to tap Send before the measured run. No measured run failed; no port was changed.
