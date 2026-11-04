# client-render: index

Reference note (not a finding): `work-count.md` counts the work for 50 rows at a reset and at an older page, and the requests a redraw issues.

id | title | category-guess | effort | estimated-gain (short) | confidence
--- | --- | --- | --- | --- | ---
client-render-01 | Sort the people list with one shared Intl.Collator and precomputed names | 1 | S | sort of 2,000 names 72.6 ms to 0.9 ms (sandbox V8 check); runs at every room switch and presence change | high
client-render-02 | Build the admin and bot badge emoji only for rows that show them | 1 | S | about 80 fewer image requests per people pass on WebKit | high
client-render-03 | Move the people window in steps of the overscan, not one row at a time | 1 | S | about 10x fewer window rebuilds while scrolling the sidebar | medium
client-render-04 | Redraw timeline rows only for the person whose profile changed | 1 | S | no full redraw for unrelated profile changes; no 570 KB JSON per bootstrap, reset and emoji use | high
client-render-05 | Refill the quick reaction buttons instead of redrawing every row when they change | 1 | S | no full timeline redraw when the top three reactions reorder | high
client-render-06 | Update only the reaction pills of a row when its reactions change | 1 | M | 2 row rebuilds per reaction tap to 0; no emoji blink or GIF restart | high
client-render-07 | Move the upload progress bar in place instead of rebuilding every pending row per progress event | 1 | S | hundreds of row rebuilds and layouts per slow upload removed | high
client-render-08 | Relabel row times only when the day changes, not every minute for every row | 1 | S | removes a per-minute walk of all loaded rows (about 7 Intl calls and a text write each) | high
client-render-09 | Compute today's and yesterday's day keys once per draw, not per row | 1 | S | up to 4 of 7 Intl calls per header row; small | medium
client-render-10 | At a reset, leave kept rows in place instead of moving every node | 1 | S | no style and layout rebuild of 50 kept rows at every open and reconnect | medium
client-render-11 | Drop the per-image load listeners in scrollToBottom; the ResizeObserver already follows | 1 | S | no image walk and no extra layout frames per image load | medium
client-render-12 | Load and play a row's GIF video only near the view | 2 | M | GIF bytes of off-screen rows no longer on the wire at open and per older page | medium
client-render-13 | Fetch the next older page as soon as the previous one lands, and keep it in memory | 2 | M | about one round trip (0.9 s) less wait per older page for fast readers | medium
client-render-14 | Load the rows up to a jumped-to message in one call, not one page per round trip | 2 | M | k round trips to 1 for a jump k pages back (about 4.75 s to 0.9 s at k = 5) | medium
client-render-15 | Strip the indentation text nodes from the message row template | 1 | S | 84 to 39 cloned nodes per row; 20 to 40 fewer kept nodes per row | medium
client-render-16 | Handle the row buttons with one delegated listener on the list | 2 | M | 200 to 500 fewer listeners per 50-row draw; small | low
client-render-17 | Keep only the most recent join and leave lines in the lobby | 3 | S | flat node count in a busy lobby | medium
client-render-18 | Build the reaction emoji picker once per page and reuse it | 1 | S | about 2,000 elements and 3,000 listeners less per reaction picker open | high
client-render-19 | Ask for the trending GIFs together with the three library lists | 1 | S | about 0.9 s less on the first GIF picker open for the far user | high
client-render-20 | Do not reload and redraw the GIF picker while it is closed, and draw once per open | 1 | S | one request less per reconnect; no hidden grid rebuilds | high
client-render-21 | On a phone, open the GIF picker only when its tab shows | 1 | S | up to 4 API requests and 30 previews less per emoji sheet open | medium
client-render-22 | Play the GIF picker's video previews only when they are near the view | 2 | M | roughly two thirds fewer preview bytes at open | medium
client-render-23 | Filter the emoji picker from a cached list of cells, not a DOM walk per keystroke | 1 | S | a few ms per keystroke on a phone (unknown) | low
client-render-24 | Show the row's medium picture in the viewer at once, then swap to the large one | 3 | S | picture visible at once instead of after the large download (seconds on a far link) | high
client-render-25 | Add stale-while-revalidate to the profile picture header | 1 | S | about 0.9 s less of empty avatars at every open after 5 minutes (far user) | medium
client-render-26 | Give grid cells a smaller picture than the 800 px medium file | 2 | L | likely half or more of the bytes of grid cells; unknown | low
client-render-27 | Update the room rows' badges in place instead of rebuilding the room list on every unread change | 1 | M | small CPU per message elsewhere; fewer image requests on WebKit | medium
client-render-28 | Redraw the status chip, the people header and the title only when their text changes | 1 | S | fewer node rebuilds and image requests per presence tick | medium
client-render-29 | Keep the theme backgrounds and the italic font in a cache that survives a deploy | 1 | S | no revalidation or re-download of about 155 KB per Tea House scene after each deploy | medium
client-render-30 | Keep the previous build's shell cache so an open page's late imports stay cache hits | 2 | M | about 0.9 s plus transfer less at the first picker or page open after a deploy | medium
client-render-31 | Answer the root URL from the stored shell for a signed-in device | 2 | M | one round trip plus the page download less before paint at `/` (about 1 s or more) | medium
client-render-32 | Start the new build's precache after the first rows, not during the boot | 2 | M | about 2 s less link contention on the first load after a deploy; unknown | low
client-render-33 | Evict the worker's emoji memory one entry at a time, not all at once | 1 | S | avoids a full re-read of the rows' emoji after browsing the picker; rare | low
client-render-34 | Size the draft box without a forced layout on every keystroke | 1 | S | input latency on phones; unknown | low
client-render-35 | Do not reload the Settings GIF library on every bootstrap, and debounce its filter | 1 | S | one request less per reconnect while Settings is open | medium
