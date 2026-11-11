import { isId, parseId, type PublicId } from './stamp.js';
import type { ValidationResult } from './validation.js';

export type ItemLinkIntent = { kind: 'item'; publicId: PublicId; revision?: number; view: 'detail' | 'run' };
export type LinkLimits = { maxLength: number };
const invalid = (): ValidationResult<ItemLinkIntent> => ({ ok: false, issues: [{ code: 'INVALID_LINK', path: '$', message: 'This public item link is invalid.' }] });

export function isSafeHttpsUrl(value: string): boolean {
  if (value.trim() !== value || /[\u0000-\u0020\\]/.test(value) || !value.startsWith('https://')) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.length > 0 && !url.username && !url.password;
  } catch { return false; }
}

export function parseItemLink(input: unknown, limits: LinkLimits): ValidationResult<ItemLinkIntent> {
  if (!Number.isSafeInteger(limits.maxLength) || limits.maxLength <= 0 || typeof input !== 'string'
      || input.length > limits.maxLength || input.trim() !== input || /[\u0000-\u0020\\%#]/.test(input)) return invalid();
  try {
    const url = new URL(input);
    if (url.username || url.password || url.port || url.hash) return invalid();
    let rawId: string;
    let view: 'detail' | 'run' = 'detail';
    const web = url.protocol === 'https:';
    if (web) {
      if (url.hostname !== 'pathofmastery.gg' || !input.startsWith('https://pathofmastery.gg/')) return invalid();
      const match = /^\/p\/([^/]+)(\/run)?$/.exec(url.pathname);
      if (!match) return invalid();
      rawId = match[1]!;
      if (match[2]) view = 'run';
    } else {
      if (url.protocol !== 'pathofmastery:' || url.hostname !== 'item' || !input.startsWith('pathofmastery://item/')) return invalid();
      const match = /^\/([^/]+)$/.exec(url.pathname);
      if (!match) return invalid();
      rawId = match[1]!;
    }
    // URL parsing normalizes dot segments; require the supplied route itself to match.
    const suppliedRoute = input.split('?')[0];
    const expectedRoute = web ? `https://pathofmastery.gg/p/${rawId}${view === 'run' ? '/run' : ''}` : `${url.protocol}//item/${rawId}`;
    if (suppliedRoute !== expectedRoute || !isId('public', rawId)) return invalid();
    const keys = [...url.searchParams.keys()];
    if (new Set(keys).size !== keys.length || keys.some(key => key !== 'revision' && (web || key !== 'view'))) return invalid();
    if (url.searchParams.has('view')) {
      if (url.searchParams.get('view') !== 'run') return invalid();
      view = 'run';
    }
    const revisionText = url.searchParams.get('revision');
    let revision: number | undefined;
    if (revisionText !== null) {
      if (!/^[1-9]\d*$/.test(revisionText)) return invalid();
      revision = Number(revisionText);
      if (!Number.isSafeInteger(revision)) return invalid();
    }
    const value: ItemLinkIntent = { kind: 'item', publicId: rawId, view };
    if (revision !== undefined) value.revision = revision;
    return { ok: true, value };
  } catch { return invalid(); }
}

export function formatItemLink(intent: ItemLinkIntent, target: 'web' | 'pathofmastery'): string {
  parseId('public', intent.publicId);
  if (intent.kind !== 'item' || !['detail', 'run'].includes(intent.view)) throw new TypeError('Invalid item intent.');
  if (intent.revision !== undefined && (!Number.isSafeInteger(intent.revision) || intent.revision < 1)) throw new TypeError('Invalid display revision.');
  if (!['web', 'pathofmastery'].includes(target)) throw new TypeError('Unsupported link target.');
  const root = target === 'web' ? `https://pathofmastery.gg/p/${intent.publicId}${intent.view === 'run' ? '/run' : ''}` : `${target}://item/${intent.publicId}`;
  const params = new URLSearchParams();
  if (intent.revision !== undefined) params.set('revision', String(intent.revision));
  if (target !== 'web' && intent.view === 'run') params.set('view', 'run');
  return `${root}${params.size ? `?${params}` : ''}`;
}
