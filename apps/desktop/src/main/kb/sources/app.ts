import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { EntityRow, KbSource, Pulled, SourceCtx } from './types.js';
import { LEVELING_GUIDE } from '../../../shared/leagueContent.js';

/**
 * Data the app already ships, folded into the KB so every consumer reads one store:
 * - exile-leveling (MIT): gem quest and vendor offers, zones, routes, quest passives, leveling skill candidates;
 * - divination card rewards (poewiki snapshot used by the Build Filter);
 * - the engine data's unique items and boss tables.
 */

const EXILE_LEVELING = 'https://github.com/HeartofPhos/exile-leveling';
const DATA_SRC = 'https://github.com/PathOfBuildingCommunity/PathOfBuilding/tree/dev/src/Data';
const CLASS_LETTER: Record<string, string> = { M: 'Marauder', D: 'Duelist', R: 'Ranger', S: 'Shadow', W: 'Witch', T: 'Templar', X: 'Scion' };

async function readJson<T>(p: string): Promise<T> {
  return JSON.parse(await readFile(p, 'utf8')) as T;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Newest league folder in resources/leveling ("3.29"). */
async function newestLeague(dir: string): Promise<string | null> {
  try {
    const names = (await readdir(dir)).filter((n) => /^\d+\.\d+$/.test(n));
    names.sort((a, b) => {
      const [a1, a2] = a.split('.').map(Number) as [number, number];
      const [b1, b2] = b.split('.').map(Number) as [number, number];
      return b1 - a1 || b2 - a2;
    });
    return names[0] ?? null;
  } catch {
    return null;
  }
}

/** Unique text with variants: keep the current (last) variant's lines and drop the {tags:..} markup. */
export function currentUniqueText(raw: string): { name: string; base: string; text: string; variants: number } {
  const lines = raw.split('\n');
  const name = lines[0] ?? '';
  const base = lines[1] ?? '';
  const variants = lines.filter((l) => /^Variant: /.test(l)).length;
  const current = variants || 1;
  const out: string[] = [];
  for (const l of lines.slice(2)) {
    if (/^(Variant|Selected Variant|League|Source|Upgrade|Has Alt Variant|Implicits): /.test(l)) continue;
    const v = /\{variant:([\d,]+)\}/.exec(l);
    if (v && !v[1]!.split(',').map(Number).includes(current)) continue;
    out.push(l.replace(/\{[^}]*\}/g, '').trim());
  }
  return { name, base, text: out.filter(Boolean).join('\n'), variants };
}

type Offer = [kind: string, questId: string, act: number, npc: string, level: number, classes: string];
interface OffersFile { meta: unknown; startingGems: unknown; gems: Record<string, { n: string; s: number; c: string; o: Offer[]; t?: string[] }> }

export const appSource: KbSource = {
  id: 'app',
  type: 'community',
  async pull(ctx: SourceCtx): Promise<Pulled> {
    const now = new Date().toISOString();
    const entities: Pulled['entities'] = { quest_reward: [], gem: [], unique_item: [], boss: [], div_card: [] };
    const tables: NonNullable<Pulled['tables']> = {};
    const league = await newestLeague(ctx.app.levelingDir);
    const lvlUrl = EXILE_LEVELING;

    if (league) {
      const dir = join(ctx.app.levelingDir, league);
      const offers = await readJson<OffersFile>(join(dir, 'gem-offers.json'));
      tables['gem-offers'] = { data: offers, url: lvlUrl, patch: league };
      // same shapes as main/leveling/data.ts hands Journey: zones as one ordered list, quest extras as the quest map
      const zonesFile = await readJson<{ route: Array<Record<string, unknown>>; otherAreas?: Array<Record<string, unknown>> }>(join(dir, 'zones.json'));
      tables['zones'] = { data: [...zonesFile.route, ...(zonesFile.otherAreas ?? []).map((z, i) => ({ ...z, order: 1000 + i }))], url: lvlUrl, patch: league };
      const extras = await readJson<{ quests: Record<string, unknown> }>(join(dir, 'quest-extras.json'));
      tables['quest-extras'] = { data: extras.quests, url: lvlUrl, patch: league, type: 'community' };
      // Parked leveling guide (shared/leagueContent.ts): its route and skill picks stay out; quest rewards and zones stay.
      if (LEVELING_GUIDE) {
        tables['leveling-skills'] = { data: await readJson(join(dir, 'leveling-skills.json')), url: lvlUrl, patch: league };
        const routes: Record<number, string> = {};
        for (let a = 1; a <= 10; a++) {
          const f = join(dir, 'routes', `act-${a}.txt`);
          if (await exists(f)) routes[a] = await readFile(f, 'utf8');
        }
        tables['routes'] = { data: routes, url: lvlUrl, patch: league };
      }
      for (const [gemId, g] of Object.entries(offers.gems)) {
        g.o.forEach((o, i) => {
          const classes = o[5] === '*' ? 'all' : o[5].split('').map((c) => CLASS_LETTER[c] ?? c).join(', ');
          entities.quest_reward!.push({
            id: `lvl:${gemId}:${i}`,
            quest_id: o[1],
            reward_type: o[0] === 'quest' ? 'gem_quest' : `gem_${o[0]}`,
            reward: g.n,
            classes,
            source_url: lvlUrl,
            patch: league,
            data: { gemId, act: o[2], npc: o[3], level: o[4], kind: o[0] },
          });
        });
        // merged into the CDN gem row (same id): quest and vendor availability
        entities.gem!.push({
          id: gemId,
          name: g.n,
          source_url: lvlUrl,
          patch: league,
          data: {
            offers: g.o.map((o) => ({ kind: o[0], quest: o[1], act: o[2], npc: o[3], level: o[4], classes: o[5] === '*' ? 'all' : o[5].split('').map((c) => CLASS_LETTER[c] ?? c) })),
          },
        });
      }
    }

    const cardsFile = join(ctx.app.lootfilterDir, 'cardRewards.json');
    if (await exists(cardsFile)) {
      const cards = await readJson<{ source?: string; cards: Record<string, { kind?: string; reward?: string; stack?: number }> }>(cardsFile);
      tables['card-rewards'] = { data: cards, url: 'https://www.poewiki.net/wiki/Divination_card', type: 'wiki' };
      for (const [name, c] of Object.entries(cards.cards)) {
        entities.div_card!.push({
          id: name,
          name,
          stack: c.stack ?? null,
          reward: c.reward ?? null,
          source_type: 'wiki',
          source_url: `https://www.poewiki.net/wiki/${encodeURIComponent(name.replace(/ /g, '_'))}`,
          data: { rewardKind: c.kind ?? null, snapshot: cards.source ?? null },
        });
      }
    }

    const eng = ctx.app.engineDataDir;
    if (await exists(join(eng, 'data_uniques.json'))) {
      const uniques = await readJson<Record<string, string[]>>(join(eng, 'data_uniques.json'));
      const seen = new Set<string>();
      for (const [slot, list] of Object.entries(uniques)) {
        if (!Array.isArray(list)) continue;
        for (const raw of list) {
          if (typeof raw !== 'string') continue;
          const u = currentUniqueText(raw);
          if (!u.name || seen.has(u.name)) continue;
          seen.add(u.name);
          entities.unique_item!.push({
            id: u.name,
            name: u.name,
            base: u.base,
            text: u.text,
            source_url: `${DATA_SRC}/Uniques`,
            data: { slot, variants: u.variants },
          });
        }
      }
    }
    if (await exists(join(eng, 'data_bosses.json'))) {
      const bosses = await readJson<Record<string, { armourMult?: number; evasionMult?: number; isUber?: boolean }>>(join(eng, 'data_bosses.json'));
      for (const [id, b] of Object.entries(bosses)) {
        const name = id.replace(/([a-z])([A-Z])/g, '$1 $2');
        entities.boss!.push({
          id: `boss:${id}`,
          name,
          summary: `Armour ${b.armourMult ?? 0}% of normal, evasion ${b.evasionMult ?? 0}% of normal${b.isUber ? '; has an Uber version' : ''} (boss table).`,
          source_url: `${DATA_SRC}/Bosses.lua`,
          data: b,
        });
      }
      const skillsFile = join(eng, 'data_bossSkills.json');
      if (await exists(skillsFile)) {
        const skills = await readJson<Record<string, { DamageType?: string; DamageMultipliers?: Record<string, number[]>; speed?: number; tooltip?: string; UberDamageMultiplier?: number }>>(skillsFile);
        for (const [id, s] of Object.entries(skills)) {
          const types = Object.keys(s.DamageMultipliers ?? {}).join('/');
          entities.boss!.push({
            id: `boss-skill:${id}`,
            name: id,
            summary: `Boss skill: ${s.DamageType ?? '?'} hit, ${types || 'unknown'} damage${s.speed ? `, ${s.speed} ms` : ''}${s.UberDamageMultiplier ? `, Uber x${s.UberDamageMultiplier}` : ''}. ${s.tooltip ?? ''}`.trim(),
            source_url: `${DATA_SRC}/BossSkills.lua`,
            data: s,
          });
        }
      }
    }

    return { url: DATA_SRC, patch: league ?? ctx.livePatch, fetchedAt: now, entities, tables, note: league ? `leveling ${league}` : 'no leveling data' };
  },
};

export type { EntityRow };
