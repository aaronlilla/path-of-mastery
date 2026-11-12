// Next-league preview: what main tells the window about the installed overlay, and the engine
// commands the window may run on the preview engine.
import { readItems, setItemText } from './itemsXml.js';

/** One patch-note line behind a change: its line number in the notes and what it says changed. */
export interface PreviewNote {
  cite: number;
  claim: string;
}

/** `preview-overlay.index.json`: every changed gem (by skill id), node (by id) and unique (by name), each with its notes. */
export interface PreviewIndex {
  patch: string;
  base: string;
  gems: Record<string, PreviewNote[]>;
  nodes: Record<string, PreviewNote[]>;
  uniques: Record<string, PreviewNote[]>;
  /** The note lines themselves by line number (added by the publish step). */
  notes?: Record<string, string>;
  /** Gem name by skill id (added by main when it loads the overlay). */
  gemNames?: Record<string, string>;
  /** A changed node's stat lines in the preview, by node id (added by main from the overlay's tree). */
  nodeText?: Record<string, string[]>;
  /** A changed unique's line edits, live data -> preview data, by name (added by main). */
  uniqueEdits?: Record<string, UniqueEdit[]>;
}

/** One line of a unique: `old` replaced by `new`; a null `old` adds the line, a null `new` removes it. */
export interface UniqueEdit {
  old: string | null;
  new: string | null;
}

/** A mod line without its tags ("{range:0.5}", "{variant:2}") and numbers: the same mod with other values matches. */
const modKey = (l: string) => l.replace(/\{[^}]*\}/g, '').replace(/[-+]?\(?[\d.]+(?:-[\d.]+)?\)?/g, '#').trim();
const bare = (l: string) => l.replace(/\{range:[^}]*\}/g, '').trim();

const variantOf = (l: string) => /\{variant:[^}]*\}/.exec(l)?.[0] ?? '';
const hasRangeTag = (l: string) => /^\{range:[^}]*\}/.test(l);
const SLOT = /\((\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)\)|\d+(?:\.\d+)?/g;

/** The new line with the old line's rolled numbers put into its ranges, each clamped to the new range. */
function keepRoll(oldLine: string, next: string): string {
  const rolls = oldLine.replace(/\{[^}]*\}/g, '').match(SLOT) ?? [];
  let i = 0;
  return next.replace(SLOT, (m, lo?: string, hi?: string) => {
    const r = rolls[i++];
    if (lo === undefined || hi === undefined || r === undefined || r.startsWith('(')) return m;
    return String(Math.min(Math.max(Number(r), Number(lo)), Number(hi)));
  });
}

/** The line edits from a unique's live text to its preview text: same mod with new values pairs up, the rest goes or comes. */
export function uniqueEdits(live: string, preview: string): UniqueEdit[] {
  const L = live.split('\n').map((l) => l.trim()).filter(Boolean);
  const P = preview.split('\n').map((l) => l.trim()).filter(Boolean);
  const gone = L.filter((l) => !P.includes(l));
  const added = P.filter((l) => !L.includes(l));
  const out: UniqueEdit[] = [];
  for (const g of gone) {
    const i = added.findIndex((a) => modKey(a) === modKey(g));
    out.push({ old: g, new: i >= 0 ? added.splice(i, 1)[0]! : null });
  }
  for (const a of added) out.push({ old: null, new: a });
  return out;
}

/** A build's copy of a unique with the overlay's edits: a replaced line keeps its roll ("{range:x}"), new lines go last. */
export function applyUniqueEdits(text: string, edits: UniqueEdit[]): string {
  const lines = text.split('\n');
  const tail: string[] = [];
  for (const e of edits) {
    if (e.old === null) {
      if (e.new) tail.push(e.new);
      continue;
    }
    const noVar = (s: string) => s.replace(/^\{variant:[^}]*\}/, '');
    const same = (l: string) => bare(l) === e.old || noVar(bare(l)) === noVar(e.old!);
    // A line with a roll in it ("50% increased ...") still matches the catalogue's range line ("(40-60)% increased ...").
    let k = lines.findIndex(same);
    if (k < 0) {
      // only when one line is that mod: two lines of the same mod (an implicit and an explicit) cannot be told apart
      const hits = lines.flatMap((l, i) => (modKey(l) === modKey(e.old!) && variantOf(l) === variantOf(e.old!) ? [i] : []));
      if (hits.length === 1) k = hits[0]!;
    }
    if (k < 0) continue;
    if (e.new === null) lines.splice(k, 1);
    else lines[k] = (/^\{range:[^}]*\}/.exec(lines[k]!)?.[0] ?? '') + (hasRangeTag(lines[k]!) ? e.new : keepRoll(bare(lines[k]!), e.new));
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return [...lines, ...tail].join('\n');
}

/** The build with every unique the overlay changed in its next-patch text: the engine reads a build's items from their text. */
export function previewXml(xml: string, edits: Record<string, UniqueEdit[]>): string {
  if (!Object.keys(edits).some((n) => xml.includes(n))) return xml;
  let out = xml;
  for (const it of readItems(xml).items) {
    const [rarity, name] = it.text.split('\n', 2).map((l) => l.trim());
    const e = rarity === 'Rarity: UNIQUE' && name ? edits[name] : undefined;
    if (e?.length) out = setItemText(out, it.id, applyUniqueEdits(it.text, e));
  }
  return out;
}

export interface PreviewInfo {
  /** The next patch, as the overlay names it ("3.30.0"). */
  patch: string;
  /** The live patch the overlay was built on ("3.29"). */
  live: string;
  /** When the patch notes were last read (ISO), or null when unknown. */
  checkedAt: string | null;
  threadUrl: string | null;
  index: PreviewIndex;
}

/** Read-only commands the window may run on the preview engine. */
export const PREVIEW_COMMANDS = ['getStats', 'calcsView', 'previewNode', 'gemTip', 'itemInfo', 'previewEdit', 'getBreakdowns', 'calcsMods'] as const;
export type PreviewCommand = (typeof PREVIEW_COMMANDS)[number];

/** "3.30.0" -> "3.30". */
export const shortPatch = (p: string): string => /^\d+\.\d+/.exec(p)?.[0] ?? p;
