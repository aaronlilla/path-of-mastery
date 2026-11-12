import type { ResultStore } from '../../shared/assistant/refs.js';

/** Tool results kept for the layouts to read numbers from. Each gets a ref id the model can cite. */
export class ResultLog {
  private n = 0;
  private readonly prefix = Date.now().toString(36).slice(-3);
  private store: ResultStore = {};
  private listeners: Array<(id: string, tool: string, data: unknown) => void> = [];

  onAdd(l: (id: string, tool: string, data: unknown) => void): void {
    this.listeners.push(l);
  }

  /** Stores a result and returns its ref. A result too big to keep gets a ref that resolves to nothing. */
  add(tool: string, data: unknown): string {
    const id = `r${this.prefix}${++this.n}`;
    let size = 0;
    try {
      size = JSON.stringify(data).length;
    } catch {
      size = Infinity;
    }
    if (size <= 60_000) {
      this.store[id] = { tool, data };
      const keys = Object.keys(this.store);
      if (keys.length > 400) delete this.store[keys[0]!];
      for (const l of this.listeners) l(id, tool, data);
    }
    return id;
  }

  get(id: string) {
    return this.store[id];
  }

  /** Runs `fn` on the data of every kept result that passes the test (a change that grew after it was made: the stored numbers follow it). */
  patch(test: (tool: string, data: unknown) => boolean, fn: (data: Record<string, unknown>) => void): void {
    for (const hit of Object.values(this.store)) if (test(hit.tool, hit.data) && hit.data && typeof hit.data === 'object') fn(hit.data as Record<string, unknown>);
  }

  /** The newest kept result that passes the test, with its ref. */
  latest(test: (tool: string, data: unknown) => boolean): { id: string; data: unknown } | undefined {
    const keys = Object.keys(this.store);
    for (let i = keys.length - 1; i >= 0; i--) {
      const hit = this.store[keys[i]!]!;
      if (test(hit.tool, hit.data)) return { id: keys[i]!, data: hit.data };
    }
    return undefined;
  }
}

/**
 * The fatal audit findings the answer must carry word for word, as placeholders into the newest audit: the applied change's
 * buildAudit when the turn changed the build, else the build summary's. A finding the answer already cites is left out.
 * The app adds these itself (the model summed per-resist numbers up as "your resistances come from config").
 */
/** One short phrase, no number, for a finding folded into the closing "Also noticed" line of a narrow answer: the details stay on the cards and notes the app shows. */
export function findingNote(f: { id?: string; kind?: string; line?: string }): string {
  const line = f.line ?? '';
  const un = /unreserved (mana|life)/i.exec(line);
  if (un || f.id === 'manaUnreserved' || f.id === 'lifeUnreserved') return `unreserved ${un ? un[1]!.toLowerCase() : f.id === 'lifeUnreserved' ? 'life' : 'mana'} is negative`;
  if (/enough Accuracy/i.test(line)) return 'accuracy is short for Precise Technique';
  if (f.kind === 'conditionalDefence') return 'a timed buff is counted as always up in effective HP';
  if (/^emptySlot:/.test(f.id ?? '')) return 'a slot is empty';
  if (/custom/i.test(f.id ?? '') || /custom modifier/i.test(line)) return 'a custom modifier carries some of your resistances';
  if (/resist/i.test(line)) return 'a resistance is under its cap';
  if (/requirement/i.test(line)) return 'a gem needs more attributes than you have';
  return 'another fix is ready';
}

export function fatalFindingRefs(results: ResultLog, text: string, cards: string[] = [], skip: (id: string | undefined) => boolean = () => false): { changed: boolean; refs: string[]; notes: string[]; hints: string[]; tree: boolean } {
  type A = { findings?: Array<{ id?: string; kind?: string; fatal?: boolean; line?: string; shown?: string; names?: string[]; sourceLine?: string }> };
  // a finding whose every gem the answer or one of this turn's cards names is already covered (the model's own
  // card lowered Wither, Faster Casting and Increased Area of Effect, and the app added the same finding again)
  const said = [text, ...cards].join('\n');
  const hit = results.latest((tool, d) => {
    const r = d as { buildChanged?: boolean; buildAudit?: A; audit?: A } | null;
    return !!r && ((r.buildChanged === true && !!r.buildAudit?.findings) || (tool === 'getBuildSummary' && !!r.audit?.findings));
  });
  if (!hit) return { changed: false, refs: [], notes: [], hints: [], tree: !!results.latest((_t, d) => !!(d as { treeOutdated?: unknown } | null)?.treeOutdated) };
  const r = hit.data as { buildChanged?: boolean; buildAudit?: A; audit?: A };
  const changed = r.buildChanged === true && !!r.buildAudit;
  const key = changed ? 'buildAudit' : 'audit';
  const notes: string[] = [];
  const hints: string[] = [];
  const refs = (r[key]!.findings ?? []).flatMap((f, i) => {
    // after a change, defence a Vaal skill, guard or triggered buff gives is said without it too (EHP 216k counted Vaal Molten Shell as always up)
    if (!(f.fatal || (changed && f.kind === 'conditionalDefence')) || !f.line) return [];
    if (skip(f.id)) return [];
    const cited = [i, f.id].some((k) => k !== undefined && (text.includes(`findings[${k}].line`) || text.includes(`findings[${k}].shown`)))
      || (!!f.names?.length && f.names.every((n) => said.includes(n)))
      // the answer already gives the way to that accuracy and its gain (the free route line): the finding would say the same numbers again
      || (/Accuracy/i.test(f.line) && text.includes(':free.shown'));
    // a line too long to read whole (the requirement finding quotes gem tooltips) goes in as its shown sentence
    const leaf = f.line.length <= 1000 ? 'line' : 'shown';
    if (!cited) notes.push(findingNote(f));
    if (f.sourceLine && !said.includes(f.sourceLine.slice(0, 20))) hints.push(`{{${hit.id}:${key}.findings[${i}].sourceLine}}`);
    return cited ? [] : [`{{${hit.id}:${key}.findings[${i}].${leaf}}}.`];
  });
  // the tree is behind the game's latest: one more thing noticed, said in one short phrase
  const tree = !!results.latest((_t, d) => !!(d as { treeOutdated?: unknown } | null)?.treeOutdated);
  if (tree) notes.unshift('the tree is out of date (Convert above the tree)');
  // a summary read after the change is the latest, but the turn still changed the build: it stays a done-work answer (451 words)
  const turnChanged = changed || !!results.latest((_t, d) => (d as { buildChanged?: boolean } | null)?.buildChanged === true);
  return { changed: turnChanged, refs, notes: [...new Set(notes)], hints, tree };
}

/**
 * The findings the app adds under an answer. A narrow question (a fact, a source, a farming tip: no change made, no advice asked)
 * gets one short closing line instead of the findings' text, so the answer is not padded with problems it did not ask about.
 */
export function findingsTail(refs: string[], opts: { changed: boolean; advice: boolean; configOnly?: boolean; notes?: string[]; tree?: boolean }): string[] {
  // a done change is its headline, what was done, the cost and one caveat: the findings it did not cause fold into one line too
  // (every finding in full made 200-400 word answers); advice with no change keeps them, they are the answer
  // the tree being old is the app's line on every answer: the model no longer writes its own sentence for it
  if (opts.advice && !opts.changed) return [...refs, ...(opts.tree ? ['Also noticed: the tree is out of date (Convert above the tree).'] : [])];
  if (!refs.length) return opts.tree ? ['Also noticed: the tree is out of date (Convert above the tree).'] : [];
  return [opts.notes?.length ? `Also noticed: ${opts.notes.join(', ')}.` : 'Also: the build has other fixes ready; ask what to fix next.'];
}

/** The mana-sustain sentence is written once by the app (its Check line): the model's own quotes of it are taken out of the body. */
export function dropSustainEcho(text: string): string {
  const echo = String.raw`\{\{\w+:[^}]*ManaSustain[^}]*\}\}\.?`;
  return text
    // the lead-in clause of the echoed sentence goes with it ("Your mana sustain gets worse: ...")
    .replace(new RegExp(String.raw`(?:^|(?<=[.!?] ))[^.!?\n{]*:[ \t]*${echo}[ \t]*`, 'gm'), '')
    .replace(new RegExp(`${echo}[ \\t]*`, 'g'), '')
    // a label left alone on its line ("Mana:") goes too
    .replace(/^(?!Check:)[A-Za-z ,]{1,30}:[ \t]*$/gm, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/(^|\n)[ \t]+/g, '$1');
}

/** A change made of one item, gem or config edit (no tree points): a narrow ask, whose unrelated findings fold into one closing line. */
export function isNarrowChange(kinds: string[]): boolean {
  return kinds.length > 0 && kinds.length <= 6 && kinds.every((k) => /^(setItem|setItemText|setSlotItem|setGem|removeGem|addGem|setGemSkill|setGroup|setConfig|setConfigs)$/.test(k));
}

/** A change made only of config settings: it does not bring back the findings the player did not ask about. */
export function isConfigOnly(kinds: string[]): boolean {
  return kinds.length > 0 && kinds.every((k) => /^setConfig/.test(k));
}

/**
 * Every `changes[STAT].before|after|change` the answer quotes for a stat of the applied change reads the applied change's own
 * table (`appliedRef`), so the text never shows a number from an earlier preview next to a table that says another (life
 * 3,259 in the text, 3,093 in the card).
 */
export function rewriteToApplied(text: string, appliedRef: string, stats: string[]): string {
  const set = new Set(stats);
  return text.replace(/\{\{(\w+):changes\[([^\]]+)\]\.(before|after|change)\}\}/g, (m, ref: string, stat: string, k: string) => (ref !== appliedRef && set.has(stat) ? `{{${appliedRef}:changes[${stat}].${k}}}` : m));
}

/**
 * Questions to the player (sentences ending in "?") taken out of the answer, so the app can put them last, after the
 * findings it writes ("Which level is your character in game?" sat between the reply and three findings).
 */
export function questionsLast(text: string): { text: string; questions: string[] } {
  // a sentence starts the text, a line or after ". "; dots inside numbers and {{ref:a.b}} placeholders stay in it
  const q = /(?<=^|[.!?] |\n)(?:[^\n.!?]|[.!?](?!\s|$))*\?(?=\s|$)/g;
  const questions = text.match(q) ?? [];
  if (!questions.length) return { text, questions: [] };
  return { text: text.replace(q, '').replace(/ {2,}/g, ' ').replace(/ +(?=\n|$)/g, '').trim(), questions };
}

/** Live trade listings and upgrade candidates, from the Wealth service (the player's own cookie; proposals only). */
export interface TradeListingOut {
  name: string;
  base: string;
  rarity: string;
  ilvl: number | null;
  mods: string[];
  asked: string;
  chaos: number | null;
  divine: number | null;
  ageMinutes: number | null;
  online: boolean;
}
export interface TradeSource {
  search(q: { name?: string; type?: string; category?: string; mods?: { text: string; min?: number }[]; limit?: number }): Promise<
    | { ok: true; total: number; at: number; cached: boolean; chaosPerDivine: number; listings: TradeListingOut[]; unmatchedMods: string[]; link: string }
    | { ok: false; kind: string; message: string; retryAfterSec?: number }
  >;
  upgrades(q: { buildXml: string; buildKey: string; name: string; slot: string; rank: 'dps' | 'ehp' }): Promise<
    | {
        ok: true;
        slot: string;
        equipped: string;
        rankStat: string;
        rankNow: number | null;
        total: number;
        checked: number;
        rule: string;
        /** The trade site's link to the search behind the candidates. */
        link: string;
        chaosPerDivine: number;
        candidates: Array<TradeListingOut & { gain: { stat: string; before: number; after: number; percent: number | null } | null; ehpGain: { before: number; after: number } | null; others: { stat: string; before: number; after: number }[]; held: string | null; scorePerDivine: number | null; itemText: string }>;
      }
    | { ok: false; kind: string; message: string }
  >;
}

/** Where the assistant gets prices: the Wealth price book (poe.ninja). */
export interface PriceLineOut {
  name: string;
  variant?: string;
  chaos: number;
  listings?: number;
  type: string;
}
export interface PriceSource {
  lookup(names: string[]): Promise<{ source: string; fetchedAt: number | null; chaosPerDivine: number; lines: PriceLineOut[][]; message?: string }>;
}
