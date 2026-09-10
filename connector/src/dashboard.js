'use strict';
/*
 * Local connector dashboard — a small web UI served on 127.0.0.1 so a dealership user can log in and SEE that
 * their tunnel is healthy: connection status, this location's public IP + geo + speed, and their sales reps.
 * Started by the agent (src/agent.js). No build step, no install beyond `ws` — open the printed URL in a browser.
 *
 * `status()` is supplied by the agent and returns the LIVE tunnel state; the network (IP/geo/latency) is probed
 * here directly, which egresses THIS machine's own connection — i.e. the dealership's real IP.
 */
const http = require('http');
const https = require('https');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ------------------------------------------------------------------ network probe (real egress)
let netCache = { ip: null, city: null, region: null, country: null, org: null, latencyMs: null, checkedAt: 0, ok: false };

function getJson(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let body = '';
    const req = https.get(url, { timeout: timeoutMs, headers: { 'user-agent': 'connector-dashboard' } }, (res) => {
      res.on('data', (d) => { if (body.length < 8000) body += d; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (_) { resolve(null); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}
function tcpLatency(host, port = 443, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.connect({ host, port }, () => { resolve(Date.now() - t0); s.destroy(); });
    s.setTimeout(timeoutMs, () => { s.destroy(); resolve(null); });
    s.on('error', () => resolve(null));
  });
}
async function refreshNetwork() {
  // Resolve the public IP/geo. PRIMARY = geo.myip.link: it is the same service our anti-detect browser +
  // Facebook's path resolve, so the dashboard shows the SAME location Facebook actually sees — and it is far
  // more accurate than ipapi.co for carrier/mobile IPs (ipapi mislocated an AT&T IP to "Los Angeles" while
  // geo.myip.link + ipinfo both give the correct San Diego). geo.myip.link has no ISP field, so we fill the
  // provider name from ipinfo. ipapi.co / ipify remain last-resort fallbacks. First success wins.
  let geo = null;
  const g = await getJson('https://geo.myip.link');
  if (g && g.ip && !g.error) geo = { ip: g.ip, city: g.city, region: g.stateProv || g.region, country: g.country, org: g.org || null };
  if (!geo || !geo.org) {
    const b = await getJson('https://ipinfo.io/json');
    if (b && b.ip && !b.error && b.status !== 429) {
      if (!geo) geo = { ip: b.ip, city: b.city, region: b.region, country: b.country, org: b.org };
      else geo.org = b.org || geo.org; // keep geo.myip.link's city/region, add ipinfo's ISP name
    }
  }
  if (!geo) {
    const a = await getJson('https://ipapi.co/json/');
    if (a && a.ip && !a.error) geo = { ip: a.ip, city: a.city, region: a.region, country: a.country, org: a.org || a.org_name || a.asn };
  }
  if (!geo) {
    const c = await getJson('https://api.ipify.org?format=json');
    if (c && c.ip) geo = { ip: c.ip, city: null, region: null, country: null, org: null };
  }
  const latency = await tcpLatency('www.facebook.com', 443);
  if (geo && geo.ip) {
    netCache = { ip: geo.ip, city: geo.city || null, region: geo.region || null, country: geo.country || null, org: geo.org || null, latencyMs: latency, checkedAt: Date.now(), ok: true };
  } else {
    // A transient probe failure must NOT blank the card — keep the last known IP/geo.
    netCache = { ...netCache, latencyMs: latency, checkedAt: Date.now(), ok: !!netCache.ip };
  }
  return netCache;
}

// ------------------------------------------------------------------ sessions (localhost app)
const sessions = new Map(); // token -> expiresAtMs
// "Log in once" — the sign-in lasts effectively forever (10y) and is cleared only by explicit Sign out.
const SESSION_TTL_MS = 3650 * 24 * 60 * 60 * 1000;
// Persist sessions to disk so a restart / reboot / sleep keeps the user signed in (no re-login ever).
const SESSION_FILE = path.join(__dirname, '..', '.dashboard-session.json');
function loadSessions() {
  try { const o = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); for (const [t, exp] of Object.entries(o)) sessions.set(t, Number(exp)); } catch (_) { /* none yet */ }
}
function saveSessions() {
  try { fs.writeFileSync(SESSION_FILE, JSON.stringify(Object.fromEntries(sessions)), { mode: 0o600 }); } catch (_) { /* best effort */ }
}
function cookieToken(req) { const m = /(?:^|;\s*)ds=([a-f0-9]+)/.exec(req.headers.cookie || ''); return m ? m[1] : null; }
function isAuthed(req) {
  const t = cookieToken(req);
  if (!t) return false;
  const exp = sessions.get(t);
  if (!exp) return false;
  if (Date.now() > exp) { sessions.delete(t); return false; }
  return true;
}
// Only serve requests addressed to loopback (defeats DNS-rebinding of a public name onto 127.0.0.1).
function hostOk(req) {
  const name = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return name === '127.0.0.1' || name === 'localhost' || name === '::1';
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (d) => { if (b.length < 4000) b += d; }); req.on('end', () => resolve(b));
  });
}

// ------------------------------------------------------------------ views
const STYLE = [
  ':root{--bg:#12162e;--bg2:#171d3a;--card:#1f2547;--card2:#252c54;--ink:#eef1fb;--muted:#98a1c9;--line:#2b3466;',
  '--accent:#8f9cf6;--accent2:#b9a5f4;--good:#43d6a0;--warn:#f4c36a;--bad:#f27a9c;--r:18px;--sh:0 14px 34px rgba(6,9,26,.45)}',
  '@media (prefers-color-scheme:light){:root{--bg:#eceffa;--bg2:#f5f7fd;--card:#ffffff;--card2:#f5f6fc;--ink:#1a2048;--muted:#5c6595;--line:#e4e7f4;--sh:0 12px 30px rgba(60,70,120,.14)}}',
  ':root[data-theme="dark"]{--bg:#12162e;--bg2:#171d3a;--card:#1f2547;--card2:#252c54;--ink:#eef1fb;--muted:#98a1c9;--line:#2b3466;--sh:0 14px 34px rgba(6,9,26,.45)}',
  ':root[data-theme="light"]{--bg:#eceffa;--bg2:#f5f7fd;--card:#ffffff;--card2:#f5f6fc;--ink:#1a2048;--muted:#5c6595;--line:#e4e7f4;--sh:0 12px 30px rgba(60,70,120,.14)}',
  '*{box-sizing:border-box}html,body{margin:0}body{background:radial-gradient(1200px 600px at 12% -8%,var(--bg2),var(--bg));color:var(--ink);',
  'font-family:"Segoe UI Variable","Segoe UI",system-ui,-apple-system,Roboto,sans-serif;min-height:100vh;-webkit-font-smoothing:antialiased}',
  '.wrap{max-width:1120px;margin:0 auto;padding:22px 26px 40px}',
  '.tabular{font-variant-numeric:tabular-nums}',
  // paused banner
  '.banner{background:rgba(244,195,106,.16);border:1px solid rgba(244,195,106,.55);color:#f4c36a;border-radius:14px;padding:14px 18px;margin-bottom:16px;font-size:14.5px;font-weight:600;display:flex;align-items:center;gap:10px}',
  '.banner b{color:inherit;font-weight:800}',
  '@media(prefers-color-scheme:light){.banner{color:#8a5300;background:rgba(212,145,20,.15);border-color:rgba(212,145,20,.5)}}',
  ':root[data-theme="dark"] .banner{color:#f4c36a;background:rgba(244,195,106,.16);border-color:rgba(244,195,106,.55)}',
  ':root[data-theme="light"] .banner{color:#8a5300;background:rgba(212,145,20,.15);border-color:rgba(212,145,20,.5)}',
  // top bar
  '.top{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:22px}',
  '.brand{display:flex;align-items:center;gap:11px;font-weight:650;letter-spacing:.2px}',
  '.mark{width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,var(--accent),var(--accent2));display:grid;place-items:center;color:#0e1230;font-weight:800;box-shadow:0 4px 12px rgba(143,156,246,.4)}',
  '.brand small{display:block;color:var(--muted);font-weight:500;font-size:12px;letter-spacing:.3px}',
  '.top-r{display:flex;align-items:center;gap:14px}',
  '.pill{display:inline-flex;align-items:center;gap:8px;padding:7px 14px;border-radius:999px;font-size:13px;font-weight:600;border:1px solid var(--line);background:var(--card)}',
  '.dot{width:9px;height:9px;border-radius:50%;box-shadow:0 0 0 4px transparent}',
  '.dot.g{background:var(--good);box-shadow:0 0 0 4px rgba(67,214,160,.16)}.dot.a{background:var(--warn);box-shadow:0 0 0 4px rgba(244,195,106,.16)}.dot.b{background:var(--bad);box-shadow:0 0 0 4px rgba(242,122,156,.16)}',
  '.who{color:var(--muted);font-size:14px}.who b{color:var(--ink);font-weight:600}',
  '.ghost{background:transparent;border:1px solid var(--line);color:var(--muted);padding:7px 12px;border-radius:10px;cursor:pointer;font:inherit;font-size:13px}',
  '.ghost:hover{color:var(--ink);border-color:var(--accent)}',
  // hero
  '.hero{display:grid;grid-template-columns:1.55fr 1fr;gap:16px;margin-bottom:16px}',
  '.h-main{background:linear-gradient(150deg,#20264d,#1a2044 55%,#181f4a);border:1px solid #2b3466;border-radius:var(--r);padding:26px 28px;box-shadow:var(--sh);position:relative;overflow:hidden}',
  '.h-main:after{content:"";position:absolute;right:-60px;top:-60px;width:220px;height:220px;border-radius:50%;background:radial-gradient(circle,rgba(143,156,246,.28),transparent 70%)}',
  // The hero is a committed dark card in both themes, so its text is ALWAYS light (never the themed --ink).
  '.eyebrow{text-transform:uppercase;letter-spacing:1.4px;font-size:11px;color:#9aa4d6;font-weight:600}',
  '.ip{font-size:52px;font-weight:750;letter-spacing:-1px;margin:10px 0 4px;line-height:1;color:#ffffff}',
  '.h-sub{color:#b3bbe0;font-size:15px}.h-sub b{color:#ffffff;font-weight:600}',
  '.tag{display:inline-flex;align-items:center;gap:8px;margin-top:18px;padding:7px 13px;border-radius:999px;font-size:12.5px;font-weight:600;background:rgba(143,156,246,.14);color:var(--accent2);border:1px solid rgba(143,156,246,.3)}',
  '.h-side{display:grid;grid-template-rows:1fr 1fr;gap:16px}',
  '.metric{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:20px 22px;box-shadow:var(--sh);display:flex;flex-direction:column;justify-content:center}',
  '.metric .n{font-size:34px;font-weight:720;letter-spacing:-.5px;line-height:1}',
  '.metric .l{color:var(--muted);font-size:13px;margin-top:6px}',
  '.metric .n small{font-size:16px;font-weight:600;color:var(--muted);margin-left:3px}',
  // cards row
  '.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:16px}',
  '.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:18px 20px;box-shadow:var(--sh)}',
  '.card .l{color:var(--muted);font-size:12.5px;text-transform:uppercase;letter-spacing:.6px}',
  '.card .v{font-size:22px;font-weight:680;margin-top:8px;letter-spacing:-.3px}',
  '.card .v .sub{font-size:13px;color:var(--muted);font-weight:500}',
  // reps
  '.reps{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:20px 22px;box-shadow:var(--sh)}',
  '.reps-h{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:14px}',
  '.reps-h h2{margin:0;font-size:16px;font-weight:680}.reps-h span{color:var(--muted);font-size:13px}',
  '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px}',
  '.rep{display:flex;align-items:center;gap:11px;padding:13px 14px;border-radius:13px;background:var(--card2);border:1px solid var(--line)}',
  '.rep .av{width:34px;height:34px;border-radius:9px;background:linear-gradient(135deg,#2c3566,#3a3f7a);display:grid;place-items:center;font-weight:650;font-size:13px;color:var(--ink);flex:none}',
  '.rep .nm{font-weight:600;font-size:14px;line-height:1.15}.rep .st{font-size:12px;color:var(--muted);display:flex;align-items:center;gap:6px;margin-top:2px}',
  '.empty{color:var(--muted);font-size:14px;padding:8px 2px}',
  // footer
  '.foot{margin-top:18px;color:var(--muted);font-size:12.5px;display:flex;gap:16px;flex-wrap:wrap}',
  '.foot b{color:var(--ink);font-weight:600}',
  // login
  '.login{min-height:100vh;display:grid;place-items:center;padding:24px}',
  '.lcard{width:100%;max-width:390px;background:var(--card);border:1px solid var(--line);border-radius:22px;padding:32px 30px;box-shadow:var(--sh)}',
  '.lcard .mark{width:44px;height:44px;border-radius:13px;font-size:20px;margin-bottom:18px}',
  '.lcard h1{font-size:22px;margin:0 0 4px;letter-spacing:-.3px}.lcard p{margin:0 0 22px;color:var(--muted);font-size:14px}',
  '.field{margin-bottom:14px}.field label{display:block;font-size:12.5px;color:var(--muted);margin-bottom:6px;letter-spacing:.3px}',
  '.field input{width:100%;padding:12px 14px;border-radius:11px;border:1px solid var(--line);background:var(--bg2);color:var(--ink);font:inherit;font-size:15px}',
  '.field input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(143,156,246,.22)}',
  '.btn{width:100%;margin-top:8px;padding:13px;border:0;border-radius:12px;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#0e1230;font:inherit;font-weight:700;font-size:15px;cursor:pointer}',
  '.btn:hover{filter:brightness(1.05)}.err{color:var(--bad);font-size:13px;margin-top:12px;min-height:16px}',
  '@media(max-width:820px){.hero{grid-template-columns:1fr}.cards{grid-template-columns:repeat(2,1fr)}.ip{font-size:42px}}',
].join('\n');

function loginPage(dealership, err) {
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>AutoPost</title><style>' + STYLE + '</style></head><body><div class="login"><form class="lcard" id="f">'
    + '<div class="mark">◈</div><h1>' + esc(dealership) + '</h1><p>Sign in to view your dealership’s connection.</p>'
    + '<div class="field"><label>Username</label><input name="user" autocomplete="username" autofocus></div>'
    + '<div class="field"><label>Password</label><input name="pass" type="password" autocomplete="current-password"></div>'
    + '<button class="btn" type="submit">Sign in</button><div class="err" id="e">' + esc(err || '') + '</div></form>'
    + '<script>var f=document.getElementById("f");f.addEventListener("submit",function(ev){ev.preventDefault();'
    + 'var b={user:f.user.value,pass:f.pass.value};fetch("/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b)})'
    + '.then(function(r){return r.json()}).then(function(d){if(d.ok){location.href="/"}else{document.getElementById("e").textContent=d.error||"Wrong username or password."}})'
    + '.catch(function(){document.getElementById("e").textContent="Could not reach the connector."})});</script></body></html>';
}

function dashPage() {
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>AutoPost</title><style>' + STYLE + '</style></head><body><div class="wrap">'
    + '<div class="top"><div class="brand"><div class="mark">◈</div><div>AutoPost<small id="deal">Loading…</small></div></div>'
    + '<div class="top-r"><span class="pill" id="pill"><span class="dot a"></span><span id="pillt">Checking…</span></span>'
    + '<span class="who">Signed in as <b id="user">—</b></span><button class="ghost" id="out">Sign out</button></div></div>'
    + '<div class="banner" id="banner" style="display:none"></div>'
    + '<div class="hero"><div class="h-main"><div class="eyebrow">This location’s connection</div>'
    + '<div class="ip tabular" id="ip">—</div><div class="h-sub"><b id="org">—</b> <span id="loc" style="color:#9aa4d6;font-size:13.5px"></span></div>'
    + '<div class="tag" id="tag"><span class="dot a"></span><span id="tagt">Securing tunnel…</span></div></div>'
    + '<div class="h-side"><div class="metric"><div class="n tabular"><span id="lat">—</span><small>ms</small></div><div class="l" id="latl">Latency to Facebook</div></div>'
    + '<div class="metric"><div class="n tabular" id="sess">—</div><div class="l">Live rep sessions</div></div></div></div>'
    + '<div class="cards">'
    + '<div class="card"><div class="l">ISP region (approx.)</div><div class="v" id="cloc">—</div></div>'
    + '<div class="card"><div class="l">Speed</div><div class="v" id="cspd">—</div></div>'
    + '<div class="card"><div class="l">Provider</div><div class="v" id="corg">—</div></div>'
    + '<div class="card"><div class="l">Reps online</div><div class="v tabular" id="crep">—</div></div></div>'
    + '<div class="reps"><div class="reps-h"><h2>Sales reps</h2><span id="repc"></span></div><div class="grid" id="grid"><div class="empty">Loading…</div></div></div>'
    + '<div class="foot"><span>Uptime <b id="up">—</b></span><span>Traffic <b id="tp">—</b></span><span>Requests <b class="tabular" id="rq">—</b></span><span id="upd"></span></div>'
    + '</div><script>' + DASH_JS + '</script></body></html>';
}

const DASH_JS = [
  'function q(id){return document.getElementById(id)}',
  'function ago(ms){if(!ms)return "—";var s=Math.max(0,(Date.now()-ms)/1000);if(s<60)return Math.floor(s)+"s";if(s<3600)return Math.floor(s/60)+"m "+Math.floor(s%60)+"s";var h=Math.floor(s/3600);return h+"h "+Math.floor((s%3600)/60)+"m"}',
  'function mb(b){if(!b)return "0 MB";if(b<1048576)return (b/1024).toFixed(0)+" KB";return (b/1048576).toFixed(1)+" MB"}',
  'function latLabel(x){if(x==null)return ["—",""];if(x<70)return ["Fast","g"];if(x<160)return ["Good","g"];if(x<350)return ["Fair","a"];return ["Slow","b"]}',
  'function initials(n){return n.split(" ").filter(Boolean).slice(0,2).map(function(w){return w[0]}).join("").toUpperCase()}',
  'q("out").addEventListener("click",function(){fetch("/logout",{method:"POST"}).then(function(){location.href="/"})});',
  'function setPill(el,tel,state){var map={connected:["g","Connected"],connecting:["a","Reconnecting…"],offline:["b","Offline"],preview:["a","Preview (demo)"]};var m=map[state]||map.offline;el.className="dot "+m[0];tel.textContent=m[1]}',
  'function render(d){',
  '  q("deal").textContent=d.dealership||"Dealership";q("user").textContent=d.user||"—";',
  '  var paused=!!d.paused;var demo=!!d.demo;',
  '  var t=(d.tunnel&&d.tunnel.state)||"offline";',
  '  if(demo){q("pill").firstChild.className="dot a";q("pillt").textContent="Preview (demo)"}else if(paused){q("pill").firstChild.className="dot a";q("pillt").textContent="Paused"}else{setPill(q("pill").firstChild,q("pillt"),t)}',
  '  var bn=q("banner");if(demo){bn.style.display="flex";bn.innerHTML=\'<span class="dot a"></span><span>This is a <b>preview</b> with sample data, not a live connection. Enter your setup code to connect your dealership.</span>\'}else if(paused){bn.style.display="flex";bn.innerHTML=\'<span class="dot a"></span><span>Access is <b>paused</b>. Traffic is not exiting from this location right now. Contact support to turn it back on.</span>\'}else{bn.style.display="none"}',
  '  var net=d.network||{};q("ip").textContent=net.ip||"Checking\\u2026";',
  '  var loc=[net.city,net.region].filter(Boolean).join(", ");q("loc").textContent=loc?("\\u00b7 ISP region: "+loc+" (approx.)"):"";q("cloc").textContent=loc||"\\u2014";',
  '  q("org").textContent=(net.org||"").replace(/^AS\\d+\\s*/,"")||"—";q("corg").textContent=(net.org||"—").replace(/^AS\\d+\\s*/,"");',
  '  q("lat").textContent=net.latencyMs==null?"—":net.latencyMs;var ll=latLabel(net.latencyMs);q("latl").textContent="Latency to Facebook · "+ll[0];',
  '  q("cspd").innerHTML=(net.latencyMs==null?"—":net.latencyMs+" ms ")+"<span class=sub>"+ll[0]+"</span>";',
  '  var tagd=q("tag").firstChild;if(demo){tagd.className="dot a";q("tagt").textContent="Preview mode. Not connected to the network yet."}else if(paused){tagd.className="dot a";q("tagt").textContent="Access paused. Contact support to re-enable."}else if(t==="connected"){tagd.className="dot g";q("tagt").textContent="Tunnel secured. Traffic exits from your own connection."}else if(t==="connecting"){tagd.className="dot a";q("tagt").textContent="Reconnecting to the network\\u2026"}else{tagd.className="dot b";q("tagt").textContent="Tunnel offline. Reps are paused."}',
  '  var reps=d.reps||[];var online=reps.filter(function(r){return r.status==="active"||r.status==="ready"}).length;',
  '  q("sess").textContent=(d.activity&&d.activity.activeSessions)||0;q("crep").innerHTML=online+"<span class=sub> / "+reps.length+"</span>";q("repc").textContent=reps.length+" configured";',
  '  var g=q("grid");if(!reps.length){g.innerHTML=\'<div class="empty">No reps configured yet. They\\u2019ll appear here once added.</div>\'}else{',
  '    g.innerHTML=reps.map(function(r){var s=r.status||"offline";var dc=(s==="active"||s==="ready")?"g":(s==="paused"?"a":"b");var lbl=s==="active"?"Active now":(s==="ready"?"Ready":(s==="paused"?"Paused":"Offline"));',
  '      return \'<div class="rep"><div class="av">\'+initials(r.name)+\'</div><div><div class="nm">\'+r.name+\'</div><div class="st"><span class="dot \'+dc+\'"></span>\'+lbl+\'</div></div></div>\'}).join("")}',
  '  var a=d.activity||{};q("up").textContent=(d.tunnel&&d.tunnel.connectedSince)?ago(d.tunnel.connectedSince):"—";',
  '  q("tp").textContent="↑"+mb(a.bytesUp)+" · ↓"+mb(a.bytesDown);q("rq").textContent=a.totalRequests||0;q("upd").textContent="updated just now";',
  '}',
  'function tick(){fetch("/api/status").then(function(r){if(r.status===401){location.href="/";return null}return r.json()}).then(function(d){if(d)render(d)}).catch(function(){})}',
  'tick();setInterval(tick,4000);',
].join('\n');

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ------------------------------------------------------------------ server
function startDashboard({ cfg, status, log }) {
  const dcfg = cfg.dashboard || {};
  const port = dcfg.port || 4599;
  const dealership = cfg.dealership || 'Dealership';
  const user = String(dcfg.user || '');
  const pass = String(dcfg.pass || '');
  loadSessions(); // restore any prior sign-in so a restart/reboot doesn't force re-login
  refreshNetwork();
  const netTimer = setInterval(refreshNetwork, 10 * 60 * 1000); // 10 min — the public IP rarely changes; avoids provider rate limits
  if (netTimer.unref) netTimer.unref();

  const server = http.createServer(async (req, res) => {
    const send = (code, type, bodyStr) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(bodyStr); };
    try {
      if (!hostOk(req)) return send(403, 'text/plain', 'forbidden host');
      if (req.method === 'POST' && req.url === '/login') {
        const raw = await readBody(req);
        let creds = {};
        try { creds = JSON.parse(raw || '{}'); } catch (_) { creds = {}; }
        const okUser = user.length > 0 && pass.length > 0
          && safeEq(String(creds.user || '').trim().toLowerCase(), user.toLowerCase())
          && safeEq(creds.pass, pass);
        if (!okUser) return send(401, 'application/json', JSON.stringify({ ok: false, error: 'Wrong username or password.' }));
        const tok = crypto.randomBytes(24).toString('hex'); sessions.set(tok, Date.now() + SESSION_TTL_MS); saveSessions();
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'ds=' + tok + '; HttpOnly; SameSite=Strict; Path=/', 'cache-control': 'no-store' });
        return res.end(JSON.stringify({ ok: true }));
      }
      if (req.method === 'POST' && req.url === '/logout') {
        const t = cookieToken(req); if (t) { sessions.delete(t); saveSessions(); }
        return send(200, 'application/json', JSON.stringify({ ok: true }));
      }
      if (req.url === '/api/status') {
        if (!isAuthed(req)) return send(401, 'application/json', JSON.stringify({ error: 'auth' }));
        const st = (typeof status === 'function' ? status() : {}) || {};
        const tunnelState = (st.tunnel && st.tunnel.state) || 'offline';
        const paused = !!st.paused;
        const reps = (Array.isArray(cfg.reps) ? cfg.reps : []).map((r) => ({
          name: r.name || 'Rep',
          status: paused ? 'paused' : (tunnelState === 'connected' ? (r.status || 'ready') : 'offline'),
        }));
        return send(200, 'application/json', JSON.stringify({
          dealership, user: dcfg.displayName || user, now: Date.now(), paused,
          tunnel: st.tunnel || { state: 'offline' },
          activity: st.activity || { activeSessions: 0, totalRequests: 0, bytesUp: 0, bytesDown: 0 },
          network: netCache, reps,
        }));
      }
      // pages
      if (isAuthed(req)) return send(200, 'text/html; charset=utf-8', dashPage());
      return send(200, 'text/html; charset=utf-8', loginPage(dealership, ''));
    } catch (e) {
      if (log) log('dashboard error', e.message);
      try { send(500, 'text/plain', 'error'); } catch (_) { /* ignore */ }
    }
  });
  // Single-instance guard: if the dashboard port is already bound, another AutoPost agent is already running
  // on this machine (e.g. an auto-start copy + a hand-launched copy). Exit quietly instead of two agents
  // ping-ponging the same tunnel token.
  server.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE') { if (log) log('port ' + port + ' in use — another AutoPost instance is already running; exiting'); process.exit(0); }
    else if (log) log('dashboard error', e && e.message);
  });
  server.listen(port, '127.0.0.1', () => { if (log) log('dashboard on http://127.0.0.1:' + port + '  (open in a browser, sign in as "' + user + '")'); });
  return server;
}

function safeEq(a, b) {
  const ba = Buffer.from(String(a == null ? '' : a));
  const bb = Buffer.from(String(b == null ? '' : b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

module.exports = { startDashboard };
