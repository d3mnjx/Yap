using System.Text;
using System.Text.RegularExpressions;

namespace Yap.Services;

public partial class EmojiService
{
    private readonly CustomEmojiService _customEmojiService;
    public EmojiService(CustomEmojiService customEmojiService)
    {
        _customEmojiService = customEmojiService;
    }

    // More precise emoji regex - common emojis only
    [GeneratedRegex(
        @"(?:[\u2700-\u27bf]|(?:\ud83c[\udde6-\uddff]){2}|[\ud800-\udbff][\udc00-\udfff]|[\u0023-\u0039]\ufe0f?\u20e3|\u3299|\u3297|\u303d|\u3030|\u24c2|\ud83c[\udd70-\udd71]|\ud83c[\udd7e-\udd7f]|\ud83c\udd8e|\ud83c[\udd91-\udd9a]|\ud83c[\udde6-\uddff]|\ud83c[\ude01-\ude02]|\ud83c\ude1a|\ud83c\ude2f|\ud83c[\ude32-\ude3a]|\ud83c[\ude50-\ude51]|\u203c|\u2049|[\u25aa-\u25ab]|\u25b6|\u25c0|[\u25fb-\u25fe]|\u00a9|\u00ae|\u2122|\u2139|\ud83c\udc04|[\u2600-\u26FF]|\u2b05|\u2b06|\u2b07|\u2b1b|\u2b1c|\u2b50|\u2b55|\u231a|\u231b|\u2328|\u23cf|[\u23e9-\u23f3]|[\u23f8-\u23fa]|\ud83c\udccf|\u2934|\u2935|[\u2190-\u21ff])")]
    private static partial Regex EmojiRegex();

    [GeneratedRegex(@":([a-zA-Z0-9_-]+):")]
    private static partial Regex CustomEmojiShortcodeRegex();

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
