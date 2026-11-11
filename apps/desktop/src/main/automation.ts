import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyTestAllowance, type AllowanceContext } from './networkGate/allowance.js';

/** Window automation flags control presentation only. Network test allowance requires a signed build pin. */
export function automationNetworkAllowed(env: NodeJS.ProcessEnv, context: AllowanceContext): boolean {
  return verifyTestAllowance(env.POM_SIGNED_TEST_ALLOWANCE, context);
}

/** Window options for scripted runs. POM_AUTOMATION: the hunter's off-screen, never-focused, unthrottled window.
 *  POM_BENCH_BUILD (clickBench.ts) only needs throttling off. */
export function automationWindowOptions(env: NodeJS.ProcessEnv): {
  x?: number; y?: number; skipTaskbar?: boolean; backgroundThrottling: boolean; showInactive: boolean;
} {
  if (env.POM_AUTOMATION === '1') return { x: -20000, y: -20000, skipTaskbar: true, backgroundThrottling: false, showInactive: true };
  return { backgroundThrottling: !env.POM_BENCH_BUILD, showInactive: false };
}

/** The pid to watch: POM_LAUNCHER_PID when it is a positive integer, else the parent. */
export function launcherPid(env: NodeJS.ProcessEnv, ppid: number): number {
  const n = Number(env.POM_LAUNCHER_PID);
  return Number.isInteger(n) && n > 0 ? n : ppid;
}

/** Signal 0 probe: EPERM means the process exists but is not ours (alive); anything else (ESRCH) means gone.
 *  ponytail: PID reuse on Windows can keep the app alive if the launcher's pid is recycled; compare process start time if that ever bites */
export function pidAlive(pid: number, kill: (pid: number, sig: 0) => unknown = process.kill): boolean {
  try { kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Automation mode only (POM_LAUNCHER_PID names the Node process that launched, else the parent): ends the app when
 *  that process dies, so a killed test run leaves no hidden orphan. Just before exiting it writes
 *  `<markerDir>/hunter-launcher-gone` (watched pid and ISO time) so tests can tell this path ended the app.
 *  Returns the timer (unref'd) or undefined outside automation. isAlive/exit are injectable for tests. */
export function exitWhenLauncherDies(opts: {
  env: NodeJS.ProcessEnv; ppid: number; exit: () => void; intervalMs?: number;
  isAlive?: (pid: number) => boolean; markerDir?: string;
}): NodeJS.Timeout | undefined {
  if (opts.env.POM_AUTOMATION !== '1') return undefined;
  const isAlive = opts.isAlive ?? pidAlive;
  const t = setInterval(() => {
    if (isAlive(opts.ppid)) return;
    clearInterval(t);
    if (opts.markerDir) {
      try { writeFileSync(join(opts.markerDir, 'hunter-launcher-gone'), `${opts.ppid} ${new Date().toISOString()}
`); } catch { /* best effort */ }
    }
    opts.exit();
  }, opts.intervalMs ?? 2000);
  t.unref();
  return t;
}
