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

The `Data/` file takes the place of `Yap/appsettings.json` in the configuration stack. The sources
above it still win: `appsettings.Development.json` in Development, environment variables, and the
command line. So a deployment or a test can override any key without an edit to the `Data/` file.

## Top-level keys

```json
{
  "Logging": { ... },
  "AllowedHosts": "*",
  "Vapid": { "Subject": "mailto:...", "PublicKey": "...", "PrivateKey": "..." },
  "ChatSettings": { ... }
}
```

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
| `ClearUploadsOnStart` | bool | false | Delete all uploaded files when the app starts |
| `MaxUploadSizeMB` | int | 100 | Upload size limit for images and videos |
| `UploadUrl` | string | "" | Upload endpoint. Empty means same origin (`/api/tus`). Set a full URL to bypass a proxy upload limit (Cloudflare) |
| `UploadsPath` | string | "wwwroot/uploads" | Where uploaded files are stored, relative to the app folder. The URLs stay `/uploads/...` |
| `PublicOrigin` | string | "" | The address the login links carry, such as `https://chat.example.com`. Empty: each person's links use the address that person's own requests reached the server by, never another person's. Set it behind a proxy, together with `AllowedHosts` (top-level key), so a forged `Host` header cannot appear in anyone's link |
| `TrustedProxies` | string[] | [] | The reverse proxies whose `X-Forwarded-For` and `X-Forwarded-Proto` the server believes: addresses or CIDR networks, such as `["172.18.0.0/16"]` for a proxy container or the Docker gateway. Loopback is always trusted. Cloudflare needs no entry: its ranges are built in and refreshed daily, and behind a Cloudflare hop the visitor comes from `CF-Connecting-IP`, also when Caddy or nginx sits between Cloudflare and Yap without any Cloudflare configuration of its own. Behind a proxy that is not listed, every client address counts as unknown and smart login is off; the log warns at start and at the first such request, the bot tells the admin, and the Admin page shows a red notice with the address to add |
| `CloudflareIpsUrl` | string | Cloudflare's API | Where the Cloudflare ranges are refreshed from, once a day. The last download is kept in `Data/cloudflare-ips.json`. Empty turns the refresh off; the built-in list and the last download stay in use |
| `Ipv4BeaconUrl` | string | "" | Origin with an A record only, pointing at this app. The admin panel uses it to learn the IPv4 of dual-stack clients. Empty disables it |
| `PushSubscriptionStorage` | string | "Json" | `"Json"` stores push subscriptions in `Data/push-subscriptions.json`. `"Database"` stores them in the DB |
| `WelcomePageEnabled` | bool | true | Show `Data/welcome/welcome.html` before the login page, if the file exists |
| `Bot` | object | | The system bot. `Enabled`, `Username`, `DisplayName`, `WelcomeMessage` (`{server}` or `{0}` is the project name). The display name applies when the bot account is created; the welcome text applies until the admin saves one. After that the admin panel owns the display name, the picture and the three parts of the welcome message, in `Data/bot-settings.json` and the bot's user row |
| `Persistence` | object | | `Enabled`, `ConnectionStrings.SQLite`. With persistence off, everything lives in memory and is wiped on restart. `Load.MaxMessagesPerChannel` and `Load.MaxDays` bound what the start loads per conversation: the newest messages, at most that many and at most that many days old. 0 or absent = no bound. Older messages stay in the database and nobody can read them until the bound changes and the server restarts |
| `GifSettings` | object | | `UserQuotaMB`, `MaxPackSizeMB`, `Klipy.ApiKey` (free key from partner.klipy.com), `Klipy.CustomerId`, `Klipy.Locale`. Without an API key, provider search and trending are off. Own uploads and server collections still work |
| `FunnyTexts` | object | | Randomized UI text, see below |

The comments in `Yap/appsettings.json` are the source of truth for these keys. If this table and
that file disagree, trust the file.

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

Each UI element picks a random item from its list once, when it first shows, and keeps it until the page reloads (GEN-12). `{0}` and `{1}` are
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

#### New Messages Pill
The pill that shows when messages arrive while the reader is scrolled up. One phrase per appearance.

```json
"NewMessagesPill": ["New messages"]
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

#### Search

The message search has two lists, in the group `Search`. `Placeholder` is the text in the empty search
field; `{0}` is the name of the room or of the person. `NoResults` shows when a search finds nothing;
`{0}` is what the person searched for. The other texts of the search are fixed.

```json
"Search": {
  "Placeholder": [
    "search...",
    "find the receipts...",
    "search {0}..."
  ],
  "NoResults": [
    "crickets...",
    "nobody said {0}"
  ]
}
```

To add variations, add strings to any list. There is no registry to update.

## Technical notes

`ServerConfig` reads these lists from the configuration and supplies the defaults. The bootstrap
answer carries them to the client, which picks the random text and fills the placeholders.

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
