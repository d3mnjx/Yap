---
id: C1-29
title: List the uploads folder once for the admin's "find unused media", not once per candidate
category: 1
journey: admin
effort: S
confidence: medium
behaviour-change: none
estimated-gain: The scan is quadratic: for N candidate rows it lists the uploads folder N times. Every picture leaves three files there (original, 800 px, 1600 px), so 1,000 candidates in a folder of 3,000 files means about 3 million directory entries read. Seconds of admin wait at that size (estimate).
experiment: none
sources: [backend-media-32]
files: [Yap/Services/Media/MediaCleanupService.cs:81-99, Yap/Services/Media/MediaCleanupService.cs:146-160, Yap/Endpoints/AdminEndpoints.cs:263-264]
---

## What the code does now
- `return new(rows.Count, rows.Sum(r => BytesOf(StemOf(r.StoredFileName)!.Value)), recent);` (MediaCleanupService.cs:84).
- `private IEnumerable<string> FilesOf(Guid stem) => Directory.Exists(_uploads.Root) ? Directory.EnumerateFiles(_uploads.Root, $"{stem}*") : [];` (lines 146-147). Each call lists the folder and filters by the pattern.
- `PruneAsync` does the same per row through `DeleteFiles` (lines 92-96, 151-160).
- The admin page calls `GET /api/admin/media/unreferenced` on a button and waits for the answer (admin.js:492).

## Why it costs the user time
The admin waits for the answer of a scan whose cost grows with the number of candidates times the size of the folder.

## The change
In `CandidatesAsync` or `UnreferencedAsync`, list the folder once (`Directory.EnumerateFiles(_uploads.Root)`), group the files by `StemOf(name)`, and sum or delete per stem from that map. About 15 lines.

## Risks and what could break
None in behaviour; the file set is the same.

## How to measure it
Time the endpoint on a copy of a production uploads folder with many unused uploads.