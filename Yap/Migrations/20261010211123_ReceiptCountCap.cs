using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Yap.Migrations
{
    /// <inheritdoc />
    public partial class ReceiptCountCap : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateIndex(
                name: "IX_TextSendReceipts_AcceptedAt",
                table: "TextSendReceipts",
                column: "AcceptedAt");

            migrationBuilder.CreateIndex(
                name: "IX_TextSendReceipts_UserId_AcceptedAt_OperationId",
                table: "TextSendReceipts",
                columns: new[] { "UserId", "AcceptedAt", "OperationId" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_TextSendReceipts_AcceptedAt",
                table: "TextSendReceipts");

            migrationBuilder.DropIndex(
                name: "IX_TextSendReceipts_UserId_AcceptedAt_OperationId",
                table: "TextSendReceipts");
        }
    }
}
