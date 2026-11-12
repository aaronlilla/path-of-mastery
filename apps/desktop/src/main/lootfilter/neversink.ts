import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { parseBlocks } from '../../shared/lootfilter/blocks.js';
import { STRICTNESS } from '../../shared/lootfilter/styles.js';
import { compareVersions } from '../../shared/lootfilter/versions.js';
import { validateFilter } from '../../shared/lootfilter/syntax.js';
import type { BaseFiles, BaseVersionInfo, ReleaseInfo, UpdateCheck } from '../../shared/lootfilter/ipcTypes.js';

/**
 * NeverSink's filter is the base. A pinned release ships with the app (MIT licence beside it). The app checks
 * GitHub for newer releases and downloads one when the player says so.
 */

// POM_NEVERSINK_RELEASE_URL points the release check at a local server in tests. Unset, it is GitHub.
const API = process.env.POM_NEVERSINK_RELEASE_URL || 'https://api.github.com/repos/NeverSinkDev/NeverSink-Filter/releases/latest';

export const FILE_NAMES: Record<string, string> = Object.fromEntries(STRICTNESS.map((s) => [s.id, s.file]));

export { compareVersions };

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export class NeverSinkStore {
  constructor(
    /** Shipped with the app: resources/neversink. */
    private readonly bundledDir: string,
    /** Downloaded releases: userData/lootfilter/neversink. */
    private readonly downloadDir: string,
    private readonly fetcher: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
  ) {}

  async installed(): Promise<BaseVersionInfo[]> {
    const out: BaseVersionInfo[] = [];
    for (const [dir, source] of [[this.bundledDir, 'bundled'], [this.downloadDir, 'downloaded']] as const) {
      let names: string[] = [];
      try {
        names = await readdir(dir);
      } catch {
        continue;
      }
      for (const v of names) {
        const full = join(dir, v);
        if (!(await exists(join(full, STRICTNESS[2].file)))) continue;
        if (out.some((o) => o.version === v)) continue;
        out.push({ version: v, source, licence: await exists(join(full, 'LICENSE')) });
      }
    }
    return out.sort((a, b) => compareVersions(b.version, a.version));
  }

  private dirOf(version: string, list: BaseVersionInfo[]): string | null {
    const f = list.find((x) => x.version === version);
    if (!f) return null;
    return join(f.source === 'bundled' ? this.bundledDir : this.downloadDir, version);
  }

  /** The version to build on: the pinned one when installed, else the newest installed. */
  async resolveVersion(pinned: string): Promise<string | null> {
    const list = await this.installed();
    if (pinned && list.some((x) => x.version === pinned)) return pinned;
    return list[0]?.version ?? null;
  }

  async read(version: string): Promise<BaseFiles> {
    const list = await this.installed();
    const dir = this.dirOf(version, list);
    if (!dir) throw new Error(`NeverSink ${version} is not installed.`);
    const files: Record<string, string> = {};
    for (const s of STRICTNESS) files[s.id] = await readFile(join(dir, s.file), 'utf8');
    let licence = '';
    try {
      licence = await readFile(join(dir, 'LICENSE'), 'utf8');
    } catch {
      licence = '';
    }
    return { version, files, licence };
  }

  async readOne(version: string, strictnessId: string): Promise<string> {
    const list = await this.installed();
    const dir = this.dirOf(version, list);
    const file = FILE_NAMES[strictnessId];
    if (!dir || !file) throw new Error(`NeverSink ${version} ${strictnessId} is not installed.`);
    return readFile(join(dir, file), 'utf8');
  }

  async latestRelease(): Promise<ReleaseInfo> {
    const r = await this.fetcher(API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'PathOfMastery' }, signal: AbortSignal.timeout(15000) });
    if (r.status === 403 || r.status === 429) throw new Error('GitHub is limiting requests right now. Try again in a few minutes.');
    if (!r.ok) throw new Error(`GitHub answered ${r.status} when asked for the latest NeverSink release.`);
    const j = (await r.json()) as { tag_name: string; name?: string; published_at?: string; html_url: string; zipball_url: string; body?: string };
    return { tag: j.tag_name, name: j.name ?? j.tag_name, publishedAt: j.published_at ?? '', htmlUrl: j.html_url, zipUrl: j.zipball_url, body: (j.body ?? '').slice(0, 4000) };
  }

  async check(): Promise<UpdateCheck> {
    const installed = await this.installed();
    try {
      const latest = await this.latestRelease();
      return { checkedAt: Date.now(), installed, latest, newer: !installed.some((i) => i.version === latest.tag) && installed.every((i) => compareVersions(latest.tag, i.version) > 0) };
    } catch (e) {
      return { checkedAt: Date.now(), installed, latest: null, error: e instanceof Error ? e.message : String(e), newer: false };
    }
  }

  /**
   * Downloads a release, keeps the seven strictness files and the licence, and checks them before they are
   * installed: all seven present, the version line matches the tag, and enough blocks parse.
   */
  async download(release: ReleaseInfo): Promise<{ version: string; syntaxErrors: number }> {
    const r = await this.fetcher(release.zipUrl, { headers: { 'User-Agent': 'PathOfMastery' }, signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw new Error(`GitHub answered ${r.status} when downloading NeverSink ${release.tag}.`);
    const entries = readZip(Buffer.from(await r.arrayBuffer()));
    const top = entries.filter((e) => e.name.split('/').length === 2 && !e.name.endsWith('/'));
    const wanted: Record<string, Buffer> = {};
    for (const s of STRICTNESS) {
      const hit = top.find((e) => e.name.endsWith(`- ${s.file}`));
      if (!hit) throw new Error(`The NeverSink ${release.tag} download has no ${s.file}.`);
      wanted[s.file] = hit.data;
    }
    const licence = top.find((e) => /\/LICENSE$/.test(e.name));
    if (!licence) throw new Error(`The NeverSink ${release.tag} download has no LICENSE, so it was not installed.`);
    let syntaxErrors = 0;
    for (const s of STRICTNESS) {
      const text = wanted[s.file]!.toString('utf8');
      const v = /# VERSION:\s*(\S+)/.exec(text.slice(0, 600));
      if (!v || v[1] !== release.tag) throw new Error(`${s.file} says version ${v?.[1] ?? 'unknown'}, not ${release.tag}.`);
      if (parseBlocks(text).blocks.length < 300) throw new Error(`${s.file} has too few blocks to be a NeverSink filter.`);
      syntaxErrors += validateFilter(text).errors;
    }
    const final = join(this.downloadDir, release.tag);
    const tmp = final + '.part';
    await rm(tmp, { recursive: true, force: true });
    await mkdir(tmp, { recursive: true });
    for (const s of STRICTNESS) await writeFile(join(tmp, s.file), wanted[s.file]!);
    await writeFile(join(tmp, 'LICENSE'), licence.data);
    await rm(final, { recursive: true, force: true });
    await rename(tmp, final);
    return { version: release.tag, syntaxErrors };
  }
}

// ---- a small zip reader (stored and deflated entries) -----------------------------------------------

export interface ZipEntry {
  name: string;
  data: Buffer;
}

export function readZip(buf: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('This is not a zip file.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('The zip directory is damaged.');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('A zip entry is damaged.');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    if (method === 0) out.push({ name, data: Buffer.from(raw) });
    else if (method === 8) out.push({ name, data: inflateRawSync(raw) });
    else throw new Error(`The zip uses an unsupported compression (${method}).`);
  }
  return out;
}
