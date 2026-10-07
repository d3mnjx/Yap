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
