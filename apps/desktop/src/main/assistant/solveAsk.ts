import type { SolveGoal, SolveWealth } from '@pom/protocol';

// The wizard is asked every time; what the ask's own words state fills it in, never a guess.

/** Whole-build divine cap per tier, engine-data/wealth_tiers.json budgetDivines (mirror has none: only the word picks it). */
const TIER_CAP: Array<[SolveWealth, number]> = [['league-start', 4], ['mid-league', 10], ['rich', 150]];

export interface AskWords {
  wealth?: SolveWealth;
  playMode?: 'mapping' | 'bossing' | 'both';
}

/** The tier and the mode the message says out loud. A tier word beats a divine figure; a figure picks the richest tier it covers. */
export function askWords(text: string): AskWords {
  const t = text.toLowerCase();
  const out: AskWords = {};
  if (/\bmirror[- ]?(tier|budget|level|wealth|rich)\b/.test(t)) out.wealth = 'mirror';
  else if (/\brich\b|\bwealthy\b/.test(t)) out.wealth = 'rich';
  else if (/\bmid[- ]?league\b/.test(t)) out.wealth = 'mid-league';
  else if (/\bleague[- ]?start(er)?\b/.test(t)) out.wealth = 'league-start';
  else {
    const m = /(\d+(?:\.\d+)?)\s*(?:div|divs|divine|divines)\b/.exec(t);
    if (m) out.wealth = TIER_CAP.filter(([, cap]) => Number(m[1]) >= cap).pop()?.[0] ?? 'league-start';
  }
  // "maps, not bosses" names bosses to leave them out
  const asked = t.replace(/\b(not|no|without|never|except)\s+(?:for\s+|the\s+|any\s+)*(?:mapping|mappers?|maps|t1\d|bossers?|bossing|boss|bosses|pinnacle|uber)\b/g, ' ');
  const map = /\b(mapping|mapper|mappers|maps|t1\d)s?\b/.test(asked);
  const boss = /\b(bosser|bossers|bossing|boss|bosses|pinnacle|uber)\b/.test(asked);
  if (map && boss) out.playMode = 'both';
  else if (map) out.playMode = 'mapping';
  else if (boss) out.playMode = 'bossing';
  return out;
}

const BUILD = /\b(build|solve|solver|make me|create|new)\b/i;
const ITEM = /\b(ring|amulet|belt|helm|helmet|gloves|boots|body armou?r|chest|weapon|shield|quiver|jewel|flask|gem|node)\b/i;
const FIX = /\b(upgrade|better|worth|replace|swap|craft|buy|improve)\b/i;

/** False for a one-item or fix ask ("is this ring an upgrade", "fix my resists"): those never open the wizard. */
export function opensWizard(text: string): boolean {
  return BUILD.test(text) || !((ITEM.test(text) && FIX.test(text)) || /\bfix\b/i.test(text));
}

/** The goal with wealth and playMode taken from the ask's words only: a value the model picked on its own is dropped. */
export function prefillFromAsk(request: string, goal: SolveGoal): SolveGoal {
  const w = askWords(request);
  const { wealth: _w, ...rest } = goal;
  const { playMode: _p, ...assume } = goal.assume ?? {};
  return { ...rest, ...(w.wealth ? { wealth: w.wealth } : {}), ...(w.playMode ? { assume: { ...assume, playMode: w.playMode } } : Object.keys(assume).length ? { assume } : {}) };
}
