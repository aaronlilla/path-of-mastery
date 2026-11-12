// Start-up marks for the timing harness (apps/desktop/scripts/startup-timing.mjs). Off unless POM_STARTUP_TRACE=1:
// then each mark prints one line, "[startup] <ms since the process started> <name>", to stdout.
const on = process.env.POM_STARTUP_TRACE === '1';

export function startupMark(name: string): void {
  if (on) console.log(`[startup] ${Math.round(process.uptime() * 1000)} ${name}`);
}

/** Times one awaited step: a mark when it ends, with its own duration. */
export async function startupStep<T>(name: string, work: () => Promise<T>): Promise<T> {
  if (!on) return work();
  const t = performance.now();
  try { return await work(); } finally { startupMark(`${name} done in ${Math.round(performance.now() - t)} ms`); }
}
