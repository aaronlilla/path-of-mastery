import type { StatKind } from './blocks.js';

/**
 * The engine's stat ids the assistant talks about, with the label and colour the panel draws them in. Anything
 * not listed is shown under its engine id, so a stat the model asks for is never hidden.
 */
export interface StatMeta {
  id: string;
  label: string;
  kind: StatKind;
  /** How the number is written. */
  fmt: 'int' | 'num' | 'pct' | 'mult';
}

export const STAT_META: StatMeta[] = [
  { id: 'FullDPS', label: 'Full DPS', kind: 'dps', fmt: 'int' },
  { id: 'CombinedDPS', label: 'Combined DPS', kind: 'dps', fmt: 'int' },
  { id: 'TotalDPS', label: 'Hit DPS', kind: 'dps', fmt: 'int' },
  { id: 'MinionTotalDPS', label: 'Minion damage', kind: 'dps', fmt: 'int' },
  { id: 'AverageHit', label: 'Average hit', kind: 'dps', fmt: 'int' },
  { id: 'Speed', label: 'Attack or cast rate', kind: 'dps', fmt: 'num' },
  { id: 'CritChance', label: 'Crit chance', kind: 'dps', fmt: 'pct' },
  { id: 'CritMultiplier', label: 'Crit multiplier', kind: 'dps', fmt: 'mult' },
  { id: 'HitChance', label: 'Hit chance', kind: 'dps', fmt: 'pct' },
  { id: 'TotalEHP', label: 'Effective HP', kind: 'ehp', fmt: 'int' },
  { id: 'TotalEHPGuardUp', label: 'Effective HP with the guard up', kind: 'ehp', fmt: 'int' },
  { id: 'Life', label: 'Life', kind: 'life', fmt: 'int' },
  { id: 'LifeRegenRecovery', label: 'Life regen', kind: 'life', fmt: 'num' },
  { id: 'EnergyShield', label: 'Energy shield', kind: 'es', fmt: 'int' },
  { id: 'Mana', label: 'Mana', kind: 'mana', fmt: 'int' },
  { id: 'Armour', label: 'Armour', kind: 'armour', fmt: 'int' },
  { id: 'Evasion', label: 'Evasion', kind: 'evasion', fmt: 'int' },
  { id: 'MeleeEvadeChance', label: 'Melee evade chance', kind: 'evasion', fmt: 'pct' },
  { id: 'ProjectileEvadeChance', label: 'Projectile evade chance', kind: 'evasion', fmt: 'pct' },
  { id: 'FireResist', label: 'Fire resistance', kind: 'res', fmt: 'pct' },
  { id: 'ColdResist', label: 'Cold resistance', kind: 'res', fmt: 'pct' },
  { id: 'LightningResist', label: 'Lightning resistance', kind: 'res', fmt: 'pct' },
  { id: 'ChaosResist', label: 'Chaos resistance', kind: 'chaos', fmt: 'pct' },
  { id: 'EffectiveBlockChance', label: 'Block chance', kind: 'armour', fmt: 'pct' },
  { id: 'EffectiveSpellBlockChance', label: 'Spell block chance', kind: 'armour', fmt: 'pct' },
  { id: 'AttackDodgeChance', label: 'Attack dodge chance', kind: 'evasion', fmt: 'pct' },
  { id: 'SpellDodgeChance', label: 'Spell dodge chance', kind: 'evasion', fmt: 'pct' },
  { id: 'EvadeChance', label: 'Evade chance', kind: 'evasion', fmt: 'pct' },
  { id: 'PhysicalDamageReduction', label: 'Physical damage reduction', kind: 'armour', fmt: 'pct' },
  { id: 'BlockChance', label: 'Block chance', kind: 'armour', fmt: 'pct' },
  { id: 'SpellBlockChance', label: 'Spell block chance', kind: 'armour', fmt: 'pct' },
  { id: 'SpellSuppressionChance', label: 'Spell suppression chance', kind: 'armour', fmt: 'pct' },
  { id: 'EffectiveSpellSuppressionChance', label: 'Spell suppression chance', kind: 'armour', fmt: 'pct' },
  { id: 'SpellSuppressionChanceMax', label: 'Spell suppression cap', kind: 'armour', fmt: 'pct' },
  { id: 'SpellSuppressionEffect', label: 'Spell suppression effect', kind: 'armour', fmt: 'pct' },
  { id: 'Str', label: 'Strength', kind: 'neutral', fmt: 'int' },
  { id: 'Dex', label: 'Dexterity', kind: 'neutral', fmt: 'int' },
  { id: 'Int', label: 'Intelligence', kind: 'neutral', fmt: 'int' },
  { id: 'PhysicalMaximumHitTaken', label: 'Physical max hit', kind: 'armour', fmt: 'int' },
  { id: 'FireMaximumHitTaken', label: 'Fire max hit', kind: 'res', fmt: 'int' },
  { id: 'ColdMaximumHitTaken', label: 'Cold max hit', kind: 'res', fmt: 'int' },
  { id: 'LightningMaximumHitTaken', label: 'Lightning max hit', kind: 'res', fmt: 'int' },
  { id: 'ChaosMaximumHitTaken', label: 'Chaos max hit', kind: 'chaos', fmt: 'int' },
  { id: 'ManaUnreserved', label: 'Unreserved mana', kind: 'mana', fmt: 'int' },
  { id: 'EffectiveMovementSpeedMod', label: 'Movement speed', kind: 'neutral', fmt: 'mult' },
];

const BY_ID = new Map(STAT_META.map((m) => [m.id, m]));

export function statMeta(id: string): StatMeta {
  return BY_ID.get(id) ?? { id, label: resistLabel(id) ?? humanStat(id), kind: kindOf(id), fmt: /Resist(Max|OverCap|Total)$|^Missing\w+Resist$/.test(id) ? 'pct' : 'num' };
}

/** "ChaosResistMax" as "Chaos resistance cap", "MissingChaosResist" as "Missing chaos resistance": the engine's own words ("resist max") read as a bug. */
function resistLabel(id: string): string | null {
  const m = /^(Fire|Cold|Lightning|Chaos)Resist(Max|OverCap|Total)$/.exec(id);
  if (m) return `${m[1]} resistance ${{ Max: 'cap', OverCap: 'over the cap', Total: 'before the cap' }[m[2] as 'Max']}`;
  const q = /^Req(Str|Dex|Int|Omni)$/.exec(id);
  if (q) return `${{ Str: 'Strength', Dex: 'Dexterity', Int: 'Intelligence', Omni: 'Omniscience' }[q[1] as 'Str']} requirement`;
  const x = /^Missing(Fire|Cold|Lightning|Chaos)Resist$/.exec(id);
  return x ? `Missing ${x[1]!.toLowerCase()} resistance` : null;
}

/** "CausticGroundDPS" becomes "Caustic ground DPS", so an engine stat id never reaches the screen as written. */
export function humanStat(id: string): string {
  const words = id
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_.]+/g, ' ')
    .trim()
    .split(/\s+/);
  if (!words.length || !words[0]) return id;
  return words.map((w, i) => (/^[A-Z0-9]{2,}$/.test(w) ? w : i === 0 ? w[0]!.toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join(' ').replace(/\bdot\b/gi, 'DoT');
}

function kindOf(id: string): StatKind {
  if (/Chaos/i.test(id)) return 'chaos';
  if (/Life/i.test(id)) return 'life';
  if (/Mana/i.test(id)) return 'mana';
  if (/EnergyShield/i.test(id)) return 'es';
  if (/Armour/i.test(id)) return 'armour';
  if (/Evasion/i.test(id)) return 'evasion';
  if (/Resist/i.test(id)) return 'res';
  if (/DPS|Damage|Hit|Crit|Speed/i.test(id)) return 'dps';
  return 'neutral';
}

/** Position in the priority list; unlisted stats sort after every listed one. */
export function statPriority(id: string): number {
  const i = STAT_META.findIndex((m) => m.id === id);
  return i < 0 ? 1000 : i;
}

export function compact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (a >= 1e5) return (n / 1e3).toFixed(0) + 'k';
  if (a >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(n));
}

/** A stat value the way the sidebar writes it. */
export function formatStat(id: string, v: number | string | boolean | null): string {
  if (v === null || v === undefined) return '–';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'string') return v;
  if (!Number.isFinite(v)) return '–';
  if (/Immunity$/.test(id)) return v ? 'yes' : 'no';
  const meta = statMeta(id);
  switch (meta.fmt) {
    case 'int':
      return Math.abs(v) >= 10000 ? compact(v) : Math.round(v).toLocaleString('en-US');
    case 'pct':
      return `${Math.round(v * 100) / 100}%`;
    case 'mult':
      // movement speed is a multiplier (1.3): the sidebar writes it +30%
      return id === 'EffectiveMovementSpeedMod' ? `${v >= 1 ? '+' : '-'}${Math.abs(Math.round((v - 1) * 100))}%` : `${Math.round(v * 100)}%`;
    default:
      // a big engine number (1431444.81) reads as 1.43M, like the sidebar; a small one keeps two decimals
      return Math.abs(v) >= 10000 ? compact(v) : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : String(Math.round(v * 100) / 100);
  }
}

/** Change of a stat as a signed text: "+612" or "-3.1%" (relative for large numbers, absolute for small). */
export function formatDelta(id: string, before: number, after: number): string {
  const d = after - before;
  const meta = statMeta(id);
  if (meta.fmt === 'pct' || meta.fmt === 'mult') {
    const x = meta.fmt === 'mult' ? d * 100 : d;
    return `${x >= 0 ? '+' : '−'}${Math.abs(Math.round(x * 100) / 100)}%`;
  }
  if (Math.abs(before) >= 1000 && before !== 0) {
    const rel = (d / Math.abs(before)) * 100;
    return `${rel >= 0 ? '+' : '−'}${Math.abs(Math.round(rel * 10) / 10)}%`;
  }
  // (a jump from a small or zero value, 0 to 1.75M, reads as the compact number, not 1752273.72)
  return `${d >= 0 ? '+' : '−'}${Math.abs(d) >= 10000 ? compact(Math.abs(d)) : Math.abs(Math.round(d * 100) / 100)}`;
}

// ("Unreserved" mana is better the higher it is)
const LOWER_BETTER = /Cost|SelfHit|(?<!Un)Reserved|Degen|Reservation|TakenHitMult|TakenDamage|^Missing\w*Resist$|Cooldown|Time$/i;

/** The colour class of a change on a card: a requirement that moved is a warning, a stat is green when it moved the way the player wants. */
export function deltaTone(id: string, before: number, after: number): 'pos' | 'neg' | 'warn' {
  if (/^Req(Str|Dex|Int|Omni)$/.test(id)) return 'warn';
  const up = after > before;
  return (LOWER_BETTER.test(id) ? !up : up) ? 'pos' : 'neg';
}
