'use strict';
/*
 * Preview the connector dashboard with a mock "connected" tunnel — no VPS, no GoLogin needed.
 *   node preview-ui.js
 * then open the printed URL and sign in as  manager / preview.
 * The IP / location / speed shown are still probed LIVE from this machine's real connection.
 */
const { startDashboard } = require('./src/dashboard');

const started = Date.now();
const cfg = {
  dealership: 'Merchant Auto',
  reps: [
    { name: 'Kary McEmery' }, { name: 'Mark Luby' }, { name: 'Lisa Petrucelli' },
    { name: 'Darryl Tavarez' }, { name: 'Mike Pergamo' }, { name: 'Toby Pena' },
  ],
  dashboard: { port: 4599, user: 'manager', pass: 'preview', displayName: 'E. Watson' },
};

function status() {
  return {
    // HONEST: this is the sample-data preview, NOT a live tunnel. The dashboard shows a "Preview (demo)" badge +
    // a banner instead of a fake green "Connected" (which previously misled a dealer into thinking they were live).
    demo: true,
    tunnel: { state: 'preview', connectedSince: started, lastHeartbeatAt: Date.now() },
    activity: { activeSessions: 2, totalRequests: 148, bytesUp: Math.round(3.4 * 1048576), bytesDown: Math.round(46.1 * 1048576) },
  };
}

startDashboard({ cfg, status, log: (...a) => console.log(new Date().toISOString(), ...a) });
console.log('Preview ready: open  http://127.0.0.1:4599   — sign in as  manager / preview');
