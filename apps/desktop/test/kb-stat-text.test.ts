import { test } from 'node:test';
import assert from 'node:assert/strict';
import { annotateStatText, type Translations } from '../src/main/kb/statText.js';

// entries copied from repoe-fork stat_translations (skill.json), patch 3.29.3.3
const tr: Translations = {
  handlers: { per_minute_to_per_second: { type: 'int', divisor: 60, precision: 1 }, negate: { type: 'int', multiplier: -1 } },
  entries: [
    { ids: ['base_righteous_fire_%_of_max_life_to_deal_to_nearby_per_minute'], English: [{ condition: [{}], format: ['#'], index_handlers: [['per_minute_to_per_second']], string: 'Deals {0}% of your Maximum Life as Base Fire Damage per second' }] },
    { ids: ['righteous_fire_spell_damage_+%_final'], English: [{ condition: [{ min: 1 }], format: ['#'], index_handlers: [[]], string: 'Grants {0}% more Spell Damage' }, { condition: [{ max: -1 }], format: ['#'], index_handlers: [['negate']], string: 'Grants {0}% less Spell Damage' }] },
    { ids: ['keystone_ghost_reaver'], English: [{ condition: [{}], format: ['ignore'], index_handlers: [[]], string: 'Ghost Reaver', reminder_text: '(Leech Energy Shield instead of Life.)' }] },
  ],
};

test('stat ids get the game wording, per-minute values shown per second', () => {
  const gem = { data: { constantStats: [{ id: 'base_righteous_fire_%_of_max_life_to_deal_to_nearby_per_minute', value: 4200 }, { id: 'no_such_stat', value: 3 }] } };
  const lvl = { stats: JSON.stringify([{ id: 'righteous_fire_spell_damage_+%_final', value: -5 }]), data: {} }; // a reused row keeps stats as JSON text
  const passive = { stats: [{ id: 'keystone_ghost_reaver', value: 1 }], data: {} };
  annotateStatText(new Map<string, Map<string, unknown>>([['gem', new Map([['g', gem]])], ['gem_level', new Map([['l', lvl]])], ['passive', new Map([['p', passive]])]]) as never, tr);
  assert.deepEqual(gem.data, { constantStats: gem.data.constantStats, statText: ['Deals 70% of your Maximum Life as Base Fire Damage per second'] });
  assert.deepEqual((lvl.data as { statText?: string[] }).statText, ['Grants 5% less Spell Damage']);
  assert.deepEqual((passive.data as { statText?: string[] }).statText, ['Ghost Reaver (Leech Energy Shield instead of Life.)']);
});
