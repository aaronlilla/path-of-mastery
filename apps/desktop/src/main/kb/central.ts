import { verify as edVerify, type KeyObject } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createBrotliDecompress } from 'node:zlib';
import { importEd25519PublicKey, sha256File } from '../updater/signature.js';
import { BAKED_UPDATE_PUBLIC_KEY } from '../updater/updateKey.js';
import { KB_UA } from './http.js';
import { KB_SCHEMA_VERSION } from './schema.js';

/**
 * The central KB: built once per patch on our side (tools/kb/publish-kb.mjs), signed with the update key, and served as
 * a small manifest pointing at the Brotli snapshot, both assets of the `kb` release on the public releases repo (where
 * the update layers' bytes already live). The app downloads it instead of
 * scraping the sources itself; a failed fetch or a bad signature leaves the app on its local build.
 */

export const DEFAULT_KB_MANIFEST_URL = 'https://github.com/aaronlilla/pathofmastery-releases/releases/download/kb/kb-manifest.json';
export const KB_MANIFEST_FORMAT = 'pom-kb/1';

export interface CentralKbManifest {
  format: string;
  schemaVersion: number;
  builtAt: string;
  livePatch: string;
  dataPatch: string;
  sha256: string;
  size: number;
  url: string;
  signature: string;
  sources?: Array<{ id: string; status: string; rows: number; patch: string | null }>;
}

/** The exact bytes signed. Its own prefix, so a KB signature can never pass as an update-layer signature. tools/kb/publish-kb.mjs must match. */
export function kbSigningPayload(m: Omit<CentralKbManifest, 'signature' | 'format' | 'sources'>): string {
  return `pom-kb1:${m.schemaVersion}:${m.dataPatch}:${m.livePatch}:${m.builtAt}:${m.sha256}:${m.size}:${m.url}`;
}

export class CentralKbError extends Error {}

/** Checks shape, schema version and signature. Throws CentralKbError with the reason. */
export function verifyCentralManifest(raw: unknown, publicKey: KeyObject): CentralKbManifest {
  const m = raw as CentralKbManifest;
  if (!m || typeof m !== 'object' || m.format !== KB_MANIFEST_FORMAT) throw new CentralKbError('not a KB manifest');
  for (const k of ['builtAt', 'livePatch', 'dataPatch', 'url', 'signature'] as const) if (typeof m[k] !== 'string' || !m[k]) throw new CentralKbError(`KB manifest has no ${k}`);
  if (!/^[a-f0-9]{64}$/.test(m.sha256) || !Number.isInteger(m.size) || m.size <= 0) throw new CentralKbError('KB manifest has a bad sha256 or size');
  if (m.schemaVersion !== KB_SCHEMA_VERSION) throw new CentralKbError(`KB schema ${m.schemaVersion} is not this app's (${KB_SCHEMA_VERSION})`);
  let ok = false;
  try {
    ok = edVerify(null, Buffer.from(kbSigningPayload(m), 'utf8'), publicKey, Buffer.from(m.signature, 'base64'));
  } catch {
    ok = false;
  }
  if (!ok) throw new CentralKbError('KB manifest signature is not valid');
  return m;
}

export interface CentralKbOptions {
  manifestUrl?: string;
  publicKey?: KeyObject;
  fetch?: (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;
  /** Cuts off a manifest fetch (default 30 s) or a snapshot download (default 5 min); the caller falls back to the local build. */
  timeoutMs?: number;
}

/** Fetches and verifies the manifest. */
export async function fetchCentralManifest(o: CentralKbOptions = {}): Promise<CentralKbManifest> {
  const f = o.fetch ?? ((u, i) => fetch(u, i));
  const res = await f(o.manifestUrl ?? DEFAULT_KB_MANIFEST_URL, { headers: { 'User-Agent': KB_UA, Accept: 'application/json' }, signal: AbortSignal.timeout(o.timeoutMs ?? 30_000) });
  if (!res.ok) throw new CentralKbError(`KB manifest: HTTP ${res.status}`);
  return verifyCentralManifest(await res.json(), o.publicKey ?? importEd25519PublicKey(BAKED_UPDATE_PUBLIC_KEY));
}

/** Downloads the snapshot `m` points at, checks its size and sha256, and inflates it to `target`. */
export async function downloadCentralSnapshot(m: CentralKbManifest, target: string, o: CentralKbOptions = {}): Promise<void> {
  const f = o.fetch ?? ((u, i) => fetch(u, i));
  const br = `${target}.br`;
  await mkdir(dirname(target), { recursive: true });
  try {
    const res = await f(m.url, { headers: { 'User-Agent': KB_UA }, signal: AbortSignal.timeout(o.timeoutMs ?? 300_000) });
    if (!res.ok || !res.body) throw new CentralKbError(`KB snapshot: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(br));
    const hash = await sha256File(br);
    if (hash !== m.sha256) throw new CentralKbError(`KB snapshot sha256 mismatch: expected ${m.sha256}, got ${hash}`);
    await rm(target, { force: true });
    await pipeline(createReadStream(br), createBrotliDecompress(), createWriteStream(target));
  } catch (e) {
    await rm(target, { force: true }).catch(() => undefined);
    throw e;
  } finally {
    await rm(br, { force: true }).catch(() => undefined);
  }
}

