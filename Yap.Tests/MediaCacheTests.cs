using Yap.Services.Chat;

namespace Yap.Tests;

/// <summary>
/// The media cache starts yt-dlp with values that come from outside: the URL of a message, and for a Spotify link
/// the title of the Spotify page. This test holds the rule that such a value is one argument and never an option.
/// It reads the start information only. No yt-dlp runs, so it needs none on the machine.
/// </summary>
public class MediaCacheTests
{
    [Fact]
    public void A_Spotify_title_is_one_argument_of_yt_dlp_and_never_an_option()
    {
        // The name of a playlist or of a podcast episode is free text, and Spotify gives it as the title of the
        // page. With the arguments in one string, the quote ended the search argument and "--exec" became an
        // option of yt-dlp, which runs its value as a command.
        const string title = "x\" --exec \"touch /tmp/marker\" \"";

        var start = MediaCacheService.YtDlp(MediaCacheService.SpotifySearchArguments(title, "/data/media-cache/0123456789abcdef.mp3"));

        Assert.Equal("", start.Arguments);                              // no string that .NET splits at quotes
        Assert.Equal($"ytsearch1:{title}", start.ArgumentList[^1]);     // the whole title, as one argument
        Assert.Equal("--", start.ArgumentList[^2]);                     // after "--" yt-dlp reads no option
        Assert.DoesNotContain("--exec", start.ArgumentList);
    }
}
