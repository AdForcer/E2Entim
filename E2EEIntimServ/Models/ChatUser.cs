using System.ComponentModel.DataAnnotations;

namespace E2EEIntim.Models;

public class ChatUser
{
    [Key]
    public string Username { get; set; } = string.Empty;
    public string Token { get; set; } = string.Empty;
    public string PublicKey { get; set; }

}