// Session credentials belong to this document/account, never to persisted offline data.
let session,
    refreshing,
    generation = 0;
export let foregroundRequests = 0;
export function beginForeground() {
    foregroundRequests++;
    document.dispatchEvent(new CustomEvent('chat-foreground', { detail: foregroundRequests }));
    return () => {
        foregroundRequests--;
        document.dispatchEvent(new CustomEvent('chat-foreground', { detail: foregroundRequests }));
    };
}
function updateRequired() {
    document.dispatchEvent(new Event('chat-update-required'));
    return new ApiError(426, {
        code: 'update_required',
        error: 'Client update required. Reload Yap to continue.',
    });
}
export class ApiError extends Error {
    constructor(status, body) {
        super(body.error || `Server unavailable (${status})`);
        this.status = status;
        this.code = body.code;
    }
}
export function forgetSession() {
    generation++;
    session = refreshing = undefined;
}
export function useSession(value) {
    if (session && session.userId !== value.userId) {
        generation++;
        refreshing = undefined;
    }
    session = value;
    return value;
}
async function read(path, { signal } = {}) {
    const response = await fetch('/api/chat/' + path, {
        cache: 'no-store',
        headers: {
            'X-Yap-Chat-Protocol': '2',
            ...(!['bootstrap', 'session'].includes(path.split('?')[0]) && session?.userId
                ? { 'X-Yap-Chat-User': session.userId }
                : {}),
        },
        signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
            : AbortSignal.timeout(10000),
    });
    if (response.status === 426) throw updateRequired();
    if (response.status === 401) throw new Error('AUTH_REQUIRED');
    if (!response.ok) throw new ApiError(response.status, {});
    const value = await response.json();
    // History and individual targets use the same wire record as live updates.
    if (value.authors && !value.protocol) {
        const authors = new Map(value.authors.map((author) => [author.id, author]));
        const hydrate = (message) => ({ ...message, author: authors.get(message.authorId) });
        if (value.message) return hydrate(value.message);
        if (value.conversation)
            return { ...value.conversation, messages: value.conversation.messages.map(hydrate) };
        if (value.messages) return { ...value, messages: value.messages.map(hydrate) };
    }
    return value;
}
export async function refreshSession() {
    if (!refreshing) {
        const turn = generation;
        const pending = read('session')
            .then((value) => {
                if (turn !== generation) throw new Error('ACCOUNT_CHANGED');
                return useSession(value);
            })
            .finally(() => {
                if (refreshing === pending) refreshing = undefined;
            });
        refreshing = pending;
    }
    return refreshing;
}
export async function get(path, options = {}) {
    if (path === 'session') {
        options.signal?.throwIfAborted();
        return session || refreshSession();
    }
    return read(path, options);
}
export async function post(path, body, credentials, { signal } = {}) {
    const account = credentials.userId;
    const finish = beginForeground();
    try {
        for (let attempt = 0; attempt < 2; attempt++) {
            signal?.throwIfAborted();
            const response = await fetch('/api/chat/' + path, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-TOKEN': credentials.csrfToken,
                    'X-Yap-Chat-Protocol': '2',
                    ...(account ? { 'X-Yap-Chat-User': account } : {}),
                },
                body: JSON.stringify(body),
                signal: signal
                    ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
                    : AbortSignal.timeout(15000),
            });
            const result = await response.json().catch(() => ({}));
            if (response.ok) return result;
            if (response.status === 426) throw updateRequired();
            if (result.code === 'account_changed') throw new Error('ACCOUNT_CHANGED');
            // A retry refreshes the token, never the operation's owner or payload. Concurrent
            // rejected writes share the refresh; an account switch must stop their retries.
            if (attempt === 0 && response.status === 403 && result.code === 'csrf') {
                const next = session && session !== credentials ? session : await refreshSession();
                if (!account || next.userId !== account) throw new Error('ACCOUNT_CHANGED');
                credentials = next;
                continue;
            }
            throw new ApiError(response.status, result);
        }
    } finally {
        finish();
    }
}

// Unload cannot wait for token refresh or retry. Use this document's current account-bound
// credentials; the server's disconnect timeout remains the fallback if delivery fails.
export function leavePresence(connectionId) {
    if (!connectionId || !session) return;
    fetch('/api/chat/presence/leave', {
        method: 'POST',
        keepalive: true,
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-TOKEN': session.csrfToken,
            'X-Yap-Chat-User': session.userId,
        },
        body: JSON.stringify({ connectionId }),
    }).catch(() => {});
}
