using Yap.Services.Notifications;

namespace Yap.Tests;

/// <summary>The text of a notification has a maximum length. A longer text is cut, and the cut never leaves half an emoji.</summary>
public class PushTextTests
{
    [Fact(DisplayName = "A cut notification text ends in three dots and never in half an emoji")]
    public void Cut_does_not_divide_an_emoji()
    {
        Assert.Equal("short", PushNotificationService.Truncate("short", 10));
        Assert.Equal("1234567...", PushNotificationService.Truncate("12345678901", 10));

        // The emoji is at UTF-16 units 6 and 7. A cut after 7 units is between its two halves, so the cut moves one
        // unit back and the emoji is not in the result.
        Assert.Equal("123456...", PushNotificationService.Truncate("123456\U0001F6008901", 10));

        // An emoji that ends before the cut stays whole.
        Assert.Equal("12345\U0001F600...", PushNotificationService.Truncate("12345\U0001F6008901", 10));
    }
}
