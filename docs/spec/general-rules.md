# General rules

This page holds the rules that every component follows. A component page can make one of these rules more precise. A component page must not contradict them.

## Local actions

**GEN-01** An input that can act locally acts within the user's own tap or keystroke: typing, opening a picker, picking an emoji, sending, reacting and scrolling. The screen changes before the server answers. The answer from the server then confirms or corrects the change. Anything that must come from the server, such as search results, older messages and uploads, shows a loading state. A loading state never blocks the rest of the app.

**GEN-02** When the server refuses an action, the user sees the reason at the place of the action. A refused change puts the screen back to its previous state. A refused message stays as a failed row with Retry and Remove.

**GEN-03** On a phone, the keyboard opens only when the user taps a text field or starts an action whose purpose is typing. Reply and Edit are such actions. The keyboard closes only when the user leaves the field or taps something that takes its place.

## Privacy

**GEN-04** Only the two people in a direct message can see its text. On the administration page, the admin sees that the message was sent and sees its uploads. A room is visible to every account on the server.

**GEN-05** A sign-out removes all data of the account from the device: drafts, unsent messages, cached conversations and the notification subscription. A sign-out made elsewhere has the same effect when the device learns of it. When a different account signs in on the same device, that account starts empty. Device conveniences, such as the last route and the dismissed prompts, stay on the device.

**GEN-06** Other people see an invisible person as offline. Yap does not count an invisible person as online. Admins see the real status. When an invisible person types, the typing strip shows that person like any other person.

## Sounds, counts and mutes

**GEN-07** The conversation that receives a message decides whether the message counts as unread, plays a sound and causes a notification. The mute setting of that conversation applies. The mute setting of the open conversation does not apply. The type of the open page decides which arriving messages the tab title and the sound announce.

**GEN-08** The user's own messages never count as unread, never play a sound and never cause a notification.

**GEN-09** When something arrives in a muted conversation, the conversation shows a dot and nothing else. A person who had Yap closed gets no dot for a muted room.

## Connection

**GEN-10** Without a connection, the app stays readable and usable. The user can read what is loaded, can write, and can queue messages. An action that needs the server shows "Needs a connection" where the user takes it, or is dimmed.

**GEN-11** The header shows the connection state. When a state needs action from the user, the notice strip also shows it. The connection state never shows as a layer over the content. The one exception is the small pill of [TL-39](timeline.md#TL-39), which floats over the top of the list.

## Texts and look

**GEN-12** The playful texts that vary come from lists that are configured on the server. Each list has a plain fallback. Yap picks a text when its context appears. The text stays until the context changes.

**GEN-13** A theme changes colours, patterns, tints and glows. A theme never changes behaviour, the sizes of controls or the meaning of the status colours.

**GEN-14** Two width tiers apply. The 768 px tier controls the sidebar and the people count. The 600 px tier controls the compact components and the header's density. Both tiers depend on the width, not on the device. Hover and touch rules depend on the input, not on the width.

**GEN-15** On a phone, every text field uses 16 px text, so the page never zooms when a field gets focus.

**GEN-16** On a touch screen, every control that shows on hover on desktop is always visible, or the user can reach it with a tap.

## Shared behaviour

**GEN-17** A tap outside a popup closes it. Escape closes only the topmost open layer.

**GEN-18** On a phone, pickers and menus open as bottom sheets over a dimmed page.

**GEN-19** Yap shows a person by display name. When the person has no display name, Yap shows the username.

**GEN-20** Emoji show as images from one set, so everyone sees the same picture. An image that has not arrived after a second shows as the device's own emoji until it arrives.

**GEN-21** Drafts and unsent messages are kept through a reload, a new version and the error screen.

**GEN-22** A change made on another device or by another person shows at once. The one exception is the Users table of the administration page, which is read when that page loads.

**GEN-23** These belong to the account: the profile, the theme and text size, the time format and the status. The mutes, the recent emoji, the favourites and the unread counts also belong to the account. These belong to the device: the drafts, the pending messages, the cached conversations, the notification subscription, the last route and the dismissed prompts.
