import { ipcRenderer } from 'electron';
import { JRN, type JourneyBridge } from '../shared/journey/ipcTypes.js';
import { JRNX, type JourneyLiveBridge } from '../shared/journey/liveExtra.js';

/** window.pom.journey: the Journey screens' calls into the main process. */
export const journeyBridge: JourneyBridge & Omit<JourneyLiveBridge, 'step'> = {
  plan: (req) => ipcRenderer.invoke(JRN.PLAN, req),
  onPlanProgress: (cb) => {
    const h = (_e: Electron.IpcRendererEvent, p: Parameters<typeof cb>[0]) => cb(p);
    ipcRenderer.on(JRN.PLAN_PROGRESS, h);
    return () => ipcRenderer.removeListener(JRN.PLAN_PROGRESS, h);
  },
  pin: (req) => ipcRenderer.invoke(JRN.PIN, req),
  policy: (req) => ipcRenderer.invoke(JRN.POLICY, req),
  chars: (req) => ipcRenderer.invoke(JRN.CHARS, req),
  checkGems: (req) => ipcRenderer.invoke(JRN.CHECK_GEMS, req),
  link: (l) => ipcRenderer.invoke(JRN.LINK, l),
  onLive: (cb) => {
    const h = (_e: Electron.IpcRendererEvent, s: Parameters<typeof cb>[0]) => cb(s);
    ipcRenderer.on(JRN.LIVE, h);
    return () => ipcRenderer.removeListener(JRN.LIVE, h);
  },
  sync: () => ipcRenderer.invoke(JRN.SYNC),
  gapFilter: (req) => ipcRenderer.invoke(JRN.GAP_FILTER, req),
  best: (cmd) => ipcRenderer.invoke(JRN.BEST, cmd),
  onBest: (cb) => {
    const h = (_e: Electron.IpcRendererEvent, e: Parameters<typeof cb>[0]) => cb(e);
    ipcRenderer.on(JRN.BEST, h);
    return () => ipcRenderer.removeListener(JRN.BEST, h);
  },
  budget: () => ipcRenderer.invoke(JRN.BUDGET),
  setBuild: (b) => ipcRenderer.invoke(JRNX.SET_BUILD, b),
  tick: (ids, done) => ipcRenderer.invoke(JRNX.TICK, ids, done),
  offPlan: (node, op) => ipcRenderer.invoke(JRNX.OFFPLAN, node, op),
  dismissTown: () => ipcRenderer.invoke(JRNX.DISMISS_TOWN),
  getLink: () => ipcRenderer.invoke(JRNX.GET_LINK),
  state: () => ipcRenderer.invoke(JRNX.STATE),
};
