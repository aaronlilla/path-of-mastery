// Regression: a gem picked through "Any gem..." must be an id the leveling data knows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduceGameData } from '../src/shared/lootfilter/profile.js';
import { planLeveling } from '../src/shared/leveling/plan.js';
import type { LevelingData } from '../src/shared/leveling/types.js';

test('a variant gem record carries its game id, which the picker hands to the plan', () => {
  const g = reduceGameData({
    itemBases: {},
    gems: { 'Metadata/Items/Gems/SkillGemSpectralShieldThrow': { name: 'Spectral Shield Throw', gameId: 'Metadata/Items/Gems/SkillGemThrownShieldProjectile' } },
  } as never);
  assert.equal(g.gems['Metadata/Items/Gems/SkillGemSpectralShieldThrow']?.gameId, 'Metadata/Items/Gems/SkillGemThrownShieldProjectile');
});

test('the plan follows an override gem the leveling data knows by its game id', () => {
  const id = 'Metadata/Items/Gems/SkillGemThrownShieldProjectile';
  const main = 'Metadata/Items/Gems/SkillGemMain';
  const offer = (gemId: string, level: number) => ({ gemId, class: 'Duelist', kind: 'vendor', questId: 'a3q8', act: 3, npc: 'Maramoa', level });
  const data = {
    league: '3.29',
    offers: { [main]: { Duelist: [offer(main, 30)] }, [id]: { Duelist: [offer(id, 4)] } },
    gems: { [main]: { name: 'Main', isSupport: false, colour: 'R', tags: ['attack'] }, [id]: { name: 'Spectral Shield Throw', isSupport: false, colour: 'G', tags: ['spell'] } },
    zones: [], skills: [], questExtras: {}, starts: {}, routes: {}, questZones: {},
  } as unknown as LevelingData;
  const plan = planLeveling({ className: 'Duelist', ruthless: false, mainSkillId: main, mainSupportIds: [] } as never, data, id);
  assert.equal(plan.skills[0]?.gemId, id);
});
