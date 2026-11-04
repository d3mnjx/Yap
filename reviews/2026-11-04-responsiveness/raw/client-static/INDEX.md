# client-static: findings index

Area facts: nine render-blocking stylesheets, 273,095 B raw, 78,792 B at gzip level 1 (served one by one), 1,296 style rules and 1,395 selectors; pages.css alone 85,548 B and 600 rules. Selector matching is not a real cost: the full message-row template meets about 150 candidate selectors over 24 elements (about 6 per element). The page is 96,885 B raw (82,156 B of it templates). Boot media: regular font 352,240 B (preloaded), emoji-toggle sprites 84,998 B, notif.mp3 43,860 B at first input, italic font 387,976 B at the first system line.

id | title | category-guess | effort | estimated-gain (short) | confidence
--- | --- | --- | --- | --- | ---
client-static-01 | Give the regular font preload a low fetch priority | 1 | S | up to ~2.8 s of link time behind CSS/JS on a first visit, if the path honours priority | low
client-static-02 | Do not download the 388 KB italic font for the grey system lines | 3 | S | 388 KB (~3.1 s at 1 Mbit/s) off most first visits, no swap of system lines | medium
client-static-03 | Load tus.min.js on the first upload, not as a parser-blocking script at every boot | 1 | S | cold -26.8 KB gz before main.js (~215 ms); warm: no 87 KB compile per boot | high
client-static-04 | Ship the emoji-toggle sprites as lossless WebP (85.0 KB to 31.5 KB) | 1 | S | -53.4 KB per first visit (~430 ms at 1 Mbit/s) | high
client-static-05 | Compress the stylesheets and the page at a better level than Fastest | 1 | S | CSS -14.4 KB, page -4.4 KB (gzip 1 vs 6), ~150 ms cold | medium
client-static-06 | Take the Settings, channel, admin and GIF-library rules out of the render-blocking CSS | 2 | M | -18.5 KB gz from the blocking set (~150 ms cold); 527 rules not parsed before first paint | medium
client-static-07 | Strip the cover art from notif.mp3 and re-encode it (43.9 KB to 9.8 KB) | 1 | S | -11.4 KB lossless, -34 KB at 96 kb/s, at the first tap of a first visit | high
client-static-08 | Register the worker after the first server rows, so its install does not download media during the first visit's bootstrap | 1 | S | ~108 KB (~0.9 s at 1 Mbit/s) moved behind the first rows | medium
client-static-09 | Let profile pictures paint from the cache while they revalidate (stale-while-revalidate) | 1 | S | avatars paint at once instead of ~1 RTT (900 ms far user) at opens after 5 min | medium
client-static-10 | Give the wwwroot images and the sound a Cache-Control, so a deploy does not cost a revalidation | 1 | S | unknown; up to 1 RTT before the Tea House scene after a deploy | low
client-static-11 | Use overflow-x clip on .message-content, so a row's text is not a scroll container | 1 | S | unknown; one scroll container less per row | low
client-static-12 | Build the hover bar's buttons when the bar first shows, like the quick reactions | 2 | M | 12 of 17 to 23 elements per drawn row, 2-3 listeners, 1 stacking context | medium
client-static-13 | Remove the indentation text nodes and comments from the templates once, not in every clone | 1 | S | row clone 84 nodes to 39 | medium
client-static-14 | Cap the rows kept in the DOM; per-row content-visibility does not fit this row design | 2 | L | unknown; bounds re-layout and re-style cost for long reads back | low
client-static-15 | Serve the nine stylesheets as one file, joined at startup like the import map | 2 | M | -3.5 to -6.3 KB gz, 8 requests fewer; ~1 RTT on HTTP/1.1 deployments | medium
client-static-16 | Move the Settings, channel, admin and GIF-library templates out of the page | 2 | M | page 26.3 to 16.6 KB gz on first visits and installs (~80 ms) | medium
client-static-17 | Remove the GIF spinner rules; their :has() matches every GIF row, so the spinner never shows | 1 | S | small; dead :has(), pseudo-element and two listeners per GIF row | high
client-static-18 | Replace the two per-row :has() rules with classes the renderer already knows | 1 | S | unknown, small; fewer :has() subjects per row | low
client-static-19 | Collapse the send and GIF buttons without animating width, flex-basis and margin | 3 | S | unknown; ~9 frames of composer re-layout at the first key press and after sends | low
client-static-20 | Name the transitioned properties instead of `transition: all` in the sidebar rows | 1 | S | small | medium
client-static-21 | Measure the blur over the animated GIF tiles of the GIF picker; show a still picture if it is costly | 3 | S | unknown; per-frame blur of several animated tiles | low
client-static-22 | Encode the Tea House strip tiles at WebP quality 85 instead of 95 | 3 | S | ~40-55 KB less per night scene, Tea House users | medium
client-static-23 | Add a metric-matched fallback face, so the swap to Inter moves no text | 1 | S | unknown; removes the swap shift if it happens after first paint | low
client-static-24 | Measure the scroll cost of the full-height masked pattern layer in the pattern themes | 2 | S | unknown; pattern themes and DM contexts only | low
