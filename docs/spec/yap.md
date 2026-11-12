# Yap

Yap is a self-hosted chat for one group of people. One server holds one community with rooms and direct messages. The server is run by one of the members, the admin. Yap is not a critical system. User experience has priority over guarantees.

This page is the overview. Each section links to the page that holds the rules. The [general rules](general-rules.md) apply to every page.

## Accounts

An account has a username, chosen once, and an optional display name, avatar, bio and location. The first human account on a server is the admin. A bot account welcomes new members and tells phone users how to install the app. Its name and its texts are set per server.

A person joins by an invite link, or by registration while the admin keeps registration open. Sign-in has no password. A device stays signed in. A device on a known network signs in with the username alone. A login link signs in any other device. The code of the link also works as a typed code. A secret code is a retired way in that older accounts can still have. See [Sign-in and sessions](sessions.md).

The admin can delete an account, except the admin and the bot. See [Administration](admin.md#AD-38).

## Rooms and direct messages

Every room is visible to every member. The lobby is the default room and cannot be deleted. The admin can make a room admin-only, which makes it read-only for the other members, and can limit how far back non-admins see its history. Each room has a description and a position in the list, both set by the admin.

A direct message is a private conversation between two people. It starts when one person taps the other person's name in the sidebar. There are no group direct messages. See [Header, sidebar and overlays](frame.md) for the lists of rooms and people.

## Messages

A message is text or media. Text keeps its line breaks, shows links with a link card, and shows emoji as images from one set. Yap has no formatting syntax and no mentions. Media is up to ten images or videos in one message, or one GIF from the user's library, from the server library or from the GIF provider, or one voice message recorded in the input box. A message can be a reply to another message. A message can carry reactions. The author can edit a text message and can delete any own message. Any reader can copy the text. See [Message row and actions](message-row.md) and [Input box](input-box.md).

Every action in the input box, the pickers and the message rows takes effect at once, except an action that needs data from the network. The server confirms the action afterwards. See [General rules](general-rules.md).

## Emoji and GIFs

The emoji picker shows the user's recent emoji, the custom packs and the standard categories, and has a search. The GIF picker shows the user's recent and favourite GIFs with folders, the server library, trending GIFs and search results from the provider, and has an upload. Reactions use the same emoji picker. See [Emoji and GIF pickers](pickers.md).

## The conversation

The timeline shows the newest messages at the bottom and loads older messages when the user scrolls up. While the user is at the bottom, the timeline follows new messages. While the user reads older messages, the timeline holds its position and shows a pill for new messages. An image opens in the gallery viewer. See [Timeline and media](timeline.md).

The search finds messages of the open conversation by their text: all words of the query, in any order, with no regard to capital letters and accent marks. A tap on a result shows the message in the conversation. See [Search](search.md).

## Presence

The sidebar lists everyone online, each with a status: online or away. The user can choose away, or away comes by itself after some minutes without input and ends with the next input. An invisible user sees everyone and appears offline to everyone except the admin. The typing strip shows who types in the open conversation. See [Presence](presence.md).

## Notifications

Yap counts unread messages per room and per direct message. The mailbox in the header and the installed app's icon show the total. The tab title announces new messages while the tab is hidden; a sound announces new direct messages. The user can mute each room and each direct message. A muted conversation shows a dot and nothing else. A browser that supports notifications, and the installed app, can receive notifications while Yap is closed. See [Notifications and unread](notifications.md).

## Offline and installation

The user can install Yap on a phone or a desktop as an app. Without a connection, Yap shows what the device already has. A message written without a connection is kept on the device and sent when the connection returns. This is best effort, not a guarantee. See [Offline and installation](offline.md).

## Settings and administration

Settings holds the profile, the theme and the text size, Time & Date, the notification settings, the login link, the secret code of an older account, the devices, and My GIFs. The administration page holds the members, the invites, the sessions, the server switches, the logs and the server GIF library. The admin creates and changes rooms on separate pages. See [Settings](settings.md) and [Administration](admin.md).

## Configured texts

Many texts come from lists in the server configuration: the room headers, the placeholder in the input box, the typing texts, the title of the people section, the join and leave lines, and the new messages pill. Each list has a fallback text. Themes change colours and patterns only; they never change behaviour.

## How to read the pages

Every page has the same sections: purpose, anatomy with a screenshot, numbered rules, a states table, the texts the user can read, and links. A rule has a stable ID, for example IB-22, and describes one behaviour in the present tense. A component page says how a part looks and reacts. A feature page says when a behaviour applies and why. When this page and a detail page disagree, the detail page is correct.
