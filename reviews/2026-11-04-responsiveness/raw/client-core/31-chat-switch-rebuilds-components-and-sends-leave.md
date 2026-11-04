---
id: client-core-31
title: Keep the timeline and composer across room switches, and drop the redundant leave
area: client-core
journey: switch-room
category-guess: 2
behaviour-change: none
effort: M
estimated-gain: Unknown, needs measurement. Each switch today unmounts and rebuilds both components from their templates (the composer template alone is 91 tags with SVGs), closes the conversation (three store notifications the frame redraws for), and sends a `leave` that the next `openRoom` makes redundant.
confidence: low
files: [Yap/wwwroot/js/pages/chat.js:35-78, Yap/wwwroot/js/main.js:96-128, Yap/wwwroot/js/store.js:103-109, Yap/Endpoints/ChatHub.cs:95-100, Yap/Endpoints/ChatHub.cs:152-157]
---

## What the code does now
The router treats every route change as a new page mount (main.js:105-126): `unmountPage()` then `page.mount(root, route)`. The chat page's unmount (chat.js:70-77):

```js
if (hub.connected() && hub.looking()) hub.send('markRead', state.open.channelId);
unmounts.forEach(u => u());
closeOpen();
if (hub.connected()) hub.send('leave');
```

and its mount (chat.js:38-41) builds new roots and `[Timeline(timelineRoot), Composer(composerRoot)]`. `closeOpen` fires `open`, `messages` reset and `typists` (store.js:103-109); the frame redraws its room list, people, mailbox and pins for `open`. Then `paintStored` fires `open` again, and the `openRoom` answer a third time. On the server, `Leave` (ChatHub.cs:95-100) leaves the group and sets viewing to null, and the following `OpenRoom`'s `Switch` (ChatHub.cs:152-157) leaves the current group anyway.

## Why it costs the user time
A room switch is a frequent action. The person waits for the stored rows of the next room; before them the old components are torn down and new ones are built and wired, on the main thread. The frame redraws three times for one switch. The `leave` is one more hub message and server work (viewing to null, then to the new room) per switch.

## The change
In the chat page, when the next route is also a chat route, keep the Timeline and Composer and only switch the target: the router could pass the new route to a `page.update(route)` when the page module stays the same, and `chat.js` would run `setTitles`, `paintStored` and `openConversation` for the new target. Send `leave` only when the next page is not a chat page (Settings, Admin).

## Risks and what could break
- The composer holds per-conversation state (draft, reply target, attachments, recorder); it must reset per target, as `onOpen` partly does today (`messages` reset).
- The timeline's scroll state and the "New messages" pill must reset per conversation.
- This touches the ui reader's area (ui/timeline.js, ui/composer.js); measure first.

## How to measure it
Journey switch-room on a phone: a performance profile from the tap on a room to the stored rows on screen; count the frame's redraws per switch.
