import { ipcRenderer } from 'electron';
import { LVL, type LevelingBridge, type ZoneEvent } from '../shared/leveling/ipcTypes.js';

/** window.pom.leveling: the Leveling tab's calls into the main process. */
export const levelingBridge: LevelingBridge = {
  guide: (req) => ipcRenderer.invoke(LVL.GUIDE, req),
  tick: (buildId, stepIds, done) => ipcRenderer.invoke(LVL.TICK, buildId, stepIds, done),
  settings: (buildId, patch) => ipcRenderer.invoke(LVL.SETTINGS, buildId, patch),
  onZone: (cb) => {
    const h = (_e: Electron.IpcRendererEvent, z: ZoneEvent) => cb(z);
    ipcRenderer.on(LVL.ZONE, h);
    return () => ipcRenderer.removeListener(LVL.ZONE, h);
  },
};
