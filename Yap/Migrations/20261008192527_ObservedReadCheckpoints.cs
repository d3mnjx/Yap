using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Yap.Migrations
{
    /// <inheritdoc />
    public partial class ObservedReadCheckpoints : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<long>(
                name: "ReadThrough",
                table: "ChannelReadStates",
                type: "INTEGER",
                nullable: false,
                defaultValue: 0L);

            migrationBuilder.AddColumn<long>(
                name: "ReceivedCount",
                table: "ChannelReadStates",
                type: "INTEGER",
                nullable: false,
                defaultValue: 0L);

            // Preserve the existing badge count as the initial unread checkpoint range.
            migrationBuilder.Sql("UPDATE ChannelReadStates SET ReceivedCount = UnreadCount");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "ReadThrough",
                table: "ChannelReadStates");

            migrationBuilder.DropColumn(
                name: "ReceivedCount",
                table: "ChannelReadStates");
        }
    }
}
