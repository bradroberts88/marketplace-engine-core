'use strict';
/*
 * First-run setup screen — shown when the app has NO config.json (a fresh dealership install). The dealership
 * types the one-time setup code from their onboarding email; we redeem it against the tunnel's public claim
 * endpoint (src/claim.js), write config.json, and electron-main relaunches into the real connector. This is the
 * self-serve replacement for the hand-placed config.json + Configure-AutoPost.cmd.
 */
const http = require('http');
const path = require('path');
const { claim } = require('./src/claim');

const PORT = (process.env.AUTOPOST_DASH_PORT && Number(process.env.AUTOPOST_DASH_PORT)) || 4599;
const CLAIM_URL = process.env.AUTOPOST_CLAIM_URL || 'https://marketplaceautopost.com/claim';
const CONFIG_PATH = process.env.CONNECTOR_CONFIG || path.join(__dirname, 'config.json');
const log = (...a) => console.log(new Date().toISOString(), '[firstrun]', ...a);

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Set up AutoPost</title>
<style>
  :root{--brand:#6a5bf0;--brand2:#8f7cf6;--bg:#10142c;--panel:#1a2044;--ink:#eef1fb;--muted:#98a1c9;--line:#2a3366;--good:#3ccfad;--bad:#f4788a}
  *{box-sizing:border-box}
  html,body{height:100%}
  body{margin:0;display:grid;place-items:center;background:radial-gradient(900px 500px at 50% -10%,#1c2350,var(--bg)) fixed;
    color:var(--ink);font-family:"Segoe UI Variable","Segoe UI",system-ui,-apple-system,sans-serif}
  .card{width:min(440px,92vw);background:var(--panel);border:1px solid var(--line);border-radius:18px;
    box-shadow:0 20px 60px rgba(4,7,22,.55);padding:34px 34px 30px}
  .mark{width:44px;height:44px;border-radius:12px;display:grid;place-items:center;color:#fff;font-weight:800;font-size:22px;
    background:linear-gradient(135deg,var(--brand),var(--brand2));box-shadow:0 8px 20px rgba(106,91,240,.45);margin-bottom:16px}
  h1{margin:0 0 6px;font-size:22px;letter-spacing:-.02em}
  p.lede{margin:0 0 22px;color:var(--muted);font-size:14.5px;line-height:1.5}
  label{display:block;font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin:0 0 8px}
  input{width:100%;padding:15px 16px;border-radius:12px;border:1.5px solid var(--line);background:#0e1330;color:var(--ink);
    font-size:22px;letter-spacing:.18em;text-align:center;text-transform:uppercase;font-family:"Cascadia Code",ui-monospace,monospace;outline:none}
  input:focus{border-color:var(--brand)}
  button{width:100%;margin-top:16px;padding:14px 16px;border:0;border-radius:12px;font-size:15.5px;font-weight:650;cursor:pointer;
    color:#fff;background:linear-gradient(135deg,var(--brand),var(--brand2));box-shadow:0 8px 20px rgba(106,91,240,.4)}
  button:disabled{opacity:.6;cursor:default}
  .msg{margin-top:16px;min-height:20px;font-size:14px;text-align:center}
  .msg.bad{color:var(--bad)} .msg.good{color:var(--good)}
  .foot{margin-top:20px;color:var(--muted);font-size:12.5px;text-align:center;line-height:1.5}
</style></head><body>
  <div class="card">
    <div class="mark">◈</div>
    <h1>Set up AutoPost</h1>
    <p class="lede">Enter the one-time <b>setup code</b> from your onboarding email. This connects this computer so
      your listings post from your dealership&rsquo;s own internet.</p>
    <form id="f" autocomplete="off">
      <label for="c">Setup code</label>
      <input id="c" name="c" placeholder="XXXX-XXXX" maxlength="12" autofocus>
      <button id="b" type="submit">Connect</button>
    </form>
    <div id="m" class="msg"></div>
    <div class="foot">No code, or it won&rsquo;t connect? Contact your account manager.</div>
  </div>
<script>
  var f=document.getElementById('f'),c=document.getElementById('c'),b=document.getElementById('b'),m=document.getElementById('m');
  c.addEventListener('input',function(){var v=c.value.toUpperCase().replace(/[^0-9A-Z]/g,'');if(v.length>4)v=v.slice(0,4)+'-'+v.slice(4,8);c.value=v;});
  f.addEventListener('submit',function(e){e.preventDefault();var code=c.value.trim();if(!code){m.className='msg bad';m.textContent='Enter your setup code.';return;}
    b.disabled=true;m.className='msg';m.textContent='Connecting…';
    fetch('/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:code})})
      .then(function(r){return r.json();}).then(function(d){
        if(d&&d.ok){m.className='msg good';m.textContent='Connected to '+(d.dealership||'your dealership')+'. Starting AutoPost…';}
        else{m.className='msg bad';m.textContent=(d&&d.error)||'Setup failed. Try again.';b.disabled=false;}
      }).catch(function(){m.className='msg bad';m.textContent='Could not reach setup. Check your internet.';b.disabled=false;});
  });
</script></body></html>`;

const server = http.createServer((req, res) => {
  const url = (req.url || '').split('?')[0];
  if (req.method === 'GET' && url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(PAGE); return; }
  if (req.method === 'POST' && url === '/setup') {
    let body = ''; let done = false;
    const finish = (code, obj) => { if (done) return; done = true; res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
    req.on('data', (ch) => { body += ch; if (body.length > 4096) { finish(413, { ok: false, error: 'too large' }); try { req.destroy(); } catch (_) {} } });
    req.on('end', async () => {
      let codeVal; try { codeVal = JSON.parse(body || '{}').code; } catch (_) { return finish(400, { ok: false, error: 'Bad request.' }); }
      if (!codeVal) return finish(400, { ok: false, error: 'Enter your setup code.' });
      try {
        const cfg = await claim({ claimUrl: CLAIM_URL, code: codeVal, configPath: CONFIG_PATH });
        log('setup code accepted -> configured for', cfg.dealership || cfg.dealershipId);
        finish(200, { ok: true, dealership: cfg.dealership || cfg.dealershipId || 'your dealership' });
      } catch (e) {
        log('setup failed:', e.reason || e.message);
        const msg = e.reason === 'already_claimed' ? 'That code was already used. Ask your account manager for a new one.'
          : e.reason === 'expired' ? 'That code has expired. Ask your account manager for a new one.'
          : e.reason === 'not_found' || e.reason === 'malformed' ? 'That code was not recognized. Check for typos.'
          : e.reason === 'rate_limited' || e.reason === 'too_many_attempts' ? 'Too many tries. Wait a minute and try again.'
          : (e.message || 'Setup failed. Check your internet and try again.');
        finish(400, { ok: false, error: msg });
      }
    });
    req.on('error', () => finish(400, { ok: false, error: 'Request error.' }));
    return;
  }
  res.writeHead(404); res.end('not found');
});
server.listen(PORT, '127.0.0.1', () => log('setup screen on http://127.0.0.1:' + PORT + '  (claim: ' + CLAIM_URL + ')'));
