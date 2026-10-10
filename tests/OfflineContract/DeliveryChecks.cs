using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Yap.Data;
using Yap.Models;
using Yap.Services;

static class DeliveryChecks
{
    public static async Task Run(IServiceProvider services, User sender)
    {
        var chat = services.GetRequiredService<ChatService>();
        var users = services.GetRequiredService<UserService>();
        var other = (await users.CreateUserAsync("deliveryfixture"))!;
        var channel = await chat.OpenDirectMessageAsync(sender, other.Username);
        await using var db = await services.GetRequiredService<IDbContextFactory<ChatDbContext>>().CreateDbContextAsync();
        var operation = Guid.NewGuid();
        var arrivals = 0;
        var unread = 0;
        Action<ChatMessage> broken = _ => throw new InvalidOperationException("synthetic listener failure");
        Action<ChatMessage> receive = m => { if (m.ChannelId == channel.Id) arrivals++; };
        Action<Guid, Guid> read = (user, id) => { if (user == other.Id && id == channel.Id) unread++; };
        chat.OnMessageReceived += broken;
        chat.OnMessageReceived += receive;
        chat.OnUnreadChanged += read;
        void Check(bool condition, string label)
        {
            if (!condition)
                throw new Exception(label);
            Console.WriteLine("PASS " + label);
        }
        try
        {
            await db.Database.ExecuteSqlRawAsync("CREATE TRIGGER reject_delivery_unread BEFORE UPDATE ON ChannelReadStates BEGIN SELECT RAISE(ABORT, 'synthetic unread failure'); END;");
            var failed = false;
            try
            {
                await chat.SendTextAsync(sender, channel.Id, operation, "atomic delivery");
            }
            catch { failed = true; }
            Check(failed && !await db.Messages.AnyAsync(m => m.Id == operation)
                && !await db.TextSendReceipts.AnyAsync(r => r.OperationId == operation)
                && chat.GetMessageById(channel.Id, operation) == null && arrivals == 0
                && chat.GetUnreadCount(other.Id, channel.Id) == 0, "unread failure rolls back message and receipt without publishing");
            await db.Database.ExecuteSqlRawAsync("DROP TRIGGER reject_delivery_unread;");
            await chat.SendTextAsync(sender, channel.Id, operation, "atomic delivery");
            await chat.SendTextAsync(sender, channel.Id, operation, "atomic delivery");
            var state = await db.ChannelReadStates.AsNoTracking().SingleAsync(s => s.UserId == other.Id && s.ChannelId == channel.Id);
            Check(arrivals == 1 && unread == 1 && state.ReceivedCount == 1 && state.UnreadCount == 1
                && chat.GetUnreadCount(other.Id, channel.Id) == 1, "retry publishes once with durable unread despite a throwing subscriber");
            await db.Database.ExecuteSqlRawAsync("CREATE TRIGGER reject_legacy_delivery BEFORE INSERT ON Messages WHEN NEW.Content = 'legacy-delivery-fixture' BEGIN SELECT RAISE(ABORT, 'synthetic legacy failure'); END;");
            await chat.SendMessageAsync(channel.Id, sender.Id, sender.Username, "legacy-delivery-fixture");
            Check(arrivals == 2 && unread == 2 && chat.GetMessages(channel.Id, 100).Any(m => m.Content == "legacy-delivery-fixture")
                && !await db.Messages.AnyAsync(m => m.Content == "legacy-delivery-fixture"), "legacy bot send logs persistence failure and still publishes without throwing");
        }
        finally
        {
            chat.OnMessageReceived -= broken;
            chat.OnMessageReceived -= receive;
            chat.OnUnreadChanged -= read;
            await db.Database.ExecuteSqlRawAsync("DROP TRIGGER IF EXISTS reject_delivery_unread;");
            await db.Database.ExecuteSqlRawAsync("DROP TRIGGER IF EXISTS reject_legacy_delivery;");
        }
    }
}
