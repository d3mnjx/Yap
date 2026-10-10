const el = (tag, cls) => {
    const n = document.createElement(tag);
    n.className = cls;
    return n;
};
const mobile = matchMedia('(max-width:600px)');
const composer = document.querySelector('.message-input-container');
let factories,
    views = {},
    panel,
    combined,
    active = 'emoji',
    opened = null,
    popup,
    popupRefresh;
const backdrop = el('div', 'emoji-picker-backdrop');
backdrop.hidden = true;
// Chat isolates its stacking context for theme layers; a body-level backdrop would cover its picker.
document.querySelector('.chat-container').append(backdrop);
backdrop.onclick = () => closePickers();
function view(kind) {
    return (views[kind] ??= factories[kind]());
}
export function configurePickers(value) {
    factories = value;
}
export function closePickers() {
    opened = null;
    delete composer.dataset.picker;
    if (panel) panel.hidden = true;
    popup?.remove();
    popup = null;
    popupRefresh = null;
    backdrop.hidden = true;
}
function layout() {
    if (panel) return;
    panel = el('div', 'emoji-picker-container');
    document.querySelector('.emoji-toggle-wrapper').append(panel);
    if (mobile.matches) {
        combined = el('div', 'combined-picker');
        combined.dataset.activeTab = active;
        const tabs = el('div', 'combined-tabs'),
            body = el('div', 'combined-body');
        combined.append(tabs, body);
        for (const [kind, label] of [
            ['gif', 'GIFs'],
            ['emoji', 'Emoji'],
        ]) {
            const key = kind === 'gif' ? 'gifs' : kind,
                b = el('button', 'combined-tab');
            b.textContent = label;
            b.dataset.combinedTab = key;
            b.onclick = () => {
                active = key;
                combined.dataset.activeTab = key;
                view(kind).shown?.();
            };
            tabs.append(b);
            const pane = el('div', 'combined-pane');
            pane.dataset.combinedPane = key;
            pane.append(view(kind).node);
            body.append(pane);
        }
        panel.append(combined);
    } else
        for (const kind of ['emoji', 'gif']) {
            const pane = el('div', '');
            pane.dataset.clientPane = kind;
            pane.append(view(kind).node);
            panel.append(pane);
        }
}
export function togglePicker(kind) {
    const next = mobile.matches ? 'emoji' : kind;
    if (opened === next) {
        closePickers();
        return;
    }
    closePickers();
    opened = next;
    layout();
    for (const pane of panel.querySelectorAll('[data-client-pane]'))
        pane.hidden = pane.dataset.clientPane !== next;
    panel.hidden = false;
    backdrop.hidden = false;
    composer.dataset.picker = next;
    // Reopen resets searches/recents. Switching the already mounted mobile panes must not.
    for (const key of mobile.matches ? ['emoji', 'gif'] : [next]) view(key).opened?.();
    view(mobile.matches ? (active === 'gifs' ? 'gif' : 'emoji') : next).shown?.();
}
export function showReactionPicker(anchor, node, refresh) {
    closePickers();
    popupRefresh = refresh;
    popup = el('div', 'emoji-picker-wrapper client-reaction-picker');
    popup.append(node);
    document.body.append(popup);
    backdrop.hidden = false;
    if (!mobile.matches) {
        const box = anchor.getBoundingClientRect(),
            bounds = popup.getBoundingClientRect();
        const bottom = Math.min(
            innerHeight,
            anchor.closest('.messages')?.getBoundingClientRect().bottom ?? innerHeight,
        );
        const top =
            box.bottom + 4 + bounds.height <= bottom ? box.bottom + 4 : box.top - bounds.height - 4;
        popup.style.top = Math.max(4, top) + 'px';
        popup.style.left =
            Math.max(4, Math.min(box.right - bounds.width, innerWidth - bounds.width - 4)) + 'px';
    }
}
document.querySelector('#draft').addEventListener('focus', closePickers);
document.querySelector('#send').addEventListener('click', closePickers);
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closePickers();
});
mobile.addEventListener('change', () => {
    closePickers();
    panel?.remove();
    panel = null;
});
document.addEventListener('chat-clear', () => {
    closePickers();
    panel?.remove();
    panel = null;
    views = {};
    active = 'emoji';
});

document.addEventListener('chat-content', () => {
    views.emoji?.refresh?.();
    popupRefresh?.();
});
