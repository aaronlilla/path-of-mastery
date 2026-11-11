// The sidebar's stat list: BuildDisplayStats.lua's rows run against the engine's stats and the main skill's flags,
// the way `buildMode:AddDisplayStatList` and `FormatStat` do (Modules/Build.lua).
import { displayStats, minionDisplayStats } from './displayStatsData.js';
import type { ColorName, DisplayStat, Output } from './displayStatsTypes.js';
import { T } from './displayStatsRuntime.js';

export interface NumberFormat {
  /** `main.showThousandsSeparators` */
  thousands: boolean;
  /** `main.useCompactValues` */
  compact: boolean;
  thousandsSeparator: string;
  decimalSeparator: string;
}

export const DEFAULT_NUMBER_FORMAT: NumberFormat = { thousands: true, compact: false, thousandsSeparator: ',', decimalSeparator: '.' };

// ---- C-style formatting (Lua's string.format over the formats the display stats use) ------------------------------

/** printf("%.Nf") with ties to even like C (JS rounds exact ties up). */
function toFixedC(x: number, digits: number): string {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? 'nan' : x > 0 ? 'inf' : '-inf';
  // printf rounds by the exact binary value; only an exact tie goes to the even digit (toFixed picks the larger one then).
  const exact = Math.abs(x).toFixed(Math.min(100, digits + 30));
  const tail = exact.slice(exact.length - 30);
  if (/^50*$/.test(tail)) {
    const keep = exact.slice(0, exact.length - 30);
    const last = Number(keep[keep.length - 1] === '.' ? keep[keep.length - 2] : keep[keep.length - 1]);
    if (last % 2 === 0) {
      const r = (keep.endsWith('.') ? keep.slice(0, -1) : keep);
      return x < 0 ? '-' + r : r;
    }
  }
  return x.toFixed(digits);
}

/** `string.format("%" + fmt, val)` for fmt like "d", ".1f", "+d%%", ".2fs", "+.1f". */
export function sFormat(fmt: string, val: number): string {
  const m = fmt.match(/^(\+?)(?:(d)|\.(\d+)f)(.*)$/);
  if (!m) return String(val);
  const [, plus, d, digits, rest] = m;
  let body: string;
  if (d) {
    body = Number.isFinite(val) ? String(Math.trunc(val)) : val > 0 ? '9223372036854775807' : '-9223372036854775808';
    if (Object.is(Number(body), -0)) body = '0';
  } else {
    body = toFixedC(val, Number(digits));
  }
  if (plus && !body.startsWith('-')) body = '+' + body;
  return body + rest!.replace(/%%/g, '%');
}

/** FormatStat's trailing-zero trim: "12.50" -> "12.5", "3.00%" -> "3%". */
export function trimZeros(s: string): string {
  const m = s.match(/^([+-]?\d+\.\d+)(\D*)$/);
  if (!m) return s;
  return m[1]!.replace(/0+$/, '').replace(/\.$/, '') + m[2];
}

/** `formatNumSep`: thousands and decimal separators on the first number in the text. */
export function formatNumSep(str: string, f: NumberFormat): string {
  return str.replace(/(-?\d+\.?\d+)/, (m) => {
    const sign = m.startsWith('-') ? '-' : '';
    const mm = m.match(/^-?(\d+)(\.?\d*)$/);
    if (!mm) return m;
    let integer = mm[1]!;
    const fraction = mm[2]!;
    if (f.thousands && f.thousandsSeparator !== '') {
      integer = integer.replace(/\B(?=(\d{3})+(?!\d))/g, f.thousandsSeparator);
    }
    return sign + integer + fraction.replace('.', f.decimalSeparator);
  });
}

export interface FormattedStat {
  text: string;
  /** True for upstream's red (a negative value, or an exceeded cap). */
  negative: boolean;
  /** The chaos-immune muted colour for a non-positive value. */
  muted: boolean;
}

/** `buildMode:FormatStat` without the colour codes: the text, and whether the value is drawn red. */
export function formatStat(sd: DisplayStat, statVal: number, overCap: number | undefined, f: NumberFormat, colorOverride?: boolean): FormattedStat {
  const val = statVal * (sd.pc || sd.mod ? 100 : 1) - (sd.mod ? 100 : 0);
  let negative = colorOverride ?? !(statVal >= 0);
  let muted = false;
  if (!colorOverride && statVal < 0 && sd.chaosInoc) {
    negative = false;
    muted = true;
  }
  if (sd.label === 'Unreserved Life' && statVal === 0) negative = true;
  let valStr: string | undefined;
  if (sd.compactValue && f.compact && Number.isFinite(val)) {
    const a = Math.abs(val);
    if (a >= 1e9) valStr = sFormat('.1f', val / 1e9) + 'B';
    else if (a >= 1e6) valStr = sFormat('.1f', val / 1e6) + 'M';
    else if (a >= 1e4) valStr = sFormat('.1f', val / 1e3) + 'K';
  }
  if (valStr === undefined) valStr = trimZeros(sFormat(sd.fmt ?? '.1f', val));
  let text = formatNumSep(valStr, f);
  if (overCap !== undefined && overCap > 0) text += ` (+${sFormat('d', overCap)}%)`;
  return { text, negative, muted };
}

// ---- the list --------------------------------------------------------------------------------------------------------

export type GroupId = 'minion' | 'off' | 'attr' | 'hit' | 'pools' | 'res';

export interface SidebarRow {
  key: string;
  /** Engine stat id (the value's source). */
  stat: string;
  label: string;
  text: string;
  /** The value as a number, for deltas and the pinned tiles. */
  value: number;
  negative: boolean;
  muted: boolean;
  /** Text after the value, in grey: "(Immune)", "(Guard)". */
  suffix?: string;
  color?: ColorName;
  /** Upstream's warning colouring of the label. */
  warn: boolean;
  /** A skill-DPS row's extra lines. */
  sub?: string[];
  group: GroupId;
  breakdown?: string;
  /** What the hover breakdown needs (`BuildDisplayStats.lua`): the child stat, extra modifier names and sections to leave out. */
  childStat?: string;
  modNames?: string[];
  ignoredSections?: string[];
  compPercent?: boolean;
  lowerIsBetter?: boolean;
}

export interface SidebarModel {
  rows: SidebarRow[];
  warnings: string[];
  /** The main skill's message line(s) (`infoMessage`), when the engine gives one. */
  info: string[];
}

const ATTR = new Set(['Str', 'ReqStr', 'Dex', 'ReqDex', 'Int', 'ReqInt', 'Omni', 'ReqOmni', 'Devotion']);
const RES = new Set(['FireResist', 'ColdResist', 'LightningResist', 'ChaosResist']);
const HIT = new Set(['TotalEHP', 'PvPTotalTakenHit', 'PhysicalMaximumHitTaken', 'LightningMaximumHitTaken', 'FireMaximumHitTaken', 'ColdMaximumHitTaken', 'ChaosMaximumHitTaken']);
const OFFENCE_END = new Set(['FullDPS', 'FullDotDPS', 'SkillDPS']);

/** The design's five sections; the list's own order inside each is upstream's. */
function groupOf(stat: string, beforeAttrs: boolean): GroupId {
  if (ATTR.has(stat)) return 'attr';
  if (HIT.has(stat)) return 'hit';
  if (RES.has(stat)) return 'res';
  if (OFFENCE_END.has(stat)) return 'off';
  return beforeAttrs ? 'off' : 'pools';
}

/** Lua's `matchFlags`. */
export function matchFlags(req: string | undefined, notFlag: string | undefined, flags: ReadonlySet<string>): boolean {
  if (req !== undefined && !flags.has(req)) return false;
  if (notFlag !== undefined && flags.has(notFlag)) return false;
  return true;
}

interface SkillDpsRow {
  name: string;
  dps: number;
  count: number;
  skillPart?: string;
  source?: string;
  trigger?: string;
}

/** The engine writes "Inf" / "-Inf" / "NaN" as text (JSON has no infinity); upstream's output holds the numbers. */
export function normaliseOutput(stats: Record<string, unknown>): Output {
  const out: Output = {};
  for (const [k, v] of Object.entries(stats)) {
    out[k] = v === 'Inf' ? Infinity : v === '-Inf' ? -Infinity : v === 'NaN' ? NaN : v;
  }
  for (const hand of ['MainHand', 'OffHand']) {
    const t = out[hand];
    if (t && typeof t === 'object') {
      const c: Output = {};
      for (const [k, v] of Object.entries(t as Output)) c[k] = v === 'Inf' ? Infinity : v === '-Inf' ? -Infinity : v === 'NaN' ? NaN : v;
      out[hand] = c;
    }
  }
  return out;
}

/**
 * The sidebar for one actor: `AddDisplayStatList` plus the cost warnings after it. With `inGroup` every row goes in that
 * section and only the list's own warnings are kept: that is the minion's list (`minionDisplayStats` over the minion's
 * output and its main skill's flags), which upstream prints as "Minion:" above "Player:".
 */
export function buildSidebar(output: Output, flags: ReadonlySet<string>, fmt: NumberFormat, list: DisplayStat[] = displayStats, inGroup?: GroupId): SidebarModel {
  const rows: SidebarRow[] = [];
  const warnings: string[] = [];
  const addWarning = (w: string) => {
    if (!warnings.includes(w)) warnings.push(w);
  };
  const strIdx = list.findIndex((s) => s.stat === 'Str');
  let n = 0;
  for (const [li, sd] of list.entries()) {
    if (!matchFlags(sd.flag, sd.notFlag, flags)) continue;
    if (!sd.stat) continue; // separators: the sections come from `groupOf`
    let statVal: unknown = output[sd.stat];
    if (T(statVal) && sd.childStat && statVal && typeof statVal === 'object') statVal = (statVal as Output)[sd.childStat];
    if (!T(statVal)) continue;
    const shown = sd.condFunc ? sd.condFunc(statVal, output) : statVal !== 0;
    if (shown) {
      let overCap = sd.overCapStat ? (output[sd.overCapStat] as number | undefined) : undefined;
      if (overCap !== undefined && sd.overCapStatCondFunc && !sd.overCapStatCondFunc(statVal, output)) overCap = undefined;
      const group = inGroup ?? groupOf(sd.stat, li < strIdx);
      if (sd.stat === 'SkillDPS') {
        const list2 = Object.values(statVal as Record<string, SkillDpsRow>).sort((a, b) => b.dps * b.count - a.dps * a.count);
        for (const s of list2) {
          const label = (s.count >= 2 ? `${s.count}x ` : '') + s.name + (s.trigger ? ` (${s.trigger})` : '');
          const f = formatStat({ fmt: '.1f', compactValue: sd.compactValue }, s.dps * s.count, overCap, fmt);
          const sub: string[] = [];
          if (s.skillPart) sub.push(s.skillPart);
          if (s.source) sub.push(`from ${s.source}`);
          rows.push({ key: `${sd.stat}${n++}`, stat: sd.stat, label, text: f.text, value: s.dps * s.count, negative: f.negative, muted: f.muted, warn: false, sub, group, color: undefined });
        }
      } else if (!sd.hideStat && typeof statVal === 'number') {
        const warnRed = T(output[sd.stat + 'Warning']) || (!!sd.warnFunc && !!sd.warnFunc(statVal, output) && !!sd.warnColor);
        const f = formatStat(sd, statVal, overCap, fmt, warnRed ? true : undefined);
        let suffix: string | undefined;
        if (sd.suffix && (!sd.suffixCondFunc || sd.suffixCondFunc(statVal, output))) {
          suffix = typeof sd.suffix === 'function' ? sd.suffix(statVal, output) : sd.suffix;
        }
        rows.push({ key: `${sd.stat}${n++}`, stat: sd.stat, label: sd.label ?? sd.stat, text: f.text, value: statVal, negative: f.negative, muted: f.muted, suffix, color: sd.color, warn: warnRed, group, breakdown: sd.breakdown, childStat: sd.childStat, modNames: sd.modNames, ignoredSections: sd.ignoredSections, compPercent: sd.compPercent, lowerIsBetter: sd.lowerIsBetter });
      }
    }
    if (sd.warnFunc && (!sd.condFunc || sd.condFunc(statVal, output))) {
      const w = sd.warnFunc(statVal, output);
      if (w) addWarning(w);
    }
  }
  if (inGroup) return { rows, warnings, info: [] };
  const costWarn: Array<[string, string]> = [['Life', 'LifeCostWarningList'], ['Mana', 'ManaCostWarningList'], ['Rage', 'RageCostWarningList'], ['Energy Shield', 'ESCostWarningList']];
  for (const [pool, key] of costWarn) {
    const l = output[key];
    if (l && typeof l === 'object') {
      const names = Object.values(l as Record<string, string>);
      addWarning(`You do not have enough ${T(output.EnergyShieldProtectsMana) && pool === 'Mana' ? 'Energy Shield and Mana' : pool} to use: ${names.join(', ')}`);
    }
  }
  const pctWarn: Array<[string, string]> = [['Unreserved life', 'LifePercentCostPercentCostWarningList'], ['Unreserved Mana', 'ManaPercentCostPercentCostWarningList']];
  for (const [pool, key] of pctWarn) {
    const l = output[key];
    if (l && typeof l === 'object') addWarning(`You do not have enough ${pool}% to use: ${Object.values(l as Record<string, string>).join(', ')}`);
  }
  if (typeof output.TimelessDataWarning === "string") addWarning(output.TimelessDataWarning);
  if (T(output.VixensTooMuchCastSpeedWarn)) addWarning("You may have too much cast speed or too little cooldown reduction to effectively use Vixen's Curse replacement");
  if (T(output.VixenModeNoVixenGlovesWarn)) addWarning("Vixen's calculation mode for Doom Blast is selected but you do not have Vixen's Entrapment Embroidered Gloves equipped");
  return { rows, warnings, info: [] };
}

export { displayStats, minionDisplayStats };

// ---- node and item comparisons (`buildMode:CompareStatList`) -----------------------------------------------------

export interface CompareLine {
  key: string;
  /** "+228", the sign and value as upstream prints them. */
  value: string;
  label: string;
  /** " (+4.9%)" when the row compares by percent. */
  percent?: string;
  good: boolean;
  color?: ColorName;
  /** "[+12.5 (+0.3%) per point]" on the lines of a many-node change, as upstream adds it. */
  perPoint?: string;
}

/** The lines upstream's tooltip shows for a change from `base` to `compare` output (the changed display stats). */
export function compareLines(base: Output, compare: Output, flags: ReadonlySet<string>, fmt: NumberFormat, list: DisplayStat[] = displayStats, nodeCount?: number): CompareLine[] {
  const out: CompareLine[] = [];
  let n = 0;
  for (const sd of list) {
    if (!sd.stat || sd.childStat || sd.stat === 'SkillDPS' || !matchFlags(sd.flag, sd.notFlag, flags)) continue;
    const v1 = (compare[sd.stat] as number | undefined) ?? 0;
    const v2 = (base[sd.stat] as number | undefined) ?? 0;
    if (typeof v1 !== 'number' || typeof v2 !== 'number') continue;
    let diff = v1 - v2;
    if (sd.stat === 'FullDPS' && compare[sd.stat] === undefined) diff = 0;
    if (!(diff > 0.001 || diff < -0.001)) continue;
    if (sd.condFunc && !(sd.condFunc(v1, compare) || sd.condFunc(v2, base))) continue;
    const good = (sd.lowerIsBetter && diff < 0) || (!sd.lowerIsBetter && diff > 0);
    const val = diff * (sd.pc || sd.mod ? 100 : 1);
    const f0 = sd.fmt ?? '.1f';
    const value = formatNumSep(trimZeros(sFormat(f0.startsWith('+') ? f0 : '+' + f0, val)), fmt);
    let percent: string | undefined;
    let pcPerPt = '';
    if (sd.compPercent && v1 !== 0 && v2 !== 0) {
      const pc = (v1 / v2) * 100 - 100;
      percent = ` (${sFormat('+.1f', pc)}%)`;
      if (nodeCount) pcPerPt = ` (${sFormat('+.1f', pc / nodeCount)}%)`;
    }
    const perPoint = nodeCount ? `[${sFormat(f0.startsWith('+') ? f0 : '+' + f0, val / nodeCount)}${pcPerPt} per point]` : undefined;
    out.push({ key: `${sd.stat}${n++}`, value, label: sd.label ?? sd.stat, percent, good, color: sd.color, ...(perPoint ? { perPoint } : {}) });
  }
  return out;
}
