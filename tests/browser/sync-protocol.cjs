// Pure protocol checks: no server, credentials, timing assumptions or network benchmark.
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
(async () => {
    const { mergeUpdate } = await import(
        pathToFileURL(path.resolve('Yap/wwwroot/chat-client/sync.js'))
    );
    const author = { id: 'alice', username: 'alice', displayName: 'Alice' };
    const message = (id, content = id) => ({
        id,
        authorId: 'alice',
        operationId: id,
        timestamp: '2026-01-01T00:00:00Z',
        content,
    });
    const patch = (id, messages = [], extra = {}) => ({
        id,
        state: { id, messages: [], received: 1, readThrough: 0 },
        messages,
        removed: [],
        window: null,
        baseRevision: null,
        revision: 'r1',
        ...extra,
    });
    const update = (sequence, conversations, extra = {}) => ({
        protocol: 2,
        userId: 'alice',
        serverEpoch: 'server1',
        sequence,
        state: null,
        conversations,
        removedConversations: [],
        authors: [author],
        ...extra,
    });
    let state = mergeUpdate(
        null,
        update(
            1,
            [patch('a', [message('a1')], { window: ['a1'] }), patch('b', [], { window: [] })],
            { state: { user: author, recentMessageLimit: 100, people: [author] }, reset: true },
        ),
    );
    state = mergeUpdate(state, update(10, [patch('a', [message('a1', 'new')])]));
    state = mergeUpdate(state, update(3, [patch('b', [message('b1')])]));
    assert.equal(state.conversations.find((c) => c.id === 'b').messages[0].id, 'b1');
    const version = state.conversations.find((c) => c.id === 'a').sync.version;
    state = mergeUpdate(state, update(5, [patch('a', [message('late-independent-record')])]));
    assert(state.conversations.find((c) => c.id === 'a').sync.version > version);
    state = mergeUpdate(
        state,
        update(6, [patch('a', [], { removed: ['late-independent-record'] })]),
    );
    console.log('PASS delayed independent records invalidate the local render version');
    state = mergeUpdate(state, update(4, [patch('a', [message('a1', 'stale')])]));
    assert.equal(state.conversations.find((c) => c.id === 'a').messages[0].content, 'new');
    state = mergeUpdate(state, update(11, [patch('a', [], { removed: ['a1'] })]));
    state = mergeUpdate(state, update(10, [patch('a', [message('a1', 'receipt replay')])]));
    assert.equal(state.conversations.find((c) => c.id === 'a').messages.length, 0);
    console.log(
        'PASS unrelated conversations merge independently; late edits and receipts cannot resurrect deletion',
    );
    state = mergeUpdate(state, update(12, [], { removedConversations: ['b'] }));
    state = mergeUpdate(state, update(5, [patch('b', [message('b1')], { window: ['b1'] })]));
    assert.equal(
        state.conversations.some((c) => c.id === 'b'),
        false,
    );
    state = mergeUpdate(state, update(13, [patch('a', [message('a2')], { window: ['a2'] })]));
    state = mergeUpdate(state, update(12, [patch('a', [message('old')])]));
    assert.deepEqual(
        state.conversations[0].messages.map((m) => m.id),
        ['a2'],
    );
    console.log('PASS removed access and full-window watermarks reject delayed authority');
    state = mergeUpdate(
        state,
        update(14, [patch('a', [], { baseRevision: 'r1', revision: 'r2' })]),
    );
    assert.equal(state.conversations[0].sync.loaded, true);
    assert.equal(state.conversations[0].sync.revision, 'r2');
    state = mergeUpdate(
        state,
        update(16, [patch('a', [], { baseRevision: 'missing', revision: 'r4' })]),
    );
    assert.equal(state.conversations[0].sync.loaded, false);
    console.log('PASS complete deltas advance cache versions; gaps request bounded recovery');
    state = mergeUpdate(
        state,
        update(1, [patch('a', [message('fresh')], { window: ['fresh'] })], {
            serverEpoch: 'server2',
            reset: true,
            state: { user: author, people: [author], recentMessageLimit: 100 },
        }),
    );
    assert.deepEqual(
        state.conversations[0].messages.map((m) => m.id),
        ['fresh'],
    );
    console.log('PASS server restart establishes new ordering');
    // Other cached conversations stay readable even if recovery is interrupted.
    let cached = mergeUpdate(
        null,
        update(
            90,
            [
                patch('a', [message('active')], { window: ['active'] }),
                patch('b', [message('cached')], { window: ['cached'] }),
                patch('restricted', [message('secret')], { window: ['secret'] }),
                patch('revoked', [message('removed')], { window: ['removed'] }),
            ],
            { state: { user: author, people: [author] }, reset: true },
        ),
    );
    cached = mergeUpdate(
        cached,
        update(
            1,
            [
                patch('a', [message('active')], { window: ['active'] }),
                patch('b', [], { invalidate: true }),
                patch('restricted', [], {
                    invalidate: true,
                    state: { id: 'restricted', historyLimited: true },
                }),
            ],
            { serverEpoch: 'server2', reset: true, state: { user: author, people: [author] } },
        ),
    );
    assert.equal(cached.conversations.find((c) => c.id === 'b').messages[0].id, 'cached');
    assert.equal(cached.conversations.find((c) => c.id === 'b').sync.loaded, false);
    assert.equal(cached.conversations.find((c) => c.id === 'restricted').messages.length, 0);
    assert(!cached.conversations.some((c) => c.id === 'revoked'));
    cached = mergeUpdate(
        cached,
        update(2, [patch('b', [], { invalidate: true, revision: 'r2' })], {
            serverEpoch: 'server2',
        }),
    );
    assert.equal(cached.conversations.find((c) => c.id === 'b').messages[0].id, 'cached');
    cached = mergeUpdate(
        cached,
        update(
            3,
            [patch('b', [message('replacement')], { window: ['replacement'], revision: 'r2' })],
            { serverEpoch: 'server2' },
        ),
    );
    assert.deepEqual(
        cached.conversations.find((c) => c.id === 'b').messages.map((m) => m.id),
        ['replacement'],
    );
    assert.equal(cached.conversations.find((c) => c.id === 'b').sync.stale, false);
    console.log(
        'PASS restart retains inactive caches until validation, while restrictions and revocations clear content',
    );
    for (let i = 2; i < 302; i++) {
        const previousId = state.conversations[0].messages[0].id;
        const revision = state.conversations[0].sync.revision;
        state = mergeUpdate(
            state,
            update(
                i,
                [
                    patch('a', [message('bounded' + i)], {
                        removed: [previousId],
                        baseRevision: revision,
                        revision: 'bounded-revision' + i,
                    }),
                ],
                { serverEpoch: 'server2' },
            ),
        );
    }
    assert.equal(Object.keys(state.conversations[0].sync.removed).length, 0);
    assert.equal(Object.keys(state.conversations[0].sync.records).length, 1);
    console.log('PASS continuous deltas keep ordering metadata bounded to the recent window');

    global.document = new EventTarget();
    const api = await import(pathToFileURL(path.resolve('Yap/wwwroot/chat-client/api.js')));
    let gets = 0,
        posts = 0;
    const response = (status, body) => ({ status, ok: status === 200, json: async () => body });
    global.fetch = async (url, options) => {
        if (options.method !== 'POST') {
            gets++;
            return response(200, { userId: 'alice', csrfToken: 'good' });
        }
        posts++;
        return response(200, { operationId: JSON.parse(options.body).operationId });
    };
    const credentials = await api.get('session');
    for (let i = 0; i < 3; i++)
        await api.post('messages', { operationId: i }, await api.get('session'));
    assert.equal(gets, 1);
    assert.equal(posts, 3);
    assert.equal(api.foregroundRequests, 0);
    console.log(
        'PASS normal writes reuse credentials: one POST per operation, no session preflight',
    );
    api.useSession({ userId: 'alice', csrfToken: 'expired' });
    const expired = await api.get('session');
    gets = posts = 0;
    global.fetch = async (url, options) => {
        if (options.method !== 'POST') {
            gets++;
            await Promise.resolve();
            return response(200, credentials);
        }
        posts++;
        return options.headers['X-CSRF-TOKEN'] === 'expired'
            ? response(403, { code: 'csrf' })
            : response(200, {});
    };
    await Promise.all([
        api.post('messages', { operationId: 1 }, expired),
        api.post('messages', { operationId: 2 }, expired),
    ]);
    assert.equal(gets, 1);
    assert.equal(posts, 4);
    console.log(
        'PASS simultaneous expired-token failures share one refresh and preserve operation retries',
    );
    api.useSession(expired);
    posts = 0;
    global.fetch = async (url, options) => {
        if (options.method !== 'POST') return response(200, { userId: 'bob', csrfToken: 'bob' });
        posts++;
        return response(403, { code: 'csrf' });
    };
    await assert.rejects(api.post('messages', { operationId: 3 }, expired), /ACCOUNT_CHANGED/);
    assert.equal(posts, 1);
    assert.equal(api.foregroundRequests, 0);
    console.log('PASS token refresh cannot replay an operation as a different account');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
