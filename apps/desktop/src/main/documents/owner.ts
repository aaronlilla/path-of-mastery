import { createServer } from 'node:net';
import { readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hashBytes } from './blobs.js';

/** The OS releases the endpoint on process death; SQLite's WASM lock directory does not. */
export async function acquireStoreOwner(root: string): Promise<() => Promise<void>> {
  const key = hashBytes(process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root));
  const pidFile = join(root, 'owner.json');
  const socket = process.platform === 'win32' ? `\\\\.\\pipe\\pom-mastery-${key}` : join(root, 'owner.sock');
  if (process.platform !== 'win32') {
    try {
      const owner = JSON.parse(await readFile(pidFile, 'utf8')) as { pid: number };
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error('Invalid store owner.');
      try { process.kill(owner.pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        await unlink(socket).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const server = createServer(connection => connection.end());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, () => { server.removeListener('error', reject); resolve(); });
  });
  const release = () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  try {
    await writeFile(pidFile, JSON.stringify({ pid: process.pid }));
    // Remove only the driver's empty lock directory while holding exclusive store ownership.
    await rmdir(join(root, 'index.sqlite.lock')).catch(error => { if (error.code !== 'ENOENT') throw error; });
  } catch (error) { await release(); throw error; }
  return release;
}
