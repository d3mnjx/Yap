# Responsiveness over time

`npm run perf -- --record` writes this page and one JSON file per run. Do not edit the page by hand; "The performance
harness" in `../README.md` says how to add a record.

Each row is one run of `perf.mjs` on one build: one person on a server with 50,000 messages, through three links.
The numbers are medians of the run's repetitions, in ms. The JSON file of a run holds every metric with its min
and max. A `*` after a commit marks a build with uncommitted changes to the app.

## far (900 ms round trip, 1 Mbit/s)

| date (UTC) | commit | first visit | first visit KB | warm open | resume | send: own row | send: confirmed | to the lobby | older page | emoji picker | GIF picker | machine check |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| 2026-11-04 11:37 | 7f149be4 | 18,054 | 1,006 | 3,001 | 2,979 | 1.3 | 918 | 1,164 | 1,149 | 8,648 | 927 | — |
| 2026-11-11 10:47 | 2836db63 | 18,831 | 1,037 | 3,011 | 2,976 | 1.3 | 919 | 1,167 | 1,147 | 8,667 | 929 | — |
| 2026-11-11 11:41 | 2836db63 | 18,823 | 1,037 | 3,007 | 2,980 | 1.6 | 919 | 1,165 | 1,149 | 8,665 | 931 | 155 |

## near (60 ms round trip, 20 Mbit/s)

| date (UTC) | commit | first visit | first visit KB | warm open | resume | send: own row | send: confirmed | to the lobby | older page | emoji picker | GIF picker | machine check |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| 2026-11-04 11:37 | 7f149be4 | 1,352 | 1,007 | 285 | 258 | 1.2 | 67.1 | 135 | 220 | 951 | 71.4 | — |
| 2026-11-11 10:47 | 2836db63 | 1,479 | 1,038 | 326 | 263 | 1.7 | 68.6 | 136 | 224 | 1,216 | 74.2 | — |
| 2026-11-11 11:41 | 2836db63 | 1,440 | 1,038 | 296 | 267 | 1.6 | 68.1 | 133 | 223 | 1,011 | 73.8 | 184 |

## lan (no proxy: the server and the page)

| date (UTC) | commit | first visit | first visit KB | warm open | resume | send: own row | send: confirmed | to the lobby | older page | emoji picker | GIF picker | machine check |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| 2026-11-04 11:37 | 7f149be4 | 160 | — | 75.6 | 64.7 | 1.3 | 4.1 | 43.1 | 219 | 642 | 11.9 | — |
| 2026-11-11 10:47 | 2836db63 | 248 | — | 106 | 82.2 | 2.2 | 7.7 | 73.5 | 227 | 417 | 18.4 | — |
| 2026-11-11 11:41 | 2836db63 | 271 | — | 125 | 76.2 | 1.8 | 7.3 | 67.9 | 225 | 767 | 20.6 | 181 |

## The columns

- **first visit**: A new device opens the app. From the navigation start to the server's rows on screen.
- **first visit KB**: The bytes of that first visit on the link, both ways. Not a time: it changes only when the app's files change. `lan` has no proxy to count them.
- **warm open**: A device that holds the app opens it again. From the navigation start to the server's rows on screen.
- **resume**: The app comes back after 35 s in the background with a dead socket. From the return to a message that arrived in between.
- **send: own row**: From the Enter key to the own message in the list.
- **send: confirmed**: From the Enter key to the server's confirmation on that message.
- **to the lobby**: From the click on the busiest room (20,000 messages) to its rows, with no loading mark left.
- **older page**: From the scroll to the top to the older messages in the list. It includes the 200 ms the app waits for a still view.
- **emoji picker**: The first open on a device. From the click to every visible emoji image complete. The images come from the real CDN, outside the proxy, so on `near` and `lan` this number follows the CDN and not the app.
- **GIF picker**: The first open on a device. From the click to the grid.
- **machine check**: Not the app: a fixed piece of work on a blank page, at the start of the profile. It says how fast the machine was at that minute. It moves by 20% inside one quiet run, so only a larger difference between two records means a faster or a slower machine.

How far a number moves between two records of one build on one machine: 1% on `far`, 10% on `near`, 20% on `lan`, and 20% for any time under 100 ms. A smaller change is noise. The two records of 2026-11-11 are the same build, an hour apart, and show it.
For a question about one change, measure the two builds side by side in one run (`--a` and `--b`): the noise inside a run is much smaller.

## The runs

| date (UTC) | commit | its subject | machine | Chromium | repetitions | failed runs | minutes |
| --- | --- | --- | --- | --- | --: | --: | --: |
| 2026-11-04 11:37 | 7f149be4 | Docs: the plan for the emoji warm-up, design only, nothing built | not recorded (the sandbox of the review of 2026-11-04) | 129.0.6668.29 | 5 | 0 | — |
| 2026-11-11 10:47 | 2836db63 | Spec: PK-38 and ST-22 list the file types of a GIF upload, with .apng, .avif and .m4v | linux x64, 16 x AMD Ryzen 9 9950X 16-Core Processor | 129.0.6668.29 | 5 | 0 | 33 |
| 2026-11-11 11:41 | 2836db63 | Spec: PK-38 and ST-22 list the file types of a GIF upload, with .apng, .avif and .m4v | linux x64, 16 x AMD Ryzen 9 9950X 16-Core Processor | 129.0.6668.29 | 5 | 0 | 23 |
