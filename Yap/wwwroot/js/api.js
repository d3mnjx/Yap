// The HTTP side of the wire contract: JSON in, JSON out, the cookie on every request, and a refusal turned
// into a reason the page can show (GEN-02). The hub side is hub.js.

export class ApiError extends Error {
  constructor(status, reason) { super(reason); this.status = status; }
}

// Which answers come from in front of the server, not from it: a reverse proxy (Caddy, Nginx, a tunnel) answers
// 502, 503 or 504 by itself while the server behind it restarts. Yap sends none of the three. For a send that can
// wait (a message of the outbox, a file of an upload) they count as no answer at all, not as a refusal.
export const away = status => status === 502 || status === 503 || status === 504;

let signedOutHandler = () => {};
// main.js installs the handler; api.js must not import the router or the store (no cycles).
export function onSignedOut(fn) { signedOutHandler = fn; }

async function request(method, url, body) {
  const init = { method, credentials: 'same-origin' };
  if (body instanceof FormData) init.body = body;                       // the browser sets the multipart boundary
  else if (body !== undefined) { init.headers = { 'content-type': 'application/json' }; init.body = JSON.stringify(body); }

  let res;
  try { res = await fetch(url, init); }
  catch { throw new ApiError(0, 'Needs a connection'); }                // no network at all (GEN-10)

  if (res.ok) return res.status === 204 ? null : res.json();
  if (res.status === 401) signedOutHandler();                           // the cookie is gone: back to the login page
  const problem = await res.json().catch(() => null);                   // ProblemDetails; `detail` is the readable text
  throw new ApiError(res.status, problem?.detail ?? problem?.title ?? 'Something went wrong');
}

export const api = {
  get: url => request('GET', url),
  post: (url, body) => request('POST', url, body),
  put: (url, body) => request('PUT', url, body),
  patch: (url, body) => request('PATCH', url, body),
  delete: (url, body) => request('DELETE', url, body),
};
