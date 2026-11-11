import { fork, type ChildProcess, type Serializable } from 'node:child_process';
import type { ProcessFactory, ProcessHandle } from '../shared/processHandle.js';

/** Wraps a plain Node child process so it satisfies the shared ProcessHandle contract. */
function adaptChildProcess(proc: ChildProcess): ProcessHandle {
  return {
    postMessage: (message) => {
      proc.send(message as Serializable);
    },
    onMessage: (handler) => proc.on('message', handler),
    onExit: (handler) => proc.on('exit', handler),
    kill: () => {
      proc.kill();
    },
  };
}

/**
 * Test/fallback factory: spawns the engine host with `child_process.fork`
 * instead of Electron's `utilityProcess.fork`. Used by the hot-swap unit
 * tests (which run under plain Node, with no Electron runtime available)
 * against real fixture scripts, exercising the exact same
 * ProcessHandle-shaped state machine the production code uses.
 */
export const nodeChildProcessFactory: ProcessFactory = ({ modulePath, env }) =>
  adaptChildProcess(
    fork(modulePath, [], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    }),
  );
