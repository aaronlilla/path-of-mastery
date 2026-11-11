import { slimEntries, type Handler, type TransEntry } from '../statText.js';
import type { EntityRow, KbSource, Pulled, SourceCtx } from './types.js';

/**
 * repoe-fork (community JSON exports of the game files, updated a few days after each patch). Adds what the CDN source
 * does not have: each mod's in-game text (so a mod is found by what it says), essences, fossils and the crafting bench.
 * The CDN source runs first and owns the mod rows; these rows only add `text` to their data.
 */

export const REPOE_BASE = 'https://repoe-fork.github.io/';

/** "RePoE - PoE version 3.29.3.3" in the index page title. */
export function parseRepoeVersion(html: string): string | null {
  return /PoE version\s+(\d+(?:\.\d+)+)/i.exec(html)?.[1] ?? null;
}

/** Skill-specific translation files first (their wording wins), the general one last. */
const TRANSLATION_FILES = ['skill', 'support_gem', 'active_skill_gem', 'passive_skill', 'passive_skill_aura', 'aura_skill', 'buff_skill', 'curse_skill', 'debuff_skill', 'secondary_debuff_skill', 'minion_skill', 'minion_attack_skill', 'minion_spell_skill', 'minion_spell_damage_skill', 'single_minion_spell_skill', 'brand_skill', 'beam_skill', 'banner_aura_skill', 'offering_skill', 'variable_duration_skill'];

type RepoeMod = { name?: string; domain?: string; generation_type?: string; required_level?: number; stats?: Array<{ id: string; min?: number; max?: number }>; text?: string };

export function repoeModRows(mods: Record<string, RepoeMod>): EntityRow[] {
  const rows: EntityRow[] = [];
  for (const [id, m] of Object.entries(mods)) {
    if (!m.text) continue;
    rows.push({ id, name: m.name || null, domain: m.domain?.toUpperCase() ?? null, generation: m.generation_type?.toUpperCase() ?? null, level: m.required_level ?? null, stats: m.stats ?? [], data: { text: m.text } });
  }
  return rows;
}

export const repoeSource: KbSource = {
  id: 'repoe',
  type: 'community',
  async pull(ctx: SourceCtx): Promise<Pulled> {
    const json = async <T>(f: string) => (await ctx.http.json<T>(`${REPOE_BASE}${f}.min.json`)).data;
    const index = await ctx.http.text(`${REPOE_BASE}poe1.html`);
    const patch = parseRepoeVersion(index.body);
    if (!patch) throw new Error('repoe: no game version on the index page');
    const mod = repoeModRows(await json<Record<string, RepoeMod>>('mods'));
    const essences = await json<unknown>('essences');
    const fossils = await json<unknown>('fossils');
    const bench = await json<unknown>('crafting_bench_options');
    const handlers = await json<Record<string, Handler>>('stat_value_handlers');
    const entries: TransEntry[] = [];
    for (const f of [...TRANSLATION_FILES.map((n) => `stat_translations/${n}`), 'stat_translations']) entries.push(...slimEntries(await json<Array<Partial<TransEntry>>>(f)));
    ctx.log(`repoe: ${patch}: ${mod.length} mod texts`);
    return {
      url: `${REPOE_BASE}poe1.html`,
      patch,
      fetchedAt: index.fetchedAt,
      entities: { mod },
      tables: {
        essences: { data: essences, url: `${REPOE_BASE}essences.json` },
        fossils: { data: fossils, url: `${REPOE_BASE}fossils.json` },
        'stat-translations': { data: { handlers, entries }, url: `${REPOE_BASE}stat_translations/` },
        'crafting-bench': { data: bench, url: `${REPOE_BASE}crafting_bench_options.json` },
      },
      ...(patch !== ctx.livePatch ? { note: `repoe-fork is on ${patch}, live is ${ctx.livePatch}` } : {}),
    };
  },
};
