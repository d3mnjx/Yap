---
id: client-core-24
title: Run the IPv4 beacon once per page load, not after every connect
area: client-core
journey: resume
category-guess: 2
behaviour-change: none
effort: S
estimated-gain: Small. Every reconnect today adds a hub round trip (`beaconNonce`) and a request to another host (new DNS lookup, TCP and TLS set-up, a certificate chain of a few KB) on the phone's link in the seconds when the rows and the bootstrap arrive. Off the critical path (not awaited), but it shares the 1 Mbit/s link and the radio with them. Only deployments with `Ipv4BeaconUrl` set pay it.
confidence: medium
files: [Yap/wwwroot/js/hub.js:124-131, Yap/wwwroot/js/hub.js:164-173, Yap/Endpoints/BootstrapEndpoints.cs:219]
---

## What the code does now
After each connect's bootstrap (hub.js:129) the client calls `beacon(doc.config)` (hub.js:167-173):

```js
const nonce = await invoke('beaconNonce');
if (typeof nonce !== 'string') return;
try { fetch(`${config.beaconUrl.replace(/\/+$/, '')}/api/ipv4-beacon?n=${encodeURIComponent(nonce)}`, { mode: 'no-cors', cache: 'no-store' }).catch(() => {}); }
```

The nonce is bound to the connection (ChatHub `BeaconNonce`), so the server learns the IPv4 of each new connection for the admin's Sessions table.

## Why it costs the user time
A phone reconnects many times a day. Each time, right after the socket comes up, the client spends one hub round trip and opens a connection to a second host (IPv4-only, DNS-only, so no shared connection and no Cloudflare edge). On the far link the TLS set-up alone is two round trips and a few KB. It competes with `openRoom`'s answer and the bootstrap for the link.

## The change
Client: run the beacon only on the first connect of a page load (`if (!wasReconnect) beacon(doc.config)`). Server: keep the last IPv4 per device id (the session already has `DeviceId`) and fill it into later sessions of the same device, so the admin table still shows it. An IPv4 does not change with a reconnect on the same network; a network change is the case the table would then show late.

## Risks and what could break
- After a network change without a reload, the Sessions table shows the old IPv4 until the next load. The value is display-only (admin.js says "never affects login decisions").

## How to measure it
On the far link, count the requests to the beacon host per hour of normal phone use (each resume is one today). The network panel shows the TLS set-up time of each.
