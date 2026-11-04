// The seed of perf.mjs: a small server with a real history, built once through the real code paths and kept, so no
// measured run seeds. 30 people, 10 rooms and 3 direct conversations, 50,000 messages: the lobby holds 20,000 (the
// busiest room, and where a person lands), nine rooms share 24,000 unevenly (the quietest has 200), and the measured
// person has three direct conversations of 2,000. About 10% of the texts carry emoji (Unicode, and the first custom
// pack's shortcodes), 5% are replies, 3% get reactions, 2% are long multi-line texts near the 4,000 limit, 50 carry a
// small picture, and the measured person sent 20 GIF files (they fill the GIF picker's Recent). No links: the sandbox
// firewall would stall the link previews.
//
// Messages go through the send route from this process with each person's cookie: one queue per conversation (a reply
// needs the id of an earlier message), every conversation at once. Pictures and GIFs go up through the tus route, as
// the composer sends them. Reactions go through the hub from a page of each reacting person, as a tap does. The
// timestamps are then spread over the last 180 days (node:sqlite on the stopped server's database), so the timeline
// shows its date lines as a real history does.
//
// The result is a folder: Data/ (yap.db and the settings files), uploads/, and seed.json (people, rooms, tokens).

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { startServer, writePng, waitTrue, sleep } from './lib.mjs';

// The settings of the seed server and of every measured server. The database is on, at the default connection string
// (Data/yap.db relative to the working directory, which is the content root). The uploads live in the root: the
// default is under wwwroot, which is a link to the worktree's own folder. No load bounds: production loads 5,000 rows
// per conversation and 90 days, which would hide half of a 180-day history; the whole seed is in memory instead.
export const SERVER_ARGS = [
  '--ChatSettings:Persistence:Enabled=true',
  '--ChatSettings:Persistence:Load:MaxMessagesPerChannel=0',
  '--ChatSettings:Persistence:Load:MaxDays=0',
  '--ChatSettings:UploadsPath=uploads',
];

const PEOPLE = ['ada', 'ben', 'cleo', 'dan', 'eva', 'finn', 'gia', 'hugo', 'ivy', 'jack', 'kai', 'lena', 'milo', 'nora', 'omar',
  'pia', 'quinn', 'rosa', 'sam', 'tara', 'uma', 'vic', 'wes', 'xena', 'yuri', 'zoe', 'abe', 'bea', 'cal', 'dora'];
const MEASURED = 'ada';   // the first sign-in, so the admin who creates the rooms; the person every journey is
const ROOMS = [['lobby', 20000], ['dev', 8000], ['design', 5000], ['random', 3500], ['music', 2500], ['games', 2000],
  ['food', 1500], ['travel', 800], ['books', 500], ['pets', 200]];
const QUIET = 'pets';
const DMS = [['ben', 2000], ['cleo', 2000], ['dan', 2000]];   // the measured person's direct conversations
const IMAGES = 50, GIFS = 20, SPREAD_DAYS = 180;

// ---- the text ----

// A fixed seed: two seeds built from the same code hold the same history.
function random(seed) {
  return () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const rnd = random(20261104);
const pick = list => list[Math.floor(rnd() * list.length)];
const between = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

const WORDS = ('the a to and of in is it you that we for on this was with but not are have be just so at like what can about ' +
  'think know really time get one all would there they if out up my do your more when no will now some how good people ' +
  'today tomorrow week build test deploy fix bug server phone app release meeting lunch coffee music game play read book ' +
  'trip train weather idea plan maybe sure yes nice cool great thanks again later soon still already never always new old ' +
  'first last next work home team design review change merge branch code page room chat message picture video link note').split(' ');
const SHORT = ['ok', 'lol', 'sounds good', 'thanks!', 'nice', 'agreed', 'on it', 'haha yes', 'brb', 'same', 'done', 'why not'];
const UNICODE = ['😀', '😂', '🤣', '😅', '😊', '😍', '🤔', '😎', '🙃', '😭', '👍', '👏', '🙏', '💪', '🎉', '🔥', '❤️', '💯', '👀', '✅', '🚀', '☕', '🍕', '🌧️', '🐶'];
export const REACTIONS = ['👍', '❤️', '😂', '🎉', '🔥', '👀', '🙏', '💯'];

function sentence() {
  const words = Array.from({ length: between(3, 16) }, () => pick(WORDS));
  words[0] = words[0][0].toUpperCase() + words[0].slice(1);
  return words.join(' ') + pick(['.', '.', '.', '?', '!', '']);
}
const plain = () => rnd() < 0.15 ? pick(SHORT) : Array.from({ length: between(1, 3) }, sentence).join(' ');

// Near the 4,000-character limit, over many lines (MR-11): the rows that cost the layout most.
function long() {
  const lines = [];
  let length = 0;
  const target = between(3500, 3950);
  while (length < target) { const line = Array.from({ length: between(1, 3) }, sentence).join(' '); lines.push(line); length += line.length + 1; }
  return lines.join('\n').slice(0, 3990);
}

// 10% carry emoji: a fifth emoji only, half Unicode inside a text, the rest a pack shortcode inside a text.
function withEmoji(packCodes) {
  const r = rnd();
  if (r < 0.2) return Array.from({ length: between(1, 3) }, () => pick(UNICODE)).join('');
  if (r < 0.7 || !packCodes.length) return `${plain()} ${Array.from({ length: between(1, 2) }, () => pick(UNICODE)).join('')}`;
  return `${plain()} :${pick(packCodes)}:`;
}

// ---- the plan ----

// Who talks: a few people often, most people sometimes (weights 1/rank^0.8), the measured person in the middle.
const talk = (() => {
  const order = [...PEOPLE].sort(() => rnd() - 0.5);
  const weights = order.map((_, i) => 1 / Math.pow(i + 1, 0.8));
  const sum = weights.reduce((a, b) => a + b, 0);
  return () => { let r = rnd() * sum; for (let i = 0; i < order.length; i++) { r -= weights[i]; if (r <= 0) return order[i]; } return order.at(-1); };
})();

// Every message of every conversation, in sending order: { sender, text, reply (how many messages back, 0 for none),
// image and gif (the file's number, or null) }. Every random choice is made here, before the parallel sends, whose
// order varies from run to run: two seeds of the same code hold the same history, at the same times before their day.
function plan(packCodes) {
  const conversations = [
    ...ROOMS.map(([name, count]) => ({ kind: 'room', name, count })),
    ...DMS.map(([partner, count]) => ({ kind: 'dm', name: `@${partner}`, partner, count })),
  ];
  for (const c of conversations) {
    c.messages = Array.from({ length: c.count }, (_, i) => {
      const sender = c.kind === 'dm' ? (rnd() < 0.5 ? MEASURED : c.partner) : talk();
      const r = rnd();
      const text = r < 0.02 ? long() : r < 0.12 ? withEmoji(packCodes) : plain();
      return { sender, text, reply: i > 0 && rnd() < 0.05 ? between(1, Math.min(30, i)) : 0, image: null, gif: null };
    });
  }
  // The pictures anywhere; the GIFs in the lobby and the direct conversations, sent by the measured person.
  const all = conversations.flatMap(c => c.messages);
  pickDistinct(all, IMAGES).forEach((m, i) => { m.image = i; if (rnd() < 0.5) m.text = ''; });
  const mine = conversations.filter(c => c.name === 'lobby' || c.kind === 'dm').flatMap(c => c.messages).filter(m => m.image === null);
  pickDistinct(mine, GIFS).forEach((m, i) => { m.gif = i; m.sender = MEASURED; m.text = ''; m.reply = 0; });
  // 3% of the messages get one to three reactions; a direct message from its two people only.
  for (const c of conversations) {
    const people = c.kind === 'dm' ? [MEASURED, c.partner] : PEOPLE;
    for (const m of c.messages) {
      if (rnd() < 0.03) m.reactions = pickDistinct(people, between(1, Math.min(3, people.length))).map(p => [p, pick(REACTIONS)]);
    }
  }
  return conversations;
}

function pickDistinct(list, count) {
  const chosen = new Set();
  while (chosen.size < Math.min(count, list.length)) chosen.add(list[Math.floor(rnd() * list.length)]);
  return [...chosen];
}

// ---- the files ----

// A small GIF (one frame, four colours) without a library. The LZW stream clears its table every two pixels, so every
// code stays three bits wide: bigger than a real encoder's output, and valid for every decoder.
function gif(width, height, palette, colourAt) {
  const codes = [];
  for (let i = 0; i < width * height; i++) { if (i % 2 === 0) codes.push(4); codes.push(colourAt(i % width, Math.floor(i / width))); }
  codes.push(5);
  const bytes = [];
  let acc = 0, bits = 0;
  for (const c of codes) { acc |= c << bits; bits += 3; while (bits >= 8) { bytes.push(acc & 255); acc >>= 8; bits -= 8; } }
  if (bits) bytes.push(acc & 255);
  const blocks = [];
  for (let i = 0; i < bytes.length; i += 255) { const part = bytes.slice(i, i + 255); blocks.push(part.length, ...part); }
  const le = n => [n & 255, n >> 8];
  return Buffer.from([...Buffer.from('GIF89a'), ...le(width), ...le(height), 0x91, 0, 0, ...palette.flat(),
    0x2c, 0, 0, 0, 0, ...le(width), ...le(height), 0, 2, ...blocks, 0, 0x3b]);
}
const gifNumber = i => gif(64, 64, [[255, 255, 255], [40 + i * 10, 80, 200 - i * 8], [230, 120, 20 + i * 9], [20, 20, 20]],
  (x, y) => ((x >> (1 + i % 4)) + (y >> (1 + (i >> 2) % 3))) % 4);

// A gradient picture, a different one per number (lib.mjs writes PNG files only, so it goes through the disk).
function pngNumber(dir, i) {
  const w = 240, h = 160, rgb = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgb.set([(x + i * 37) % 256, (y * 2 + i * 11) % 256, (i * 53) % 256], (y * w + x) * 3);
  return fs.readFileSync(writePng(path.join(dir, `seed-${i}.png`), w, h, rgb));
}

// ---- the server's routes ----

function client(base, token) {
  const cookie = `yap_auth=${token}`;
  async function call(method, url, body) {
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(base + url, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      if (res.ok) return res.status === 204 ? null : res.json();
      if (attempt === 3) throw new Error(`${method} ${url}: ${res.status} ${(await res.text()).slice(0, 200)}`);
      await sleep(500);
    }
  }
  // tus by hand (creation, one PATCH, then the info poll of upload.js): the route the composer uses, without its library.
  async function upload(name, type, bytes) {
    const meta = Object.entries({ filename: name, filetype: type }).map(([k, v]) => `${k} ${Buffer.from(v).toString('base64')}`).join(',');
    const created = await fetch(`${base}/api/tus`, { method: 'POST', headers: { cookie, 'Tus-Resumable': '1.0.0', 'Upload-Length': String(bytes.length), 'Upload-Metadata': meta } });
    if (created.status !== 201) throw new Error(`tus create: ${created.status}`);
    const location = new URL(created.headers.get('location'), base).href;
    const patched = await fetch(location, { method: 'PATCH', headers: { cookie, 'Tus-Resumable': '1.0.0', 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream' }, body: bytes });
    if (patched.status !== 204) throw new Error(`tus patch: ${patched.status}`);
    const id = location.split('/').pop();
    for (let i = 0; i < 120; i++) {
      const res = await fetch(`${base}/api/tus/info/${id}`, { headers: { cookie } });
      if (res.ok) return res.json();
      await sleep(250);
    }
    throw new Error(`tus info: no answer for ${name}`);
  }
  return { get: url => call('GET', url), post: (url, body) => call('POST', url, body), upload };
}

// The sign-in route sets the cookie; its value is the account's token, which seed.json keeps.
export async function signInToken(base, username) {
  const res = await fetch(`${base}/api/auth/signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username }) });
  const token = res.headers.getSetCookie().map(c => /^yap_auth=([^;]+)/.exec(c)?.[1]).find(Boolean);
  if (!res.ok || !token) throw new Error(`sign-in of ${username}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return token;
}

// ---- the seed ----

export async function buildSeed({ dll, wwwroot, seedDir, runsDir, port }) {
  const t0 = Date.now();
  if (fs.existsSync(seedDir)) throw new Error(`${seedDir} exists. Remove it first, or measure with it (--seed-dir).`);
  const server = await startServer({ dll, wwwroot, port, scratch: runsDir, args: SERVER_ARGS, keep: true });
  const base = server.base;
  const fixtures = fs.mkdtempSync(path.join(runsDir, 'seed-fixtures-'));
  try {
    const tokens = {};
    for (const name of PEOPLE) tokens[name] = await signInToken(base, name);   // in order: the first is the admin
    const as = Object.fromEntries(PEOPLE.map(p => [p, client(base, tokens[p])]));
    const boot = await as[MEASURED].get('/api/bootstrap');
    if (!boot.user?.isAdmin) throw new Error(`${MEASURED} is not the admin: the seed needs a fresh server`);
    const packCodes = (boot.emojiImages?.packs?.[0]?.emojis ?? []).map(e => e.shortcode);

    const rooms = { lobby: boot.rooms.find(r => r.isDefault)?.id ?? boot.rooms[0].id };
    for (const [name] of ROOMS.slice(1)) {
      rooms[name] = (await as[MEASURED].post('/api/rooms', { name, description: null, adminOnly: false, historyLimit: 'unlimited', sinceJoined: false })).id;
    }

    const conversations = plan(packCodes);
    const total = conversations.reduce((s, c) => s + c.count, 0);
    let sent = 0, images = 0, gifs = 0;
    const progress = setInterval(() => console.log(`seed: ${sent} of ${total} messages, ${images} pictures, ${gifs} GIFs`), 5000);
    await Promise.all(conversations.map(async c => {
      const own = [];
      for (const m of c.messages) {
        const body = { clientId: crypto.randomUUID(), text: m.text || null };
        if (m.reply) body.replyToId = own[own.length - m.reply];
        if (m.image !== null) { const info = await as[m.sender].upload(`picture-${m.image}.png`, 'image/png', pngNumber(fixtures, m.image)); body.images = [info.url]; images++; }
        if (m.gif !== null) { const info = await as[m.sender].upload(`gif-${m.gif}.gif`, 'image/gif', gifNumber(m.gif)); body.gifs = [{ entryId: info.gifEntryId, searchText: null }]; gifs++; }
        const url = c.kind === 'dm'
          ? `/api/dm/${m.sender === MEASURED ? c.partner : MEASURED}/messages`
          : `/api/channels/${rooms[c.name]}/messages`;
        const message = await as[m.sender].post(url, body);
        own.push(message.id);
        m.id = message.id;
        c.channelId ??= message.channelId;
        sent++;
      }
    }));
    clearInterval(progress);
    console.log(`seed: ${sent} messages sent after ${Math.round((Date.now() - t0) / 1000)} s`);

    const reactions = await react(base, tokens, conversations);
    await drained(as[MEASURED]);
    const issues = await server.stop();
    if (issues.length) console.log(`seed server problems:\n${issues.join('\n')}`);

    fs.mkdirSync(seedDir, { recursive: true });
    fs.cpSync(path.join(server.root, 'Data'), path.join(seedDir, 'Data'), { recursive: true, filter: src => !src.includes(`${path.sep}RequestLogs`) });   // the seed's own request log is no state
    fs.cpSync(path.join(server.root, 'uploads'), path.join(seedDir, 'uploads'), { recursive: true, filter: src => !src.includes(`${path.sep}tus-temp`) });
    const spread = await spreadTimestamps(path.join(seedDir, 'Data', 'yap.db'));

    const facts = {
      createdAt: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000),
      measured: MEASURED, people: PEOPLE.map(username => ({ username, token: tokens[username] })),
      lobby: { id: rooms.lobby, name: 'lobby' }, quiet: { id: rooms[QUIET], name: QUIET },
      rooms: ROOMS.map(([name, count]) => ({ id: rooms[name], name, messages: count })),
      dms: conversations.filter(c => c.kind === 'dm').map(c => ({ partner: c.partner, channelId: c.channelId, messages: c.count })),
      messages: sent, images, gifs, reactions, spread,
      bytes: { db: fs.statSync(path.join(seedDir, 'Data', 'yap.db')).size, uploads: folderBytes(path.join(seedDir, 'uploads')) },
    };
    fs.writeFileSync(path.join(seedDir, 'seed.json'), JSON.stringify(facts, null, 2));
    console.log(`seed: done in ${facts.seconds} s: ${sent} messages, ${reactions} reactions, ${images} pictures, ${gifs} GIFs; ` +
      `database ${(facts.bytes.db / 1e6).toFixed(1)} MB, uploads ${(facts.bytes.uploads / 1e6).toFixed(1)} MB, in ${seedDir}`);
    return facts;
  } finally {
    fs.rmSync(fixtures, { recursive: true, force: true });
    fs.rmSync(server.root, { recursive: true, force: true });
  }
}

// The planned reactions, each from a page of the reacting person through the hub, as a tap sends it. The measured
// person's page then marks every conversation read, so the sidebar starts without the counts the seed piled up, and
// records a few emoji uses, so the picker's Recent row has content.
async function react(base, tokens, conversations) {
  const byPerson = new Map();
  let count = 0;
  for (const m of conversations.flatMap(c => c.messages)) {
    for (const [p, emoji] of m.reactions ?? []) {
      if (!byPerson.has(p)) byPerson.set(p, []);
      byPerson.get(p).push([m.id, emoji]);
      count++;
    }
  }
  const channelIds = conversations.map(c => c.channelId);
  const browser = await chromium.launch();
  try {
    for (const person of PEOPLE) {
      const ctx = await browser.newContext();
      await ctx.addCookies([{ name: 'yap_auth', value: tokens[person], domain: '127.0.0.1', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);
      const page = await ctx.newPage();
      await page.goto(`${base}/settings`);
      const up = await waitTrue(() => page.evaluate(async () => (await import('/js/hub.js')).connected()), 20000, 200);
      if (!up) throw new Error(`no hub connection for ${person}`);
      const failed = await page.evaluate(async ({ list, read, emoji }) => {
        const hub = await import('/js/hub.js');
        let failures = 0;
        for (const [id, e] of list) if ((await hub.invoke('react', id, e))?.error) failures++;
        for (const id of read) await hub.invoke('markRead', id);
        for (const e of emoji) await hub.invoke('emojiUsed', e);
        return failures;
      }, { list: byPerson.get(person) ?? [], read: person === MEASURED ? channelIds : [], emoji: person === MEASURED ? ['👍', '😂', '🎉', '🔥', '❤️', '🙏'] : [] });
      if (failed) throw new Error(`${failed} reactions of ${person} were refused`);
      await ctx.close();
    }
  } finally { await browser.close(); }
  return count;
}

// The writer is seconds behind memory (PersistenceWriter); a stop flushes it too, but a drained queue first keeps the
// stop short. Two empty readings in a row: the read states are coalesced and flushed every 2 s.
async function drained(admin) {
  let empty = 0;
  const ok = await waitTrue(async () => {
    const d = await admin.get('/api/admin/diagnostics');
    empty = d.writer.depth === 0 ? empty + 1 : 0;
    return empty >= 2;
  }, 300_000, 3000);
  if (!ok) throw new Error('the database writer did not drain within 5 minutes');
}

// Each conversation's messages keep their order and get random times over the last 180 days: sorted uniform draws,
// so the gaps vary as in a real history (some hours busy, some days quiet). EF Core stores a DateTime as text,
// 'yyyy-MM-dd HH:mm:ss.fffffff', which sorts as it reads. The people and the rooms get a creation time before it all.
async function spreadTimestamps(file) {
  const { DatabaseSync } = await import('node:sqlite');   // here, not at the top: the module is experimental and warns when loaded
  const db = new DatabaseSync(file);
  const end = Date.now() - 10 * 60_000, start = end - SPREAD_DAYS * 86_400_000;
  const text = ms => new Date(ms).toISOString().replace('T', ' ').replace('Z', '') + '0000';
  const rows = db.prepare('SELECT Id, ChannelId, Content FROM Messages ORDER BY ChannelId, Timestamp, Id').all();
  const update = db.prepare('UPDATE Messages SET Timestamp = ? WHERE Id = ?');
  db.exec('BEGIN');
  for (let i = 0; i < rows.length;) {
    let j = i;
    while (j < rows.length && rows[j].ChannelId === rows[i].ChannelId) j++;
    // The channel ids differ between seeds; the first text of a conversation does not: it seeds the conversation's draws.
    const draw = random([...rows[i].Content ?? ''].reduce((h, ch) => Math.imul(h ^ ch.codePointAt(0), 16777619), 2166136261 ^ (j - i)));
    const times = Array.from({ length: j - i }, () => start + draw() * (end - start)).sort((a, b) => a - b);
    for (let k = i; k < j; k++) update.run(text(times[k - i]), rows[k].Id);
    i = j;
  }
  for (const [table, column] of [['Users', 'CreatedAt'], ['Channels', 'CreatedAt']]) {
    const has = db.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('${table}') WHERE name = '${column}'`).get().n > 0;
    if (has) db.prepare(`UPDATE ${table} SET ${column} = ?`).run(text(start - 86_400_000));
  }
  db.exec('COMMIT');
  db.close();
  return `${rows.length} messages over ${SPREAD_DAYS} days`;
}

function folderBytes(dir) {
  return fs.readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter(e => e.isFile()).reduce((sum, e) => sum + fs.statSync(path.join(e.parentPath ?? e.path, e.name)).size, 0);
}

// The facts of a seed folder; perf.mjs reads the people, rooms and tokens from here.
export function readSeed(seedDir) {
  const file = path.join(seedDir, 'seed.json');
  if (!fs.existsSync(file)) throw new Error(`${file} not found. Build a seed first: node perf.mjs --seed`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Fills a fresh content root with a copy of the seed (prepare() of startServer).
export function copySeed(seedDir) {
  return root => {
    fs.cpSync(path.join(seedDir, 'Data'), path.join(root, 'Data'), { recursive: true });
    fs.cpSync(path.join(seedDir, 'uploads'), path.join(root, 'uploads'), { recursive: true });
  };
}
