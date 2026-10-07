# Reference: notification settings, what a user can set up

> Current-state map of the notification subsystem. Written 2026-08-27, rewritten the same day when
> per-channel mute landed. This is a feature reference, not a bug report. For the 2026-05-29
> investigation into missing badges and unreliable push, see `unread-and-push-notifications-analysis.md`.

## What a user can set up

Two separate questions, answered in two Settings sections.

### 1. Can this device be notified at all? (`/settings` → Device Push Notifications)

- **Enable push on this device** asks for browser permission, subscribes with the server VAPID key, then
  saves the endpoint per username (`EnablePush`, `Settings.razor`).
- **Turn off push on this device** unsubscribes this browser and deletes only its endpoint. (Until
  2026-08 the button also wiped every other device's subscription; that wipe predated the per-device
  list and is removed.)
- Each subscribed device is listed with its push host, when it was added, and the last confirmed
  delivery. **Remove** deletes that one endpoint.
- **Send a test to all devices** pushes to every subscribed device and reports sent/failed. It ignores every mute
  setting on purpose (`SendTestAsync`, `PushNotificationService.cs`): a delivery test a mute could
  silence would prove nothing.
- `PushPermissionPrompt.razor` shows a first-run card, but only inside an installed PWA, only while
  permission is still `default`, and it stops after 3 dismissals (counter in `localStorage`).
  If permission is already granted it silently re-registers the subscription to repair rotated endpoints.

### 2. What is worth notifying about? (`/settings` → Allow / Mute Notifications)

Three levels, evaluated top down by `NotificationSettingsService.IsMuted`. The first level that
decides wins.

**Server level.** Allow or Mute everything. Muting picks a duration: 1 hour, 1 day, 1 week, or
until the user turns it back on (the default). A timed mute reads as expired on its own; the stored
flag is cleared lazily the next time the settings page loads. While the server is muted the DM and
room sections are hidden, because nothing below them can matter.

**DM level.** Allow all, Individual, or Mute all. Default is Allow all. Individual lists every DM
partner with at least one message, newest conversation first, each with a bell toggle, plus a
**New DMs** row that decides the default for a partner with no override row yet.

**Room level.** The same three states, but the default is Mute all, which reproduces exactly what
rooms did before this feature existed. Individual lists the rooms. A room the user never touched
stays muted, and there is no "New rooms" row.

Per-channel overrides survive a switch to Allow all or Mute all and are ignored while that lasts, so
returning to Individual restores the user's earlier picks.

## What muting does

A muted channel keeps counting unread messages. The count is hidden, not lost. The channel:

- shows no numeric unread badge in the sidebar,
- adds nothing to the app-wide unread total (mailbox count and PWA app icon badge),
- sends no push notification,
- plays no sound and adds nothing to the browser tab title,
- does not sort its DM to the top of the user list,
- still shows the small unread dot.

Unmuting reveals the true accumulated count, because the filter runs at read time and not at
increment time (`GetTotalUnreadCount` in `ChatService.cs`).

## What is NOT configurable

Quiet hours, per-device mute, sound choice, and volume. Volume is hardcoded at 0.5 in `chat.js`.

## The suppression rule

Independent of mute, and unchanged by this feature: a push is skipped only when the recipient is
`Online` **and** at least one session has a visible page (`DispatchPush` in `ChatService.cs`).
`Away` and `Invisible` still get pushed, which is deliberate, since Away is exactly when the phone
should buzz. Every decision and result goes into a 200-entry ring buffer
(`Services/NotificationAudit.cs`) that feeds the admin Diagnostics tab.

## Room unread fan-out

Room unread counts increment for two sets of users, unioned: everyone with a live session (which is
what puts the dot on a room for people who are here), plus everyone who unmuted that room, online or
not. The second set exists so a badge and the push that announced it agree. Offline users who have a
room muted are still skipped, so nobody returns to a sidebar full of dots for rooms they never opened.

## Server-side prerequisites

Push is off unless `Vapid:Subject/PublicKey/PrivateKey` are set in `appsettings.json`. Startup
verifies the public key is the true pair of the private key and disables push loudly if not.
Subscriptions are stored as JSON or in the DB per `ChatSettings:PushSubscriptionStorage`.

## Platform limits (iOS)

Safari has no install prompt. The user installs through Share, then Add to Home Screen. Push and the
app badge need iOS 16.4 or later and work only in the installed PWA, not in the Safari tab. The badge
also needs notification permission. The permission request must come from a user gesture. Safari
evicts the PWA's storage after about 7 days without use. `setAppBadge(0)` clears the badge instead of
showing a dot, so the client calls `clearAppBadge()` to clear and `setAppBadge(n)` only when n > 0.

## Removed: the old PushMuted flag

`User.PushMuted` used to mean "send the badge, suppress the banner". It is gone from the UI, from
`PushNotificationService`, and from the service worker, replaced by the settings above, which
suppress the notification outright. The column remains in the database because the DB is live and
dropping it buys nothing. Nothing reads it. Values were not migrated: the old flag was weaker than a
server mute, so carrying it over would have silenced badges the user never asked to silence.
