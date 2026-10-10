using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Components;

namespace Yap.Services;

public partial class EmojiService
{
    private readonly CustomEmojiService _customEmojiService;
    private readonly Dictionary<string, MarkupString> _pickerEmojiCache = new();

    public EmojiService(CustomEmojiService customEmojiService)
    {
        _customEmojiService = customEmojiService;

        // Precompute <img> HTML for all known emojis used in the picker.
        // This eliminates ~1400 regex operations per render cycle.
        CachePickerEmoji("🕐"); // Recent tab icon
        foreach (var category in EmojiData.Categories)
        {
            CachePickerEmoji(category.Value.Icon);
            foreach (var emoji in category.Value.Emojis)
                CachePickerEmoji(emoji);
        }
    }

    private void CachePickerEmoji(string emoji)
    {
        if (_pickerEmojiCache.ContainsKey(emoji))
            return;

        var codePoint = GetCodePoint(emoji);
        if (!string.IsNullOrEmpty(codePoint) && codePoint != "fffd")
        {
            _pickerEmojiCache[emoji] = new MarkupString(
                $"<img src=\"/chat-client/emoji/{codePoint}.svg\" " +
                $"alt=\"{emoji}\" class=\"emoji\" style=\"width: 18px; height: 18px; vertical-align: -3px; display: inline-block;\" />");
        }
    }

    /// <summary>
    /// Returns precomputed Twemoji HTML for a single emoji, optimized for the emoji picker.
    /// Falls back to full regex-based conversion for unknown emojis.
    /// </summary>
    public MarkupString GetPickerEmojiHtml(string emoji)
    {
        if (_pickerEmojiCache.TryGetValue(emoji, out var cached))
            return cached;

        return ConvertEmojisToTwemoji(emoji, forceSmall: true);
    }

    // More precise emoji regex - common emojis only
    [GeneratedRegex(
        @"(?:[\u2700-\u27bf]|(?:\ud83c[\udde6-\uddff]){2}|[\ud800-\udbff][\udc00-\udfff]|[\u0023-\u0039]\ufe0f?\u20e3|\u3299|\u3297|\u303d|\u3030|\u24c2|\ud83c[\udd70-\udd71]|\ud83c[\udd7e-\udd7f]|\ud83c\udd8e|\ud83c[\udd91-\udd9a]|\ud83c[\udde6-\uddff]|\ud83c[\ude01-\ude02]|\ud83c\ude1a|\ud83c\ude2f|\ud83c[\ude32-\ude3a]|\ud83c[\ude50-\ude51]|\u203c|\u2049|[\u25aa-\u25ab]|\u25b6|\u25c0|[\u25fb-\u25fe]|\u00a9|\u00ae|\u2122|\u2139|\ud83c\udc04|[\u2600-\u26FF]|\u2b05|\u2b06|\u2b07|\u2b1b|\u2b1c|\u2b50|\u2b55|\u231a|\u231b|\u2328|\u23cf|[\u23e9-\u23f3]|[\u23f8-\u23fa]|\ud83c\udccf|\u2934|\u2935|[\u2190-\u21ff])")]
    private static partial Regex EmojiRegex();

    [GeneratedRegex(@":([a-zA-Z0-9_-]+):")]
    private static partial Regex CustomEmojiShortcodeRegex();

    /// <summary>
    /// Converts all Unicode emoji characters in the specified text to Twemoji SVG image tags, preserving the original
    /// text for non-emoji content.
    /// </summary>
    /// <remarks>The rendered emoji images use the local Twemoji artwork and are styled according to the specified
    /// parameters. If the text consists only of emojis and whitespace, larger emoji images are used for emphasis. This
    /// method is intended for use in Blazor or other environments that support MarkupString rendering.</remarks>
    /// <param name="text">The input text that may contain Unicode emoji characters to be replaced with Twemoji images. Can be null or
    /// empty.</param>
    /// <param name="forceSmall">true to force emojis to render at a smaller size suitable for compact UI elements such as reaction pills;
    /// otherwise, false.</param>
    /// <param name="inline">true to render emojis with inline sizing and alignment, suitable for use within text flows such as display names
    /// or room names; otherwise, false.</param>
    /// <returns>A MarkupString containing the input text with all recognized emoji characters replaced by Twemoji SVG image
    /// tags. If no emojis are present or the input is null or empty, returns the original text as a MarkupString.</returns>
    public MarkupString ConvertEmojisToTwemoji(string text, bool forceSmall = false, bool inline = false)
    {
        if (string.IsNullOrEmpty(text))
            return new MarkupString(text);

        // Check if message contains only emojis (and whitespace)
        var isEmojiOnly = !forceSmall && !inline && IsEmojiOnlyMessage(text);

        var (emojiSize, verticalAlign)
            = (inline, forceSmall, isEmojiOnly) switch
            {
                (true, _, _) => ("1em", "-0.15em"),      // Inline text (display names, room names)
                (_, true, _) => ("18px", "-3px"),         // Reaction pills
                (_, _, true) => ("3em", "-0.4em"),        // Emoji-only messages
                _ => ("1.2em", "-0.2em")                  // Mixed content messages - nomral chat message containing text + emojis
            };

        // Replace custom emoji shortcodes FIRST (before Unicode emoji replacement)
        var result = CustomEmojiShortcodeRegex().Replace(text, match =>
        {
            var shortcode = match.Groups[1].Value;
            var emoji = _customEmojiService.GetByShortcode(shortcode);
            if (emoji == null)
                return match.Value; // Not a known custom emoji, leave as-is

            return $"<img src=\"{emoji.Url}\" alt=\":{emoji.Shortcode}:\" class=\"emoji custom-emoji\" " +
                   $"style=\"width: {emojiSize}; height: {emojiSize}; vertical-align: {verticalAlign}; display: inline-block; object-fit: contain;\" />";
        });

        // Replace Unicode emojis, merging ZWJ sequences into single images
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

                // Merge consecutive emoji matches that form a single visual emoji
                // (ZWJ sequences like 👨‍💻, skin tone modifiers like 👋🏻, combined like 👩🏻‍♀️)
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

                // Consume trailing variation selectors (FE0F) that follow the sequence
                while (seqEnd < result.Length && result[seqEnd] == '\uFE0F')
                    seqEnd++;

                // Append text before this emoji/sequence
                sb.Append(result, lastEnd, seqStart - lastEnd);

                // Extract full sequence and generate image
                var emoji = result.Substring(seqStart, seqEnd - seqStart);
                var codePoint = GetCodePoint(emoji);

                if (string.IsNullOrEmpty(codePoint) || codePoint == "fffd")
                {
                    sb.Append(emoji);
                }
                else
                {
                    sb.Append($"<img src=\"/chat-client/emoji/{codePoint}.svg\" " +
                              $"alt=\"{emoji}\" class=\"emoji\" style=\"width: {emojiSize}; height: {emojiSize}; vertical-align: {verticalAlign}; display: inline-block;\" />");
                }

                lastEnd = seqEnd;
                i = next;
            }

            sb.Append(result, lastEnd, result.Length - lastEnd);
            result = sb.ToString();
        }

        return new MarkupString(result);
    }

    /// <summary>
    /// Processes message content: extracts URLs and makes them clickable links,
    /// then applies emoji conversion to the non-URL parts.
    /// URLs are not processed for emoji shortcodes (e.g., :something: in a URL stays as-is).
    /// </summary>
    public MarkupString ProcessMessageContent(string text)
    {
        if (string.IsNullOrEmpty(text))
            return new MarkupString(text);

        var urls = LinkPreviewService.ExtractUrls(text);
        if (urls.Count == 0)
            return ConvertEmojisToTwemoji(text);

        // Split text around URLs and process each segment
        var sb = new StringBuilder();
        var remaining = text;

        foreach (var url in urls)
        {
            // Find the raw URL text in the remaining string
            // The URL might have been normalized (https:// prepended), so find the original text
            var searchUrl = url;
            var idx = remaining.IndexOf(searchUrl, StringComparison.Ordinal);

            // If normalized URL not found, try without https:// prefix (bare domain case)
            if (idx < 0 && searchUrl.StartsWith("https://"))
            {
                searchUrl = searchUrl["https://".Length..];
                idx = remaining.IndexOf(searchUrl, StringComparison.Ordinal);
            }

            if (idx < 0) continue;

            // Process text before the URL (with emoji conversion)
            if (idx > 0)
            {
                var before = remaining[..idx];
                sb.Append(ConvertEmojisToTwemoji(before).Value);
            }

            // Render the URL as a clickable link (HTML-encoded, no emoji processing)
            var encodedUrl = WebUtility.HtmlEncode(url);
            var encodedDisplay = WebUtility.HtmlEncode(searchUrl);
            sb.Append($"<a href=\"{encodedUrl}\" target=\"_blank\" rel=\"noopener noreferrer\" class=\"message-link\">{encodedDisplay}</a>");

            remaining = remaining[(idx + searchUrl.Length)..];
        }

        // Process any remaining text after the last URL
        if (remaining.Length > 0)
        {
            sb.Append(ConvertEmojisToTwemoji(remaining).Value);
        }

        return new MarkupString(sb.ToString());
    }

    private bool IsEmojiOnlyMessage(string text)
    {
        if (string.IsNullOrEmpty(text))
            return false;

        var trimmed = text.Trim();

        // Strip known custom emoji shortcodes
        var withoutCustom = CustomEmojiShortcodeRegex().Replace(trimmed, match =>
            _customEmojiService.IsCustomEmoji(match.Groups[1].Value) ? "" : match.Value);

        // Replace all Unicode emojis with empty string
        var withoutEmojis = EmojiRegex().Replace(withoutCustom, "");

        // Strip variation selectors (FE0F) and ZWJ (200D) that may remain
        // These are modifier characters attached to emojis but not matched by the regex
        withoutEmojis = withoutEmojis.Replace("\uFE0F", "").Replace("\u200D", "");

        // If nothing remains after removing emojis, it's emoji-only
        return string.IsNullOrWhiteSpace(withoutEmojis);
    }

    public MarkupString RenderCustomEmoji(CustomEmoji emoji, string size = "18px")
    {
        // Picker-only renderer (grid cells + sidebar tabs) — lazy so the mounted-hidden
        // picker doesn't fetch every custom emoji at page load.
        return new MarkupString(
            $"<img src=\"{emoji.Url}\" loading=\"lazy\" alt=\":{emoji.Shortcode}:\" class=\"emoji custom-emoji\" " +
            $"style=\"width: {size}; height: {size}; vertical-align: -3px; display: inline-block; object-fit: contain;\" />");
    }

    /// <summary>
    /// Determines whether two adjacent emoji regex matches should be merged into a
    /// single emoji sequence. Handles ZWJ sequences (👨‍💻) and skin tone modifiers (👋🏻).
    /// </summary>
    private static bool ShouldMergeEmoji(string text, int gapStart, int gapLength, int nextMatchIndex)
    {
        // Check what's in the gap between the two matches
        var hasZwj = false;
        for (var i = gapStart; i < gapStart + gapLength; i++)
        {
            if (text[i] == '\u200D') hasZwj = true;
            else if (text[i] == '\uFE0F') continue;
            else return false; // Non-combining character in gap — don't merge
        }

        // ZWJ present → always merge (ZWJ sequences like 👨‍💻, 🏳️‍🌈)
        if (hasZwj) return true;

        // Adjacent (gap=0) or FE0F-separated → merge only if next is a skin tone modifier
        return IsSkinToneModifier(text, nextMatchIndex);
    }

    /// <summary>
    /// Checks if the character at the given index is a Fitzpatrick skin tone modifier (U+1F3FB–U+1F3FF).
    /// </summary>
    private static bool IsSkinToneModifier(string text, int index)
    {
        if (index + 1 >= text.Length) return false;
        return text[index] == '\uD83C' && text[index + 1] is >= '\uDFFB' and <= '\uDFFF';
    }

    private static string GetCodePoint(string emoji)
    {
        try
        {
            // Match official Twemoji behavior:
            // ZWJ sequences: keep FE0F (Twemoji includes it in filenames)
            // Simple emojis: strip FE0F
            var hasZwj = emoji.Contains('\u200D');
            var codePoints = new List<string>();

            for (int i = 0; i < emoji.Length; i++)
            {
                var c = emoji[i];

                // Handle surrogate pairs
                if (char.IsHighSurrogate(c) && i + 1 < emoji.Length)
                {
                    var low = emoji[i + 1];
                    if (char.IsLowSurrogate(low))
                    {
                        var codePoint = 0x10000 + (c - 0xD800) * 0x400 + (low - 0xDC00);
                        codePoints.Add(codePoint.ToString("x"));
                        i++;
                        continue;
                    }
                }

                var charCode = (int)c;

                if (charCode == 0xFE0F && !hasZwj)
                    continue;

                codePoints.Add(charCode.ToString("x"));
            }

            return string.Join("-", codePoints);
        }
        catch
        {
            return "";
        }
    }
}
