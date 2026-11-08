// The link page (AU-10, AU-16, AU-17): an invite asks for a username; a login link asks for one tap, so a
// link that a messenger fetches never signs anyone in. Signed in as someone else, it offers a switch.

import { state, projectName } from '../store.js';
import { api, ApiError } from '../api.js';
import { clone } from '../render/dom.js';
import * as session from '../session.js';
import * as router from '../router.js';
import { usernameRule } from './login.js';

export function mount(root, { code }) {
  const page = clone('t-invite');
  const heading = page.querySelector('.invite-heading');
  const text = page.querySelector('.invite-text');
  const formRow = page.querySelector('.invite-form-row');
  const input = page.querySelector('.invite-input');
  const join = page.querySelector('.invite-button.join');
  const primary = page.querySelector('.invite-button.primary');
  const secondary = page.querySelector('.invite-secondary');
  const error = page.querySelector('.validation-error');
  page.querySelector('.build-info').textContent = document.documentElement.dataset.build ?? '';
  const project = projectName();
  // Only with a config: a load with no bootstrap answer (offline, signed out) must not write the "Yap" fallback over
  // the project name the server stamped into the shell's <title> (SH-45).
  if (state.config?.projectName) document.title = project;
  let live = true;

  function link(label, href) { secondary.textContent = label; secondary.href = href; secondary.hidden = false; secondary.onclick = e => { e.preventDefault(); router.navigate(href); }; }
  function fail(message) { error.textContent = message; error.hidden = false; }

  (async () => {
    let view;
    try { view = await api.get(`/api/invite/${encodeURIComponent(code)}`); }
    catch (e) { heading.textContent = 'One moment'; text.textContent = e instanceof ApiError && e.status === 0 ? 'Needs a connection' : e.message; return; }
    if (!live) return;
    switch (view.state) {
      case 'busy':
        heading.textContent = 'One moment';
        text.textContent = 'Too many sign-in attempts right now. Try this link again in a few minutes.';
        break;
      case 'invalid':
        heading.textContent = 'This link no longer works';
        text.textContent = 'It may have expired or been revoked. Ask the person who sent it for a new one.';
        if (state.user) link('Back to chat', '/lobby'); else link('Go to the login page', '/login');
        break;
      case 'self':
        router.navigate('/lobby', { replace: true });
        break;
      case 'join':
        heading.textContent = `You're invited to ${project}`;
        text.textContent = 'Pick a username to join.';
        formRow.hidden = false;
        input.focus();
        break;
      case 'continue':
        heading.textContent = `Welcome back, ${view.owner}`;
        text.replaceChildren('This link signs you in as ', Object.assign(document.createElement('strong'), { textContent: view.owner }), ' on this device.');
        primary.textContent = `Continue as ${view.owner}`; primary.hidden = false;
        primary.addEventListener('click', () => redeem(null, 'Signing in…'));
        break;
      case 'switch':
        heading.textContent = 'Switch account?';
        text.replaceChildren('You are signed in as ', Object.assign(document.createElement('strong'), { textContent: view.current }), '. This link belongs to ', Object.assign(document.createElement('strong'), { textContent: view.owner }), '.');
        primary.textContent = `Switch to ${view.owner}`; primary.hidden = false;
        primary.addEventListener('click', () => redeem(null, 'Switching…', true));
        link(`Stay as ${view.current}`, '/lobby');
        break;
    }
  })();

  input.addEventListener('input', () => {
    const normalised = input.value.toLowerCase().trim();
    if (normalised !== input.value) input.value = normalised;
    const rule = usernameRule(input.value, { blurred: false });
    error.hidden = true; input.classList.toggle('invalid', !!rule);
    if (rule) fail(rule);
    join.disabled = !!rule || input.value.length < 2;
  });
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !join.disabled) { e.preventDefault(); redeem(input.value, 'Joining…'); } });
  join.addEventListener('click', () => redeem(input.value, 'Joining…'));

  // AU-25: a different account on this device starts with no data of the previous one.
  async function redeem(username, busyText, switching = false) {
    const button = username === null ? primary : join;
    const label = button.textContent;
    button.disabled = true; button.textContent = busyText;
    try {
      if (switching) await session.forgetAccount();
      const res = await fetch(`/api/invite/${encodeURIComponent(code)}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username }) });
      if (res.ok) { await session.signedIn(); return; }
      const problem = await res.json().catch(() => null);
      fail(problem?.detail ?? 'Something went wrong');
    } catch { fail('Needs a connection'); }
    finally { button.textContent = label; button.disabled = false; }
  }

  root.replaceChildren(page);
  return () => { live = false; page.remove(); };
}
