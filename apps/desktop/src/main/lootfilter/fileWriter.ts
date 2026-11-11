import { copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { posixGameFolder } from '../gamePaths.js';
import { hashText, parseHeader } from '../../shared/lootfilter/generate.js';
import type { TargetState, WriteOutcome, WriteRequest } from '../../shared/lootfilter/ipcTypes.js';

/**
 * Writes `Path of Mastery.filter` into the game's folder. Rules of the road:
 *  - a file with our header is ours; a file without it is never overwritten until the player agrees,
 *  - our own file is also left alone if it no longer matches the text we last wrote (edited elsewhere),
 *  - the previous file is copied to the backup folder first,
 *  - the new text goes to a temp name and is renamed into place, so a crash never leaves half a filter.
 */

export function defaultGameFolder(documentsDir: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return posixGameFolder(platform);
  return join(documentsDir, 'My Games', 'Path of Exile');
}

const isNotFound = (e: unknown): boolean => (e as NodeJS.ErrnoException)?.code === 'ENOENT';

async function folderExists(folder: string): Promise<boolean> {
  try {
    return (await stat(folder)).isDirectory();
  } catch {
    return false;
  }
}

/** Hash of the file as read, line endings normalised so a CRLF/LF round trip does not count as a change. */
export function fileHash(text: string): string {
  return hashText(text.replace(/\r\n/g, '\n'));
}

export async function inspectTarget(folder: string, fileName: string, lastHash?: string): Promise<TargetState> {
  if (!(await folderExists(folder))) return { state: 'folder-missing', folder };
  const path = join(folder, fileName);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if (isNotFound(e)) return { state: 'none', path };
    throw e;
  }
  const hash = fileHash(text);
  const header = parseHeader(text);
  if (!header) return { state: 'foreign', path, hash };
  if (lastHash && lastHash !== hash) return { state: 'changed', path, hash };
  return { state: 'ours', path, hash, header: header.rulesHash };
}

export interface BackupOptions {
  /** Where backups go (outside the game folder, so they never show up in the filter list). */
  dir: string;
  keep: number;
  now?: () => Date;
}

function stamp(d: Date): string {
  const p = (n: number, l = 2): string => String(n).padStart(l, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export async function backupFile(path: string, fileName: string, opts: BackupOptions): Promise<string | undefined> {
  try {
    await stat(path);
  } catch (e) {
    if (isNotFound(e)) return undefined;
    throw e;
  }
  await mkdir(opts.dir, { recursive: true });
  const base = fileName.replace(/\.filter$/i, '');
  const dest = join(opts.dir, `${base} ${stamp((opts.now ?? (() => new Date()))())}.filter`);
  await copyFile(path, dest);
  // Keep only the newest `keep` backups of this filter.
  const prefix = base + ' ';
  const mine = (await readdir(opts.dir)).filter((f) => f.startsWith(prefix) && f.toLowerCase().endsWith('.filter')).sort();
  const extra = Math.max(0, mine.length - Math.max(1, opts.keep));
  for (const f of mine.slice(0, extra)) await unlink(join(opts.dir, f)).catch(() => undefined);
  return dest;
}

function describeError(e: unknown): { code: Extract<WriteOutcome, { kind: 'error' }>['code']; message: string } {
  const code = (e as NodeJS.ErrnoException)?.code;
  const msg = e instanceof Error ? e.message : String(e);
  if (code === 'ENOENT') return { code: 'folder-missing', message: 'The game folder was not found.' };
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return { code: 'permission', message: 'The filter file is read only or in use by another program, so it could not be written.' };
  if (code === 'ENOSPC') return { code: 'disk-full', message: 'The disk is full.' };
  return { code: 'unknown', message: msg };
}

export async function writeFilterFile(req: WriteRequest, backups: BackupOptions): Promise<WriteOutcome> {
  const path = join(req.folder, req.fileName);
  if (!req.fileName || /[\\/:*?"<>|]/.test(req.fileName) || !/\.filter$/i.test(req.fileName)) {
    return { kind: 'error', code: 'invalid', message: 'The file name must end in .filter and cannot contain \\ / : * ? " < > |.', path, folder: req.folder };
  }
  if (!parseHeader(req.fileText)) {
    return { kind: 'error', code: 'invalid', message: 'The generated text has no Path of Mastery header, so it was not written.', path, folder: req.folder };
  }
  let target: TargetState;
  try {
    target = await inspectTarget(req.folder, req.fileName, req.lastHash);
  } catch (e) {
    const d = describeError(e);
    return { kind: 'error', ...d, path, folder: req.folder };
  }
  if (target.state === 'folder-missing') return { kind: 'error', code: 'folder-missing', message: `The game folder was not found: ${req.folder}`, path, folder: req.folder };
  if (target.state === 'foreign' && req.overwrite !== 'foreign') return { kind: 'needs-confirm', why: 'foreign', path, folder: req.folder };
  if (target.state === 'changed' && req.overwrite !== 'changed' && req.overwrite !== 'foreign') return { kind: 'needs-confirm', why: 'changed', path, folder: req.folder };
  const tmp = `${path}.pom-tmp`;
  try {
    const backupPath = await backupFile(path, req.fileName, backups);
    await writeFile(tmp, req.fileText, 'utf8');
    await rename(tmp, path);
    return { kind: 'written', path, bytes: Buffer.byteLength(req.fileText, 'utf8'), hash: fileHash(req.fileText), ...(backupPath ? { backupPath } : {}), folder: req.folder };
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    const d = describeError(e);
    return { kind: 'error', ...d, path, folder: req.folder };
  }
}

/** Which of these bare file names exist in the folder. Names with a folder part are never looked up. */
export async function existingFiles(folder: string, names: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const n of names) {
    if (!n || /[\\/:*?"<>|]/.test(n)) continue;
    try {
      if ((await stat(join(folder, n))).isFile()) out.push(n);
    } catch {
      // not there
    }
  }
  return out;
}

/**
 * Copies a sound the player picked into the game folder under the name a rule asks for. It never replaces a file
 * that is already there and only writes inside the folder it was given.
 */
export async function copySoundInto(from: string, folder: string, wantedName: string): Promise<string> {
  if (!wantedName || basename(wantedName) !== wantedName || /[\\/:*?"<>|]/.test(wantedName)) throw new Error('That is not a plain file name.');
  if (!(await folderExists(folder))) throw new Error(`The game folder was not found: ${folder}`);
  const to = join(folder, wantedName);
  try {
    await stat(to);
    throw new Error(`${wantedName} is already in the folder, so it was not replaced.`);
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
  await copyFile(from, to);
  return to;
}

const isPlainFilterName = (n: string): boolean => !!n && basename(n) === n && /\.filter$/i.test(n) && !/[\/:*?"<>|]/.test(n);

/** The .filter files in the game folder, newest first, each marked when Path of Mastery wrote it. */
export async function listFilterFiles(folder: string): Promise<{ ok: true; folder: string; files: { name: string; ours: boolean }[] } | { ok: false; error: string }> {
  if (!(await folderExists(folder))) return { ok: false, error: `The Path of Exile folder was not found: ${folder}` };
  const names = (await readdir(folder)).filter(isPlainFilterName);
  const rows: { name: string; ours: boolean; at: number }[] = [];
  for (const name of names) {
    try {
      const path = join(folder, name);
      const st = await stat(path);
      if (!st.isFile()) continue;
      rows.push({ name, ours: !!parseHeader(await readFile(path, 'utf8')), at: st.mtimeMs });
    } catch {
      // unreadable: left out
    }
  }
  rows.sort((a, b) => b.at - a.at);
  return { ok: true, folder, files: rows.map(({ name, ours }) => ({ name, ours })) };
}

/** The text of one .filter file directly inside the game folder. Only a plain file name is accepted. */
export async function readFilterFile(folder: string, name: string): Promise<{ ok: true; name: string; text: string } | { ok: false; error: string }> {
  if (!isPlainFilterName(name)) return { ok: false, error: 'That is not a .filter file name.' };
  try {
    return { ok: true, name, text: await readFile(join(folder, name), 'utf8') };
  } catch (e) {
    return { ok: false, error: isNotFound(e) ? `${name} is no longer in the folder.` : `${name} could not be read.` };
  }
}
