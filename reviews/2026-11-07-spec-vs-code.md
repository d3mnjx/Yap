# Spec versus code, 2026-11-07

A check of docs/spec against the code at 6f6825b9, and of every item in `2026-10-23-spec-vs-code.md`. The user
decided each item. This file records the decisions and the two items that wait for a closer look.

## Items of 2026-10-23

| Rule | Decision | Result |
| --- | --- | --- |
| PK-16 | The code wins | PK-16 now says that a GIF uploaded from the picker goes into Recent. |
| ST-01 | Code fixed | "Manage your GIFs in Settings" opens `/settings#my-gifs`, and the section stays in view while the page fills. |
| GEN-05, OF-16 | Code fixed | A sign-out, and a sign-in of another account (AU-25), delete the saved media (the `yap-media` cache). |
| TL-29, TL-20 | The code wins | TL-29 now says that a refresh of the list closes the viewer. |
| TL-15, TL-18 | Code fixed | After a refresh that keeps the place, the pill shows when someone else posted below. A pill shown before the refresh stays, with its phrase. |
| MR-62 | Code fixed | The row with the editor stays through a refresh, also when its message changed. The editor's close draws the row with the message as it is then. MR-62 now says that changes from elsewhere show when the editor closes. |
| SH-20, OF-18 | Fixed before | 5a09cbb5: Reload fetches the page from the server. |
| OF-04, SH-20 | Checked on 2026-11-07 | See the section on the new-version strip below. |
| PR-24, NT-26 | **For later** | See below. |
| NT-07 | **For later** | See below. |
| Admin hints | Code fixed | The Older column and the Load time hint say what they measure now. |

The fix of MR-62 also removed a delay. After Save, the row showed the old text until the server answered (one
round trip), because the row skipped every redraw while the editor was open and the close put the old text back.

## The new-version strip at a launch after a deploy (OF-04, SH-20, SH-50)

Reproduced on 2026-11-07 with two builds (2135 and 2136) and Chromium. A signed-in device had build A's page and
its stored copy of the account data, which names build A. Build B was started, and the page opened '/', as the
installed app does at a launch. The worker passes '/' to the server, so the page was build B at once. The stored
copy still named build A, so the page showed the strip, and the start then made the fresh load of SH-50: the strip
said "Getting the new version…" after about 0.1 s, and the page loaded a second time after about 1.2 s. It ended on
build B with no strip. OF-04 says that Yap never reloads an open page by itself, and the reload had no cause,
because the page was already the new build. On a slow link the extra load costs seconds.

`update.js` compares this page's build with the stamp in the account data that arrives first. At a start that is
the stored copy (OF-06). `main.js needsFreshLoad` then sends the first page to a fresh load.

## Other decisions

- MR-59 against GEN-03: GEN-03 wins. MR-59 now says that Edit opens the phone keyboard. The row left the kept
  differences in `docs/architecture/sketch.md`.
- Every spec page has the status "current".

## For a later investigation

The user wants more attention on these two. Nothing is changed.

- **PR-24, NT-26.** A laptop that sleeps with Yap on screen stops the notifications to the person's other devices
  until the server drops the laptop's connection. `PresenceService.IsOnlineAndVisible` reads the Visible flag
  without the heartbeat limit that `Looking` applies (`Services/Presence/PresenceService.cs`, near line 361).
- **NT-07.** A direct message counts as unread for a reader who has it open. The room path skips the readers
  (`Looking`); the direct message path does not (`ChatService.IncrementUnread`, near line 1024). Another device
  of the reader can show the count for a moment.

## Checks

A one-off Playwright script checked TL-15 (pill shown, and not shown when nothing came), MR-62 (the draft
survives a reconnect with a reaction from someone else; Save shows the new text in the same task), ST-01 and
GEN-05. All checks passed with the fixes and failed on the code before them. The offline, features and smoke
suites passed (14, 16 and 17 steps).
