using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Yap.Data;

static class MigrationChecks
{
    public static async Task Run(string database)
    {
        var clone = database + ".migration-check";
        await using (var source = new SqliteConnection("Data Source=" + database))
        await using (var destination = new SqliteConnection("Data Source=" + clone))
        {
            await source.OpenAsync();
            await destination.OpenAsync();
            source.BackupDatabase(destination);
        }
        await using var db = new ChatDbContext(new DbContextOptionsBuilder<ChatDbContext>().UseSqlite("Data Source=" + clone).Options);
        var counts = await db.ChannelReadStates.AsNoTracking().ToDictionaryAsync(s => (s.UserId, s.ChannelId), s => s.UnreadCount);
        var messages = await db.Messages.CountAsync();
        var users = await db.Users.CountAsync();
        var migrator = db.GetService<IMigrator>();
        await migrator.MigrateAsync("20261008174322_DurableTextSends");
        await migrator.MigrateAsync();
        var migrated = await db.ChannelReadStates.AsNoTracking().ToListAsync();
        if (migrated.Count != counts.Count || migrated.Any(s => s.UnreadCount != counts[(s.UserId, s.ChannelId)] || s.ReceivedCount != s.UnreadCount || s.ReadThrough != 0)
            || await db.Messages.CountAsync() != messages || await db.Users.CountAsync() != users)
            throw new Exception("Unread migration changed existing data");
        Console.WriteLine("PASS migration preserves existing unread counts/messages/accounts and initializes checkpoints");
    }
}
