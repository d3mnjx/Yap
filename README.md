# Yap

Self hosted community chat inspired by Discord aesthetics

![Screenshot](screenshot.png)


## Run with Docker

```bash
docker run -d --name yap -p 5221:8080 -v ./uploads:/app/wwwroot/uploads -v ./data:/app/Data ghcr.io/urza/yap:latest
```

There are two volumes:
- "uploads" which holds media (pictures) uploaded by users
- "data" which contains configuration (appsettings.json), SQLite db (if enabled), and custom emojis

Access at `http://localhost:5221` - it's up to you how to make this accessible for others. For example use some reverse proxy like nginx proxy manager  (https://nginxproxymanager.com/) or cloudflare tunnel.

## Features

- **No registration required** - Just log in with username, no passwords or social logins
- **User profiles** - Set profile picture, display name, and bio; avatars shown in chat
- **Offline chat** - Cached conversations, local drafts and queued messages/actions survive disconnection and reload. Sending works with or without SQLite.
- **Database optional** - Accounts, messages, operation receipts and read checkpoints can live only in memory and are wiped on restart, or use SQLite to retain them.
- **Customizable labels in config** - make it fun or serious
- **Emoji support** - Beautiful Twemoji rendering 
- **Custom emojis** - Drop image files into `Data/custom-emojis/` (data volume) folder and they become available for your users
- **Gifs** - gifs by Klipy + your own, server collections curated by server admin, user favs + customs, bulk import / export
- **Themes** - Dark, Midnight, Nord, Ocean, Sunset, Aurora, Daylight
- **Multiple rooms/channels** - admin can create new, nobody will come anyway
- **Direct messages** - Private conversations between users, not encrypted, treat accordingly
- **Message actions** - Discord-style hover popup with reactions, edit, delete
- **Reactions** - React to messages with emojis, even custom ones
- **Tab notifications** - Unread count in browser tab + audio notifications
- **Typing indicators** - See who's typing with customizable messages
- **Mobile responsive** - Works great(TM) on all devices with collapsible sidebar
- **PWA installable** - Add to home screen on mobile, install as app on desktop, get notifications
- **Image/Video sharing** - Upload image(s) or videos and see them in inline gallery
- **Social media previews/embeds** - Yap downloads that tiktok/youtube video so users dont need to go to these evil sites


## Architecture and development

Chat routes use a browser client with local storage and a service worker. ASP.NET remains authoritative for accounts, permissions and messages; Login, Settings and Admin continue to use Blazor. An authenticated online visit prepares cached reading and durable outgoing work for later disconnection.

- [Offline behavior](docs/offline-behavior.md): cached reading, drafts, outgoing operations, account isolation and recovery limits.
- [Architecture](docs/offline-client-architecture.md) and [interactive diagrams](docs/offline-architecture.html): module ownership, data flow and repository structure.
- [Communication guide](docs/offline-communication.html): startup order, HTTP versus SignalR, message flow and retained Blazor interactivity, with diagrams and source excerpts.
- [Feature reference](docs/feature-parity-inventory.md): the maintained list of Yap features, regression coverage and verification limits.
- [Testing and formatting](tests/browser/README.md): pinned tools, isolated fixtures and suite prerequisites.
- [Deployment and rollback](GHCR-DEPLOYMENT-GUIDE.md#upgrading-yap-to-the-offline-client): persistent data, proxy/cache configuration and safe upgrade checks.

## License

YOU CAN USE THIS SOFTWARE "AS IS" (NO WARRANTY) IN ANY WAY YOU WANT, BUT BY DOING SO YOU ACKNOWLEDGE THAT:

Science is a force for human liberation and one of humanity's greatest inventions. Through open inquiry, evidence, and the willingness to correct our errors, we expand our understanding and our ability to improve the human condition.

Technology is the physical manifestation of our discoveries. By building better tools, we overcome limitations, reduce suffering, and create abundance.

Free markets enable cooperation on an extraordinary scale. Through competition, exchange, and entrepreneurship, they reward useful ideas, spread innovation, and help lift people out of poverty.
