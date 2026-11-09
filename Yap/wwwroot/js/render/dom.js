// DOM construction without HTML strings. Every value from the server lands in the DOM through textContent
// or an attribute, never through innerHTML (principle 6 of docs/architecture/sketch.md, MR-10).

// el('div', { class: 'row', hidden: true, onclick: fn }, 'text', node, ...)
// Attribute rules: a function value becomes a listener ('onclick'), a boolean value toggles a boolean
// attribute, null and undefined are skipped, 'dataset' and 'style' objects spread.
export function el(tag, attrs = null, ...children) {
  const node = document.createElement(tag);
  if (attrs) for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (name.startsWith('on') && typeof value === 'function') node.addEventListener(name.slice(2), value);
    else if (name === 'dataset') Object.assign(node.dataset, value);
    else if (name === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (value === true) node.setAttribute(name, '');
    else node.setAttribute(name, value);
  }
  append(node, children);
  return node;
}

export function append(parent, children) {
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : String(child));
  }
  return parent;
}

const templates = new Map();   // id -> <template>, looked up once

// clone('t-room-row') returns the first element inside <template id="t-room-row"> in index.html.
export function clone(id) {
  let template = templates.get(id);
  if (!template) {
    template = document.getElementById(id);
    if (!template) throw new Error(`missing template ${id}`);
    // The icons of the template get their drawings here, once, in the template itself: every clone after this
    // is plain inline SVG, so a row costs what it cost when each template carried its own copy of the paths.
    for (const svg of template.content.querySelectorAll('svg[data-icon]')) draw(svg, svg.getAttribute('data-icon'));
    templates.set(id, template);
  }
  return template.content.firstElementChild.cloneNode(true);
}

// ---- the icons ----
// Every drawing exists once, as <symbol id="i-name"> in <template id="t-icons"> (index.html has the reason why a
// use is a copy and not a <use> reference). A use is <svg data-icon="name"> in a template, or icon('name') here.

const SVG = 'http://www.w3.org/2000/svg';
let symbols = null;   // the content of t-icons, looked up at the first icon

// The symbol's attributes (the viewBox and the paint) and a copy of its drawing go into the <svg>. An attribute
// that the use sets itself stays: the theme card draws the check with a heavier stroke than the symbol's.
function draw(svg, name) {
  symbols ??= document.getElementById('t-icons').content;
  const symbol = symbols.getElementById(`i-${name}`);
  if (!symbol) throw new Error(`missing icon ${name}`);
  for (const { name: attr, value } of symbol.attributes) if (attr !== 'id' && !svg.hasAttribute(attr)) svg.setAttribute(attr, value);
  svg.append(...symbol.cloneNode(true).childNodes);
  return svg;
}

// icon('trash', { width: 18, height: 18 }) returns the <svg> of that drawing, for a node that JavaScript builds.
export function icon(name, attrs = {}) {
  const svg = document.createElementNS(SVG, 'svg');
  for (const [attr, value] of Object.entries(attrs)) svg.setAttribute(attr, value);
  return draw(svg, name);
}

// Replaces the children of a node with a list. The one function every component uses to redraw.
export function replace(parent, children) {
  parent.replaceChildren();
  return append(parent, children);
}

// Class toggles from an object: classes(node, { open: true, muted: false })
export function classes(node, map) {
  for (const [name, on] of Object.entries(map)) node.classList.toggle(name, !!on);
  return node;
}
