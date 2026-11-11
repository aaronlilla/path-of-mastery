// League content switched off (src/shared/leagueContent.ts): with the switches off, none of the build tabs,
// palette tab rows, Ctrl+Alt digits, Start screen sections, MCP tools or AI prompt lines reaches league starters, the
// Atlas mechanic optimizer or the leveling guide, and a build filter made without the leveling part is still a valid filter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ATLAS_MECHANICS, LEAGUE_STARTERS, LEVELING_GUIDE } from '../src/shared/leagueContent.js';
import { PALETTE_TABS, TABS, tabVisible } from '../src/renderer/buildTabs.js';
import { AssistantService } from '../src/main/assistant/service.js';
import { LOOT_TOOLS } from '../src/main/assistant/lootTools.js';
import { KB_TOOLS } from '../src/main/assistant/kbTools.js';
import { BUILD_TOOLS as TOOLS } from '../src/main/assistant/buildTools.js';
import { lootSystemPrompt, systemPrompt } from '../src/main/assistant/prompts.js';
import { planFor } from '../src/main/lootfilter/buildData.js';
import { fixture as aiFixture } from '../src/main/aiGate/fixtures.js';
import { makeBuildFilter } from '../src/shared/lootfilter/buildFilter.js';
import { generateFilter } from '../src/shared/lootfilter/generate.js';
import { parseBlocks } from '../src/shared/lootfilter/blocks.js';
import { levelingLite, readBuildProfile } from '../src/shared/lootfilter/profile.js';
import { DEFAULT_BUILD_SETUP } from '../src/shared/lootfilter/types.js';
import { fixture, loadGame, neverSink } from './buildFilterHelpers.js';

const src = (rel: string): string => readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const LEVELING_TOOL_NAMES = ['getLevelingGuide', 'explainGuideStep', 'proposeLevelingSkill'];
const PARKED_WORDS = /league start|starter|leveling guide|leveling tab|follow along|journey|optimi[sz]e mechanics|mechanic optimizer|taxonomy/i;

test('the three switches are off', () => {
  assert.equal(LEAGUE_STARTERS, false);
  assert.equal(ATLAS_MECHANICS, false);
  assert.equal(LEVELING_GUIDE, false);
});

test('build tabs: no Leveling tab, Ctrl Alt 1-8 follow the visible tabs in order, palette rows match', () => {
  const ids = TABS.map((t) => t.id);
  console.log('build tabs:', TABS.map((t) => `${t.label} (${t.key})`).join(', '));
  assert.deepEqual(ids, ['tree', 'skills', 'items', 'calcs', 'config', 'compare', 'party', 'notes']);
  TABS.forEach((t, i) => assert.equal(t.key, `Ctrl Alt ${i + 1}`));
  assert.equal(TABS[8], undefined, 'Ctrl Alt 9 has no tab, so it does nothing');
  assert.equal(tabVisible('leveling'), false);
  assert.equal(tabVisible('import'), true);
  console.log('palette tab rows:', PALETTE_TABS.map((r) => r[1]).join(', '));
  for (const [id, label, meta, extra] of PALETTE_TABS) assert.ok(id !== 'leveling' && !PARKED_WORDS.test(`${label} ${meta} ${extra ?? ''}`), `palette row ${label}`);
});

test('MCP tool list the AI sees: no leveling tools, and no description points at a switched-off feature', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pom-park-'));
  try {
    // The service's own list (connectorInfo is what the Connections screen and paired clients are told).
    const svc = new AssistantService({ ...aiFixture().deps, engine: {} as never, dataDir: dir, version: 'test', bridgePath: join(dir, 'bridge.cjs'), desktopConfigPath: join(dir, 'cfg.json') });
    const names = (await svc.connectorInfo()).toolNames;
    console.log(`MCP tools (${names.length}):`, names.join(', '));
    assert.equal(names.length, TOOLS.length + LOOT_TOOLS.length);
    for (const n of LEVELING_TOOL_NAMES) assert.ok(!names.includes(n), `${n} is not served`);
    for (const t of [...TOOLS, ...LOOT_TOOLS, ...KB_TOOLS]) assert.ok(!PARKED_WORDS.test(`${t.chip} ${t.description}`), `tool ${t.name}: ${t.description}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AI system prompts: no leveling guide, starter or mechanic optimizer lines', () => {
  const loot = lootSystemPrompt({ tools: [...LOOT_TOOLS, ...KB_TOOLS].map((t) => t.name) });
  const build = systemPrompt({ tools: TOOLS.map((t) => t.name) });
  for (const p of [loot, build]) {
    assert.doesNotMatch(p, /Leveling tab|getLevelingGuide|explainGuideStep|proposeLevelingSkill|league start|starter|Optimize mechanics/i);
  }
  assert.match(loot, /To change a stage call proposeBuildFilterChange; it makes a card the player accepts\./);
});

test('Start screen: the LEAGUE STARTS section and the Leveling guide link render only behind their switches', () => {
  const start = src('renderer/home/Start.tsx');
  // Every section of the Start screen, by its heading label.
  const labels = [...start.matchAll(/className="lbl">([A-Z ]+)</g)].map((m) => m[1]);
  console.log('Start sections:', labels.join(', '));
  assert.deepEqual(labels, ['LEAGUE STARTS', 'AFTER YOUR FIRST BUILD']);
  assert.match(start, /\{LEAGUE_STARTERS && <section className="starter-chooser start-leagues"/);
  assert.match(start, /if \(!LEAGUE_STARTERS\) return;[^\n]*\n\s+let alive = true;\n\s+call<StarterState>\('mastery:starters'/);
  assert.match(start, /\{LEVELING_GUIDE && \(\s+<button[^>]*>\s+<Icon name="list" size=\{16\} \/>\s+<span className="t">Leveling guide/);
  const app = src('renderer/App.tsx');
  assert.match(app, /\.\.\.\(LEAGUE_STARTERS \? \[\{ kind: 'Action' as const, title: 'League starts'/);
  assert.match(app, /\.\.\.\(LEAGUE_STARTERS \? \{ onLeagueStarts:/);
  assert.equal((app.match(/title: 'League starts'/g) ?? []).length, 1, 'one palette entry, behind the switch');
});

test('main: no leveling planner, so a build filter has no leveling stage and still writes a valid filter', async () => {
  const reply = await planFor({ className: 'Ranger' } as never);
  assert.deepEqual(reply, { plan: null }, 'no plan and no note about leveling');
  const xml = fixture('pconc-pathfinder.xml');
  const game = loadGame();
  const profile = readBuildProfile(xml, game);
  assert.ok(profile);
  const { plan } = await planFor(levelingLite(profile!));
  const built = makeBuildFilter(xml, plan, { ...DEFAULT_BUILD_SETUP, on: true }, { game });
  assert.ok(built);
  const leveling = built!.rules.filter((r) => /levweap|levgems/.test(r.id));
  assert.deepEqual(leveling, [], 'no leveling weapons or leveling gems rules');
  assert.ok(!built!.stages.some((s) => s.id === 'S0'), 'no Leveling skill stage');
  const out = generateFilter({ baseText: neverSink(), baseVersion: '8.20.1d', strictness: 2, style: 0, rules: built!.rules, buildHeader: built!.header, stageBanners: built!.banners });
  const blocks = parseBlocks(out.text).blocks;
  console.log(`filter: ${built!.rules.length} build rules, stages ${built!.stages.map((s) => s.id).join(' ')}, ${blocks.length} blocks, ${out.text.length} chars`);
  assert.ok(blocks.length > 100 && /^Show|^Hide/m.test(out.text));
  assert.ok(built!.rules.some((r) => r.id === 'build:gems:skill'), 'the build part is still there');
});

test('a saved setup with moved stage bounds brings back no leveling stage, and the saved setting is left as it is', async () => {
  // A filter saved while the leveling guide was on: S1 moved to area 20 (so S0 Leveling skill covers 1-19) and a leveling skill picked.
  const dir = await mkdtemp(join(tmpdir(), 'pom-park-bounds-'));
  try {
    const file = join(dir, 'filter.json');
    const saved = JSON.stringify({ setup: { build: { ...DEFAULT_BUILD_SETUP, on: true, bounds: [20, 45, 68, 78], levelingSkill: 'Metadata/Items/Gems/SkillGemFireball' } } });
    await writeFile(file, saved, 'utf8');
    const doc = JSON.parse(await readFile(file, 'utf8')) as { setup: { build: typeof DEFAULT_BUILD_SETUP } };
    const xml = fixture('pconc-pathfinder.xml');
    const game = loadGame();
    const { plan } = await planFor(levelingLite(readBuildProfile(xml, game)!), doc.setup.build.levelingSkill);
    // The wizard's stage strip and the Write button both use this call (renderer/lootfilter/useBuildFilter.ts).
    const built = makeBuildFilter(xml, plan, doc.setup.build, { game })!;
    const out = generateFilter({ baseText: neverSink(), baseVersion: '8.20.1d', strictness: 2, style: 0, rules: built.rules, buildHeader: built.header, stageBanners: built.banners });
    const s0Rules = built.rules.filter((r) => r.build?.stage === 'S0' || /levweap|levgems/.test(r.id));
    const s0Text = out.text.split('\n').filter((l) => /\bS0\b|Leveling skill|Leveling gems|Leveling weapons/.test(l));
    console.log(`saved bounds [20,45,68,78]: stages ${built.stages.map((s) => `${s.id} ${s.lo}-${s.hi}`).join(', ')}; S0 rules ${s0Rules.length}; leveling lines in file ${s0Text.length}`);
    assert.ok(!built.stages.some((s) => s.id === 'S0'), 'no Leveling skill stage in the wizard');
    assert.equal(built.stages[0]!.lo, 1, 'the first stage starts at area 1');
    assert.deepEqual(s0Rules, [], 'no leveling-stage rules');
    assert.deepEqual(s0Text, [], 'no leveling-stage blocks or banners in the file');
    assert.equal(await readFile(file, 'utf8'), saved, 'the saved setup is unchanged');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
