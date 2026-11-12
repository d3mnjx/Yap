// The role badge after a name: a shield for an admin, a robot for the bot (SH-31, SH-35, MR-04, AD-04). The people
// row and the message header carry the same markup in their templates (t-user-row and t-message in index.html).
// This builds it for a node that JavaScript draws: the profile card and the Users table of the Admin page.
// The colours are in css/frame.css ("Role badges").

import { el, icon } from './dom.js';

const ROLES = {
  admin: { label: 'Admin', drawing: 'shield' },
  bot: { label: 'Bot', drawing: 'robot' },
};

// role="img" with a label: a <span title> alone has no name for a screen reader, and the icon has no text.
export function roleBadge(role, size = 16) {
  const { label, drawing } = ROLES[role];
  return el('span', { class: `${role}-badge`, role: 'img', 'aria-label': label, title: label }, icon(drawing, { width: size, height: size }));
}
