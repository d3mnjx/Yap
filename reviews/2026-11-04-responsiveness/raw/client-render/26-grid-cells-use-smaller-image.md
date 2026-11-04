---
id: client-render-26
title: Give grid cells a smaller picture than the 800 px medium file
area: client-render
journey: all
category-guess: 2
behaviour-change: none
effort: L
estimated-gain: A message with 2 to 10 pictures draws them in rows of two or three cells, each cell loads the 800 px medium file. On a phone a cell is about 110 to 180 CSS px wide (330 to 540 device pixels at 3x). A 400 px file would be about a quarter of the pixels; bytes saved per picture unknown (depends on the webp encoding), likely half or more for grid cells.
confidence: low
files: [Yap/wwwroot/js/ui/message.js:135-157, Yap/Services/Media/ImageService.cs:17-18, Yap/Services/Media/ImageService.cs:121-122]
---

## What the code does now
`imageGallery` puts `src: img.medium` on every cell, single or in a grid (`message.js:142`). The server makes two sizes, 800 px (medium, "Gallery and single image preview") and 1,600 px (large) (`ImageService.cs:17-18`). The cells are lazy (`loading: 'lazy'`).

## Why it costs the user time
A 3-column grid on a phone shows each picture at a fraction of 800 px. The bytes of the unused pixels cross the slow link. A message with nine pictures loads nine 800 px files for cells of about a third of the screen width. Who pays: far users, picture-heavy rooms.

## The change
Server (backend reader): make a third size, for example 400 px, with the medium and large ones, and send it as `img.small`. Client: in `imageGallery`, use `srcset` with the small and medium files and `sizes` from the cell width (for example `sizes="(max-width: 600px) 33vw, 260px"` for a 3-cell row), and keep `src: img.medium` as the fallback. Old stored rows without `small` keep `medium`.

## Risks and what could break
Existing uploads have no small file; the server needs a backfill or a fallback to medium. Disk use grows by the small files.

## How to measure it
The byte size of medium files in a sample of uploads against a 400 px encoding of the same files. The boot report's `bytes` for a picture-heavy room on a phone.
