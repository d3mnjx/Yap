import * as storage from './storage.js';
import { configurePickers, togglePicker, closePickers } from './pickers.js';
import { createEmojiPicker, uploadLimit } from './content.js';
import { createGifPicker } from './gifs.js';
import { warn } from './warnings.js';
const $ = (selector) => document.querySelector(selector);
const draft = document.querySelector('#draft');
export const isTouchDevice = () => 'ontouchstart' in window || navigator.maxTouchPoints > 0;
export function resizeDraft() {
    draft.style.height = 'auto';
    draft.style.height = Math.min(draft.scrollHeight, 200) + 'px';
}
const icon = document.querySelector('.emoji-toggle-icon');
function randomIcon() {
    const index = Math.floor(Math.random() * 73);
    for (const kind of ['grey', 'color']) {
        icon.style.setProperty(`--${kind}-col`, index % 20);
        icon.style.setProperty(`--${kind}-row`, Math.floor(index / 20));
    }
}
randomIcon();
icon.parentElement.addEventListener('mouseenter', randomIcon);

let caret = null;
draft.addEventListener('blur', () => {
    caret = { start: draft.selectionStart, end: draft.selectionEnd };
});
export function insertEmoji(value) {
    const start = Math.min(caret?.start ?? draft.value.length, draft.value.length),
        end = Math.min(caret?.end ?? start, draft.value.length);
    draft.setRangeText(value, start, end, 'end');
    caret = { start: draft.selectionStart, end: draft.selectionEnd };
    // Keep the picker open and the keyboard down; the next textarea gesture restores focus.
    draft.dispatchEvent(new Event('input', { bubbles: true }));
}

// Owns draft writes, reply selection, restoration and submission. Account, snapshot
// and route remain in app.js; getters read them at the start of each user action.
export function createComposer({ identity, snapshot, selected, current, live, onQueued, notice }) {
    let draftWrite = Promise.resolve();
    let replyingTo = null;
    let submitting = false;
    let loadingDraftFor = null;
    function renderReply() {
        const bar = $('#reply-bar');
        bar.hidden = !replyingTo;
        $('.message-input-container').classList.toggle('has-reply-bar', !!replyingTo);
        $('#reply-name').textContent = replyingTo?.author.displayName || '';
        document
            .querySelectorAll('.reply-target')
            .forEach((n) => n.classList.remove('reply-target'));
        if (replyingTo)
            document.getElementById('msg-' + replyingTo.id)?.classList.add('reply-target');
    }
    $('#cancel-reply').onclick = async () => {
        replyingTo = null;
        await storage.saveReply(selected(), null, identity());
        renderReply();
    };
    function updateComposer() {
        const c = snapshot()?.conversations.find((c) => c.id === selected());
        const allowed = !!(
            identity() &&
            c?.canWrite &&
            snapshot().canSend &&
            loadingDraftFor !== selected()
        );
        $('#send').disabled = !allowed || submitting || !$('#draft').value.trim();
        $('#draft').disabled = !c || !c.canWrite || loadingDraftFor === selected();
        $('#draft').maxLength = snapshot()?.maxTextLength || 4000;
        $('.message-input-container').hidden = !!c && !c.canWrite;
        if (c && !c.canWrite) $('#reply-bar').hidden = true;
        for (const button of ['#upload-button', '#gif-button', '#emoji-button'])
            $(button).disabled = !allowed;
        $('#permission-note').hidden = !!c?.canWrite;
        if (!c?.canWrite)
            $('#permission-note').textContent = c
                ? 'You do not have permission to send messages in this channel.'
                : 'Connect to open this conversation.';
    }
    $('#draft').oninput = () => {
        const id = selected(),
            value = $('#draft').value,
            owner = identity();
        resizeDraft();
        updateComposer();
        live.input(value);
        draftWrite = draftWrite
            .catch(() => {})
            .then(() => storage.saveDraft(id, value, owner))
            .catch((error) => {
                notice(`Draft could not be saved: ${error.message}`);
            });
    };
    function finishReply(account, channel, reply) {
        // Enqueue may complete after navigation or a new reply selection. The storage
        // transaction owns draft cleanup; only its original view may clear the reply bar.
        if (identity()?.epoch !== account.epoch || selected() !== channel || replyingTo !== reply)
            return;
        replyingTo = null;
        renderReply();
        live.stopTyping();
    }
    async function send() {
        if ($('#send').disabled || !identity()) return;
        const content = $('#draft').value,
            channel = selected(),
            account = identity(),
            reply = replyingTo;
        submitting = true;
        updateComposer();
        try {
            await draftWrite;
            await storage.enqueue(
                channel,
                content,
                account,
                { replyToMessageId: reply?.id },
                reply,
            );
            if (identity()?.epoch !== account.epoch) return;
            finishReply(account, channel, reply);
            if (selected() === channel && $('#draft').value === content) {
                $('#draft').value = '';
                $('#draft').style.height = 'auto';
            }
            await onQueued(channel);
        } catch (error) {
            notice(`Message could not be queued: ${error.message}`);
        } finally {
            submitting = false;
            updateComposer();
            if (identity()?.epoch === account.epoch && selected() === channel) $('#draft').focus();
        }
    }
    async function sendExtra(extra) {
        if (!identity() || !current()?.canWrite) return;
        const channel = selected(),
            account = identity(),
            reply = replyingTo;
        await storage.enqueue(
            channel,
            '',
            account,
            { ...extra, replyToMessageId: reply?.id },
            reply,
        );
        if (identity()?.epoch !== account.epoch) return;
        finishReply(account, channel, reply);
        await onQueued(channel);
    }
    configurePickers({
        emoji: () => createEmojiPicker({ identity, choose: insertEmoji, notice }),
        gif: () =>
            createGifPicker(
                () => identity(),
                (extra) => sendExtra(extra),
                notice,
                () => {
                    const input = $('#upload-files');
                    input.dataset.gif = 'true';
                    input.accept = '.gif,.webm,.mp4,.mov,.webp';
                    input.multiple = false;
                    input.click();
                },
            ),
    });
    $('#emoji-button').onclick = () => togglePicker('emoji');
    $('#gif-button').onclick = () => togglePicker('gif');
    async function queueFiles(files, gifUpload = false) {
        const accepted = [],
            errors = [];
        for (const file of files) {
            if (
                file.size >
                Math.min(
                    snapshot()?.maxUploadBytes ?? uploadLimit(),
                    gifUpload ? 50 * 1024 * 1024 : Infinity,
                )
            )
                errors.push(`${file.name} exceeds the upload size limit.`);
            else if (
                !(
                    snapshot()?.allowedExtensions ?? [
                        '.png',
                        '.jpg',
                        '.jpeg',
                        '.gif',
                        '.webp',
                        '.mp4',
                        '.webm',
                        '.mov',
                        '.mkv',
                    ]
                ).includes('.' + file.name.split('.').pop().toLowerCase())
            )
                errors.push(`${file.name} is not a supported image or video.`);
            else if (accepted.length >= (snapshot()?.maxFilesPerMessage ?? 20))
                errors.push(
                    `${file.name}: select no more than ${snapshot()?.maxFilesPerMessage ?? 20} files at once.`,
                );
            else accepted.push(file);
        }
        if (accepted.length) {
            await sendExtra({ files: accepted, gifUpload });
            if (!gifUpload || !navigator.onLine) closePickers();
        }
        if (errors.length)
            warn(
                accepted.length ? 'Some files could not be uploaded' : 'Could not upload files',
                errors.join('\n'),
            );
    }
    $('#upload-button').onclick = () => {
        const input = $('#upload-files');
        input.dataset.gif = '';
        input.accept = snapshot()?.allowedExtensions?.join(',') || 'image/*,video/*';
        input.multiple = true;
        input.click();
    };
    $('#upload-files').onchange = (event) => {
        queueFiles(event.target.files, event.target.dataset.gif === 'true').catch((error) =>
            warn('Could not upload files', error.message),
        );
        event.target.value = '';
    };
    const dropZone = $('.message-input-container');
    let dragDepth = 0;
    const resetDrag = () => {
        dragDepth = 0;
        delete dropZone.dataset.dragging;
    };
    const fileDrag = (event) => event.dataTransfer?.types.includes('Files');
    dropZone.addEventListener('dragenter', (event) => {
        if (fileDrag(event) && !$('#draft').disabled) {
            dragDepth++;
            dropZone.dataset.dragging = '';
        }
    });
    dropZone.addEventListener('dragleave', () => {
        dragDepth = Math.max(0, dragDepth - 1);
        if (!dragDepth) resetDrag();
    });
    $('.messages-container').addEventListener('dragover', (event) => {
        if (fileDrag(event) && !$('#draft').disabled) event.preventDefault();
    });
    $('.messages-container').addEventListener('drop', (event) => {
        resetDrag();
        if (!fileDrag(event) || $('#draft').disabled) return;
        event.preventDefault();
        queueFiles(
            [...event.dataTransfer.files].filter((file) => /^(image|video)\//.test(file.type)),
        ).catch((error) => warn('Could not upload files', error.message));
    });
    document.addEventListener('dragend', resetDrag);
    document.addEventListener('drop', resetDrag);
    $('#draft').addEventListener('paste', (event) => {
        const files = [...event.clipboardData.items]
            .filter((i) => i.kind === 'file')
            .map((i) => i.getAsFile());
        if (files.length) {
            event.preventDefault();
            queueFiles(files).catch((error) => warn('Could not upload files', error.message));
        }
    });
    $('#send').onclick = send;
    // Keep mobile keyboard focus inside the user gesture, before IndexedDB work yields.
    $('#send').addEventListener('pointerdown', (event) => {
        event.preventDefault();
        $('#draft').focus();
    });
    $('#draft').addEventListener('keydown', (event) => {
        if (
            event.key === 'Enter' &&
            !event.shiftKey &&
            !event.isComposing &&
            event.keyCode !== 229 &&
            !isTouchDevice()
        ) {
            event.preventDefault();
            send();
        }
    });
    async function reply(message) {
        replyingTo = { ...message, draftId: crypto.randomUUID() };
        renderReply();
        $('#draft').focus();
        await storage.saveReply(selected(), replyingTo, identity());
    }
    function beginNavigation(channelId) {
        closePickers();
        loadingDraftFor = channelId;
        // Disable before the coordinator awaits its outbox read: fast input must not
        // be overwritten by a delayed draft restoration from the destination room.
        $('#draft').disabled = true;
        $('#draft').value = '';
    }
    async function restore(channelId, conversation, isCurrentRender) {
        loadingDraftFor = channelId;
        $('#draft').disabled = true;
        $('#draft').value = '';
        await draftWrite;
        const value = channelId ? await storage.draft(channelId) : undefined;
        const savedReply = channelId ? await storage.replyDraft(channelId) : null;
        // The coordinator owns render generations; an overlapping render keeps the
        // navigation latch until the latest restoration finishes.
        if (!isCurrentRender()) return;
        $('#draft').value = value ?? '';
        resizeDraft();
        replyingTo = savedReply;
        loadingDraftFor = null;
        $('#draft').disabled = !conversation;
    }

    return {
        reply,
        settleDraft: () => draftWrite,
        update: updateComposer,
        renderReply,
        beginNavigation,
        restore,
        isRestoring: (channelId) => loadingDraftFor === channelId,
        clear() {
            $('#draft').value = '';
            $('#draft').disabled = true;
            replyingTo = null;
            renderReply();
        },
    };
}
