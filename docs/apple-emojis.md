# Emoji Rendering (Twemoji ⇄ Apple)

Documentation for the emoji-image feature. Audience: future maintainers (you and Claude).

## TL;DR

Yap renders **emoji as images for everyone** by reusing the existing unicode → `<img>` pipeline. A
single **code-only `const`** (`ActiveEmojiStyle`) flips the active set between **Twemoji** (SVGs)
and **Apple** (`emoji-datasource-apple` PNGs). **Twemoji is the active set since 2026-06-23**
(commit `c36b95b`); the app launched on Apple and the switch was flipped back after a few months.
Self-hosted overrides always win in both modes. There is **nothing in the UI**, it is a compile-time
switch.

Per-emoji resolution order (both modes):

1. **Self-hosted override** — `wwwroot/emoji-fallback/{codepoint}.png` (for emoji missing or
   outdated in the chosen set, e.g. new Unicode releases). Auto-discovered by a folder scan.
2. **Active set CDN** — Apple (`cdn.jsdelivr.net/npm/emoji-datasource-apple@16.0.0`) **or** Twemoji
   (`cdn.jsdelivr.net/gh/jdecked/twemoji@latest`), chosen by `ActiveEmojiStyle`.
3. **Twemoji CDN** — final `onerror` fallback for anything the active set is missing (skipped when
   Twemoji is already the source). In Twemoji mode the Apple CDN is still used for one case: an
   emoji that `GetCodePoint` cannot name for Twemoji falls to the Apple URL (`BuildEmojiImg`).

> **Why images at all?** We deliberately keep the "swap unicode for an image" model (rather than
> rendering native OS emoji) so every platform sees a consistent design. This was an explicit
> product choice.

## The toggle

Top of `Yap/Services/EmojiService.Rendering.cs`:

```csharp
private enum EmojiStyle { Apple, Twemoji }

// === Switch the active emoji set here (code-only; nothing in the UI). ===
private const EmojiStyle ActiveEmojiStyle = EmojiStyle.Twemoji;   // flip to EmojiStyle.Apple to go back
```

Flip it, rebuild, done. `BuildEmojiImg` reads it to choose the "rest" source; `LocalOverrides` is
checked first regardless, and Twemoji remains the `onerror` last-resort.

## Why this approach (background)

- Apple does **not** distribute its emoji as downloadable image assets — Apple Color Emoji is a
  proprietary OS font. The only way to show Apple art on *non-Apple* devices is to host Apple-style
  PNGs. We use the community `emoji-datasource-apple` image set (Apple-style art) served from jsDelivr.
- Licensing was explicitly ruled out of scope for this project (non-commercial app); that's the
  maintainer's call, not encoded here.
- We considered native-unicode rendering (real Apple emoji only on Apple devices, Twemoji elsewhere)
  but rejected it: it gives up cross-platform consistency.
- The switch back to Twemoji (2026-06-23) kept the whole Apple machinery in place. Override files are
  still named by the Apple-set codepoint, and `AppleMap` still bridges bare legacy emoji, so flipping
  the const is all it takes to go back.

## Code changes

### `Yap/Services/EmojiService.Rendering.cs` (the active renderer)

A **second partial** of `EmojiService` (the class was already `partial`). It contains the unified
renderer and reuses private helpers from `EmojiService.cs` (`EmojiRegex()`,
`CustomEmojiShortcodeRegex()`, `ShouldMergeEmoji`, `IsEmojiOnlyMessage`, `_customEmojiService`, and
crucially `GetCodePoint()` for the Twemoji codepoint/fallback).

Public methods (active, wired into the UI) and their dormant full-Twemoji backups in `EmojiService.cs`:

| Active method (this file) | Backup twin (EmojiService.cs, untouched) |
|---|---|
| `ConvertEmojis(text, forceSmall, inline, withFallback=true)` | `ConvertEmojisToTwemoji(text, forceSmall, inline)` |
| `RenderMessageContent(text)` | `ProcessMessageContent(text)` |
| `GetEmojiHtml(emoji)` | `GetPickerEmojiHtml(emoji)` |

Key internals:

- **`BuildEmojiImg(emoji, appleCp, …, withFallback)`** — emits the `<img>`. `src` = local override if
  present, else the **active set's** URL (Apple PNG or Twemoji SVG per `ActiveEmojiStyle`); plus an
  `onerror` → Twemoji when `withFallback` and Twemoji isn't already the src.
- **`ResolveAppleCodePoint(emoji)`** — the emoji-datasource filename (no extension); used as the
  **override-file key in both modes** and as the Apple URL. Uses `AppleMap` for bare/legacy/keycap
  emoji; otherwise a direct computation.
- **`NormalizeCodePoints(emoji, keepFe0f)`** — hyphen-joined lowercase hex, each codepoint padded to
  ≥4 digits (`ToString("x4")`), optionally dropping `FE0F`.
- **`AppleMap`** (lazy, from embedded `emoji.json`) — bare (FE0F-stripped) codepoint → fully-qualified
  filename. Only entries whose qualified form contains `FE0F` are stored, so the map is small.
- **`LocalOverrides`** (lazy folder scan of `wwwroot/emoji-fallback/`) — codepoints that have a
  self-hosted PNG.
- **`GetEmojiHtml`** passes `withFallback: false` — the picker's ~1400 cells are all curated emoji
  present in the chosen CDN, so the fallback markup would only bloat them.

> Naming note: set-specific helpers keep the "Apple" name (`AppleImgUrl`, `AppleCdnBase`, `AppleMap`,
> `ResolveAppleCodePoint`) because they refer to the Apple/emoji-datasource set / the override-file
> key even when `ActiveEmojiStyle == Twemoji`.

### `Yap/Data/emoji.json` (embedded resource)

The `emoji-datasource` metadata file (the `unified` codepoints used to build `AppleMap`). Embedded
via `Yap.csproj`:

```xml
<ItemGroup>
  <None Remove="Data\emoji.json" />
  <EmbeddedResource Include="Data\emoji.json" />
</ItemGroup>
```

Read at runtime with `Assembly.GetManifestResourceStream` (no constructor/DI change needed). It is
**not** web-served (it's inside the DLL).

### `Yap/wwwroot/emoji-fallback/`

Self-hosted Apple PNGs for emoji the chosen set lacks or draws badly. Served at `/emoji-fallback/*`
by the existing `app.UseStaticFiles()`. Current contents (2026-10):

| File | Emoji | Codepoint | Why |
|---|---|---|---|
| `1faef.png` | 🫯 fight cloud | U+1FAEF | Unicode 17 — missing from Apple @16 *and* Twemoji |
| `1facd.png` | orca | U+1FACD | Unicode 17 — missing from Apple @16 |
| `1f3f4-200d-2620-fe0f.png` | 🏴‍☠️ pirate flag | ZWJ seq | Apple art preferred over the set's |
| `1f525.png` | 🔥 fire | U+1F525 | Apple art preferred over Twemoji's |
| `1f3cb-fe0f.png`, `…-200d-2640-fe0f.png`, `…-200d-2642-fe0f.png` | 🏋️ weight lifter + ♀/♂ | ZWJ seqs | Apple art preferred over Twemoji's |
| `_1faea.png` | 🫪 distorted face | U+1FAEA | **Disabled.** Renamed with a leading underscore so the name no longer matches a codepoint; Twemoji has the glyph. Kept on disk in case of a switch back to Apple @16 |

Rename a file to disable an override. Delete it when the set has caught up for good.

### Wired active (call-site swaps)

The unicode-emoji calls in 7 components point at the active methods (`ConvertEmojis`,
`RenderMessageContent`, `GetEmojiHtml`). **`RenderCustomEmoji` is left alone** — custom `:shortcode:`
emoji are local images, identical under both sets.

Components: `MessageItem.razor`, `EmojiPicker.razor`, `ChatSidebar.razor`, `ChatHeader.razor`,
`UserProfileCard.razor`, `Pages/ChannelSettings.razor`, `Pages/Settings.razor`.

`ConvertEmojis` also takes `lazyImg` (default false). The picker passes `lazyImg: true` so that the
~1400 hidden cells fetch nothing until the picker opens.

### Untouched (full-revert backup)

`Yap/Services/EmojiService.cs` (the original Twemoji methods, caches, `GetCodePoint`) and
`Yap/Services/EmojiData.cs`. No model / migration / settings / DI changes.

## The filename convention (the important detail)

`emoji-datasource` names files by the **fully-qualified `unified` codepoint, lowercased**:
`FE0F` is **kept**, and each codepoint is **zero-padded to ≥4 hex digits**.

| Emoji | emoji-datasource (Apple) file | Twemoji file |
|---|---|---|
| 😀 U+1F600 | `1f600.png` | `1f600.svg` |
| ❤️ U+2764 FE0F | `2764-fe0f.png` | `2764.svg` (FE0F stripped) |
| ©️ U+00A9 FE0F | `00a9-fe0f.png` | `a9.svg` (minimal width) |
| #️⃣ U+0023 FE0F 20E3 | `0023-fe0f-20e3.png` | `23-20e3.svg` |
| 🏳️‍🌈 …FE0F‍🌈 | `1f3f4-fe0f-200d-1f308.png` | same |

Apple naming is the **inverse** of Twemoji's `GetCodePoint` (strips FE0F, minimal width). Because
`EmojiData.cs` stores its picker emoji **bare** (no FE0F), bare legacy/keycap emoji wouldn't match
the qualified Apple filenames — that's exactly what `AppleMap` bridges. Astral emoji, skin-tone
sequences, and FE0F-qualified keyboard input resolve directly without the map. `BuildEmojiImg`
computes both forms (`appleCp` via `ResolveAppleCodePoint`, the Twemoji one via `GetCodePoint`).

URLs:

- Apple CDN: `https://cdn.jsdelivr.net/npm/emoji-datasource-apple@16.0.0/img/apple/64/{appleCp}.png`
- Twemoji CDN: `https://cdn.jsdelivr.net/gh/jdecked/twemoji@latest/assets/svg/{twemojiCp}.svg`
- Local: `/emoji-fallback/{appleCp}.png` (override files are named by the **Apple-set** codepoint)

---

## How to add / fix an emoji (the part you'll come back for)

You'll need this when an emoji renders broken, or a new Unicode set drops and you want the art.

### The foolproof recipe

1. **Find the codepoint the app is looking for.** Send the emoji in the app, open DevTools →
   **Network**, and look at the request the `<img>` made.
   - **Apple mode:** the failing (404) request is `…/img/apple/64/XXXX.png`. **`XXXX` is exactly the
     name your file must have.**
   - **Twemoji mode (current):** the request is `…/twemoji…/svg/YYYY.svg`, and that name is **not**
     the override key. Twemoji strips `FE0F` and minimal-width pads, Apple keeps `FE0F` and pads to 4.
     For a single astral emoji (`1faef`) the two names are the same. For anything with `FE0F`, a
     keycap, or a short codepoint, derive the Apple name with the manual rules below, or flip the
     const to Apple for one local run and read the name off the 404.
   The override key is the Apple-set codepoint in both modes.
2. **Get an Apple PNG** for that emoji (e.g. from [emojipedia](https://emojipedia.org) — the page's
   image; its filename usually contains the codepoint too).
3. **Save it as `wwwroot/emoji-fallback/XXXX.png`** (same `XXXX` from step 1).
4. **Restart the app.** The override folder is scanned once at startup. (`UseStaticFiles` serves the
   file at runtime; the scan is what registers it for the lookup — so a restart is required.)

That's it. Local overrides win, so this also **replaces** an emoji whose set art is outdated (e.g. the
pirate flag).

### Naming without DevTools (manual codepoint rules)

Take the emoji's Unicode codepoints (emojipedia lists them under "Codepoints"), lowercase the hex,
drop the `U+`, join multiple with `-`:

- **Single new emoji** (most common): just the hex — `U+1FAEF` → `1faef.png`.
- **Sequences** (ZWJ flags/professions, keycaps): include every codepoint *including* `fe0f` and
  `200d`, in order — 🏴‍☠️ `U+1F3F4 U+200D U+2620 U+FE0F` → `1f3f4-200d-2620-fe0f.png`.
- Pad any codepoint shorter than 4 hex digits to 4 (`U+0023` → `0023`). Astral emoji (U+1Fxxx) are
  already ≥4.

If a file is mis-named it simply won't match (the emoji falls through to the set CDN / Twemoji). When
in doubt, use the DevTools recipe.

### Add it to the picker too (optional)

The fallback renders the emoji wherever it's typed, but it won't appear in the picker drawer until
it's in `EmojiData.cs`. Add the character to the right category's array and an `EmojiKeywords` entry
(use the C# escape `"\U0001FACD"` for brand-new astral glyphs so they can't be mangled in source).
Example: orca was added to the `animals` array after the whale.

### When a newer `emoji-datasource-apple` ships (e.g. v17)

The cleaner long-term fix for "new Unicode set" is to bump the package instead of self-hosting each
emoji:

1. Update the version in **two** places to keep the map and images in sync:
   - `AppleCdnBase` in `Services/EmojiService.Rendering.cs` (the CDN URL).
   - `Yap/Data/emoji.json` — re-download from the matching version:
     `curl -sSL https://cdn.jsdelivr.net/npm/emoji-datasource-apple@<NEW_VER>/emoji.json -o Yap/Data/emoji.json`
2. Rebuild (the embedded resource is baked at build time).
3. Remove any now-redundant files from `wwwroot/emoji-fallback/` (the CDN now has them). Leftover
   overrides aren't harmful — local always wins — but clean them up to avoid stale art.

### Edge cases

- **Emoji missing from the active set *and* Twemoji** (e.g. fight cloud was 404 on both) → it *must*
  be self-hosted, or it renders broken. There's no other source.
- **Skin-tone variants** of an overridden base aren't covered by a single file — e.g. a local
  `1f483.png` (💃) does not cover `1f483-1f3fd` (💃🏽). Add each variant's file if needed (the CDN
  usually has skin-tone variants already, so this is rare).
- **Picker** uses `GetEmojiHtml` (no Twemoji `onerror`). Its emoji come from the curated
  `EmojiData.cs` set and are all in the chosen CDN, so they never need the fallback.

## Switching the emoji set

- **Twemoji ⇄ Apple (recommended):** flip `ActiveEmojiStyle` in `EmojiService.Rendering.cs` and
  rebuild. Local overrides still apply in both modes. In Twemoji mode the Apple CDN is only hit for an
  emoji Twemoji cannot name.
- **Full revert to the original Twemoji path (drops local overrides):** swap the 7 components' call
  sites to the `EmojiService.cs` backups — `ConvertEmojis`→`ConvertEmojisToTwemoji`,
  `RenderMessageContent`→`ProcessMessageContent`, `GetEmojiHtml`→`GetPickerEmojiHtml`. ⚠️ This loses
  the self-hosted overrides, so brand-new emoji (orca/fight-cloud) render broken — prefer the const.

(Grep `ConvertEmojis\b\|RenderMessageContent\|GetEmojiHtml` to find every active call site.)

## Verify after changes

1. `dotnet build` (with `ActiveEmojiStyle = Twemoji`, the current value), run, hard-refresh. Picker
   shows Twemoji SVGs; Network shows `…/jdecked/twemoji…/svg/*.svg` (200). The overrides (🫯 orca 🏴‍☠️
   🔥 🏋️) come from `/emoji-fallback/`, and legacy/keycap (❤ ☀ © `#️⃣`) render with no 404s.
2. Flip the const to `Apple`, rebuild, hard-refresh. Non-override emoji now load
   `…emoji-datasource-apple@16.0.0/img/apple/64/*.png`; the overrides **still** come from
   `/emoji-fallback/`. Flip back before committing.
3. Force a fallback in Apple mode: an emoji the Apple CDN lacks should swap to a `…/jdecked/twemoji…svg`.
4. Reactions, emoji-only "jumbo" sizing, inline emoji in names, and custom `:shortcode:` emoji all fine.
