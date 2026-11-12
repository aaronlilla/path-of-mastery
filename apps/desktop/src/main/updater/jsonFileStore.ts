import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { PendingAppUpdate, AppUpdateStore } from './appShellUpdater.js';

/** Simplest possible durable store: a small JSON file under userData. */
export class JsonFileAppUpdateStore implements AppUpdateStore {
  constructor(private readonly filePath: string) {}

  async getPending(): Promise<PendingAppUpdate | null> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      return JSON.parse(raw) as PendingAppUpdate;
    } catch {
      return null;
    }
  }

  async setPending(update: PendingAppUpdate | null): Promise<void> {
    if (update === null) {
      await writeFile(this.filePath, '', 'utf8').catch(() => {});
      return;
    }
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(update), 'utf8');
  }
}
