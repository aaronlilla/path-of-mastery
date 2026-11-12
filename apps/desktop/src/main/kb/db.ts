import { createRequire } from 'node:module';

/**
 * One small SQLite surface over two drivers. `node:sqlite` (Node 22.5+: the dev CLI, the build script, the tests) is
 * file-mapped and fastest. Electron 33's main process is Node 20, which has no `node:sqlite`, so the app falls back to
 * `node-sqlite3-wasm` (WASM, FTS5, direct file I/O, no native rebuild). Both read and write the same file format.
 * KB_SQLITE_DRIVER=wasm forces the WASM driver (tests use it to cover the app path).
 */

export type SqlValue = string | number | null | Uint8Array;
export type Row = Record<string, unknown>;

export interface KbStatement {
  run(params?: SqlValue[]): void;
  finalize(): void;
}

export interface KbDb {
  readonly driver: 'node:sqlite' | 'wasm';
  all<T = Row>(sql: string, params?: SqlValue[]): T[];
  get<T = Row>(sql: string, params?: SqlValue[]): T | undefined;
  run(sql: string, params?: SqlValue[]): void;
  exec(sql: string): void;
  prepare(sql: string): KbStatement;
  close(): void;
}

const req = createRequire(import.meta.url);

interface NodeStmt { all(...p: SqlValue[]): Row[]; get(...p: SqlValue[]): Row | undefined; run(...p: SqlValue[]): unknown }
interface NodeDb { prepare(sql: string): NodeStmt; exec(sql: string): void; close(): void }
interface WasmStmt { run(p?: SqlValue[]): unknown; finalize(): void }
interface WasmDb {
  all(sql: string, p?: SqlValue[]): Row[];
  get(sql: string, p?: SqlValue[]): Row | null | undefined;
  run(sql: string, p?: SqlValue[]): unknown;
  exec(sql: string): void;
  prepare(sql: string): WasmStmt;
  close(): void;
}

function nodeSqlite(): (new (path: string, opts?: { readOnly?: boolean }) => NodeDb) | null {
  if (process.env.KB_SQLITE_DRIVER === 'wasm') return null;
  try {
    return (req('node:sqlite') as { DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => NodeDb }).DatabaseSync;
  } catch {
    return null;
  }
}

export function openDb(path: string, opts: { readOnly?: boolean } = {}): KbDb {
  const Native = nodeSqlite();
  if (Native) {
    const db = new Native(path, opts.readOnly ? { readOnly: true } : {});
    const cache = new Map<string, NodeStmt>();
    const stmt = (sql: string): NodeStmt => {
      let s = cache.get(sql);
      if (!s) cache.set(sql, (s = db.prepare(sql)));
      return s;
    };
    return {
      driver: 'node:sqlite',
      all: <T>(sql: string, p: SqlValue[] = []) => stmt(sql).all(...p) as T[],
      get: <T>(sql: string, p: SqlValue[] = []) => stmt(sql).get(...p) as T | undefined,
      run: (sql, p = []) => void stmt(sql).run(...p),
      exec: (sql) => db.exec(sql),
      prepare: (sql) => {
        const s = db.prepare(sql);
        return { run: (p = []) => void s.run(...p), finalize: () => undefined };
      },
      close: () => {
        cache.clear();
        db.close();
      },
    };
  }
  const { Database } = req('node-sqlite3-wasm') as { Database: new (path: string, opts?: { readOnly?: boolean; fileMustExist?: boolean }) => WasmDb };
  const db = new Database(path, opts.readOnly ? { readOnly: true } : {});
  return {
    driver: 'wasm',
    all: <T>(sql: string, p: SqlValue[] = []) => db.all(sql, p) as T[],
    get: <T>(sql: string, p: SqlValue[] = []) => (db.get(sql, p) ?? undefined) as T | undefined,
    run: (sql, p = []) => void db.run(sql, p),
    exec: (sql) => db.exec(sql),
    prepare: (sql) => {
      const s = db.prepare(sql);
      return { run: (p = []) => void s.run(p), finalize: () => s.finalize() };
    },
    close: () => db.close(),
  };
}
