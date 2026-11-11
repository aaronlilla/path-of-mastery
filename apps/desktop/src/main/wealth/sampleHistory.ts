/**
 * Replays a few days of play through the sample stash and the real service, so the dev switch opens on an account
 * that already has net-worth history and sessions. Everything goes through the same read, snapshot and session code
 * the live account uses; only the clock and the stash are fake.
 */
import type { Activity, SampleGgg } from './sampleGgg.js';
import type { WealthService } from './service.js';

interface Win {
  /** Minutes before the end when the window starts. */
  ago: number;
  minutes: number;
  kind: Activity;
}

const WINDOWS: Win[] = [
  { ago: 3 * 1440 + 300, minutes: 150, kind: 'map' },
  { ago: 2 * 1440 + 360, minutes: 40, kind: 'craft' },
  { ago: 2 * 1440 + 200, minutes: 70, kind: 'map' },
  { ago: 1 * 1440 + 300, minutes: 120, kind: 'map' },
  { ago: 1 * 1440 + 60, minutes: 34, kind: 'boss' },
  { ago: 1 * 1440 - 200, minutes: 10, kind: 'sale' },
  { ago: 52, minutes: 52, kind: 'map' },
];

export async function seedSampleHistory(svc: WealthService, sample: SampleGgg, clock: { t: number }, end: number): Promise<number> {
  svc.beginBulk();
  const step = 3 * 60_000;
  const start = end - 3.5 * 1440 * 60_000;
  let n = 0;
  for (let t = start; t <= end; t += step) {
    if (clock.t < t) clock.t = t;
    const min = (end - t) / 60_000;
    for (const w of WINDOWS) {
      if (min <= w.ago && min > w.ago - w.minutes) {
        if (w.kind === 'boss' && n % 2) continue;
        if (w.kind === 'sale' && min < w.ago - 1) continue;
        sample.advance(w.kind);
      }
    }
    n++;
    await svc.tick();
  }
  await svc.endBulk();
  return n;
}
