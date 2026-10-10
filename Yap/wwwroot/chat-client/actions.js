import { isTouchDevice } from './composer.js';
import { recordEmoji, richText } from './content.js';
import { avatar } from './messages.js';
import { timestamp } from './dates.js';
import * as storage from './storage.js';
const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
};
const icons = {
    copy: 'M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z',
    delete: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
    star: 'M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z',
    picker: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm-5-6c.78 2.34 2.72 4 5 4s4.22-1.66 5-4H7zm8-5a1 1 0 1 0 0 2 1 1 0 0 0 0-2zM9 9a1 1 0 1 0 0 2 1 1 0 0 0 0-2z',
    reply: 'M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z',
    edit: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75z',
    more: 'M6 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
};
export function createActions({
    snapshot = () => null,
    identity,
    current,
    render,
    flush,
    notice,
    reply,
    pickEmoji,
    quickReactions,
    favorite,
    renderEmoji,
}) {
    let closePopup = () => {},
        editing = null,
        popupOpen = false,
        idleTimer,
        menuOwner;
    const button = (cls, label, handler, icon) => {
        const b = el('button', cls, icon ? undefined : label);
        b.title = label;
        b.setAttribute('aria-label', label);
        if (icon) {
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('viewBox', '0 0 24 24');
            svg.setAttribute('width', '18');
            svg.setAttribute('height', '18');
            svg.setAttribute('fill', 'currentColor');
            const p = document.createElementNS(svg.namespaceURI, 'path');
            p.setAttribute('d', icons[icon]);
            svg.append(p);
            b.append(svg);
            if (cls.includes('more-menu-item')) b.append(el('span', '', label));
        }
        b.onclick = (e) => {
            e.stopPropagation();
            Promise.resolve(handler(e)).catch((err) => notice(err.message));
        };
        return b;
    };
    async function mutate(message, kind, extra = {}) {
        const owner = identity(),
            channel = current()?.id;
        if (!owner || !channel) return;
        if (
            message.pending &&
            ['edit', 'delete'].includes(kind) &&
            (await storage.changePending(message.operationId, kind, extra.content, owner))
        )
            storage.notify('outbox');
        else
            await storage.enqueue(channel, extra.content ?? '', owner, {
                kind,
                messageId: message.id,
                ...extra,
            });
        await render();
        flush();
    }
    function popup(node, anchor, messageId) {
        closePopup();
        popupOpen = true;
        menuOwner = messageId;
        anchor.closest('.message-group')?.classList.add('menu-open');
        const backdrop = el('div', 'more-menu-backdrop');
        document.querySelector('.chat-container').append(backdrop);
        document.body.append(node);
        const rect = anchor.getBoundingClientRect();
        if (innerWidth > 600) {
            const bottom = Math.min(
                innerHeight,
                anchor.closest('.messages')?.getBoundingClientRect().bottom ?? innerHeight,
            );
            const top =
                rect.bottom + 4 + node.offsetHeight <= bottom
                    ? rect.bottom + 4
                    : rect.top - node.offsetHeight - 4;
            node.style.position = 'fixed';
            node.style.top = Math.max(4, top) + 'px';
            node.style.left =
                Math.max(
                    8,
                    Math.min(rect.right - node.offsetWidth, innerWidth - node.offsetWidth - 8),
                ) + 'px';
        }
        // Original menu CSS stays hidden until its positioning code reveals it.
        node.style.visibility = 'visible';
        const outside = (e) => {
            if (!node.contains(e.target)) closePopup();
        };
        document.addEventListener('pointerdown', outside);
        closePopup = () => {
            document
                .querySelectorAll('.message-group.menu-open')
                .forEach((row) => row.classList.remove('menu-open'));
            menuOwner = null;
            node.remove();
            backdrop.remove();
            popupOpen = false;
            document.removeEventListener('pointerdown', outside);
            closePopup = () => {};
        };
    }
    function remove(message, event) {
        closePopup();
        if (event.shiftKey) return mutate(message, 'delete');
        const overlay = el('div', 'delete-confirm-overlay'),
            dialog = el('div', 'delete-confirm-dialog');
        overlay.append(dialog);
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-label', 'Delete Message');
        const preview = el('div', 'delete-confirm-preview'),
            meta = el('div', 'preview-meta'),
            picture = avatar(message.author);
        picture.className = 'avatar avatar-small';
        meta.append(
            picture,
            el('strong', 'preview-username', message.author.displayName || message.author.username),
            el('span', 'preview-time', timestamp(message.timestamp, snapshot()?.dateSettings)),
        );
        preview.append(meta);
        if (message.content) {
            const content = el('div', 'preview-content');
            content.append(richText(message.content, true));
            preview.append(content);
        }
        const thumbnail =
            message.images?.[0]?.medium || message.videos?.[0]?.replace(/\.[^.]+$/, '_poster.webp');
        if (thumbnail) {
            const image = el('img', 'preview-thumb');
            image.src = thumbnail;
            image.alt = 'Attachment';
            preview.append(image);
        } else if (message.gifs?.length || message.gifCount) {
            preview.append(el('div', 'preview-attachment-label', 'GIF attachment'));
        } else if (message.files?.length) {
            preview.append(
                el(
                    'div',
                    'preview-attachment-label',
                    message.files.map((file) => file.name).join(', '),
                ),
            );
        }
        dialog.append(
            el('h3', 'delete-confirm-title', 'Delete Message'),
            el('p', 'delete-confirm-text', 'Are you sure you want to delete this message?'),
            preview,
            el(
                'div',
                'delete-confirm-tip',
                'Pro tip: hold Shift when deleting to skip this confirmation.',
            ),
        );
        const buttons = el('div', 'delete-confirm-actions');
        dialog.append(buttons);
        buttons.append(
            button('confirm-cancel', 'Cancel', () => closePopup()),
            button('confirm-delete', 'Delete', async () => {
                closePopup();
                await mutate(message, 'delete');
            }),
        );
        document.body.append(overlay);
        popupOpen = true;
        closePopup = () => {
            overlay.remove();
            popupOpen = false;
            closePopup = () => {};
        };
        overlay.onclick = (e) => {
            if (e.target === overlay) closePopup();
        };
        buttons.lastChild.focus();
    }
    function edit(row, message) {
        closePopup();
        if (editing) editing.cancel(true).catch((err) => notice(err.message));
        const content = row.querySelector('.message-content'),
            previous = [...content.childNodes],
            box = el('div', 'edit-container'),
            input = el('textarea', 'edit-input');
        input.value = message.content;
        input.rows = 1;
        input.maxLength = snapshot()?.maxTextLength ?? 4000;
        input.setAttribute('aria-label', 'Edit message');
        box.append(input);
        const controls = el('div', 'edit-actions');
        box.append(controls);
        // Snapshots keep arriving while this row is protected by the editor. User cancellation
        // must reconcile them; reset/save callers already render and must not recurse here.
        const cancel = (refresh = false) => {
            content.replaceChildren(...previous);
            row.classList.remove('editing');
            editing = null;
            if (refresh) return render();
        };
        const save = async () => {
            if (!input.value.trim()) return;
            if (input.value === message.content) {
                await cancel(true);
                return;
            }
            await mutate(message, 'edit', { content: input.value });
            cancel();
            await render();
        };
        controls.append(
            button('edit-save', '✓ Save', save),
            button('edit-cancel', '✕ Cancel', () => cancel(true)),
            el('span', 'edit-hint', 'Enter to save · Shift+Enter for newline · Esc to cancel'),
        );
        editing = {
            id: message.id,
            row,
            cancel,
            update(value) {
                message = value;
                this.id = value.id;
            },
        };
        row.classList.add('editing');
        content.replaceChildren(box);
        if (!isTouchDevice()) input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        const resize = () => {
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 200) + 'px';
            requestAnimationFrame(() => controls.scrollIntoView({ block: 'nearest' }));
        };
        input.oninput = resize;
        resize();
        input.onkeydown = (e) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                cancel(true).catch((err) => notice(err.message));
            } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isTouchDevice()) {
                e.preventDefault();
                save().catch((err) => notice(err.message));
            }
        };
    }
    async function reaction(message, emoji) {
        recordEmoji(emoji, identity());
        const active = !message.reactions
            ?.find((r) => r.emoji === emoji)
            ?.users.includes(identity()?.snapshot?.user?.username || currentUser());
        await mutate(message, 'reaction', { emoji, active });
    }
    const currentUser = () => document.querySelector('#timeline')?.dataset.username;
    function attach(row, message) {
        if (message.author.username === 'System') return;
        // The backdrop intentionally removes hover; preserve the original open-menu action bar.
        if (message.id === menuOwner) row.classList.add('menu-open');
        const bar = el('div', 'message-actions'),
            own = message.author.id === identity()?.userId;
        if (!message.pending) {
            for (const emoji of quickReactions()) {
                const quick = button('action-btn', emoji, () => reaction(message, emoji));
                quick.replaceChildren(renderEmoji(emoji));
                bar.append(quick);
            }
            bar.append(
                el('div', 'action-divider'),
                button(
                    'action-btn action-picker',
                    'Add Reaction',
                    (e) => pickEmoji(e.currentTarget, (emoji) => reaction(message, emoji)),
                    'picker',
                ),
            );
            bar.append(button('action-btn action-reply', 'Reply', () => reply(message), 'reply'));
        }
        if (!message.pending && message.gifs?.length)
            bar.append(
                button(
                    'action-btn action-gif-fav' + (message.gifs[0].favorite ? ' favorited' : ''),
                    message.gifs[0].favorite ? 'Remove from favorites' : 'Add to favorites',
                    (e) => favorite(message.gifs[0], e.currentTarget),
                    'star',
                ),
            );
        if (own && !message.images.length && !message.videos.length && !message.gifCount)
            bar.append(button('action-btn action-edit', 'Edit', () => edit(row, message), 'edit'));
        if (own || message.content)
            bar.append(
                button(
                    'action-btn action-more',
                    'More',
                    (e) => {
                        const menu = el('div', 'more-menu');
                        if (message.content)
                            menu.append(
                                button(
                                    'more-menu-item',
                                    'Copy Text',
                                    async () => {
                                        await navigator.clipboard.writeText(message.content);
                                        closePopup();
                                    },
                                    'copy',
                                ),
                            );
                        if (own)
                            menu.append(
                                button(
                                    'more-menu-item menu-item-danger',
                                    'Delete Message',
                                    (e) => remove(message, e),
                                    'delete',
                                ),
                            );
                        popup(menu, e.currentTarget, message.id);
                    },
                    'more',
                ),
            );
        row.append(bar);
        for (const pill of row.querySelectorAll('[data-emoji]'))
            pill.onclick = () =>
                reaction(message, pill.dataset.emoji).catch((err) => notice(err.message));
    }
    const scroller = document.querySelector('.messages');
    let scrollStart = 0;
    const dismiss = () => {
        if (
            !isTouchDevice() ||
            popupOpen ||
            document.querySelector('.client-reaction-picker') ||
            document.querySelector('.message-input-container[data-picker]')
        )
            return;
        scroller.classList.add('scroll-dismissing');
        document
            .querySelectorAll('.touch-actions')
            .forEach((n) => n.classList.remove('touch-actions'));
    };
    document.addEventListener(
        'pointerdown',
        (event) => {
            if (event.pointerType !== 'touch') return;
            clearTimeout(idleTimer);
            const row = event.target.closest('.message-group');
            if (!row) {
                dismiss();
                return;
            }
            scroller.classList.remove('scroll-dismissing');
            document
                .querySelectorAll('.touch-actions')
                .forEach((n) => n.classList.remove('touch-actions'));
            row.classList.add('touch-actions');
            scrollStart = scroller.scrollTop;
            idleTimer = setTimeout(dismiss, 5000);
        },
        { passive: true },
    );
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closePopup();
            dismiss();
        }
    });
    scroller.addEventListener('scroll', () => {
        closePopup();
        if (Math.abs(scroller.scrollTop - scrollStart) > 50) dismiss();
    });
    document.addEventListener('chat-clear', () => {
        closePopup();
        clearTimeout(idleTimer);
        editing?.cancel();
    });
    return {
        attach,
        isEditing: (id) => editing?.id === id,
        acceptPending(message) {
            if (!message.operationId || editing?.id !== message.operationId) return null;
            editing.update(message);
            return editing.row;
        },
        reset() {
            closePopup();
            clearTimeout(idleTimer);
            editing?.cancel();
        },
    };
}
export function applyMutations(messages, operations, username) {
    const result = structuredClone(messages);
    for (const op of operations.filter((o) => o.kind && o.status !== 'failed')) {
        const index = result.findIndex(
            (m) => m.id === op.messageId || m.operationId === op.messageId,
        );
        if (index < 0) continue;
        const m = result[index];
        if (op.kind === 'delete') result.splice(index, 1);
        if (op.kind === 'edit') {
            m.content = op.content;
            m.isEdited = true;
        }
        if (op.kind === 'reaction') {
            let r = m.reactions.find((r) => r.emoji === op.emoji);
            if (!r) {
                r = { emoji: op.emoji, users: [] };
                m.reactions.push(r);
            }
            r.users = r.users.filter((u) => u !== username);
            if (op.active) r.users.push(username);
            m.reactions = m.reactions.filter((r) => r.users.length);
        }
    }
    return result;
}
