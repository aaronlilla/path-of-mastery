import type { ItemProps } from '../../../../shared/lootfilter/evaluate.js';
import type { BaseInfo } from '../../../../shared/lootfilter/bases.js';

/** An item as the player sees it: what to draw, and what the filter engine is told. */
export interface SimItem {
  key: string;
  /** The name drawn on the label (the unique's or rare's own name when it has one). */
  display: string;
  /** The base type line, when the item has a name of its own. */
  base?: string;
  props: ItemProps;
  /** True for items the player pasted or built. */
  mine?: boolean;
}

const INFLUENCES = ['Shaper', 'Elder', 'Crusader', 'Redeemer', 'Hunter', 'Warlord', 'Searing Exarch', 'Eater of Worlds'];

function num(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const m = /-?\d+/.exec(s.replace(/,/g, ''));
  return m ? Number(m[0]) : undefined;
}

/** Longest base type name from the engine's table that appears in an item name (for magic items like "Sturdy Vaal Axe of Haste"). */
function findBase(name: string, bases: BaseInfo[] | undefined): BaseInfo | undefined {
  if (!bases?.length) return undefined;
  const exact = bases.find((b) => b.name === name);
  if (exact) return exact;
  let best: BaseInfo | undefined;
  for (const b of bases) if (name.includes(b.name) && (!best || b.name.length > best.name.length)) best = b;
  return best;
}

/**
 * Reads the text the game copies with Ctrl C. Fields the text does not give stay undefined, so the filter engine
 * reports "cannot tell" for a rule that tests them instead of guessing.
 */
export function parseItemText(text: string, bases?: BaseInfo[]): SimItem | null {
  const clean = text.replace(/\r/g, '').trim();
  if (!clean) return null;
  const sections = clean.split(/^-{4,}\s*$/m).map((s) => s.split('\n').map((l) => l.trim()).filter(Boolean));
  const head = sections[0] ?? [];
  let cls: string | undefined;
  let rarityText: string | undefined;
  const names: string[] = [];
  for (const l of head) {
    const m = /^([A-Za-z ]+):\s*(.*)$/.exec(l);
    if (m && /^item class$/i.test(m[1]!)) cls = m[2]!.trim();
    else if (m && /^rarity$/i.test(m[1]!)) rarityText = m[2]!.trim();
    else names.push(l);
  }
  if (!rarityText || !names.length) return null;

  const props: ItemProps = { name: names[names.length - 1]! };
  const r = rarityText.toLowerCase();
  if (r === 'normal' || r === 'currency' || r === 'gem' || r === 'divination card' || r === 'quest item') props.rarity = 'Normal';
  else if (r === 'magic') props.rarity = 'Magic';
  else if (r === 'rare') props.rarity = 'Rare';
  else if (r === 'unique') props.rarity = 'Unique';

  let display = names[0]!;
  let base: string | undefined;
  if (names.length >= 2) {
    base = names[names.length - 1];
    props.name = base!;
  } else if (props.rarity === 'Magic') {
    const b = findBase(names[0]!, bases);
    props.name = b ? b.name : names[0]!;
    if (b) base = b.name;
  }
  const info = findBase(props.name, bases);
  if (cls) props.class = cls;
  else if (info) props.class = info.class;
  if (info) props.dropLevel = info.level;

  const body = sections.slice(1).flat();
  props.identified = true;
  props.corrupted = false;
  props.mirrored = false;
  const infl: string[] = [];
  for (const l of body) {
    let m: RegExpExecArray | null;
    if ((m = /^Item Level:\s*(.*)$/i.exec(l))) props.itemLevel = num(m[1]);
    else if ((m = /^Stack Size:\s*(.*)$/i.exec(l))) props.stackSize = num(m[1]);
    else if ((m = /^Quality:\s*(.*)$/i.exec(l))) props.quality = num(m[1]);
    else if ((m = /^Map Tier:\s*(.*)$/i.exec(l))) props.mapTier = num(m[1]);
    else if ((m = /^Level:\s*(.*)$/i.exec(l)) && props.class && /gem/i.test(props.class)) props.gemLevel = num(m[1]);
    else if ((m = /^Sockets:\s*(.*)$/i.exec(l))) {
      const groups = m[1]!.trim().split(/\s+/);
      props.sockets = groups.join('').replace(/[^RGBADW]/gi, '').toUpperCase();
      props.linkedSockets = Math.max(0, ...groups.map((g) => g.replace(/[^RGBADWrgbadw]/g, '').length));
    } else if (/^Corrupted$/i.test(l)) props.corrupted = true;
    else if (/^Unidentified$/i.test(l)) props.identified = false;
    else if (/^Mirrored$/i.test(l)) props.mirrored = true;
    else {
      const inf = INFLUENCES.find((i) => l.toLowerCase() === `${i.toLowerCase()} item`);
      if (inf) infl.push(inf);
    }
  }
  if (props.sockets === undefined) {
    // An item with no Sockets line has none (or is not socketable).
    props.sockets = '';
    props.linkedSockets = 0;
  }
  props.influences = infl;
  if (props.quality === undefined) props.quality = 0;
  return { key: 'paste-' + Date.now().toString(36), display, ...(base && base !== display ? { base } : {}), props, mine: true };
}

/** The item the builder form describes. */
export function buildItem(opts: { base: string; rarity: 'Normal' | 'Magic' | 'Rare' | 'Unique'; itemLevel: number; links: number }, bases?: BaseInfo[]): SimItem {
  const info = bases?.find((b) => b.name === opts.base);
  const n = Math.max(0, Math.min(6, Math.round(opts.links)));
  const props: ItemProps = {
    name: opts.base,
    rarity: opts.rarity,
    itemLevel: opts.itemLevel,
    identified: true,
    corrupted: false,
    mirrored: false,
    quality: 0,
    linkedSockets: n,
    stackSize: 1,
  };
  // Socket colours are not asked for, so a rule that tests them reports "cannot tell".
  if (n === 0) props.sockets = '';
  if (info) {
    props.class = info.class;
    props.dropLevel = info.level;
  }
  return { key: 'build-' + Date.now().toString(36), display: opts.base, props, mine: true };
}
