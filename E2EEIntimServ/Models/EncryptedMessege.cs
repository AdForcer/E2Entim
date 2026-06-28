using System.ComponentModel.DataAnnotations;

namespace E2EEIntim.Models;

public class EncryptedMessage
{
    [Key]
    public int Id { get; set; }
    public string SenderUsername { get; set; } = string.Empty;
    public string ReceiverUsername { get; set; } = string.Empty;
    public string Payload { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}