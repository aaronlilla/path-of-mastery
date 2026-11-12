import { createWriteStream } from 'node:fs';
import { copyFile, rename, rm } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

export interface DownloadOptions {
  /** Bytes received so far and the expected total (0 when the server does not say). */
  onProgress?(received: number, total: number): void;
}

export interface Downloader {
  download(url: string, destPath: string, opts?: DownloadOptions): Promise<void>;
}

/**
 * Default downloader: `https:`/`http:` go through the platform `fetch`
 * (global in Node 22+, same engine Electron's main process uses); `file:`
 * URLs are copied directly, which is what lets tests point layers at local
 * fixture files without standing up an HTTP server. The bytes land in
 * `<dest>.part` and are renamed into place only when the transfer completed,
 * so a cut-off download never looks like a finished one.
 */
export const fetchDownloader: Downloader = {
  async download(url, destPath, opts) {
    const parsed = new URL(url);
    if (parsed.protocol === 'file:') {
      await copyFile(fileURLToPath(parsed), destPath);
      return;
    }
    const response = await fetch(url);
    if (!response.ok || !response.body) {
      throw new Error(`download failed for ${url}: HTTP ${response.status}`);
    }
    const total = Number(response.headers.get('content-length') ?? 0) || 0;
    let received = 0;
    let lastReport = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        received += chunk.length;
        const now = Date.now();
        if (opts?.onProgress && (now - lastReport > 250 || received === total)) {
          lastReport = now;
          opts.onProgress(received, total);
        }
        done(null, chunk);
      },
    });
    const part = `${destPath}.part`;
    try {
      await pipeline(Readable.fromWeb(response.body as never), meter, createWriteStream(part));
      opts?.onProgress?.(received, total || received);
      await rm(destPath, { force: true });
      await rename(part, destPath);
    } catch (e) {
      await rm(part, { force: true }).catch(() => {});
      throw e;
    }
  },
};
