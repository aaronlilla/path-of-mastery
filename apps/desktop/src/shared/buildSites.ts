import type { ImportSource } from './library.js';

/**
 * Build sites we can read a code from, and the raw-code URL for a pasted link. The list and the link
 * patterns follow upstream's own (Modules/BuildSiteTools.lua), with pobb.in read through its
 * /raw route.
 */

export interface BuildSite {
  source: Exclude<ImportSource, 'code' | 'file'>;
  label: string;
  /** Matches a pasted link and captures the build id. */
  link: RegExp;
  /** Raw-code URLs to try in order; {id} is the captured id. */
  raw: string[];
}

export const BUILD_SITES: BuildSite[] = [
  { source: 'pobb.in', label: 'pobb.in', link: /^https?:\/\/(?:www\.)?pobb\.in\/([A-Za-z0-9_-]+)\/?(?:raw)?\/?$/i, raw: ['https://pobb.in/{id}/raw', 'https://pobb.in/pob/{id}'] },
  { source: 'pob.codes', label: 'pob.codes', link: /^https?:\/\/pob\.codes\/b\/([A-Za-z0-9_-]+)\/?$/i, raw: ['https://api.pob.codes/{id}/raw'] },
  { source: 'poe.ninja', label: 'poe.ninja', link: /^https?:\/\/(?:www\.)?poe\.ninja\/(?:poe1\/)?pob\/(?:raw\/)?([A-Za-z0-9]+)\/?$/i, raw: ['https://poe.ninja/poe1/pob/raw/{id}'] },
  { source: 'pastebin', label: 'Pastebin', link: /^https?:\/\/(?:www\.)?pastebin\.com\/(?:raw\/)?([A-Za-z0-9]+)\/?$/i, raw: ['https://pastebin.com/raw/{id}'] },
  { source: 'pastebinp', label: 'PastebinP', link: /^https?:\/\/pastebinp\.com\/(?:raw\/)?([A-Za-z0-9]+)\/?$/i, raw: ['https://pastebinp.com/raw/{id}'] },
  { source: 'rentry', label: 'Rentry', link: /^https?:\/\/rentry\.co\/([A-Za-z0-9-]+)\/?(?:raw)?\/?$/i, raw: ['https://rentry.co/paste/{id}/raw'] },
  { source: 'maxroll', label: 'Maxroll', link: /^https?:\/\/maxroll\.gg\/poe\/pob\/([^\s?#]+)$/i, raw: ['https://maxroll.gg/poe/api/pob/{id}'] },
  { source: 'poedb', label: 'poedb.tw', link: /^https?:\/\/poedb\.tw\/pob\/([^\s?#/]+)\/?(?:raw)?$/i, raw: ['https://poedb.tw/pob/{id}/raw'] },
  { source: 'mobalytics', label: 'Mobalytics', link: /^https?:\/\/(?:www\.)?mobalytics\.gg\/poe\/builds\/([^\s?#/]+)\/?(?:[?#]\S*)?$/i, raw: [] },
];

export interface SiteMatch {
  site: BuildSite;
  id: string;
  urls: string[];
}

/**
 * What upstream does to pasted text before it looks at it: trims spaces and "?" at both ends, and takes the real
 * link out of a youtube.com/redirect or google.com/url wrapper.
 */
export function cleanImportText(input: string): string {
  let t = input.replace(/^[\s?]+/, '').replace(/[\s?]+$/, '');
  if (/youtube\.com\/redirect\?|google\.com\/url\?/.test(t)) {
    const q = /[?&]q=([^&]+)/.exec(t);
    if (q) {
      try {
        t = decodeURIComponent(q[1]!.replace(/\+/g, ' '));
      } catch {
        /* keep the wrapper */
      }
    }
  }
  return t;
}

export function matchBuildSite(input: string): SiteMatch | null {
  const t = cleanImportText(input);
  if (!/^https?:\/\//i.test(t)) return null;
  for (const site of BUILD_SITES) {
    const m = site.link.exec(t);
    if (m && m[1]) return { site, id: m[1], urls: site.raw.map((u) => u.replace('{id}', m[1]!)) };
  }
  return null;
}

export type ClassifiedInput =
  | { kind: 'empty' }
  | { kind: 'xml' }
  | { kind: 'code' }
  | { kind: 'link'; match: SiteMatch }
  /** A poe.ninja character page: the character is read from the game's public character window, then imported like any build. */
  | { kind: 'character-link'; account: string; character: string }
  | { kind: 'unsupported-link'; host: string }
  | { kind: 'unknown' };

/** `https://poe.ninja/poe1/builds/<league>/character/<account>/<character>`: poe.ninja writes the account's # as a dash. */
export function ninjaCharacterOf(url: string): { account: string; character: string } | null {
  const m = /^https?:\/\/(?:www\.)?poe\.ninja\/(?:poe1\/)?builds\/[^/?#]+\/character\/([^/?#]+)\/([^/?#]+)/i.exec(url);
  if (!m) return null;
  try {
    return { account: decodeURIComponent(m[1]!), character: decodeURIComponent(m[2]!) };
  } catch {
    return null;
  }
}

/** What a pasted string looks like, without reading it. */
export function classifyImportText(input: string): ClassifiedInput {
  const t = cleanImportText(input);
  if (!t) return { kind: 'empty' };
  if (t.startsWith('<')) return { kind: 'xml' };
  if (/^https?:\/\//i.test(t)) {
    const ch = ninjaCharacterOf(t);
    if (ch) return { kind: 'character-link', ...ch };
    const match = matchBuildSite(t);
    if (match) return { kind: 'link', match };
    let host = t;
    try {
      host = new URL(t).hostname;
    } catch {
      /* keep the raw text */
    }
    return { kind: 'unsupported-link', host };
  }
  if (looksLikeCodeText(t)) return { kind: 'code' };
  return { kind: 'unknown' };
}

/**
 * Like upstream, anything outside the code's alphabet (spaces, line breaks, stray marks) is ignored when the code is
 * read. Text counts as a code when what is left is long enough and the ignored part is a small share of it.
 */
export function looksLikeCodeText(text: string): boolean {
  const t = text.replace(/\s+/g, '');
  const kept = t.replace(/[^A-Za-z0-9+/_=-]/g, '');
  if (kept.length < 24 || t.length - kept.length > Math.max(2, Math.floor(t.length * 0.1))) return false;
  // Wrapped or spaced codes have long pieces; a sentence has short words.
  const pieces = text.trim().split(/\s+/);
  return pieces.slice(0, -1).every((w) => w.length >= 8);
}

/** The sites a build can be shared to: upstream's list entries that have an upload address. */
export type ShareSiteId = 'maxroll' | 'pob.codes' | 'pobb.in' | 'poe.ninja' | 'poedb';

export interface ShareSite {
  id: ShareSiteId;
  label: string;
  postUrl: string;
  /** Put in front of the code in the request body. */
  postFields: string;
  /** Put in front of the site's answer to make the link ("" when the answer is the whole link). */
  codeOut: string;
}

export const SHARE_SITES: ShareSite[] = [
  { id: 'maxroll', label: 'Maxroll', postUrl: 'https://maxroll.gg/poe/api/pob', postFields: 'pobCode=', codeOut: 'https://maxroll.gg/poe/pob/' },
  { id: 'pob.codes', label: 'pob.codes', postUrl: 'https://api.pob.codes/pob/plain', postFields: '', codeOut: 'https://pob.codes/b/' },
  { id: 'pobb.in', label: 'pobb.in', postUrl: 'https://pobb.in/pob/', postFields: '', codeOut: 'https://pobb.in/' },
  { id: 'poe.ninja', label: 'poe.ninja', postUrl: 'https://poe.ninja/poe1/pob/api/upload', postFields: 'code=', codeOut: '' },
  { id: 'poedb', label: 'poedb.tw', postUrl: 'https://poedb.tw/pob/api/gen', postFields: '', codeOut: '' },
];

/** The link a site's upload answer stands for: the answer after `codeOut`, or the answer itself when it is already a link. */
export function shareLinkFrom(site: ShareSite, answer: string): string | null {
  const a = answer.trim();
  if (/^https?:\/\/\S+$/.test(a)) return /[^/]$/.test(a) ? a : null;
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(a)) return null;
  if (site.codeOut) return site.codeOut + a;
  if (site.id === 'poe.ninja') return 'https://poe.ninja/poe1/pob/' + a;
  if (site.id === 'poedb') return 'https://poedb.tw/pob/' + a;
  return null;
}
