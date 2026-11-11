import { utilityProcess, type UtilityProcess } from 'electron';
import type { ProcessFactory, ProcessHandle } from '../shared/processHandle.js';

/** Wraps an Electron UtilityProcess so it satisfies the shared ProcessHandle contract. */
function adaptUtilityProcess(proc: UtilityProcess): ProcessHandle {
  return {
    postMessage: (message) => proc.postMessage(message),
    onMessage: (handler) => proc.on('message', handler),
    onExit: (handler) => proc.on('exit', handler),
    kill: () => proc.kill(),
  };
}

/** Production factory: every real engine host runs as an Electron utility process. */
export const electronEngineProcessFactory: ProcessFactory = ({ modulePath, env }) =>
  adaptUtilityProcess(
    utilityProcess.fork(modulePath, [], {
      serviceName: 'pom-engine-host',
      env: { ...process.env, ...env },
      // The engine reads nothing relative to its working directory (POM_ENGINE_DATA names its data folder), so
      // POM_ENGINE_CWD is no longer needed; it is still honoured for anyone who set it.
      ...(process.env.POM_ENGINE_CWD ? { cwd: process.env.POM_ENGINE_CWD } : {}),
    }),
  );
