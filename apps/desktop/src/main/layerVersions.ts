import { readFileSync } from 'node:fs';

/** What About shows when no real number is known. Never a made-up one. */
export const UNKNOWN_VERSION = 'unknown';

const VERSION = /^\d+\.\d+\.\d+/;

/**
 * The numbers `scripts/stamp-versions.mjs` wrote into dist/versions.json for this build. A missing or broken file gives
 * 'unknown'. `official` is true only for a release build, which is the only kind that updates itself.
 */
export function readStampedVersions(file: string | URL): { engine: string; interface: string; official: boolean } {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as { engine?: unknown; interface?: unknown; official?: unknown };
    const ok = (v: unknown) => (typeof v === 'string' && VERSION.test(v) ? v : UNKNOWN_VERSION);
    return { engine: ok(j.engine), interface: ok(j.interface), official: j.official === true };
  } catch {
    return { engine: UNKNOWN_VERSION, interface: UNKNOWN_VERSION, official: false };
  }
}

/**
 * The number About shows for a layer: the version an update installed, else the stamped one for this build.
 * The updater's own notion of "current" stays 'dev' for an unpackaged build (that is what its manifests are compared with).
 */
export function shownVersion(updaterCurrent: string, stamped: string): string {
  return VERSION.test(updaterCurrent) ? updaterCurrent : stamped;
}
