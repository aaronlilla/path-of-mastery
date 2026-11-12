import { PoliteHttp } from '../src/main/kb/http.js';
import type { KbSource, Pulled } from '../src/main/kb/sources/types.js';

/** Three fake KB sources (CDN, forum, app) with a handful of real-looking rows; no network. */
export function fakeSources(state: { failForum?: boolean; ducats?: string }): KbSource[] {
  const at = '2026-10-11T00:00:00.000Z';
  const cdn: KbSource = {
    id: 'cdn',
    type: 'datamined',
    pull: async (): Promise<Pulled> => ({
      url: 'https://patch.poecdn.com/3.29.3.3/',
      patch: '3.29.3.3',
      fetchedAt: at,
      entities: {
        gem: [
          { id: 'Metadata/Items/Gems/SkillGemPoisonousConcoction', name: 'Poisonous Concoction', is_support: 0, color: 'G', tags: 'attack,chaos', req_level: 12, max_level: 40, description: 'Throws a bottle', data: { castTimeMs: 1000 } },
          { id: 'Metadata/Items/Gems/SkillGemFireball', name: 'Fireball', is_support: 0, color: 'B', tags: 'spell,fire', req_level: 1, max_level: 40, description: 'Unleashes a ball of fire', data: {} },
        ],
        gem_level: [
          { gem_id: 'Metadata/Items/Gems/SkillGemPoisonousConcoction', level: 1, req_level: 12, stats: [{ id: 'base_chance_to_poison_on_hit_%', value: 40 }], data: { cost: [{ type: 'Mana', amount: 5 }] } },
          { gem_id: 'Metadata/Items/Gems/SkillGemPoisonousConcoction', level: 20, req_level: 70, stats: [], data: {} },
        ],
        passive: [{ id: 'life1213', hash: 31471, name: 'Life', node_kind: 'normal', stats: [{ id: 'maximum_life_+%', value: 6 }], data: {} }],
        league_mechanic: [{ id: 'allflame:cursed-ducats', league: 'Allflame', name: 'Allflame Cursed Ducats', summary: state.ducats ?? 'Ducat of the Grasping Deep', data: {} }],
        quest: [{ id: 'a1q3', name: 'Breaking Some Eggs', act: 1, data: {} }],
        quest_reward: [{ id: 'cdn:qr:0', quest_id: 'a1q3', reward_type: 'gem_quest', reward: 'Poisonous Concoction', classes: 'Ranger', data: {} }],
      },
      tables: { 'passive-ids': { data: { life1213: { hash: 31471, name: 'Life' } } } },
    }),
  };
  const forum: KbSource = {
    id: 'forum',
    type: 'official',
    pull: async (): Promise<Pulled> => {
      if (state.failForum) throw new Error('forum down');
      return {
        url: 'https://www.pathofexile.com/forum/view-forum/patch-notes',
        patch: '3.29.3b',
        fetchedAt: at,
        entities: {
          doc: [
            { id: 'forum:3996516#0', doc_kind: 'patch_note', title: '3.29.3 Patch Notes — General Improvements & Bug Fixes', version: '3.29.3', posted_at: '2026-08-12', body: '- Fixed a bug introduced in 3.29 which caused level one Conflagration to deal no damage.', source_url: 'https://www.pathofexile.com/forum/view-thread/3996516', data: { thread: 3996516, chunk: 0, threadTitle: '3.29.3 Patch Notes', heading: 'General Improvements & Bug Fixes' } },
            { id: 'forum:3985332#0', doc_kind: 'league', title: 'Content Update 3.29.0 — Curse of the Allflame — The Curse of the Allflame Challenge League', version: '3.29.0', posted_at: '2026-07-16', body: '- Meet Valerie, a corsair captain. Find Charts, board The Sovereign, and set sail!', source_url: 'https://www.pathofexile.com/forum/view-thread/3985332', data: { thread: 3985332, chunk: 0, threadTitle: 'Content Update 3.29.0', heading: 'The Curse of the Allflame Challenge League' } },
          ],
        },
        tables: { 'patch-threads': { data: [{ id: 4002803, title: 'Server Maintenance' }] } },
      };
    },
  };
  // the app source fills empty columns of the CDN row and adds rows of its own
  const app: KbSource = {
    id: 'app',
    type: 'community',
    pull: async (): Promise<Pulled> => ({
      url: 'https://github.com/HeartofPhos/exile-leveling',
      patch: '3.29',
      fetchedAt: at,
      entities: {
        gem: [{ id: 'Metadata/Items/Gems/SkillGemPoisonousConcoction', name: 'Poisonous Concoction', data: { offers: [{ kind: 'vendor', quest: 'a1q3' }] } }],
        unique_item: [{ id: 'Tabula Rasa', name: 'Tabula Rasa', base: 'Simple Robe', text: 'Sockets: W-W-W-W-W-W', data: {} }],
      },
      tables: { 'gem-offers': { data: { gems: {} } }, zones: { data: { route: [] } } },
    }),
  };
  return [cdn, forum, app];
}

export const noNet = new PoliteHttp({ fetch: async () => { throw new Error('no network in tests'); } });
