const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('masteryRun', Object.freeze({
  view: () => ipcRenderer.invoke('mastery:run', { schemaVersion: 1, method: 'view' }),
  runAgain: runId => ipcRenderer.invoke('mastery:run', { schemaVersion: 1, method: 'runAgain', runId }),
  command: command => ipcRenderer.invoke('mastery:run', { schemaVersion: 1, method: 'command', command }),
  close: () => ipcRenderer.invoke('mastery:run', { schemaVersion: 1, method: 'close' }),
  retry: () => ipcRenderer.invoke('mastery:run', { schemaVersion: 1, method: 'retry' }),
  exportRecovery: () => ipcRenderer.invoke('mastery:run', { schemaVersion: 1, method: 'exportRecovery' }),
  setCounting: enabled => ipcRenderer.invoke('mastery:run', { schemaVersion: 1, method: 'counting', enabled }),
  setChunks: characterChunks => ipcRenderer.invoke('mastery:run', { schemaVersion: 1, method: 'chunks', characterChunks }),
  windowSettings: () => ipcRenderer.invoke('mastery:run', { schemaVersion: 1, method: 'windowSettings' }),
  saveWindowSettings: preferences => ipcRenderer.invoke('mastery:run', { schemaVersion: 1, method: 'saveWindowSettings', preferences }),
  configureHotkeys: (next, back) => ipcRenderer.invoke('mastery:run', { schemaVersion: 1, method: 'configureHotkeys', next, back }),
  disableHotkeys: () => ipcRenderer.invoke('mastery:run', { schemaVersion: 1, method: 'disableHotkeys' }),
  logState: () => ipcRenderer.invoke('mastery:run', { schemaVersion: 1, method: 'logState' }),
  logControl: control => ipcRenderer.invoke('mastery:run', { schemaVersion: 1, method: 'logControl', control }),
  openTimeline: () => ipcRenderer.invoke('mastery:run', { schemaVersion: 1, method: 'openTimeline' }),
  monitors: () => ipcRenderer.invoke('mastery:run', { schemaVersion: 1, method: 'monitors' }),
  services: call => ipcRenderer.invoke('mastery:run', { schemaVersion: 1, method: 'service', call }),
  openSource: actionId => ipcRenderer.invoke('mastery:run', { schemaVersion: 1, method: 'openSource', actionId }),
  subscribe: listener => {
    const handler = (_event, view) => listener(view);
    ipcRenderer.on('mastery:run:changed', handler);
    return () => ipcRenderer.removeListener('mastery:run:changed', handler);
  },
}));
