using System.Globalization;
using System.Text;

namespace Yap.Helpers;

/// <summary>
/// The fold of the message search (SR-04): two texts that differ only in case or in accent marks fold to the same
/// text, so "prilis" finds "Příliš". The text goes to its decomposed form, the marks leave, the rest goes to lower
/// case. A letter with a code point of its own (ł, ø, đ, ß) has no decomposed form and stays as it is. The client
/// folds the same way for its highlight (js/ui/search.js, fold); a difference there costs a highlight, never a result.
/// </summary>
public static class TextFold
{
    public static string Fold(string text)
    {
        if (Ascii.IsValid(text)) return text.ToLowerInvariant();   // no mark to remove, and no normalization to pay for
        var decomposed = Decompose(text);
        var folded = new StringBuilder(decomposed.Length);
        foreach (var c in decomposed)
            if (CharUnicodeInfo.GetUnicodeCategory(c) != UnicodeCategory.NonSpacingMark) folded.Append(char.ToLowerInvariant(c));
        return folded.ToString();
    }

    /// <summary>Whether the text holds every word. The words are folded already (<see cref="Fold"/>). An ASCII text is
    /// compared in place, with no folded copy of it: most messages are ASCII, and one search reads every message of
    /// its conversation. A word that is not ASCII cannot be in such a text.</summary>
    public static bool HoldsAll(string text, string[] words)
    {
        if (Ascii.IsValid(text)) return Array.TrueForAll(words, word => Ascii.IsValid(word) && text.Contains(word, StringComparison.OrdinalIgnoreCase));
        var folded = Fold(text);
        return Array.TrueForAll(words, word => folded.Contains(word, StringComparison.Ordinal));
    }

    // Normalize throws on a lone surrogate and on a noncharacter such as U+FFFE, and a member can send either. One such
    // message must not fail every search of its conversation (plan review, 2026-11-12), and its other words must still
    // be found with and without their marks (PR review, 2026-11-12). So only the code points that cannot be normalized
    // leave, and the rest folds as usual.
    private static string Decompose(string text)
    {
        try { return text.Normalize(NormalizationForm.FormD); }
        catch (ArgumentException) { }
        var clean = new StringBuilder(text.Length);
        foreach (var rune in text.EnumerateRunes())   // a lone surrogate comes out as U+FFFD, which normalizes
            if (!IsNoncharacter(rune.Value)) clean.Append(rune.ToString());
        try { return clean.ToString().Normalize(NormalizationForm.FormD); }
        catch (ArgumentException) { return text; }    // nothing known gets here; the text is then searched as it is, in lower case
    }

    // The 66 code points that Unicode reserves and no text should hold: U+FDD0 to U+FDEF, and the last two of each plane.
    private static bool IsNoncharacter(int value) => (value & 0xFFFE) == 0xFFFE || value is >= 0xFDD0 and <= 0xFDEF;
}
