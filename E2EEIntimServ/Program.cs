using Microsoft.EntityFrameworkCore;
using E2EEIntim.Data;
using E2EEIntim.Hubs;
using E2EEIntim.Models;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddDbContext<AppDbContext>(options =>
    options.UseSqlite("Data Source=chat.db"));

builder.Services.AddSignalR(opts => {
    opts.MaximumReceiveMessageSize = 256 * 1024; // 256 KB — для видео-чанков
});

builder.Services.AddCors(options =>
{
    options.AddPolicy("AllowAll", policy => {
        policy.AllowAnyHeader()
              .AllowAnyMethod()
              .SetIsOriginAllowed(_ => true)
              .AllowCredentials();
    });
});

var app = builder.Build();

using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    db.Database.EnsureCreated();
}



app.UseCors("AllowAll");

// Эндпоинт для регистрации (Максимум 2 человека)
app.MapPost("/register", async (RegisterRequest req, AppDbContext db) =>
{
    var usersCount = await db.Users.CountAsync();

    if (usersCount >= 2)
    {
        return Results.Forbid();
    }

    var existingUser = await db.Users.FirstOrDefaultAsync(u => u.Username == req.Username);
    if (existingUser != null)
    {
        return Results.BadRequest("User already registered.");
    }

    var newToken = Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N");

    db.Users.Add(new ChatUser
    {
        Username = req.Username,
        Token = newToken,
        PublicKey = req.PublicKey
    });

    await db.SaveChangesAsync();

    return Results.Ok(new { Token = newToken });
});

app.MapGet("/contact", async (string myUsername, AppDbContext db) =>
{
    // Ищем первого попавшегося юзера, имя которого НЕ совпадает с твоим
    var contact = await db.Users.FirstOrDefaultAsync(u => u.Username != myUsername);

    if (contact == null)
    {
        return Results.NotFound("Собеседник еще не зарегистрирован.");
    }

    return Results.Ok(new
    {
        Username = contact.Username,
        PublicKey = contact.PublicKey
    });
});

app.MapDelete("/reset-users", async (AppDbContext db) =>
{
    // Удаляем всех юзеров из таблицы
    db.Users.RemoveRange(db.Users);
    await db.SaveChangesAsync();

    return Results.Ok("Все токены удалены. Места снова свободны.");
});

app.MapGet("/messages/{username}", async (string username, AppDbContext db) =>
{
    // Забираем все сообщения для этого пользователя
    var messages = await db.Messages
        .Where(m => m.ReceiverUsername == username)
        .OrderBy(m => m.CreatedAt)
        .ToListAsync();

    // Удаляем из базы после того, как отдали клиенту
    db.Messages.RemoveRange(messages);
    await db.SaveChangesAsync();

    return Results.Ok(messages);
});



app.MapHub<ChatHub>("/chathub");

app.MapGet("/", () => "Strict E2EE Server is running.");

app.Run();

public record RegisterRequest(string Username, string PublicKey);