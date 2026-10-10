# Browser and contract checks

These checks exercise the running app with synthetic accounts. Run them against a disposable local instance with its own Data and uploads. Port **7543** is reserved for interactive development and is rejected by the suite runner. The runner rejects that port and non-local hosts; several older comparison suites use fixed addresses as listed below.

## Tooling

From the repository root, install the pinned development dependencies:

```sh
npm ci --ignore-scripts --no-audit --no-fund
node node_modules/playwright/cli.js install chromium firefox
```

On mounts that cannot create symlinks, add `--no-bin-links` to `npm ci`. The package scripts use explicit Node entry points and do not need `.bin` symlinks. Playwright can install Linux system dependencies with its `install-deps` command when required. An existing Playwright installation can be selected with `PLAYWRIGHT_MODULE=/absolute/path/to/playwright`.

Node/Prettier/Playwright are development-only; `dotnet publish` does not require npm or bundle these dependencies into the client.

## Isolated app

Publish a complete package to a new private directory outside Git, then launch from that directory so its Data/uploads are isolated:

```sh
dotnet publish Yap -c Release -o /tmp/yap-browser-app
cd /tmp/yap-browser-app
ASPNETCORE_ENVIRONMENT=Development dotnet Yap.dll --urls http://127.0.0.1:7643
```

Use test configuration with registration enabled and SQLite persistence for durable/restart scenarios; see [offline behavior](../../docs/offline-behavior.md). Do not copy production credentials or databases into a fixture.

The server contract suite includes login-link origin isolation, migration/restart checks, and the real one-minute delayed welcome DM. It creates its own temporary app/database and does not need the browser fixture.

The runner neither starts nor stops the fixture. Check `/login` before running. From another terminal in the repository:

```sh
npm run test:contracts
YAP_TEST_ORIGIN=http://127.0.0.1:7643 npm run test:browser
npm run test:browser -- review-composer history-interface
```

The default suites run sequentially and stop on the first failure. `YAP_TEST_ARTIFACTS=/absolute/output/path` selects a parent directory with one subdirectory per suite; otherwise a temporary directory is created and printed. Capture stdout/stderr too when recording a validation run. Cookie/storage-state files are credentials: keep them in private runtime directories, never Git or reports.

## Suite selection

| Suites | Purpose / prerequisites |
| --- | --- |
| **Default:** `sync-protocol`, `communication`, `review-recovery`, `review-composer`, `text-sending`, `history-interface`, `rich-content`, `message-actions`, `pwa-integration`, `local-http` | Protocol ordering, cached credentials, blocked catalog/window independence, one-POST writes, durable sends, upload cancellation/timeouts and independent-conversation progress, history and reply races, offline media/actions, PWA and worker failure. Use the isolated origin; create their own synthetic accounts. |
| `emoji-cache` | Real root/client workers on a disposable static origin; v35 SVG migration, direct/warmed cache entries, no SVG requests across a shell-only upgrade, offline reuse, separate custom caching, and replacement on a changed artwork pin. No app fixture needed; `YAP_BROWSER=firefox` also supported. |
| `emoji-loading` | First-use emoji selection with artwork/catalog unavailable; late custom catalog and quick reactions repair retained rows/pickers; cached preferences, direct SVG decode, compound emoji, offline reload and native fallback. Uses the isolated origin with synthetic accounts. |
| `composer-parity`, `emoji-parity`, `gif-parity`, `gallery-parity` | Compare against the separately running frozen original at `https://localhost:7443` and rewrite at `http://127.0.0.1:7643`; these addresses are fixed in the scripts. They create synthetic reference accounts/content. Reference code/package remains frozen. |
| `action-parity`, `media-playback`, `reported-regressions`, `interface-integration` | Focused interaction/media/Settings checks. Inspect script origins/configuration fixtures before use; some also reference 7443 and fixed 7643. Media checks require `ffmpeg`. |
| `presence-unread`, `tab-notifications` | Multiple accounts/tabs, typing/read checkpoints and title/audio. Optional notification restart coverage requires `YAP_TEST_LAUNCHER` and a stopped disposable fixture; see the script before enabling it. Without the launcher, that branch is skipped. |
| `queued-scroll` | Needs `YAP_TEST_STATE` from `text-sending` (set that variable when running text-sending to save private fixture state). Offline cached/queued grouping and navigation at desktop/phone widths. |
| `review-worker-upgrade` | Requires explicit `YAP_PREVIOUS_PACKAGE` and `YAP_REWRITE_PACKAGE`, each a full publish output using the same `yap-chat-*` storage namespace. Serves static packages on disposable port 7844, forwards API requests to `YAP_TEST_ORIGIN` (default 7643); derives cache versions from the two workers. Checks activation, draft/outbox preservation, exactly-once recovery and offline reload. `YAP_BROWSER=firefox` selects Firefox; default Chromium. |
| `upgrade-rollout` | Original→rewrite→rollback/re-upgrade rehearsal. Needs original/candidate packages, HTTPS certificate and free 7743/7843. See [deployment guide](../../GHCR-DEPLOYMENT-GUIDE.md#upgrading-yap-to-the-offline-client); set candidate explicitly with `YAP_REWRITE_PACKAGE`. |
| `account-integration` | Session revocation, retained Settings/status, error recovery and signout; fixed isolated origin 7643. Fresh-admin CRUD is a separate direct-run script, `admin-integration.cjs`. |

`gallery-parity` also accepts `YAP_BROWSER=firefox`. Other suites default to Chromium and should not be assumed to support that switch. Tests use desktop and emulated phone viewports; they do not establish real keyboard/install/push/device behavior. PWA/provider API fixtures are identified in their output.

Restart, reference-only and diagnostic scripts remain directly runnable with Node. They are not silently included in the default suite; their top-of-file prerequisites still apply.

## Formatting

```sh
npm run format
npm run format:check
dotnet format whitespace BlazorChat.sln --no-restore --include Yap/Offline/*.cs Yap/Services/ChatService.*.cs
dotnet format whitespace tests/OfflineContract/OfflineContract.csproj --no-restore --include tests/OfflineContract/*.cs
```

Use `--verify-no-changes` for the C# check-only form. The contract harness is outside the solution and needs its separate command. First-party client code/tests use pinned Prettier; generated/vendor/emoji assets are excluded. Format a focused diff and run the affected regressions; no additional frontend framework or test-fixture architecture is needed.

## Slow-network comparison

See the [recorded results and limitations](../../docs/offline-network-measurements.md) before interpreting the raw timing and byte counters.

`slow-network.cjs` is an explicit benchmark, outside the default correctness suite. It compares the frozen original and candidate using a shared application-byte proxy that delays **both HTTP and WebSockets**. Browser-only HTTP throttling would favor Blazor incorrectly. Three profiles cover local control, 900 ms RTT, and 900 ms RTT with 1 Mbit/s down / 256 kbit/s up. A small-response and 128 KiB transfer calibration checks the shaper before each profile. It preserves FIFO byte ordering within every stream and checks a patterned response for corruption. TCP handshakes, packet loss, congestion and mobile CPU/OS behavior are not simulated. HTTPS mode shapes TLS records and their handshake too.

Prepare **new disposable copies**, never the interactive development or frozen reference directories:

1. Create `/tmp/yap-network-<name>/reference` and `/rewrite` from full original/candidate publish outputs. Exclude `Data`, `wwwroot/uploads` and runtime logs; do not copy real user credentials. Verify the reference DLL against the frozen baseline hash.
2. In both packages, create `Data/appsettings.json` with SQLite persistence enabled (`Data Source=Data/yap.db`), `ChatSettings.Bot.Enabled=false`, `ChatSettings.WelcomePageEnabled=false`, and otherwise identical defaults. Launch each once on `127.0.0.1:8051` / `8052` with `ASPNETCORE_ENVIRONMENT=Development` to apply its migrations, then stop both cleanly.
3. Generate one synthetic WebP as `<fixture>/image.webp`. The recorded workload used `ffmpeg -f lavfi -i 'testsrc2=size=800x450,noise=alls=12:allf=u:all_seed=42' -frames:v 1 -c:v libwebp -quality 80 <fixture>/image.webp`.
4. Run `python3 tests/browser/seed-network.py <fixture>` against those stopped, empty databases. It creates six synthetic users and five 30-message DMs per network profile, with three images per conversation. Its `fixture.json` contains synthetic credentials and must stay outside Git/reports.
5. Restart both isolated packages on 8051/8052. Keep the original DLL unchanged. Ports 8151, 8059 and 8159 must also be free. Run:

```sh
YAP_NETWORK_FIXTURE=/tmp/yap-network-<name> \
YAP_TEST_ARTIFACTS=/tmp/yap-network-results \
node tests/browser/slow-network.cjs
```

The default is three cold/warm startup pairs and five sends/receives per version/profile. `YAP_STARTUP_TRIALS`, `YAP_MESSAGE_SAMPLES` and comma-separated `YAP_NETWORK_PROFILES=local,latency900,slow900` allow targeted runs. It warms the servers, uses authenticated browser contexts and fresh browser caches for cold loads, then retains caches for warm reloads. A fast second browser separates sender feedback/confirmation from recipient delivery. The original's `.pending-message` ghost and the rewrite's pending rows are excluded from confirmation timestamps. Inactive delivery measures the sidebar unread badge, since the original does not replicate inactive message bodies.

Raw proxy stream counts include HTTP headers, compressed bodies, WebSocket framing and protocol/control traffic for the measured browser, including service-worker downloads. CDP frame payload counters are a separate decoded view and must not be presented as compressed stream bytes. Startup counts cover ready time and a further 15 seconds; message counts include a three-second tail. Periodic presence/session traffic can fall inside those windows. No payloads, cookies or headers containing credentials are saved in `results.json`. Run versions serially and keep other browsers off the shaped origin.

`pwa-return.cjs`, run with `YAP_TEST_ORIGIN` pointing at a disposable rewrite instance, checks standalone-mode return with 28-day-old local authentication metadata, draft/account retention, rejected-token refresh, and offline reopening without an elapsed-time limit. It does not advance the server clock or claim physical-phone suspension coverage.

For HTTPS/HTTP/2, run the two fixture packages on the same ports with trusted or disposable test certificates and set `YAP_NETWORK_TLS=1`. The proxy forwards TLS unchanged, so browser/Kestrel ALPN negotiation selects HTTP/2 for HTTP requests. The harness allows the disposable certificate and records the observed protocols, WebSocket compression, and encrypted-stream byte counts. Never apply its certificate override to deployment guidance. `YAP_NETWORK_RESUME=1` resumes completed version/profile pairs in the same output directory; retain the same workload/protocol configuration.

`interaction-locality.cjs` holds API writes open and measures paintable local feedback for sending, reactions, edit/save and emoji interactions. Run it on a disposable rewrite with `YAP_TEST_ORIGIN`; `YAP_LOCALITY_OUTPUT` writes timings. It reports known queued-edit blocking as a `FINDING`, rather than implying that all interactions satisfy the latency rule. Those measurements include two animation frames and are distinct from the main benchmark's DOM-mutation timings.

`YAP_STARTUP_ONLY=1 YAP_CACHE_STAGES=cold,warm,settled YAP_STARTUP_TRIALS=1` adds a third reload without message measurements. This distinguishes the first reload after installation from a later reload after on-use artwork has entered the worker cache. The recorded comparison uses HTTPS, two cold/warm pairs and five message samples per version/profile, plus this supplementary cache check. Timings are descriptive samples, not a production percentile or capacity estimate.

## Server fan-out load

See [FanoutLoad](../FanoutLoad/README.md) for the 10/30/50-client .NET SignalR benchmark, synthetic fixture, server CPU and p95 delivery measurement. The contract suite also pauses a bounded server subscription to verify overflow invalidation and authorized-window recovery.
