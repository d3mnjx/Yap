Twemoji artwork v17.0.3, https://github.com/jdecked/twemoji/tree/v17.0.3/assets/svg
Artwork: CC-BY 4.0; see LICENSE-GRAPHICS. No runtime JavaScript dependency.

The 4,009 SVGs are unmodified upstream files. Images load independently and the
service worker caches them on use in `yap-chat-emoji-17.0.3`, independently of
app-shell updates. The transition copies SVGs already cached by shell v35.
Custom packs, local overrides and catalog metadata retain shell-scoped caching. Only the three default quick reactions are
precached; personal quick reactions and up to 20 recents warm after metadata is
available. Uncached images offline fall back to Unicode or custom shortcodes.
There is no artwork bundle, SVG JSON parsing or emoji Blob URL allocation.

catalog.js contains only shipped picker/search metadata and SVG filename stems,
so Unicode sequences and built-in packs work before account metadata arrives.
It is generated from the same C# services as the authenticated catalog, with an
empty temporary server-custom directory (no account or deployment data).

After changing EmojiData, built-in packs, overrides, or the pinned artwork, run
from the repository root:

    dotnet run --project scripts/EmojiCatalog

Commit catalog.js with the asset change; the startup manifest derives the new shell hash. This maintenance
command is not required for ordinary builds or deployment. To update Twemoji,
replace only *.svg with assets/svg/*.svg from the chosen pinned source archive,
update this version attribution and CHAT_EMOJI_CACHE in worker.js, and preserve
the upstream licenses. Only a changed artwork pin replaces the SVG cache; ordinary
Ordinary shell updates retain it. Cache misses after a pin change bypass the HTTP cache
so old responses at the same image paths cannot override the new artwork.
