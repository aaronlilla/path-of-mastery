import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spectreMatches, spectreTipLines } from '../src/shared/spectreLogic.js';

test('the Spectre Library search honours its Names, Skills and Both modes', () => {
  const skills = ['Default Attack', 'Frost Bolt'];
  assert.ok(spectreMatches('Sandworn Slave', skills, 'sand', 'Names'));
  assert.ok(!spectreMatches('Sandworn Slave', skills, 'frost', 'Names'));
  assert.ok(spectreMatches('Sandworn Slave', skills, 'frost', 'Skills'));
  assert.ok(!spectreMatches('Sandworn Slave', skills, 'sand', 'Skills'));
  assert.ok(spectreMatches('Sandworn Slave', skills, 'frost', 'Both') && spectreMatches('Sandworn Slave', skills, 'sand', 'Both'));
  assert.ok(spectreMatches('Anything', [], '  ', 'Names'));
});

test('a spectre row tooltip lists the figures the original shows', () => {
  const lines = spectreTipLines({ name: 'X', life: 4.4, energyShield: 0.2, resist: { fire: 0, cold: 0, lightning: 40, chaos: 0 }, damage: 1.28, attackTime: 1.755, skills: ['Melee'] });
  assert.deepEqual(lines, ['Life Multiplier: x4.40', 'Energy Shield: 20% of base Life', 'Resistances: 0/0/40/0', 'Base Damage: x1.28', 'Base Attack Speed: 0.57', 'Skill: Melee']);
});
