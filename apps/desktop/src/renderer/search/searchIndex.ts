// App-wide search for the palette (Ctrl K): ranked results across stats, configuration, items, gems, passives, tabs and
// commands, in the groups and order the design's search draws. The scoring follows the design's search-index.js: plain
// words are reduced to a base form (so "resists" finds Resistance), synonyms fold together, and a word that is one
// typo away still matches. The documents come from the open build, so every number shown is the build's own.

import { tr } from '../i18n';

export type DocKind = 'Area' | 'Build' | 'Option' | 'Stat' | 'Setting' | 'Item' | 'Gem' | 'Passive' | 'Tab' | 'Action';

export interface SearchDoc {
  kind: DocKind;
  title: string;
  /** The grey text at the right of the row: a value, a slot, a shortcut. */
  meta: string;
  /** Extra words that find this row but are not shown. */
  extra?: string;
  run: () => void;
}

export interface Seg {
  t: string;
  hl: boolean;
}

export interface Hit {
  doc: SearchDoc;
  segs: Seg[];
}

export interface Group {
  kind: DocKind;
  items: Hit[];
}

export interface Locked {
  id: string;
  title: string;
  where: string;
}

export interface SearchOut {
  groups: Group[];
  flat: Hit[];
  suggestion: string;
  /** A plain-language topic the question touches, whose full answer needs the assistant. */
  locked: Locked | null;
}

export const GROUP_HEAD: Record<DocKind, string> = {
  Area: tr('h_search_searchIndex.g_areas'),
  Build: tr('h_search_searchIndex.g_builds'),
  Option: tr('h_search_searchIndex.g_settings'),
  Stat: tr('h_search_searchIndex.g_stats'),
  Setting: tr('h_search_searchIndex.g_config'),
  Item: tr('h_search_searchIndex.g_items'),
  Gem: tr('h_search_searchIndex.g_gems'),
  Passive: tr('h_search_searchIndex.g_tree'),
  Tab: tr('h_search_searchIndex.g_tabs'),
  Action: tr('h_search_searchIndex.g_actions'),
};

export const GROUP_GLYPH: Record<DocKind, { g: string; c: string }> = {
  Area: { g: 'A', c: 'var(--text-2)' },
  Build: { g: 'B', c: 'var(--gold-text)' },
  Option: { g: 'O', c: 'var(--text-3)' },
  Stat: { g: 'S', c: 'var(--gold-text)' },
  Setting: { g: 'C', c: 'var(--stat-speed)' },
  Item: { g: 'I', c: 'var(--rarity-unique)' },
  Gem: { g: 'G', c: 'var(--gem-str-hi)' },
  Passive: { g: 'P', c: '#9fc79f' },
  Tab: { g: 'T', c: 'var(--text-3)' },
  Action: { g: '›', c: 'var(--text-3)' },
};

/** The words the empty search offers. */
export const BASIC_SUGGESTIONS = ['freeze', 'resistance', 'cyclone', 'bandit', 'flask', 'life', 'configuration'];

const STOP = new Set(
  'i im my me am is are was the a an of to on in at for do does did have has how much many what whats which where show tell give can could should would about with and or any all current currently much there their its it this that please find get see check'.split(' '),
);

const SYN: Record<string, string[]> = {
  avoid: ['avoid', 'avoidance', 'avoidances', 'avoiding', 'avoids', 'prevent', 'prevention'],
  ailment: ['ailment', 'ailments', 'status', 'debuff', 'debuffs', 'dot'],
  immune: ['immune', 'immunity', 'immunities', 'cannot', 'cant'],
  freeze: ['freeze', 'frozen', 'freezes', 'freezing'],
  chill: ['chill', 'chilled', 'chills'],
  shock: ['shock', 'shocked', 'shocks'],
  ignite: ['ignite', 'ignited', 'ignites', 'burning', 'burn'],
  bleed: ['bleed', 'bleeding', 'bleeds', 'corrupted'],
  poison: ['poison', 'poisoned', 'poisons'],
  scorch: ['scorch', 'scorched'],
  brittle: ['brittle'],
  sap: ['sap', 'sapped'],
  stun: ['stun', 'stunned', 'stuns'],
  res: ['res', 'resist', 'resists', 'resistance', 'resistances', 'resistence', 'resi'],
  cap: ['cap', 'capped', 'overcap', 'overcapped', 'max', 'maximum', 'maxed'],
  ele: ['ele', 'elemental'],
  fire: ['fire'],
  cold: ['cold'],
  lightning: ['lightning', 'light', 'lite'],
  chaos: ['chaos'],
  phys: ['phys', 'physical'],
  life: ['life', 'hp', 'health'],
  es: ['es', 'energy', 'shield'],
  mana: ['mana'],
  armour: ['armour', 'armor', 'ar'],
  evasion: ['evasion', 'evade', 'eva', 'ev'],
  block: ['block', 'blocking'],
  suppress: ['suppress', 'suppression', 'suppressed'],
  dodge: ['dodge'],
  crit: ['crit', 'crits', 'critical'],
  multi: ['multi', 'multiplier'],
  dps: ['dps', 'damage', 'dmg', 'output', 'clear'],
  hit: ['hit', 'hits'],
  speed: ['speed', 'aspd', 'fast', 'faster'],
  attack: ['attack', 'attacks'],
  move: ['move', 'movement', 'movespeed', 'ms', 'run'],
  ehp: ['ehp', 'tanky', 'tankiness', 'survivability', 'defence', 'defences', 'defense', 'defenses', 'defensive'],
  regen: ['regen', 'regeneration', 'recovery', 'sustain'],
  leech: ['leech', 'leeching'],
  charge: ['charge', 'charges'],
  frenzy: ['frenzy'],
  endurance: ['endurance'],
  power: ['power'],
  bandit: ['bandit', 'bandits', 'alira', 'kraityn', 'oak'],
  pantheon: ['pantheon', 'god', 'gods', 'major', 'minor'],
  gem: ['gem', 'gems', 'support', 'supports', 'link', 'links', 'skill', 'skills'],
  item: ['item', 'items', 'gear', 'equipment', 'equipped'],
  tree: ['tree', 'passive', 'passives', 'node', 'nodes', 'notable', 'notables', 'keystone'],
  flask: ['flask', 'flasks', 'pot', 'pots'],
  jewel: ['jewel', 'jewels'],
  weak: ['weak', 'weakness', 'weaknesses', 'problem', 'problems', 'hole', 'holes', 'missing', 'lacking', 'improve'],
  theme: ['theme', 'themes', 'appearance', 'colour', 'color', 'dark', 'light'],
  boss: ['boss', 'bosses', 'uber', 'pinnacle'],
  big: ['big', 'biggest', 'largest', 'huge', 'maxhit', 'onehit', 'oneshot', 'survive', 'take'],
  curse: ['curse', 'curses', 'hex'],
};
const CANON: Record<string, string> = {};
for (const k of Object.keys(SYN)) for (const w of SYN[k]!) if (!CANON[w]) CANON[w] = k;

const stem = (w: string) => (w.length > 5 && w.endsWith('ies') ? w.slice(0, -3) + 'y' : w.length > 4 && w.endsWith('es') ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);
const canon = (w: string) => CANON[w] ?? CANON[stem(w)] ?? stem(w);
const words = (s: string) => (s || '').toLowerCase().replace(/[’']/g, '').split(/[^a-z0-9%+.]+/).filter(Boolean);
const qtoks = (s: string) => {
  const out: string[] = [];
  for (const w of words(s)) {
    if (STOP.has(w)) continue;
    const c = canon(w);
    if (!out.includes(c)) out.push(c);
  }
  return out;
};
const btok = (s: string) => [...new Set(words(s).filter((w) => !STOP.has(w)).map(stem))];

function lev(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const m = a.length;
  const n = b.length;
  let p = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const c = [i];
    for (let j = 1; j <= n; j++) c[j] = Math.min(p[j]! + 1, c[j - 1]! + 1, p[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    p = c;
  }
  return p[n]!;
}

/** Topics a plain-language question can touch. The full answer is the assistant's; here they only name the topic. */
const CONCEPTS: Array<{ id: string; title: string; where: string; triggers: string[][] }> = [
  { id: 'ail', title: tr('h_search_searchIndex.t_ail'), where: tr('h_search_searchIndex.w_ail'), triggers: [['ailment'], ['avoid'], ['immune'], ['freeze'], ['chill'], ['shock'], ['ignite'], ['bleed'], ['poison'], ['scorch'], ['brittle'], ['sap'], ['stun']] },
  { id: 'res', title: tr('h_search_searchIndex.t_res'), where: tr('h_search_searchIndex.w_res'), triggers: [['res'], ['cap'], ['fire'], ['cold'], ['lightning'], ['chaos'], ['ele']] },
  { id: 'maxhit', title: tr('h_search_searchIndex.t_maxhit'), where: tr('h_search_searchIndex.w_maxhit'), triggers: [['cap', 'hit'], ['big', 'hit'], ['big'], ['hit', 'phys'], ['ehp'], ['boss', 'hit']] },
  { id: 'dmg', title: tr('h_search_searchIndex.t_dmg'), where: tr('h_search_searchIndex.w_dmg'), triggers: [['dps'], ['crit'], ['hit'], ['attack', 'speed'], ['speed']] },
  { id: 'pools', title: tr('h_search_searchIndex.t_pools'), where: tr('h_search_searchIndex.w_pools'), triggers: [['life'], ['mana'], ['es'], ['regen'], ['leech']] },
  { id: 'mitig', title: tr('h_search_searchIndex.t_mitig'), where: tr('h_search_searchIndex.w_mitig'), triggers: [['armour'], ['evasion'], ['block'], ['suppress'], ['ehp'], ['dodge']] },
  { id: 'weak', title: tr('h_search_searchIndex.t_weak'), where: tr('h_search_searchIndex.w_mitig'), triggers: [['weak']] },
  { id: 'move', title: tr('h_search_searchIndex.t_move'), where: tr('h_search_searchIndex.w_move'), triggers: [['move']] },
  { id: 'charges', title: tr('h_search_searchIndex.t_charges'), where: tr('h_search_searchIndex.w_charges'), triggers: [['charge'], ['frenzy'], ['endurance'], ['power', 'charge']] },
];

function conceptScore(q: string[], c: (typeof CONCEPTS)[number]): number {
  let best = 0;
  for (const tr of c.triggers) {
    const n = tr.filter((t) => q.includes(t)).length;
    if (n === tr.length) best = Math.max(best, tr.length * 2 + (tr.length === q.length ? 1 : 0));
  }
  return best;
}

interface Indexed {
  d: SearchDoc;
  tk: string[];
  tt: string[];
}

let lastDocs: SearchDoc[] | null = null;
let lastIndex: Indexed[] = [];
/** The documents' words, worked out once per document list (the list changes when the build does, not per keystroke). */
function index(docs: SearchDoc[]): Indexed[] {
  if (docs !== lastDocs) {
    lastDocs = docs;
    lastIndex = docs.map((d) => ({ d, tk: btok(d.title + ' ' + (d.extra ?? '')), tt: btok(d.title) }));
  }
  return lastIndex;
}

function scoreDoc(q: string[], x: Indexed): number {
  let s = 0;
  let hit = 0;
  for (const t of q) {
    let best = 0;
    for (const w of x.tk) {
      if (w === t) best = Math.max(best, x.tt.includes(w) ? 3 : 2);
      else if (t.length >= 2 && w.startsWith(t)) best = Math.max(best, 1.6);
      else if (t.length >= 4 && lev(t, w) <= 1) best = Math.max(best, 1.1);
    }
    if (best) hit++;
    s += best;
  }
  if (!hit) return 0;
  return (s / q.length) * (hit === q.length ? 1.5 : hit / q.length);
}

function highlight(title: string, q: string[]): Seg[] {
  return title.split(/(\s+)/).map((w) => {
    const c0 = w.toLowerCase().replace(/[^a-z0-9]/g, '');
    const c = stem(c0);
    return { t: w, hl: !!c && q.some((t) => c === t || (t.length >= 2 && c.startsWith(t))) };
  });
}

const ORDER: DocKind[] = ['Area', 'Build', 'Option', 'Stat', 'Setting', 'Item', 'Gem', 'Passive', 'Tab', 'Action'];

/** A question's words in the base form the search folds to (what a topic's row keys are written in). */
export const stemWords = (raw: string): string[] => qtoks(raw);

export function search(raw: string, docs: SearchDoc[]): SearchOut {
  const q = btok(raw);
  if (!q.length) return { groups: [], flat: [], suggestion: '', locked: null };
  const qs = qtoks(raw);
  let concept: (typeof CONCEPTS)[number] | null = null;
  let cs = 0;
  for (const c of CONCEPTS) {
    const s = conceptScore(qs, c);
    if (s > cs) {
      cs = s;
      concept = c;
    }
  }
  const all = index(docs)
    .map((x) => ({ x, s: scoreDoc(q, x) }))
    .filter((r) => r.s >= 0.7)
    .sort((a, b) => b.s - a.s);
  // The 18 best overall, plus each kind's best 2, so "life" also shows its gems, items and passives, not only stats and settings.
  const keep = new Set(all.slice(0, 18));
  for (const k of ORDER) for (const r of all.filter((r) => r.x.d.kind === k).slice(0, 2)) keep.add(r);
  const scored = all.filter((r) => keep.has(r));
  const groups: Group[] = [];
  for (const k of ORDER) {
    const items = scored.filter((r) => r.x.d.kind === k).slice(0, 5).map((r) => ({ doc: r.x.d, segs: highlight(r.x.d.title, q) }));
    if (items.length) groups.push({ kind: k, items });
  }
  groups.sort((a, b) => scored.findIndex((r) => r.x.d.kind === a.kind) - scored.findIndex((r) => r.x.d.kind === b.kind));
  let suggestion = '';
  if (!groups.length) {
    const vocab = [...new Set([...Object.keys(CANON), ...docs.flatMap((d) => words(d.title))])].filter((w) => w.length > 3);
    const alt = words(raw)
      .map((w) => {
        if (w.length < 4) return w;
        let best = w;
        let bd = 3;
        for (const v of vocab) {
          const d = lev(w, v);
          // Only a word that is really close counts: one letter off up to 6 letters, two off beyond that.
          if (d < bd && d <= (Math.max(w.length, v.length) > 6 ? 2 : 1)) {
            bd = d;
            best = v;
          }
        }
        return best;
      })
      .join(' ');
    if (alt !== raw.toLowerCase().trim()) suggestion = alt;
  }
  return { groups, flat: groups.flatMap((g) => g.items), suggestion, locked: concept ? { id: concept.id, title: concept.title, where: concept.where } : null };
}
