// The slow link of load.mjs and perf.mjs: a TCP proxy in this process between the browser and the server.
//
// Why a proxy and not a CDP throttle: a CDP throttle shapes the page's requests only, never the service worker's
// fetches or the WebSocket frames, and the shell caching is the worker's work. Every byte between the browser and the
// server passes the proxy, so the proxy can also kill the server side of a socket while the client side stays open
// and silent: a socket dead without a close, as after a long sleep.
//
// The server speaks HTTP/1.1 here (no TLS), so the browser has six connections and a file count costs more than it
// does over h2 in production. The numbers compare two runs on one machine; they are not production numbers.

import net from 'node:net';

// One queue per direction, shared by every connection, like one link: a chunk leaves after its time on the wire
// at the rate, never before the chunk ahead of it, plus the one-way delay. `set(null)` is a plain pass-through.
// `link` is { oneWayMs, bytesPerSec }. The counters see every byte and every HTTP request line that crosses.
export function startProxy({ port, upstream }) {
  let link = null;
  const pairs = new Set();
  const lanes = { up: { ready: 0 }, down: { ready: 0 } };
  const counts = { up: 0, down: 0, requests: 0, lines: [] };   // lines: the request lines, to see which files crossed
  // One ordered queue per direction of a connection, drained by one timer at a time: a timer per chunk would let two
  // chunks with the same expiry fire in either order and corrupt the stream.
  const forward = (from, to, lane, pair, fromClient) => {
    const queue = [];   // { chunk | null for the end, at }, in order of `at`
    let timer = null;
    const drain = () => {
      timer = null;
      while (queue.length && queue[0].at <= Date.now()) {
        const { chunk } = queue.shift();
        if (to.destroyed) continue;
        if (chunk) to.write(chunk); else to.end();
      }
      if (queue.length) timer = setTimeout(drain, Math.max(1, queue[0].at - Date.now()));
    };
    const enqueue = (chunk, at) => { queue.push({ chunk, at }); if (!timer) timer = setTimeout(drain, Math.max(1, at - Date.now())); };
    let first = true;
    from.on('data', chunk => {
      if (fromClient && first) { first = false; pair.ws = /upgrade: websocket/i.test(chunk.toString('latin1', 0, 1024)); }   // the socket's first request names it
      if (pair.hold && fromClient) return;   // blackholed: the client talks into the void
      count(chunk, fromClient, pair);
      if (!link) { to.write(chunk); return; }
      const start = Math.max(Date.now(), lane.ready);
      lane.ready = start + chunk.length * 1000 / link.bytesPerSec;
      enqueue(chunk, lane.ready + link.oneWayMs);
    });
    from.on('end', () => {
      if (pair.hold && fromClient) return;
      if (!link) { to.end(); return; }
      enqueue(null, Math.max(queue.at(-1)?.at ?? 0, Date.now() + link.oneWayMs));
    });
    // A connection that closes gives the link back the time of its chunks still waiting. The server writes whole
    // responses into this queue at once, while real TCP keeps a window in flight and stops when the peer goes. Without
    // this, a page closed during the worker's precache left seconds of bytes nobody receives on the lane, and the next
    // page on the link waited behind them (2026-11-04: the html phase of the next cold open 2.1 s late).
    return () => {
      const bytes = queue.reduce((sum, q) => sum + (q.chunk?.length ?? 0), 0);
      queue.length = 0;
      clearTimeout(timer); timer = null;
      if (link && bytes) lane.ready = Math.max(Date.now(), lane.ready - bytes * 1000 / link.bytesPerSec);
    };
  };
  // HTTP/1.1 without pipelining: a request starts a chunk of its socket, and its line is plain text. A WebSocket's
  // frames after the upgrade are masked binary and are counted as bytes only.
  const REQUEST_LINE = /(?:^|\r\n)(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \S+ HTTP\/1\.[01]\r\n/g;
  function count(chunk, fromClient, pair) {
    if (!fromClient) { counts.down += chunk.length; return; }
    counts.up += chunk.length;
    if (pair.ws && pair.counted) return;
    pair.counted = true;   // the upgrade request itself counts once
    const lines = chunk.toString('latin1').match(REQUEST_LINE) ?? [];
    counts.requests += lines.length;
    lines.forEach(l => counts.lines.push(l.trim()));
  }
  const server = net.createServer(client => {
    const upstreamSocket = net.connect(upstream, '127.0.0.1');
    const pair = { client, upstream: upstreamSocket, hold: false };
    pairs.add(pair);
    const dropUp = forward(client, upstreamSocket, lanes.up, pair, true);
    const dropDown = forward(upstreamSocket, client, lanes.down, pair, false);
    client.on('close', () => { pairs.delete(pair); upstreamSocket.destroy(); dropUp(); dropDown(); });
    client.on('error', () => client.destroy());
    upstreamSocket.on('close', () => { if (!pair.hold) client.destroy(); });
    upstreamSocket.on('error', () => { if (!pair.hold) client.destroy(); });
  });
  server.listen(port, '127.0.0.1');
  return {
    origin: `http://127.0.0.1:${port}`,
    set(l) { link = l; },
    // What crossed since the last reset: bytes each way and HTTP requests (the WebSocket upgrade included).
    counters() { return { ...counts, lines: [...counts.lines] }; },
    reset() { counts.up = 0; counts.down = 0; counts.requests = 0; counts.lines = []; },
    // What a long sleep leaves behind: the WebSocket's server side is gone while its client side stays open and
    // silent, and the idle keep-alive HTTP sockets are closed, so the page's next requests open new connections.
    blackhole() { for (const p of pairs) { if (p.ws) { p.hold = true; p.upstream.destroy(); } else { p.client.destroy(); p.upstream.destroy(); } } },
    close() { for (const p of pairs) { p.client.destroy(); p.upstream.destroy(); } server.close(); },
  };
}
