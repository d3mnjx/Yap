# GitHub → GHCR → Docker Deployment Guide

A reusable recipe for: **push to GitHub → GitHub Actions builds a Docker image → image lands in `ghcr.io` → server pulls and runs it**.

No third-party registry, no paid CI, no SSH-from-CI. The server is the only thing that talks to GHCR.

For an existing Yap instance, follow [Upgrading Yap to the offline client](#upgrading-yap-to-the-offline-client) before replacing its image. It covers persistent data, login sessions, proxy/cache configuration and rollback limits.

---

## What you get

- Every push to `main` produces a new image tagged `latest` (and with the commit SHA).
- Every `v*` git tag produces a semver-tagged image.
- The server pulls `latest` (or a pinned tag) and restarts the container.
- The whole pipeline is free for public repos. For private repos it uses your GitHub free-tier minutes + GHCR storage.

---

## Prerequisites

- A GitHub repo for the project.
- A server with Docker installed (`docker` + `docker compose` plugin).
- A working `Dockerfile` for the app.

---

## 1. The Dockerfile

Place a `Dockerfile` in the build context (usually the app folder). Use multi-stage builds — build with the SDK, run on the slim runtime image.

Sketch (adapt for your stack):

```dockerfile
FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS base
WORKDIR /app
EXPOSE 8080

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY ["MyApp.csproj", "."]
RUN dotnet restore
COPY . .
RUN dotnet publish -c Release -o /app/publish /p:UseAppHost=false

FROM base AS final
WORKDIR /app
COPY --from=build /app/publish .
ENTRYPOINT ["dotnet", "MyApp.dll"]
```

The same pattern works for Node, Python, Go, etc. — only the base images and build steps change.

Tips:
- `EXPOSE` the port your app listens on inside the container (not the public port).
- Keep the runtime image small — only install OS packages you actually need at runtime (e.g. `ffmpeg`, `curl`).
- If your image needs config files or data, mount them as volumes from the host. Don't bake secrets in.

---

## 2. The GitHub Actions workflow

Create `.github/workflows/docker-publish.yml`:

```yaml
name: Build and Push Docker Image

on:
  push:
    branches: [main]
    tags: ['v*']
  workflow_dispatch:  # manual run from the Actions tab

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}   # owner/repo, lowercased automatically

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write                    # required to push to GHCR

    steps:
      - uses: actions/checkout@v4

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract tags & labels
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=raw,value=latest,enable={{is_default_branch}}
            type=semver,pattern={{version}}
            type=sha,prefix=

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: ./MyApp           # folder containing the Dockerfile
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
```

Key points:
- `secrets.GITHUB_TOKEN` is provided automatically — you don't have to create anything.
- `permissions: packages: write` is what authorizes that token to push to GHCR.
- `context:` must point at the folder containing the Dockerfile.
- The `metadata-action` tag rules give you, for any push to `main`:
  - `latest`
  - `<short-sha>`
  - For `v1.2.3` git tags: `1.2.3`

---

## 3. First push & making the package public (optional)

Push to `main`. The workflow runs. When it finishes, the image is at:

```
ghcr.io/<owner>/<repo>:latest
```

By default the package is **private** and inherits its visibility from the repo. To make it public (so the server can pull without authentication):

1. GitHub → your profile → **Packages** → click the package.
2. **Package settings** → **Change visibility** → **Public**.

If you keep it private, the server will need to `docker login ghcr.io` with a Personal Access Token that has `read:packages` scope.

---

## 4. Running on the server

### Option A — `docker run` (recommended)

One-liner that pulls the latest image, stops + removes the old container, and starts a fresh one. Works the same on Linux and Windows (just adjust the host volume paths).

**Linux:**
```bash
docker pull ghcr.io/<owner>/<repo>:latest; \
docker stop myapp; \
docker rm myapp; \
docker run -d \
  --name myapp \
  --restart=unless-stopped \
  -p 5221:8080 \
  -v /srv/myapp/uploads:/app/wwwroot/uploads \
  -v /srv/myapp/config:/app/Data \
  -e ASPNETCORE_ENVIRONMENT=Production \
  ghcr.io/<owner>/<repo>:latest
```

**Windows (PowerShell or cmd):**
```bat
docker pull ghcr.io/urza/yap:latest & ^
docker stop yapdoc & ^
docker rm yapdoc & ^
docker run -d --name yapdoc ^
  --restart=unless-stopped ^
  -p 6777:8080 ^
  -v D:/dockerdata/yap-doc/uploads:/app/wwwroot/uploads ^
  -v D:/dockerdata/yap-doc/config:/app/Data ^
  ghcr.io/urza/yap:latest
```

Breakdown of the flags:
- `-d` — detached (runs in background).
- `--name myapp` — fixed container name so the next deploy can `docker stop`/`rm` it by name.
- `--restart=unless-stopped` — auto-start on boot / after a crash, but respect a manual `docker stop`.
- `-p HOST:CONTAINER` — publish the container port on the host. `CONTAINER` matches `EXPOSE` in the Dockerfile; `HOST` is whatever free port you want behind the reverse proxy.
- `-v HOST_PATH:CONTAINER_PATH` — mount a host folder into the container so data survives container replacement. Use absolute paths.
- `-e KEY=VALUE` — environment variables (e.g. `ASPNETCORE_ENVIRONMENT=Production`). Repeat the flag for each.
- The image tag is the **last** argument.

`docker stop` / `docker rm` will emit a harmless error on the very first run (no container to stop yet). Ignore it, or guard with `2>/dev/null || true` on Linux.

Tip: save the whole command as `~/deploy.sh` (Linux) or `deploy.bat` (Windows) so a redeploy is one keystroke.

### Option B — `docker compose`

If you prefer a declarative file, put this on the server as `docker-compose.yml`:

```yaml
services:
  app:
    image: ghcr.io/<owner>/<repo>:latest
    container_name: myapp
    ports:
      - "5221:8080"
    environment:
      - ASPNETCORE_ENVIRONMENT=Production
    volumes:
      - /srv/myapp/uploads:/app/wwwroot/uploads
      - /srv/myapp/config:/app/Data
    restart: unless-stopped
```

Deploy / update:
```bash
docker compose pull && docker compose up -d && docker image prune -f
```

### Pinning vs `latest`

`:latest` is convenient but means "whatever was last built". For production, pin to a SHA or semver tag (`:abc1234`, `:1.2.3`) so you control exactly when an update happens.

---

## 5. Private images: server-side login

If the GHCR package stays private:

1. On GitHub → **Settings → Developer settings → Personal access tokens → Tokens (classic)**.
2. Create a token with **`read:packages`** scope only.
3. On the server:

```bash
echo "<TOKEN>" | docker login ghcr.io -u <github-username> --password-stdin
```

Docker stores the credentials in `~/.docker/config.json` and reuses them for future pulls.

---

## 6. Reverse proxy (Caddy / Nginx)

The container exposes a plain HTTP port on the host (`5221` above). Put it behind a reverse proxy for TLS and a real hostname. Caddy example:

```
app.example.com {
    reverse_proxy localhost:5221
}
```

For apps with WebSockets / SignalR / long-polling (Blazor Server, etc.), make sure the proxy passes `Upgrade` / `Connection` headers — Caddy does this by default; Nginx needs explicit `proxy_set_header` directives.

---

## 7. One-line update on the server

For Yap, complete the [backup and deployment checks](#upgrading-yap-to-the-offline-client) first. These generic scripts do not make a data backup; pin the candidate and retain the original image instead of pruning it during the rollout.

Save your `docker run` command (from section 4) as a script — redeploy becomes a single command.

**Linux** (`~/deploy.sh`, `chmod +x` once):
```bash
#!/usr/bin/env bash
set -e
docker pull ghcr.io/<owner>/<repo>:latest
docker stop myapp 2>/dev/null || true
docker rm   myapp 2>/dev/null || true
docker run -d \
  --name myapp \
  --restart=unless-stopped \
  -p 5221:8080 \
  -v /srv/myapp/uploads:/app/wwwroot/uploads \
  -v /srv/myapp/config:/app/Data \
  -e ASPNETCORE_ENVIRONMENT=Production \
  ghcr.io/<owner>/<repo>:latest
docker image prune -f
```

**Windows** (`deploy.bat`):
```bat
@echo off
docker pull ghcr.io/urza/yap:latest
docker stop yapdoc
docker rm yapdoc
docker run -d --name yapdoc --restart=unless-stopped ^
  -p 6777:8080 ^
  -v D:/dockerdata/yap-doc/uploads:/app/wwwroot/uploads ^
  -v D:/dockerdata/yap-doc/config:/app/Data ^
  ghcr.io/urza/yap:latest
docker image prune -f
```

Run it manually after a push, or trigger from a webhook / scheduled task / `watchtower` if you want full automation.

---

## 8. Checklist for a new project

1. Add `Dockerfile` to the app folder.
2. Add `.github/workflows/docker-publish.yml` — change `context:` to your app folder.
3. Push to `main`, watch the Actions tab go green.
4. (Optional) Make the GHCR package public.
5. On the server: create a `docker-compose.yml` with `image: ghcr.io/<owner>/<repo>:latest` and any volumes / env vars / ports.
6. `docker compose up -d`.
7. Front it with a reverse proxy for TLS.

After that, the deploy loop is: **push → wait for the green check → `docker compose pull && up -d`**.

---

## Common gotchas

- **403 on push to GHCR**: missing `permissions: packages: write` in the workflow.
- **`denied` on server pull**: package is private and the server isn't logged in (`docker login ghcr.io`).
- **Image name must be lowercase** — GHCR rejects uppercase. `${{ github.repository }}` is already lowercased by GitHub.
- **Wrong `context:`** — build fails with "Dockerfile not found". The path is relative to the repo root.
- **Old container keeps running after `pull`** — `pull` only fetches the image. You must `up -d` (or `stop` + `run`) to actually restart with the new image.
- **Disk fills up over time** — old images accumulate. Run `docker image prune -f` after deploys, or schedule it.
- **Secrets in the image** — never `COPY` `appsettings.Production.json` or `.env` files containing secrets into the image. Mount them as volumes or pass via `environment:`.


## Upgrading Yap to the offline client

Use a pinned candidate image and retain the original image digest and persistent data. The offline client uses the same accounts, valid login cookies, public room/DM routes and online Settings/Admin pages. A successful online visit prepares offline storage; a browser that has never loaded the client cannot open its chat offline.

### Persistence and client state

SQLite persistence makes accepted messages, accounts and receipts survive restarts. With persistence disabled, chat works in memory; restarting invalidates accounts and locks cached work, and registering again discards the old account’s queue. Preserve the complete `Data` directory, its effective `appsettings.json`, and `wwwroot/uploads`. Startup applies the additive `DurableTextSends` and `ObservedReadCheckpoints` migrations, plus `ReceiptCountCap` indexes: operation receipts/message IDs and read checkpoints initialized from existing unread counts. Do not run two application versions against the same SQLite/data directory. The client uses `yap-chat-v1` IndexedDB schema 4 and preserves drafts/outbox/read checkpoints across shell updates. Protocol 3 is the only supported chat protocol; explicit API or hub protocol mismatches return 426 and request a reload without clearing local work. The older schema-3 client cannot reopen a schema-4 database: prefer a forward fix, and do not clear site data to work around a downgrade.

Before stopping the original Blazor app, ask users to send or copy unfinished text and finish uploads. Its unsent draft lives in the old page/circuit and its reconnect handler can auto-reload; the replacement cannot recover it retroactively. The first offline release starts new browser storage and does not migrate prototype browser-only test queues. Subsequent releases should preserve the deployed chat namespace, drafts/outbox and receipt compatibility.

### Existing Android installations and stable manifest identity

The default manifest ID is now `/`. Earlier versions omitted an ID, so Chrome derived one from the token-bearing `start_url`; rotating that token could make the same site look like a new app. A stable ID prevents future identity changes, but existing Android installs can retain the old identity. They keep working and launching with their existing account, while manifest updates (name, icons or theme) may no longer reach them. Chrome may offer another installation. Use the existing icon, or save a login link in Settings, remove the old icon, and then install the replacement. Do not reinstall merely to recover offline drafts. The bot/Settings install guide offers an existing-app exit and does not prompt for another installation from standalone mode.

Before deploying, use one real Android device: install the original version, sign in, deploy the candidate on the same origin, open the existing icon, confirm it launches signed in, and check whether Chrome offers a second installation. Record the Android/Chrome versions and observed result in the PR. Automated browser handoff tests do not establish this OS-level identity behavior; this check is still pending.

### HTTPS, reverse proxies and caches

Service workers require trusted HTTPS, except for loopback development. Yap accepts `X-Forwarded-Proto` and `X-Forwarded-For` from any immediate proxy by default. Ordinary Caddy/Nginx and Docker deployments do not need a proxy address allowlist, and changing container addresses does not require an app configuration update. Forwarding restores the public scheme and client IP; only the nearest forwarded hop is processed (`ForwardLimit = 1`). `X-Forwarded-Host` is ignored so it cannot replace the login-link host.

Chat writes require an account-bound antiforgery token. Chat API writes and hub requests reject `Sec-Fetch-Site: cross-site`, but accept missing browser metadata and do not compare the browser's Origin with the internal request URL. This intentionally favors compatibility with proxy URL rewriting and older clients; it is not strict same-origin enforcement.

The permissive default also accepts forwarded headers supplied directly by a client. Deployers who want restricted trust can optionally configure proxy addresses or CIDR networks in the effective `Data/appsettings.json` or environment settings. A nonempty list enables restriction to the configured addresses/networks plus the framework's loopback defaults. Example only; substitute the real proxy address:

```json
"ReverseProxy": {
  "KnownProxies": ["172.30.0.10"]
}
```

`ReverseProxy:KnownNetworks` accepts CIDRs when a specific stable address is impractical. Leave both lists absent or empty to keep the permissive default. When opting into restriction, use valid IP addresses/CIDRs; malformed entries prevent startup.

Preserve the public Host, and forward the original public scheme in `X-Forwarded-Proto`. With multiple proxies, the nearest proxy must pass that public URL through instead of reporting its internal HTTP connection. Forward `/api/chat/*`, `/hubs/chat*` with WebSocket upgrades, `/api/tus*`, `/service-worker.js`, `/service-worker-module.js`, `/chat-client/*` and retained Blazor routes. A normal Caddy `reverse_proxy` preserves the Host.

If the proxy hides the public Host, set the optional top-level `PublicOrigin` to an HTTP(S) origin such as `"https://chat.example.com"`; it overrides all invite/login-link origins. Otherwise bot links use per-user recorded origins: the recipient's for welcome DMs, the recipient's then issuing admin's for replacement DMs, and a site-relative link when neither is known. Settings/Admin use the viewing circuit's base URI. Origins contain no path. See [configuration](CONFIG_README.md#publicorigin).

For Cloudflare or another CDN:

- Leave authenticated HTML, `/api/*`, `/hubs/*`, `/auth/*`, `/manifest.webmanifest`, `/pwa-launch`, Settings/Admin and Blazor endpoints uncached.
- Revalidate service-worker and client assets. Stable asset URLs must not retain an earlier deployment indefinitely; the worker owns the offline shell cache.
- Keep app routes out of challenge rules that would replace JSON/JavaScript/WebSocket responses with an HTML challenge. Preserve the existing TLS policy.
- During an initial rollout, use a hostname-scoped cache bypass or purge affected assets. Do not rely on a browser hard refresh to invalidate a CDN cache. Immutable media can retain its existing policy.

### Deployment checks

1. Record the image digests, volume mounts, effective configuration, public hostname and proxy peer. Verify persistence is enabled and the original image remains available.
2. Stop Yap cleanly. Make a dated, private backup of all persistent mounts/configuration. Wait for process exit before copying files; a live SQLite main-file copy alone is unsafe. Use SQLite's backup API where appropriate and verify the backup can be read.
3. Start one candidate container with the same data/uploads volumes and public origin. Inspect startup and migration logs. Deploy the full publish/image output, including compressed static assets.
4. In an already authenticated browser, refresh and verify the same account/history, lobby and DM navigation, receiving from another account, text send, upload and Settings return. Repeated API/hub 403s or a send stuck pending are failed rollout checks.
5. After successful synchronization, disconnect that browser, reload cached chat, save a draft, queue a message and reconnect. Confirm one accepted message. Check an ordinary browser and an existing installed app, without resetting permissions/subscriptions.
6. Verify real proxy/CDN response headers, WebSocket and upload behavior, installed launch and notification delivery on target devices. Retain the backup and original image while checking the release.

An automated same-origin rehearsal is available in [upgrade-rollout.cjs](tests/browser/upgrade-rollout.cjs); set its original/candidate package and certificate inputs explicitly as described in the [test guide](tests/browser/README.md). It exercises account/data preservation and short rollback/re-upgrade using disposable copies. It does not establish actual CDN policy, OS installation identity, device focus or external push delivery. Run it for the candidate being deployed rather than treating an earlier release's result as current validation.

### Rollback limits

Prepared chat routes use the cached shell immediately. To reach a rolled-back original app directly, navigate online to `/` (without a return URL), which remains network-first, then reload the desired chat route after the original classic worker takes control. The original server does not serve the new hash-named module registration URL, so a cached-route refresh or background update alone is not a rollback mechanism. `/pwa-launch` also remains network-first for authentication handoff. Offline navigation may still use the cached client. The original UI cannot display or deliver the new client's IndexedDB outbox, and it does not maintain the new read counters or operation receipts. A short controlled rollback/re-upgrade is not a guarantee of safe prolonged writable downgrade. Prefer a forward fix after users resume activity.

If checks fail **before new user activity**, stop the candidate, retain a copy of its state, and restore the original image and pre-upgrade data only after confirming that doing so discards no new messages/accounts. Keep asset revalidation in place and refresh online.

If acknowledged messages or offline work already exist, preserve both server states and browser storage before choosing recovery. An old server backup may omit accepted messages/receipts, while unsent work exists only in browsers. Blindly restoring old data can lose messages or let later retries duplicate acceptance. Do not clear site data, discard receipts or prescribe reinstallation as a normal rollback procedure; reconcile data or repair forward.

The [offline behavior guide](docs/offline-behavior.md) describes account expiry, queue semantics and durability limits. The [parity inventory](docs/feature-parity-inventory.md#remaining-verification) records remaining platform and feature coverage.

Module service workers require Chrome/Edge 91+, Firefox 114+, or Safari 15+. The client explains when offline reload/push is unavailable. The classic migration bridge never force-reloads open tabs: users should finish uploads and send/copy old Blazor drafts before their next navigation. Publish static/branding assets atomically and restart to rebuild the shell manifest. Theme and installation-guide artwork caches on use and does not gate installation.
