import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { openDb, type KbDb } from '../kb/db.js';
import { acquireStoreOwner } from '../documents/owner.js';
import { BlobStore, type FaultProbe } from '../documents/blobs.js';
import type { Schema, ValidationLimits } from '@pom/mastery-contracts';

export class MarketplaceLocalError extends Error {
  constructor(readonly code: 'INVALID' | 'CLOSED' | 'DOWNLOAD_NEEDED' | 'ACCOUNT_CHANGED' | 'CONFLICT', message: string) { super(message); }
}
export function validate<T>(schema: Schema<T>, value: unknown, limits: ValidationLimits): T {
  const result = schema.parse(value, limits);
  if (!result.ok) throw new MarketplaceLocalError('INVALID', result.issues[0]?.message ?? 'Invalid Marketplace data.');
  return result.value;
}

/** The document store owns document history; this separate index owns saves and network state. */
export class MarketplaceStore {
  readonly root: string;
  readonly blobs: BlobStore;
  private db: KbDb | null = null;
  private release: (() => Promise<void>) | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private closing = false;
  private closeTask: Promise<void> | null = null;
  constructor(userData: string, readonly limits: ValidationLimits, private readonly probe: FaultProbe = () => {}) {
    this.root = join(userData, 'mastery', 'marketplace');
    this.blobs = new BlobStore(join(this.root, 'blobs'), probe);
  }
  async init(): Promise<void> {
    if (this.db || this.closing) throw new MarketplaceLocalError('CLOSED', 'Marketplace store is already open or closed.');
    await mkdir(this.root, { recursive: true });
    this.release = await acquireStoreOwner(this.root);
    try {
      await this.blobs.init();
      this.db = openDb(join(this.root, 'index.sqlite'));
      const version = this.db.get<{ user_version: number }>('PRAGMA user_version')!.user_version;
      if (version !== 0 && version !== 1) throw new MarketplaceLocalError('INVALID', 'Unsupported Marketplace index version.');
      this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS records(bucket TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(bucket,id));
        PRAGMA user_version=1;`);
    } catch (error) { this.db?.close(); this.db = null; await this.release(); this.release = null; throw error; }
  }
  private database(): KbDb {
    if (!this.db) throw new MarketplaceLocalError('CLOSED', 'Marketplace store is closed.');
    return this.db;
  }
  get<T>(bucket: string, id: string): T | null {
    const row = this.database().get<{ value: string }>('SELECT value FROM records WHERE bucket=? AND id=?', [bucket, id]);
    return row ? JSON.parse(row.value) as T : null;
  }
  list<T>(bucket: string): T[] {
    return this.database().all<{ value: string }>('SELECT value FROM records WHERE bucket=? ORDER BY id', [bucket]).map(row => JSON.parse(row.value) as T);
  }
  put(bucket: string, id: string, value: unknown): void {
    this.database().run('INSERT INTO records(bucket,id,value) VALUES (?,?,?) ON CONFLICT(bucket,id) DO UPDATE SET value=excluded.value', [bucket, id, JSON.stringify(value)]);
  }
  remove(bucket: string, id: string): void { this.database().run('DELETE FROM records WHERE bucket=? AND id=?', [bucket, id]); }
  transaction<T>(work: () => T): T {
    const db = this.database(); db.exec('BEGIN IMMEDIATE');
    try { const value = work(); this.probe('beforeIndexCommit'); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  serial<T>(work: () => Promise<T> | T): Promise<T> {
    if (this.closing || !this.db) return Promise.reject(new MarketplaceLocalError('CLOSED', 'Marketplace store is closed.'));
    const task = this.tail.then(work); this.tail = task.catch(() => {}); return task;
  }
  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closing = true;
    this.closeTask = this.tail.then(async () => { this.db?.close(); this.db = null; await this.release?.(); this.release = null; });
    return this.closeTask;
  }
}
