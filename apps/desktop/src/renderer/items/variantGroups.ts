// Items that use versions and variant groups (Item.lua: `usesVariantGroups`, `variantGroups`, `GetVariantGroupOptions`,
// `NormaliseVariantSelections`; ItemsTab.lua: `UpdateDisplayItemVariantControls`, `SelectDisplayItemVariant`).
// Pure text in, text out: the item text carries `Version:` / `Selected Version:` / `Variant:` / `Selected Variant Group: g=v`
// lines and `{variant:..}{group:..}{version:..}` tags on the modifier lines.
import { textLines, joinLines } from './itemText.js';

export interface VariantGroupOption {
  variantId: number;
  label: string;
}

export interface VariantGroupControl {
  groupId: number;
  /** The variants this group offers that no other group has taken (`GetVariantGroupOptions(groupId, true)`). */
  options: VariantGroupOption[];
  selected: number | null;
  /** More than one option, so the dropdown can change. */
  enabled: boolean;
}

export interface VariantModel {
  versions: string[];
  selectedVersion: number | null;
  variants: string[];
  groups: VariantGroupControl[];
}

interface Parsed {
  versions: string[];
  selectedVersion: number | null;
  variants: string[];
  selections: Map<number, number>;
  /** groupId -> variantId -> version ids (0 = any version). */
  groups: Map<number, Map<number, Set<number>>>;
  usesGroups: boolean;
}

const nums = (s: string): number[] => (s.match(/\d+/g) ?? []).map((n) => parseInt(n, 10));

function parse(text: string): Parsed {
  const out: Parsed = { versions: [], selectedVersion: null, variants: [], selections: new Map(), groups: new Map(), usesGroups: false };
  const lines = textLines(text);
  for (const l of lines) {
    let m: RegExpExecArray | null;
    if ((m = /^Version:\s*(.*)$/i.exec(l))) {
      out.versions.push(m[1]!.trim());
      out.usesGroups = true;
    } else if ((m = /^Selected Version:\s*([+-]?[\d.]+)/i.exec(l))) {
      out.selectedVersion = parseInt(m[1]!, 10);
      out.usesGroups = true;
    } else if ((m = /^Variant:\s*(.*)$/i.exec(l))) {
      out.variants.push(m[1]!.trim());
    } else if ((m = /^Selected Variant Group:\s*(\d+)\s*=\s*(\d+)\s*$/i.exec(l))) {
      out.selections.set(parseInt(m[1]!, 10), parseInt(m[2]!, 10));
      out.usesGroups = true;
    }
  }
  for (const l of lines) {
    if (!l.startsWith('{')) continue;
    let variant: number[] | null = null;
    let version: number[] | null = null;
    let group: number[] | null = null;
    const re = /\{(\w*):?([^}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(l))) {
      if (m[1] === 'variant') variant = nums(m[2]!);
      else if (m[1] === 'version') {
        version = nums(m[2]!);
        out.usesGroups = true;
      } else if (m[1] === 'group') {
        group = nums(m[2]!).filter((g) => g > 0);
        out.usesGroups = true;
      }
    }
    if (!group || !variant) continue;
    for (const g of group) {
      const gr = out.groups.get(g) ?? new Map<number, Set<number>>();
      out.groups.set(g, gr);
      for (const v of variant) {
        if (v < 1 || v > out.variants.length) continue;
        const set = gr.get(v) ?? new Set<number>();
        gr.set(v, set);
        if (version) {
          for (const ver of version) if (ver >= 1 && ver <= out.versions.length) set.add(ver);
        } else set.add(0);
      }
    }
  }
  return out;
}

const eligible = (p: Parsed, sel: number | null, g: number, v: number): boolean => {
  const set = p.groups.get(g)?.get(v);
  return !!set && (set.has(0) || (sel !== null && set.has(sel)));
};

const groupOptions = (p: Parsed, sel: number | null, selections: Map<number, number>, g: number, excludeSelected: boolean): number[] => {
  if (!p.groups.has(g)) return [];
  const used = new Set<number>();
  if (excludeSelected) {
    for (const other of [...p.groups.keys()].sort((a, b) => a - b)) {
      if (other === g) continue;
      const v = selections.get(other);
      if (v !== undefined && eligible(p, sel, other, v)) used.add(v);
    }
  }
  const out: number[] = [];
  for (let v = 1; v <= p.variants.length; v++) if (eligible(p, sel, g, v) && !used.has(v)) out.push(v);
  return out;
};

/** `NormaliseVariantSelections`. */
function normalise(p: Parsed): { sel: number | null; selections: Map<number, number> } {
  const sel = p.versions.length ? Math.max(1, Math.min(p.versions.length, p.selectedVersion ?? p.versions.length)) : null;
  const selections = new Map([...p.selections].filter(([g]) => p.groups.has(g)));
  const used = new Set<number>();
  const need: number[] = [];
  for (const g of [...p.groups.keys()].sort((a, b) => a - b)) {
    if (!groupOptions(p, sel, selections, g, false).length) continue;
    const s = selections.get(g);
    if (s !== undefined && eligible(p, sel, g, s) && !used.has(s)) used.add(s);
    else need.push(g);
  }
  for (const g of need) {
    const pick = groupOptions(p, sel, selections, g, false).find((v) => !used.has(v));
    if (pick !== undefined) {
      selections.set(g, pick);
      used.add(pick);
    } else selections.delete(g);
  }
  return { sel, selections };
}

/** What the editor shows, or null for an item that does not use versions or variant groups. */
export function variantModel(text: string): VariantModel | null {
  const p = parse(text);
  if (!p.usesGroups) return null;
  const { sel, selections } = normalise(p);
  const groups: VariantGroupControl[] = [];
  for (const g of [...p.groups.keys()].sort((a, b) => a - b)) {
    if (!groupOptions(p, sel, selections, g, false).length) continue;
    if (groups.length >= 6) break;
    const options = groupOptions(p, sel, selections, g, true).map((v) => ({ variantId: v, label: p.variants[v - 1] ?? `Variant ${v}` }));
    groups.push({ groupId: g, options, selected: selections.get(g) ?? null, enabled: options.length > 1 });
  }
  return { versions: p.versions, selectedVersion: sel, variants: p.variants, groups };
}

function write(text: string, sel: number | null, selections: Map<number, number>): string {
  const lines = textLines(text).filter((l) => !/^Selected Version:/i.test(l) && !/^Selected Variant Group:/i.test(l));
  const lastVersion = lines.map((l, i) => (/^Version:/i.test(l) ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
  if (sel !== null && lastVersion >= 0) lines.splice(lastVersion + 1, 0, `Selected Version: ${sel}`);
  const lastVariant = lines.map((l, i) => (/^Variant:/i.test(l) ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
  const at = lastVariant >= 0 ? lastVariant + 1 : lines.length;
  const sels = [...selections].sort((a, b) => a[0] - b[0]).map(([g, v]) => `Selected Variant Group: ${g}=${v}`);
  lines.splice(at, 0, ...sels);
  return joinLines(lines);
}

/** Picks version `n` (1-based) and re-normalises the group choices (`displayItemVersion`). */
export function setVersion(text: string, n: number): string {
  const p = parse(text);
  p.selectedVersion = n;
  const { sel, selections } = normalise(p);
  return write(text, sel, selections);
}

/** Picks variant `variantId` in group `groupId` (`SelectDisplayItemVariant`). */
export function setGroupVariant(text: string, groupId: number, variantId: number): string {
  const p = parse(text);
  p.selections.set(groupId, variantId);
  const { sel, selections } = normalise(p);
  return write(text, sel, selections);
}
