import type { TabName } from '../../shared/assistant/blocks.js';
import type { JevDecide } from './jev.js';

/** What the player's message turns into when the app can answer it without Claude. */
export interface InstantReply {
  text: string;
  nav?: TabName;
  openSolve?: boolean;
}

export interface RouterDeps {
  decide: JevDecide;
  /** Runs one of the assistant's read tools on the open build. */
  lookup: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
  openSolve: () => void;
}

export const MIN_CONFIDENCE = 0.8;
export const JEV_RACE_MS = 250;

const OPTIONS: Record<string, string> = {
  stat: 'Asks for the value of a stat of the open build (life, resistances, DPS, armour, crit chance...).',
  budget: 'Asks how many passive or ascendancy points are used, left or available.',
  setting: 'Asks where a setting or configuration option is, or what it is set to.',
  gem: 'Asks what a skill gem or support gem is (its colour, tags, level requirement).',
  unique: 'Asks which unique item has a given modifier or what a named unique item is.',
  'go-tree': 'Asks to open or show the passive tree tab.',
  'go-skills': 'Asks to open or show the skills tab.',
  'go-items': 'Asks to open or show the items tab.',
  'go-calcs': 'Asks to open or show the calculations tab.',
  'go-config': 'Asks to open or show the configuration tab.',
  'go-notes': 'Asks to open or show the notes tab.',
  'go-solve': 'Asks only to open the build solver form, with no goal and no numbers given.',
  claude: 'Anything else: advice, comparison, explanation, planning, a change to the build (adding, removing, swapping, setting anything), a request to make, find or optimise a build for a stated goal (a skill, level, damage or defence numbers, making it tankier), or a question that needs reasoning.',
};
const ASK = 'What does the player want? Pick claude when unsure; a change to the build is always claude.';

const STOP = new Set('what whats is are the a an my me i do does of in on to for how many much where can you show open tell about it its this that which have has with and or please find go set'.split(' '));
export const keywords = (t: string) => t.toLowerCase().replace(/[^a-z0-9' -]/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));

type Rec = Record<string, unknown>;
const arr = (v: unknown): Rec[] => (Array.isArray(v) ? (v as Rec[]) : []);

async function stat(text: string, d: RouterDeps): Promise<string | null> {
  // The stat list is the player's own. A question about minions, spectres or totems needs Claude: "my minions' life" is not Life.
  if (MINION_QUESTION.test(text) || /\b(spirits?|guardian)\b/i.test(text)) return null;
  const t = text.toLowerCase();
  const idRe = (r: Rec) => new RegExp(`\\b${String(r.id).toLowerCase()}\\b`);
  const head = arr(((await d.lookup('getStats', {})) as Rec).stats);
  let rows = head.filter((r) => t.includes(String(r.label).toLowerCase()) || idRe(r).test(t));
  if (rows.length) {
    // "life regen" names Life only as part of another stat: a word left over after the matched labels goes to Claude
    let rest = t;
    for (const r of rows) rest = rest.replace(String(r.label).toLowerCase(), ' ').replace(idRe(r), ' ');
    if (keywords(rest).length) return null;
  } else {
    // a search hit counts only when its label holds every word asked ("movement speed" is not "Attack rate")
    const ws = keywords(text);
    for (const w of ws) {
      rows = arr(((await d.lookup('getStats', { search: w })) as Rec).stats).filter((r) => ws.every((x) => `${r.label} ${r.id}`.toLowerCase().includes(x)));
      if (rows.length) break;
    }
    if (rows.length > 4) rows = [];
  }
  return rows.length ? rows.map((r) => `${r.label}: ${r.shown}`).join('\n') : null;
}

async function budget(d: RouterDeps): Promise<string | null> {
  const b = (await d.lookup('getPointBudget', {})) as { passive: Rec; ascendancy: Rec };
  return `Passive points: ${b.passive.used} of ${b.passive.available} used, ${b.passive.left} left.\nAscendancy points: ${b.ascendancy.used} of ${b.ascendancy.available} used, ${b.ascendancy.left} left.`;
}

async function setting(text: string, d: RouterDeps): Promise<string | null> {
  const ws = keywords(text).filter((w) => !['setting', 'settings', 'option', 'options', 'configuration', 'config', 'tab'].includes(w));
  if (!ws.length) return null;
  const rows = arr(((await d.lookup('getConfigOptions', { search: ws.join(' ') })) as Rec).options).slice(0, 3);
  return rows.length ? rows.map((r) => `${r.label}: Configuration tab, ${r.section} section. Now ${r.value === null || r.value === '' ? 'not set' : r.value}${r.changed ? '' : ' (default)'}.`).join('\n') : null;
}

async function gem(text: string, d: RouterDeps): Promise<string | null> {
  const ws = keywords(text).filter((w) => !['gem', 'gems', 'skill', 'support'].includes(w));
  if (!ws.length) return null;
  const rows = arr(((await d.lookup('searchGems', { query: ws.join(' '), limit: 3 })) as Rec).gems);
  return rows.length ? rows.map((g) => `${g.name}: ${g.support ? 'support' : 'skill'} gem, ${g.colour}, ${(g.tags as string[]).join(', ')}. Needs character level ${(g.requires as Rec).levelAtGemLevel1} at gem level 1.`).join('\n') : null;
}

async function unique(text: string, d: RouterDeps): Promise<string | null> {
  const ws = keywords(text).filter((w) => !['unique', 'uniques', 'item', 'items'].includes(w));
  if (!ws.length) return null;
  const rows = arr(((await d.lookup('searchUniques', { query: ws.join(' '), limit: 3, withText: false })) as Rec).uniques);
  return rows.length ? rows.map((u) => `${u.name} (${u.base}): ${(u.matching as string[]).slice(0, 2).join('; ')}`).join('\n') : null;
}

const NAV: Record<string, TabName> = { 'go-tree': 'tree', 'go-skills': 'skills', 'go-items': 'items', 'go-calcs': 'calcs', 'go-config': 'config', 'go-notes': 'notes' };

/** Numbers that make a goal: a level, or a DPS / EHP / life target ("1m dps", "1 million dps", "20k life"). */
export const GOAL_IN_WORDS = /\b(level|lvl)\s*\d{1,3}\b|\b\d+(?:\.\d+)?\s*(?:[kKmM]|million|thousand|billion|mil)?\s*(?:dps|damage|ehp|hp|life|es)\b/i;

/** A minion, spectre or totem has numbers of its own: the player's sheet cannot answer a stat question about it, so Claude gets it. */
export const MINION_QUESTION = /\b(minions?|spectres?|zombies?|skeletons?|golems?|raging spirits?|totems?)\b/i;

/** Null means: send it to Claude as usual. Never throws. */
export async function routeMessage(text: string, d: RouterDeps): Promise<InstantReply | null> {
  try {
    // The backend call waits up to 15 s (aiGate/client.ts); a slow Jev must not hold the message, so after JEV_RACE_MS it goes the normal way.
    let timer: NodeJS.Timeout | undefined;
    const answers = await Promise.race([
      d.decide(`Player message in a Path of Exile build planner:\n${text.slice(0, 1000)}`, {
        route: { type: 'choice', instructions: ASK, criteria: OPTIONS },
      }),
      new Promise<null>((r) => { timer = setTimeout(() => r(null), JEV_RACE_MS); }),
    ]).finally(() => clearTimeout(timer));
    const a = answers?.route;
    if (!a?.choice || a.choice === 'claude' || !((a.confidence ?? 0) >= MIN_CONFIDENCE)) return null;
    if (a.choice in NAV) return { text: `Opened the ${NAV[a.choice]} tab.`, nav: NAV[a.choice]! };
    if (a.choice === 'go-solve') {
      // "Make me a level 90 ... build with 1M DPS": a request that already carries the goal goes to Claude, which turns it into one with startSolve; only a bare "open the solver" is answered here.
      if (GOAL_IN_WORDS.test(text)) return null;
      d.openSolve();
      return { text: 'Opened the Solve panel. Set the goal there, or tell me the goal and I will fill it in.', openSolve: true };
    }
    const reply = a.choice === 'stat' ? await stat(text, d) : a.choice === 'budget' ? await budget(d) : a.choice === 'setting' ? await setting(text, d) : a.choice === 'gem' ? await gem(text, d) : a.choice === 'unique' ? await unique(text, d) : null;
    return reply ? { text: reply } : null;
  } catch {
    return null;
  }
}
