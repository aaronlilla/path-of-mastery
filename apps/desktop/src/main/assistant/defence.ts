import { present } from './tools.js';

type Scalar = string | number | boolean | null;
const ELEMENTS = ['Fire', 'Cold', 'Lightning', 'Chaos'] as const;
const LOW_MAX_HIT = 15000; // shortcut: flat line, not level-scaled
const TYPES = ['Physical', ...ELEMENTS] as const;

/**
 * The build's weakest defences ranked from engine stats, so "weakest" is read from data, not guessed (chaos
 * called weakest while physical max hit was lower), plus the problems to address first, worst first.
 * shortcut: the low-pool line is a flat 4000 Life + ES, not level-scaled; no movement-skill check (needs gems).
 */
export function defenceReport(stats: Record<string, Scalar>) {
  const num = (id: string) => (typeof stats[id] === 'number' ? (stats[id] as number) : null);
  const maxHits = TYPES.filter((t) => num(`${t}MaximumHitTaken`) !== null).sort((a, b) => num(`${a}MaximumHitTaken`)! - num(`${b}MaximumHitTaken`)!);
  const noChaos = !!stats.ChaosInoculation; // Chaos Inoculation: chaos resistance does not matter
  // elemental gaps first, worst first; chaos (usually far below its cap) is last so it never outranks an uncapped element
  const rank = (e: string) => (e === 'Chaos' ? 1 : 0);
  const resists = ELEMENTS.filter((e) => num(`${e}Resist`) !== null && !(noChaos && e === 'Chaos')).map((e) => ({ e, missing: num(`Missing${e}Resist`) ?? 0 })).sort((a, b) => rank(a.e) - rank(b.e) || b.missing - a.missing);
  const topProblems: Array<{ id: string; issue: string; shown: string }> = [];
  if ((num('ManaUnreserved') ?? 0) < 0) topProblems.push({ id: 'ManaUnreserved', issue: 'Reservation is more than the mana pool, so skills cannot be used', shown: present('ManaUnreserved', num('ManaUnreserved')).shown });
  for (const r of resists) if (r.missing > 0) topProblems.push({ id: `${r.e}Resist`, issue: `${r.e} resistance is below its cap`, shown: present(`Missing${r.e}Resist`, r.missing).shown });
  if (num('Life') !== null && (num('Life') ?? 0) + (num('EnergyShield') ?? 0) < 4000) topProblems.push({ id: 'Life', issue: 'Life plus energy shield is low', shown: present('Life', (num('Life') ?? 0) + (num('EnergyShield') ?? 0)).shown });
  if (maxHits.length && num(`${maxHits[0]}MaximumHitTaken`)! < LOW_MAX_HIT) topProblems.push({ id: `${maxHits[0]}MaximumHitTaken`, issue: `${maxHits[0]} is the weakest max hit`, shown: present(`${maxHits[0]}MaximumHitTaken`, num(`${maxHits[0]}MaximumHitTaken`)).shown });
  return {
    note: 'Ranked by the engine: call something the weakest or lowest only from these lists; address topProblems in order, first one first.',
    topProblems,
    maxHitsWeakestFirst: maxHits.map((t) => present(`${t}MaximumHitTaken`, num(`${t}MaximumHitTaken`))),
    resistsWorstFirst: resists.map((r) => ({ ...present(`${r.e}Resist`, num(`${r.e}Resist`)), belowCap: present(`Missing${r.e}Resist`, r.missing).shown })),
  };
}
