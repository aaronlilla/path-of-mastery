// The timeless jewel tables as the window sees them: the main process inflates them from the package into user data
// (src/main/timelessData.ts); this follows its progress and, when a build was calculated without them, has the engine
// calculate it again once they are there.
import { useEffect, useState } from 'react';
import { engineSend, type EngineBuild } from '../engineBuild';
import type { TimelessInstallStatus } from '../../shared/timelessStatus';

type Listener = (s: TimelessInstallStatus) => void;
const listeners = new Set<Listener>();
let last: TimelessInstallStatus | null = null;
let driving = false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Starts the inflating (when something is missing) and follows it until it ends. One loop for the whole window. */
async function drive(): Promise<void> {
  if (driving) return;
  driving = true;
  try {
    let r = await window.pom.app.timelessData.install();
    for (;;) {
      if (!r.ok) break;
      last = r.value;
      listeners.forEach((l) => l(r.ok ? r.value : (last as TimelessInstallStatus)));
      if (r.value.state === 'ready' || r.value.state === 'error') break;
      await sleep(400);
      r = await window.pom.app.timelessData.status();
    }
  } finally {
    driving = false;
  }
}

/** The tables' status; `want` starts the inflating (the Find Timeless Jewel dialog is open, or a build needs them). */
export function useTimelessTables(want: boolean): TimelessInstallStatus | null {
  const [status, setStatus] = useState<TimelessInstallStatus | null>(last);
  useEffect(() => {
    listeners.add(setStatus);
    return () => {
      listeners.delete(setStatus);
    };
  }, []);
  useEffect(() => {
    if (want) void drive();
  }, [want]);
  return status;
}

/**
 * A build whose numbers leave out a timeless jewel (the engine says so in `TimelessDataWarning`) starts the inflating;
 * when it is done the build is calculated again and the new numbers replace the old ones.
 */
export function useTimelessRecalc(eng: EngineBuild): void {
  const warned = typeof eng.stats.TimelessDataWarning === 'string';
  const status = useTimelessTables(warned);
  const ready = status?.state === 'ready';
  useEffect(() => {
    if (!warned || !ready || !eng.buildId) return;
    let alive = true;
    void engineSend('recalc', { buildId: eng.buildId }).then((r) => {
      if (alive) eng.applyExternal(r.statDiff.changed);
    }, () => undefined);
    return () => {
      alive = false;
    };
  }, [warned, ready, eng.buildId]); // eslint-disable-line react-hooks/exhaustive-deps
}
