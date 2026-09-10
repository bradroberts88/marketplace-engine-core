'use strict';
/*
 * Data-plane egress + LAN-isolation guard.
 *
 * The connector may ONLY reach PUBLIC hosts. It must never be usable to reach the dealership's internal
 * network — so every outbound target is checked against private/loopback/link-local/CGNAT ranges, for BOTH
 * IPv4 and IPv6, at connect (literal host) and after connect (the resolved peer IP, which is the address that
 * actually matters since Chromium hands us a HOSTNAME and WE resolve it).
 */
const net = require('net');

function isPrivateV4(ip) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
  const p = ip.split('.').map(Number);
  if (p.some((o) => o > 255)) return true;                      // malformed → treat as unsafe
  if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;
  if (p[0] === 169 && p[1] === 254) return true;                // link-local + cloud metadata 169.254.169.254
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;   // CGNAT 100.64.0.0/10
  if (p[0] === 192 && p[1] === 0 && p[2] === 0) return true;    // 192.0.0.0/24 (IETF protocol assignments)
  if (p[0] === 198 && (p[1] === 18 || p[1] === 19)) return true; // 198.18.0.0/15 benchmarking
  if (p[0] >= 224) return true;                                 // multicast + reserved (224.0.0.0/3)
  return false;
}

// IPv6: block loopback ::1, unspecified ::, ULA fc00::/7, link-local fe80::/10, multicast ff00::/8, and
// IPv4-mapped ::ffff:a.b.c.d (defer to isPrivateV4). Only 2000::/3 is trusted global-unicast; ANYTHING else
// (including anything we cannot parse) is treated as NON-public and blocked → fail closed.
function isPrivateV6(addr) {
  let a = String(addr).toLowerCase().trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (mapped) return isPrivateV4(mapped[1]);
  if (a === '::1' || a === '::' || a === '') return true;
  const first = a.split(':')[0];
  const h = /^[0-9a-f]{1,4}$/.test(first) ? parseInt(first, 16) : NaN;
  if (Number.isNaN(h)) return true;                             // leading '::' / unparseable → unsafe
  const top8 = (h >> 8) & 0xff;
  if (top8 === 0xfc || top8 === 0xfd) return true;              // ULA fc00::/7
  if ((h & 0xffc0) === 0xfe80) return true;                     // link-local fe80::/10
  if (top8 >= 0xff) return true;                                // multicast ff00::/8
  if (h < 0x2000 || h > 0x3fff) return true;                    // not global-unicast 2000::/3 → block
  return false;
}

function isPrivateHostLiteral(host) {
  const h = String(host).replace(/^\[|\]$/g, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return isPrivateV4(h);
  if (h.includes(':')) return isPrivateV6(h);                   // bare or bracketed IPv6 literal
  return false;                                                 // hostname → allowed; re-checked by peer IP at connect
}

// A raw private literal is blocked outright; hostnames are allowed (resolved + re-checked at connect).
function isAllowedTarget(host) { return !isPrivateHostLiteral(host); }

// Is the CONNECTED peer address private? Unknown/blank peer → treat as private (fail closed).
function peerIsPrivate(sock) {
  const raw = String(sock.remoteAddress || '');
  if (!raw) return true;
  if (raw.includes(':') && !/^::ffff:\d/.test(raw)) return isPrivateV6(raw);
  return isPrivateV4(raw.replace(/^::ffff:/i, ''));
}

/**
 * Open a TCP stream to (host,port) that egresses via THIS machine's default route (the dealership's IP),
 * verify the resolved peer is a PUBLIC address, and return the socket via cb(err, socket). Rejects private
 * targets (v4 + v6). cb fires EXACTLY once (a post-connect error can't re-enter the success path).
 */
function openStream(host, port, cb) {
  let done = false;
  const finish = (err, sock) => { if (done) return; done = true; cb(err, sock); };
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return finish(new Error(`bad port ${port}`));
  if (!isAllowedTarget(host)) return finish(new Error(`blocked non-public target ${host}`));

  let sock;
  try {
    sock = net.connect({ host: String(host).replace(/^\[|\]$/g, ''), port: p }, () => {
      if (peerIsPrivate(sock)) { sock.destroy(); return finish(new Error(`resolved to private ${sock.remoteAddress}`)); }
      sock.setTimeout(0); // CONNECT-phase timeout only — do NOT idle-kill long-lived FB realtime (MQTT/chat) sockets
      finish(null, sock);
    });
  } catch (e) { return finish(new Error(`connect failed: ${e.message}`)); } // e.g. ERR_SOCKET_BAD_PORT throws sync

  sock.setTimeout(20000, () => { if (!done) sock.destroy(new Error('connect timeout')); });
  sock.on('error', (e) => finish(e));
  return sock;
}

module.exports = { openStream, isAllowedTarget, isPrivateV4, isPrivateV6 };
