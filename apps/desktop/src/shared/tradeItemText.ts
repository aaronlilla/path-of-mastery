import type { TradeItem } from './wealthTrade.js';

/**
 * An item from the trade site (or the stash) written as upstream item text, the way upstream's character
 * import does it (`ImportTab:ImportItem` collects the fields, `Item:BuildRaw` writes them). The engine then parses the
 * text like any other item.
 */

const RARITY: Record<number, string> = { 0: 'NORMAL', 1: 'MAGIC', 2: 'RARE', 3: 'UNIQUE', 9: 'RELIC', 10: 'RELIC' };
const INFLUENCE: [string, string][] = [
  ['shaper', 'Shaper Item'],
  ['elder', 'Elder Item'],
  ['crusader', 'Crusader Item'],
  ['redeemer', 'Redeemer Item'],
  ['hunter', 'Hunter Item'],
  ['warlord', 'Warlord Item'],
];

/** The game's colour and markup codes inside item text ("<default>{...}", "[Tag|Shown]") reduced to plain text. */
export function sanitise(raw: string | { description?: string }): string {
  const s = typeof raw === 'string' ? raw : raw?.description ?? '';
  return s
    .replace(/<\w+>\{([^}]*)\}/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\[([^\]|]+)\|([^\]]+)\]/g, '$2')
    .replace(/\[([^\]]+)\]/g, '$1')
    .trim();
}

const lines = (xs: Array<string | { description?: string }> | undefined): string[] => (xs ?? []).flatMap((m) => sanitise(m).split('\n').map((l) => l.trim()).filter(Boolean));

export interface ItemTextResult {
  text: string;
  rarity: string;
  title: string;
  base: string;
}

/** Returns null for an item upstream would also skip (no rarity, or nothing to calculate). */
export function tradeItemText(it: TradeItem): ItemTextResult | null {
  const rarity = RARITY[it.frameType];
  if (!rarity) return null;
  const name = sanitise(it.name ?? '');
  const typeLine = sanitise(it.typeLine ?? '').replace(/^Synthesised /, '').replace(/^Vestigial /, '');
  let title = '';
  let base = typeLine;
  const out: string[] = [`Rarity: ${rarity}`];
  if (name) {
    title = name;
    if (base === 'Two-Toned Boots') base = 'Two-Toned Boots (Armour/Energy Shield)';
    out.push(name, base);
  } else {
    // Normal and magic items carry the whole name in the type line; the base is found by the engine from it.
    out.push(typeLine);
  }
  const props = it.properties ?? [];
  const num = (v: string | undefined): number | undefined => {
    const m = /-?\d+(?:\.\d+)?/.exec(v ?? '');
    return m ? parseFloat(m[0]) : undefined;
  };
  // Armour values the engine reads back from the item's own numbers.
  const armour: [string, string][] = [['Armour', 'Armour'], ['Evasion Rating', 'Evasion'], ['Energy Shield', 'Energy Shield'], ['Ward', 'Ward']];
  for (const [prop, label] of armour) {
    const p = props.find((x) => x.name === prop);
    if (!p) continue;
    const total = p.values.reduce((s, v) => s + (num(v[0]) ?? 0), 0);
    if (total > 0) out.push(`${label}: ${total}`);
  }
  if (it.id) out.push(`Unique ID: ${it.id}`);
  if (it.influences) for (const [k, label] of INFLUENCE) if (it.influences[k]) out.push(label);
  if (it.ilvl && it.ilvl > 0) out.push(`Item Level: ${it.ilvl}`);
  const quality = props.find((x) => x.name === 'Quality');
  const q = num(quality?.values[0]?.[0]);
  if (q !== undefined) out.push(`Quality: ${q}`);
  if (it.sockets && it.sockets.length) {
    let s = '';
    it.sockets.forEach((k, i) => {
      s += k.sColour;
      const next = it.sockets![i + 1];
      if (next) s += next.group === k.group ? '-' : ' ';
    });
    out.push(`Sockets: ${s}`);
  }
  const req = (it.requirements ?? []).find((r) => r.name === 'Level');
  const lvl = num(req?.values[0]?.[0]);
  if (lvl !== undefined) out.push(`LevelReq: ${lvl}`);
  const enchant = lines(it.enchantMods).map((l) => `{enchant}${l}`);
  const scourge = lines(it.scourgeMods).map((l) => `{scourge}${l}`);
  const implicit = lines(it.implicitMods);
  out.push(`Implicits: ${enchant.length + scourge.length + implicit.length}`);
  out.push(...enchant, ...scourge, ...implicit);
  out.push(...lines(it.fracturedMods).map((l) => `{fractured}${l}`));
  out.push(...lines(it.explicitMods));
  out.push(...lines(it.craftedMods).map((l) => `{crafted}${l}`));
  out.push(...lines(it.mutatedMods).map((l) => `{mutated}${l}`));
  out.push(...lines(it.crucibleMods).map((l) => `{crucible}${l}`));
  if (it.mirrored || it.duplicated) out.push('Mirrored');
  if (it.fractured) out.push('Fractured Item');
  if (it.corrupted) out.push('Corrupted');
  return { text: out.join('\n'), rarity, title, base };
}
