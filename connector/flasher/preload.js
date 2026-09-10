'use strict';
/*
 * flasher/preload.js — the ONLY bridge between the flasher UI (renderer, no Node access) and the main process.
 * Exposes a tiny, explicit API over contextBridge. The renderer can ASK main to scan/dry-run/flash/verify; it can
 * never touch a disk itself. All the dangerous capability stays in main-flasher.js + the elevated writer.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('flasher', {
  scanDrives: () => ipcRenderer.invoke('flasher:scanDrives'),
  dryRun: (form) => ipcRenderer.invoke('flasher:dryRun', form),
  // ONE native "erase these N cards" dialog for a whole batch -> a token each flash() presents instead of
  // popping its own modal. Cancelling mints no token, so nothing can be written.
  confirmBatch: (targets) => ipcRenderer.invoke('flasher:confirmBatch', targets),
  flash: (form) => ipcRenderer.invoke('flasher:flash', form),
  verifyCard: (bootDir) => ipcRenderer.invoke('flasher:verifyCard', bootDir),
  resolveImage: (piModel) => ipcRenderer.invoke('flasher:resolveImage', piModel),
  // fleet-wide defaults from START-HERE.cmd (public key + bench SSID only — never the bench password)
  fleetDefaults: () => ipcRenderer.invoke('flasher:fleetDefaults'),
  listDealerships: () => ipcRenderer.invoke('flasher:listDealerships'),
  mintCode: (id) => ipcRenderer.invoke('flasher:mintCode', id),
  // one-way: main -> renderer live progress from the elevated writer
  onProgress: (cb) => {
    const h = (_e, msg) => { try { cb(msg); } catch (_) {} };
    ipcRenderer.on('flasher:progress', h);
    return () => ipcRenderer.removeListener('flasher:progress', h);
  },
});
