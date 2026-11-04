# Component CSS (flattened from Blazor scoped CSS)

These files hold the old `*.razor.css` rules from commit 7af3454 (the parent of 2c1b6c0, "Step 1: remove Blazor").
Declarations, values, comments and media queries are copied as they were. The only selector changes are:
`::deep` is removed, and a root class is put in front of selectors whose class names collided between components.
`app.css` and `themes.css` are not changed.

## Load order

Load these files after `app.css`, `themes.css` and `themes/teahouse.css`, in this order:
`frame.css`, `pickers.css`, `timeline.css`, `composer.css`, `message.css`, `pages.css`.

Each flattened rule is one attribute less specific than its scoped form, so ties between files now go to the file
that loads later. The order above follows the old `Yap.styles.css` bundle (sorted by component path), which loaded
after the global files. Sections inside each file use the same order. Cases that need it: Avatar before the
`.x .avatar` overrides in ChatHeader, UserProfileCard and MessageItem; the ChatLayout timeline rules before MessageItem
(`.system-message`).

## Files and sections

| File | Sections |
|---|---|
| frame.css | Avatar, ChatHeader, ChatSidebar, ChatLayout (frame part), PushPermissionPrompt, UserProfileCard |
| pickers.css | CombinedPicker, EmojiPicker, GifPicker (PickerPane had no CSS file) |
| timeline.css | ImageGalleryModal, ChatLayout (timeline part), ShowMoreButton |
| composer.css | MessageInput |
| message.css | LinkPreviewCard, MediaPlayer, MessageItem |
| pages.css | GifLibraryManager, Admin, ChannelSettings, Invite, Login, Settings, VerifyDevice |

ChatLayout split: frame.css has `.chat-container`, `.theme-scene`, `.theme-scrim`, `.header-line`, `.chat-main`,
`.messages-container`, `.sidebar-backdrop` (and its media query), `.error-content` and the error buttons.
timeline.css has `.messages` and its scrollbar, `.messages-flow`, the scroll-dismiss rule, `.messages-spacer`,
`.loading-more`, `.loading-spinner` and `.history-start`. `.system-message` is in message.css only; the
timeline.css copy said the same and went (2026-10-30).
ChatLayout has no "pill" rule. The only pill near messages is `.reaction-pill` in message.css.

## Root classes (prefixes)

The prefix is a descendant selector, so the root must be an ancestor of the element, not the same element.
The `.page-*` classes are new. Put each one on a wrapper around that page's own markup. Do not put it on `<body>`:
Settings and ChannelSettings render inside the chat frame, and the header has its own `.back-button`.

| Root | Section | Classes whose selectors got the root in front |
|---|---|---|
| `.page-admin` | Admin | back-button, form-group, form-input, form-hint, form-textarea, toggle-row/-info/-label/-hint/-switch/-slider, admin-badge, user-name, status-dot, section-header, section-hint, gif-tags-cell |
| `.page-admin .gif-tags-cell` | Admin | gif-tags-view, gif-tag-chip, gif-tags-empty, gif-tags-edit, gif-tags-input, gif-tags-btn (see decision 3) |
| `.page-channel` | ChannelSettings | back-button, form-group, form-input, form-hint, form-textarea, settings-container/-header/-content/-section/-actions, section-hint, and `.danger-section h3` (decision 4) |
| `.page-settings` | Settings | back-button, form-group, form-input, form-hint, form-textarea, settings-container/-header/-content/-section, toggle-row/-info/-label/-hint/-switch/-slider |
| `.page-invite` | Invite | validation-error, build-info |
| `.page-login` | Login | validation-error, build-info |
| `.page-verify` | VerifyDevice | validation-error |
| `.gif-library` | GifLibraryManager | gif-tags-view, gif-tag-chip, gif-tags-empty, gif-tags-edit, gif-tags-input, gif-tags-btn |
| `.emoji-picker` | EmojiPicker | category-btn, section-header |
| `.gif-picker` | GifPicker | category-btn |
| `.chat-header` | ChatHeader | back-button, status-dot |
| `.users-sidebar` | ChatSidebar | user-name, admin-badge, bot-badge |
| `.message-input-container` | MessageInput | emoji-picker-backdrop |
| `.message-group` | MessageItem | bot-badge, emoji-picker-backdrop |

The prefix goes on every selector that names one of these classes, in any position, including the copies in media
queries (`.form-group label`, `.toggle-switch input:checked + .toggle-slider`). In a selector list, only the parts
that name the class get it. 150 selectors in total. In the old markup, every prefixed element is inside its root.

## Decisions

1. `.dot` is not prefixed. The typing dots sit in `.typing-indicator-container`, a sibling of
   `.message-input-container`, so that prefix would break them. `.typing-dots .dot` and `.reconnect-dots .dot`
   kept the two rule sets apart until the reconnect dots went (2026-10-29).
2. `.section-hint` was not on the list. It has different rules in Admin and ChannelSettings, so it got a prefix (rule 3).
3. The Admin page renders GifLibraryManager, which uses the same `.gif-tag*` names with different rules
   (for example `margin: -4px` and `min-width: 140px` exist only in Admin). `.page-admin` alone would reach into the
   library. The Admin tag editor sits in `<td class="gif-tags-cell">`, so its rules use `.page-admin .gif-tags-cell`.
   Keep that cell in the new Admin markup.
4. ChannelSettings markup is `<div class="settings-section danger-section">`. After `.settings-section h3` got its
   prefix, it would beat `.danger-section h3`, and the danger heading would lose its red. So that rule got the prefix too.
5. Some listed classes have identical rules in both files. They got the prefix anyway, as asked: `.build-info`
   (Invite, Login), `.toggle-switch/-slider/-label/-info/-hint` (Admin, Settings), `.settings-content/-header/-section`
   (ChannelSettings, Settings). `.form-counter` is identical in ChannelSettings and Settings and was not on the list,
   so it has no prefix. It is defined once, in the ChannelSettings section (2026-10-30).
6. Not prefixed, with no conflict: state classes that always join a component class (`.active`, `.selected`,
   `.online`, `.disabled` ...), and the old `::deep` overrides that are meant to reach another component
   (`.dm-header-title .avatar`, `.reply-preview .avatar`, `.profile-card-avatar .avatar`, `.combined-pane .emoji-picker`,
   `.emoji-picker-container .emoji-picker`, `.emoji-picker-wrapper .emoji-picker`, `.system-message .message-content`).
7. Some keyframe names occurred twice with identical bodies: `spin` (ChatLayout, Login), `gif-spin` (MessageItem,
   GifPicker), `fadeIn` (MessageInput, app.css). Blazor scoped them per component. Flat, a keyframe name is global,
   so app.css defines `fadeIn` and `spin` once (2026-10-30); `gif-spin` had the body of `spin` and went.
8. Three guard comments mark deliberate oddities: decisions 3 and 4, and the MessageInput `[data-picker-pane]` hide
   rule. That rule now ties with the reveal rule after it and loses only by source order, so keep that order.
9. New leaks: in the old Admin markup, the "Load more" buttons used `.upload-button` (styled in Settings) and
   `.join-button` (styled in Login). Scoping kept them bare. Flat, they take those styles. Each class is defined in
   one file only, so rule 3 did not allow a prefix. Use other class names in the new Admin markup to keep the bare look.

## Dropped rules

- MainLayout: `#blazor-error-ui` and `#blazor-error-ui .dismiss` (the whole file).
- ReconnectModal: `#components-reconnect-modal`; the hide rule
  `.components-reconnect-first-attempt-visible, .components-reconnect-repeated-attempt-visible, .components-reconnect-failed-visible, .components-pause-visible, .components-resume-failed-visible, .reconnect-dots { display: none !important }`;
  the show rule `#components-reconnect-modal.components-reconnect-{show,retrying,failed,paused,resume-failed}`;
  the five state rules `#components-reconnect-modal.<state> .components-*-visible` (three of them also show `.reconnect-dots`);
  `#components-reconnect-modal button`, `:hover` and `:active`; `#components-seconds-to-next-attempt`.
  Their comments and the Blazor state list in the header comment went too.
  Kept at first: `.reconnect-banner-content`, `.reconnect-dots`, `.reconnect-dots .dot` with its three `:nth-child`
  delays, `@keyframes reconnect-dot-pulse`. The vanilla client never used them (the connection dot and the notice
  strip in app.css took the role), so they went on 2026-10-29.
- The sources had no `[b-...]` selectors and no `.blazor-error-boundary` rules.

## Classes each component expects on its markup

| Component | File | Main classes (states in brackets) |
|---|---|---|
| Avatar | frame | avatar (avatar-small, avatar-medium, avatar-large), avatar-image, avatar-initials |
| ChatHeader | frame | chat-header, back-button, dm-header-title, header-controls, mailbox-button (has-unread), mailbox-badge, pins-button, pins-badge, users-toggle, icon-hamburger, icon-people, online-count, status-dropdown-container, status-button (status-online, status-away, status-invisible), status-indicator, status-username, dropdown-backdrop, status-dropdown, dropdown-item (active, signout), dropdown-divider, status-dot (online, away, invisible) |
| ChatSidebar | frame | users-sidebar (sidebar-open), sidebar-section, rooms-list, room-item (active, has-unread), room-icon, room-name, room-settings, add-room, users-list, user-item (current-user, active-dm), user-name, user-status-dot (online, away, invisible), admin-badge, bot-badge, unread-dot, unread-badge, mute-bell, profile-info-btn, profile-popup (is-mobile; a sibling of the sidebar), profile-popup-backdrop |
| ChatLayout | frame, timeline | chat-container (data-context), theme-scene, theme-scrim, header-line, chat-main, messages-container, sidebar-backdrop (show), error-content, error-retry-button, error-reload-button; messages, messages-flow, messages-spacer, system-message, loading-more, loading-spinner, history-start |
| PushPermissionPrompt | frame | push-prompt-overlay (hiding), push-prompt-card, push-prompt-icon, push-prompt-heading, push-prompt-body, push-prompt-enable, push-prompt-later |
| Pinned messages panel | frame | pins-layer, pins-backdrop, pins-panel, pins-head, pins-title, pins-close, pins-list, pin-entry (jumping), pin-entry-header, pin-avatar, pin-author, pin-time, pin-unpin, pin-text, pin-media, pin-frame, pin-shot, pin-grid, pin-cell, pin-picture, pin-gif, pin-card, pin-card-title, pin-card-site, pin-attachment-label, pin-entry-foot, pin-by |
| UserProfileCard | frame | profile-card, profile-card-banner, profile-card-avatar, profile-card-body, profile-card-identity, profile-card-name, profile-card-badge, profile-card-username, profile-card-statusline, profile-card-status-dot (online, away, offline), profile-card-divider, profile-card-section, profile-card-label, profile-card-bio, profile-card-empty, profile-card-meta |
| CombinedPicker | pickers | combined-picker (data-active-tab), combined-tabs, combined-tab, combined-body, combined-pane |
| EmojiPicker | pickers | emoji-picker, emoji-sidebar, category-btn (active), emoji-content, emoji-search, emoji-search-clear, emoji-section, section-header, emoji-grid, emoji-btn, emoji, emoji-empty |
| GifPicker | pickers | gif-picker, gif-sidebar, category-btn (active), gif-content, gif-search, gif-search-clear, gif-upload-btn (is-busy), gif-spinner, gif-upload-overlay, gif-results, gif-section-header, gif-grid, gif-card, gif-fav-btn (favorited), gif-empty, gif-no-provider, gif-tile-grid, gif-folder-tile, gif-folder-back, gif-manage-link, gif-attribution |
| ImageGalleryModal | timeline | image-modal (closing), gallery-strip, modal-stage (dragging, fill, fill-w), modal-close, modal-nav (prev, next), modal-fill, modal-counter |
| ShowMoreButton | timeline | show-more |
| MessageInput | composer | typing-indicator-container, typing-indicator, typing-dots, dot, upload-progress-track, upload-progress-fill, reply-bar, reply-bar-text, reply-bar-close, message-input-container (has-reply-bar, data-picker, data-recording), input-box, message-input, image-upload-button, emoji-toggle-wrapper, emoji-toggle-button, gif-toggle-button, gif-toggle-badge, emoji-picker-container (data-picker-pane), emoji-picker-backdrop, send-button (disabled), recorder, recorder-trash, recorder-dot, recorder-time, recorder-bars, warning-modal-backdrop, warning-modal, readonly-bar |
| LinkPreviewCard | message | link-preview-card, link-preview-content, link-preview-site, link-preview-title, link-preview-description, link-preview-thumbnail |
| MediaPlayer | message | media-player-container, cached-video-player, video-info, video-site, video-title, cached-audio-player, audio-thumbnail, audio-info, audio-title, audio-site, audio-element |
| Voice player | message | voice-message (playing), voice-play, play-icon, pause-icon, voice-bars, voice-time, voice-speed |
| MessageItem | message | message-group (system-message, has-header, has-reply, reply-target, highlight-message, picker-open, menu-open), reply-preview, reply-author, reply-text, message-body, message-meta, message-username, bot-badge, message-time, message-content, message-link, edited-indicator, image-gallery, gallery-item, gif-message (gif-loaded), video-container, message-actions, action-btn, emoji-picker-wrapper, reactions-display, reaction-pill (reacted), edit-container, more-menu, delete-confirm-overlay |
| GifLibraryManager | pages | gif-library, gif-lib-toolbar, gif-lib-folders, folder-chip (active), gif-lib-actions, gif-lib-filter, gif-lib-action-btn (disabled), gif-lib-quota, gif-lib-quota-fill (hot), gif-lib-strip (error, done), gif-lib-empty, gif-lib-grid, gif-lib-card, gif-lib-thumb, gif-lib-processing, gif-tags-view, gif-tag-chip (more), gif-tags-edit, gif-tags-input, gif-tags-btn (save), gif-lib-controls, gif-lib-btn (danger) |
| Admin | pages | page-admin (wrapper), admin-page, admin-sidebar, admin-sidebar-header, back-button, nav-item (active), admin-tabs, tab-item (active), admin-content, section-header, table-wrapper, users-table, clickable-row (selected), user-cell, user-name, admin-badge, status-pill (online, away, invisible, offline), status-dot, user-detail-panel, form-group, form-input, toggle-row, toggle-switch, gif-tags-cell, gif-row-btn (active, danger) |
| ChannelSettings | pages | page-channel (wrapper), settings-container, settings-header, back-button, settings-content, settings-section, section-hint, form-group, form-input, form-textarea, form-hint, form-counter, permission-cards, permission-card (selected), reorder-list, reorder-item (current), settings-actions, cancel-button, save-button, danger-section, danger-item, delete-button (confirm), error-message |
| Invite | pages | page-invite (wrapper), invite-container, invite-card, invite-text, invite-form-row, invite-input (invalid), invite-button, invite-secondary, validation-error, build-info |
| Login | pages | page-login (wrapper), username-container, username-form, username-form-row, username-input (invalid), join-button, validation-error, new-account-hint, retry-link, multidevice-guide, closed-message, waiting-message, waiting-hint, waiting-spinner, rejection-notice, build-info |
| Settings | pages | page-settings (wrapper), settings-container, settings-header, back-button, settings-content, settings-section, form-group, form-input, form-hint, save-status (saving, saved, error), toggle-row, toggle-switch, toggle-slider, theme-grid, theme-card (selected), font-size-option (selected), format-option (selected), sessions-list, session-item (current), segmented, seg-btn (seg-selected), notif-item-toggle (muted), debug-info |
| VerifyDevice | pages | page-verify (wrapper), verify-container, verify-hint, verify-form, input-wrapper, verify-input (invalid), verify-button, validation-error, back-link |
