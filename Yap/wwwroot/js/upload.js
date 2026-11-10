// Files to the TUS endpoint: one file of a message, with its progress, which can go on from where an earlier try
// stopped (IB-29 to IB-37), and one file with metadata for the GIF library (PK-38, ST-22). lib/tus.min.js defines `tus`.

import { away } from './api.js';

const EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.webm', '.mov', '.avi', '.mkv'];   // IB-31
const MAX_FILES = 10;                                                                              // IB-32
// A pasted picture can come with a name that has no extension. The server decides by the extension of the name alone
// (TusEndpoints.cs) and refuses such a file, so the client gives the file its extension, from the type the browser reports.
const PASTED = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };

// Splits a pick into the files that go to the tray and the lines of the refusal dialog (IB-35). `inTray` is
// what waits there already: the limit is per message, not per pick (IB-32).
export function check(files, maxMB, inTray = 0) {
  const accepted = [], refused = [];
  if (inTray + files.length > MAX_FILES) return { accepted: [], refused: ['Choose at most 10 files.'] };
  for (const picked of files) {
    const f = !picked.name.includes('.') && PASTED[picked.type]
      ? new File([picked], (picked.name || 'image') + PASTED[picked.type], { type: picked.type, lastModified: picked.lastModified })
      : picked;
    const ext = '.' + f.name.split('.').pop().toLowerCase();
    if (!EXTENSIONS.includes(ext)) refused.push(`"${f.name}" — unsupported file type`);   // the kinds of IB-31, by extension
    else if (f.size > maxMB * 1024 * 1024) refused.push(`"${f.name}" — too large (${(f.size / 1024 / 1024).toFixed(0)} MB, max ${maxMB} MB)`);
    else accepted.push(f);
  }
  return { accepted, refused };
}

// The server processes a file after its last chunk; its info appears when it is done. The server answers 200 with
// the info, 202 while it still works on the file, and 404 for an upload it does not know (TusEndpoints.cs): a 404
// ends the polls at once, with no info. `reached` tells whether the server answered any poll (a proxy's answer for it does not count, `away`): none at all means
// the network or the server went away, not that the server is slow. `tick` runs on every poll, a sign of life for
// the stall check of sender.js.
async function info(uploadUrl, attempts = 30, tick = () => {}) {
  const base = uploadUrl.slice(0, uploadUrl.lastIndexOf('/'));
  const id = uploadUrl.split('/').pop();
  let reached = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(`${base}/info/${id}`, { credentials: 'same-origin' });
      if (!away(res.status)) reached = true;
      if (res.status === 200) return { info: await res.json(), reached };
      if (res.status === 404) return { info: null, reached };
    } catch { /* no answer: the network is away; the next poll may get through */ }
    tick();
    await new Promise(r => setTimeout(r, 1000));
  }
  return { info: null, reached };
}

// lib/tus.min.js loads async (index.html), so it can run after the first upload starts: the sender sends the outbox
// at boot. Every upload waits here. Without the wait, `new tus.Upload` throws, the promise of uploadFile() never
// settles, and its file holds one of the sender's upload slots for good. A failed load (no network and no cached copy) rejects; a reload
// loads the script again.
function tusReady() {
  if (window.tus) return Promise.resolve();
  const script = document.getElementById('tus-script');
  if ('failed' in script.dataset) return Promise.reject(new Error('The upload library did not load'));   // set by its onerror attribute
  return new Promise((resolve, reject) => {
    script.addEventListener('load', resolve, { once: true });
    script.addEventListener('error', () => reject(new Error('The upload library did not load')), { once: true });
  });
}

// One file with metadata (the GIF library: kind, target, folder). Resolves to the server's info object.
export async function uploadOne(file, endpoint, metadata = {}) {
  await tusReady();
  return new Promise((resolve, reject) => {
    const u = new tus.Upload(file, {
      endpoint, chunkSize: 5 * 1024 * 1024, retryDelays: [0, 1000, 3000], withCredentials: true, storeFingerprintForResuming: false,
      metadata: { filename: file.name, filetype: file.type, ...metadata },
      onError: reject,
      onSuccess: async () => { const { info: result } = await info(u.url, 60); if (result) resolve(result); else reject(new Error('timeout')); },
    });
    u.start();
  });
}

// Which answers on an upload URL mean "this URL cannot be used", not "this file is refused": 404, the server does
// not have the upload (it removed it after a day without a chunk, or it has finished it); 409 and 423, it still
// holds the lock of a request that died with the network. tus has retried 409 and 423 for nine seconds by then.
const urlGone = status => status === 404 || status === 409 || status === 423;

// One file to the TUS endpoint. Returns { promise, abort }. The promise resolves to one of
//   { info }     the server's result for the processed file;
//   { error }    the server refused the file: the line for the person;
//   { retry }    nobody answered (the network, or the server, is away): not a failure, the sender keeps the file
//                for the next wake-up (OF-08);
//   { aborted }  abort() was called.
// `url` is the upload URL of an earlier try, kept by the sender: the upload goes on from the bytes the server has.
// onUrl(url) tells the sender the URL to keep, and onUrl(null) that the kept one is of no use. onProgress(bytes)
// is the progress and also the sign of life for the sender's stall check; the polls for the result call it with
// null: no new byte, but somebody is still at work.
// abort(true) deletes the upload on the server (Cancel, IB-34); abort(false) keeps it for the next try.
export function uploadFile(file, endpoint, { metadata = {}, url = null, onUrl = () => {}, onProgress = () => {} } = {}) {
  let over = false, settle = null, current = null;
  let fresh = false;   // one upload from zero after an unusable URL; a second unusable URL is a wait, never a loop
  const promise = new Promise(resolve => { settle = resolve; });
  const finish = outcome => { if (!over) { over = true; settle(outcome); } };
  const refusal = reason => ({ error: `"${file.name}" — ${reason}` });

  // The server processes the file after its last byte; the result appears when it is done.
  const result = async at => {
    const { info: got, reached } = await info(at, 30, () => { if (!over) onProgress(null); });
    if (got?.type === 'error') return refusal(got.error ?? 'Upload failed');   // the server took the file and refused it (a voice message it could not transcode)
    if (got) return { info: got };
    return reached ? null : { retry: true };   // null: the server answers and has no result (it does not know the upload, or it never finished the file)
  };

  const fromZero = () => {
    if (fresh) { finish({ retry: true }); return; }
    fresh = true;
    onUrl(null);
    attempt(null);
  };

  const attempt = from => {
    const u = current = new tus.Upload(file, {
      endpoint: from ? null : endpoint, uploadUrl: from,
      chunkSize: 5 * 1024 * 1024, retryDelays: [0, 1000, 3000, 5000],
      storeFingerprintForResuming: false,   // the sender keeps the URL with the outbox row; tus's own copy in localStorage was never read or removed
      metadata: { filename: file.name, filetype: file.type, ...metadata },
      onUploadUrlAvailable: () => {
        // From here tus has no endpoint. With one, it answers a 404 on the HEAD of a retry by creating a new upload
        // by itself, and a 404 there can also mean "finished": the server moves a finished file out of the tus
        // store (TusEndpoints.cs). A last chunk whose answer was lost would go again from zero, as a second copy.
        // Without an endpoint the 404 comes to onError, which asks for the result first.
        u.options.endpoint = null;
        onUrl(u.url);
      },
      onProgress: bytes => { if (!over) onProgress(bytes); },
      // tus gives up after its own retries (about nine seconds). No response at all means nobody was reached, and
      // so does the answer of a proxy for a server that restarts (`away`): the file waits with its URL, and goes on
      // from the server's bytes when the server is back. An answer's body is the server's reason (a voice message on
      // a server without ffmpeg, IB-71); tus's own message wraps it in a paragraph of request details.
      onError: async error => {
        if (over) return;
        const response = error?.originalResponse;
        if (!response || away(response.getStatus())) { finish({ retry: true }); return; }
        if (!urlGone(response.getStatus())) { finish(refusal(response.getBody?.()?.trim() || error?.message || 'Upload failed')); return; }
        // The HEAD that asks how far the upload is got a 404: the upload is finished, or the server does not have
        // it. The result endpoint tells which: the result, "still at work", or at once "unknown".
        if (response.getStatus() === 404 && error.originalRequest?.getMethod() === 'HEAD') {
          const done = await result(u.url);
          if (over) return;
          if (done) { finish(done); return; }
        }
        fromZero();
      },
      onSuccess: async () => {
        if (over) return;
        onProgress(file.size);
        finish(await result(u.url) ?? refusal('server processing timeout'));
      },
    });
    u.start();
  };

  // tus may still be loading (tusReady). An abort during that wait starts nothing. A failed load is a wait: the
  // file goes again at the next wake-up (OF-08).
  tusReady().then(() => { if (!over) attempt(url); }, () => finish({ retry: true }));

  return {
    promise,
    // tus calls neither onSuccess nor onError after abort(), so the promise settles here.
    abort: discard => { current?.abort(discard).catch(() => {}); finish({ aborted: true }); },
  };
}
