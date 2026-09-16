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

        // Достаем ТОЛЬКО токен. SignalR при accessTokenFactory железно прокинет его
        var token = httpContext?.Request.Query["access_token"].ToString();

        // Подстраховка: если вдруг решишь перейти на заголовки
        if (string.IsNullOrEmpty(token))
        {
            var authHeader = httpContext?.Request.Headers["Authorization"].ToString();
            if (!string.IsNullOrEmpty(authHeader) && authHeader.StartsWith("Bearer "))
            {
                token = authHeader.Substring(7);
            }
        }

        // Ищем пользователя в БД чисто по токену
        var user = await _db.Users.FirstOrDefaultAsync(u => u.Token == token);

        if (user == null || string.IsNullOrEmpty(token))
        {
            Console.WriteLine($"[ОТКАЗ] Неудачная попытка входа. Токен не валиден или пуст.");
            Context.Abort();
            return;
        }

        // Имя пользователя берем из подтвержденной записи в БД!
        string username = user.Username;

        // Сохраняем имя в контекст текущего соединения. 
        // Context.Items живет всё время, пока клиент подключен к Хабу (даже на лонг-поллинге)
        Context.Items["Username"] = username;

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
        var actualSender = Context.Items["Username"]?.ToString();

        if (string.IsNullOrEmpty(actualSender))
        {
            actualSender = OnlineUsers.FirstOrDefault(x => x.Value == Context.ConnectionId).Key;
        }

        Console.WriteLine($"=== ПОПЫТКА ОТПРАВКИ: {actualSender} хочет написать {targetUsername} ===");

        if (string.IsNullOrEmpty(actualSender) || actualSender != senderUsername)
        {
            Console.WriteLine($"[ОТКАЗ] Попытка отправки от чужого имени или неавторизованный запрос.");
            return;
        }

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