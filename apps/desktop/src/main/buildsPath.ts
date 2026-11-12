// Where local builds are saved. The folder the player picked lives in one small file in the app's data folder, read
// before the library opens; no file (or a folder that cannot be used) means the default.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const file = (userData: string) => join(userData, 'builds-path.txt');

/** Why builds cannot be written in `dir`, or null when they can. A saved folder that has gone missing is reported, not quietly made again (`create` is for a folder being chosen now). */
function whyUnusable(dir: string, create = false): string | null {
  if (!create && !existsSync(dir)) return 'The folder is missing';
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, '.pom-write-test');
    writeFileSync(probe, '');
    rmSync(probe);
    return null;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'EPERM' || code === 'EACCES' ? 'Access denied' : code === 'ENOENT' || code === 'ENOTDIR' ? 'The folder is missing' : e instanceof Error ? e.message : String(e);
  }
}

/** True when builds can be written in `dir`. */
function usable(dir: string, create = false): boolean {
  return whyUnusable(dir, create) === null;
}

/** Set when the player chose a builds folder that cannot be used now (so this run falls back to the default). */
export function buildsDirProblem(userData: string): { path: string; reason: string } | null {
  let p: string;
  try {
    p = readFileSync(file(userData), 'utf8').trim();
  } catch {
    return null;
  }
  if (!p) return null;
  if (!isAbsolute(p)) return { path: p, reason: 'The saved folder is not a full path' };
  const reason = whyUnusable(p);
  return reason ? { path: p, reason } : null;
}

/** The chosen folder, or null when none is set or it cannot be used. */
export function chosenBuildsDir(userData: string): string | null {
  try {
    const p = readFileSync(file(userData), 'utf8').trim();
    return p && isAbsolute(p) && usable(p) ? p : null;
  } catch {
    return null;
  }
}

export function defaultBuildsDir(userData: string): string {
  return join(userData, 'Builds');
}

export function resolveBuildsDir(userData: string): string {
  return chosenBuildsDir(userData) ?? defaultBuildsDir(userData);
}

/** Remembers `dir` for the next start; null goes back to the default. Throws when the folder cannot be written. */
export function setBuildsDir(userData: string, dir: string | null): string {
  if (dir === null) {
    try {
      unlinkSync(file(userData));
    } catch {
      /* already default */
    }
    return defaultBuildsDir(userData);
  }
  if (!isAbsolute(dir) || !usable(dir, true)) throw new Error('Path of Mastery cannot save builds in that folder. Pick another one.');
  writeFileSync(file(userData), dir);
  return dir;
}
