import { z } from 'zod';
import type { SolveGoal, SolveWealth } from '@pom/protocol';
import { evidenceFor, standing, type PackLike } from '../../shared/assistant/solveQuestions.js';
import { loadPatterns } from './buildPatterns.js';
import { gemCatalog } from './gemFit.js';
import { keptAll, keptFor, type KeptBuild } from './skeletons.js';
import { ToolError, type ToolDef } from './tools.js';

/**
 * keptBuilds (PLAN.md slice 5c): what the app ships for a skill before anything is searched or researched. The kept builds (whole builds proven on our engine, with what they reach
 * against the ask), the gem versions and ascendancies real characters play, and where the ask sits among them. A skill with no kept build gets the nearest kept build of the same
 * kind, marked as another skill: a reference for its auras, defence and flasks. It is never a start, because the solver treats a build of another skill as a blank start.
 */

const TIERS = ['league-start', 'mid-league', 'rich', 'mirror'];
const TIER_WORDS: Record<string, string> = { 'league-start': 'league start', 'mid-league': 'mid league', rich: 'rich', mirror: 'mirror' };
const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${Math.round(n / 1e3)}k`);
const pct = (have: number, ask: number) => Math.round((have / ask) * 100);
const baseOf = (name: string) => name.replace(/^Vaal /, '').replace(/ of .*$/, '').toLowerCase();

/** How much two gems' tag lists overlap (shared over all), 0 to 1. Tags like Attack, Projectile, Chaos, Duration tell the build kind. */
export function tagOverlap(a: string[], b: string[]): number {
  const x = new Set(a.map((t) => t.toLowerCase())), y = new Set(b.map((t) => t.toLowerCase()));
  const both = [...x].filter((t) => y.has(t)).length;
  return both / (x.size + y.size - both || 1);
}

export interface KeptAsk { skill: string; wealth?: SolveWealth; level?: number; dps?: number; ehp?: number }

/** The tool's answer. Pure: the pack, the kept list, the gem tags and the start lookup come in, so a test feeds small ones. */
export function keptAnswer(ask: KeptAsk, pack: PackLike, kept: KeptBuild[], tags: (gem: string) => string[] | null, startOf: (a: KeptAsk) => string | null) {
  const typed = ask.skill.trim().toLowerCase();
  const same = kept.filter((s) => s.skill.toLowerCase() === typed);
  const sameBase = kept.filter((s) => s.skill.toLowerCase() !== typed && baseOf(s.skill) === baseOf(ask.skill));
  const row = (s: KeptBuild) => {
    const vs = [ask.dps ? `DPS ${pct(s.dps, ask.dps)}% of the ask` : '', ask.ehp ? `EHP ${pct(s.ehp, ask.ehp)}% of the ask` : ''].filter(Boolean).join(', ');
    return {
      id: s.id, gem: s.skill, class: s.className, ascendancy: s.ascendancy, tier: s.tier, level: s.level, gearDivines: s.gearDivines,
      dps: s.dps, ehp: s.ehp,
      ...(s.ladderNote ? { realCharacters: s.ladderNote } : {}),
      line: `${s.skill}, ${s.ascendancy}, ${TIER_WORDS[s.tier] ?? s.tier}, level ${s.level}, ${s.gearDivines} divine of gear: ${k(s.dps)} DPS and ${k(s.ehp)} EHP on our engine${vs ? ` (${vs})` : ''}.`,
    };
  };
  const order = (a: KeptBuild, b: KeptBuild) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier);
  const ev = evidenceFor(pack, ask.skill);
  const sits = ev?.sits && (ask.dps || ask.ehp)
    ? [ask.dps ? { target: 'DPS', where: standing(ask.dps, ev.sits.dps) } : null, ask.ehp ? { target: 'EHP', where: standing(ask.ehp, ev.sits.ehp) } : null].filter((x) => x && x.where)
    : [];
  const ref = same[0] ?? sameBase[0];
  const nearest = ref ? [] : kept.map((s) => ({ s, t: tagOverlap(tags(ask.skill) ?? [], tags(s.skill) ?? []) })).filter((x) => x.t >= 0.5).sort((a, b) => b.t - a.t).slice(0, 2).map((x) => ({ ...row(x.s), otherSkill: true, sameKind: Math.round(x.t * 100) + '% of its tags' }));
  const startsFrom = startOf(ask);
  return {
    skill: ask.skill,
    source: 'Kept builds shipped with the app: hand-checked whole builds, scored on our engine (the Solve\'s own DPS and EHP). Not a live listing.',
    keptBuilds: same.sort(order).map(row),
    runStartsFrom: startsFrom,
    ...(!startsFrom && same.length ? { whyNot: 'No kept build fits this tier and level exactly (tier, and level from the kept one up to 5 above): the Run starts blank or from the open build.' } : {}),
    ...(sameBase.length ? { otherGemVersions: sameBase.sort(order).map(row), versionNote: 'A different version of the gem. The player picks it with one tap in the Solve form; never switch it for them.' } : {}),
    ...(nearest.length ? { nearestOtherSkill: nearest, nearestNote: 'No kept build for this skill. These are the nearest kept builds of the same kind (another skill): look at their auras, defence layers and flask plans. The Run does not start from them.' } : {}),
    ...(ev ? { realCharacters: { league: pack.league, ...(ev.ascendancies ? { ascendancies: ev.ascendancies.slice(0, 4) } : {}), ...(ev.versions ? { gemVersions: ev.versions } : {}), ...(ev.sits ? { builds: ev.sits.builds } : {}) }, ...(sits.length ? { askSits: sits, askSitsNote: 'Among all real characters of this skill in the pack (not a budget band, and their numbers can read low: default config). Information only: it never changes the target.' } : {}) } : {}),
    ...(!ref && !nearest.length ? { none: 'No kept build and no near kind for this skill: research it as the prompt says, then plan.' } : {}),
  };
}

export const KEPT_TOOLS: ToolDef[] = [
  {
    name: 'keptBuilds',
    chip: 'Look up kept builds',
    description:
      "What the app already holds for a main skill, before any web research: the kept builds (a whole proven build per exact gem, ascendancy and budget tier, with what it reaches on our engine against the player's ask and, where known, how far real characters of it get), which one the Run starts from, the other gem versions real players use, the ascendancies they play, and where the ask sits among real characters. A skill with no kept build gets the nearest kept build of the same kind, marked as another skill. Pass the skill as typed, the wealth tier when the player named one, the level and the DPS and EHP asked. Numbers come back in lines you can quote; they are our engine's, scored on a fixed setup.",
    shape: {
      skill: z.string().min(1).max(80),
      wealth: z.enum(['league-start', 'mid-league', 'rich', 'mirror']).optional(),
      level: z.number().int().min(1).max(100).optional(),
      dps: z.number().positive().optional(),
      ehp: z.number().positive().optional(),
    },
    async run(args, ctx) {
      const ask = args as unknown as KeptAsk;
      let pack: PackLike;
      try {
        pack = loadPatterns();
      } catch (e) {
        throw new ToolError(e instanceof Error ? e.message : String(e));
      }
      const catalog = (await gemCatalog(ctx).catch(() => ({ gems: [] }))).gems;
      const tagsOf = (name: string) => catalog.find((g) => g.name.toLowerCase() === name.trim().toLowerCase())?.tags ?? null;
      return keptAnswer(ask, pack, keptAll(), tagsOf, (a) => keptFor({ skill: a.skill, ...(a.wealth ? { wealth: a.wealth } : {}), ...(a.level ? { level: a.level } : {}) } as SolveGoal)?.id ?? null);
    },
  },
];

/** The prompt line that comes with the tool. */
export const KEPT_PROMPT_RULE =
  "- keptBuilds comes before any web research on a new-build ask: call it with the skill, and the wealth, level, DPS and EHP the player named. When it returns a kept build for the skill, the Run starts from it: do no web research and no realBuilds, and say in your first answer, in two lines, which kept build the Run starts from and what it reaches on our engine against the ask (quote its line), then where the ask sits (askSits, and realCharacters when it is given). Never promise more than the kept build reaches: when its EHP or DPS is under the ask, say so plainly. When it lists another gem version, name it as the one-tap choice in the form. When it returns only a nearest build of another skill, say it is another skill's build used as a reference, then research as below. When it returns none, research as below.";
