// Smart search answer cards: a plain question ("am I res capped?") that matches a topic gets one card whose rows are the
// open build's own numbers, read from the same documents the palette searches. A row whose number the build does not
// have is left out; a topic with no rows has no card, so a card never shows a made-up figure.
/** A key built from an id (the typed tr() only takes literal keys). */
const dyn = (k: string): string => (tr as unknown as (key: string) => string)('h_search_answers.' + k);
import { stemWords, type SearchDoc } from './searchIndex.js';
import { tr } from '../i18n';

export type Tone = 'ok' | 'part' | 'low' | 'none' | 'muted';

export interface AnswerRow {
  label: string;
  value: string;
  status: string;
  tone: Tone;
  /** Where the number comes from. */
  src: string;
  /** The row the question was about. */
  focus: boolean;
  doc: SearchDoc;
}

export interface Answer {
  id: string;
  title: string;
  summary: string;
  where: string;
  /** Opens the topic: the first row's own document. */
  open: () => void;
  rows: AnswerRow[];
}

type Kind = 'res' | 'pct' | 'plain';
interface Spec {
  label: string;
  match: RegExp;
  kind: Kind;
  keys: string;
  from?: 'Setting';
}

const AVOID: Spec[] = ['Freeze', 'Chill', 'Shock', 'Ignite', 'Bleed', 'Poison', 'Stun'].map((a) => ({ label: tr('h_search_answers.avoid', { ailment: dyn(`a_${a.toLowerCase()}`) }), match: new RegExp(`^${a}.*avoid`, 'i'), kind: 'pct' as const, keys: `${a.toLowerCase()} avoid ailment immune` }));
const RES: Spec[] = [
  { label: tr('h_search_answers.e_fire'), match: /^fire res/i, kind: 'res', keys: 'fire res ele cap' },
  { label: tr('h_search_answers.e_cold'), match: /^cold res/i, kind: 'res', keys: 'cold res ele cap' },
  { label: tr('h_search_answers.e_lightning'), match: /^lightning res/i, kind: 'res', keys: 'lightning res ele cap' },
  { label: tr('h_search_answers.e_chaos'), match: /^chaos res/i, kind: 'res', keys: 'chaos res cap' },
];
const SUPPRESS: Spec = { label: tr('h_search_answers.spell_supp'), match: /suppress/i, kind: 'pct', keys: 'suppress' };

const TOPICS: Record<string, { rows: Spec[]; src: string }> = {
  ail: { rows: AVOID, src: tr('h_search_answers.s_def') },
  res: { rows: RES, src: tr('h_search_answers.s_def') },
  maxhit: {
    rows: ['Physical', 'Fire', 'Cold', 'Lightning', 'Chaos'].map((t) => ({ label: tr('h_search_answers.max_hit', { element: dyn(`e_${t.toLowerCase()}`) }), match: new RegExp(`^${t}.*max.*hit`, 'i'), kind: 'plain' as const, keys: `${t.toLowerCase()} phys big hit cap ehp` })).concat([{ label: tr('h_search_answers.ehp'), match: /effective hit pool|^ehp/i, kind: 'plain', keys: 'ehp' }]),
    src: tr('h_search_answers.s_def'),
  },
  dmg: {
    rows: [
      { label: tr('h_search_answers.dps'), match: /^(combined|total) dps/i, kind: 'plain', keys: 'dps' },
      { label: tr('h_search_answers.avg_hit'), match: /^average hit/i, kind: 'plain', keys: 'hit dps' },
      { label: tr('h_search_answers.crit_chance'), match: /^crit chance/i, kind: 'plain', keys: 'crit' },
      { label: tr('h_search_answers.crit_multi'), match: /^crit multi/i, kind: 'plain', keys: 'crit multi' },
      { label: tr('h_search_answers.attack_rate'), match: /^(attack|cast) rate/i, kind: 'plain', keys: 'attack speed' },
    ],
    src: tr('h_search_answers.s_off'),
  },
  pools: {
    rows: [
      { label: tr('h_search_answers.life'), match: /^(total )?life$/i, kind: 'plain', keys: 'life' },
      { label: tr('h_search_answers.life_regen'), match: /^life regen/i, kind: 'plain', keys: 'regen life' },
      { label: tr('h_search_answers.es'), match: /^energy shield$/i, kind: 'plain', keys: 'es' },
      { label: tr('h_search_answers.mana'), match: /^(total )?mana$/i, kind: 'plain', keys: 'mana' },
      { label: tr('h_search_answers.mana_regen'), match: /^mana regen/i, kind: 'plain', keys: 'regen mana' },
    ],
    src: tr('h_search_answers.s_def'),
  },
  mitig: {
    rows: [
      { label: tr('h_search_answers.armour'), match: /^armour$/i, kind: 'plain', keys: 'armour' },
      { label: tr('h_search_answers.evasion'), match: /^evasion/i, kind: 'plain', keys: 'evasion' },
      { label: tr('h_search_answers.block'), match: /^(attack )?block chance/i, kind: 'pct', keys: 'block' },
      { label: tr('h_search_answers.spell_block'), match: /^spell block/i, kind: 'pct', keys: 'block' },
      SUPPRESS,
    ],
    src: tr('h_search_answers.s_def'),
  },
  weak: { rows: [...RES, ...AVOID, SUPPRESS], src: tr('h_search_answers.s_def') },
  move: { rows: [{ label: tr('h_search_answers.move_speed'), match: /^(effective )?move(ment)? speed/i, kind: 'plain', keys: 'move' }], src: tr('h_search_answers.s_misc') },
  charges: {
    rows: ['Frenzy', 'Endurance', 'Power'].map((c) => ({ label: dyn(`c_${c.toLowerCase()}`), match: new RegExp(`${c} charges`, 'i'), kind: 'plain' as const, keys: `${c.toLowerCase()} charge`, from: 'Setting' as const })),
    src: tr('h_search_answers.s_config'),
  },
};

const num = (s: string): number | null => {
  const m = /-?\d[\d,]*\.?\d*/.exec(s);
  return m ? Number(m[0].replace(/,/g, '')) : null;
};

/** The chip beside a number: only where the number has a clear good or bad reading. */
export function readNumber(kind: Kind, value: string): { status: string; tone: Tone } {
  const n = num(value);
  if (/immune/i.test(value)) return { status: tr('h_search_answers.st_immune'), tone: 'ok' };
  if (n === null || kind === 'plain') return { status: '', tone: 'muted' };
  // the sidebar's "(+N%)" is res over the build's own max, so it is capped whatever the max is; shortcut: with no suffix the default 75 is assumed (the max is not in the search rows)
  if (kind === 'res') return n >= 75 || /\(\+\d/.test(value) ? { status: tr('h_search_answers.st_capped'), tone: 'ok' } : { status: n < 0 ? tr('h_search_answers.st_negative') : tr('h_search_answers.st_below'), tone: 'low' };
  if (n >= 100) return { status: tr('h_search_answers.st_full'), tone: 'ok' };
  return n <= 0 ? { status: tr('h_search_answers.st_none'), tone: 'none' } : { status: tr('h_search_answers.st_partial'), tone: 'part' };
}

/** The card for a topic, or null when the build has none of its numbers. */
export function answerFor(id: string, title: string, where: string, raw: string, docs: SearchDoc[]): Answer | null {
  const topic = TOPICS[id];
  if (!topic) return null;
  const q = stemWords(raw);
  let rows: AnswerRow[] = [];
  const hits: number[] = [];
  for (const sp of topic.rows) {
    const doc = docs.find((d) => d.kind === (sp.from ?? 'Stat') && sp.match.test(d.title) && d.meta);
    if (!doc) continue;
    const { status, tone } = readNumber(sp.kind, doc.meta);
    rows.push({ label: sp.label, value: doc.meta, status, tone, src: topic.src, focus: false, doc });
    hits.push(sp.keys.split(' ').filter((k) => q.includes(k)).length);
  }
  // The rows the question names most closely go first and are marked.
  const best = Math.max(0, ...hits);
  rows.forEach((r, i) => (r.focus = best > 0 && hits[i] === best));
  if (id === 'weak') rows = rows.filter((r) => r.tone === 'low' || r.tone === 'none' || r.tone === 'part');
  if (!rows.length) return null;
  if (best > 0) rows.sort((a, b) => Number(b.focus) - Number(a.focus));
  const shown = rows.slice(0, 4).map((r) => `${r.label} ${r.value}`).join(', ');
  const summary = id === 'weak' ? tr('h_search_answers.gaps', { shown: shown }) : `${shown}.`;
  return { id, title, summary, where, open: rows[0]!.doc.run, rows };
}
