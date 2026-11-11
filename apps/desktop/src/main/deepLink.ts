import { parseItemLink } from '@pom/mastery-contracts';

const PROTOCOLS = ['pathofmastery'] as const;
/** Longest link accepted at all (argv and open-url are untrusted input). */
const MAX_LINK_LENGTH = 2048;

export type DeepLinkRoute =
  | { kind: 'importCode'; code: string }
  | { kind: 'openBuild'; buildId: string }
  /** A sign-in link brought the player back; the main process finishes the sign-in itself. */
  | { kind: 'authCallback'; url: string }
  | { kind: 'share'; token: string }
  /** A public Marketplace item (the page's "Open in Path of Mastery" link); view 'run' is the explicit Run intent. */
  | { kind: 'item'; publicId: string; revision?: number; view: 'detail' | 'run' }
  | { kind: 'unknown'; raw: string };

/**
 * Parses `pathofmastery://...` URLs, whether they arrive via `open-url` (macOS) or
 * as an argv entry on a second-instance launch (Windows/Linux). Registration
 * of the protocols (`app.setAsDefaultProtocolClient`) happens in index.ts, which is the only place that needs
 * the real `electron` module. Incoming links never run a command or open a local path.
 */
export function parseDeepLink(url: string): DeepLinkRoute {
  if (typeof url !== 'string' || url.length > MAX_LINK_LENGTH) return { kind: 'unknown', raw: String(url).slice(0, 200) };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'unknown', raw: url };
  }
  const scheme = parsed.protocol.replace(/:$/, '');
  if (!(PROTOCOLS as readonly string[]).includes(scheme)) {
    return { kind: 'unknown', raw: url };
  }
  const host = parsed.hostname || parsed.pathname.replace(/^\/+/, '');
  if (host === 'item') {
    const item = parseItemLink(url, { maxLength: MAX_LINK_LENGTH });
    if (!item.ok) return { kind: 'unknown', raw: url };
    return { kind: 'item', publicId: item.value.publicId, view: item.value.view, ...(item.value.revision !== undefined ? { revision: item.value.revision } : {}) };
  }
  if (host === 'import') {
    const code = parsed.searchParams.get('code');
    if (code) return { kind: 'importCode', code };
  }
  if (host === 'auth') return { kind: 'authCallback', url };
  if (host === 'share') {
    const token = parsed.pathname.replace(/^\/+|\/+$/g, '');
    if (/^[A-Za-z0-9_-]{8,64}$/.test(token)) return { kind: 'share', token };
  }
  if (host === 'build') {
    const buildId = parsed.searchParams.get('id');
    if (buildId) return { kind: 'openBuild', buildId };
  }
  return { kind: 'unknown', raw: url };
}

export function findDeepLinkInArgv(argv: readonly string[]): string | undefined {
  return argv.find((arg) => PROTOCOLS.some((p) => arg.startsWith(`${p}://`)));
}

export { PROTOCOLS };
