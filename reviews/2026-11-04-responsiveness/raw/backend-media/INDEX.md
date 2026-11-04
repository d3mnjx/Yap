# backend-media: index

id | title | category-guess | effort | estimated-gain (short) | confidence
--- | --- | --- | --- | --- | ---
backend-media-01 | Put the upload result in the last tus response and drop the GET /api/tus/info round trip | 1 | S | 1 RTT (~900 ms) per media send | medium
backend-media-02 | Send the first chunk with the tus create request (creation-with-upload) | 1 | S | 1 RTT (~900 ms) per media send | medium
backend-media-03 | Encode thumbnails as lossy WebP; PNG uploads give lossless 800 px files of 600 to 800 KB | 3 | S | measured 590-818 KB per PNG row picture; lossy likely 5-10x smaller; ~4-6 s per row for far reader | high
backend-media-04 | Resize every picture wider than the target, also files under 500 KB | 1 | S | up to ~2x fewer pixels per affected picture; share unknown | medium
backend-media-05 | Decode JPEGs at a reduced size for the 800 px thumbnail (TargetSize) | 1 | S | unknown; plausibly several hundred ms per photo on the send path | low
backend-media-06 | Let the waiting 800 px thumbnails go before the background 1600 px ones | 1 | S | unknown; up to one large-thumbnail time per later picture | low
backend-media-07 | Add a 400 px picture size for gallery cells of two and three per row | 2 | M | ~3-4x fewer bytes for multi-picture rows; ~2 s per 4-picture row far reader | medium
backend-media-08 | Downscale photos on the device before the upload | 3 | M | ~24-28 s less upload per 4 MB photo at 1 Mbit/s | medium
backend-media-09 | Seek before the input for the video poster frame | 1 | S | unknown; up to ~1 s per 4K clip on the send path | low
backend-media-10 | Remux small MP4 uploads with the index at the front (faststart) | 1 | S | ~1 RTT + wasted bytes at first play; measured moov-at-end on disk | medium
backend-media-11 | A .mov row points at an .mp4 that exists only after the encode; remux H.264 .mov at once | 2 | M | video plays at once instead of after seconds to minutes | medium
backend-media-12 | Run background ffmpeg and yt-dlp work at a lower CPU priority | 1 | S | unknown; protects every request during encodes on small boxes | low
backend-media-13 | Keep voice transcodes out of the queue that background GIF work fills | 1 | S | unknown; seconds in bursts, zero when quiet | low
backend-media-14 | Make the uploaded GIF's picker preview in the background; move instead of copy | 1 | S | ~0.5-3 s of the GIF sender's wait | medium
backend-media-15 | Lower the 30 s limit for turning silent video uploads into animated WebP | 3 | S | unknown; seconds of encode and MBs per reader for long silent clips | medium
backend-media-16 | Start the trending request together with the library requests at first picker open | 1 | S | 1 RTT (~900 ms) to the Browse grid | high
backend-media-17 | Send the GIF picker a lean card without tags and library-only fields | 1 | S | estimate 30-50 % of /favorites and /server bytes | medium
backend-media-18 | Read the favourites folder map once per request, not once per card | 1 | S | removes O(n^2) copies; 100+ ms CPU at 3,000 favourites (estimate) | high
backend-media-19 | Keep the first page of Klipy trending in memory for a few minutes | 3 | S | removes the server-to-Klipy call (unknown, ~100-500 ms) from picker open | medium
backend-media-20 | Do not let a slow Klipy hold back the library hits of a search for 15 s | 3 | S | up to 11 s less spinner when Klipy is slow | medium
backend-media-21 | Send provider GIFs as a lean card and send back only the source id | 1 | M | estimate ~50 KB to ~8 KB raw per page of 30; smaller send POST | medium
backend-media-22 | Start the picker's preview videos only when their card scrolls into view | 1 | S | first screen of trending ~3x sooner on a slow link; fewer decoders | medium
backend-media-23 | Keep the GIF grid when its data did not change instead of rebuilding every card | 1 | M | unknown; avoids 2 full rebuilds per reopen and per star | medium
backend-media-24 | A newly sent provider GIF is downloaded twice by every reader | 2 | M | one full GIF download per reader per new GIF | medium
backend-media-25 | Measure Klipy MP4 against the animated WebP the GIF rows load; consider MP4 rows | 3 | L | unknown; video often several times smaller; step 1 is a log line | low
backend-media-26 | Re-encode large .gif uploads with ffmpeg's native libwebp | 3 | S | unknown; commonly 2-5x smaller for multi-MB GIFs | low
backend-media-27 | Cache and shrink link-card images on the server instead of hotlinking og:image | 2 | M | ~50-300 KB to a few KB per card + no new connection | medium
backend-media-28 | Compress responses at the Optimal level instead of Fastest | 1 | S | measured gzip: 351 KB to 302 KB for the shell (-49 KB, ~0.4 s at 1 Mbit/s) | high
backend-media-29 | Look up branding overrides from a startup list, not a file-system call per request | 1 | S | small; one stat per request removed | low
backend-media-30 | Warm the per-URL disk lookups at startup, not on the first openRoom after a restart | 1 | S | small; after deploys only | low
backend-media-31 | Give icons, the sound and the theme images a cache lifetime | 1 | S | unknown; 60-181 KB theme slot + ~62 KB per deploy | low
backend-media-32 | List the uploads folder once for the admin's "find unused media" | 1 | S | removes O(rows x files) scan; seconds at size | medium
