// One stack of open layers: menus, the reaction picker, the pins panel, sheets, dialogs, the gallery. Escape closes
// the top layer only (GEN-17). A tap outside a layer closes it. The 600 px tier decides sheet or popup (GEN-18,
// GEN-14). The emoji and GIF pickers of the input box are not on the stack: composer.js closes them by the rules of
// IB-42 and IB-43, and its Escape waits for the stack (IB-17).

const stack = [];

export const phone = matchMedia('(max-width: 600px)');
const touch = matchMedia('(hover: none)');
export const isPhone = () => phone.matches;
export const isTouch = () => touch.matches;

// open({ element, onClose, outsideCloses = true, keep = [] }) returns the function that closes the layer.
// `keep` lists elements whose taps do not count as outside (the button that opened the layer).
export function open(layer) {
  const entry = { outsideCloses: true, keep: [], ...layer, closed: false };
  entry.close = () => {
    if (entry.closed) return;
    entry.closed = true;
    const i = stack.indexOf(entry);
    if (i >= 0) stack.splice(i, 1);
    entry.onClose?.();
  };
  stack.push(entry);
  return entry.close;
}

function top() { return stack.at(-1) ?? null; }
function closeTop() { top()?.close(); }
export function closeAll() { while (stack.length) stack.at(-1).close(); }
export function anyOpen() { return stack.length > 0; }

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && stack.length) { e.preventDefault(); closeTop(); }
});

// pointerdown, not click: a tap outside must close the layer and never press what is under it (MR-55).
document.addEventListener('pointerdown', e => {
  const layer = top();
  if (!layer || !layer.outsideCloses) return;
  const inside = layer.element.contains(e.target) || layer.keep.some(k => k?.contains(e.target));
  if (!inside) { layer.close(); if (layer.swallowOutsideTap) { e.preventDefault(); e.stopPropagation(); } }
}, true);

// Places a popup below its anchor, or above when there is no space below, and inside the window (MR-42, MR-54).
// On a phone the CSS makes the popup a bottom sheet, and this does nothing.
export function place(popup, anchor, options) {
  if (isPhone()) return;   // a sheet there, by CSS
  popup.style.position = 'fixed';
  popup.style.visibility = 'hidden';
  positionUnder(popup, anchor, options);
  popup.style.visibility = 'visible';
}

// The fixed coordinates of a box at an anchor: under it when it fits, else above; 8 px inside the window. align:
// 'right' (the right edges meet), 'left', or 'center'. The box is measured at the origin first. The admin tooltip
// (tooltip.js) uses this on a phone too, so the phone rule stays in place().
export function positionUnder(box, anchor, { align = 'right', gap = 6 } = {}) {
  const a = anchor.getBoundingClientRect();
  box.style.top = '0px'; box.style.left = '0px';
  const w = box.offsetWidth, h = box.offsetHeight;
  const below = a.bottom + gap + h <= innerHeight;
  const left = align === 'right' ? a.right - w : align === 'center' ? a.left + a.width / 2 - w / 2 : a.left;
  box.style.top = `${below ? a.bottom + gap : Math.max(8, a.top - gap - h)}px`;
  box.style.left = `${Math.min(Math.max(8, left), innerWidth - w - 8)}px`;
}

// A short text at an element for two seconds: the reason of a refusal (GEN-02, MR-75).
export function reason(host, text, ms = 2000) {
  host.querySelector('.row-reason')?.remove();
  const node = document.createElement('span');
  node.className = 'row-reason';
  node.textContent = text;
  host.append(node);
  setTimeout(() => node.remove(), ms);
}
