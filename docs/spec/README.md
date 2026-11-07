# Yap product specification

This folder defines what Yap does, as the user sees it. The pages describe behaviour and appearance, not implementation. A page is correct when a user who reads it knows exactly what happens and an implementer who reads it knows exactly what to build.

The pages are Markdown so that people and agents read the same text. `tools/build.py` renders them to HTML with screenshots in `html/`. The Markdown is the source. Never edit the HTML.

## How the pages are organised

1. **Yap** (`yap.md`). What the product is: accounts, rooms, direct messages, messages and media, presence, notifications, offline, installation on a phone, settings and administration. It is one page. Read it first.
2. **General rules** (`general-rules.md`). Rules that every component follows: every input acts locally first, what is private, which conversation's mute setting applies, what the user sees in each connection state.
3. **Components**. The parts of the screen that a user can point to. Each part has one page with the same shape: purpose, anatomy with a screenshot, rules, states, wording.
4. **Feature areas**. Behaviour that several components show. Each area has one page: presence, notifications and unread counts, sign-in and sessions, offline and installation.

Component pages and feature pages link to each other. A component page tells what a part looks like and how it reacts. A feature page tells when and why a behaviour occurs.

## Pages

| Page | Prefix | Status |
| --- | --- | --- |
| [Yap](yap.md) | YAP | current |
| [General rules](general-rules.md) | GEN | current |
| [Input box](input-box.md) | IB | current |
| [Message row and actions](message-row.md) | MR | current |
| [Emoji and GIF pickers](pickers.md) | PK | current |
| [Timeline and media](timeline.md) | TL | current |
| [Header, sidebar and overlays](frame.md) | SH | current |
| [Settings](settings.md) | ST | current |
| [Administration](admin.md) | AD | current |
| [Presence](presence.md) | PR | current |
| [Notifications and unread](notifications.md) | NT | current |
| [Sign-in and sessions](sessions.md) | AU | current |
| [Offline and installation](offline.md) | OF | current |

Current means that the page describes the product as it is now. A change of behaviour changes its page in the same commit.

## Rules and their IDs

Every rule has an ID made of the page prefix and a number, for example `IB-04`. An ID never changes. A removed rule keeps its number and is marked retired. A number is never used again. Tests, issues and commits refer to rules by their IDs.

A rule is a few short sentences about one subject, in the present tense, that say what happens. When the reason is not obvious, a *Why:* sentence gives it. A rule never names a mechanism. "The draft is kept when the user switches conversations" is a rule. "The draft is written to local storage on every keystroke" is not a rule. <!-- lint: allow -->

## Page shape

Every component page has these sections in this order. A feature page has the same sections without Anatomy.

1. **Purpose.** One paragraph that says what the part is for.
2. **Anatomy.** A screenshot with the parts numbered, and one line per part.
3. **Rules.** The numbered rules.
4. **States.** A table: the state or trigger, the input type (mouse, touch, keyboard), and what the user sees.
5. **Wording.** Every text the user can read in this part, verbatim.
6. **Related.** Links to the pages this one depends on.

`tools/page-template.md` is the empty template.

## Screenshots

Screenshots are generated and never pasted. `tests/browser/screenshots.mjs` (`npm run screenshots` in `tests/browser`) seeds a throwaway server, captures each named state and writes the images to `img/`. When a screenshot no longer matches its page, one of the two has a bug.

A run rewrites nearly every image, because the placeholder texts, the section titles and the message times are random or new. Keep only the images whose content changed, and restore the others with `git checkout`.

## Tools

```
python3 docs/spec/tools/lint.py     # IDs unique, links resolve, no implementation words
python3 docs/spec/tools/build.py    # Markdown to html/
```

The lint refuses words that describe an implementation instead of a behaviour. The list is in `tools/lint.py`. A page that needs one of those words for a good reason marks the line with `<!-- lint: allow -->`.
