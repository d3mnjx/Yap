// Files to the TUS endpoint, with one progress figure for the whole message (IB-29 to IB-37), and one file
// with metadata for the GIF library (PK-38, ST-22). lib/tus.min.js defines `tus`.

const EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.webm', '.mov', '.avi', '.mkv'];   // IB-31
const MAX_FILES = 10;                                                                              // IB-32

// Splits a pick into the files that go to the tray and the lines of the refusal dialog (IB-35). `inTray` is
// what waits there already: the limit is per message, not per pick (IB-32).
export function check(files, maxMB, inTray = 0) {
  const accepted = [], refused = [];
  if (inTray + files.length > MAX_FILES) return { accepted: [], refused: ['Choose at most 10 files.'] };
  for (const f of files) {
    const ext = '.' + f.name.split('.').pop().toLowerCase();
    const kindOk = EXTENSIONS.includes(ext);   // the kinds of IB-31, by extension; a pasted screenshot has no name and comes as image/png
    const pasted = !f.name.includes('.') && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(f.type);
    if (!kindOk && !pasted) refused.push(`"${f.name}" — unsupported file type`);
    else if (f.size > maxMB * 1024 * 1024) refused.push(`"${f.name}" — too large (${(f.size / 1024 / 1024).toFixed(0)} MB, max ${maxMB} MB)`);
    else accepted.push(f);
  }
  return { accepted, refused };
}

// The server processes a file after its last chunk; its info appears when it is done. `reached` tells whether any
// poll got an answer: none at all means the network went away, not that the server is slow. `tick` runs on every
// poll, a sign of life for the stall check of sender.js.
async function info(uploadUrl, attempts = 30, tick = () => {}) {
  const base = uploadUrl.slice(0, uploadUrl.lastIndexOf('/'));
  const id = uploadUrl.split('/').pop();
  let reached = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(`${base}/info/${id}`, { credentials: 'same-origin' });
      reached = true;
      if (res.ok) return { info: await res.json(), reached };
    } catch { /* no answer: the network is away; the next poll may get through */ }
    tick();
    await new Promise(r => setTimeout(r, 1000));
  }
  return { info: null, reached };
}

// lib/tus.min.js loads async (index.html), so it can run after the first upload starts: the sender sends the outbox
// at boot. Every upload waits here. Without the wait, `new tus.Upload` throws, the promise of upload() never settles,
// and the sender stops for every row behind it. A failed load (no network and no cached copy) rejects; a reload
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
      endpoint, chunkSize: 5 * 1024 * 1024, retryDelays: [0, 1000, 3000], withCredentials: true,
      metadata: { filename: file.name, filetype: file.type, ...metadata },
      onError: reject,
      onSuccess: async () => { const { info: result } = await info(u.url, 60); if (result) resolve(result); else reject(new Error('timeout')); },
    });
    u.start();
  });
}

// Uploads every file; onProgress(percent, done, total). Returns { promise, cancel, giveUp }: the promise resolves
// to { files: [info], errors: [line], refused: [file], retry: [file], cancelled }. `retry` holds the files the server
// never answered for (the network, or the server, is down): they are not failures, the sender keeps them for the next
// wake-up (OF-08). `errors` are the answers that refused a file, `refused` those files. cancel() aborts the rest and resolves the promise
// at once; giveUp() does the same but keeps what is done. `metadata` goes to the server with every file (kind: 'voice').
export function upload(files, endpoint, onProgress, metadata = {}) {
  const total = files.reduce((s, f) => s + f.size, 0);
  const sent = new Array(files.length).fill(0);
  const settled = new Array(files.length);   // a file's outcome once it has one: { info } | { error, file } | { retry }
  let done = 0, cancelled = false, over = false, settle = null;
  const uploads = [];
  // Silent once the promise settled: a late poll of a given-up job must not write into the row the next job owns.
  const report = () => { if (!over) onProgress(total ? Math.round(sent.reduce((a, b) => a + b, 0) / total * 100) : 0, done, files.length); };
  const outcome = () => ({ files: settled.filter(r => r?.info).map(r => r.info), errors: settled.filter(r => r?.error).map(r => r.error),
                           refused: settled.filter(r => r?.error).map(r => r.file), retry: files.filter((f, i) => !settled[i] || settled[i].retry), cancelled });

  const startAll = () => Promise.all(files.map((file, i) => new Promise(resolve => {
    const finish = r => { settled[i] = r; resolve(r); };
    const u = new tus.Upload(file, {
      endpoint, chunkSize: 5 * 1024 * 1024, retryDelays: [0, 1000, 3000, 5000], withCredentials: true,
      metadata: { filename: file.name, filetype: file.type, ...metadata },
      onProgress: bytes => { sent[i] = bytes; report(); },
      // tus gives up after its own retries (about nine seconds). No response at all means nobody was reached. An
      // answer's body is the server's reason (a voice message on a server without ffmpeg, IB-71); tus's own message
      // wraps it in a paragraph of request details.
      onError: error => finish(error?.originalResponse ? { error: `"${file.name}" — ${error.originalResponse.getBody?.()?.trim() || error?.message || 'Upload failed'}`, file } : { retry: file }),
      onSuccess: async () => {
        done++; sent[i] = file.size; report();
        const { info: result, reached } = await info(u.url, 30, report);
        if (cancelled) return;   // the promise settled at the cancel; nobody reads this
        if (result?.type === 'error') finish({ error: `"${file.name}" — ${result.error ?? 'Upload failed'}`, file });   // the server took the file and refused it (a voice message it could not transcode)
        else if (result) finish({ info: result });
        else finish(reached ? { error: `"${file.name}" — server processing timeout`, file } : { retry: file });   // no answer at all: the network, not the server (OF-08)
      },
    });
    uploads.push(u);
    u.start();
  })));
  // tus may still be loading (tusReady). A cancel or a give-up during that wait starts nothing. A failed load settles
  // no file, so outcome() puts every file in `retry`: they go again at the next wake-up (OF-08).
  const all = tusReady().then(() => { if (!over) return startAll(); }, () => {}).then(outcome);

  const promise = new Promise(resolve => { settle = resolve; all.then(resolve); });
  // tus calls neither onSuccess nor onError after abort(), so the promise settles here.
  return {
    promise,
    cancel: () => { over = cancelled = true; uploads.forEach(u => u.abort(true).catch(() => {})); settle({ files: [], errors: [], retry: [], cancelled: true }); },   // abort(true) deletes the upload on the server (IB-34)
    // A dead socket after a network change (sender.js): what is done stays done, the rest goes again at the next
    // wake-up. abort(false): a delete would not get through either, and the server expires the part in a day.
    giveUp: () => { over = true; uploads.forEach((u, i) => { if (!settled[i]) u.abort(false).catch(() => {}); }); settle(outcome()); },
  };
}
