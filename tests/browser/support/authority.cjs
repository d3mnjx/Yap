// Synthetic snapshots use the same protocol-3 storage path as real authority.
function updateFromSnapshot(snapshot) {
    return {
        protocol: 3,
        userId: snapshot.user.id,
        serverEpoch: snapshot.serverEpoch,
        sequence: snapshot.sequence,
        state: { ...snapshot, conversations: [] },
        reset: true,
        removedConversations: [],
        authors: snapshot.conversations.flatMap((c) => c.messages.map((m) => m.author)),
        conversations: snapshot.conversations.map((c) => ({
            id: c.id,
            state: { ...c, messages: [] },
            messages: c.messages.map((m) => ({ ...m, authorId: m.author.id })),
            removed: [],
            window: c.messages.map((m) => m.id),
            baseRevision: null,
            revision: String(c.contentVersion ?? snapshot.sequence),
        })),
    };
}
async function fixturePage(context) {
    const page = await context.newPage();
    const constants = await import(
        require('node:path').resolve(__dirname, '../../../Yap/wwwroot/chat-client/constants.js')
    );
    const values = Object.fromEntries(
        Object.entries(constants).filter(([, value]) => typeof value !== 'function'),
    );
    await page.addInitScript((values) => {
        window.fixtureConstants = values;
    }, values);
    await page.addInitScript('window.fixtureUpdate = ' + updateFromSnapshot.toString());
    return page;
}
async function readSnapshot(request, origin) {
    const { update } = await (await request.get(origin + '/api/chat/bootstrap')).json();
    const conversations = [];
    for (const item of update.conversations) {
        const window = await (await request.get(origin + '/api/chat/windows/' + item.id)).json();
        const patch = window.conversations[0];
        if (!patch) continue;
        const authors = new Map(window.authors.map((a) => [a.id, a]));
        conversations.push({
            ...patch.state,
            messages: patch.messages.map((m) => ({ ...m, author: authors.get(m.authorId) })),
        });
    }
    return {
        ...update.state,
        serverEpoch: update.serverEpoch,
        sequence: update.sequence,
        conversations,
    };
}
module.exports = { fixturePage, readSnapshot };
