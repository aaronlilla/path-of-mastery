import type { Block, Condition, LabelStyle } from './types.js';
import { blockStyle } from './blocks.js';
import { mergeStyle } from './generate.js';
import { RARITIES } from './syntax.js';

/** What the filter engine knows about a dropped item. Fields we do not know stay undefined. */
export interface ItemProps {
  /** Base type name, like "Divine Orb" or "Stygian Vise". */
  name: string;
  /** Item class, like "Stackable Currency" or "Body Armours". */
  class?: string;
  rarity?: (typeof RARITIES)[number];
  itemLevel?: number;
  dropLevel?: number;
  areaLevel?: number;
  stackSize?: number;
  quality?: number;
  linkedSockets?: number;
  /** Socket colours, like "RGB". Its length is the socket count. */
  sockets?: string;
  mapTier?: number;
  gemLevel?: number;
  corrupted?: boolean;
  identified?: boolean;
  mirrored?: boolean;
  influences?: string[];
  /** A drop is none of these unless it says so: the checks below read a missing flag as false. */
  fractured?: boolean;
  synthesised?: boolean;
  replica?: boolean;
  explicitMods?: string[];
  height?: number;
  width?: number;
}

export interface EvalStep {
  block: Block;
  result: 'match' | 'miss' | 'unknown';
  /** The first condition that failed or could not be checked. */
  failed?: Condition;
  /** For a miss on a condition we could not check. */
  note?: string;
}

export interface EvalResult {
  visible: boolean;
  /** The block that decided visibility (the first matching block without Continue, or the last matching). */
  decided: Block | null;
  /** Every block that matched, in order (Continue blocks included). */
  matched: Block[];
  steps: EvalStep[];
  /** Combined look: later matching blocks override fields set by earlier Continue blocks. */
  style: LabelStyle;
  /** True when a block was skipped because it tests something this item description does not give. */
  uncertain: boolean;
}

const RARITY_ORDER: Record<string, number> = { Normal: 0, Magic: 1, Rare: 2, Unique: 3 };

type Tri = true | false | null;

function cmp(op: string, a: number, b: number): boolean {
  switch (op) {
    case '':
    case '=':
    case '==':
      return a === b;
    case '!':
    case '!=':
      return a !== b;
    case '<':
      return a < b;
    case '>':
      return a > b;
    case '<=':
      return a <= b;
    case '>=':
      return a >= b;
  }
  return false;
}

/**
 * Condition values in lower case, worked out once per value list. Building the Loot Filter's item catalog runs every item
 * through every block, and lower-casing each needle on every check was most of its 260 ms. Value lists are never changed
 * in place (edits make new conditions), so the cache follows the array.
 */
const LOWER = new WeakMap<string[], string[]>();
function lowered(values: string[]): string[] {
  let l = LOWER.get(values);
  if (!l) {
    l = values.map((v) => v.toLowerCase());
    LOWER.set(values, l);
  }
  return l;
}

function str(op: string, hay: string, needles: string[]): boolean {
  const h = hay.toLowerCase();
  const xs = lowered(needles);
  let hit = false;
  if (op === '==') {
    for (const x of xs) if (h === x) { hit = true; break; }
  } else {
    for (const x of xs) if (h.includes(x)) { hit = true; break; }
  }
  return op === '!' || op === '!=' ? !hit : hit;
}

function numeric(c: Condition, v: number | undefined): Tri {
  if (v === undefined) return null;
  const n = Number(c.values[0]);
  return Number.isFinite(n) ? cmp(c.op, v, n) : false;
}

function bool(c: Condition, v: boolean | undefined): Tri {
  if (v === undefined) return null;
  const want = /^true$/i.test(c.values[0] ?? '');
  return c.op === '!' || c.op === '!=' ? v !== want : v === want;
}

/** Checks one condition. null means the item description does not say enough. */
export function checkCondition(c: Condition, item: ItemProps, areaLevel?: number): Tri {
  switch (c.key) {
    case 'BaseType':
      return str(c.op, item.name, c.values);
    case 'Class':
      return item.class === undefined ? null : str(c.op, item.class, c.values);
    case 'Rarity': {
      if (!item.rarity) return null;
      const r = RARITY_ORDER[item.rarity]!;
      if (c.op === '' || c.op === '=' || c.op === '==') return c.values.some((v) => RARITY_ORDER[v] === r);
      if (c.op === '!' || c.op === '!=') return !c.values.some((v) => RARITY_ORDER[v] === r);
      const lim = RARITY_ORDER[c.values[0] ?? ''];
      return lim === undefined ? false : cmp(c.op, r, lim);
    }
    case 'ItemLevel':
      return numeric(c, item.itemLevel);
    case 'DropLevel':
      return numeric(c, item.dropLevel);
    case 'AreaLevel':
      return numeric(c, areaLevel ?? item.areaLevel);
    case 'StackSize':
      return numeric(c, item.stackSize);
    case 'Quality':
      return numeric(c, item.quality);
    case 'LinkedSockets':
      return numeric(c, item.linkedSockets);
    case 'MapTier':
      return numeric(c, item.mapTier);
    case 'GemLevel':
      return numeric(c, item.gemLevel);
    case 'Height':
      return numeric(c, item.height);
    case 'Width':
      return numeric(c, item.width);
    case 'Corrupted':
      return bool(c, item.corrupted);
    case 'Identified':
      return bool(c, item.identified);
    case 'Mirrored':
      return bool(c, item.mirrored);
    case 'Sockets': {
      if (item.sockets === undefined) return null;
      const m = /^(\d*)([RGBADW]*)$/.exec(c.values[0] ?? '');
      if (!m) return false;
      const n = m[1] ? Number(m[1]) : 0;
      const colours = m[2] ?? '';
      const have = item.sockets.length;
      const countOk = m[1] ? cmp(c.op, have, n) : true;
      const colourOk = [...colours].every((ch) => item.sockets!.split(ch).length - 1 >= colours.split(ch).length - 1);
      return countOk && colourOk;
    }
    case 'FracturedItem':
      return bool(c, item.fractured ?? false);
    case 'SynthesisedItem':
      return bool(c, item.synthesised ?? false);
    case 'Replica':
      return bool(c, item.replica ?? false);
    case 'HasInfluence': {
      const infl = item.influences ?? [];
      if (c.values.includes('None')) return infl.length === 0;
      return c.values.some((v) => infl.includes(v));
    }
    case 'HasExplicitMod': {
      if (!item.explicitMods) return null;
      const first = c.values[0] ?? '';
      const m = /^(<=|>=|==|!=|=|<|>|!)?(\d+)$/.exec(first);
      const op = c.op || (m ? m[1] ?? '>=' : '>=');
      const count = c.op ? Number(first) : m ? Number(m[2]) : 1;
      const names = c.op || m ? c.values.slice(1) : c.values;
      const have = names.filter((n) => item.explicitMods!.some((x) => x.toLowerCase().includes(n.toLowerCase()))).length;
      return cmp(op === '' ? '>=' : op, have, Number.isFinite(count) ? count : 1);
    }
    default:
      return null;
  }
}

/** One condition worked out ahead for repeated checks: the same answers as `checkCondition`. */
type Pred = (item: ItemProps, lname: string, lclass: string | undefined, areaLevel: number | undefined) => Tri;
const NUMERIC: Record<string, (i: ItemProps, a: number | undefined) => number | undefined> = {
  ItemLevel: (i) => i.itemLevel,
  DropLevel: (i) => i.dropLevel,
  AreaLevel: (i, a) => a ?? i.areaLevel,
  StackSize: (i) => i.stackSize,
  Quality: (i) => i.quality,
  LinkedSockets: (i) => i.linkedSockets,
  MapTier: (i) => i.mapTier,
  GemLevel: (i) => i.gemLevel,
  Height: (i) => i.height,
  Width: (i) => i.width,
};
const BOOL: Record<string, (i: ItemProps) => boolean | undefined> = {
  Corrupted: (i) => i.corrupted,
  Identified: (i) => i.identified,
  Mirrored: (i) => i.mirrored,
};
function lowerHit(op: string, h: string, xs: string[]): boolean {
  let hit = false;
  if (op === '==') {
    for (const x of xs) if (h === x) { hit = true; break; }
  } else {
    for (const x of xs) if (h.includes(x)) { hit = true; break; }
  }
  return op === '!' || op === '!=' ? !hit : hit;
}
function compile(c: Condition): Pred {
  const op = c.op;
  if (c.key === 'BaseType') {
    const xs = lowered(c.values);
    return (_i, lname) => lowerHit(op, lname, xs);
  }
  if (c.key === 'Class') {
    const xs = lowered(c.values);
    return (_i, _n, lclass) => (lclass === undefined ? null : lowerHit(op, lclass, xs));
  }
  const num = NUMERIC[c.key];
  if (num) {
    const n = Number(c.values[0]);
    const finite = Number.isFinite(n);
    return (i, _n, _c, a) => {
      const v = num(i, a);
      if (v === undefined) return null;
      return finite ? cmp(op, v, n) : false;
    };
  }
  const bo = BOOL[c.key];
  if (bo) {
    const want = /^true$/i.test(c.values[0] ?? '');
    const neg = op === '!' || op === '!=';
    return (i) => {
      const v = bo(i);
      if (v === undefined) return null;
      return neg ? v !== want : v === want;
    };
  }
  return (i, _n, _c, a) => checkCondition(c, i, a);
}
/**
 * Each block's conditions, worked out once. Running every catalog item through every block (the guided home screen does
 * it after each change, 2,157 items by 754 blocks) re-parsed the same numbers and patterns millions of times. Blocks are
 * never changed after parsing; the length check covers a block that gains conditions while it is being parsed.
 */
/** Per block list: each block as it was compiled, and its conditions. A slot is redone when its block or its length differs. */
const COMPILED = new WeakMap<Block[], { blocks: Block[]; preds: Pred[][] }>();
function compiledFor(blocks: Block[]): { blocks: Block[]; preds: Pred[][] } {
  let c = COMPILED.get(blocks);
  if (!c) COMPILED.set(blocks, (c = { blocks: [], preds: [] }));
  return c;
}

/**
 * Runs an item through filter blocks the way the game does: blocks are tried in order, the first match decides
 * unless it says Continue, in which case later matches override the fields they set.
 */
export function evaluateItem(blocks: Block[], item: ItemProps, opts: { areaLevel?: number; /** false: leave `steps` empty, for callers that never read it. */ steps?: boolean } = {}): EvalResult {
  const keepSteps = opts.steps !== false;
  // The step list is written out when something reads it: most callers never do, and making ~750 step objects per item
  // was most of the time to run every catalog item through the filter. What is kept here is the same record, unboxed.
  const stepsBlocks: Block[] = [];
  const stepsResult: EvalStep['result'][] = [];
  const stepsFailed: (Condition | undefined)[] = [];
  const matched: Block[] = [];
  let style: LabelStyle = {};
  let decided: Block | null = null;
  let uncertain = false;
  const area = opts.areaLevel;
  const lname = item.name.toLowerCase();
  const lclass = item.class === undefined ? undefined : item.class.toLowerCase();
  const comp = compiledFor(blocks);
  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi]!;
    let result: EvalStep['result'] = 'match';
    let failed: Condition | undefined;
    let preds = comp.preds[bi];
    if (comp.blocks[bi] !== b || !preds || preds.length !== b.conditions.length) {
      preds = b.conditions.map(compile);
      comp.blocks[bi] = b;
      comp.preds[bi] = preds;
    }
    for (let k = 0; k < preds.length; k++) {
      const t = preds[k]!(item, lname, lclass, area);
      if (t === true) continue;
      failed = b.conditions[k];
      if (t === null) {
        result = 'unknown';
        uncertain = true;
      } else result = 'miss';
      break;
    }
    if (keepSteps) {
      stepsBlocks.push(b);
      stepsResult.push(result);
      stepsFailed.push(failed);
    }
    if (result !== 'match') continue;
    matched.push(b);
    if (b.kind !== 'Hide') style = mergeStyle(style, blockStyle(b));
    decided = b;
    if (!b.continue) break;
  }
  const visible = decided ? decided.kind !== 'Hide' && decided.kind !== 'Minimal' : true;
  const out = { visible, decided, matched, style, uncertain } as EvalResult;
  let steps: EvalStep[] | null = null;
  Object.defineProperty(out, 'steps', {
    enumerable: true,
    configurable: true,
    get() {
      if (!steps) steps = stepsBlocks.map((block, k) => (stepsFailed[k] ? { block, result: stepsResult[k]!, failed: stepsFailed[k] } : { block, result: stepsResult[k]! }));
      return steps;
    },
    set(v: EvalStep[]) {
      steps = v;
    },
  });
  return out;
}
