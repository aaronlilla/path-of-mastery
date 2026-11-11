/** Pure logic of the Skills tab: gem search, default levels, group copy/paste text, socket matching. No DOM, no engine. */
import type { GemColour, GemInfo, SkillGem, SkillsOptions } from '@pom/protocol';
import { gemSkillIds } from './gemSkillIds.js';

/** Art file name for a gem: the lower-case name with every run of other characters turned into a dash. */
export function gemSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export interface AttrStyle {
  /** CSS colour of the gem's name. */
  text: string;
  /** CSS colour of the socket dot. */
  socket: string;
  /** Socket art file under assets/poe/ui. */
  icon: string;
  /** Fallback gem frame under assets/poe/gems. */
  frame: string;
  label: string;
}

export const ATTR: Record<GemColour, AttrStyle> = {
  str: { text: 'var(--gem-str)', socket: 'var(--socket-r)', icon: 'socket-str-active', frame: '_red', label: 'Red' },
  dex: { text: 'var(--gem-dex)', socket: 'var(--socket-g)', icon: 'socket-dex-active', frame: '_green', label: 'Green' },
  int: { text: 'var(--gem-int)', socket: 'var(--socket-b)', icon: 'socket-int-active', frame: '_blue', label: 'Blue' },
  w: { text: 'var(--text-2)', socket: 'var(--socket-w)', icon: 'socket-white-active', frame: '_blue', label: 'White' },
};

/** The letter an item socket colour has in the build (R, G, B, W, A) as a gem colour. */
export function socketColour(letter: string): GemColour {
  return letter === 'R' ? 'str' : letter === 'G' ? 'dex' : letter === 'B' ? 'int' : 'w';
}

export const GEM_LEVEL_MODES: { value: string; label: string; description: string }[] = [
  { value: 'normalMaximum', label: 'Normal Maximum', description: 'All gems default to their highest valid non-corrupted gem level.' },
  { value: 'corruptedMaximum', label: 'Corrupted Maximum', description: 'Normal gems default to their highest valid corrupted gem level.\nAwakened gems default to their highest valid non-corrupted gem level.' },
  { value: 'awakenedMaximum', label: 'Awakened Maximum', description: 'All gems default to their highest valid corrupted gem level.' },
  { value: 'characterLevel', label: 'Match Character Level', description: 'All gems default to their highest valid non-corrupted gem level that your character meets the level requirement for.\nThis hides gems with a minimum level requirement above your character level, preventing them from showing up in the dropdown list.' },
  { value: 'levelOne', label: 'Level 1', description: 'All gems default to level 1.' },
];

export const SORT_FIELDS: { value: string; label: string }[] = [
  { value: 'FullDPS', label: 'Full DPS' },
  { value: 'CombinedDPS', label: 'Combined DPS' },
  { value: 'TotalDPS', label: 'Hit DPS' },
  { value: 'AverageDamage', label: 'Average Hit' },
  { value: 'TotalDot', label: 'DoT DPS' },
  { value: 'BleedDPS', label: 'Bleed DPS' },
  { value: 'IgniteDPS', label: 'Ignite DPS' },
  { value: 'TotalPoisonDPS', label: 'Poison DPS' },
  { value: 'TotalEHP', label: 'Effective Hit Pool' },
];

export const SUPPORT_TYPES: { value: string; label: string }[] = [
  { value: 'ALL', label: 'All' },
  { value: 'NORMAL', label: 'Non-Exceptional' },
  { value: 'EXCEPTIONAL', label: 'Exceptional' },
];

/** `SkillsTab:ProcessGemLevel`: the level a new gem starts at. */
export function defaultGemLevel(gem: GemInfo, mode: string, characterLevel: number, imbued = false): number {
  if (imbued || mode === 'levelOne') return 1;
  if (mode === 'awakenedMaximum') return gem.naturalMaxLevel + 1;
  if (mode === 'corruptedMaximum') return gem.plusVersion ? gem.naturalMaxLevel : gem.naturalMaxLevel + 1;
  if (mode === 'normalMaximum') return gem.naturalMaxLevel;
  let max = gem.naturalMaxLevel;
  if (!gem.levelReq[max - 1]) max = gem.levelReq.length;
  for (let l = max; l >= 1; l--) if ((gem.levelReq[l - 1] ?? 0) <= characterLevel) return l;
  return 1;
}

const TAG_ALIAS: Record<string, string> = { active: 'grants_active_skill', int: 'intelligence', str: 'strength', dex: 'dexterity', aoe: 'area' };

function hasTag(g: GemInfo, tag: string): boolean {
  if (tag === 'support') return g.support;
  if (tag === 'strength') return g.colour === 'str' || g.tags.includes('strength');
  if (tag === 'dexterity') return g.colour === 'dex' || g.tags.includes('dexterity');
  if (tag === 'intelligence') return g.colour === 'int' || g.tags.includes('intelligence');
  if (tag === 'grants_active_skill') return !g.support || g.tags.includes('grants_active_skill');
  return g.tags.some((t) => t.toLowerCase() === tag);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface PickerFilter {
  options: Pick<SkillsOptions, 'showSupportGemTypes' | 'showLegacyGems' | 'defaultGemLevel'>;
  characterLevel: number;
  /** 'S' = only supports, 'A' = only active gems. */
  kind: 'S' | 'A' | null;
  /** The imbued picker: non-exceptional supports only (and no Vaal-style secondary effect that is not a support). */
  imbued?: boolean;
}

/** Whether the picker lists the gem at all (`PopulateGemList` and `FilterSupport`). */
export function gemListed(g: GemInfo, f: PickerFilter): boolean {
  if (f.imbued) return g.support && !g.exceptional && g.imbuedOk;
  if (f.options.defaultGemLevel === 'characterLevel' && (g.levelReq[0] ?? 1) > f.characterLevel) return false;
  if (g.legacy && !f.options.showLegacyGems) return false;
  if (f.kind === 'S' && !g.support) return false;
  if (f.kind === 'A' && g.support) return false;
  if (g.support) {
    const t = f.options.showSupportGemTypes;
    if (t === 'NORMAL' && g.exceptional) return false;
    if (t === 'EXCEPTIONAL' && !g.exceptional) return false;
  }
  return true;
}

/**
 * The picker's results for a query, the way `GemSelectControl:BuildList` finds them: the text before the first colon matches the
 * name (exact, then abbreviation like "ctf" for Cold to Fire, then starts with, then contains), each `:tag` after it narrows by tag
 * (`-tag` excludes). Within one step gems come in alphabetical order, supports before active gems.
 */
export function searchGems(gems: GemInfo[], query: string, f: PickerFilter): GemInfo[] {
  const listed = gems.filter((g) => gemListed(g, f));
  const parts = query.split(':');
  const term = (parts[0] ?? '').trim().toLowerCase();
  const tags = parts.slice(1).map((t) => t.replace(/\s+/g, '').toLowerCase());
  const order = (a: GemInfo, b: GemInfo) => Number(b.support) - Number(a.support) || a.name.localeCompare(b.name);
  if (!query.trim() || (!term && !tags.length)) return [...listed].sort(order);
  const tagOk = (g: GemInfo) => {
    for (const raw of tags) {
      if (!raw) continue;
      const neg = raw.startsWith('-');
      const name = TAG_ALIAS[neg ? raw.slice(1) : raw] ?? (neg ? raw.slice(1) : raw);
      const has = hasTag(g, name);
      if (neg ? has : !has) return false;
    }
    return true;
  };
  const abbr = new RegExp('^' + term.replace(/./g, (c) => (/[a-z]/.test(c) ? ` ${c}[a-z]+` : escapeRe(c))) + '$');
  const steps: ((n: string) => boolean)[] = [(n) => n === term, (n) => abbr.test(' ' + n), (n) => n.startsWith(term), (n) => n.includes(term)];
  const seen = new Set<string>();
  const out: GemInfo[] = [];
  for (const test of steps) {
    const hits: GemInfo[] = [];
    for (const g of listed) {
      if (seen.has(g.id) || !tagOk(g)) continue;
      if (!term || test(g.name.toLowerCase())) {
        hits.push(g);
        seen.add(g.id);
      }
    }
    out.push(...hits.sort(order));
    if (!term) break;
  }
  return out;
}

/** Text upstream copies for a group (`CopySocketGroup`), lines joined with CRLF. */
export function groupToText(g: { label: string; slot?: string; gems: Pick<SkillGem, 'nameSpec' | 'level' | 'quality' | 'enabled' | 'count'>[] }): string {
  let t = '';
  if ((g.label ?? '').trim()) t += `Label: ${g.label}\r\n`;
  if (g.slot) t += `Slot: ${g.slot}\r\n`;
  for (const x of g.gems) t += `${x.nameSpec} ${x.level}/${x.quality} ${x.enabled ? '' : 'DISABLED'} ${x.count}\r\n`;
  return t;
}

export interface PastedGem {
  nameSpec: string;
  level: number;
  quality: number;
  enabled: boolean;
  count: number;
}

/** What `PasteSocketGroup` reads from text; `null` when no gem line is found. */
export function textToGroup(text: string): { label: string; slot?: string; gems: PastedGem[] } | null {
  const clean = text.replace(/\r/g, '');
  const label = /Label: ([^\n]+)/.exec(clean)?.[1] ?? '';
  const slot = /Slot: ([^\n]+)/.exec(clean)?.[1];
  const gems: PastedGem[] = [];
  const re = /([ A-Za-z']+) (\d+)\/(\d+) ?([A-Za-z]*) (\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    gems.push({ nameSpec: m[1]!.replace(/^\s+/, ''), level: Number(m[2]) || 20, quality: Number(m[3]) || 0, enabled: m[4] !== 'DISABLED', count: Number(m[5]) || 1 });
  }
  return gems.length ? { label, ...(slot ? { slot } : {}), gems } : null;
}

/**
 * Orders a group's gems so coloured item sockets hold gems of their own colour (each match is worth +10% quality).
 * `sockets` are the item's socket letters from the group's first socket on. Returns `order` for the `orderGems` edit
 * (`order[i]` = old 1-based index of the gem that goes to position i+1), or `null` when no better order exists.
 */
export function matchColourOrder(gems: { colour: GemColour; support: boolean }[], sockets: string[]): number[] | null {
  const n = gems.length;
  const want = (i: number) => socketColour(sockets[i] ?? 'W');
  const score = (order: number[]) => order.reduce((a, gi, i) => a + (sockets[i] && sockets[i] !== 'W' && gems[gi]!.colour === want(i) ? (gems[gi]!.support ? 1 : 3) : 0), 0);
  const ident = gems.map((_, i) => i);
  const out: (number | null)[] = new Array(n).fill(null);
  const used = new Set<number>();
  const pri = [...ident].sort((a, b) => Number(gems[a]!.support) - Number(gems[b]!.support));
  for (const gi of pri) {
    const si = out.findIndex((v, k) => v == null && k < n && sockets[k] && sockets[k] !== 'W' && want(k) === gems[gi]!.colour);
    if (si >= 0) {
      out[si] = gi;
      used.add(gi);
    }
  }
  const rest = ident.filter((i) => !used.has(i));
  for (let k = 0; k < n; k++) if (out[k] == null) out[k] = rest.shift()!;
  const order = out as number[];
  return score(order) > score(ident) ? order.map((i) => i + 1) : null;
}

/** How many gems of the group sit in a socket of their own colour, and how many sockets are coloured. */
export function matchSummary(gems: { colour: GemColour }[], sockets: string[]): { matched: number; coloured: number } {
  const coloured = sockets.slice(0, gems.length).filter((s) => s !== 'W' && s !== 'A').length;
  let matched = 0;
  gems.forEach((g, i) => {
    const s = sockets[i];
    if (s && s !== 'W' && s !== 'A' && socketColour(s) === g.colour) matched++;
  });
  return { matched, coloured };
}

/** The per-row percentage a gem preview shows: change of `field` as a fraction of its old value, from an engine stat diff. */
export function previewPercent(changed: { statId: string; before: unknown; after: unknown }[], field: string): number | null {
  const d = changed.find((c) => c.statId === field);
  if (!d || typeof d.before !== 'number' || typeof d.after !== 'number') return null;
  if (d.before === 0) return d.after === 0 ? 0 : null;
  return (d.after - d.before) / Math.abs(d.before);
}

/**
 * The picker's figure next to a gem. The engine's `gemPower` already returns a percent (Momentum 40.25 means the
 * sort field rises 40.25% when the gem is added), so it is only rounded and signed here, never multiplied again.
 * Under 100% it keeps one decimal, from 100% up it is a whole number.
 */
export function formatGemPower(v: number | null | undefined): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '';
  if (v === 0) return '0%';
  return (v > 0 ? '+' : '') + (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)) + '%';
}

// ---- tooltips, picker marks, sockets, wiki ---------------------------------------------------------------------------

/** The granted effect id the engine's skill tooltip takes: the gem's variant id, except for the few gems that spell it differently. */
export function skillIdOf(g: Pick<GemInfo, 'id' | 'variantId'>): string {
  return gemSkillIds[g.id] ?? g.variantId ?? g.id.replace(/^.*\/SkillGem/, '');
}

/** The picker's check mark and "+" colour for a gem's change in the sort stat (`DPSBuilder`): green up, red down, yellow unchanged. */
export function dpsColour(change: number): string {
  return change > 0 ? '#228866' : change < 0 ? '#ff4422' : '#ffff66';
}

// Upstream's tag string leaves these out: the attribute tags (the name colour says them) and the data-only flags.
const TAG_LABEL: Record<string, string> = { area: 'AoE', grants_active_skill: '', strength: '', dexterity: '', intelligence: '', low_max_level: '', awakened: '', random_element: '', banner: '' };

/** What a gem row says. Upstream only reports an unrecognised name for a gem saved by name alone: one saved with its skill id keeps its name and says nothing (`ProcessSocketGroup`). */
export function gemRowLook(x: { known: boolean; nameSpec: string; skillId?: string; errMsg?: string }): { text: string; muted: boolean; note: string | undefined } {
  if (x.known) return { text: x.nameSpec, muted: false, note: x.errMsg };
  const bySkill = Boolean(x.skillId);
  return { text: bySkill ? x.nameSpec : x.errMsg || x.nameSpec || 'Unknown gem', muted: bySkill, note: undefined };
}

/** A gem's tags as upstream's tag string spells them (without the attribute tags, which the name colour already says). */
export function gemTagLabels(tags: string[]): string[] {
  const out: string[] = [];
  for (const t of tags) {
    const l = t in TAG_LABEL ? TAG_LABEL[t]! : t.charAt(0).toUpperCase() + t.slice(1);
    if (l) out.push(l);
  }
  return out;
}

/** The wiki page of a gem (`itemLib.wiki.openGem`): a support gem's page carries " Support". */
export function gemWikiUrl(name: string, support: boolean): string {
  return 'https://www.poewiki.net/wiki/' + (name + (support ? ' Support' : '')).replace(/ /g, '_');
}

/** Item sockets for Optimise Sockets: one socket per gem of the item's groups, in the colour of the gem, linked within a group, up to `max`. */
export function optimisedSockets(groups: { colour: GemColour }[][], max: number): { c: string; link: boolean }[] {
  const out: { c: string; link: boolean }[] = [];
  let left = max;
  for (const g of groups) {
    for (let i = 0; i < g.length && left > 0; i++) {
      const c = g[i]!.colour;
      out.push({ c: c === 'str' ? 'R' : c === 'dex' ? 'G' : c === 'int' ? 'B' : 'W', link: i < g.length - 1 && left > 1 });
      left--;
    }
  }
  if (out.length) out[out.length - 1]!.link = false;
  return out;
}

/** Upstream's `optimiseSockets.enabled`: some gem in the item's groups, within the item's socket limit, is not in a matching socket. */
export function optimiseWanted(groups: { gems: { matchesSocket: boolean }[] }[], max: number): boolean {
  let left = max;
  for (const g of groups) {
    for (const gem of g.gems) {
      if (left <= 0) return false;
      if (!gem.matchesSocket) return true;
      left--;
    }
  }
  return false;
}

/** The group the tab selects when it opens or the set changes: the main skill's group, else the first. */
export function openingGroup(mainGroup: number, groupCount: number): number | null {
  if (!groupCount) return null;
  return mainGroup >= 1 && mainGroup <= groupCount ? mainGroup : 1;
}

/** The index of the group a New or Paste adds: after the last group the build text holds (upstream appends). */
export function appendedGroupIndex(groups: { source?: string }[]): number {
  let at = 0;
  groups.forEach((g, i) => {
    if (!g.source) at = i + 1;
  });
  return at + 1;
}

/** The other versions of a gem: its base gem and every transfigured variant of that base (not legacy ones), base first. */
export function gemVersions<T extends Pick<GemInfo, 'id' | 'name' | 'legacy' | 'transfiguredOf'>>(gems: T[], gem: Pick<GemInfo, 'id' | 'name' | 'transfiguredOf'>): T[] {
  const base = gem.transfiguredOf ?? gem.name;
  return gems
    .filter((g) => g.id !== gem.id && !g.legacy && (g.transfiguredOf ?? g.name) === base)
    .sort((a, b) => Number(!!a.transfiguredOf) - Number(!!b.transfiguredOf) || a.name.localeCompare(b.name));
}

/** What a socket group row warns about: more gems than the item has sockets, or a gem the calculation reports a problem with. */
export function groupWarnings(g: { gems: { known: boolean; errMsg?: string; nameSpec: string }[] }, socketCap: number | null): string[] {
  const out: string[] = [];
  if (socketCap != null && socketCap > 0 && g.gems.length > socketCap) { const n = g.gems.length - socketCap; out.push(`${g.gems.length} gems in ${socketCap} sockets: ${n} ${n === 1 ? 'gem' : 'gems'} over the link limit`); }
  for (const x of g.gems) if (x.errMsg && x.known) out.push(`${x.nameSpec}: ${x.errMsg}`);
  return out;
}
