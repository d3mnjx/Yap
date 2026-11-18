# Yap

Yap is self-hosted real-time chat for small communities, inspired by Discord aesthetics. Frictionless login, fun and customizable to make your own, great with media, fast and polished on both desktop and phone (PWA).

![Screenshot](screenshot.png)

## Features

- **No registration required** - Just log in with username, no passwords or social logins, irc vibes but modern style
- **Database optional** - Everything can be ephemeral and live only in memory (wiped on app reset) or you can use SQLite for persistence
- **Customizable system messages** - make it fun or serious
- **Beautiful emojis** - Beautiful Twemoji rendering
- **Custom emojis** - Drop image files into `Data/custom-emojis/` (data volume) folder and they become available for your users
- **Themes** - Discord Dark, Midnight, Nord, Ocean, Sunset, Aurora, Terminal, Neon Glow, Tea House, Daylight, Solarized Light
- **User profiles** - Set profile picture, display name, and bio; avatars shown in chat
- **Gifs** - gifs by Klipy + your own, server collections curated by server admin, user favs + customs, bulk import / export
- **Image/Video sharing** - Upload image(s) or videos and see them in inline gallery
- **Social media previews/embeds** - Yap downloads that tiktok/youtube video so users dont need to go to these evil sites
- **Voice messages** - Record voice memos up to 5 minutes
- **Message actions** - Discord-style hover popup with reactions, edit, delete
- **Reactions** - React to messages with emojis, even custom ones
- **Tab notifications** - Unread count in browser tab + audio notifications
- **Typing indicators** - See who's typing with customizable messages
- **Multiple rooms/channels** - admin can create new, nobody will come anyway
- **Direct messages** - Private conversations between users, not encrypted, treat accordingly
- **Mobile responsive** - Works great(TM) on all devices with collapsible sidebar
- **PWA installable** - Add to home screen on mobile, install as app on desktop, pretend it's real app
- **Search** - Yes we have it, it's fast
- **Pinned messages** - So you can keep coming back for the gold

## Run with Docker

```bash
docker run -d --name yap -p 5221:8080 -v ./uploads:/app/wwwroot/uploads -v ./data:/app/Data ghcr.io/urza/yap:latest
```

There are two volumes:
- "uploads" which holds media (pictures) uploaded by users
- "data" which contains configuration (appsettings.json), SQLite db (if enabled), and custom emojis

Access at `http://localhost:5221` - it's up to you how to make this accessible for others. For example use some reverse proxy like nginx proxy manager  (https://nginxproxymanager.com/) or cloudflare tunnel.



## License

YOU CAN USE THIS SOFTWARE "AS IS" (NO WARRANTY) IN ANY WAY YOU WANT, BUT BY DOING SO YOU ACKNOWLEDGE THAT:

Science is a force for human liberation and one of humanity's greatest inventions. Through open inquiry, evidence, and the willingness to correct our errors, we expand our understanding and our ability to improve the human condition.

Technology is the physical manifestation of our discoveries. By building better tools, we overcome limitations, reduce suffering, and create abundance.

Free markets enable cooperation on an extraordinary scale. Through competition, exchange, and entrepreneurship, they reward useful ideas, spread innovation, and help lift people out of poverty.

