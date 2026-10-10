using Yap.Models;

namespace Yap.Services;

public partial class ChatService
{
    private readonly SemaphoreSlim readStateGate = new(1, 1);
    private ChannelReadState CopyReadState(Guid userId, Guid channelId)
    {
        _readStates.TryGetValue((userId, channelId), out var state);
        return new()
        {
            UserId = userId,
            ChannelId = channelId,
            LastReadAt = state?.LastReadAt ?? DateTime.MinValue,
            UnreadCount = state?.UnreadCount ?? 0,
            ReceivedCount = state?.ReceivedCount ?? 0,
            ReadThrough = state?.ReadThrough ?? 0
        };
    }

    // Capture BEFORE the message window: concurrent arrivals may be displayed, but never acknowledged unseen.
    public (int Unread, long Received, long ReadThrough) GetReadCheckpoint(Guid userId, Guid channelId)
    {
        // States are replaced only after persistence; each published instance is immutable.
        var state = CopyReadState(userId, channelId);
        return (state.UnreadCount, state.ReceivedCount, state.ReadThrough);
    }

    public async Task MarkObservedReadAsync(Guid userId, Guid channelId, long? through, bool silent = false, string? callerSessionId = null, string source = "observed")
    {
        var channel = GetChannel(channelId);
        if (channel == null || !channel.CanAccess(userId))
            throw new ChatSendException(404, "conversation_unavailable", "This conversation is no longer available.");
        bool changed;
        await readStateGate.WaitAsync();
        try
        {
            var state = CopyReadState(userId, channelId);
            var target = through ?? state.ReceivedCount;
            if (target < 0 || target > state.ReceivedCount)
                throw new ChatSendException(400, "invalid_read", "Read checkpoint is not available.");
            if (target <= state.ReadThrough)
                return;
            var previousCount = state.UnreadCount;
            state.ReadThrough = target;
            state.UnreadCount = checked((int)(state.ReceivedCount - target));
            state.LastReadAt = DateTime.UtcNow;
            await _persistence.PersistReadStateAsync(state);
            _readStates[(userId, channelId)] = state;
            if (channel.IsDirectMessage && previousCount > state.UnreadCount)
            {
                UserSession? caller = null;
                if (callerSessionId != null)
                    _users.TryGetValue(callerSessionId, out caller);
                var username = _userService.GetById(userId)?.Username ?? "?";
                _audit.RecordUnreadChange(username, DescribeChannel(channel), "clear", previousCount - state.UnreadCount, source,
                    _audit.DescribeCallerSession(caller, GetUserStatus(username)));
            }
            changed = true;
        }
        finally { readStateGate.Release(); }
        if (changed && !silent)
            OnUnreadChanged?.Invoke(userId, channelId);
    }
}
