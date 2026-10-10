# Server fan-out load check

Recorded comparison: [measurements and limits](../../docs/measurements/fanout/README.md).

Uses real .NET SignalR clients against an external, disposable Yap process. It opens both current streams, registers presence, and sends text at two messages/second. The fixture has 50 synthetic accounts and five public rooms with 100 messages each. The generator checks that every subscribed client receives every measured message.

Requires .NET 10, Python 3 with SQLite, and two isolated full publish packages. Do not use the interactive development instance or real accounts. The executable rejects non-loopback origins and port 7543; the seeder accepts only empty `/tmp/yap-fanout-*` packages. Synthetic cookie tokens remain in the package's private `fixture.json` and are never printed in results.

1. Publish the baseline and candidate to `/tmp/yap-fanout-before` and `/tmp/yap-fanout-candidate`. Use separate source checkouts when reproducing a before/after comparison. The recorded baseline is `a3cb057`, whose fan-out code is unchanged from the reviewed `8231ef4`.
2. In each package create `Data/appsettings.json` with SQLite enabled (`ChatSettings:Persistence:Enabled=true`, `ChatSettings:Persistence:ConnectionStrings:SQLite="Data Source=Data/yap.db"`), bot disabled, `ClearUploadsOnStart=false`, and empty VAPID keys. Use the same configuration in both packages. Run each package once with `ASPNETCORE_ENVIRONMENT=Development dotnet Yap.dll --urls http://127.0.0.1:8041` (8043 for the candidate), from its package directory, then stop it to finish migrations.
3. From the repository, run `python3 tests/FanoutLoad/seed.py /tmp/yap-fanout-before` and repeat for the candidate. Start the packages again and record their actual **dotnet process IDs**, not the launching shell's ID.
4. Build with `dotnet build tests/FanoutLoad -c Release`. Run the executable separately for 10, 30 and 50 clients:

```sh
# Set YAP_LOAD_PID to the baseline's actual server process ID.
dotnet tests/FanoutLoad/bin/Release/net10.0/FanoutLoad.dll \
  http://127.0.0.1:8041 /tmp/yap-fanout-before/fixture.json \
  "$YAP_LOAD_PID" 50 30 /tmp/yap-fanout-before-50.json
```

Repeat against candidate port 8043, fixture path and process ID. Run cases serially, without browser suites or another workload on the measured server. Keep complete source/package versions with your results.

Run one initial 50-client case and discard it to warm the server process and tiered JIT, then collect the 10/30/50-client cases. Ten additional warm-up sends precede 30 measured sends in each case. Results report total server process CPU per accepted message, one-core CPU percentage, and p95 POST-start/POST-acknowledgement to the last subscriber's patch. Negative acknowledgement-to-last values mean all clients received the patch before the HTTP response arrived. CPU excludes the generator process and includes the server's background work; these short local runs are descriptive measurements, not production capacity guarantees. Sending/serialization still has unavoidable work per recipient even though projection no longer scales with recipient count or unrelated windows.

The deterministic overflow check is in `tests/OfflineContract/SyncChecks.cs`: it pauses a real fan-out subscription, exceeds its queue capacity, verifies invalidations, then refetches the current authorized window. This deliberately tests the server queue directly: pausing a .NET stream consumer alone can leave the transport draining into client buffers and would not establish server overflow. The same contracts cover private-recipient isolation, concurrent send coalescing, independent conversation stamps across HTTP acknowledgements, reconnect revision matching, profile invalidation and per-user metadata updates. Browser protocol/recovery suites exercise those wire updates through the existing client merger.

Durable acceptance now holds the read/checkpoint gate across the message, receipt and recipient unread transaction. Sends with recipients and read acknowledgements can wait on one another; earlier measurements predate this change and do not quantify that contention. Include concurrent read acknowledgements when repeating the load measurement.
