/** Tier letters in NeverSink's order: tier 1 is S, tier 2 is A, and so on. Customize names tiers the same way. */
export const TIER_LETTERS = ['S', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

/**
 * A short, distinct name for each tier of one item type. NeverSink numbers its tiers (`t1exalted`, `t2divine`, `t4chaos`)
 * and some types carry two tags with the same number (`t4` and `t4c`), which used to both read "Tier 4". The second one
 * keeps its tag in brackets so no two tiers of a type share a name.
 */
export function tierNames(tiers: { key: string; tier: string }[]): Map<string, string> {
  const out = new Map<string, string>();
  const parts = tiers.map((t) => {
    const m = /^t(\d+)(.*)$/.exec(t.tier);
    return { key: t.key, tier: t.tier, letter: m ? TIER_LETTERS[Number(m[1]) - 1] ?? `T${m[1]}` : t.tier.replace(/_/g, ' '), tail: m ? m[2]! : '' };
  });
  const sharing = new Map<string, number>();
  for (const p of parts) sharing.set(p.letter, (sharing.get(p.letter) ?? 0) + 1);
  const used = new Set<string>();
  for (const p of parts) {
    // The plain tag keeps the bare letter; its siblings carry what follows the number, like "C (c)".
    // A one-letter tail ("c") says nothing to a player, so a sibling reads "C (second)" instead.
    const seenSame = parts.slice(0, parts.indexOf(p)).filter((q) => q.letter === p.letter).length;
    const tailName = p.tail.length > 1 ? p.tail : ['', 'second', 'third', 'fourth', 'fifth'][seenSame] ?? `no. ${seenSame + 1}`;
    let name = (sharing.get(p.letter) ?? 0) > 1 && p.tail && seenSame > 0 ? `${p.letter} (${tailName})` : p.letter;
    let n = 1;
    while (used.has(name)) name = `${p.letter} (${['second', 'third', 'fourth', 'fifth'][n - 1] ?? `no. ${n + 1}`})`, n++;
    used.add(name);
    out.set(p.key, name);
  }
  return out;
}
