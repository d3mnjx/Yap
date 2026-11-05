# npm and node in Yap, 2026-11-05

An analysis of one question: where does Yap use npm and node, how exposed is that to supply-chain attacks, and should the browser tests move to Microsoft.Playwright on NuGet? It is a brainstorm. Nothing changed in the code, and no decision is made. Versions, dates and counts were checked on 2026-11-04 and 2026-11-05.

## Where node runs today

The app, its build, the Docker image and the GitHub workflow contain no npm and no node. Node is a development tool only.

| place | size | must it keep running? |
| --- | --- | --- |
| Browser tests, `tests/browser` | 9 scripts, 3,205 lines | yes |
| Spec screenshot tool, `docs/spec/tools/screenshots` | 3 scripts, 1,478 lines | yes, it makes the spec images |
| Review evidence scripts, `reviews/` | 24 scripts | no, they are records of past reviews |
| node and npm in the sandbox | Ubuntu packages, node 22.22.1, npm 9.2.0 | no, after a port |
| node on the Windows machine | the user's install | no, after a port |

The client also runs code from the npm ecosystem without the npm tool. SignalR and tus-js-client are copies in `Yap/wwwroot/lib`, each with the hash of its original. Chart.js and the add-to-homescreen guide load from jsDelivr at runtime. That runtime part is a separate finding and is not covered here.

## Exposure of the current test setup

npm installs two packages, `playwright` and `playwright-core` 1.47.2, both from Microsoft. The macOS-only `fsevents` never installs on Windows or Linux.

The recent npm campaigns (Shai-Hulud, ChainDrop in August 2026, PolinRider on 2026-11-04) publish a new malicious version of a package. Version ranges and fresh installs then pull it in. Our setup resists this:

- **Exact pins.** `package.json` pins 1.47.2, and `playwright` pins `playwright-core` to the same exact version. No range can take a new release.
- **No install scripts.** Neither package has one, so `npm install` runs no package code.
- **No other dependencies.** `playwright-core` bundles its own code.
- **Frozen versions.** npm does not let anyone overwrite a published version. 1.47.2 was published on 2024-09-20. A maintainer account taken over today can only publish new versions, and the pin ignores them.

The weak points:

- **One known advisory.** `npm audit` reports CVE-2025-59288 (GHSA-7mvr-c777-76hp), fixed in 1.55.1. The insecure `curl -k` lines are only in the macOS scripts that install branded Chrome and Edge. We install plain Chromium on Windows and Linux, so that code never runs.
- **Old browser.** 1.47.2 bundles Chromium 129.0.6668.29, about two years behind on security fixes. The scripts open only the local test server, so the exposure is small.
- **The upgrade day.** The real exposure comes when the version changes. On that day we trust whatever the registry holds.
- **Lockfile not in git.** `tests/browser/.gitignore` excludes `package-lock.json`, so a new machine has no recorded hash to check against.
- **One-off npx runs.** When an agent or a person runs a tool once with npx, npx downloads the newest version without a pin and runs it at once. This is the most likely way in.
- **Full user rights.** Package code runs with the rights of the user who runs it. On the Windows machine, that is outside the sandbox.
- **Old npm in the sandbox.** npm 9.2.0 cannot check registry signatures after the registry's key rotation of January 2025 (`EEXPIREDSIGNATUREKEY`).

Hardening that needs no port:

1. Commit the lockfile and change the README to `npm ci`.
2. Add `ignore-scripts=true` to a `.npmrc` in `tests/browser`. Our packages need no scripts.
3. Use `npx --no-install`, or give an exact version to every npx call.
4. Upgrade Playwright once, to a release that is a few weeks old.

## Options to drop npm or node

Every language version of Playwright runs a Node driver. Microsoft.Playwright 1.64.1 on NuGet carries a node binary for linux-x64, linux-arm64, darwin-x64, darwin-arm64 and win32_x64, plus the same `playwright-core` JavaScript. So Playwright can lose npm, but it cannot lose node.

| option | node | port effort | who we trust |
| --- | --- | --- | --- |
| Microsoft.Playwright 1.64.1 | bundled and hidden, not on PATH | small, the API maps almost one to one | Microsoft only; its three dependencies are Microsoft packages |
| Selenium.WebDriver 4.52.0 | none | large | the Selenium project; dependencies are Microsoft packages; bundles the Rust `selenium-manager` binary |
| PuppeteerSharp 25.15.0 | none | large | one maintainer; adds ReactiveExtensionsSharp (same maintainer) and WebDriverBiDi (WebDriverBiDi.NET Committers) |
| Our own client for the Chrome DevTools Protocol | none | largest, and we maintain it | only the browser |

The hard parts outside Playwright:

- **Waits.** The scripts make 628 locator calls, and each one relies on Playwright's automatic waits. In another tool, each call needs an explicit wait or a helper of our own.
- **Offline.** The offline suite cuts the network of the service worker too (17 `setOffline` calls). Playwright does this with one setting, `PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1`. With the other tools, we must attach to the worker through the DevTools protocol ourselves.
- **Two people in one browser.** The scripts open 15 isolated contexts, for users A and B. Puppeteer has this feature. Selenium needs a second browser or its BiDi user contexts.

Removing node completely costs a large rewrite and gains little security. In every option, the biggest piece of third-party code is the browser itself.

## Microsoft.Playwright: pros and cons

| item | amount |
| --- | --- |
| Script lines to port | about 4,700, in 12 scripts |
| `evaluate` calls that become JavaScript strings | 117 |
| Locator calls that need `await` | 628 |
| Package size in the NuGet cache | 205 MB |
| Review scripts that stop running | 24 |

### Pros

- **No npm anywhere.** `package.json`, `node_modules`, the npm registry and npx leave the project. Install scripts and one-off npx runs are then no longer ways in.
- **No node on the PATH.** After the port, node can be uninstalled on Windows and in the sandbox. Then nobody, human or agent, can run npx out of habit.
- **One toolchain.** The tests build and run with dotnet alone, in the language of the app. The compiler catches errors in API calls, and Visual Studio can refactor them.
- **Same API, same features.** The .NET API maps almost one to one to the node API. The offline suite keeps its service worker setting, because the same driver reads it.
- **One publisher.** Microsoft publishes the package and its three dependencies. nuget.org does not let anyone change a published version.
- **A current browser.** The port moves to 1.64.1, with a current Chromium, and clears the old advisory. An npm upgrade gives the same result, so this gain does not need the port.

### Cons

- **Node stays, hidden.** The package carries a node binary for each platform and runs the same Playwright JavaScript. We trust the same code as before. Only the delivery path changes.
- **Build-time code.** The package's MSBuild file runs at every build, on Windows too. Several of our packages do this already. See the next section.
- **Size.** Each build copies node and the driver into the output folder of the test project.
- **Port work.** Each `evaluate` call changes from a JavaScript function to a JavaScript string, so the editor stops checking those snippets. Each suite must run next to its node version until the results match.
- **Browser install.** The documented install uses `playwright.ps1`, and the sandbox has no PowerShell. A one-line call to `Microsoft.Playwright.Program.Main(["install", "chromium"])` in our code avoids this.
- **More cleanup.** The new project adds its own `bin` and `obj` folders to the mixed-OS cleanup. If it joins `Yap.slnx`, every Windows build also builds it and copies node.
- **Slower scripting.** After each edit, a C# script compiles before it runs. A node script starts at once.
- **Old evidence scripts.** The review scripts under `reviews/` need node. After the port they are records only.
- **Docs to update.** The browser test README, `CLAUDE.local.md` and several memories describe the npm commands.

## Build-time code in NuGet packages

A NuGet package can contain MSBuild files under `build/` and `buildTransitive/`. MSBuild imports them into every project that references the package, also through an indirect reference for `buildTransitive/`. These files can run any command with the rights of the user. This is NuGet's version of npm's install scripts, but it runs at build time: on `dotnet build`, `dotnet test`, `dotnet run`, and when Visual Studio loads or builds the project.

`Microsoft.Playwright.targets` in 1.64.1 has two targets:

- `CopyPlaywrightFilesToOutput` copies the node binary for the platform and the `playwright-core` JavaScript into `.playwright/` in the build output. It also copies `playwright.ps1`, but the build does not run it.
- `PlaywrightChmodExecutables` runs on Linux and macOS only. It is the only command the file runs:

```xml
<Exec Command="chmod +x &quot;%(_PlaywrightChmodItems.FullPath)&quot;" ... />
```

So the file does no harm today. The risk is what the file can do: if a future version of the package is compromised, the next build runs whatever the attacker puts there.

We accept this already. These current packages carry build files:

| package | build files |
| --- | --- |
| Microsoft.AspNetCore.Mvc.Testing | targets that load the package's own task code |
| Microsoft.NET.Test.Sdk | props and targets |
| xunit.runner.visualstudio | props |
| SixLabors.ImageSharp | props |
| Microsoft.EntityFrameworkCore | props |
| Microsoft.EntityFrameworkCore.Design | props |

The port does not add a new kind of risk. It adds one more package with this power, from Microsoft.

The protection is a pin plus a lock file. nuget.org does not let anyone replace a published version. A NuGet lock file also records a hash of each package:

```xml
<RestorePackagesWithLockFile>true</RestorePackagesWithLockFile>
```

Restore with `--locked-mode`, and a package that does not match its recorded hash stops the restore.

## Compared with staying on node

The hardening steps above close most of the same risks for less work. The port adds one thing that hardening cannot give: machines without npm and node on the PATH. The decision depends on how much that is worth, because the trusted code stays the same.

## Order of work, if the port goes ahead

1. Port the shared helpers in `lib.mjs`, then `smoke` and `load`. Run each next to its node version and compare the results.
2. Port `offline`, `features`, `pages`, `latency`, `update` and `screenshots` the same way.
3. Port the spec screenshot tool. It reads login tokens with node's built-in SQLite, which becomes Microsoft.Data.Sqlite.
4. Turn on the NuGet lock file for the new project.
5. Delete `package.json` and the `.mjs` suites, and update the README, `CLAUDE.local.md` and the memories.
6. Uninstall node on the Windows machine and in the sandbox.

## Sources

- [GHSA-7mvr-c777-76hp](https://github.com/advisories/GHSA-7mvr-c777-76hp), the Playwright advisory
- [OSV: CVE-2025-59288](https://api.osv.dev/v1/vulns/CVE-2025-59288)
- [Microsoft: ChainDrop supply chain compromise](https://www.microsoft.com/en-us/security/blog/2026/08/04/chaindrop-supply-chain-compromise-anatomy-self-propagating-worm/)
- [OX Security: PolinRider returns](https://www.ox.security/blog/polinrider-returns-hijacked-npm-packages-use-ethereum-blockchain-to-conceal-malware-infrastructure/)
- [Unit 42: Shai-Hulud worm](https://unit42.paloaltonetworks.com/npm-supply-chain-attack/)
- Package facts come from the npm registry, nuget.org (nuspec files and package contents) and `npm audit` in `tests/browser`.
