using Yap.Services.Media;

namespace Yap.Tests;

/// <summary>
/// The ids of tus uploads carry their owner (UploadIds), so the owner check of TusEndpoints works after a restart.
/// </summary>
public class UploadIdsTests
{
    [Fact(DisplayName = "An upload id belongs to the person who created it and to nobody else")]
    public async Task An_id_belongs_to_its_creator_only()
    {
        var owner = Guid.NewGuid();
        var id = await new UploadIds(owner).CreateId("");

        Assert.True(UploadIds.IsValid(id));
        Assert.True(UploadIds.Owns(owner, id));
        Assert.False(UploadIds.Owns(Guid.NewGuid(), id));
        Assert.NotEqual(id, await new UploadIds(owner).CreateId(""));   // the second half is random
    }

    [Fact(DisplayName = "An upload id from before the owner was in it is valid and belongs to nobody")]
    public void An_old_id_is_valid_and_nobodys()
    {
        var user = Guid.NewGuid();
        var old = user.ToString("N");   // the worst case: an old id that equals a user id

        Assert.True(UploadIds.IsValid(old));
        Assert.False(UploadIds.Owns(user, old));
    }

    [Theory(DisplayName = "Text that is not an upload id is refused before it becomes a file name")]
    [InlineData("")]
    [InlineData("../../appsettings")]
    [InlineData("0123456789abcdef0123456789abcdeF")]                                    // upper case
    [InlineData("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde/")]
    [InlineData("0123456789abcdef0123456789abcdef0")]                                   // 33 digits
    public void Other_text_is_not_an_id(string text)
    {
        Assert.False(UploadIds.IsValid(text));
        Assert.False(UploadIds.Owns(Guid.Empty, text));
    }
}
