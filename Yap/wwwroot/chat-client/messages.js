import { renderMedia } from './rich-media.js';
import { richText, contentRevision } from './content.js';
import { timestamp } from './dates.js';
import { favorite } from './gifs.js';
import { installGuide } from './pwa.js';
import { imageSource } from './media.js';
import { openGallery } from './gallery.js';
const $ = (selector) => document.querySelector(selector);
const element = (tag, className, text) => {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
};
export function avatar(author) {
    const node = element('div', 'avatar avatar-medium');
    node.style.background = author.gradient;
    node.title = author.username;
    node.append(element('span', 'avatar-initials', author.username[0]?.toUpperCase() ?? '?'));
    if (author.picture) {
        const img = element('img', 'avatar-image');
        img.src = author.picture;
        img.alt = author.displayName;
        img.onerror = () => img.remove();
        node.append(img);
    }
    return node;
}
export function needsMessageHeader(message, previous) {
    return (
        !previous ||
        previous.author.id !== message.author.id ||
        new Date(message.timestamp) - new Date(previous.timestamp) >= 3600000 ||
        !!message.replyToMessageId
    );
}
// The timeline owns rendered rows and hydrated media URLs. Keep this cache separate
// from snapshots so ordinary updates can preserve editors, selection and playback.
export function createMessages({ identity, snapshot, current, actions, history, notice }) {
    const nodes = new Map();
    const urls = new Set();
    function textWithLinks(text) {
        return richText(text);
    }
    function formatTimestamp(value) {
        return timestamp(value, snapshot()?.dateSettings);
    }
    function messageNode(message, header, messages) {
        const node = element(
            'article',
            `message-group${header ? ' has-header' : ''}${message.replyToMessageId ? ' has-reply' : ''}`,
        );
        node.id = `msg-${message.id}`;
        node.dataset.author = message.author.username;
        if (message.replyToMessageId) {
            const target = messages.find((m) => m.id === message.replyToMessageId) || message.reply;
            const reply = element('button', 'reply-preview');
            if (target) {
                const face = avatar(target.author);
                face.className = 'avatar avatar-small';
                const text = element('span', 'reply-text');
                text.append(richText(target.content || 'Click to see attachment', true));
                reply.append(
                    face,
                    element('span', 'reply-author', target.author.displayName),
                    text,
                );
            } else reply.textContent = 'Original message unavailable';
            reply.onclick = () => history.jump(current(), message.replyToMessageId);
            node.append(reply);
        }
        if (header) node.append(avatar(message.author));
        const body = element('div', 'message-body');
        node.append(body);
        if (header) {
            const meta = element('div', 'message-meta'),
                name = element('strong', 'message-username');
            name.append(richText(message.author.displayName, true));
            meta.append(name);
            if (message.author.isBot) {
                const bot = element('span', 'bot-badge');
                bot.append(richText('🤖', true));
                bot.title = 'Bot';
                meta.append(bot);
            }
            const time = element('span', 'message-time', formatTimestamp(message.timestamp));
            time.dataset.timestamp = message.timestamp;
            meta.append(time);
            body.append(meta);
        }
        const content = element('div', 'message-content');
        body.append(content);
        if (message.author.isBot && message.content.includes('[pwa-install]')) {
            const [before, ...after] = message.content.split('[pwa-install]');
            content.append(textWithLinks(before));
            const install = element('button', 'bot-action-link', 'install it');
            install.onclick = () => installGuide().catch((error) => notice(error.message));
            content.append(install, textWithLinks(after.join('[pwa-install]')));
        } else if (message.content) content.append(textWithLinks(message.content));
        if (message.author.username === 'System') node.classList.add('system-message');
        if (message.isEdited) content.append(element('span', 'edited-indicator', ' (edited)'));
        if (message.images.length) {
            const gallery = element(
                'div',
                `image-gallery${message.images.length === 1 ? ' gallery-single' : ''}`,
            );
            content.append(gallery);
            let row = gallery,
                remaining = 0;
            message.images.forEach((img, index) => {
                if (message.images.length > 1 && !remaining) {
                    const left = message.images.length - index;
                    remaining = left <= 3 ? left : left % 3 === 0 ? 3 : 2;
                    row = element('div', 'gallery-row');
                    gallery.append(row);
                }
                const button = element('button', 'gallery-item');
                button.setAttribute('aria-label', `Open image ${index + 1}`);
                const preview = element('img', 'gallery-image');
                preview.alt = 'Uploaded image';
                preview.width = 800;
                preview.height = message.images.length === 1 ? 600 : 800;
                preview.loading = 'lazy';
                preview.dataset.medium = img.medium;
                button.append(preview);
                row.append(button);
                remaining--;
                button.onclick = () => openGallery(message.images, index, identity().userId);
                // Online thumbnails must not wait behind the background cache warmer's other conversations.
                preview.onerror = () => {
                    preview.onerror = null;
                    preview.removeAttribute('src');
                    preview.alt = 'Image unavailable offline';
                    hydrateImage(preview);
                };
                if (navigator.onLine) preview.src = img.medium;
                else hydrateImage(preview);
            });
        }
        renderMedia(message, content, (gif, button) =>
            favorite(gif, button, identity()).catch((error) => notice(error.message)),
        );
        renderReactions(node, message);
        actions.attach(node, message);
        return node;
    }
    function renderReactions(row, message) {
        row.querySelector('.reactions-display')?.remove();
        if (!message.reactions.length) return;
        const reactions = element('div', 'reactions-display');
        for (const r of message.reactions) {
            const pill = element(
                'button',
                'reaction-pill' + (r.users.includes(snapshot().user.username) ? ' reacted' : ''),
            );
            pill.append(
                richText(r.emoji, true),
                element('span', 'reaction-count', String(r.users.length)),
            );
            pill.dataset.emoji = r.emoji;
            pill.title = r.users.join(', ');
            reactions.append(pill);
        }
        row.querySelector('.message-body').append(reactions);
    }
    async function hydrateImage(img) {
        if (img.src || !identity()) return;
        const source = await imageSource(img.dataset.medium, identity().userId);
        if (source) {
            if (!img.isConnected) {
                URL.revokeObjectURL(source);
                return;
            }
            urls.add(source);
            img.src = source;
            img.alt = 'Cached image';
        }
    }
    document.addEventListener('chat-media-ready', () =>
        document.querySelectorAll('img[data-medium]').forEach(hydrateImage),
    );
    function timeline(conversation) {
        const keep = new Set();
        let previous;
        let position = 0;
        for (const message of conversation?.messages ?? []) {
            const header = needsMessageHeader(message, previous);
            // A target can change without the reply message changing; invalidate its preview too.
            const replyTarget = message.replyToMessageId
                ? conversation.messages.find((m) => m.id === message.replyToMessageId) ||
                  message.reply
                : null;
            const signature = JSON.stringify([
                message,
                contentRevision(),
                header,
                snapshot().dateSettings,
                replyTarget,
            ]);
            const contentSignature = JSON.stringify([
                { ...message, reactions: undefined },
                header,
                snapshot().dateSettings,
                replyTarget,
            ]);
            let record = nodes.get(message.id);
            if (!record || (record.signature !== signature && !actions.isEditing(message.id))) {
                if (record?.contentSignature === contentSignature) {
                    // Reactions must not detach media: replacing the row resets playback and GIFs.
                    renderReactions(record.node, message);
                    record.node.querySelector('.message-actions')?.remove();
                    actions.attach(record.node, message);
                    record.signature = signature;
                } else {
                    const node = messageNode(message, header, conversation.messages);
                    if (record) {
                        record.node.querySelectorAll('img[src^="blob:"]').forEach((img) => {
                            if (urls.delete(img.src)) URL.revokeObjectURL(img.src);
                        });
                        record.node.replaceWith(node);
                    }
                    record = { signature, contentSignature, node };
                    nodes.set(message.id, record);
                }
            }
            // Only hydrated message media uses object URLs.
            // Append only new nodes. Existing nodes retain selection, playback, and scroll geometry.
            const atPosition = $('#timeline').children[position++];
            if (atPosition !== record.node)
                $('#timeline').insertBefore(record.node, atPosition || null);
            keep.add(message.id);
            previous = message;
        }
        for (const [id, record] of nodes)
            if (!keep.has(id)) {
                record.node.querySelectorAll('img[src^="blob:"]').forEach((img) => {
                    if (urls.delete(img.src)) URL.revokeObjectURL(img.src);
                });
                record.node.remove();
                nodes.delete(id);
            }
        $('#history-note').textContent = conversation
            ? conversation.hasMore
                ? navigator.onLine
                    ? ''
                    : 'Earlier uncached history needs a connection.'
                : conversation.historyLimited
                  ? 'Older messages are not available in this channel'
                  : conversation.description || `This is the beginning of #${conversation.name}`
            : 'This conversation is not cached or is no longer accessible. Connect to refresh.';
        $('#load-history').hidden = !conversation?.hasMore || !navigator.onLine;
        $('#load-history').disabled = history.busy;
        const note = $('#history-note');
        note.className =
            conversation?.kind === 'dm' && !conversation.hasMore
                ? 'system-message'
                : 'history-start';
        if (conversation?.kind === 'dm' && !conversation.hasMore) {
            const content = element(
                'div',
                'message-content',
                'This is the beginning of your direct message history with ',
            );
            content.append(
                element(
                    'strong',
                    '',
                    decodeURIComponent((conversation.path || '').slice(4)) || conversation.name,
                ),
                document.createTextNode('.'),
            );
            note.replaceChildren(content);
        }
    }

    return {
        render: timeline,
        createMessage: messageNode,
        clear() {
            nodes.clear();
            $('#timeline').replaceChildren();
            urls.forEach(URL.revokeObjectURL);
            urls.clear();
        },
    };
}
