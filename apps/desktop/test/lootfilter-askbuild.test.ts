import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOOT_TOOLS, LfProposalStore } from '../src/main/assistant/lootTools.js';
import { NeverSinkStore } from '../src/main/lootfilter/neversink.js';
import { LootFilterStore } from '../src/main/lootfilter/store.js';
import type { LfProposal } from '../src/shared/lootfilter/ipcTypes.js';
import { NEVERSINK_DIR } from './lootfilterHelpers.js';

const tool = (n: string) => LOOT_TOOLS.find((t) => t.name === n)!;

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'pom-ask2-'));
  const store = new LootFilterStore(join(dir, 'filters.json'));
  await store.load();
  const proposals = new LfProposalStore();
  const seen: LfProposal[] = [];
  proposals.onCreated((p) => seen.push(p));
  const base = { origin: 'panel', loot: { store, ns: new NeverSinkStore(join(NEVERSINK_DIR, '..'), join(dir, 'dl')), prices: async () => null, proposals } };
  return { dir, base, seen };
}

const XML = `<PathOfBuilding><Build level="68" className="Ranger" ascendClassName="Deadeye" mainSocketGroup="1"/>
<Skills><Skill enabled="true"><Gem nameSpec="Tornado Shot" skillId="TornadoShot" enabled="true"/><Gem nameSpec="Mirage Archer" skillId="SupportMirageArcher" enabled="true"/></Skill></Skills>
<Items><Item id="1">Rarity: RARE
Doom Whorl
Slink Boots
Item Level: 84</Item><ItemSet id="1"><Slot name="Boots" itemId="1"/></ItemSet></Items></PathOfBuilding>`;

test('the assistant can read the open build: level, equipped bases and gems, from the build file only', async () => {
  const { dir, base } = await setup();
  try {
    const ctx = { ...base, open: () => ({ buildId: 'b1', name: 'Kaelen', buildKey: 'k' }), engine: { send: async () => ({ buildXml: XML }) } } as never;
    const r = (await tool('getLootBuild').run({}, ctx)) as { build: string; level: number; mainSkill: string; equipped: { slot: string; base: string; rarity: string; itemLevel: number }[]; gems: { name: string; support: boolean }[] };
    assert.equal(r.build, 'Kaelen');
    assert.equal(r.level, 68);
    assert.equal(r.mainSkill, 'Tornado Shot');
    assert.deepEqual(r.equipped, [{ slot: 'Boots', base: 'Slink Boots', rarity: 'rare', itemLevel: 84 }]);
    assert.deepEqual(r.gems.map((g) => [g.name, g.support]), [['Tornado Shot', false], ['Mirage Archer', true]]);
    await assert.rejects(tool('getLootBuild').run({}, { ...base, open: () => null } as never), /No build is open/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a proposal keeps the section and reason the assistant gave each change', async () => {
  const { dir, base, seen } = await setup();
  try {
    await tool('proposeLootRules').run({ title: 'Quiet scrolls', changes: [{ action: 'hide', items: ['Portal Scroll'], section: 'Leveling scrolls', reason: 'You asked to hide scrolls after act 10.' }, { action: 'quiet', items: ['Scroll of Wisdom'] }] }, base as never);
    assert.equal(seen[0]!.changes[0]!.section, 'Leveling scrolls');
    assert.equal(seen[0]!.changes[0]!.reason, 'You asked to hide scrolls after act 10.');
    assert.equal(seen[0]!.changes[1]!.section, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
