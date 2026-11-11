// The timeless jewel tables. The app ships them compressed (resources/timeless, Brotli, made by
// scripts/pack-timeless.mjs); the engine reads plain `<Name>.bin` files from the user-data folder, so the first
// time a build or the search needs them they are inflated there. This runs in the main process, one table at a time
// and off the engine, so neither the window nor a calculation waits on it.
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createBrotliDecompress } from 'node:zlib';

export interface TimelessManifestFile {
  /** The table's name, e.g. GloriousVanity (the engine reads `<name>.bin`). */
  name: string;
  /** Bytes once inflated. */
  raw: number;
  /** Bytes in the package. */
  packed: number;
}

export interface TimelessManifest {
  files: TimelessManifestFile[];
}

import type { TimelessInstallStatus } from '../shared/timelessStatus.js';
export type { TimelessInstallStatus };

/** Tables a calculation can need that the package leaves out (none: all eleven ship). */
export const NOT_BUNDLED: string[] = [];

export class TimelessInstaller {
  private status: TimelessInstallStatus;
  private running: Promise<void> | null = null;

  constructor(
    private readonly bundledDir: string,
    private readonly targetDir: string,
  ) {
    this.status = { state: 'idle', done: 0, total: 0, current: null, percent: 0, dir: targetDir, notBundled: NOT_BUNDLED };
  }

  getStatus(): TimelessInstallStatus {
    return { ...this.status };
  }

  /** Puts `NodeIndexMapping.lua` in place (small, so at once); the engine needs it to know the tables exist. */
  async prepare(): Promise<void> {
    await mkdir(this.targetDir, { recursive: true });
    const from = join(this.bundledDir, 'NodeIndexMapping.lua');
    const to = join(this.targetDir, 'NodeIndexMapping.lua');
    if (existsSync(from) && (await sizeOf(to)) !== (await sizeOf(from))) await copyFile(from, to);
  }

  /** Inflates every table of the package that is not in the folder yet. Safe to call again while it runs. */
  ensure(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(): Promise<void> {
    try {
      const manifest = JSON.parse(await readFile(join(this.bundledDir, 'manifest.json'), 'utf8')) as TimelessManifest;
      await this.prepare();
      const todo: TimelessManifestFile[] = [];
      for (const f of manifest.files) if ((await sizeOf(join(this.targetDir, f.name + '.bin'))) !== f.raw) todo.push(f);
      const totalBytes = todo.reduce((a, f) => a + f.raw, 0);
      this.status = { ...this.status, state: todo.length ? 'inflating' : 'ready', done: 0, total: todo.length, current: null, percent: todo.length ? 0 : 100, error: undefined };
      let doneBytes = 0;
      for (const f of todo) {
        this.status = { ...this.status, current: f.name };
        const tmp = join(this.targetDir, `${f.name}.bin.tmp${process.pid}`);
        let written = 0;
        const count = new Transform({
          transform: (chunk: Buffer, _enc, cb) => {
            written += chunk.length;
            this.status = { ...this.status, percent: Math.min(99, Math.floor(((doneBytes + written) / totalBytes) * 100)) };
            cb(null, chunk);
          },
        });
        try {
          await pipeline(createReadStream(join(this.bundledDir, f.name + '.br')), createBrotliDecompress(), count, createWriteStream(tmp));
          if (written !== f.raw) throw new Error(`${f.name} inflated to ${written} bytes, expected ${f.raw}`);
          await rename(tmp, join(this.targetDir, f.name + '.bin'));
        } catch (e) {
          await rm(tmp, { force: true });
          throw e;
        }
        doneBytes += f.raw;
        this.status = { ...this.status, done: this.status.done + 1 };
      }
      this.status = { ...this.status, state: 'ready', current: null, percent: 100 };
    } catch (e) {
      this.status = { ...this.status, state: 'error', current: null, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return -1;
  }
}
