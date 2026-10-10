using System.Collections.Concurrent;
using System.Net;
using System.Reflection;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Components;

namespace Yap.Services;

/// <summary>
/// Active emoji renderer (second partial of <see cref="EmojiService"/>). Emits emoji
/// <c>&lt;img&gt;</c> tags for the set selected by <see cref="ActiveEmojiStyle"/> — Apple
/// (emoji-datasource-apple PNGs) or Twemoji (SVGs) — with self-hosted overrides in
/// <c>wwwroot/emoji-fallback/</c> taking priority in both modes.
///
/// Resolution order for each emoji:
///   1. self-hosted override  (wwwroot/emoji-fallback/{codepoint}.png) — for emoji missing or
///      outdated in the chosen set (e.g. new Unicode releases). Drop a file named by its codepoint
///      and it is picked up automatically (folder scanned once at startup).
///   2. the chosen artwork set (local pinned Twemoji, or Apple CDN — per ActiveEmojiStyle).
///   3. local Twemoji artwork (final onerror fallback; skipped when Twemoji is already the source).
///
/// Apple filename convention (verified against the CDN): the fully-qualified <c>unified</c>
/// codepoint, lowercased — FE0F kept, each codepoint zero-padded to >=4 (heart = 2764-fe0f,
/// grinning = 1f600). Twemoji uses the inverse (FE0F stripped, minimal width) via
/// <see cref="GetCodePoint"/>. Because EmojiData.cs stores emoji bare, bare legacy/keycap emoji are
/// mapped via <see cref="AppleMap"/> (from emoji.json); the override-file key is always the
/// Apple-set codepoint.
/// </summary>
public partial class EmojiService
{
    private enum EmojiStyle { Apple, Twemoji }

    // === Switch the active emoji set here (code-only; nothing in the UI). ===
    // Self-hosted overrides in wwwroot/emoji-fallback/ always take priority in both modes.
    private const EmojiStyle ActiveEmojiStyle = EmojiStyle.Twemoji;   // Twemoji since 2026-06-23 (c36b95b); flip to Apple to go back

    private const char VariationSelector = (char)0xFE0F; // U+FE0F

    // 64px is the largest individual image size emoji-datasource ships.
    private const string AppleCdnBase = "https://cdn.jsdelivr.net/npm/emoji-datasource-apple@16.0.0/img/apple/64";
    private static string AppleImgUrl(string codePoint) => $"{AppleCdnBase}/{codePoint}.png";

    // Self-hosted overrides served from wwwroot/emoji-fallback/, and the local Twemoji artwork used as the
    // pinned Twemoji source / universal final fallback.
    private const string LocalFallbackUrlBase = "/emoji-fallback";
    private const string TwemojiLocalBase = "/chat-client/emoji";

    // Memoized <img> markup for picker cells (lazy; the style is a const so a rebuild rebuilds it).
    private readonly ConcurrentDictionary<string, MarkupString> _emojiCache = new();

    // bare (FE0F-stripped) codepoint key -> fully-qualified apple filename. Lazily loaded.
    private Dictionary<string, string>? _appleMap;
    private readonly object _appleMapLock = new();

    // Codepoints that have a self-hosted PNG in wwwroot/emoji-fallback/. Scanned once, lazily.
    private HashSet<string>? _localOverrides;
    private readonly object _localOverridesLock = new();

    /// <summary>Emoji artwork for retained Blazor controls.</summary>
    /// <remarks>No Twemoji <c>onerror</c> fallback: every picker emoji comes from the curated
    /// EmojiData set and is present in the chosen artwork set, so the fallback would only bloat ~1400
    /// cached cells. Cells are <c>loading="lazy"</c> — load-bearing for the mounted-hidden
    /// picker: inside <c>display:none</c> a lazy image never intersects, so ~1000 image fetches
    /// wait until the picker actually opens and cells scroll near view.</remarks>
    public MarkupString GetEmojiHtml(string emoji)
        => _emojiCache.GetOrAdd(emoji, e => ConvertEmojis(e, forceSmall: true, withFallback: false, lazyImg: true));

    /// <summary>
    /// Converts Unicode emoji in <paramref name="text"/> to <c>&lt;img&gt;</c> tags for the active
    /// emoji set (<see cref="ActiveEmojiStyle"/>). Custom <c>:shortcode:</c> emoji and all sizing
    /// behaviour match the Twemoji backup path. When <paramref name="withFallback"/> is true, each
    /// Unicode-emoji image gets an <c>onerror</c> handler that falls back to the local Twemoji artwork.
    /// <paramref name="lazyImg"/> adds <c>loading="lazy"</c> — picker cells only; message content
    /// stays eager so emoji never pop in while reading.
    /// </summary>
    public MarkupString ConvertEmojis(string text, bool forceSmall = false, bool inline = false, bool withFallback = true, bool lazyImg = false)
    {
        if (string.IsNullOrEmpty(text))
            return new MarkupString(text);

        var isEmojiOnly = !forceSmall && !inline && IsEmojiOnlyMessage(text);

        var (emojiSize, verticalAlign)
            = (inline, forceSmall, isEmojiOnly) switch
            {
                (true, _, _) => ("1em", "-0.15em"),     // Inline text (display names, room names)
                (_, true, _) => ("18px", "-3px"),        // Reaction pills
                (_, _, true) => ("3em", "-0.4em"),       // Emoji-only messages
                _ => ("1.2em", "-0.2em")                 // Mixed content messages
            };

        // Replace custom emoji shortcodes FIRST (local images - identical to the Twemoji path).
        var result = CustomEmojiShortcodeRegex().Replace(text, match =>
        {
            var shortcode = match.Groups[1].Value;
            var emoji = _customEmojiService.GetByShortcode(shortcode);
            if (emoji == null)
                return match.Value;

            return $"<img src=\"{emoji.Url}\"{(lazyImg ? " loading=\"lazy\"" : "")} alt=\":{emoji.Shortcode}:\" class=\"emoji custom-emoji\" " +
                   $"style=\"width: {emojiSize}; height: {emojiSize}; vertical-align: {verticalAlign}; display: inline-block; object-fit: contain;\" />";
        });

        // Replace Unicode emojis, merging ZWJ sequences / skin tones into single images.
        var emojiMatches = EmojiRegex().Matches(result);
        if (emojiMatches.Count > 0)
        {
            var sb = new StringBuilder(result.Length + emojiMatches.Count * 100);
            var lastEnd = 0;
            var i = 0;

            while (i < emojiMatches.Count)
            {
                var seqStart = emojiMatches[i].Index;
                var seqEnd = seqStart + emojiMatches[i].Length;

                var next = i + 1;
                while (next < emojiMatches.Count)
                {
                    var gapStart = seqEnd;
                    var gapLength = emojiMatches[next].Index - gapStart;
                    if (ShouldMergeEmoji(result, gapStart, gapLength, emojiMatches[next].Index))
                    {
                        seqEnd = emojiMatches[next].Index + emojiMatches[next].Length;
                        next++;
                    }
                    else break;
                }

                // Consume trailing variation selectors (FE0F) that follow the sequence.
                while (seqEnd < result.Length && result[seqEnd] == VariationSelector)
                    seqEnd++;

                sb.Append(result, lastEnd, seqStart - lastEnd);

                var emoji = result.Substring(seqStart, seqEnd - seqStart);
                var codePoint = ResolveAppleCodePoint(emoji);

                if (string.IsNullOrEmpty(codePoint) || codePoint == "fffd")
                    sb.Append(emoji);
                else
                    sb.Append(BuildEmojiImg(emoji, codePoint, emojiSize, verticalAlign, withFallback, lazyImg));

                lastEnd = seqEnd;
                i = next;
            }

            sb.Append(result, lastEnd, result.Length - lastEnd);
            result = sb.ToString();
        }

        return new MarkupString(result);
    }

    /// <summary>
    /// Builds an emoji <c>&lt;img&gt;</c>: self-hosted override if present, otherwise the active set's
    /// artwork (<see cref="ActiveEmojiStyle"/> — Apple or Twemoji), with an optional <c>onerror</c>
    /// fallback to the local Twemoji artwork.
    /// </summary>
    private string BuildEmojiImg(string emoji, string appleCp, string size, string verticalAlign, bool withFallback, bool lazyImg = false)
    {
        var twemojiCp = GetCodePoint(emoji); // Twemoji naming (FE0F stripped, minimal width)
        var twemojiUrl = (!string.IsNullOrEmpty(twemojiCp) && twemojiCp != "fffd")
            ? $"{TwemojiLocalBase}/{twemojiCp}.svg"
            : null;

        // The chosen set for everything that isn't a self-hosted override.
        var restUrl = ActiveEmojiStyle == EmojiStyle.Twemoji
            ? (twemojiUrl ?? AppleImgUrl(appleCp))   // Twemoji (fall to Apple if Twemoji can't name it)
            : AppleImgUrl(appleCp);                  // Apple

        var src = LocalOverrides.Contains(appleCp)
            ? $"{LocalFallbackUrlBase}/{appleCp}.png"
            : restUrl;

        // Twemoji is the universal last-resort; skip it when it's already the source.
        var onError = "";
        if (withFallback && twemojiUrl != null && src != twemojiUrl)
            onError = $" onerror=\"this.onerror=null;this.src='{twemojiUrl}'\"";

        return $"<img src=\"{src}\"{onError}{(lazyImg ? " loading=\"lazy\"" : "")} alt=\"{emoji}\" class=\"emoji\" " +
               $"style=\"width: {size}; height: {size}; vertical-align: {verticalAlign}; display: inline-block;\" />";
    }

    /// <summary>
    /// Resolves an emoji sequence to the emoji-datasource-apple filename (no extension). This is the
    /// override-file key in both modes. Bare/legacy/keycap emoji hit the qualified-name map; astral,
    /// skin-tone and already-qualified input fall through to a direct keep-FE0F + pad-to-4 computation.
    /// </summary>
    private string ResolveAppleCodePoint(string emoji)
    {
        try
        {
            var bareKey = NormalizeCodePoints(emoji, keepFe0f: false);
            if (AppleMap.TryGetValue(bareKey, out var qualified))
                return qualified;

            return NormalizeCodePoints(emoji, keepFe0f: true);
        }
        catch
        {
            return "";
        }
    }

    /// <summary>
    /// Hyphen-joined lowercase hex codepoints, each padded to a minimum of 4 digits
    /// (emoji-datasource convention). FE0F is optionally dropped.
    /// </summary>
    private static string NormalizeCodePoints(string emoji, bool keepFe0f)
    {
        var parts = new List<string>();
        for (int i = 0; i < emoji.Length; i++)
        {
            var c = emoji[i];

            if (char.IsHighSurrogate(c) && i + 1 < emoji.Length && char.IsLowSurrogate(emoji[i + 1]))
            {
                var cp = 0x10000 + (c - 0xD800) * 0x400 + (emoji[i + 1] - 0xDC00);
                parts.Add(cp.ToString("x4"));
                i++;
                continue;
            }

            if (!keepFe0f && c == VariationSelector)
                continue;

            parts.Add(((int)c).ToString("x4"));
        }

        return string.Join("-", parts);
    }

    private Dictionary<string, string> AppleMap
    {
        get
        {
            if (_appleMap != null)
                return _appleMap;

            lock (_appleMapLock)
            {
                _appleMap ??= LoadAppleMap();
            }

            return _appleMap;
        }
    }

    private HashSet<string> LocalOverrides
    {
        get
        {
            if (_localOverrides != null)
                return _localOverrides;

            lock (_localOverridesLock)
            {
                _localOverrides ??= ScanLocalOverrides();
            }

            return _localOverrides;
        }
    }

    /// <summary>
    /// Scans wwwroot/emoji-fallback/ for self-hosted override PNGs, keyed by the codepoint
    /// (the filename without extension, e.g. <c>1faea.png</c> -&gt; <c>1faea</c>).
    /// </summary>
    private static HashSet<string> ScanLocalOverrides()
    {
        var set = new HashSet<string>(StringComparer.Ordinal);

        try
        {
            var dir = Path.Combine(Directory.GetCurrentDirectory(), "wwwroot", "emoji-fallback");
            if (Directory.Exists(dir))
            {
                foreach (var file in Directory.GetFiles(dir, "*.png"))
                    set.Add(Path.GetFileNameWithoutExtension(file).ToLowerInvariant());
            }
        }
        catch
        {
            // Best-effort: without overrides, emoji fall back to the chosen set / Twemoji.
        }

        return set;
    }

    /// <summary>
    /// Builds the bare->qualified filename map from the embedded emoji.json. Only entries whose
    /// fully-qualified form contains FE0F need mapping (everything else matches the bare
    /// computation), so the map stays small.
    /// </summary>
    private static Dictionary<string, string> LoadAppleMap()
    {
        var map = new Dictionary<string, string>(StringComparer.Ordinal);

        try
        {
            var asm = typeof(EmojiService).Assembly;
            var resourceName = asm.GetManifestResourceNames()
                .FirstOrDefault(n => n.EndsWith("emoji.json", StringComparison.OrdinalIgnoreCase));
            if (resourceName == null)
                return map;

            using var stream = asm.GetManifestResourceStream(resourceName);
            if (stream == null)
                return map;

            using var doc = JsonDocument.Parse(stream);
            foreach (var el in doc.RootElement.EnumerateArray())
            {
                if (!el.TryGetProperty("unified", out var unifiedEl))
                    continue;

                var unified = unifiedEl.GetString();
                if (string.IsNullOrEmpty(unified)
                    || unified.IndexOf("FE0F", StringComparison.OrdinalIgnoreCase) < 0)
                    continue; // bare form already resolves correctly

                // Skip emoji with no Apple artwork (would 404 either way).
                if (el.TryGetProperty("has_img_apple", out var hasApple) && hasApple.ValueKind == JsonValueKind.False)
                    continue;

                var filename = unified.ToLowerInvariant();                              // e.g. "2764-fe0f"
                var key = string.Join("-", filename.Split('-').Where(p => p != "fe0f")); // e.g. "2764"
                map[key] = filename;
            }
        }
        catch
        {
            // Best-effort: the fallback computation still handles astral/qualified input.
        }

        return map;
    }
}
