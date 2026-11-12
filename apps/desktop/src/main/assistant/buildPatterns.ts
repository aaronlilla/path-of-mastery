import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ToolError, type ToolDef } from './tools.js';

/**
 * buildPatterns: what real builds of the current league use, from the bundled, aggregated pack
 * (resources/buildpatterns/patterns.json, made by tools/build-corpus/corpus.mjs pack). Counts and shares only: the pack holds
 * no account or character names. A lead to test with diagnoseBuild and what-ifs, never proof.
 */

/** A group with fewer builds than this is not shown as a pattern. The pack keeps only the count for such groups. */
export const MIN_SAMPLE = 8;

interface Share { name: string; count: number; share: number }
interface Spread { p10: number | null; p50: number | null; p90: number | null; max: number | null }
interface Group {
  builds: number;
  ascendancies?: Share[]; supports?: Share[]; keystones?: Share[]; notables?: Share[]; uniques?: Share[]; auras?: Share[]; heralds?: Share[]; guards?: Share[];
  dps?: Spread; ehp?: Spread; life?: Spread; energyShield?: Spread;
}
export interface PatternsPack { note: string; league: string | null; collected: string[]; builds: number; supportCharacters?: { count: number; reasons: Record<string, number> }; overall?: Group; bySkill: Record<string, Group>; byTag: Record<string, Group> }

let cached: PatternsPack | undefined;

/** The shipped pack: next to the installed app's other resources, or resources/ above this file in a dev checkout. */
function packFile(): string | undefined {
  const rel = join('buildpatterns', 'patterns.json');
  const res = (process as unknown as { resourcesPath?: string }).resourcesPath;
  if (res && existsSync(join(res, rel))) return join(res, rel);
  let d = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 7; i++, d = dirname(d)) if (existsSync(join(d, 'resources', rel))) return join(d, 'resources', rel);
  return undefined;
}

export function loadPatterns(): PatternsPack {
  if (cached) return cached;
  const f = packFile();
  if (!f) throw new ToolError('The build patterns data is not part of this install.');
  return (cached = JSON.parse(readFileSync(f, 'utf8')) as PatternsPack);
}

const LISTS = ['ascendancies', 'supports', 'keystones', 'notables', 'uniques', 'auras', 'heralds', 'guards'] as const;
const top = (xs: Share[] | undefined, n: number) => (xs ?? []).slice(0, n).map((x) => ({ name: x.name, builds: x.count, share: x.share }));

/** One group as an answer: patterns when the sample is big enough, otherwise only the fact that it is not. */
function present(label: string, g: Group, topN: number) {
  if (g.builds < MIN_SAMPLE) {
    return { label, sampleSize: g.builds, tooSmall: true, note: `Only ${g.builds} real build(s) in the sample, fewer than ${MIN_SAMPLE}: too small to show a pattern. Do not infer one; say the sample is too small.` };
  }
  return {
    label, sampleSize: g.builds,
    ...Object.fromEntries(LISTS.map((k) => [k, top(g[k], topN)])),
    dps: g.dps, ehp: g.ehp, life: g.life, energyShield: g.energyShield,
  };
}

/** The tool's answer for a pack and arguments. Pure, so a test can feed a small pack. */
export function patternsAnswer(pack: PatternsPack, args: { skill?: string; tags?: string[]; top?: number }) {
  const topN = args.top ?? 8;
  const header = {
    league: pack.league, collected: pack.collected, totalBuildsInPack: pack.builds,
    ...(pack.supportCharacters?.count ? { supportCharactersExcluded: pack.supportCharacters.count, supportCharactersNote: `${pack.supportCharacters.count} more sampled characters (aura, curse, link or summon characters with no measurable damage) are left out of every pattern and DPS spread below. They exist; say so if asked, never mix them into damage builds.` } : {}),
    caveats: [
      'Characters were scored with default Config (no manual toggles such as Wither stacks or charges), so DPS and EHP can be understated.',
      'The sample is random across the whole league ladder, not the top ranks. Popularity is not strength.',
      pack.note,
    ],
    rule: 'A pattern is a lead to test with diagnoseBuild and what-ifs on the player\'s build, never proof. Say the sample size, league and date when you use it.',
  };
  const find = (rec: Record<string, Group>, name: string) => Object.entries(rec).find(([k]) => k.toLowerCase() === name.trim().toLowerCase());
  const answers: unknown[] = [];
  const unknown: string[] = [];
  if (args.skill) {
    const hit = find(pack.bySkill, args.skill);
    if (hit) answers.push(present(`main skill ${hit[0]}`, hit[1], topN));
    else unknown.push(`main skill "${args.skill}"`);
  }
  for (const t of args.tags ?? []) {
    const hit = find(pack.byTag, t);
    if (hit) answers.push(present(`skills tagged ${hit[0]}`, hit[1], topN));
    else unknown.push(`tag "${t}"`);
  }
  if (!args.skill && !args.tags?.length) {
    if (pack.overall) answers.push(present('all builds', pack.overall, topN));
  }
  const bigSkills = Object.entries(pack.bySkill).filter(([, g]) => g.builds >= MIN_SAMPLE).sort((a, b) => b[1].builds - a[1].builds).slice(0, 12).map(([name, g]) => ({ name, builds: g.builds }));
  return {
    ...header,
    results: answers,
    ...(unknown.length ? { notInSample: `No real build in the sample has ${unknown.join(' or ')}: say the sample has nothing on it.` } : {}),
    ...(answers.length === 0 || answers.some((a) => (a as { tooSmall?: boolean }).tooSmall) ? { skillsWithEnoughBuilds: bigSkills } : {}),
  };
}

export const PATTERN_TOOLS: ToolDef[] = [
  {
    name: 'buildPatterns',
    chip: 'See what real builds use',
    description:
      "What real builds of the current league use for a main skill or skill tags: ascendancies, supports, keystones, notables, uniques, auras, heralds and guards (with how many builds and what share use each), plus the spread of DPS, EHP, life and energy shield they reach. Anonymous aggregate of sampled public characters; no names. Every answer carries the sample size, league and collection date, and that the characters were scored with default Config so DPS can be understated. A group with too few builds comes back as too small: say so, never present a pattern from it. Patterns are leads to test with diagnoseBuild and previewEdit what-ifs on the player's build, never proof: popularity is not strength. skill is the exact main skill name; tags are skill tags such as Spell, Minion, Aura or Fire.",
    shape: {
      skill: z.string().min(1).max(80).optional(),
      tags: z.array(z.string().min(1).max(40)).max(4).optional(),
      top: z.number().int().min(1).max(15).optional(),
    },
    async run(args) {
      return patternsAnswer(loadPatterns(), args as { skill?: string; tags?: string[]; top?: number });
    },
  },
];

/** The prompt line that comes with the tool. */
export const PATTERNS_PROMPT_RULE =
  "- buildPatterns shows what real builds of this league use and reach. A pattern is a lead to test with diagnoseBuild and what-ifs on this player's build, never proof, and popularity is not strength: do not advise a support, unique or keystone because many builds have it. Always give the sample size, league and date it carries, and that the characters were scored with default Config so DPS can be understated. When it says the sample is too small, say that and show no pattern.";
