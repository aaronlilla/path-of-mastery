import type { UpdateChannel, UpdateLayer, UpdateLayerName, UpdateManifest } from '@pom/protocol';
import { isUpdateChannel } from '@pom/protocol';
import { isSemver } from '@pom/protocol/semver';

export class ManifestParseError extends Error {}

/** A manifest layer, with the optional release notes the Update Available dialog shows (display only, not signed). */
export type ManifestLayer = UpdateLayer & { notes?: string[] };
export type ParsedManifest = Omit<UpdateManifest, 'layers'> & { layers: Record<UpdateLayerName, ManifestLayer> };

const LAYER_NAMES: UpdateLayerName[] = ['engine', 'interface', 'app'];

function parseLayer(value: unknown, layerName: UpdateLayerName): ManifestLayer {
  if (typeof value !== 'object' || value === null) {
    throw new ManifestParseError(`layer "${layerName}" is missing or not an object`);
  }
  const v = value as Record<string, unknown>;
  if (typeof v.version !== 'string' || v.version.length === 0) {
    throw new ManifestParseError(`layer "${layerName}" has an invalid "version"`);
  }
  if (typeof v.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(v.sha256)) {
    throw new ManifestParseError(`layer "${layerName}" has an invalid "sha256"`);
  }
  if (typeof v.size !== 'number' || !Number.isFinite(v.size) || v.size < 0) {
    throw new ManifestParseError(`layer "${layerName}" has an invalid "size"`);
  }
  if (typeof v.url !== 'string' || v.url.length === 0) {
    throw new ManifestParseError(`layer "${layerName}" has an invalid "url"`);
  }
  if (typeof v.signature !== 'string' || v.signature.length === 0) {
    throw new ManifestParseError(`layer "${layerName}" has an invalid "signature"`);
  }
  const notes = Array.isArray(v.notes) ? v.notes.filter((n): n is string => typeof n === 'string' && n.trim().length > 0) : undefined;
  const out: ManifestLayer = { version: v.version, sha256: v.sha256.toLowerCase(), size: v.size, url: v.url, signature: v.signature, ...(notes?.length ? { notes } : {}) };
  // The signed delivery fields (layerSigningPayload v2). A malformed one is an error, never dropped: dropping it would
  // change what the signature covers.
  const has = (k: string) => v[k] !== undefined && v[k] !== null;
  for (const k of ['minimumVersion', 'forApp'] as const) {
    if (!has(k)) continue;
    if (!isSemver(v[k])) throw new ManifestParseError(`layer "${layerName}" has an invalid "${k}"`);
    out[k] = v[k] as string;
  }
  for (const k of ['critical', 'allowDowngrade'] as const) {
    if (!has(k)) continue;
    if (typeof v[k] !== 'boolean') throw new ManifestParseError(`layer "${layerName}" has an invalid "${k}"`);
    out[k] = v[k] as boolean;
  }
  if (has('rolloutPercent')) {
    const n = v.rolloutPercent;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 100) throw new ManifestParseError(`layer "${layerName}" has an invalid "rolloutPercent"`);
    out.rolloutPercent = n;
  }
  return out;
}

/**
 * Validates and normalizes a raw manifest JSON payload. Throws
 * ManifestParseError with a specific reason rather than silently coercing a
 * malformed manifest into something that might update the wrong layer.
 */
export function parseManifest(raw: unknown, platformKey: string = `${process.platform}-${process.arch}`): ParsedManifest {
  if (typeof raw !== 'object' || raw === null) {
    throw new ManifestParseError('manifest is not a JSON object');
  }
  const v = raw as Record<string, unknown>;
  if (v.placeholder === true) {
    throw new ManifestParseError('No update has been published yet.');
  }
  if (!isUpdateChannel(v.channel)) {
    throw new ManifestParseError(`manifest has an invalid "channel": ${String(v.channel)}`);
  }
  if (typeof v.generatedAt !== 'string') {
    throw new ManifestParseError('manifest is missing "generatedAt"');
  }
  if (typeof v.layers !== 'object' || v.layers === null) {
    throw new ManifestParseError('manifest is missing "layers"');
  }
  let layersRaw = v.layers as Record<string, unknown>;
  // The base layers are the Windows build. Other systems read `platforms["darwin-arm64"]` / `["linux-x64"]`, which must hold
  // its own engine and app (a .node and a .dmg/.AppImage); the interface bundle is plain JS and is shared unless overridden.
  if (!platformKey.startsWith('win32')) {
    const own = (v.platforms as Record<string, Record<string, unknown>> | undefined)?.[platformKey];
    if (!own?.engine || !own.app) throw new ManifestParseError(`No update has been published for ${platformKey} yet.`);
    layersRaw = { ...layersRaw, ...own };
  }
  const layers = {} as Record<UpdateLayerName, ManifestLayer>;
  for (const name of LAYER_NAMES) {
    layers[name] = parseLayer(layersRaw[name], name);
  }
  return { channel: v.channel as UpdateChannel, generatedAt: v.generatedAt, layers };
}

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; headers?: { get(name: string): string | null } }>;

export async function fetchManifest(url: string, fetchImpl: FetchLike = fetch): Promise<ParsedManifest> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`failed to fetch manifest from ${url}: HTTP ${response.status}`);
  }
  return parseManifest(await response.json());
}

export function manifestUrlFor(baseUrl: string, channel: UpdateChannel): string {
  const separator = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${separator}channel=${channel}`;
}

/** Thrown for a check that could not reach the server (offline, DNS, refused): automatic checks stay quiet about it. */
export class ManifestNetworkError extends Error {}

/**
 * Fetches the manifest the way a browser cache would: within the server's max-age the last copy is reused without a
 * request (unless `force`), and after it a conditional request (If-None-Match / If-Modified-Since) costs a 304 when
 * nothing changed. The site serves the manifest with max-age=300.
 */
export class ManifestFetcher {
  private cache: { url: string; manifest: ParsedManifest; etag?: string; lastModified?: string; freshUntil: number } | null = null;

  constructor(
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly now: () => number = Date.now,
  ) {}

  async fetch(url: string, opts: { force?: boolean } = {}): Promise<{ manifest: ParsedManifest; from: 'network' | 'cache' | 'revalidated' }> {
    const c = this.cache && this.cache.url === url ? this.cache : null;
    if (c && !opts.force && this.now() < c.freshUntil) return { manifest: c.manifest, from: 'cache' };
    const headers: Record<string, string> = {};
    if (c?.etag) headers['If-None-Match'] = c.etag;
    if (c?.lastModified) headers['If-Modified-Since'] = c.lastModified;
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.fetchImpl(url, { headers });
    } catch (e) {
      throw new ManifestNetworkError(`could not reach the update server: ${e instanceof Error ? e.message : String(e)}`);
    }
    const header = (n: string) => response.headers?.get(n) ?? undefined;
    const maxAge = Number(/max-age=(\d+)/.exec(header('cache-control') ?? '')?.[1] ?? 0);
    const freshUntil = this.now() + Math.min(maxAge, 3600) * 1000;
    if (response.status === 304 && c) {
      c.freshUntil = freshUntil;
      return { manifest: c.manifest, from: 'revalidated' };
    }
    if (!response.ok) throw new Error(`failed to fetch manifest from ${url}: HTTP ${response.status}`);
    const manifest = parseManifest(await response.json());
    const etag = header('etag');
    const lastModified = header('last-modified');
    this.cache = { url, manifest, freshUntil, ...(etag ? { etag } : {}), ...(lastModified ? { lastModified } : {}) };
    return { manifest, from: 'network' };
  }
}
