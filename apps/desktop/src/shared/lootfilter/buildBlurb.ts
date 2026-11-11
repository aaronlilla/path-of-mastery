import type { BuildFacts, BuildProposal } from './buildRules.js';

/**
 * Two plain lines about what the filter reads from the open build, for the Start screen. Every word comes from
 * the build file or the engine's numbers: the gear it wears, the uniques it wears, and any resistance under the cap.
 */
export function buildBlurb(facts: BuildFacts | null, proposals: BuildProposal[]): string[] {
  if (!facts) return [];
  const out: string[] = [];
  const bases = new Set(facts.items.map((i) => i.base).filter(Boolean));
  const parts: string[] = [];
  if (bases.size) parts.push(`${bases.size} gear base${bases.size === 1 ? '' : 's'}`);
  const gems = facts.gems.length;
  if (gems) parts.push(`${gems} gem${gems === 1 ? '' : 's'}`);
  const under: string[] = [];
  for (const p of proposals) {
    const m = /^Your (\w+) resistance is (\d+)% under the cap/.exec(p.why);
    if (m) under.push(`${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} resistance is ${m[2]}% under cap`);
  }
  if (parts.length) out.push(`Reads ${parts.join(' and ')}.${under.length ? ' ' + under.join('. ') + '.' : ''}`);
  else if (under.length) out.push(under.join('. ') + '.');
  const uniques = facts.items.filter((i) => i.rarity === 'UNIQUE' && i.name);
  if (uniques.length) {
    const names = uniques.map((u) => u.name);
    const shown = names.length > 2 ? `${names.slice(0, 2).join(', ')} and ${names.length - 2} more` : names.join(' and ');
    const baseNames = [...new Set(uniques.map((u) => u.base).filter(Boolean))];
    out.push(`Wears ${shown}, so ${baseNames.length > 1 ? 'their bases are' : `${baseNames[0] ?? 'the base'} is`} highlighted when dropped as normal, magic or rare.`);
  }
  return out;
}
