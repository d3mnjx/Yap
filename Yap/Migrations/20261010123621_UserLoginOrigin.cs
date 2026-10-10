using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Yap.Migrations
{
    /// <inheritdoc />
    public partial class UserLoginOrigin : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "LoginOrigin",
                table: "Users",
                type: "TEXT",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "LoginOrigin",
                table: "Users");
        }
    }
}
