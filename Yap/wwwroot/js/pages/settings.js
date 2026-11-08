// Settings (settings.md): every control saves at once (ST-02); the `me` hub message brings a change made on
// another device back into the page. Inside the frame (ST-03).

import { state, on, mergeMe, serverMuted, displayName } from '../store.js';
import { build, reloadForNewBuild } from '../update.js';
import { api } from '../api.js';
import { clone, el, replace } from '../render/dom.js';
import { inline } from '../render/text.js';
import { avatar } from '../render/avatar.js';
import { ago, timeOf, usePreferences } from '../render/time.js';
import * as hub from '../hub.js';
import * as frame from '../ui/frame.js';
import * as push from '../push.js';
import { openInstallDialog } from '../pwa.js';
import { GifLibrary } from '../ui/gif-library.js';
import { setTitle } from '../notify.js';
import { deviceId } from '../hub.js';
import { confirm } from '../ui/confirm.js';
import { mountDebugInfo } from './settings-debug.js';

const FONT_SIZES = [14, 15, 16, 17, 18, 20];   // ST-10
const BELL = '<svg class="seg-icon" width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.63-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2zm-2 1H8v-6c0-2.48 1.51-4.5 4-4.5s4 2.02 4 4.5v6z"/></svg>';
const BELL_OFF = '<svg class="seg-icon" width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm0-15.5c2.49 0 4 2.02 4 4.5v5h2v1H6v-1h2v-5c0-3.07 1.63-5.64 4.5-6.32V4c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5v.68c-.17.04-.33.09-.5.14zM5.41 3.35L4 4.76l2.81 2.81C6.29 8.57 6 9.74 6 11v5l-2 2v1h14.24l1.35 1.35 1.41-1.41L5.41 3.35z"/></svg>';
// The state of this device gets a mark next to its word: a green check when the device gets notifications, a red
// crossed bell when it does not (Off, Blocked, Not possible here, Not set up on this server). The crossed bell is
// the app's sign for "no notifications" (the muted bells, the red notice); a cross would read as delete or close.
const CHECK_CIRCLE = '<svg class="status-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>';
const SLIDERS = '<svg class="seg-icon" width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z"/></svg>';
const EYE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
const COPY = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHECK = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';

// Fixed icons of this page: the strings above are ours, not the server's, so a template is safe here.
const icon = svg => { const t = document.createElement('template'); t.innerHTML = svg; return t.content.firstElementChild; };

export function mount(root, route) {
  const page = clone('t-settings');
  const me = state.user;
  const aborter = new AbortController();
  const offs = [];
  const timers = [];
  frame.setTitle('page', { text: 'Settings' });
  setTitle('Settings');

  const $ = sel => page.querySelector(sel);
  const status = $('.save-status');
  let statusTimer = 0;
  function saved(node = status, text = 'Saved', cls = 'saved') {
    node.hidden = false; node.textContent = text;
    node.classList.remove('saved', 'saving', 'error'); node.classList.add(cls);   // the other classes of the node stay
    clearTimeout(node._timer); node._timer = setTimeout(() => { node.hidden = true; }, node === status ? 2000 : 3000);   // the chip 2 s, a card's line 3 s (ST-02, ST-14)
  }
  function saving() { status.hidden = false; status.textContent = 'Saving...'; status.classList.remove('saved', 'error'); status.classList.add('saving'); }
  async function patch(body) {
    saving();
    try { await api.patch('/api/account', body); saved(); $('.save-error').hidden = true; return true; }
    catch (e) { saved(status, 'Could not save. Try again.', 'error'); $('.save-error').hidden = false; return false; }   // next to the control too (ST-02)
  }

  // ---- Profile (ST-04 to ST-07) ----
  const avatarHost = $('.profile-avatar');
  const drawAvatar = () => replace(avatarHost, [avatar(me.username, state.user.avatarUrl, 'large')]);
  drawAvatar();
  const uploadLabel = $('.upload-label'), removePicture = $('.remove-picture'), pictureError = $('.picture-error');
  const drawPicture = () => { uploadLabel.textContent = state.user.avatarUrl ? 'Change Picture' : 'Upload Picture'; removePicture.hidden = !state.user.avatarUrl; drawAvatar(); };
  drawPicture();
  $('#profile-upload').addEventListener('change', async e => {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return;
    pictureError.hidden = true;
    if (!file.type.startsWith('image/') || file.size > 10 * 1024 * 1024) { pictureError.textContent = 'Choose an image up to 10 MB'; pictureError.hidden = false; return; }   // ST-04
    uploadLabel.textContent = 'Uploading...';
    const form = new FormData(); form.append('file', file);
    saving();
    try { await api.put('/api/account/avatar', form); saved(); }
    catch (err) { pictureError.textContent = err.message; pictureError.hidden = false; saved(status, 'Could not save. Try again.', 'error'); }
    drawPicture();
  });
  removePicture.addEventListener('click', async () => { saving(); try { await api.delete('/api/account/avatar'); saved(); } catch { saved(status, 'Could not save. Try again.', 'error'); } });

  const name = $('#display-name'), bio = $('#bio'), country = $('#country'), bioCounter = $('.bio-counter');
  name.placeholder = me.username;
  $('.name-hint').textContent = `Your username is ${me.username}, but your display name can be more fun. It can contain symbols and emojis :) `;
  name.value = me.displayName ?? ''; bio.value = me.bio ?? ''; country.value = me.location ?? '';
  const drawCounter = () => { bioCounter.textContent = `${bio.value.length}/150`; };
  drawCounter();
  let profileTimer = 0, profileDirty = false;
  const profileBody = () => ({ displayName: name.value, bio: bio.value, location: country.value });
  const flushProfile = async () => { if (!profileDirty) return; profileDirty = false; await patch(profileBody()); };
  for (const input of [name, bio, country]) input.addEventListener('input', () => { profileDirty = true; drawCounter(); saving(); clearTimeout(profileTimer); profileTimer = setTimeout(flushProfile, 800); });   // ST-02
  const detect = $('.detect-location');
  api.get('/api/account/location').then(found => { if (found?.location) { detect.hidden = false; detect.addEventListener('click', () => { country.value = found.location; profileDirty = true; flushProfile(); }); } }).catch(() => {});   // ST-06

  // ---- Appearance and Text Size (ST-08, ST-10) ----
  const grid = $('.theme-grid');
  const drawThemes = () => replace(grid, (state.config?.themes ?? []).map(t => {
    const card = clone('t-theme-card');
    card.title = t.name;
    card.querySelector('.theme-card-preview').style.background = t.previewBg;
    card.querySelector('.theme-card-accent-dot').style.background = t.previewAccent;
    card.querySelector('.theme-card-name').textContent = t.name;
    const on = (state.user.theme || 'discord-dark') === t.id;
    card.classList.toggle('selected', on); card.querySelector('.theme-card-check').hidden = !on;
    card.addEventListener('click', () => { mergeMe({ theme: t.id }); patch({ theme: t.id }); });   // applies at once (GEN-01)
    return card;
  }));
  const row = $('.font-size-row');
  const drawSizes = () => replace(row, FONT_SIZES.map(px => {
    const option = clone('t-font-size-option');
    option.title = `${px}px`;
    option.querySelector('.font-size-sample').style.fontSize = `${px}px`;
    option.querySelector('.font-size-value').textContent = px === 16 ? 'Default' : `${px}px`;
    option.classList.toggle('selected', (state.user.fontSize ?? 16) === px);
    option.addEventListener('click', () => { mergeMe({ fontSize: px === 16 ? null : px }); patch({ fontSize: px }); });
    return option;
  }));
  drawThemes(); drawSizes();

  // ---- Login Link (ST-11 to ST-13) and Secret Code (ST-14) ----
  const link = { value: null, shown: false };
  const code = { value: null, shown: false };
  function masked(node, text, shown, mask) { node.textContent = shown ? text : mask; }
  function wireReveal(button, store, draw) { button.replaceChildren(icon(store.shown ? EYE_OFF : EYE)); button.title = store.shown ? 'Hide' : 'Reveal'; button.onclick = () => { store.shown = !store.shown; draw(); }; }
  function wireCopy(button, text) {
    button.replaceChildren(icon(COPY)); button.title = 'Copy';
    button.onclick = async () => { try { await navigator.clipboard.writeText(text); } catch { /* no clipboard */ } button.replaceChildren(icon(CHECK)); button.title = 'Copied!'; setTimeout(() => { button.replaceChildren(icon(COPY)); button.title = 'Copy'; }, 2000); };
  }
  function drawLink() {
    const has = !!link.value;
    $('.link-present').hidden = !has; $('.link-absent').hidden = has;
    const ways = [has ? 'your login link' : null, code.value ? 'your secret code' : null, state.config?.smartLoginAllowed && !state.user.smartLoginOptOut ? 'smart login from a network you used recently' : null].filter(Boolean);
    $('.link-summary').textContent = ways.length ? `You can log in from other devices with ${ways.join(', ')}.` : 'This account is tied to this device only.';   // ST-11
    if (has) {
      $('.link-username').textContent = me.username;
      masked($('.link-value'), link.value.url, link.shown, link.value.url.replace(/\/invite\/.*$/, '/invite/••••••••••••'));
      wireReveal($('.link-reveal'), link, drawLink); wireCopy($('.link-copy'), link.value.url);
      const select = $('.link-expiry');
      const current = [...select.options].find(o => o.value === 'current');
      if (link.value.expiresAt) { (current ?? select.insertBefore(el('option', { value: 'current' }), select.firstChild)).textContent = `Expires ${link.value.expiresAt.slice(0, 10)}`; select.value = 'current'; }
      else { current?.remove(); select.value = 'never'; }
    }
    $('.smart-login').hidden = !state.config?.smartLoginAllowed;
    $('.smart-login-toggle').checked = !state.user.smartLoginOptOut;
  }
  function drawCode() {
    const has = !!code.value;
    // Secret codes are retired (AU-13): the card shows only while the account still has one, and nothing can
    // create a new one. The login link does the job; its code is typed on the login page the same way (AU-12).
    $('[data-section="passphrase"]').hidden = !has;
    if (has) { $('.code-username').textContent = me.username; masked($('.code-value'), code.value, code.shown, '••••••••••'); wireReveal($('.code-reveal'), code, drawCode); wireCopy($('.code-copy'), code.value); }
    drawLink();
  }
  const linkStatus = $('.link-status'), codeStatus = $('.code-status');
  api.get('/api/account/link').then(l => { link.value = l; drawLink(); }).catch(() => {});
  api.get('/api/account/passphrase').then(p => { code.value = p?.passphrase ?? null; drawCode(); }).catch(() => {});
  // The sign-out warning reads hasLink and hasPassphrase from the store (SH-15). The bootstrap set them, so every
  // change here updates them too; otherwise a revoke followed by a sign-out in the same session would show no warning.
  $('.link-create').addEventListener('click', async () => { try { link.value = await api.post('/api/account/link'); link.shown = true; mergeMe({ hasLink: true }); drawLink(); saved(linkStatus, 'Login link created'); } catch (e) { saved(linkStatus, e.message, 'error'); } });
  $('.link-new').addEventListener('click', async () => { try { link.value = await api.post('/api/account/link'); link.shown = true; mergeMe({ hasLink: true }); drawLink(); saved(linkStatus, 'New link created. The old one no longer works.'); } catch (e) { saved(linkStatus, e.message, 'error'); } });
  $('.link-revoke').addEventListener('click', async () => { try { await api.delete('/api/account/link'); link.value = null; mergeMe({ hasLink: false }); drawLink(); saved(linkStatus, 'Login link revoked'); } catch (e) { saved(linkStatus, e.message, 'error'); } });
  $('.link-expiry').addEventListener('change', async e => {
    const v = e.target.value; if (v === 'current') return;
    const expiresAt = v === 'never' ? null : new Date(Date.now() + Number(v) * 86_400_000).toISOString();
    try { await api.put('/api/account/link/expiry', { expiresAt }); link.value = { ...link.value, expiresAt }; drawLink(); saved(linkStatus, expiresAt ? `Link expires ${expiresAt.slice(0, 10)}` : 'Link never expires'); }
    catch (err) { saved(linkStatus, err.message, 'error'); }
  });
  $('.smart-login-toggle').addEventListener('change', e => { mergeMe({ smartLoginOptOut: !e.target.checked }); patch({ smartLoginOptOut: !e.target.checked }); drawLink(); });
  $('.code-new').addEventListener('click', async () => { try { code.value = (await api.post('/api/account/passphrase')).passphrase; code.shown = true; drawCode(); saved(codeStatus, 'Secret code changed'); } catch (e) { saved(codeStatus, e.message, 'error'); } });
  // Disable is final, so it asks first. The status goes under Login Link, because this card is gone after it.
  $('.code-disable').addEventListener('click', async () => {
    if (!await confirm({ title: 'Disable your secret code?', text: 'It cannot be turned on again. Your login link does the same job.', action: 'Disable' })) return;
    try { await api.delete('/api/account/passphrase'); code.value = null; mergeMe({ hasPassphrase: false }); drawCode(); saved(linkStatus, 'Secret code disabled'); } catch (e) { saved(codeStatus, e.message, 'error'); }
  });

  // ---- Active Sessions (ST-15, AU-19, AU-20) ----
  const deviceList = $('.device-list');
  const signOutOthers = $('.sign-out-others'), sessionsStatus = $('.sessions-status');
  let allowedAt = 0;   // when this device may sign the others out (AU-20): its first hour is over, or it never was new
  async function drawDevices() {
    let devices = [];
    try {
      const answer = await api.get(`/api/account/devices?device=${encodeURIComponent(deviceId())}`);
      devices = answer.devices; allowedAt = new Date(answer.signOutOthersAllowedAt).getTime();
    } catch { /* keep what shows */ }
    replace(deviceList, devices.map(d => {
      const item = clone('t-session-item');
      item.classList.toggle('current', d.current);
      item.querySelector('.session-icon').textContent = d.isMobile ? '📱' : '🖥️';
      item.querySelector('.session-badge').hidden = !d.current;
      item.querySelector('.session-ip').textContent = d.ip ?? 'Unknown IP';
      item.querySelector('.session-activity').textContent = `Active ${ago(d.lastActiveAt)}`;
      return item;
    }));
    $('.no-sessions').hidden = devices.length > 0;
    $('.sign-out-others-row').hidden = false;   // always present (AU-20); disabled during this device's first hour
    drawSignOutOthers();
  }
  // A new device cannot sign the others out for an hour (AU-20). The button says so and comes back on its own.
  function drawSignOutOthers() {
    const wait = allowedAt - Date.now();
    signOutOthers.disabled = wait > 0;
    $('.new-device-hint').hidden = wait <= 0;
    if (wait > 0) {
      $('.new-device-hint').textContent = `Available ${Math.ceil(wait / 60_000)} min after this device signed in. The devices that were signed in before can use it now.`;
      clearTimeout(timers.signOutOthers); timers.signOutOthers = setTimeout(drawSignOutOthers, Math.min(wait, 60_000));
    }
  }
  drawDevices();
  offs.push(on('presence', () => { clearTimeout(timers.devices); timers.devices = setTimeout(drawDevices, 500); }));
  signOutOthers.addEventListener('click', async () => {
    signOutOthers.disabled = true; signOutOthers.textContent = 'Signing out...';
    try {
      const sub = await push.current();
      const answer = await api.post('/api/account/devices/sign-out-others', { deviceId: deviceId(), pushEndpoint: sub?.endpoint ?? null });
      saved(sessionsStatus, 'Other devices signed out');
      const notice = $('.kicked-notice');
      notice.hidden = false;
      notice.querySelector('.kicked-detail').textContent = `${link.value ? 'Your login link keeps working. ' : ''}${answer?.passphrase ? 'Your secret code was automatically changed. See the new one below.' : ''}`;
      if (answer?.passphrase) { code.value = answer.passphrase; code.shown = true; drawCode(); }
      drawDevices();
    } catch (e) { saved(sessionsStatus, e.message || 'Failed', 'error'); }
    signOutOthers.textContent = 'Sign out all other devices';
    drawSignOutOthers();
  });
  $('.kicked-notice-dismiss').addEventListener('click', () => { $('.kicked-notice').hidden = true; });

  // ---- Install as App (ST-16) ----
  if (push.installed()) { $('.pwa-installed-info').hidden = false; $('.pwa-not-installed').hidden = true; }
  // The icon on the home screen carries the server's name, so the cards name it too (ST-16, ST-17).
  for (const n of page.querySelectorAll('.pwa-name, .push-name')) n.textContent = push.appName();
  $('.install-app').textContent = `Install ${push.appName()}`;   // one text node: the button is inline-flex, which drops the space before a span
  $('.pwa-where').textContent = push.where().phone ? 'on your home screen' : 'as an app on this computer';
  $('.pwa-device').textContent = push.where().device;
  $('.install-app').addEventListener('click', openInstallDialog);

  // ---- Notifications on this device (ST-17, ST-27, NT-23, NT-24, NT-30) ----
  // The card says what the person will see on this device, not how push works: the people who asked "why is my
  // phone quiet" had installed the app and never found the switch behind "push" and "subscribe".
  const pushStatus = $('.push-status');
  const Device = w => w.device === 'phone' || w.device === 'computer' ? w.device[0].toUpperCase() + w.device.slice(1) : w.device;   // "This Phone", but "This iPhone"
  const pushIntro = (w, name) => {
    if (w.ios && !w.installed) return `${w.browser} cannot show ${name} notifications. First add ${name} to your home screen (see Install as App above). Then open the ${name} icon and turn notifications on there. The app shows new messages like any other app, with a number on its icon.`;
    if (w.installed && w.phone) return `When ${name} is closed, new messages show as notifications on this ${w.device}, with a number on the ${name} icon. Your ${w.device} treats ${name} like any other app. You can also change this in your ${w.device}'s Settings, under Notifications.`;
    if (w.phone) return `When this tab is closed, new messages show in your phone's notifications. For a number on an icon, install ${name} on your home screen (see Install as App above).`;
    if (w.installed) return `When ${name} is closed, new messages show as a pop-up in the corner of your screen. The number of unread messages shows on the ${name} icon in your taskbar or dock.`;
    return 'When this tab is closed, new messages show as a pop-up in the corner of your screen. While the tab is open, the number of unread messages shows in the tab title.';
  };
  const scrollTo = sel => e => { e.preventDefault(); $(sel).scrollIntoView({ behavior: 'smooth' }); };
  async function drawPush() {
    const w = push.where(), name = push.appName(), device = w.device, card = `Notifications on This ${Device(w)}`;
    const possible = push.supported() && !(w.ios && !w.installed);   // a browser on an iPhone has no notifications at all (NT-23)
    const configured = !!state.config?.vapidPublicKey, blocked = possible && push.permission() === 'denied';
    const sub = possible ? await push.current() : null;
    let devices = [];
    try { devices = await api.get('/api/push/devices'); } catch { /* keep */ }
    const mine = sub && devices.find(d => d.endpoint === sub.endpoint);
    $('.push-heading').textContent = card;
    $('.push-intro').textContent = pushIntro(w, name);
    $('.push-this-label').textContent = `This ${device}`;
    const thisValue = $('.push-this');
    const thisState = !possible ? ['Not possible here', 'status-unavailable'] : !configured ? ['Not set up on this server', 'status-unavailable'] : blocked ? ['Blocked', 'status-denied'] : mine ? ['On', 'status-enabled'] : ['Off', 'status-disabled'];
    const on = thisState[1] === 'status-enabled';
    const mark = icon(on ? CHECK_CIRCLE : BELL_OFF); mark.setAttribute('class', `status-icon ${on ? 'status-icon-on' : 'status-icon-off'}`);
    thisValue.replaceChildren(mark, thisState[0]); thisValue.className = `notification-value push-this ${thisState[1]}`;   // push-this stays: the next draw looks it up
    $('.push-count').textContent = devices.length ? String(devices.length) : 'none yet';
    replace($('.push-list'), devices.map(d => {
      const item = clone('t-session-item');
      const current = sub && d.endpoint === sub.endpoint;
      item.classList.toggle('current', !!current);
      item.querySelector('.session-icon').textContent = '🔔';
      item.querySelector('.session-badge').hidden = !current;
      item.querySelector('.session-ip').textContent = d.platform;
      item.querySelector('.session-activity').textContent = `Added ${ago(d.addedAt)}`;
      if (d.deliveredAt) { const extra = item.querySelector('.session-extra'); extra.hidden = false; extra.textContent = `Delivered ${ago(d.deliveredAt)}`; }
      // Remove is the only way off, this device included: a "Turn off" button for this device did the same
      // thing under a second name, so it went (2026-10-26).
      const remove = item.querySelector('.session-remove'); remove.hidden = false;
      remove.addEventListener('click', async () => { try { await api.delete('/api/push/devices', { endpoint: d.endpoint }); if (current) await push.unsubscribe(); drawPush(); } catch (e) { saved(pushStatus, e.message, 'error'); } });
      return item;
    }));
    // The reason when nothing can be done here. For a block, the steps for this browser or for the phone's Settings.
    const reason = $('.push-reason');
    const text = !possible ? (w.ios ? null : 'This browser cannot show notifications.') : !configured ? 'Notifications are not set up on this server.' : blocked ? push.blockedHint() : null;
    reason.hidden = !text; if (text) reason.textContent = text;
    const stuck = !possible || !configured || blocked;
    $('.push-on').hidden = stuck || !!mine; $('.push-on-hint').hidden = stuck || !!mine;
    $('.push-on').textContent = `Turn on notifications on this ${device}`;
    $('.push-on-hint').textContent = w.phone ? `Your ${device} will ask you to allow notifications. Tap Allow.` : 'Your browser will ask you to allow notifications. Click Allow.';
    const canTest = configured && devices.length > 0;
    $('.push-test-row').hidden = !canTest; $('.push-test-hint').hidden = !canTest;
    // The red notice above Allow / Mute (ST-27): the rules there belong to the account and cannot wake a quiet device.
    const notice = $('.push-off-notice'), link = (label, sel) => el('a', { href: '#', onclick: scrollTo(sel) }, label);
    const parts = !configured ? null
      : !possible ? (w.ios ? [`${w.browser} cannot show notifications. `, link(`Install ${name} on your home screen`, '[data-section="install"]'), ' to get them.'] : [`This browser cannot show notifications when ${name} is closed.`])
      : blocked ? [`Notifications are blocked on this ${device}. See `, link(card, '[data-section="push"]'), ' above for the fix.']
      : mine ? null : [`This ${device} does not show notifications when ${name} is closed. Turn them on in `, link(card, '[data-section="push"]'), ' above.'];
    notice.hidden = !parts;
    if (parts) $('.push-off-notice-text').replaceChildren(...parts);
  }
  drawPush();
  // Back from the phone's Settings or from the browser's permission popup: the state may have changed.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') drawPush(); }, { signal: aborter.signal });
  $('.push-on').addEventListener('click', async e => {
    e.target.disabled = true; e.target.textContent = 'Turning on...';
    const result = await push.subscribe();
    if (!result.ok) saved(pushStatus, result.reason, 'error');
    e.target.disabled = false;
    drawPush();   // also restores the label
  });
  $('.push-test').addEventListener('click', async e => {
    e.target.disabled = true; e.target.textContent = 'Sending...';
    try {
      const r = await api.post('/api/push/test', {});
      const devices = n => `${n} ${n === 1 ? 'device' : 'devices'}`;
      saved(pushStatus, r.total === 0 ? 'No phone or computer gets notifications yet.' : r.failed ? `Sent to ${r.sent} of ${devices(r.total)}. ${r.failed} could not be reached and the dead ones were removed.` : `Sent to ${devices(r.sent)}. Check them now.`);
    } catch { saved(pushStatus, 'Failed to send test notification.', 'error'); }
    e.target.disabled = false; e.target.textContent = 'Send a test to all my devices';
    drawPush();
  });
  $('.to-mutes').addEventListener('click', scrollTo('#notification-settings'));

  // ---- Allow / Mute Notifications (ST-18, NT-16 to NT-22) ----
  function seg(host, items, selected, onPick) {
    replace(host, items.map(([value, label, svg]) => {
      const b = clone('t-seg-btn');
      const on = value === selected;
      b.classList.toggle('seg-selected', on); b.setAttribute('aria-checked', String(on));
      replace(b.querySelector('.seg-icon-slot'), svg ? [icon(svg)] : []);
      b.querySelector('.seg-text').textContent = label;
      b.addEventListener('click', () => onPick(value));
      return b;
    }));
  }
  async function putMutes(body) { try { await api.put('/api/account/mutes', body); } catch (e) { saved(status, e.message, 'error'); } }
  function muteHint() {
    const until = state.mutes?.server?.until;
    if (!until) return 'Muted until you turn notifications back on.';
    const left = Math.max(0, new Date(until) - Date.now());
    const m = Math.round(left / 60_000), h = Math.round(left / 3_600_000), d = Math.round(left / 86_400_000);
    const text = left < 60_000 ? 'a moment' : m < 60 ? (m === 1 ? '1 minute' : `${m} minutes`) : h < 24 ? (h === 1 ? '1 hour' : `${h} hours`) : (d === 1 ? '1 day' : `${d} days`);
    return `Muted for another ${text}.`;
  }
  function drawMutes() {
    const mutes = state.mutes; if (!mutes) return;
    const muted = serverMuted();
    seg($('.server-seg'), [['allow', 'Allow', BELL], ['mute', 'Mute', BELL_OFF]], muted ? 'mute' : 'allow', v => {
      if (v === 'mute') { mergeMe({ mutes: { ...mutes, server: { muted: true, until: null } } }); putMutes({ server: { muted: true, until: null } }); }
      else { mergeMe({ mutes: { ...mutes, server: { muted: false, until: null } } }); putMutes({ server: { muted: false, until: null } }); }
    });
    $('.duration-row').hidden = !muted; $('.mute-hint').hidden = !muted; $('.modes').hidden = muted;
    if (muted) {
      const until = mutes.server.until ? new Date(mutes.server.until) - Date.now() : null;
      const pick = until === null ? 'forever' : until <= 3_600_000 ? '1h' : until <= 86_400_000 ? '1d' : '1w';   // the shortest that covers the rest (NT-17)
      seg($('.duration-seg'), [['1h', '1 hour'], ['1d', '1 day'], ['1w', '1 week'], ['forever', 'Until I turn it back on']], pick, v => {
        const ms = { '1h': 3_600_000, '1d': 86_400_000, '1w': 7 * 86_400_000 }[v];
        const untilIso = ms ? new Date(Date.now() + ms).toISOString() : null;
        mergeMe({ mutes: { ...mutes, server: { muted: true, until: untilIso } } }); putMutes({ server: { muted: true, until: untilIso } });
      });
      $('.mute-hint').textContent = muteHint();
      return;
    }
    // "Allow" and "Mute", not "Allow all" and "Mute all": the three choices must share one line on a phone at
    // the 20 px text size (ST-26), and the server row above uses the same two words.
    const modes = [['allowAll', 'Allow', BELL], ['individual', 'Individual', SLIDERS], ['muteAll', 'Mute', BELL_OFF]];
    seg($('.dm-seg'), modes, mutes.dmMode, v => { mergeMe({ mutes: { ...mutes, dmMode: v } }); putMutes({ dmMode: v }); });
    seg($('.room-seg'), modes, mutes.roomMode, v => { mergeMe({ mutes: { ...mutes, roomMode: v } }); putMutes({ roomMode: v }); });
    const dmList = $('.dm-list'), roomList = $('.room-list');
    dmList.hidden = mutes.dmMode !== 'individual'; roomList.hidden = mutes.roomMode !== 'individual';
    const toggle = (label, isMuted, onToggle) => {
      const item = clone('t-notif-item');
      replace(item.querySelector('.notif-item-name'), inline(label));
      const b = item.querySelector('.notif-item-toggle');
      b.classList.toggle('muted', isMuted); b.setAttribute('aria-pressed', String(isMuted));
      b.title = isMuted ? 'Muted — click to allow' : 'Allowed — click to mute'; b.setAttribute('aria-label', isMuted ? 'Unmute' : 'Mute');
      b.replaceChildren(icon(isMuted ? BELL_OFF : BELL));
      b.addEventListener('click', () => onToggle(!isMuted));
      return item;
    };
    const channelToggle = (channelId, label, fallback) => toggle(label, mutes.channels[channelId] ?? fallback, next => {
      mergeMe({ mutes: { ...mutes, channels: { ...mutes.channels, [channelId]: next } } }); putMutes({ channel: { channelId, muted: next } });
    });
    if (!dmList.hidden) {
      replace(dmList, [...state.dms.slice().sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '')).map(d => channelToggle(d.channelId, displayName(d.partner), mutes.newDmsMuted)),
        Object.assign(toggle('New DMs', mutes.newDmsMuted, next => { mergeMe({ mutes: { ...mutes, newDmsMuted: next } }); putMutes({ newDmsMuted: next }); }), { className: 'notif-item notif-item-default' })]);
    }
    if (!roomList.hidden) replace(roomList, state.rooms.map(r => channelToggle(r.id, `#${r.name}`, true)));
  }
  drawMutes();
  offs.push(on('mutes', drawMutes), on('dms', drawMutes), on('rooms', drawMutes));
  timers.hint = setInterval(() => { if (!$('.mute-hint').hidden) $('.mute-hint').textContent = muteHint(); }, 60_000);

  // ---- Time & Date (ST-19, ST-20) ----
  let options = null;   // from /api/account/locale-options
  const clockNow = $('.current-time');
  const drawClock = () => { clockNow.textContent = timeOf(new Date()); };
  drawClock(); timers.clock = setInterval(drawClock, 10_000);
  function offsetOf(zone) {   // the current offset of the zone, in hours
    const fixed = /^UTC([+-]\d+)$/.exec(zone ?? '');
    if (fixed) return Number(fixed[1]);   // a fixed offset chosen here before
    try {
      const parts = new Intl.DateTimeFormat('en', { timeZone: zone, timeZoneName: 'longOffset' }).formatToParts(new Date());
      const m = /GMT([+-]\d{1,2})(?::(\d{2}))?/.exec(parts.find(p => p.type === 'timeZoneName')?.value ?? '');
      return m ? Number(m[1]) + Math.sign(Number(m[1]) || 1) * Number(m[2] ?? 0) / 60 : 0;
    } catch { return 0; }
  }
  function shiftZone(delta) {
    const zone = state.user.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    let hours = Math.round(offsetOf(zone)) + delta;
    hours = Math.max(-14, Math.min(14, hours));                                                  // ST-19
    const fixed = `UTC${hours >= 0 ? '+' : ''}${hours}`;
    mergeMe({ timeZone: fixed }); usePreferences(state.user); drawClock(); patch({ timeZone: fixed });
  }
  $('.time-minus').addEventListener('click', () => shiftZone(-1));
  $('.time-plus').addEventListener('click', () => shiftZone(1));
  $('.time-detect').addEventListener('click', () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!zone || zone === 'Etc/Unknown') return;   // a browser without a zone (headless) changes nothing
    mergeMe({ timeZone: zone }); usePreferences(state.user); drawClock(); patch({ timeZone: zone });
  });
  function formatExample(order, clock, culture) {
    const loc = culture || state.user.locale || navigator.language;
    const now = new Date();
    if (clock) return new Intl.DateTimeFormat(loc, clock === '12h' ? { hour: 'numeric', minute: '2-digit', hour12: true } : { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
    const p = Object.fromEntries(new Intl.DateTimeFormat(loc, { day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(now).map(x => [x.type, x.value]));
    const sep = order === 'ymd' ? '-' : (p.literal ?? '/').trim() || '/';
    return order === 'dmy' ? `${p.day}${sep}${p.month}${sep}${p.year}` : order === 'mdy' ? `${Number(p.month)}${sep}${Number(p.day)}${sep}${p.year}` : `${p.year}-${p.month}-${p.day}`;
  }
  function saveFormat() {
    const { order, clock, culture } = options.current;
    const value = `${order}-${clock}${culture && options.cultures.length > 1 ? `-${culture}` : ''}`;
    mergeMe({ dateFormat: value }); usePreferences(state.user); drawClock(); patch({ dateFormat: value });
  }
  function drawFormats() {
    if (!options) return;
    const cards = (host, items, selected, name, onPick) => replace(host, items.map(([value, example, label]) => {
      const card = clone('t-format-option');
      const input = card.querySelector('input'); input.name = name; input.checked = value === selected;
      card.classList.toggle('selected', value === selected);
      card.querySelector('.format-example').textContent = example;
      if (label) { const l = card.querySelector('.format-label'); l.hidden = false; l.textContent = label; }
      input.addEventListener('change', () => onPick(value));
      return card;
    }));
    const c = options.current;
    cards($('.clock-options'), options.clocks.map(id => [id, formatExample(null, id, c.culture)]), c.clock, 'clock', v => { c.clock = v; saveFormat(); drawFormats(); });
    cards($('.order-options'), options.dateOrders.map(id => [id, formatExample(id, null, c.culture)]), c.order, 'dateOrder', v => { c.order = v; saveFormat(); drawFormats(); });
    const sepGroup = $('.separators-group');
    sepGroup.hidden = options.cultures.length < 2;
    if (!sepGroup.hidden) cards($('.separator-options'), options.cultures.map(cu => [cu.name, formatExample(c.order, null, cu.name), cu.nativeName]), c.culture, 'separators', v => { c.culture = v; saveFormat(); drawFormats(); });
    $('.detected').textContent = `Detected: ${state.user.timeZone ?? '—'} · ${state.user.locale ?? '—'}`;
  }
  api.get('/api/account/locale-options').then(o => { options = o; drawFormats(); }).catch(() => {});

  // ---- My GIFs (ST-21 to ST-24) ----
  const unmountLibrary = GifLibrary($('.gif-library-host'), { server: false });

  // ---- APP VERSION (ST-28) ----
  // The build this page runs, the server's when it is newer, and the same move as the strip's Reload: the page comes
  // from the server, so the device gets the new build even when its service worker stays on an old one (update.js).
  const drawVersion = () => {
    const server = state.config?.buildStamp;
    const newer = !!server && !!build && server !== build;
    $('.version-page').textContent = build || '—';
    $('.version-server-row').hidden = !newer;
    $('.version-server').textContent = server ?? '';
    // No stamp until the hub answers (main.js start(), OF-04): no hint then, since "latest" would be a guess.
    $('.version-hint').textContent = !server ? '' : newer ? 'A newer version is on the server. Reload to get it.' : 'This is the latest version.';
  };
  drawVersion();
  offs.push(on('config', drawVersion));
  $('.version-reload').addEventListener('click', () => { $('.version-reload').disabled = true; reloadForNewBuild(); });

  // ---- DEBUG INFO (ST-25) ----
  mountDebugInfo(page);   // the caches and the emoji timings of this page load (settings-debug.js)

  // ---- the account's changes from elsewhere (ST-07, ST-10) ----
  // store.reset() fires this too, with no user: the device was signed out and the page unmounts a moment later.
  offs.push(on('user', () => { if (!state.user) return; drawPicture(); drawThemes(); drawSizes(); drawLink(); drawClock(); drawFormats(); }));

  root.replaceChildren(page);
  // ST-01. "Notification settings" in the status menu and "Manage your GIFs in Settings" in the GIF picker open a
  // section. The lists above it (sessions, push devices, the login link) arrive after the first frame and push it
  // down. The browser's scroll anchoring does not hold it on the phone. So each size change of the column scrolls to
  // the section again, until the reader touches the page.
  const linked = { 'notification-settings': '#notification-settings', 'my-gifs': '[data-section="gifs"]' }[route.hash];
  if (linked) {
    const section = $(linked), touched = new AbortController();
    const pin = new ResizeObserver(() => section.scrollIntoView());   // it also fires once on observe: the first scroll
    pin.observe($('.settings-content'));
    const release = () => { pin.disconnect(); touched.abort(); };
    for (const type of ['pointerdown', 'wheel', 'keydown']) $('.settings-container').addEventListener(type, release, { passive: true, signal: touched.signal });
    offs.push(release);
  }
  return () => {
    clearTimeout(profileTimer); flushProfile();                                                  // a typed edit is saved on leaving (ST-02)
    for (const t of Object.values(timers)) { clearInterval(t); clearTimeout(t); }
    offs.forEach(off => off()); aborter.abort(); unmountLibrary(); page.remove();
  };
}
