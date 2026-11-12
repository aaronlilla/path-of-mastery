import type { FilterSetup, Rule } from './types.js';

/**
 * Share link and rule pack. Both are plain data the app's import reads back: nothing goes to a server.
 *  - A share link carries a whole filter (its setup and every rule) in the link itself.
 *  - A rule pack is a file of the player's own rules, to add to another filter.
 */

export const LINK_PREFIX = 'pathofmastery://filter?code=';
export const PACK_KIND = 'pom-rule-pack';

export interface SharedFilter {
  v: 1;
  name: string;
  setup: FilterSetup;
  rules: Rule[];
}

export interface RulePack {
  kind: typeof PACK_KIND;
  version: 1;
  name: string;
  rules: Rule[];
}

const b64url = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64url = (t: string): Uint8Array => {
  const s = atob(t.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((t.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

export async function makeShareLink(f: SharedFilter): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(f));
  return LINK_PREFIX + b64url(await pipe(json, new CompressionStream('deflate-raw')));
}

/** Reads a share link, or the bare code after `code=`. Returns null when the text is neither. */
export async function readShareLink(text: string): Promise<SharedFilter | null> {
  const t = text.trim();
  const code = t.startsWith(LINK_PREFIX) ? t.slice(LINK_PREFIX.length) : /^[A-Za-z0-9_-]{20,}$/.test(t) ? t : '';
  if (!code) return null;
  try {
    const raw = await pipe(fromB64url(code), new DecompressionStream('deflate-raw'));
    const f = JSON.parse(new TextDecoder().decode(raw)) as SharedFilter;
    if (f.v !== 1 || typeof f.name !== 'string' || !f.setup || !Array.isArray(f.rules)) return null;
    return f;
  } catch {
    return null;
  }
}

/** The player's own rules (not the ones the build wrote) as a pack file's text. */
export function makeRulePack(name: string, rules: Rule[]): string {
  const pack: RulePack = { kind: PACK_KIND, version: 1, name, rules: rules.filter((r) => r.source !== 'build') };
  return JSON.stringify(pack, null, 2);
}

export function readRulePack(text: string): RulePack | null {
  try {
    const p = JSON.parse(text) as RulePack;
    if (p.kind !== PACK_KIND || p.version !== 1 || !Array.isArray(p.rules)) return null;
    return p;
  } catch {
    return null;
  }
}

/** Gives pack rules new ids and priorities above `topPriority`, so they land above what is already there and keep their order. */
export function placeRules(rules: Rule[], idSuffix: string, topPriority: number, now = Date.now()): Rule[] {
  const sorted = [...rules].sort((a, b) => a.priority - b.priority);
  return sorted.map((r, i) => ({ ...r, id: `${r.id}-${idSuffix}`, priority: topPriority + 1 + i, createdAt: now }));
}
