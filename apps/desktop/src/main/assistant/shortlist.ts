// Jev as the solver's optional shortlister: before a solve, Jev answers one yes/no question per
// candidate (support gems, uniques when the item rules allow them, modifier families) for the goal's main skill. The
// probabilities go to the solver as `goal.priority`, which only changes the order candidates are tested in; the
// solver still tests every one and the engine's numbers decide. No key, an error or a slow answer: no priority.
import type { CatalogUnique, GemInfo, SolveGoal, SolvePriority } from '@pom/protocol';
import type { JevDecide, JevQuestion } from './jev.js';
import type { AssistantEngine } from './tools.js';

/** The whole shortlist (every call in parallel) waits at most this long. */
export const SHORTLIST_MS = 2000;
/** Questions per call (about 30-60 tokens each, well under Jev's 64k tokens per request). */
const BATCH = 300;

/** Modifier families Jev weighs, as phrases of the modifier text; the solver matches them in its families' text. */
export const MOD_FAMILIES = [
  'maximum Life', 'maximum Energy Shield', 'maximum Mana', 'Armour', 'Evasion Rating', 'Life Regeneration', 'Mana Regeneration',
  'Fire Resistance', 'Cold Resistance', 'Lightning Resistance', 'Chaos Resistance', 'all Elemental Resistances',
  'to Strength', 'to Dexterity', 'to Intelligence', 'to all Attributes', 'Movement Speed',
  'Physical Damage', 'Fire Damage', 'Cold Damage', 'Lightning Damage', 'Chaos Damage', 'Elemental Damage', 'Spell Damage',
  'Damage over Time', 'Attack Speed', 'Cast Speed', 'Critical Strike Chance', 'Critical Strike Multiplier', 'Accuracy Rating',
  'Level of all', 'Minion', 'Projectile', 'Area of Effect', 'Leeched as Life', 'Life gained', 'Mana Cost', 'Flask', 'Block',
  'Damage with Bleeding', 'Damage with Poison', 'Damage with Ignite',
];

type ItemRules = { rarities?: string[]; mustUse?: string[]; neverUse?: string[] };

/** The solver's own rule: uniques are allowed unless the rarities leave them out (a must-use unique always is). */
export function uniquesAllowed(goal: SolveGoal): boolean {
  const r = (goal.items ?? {}) as ItemRules;
  return !!r.mustUse?.length || !r.rarities || r.rarities.some((x) => /^uniques?$/i.test(x));
}

const MOD_LINE = /^(Rarity|Requires|Implicits|League|Source|Variant|Selected Variant|LevelReq|Item Level|Sockets|Limited to|Radius|Has Alt|Quality|Unique ID|Crafted|Prefix|Suffix|\{)/i;

/** A unique's first few modifier lines (its text without the header). */
function uniqueMods(u: CatalogUnique): string {
  const lines = u.text.split('\n').map((l) => l.replace(/\{[^}]*\}/g, '').trim()).filter((l) => l && l !== u.name && l !== u.base && !MOD_LINE.test(l));
  return lines.slice(0, 5).join('; ').slice(0, 300);
}

export interface ShortlistDeps {
  engine: Pick<AssistantEngine, 'send'>;
  decide: JevDecide;
  timeoutMs?: number;
}

/** Jev's priority for a goal, or null (no answer in time). Never throws. */
export async function shortlist(goal: SolveGoal, d: ShortlistDeps): Promise<SolvePriority | null> {
  try {
    const level = goal.level ?? 90;
    const [{ gems }, uniques] = await Promise.all([
      d.engine.send('gemCatalog', {} as Record<string, never>) as Promise<{ gems: GemInfo[] }>,
      uniquesAllowed(goal) ? (d.engine.send('itemCatalog', {} as Record<string, never>) as Promise<{ catalog: { uniques: CatalogUnique[] } }>).then((r) => r.catalog.uniques) : Promise.resolve([] as CatalogUnique[]),
    ]);
    const skill = gems.find((g) => !g.support && g.name.toLowerCase() === goal.skill.trim().toLowerCase());
    const state = [
      'Path of Exile character build.',
      `Main skill: ${goal.skill}${skill ? ` (${skill.tags.join(', ')})` : ''}.`,
      goal.ascendancy ? `Ascendancy: ${goal.ascendancy}.` : '',
      `Character level ${level}.`,
      goal.targets?.length ? `Goals: ${goal.targets.map((t) => `${t.name} (${t.metric ?? 'combined'})`).join(', ')}.` : '',
    ].filter(Boolean).join(' ');

    const ban = new Set([...(goal.gems?.ban ?? []), ...((goal.items as ItemRules | undefined)?.neverUse ?? [])].map((x) => x.toLowerCase()));
    const supports = [...new Set(gems.filter((g) => g.support && !g.legacy && !g.vaal && !g.exceptional && !g.transfiguredOf && (g.levelReq[0] ?? 1) <= level && !ban.has(g.name.toLowerCase())).map((g) => g.name))];
    const tagsOf = new Map(gems.map((g) => [g.name, g.tags.join(', ')]));
    const seen = new Set<string>();
    const uniq = uniques.filter((u) => u.level <= level && !ban.has(u.name.toLowerCase()) && !seen.has(u.name) && seen.add(u.name));

    // Every question as [kind, name, question]; asked in batches, all at once.
    const all: Array<['supports' | 'uniques' | 'modGroups', string, JevQuestion]> = [
      ...supports.map((n) => ['supports', n, { type: 'noul', instructions: `Is the support gem ${n} (${tagsOf.get(n)}) a good link for the main skill of this build?` }] as const),
      ...uniq.map((u) => ['uniques', u.name, { type: 'noul', instructions: `Is the unique item ${u.name} (${u.base}) useful for this build? It has: ${uniqueMods(u)}` }] as const),
      ...MOD_FAMILIES.map((m) => ['modGroups', m, { type: 'noul', instructions: `Is an item modifier with "${m}" valuable for this build?` }] as const),
    ] as Array<['supports' | 'uniques' | 'modGroups', string, JevQuestion]>;
    const calls: Array<Promise<boolean>> = [];
    const out: Required<SolvePriority> = { supports: {}, uniques: {}, modGroups: {} };
    for (let i = 0; i < all.length; i += BATCH) {
      const part = all.slice(i, i + BATCH);
      const qs = Object.fromEntries(part.map((q, k) => [`q${k}`, q[2]]));
      calls.push(
        d.decide(state, qs).then((a) => {
          if (!a) return false;
          part.forEach(([kind, name], k) => {
            const p = a[`q${k}`]?.noul;
            if (typeof p === 'number' && Number.isFinite(p)) out[kind][name] = Math.round(p * 1000) / 1000;
          });
          return true;
        }),
      );
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'late'>((r) => (timer = setTimeout(() => r('late'), d.timeoutMs ?? SHORTLIST_MS)));
    const done = await Promise.race([Promise.allSettled(calls), late]);
    clearTimeout(timer);
    if (done === 'late') return null;
    if (!done.some((r) => r.status === 'fulfilled' && r.value)) return null;
    const kept = Object.fromEntries(Object.entries(out).filter(([, v]) => Object.keys(v).length)) as SolvePriority;
    return Object.keys(kept).length ? kept : null;
  } catch {
    return null;
  }
}
