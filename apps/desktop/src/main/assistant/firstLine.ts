// The first line of an open-ended advice answer ("what should I upgrade next?"), written by the app from the facts it already
// read, so the player reads something true within a second while the model works. It names the first thing a player would fix.

/** True for a question that asks what to do next, not for a number or a fact. */
export const wantsAdvice = (text: string): boolean => /\b(what (should|do) i|what'?s next|next|upgrade|improve|fix|weakest|better)\b/i.test(text) && !/\b(max hit|how does|how do|what is|explain)\b/i.test(text) && !/^\s*(replace|swap|set|take|put|make|create|find|pick|path|equip|allocate|spend|add|remove|use)\b/i.test(text);

/** A "which X gives the most Y" ask: ranked on damage too, so a selected skill that is not all the damage is said first. */
export const wantsRanking = (text: string): boolean => /\b(most|best|which|highest|strongest)\b/i.test(text);

export interface FirstLineFacts {
  warnings: string[];
  passivePointsLeft: number;
  emptySlots?: string[];
  /** The audit's which-skill finding: the selected skill and the other skills that deal damage (Righteous Fire beside Fire Trap). */
  damageSkills?: { selected: string; others: string[] };
}

/** One plain sentence, or null when the facts hold nothing worth saying first. */
export function firstLine(f: FirstLineFacts, rankingOnly = false): string | null {
  const d = f.damageSkills;
  if (d?.others.length) return `Your damage numbers count only ${d.selected}, the selected skill, but ${d.others.join(' and ')} also deal${d.others.length === 1 ? 's' : ''} damage, so I am counting them together.`;
  if (rankingOnly) return null;
  const w = f.warnings.find((x) => /unreserved (mana|life)/i.test(x));
  if (w) return `${/life/i.test(w) ? 'Your auras reserve more life than you have' : 'Your auras reserve more mana than you have'}: fixing that first.`;
  const req = f.warnings.find((x) => /requirement|enough (strength|dexterity|intelligence|accuracy)/i.test(x));
  if (req) return `${req.replace(/\.$/, '')}: checking the cheapest fix first.`;
  // no digits: the final answer keeps this line, and a typed number in it would be drawn as a dash
  if (f.passivePointsLeft > 0) return 'You have unspent passive points: finding where they pay most.';
  if (f.emptySlots?.length) return `Your ${f.emptySlots[0]} slot is empty: checking what fits it.`;
  if (f.warnings.length) return `${f.warnings[0]!.replace(/\.$/, '')}: looking at that first.`;
  return null;
}

/**
 * Whether the question is about the empty slot itself: it names the slot, or says empty, unfilled or fill. Any other question
 * gets the free fill as a card of its own, never inside the change that was asked (Soul Talons, for one).
 */
export const asksForSlotFill = (text: string, slots: string[]): boolean =>
  /\b(empty|unfilled|fill|nothing (in|equipped)|gems? (do not|don'?t|doesn'?t|not) work)/i.test(text) || slots.some((s) => s.length > 2 && new RegExp(`\\b${s.replace(/[^a-z0-9 ]/gi, '')}\\b`, 'i').test(text));

const FIX_NAMES: Array<[RegExp, string]> = [[/mana/, 'mana'], [/pantheon/, 'pantheon'], [/route|craft/, 'accuracy'], [/^buy/, 'ring'], [/resist/, 'resistances'], [/requirement/, 'gem levels']];

/** What the app's own free change touches, by name (no number): the plan's use ids as words, for `Fix mana, pantheon` titles and the line shown the moment the plan is known. */
export function fixNames(ids: string[]): string[] {
  // ids that carry their subject say it in words (fix:quality:Boneshatter -> Boneshatter quality), never the raw id
  return [...new Set(ids.map((id) => { const q = /quality:(.+)$/.exec(id); const f = /flaskImmunity:(\w+)/.exec(id); const c = /count:(.+)$/.exec(id); return q ? `${q[1]} quality` : f ? `${f[1]} immunity flask` : c ? `${c[1]} count` : FIX_NAMES.find(([re]) => re.test(id))?.[1] ?? id.replace(/^(\w+:)+/, ''); }))];
}

/** The line shown as soon as the plan is known, before the buys are searched. */
export function freeFixLine(ids: string[]): string | null {
  const names = fixNames(ids).filter((n) => !/\d/.test(n));
  // never "free": a fix can be bought (Enlighten, Gemcutter's Prisms); its price is said with it
  return names.length ? `Fixes first, going in now: ${names.join(', ')}.` : null;
}

/** "Replace/swap the weakest support ... with the best one": one swap the app can make itself before the model starts. */
export const wantsSupportSwap = (text: string): boolean => /^\s*(replace|swap)\b[^.?]*\bweakest support\b/i.test(text) && !/\b(only if|if|whether|or tell|would|could|should)\b|worth/i.test(text);

/** What the ask is about, for the app's own swap: the skill it names (longest gem name in the text), and whether it asks for something other than damage (then the model ranks it). */
export function swapAsk(text: string, gemNames: string[]): { skill?: string; notDamage: boolean } {
  const q = text.toLowerCase();
  const skill = gemNames.filter((n) => n.length > 3 && q.includes(n.toLowerCase())).sort((a, b) => b.length - a.length)[0];
  return { ...(skill ? { skill } : {}), notDamage: /\b(ehp|effective hp|surviv\w*|life|defen[cs]\w*|tank\w*|armou?r|evasion|energy shield|es|mana|block|resist\w*|max(imum)? hit|toughness)\b/i.test(text) };
}

/** Why the app must not make the ranked swap itself (null: safe): a gem that costs currency, an unknown or short attribute requirement, a recolour, a lost buff, or less defence is the player's call. */
/** The ranking's socket-fitting alternative reshaped like the top pick, for when the top pick is skipped only for a recolour (null: none). */
export function fitSwapAlt(sw: Record<string, any>): Record<string, any> | null {
  const f = sw.socketColours?.bestWithoutRecolour;
  if (!f?.edits?.length || f.replaceGem === undefined) return null;
  return { ...sw, replace: { name: f.replace, gem: f.replaceGem }, with: { ...sw.with, name: f.with, price: f.price }, stat: f.stat, requirement: f.requirement, side: f.side, losesBuff: f.losesBuff, socketColours: undefined, edits: f.edits };
}

export function swapSkip(sw: { stat?: { percent?: number | null }; with?: { price?: unknown }; requirement?: unknown; losesBuff?: unknown; socketColours?: unknown; side?: Array<{ stat: string; label: string; percent: number | null }> }): string | null {
  if (!((sw.stat?.percent ?? 0) > 0)) return 'no swap gains';
  if (sw.with?.price) return 'the new gem costs currency';
  if (!sw.requirement) return 'its attribute requirement could not be checked';
  if (/ short\)/.test(String(sw.requirement))) return 'the new gem would be short of attributes';
  if (sw.losesBuff) return 'it loses a buff';
  if (sw.socketColours) return 'it needs a socket recolour';
  const lost = (sw.side ?? []).find((r) => ['TotalEHP', 'Life', 'EnergyShield'].includes(r.stat) && (r.percent ?? 0) < -0.5);
  return lost ? `it costs ${lost.label}` : null;
}

/** The app's first line once the swap is in: names it, and takes its numbers from the ranking result `ref` (a typed number would be refused). */
export const swapLine = (ref: string, r: { replace: { name: string }; with: { name: string }; skill: string | null; stat: { label: string } }, at = 'stat'): string =>
  `Swapped ${r.replace.name} for ${r.with.name} on ${r.skill ?? 'the main skill'}: ${r.stat.label} {{${ref}:${at}.beforeShown}} -> {{${ref}:${at}.afterShown}} (+{{${ref}:${at}.percent}}%).`;

/**
 * The app's line for a stronger swap held because it takes out the build's only source of a buff (Fortify's Fortification), or
 * null when there is none or it gains no more than the swap made (the answer called a weaker card "next-strongest", no reason).
 */
export function heldBuffLine(ref: string, ub: { replace?: string; with?: string; stat?: { label?: string; percent?: number | null }; loses?: string | null; edits?: unknown[] } | undefined, gained: number): string | null {
  if (!ub?.edits?.length || !ub.loses || !ub.stat?.label || !((ub.stat.percent ?? 0) > gained)) return null;
  // the reason in words: the full loses text runs past the 200 characters a ref may print, and the line was dropped
  const buff = /only source of ([^:]+)/.exec(ub.loses)?.[1];
  const why = buff ? `${ub.replace} is your only source of ${buff}` : 'it costs too much effective HP';
  // a swap that gains much more but drops the only source of a defence layer is the first card with its cost, never applied
  // without a tap
  return `Strongest swap, on a card for you to tap: ${ub.with} in place of ${ub.replace}, ${ub.stat.label} +{{${ref}:unguardedBest.stat.percent}}%, but ${why}, so it is not applied.`;
}

/**
 * The recolour pick's own line: which stat, from what to what (the build before any swap, not on top of the swap just made
 * read "+56.4%" while the card showed +23%), and its price or where to get it.
 */
export function recolourLine(ref: string, top: { with?: { name?: string; price?: string }; replace?: { name?: string }; stat?: { label?: string } }): string | null {
  if (!top.with?.name || !top.replace?.name || !top.stat?.label) return null;
  const price = top.with.price ? `Price: {{${ref}:with.price}}.` : 'No poe.ninja price: buy it from another player on the trade site.';
  return `On a card: ${top.with.name} in place of ${top.replace.name}, which needs a socket recolour: ${top.stat.label} {{${ref}:stat.before}} to {{${ref}:stat.after}} (+{{${ref}:stat.percent}}%), measured from your build before any swap; the card shows its gain on top of the swap just made. ${price}`;
}
