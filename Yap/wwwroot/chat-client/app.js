import { timestamp } from './dates.js';
import { createScroll } from './scroll.js';
import { watchWorkerUpdates } from './worker-updates.js';
import { createMessages, avatar, needsMessageHeader } from './messages.js';
import { createComposer } from './composer.js';
import { createPwa } from './pwa.js';
import { createHistory } from './history.js';
import { createProfiles } from './profiles.js';
import { chatLabel, loadContent, richText, showEmoji, quickReactions } from './content.js';
import { favorite } from './gifs.js';
import { createActions, applyMutations } from './actions.js';
import { get, post, useSession, refreshSession, forgetSession } from './api.js';
import { createSender } from './sender.js';
import { createLive } from './live.js';
import { createReader } from './reader.js';
import { createNotifications } from './notifications.js';
import * as storage from './storage.js';
import { createWindows } from './windows.js';
import { warmImages } from './media.js';
const $ = (selector) => document.querySelector(selector);
const element = (tag, className, text) => {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
};
const scrolling = createScroll($('.messages'));
/** @type {import('./contracts.js').AccountState | undefined | null} */
let identity;
/** @type {import('./contracts.js').ChatSnapshot | undefined | null} */
let snapshot;
let selectedConversationId;
// These generations belong to this page, not the server or the persisted account.
// A reconnect invalidates old network callbacks; a render invalidates old DOM work.
let connectionGeneration = 0;
let renderGeneration = 0;
let hubConnection;
let reconnectTimer;
let connecting = false;
// Serialize HTTP acknowledgements and stream snapshots through the same commit path.
let snapshotQueue = Promise.resolve();
let pendingOperations = [];
let resolvingDm = false;
let workerReady = false,
    workerWarning = '',
    readMarkers = [],
    lastBadge = -1;
function connectionLabel(text) {
    if (text.startsWith('Synced')) return 'Synced';
    if (/Offline|Disconnected/.test(text)) return 'Offline';
    if (text.includes('failed')) return 'Sync failed';
    if (text.startsWith('Sign')) return 'Sign in';
    return 'Syncing';
}
function status(text) {
    const node = $('#connection');
    node.textContent = text;
    node.hidden = text.startsWith('Synced') && !text.includes('unavailable');
    node.title = text;
    node.dataset.label = connectionLabel(text);
}
function notice(text, login = false) {
    text ||= workerWarning;
    const n = $('#notice');
    n.replaceChildren(document.createTextNode(text));
    n.hidden = !text;
    if (login) {
        const a = element('a', '', 'Sign in');
        a.href = '/login?returnUrl=' + encodeURIComponent(location.pathname + location.search);
        n.append(a);
    }
}
function clearUI() {
    scrolling.reset();
    $('#recovery').hidden = true;
    snapshot = null;
    selectedConversationId = null;
    messageView.clear();
    $('#rooms').replaceChildren();
    $('#dms').replaceChildren();
    $('#pending').replaceChildren();
    $('#outgoing').replaceChildren();
    $('#title').textContent = 'Yap';
    $('#status-username').textContent = 'Account';
    readMarkers = [];
    lastBadge = -1;
    renderLive();
    notifications.clear();
    chatHistory.clear();
    profiles.close();
    actions.reset();
    composer.clear();
    document.dispatchEvent(new Event('chat-clear'));
}
function stopConnection() {
    // Fence callbacks before stopping transports: stop() itself can fire onclose.
    connectionGeneration++;
    clearTimeout(reconnectTimer);
    sender.stop();
    windows.stop();
    live.detach();
    return hubConnection?.stop();
}
async function loseAccount(remove = false) {
    forgetSession();
    await stopConnection();
    if (remove) await storage.forget();
    else await storage.lockAccount();
    identity = null;
    clearUI();
    composer.update();
    status('Sign in required');
    notice('Sign in again to resume your saved drafts and outgoing messages.', true);
}
const windows = createWindows({
    identity: () => identity,
    snapshot: () => snapshot,
    current: () => currentConversation(),
    accepted: (data) => acceptSnapshot(data, connectionGeneration),
});
const sender = createSender({
    identity: () => identity,
    accepted: async (data, operationId, owner) => {
        if (identity?.epoch !== owner.epoch) return;
        await acceptSnapshot(data, connectionGeneration, operationId);
    },
    changed: render,
    authRequired: () => loseAccount(),
    failed: (error) => notice(`Outgoing messages could not be updated: ${error.message}`),
});

const currentConversation = () =>
    snapshot?.conversations.find((c) => c.id === selectedConversationId);
const actions = createActions({
    identity: () => identity,
    current: currentConversation,
    render,
    flush: () => sender.start(),
    notice,
    reply: (message) => composer.reply(message),
    quickReactions,
    renderEmoji: (value) => richText(value, true),
    favorite: (gif, button) => favorite(gif, button, identity),
    pickEmoji: (anchor, choose) => showEmoji(anchor, choose, identity),
});

const chatHistory = createHistory({
    identity: () => identity,
    current: currentConversation,
    changed: render,
    notice,
});
const profiles = createProfiles({
    avatar,
    text: (value) => richText(value, true),
    status: (username) => live.view?.users.find((u) => u.username === username)?.status,
});
const pwa = createPwa({ identity: () => identity, navigate, notice });
const notifications = createNotifications({
    identity: () => identity,
    snapshot: () => snapshot,
    current: currentConversation,
});
const live = createLive({
    identity: () => identity,
    current: currentConversation,
    changed: () => {
        renderLive();
        if (snapshot) {
            sidebar();
            reader.observe(currentConversation()).catch((error) => notice(error.message));
        }
    },
    authRequired: () => loseAccount(),
});
const reader = createReader({
    identity: () => identity,
    accepted: (data) => acceptSnapshot(data, connectionGeneration),
    changed: async () => {
        readMarkers = await storage.reads();
        if (snapshot) sidebar();
    },
    eligible: () => live.connected && !!live.view && live.view.status !== 'away',
    authRequired: () => loseAccount(),
    failed: (error) => {
        if (error.status === 400) notice('Read status could not be synchronized.');
    },
});
const composer = createComposer({
    identity: () => identity,
    snapshot: () => snapshot,
    selected: () => selectedConversationId,
    current: currentConversation,
    live,
    notice,
    onQueued: async (channelId) => {
        await renderPending();
        if (selectedConversationId === channelId) scrolling.bottom();
        sender.start();
    },
});
const messageView = createMessages({
    identity: () => identity,
    snapshot: () => snapshot,
    current: currentConversation,
    actions,
    history: chatHistory,
    notice,
});
function formatTimestamp(value) {
    return timestamp(value, snapshot?.dateSettings);
}
function renderLive() {
    const state = live.view,
        effective = state?.status || 'invisible';
    $('#menu-button').className = 'status-button status-' + effective;
    document.querySelectorAll('[data-status]').forEach((button) => {
        button.classList.toggle(
            'active',
            button.dataset.status === (state?.chosenStatus || live.chosen),
        );
        button.disabled = !live.connected;
    });
    $('#online-count').textContent = state ? state.onlineCount : '';
    $('#users-heading').textContent = state?.header || 'Online Users';
    const text = state && state.channelId === selectedConversationId ? state.typingText : '';
    $('#typing').hidden = !text;
    $('#typing-text').textContent = text || '';
}
function unread(c) {
    const marker = readMarkers.find((m) => m.channelId === c.id);
    return marker && Number.isFinite(c.received)
        ? Math.min(c.unread, Math.max(0, c.received - marker.through))
        : c.unread;
}
function muteBell() {
    const bell = element('span', 'mute-bell');
    bell.title = 'Notifications muted';
    bell.innerHTML =
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm0-15.5c2.49 0 4 2.02 4 4.5v5h2v1H6v-1h2v-5c0-3.07 1.63-5.64 4.5-6.32V4c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5v.68c-.17.04-.33.09-.5.14zM5.41 3.35L4 4.76l2.81 2.81C6.29 8.57 6 9.74 6 11v5l-2 2v1h14.24l1.35 1.35 1.41-1.41L5.41 3.35z"/></svg>';
    return bell;
}
function sidebar() {
    const link = (a, path) => {
        a.href = path;
        a.onclick = (event) => {
            if (event.ctrlKey || event.metaKey || event.shiftKey || event.button) return;
            event.preventDefault();
            navigate(path);
        };
    };
    const badge = (node, c) => {
        if (!c) return;
        if (c.muteBell) node.append(muteBell());
        const count = c.id === selectedConversationId ? 0 : unread(c);
        if (count > 0)
            node.append(
                element(
                    'span',
                    c.muted ? 'unread-dot' : 'unread-badge',
                    c.muted ? '' : String(count),
                ),
            );
    };
    const rooms = $('#rooms');
    rooms.replaceChildren();
    for (const c of snapshot.conversations.filter((c) => c.kind === 'room')) {
        const a = element(
            'a',
            `room-item${c.id === selectedConversationId ? ' active' : ''}${unread(c) && c.id !== selectedConversationId ? ' has-unread' : ''}`,
        );
        link(a, c.path);
        a.dataset.channel = c.id;
        const name = element('span', 'room-name');
        name.append(richText(c.name, true));
        a.append(element('span', 'room-icon', '#'), name);
        badge(a, c);
        if (snapshot.isAdmin) {
            const settings = element('button', 'room-settings');
            settings.title = 'Channel settings';
            settings.setAttribute('aria-label', 'Channel settings');
            const gear = $('#menu-button .dropdown-gear').cloneNode(true);
            gear.removeAttribute('class');
            settings.append(gear);
            settings.onclick = (event) => {
                event.preventDefault();
                event.stopPropagation();
                toggleSidebar(false);
                location.href = `/channel/${c.id}/settings`;
            };
            a.append(settings);
        }
        rooms.append(a);
    }
    if (snapshot.isAdmin) {
        const add = element('a', 'room-item add-room');
        add.href = '/channel/new';
        add.append(element('span', 'room-icon', '+'), element('span', 'room-name', 'Add Room'));
        add.onclick = () => toggleSidebar(false);
        rooms.append(add);
    }
    const people = $('#dms');
    people.replaceChildren();
    const online = new Map((live.view?.users || []).map((p) => [p.username, p.status]));
    const dm = (person) =>
        snapshot.conversations.find(
            (c) => c.kind === 'dm' && c.path === '/dm/' + encodeURIComponent(person.username),
        );
    const tier = (person) =>
        person.isAdmin ? 0 : person.isBot ? 1 : person.id === snapshot.user.id ? 2 : 3;
    const hasUnread = (person) => {
        const c = dm(person);
        return c && c.id !== selectedConversationId && !c.muted && unread(c) > 0 ? 1 : 0;
    };
    const present = (person) =>
        online.has(person.username) && online.get(person.username) !== 'invisible' ? 1 : 0;
    const lastDm = (person) => {
        const c = dm(person);
        return Date.parse(c?.messages.at(-1)?.timestamp || '') || 0;
    };
    const visible = (snapshot.people || []).filter(
        (p) => !live.view || online.has(p.username) || dm(p) || p.id === snapshot.user.id,
    );
    visible.sort(
        (a, b) =>
            tier(a) - tier(b) ||
            (tier(a) === 3
                ? hasUnread(b) - hasUnread(a) ||
                  present(b) - present(a) ||
                  (!present(a) ? lastDm(b) - lastDm(a) : 0)
                : 0) ||
            a.username.localeCompare(b.username),
    );
    for (const person of visible) {
        const c = dm(person),
            self = person.id === snapshot.user.id;
        const a = element(
            'a',
            `user-item${self ? ' current-user' : ''}${c?.id === selectedConversationId ? ' active-dm' : ''}`,
        );
        a.dataset.username = person.username;
        link(a, '/dm/' + encodeURIComponent(person.username));
        if (self) a.onclick = (event) => event.preventDefault();
        const name = element('span', 'user-name');
        name.append(richText(person.displayName, true));
        if (self) name.append(document.createTextNode(' (you)'));
        name.onmouseenter = (event) => {
            if (!matchMedia('(max-width: 768px), (pointer: coarse)').matches)
                profiles.show(person, event);
        };
        name.onmouseleave = () => profiles.hideHover();
        const info = element('button', 'profile-info-btn');
        info.title = 'View profile';
        info.setAttribute('aria-label', 'View profile');
        info.innerHTML =
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>';
        info.onclick = (event) => {
            event.preventDefault();
            event.stopPropagation();
            profiles.show(person, event, true);
        };
        a.append(
            element('span', 'user-status-dot ' + (online.get(person.username) || 'invisible')),
            name,
            info,
        );
        if (person.isAdmin) {
            const marker = element('span', 'admin-badge');
            marker.append(richText('👑', true));
            marker.title = 'Admin';
            a.append(marker);
        }
        if (person.isBot) {
            const marker = element('span', 'bot-badge');
            marker.append(richText('🤖', true));
            marker.title = 'Bot';
            a.append(marker);
        }
        badge(a, c);
        people.append(a);
    }
    const total = snapshot.conversations
        .filter((c) => !c.muted && !(c.kind === 'dm' && c.id === selectedConversationId))
        .reduce((n, c) => n + unread(c), 0);
    $('#mailbox').hidden = total === 0;
    $('#mailbox').title = `${total} unread messages`;
    $('#mailbox-count').textContent = total;
    if (total !== lastBadge && 'setAppBadge' in navigator) {
        lastBadge = total;
        (total ? navigator.setAppBadge(total) : navigator.clearAppBadge()).catch(() => {});
    }
}
function navigate(path) {
    profiles.close();
    history.pushState(null, '', path);
    render();
    toggleSidebar(false);
}
function decodePath(path) {
    try {
        return decodeURI(path);
    } catch {
        return path;
    }
}
function routeConversation() {
    const path = decodePath(location.pathname).replace(/\/$/, '');
    // The Outgoing section uses channel IDs to keep removed conversations reachable.
    const channelId = new URL(location.href).searchParams.get('channel');
    if (channelId) return snapshot.conversations.find((c) => c.id === channelId);
    if (path.startsWith('/room/'))
        return snapshot.conversations.find(
            (c) => c.kind === 'room' && c.id.toLowerCase() === path.slice(6).toLowerCase(),
        );
    if (path.toLowerCase() === '/dm/' + snapshot.user.username.toLowerCase())
        return snapshot.conversations.find((c) => c.isDefault);
    if (path === '/chat' || path === '/lobby')
        return snapshot.conversations.find((c) => c.isDefault);
    return snapshot.conversations.find(
        (c) => decodePath(c.path || '').toLowerCase() === path.toLowerCase(),
    );
}
async function resolveDm() {
    if (resolvingDm || !navigator.onLine || !identity || !location.pathname.startsWith('/dm/'))
        return;
    resolvingDm = true;
    const account = identity;
    try {
        const session = await get('session');
        if (session.userId !== account.userId) {
            await loseAccount();
            return;
        }
        const name = decodeURIComponent(location.pathname.slice(4));
        const result = await post('dm/' + encodeURIComponent(name), {}, session);
        await acceptSnapshot(result.update || result.snapshot, connectionGeneration);
    } catch (error) {
        notice(error.message);
    } finally {
        resolvingDm = false;
    }
}
async function renderPending() {
    const account = identity,
        channel = selectedConversationId;
    if (!account) return;
    const all = await storage.outbox();
    const pending = all.filter(
        (m) => m.channelId === channel && !m.cancelled && (!m.kind || m.status === 'failed'),
    );
    if (identity?.epoch !== account.epoch || selectedConversationId !== channel || !snapshot)
        return;
    document.dispatchEvent(new CustomEvent('client-outbox', { detail: all }));
    const outgoing = $('#outgoing');
    outgoing.replaceChildren();
    for (const id of new Set(
        all
            .filter((m) => !snapshot.conversations.some((c) => c.id === m.channelId))
            .map((m) => m.channelId),
    )) {
        const item = all.find((m) => m.channelId === id);
        const link = element(
            'a',
            'user-item',
            `Unsent: ${item.conversationName || 'Unavailable conversation'}`,
        );
        link.href = `/chat?channel=${id}`;
        link.onclick = (event) => {
            if (event.ctrlKey || event.metaKey || event.shiftKey || event.button) return;
            event.preventDefault();
            navigate(link.href);
        };
        outgoing.append(link);
    }
    $('#outgoing-section').hidden = !outgoing.children.length;
    const root = $('#pending');
    root.replaceChildren();
    const messages = snapshot.conversations.find((c) => c.id === channel)?.messages ?? [];
    let previous = messages.at(-1);
    for (const item of pending) {
        const message = {
            id: item.operationId,
            author: snapshot.user,
            timestamp: item.createdAt,
            content: item.content,
            operationId: item.operationId,
            pending: true,
            replyToMessageId: item.replyToMessageId,
            images: [],
            videos: [],
            reactions: [],
            gifCount: item.gifEntryId || item.gifSource || item.files?.length ? 1 : 0,
            gifs: item.gifPreview ? [item.gifPreview] : [],
        };
        const row = item.kind
            ? element('article', 'message-group')
            : messageView.createMessage(message, needsMessageHeader(message, previous), messages);
        if (item.kind) {
            const body = element(
                'div',
                'message-body',
                `${item.kind === 'edit' ? 'Edit' : item.kind === 'delete' ? 'Delete' : 'Reaction'} could not be saved. ${item.content || ''}`,
            );
            row.append(body);
        }
        row.removeAttribute('id');
        row.classList.add('pending-message');
        row.dataset.operation = item.operationId;
        const body = row.querySelector('.message-body');
        previous = message;
        if (item.files?.length) {
            body.append(
                element('div', 'attachment-preview', item.files.map((f) => f.name).join(', ')),
            );
            if (item.status === 'sending') body.append(element('progress', 'upload-progress'));
            const progress = body.querySelector('progress');
            if (progress) {
                progress.max = 100;
                progress.value = item.progress || 0;
                progress.setAttribute('aria-label', 'Upload progress');
            }
            const cancel = element('button', 'retry-send', 'Cancel upload');
            cancel.onclick = () =>
                sender
                    .cancelUpload(item.operationId, account)
                    .catch((error) => notice(error.message));
            cancel.hidden = !!item.uploadIds;
            body.append(cancel);
        }
        // Queued/sending messages keep the original faded appearance, without status copy.
        if (item.status === 'failed') {
            body.append(element('span', 'delivery-status failed', 'Failed'));
            body.append(element('span', 'delivery-error', item.error));
            const retryButton = element('button', 'retry-send', 'Retry');
            retryButton.onclick = async () => {
                await storage.setDelivery(item.operationId, 'queued', null, account);
                await renderPending();
                sender.flush();
            };
            body.append(retryButton);
        }
        root.append(row);
    }
}
async function render() {
    if (!snapshot) return;
    const target = routeConversation();
    const id =
        target?.id ||
        new URL(location.href).searchParams.get('channel') ||
        /^\/room\/([^/]+)\/?$/.exec(location.pathname)?.[1];
    if (target?.path && location.pathname !== target.path)
        history.replaceState(null, '', target.path);
    pwa.remember();
    // A newer snapshot may supersede a navigation while its IndexedDB reads are pending.
    // Keep navigation intent until draft restoration completes, not merely until selected changes.
    const switched = selectedConversationId !== id || composer.isRestoring(id);
    selectedConversationId = id;
    const turn = ++renderGeneration;
    const c = snapshot.conversations.find((c) => c.id === selectedConversationId);
    document.documentElement.dataset.theme = snapshot.theme;
    syncThemeColor();
    document.documentElement.style.fontSize =
        snapshot.fontSize >= 12 && snapshot.fontSize <= 24 ? `${snapshot.fontSize}px` : '';
    $('.chat-container').dataset.context = c?.kind || 'room';
    $('#header-line').src =
        c?.kind === 'dm' ? '/images/purpleline01_3px.png' : '/images/turqline01_3px.png';
    $('#title').replaceChildren(
        richText(
            c
                ? c.kind === 'room'
                    ? chatLabel('roomHeaders', '# {0}', c.id, c.name)
                    : c.name
                : snapshot.projectName,
            true,
        ),
    );
    notifications.render();
    $('#back').hidden = !c || c.isDefault;
    $('#header-avatar').replaceChildren();
    const partner =
        c?.kind === 'dm'
            ? snapshot.people?.find((p) => '/dm/' + encodeURIComponent(p.username) === c.path)
            : null;
    $('#header-avatar').hidden = !partner;
    if (partner) {
        const face = avatar(partner);
        face.className = 'avatar avatar-small';
        $('#header-avatar').append(face);
    }
    $('#draft').placeholder = partner
        ? `Message @${partner.username}`
        : chatLabel('messagePlaceholders', 'Type a message...', c?.id || 'lobby');
    $('#status-username').replaceChildren(richText(snapshot.user.displayName, true));
    $('#admin-link').hidden = !snapshot.isAdmin;
    if (switched) {
        live.navigate();
        renderLive();
    }
    if (switched) {
        actions.reset();
        composer.beginNavigation(id);
    }
    pendingOperations = await storage.outbox();
    if (turn !== renderGeneration || selectedConversationId !== id || currentConversation() !== c)
        return;
    $('#timeline').dataset.username = snapshot.user.username;
    const historyView = chatHistory.view(c);
    const display = c
        ? {
              ...historyView,
              messages: applyMutations(
                  historyView.messages,
                  pendingOperations.filter((m) => m.channelId === id),
                  snapshot.user.username,
              ),
          }
        : c;
    sidebar();
    messageView.render(display);
    // Arm following as soon as destination content exists. Read acknowledgements may
    // trigger a newer render before this one finishes its remaining IndexedDB awaits.
    if (switched) scrolling.bottom();
    if (!c && location.pathname.startsWith('/dm/')) resolveDm();
    if (!c) $('#draft').disabled = true;
    if (switched)
        await composer.restore(
            id,
            c,
            () => turn === renderGeneration && selectedConversationId === id,
        );
    if (turn !== renderGeneration || selectedConversationId !== id) return;
    composer.renderReply();
    composer.update();
    await renderPending();
    readMarkers = await storage.reads();
    if (turn === renderGeneration && selectedConversationId === id) {
        sidebar();
        await reader.observe(c, switched);
    }
    if (turn !== renderGeneration || selectedConversationId !== id) return;
    scrolling.update();
    chatHistory.refresh();
    windows.schedule();
    warmImages(snapshot, identity, id);
}
function toggleSidebar(open = !$('.users-sidebar').classList.contains('sidebar-open')) {
    $('.users-sidebar').classList.toggle('sidebar-open', open);
    $('.sidebar-backdrop').classList.toggle('show', open);
    $('#sidebar-button').setAttribute('aria-expanded', String(open));
}
$('#load-history').onclick = () => chatHistory.load(currentConversation());
$('.messages').addEventListener('scroll', () => {
    if (
        $('.messages').scrollTop < 60 &&
        chatHistory.view(currentConversation())?.hasMore &&
        !chatHistory.busy
    )
        chatHistory.load(currentConversation());
});
setInterval(
    () =>
        document
            .querySelectorAll('.message-time[data-timestamp]')
            .forEach((n) => (n.textContent = formatTimestamp(n.dataset.timestamp))),
    60000,
);
$('#back').onclick = () => navigate('/lobby');
$('#mailbox').onclick = () => toggleSidebar(true);
document.querySelectorAll('[data-status]').forEach(
    (button) =>
        (button.onclick = async () => {
            try {
                await live.setStatus(button.dataset.status);
            } catch {
                notice('Status could not be changed. Try again when connected.');
            }
            toggleMenu(false);
        }),
);
$('#sidebar-button').onclick = () => toggleSidebar();
$('.sidebar-backdrop').onclick = () => toggleSidebar(false);
function toggleMenu(open = $('#account-menu').hidden) {
    $('#account-menu').hidden = !open;
    $('#menu-backdrop').hidden = !open;
    $('#menu-button').setAttribute('aria-expanded', String(open));
}
$('#menu-button').onclick = () => toggleMenu();
$('#account-menu')
    .querySelectorAll('a')
    .forEach((link) =>
        link.addEventListener('click', () => {
            toggleMenu(false);
            toggleSidebar(false);
        }),
    );
document.addEventListener('click', (event) => {
    if (!event.target.closest('#account-menu, #menu-button')) toggleMenu(false);
});
$('#forget').onclick = async () => {
    await loseAccount(true);
    notice('Offline data removed. Reload while online to synchronize again.', true);
};
$('#signout').onclick = async () => {
    toggleMenu(false);
    const session = navigator.onLine ? await get('session').catch(() => null) : null;
    const hasWayBack = session?.hasWayBack ?? (await storage.metadata('hasWayBack'));
    if (
        hasWayBack === false &&
        !confirm(
            'You have no login link and no secret code. Without one, you won’t be able to get back into this account. Continue signing out?',
        )
    )
        return;
    await pwa.signOut();
    await loseAccount(true);
    location.href = '/auth/signout';
};
window.addEventListener('popstate', render);
function acceptSnapshot(
    data,
    attemptGeneration,
    acknowledgedOperation = null,
    notificationOptions = {},
) {
    snapshotQueue = snapshotQueue
        .catch(() => {})
        .then(async () => {
            if (attemptGeneration !== connectionGeneration) return;
            const old = snapshot;
            if (data.protocol === 2) {
                snapshot =
                    (await storage.commitUpdate(data, identity, acknowledgedOperation)) || snapshot;
                if (old?.serverEpoch === snapshot?.serverEpoch) {
                    const before = new Map(old.conversations.map((c) => [c.id, c]));
                    snapshot.conversations = snapshot.conversations.map((c) => {
                        const prior = before.get(c.id);
                        return prior?.sync && prior.sync.version === c.sync?.version ? prior : c;
                    });
                }
            } else {
                if (data.protocol !== 1) throw new Error('Client update required');
                if (data.user.id !== identity?.userId) throw new Error('ACCOUNT_CHANGED');
                const committed = await storage.commit(data, identity, acknowledgedOperation);
                snapshot = committed ? data : (await storage.readState())?.snapshot;
            }
            if (attemptGeneration !== connectionGeneration || !snapshot) return;
            chatHistory.reconcile(snapshot).catch(() => {});
            await notifications.observe(snapshot, notificationOptions);
            if (attemptGeneration !== connectionGeneration) return;
            const affectsCurrent =
                data.protocol !== 2 ||
                data.state ||
                acknowledgedOperation ||
                data.conversations.some(
                    (c) => c.id === selectedConversationId || c.state.path === location.pathname,
                ) ||
                data.removedConversations.includes(selectedConversationId) ||
                !old;
            if (affectsCurrent) await render();
            else {
                sidebar();
                windows.schedule();
            }
            status(
                workerReady ? 'Synced · available offline' : 'Synced · offline reload unavailable',
            );
            notice('');
        })
        .catch((error) => {
            status('Sync failed');
            notice(
                error.message === 'ACCOUNT_CHANGED'
                    ? 'Account changed. Reload to continue.'
                    : `Could not save chat: ${error.message}`,
            );
            if (acknowledgedOperation) throw error;
        });
    return snapshotQueue;
}
function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => connectChat(), 3000);
}
async function bootstrapChat(cached = snapshot) {
    const path = location.pathname;
    const channelId = new URL(location.href).searchParams.get('channel');
    const current = cached?.conversations.find((c) =>
        channelId
            ? c.id === channelId
            : ['/', '/chat'].includes(path)
              ? c.isDefault
              : c.path.toLowerCase() === path.toLowerCase(),
    );
    const query = new URLSearchParams({ path });
    if (channelId) query.set('channelId', channelId);
    if (current?.sync?.loaded && current.sync.revision) {
        query.set('revision', current.sync.revision);
        query.set('epoch', cached.serverEpoch);
        query.set('knownUser', cached.user.id);
    }
    return get('bootstrap?' + query);
}
async function connectChat(bootstrap = null) {
    if (connecting) return;
    connecting = true;
    const attemptGeneration = ++connectionGeneration;
    try {
        live.detach();
        await hubConnection?.stop();
        bootstrap ||= await bootstrapChat();
        if (attemptGeneration !== connectionGeneration) return;
        const session = useSession(bootstrap.session);
        if (identity && identity.userId !== session.userId) clearUI();
        identity = await storage.establish(session.userId);
        if (attemptGeneration !== connectionGeneration) return;
        await acceptSnapshot(bootstrap.update, attemptGeneration, null, { baseline: true });
        sender.start();
        // Optional data never gates the active view or outgoing operations.
        reader.flush();
        loadContent(identity)
            .then(() => render())
            .catch(() => {});
        windows.schedule();
        hubConnection = new signalR.HubConnectionBuilder()
            .withUrl('/hubs/chat')
            .configureLogging(signalR.LogLevel.Warning)
            .build();
        await hubConnection.start();
        if (attemptGeneration !== connectionGeneration) {
            await hubConnection.stop();
            return;
        }
        await storage.saveMetadata('hasWayBack', session.hasWayBack, identity);
        await live.attach(hubConnection, session.liveTicket);
        pwa.start(session);
        let firstPacket = true;
        hubConnection
            .stream(
                'WatchChanges',
                Object.fromEntries(
                    snapshot.conversations
                        .filter((c) => c.sync?.loaded && c.sync.revision)
                        .map((c) => [c.id, c.sync.revision]),
                ),
                snapshot.stateRevision || null,
            )
            .subscribe({
                next: (data) => {
                    const baseline = firstPacket;
                    firstPacket = false;
                    return acceptSnapshot(data, attemptGeneration, null, {
                        baseline,
                        live: !baseline,
                    });
                },
                error: (error) => {
                    if (attemptGeneration !== connectionGeneration) return;
                    if (error.message.includes('AUTH_REQUIRED')) loseAccount();
                    else {
                        live.detach();
                        status('Disconnected · cached chat');
                        scheduleReconnect();
                    }
                },
                complete: () => {
                    if (attemptGeneration === connectionGeneration) scheduleReconnect();
                },
            });
        hubConnection.onclose(() => {
            if (attemptGeneration === connectionGeneration) {
                live.detach();
                status('Disconnected · cached chat');
                scheduleReconnect();
            }
        });
    } catch (error) {
        if (attemptGeneration !== connectionGeneration) return;
        if (error.message === 'AUTH_REQUIRED') await loseAccount();
        else {
            status(snapshot ? 'Offline · cached chat' : 'Offline · connect to set up');
            if (!snapshot) notice('No available offline chat. Connect and sign in first.', true);
            scheduleReconnect();
        }
    } finally {
        connecting = false;
        if (identity && navigator.onLine && attemptGeneration !== connectionGeneration)
            scheduleReconnect();
    }
}
async function boot() {
    try {
        // A blocked worker must not block authentication, synchronization, or local drafts.
        // Browser certificate exceptions for pages do not necessarily apply to worker scripts.
        try {
            // ready can resolve to the original push-only worker during the first upgrade.
            // Only the worker controlling this page can confirm it serves the offline shell.
            const checkWorker = () => {
                workerReady = false;
                if ($('#connection').textContent.startsWith('Synced'))
                    status('Synced · offline reload unavailable');
                navigator.serviceWorker.controller?.postMessage({ type: 'CHAT_OFFLINE_CHECK' });
            };
            navigator.serviceWorker.addEventListener('message', (event) => {
                if (
                    event.data?.type !== 'CHAT_OFFLINE_READY' ||
                    event.source !== navigator.serviceWorker.controller
                )
                    return;
                workerReady = true;
                if (identity)
                    get('session')
                        .then((session) => {
                            if (session.userId === identity?.userId) pwa.start(session);
                        })
                        .catch(() => {});
                if ($('#connection').textContent.startsWith('Synced'))
                    status('Synced · available offline');
            });
            navigator.serviceWorker.addEventListener('controllerchange', checkWorker);
            navigator.serviceWorker
                .register('/service-worker.js', { updateViaCache: 'none' })
                .then((registration) => {
                    watchWorkerUpdates(registration);
                    checkWorker();
                })
                .catch((error) => {
                    workerWarning =
                        'Chat can open, but offline reload is unavailable. This browser needs a trusted connection to enable it.';
                    console.warn(error);
                });
        } catch (error) {
            workerWarning =
                'Chat can open, but offline reload is unavailable. This browser needs a trusted connection to enable it.';
            if (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname))
                workerWarning += ` For local testing, open http://localhost${location.port ? ':' + location.port : ''}/lobby.`;
            console.warn('Offline worker registration failed:', error);
            notice('');
        }
        const state = await storage.readState();
        await pwa.resume();
        let bootstrap;
        // One authenticated bootstrap both validates local ownership and supplies active data.
        try {
            bootstrap = await bootstrapChat(state?.snapshot);
            useSession(bootstrap.session);
            identity = await storage.establish(bootstrap.session.userId);
        } catch (error) {
            if (error.message === 'AUTH_REQUIRED') {
                await loseAccount();
                return;
            }
            if (state?.userId && !state.locked) identity = state;
            else {
                status('Connect to continue');
                notice('Offline chat has not been set up or is locked. Connect to sign in.', true);
                return;
            }
        }
        await pwa.resume();
        loadContent(identity, false)
            .then(() => render())
            .catch(() => {});
        await chatHistory.restore(state?.userId === identity.userId ? state.snapshot : null);
        if (state?.userId === identity.userId && state.snapshot) {
            snapshot = state.snapshot;
            await render();
        }
        if (navigator.onLine) await connectChat(bootstrap);
        else status('Offline · cached chat');
    } catch (error) {
        status('Offline storage unavailable');
        notice(`Chat could not start: ${error.message}`);
    }
}
storage.onExternalChange(async (type) => {
    if (type?.type === 'cancel-upload') type = 'outbox';
    if (type === 'reads') {
        readMarkers = await storage.reads();
        if (snapshot) sidebar();
        reader.flush();
        return;
    }
    if (
        type === 'forget' ||
        type === 'locked' ||
        type === 'upgrade' ||
        (type === 'account' && (await storage.readState())?.epoch !== identity?.epoch)
    ) {
        await stopConnection();
        clearUI();
        identity = null;
        status('Account changed');
        notice('Offline data changed in another tab. Reload to continue.', true);
    } else if (identity && (type === 'outbox' || type === 'snapshot')) {
        const current = await storage.readState();
        if (current?.epoch === identity.epoch && !current.locked) {
            snapshot = current.snapshot;
            if (snapshot) chatHistory.reconcile(snapshot).catch(() => {});
            await render();
            sender.flush();
        }
    }
});
window.addEventListener('online', () => {
    if (identity) connectChat();
});
window.addEventListener('offline', () => {
    stopConnection();
    status('Offline · cached chat');
});
document.addEventListener('visibilitychange', () => {
    if (!document.hidden && identity) {
        // Worker pushes can change the OS badge while hidden; reapply page state on return.
        lastBadge = -1;
        if (snapshot) sidebar();
        if (!live.connected) connectChat();
        else reader.observe(currentConversation()).catch((error) => notice(error.message));
    }
});
document.addEventListener('client-badge-refresh', () => {
    lastBadge = -1;
    if (snapshot) sidebar();
});
// Cross-tab cookie changes are checked off the interaction path. Writes are independently
// protected by the expected account and antiforgery token at the server boundary.
setInterval(async () => {
    if (!identity || !navigator.onLine) return;
    try {
        const session = await refreshSession();
        if (session.userId !== identity.userId) connectChat();
    } catch (error) {
        if (error.message === 'AUTH_REQUIRED') loseAccount();
    }
}, 30000);
// Recovery rebuilds the view without clearing durable drafts, reads or queued writes.
const showRecovery = () => {
    if (identity) $('#recovery').hidden = false;
};
window.addEventListener('error', (event) => {
    if (event.error) showRecovery();
});
window.addEventListener('unhandledrejection', showRecovery);
$('#reload-client').onclick = () => location.reload();
$('#retry-client').onclick = async () => {
    $('#recovery').hidden = true;
    try {
        messageView.clear();
        await render();
        await connectChat();
    } catch {
        showRecovery();
    }
};
const scenes = [
    'midnight',
    'midnight',
    '2am',
    '314am',
    '4am',
    '4am',
    '6am',
    '6am',
    '8am',
    '8am',
    '10am',
    '10am',
    'noon',
    'noon',
    '2pm',
    '2pm',
    '4pm',
    '4pm',
    '6pm',
    '6pm',
    '8pm',
    '8pm',
    '10pm',
    '10pm',
];
function syncThemeColor() {
    // Phone chrome follows the actual theme/scene canvas, including Tea House's time changes.
    const color = getComputedStyle(document.documentElement).backgroundColor;
    if (color && color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)')
        $('meta[name="theme-color"]').content = color;
}
function scene() {
    document.documentElement.dataset.scene = scenes[new Date().getHours()];
    syncThemeColor();
}
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scene();
});
scene();
setInterval(scene, 60000);
boot();
