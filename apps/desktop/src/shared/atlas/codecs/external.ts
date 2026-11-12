export const NOT_SUPPORTED_YET = 'not supported yet';
export const UNSUPPORTED_ATLAS_LINK = 'This atlas link format is not supported yet.';
export const UNAVAILABLE_OFFICIAL_EXPORT = 'Official link export is unavailable for this tree data.';
export const BUILD_TREE_MESSAGE = 'This is a Build passive tree. Open it in Builds?';
export type ExternalFormat = 'official' | 'poeplanner';
// Both formats were verified against live poeplanner.com 2.10.8.3 output and its importer/exporter code (see test/fixtures/mastery-formats/LINKS.md).
// The official format is the one poeplanner writes for pathofexile.com; pathofexile.com itself returned 403 to automated fetches.
export const ATLAS_EXTERNAL_FORMATS = Object.freeze([
  Object.freeze({ format: 'official' as const, status: 'supported' as const, message: UNSUPPORTED_ATLAS_LINK, exportMessage: UNAVAILABLE_OFFICIAL_EXPORT }),
  Object.freeze({ format: 'poeplanner' as const, status: 'supported' as const, message: UNSUPPORTED_ATLAS_LINK, exportMessage: UNSUPPORTED_ATLAS_LINK }),
]);
export type DecodedAtlasAllocation = {
  format: ExternalFormat;
  /** Exact atlas node IDs (the export's node key / PassiveSkillGraphId) as decimal strings, in link order. */
  nodeIds: string[];
  /** Format version byte(s): official u32 (6) or poeplanner u16 (5). */
  formatVersion: number;
  /** poeplanner tree version number. Official links carry no tree or variant information. */
  treeVersion?: number;
  /** poeplanner version table entry, only for treeVersion values observed in its manifest. */
  patch?: string;
  ruthless?: boolean;
};
// Observed in poeplanner's /json/versions.json atlasVersions.
const POEPLANNER_TREE_VERSIONS: Readonly<Record<number, { patch: string; ruthless: boolean }>> = Object.freeze({
  28: { patch: '3.29.0', ruthless: false }, 27: { patch: '3.29.0', ruthless: true },
  26: { patch: '3.28.0', ruthless: false }, 25: { patch: '3.28.0', ruthless: true },
});
const MAX_NODE_ID = 0xffff;
function fromBase64(code: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_+/-]+={0,2}$/.test(code)) return null;
  const std = code.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  if (std.length % 4 === 1) return null;
  const bin = atob(std + '='.repeat((4 - (std.length % 4)) % 4));
  return Uint8Array.from(bin, ch => ch.charCodeAt(0));
}
function toBase64Url(bytes: readonly number[]): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_');
}
function decodeOfficial(b: Uint8Array): DecodedAtlasAllocation | null {
  // u32 BE version (6), u8 class (0), u8 ascendancy (0), u8 count, count x u16 BE node id, u8 extended count (0), u8 mastery count (0).
  if (b.length < 9) return null;
  const version = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
  if (version !== 6 || b[4] !== 0 || b[5] !== 0) return null;
  const count = b[6]!;
  if (b.length !== 7 + count * 2 + 2 || b[b.length - 2] !== 0 || b[b.length - 1] !== 0) return null;
  const ids: string[] = [];
  for (let i = 0; i < count; i++) ids.push(String((b[7 + i * 2]! << 8) | b[8 + i * 2]!));
  return { format: 'official', nodeIds: ids, formatVersion: version };
}
function decodePoeplanner(b: Uint8Array): DecodedAtlasAllocation | null {
  // u16 LE version (5), u16 LE tree version, u8 isPoE2 (0), u16 LE count, count x u16 LE node id, u16 LE notes length, gzip notes.
  if (b.length < 9) return null;
  const u16 = (o: number) => b[o]! | (b[o + 1]! << 8);
  if (u16(0) !== 5 || b[4] !== 0) return null;
  const treeVersion = u16(2), count = u16(5);
  const notesAt = 7 + count * 2;
  if (b.length < notesAt + 2 || b.length !== notesAt + 2 + u16(notesAt)) return null;
  const ids: string[] = [];
  for (let i = 0; i < count; i++) ids.push(String(u16(7 + i * 2)));
  const known = POEPLANNER_TREE_VERSIONS[treeVersion];
  return { format: 'poeplanner', nodeIds: ids, formatVersion: 5, treeVersion, ...(known ?? {}) };
}
/** Decode an official or poeplanner atlas code. Same sniffing as poeplanner: first three bytes all zero means the official layout. */
export function decodeAtlasCode(code: string): DecodedAtlasAllocation | null {
  let bytes: Uint8Array | null;
  try { bytes = fromBase64(code); } catch { return null; }
  if (!bytes || bytes.length < 3) return null;
  const decoded = bytes[0]! + bytes[1]! + bytes[2]! === 0 ? decodeOfficial(bytes) : decodePoeplanner(bytes);
  if (!decoded) return null;
  if (new Set(decoded.nodeIds).size !== decoded.nodeIds.length) return null;
  return decoded;
}
/** pathofexile.com fullscreen-atlas-skill-tree link for exact node IDs. Null when an ID cannot be represented. */
export function encodeOfficialAtlasLink(nodeIds: readonly string[]): string | null {
  if (nodeIds.length > 255 || new Set(nodeIds).size !== nodeIds.length) return null;
  const bytes = [0, 0, 0, 6, 0, 0, nodeIds.length];
  for (const id of nodeIds) {
    if (!/^(0|[1-9]\d{0,4})$/.test(id) || Number(id) > MAX_NODE_ID) return null;
    bytes.push(Number(id) >> 8, Number(id) & 255);
  }
  bytes.push(0, 0);
  return `https://www.pathofexile.com/fullscreen-atlas-skill-tree/${toBase64Url(bytes)}`;
}
export type LinkDetection = { kind: 'build'; input: string; message: typeof BUILD_TREE_MESSAGE }
  | ({ kind: 'allocation'; input: string } & DecodedAtlasAllocation)
  | { kind: 'unsupported'; input: string; format: ExternalFormat | 'unknown'; status: typeof NOT_SUPPORTED_YET; message: typeof UNSUPPORTED_ATLAS_LINK }
  | { kind: 'invalid'; input: string };

// Detect routes and decode verified atlas allocation links. Anything undecodable stays unsupported.
export function detectAtlasLink(input: string): LinkDetection {
  const trimmed = input.trim();
  let url: URL;
  try { url = new URL(trimmed); } catch { return { kind: 'invalid', input }; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return { kind: 'invalid', input };
  const host = url.hostname.toLowerCase();
  if (['pathofexile.com', 'www.pathofexile.com'].includes(host)) {
    if (/^\/(?:fullscreen-)?passive-skill-tree(?:\/|$)/.test(url.pathname)) return { kind: 'build', input, message: BUILD_TREE_MESSAGE };
    if (/^\/(?:fullscreen-)?atlas-skill-tree(?:\/|$)/.test(url.pathname)) {
      const decoded = decodeAtlasCode(url.pathname.split('/').filter(Boolean).slice(1).join('/'));
      if (decoded?.format === 'official') return { kind: 'allocation', input, ...decoded };
      return { kind: 'unsupported', input, format: 'official', status: NOT_SUPPORTED_YET, message: UNSUPPORTED_ATLAS_LINK };
    }
  }
  if (['poeplanner.com', 'www.poeplanner.com'].includes(host)) {
    // Legacy compact paths cannot be classified without decoding a verified format.
    if (/^\/atlas-tree(?:\/|$)/.test(url.pathname)) {
      const decoded = decodeAtlasCode(url.pathname.split('/').filter(Boolean).slice(1).join('/'));
      if (decoded) return { kind: 'allocation', input, ...decoded };
      return { kind: 'unsupported', input, format: 'poeplanner', status: NOT_SUPPORTED_YET, message: UNSUPPORTED_ATLAS_LINK };
    }
    if (/^\/(?:builds?|passive-skill-tree)(?:\/|$)/.test(url.pathname)) return { kind: 'build', input, message: BUILD_TREE_MESSAGE };
  }
  return { kind: 'unsupported', input, format: 'unknown', status: NOT_SUPPORTED_YET, message: UNSUPPORTED_ATLAS_LINK };
}
export function exportExternalAtlas(format: ExternalFormat, nodeIds?: readonly string[]) {
  if (format === 'official' && nodeIds) {
    const link = encodeOfficialAtlasLink(nodeIds);
    if (link) return { kind: 'link' as const, format, link };
  }
  return { kind: 'unsupported' as const, format, status: NOT_SUPPORTED_YET,
    message: format === 'official' ? UNAVAILABLE_OFFICIAL_EXPORT : UNSUPPORTED_ATLAS_LINK };
}
