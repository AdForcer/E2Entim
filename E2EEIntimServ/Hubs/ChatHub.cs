using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using E2EEIntim.Data;
using E2EEIntim.Models;
using System.Collections.Concurrent;

namespace E2EEIntim.Hubs;

public class ChatHub : Hub
{
    private static readonly ConcurrentDictionary<string, string> OnlineUsers = new();
    private readonly AppDbContext _db;

    public ChatHub(AppDbContext db) => _db = db;

    public override async Task OnConnectedAsync()
    {
        var httpContext = Context.GetHttpContext();

        // SignalR с accessTokenFactory кладёт токен в query string, не в заголовки
        var username = httpContext?.Request.Query["username"].ToString();
        var token = httpContext?.Request.Query["access_token"].ToString();

        // Проверяем по базе
        if (string.IsNullOrEmpty(username) || !_db.Users.Any(u => u.Username == username && u.Token == token))
        {
            Console.WriteLine($"[ОТКАЗ] Неудачная попытка входа. Имя: '{username}'");
            Context.Abort();
            return;
        }

        OnlineUsers[username] = Context.ConnectionId;
        Console.WriteLine($"[ОНЛАЙН] Пользователь {username} зашел в чат!");

        // Отдаем все накопленные сообщения
        var pendingMessages = await _db.Messages
            .Where(m => m.ReceiverUsername == username)
            .OrderBy(m => m.CreatedAt)
            .ToListAsync();

        if (pendingMessages.Any())
        {
            Console.WriteLine($"[ОЧЕРЕДЬ] Выгружаем {pendingMessages.Count} сообщений для {username}");
            foreach (var msg in pendingMessages)
            {
                await Clients.Caller.SendAsync("ReceiveMessage", msg.SenderUsername, msg.Payload);
            }

            _db.Messages.RemoveRange(pendingMessages);
            await _db.SaveChangesAsync();
        }

        await base.OnConnectedAsync();
    }

    public async Task SendEncryptedMessage(string senderUsername, string targetUsername, string encryptedPayload)
    {
        var httpContext = Context.GetHttpContext();
        var actualSender = httpContext?.Request.Query["username"].ToString();

        Console.WriteLine($"=== ПОПЫТКА ОТПРАВКИ: {actualSender} хочет написать {targetUsername} ===");

        if (actualSender != senderUsername) return;

        if (OnlineUsers.TryGetValue(targetUsername, out var connectionId))
        {
            Console.WriteLine($"[УСПЕХ] Получатель в сети. Доставляем мгновенно.");
            await Clients.Client(connectionId).SendAsync("ReceiveMessage", senderUsername, encryptedPayload);
        }
        else
        {
            Console.WriteLine($"[ОФЛАЙН] Получатель не в сети. Сохраняем в БД.");
            _db.Messages.Add(new EncryptedMessage
            {
                SenderUsername = senderUsername,
                ReceiverUsername = targetUsername,
                Payload = encryptedPayload
            });
            await _db.SaveChangesAsync();
        }
    }

    public override async Task OnDisconnectedAsync(Exception? ex)
    {
        var user = OnlineUsers.FirstOrDefault(x => x.Value == Context.ConnectionId);
        if (user.Key != null)
        {
            OnlineUsers.TryRemove(user.Key, out _);
            Console.WriteLine($"[ОФФЛАЙН] {user.Key} покинул чат.");
        }
        await base.OnDisconnectedAsync(ex);
    }
}