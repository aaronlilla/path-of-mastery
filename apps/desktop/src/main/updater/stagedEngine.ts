import { readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { KeyObject } from 'node:crypto';
import type { UpdateLayer } from '@pom/protocol';
import { verifyDownloadedLayer } from './signature.js';

/**
 * A verified engine update waits here until the next app start: the app is not reloaded under open builds. The marker names
 * the pack and its version; the next launch forks the engine host on that pack and shows that version in About.
 */
export interface StagedEngine {
  version: string;
  packPath: string;
  /** The signed manifest entry the pack was verified against; checked again at the next start. */
  layer?: UpdateLayer;
}

const MARKER = 'engine-staged.json';

export async function writeStagedEngine(stagingDir: string, staged: StagedEngine): Promise<void> {
  await writeFile(join(stagingDir, MARKER), JSON.stringify(staged), 'utf8');
}

/** The staged engine, or null when there is none or its pack is gone (then the bundled engine runs). */
export async function readStagedEngine(stagingDir: string, publicKey?: KeyObject): Promise<StagedEngine | null> {
  try {
    const parsed = JSON.parse(await readFile(join(stagingDir, MARKER), 'utf8')) as Partial<StagedEngine>;
    if (typeof parsed.version !== 'string' || typeof parsed.packPath !== 'string') return null;
    if (!(await stat(parsed.packPath)).isFile()) return null;
    // With a key, the pack is verified again (signature and sha256) before it is loaded as native code: a file swapped in the staging folder is refused.
    if (publicKey) {
      if (!parsed.layer || parsed.layer.version !== parsed.version) return null;
      if (!(await verifyDownloadedLayer('engine', parsed.layer, parsed.packPath, publicKey)).ok) return null;
    }
    return { version: parsed.version, packPath: parsed.packPath, ...(parsed.layer ? { layer: parsed.layer } : {}) };
  } catch {
    return null;
  }
}

/** Drops the staged engine, so the next start runs the bundled one again (a staged engine that would not start). */
export async function clearStagedEngine(stagingDir: string): Promise<void> {
  await rm(join(stagingDir, MARKER), { force: true });
}
