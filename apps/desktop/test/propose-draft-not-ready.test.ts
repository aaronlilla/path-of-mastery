import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILD_TOOLS } from '../src/main/assistant/buildTools.js';
import { xmlHash } from '../src/main/assistant/buildReaders.js';
import { blankBuildXml } from '../src/shared/buildXml.js';
import type { ToolContext } from '../src/main/assistant/tools.js';

// A solve row assessed "not ready" and opened as a draft is not applied by proposeDraft until the repair clears it (0.1.21 Claude review OTHER 3).

const open = blankBuildXml('Witch', 90);
const gloves = ['Rarity: RARE', 'Doom Grip', 'Warlock Gloves', 'Implicits: 0', '{crafted}+25 to Strength', '{crafted}55% increased Energy Shield'].join('\n');
const draftXml = open.replace('<ItemSet useSecondWeaponSet="nil" id="1" />', `<Item id="1">\n${gloves}\n</Item><ItemSet useSecondWeaponSet="nil" id="1"><Slot name="Gloves" itemId="1"/></ItemSet>`);

test('proposeDraft refuses a not-ready draft whose blocking line is still there, and applies nothing', async () => {
  const sent: string[] = [];
  const engine = {
    async send(cmd: string, args: any) {
      sent.push(cmd);
      if (cmd === 'getBuildXml') return { buildXml: args.buildId === 'open' ? open : draftXml };
      if (cmd === 'itemInfo') return { item: { valid: true, baseName: 'Warlock Gloves', itemLevel: 84, defences: { EnergyShield: 60 } } };
      if (cmd === 'modPool') return { pool: { prefixes: [], suffixes: [] } };
      throw new Error(`no ${cmd} in this fake`);
    },
  };
  const draft = { id: 'd1', buildId: 'draft', name: 'Solver result 1', from: 'open', baseKey: 'k', baseHash: xmlHash(open), startStats: {}, startAllocated: [], lines: ['Class: Witch'], kinds: new Set(['setXml']), notReady: 'Gloves: a craft the bench cannot make' };
  let created = 0;
  const ctx = { engine, open: () => ({ buildId: 'open', buildKey: 'k', name: 'x' }), drafts: { get: (id: string) => (id === 'd1' ? draft : undefined) }, proposals: { create: () => created++ }, origin: 'panel' } as unknown as ToolContext;
  const tool = BUILD_TOOLS.find((t) => t.name === 'proposeDraft')!;
  await assert.rejects(Promise.resolve(tool.run({ draftId: 'd1', title: 'Repaired build' }, ctx)), (e: Error) => {
    assert.match(e.message, /not ready, so it cannot be applied: Gloves: .* is not a craft the bench can put on Warlock Gloves/);
    assert.match(e.message, /Repair it first/);
    return true;
  });
  assert.equal(created, 0);
  assert.equal(sent.includes('modPool'), true, 'the craft check ran on the draft');
});
