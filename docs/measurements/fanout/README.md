# Server fan-out measurements

Measured locally on 2026-10-10 using [the committed .NET SignalR harness](../../../tests/FanoutLoad/README.md). The [sanitized results](results.json) include publish DLL hashes and all numerical counters. Baseline `a3cb057` retains the reviewed `8231ef4` fan-out implementation; its intervening change concerns login-link origins.

Each fixture started with 50 synthetic users and five public rooms containing 100 messages each. The clients registered presence and subscribed to both streams; one sender posted two messages/second. Each case had ten warm-up sends and 30 measured sends. Processes were warmed before collecting the table; early startup/JIT exploratory runs are excluded. Cases ran serially at 10, 30 and 50 clients, using separate server and generator processes. CPU is the server process's total CPU, including its background work. Credentials and synthetic databases remain outside the repository.

| Connected clients | Before CPU ms/message | After CPU ms/message | Before p95 ack → last patch | After p95 ack → last patch |
| --- | ---: | ---: | ---: | ---: |
| 10 | 59.3 | 26.7 | 46.7 ms | 0.5 ms |
| 30 | 145.0 | 18.3 | 87.6 ms | 1.1 ms |
| 50 | 291.7 | 15.0 | 148.8 ms | 1.3 ms |

Every measured message reached every subscribed client. At 50 clients, CPU/message fell about 95%; the candidate used approximately 3.1% of one CPU core during the measured interval. Candidate CPU did not grow across these three short samples. The descending values should not be interpreted as a benefit from adding clients: tiered JIT, background work and sampling noise remain. Serialization and delivery still require work per subscriber; the architectural guarantee is one common message projection, no snapshot/window hashing, and two unread SQL statements per message.

This is a local comparison, not a production capacity limit, provider/device test, or tail-latency distribution from sustained traffic. The deterministic server contract checks separately cover bounded-queue overflow, authorized recovery, independent conversation sequence stamps, private-recipient isolation, profile/preference events and concurrent retry/receipt behavior. Browser suites cover the current client merger and durable recovery.
