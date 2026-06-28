using Microsoft.EntityFrameworkCore;
using E2EEIntim.Models;

namespace E2EEIntim.Data;

public class AppDbContext : DbContext
{
    public AppDbContext(DbContextOptions<AppDbContext> options) : base(options) { }

    public DbSet<EncryptedMessage> Messages { get; set; }
    public DbSet<ChatUser> Users { get; set; }
}