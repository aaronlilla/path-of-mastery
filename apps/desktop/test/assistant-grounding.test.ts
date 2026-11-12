import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defenceReport } from '../src/main/assistant/defence.js';
import { WarmPool, type CliProc } from '../src/main/assistant/runner.js';
import { gemDamageKind } from '../src/main/kb/query.js';

test('defenceReport ranks the weakest max hit and resists from engine stats (physical, not chaos)', () => {
  const r = defenceReport({ PhysicalMaximumHitTaken: 18522, FireMaximumHitTaken: 30000, ColdMaximumHitTaken: 29000, LightningMaximumHitTaken: 31000, ChaosMaximumHitTaken: 28219, FireResist: 75, ColdResist: 40, LightningResist: 75, ChaosResist: -20, MissingFireResist: 0, MissingColdResist: 35, MissingLightningResist: 0, MissingChaosResist: 95, Life: 5000, EnergyShield: 0, ManaUnreserved: -10 });
  assert.equal(r.maxHitsWeakestFirst[0]!.id, 'PhysicalMaximumHitTaken');
  assert.equal(r.resistsWorstFirst[0]!.id, 'ColdResist');
  // elemental gap before chaos; 18522 is not a low max hit, so it is not listed as a problem
  assert.deepEqual(r.topProblems.map((p) => p.id), ['ManaUnreserved', 'ColdResist', 'ChaosResist']);
  const low = defenceReport({ PhysicalMaximumHitTaken: 9000, FireResist: 75, ChaosResist: -20, MissingFireResist: 0, MissingChaosResist: 95, ChaosInoculation: 1 });
  assert.deepEqual(low.topProblems.map((p) => p.id), ['PhysicalMaximumHitTaken']); // CI drops chaos
});

test('gemDamageKind: Righteous Fire is damage over time only, Fire Trap hits and burns', () => {
  const rf = gemDamageKind('spell,fire', { constantStats: [{ id: 'base_nonlethal_fire_damage_%_of_maximum_life_taken_per_minute' }] }, [{ stats: '[]', data: '{"damageEffectiveness":0}' }]);
  assert.match(rf ?? '', /^damage over time only/);
  const trap = gemDamageKind('spell,fire', { constantStats: [{ id: 'base_fire_damage_to_deal_per_minute' }] }, [{ stats: '[]', data: '{"damageEffectiveness":16000}' }]);
  assert.equal(trap, 'hit and damage over time');
  assert.equal(gemDamageKind('spell,fire', {}, [{ stats: '[]', data: '{"damageEffectiveness":0}' }]), undefined);
});

test('gemDamageKind: a damage over time gem with no self-damage stat says nothing about the player; spell bonuses apply when the stat says so', () => {
  const blight = gemDamageKind('spell,chaos', { constantStats: [{ id: 'base_chaos_damage_to_deal_per_minute' }, { id: 'spell_damage_modifiers_apply_to_skill_dot' }] }, [{ stats: '[]', data: '{"damageEffectiveness":0}' }]);
  assert.match(blight ?? '', /^damage over time only/);
  assert.doesNotMatch(blight ?? '', /player/);
  assert.match(blight ?? '', /spell damage bonuses do apply/);
});

test('WarmPool: a program from model A is not reused after a turn on model B in the same chat', () => {
  const killed: string[] = [];
  const proc = (n: string) => ({ exited: false, kill: () => killed.push(n) }) as unknown as CliProc;
  const pool = new WarmPool(3);
  pool.put('A', 'S', proc('a'));
  assert.equal(pool.take('B', 'S'), null); // turn on B starts: A:S is ended
  assert.deepEqual(killed, ['a']);
  pool.put('B', 'S', proc('b'));
  assert.ok(pool.take('B', 'S')); // an exact match is still reused
  pool.put('B', 'S', proc('b2'));
  assert.equal(pool.take('A', 'S'), null); // back on A: B's program is ended too
  assert.deepEqual(killed, ['a', 'b2']);
  pool.clear();
});
