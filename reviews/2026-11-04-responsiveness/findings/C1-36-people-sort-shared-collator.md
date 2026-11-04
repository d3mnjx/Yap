---
id: C1-36
title: Sort the people list with one shared Intl.Collator and precomputed names
category: 1
journey: all
effort: S
confidence: high
behaviour-change: none
estimated-gain: The sort of 2,000 names took 72.6 ms with localeCompare(…, options) and 0.9 ms with one shared Intl.Collator in a sandbox V8 check (not a phone number). On a phone the first figure is likely several times larger. The sort runs on every people pass whose signature changed, which includes every room switch and every presence tick on a busy server.
experiment: none
sources: [client-render-01]
files: [Yap/wwwroot/js/ui/frame.js:304-325, Yap/wwwroot/js/ui/frame.js:357-367]
---

## What the code does now
`peopleInOrder` sorts every name in the list with a comparator that calls `localeCompare` with an options object and calls `displayName` twice per comparison (`frame.js:316-324`):

```js
return [...names].sort((a, b) => {
  const ra = rank(a), rb = rank(b);
  ...
  return displayName(a).localeCompare(displayName(b), undefined, { sensitivity: 'base' });
});
```

`rank()` also runs twice per comparison and calls `isMuted()` for DM partners. `peoplePass` (`frame.js:357-367`) runs the sort whenever the signature changes. The signature holds the open channel (`frame.js:348`), so every room switch re-sorts. On a busy server every presence tick with a change also re-sorts (at most every 250 ms, `PEOPLE_GAP_MS`).

## Why it costs the user time
V8 builds or looks up an ICU collator inside `localeCompare` when an options object is given. A sort of n names makes about n·log2(n) comparisons (about 22,000 for 2,000 people). A sandbox check (V8, fast desktop, a check of the method only) gave 72.6 ms per sort with the current comparator and 0.9 ms with a shared `Intl.Collator`. The memory `client-render-cost-at-scale` names this exact sort as part of the 2026-10-18 stall. The signature skip landed then; the sort itself stayed. Who pays: everyone on a server with many accounts, most on phones; it lands within 250 ms of a room switch, when the new rows also draw.

## The change
In `frame.js`, at module level:

```js
const byName = new Intl.Collator(undefined, { sensitivity: 'base' });
```

In `peopleInOrder`, compute the rank, the DM time and the display name once per name into a small array of records, sort the records with `byName.compare(x.name, y.name)` as the last key, and map back to usernames. About 15 changed lines in one function.

## Risks and what could break
The order must stay identical. `Intl.Collator(undefined, { sensitivity: 'base' }).compare` gives the same result as `localeCompare(b, undefined, { sensitivity: 'base' })` by specification. The ranks and the DM time keys stay as they are.

## How to measure it
A server with 2,000 accounts (the load-test setup). Chrome DevTools performance profile on a throttled phone profile, or a real Android phone: the duration of `peoplePass` on a room switch and during a presence wave. Safari on the iPhone: same, through Web Inspector. The JSC cost of `localeCompare` with options is unknown and needs this measurement.