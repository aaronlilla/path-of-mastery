import { createHash, verify as edVerify, type KeyObject } from 'node:crypto';
import { existsSync, linkSync, copyFileSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { importEd25519PublicKey } from '../updater/signature.js';
import { BAKED_UPDATE_PUBLIC_KEY } from '../updater/updateKey.js';
import { KB_UA } from '../kb/http.js';

/**
 * The next-league preview overlay as we ship it (tools/preview-data/publish-preview.mjs): the patch notes read once on
 * our side, applied to the live engine data, and the patched data files packed (Brotli JSON) and signed with the
 * update key, like the central KB. Assets of the `preview` release on the public releases repo. The app offers the
 * preview only for a signed overlay of a patch newer than its own data, built on that data.
 */

export const DEFAULT_PREVIEW_MANIFEST_URL = 'https://github.com/aaronlilla/pathofmastery-releases/releases/download/preview/preview-manifest.json';
export const PREVIEW_MANIFEST_FORMAT = 'pom-preview/1';
export const PREVIEW_PACK_FORMAT = 'pom-preview-pack/1';

export interface PreviewManifest {
  format: string;
  patch: string;
  livePatch: string;
  treeVersion: string;
  notesCheckedAt: string;
  threadUrl: string;
  builtAt: string;
  sha256: string;
  size: number;
  url: string;
  signature: string;
}

/** The exact bytes signed; its own prefix, so it can never pass as a KB or update-layer signature. publish-preview.mjs must match. */
export function previewSigningPayload(m: Omit<PreviewManifest, 'signature' | 'format'>): string {
  return `pom-preview1:${m.patch}:${m.livePatch}:${m.treeVersion}:${m.notesCheckedAt}:${m.threadUrl}:${m.builtAt}:${m.sha256}:${m.size}:${m.url}`;
}

export class PreviewError extends Error {}

/** Checks shape and signature. Throws PreviewError with the reason. */
export function verifyPreviewManifest(raw: unknown, publicKey: KeyObject = importEd25519PublicKey(BAKED_UPDATE_PUBLIC_KEY)): PreviewManifest {
  const m = raw as PreviewManifest;
  if (!m || typeof m !== 'object' || m.format !== PREVIEW_MANIFEST_FORMAT) throw new PreviewError('not a preview manifest');
  for (const k of ['patch', 'livePatch', 'treeVersion', 'notesCheckedAt', 'threadUrl', 'builtAt', 'url', 'signature'] as const) {
    if (typeof m[k] !== 'string' || !m[k]) throw new PreviewError(`preview manifest has no ${k}`);
  }
  if (!/^[a-f0-9]{64}$/.test(m.sha256) || !Number.isInteger(m.size) || m.size <= 0) throw new PreviewError('preview manifest has a bad sha256 or size');
  let ok = false;
  try {
    ok = edVerify(null, Buffer.from(previewSigningPayload(m), 'utf8'), publicKey, Buffer.from(m.signature, 'base64'));
  } catch {
    ok = false;
  }
  if (!ok) throw new PreviewError('preview manifest signature is not valid');
  return m;
}

const ver = (p: string): number[] => (/^(\d+)\.(\d+)(?:\.(\d+))?/.exec(p)?.slice(1) ?? []).map((x) => Number(x ?? 0));
const cmp = (a: number[], b: number[]): number => {
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
};

/** True when `m` is a next league for an app whose data is `appLive` ("3.29"): built on that data, for a newer x.y. */
export function offered(m: Pick<PreviewManifest, 'patch' | 'livePatch'>, appLive: string): boolean {
  const live = ver(appLive).slice(0, 2);
  return cmp(ver(m.livePatch).slice(0, 2), live) === 0 && cmp(ver(m.patch).slice(0, 2), live) > 0;
}

/** The live patch of a data dir: its newest passive tree ("tree_3_29.json" -> "3.29"). */
export function livePatchOf(dataDir: string): string | null {
  let best: number[] | null = null;
  for (const f of readdirSync(dataDir)) {
    const m = /^tree_(\d+)_(\d+)\.json$/.exec(f);
    if (!m) continue;
    const v = [Number(m[1]), Number(m[2])];
    if (!best || cmp(v, best) > 0) best = v;
  }
  return best ? best.join('.') : null;
}

/**
 * Unpacks a verified pack into `target`: the pack's files, and every other file of the live data dir hard-linked (or
 * copied). The live dir is never written. Written to a staging folder first, so a half-made dir is never used.
 */
export async function installPreviewPack(m: PreviewManifest, pack: Buffer, liveDataDir: string, target: string): Promise<void> {
  if (pack.length !== m.size) throw new PreviewError(`preview pack size mismatch: expected ${m.size}, got ${pack.length}`);
  const hash = createHash('sha256').update(pack).digest('hex');
  if (hash !== m.sha256) throw new PreviewError(`preview pack sha256 mismatch: expected ${m.sha256}, got ${hash}`);
  const body = JSON.parse(brotliDecompressSync(pack).toString('utf8')) as { format?: string; patch?: string; files?: Record<string, string> };
  if (body.format !== PREVIEW_PACK_FORMAT || body.patch !== m.patch || !body.files || typeof body.files !== 'object') throw new PreviewError('not a preview pack for this manifest');
  const names = Object.keys(body.files);
  for (const n of names) if (!/^[A-Za-z0-9_.-]+\.json$/.test(n) || n.startsWith('.')) throw new PreviewError(`preview pack has a bad file name: ${n}`);
  if (!names.includes('preview-overlay.index.json')) throw new PreviewError('preview pack has no index');
  const staging = `${target}.part`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    const own = new Set(names);
    for (const f of readdirSync(liveDataDir)) {
      const s = join(liveDataDir, f);
      if (own.has(f) || !statSync(s).isFile()) continue;
      try {
        linkSync(s, join(staging, f));
      } catch {
        copyFileSync(s, join(staging, f));
      }
    }
    for (const n of names) writeFileSync(join(staging, n), body.files[n]!);
    rmSync(target, { recursive: true, force: true });
    renameSync(staging, target);
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    throw e;
  }
}

export interface PreviewFetchOptions {
  manifestUrl?: string;
  publicKey?: KeyObject;
  fetch?: (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;
  /** Cuts off a manifest fetch (default 30 s) or a pack download (default 5 min); a failed download already means "no preview". */
  timeoutMs?: number;
}

/** Fetches and verifies the manifest; null when none is published (404). */
export async function fetchPreviewManifest(o: PreviewFetchOptions = {}): Promise<PreviewManifest | null> {
  const f = o.fetch ?? ((u, i) => fetch(u, i));
  const res = await f(o.manifestUrl ?? DEFAULT_PREVIEW_MANIFEST_URL, { headers: { 'User-Agent': KB_UA, Accept: 'application/json' }, signal: AbortSignal.timeout(o.timeoutMs ?? 30_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new PreviewError(`preview manifest: HTTP ${res.status}`);
  return verifyPreviewManifest(await res.json(), o.publicKey);
}

/** Downloads the pack `m` names and installs it into `target` (unless it is there already). */
export async function downloadPreview(m: PreviewManifest, liveDataDir: string, target: string, o: PreviewFetchOptions = {}): Promise<void> {
  if (existsSync(join(target, 'preview-overlay.index.json'))) return;
  const f = o.fetch ?? ((u, i) => fetch(u, i));
  const res = await f(m.url, { headers: { 'User-Agent': KB_UA }, signal: AbortSignal.timeout(o.timeoutMs ?? 300_000) });
  if (!res.ok) throw new PreviewError(`preview pack: HTTP ${res.status}`);
  await installPreviewPack(m, Buffer.from(await res.arrayBuffer()), liveDataDir, target);
}
