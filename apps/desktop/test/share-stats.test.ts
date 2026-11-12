import assert from 'node:assert/strict';
import { test } from 'node:test';
import { measureShareStats } from '../src/main/accounts/shareStats.js';

type Call = { cmd: string; params: Record<string, unknown> };
const fake = (stats: Array<{ id: string; value: unknown }>, opts: { failLoad?: boolean; hang?: boolean } = {}) => {
  const calls: Call[] = [];
  const engine = {
    send: async (cmd: string, params: Record<string, unknown>) => {
      calls.push({ cmd, params });
      if (opts.hang) return new Promise(() => undefined);
      if (cmd === 'loadBuild') {
        if (opts.failLoad) throw new Error('engine is not ready');
        return { buildId: 'scratch-1' };
      }
      if (cmd === 'getStats') return { stats };
      return {};
    },
  };
  return { engine: engine as never, calls };
};

test('measures Life, Combined DPS and the rest on a scratch copy, and closes it', async () => {
  const { engine, calls } = fake([
    { id: 'Life', value: 5120.4 }, { id: 'CombinedDPS', value: 2100000.7 }, { id: 'EnergyShield', value: 0 },
    { id: 'FireResist', value: 75 }, { id: 'Mana', value: 900 }, { id: 'Name', value: 'x' }, { id: 'ChaosResist', value: null },
  ]);
  const got = await measureShareStats(engine, '<PathOfBuilding/>');
  assert.deepEqual(got, { life: 5120.4, combinedDps: 2100000.7, energyShield: 0, fireRes: 75 });
  assert.deepEqual(calls.map((c) => c.cmd), ['loadBuild', 'getStats', 'closeBuild']);
  assert.equal(calls[1]!.params.buildId, 'scratch-1');
});

test('a stat the engine did not produce is left out, never sent as 0; no stats at all gives null', async () => {
  assert.deepEqual(await measureShareStats(fake([{ id: 'Life', value: 100 }]).engine, 'x'), { life: 100 });
  assert.equal(await measureShareStats(fake([{ id: 'Mana', value: 5 }]).engine, 'x'), null);
});

test('an engine that fails or hangs gives a rejection or null, not a hang', async () => {
  await assert.rejects(measureShareStats(fake([], { failLoad: true }).engine, 'x'), /not ready/);
  assert.equal(await measureShareStats(fake([], { hang: true }).engine, 'x', 50), null);
});
