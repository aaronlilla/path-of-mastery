import type { Block, Condition } from './types.js';

/**
 * Readable names for NeverSink tiers. A tier tag is a code the author typed ("qualchancing", "deco_mapup_t16",
 * "armors1q1"). Where every part of a tag is an ordinary word, the words are shown. Where one is not, the name is
 * built from what the tier matches: its item class, rarity, quality, levels, links, map tier and so on.
 */

/** Words that may appear in a tag, with how they read. Abbreviations are spelled out; codes are not here. */
const LEX: Record<string, string> = {};
for (const w of ('high low any other others stack stacked custom over quality level early base bases rare rares magic normal large medium small tiny mirrored top general jewel jewels jewellery abyss corrupted uncorrupted fractured veiled flask flasks utility life mana boots gloves helmet shield shields quiver quivers body armour armours weapon weapons caster attack minion ring rings amulet amulets belt belts exotic delve incursion bestiary warband mercenary essence essences unique uniques special multi hide hideable final rest act link links socket sockets map maps portal wisdom scroll fragments physical pure fire cold light lightning chaos focus defense spell core exalter blend bleed double single tincture perfection overquality anointed crucible talisman heist ritual expedition pearl sacrificial stygian mirage first areas under drop vaal gem staves wand sling relic relics key keys safe itemized leagues ultimatum sanctum corruption resist resists great greater optimal very the not and non no yes one two three four five six rgb cluster dual hit speed traps elemental glove helm chest random necropolis craft valuable synth imbued void stones trinket fishing rods pieces items totemic noble burial conqueror idols idol minor enshrouded gear veil duo hybrid movement leveling levels first zone selected sorted mod mods enchanted handpicked foulborn invitations supplies stand silver coin kamasan unknown boss bow vestige binding alchemy chance annul chrom aug divine exalted crusader warlord redeemer hunter shaper elder classes shared influenced exarch eater consumable consumables labyrinth sacrificial doubles starter standard largest valdo nightmare guardian uber blighted temple generic quicksilver misc fract based idjewel hit proj suppress suppression quiv sling socketed linked utility').split(' ')) LEX[w] = w;
Object.assign(LEX, { qual: 'quality', lvl: 'level', ilvl: 'item level', ele: 'elemental', phys: 'physical', jwlry: 'jewellery', es: 'energy shield', dot: 'damage over time', crit: 'critical', amu: 'amulet', jewellery: 'jewellery', deco: 'decorated', decor: 'decorated', trans: 'transmutation', def: 'defence', defense: 'defence', lifeforce: 'lifeforce', tinc: 'tincture', conquerors: "conqueror's", wisdom: 'wisdom', twisdom: 'wisdom', tportal: 'portal', misc: 'miscellaneous', idaj: 'identified abyss jewel', mixer: 'mixed', lake: 'lake of', kala: 'kalandra', asorted: 'assorted', valdo: "Valdo's", ex: 'exception', fract: 'fractured', idjewel: 'identified jewel', proj: 'projectile', quiv: 'quiver', hh: 'helmet', mirage: 'mirage', rgb: 'RGB' });
const LEX_KEYS = Object.keys(LEX).sort((a, b) => b.length - a.length);

/** A tag piece such as `fracturedincursion` as words, or null when any part of it is a code rather than a word. */
export function cleanWords(piece: string): string | null {
  const out: string[] = [];
  for (const part of piece.split(/[_\s]+/).filter(Boolean)) {
    const n = part.length;
    const best: (string[] | null)[] = Array.from({ length: n + 1 }, () => null);
    best[0] = [];
    for (let i = 0; i < n; i++) {
      const here = best[i];
      if (!here) continue;
      const rest = part.slice(i);
      const num = /^\d+/.exec(rest);
      const hops: [number, string][] = [];
      if (num) hops.push([num[0].length, num[0]]);
      const code = /^([tin])(\d+)(?![a-z0-9])/.exec(rest);
      if (code) hops.push([code[0].length, code[1] === 't' ? `tier ${code[2]}` : code[1] === 'i' ? `item level ${code[2]}` : `${code[2]} passives`]);
      for (const k of LEX_KEYS) if (rest.startsWith(k)) hops.push([k.length, LEX[k]!]);
      for (const [len, shown] of hops) {
        const cur = best[i + len];
        if (!cur || here.length + 1 < cur.length) best[i + len] = [...here, shown];
      }
    }
    const got = best[n];
    if (!got) return null;
    out.push(...got);
  }
  return out.join(' ');
}

const cond = (b: Block, key: string): Condition[] => b.conditions.filter((c) => c.key === key);
const num = (c: Condition | undefined): number | undefined => (c && c.values[0] !== undefined && /^\d+$/.test(c.values[0]) ? Number(c.values[0]) : undefined);
const lower = (s: string): string => s.toLowerCase();

const CLASS_NOUN: Record<string, string> = {
  'Skill Gems': 'gems',
  'Support Gems': 'gems',
  'Body Armours': 'body armours',
  'Utility Flasks': 'utility flasks',
  'Life Flasks': 'life flasks',
  'Mana Flasks': 'mana flasks',
  'Hybrid Flasks': 'hybrid flasks',
  'Abyss Jewels': 'abyss jewels',
  'Jewels': 'jewels',
};

function subject(b: Block, bases: string[]): string {
  const cls = cond(b, 'Class')[0]?.values ?? [];
  if (cls.length) {
    const nouns = [...new Set(cls.map((c) => CLASS_NOUN[c] ?? lower(c)))];
    if (nouns.length <= 3) return nouns.length > 1 ? `${nouns.slice(0, -1).join(', ')} and ${nouns[nouns.length - 1]}` : nouns[0]!;
    return 'gear';
  }
  if (bases.length && bases.length <= 2) return bases.join(' and ');
  if (bases.length) return 'bases';
  return 'items';
}

/** What a tier's first block matches, in plain words. `more` adds the secondary conditions (levels, sizes) that tell similar tiers apart. */
export function describeTier(b: Block, bases: string[], more = false): string {
  const pre: string[] = [];
  const post: string[] = [];
  const rar = cond(b, 'Rarity')[0]?.values ?? [];
  if (rar.length === 1) pre.push(lower(rar[0]!));
  else if (rar.length === 2 && rar.includes('Normal') && rar.includes('Magic')) pre.push('normal and magic');
  const flag = (k: string): string | undefined => cond(b, k)[0]?.values[0];
  if (flag('Corrupted') === 'True') pre.push('corrupted');
  if (flag('FracturedItem') === 'True') pre.push('fractured');
  if (flag('Mirrored') === 'True') pre.push('mirrored');
  if (flag('Identified') === 'True') pre.push('identified');
  if (flag('ZanaMemory') === 'True') pre.push('Zana memory');
  const inf = cond(b, 'HasInfluence')[0]?.values;
  if (inf) pre.push(inf.length >= 4 ? 'influenced' : inf.map(lower).join(' or ') + '-influenced');
  const links = num(cond(b, 'LinkedSockets')[0]);
  if (links) pre.push(`${links}-linked`);
  const range = (label: string, c: Condition | undefined): string | undefined => (c && num(c) ? `${label} ${num(c)}${c.op.startsWith('>') ? '+' : c.op.startsWith('<') ? ' or less' : ''}` : undefined);
  const nums = [range('quality', cond(b, 'Quality')[0]), range('level', cond(b, 'GemLevel')[0])].filter((x): x is string => !!x);
  if (nums.length === 1) pre.push(nums[0]!);

  const cls = cond(b, 'Class')[0]?.values ?? [];
  const mt = cond(b, 'MapTier').filter((c) => num(c) !== undefined);
  let subj = subject(b, bases);
  if (cls.length === 1 && cls[0] === 'Maps') {
    const lo = mt.find((c) => c.op.startsWith('>'));
    const hi = mt.find((c) => c.op.startsWith('<'));
    const eq = mt.find((c) => !c.op.startsWith('>') && !c.op.startsWith('<'));
    if (eq) subj = `maps tier ${num(eq)}`;
    else if (lo && hi) subj = `maps tier ${num(lo)} to ${num(hi)}`;
    else if (lo) subj = `maps tier ${num(lo)}+`;
    else if (hi) subj = `maps tier ${num(hi)} or lower`;
  }

  const il = cond(b, 'ItemLevel').filter((c) => num(c) !== undefined);
  const ilLo = il.find((c) => c.op.startsWith('>'));
  const ilHi = il.find((c) => c.op.startsWith('<'));
  if (ilLo && ilHi) post.push(`item level ${num(ilLo)} to ${num(ilHi)}`);
  else if (ilLo) post.push(`item level ${num(ilLo)}+`);
  else if (ilHi) post.push(`item level up to ${num(ilHi)}`);
  const pn = cond(b, 'EnchantmentPassiveNum')[0];
  if (pn && num(pn)) post.push(pn.op.startsWith('<') ? `up to ${num(pn)} passives` : pn.op.startsWith('>') ? `${num(pn)}+ passives` : `${num(pn)} passives`);
  if (cond(b, 'EnchantmentPassiveNode').length) post.push('with wanted passives');
  if (cond(b, 'HasExplicitMod').length) post.push('with wanted mods');
  if (cond(b, 'HasEnchantment').length) post.push('enchanted');
  const ss = cond(b, 'SocketGroup')[0]?.values[0];
  if (ss) post.push(`${ss} sockets`);
  const sk = cond(b, 'Sockets')[0];
  if (sk && num(sk)) post.push(`${num(sk)} ${num(sk) === 1 ? 'socket' : 'sockets'}`);
  const stack = cond(b, 'StackSize')[0];
  if (stack && num(stack)) post.push(`stacks of ${num(stack)}${stack.op.startsWith('>') ? '+' : ''}`);
  const w = num(cond(b, 'Width')[0]);
  const h = num(cond(b, 'Height')[0]);
  if (w && h) post.push(`${w} by ${h} slots`);
  else if (w) post.push(`${w} wide`);
  else if (h) post.push(`${h} tall`);
  if (more) {
    const dl = cond(b, 'DropLevel').filter((c) => num(c) !== undefined)[0];
    if (dl) post.push(`drop level ${dl.op.startsWith('<') ? 'under' : ''} ${num(dl)}${dl.op.startsWith('>') ? '+' : ''}`.replace(/\s+/g, ' '));
    const al = cond(b, 'AreaLevel').filter((c) => num(c) !== undefined);
    for (const c of al) post.push(c.op.startsWith('>') ? `area level ${num(c)}+` : `area level up to ${num(c)}`);
  }
  const head = [...pre, subj].join(' ');
  const text = [head, ...(nums.length > 1 ? nums : []), ...post].join(', ');
  return text[0]!.toUpperCase() + text.slice(1);
}
