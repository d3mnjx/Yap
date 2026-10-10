let dismiss = () => {};
export function warn(title, message) {
    dismiss();
    const previous = document.activeElement,
        backdrop = document.createElement('div'),
        dialog = document.createElement('div');
    backdrop.className = 'warning-modal-backdrop';
    dialog.className = 'warning-modal';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', title);
    const heading = document.createElement('h3'),
        body = document.createElement('p');
    heading.className = 'warning-modal-title';
    heading.textContent = title;
    body.className = 'warning-modal-message';
    body.style.whiteSpace = 'pre-line';
    body.textContent = message;
    const close = document.createElement('button'),
        okay = document.createElement('button');
    close.className = 'warning-modal-close';
    close.textContent = '✕';
    close.setAttribute('aria-label', 'Close warning');
    okay.className = 'warning-modal-button';
    okay.textContent = 'Got It';
    dismiss = () => {
        backdrop.remove();
        previous?.focus();
        dismiss = () => {};
    };
    close.onclick = okay.onclick = () => dismiss();
    backdrop.onclick = (e) => {
        if (e.target === backdrop) dismiss();
    };
    dialog.append(close, heading, body, okay);
    backdrop.append(dialog);
    document.body.append(backdrop);
    okay.focus();
}
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') dismiss();
});
document.addEventListener('chat-clear', () => dismiss());
