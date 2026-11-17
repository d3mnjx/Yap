using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Yap.Migrations
{
    /// <inheritdoc />
    public partial class DropEmojiCounts : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "EmojiCounts",
                table: "Users");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "EmojiCounts",
                table: "Users",
                type: "TEXT",
                maxLength: 2048,
                nullable: true);
        }
    }
}
