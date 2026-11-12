import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDataJob } from '../src/main/dataWorker.js';

// A tiny data folder, so the test reads exactly what the worker returns.
const dir = mkdtempSync(join(tmpdir(), 'pom-dataworker-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const tree = {
  classes: { '0': { name: 'Scion', classes: { '1': { name: 'Ascendant' } } }, '1': { name: 'Marauder', classes: {} } },
  jewelSlots: [26725],
  nodes: { '10': { type: 'Notable', dn: 'A', modKey: 'k', sprites: { notableActive: { '1': 2, '2': 3, '3': 10 } } }, '11': { ascendancyName: 'Ascendant', isMultipleChoiceOption: true } },
  ascendNameMap: { Warden: { ascendClassId: 1 } },
  secondaryAscendNameMap: { Warden: { ascendClassId: 1 } },
  tattoo: { nodes: { T: { dn: 'Tattoo', sd: ['x'] } } },
};
writeFileSync(join(dir, 'tree_9_9.json'), JSON.stringify(tree));
writeFileSync(join(dir, 'data_gems.json'), JSON.stringify({ g1: { id: 'g1', gameId: 'G', grantedEffectId: 'E', name: 'Fireball', tagString: 'Spell', grantedEffect: { color: 3 }, extra: [1, 2, 3] } }));
writeFileSync(join(dir, 'data_itemBases.json'), JSON.stringify({ 'Iron Ring': { type: 'Ring', implicit: 'x' }, Axe: { type: 'One Handed Axe', weapon: { PhysicalMin: 1 } } }));
writeFileSync(join(dir, 'data_gemForBaseName.json'), JSON.stringify({ fireball: 'g1' }));
writeFileSync(join(dir, 'data_gemGrantedEffectIdForVaalGemId.json'), JSON.stringify({ E: 'v1' }));

test('game data is parsed on a worker thread and comes back trimmed to what the callers read', async () => {
  const prev = process.env.POM_ENGINE_DATA;
  process.env.POM_ENGINE_DATA = dir;
  try {
    const t = await runDataJob('treeInfo', '9_9');
    assert.deepEqual(t.classes[0], { name: 'Scion', ascendancies: ['Ascendant'] });
    assert.deepEqual(t.nodes['11'], { ascendancyName: 'Ascendant', isMultipleChoiceOption: true });
    assert.deepEqual(t.secondaryAscend, { Warden: 1 });
    assert.deepEqual(t.tattoos.T, { dn: 'Tattoo', icon: '', activeEffectImage: '', sd: ['x'] });
    const n = await runDataJob('treeNodes', '9_9');
    assert.deepEqual(n['10'], { n: 'A', t: 'Notable', k: n['10']!.k, sp: [2, 3, 8] });
    const items = await runDataJob('itemData');
    assert.deepEqual(items.gems.g1, { id: 'g1', gameId: 'G', grantedEffectId: 'E', name: 'Fireball' });
    assert.deepEqual(items.bases, { 'Iron Ring': { type: 'Ring' }, Axe: { type: 'One Handed Axe', weapon: { PhysicalMin: 1 } } });
    assert.deepEqual(items.vaalGemFor, { E: 'v1' });
    assert.deepEqual((await runDataJob('gameInfo')).gems.Fireball, { attr: 'int', support: false });
    await assert.rejects(runDataJob('treeInfo', '1_1'));
  } finally {
    process.env.POM_ENGINE_DATA = prev;
  }
});

test('imports asking for the same tree at the same moment share one read', async () => {
  const prev = process.env.POM_ENGINE_DATA;
  process.env.POM_ENGINE_DATA = dir;
  try {
    const { loadTree } = await import('../src/main/character/data.js');
    const [a, b] = [loadTree('9_9'), loadTree('9_9')];
    assert.equal(a, b);
    assert.equal(await a, await loadTree('9_9'));
  } finally {
    process.env.POM_ENGINE_DATA = prev;
  }

});
