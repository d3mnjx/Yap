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
        if (Ascii.IsValid(text)) return text.ToLowerInvariant();   // most messages: no mark to remove, and no normalization to pay for
        string decomposed;
        // Normalize throws on a lone surrogate and on a noncharacter such as U+FFFE, and a member can send either. One
        // such message would then fail every search of its conversation, for every reader (plan review, 2026-11-12).
        // Such a text is searched as it is, in lower case.
        try { decomposed = text.Normalize(NormalizationForm.FormD); }
        catch (ArgumentException) { return text.ToLowerInvariant(); }
        var folded = new StringBuilder(decomposed.Length);
        foreach (var c in decomposed)
            if (CharUnicodeInfo.GetUnicodeCategory(c) != UnicodeCategory.NonSpacingMark) folded.Append(char.ToLowerInvariant(c));
        return folded.ToString();
    }
}
