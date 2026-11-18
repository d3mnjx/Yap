using System.Text.Json;
using Yap.Models;
using Yap.Models.Notifications;

namespace Yap.Services.Notifications;

public class JsonPushSubscriptionPersistence : IPushSubscriptionPersistence
{
    private readonly string _filePath;
    private readonly SemaphoreSlim _lock = new(1, 1);
    private readonly ILogger<JsonPushSubscriptionPersistence> _logger;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true
    };

    public JsonPushSubscriptionPersistence(IWebHostEnvironment env, ILogger<JsonPushSubscriptionPersistence> logger)
    {
        _logger = logger;
        _filePath = Path.Combine(env.ContentRootPath, "Data", "push-subscriptions.json");
    }

    public async Task<List<PushSubscription>> LoadAllAsync()
    {
        await _lock.WaitAsync();
        try
        {
            return await ReadFileAsync();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to load push subscriptions from {Path}", _filePath);
            return new List<PushSubscription>();
        }
        finally
        {
            _lock.Release();
        }
    }

    public async Task SaveAsync(PushSubscription subscription)
    {
        await _lock.WaitAsync();
        try
        {
            var list = await ReadFileAsync();
            list.RemoveAll(s => s.Endpoint == subscription.Endpoint);
            list.Add(subscription);
            await WriteFileAsync(list);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to save push subscription");
        }
        finally
        {
            _lock.Release();
        }
    }

    public async Task RemoveAsync(string endpoint)
    {
        await _lock.WaitAsync();
        try
        {
            var list = await ReadFileAsync();
            if (list.RemoveAll(s => s.Endpoint == endpoint) > 0)
                await WriteFileAsync(list);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to remove push subscription");
        }
        finally
        {
            _lock.Release();
        }
    }

    private async Task<List<PushSubscription>> ReadFileAsync()
    {
        if (!File.Exists(_filePath))
            return new List<PushSubscription>();

        var json = await File.ReadAllTextAsync(_filePath);
        return JsonSerializer.Deserialize<List<PushSubscription>>(json, JsonOptions)
               ?? new List<PushSubscription>();
    }

    private async Task WriteFileAsync(List<PushSubscription> list)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_filePath)!);
        var json = JsonSerializer.Serialize(list, JsonOptions);
        await File.WriteAllTextAsync(_filePath, json);
    }
}
