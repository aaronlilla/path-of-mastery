// Validation records for the app's bundled read-only data (Atlas packs, the starter pack). Those files only change with a new
// release, yet validating them took 5-40 s of every start. A record says "these exact bytes passed full validation by this
// exact validator code", so a start re-hashes the bytes (tens of ms) instead of re-validating them.
//
// Records come from one place only: the release build, which runs the same validators over the same bundled files
// (`npm run build:validated`, scripts/prevalidate.mjs) and writes dist/validated. They ship inside the app package with the very code
// that made them. A record counts only under the same identity (cache schema + app version + a hash of the validator's own code
// files) and only for bytes that hash to its key; anything else (a changed or tampered file, a new release, a rebuilt validator, a
// missing or malformed record file) is a miss, and a miss runs the full validation.
//
// Nothing is ever read from or written to userData. Records there would be writable by any program running as the user, and an
// authenticated variant (a DPAPI-protected HMAC key) is readable by that same program too. Such a program can equally modify the
// installed app files themselves, so that threat is outside what an in-app cache can defend; the cache only ensures it never adds
// a way around validation. Records made at run time (`record`) live in memory for that run only.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const VALIDATION_CACHE_SCHEMA = 1;
export const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const HEX64 = /^[a-f0-9]{64}$/;

/** A release record file (dist/validated). */
type ReleaseFile = { schemaVersion: number; identity: string; entries: Record<string, unknown> };

/**
 * The validator identity: the app version plus the bytes of every code file that does the validating. Any change to either
 * (an update, a rebuilt bundle, an interface hot swap) gives a new identity, and every record made by the old one is ignored.
 */
export async function validatorIdentity(appVersion: string, codeFiles: readonly string[]): Promise<string> {
  const hash = createHash('sha256').update(`schema ${VALIDATION_CACHE_SCHEMA}\napp ${appVersion}\n`);
  for (const file of [...codeFiles].sort()) {
    const bytes = await readFile(file);
    hash.update(`${file.replace(/\\/g, '/').split('/').slice(-3).join('/')} ${bytes.length} ${sha256(bytes)}\n`);
  }
  return hash.digest('hex');
}

export class ValidationCache {
  private entries: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  private dirty = false;
  private constructor(readonly file: string | null, readonly identity: string, private readonly writer: boolean) {}

  /**
   * Opens the release record file (null: none). `writer` is for the release build step only: it may save records to `file`.
   * A missing, unreadable or malformed file, or one made by another identity, contributes nothing.
   */
  static async open(file: string | null, identity: string, options: { writer?: boolean } = {}): Promise<ValidationCache> {
    const cache = new ValidationCache(file, identity, options.writer === true);
    if (file) {
      try {
        const raw = JSON.parse(await readFile(file, 'utf8')) as ReleaseFile;
        if (raw && raw.schemaVersion === VALIDATION_CACHE_SCHEMA && raw.identity === identity && raw.entries && typeof raw.entries === 'object' && !Array.isArray(raw.entries)) {
          for (const [key, value] of Object.entries(raw.entries)) if (HEX64.test(key)) cache.entries[key] = value;
        }
      } catch { /* no usable records: every lookup misses */ }
    }
    return cache;
  }

  /** The value recorded when bytes with this SHA-256 passed validation, or undefined (a miss: validate in full). */
  lookup<T>(contentSha256: string): T | undefined {
    return HEX64.test(contentSha256) && Object.hasOwn(this.entries, contentSha256) ? structuredClone(this.entries[contentSha256]) as T : undefined;
  }

  /** Records that bytes with this SHA-256 passed full validation (kept for this run; saved only by the release build step). */
  record(contentSha256: string, value: unknown): void {
    if (!HEX64.test(contentSha256)) throw new TypeError('A validation record needs a SHA-256 hex digest.');
    this.entries[contentSha256] = structuredClone(value);
    this.dirty = true;
  }

  /** Drops a record (its bytes no longer validate) for the rest of this run. */
  forget(contentSha256: string): void {
    if (Object.hasOwn(this.entries, contentSha256)) delete this.entries[contentSha256];
  }

  get size(): number { return Object.keys(this.entries).length; }

  /** Release build step only: writes the records atomically (temp file + rename). Does nothing in the app. */
  async save(): Promise<void> {
    if (!this.writer || !this.file || !this.dirty) return;
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(temp, JSON.stringify({ schemaVersion: VALIDATION_CACHE_SCHEMA, identity: this.identity, entries: this.entries } satisfies ReleaseFile));
      await rename(temp, this.file);
      this.dirty = false;
    } catch (e) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw e; // a release build without its records must not pass silently
    }
  }
}
