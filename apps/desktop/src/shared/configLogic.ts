/**
 * Which Configuration options the tab shows, and how its inputs turn into edits. Pure functions over the engine's
 * `ConfigCatalog` and `ConfigState`, following `Classes/ConfigTab.lua` (control.shown, borderFunc, GetDefaultState).
 */
import type { ConfigCatalog, ConfigOptionDef, ConfigSectionDef, ConfigState } from '@pom/protocol';

export type CfgValue = boolean | number | string;

/** The sections in the order the design lists them (upstream's file order differs). */
export const SECTION_ORDER = ['General', 'When In Combat', 'Skill Options', 'For Effective DPS', 'Map Modifiers and Player Debuffs', 'Enemy Stats', 'Custom Modifiers'];

/** What the design's section nav calls each section, with the icon and tone it uses. */
export const SECTION_LOOK: Record<string, { nav: string; icon: string; tone: string }> = {
  General: { nav: 'General', icon: 'settings', tone: 'var(--stat-neutral)' },
  'When In Combat': { nav: 'When In Combat', icon: 'swords', tone: 'var(--stat-dps)' },
  'Skill Options': { nav: 'Skill Options', icon: 'gem', tone: 'var(--rarity-gem-text)' },
  'For Effective DPS': { nav: 'For Effective DPS', icon: 'dps', tone: 'var(--stat-crit)' },
  'Map Modifiers and Player Debuffs': { nav: 'Map Modifiers', icon: 'map', tone: 'var(--dmg-chaos)' },
  'Enemy Stats': { nav: 'Enemy Stats', icon: 'target', tone: 'var(--pool-life)' },
  'Custom Modifiers': { nav: 'Custom Modifiers', icon: 'code', tone: 'var(--mod-crafted)' },
};

export const CUSTOM_SECTION = 'Custom Modifiers';

/** Removes colour codes (`^7`, `^xE05030`). */
export function stripCodes(s: string): string {
  return s.replace(/\^(x[0-9a-fA-F]{6}|[0-9])/g, '');
}

export function sortSections(sections: ConfigSectionDef[]): ConfigSectionDef[] {
  const rank = (t: string) => {
    const i = SECTION_ORDER.indexOf(t);
    return i < 0 ? SECTION_ORDER.length : i;
  };
  return [...sections].sort((a, b) => rank(a.title) - rank(b.title));
}

function typeDefault(cur: unknown): CfgValue | undefined {
  if (typeof cur === 'number') return 0;
  if (typeof cur === 'boolean') return false;
  if (typeof cur === 'string') return '';
  return undefined;
}

/** `ConfigTab:GetDefaultState`: the placeholder when there is one, else the option's default, else the type's zero. */
export function defaultFor(varName: string, state: ConfigState, cur: unknown): CfgValue | undefined {
  const ph = state.placeholders[varName];
  if (ph !== undefined) return ph;
  const d = state.defaults[varName];
  if (d !== undefined) return d;
  return typeDefault(cur);
}

/** The input the active set stores for the option, or undefined. */
export function storedValue(opt: ConfigOptionDef, state: ConfigState): CfgValue | undefined {
  return opt.var === undefined ? undefined : state.values[opt.var];
}

/** The value the control shows: the stored input, else the option's default. */
export function shownValue(opt: ConfigOptionDef, state: ConfigState): CfgValue | undefined {
  if (opt.var === undefined) return undefined;
  const v = state.values[opt.var];
  if (v !== undefined) return v;
  const d = state.defaults[opt.var];
  if (d !== undefined) return d;
  if (opt.type === 'check') return false;
  if (opt.type === 'list') return opt.list?.[(opt.defaultIndex ?? 1) - 1]?.val;
  return undefined;
}

/** `cur ~= nil and cur ~= GetDefaultState(var, type(cur))`. */
export function isChanged(opt: ConfigOptionDef, state: ConfigState): boolean {
  if (opt.var === undefined) return false;
  const cur = state.values[opt.var];
  if (cur === undefined) return false;
  return cur !== defaultFor(opt.var, state, cur);
}

/** The label of the list entry a value selects. */
export function listLabel(opt: ConfigOptionDef, val: CfgValue | undefined): string {
  const it = opt.list?.find((l) => l.val === val || String(l.val) === String(val));
  return it ? it.label : val === undefined ? '' : String(val);
}

/**
 * The design draws two short entries, or three one-word entries (Red, Yellow, White), as a segmented control; every
 * other list, such as Resistance penalty or EHP calc unlucky, is a dropdown.
 */
export function isSegmented(opt: ConfigOptionDef): boolean {
  const l = opt.list;
  if (opt.type !== 'list' || !l || l.length < 2 || l.length > 3) return false;
  return l.reduce((n, i) => n + stripCodes(i.label).length, 0) <= (l.length === 2 ? 30 : 16);
}

/** Width of a dropdown trigger, from its longest entry. */
export function dropdownWidth(opt: ConfigOptionDef): number {
  const longest = Math.max(0, ...(opt.list ?? []).map((i) => stripCodes(i.label).length));
  return Math.max(150, Math.min(200, Math.round(longest * 7.4 + 48)));
}

export interface ViewOpts {
  q: string;
  showAll: boolean;
  onlyChanged: boolean;
}

export interface RowView {
  kind: 'row';
  opt: ConfigOptionDef;
  /** All the option's conditions pass for this build. */
  eligible: boolean;
  /** Shown only because Show All Configurations is on: the build does not use it. */
  notUsed: boolean;
  /** Set to a non-default value although its conditions fail: invalid (upstream colours its label negative). */
  invalid: boolean;
  changed: boolean;
}
export interface SubView {
  kind: 'sub';
  opt: ConfigOptionDef;
}
export interface CardView {
  section: ConfigSectionDef;
  rows: Array<RowView | SubView>;
  custom: boolean;
}

export function rowVisibility(opt: ConfigOptionDef, state: ConfigState, showAll: boolean): RowView | null {
  if (opt.var === undefined) return null;
  const eligible = state.shown[opt.var] !== false;
  const showAllOk = showAll && !opt.showAllExcluded;
  const inner = eligible || showAllOk;
  const changed = isChanged(opt, state);
  const visible = opt.hideIfInvalid ? inner : inner || changed;
  if (!visible) return null;
  return { kind: 'row', opt, eligible, notUsed: !eligible && inner, invalid: !inner && changed, changed };
}

export function searchMatches(q: string, ...texts: Array<string | undefined>): boolean {
  if (!q) return true;
  return texts.some((t) => t !== undefined && stripCodes(t).toLowerCase().includes(q));
}

/**
 * The cards the tab draws. An option shows when `control.shown()` is true in upstream (conditions pass, or Show All
 * Configurations lets it through, or it is set to a non-default value); the design's search also looks at the shown
 * value, the sub-label above and the section title. A sub-label shows when an option under it does.
 */
export function buildCards(catalog: ConfigCatalog, state: ConfigState, view: ViewOpts): CardView[] {
  const q = view.q.trim().toLowerCase();
  const out: CardView[] = [];
  const changedBlocks = state.customMods.filter((b) => b.enabled && b.text.trim());
  for (const section of sortSections(catalog.sections)) {
    const custom = section.title === CUSTOM_SECTION;
    const rows: Array<RowView | SubView> = [];
    let pending: ConfigOptionDef | null = null;
    for (const opt of catalog.options) {
      if (opt.section !== section.title) continue;
      if (opt.type === 'label') {
        // The engine keys a sub-label's own conditions as ; Show All lets it through like an option.
        pending = state.shown['#' + opt.index] !== false || (view.showAll && !opt.showAllExcluded) ? opt : null;
        continue;
      }
      const rv = rowVisibility(opt, state, view.showAll);
      if (!rv) continue;
      if (view.onlyChanged && !rv.changed) continue;
      if (q) {
        const val = opt.type === 'list' ? listLabel(opt, shownValue(opt, state)) : String(shownValue(opt, state) ?? '');
        if (!searchMatches(q, opt.label, val, pending?.label, section.title)) continue;
      }
      if (pending) {
        rows.push({ kind: 'sub', opt: pending });
        pending = null;
      }
      rows.push(rv);
    }
    if (custom) {
      const keep = (!view.onlyChanged || changedBlocks.length > 0) && (!q || searchMatches(q, section.title) || state.customMods.some((b) => (b.title + ' ' + b.text).toLowerCase().includes(q)));
      if (keep) out.push({ section, rows, custom });
    } else if (rows.length) out.push({ section, rows, custom });
  }
  return out;
}

/** Only digits for a count, a leading minus too for integers, digits and one point for a float. */
export function sanitizeNumber(type: ConfigOptionDef['type'], text: string): string {
  let t = text.slice(0, 10);
  if (type === 'count') return t.replace(/[^0-9]/g, '');
  if (type === 'float') {
    t = t.replace(/[^0-9.]/g, '');
    const i = t.indexOf('.');
    return i < 0 ? t : t.slice(0, i + 1) + t.slice(i + 1).replace(/\./g, '');
  }
  const neg = t.startsWith('-');
  t = t.replace(/[^0-9]/g, '');
  return (neg ? '-' : '') + t;
}

/** The number a text commits as: empty removes the input (null), unreadable text changes nothing (undefined). */
export function parseNumberText(text: string): number | null | undefined {
  const t = text.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/** What to store for a switch: the option's default is stored as nothing, as upstream's Save leaves it out. */
export function checkEditValue(opt: ConfigOptionDef, state: ConfigState, next: boolean): boolean | null {
  const def = opt.var === undefined ? undefined : defaultFor(opt.var, state, next);
  return def === next ? null : next;
}

/** How many inputs differ from their default, plus the custom groups that are on and have text (a set's "N changed"). */
export function changedCount(catalog: ConfigCatalog, state: ConfigState): number {
  let n = 0;
  for (const opt of catalog.options) if (isChanged(opt, state)) n++;
  return n + state.customMods.filter((b) => b.enabled && b.text.trim()).length;
}
