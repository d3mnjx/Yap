# Yap Configuration Guide

## Which file is read

The project ships `Yap/appsettings.json`. At runtime the app looks for `Data/appsettings.json`
(the `Data/` folder next to the app, the config volume in Docker).

- If `Data/appsettings.json` does not exist, the app copies `Yap/appsettings.json` there on first start.
- If it exists, it **replaces** `Yap/appsettings.json` completely. The project file is removed from
  the configuration sources. This avoids the .NET array-merge behavior, where a shorter array in an
  override file would leave stale items from the base file.

So edit `Data/appsettings.json` on a running deployment. A change to `Yap/appsettings.json` does
not reach an existing `Data/` copy. Delete the `Data/` copy to re-seed it, or mirror the change by
hand. Edits to `Data/appsettings.json` reload without a restart, but most values are read once at
startup, so restart to be sure.

`appsettings.Development.json` still loads in Development. The `Data/` file loads after it, so the
`Data/` file wins for every key it contains. In practice this means environment-specific files are
only useful for keys that the `Data/` file leaves out (logging levels, for example).

## Top-level keys

```json
{
  "Logging": { ... },
  "AllowedHosts": "*",
  "PublicOrigin": "",
  "Vapid": { "Subject": "mailto:...", "PublicKey": "...", "PrivateKey": "..." },
  "ChatSettings": { ... }
}
```

### PublicOrigin

Optional absolute HTTP(S) origin, for example `"https://chat.example.com"` or
`"https://chat.example.com:8443"`. Leave empty for automatic per-user addresses.
Use it when a reverse proxy replaces the public Host with an internal hostname.
A configured origin overrides all displayed, copied and bot-generated invite/login links.
It must contain only scheme and host (an optional port and trailing slash are allowed),
with no credentials, path, query or fragment. Invalid values fail startup.

Without this setting, chat session/bootstrap and authenticated Blazor page loads remember
scheme and host on that user's account, persisted alongside known IPs. Welcome DMs use
the recipient's address. Admin replacement-link DMs use the recipient's address, then the
issuing admin's recorded address, then a site-relative link if neither is known. Existing
accounts start without an address until their next session. Settings and Admin display/copy
links using the viewing circuit's base URI; paths are never included in the saved origin.

Yap ignores `X-Forwarded-Host`. It accepts `X-Forwarded-Proto` and `X-Forwarded-For`
from any immediate proxy by default, processing only the nearest hop (`ForwardLimit = 1`).
This supports changing container/proxy addresses; optional `ReverseProxy:KnownProxies`
and `ReverseProxy:KnownNetworks` restrict that trust. The nearest proxy must supply the
original public scheme. See the [deployment guide](GHCR-DEPLOYMENT-GUIDE.md#https-reverse-proxies-and-caches).

### Vapid

Push notifications stay off until all three keys are set and the public key is the real pair of the
private key. Startup checks this and logs loudly if the pair is wrong. Generate a valid pair with
the script in the repo root. It uses the same WebPush library the app sends with:

```
dotnet run vapidgen.cs -- mailto:you@example.com
```

Do not use online generators or `npx web-push`. A malformed pair from one of those broke push in
production once and the failure is silent on the client side.

### ChatSettings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `ProjectName` | string | "Yap" | App name in the browser tab and login page |
| `RoomName` | string | "lobby" | Default room. Users land here after login |
| `ClearUploadsOnStart` | bool | false | Delete all uploaded files when the app starts |
| `MaxUploadSizeMB` | int | 100 | Upload size limit for images and videos |
| `UploadUrl` | string | "" | Upload endpoint. Empty means same origin (`/api/tus`). Set a full URL to bypass a proxy upload limit (Cloudflare) |
| `Ipv4BeaconUrl` | string | "" | Origin with an A record only, pointing at this app. The admin panel uses it to learn the IPv4 of dual-stack clients. Empty disables it |
| `PushSubscriptionStorage` | string | "Json" | `"Json"` stores push subscriptions in `Data/push-subscriptions.json`. `"Database"` stores them in the DB |
| `WelcomePageEnabled` | bool | true | Show `Data/welcome/welcome.html` before the login page, if the file exists |
| `Bot` | object | | The system bot. `Enabled`, `Username`, `DisplayName`, `WelcomeMessage` (`{0}` is the project name). Runtime bot settings from the admin panel live in `Data/bot-settings.json` |
| `Persistence` | object | | `Enabled`, `Provider` (`"SQLite"` only; Postgres is a placeholder), `ConnectionStrings`. With persistence off, everything lives in memory and is wiped on restart |
| `GifSettings` | object | | `Provider` (`"klipy"`), `UserQuotaMB`, `MaxPackSizeMB`, `Klipy.ApiKey` (free key from partner.klipy.com), `Klipy.CustomerId`, `Klipy.Locale`. Without an API key, provider search and trending are off. Own uploads and server collections still work |
| `FunnyTexts` | object | | Randomized UI text, see below |

The comments in `Yap/appsettings.json` are the source of truth for these keys. If this table and
that file disagree, trust the file.

With `ChatSettings:Persistence:Enabled=false`, sending and message actions work normally, with retry receipts kept in memory. A restart wipes accounts and conversations too: offline clients receive an invalid-login response, lock the old account's cached work, and require login. A newly registered account never inherits the old queue, even with the same username. Both storage backends retain operation receipts for 24 hours; cleanup runs once a minute. Receipt-based retry deduplication is bounded by that retention (and by process lifetime in memory mode).

## Settings the admin panel owns

Some settings are changed from `/admin` at runtime and are not in `appsettings.json`. They persist
as JSON files in `Data/`:

| File | Owner |
|------|-------|
| `Data/registration-settings.json` | Registration gate: open, closed, or approval required |
| `Data/bot-settings.json` | System bot runtime settings |
| `Data/gif-settings.json` | GIF content rating and server collections |
| `Data/link-preview-settings.json` | Link preview behavior |
| `Data/push-subscriptions.json` | Push subscriptions when storage is `"Json"` |

Branding overrides go in `Data/branding/` (manifest, icons). The custom welcome page is
`Data/welcome/welcome.html`.

## FunnyTexts

Each UI element picks a random item from its list every time it renders. `{0}` and `{1}` are
replaced with the project name, username, or count as noted. If a list is missing, the code uses a
plain default.

#### Welcome Messages
Shown on the login page above the username input. `{0}` is the project name.

```json
"WelcomeMessages": [
  "welcome to {0}",
  "you ready?",
  "you found {0}"
]
```

#### Join Button Texts

```json
"JoinButtonTexts": [
  "lessgo",
  "slide in",
  "hop on",
  "lock in"
]
```

#### Username Placeholders

```json
"UsernamePlaceholders": [
  "drop your @",
  "who dis?",
  "pick your fighter"
]
```

#### Message Placeholders

```json
"MessagePlaceholders": [
  "say hi...",
  "spill the tea...",
  "drop a hot take..."
]
```

#### Connection Statuses

```json
"ConnectionStatuses": {
  "Connected": ["online"],
  "Disconnected": ["offline"]
}
```

#### System Messages
User join and leave messages. `{0}` is the username.

```json
"SystemMessages": {
  "UserJoined": [
    "{0} just dropped",
    "{0} pulled up",
    "{0} entered the chat"
  ],
  "UserLeft": [
    "{0} dipped",
    "{0} ghosted us",
    "{0} went to touch grass"
  ]
}
```

#### Typing Indicators

```json
"TypingIndicators": {
  "Single": [
    "{0} is cooking..",
    "{0} is yapping.."
  ],
  "Double": [
    "{0} and {1} are cooking..",
    "{0} and {1} causing chaos.."
  ],
  "Multiple": [
    "{0}, {1} and more going crazy..",
    "everyone typing their hot takes.."
  ]
}
```

#### Other UI Elements

```json
"OnlineUsersHeader": [
  "the gang ({0})",
  "squad check ({0})"
],
"RoomHeaders": [
  "# {0}",
  "{0} vibes only"
]
```

To add variations, add strings to any list. There is no registry to update.

## Technical notes

`ChatConfigService` reads these values from `IConfiguration` on each access, picks the random text,
formats the placeholders, and supplies the defaults. It is registered as scoped in `Program.cs` and
injected where needed (login, welcome, the chat pages, the sidebar, the message input, the pickers, admin, invite).

## Custom Emojis

Place image files in `Data/custom-emojis/` (created on first run). Supported formats are PNG, SVG,
GIF, WebP, and JPG/JPEG.

The filename without extension becomes the shortcode. Use only letters, numbers, hyphens, and
underscores.

| File | Shortcode |
|------|-----------|
| `pepe.png` | `:pepe:` |
| `party-parrot.gif` | `:party-parrot:` |

- The folder is scanned once at startup. Restart after adding files.
- Custom emojis appear as the first category in the emoji picker and work in messages and reactions.
- Duplicate shortcodes (same name, different extension) are logged and skipped.
- Built-in emoji packs ship under `Yap/wwwroot/emoji-packs/`. See the README there for pack layout
  and search keywords.

In Docker, `Data/` is the config volume, so drop the images into `custom-emojis/` inside the
mounted directory.
