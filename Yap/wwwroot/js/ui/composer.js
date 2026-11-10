// The input box (input-box.md): the typing strip, the reply bar, the pill with +, the draft, the toggles and
// Send, the read-only bar, the pickers, drafts per conversation, uploads. Every action here is local first;
// the server learns of a message through sender.js (IB-10, IB-24).

import { state, on, displayName, roomById, isReadOnly, setDraft, dmByChannel } from '../store.js';
import { clone, el, replace } from '../render/dom.js';
import { fileThumb } from '../render/thumb.js';
import { inline, pick } from '../render/text.js';
import * as hub from '../hub.js';
import * as overlays from './overlays.js';
import * as sender from '../sender.js';
import { check as checkFiles } from '../upload.js';
import { EmojiPicker } from './emoji-picker.js';
import { setReplyTarget } from './message.js';
import { GifPicker } from './gif-picker.js';
import { keyOf } from '../offline/snapshot.js';
import { record, supported as canRecord } from './recorder.js';
import { drawBars, formatTime } from './voice.js';

const MAX_TEXT = 4000;      // IB-14
const LIVE_BARS = 48;       // the recorder shows the last 4.8 s of levels (IB-68)
const SPRITE_COLS = 20, SPRITE_COUNT = 73;   // the emoji toggle sprite: 48 px cells (IB-45)

// The pickers live once per page, not once per conversation: the GIF picker keeps its tab and folder, and
// the phone sheet keeps its tab, across a switch (PK-14, IB-41). They call the composer mounted now.
let pickers = null;

// The trays live once per page too: the files a person picked for a conversation wait there until the send,
// also across a switch to another conversation (IB-33). A reload drops them, as Discord does.
const trays = new Map();   // conversation key -> [{ file, url }]

// The height of the phone keyboard, measured in the composer and kept on the device: a GIF as the first action of a
// session also gets a sheet of the right size (IB-41).
let keyboardHeight = Number(localStorage.getItem('yap.keyboardHeight')) || 0;

export function Composer(root) {
  const box = clone('t-composer');
  root.append(box);
  const aborter = new AbortController();
  const { signal } = aborter;
  const container = box.querySelector('.message-input-container');
  const area = box.querySelector('.message-input');
  const fileInput = box.querySelector('input[type=file]');
  const tray = box.querySelector('.attachment-tray');
  const sendButton = box.querySelector('.send-button');
  const replyBar = box.querySelector('.reply-bar');
  const readonly = box.querySelector('.readonly-bar');
  const typing = box.querySelector('.typing-indicator');
  const emojiToggle = box.querySelector('.emoji-toggle-button');
  const gifToggle = box.querySelector('.gif-toggle-button');
  const emojiPane = box.querySelector('[data-picker-pane="emoji"].emoji-picker-container');
  const gifPane = box.querySelector('[data-picker-pane="gif"].emoji-picker-container');

  let key = null;              // the open conversation as the device names it: a room id, or 'dm:' and the partner (offline/snapshot.js)
  let target = null;           // { channelId, partner } for the sender; channelId is null for a direct message opened offline for the first time (OF-08)
  let replyTo = null;          // the message replied to (IB-49)
  let files = [];              // the tray of the open conversation: the array held in trays, so a push here is a push there (IB-33)
  let placeholderPick = { channelId: null, text: '' };
  let typingPick = { key: '', text: '' };
  let caret = null;            // where an emoji pick goes (IB-44)
  let typingSentAt = 0, typingTimer = 0;
  let sendWanted = false;      // Enter came before the first open: the text goes when the conversation is there

  // ---- the conversation ----

  function onOpen() {
    const open = state.open;
    const next = open ? keyOf(open) : null;
    target = open ? { channelId: open.channelId ?? null, partner: open.partner ?? null } : null;   // a direct message gains its channel id when the connection returns; its key stays
    if (next === key) { renderReadOnly(); return; }
    recording?.cancel();   // a recording belongs to the conversation it started in (IB-69)
    const typedBeforeOpen = key === null && area.value;   // text typed while the first conversation was still opening
    if (key) saveDraft();
    key = next;
    closePicker();
    if (!typedBeforeOpen) restoreDraft();
    openTray();
    renderPlaceholder();
    renderReadOnly();
    renderTyping();
    sender.showFor(key);
    if (sendWanted && key) { sendWanted = false; send(); }
  }

  function renderPlaceholder() {
    const open = state.open;
    if (!open) return;
    const dm = dmByChannel(open.channelId) ?? (open.partner ? { partner: open.partner } : null);
    if (dm) { area.placeholder = `Message @${dm.partner}`; return; }                      // IB-16
    if (placeholderPick.channelId !== open.channelId) {
      const list = state.texts?.placeholders;
      placeholderPick = { channelId: open.channelId, text: list?.length ? (pick(list, '') || 'Say something…') : 'Type a message...' };   // IB-16 wording
    }
    area.placeholder = placeholderPick.text;
  }

  function renderReadOnly() {
    const room = state.open ? roomById(state.open.channelId) : null;
    const locked = isReadOnly(room);                                                      // IB-62
    readonly.hidden = !locked;
    container.hidden = locked;
    renderReply();
    if (locked) closePicker();
  }

  // ---- drafts (IB-53) ----

  function saveDraft() { if (key) setDraft(key, { text: area.value, replyToId: replyTo?.id ?? null, replyToName: replyTo?.username ?? null }); }
  function restoreDraft() {
    const draft = state.drafts[key];
    area.value = draft?.text ?? '';
    // the original may be above the loaded tail after a reload: the bar still shows the name (IB-53)
    replyTo = draft?.replyToId ? state.open?.messages.find(m => m.id === draft.replyToId) ?? { id: draft.replyToId, username: draft.replyToName ?? '' } : null;
    renderReply();
    grow();
    caret = null;
  }

  // ---- the draft ----

  function grow() {
    area.style.height = 'auto';
    area.style.height = `${Math.min(area.scrollHeight, 200)}px`;                           // IB-04
  }

  area.addEventListener('input', () => {
    if (area.value.length > MAX_TEXT) area.value = area.value.slice(0, MAX_TEXT);           // IB-14
    grow();
    caret = area.selectionStart;
    saveDraft();
    noteTyping();
  });
  area.addEventListener('click', () => { caret = area.selectionStart; closePicker(); });  // a tap on the draft closes the picker (IB-42)
  area.addEventListener('keyup', () => { caret = area.selectionStart; });

  // The phone sheet takes the keyboard's place, so it wants the keyboard's height (IB-41). No API gives it; the visible
  // height of the page does: it shrinks by the keyboard while a text field has the focus. Read at every keyboard open,
  // because a different keyboard app or a landscape turn gives a new number.
  let idleHeight = visualViewport.height;   // the visible height without a keyboard
  visualViewport.addEventListener('resize', () => {
    const h = visualViewport.height;
    if (!document.activeElement?.matches('input, textarea')) { idleHeight = h; return; }
    if (idleHeight - h > 100) { keyboardHeight = idleHeight - h; localStorage.setItem('yap.keyboardHeight', String(keyboardHeight)); }   // less is a browser bar, not a keyboard
  }, { signal });
  area.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.isComposing) return;                                       // IB-13
    if (overlays.isTouch() || e.shiftKey) return;                                          // IB-11, IB-12
    e.preventDefault();
    send();
  });
  area.addEventListener('paste', e => {                                                    // IB-15
    const picked = [...(e.clipboardData?.items ?? [])].filter(i => i.type.startsWith('image/') || i.type.startsWith('video/')).map(i => i.getAsFile()).filter(Boolean);
    if (!picked.length) return;
    e.preventDefault();
    addFiles(picked);
  });

  // ---- typing (IB-59) ----

  function noteTyping() {
    if (!target?.channelId) return;   // no channel id means no connection either: nobody to tell
    clearTimeout(typingTimer);
    if (!area.value.trim()) { stopTyping(); return; }
    const now = Date.now();
    if (now - typingSentAt > 2000) { hub.send('typing', target.channelId, true); typingSentAt = now; }
    typingTimer = setTimeout(stopTyping, 3000);
  }
  function stopTyping() {
    clearTimeout(typingTimer);
    if (typingSentAt && target?.channelId) hub.send('typing', target.channelId, false);
    typingSentAt = 0;
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') stopTyping(); }, { signal });

  // The text of the strip is picked once per set of names (GEN-12), not on every refresh.
  function renderTyping() {
    const names = Object.keys(state.open?.typists ?? {}).filter(n => n !== state.user?.username);
    typing.hidden = names.length === 0;
    if (!names.length) return;
    const shown = names.map(displayName);
    const dm = state.open && (dmByChannel(state.open.channelId) || state.open.partner);
    const key = `${dm ? 'dm' : 'room'}:${shown.join(',')}`;
    if (typingPick.key !== key) {
      let text;
      if (dm) text = `${shown[0]} is typing...`;                                                               // IB-60
      else if (shown.length === 1) text = pick(state.texts?.typingOne, '{0} is typing..', shown[0]);
      else if (shown.length === 2) text = pick(state.texts?.typingTwo, '{0} and {1} are typing..', shown[0], shown[1]);
      else text = pick(state.texts?.typingMany, '{0} and {1} others are typing..', shown[0], shown.length - 1);
      typingPick = { key, text };
    }
    replace(typing.querySelector('.typing-text'), inline(typingPick.text));
  }

  // ---- the reply bar (IB-49 to IB-52) ----

  function renderReply() {
    replyBar.hidden = !replyTo || !readonly.hidden;
    container.classList.toggle('has-reply-bar', !!replyTo);
    if (replyTo) replace(replyBar.querySelector('strong'), inline(displayName(replyTo.username)));
    setReplyTarget(replyTo?.id ?? null);                                                                 // MR-37
  }
  function setReply(m) { replyTo = m; renderReply(); saveDraft(); }
  document.addEventListener('yap:reply', e => { setReply(e.detail); area.focus(); }, { signal });       // IB-50
  replyBar.querySelector('.reply-bar-close').addEventListener('pointerdown', e => e.preventDefault());   // no focus move (IB-51)
  replyBar.querySelector('.reply-bar-close').addEventListener('click', () => setReply(null));

  // ---- send (IB-18 to IB-28) ----

  function send() {
    if (recording) {                                                                         // Send ends the recording and sends it (IB-69)
      if (container.dataset.recording !== undefined) { recording.stop(); return; }
      recording.cancel();                                                                    // still waiting for the microphone: the person typed instead, the text goes
    }
    if (!area.value.trim() && !files.length) return;                                        // IB-21
    if (!key) { sendWanted = true; return; }                                               // the conversation is still opening
    if (needsConnection(files.map(f => f.file))) { overlays.reason(container, 'Needs a connection'); return; }   // picked online, sent offline (OF-09)
    const text = area.value.trim() ? area.value.slice(0, MAX_TEXT) : '';                   // the same cut as the input handler, for a draft that got in by another path (IB-14); blank text is no caption
    const attached = takeFiles();                                                           // the files go with the text, as one message (IB-33)
    area.value = ''; grow(); saveDraft();
    const reply = replyTo; setReply(null);
    closePicker();
    stopTyping();
    const row = sender.queueMessage({ ...target, text, replyToId: reply?.id ?? null, files: attached });
    if (!attached.length) row.tappedAt = performance.now();                                 // AD-26 measures the wire; an upload would hide it
  }
  sendButton.addEventListener('pointerdown', e => e.preventDefault());                     // never moves the focus (IB-22)
  sendButton.addEventListener('click', send);

  // ---- attachments: the tray (IB-29 to IB-37) ----

  fileInput.addEventListener('change', () => { const picked = [...fileInput.files]; fileInput.value = ''; if (picked.length) addFiles(picked); });   // IB-37
  // + is a button, not a label around the input: a label took no keyboard focus (U03 of the 2026-10-15 user test).
  const uploadButton = box.querySelector('.image-upload-button');
  uploadButton.addEventListener('pointerdown', e => e.preventDefault());                   // never moves the focus, like Send (IB-22)
  uploadButton.addEventListener('click', () => {
    if (container.dataset.picker) closePicker();                                            // a tap on + with a picker open only closes it (IB-42)
    else openAttachMenu();
  });

  // The + menu (IB-67): the chooser, or the recorder. It lives on the body like the delete dialog, so no ancestor's
  // stacking context traps it (the phone sheet of the More menu comes with its classes).
  function openAttachMenu() {
    const layer = clone('t-attach-menu');
    const menu = layer.querySelector('.more-menu');
    const voiceItem = layer.querySelector('[data-action="voice"]');
    if (!canRecord()) voiceItem.remove();   // a browser without a recorder gets the chooser item alone
    for (const item of layer.querySelectorAll('.more-menu-item')) item.addEventListener('pointerdown', e => e.preventDefault());   // the keyboard stays as it is (IB-22)
    layer.querySelector('[data-action="files"]').addEventListener('click', () => { close(); fileInput.click(); });   // the tap on the item is the gesture the chooser needs
    voiceItem.addEventListener('click', () => { close(); startRecording(); });
    layer.querySelector('.more-menu-backdrop').addEventListener('click', () => close());
    document.body.append(layer);
    overlays.place(menu, uploadButton, { align: 'left' });
    const close = overlays.open({ element: menu, keep: [uploadButton], onClose: () => layer.remove() });
  }

  // ---- voice messages (IB-68 to IB-70) ----

  const recorderBox = box.querySelector('.recorder');
  const recorderTime = recorderBox.querySelector('.recorder-time');
  const recorderBars = recorderBox.querySelector('.recorder-bars');
  let recording = null;   // the job of recorder.js while a voice message records

  // Inside the tap of the menu item: the recorder's audio context needs the gesture (recorder.js).
  function startRecording() {
    if (!key || recording) return;
    closePicker();
    if (overlays.isPhone()) area.blur();   // the recorder takes the pill; the keyboard goes
    const job = record({
      maxMs: (state.config?.voiceMaxSeconds ?? 300) * 1000,
      // The live bars: the last LIVE_BARS levels enter from the right, lifted so a normal voice fills the height.
      onLevel: levels => { const recent = levels.slice(-LIVE_BARS).map(l => Math.min(1, l * 3)); drawBars(recorderBars, new Array(LIVE_BARS - recent.length).fill(0).concat(recent), 1); },
      onTick: ms => { recorderTime.textContent = formatTime(ms); },
    });
    recording = job;
    job.ready
      .then(() => { if (recording !== job) return; recorderTime.textContent = '0:00'; drawBars(recorderBars, new Array(LIVE_BARS).fill(0), 1); container.dataset.recording = ''; })
      .catch(() => warn('Microphone unavailable', 'Yap cannot use the microphone. Allow it in the browser settings and try again.'));
    job.done.then(result => {
      if (recording === job) { recording = null; delete container.dataset.recording; }
      if (!result) return;
      if (result.durationMs < 1000) { overlays.reason(container, 'Too short'); return; }   // a tap and a tap again (IB-69)
      sendVoice(result);
    });
  }
  recorderBox.querySelector('.recorder-trash').addEventListener('pointerdown', e => e.preventDefault());
  recorderBox.querySelector('.recorder-trash').addEventListener('click', () => recording?.cancel());

  // The recording goes as one message, alone (IB-70). It is a Blob until the sender uploads it; the pending row plays
  // the Blob with the same bars, so the accepted row looks the same (voice.js).
  function sendVoice({ blob, durationMs, peaks }) {
    if (!key) return;
    const ext = blob.type.includes('mp4') ? 'mp4' : blob.type.includes('ogg') ? 'ogg' : 'webm';
    const file = new File([blob], `voice.${ext}`, { type: blob.type });
    const reply = replyTo; setReply(null);   // a reply, as a GIF is (IB-47)
    sender.queueMessage({ ...target, replyToId: reply?.id ?? null, files: [file], voice: { durationMs, peaks } });
  }

  // Without a connection the send goes to the outbox on disk, which holds 25 MB per message (IB-64, OF-09).
  const needsConnection = blobs => state.connection !== 'connected' && blobs.reduce((s, f) => s + f.size, 0) > 25 * 1024 * 1024;

  function openTray() {
    if (key && !trays.has(key)) trays.set(key, []);
    files = key ? trays.get(key) : [];
    renderTray();
  }

  // A pick, a drop or a paste lands in the tray; nothing is uploaded before Send (IB-33).
  function addFiles(picked) {
    if (!key) return;
    const maxMB = state.config?.maxUploadMB ?? 100;
    const { accepted, refused } = checkFiles(picked, maxMB, files.length);
    if (refused.length) warn(accepted.length ? `${accepted.length} of ${picked.length} files added` : 'No file added', refused.join('\n'));   // IB-35
    if (!accepted.length) return;
    if (needsConnection([...files.map(f => f.file), ...accepted])) { overlays.reason(container, 'Needs a connection'); return; }
    files.push(...accepted.map(file => ({ file, url: URL.createObjectURL(file) })));
    renderTray();
  }

  function removeFile(entry) {
    URL.revokeObjectURL(entry.url);
    files.splice(files.indexOf(entry), 1);
    renderTray();
  }

  // Send empties the tray. The pending row draws the same squares from its own Blob URLs (sender.js thumbsOf, IB-34).
  function takeFiles() {
    const taken = files.splice(0);
    for (const f of taken) URL.revokeObjectURL(f.url);
    renderTray();
    return taken.map(f => f.file);
  }

  function renderTray() {
    tray.hidden = !files.length;
    container.classList.toggle('has-files', files.length > 0);                              // Send stays visible over an empty draft (composer.css)
    replace(tray, files.map(entry => {
      const item = fileThumb(entry.file, entry.url);
      item.append(el('button', { type: 'button', class: 'tray-remove', 'aria-label': `Remove ${entry.file.name}`, onpointerdown: e => e.preventDefault(), onclick: () => removeFile(entry) }, '✕'));   // no focus move, like + (IB-22)
      return item;
    }));
  }

  // drag and drop (IB-30)
  let dragDepth = 0;
  const isFileDrag = e => e.dataTransfer?.types?.includes('Files');
  container.addEventListener('dragenter', e => { if (isFileDrag(e) && ++dragDepth === 1) container.dataset.dragging = ''; });
  container.addEventListener('dragleave', () => { if (dragDepth > 0 && --dragDepth === 0) delete container.dataset.dragging; });
  container.addEventListener('dragover', e => { if (isFileDrag(e)) e.preventDefault(); });
  container.addEventListener('drop', e => {
    e.preventDefault(); dragDepth = 0; delete container.dataset.dragging;
    const picked = [...(e.dataTransfer?.files ?? [])].filter(f => f.type.startsWith('image/') || f.type.startsWith('video/'));
    if (picked.length) addFiles(picked);
  });
  document.addEventListener('dragover', e => e.preventDefault(), { signal });
  document.addEventListener('drop', e => e.preventDefault(), { signal });                  // a drop elsewhere does nothing

  function warn(title, message) {
    const modal = clone('t-warning-modal');
    modal.querySelector('.warning-modal-title').textContent = title;
    modal.querySelector('.warning-modal-message').textContent = message;
    const close = () => layer();
    for (const b of modal.querySelectorAll('button')) b.addEventListener('pointerdown', e => e.preventDefault());   // the dialog never moves the focus (IB-35)
    modal.querySelector('.warning-modal-close').addEventListener('click', close);
    modal.querySelector('.warning-modal-button').addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    box.prepend(modal);
    const layer = overlays.open({ element: modal.querySelector('.warning-modal'), outsideCloses: false, onClose: () => modal.remove() });
  }

  // ---- the pickers (IB-38 to IB-48) ----

  const handlers = {
    insert: insertEmoji, sendGif, warn,
    toKeyboard: () => { closePicker(); area.focus(); },      // the keyboard takes the sheet's place (IB-66)
    toggleFull: () => sizeSheet(!container.dataset.sheet),   // IB-66
  };

  function mountPickers() {
    pickers ??= {
      emoji: EmojiPicker({ onPick: v => pickers.current.insert(v) }),
      gif: GifPicker({ onSend: g => pickers.current.sendGif(g), onWarn: (t, m) => pickers.current.warn(t, m) }),
      combined: null, current: handlers,
    };
    pickers.current = handlers;
    layoutPickers();
  }

  // Desktop: two panes. Phone: one sheet with two tabs in the emoji pane (IB-41, PK-45).
  function layoutPickers() {
    if (!pickers) return;
    const { emoji, gif } = pickers;
    if (overlays.isPhone()) {
      if (!pickers.combined) {
        const combined = clone('t-combined-picker');
        for (const tab of combined.querySelectorAll('.combined-tab')) tab.addEventListener('click', () => { combined.dataset.activeTab = tab.dataset.combinedTab; });
        combined.querySelector('.combined-keyboard').addEventListener('click', () => pickers.current.toKeyboard());
        const size = combined.querySelector('.combined-size');
        size.addEventListener('pointerdown', e => e.preventDefault());   // a GIF search keeps its focus across the resize
        size.addEventListener('click', () => pickers.current.toggleFull());
        pickers.combined = combined;
      }
      // Every time, not only when the sheet is made: the unmount below takes the two pickers out of the sheet,
      // and the desktop layout takes them into its own panes. An append of an element that is there already moves nothing.
      pickers.combined.querySelector('[data-combined-pane="gifs"]').append(gif.element);
      pickers.combined.querySelector('[data-combined-pane="emoji"]').append(emoji.element);
      replace(emojiPane, [pickers.combined]);
      replace(gifPane, []);
    } else {
      replace(emojiPane, [emoji.element]);
      replace(gifPane, [gif.element]);
    }
  }
  overlays.phone.addEventListener('change', () => { closePicker(); layoutPickers(); }, { signal });   // IB-43

  function openPicker(which) {
    mountPickers();
    container.dataset.picker = which;
    if (which === 'emoji') pickers.emoji.opened();
    if (which === 'gif' || overlays.isPhone()) pickers.gif.opened();
    emojiToggle.classList.toggle('open', which === 'emoji');
    if (overlays.isPhone()) {
      // The sheet takes the keyboard's place (IB-41): the draft gives up the focus, so the keyboard closes, and the
      // sheet gets the keyboard's height, so the box stays where it was. Half height on every open.
      area.blur();
      container.style.setProperty('--sheet-height', keyboardHeight ? `${keyboardHeight}px` : '');
      sizeSheet(false);
      showSheet(true);
    }
  }
  function closePicker() {
    delete container.dataset.picker;
    emojiToggle.classList.remove('open');
    sizeSheet(false);
    showSheet(false);
  }
  // The sheet is a popover: the top layer takes it above the header and out of the chat column's clip (pickers.css).
  // A browser without the API shows it as a fixed box in the input box, as before.
  function showSheet(shown) {
    const sheet = pickers?.combined;
    if (!sheet?.isConnected || !sheet.showPopover) return;
    if (shown) sheet.showPopover(); else sheet.hidePopover();
  }
  // The phone sheet at half height, in the keyboard's place, or at full height over the whole view (IB-66).
  function sizeSheet(full) {
    if (full) container.dataset.sheet = 'full'; else delete container.dataset.sheet;
    pickers?.combined?.querySelector('.combined-size')?.setAttribute('aria-expanded', String(full));   // the chevrons turn on this
  }
  for (const toggle of [emojiToggle, gifToggle]) {
    toggle.addEventListener('pointerdown', e => e.preventDefault());                       // never moves the focus (IB-58)
    toggle.addEventListener('click', () => {
      const which = toggle.dataset.pickerToggle;
      if (container.dataset.picker) closePicker(); else openPicker(which);                 // IB-42
    });
  }
  for (const backdrop of box.querySelectorAll('.emoji-picker-backdrop')) backdrop.addEventListener('click', closePicker);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && container.dataset.picker && !overlays.anyOpen()) closePicker(); }, { signal });   // IB-17

  // IB-44: at the caret, before a selection, at the end when the draft was never focused.
  function insertEmoji(value) {
    if (area.value.length + value.length > MAX_TEXT) return;                                // the limit holds for a pick too; no input event runs here (IB-14)
    const pos = caret ?? area.value.length;
    area.value = area.value.slice(0, pos) + value + area.value.slice(pos);
    caret = pos + value.length;
    area.setSelectionRange(caret, caret);
    grow(); saveDraft(); noteTyping();
    sizeSheet(false);                                                                       // a pick at full height shows the draft again (IB-44)
  }

  function sendGif(gif) {                                                                  // IB-47, PK-20
    if (!key) return;
    closePicker();
    const reply = replyTo; setReply(null);
    const row = sender.queueMessage({ ...target, replyToId: reply?.id ?? null, gif });
    row.tappedAt = performance.now();
  }

  // the toggle's random silhouette (IB-45)
  const icon = box.querySelector('.emoji-toggle-icon');
  const randomCell = () => {
    const index = Math.floor(Math.random() * SPRITE_COUNT);
    const col = index % SPRITE_COLS, row = Math.floor(index / SPRITE_COLS);
    for (const [k, v] of [['--color-col', col], ['--color-row', row], ['--grey-col', col], ['--grey-row', row]]) icon.style.setProperty(k, String(v));
  };
  randomCell();
  emojiToggle.addEventListener('mouseenter', randomCell);

  const offs = [on('messages', d => { if (d?.type === 'reset') onOpen(); }), on('typists', renderTyping), on('rooms', renderReadOnly), on('user', renderReadOnly), on('texts', renderPlaceholder), on('users', renderTyping)];
  if (pickers) { pickers.current = handlers; layoutPickers(); }
  onOpen();
  return () => {
    saveDraft(); stopTyping(); recording?.cancel(); offs.forEach(off => off()); aborter.abort();
    if (pickers) for (const p of [pickers.emoji.element, pickers.gif.element, pickers.combined]) p?.remove();   // the pickers survive; the box does not
    box.remove();
  };
}
