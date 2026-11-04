---
id: client-core-14
title: Stop tus from writing an upload fingerprint to localStorage for every file
area: client-core
journey: upload
category-guess: 1
behaviour-change: none
effort: S
estimated-gain: One synchronous localStorage write per uploaded file, and a localStorage that no longer grows by one entry per upload forever. The page reads localStorage synchronously before its first paint (the inline theme script in index.html, `yap.lastRoute`, `yap.deviceId`), and Chromium loads the whole origin's storage map on first access, so a large map can delay that first read. Small; grows with use.
confidence: high
files: [Yap/wwwroot/js/upload.js:43-53, Yap/wwwroot/js/upload.js:73-76, Yap/wwwroot/index.html:20-31]
---

## What the code does now
Neither tus option object sets the fingerprint options (upload.js:46, upload.js:74). The vendored tus-js-client 4.3.1 defaults, checked in `lib/tus.min.js`, are `storeFingerprintForResuming: true` and `removeFingerprintOnSuccess: false`. The client stores a `tus::<fingerprint>::<id>` entry in localStorage at every upload start and never removes it. The code never calls `findPreviousUploads()`, so the entries are never read.

## Why it costs the user time
Each entry is a few hundred bytes of JSON. A person who sends many photos accumulates thousands of dead entries. localStorage is synchronous; the inline script in `index.html` reads it before the first paint (theme, font size, colour, scene), and `router.js` and `hub.js` read it at boot.

## The change
Add `storeFingerprintForResuming: false` to both option objects in `upload.js`. The sender already restarts an interrupted upload from its Blob (the outbox keeps the files), so resume-by-fingerprint is unused. Optionally, once, remove the existing `tus::` keys at boot in an idle callback.

## Risks and what could break
None known: resumption across reloads is not used. If it is wanted later, `removeFingerprintOnSuccess: true` keeps the feature and stops the growth.

## How to measure it
Count `tus::` keys in localStorage on a device that uploaded for weeks (`Object.keys(localStorage).filter(k => k.startsWith('tus::')).length`) and their total size.
