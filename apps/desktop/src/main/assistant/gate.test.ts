import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkChange, heldLine, isPureQuestion, namedByPlayer, waivesSuppression, type GateAsk, type GateInput } from './gate.js';

// A capped, healthy build: every row of the gate reads these numbers.
const BASE = {
  FullDPS: 1_000_000, CombinedDPS: 1_000_000, TotalEHP: 50_000, Life: 5000,
  FireResist: 75, FireResistMax: 75, ColdResist: 75, ColdResistMax: 75, LightningResist: 75, LightningResistMax: 75, ChaosResist: 30, ChaosResistMax: 75,
  PhysicalMaximumHitTaken: 10_000, FireMaximumHitTaken: 20_000, ColdMaximumHitTaken: 20_000, LightningMaximumHitTaken: 20_000, ChaosMaximumHitTaken: 8000,
  FreezeAvoidChance: 100, ManaPerSecondCost: 20, ManaRegenRecovery: 30, ManaLeechRate: 0,
};
const input = (after: Record<string, number>, more: Partial<GateInput> = {}): GateInput => ({
  before: BASE, after: { ...BASE, ...after }, warnBefore: [], warnAfter: [], unfixed: [], itemLines: [], ...more,
});
const CHOSEN: GateAsk = { named: false, question: false, suppressionWaived: false };
const NAMED: GateAsk = { ...CHOSEN, named: true };

test('K01: an edit the assistant chose that uncaps a resist is not applied; the variant that keeps the cap goes in', () => {
  const asked = input({ FullDPS: 1_100_000, FireResist: 68 }, { stat: 'FullDPS' });
  const alone = checkChange(asked, CHOSEN);
  assert.equal(alone.outcome, 'card');
  assert.ok(alone.rows.some((r) => r.rule === 'uncapped'), 'the uncapped resist is the reason');
  const v = checkChange(asked, CHOSEN, input({ FullDPS: 1_060_000 }, { stat: 'FullDPS' }));
  assert.equal(v.outcome, 'variant');
});

test('K02: a draft that drops Strength under a gem passes once the fix is folded in, and not before', () => {
  const lost = input({}, { warnAfter: ['You do not meet the Strength requirement'], unfixed: ['Herald of Ash needs 98 Strength, the build has 91'] });
  assert.equal(checkChange(lost, CHOSEN).outcome, 'card');
  assert.ok(checkChange(lost, CHOSEN).rows.some((r) => r.rule === 'unmet'));
  // the fixer lowered the gem in the same step: no warning and nothing unfixed is left
  assert.equal(checkChange(input({ FullDPS: 1_050_000 }), CHOSEN).outcome, 'apply');
});

test('K03: +4% damage for -30% effective HP is a card', () => {
  const v = checkChange(input({ FullDPS: 1_040_000, TotalEHP: 35_000 }, { stat: 'FullDPS' }), CHOSEN);
  assert.equal(v.outcome, 'card');
  assert.deepEqual([...new Set(v.rows.map((r) => r.rule))].sort(), ['limit', 'trade']);
});

test('K04: a gem that does not fit the sockets is a card; the pick that fits goes in', () => {
  const misfit = input({ FullDPS: 1_080_000 }, { stat: 'FullDPS', itemLines: ['Socket colours: Weapon 1 is R-B-G-G-B-G and its gems need 1 more blue: recolour it'] });
  assert.equal(checkChange(misfit, CHOSEN).outcome, 'card');
  assert.ok(checkChange(misfit, CHOSEN).rows.some((r) => r.rule === 'sockets'));
  assert.equal(checkChange(misfit, CHOSEN, input({ FullDPS: 1_050_000 }, { stat: 'FullDPS' })).outcome, 'variant');
});

test('K05: losing freeze immunity is a card', () => {
  const v = checkChange(input({ FullDPS: 1_200_000, FreezeAvoidChance: 0 }, { stat: 'FullDPS' }), CHOSEN);
  assert.equal(v.outcome, 'card');
  assert.ok(v.rows.some((r) => r.rule === 'layer' && /Freeze immunity/.test(r.shown)));
});

test('K06: +1% damage for -10% effective HP is a card: it gains less than it costs', () => {
  const v = checkChange(input({ FullDPS: 1_010_000, TotalEHP: 45_000 }, { stat: 'FullDPS' }), CHOSEN);
  assert.equal(v.outcome, 'card');
  assert.deepEqual(v.rows.map((r) => r.rule), ['trade']);
});

test('a change the player named exactly goes in with its cost said; the better option is offered', () => {
  const asked = input({ FullDPS: 1_040_000, TotalEHP: 35_000 }, { stat: 'FullDPS' });
  const v = checkChange(asked, NAMED, input({ FullDPS: 1_020_000 }, { stat: 'FullDPS' }));
  assert.equal(v.outcome, 'applyWithCost');
  assert.equal(v.variantPasses, true);
  assert.match(v.reason, /Effective HP/);
});

test('the assistant picking an item on "put it on" passes the full gate: +0.9% Full DPS for -4.4% effective HP stays a card', () => {
  assert.equal(checkChange(input({ FullDPS: 1_009_000, TotalEHP: 47_800 }, { stat: 'CombinedDPS' }), CHOSEN).outcome, 'card');
  assert.equal(namedByPlayer('Which unique belt gives me the most Full DPS? Put it on.', [["Meginord's Girdle", 'Leather Belt']]), false);
  assert.equal(namedByPlayer('equip meginords girdle', [["Meginord's Girdle", 'Leather Belt']]), true);
  assert.equal(namedByPlayer('take Ghost Reaver', [['Ghost Reaver']]), true);
  assert.equal(namedByPlayer('take Ghost Reaver', [['Ghost Reaver'], ['Enlighten']]), false, 'every thing the change sets must be named');
  assert.equal(namedByPlayer('', [['Ghost Reaver']]), false);
});

test('a pure question never changes the build, even when it names the thing', () => {
  assert.equal(checkChange(input({ FullDPS: 1_100_000 }), { ...NAMED, question: true }).outcome, 'card');
  assert.equal(isPureQuestion('Which is my weakest resistance?'), true);
  assert.equal(isPureQuestion('How much damage would Ghost Reaver give me?'), true);
  assert.equal(isPureQuestion('What should I upgrade next?'), false);
  assert.equal(isPureQuestion('Can you take Ghost Reaver?'), false);
  assert.equal(isPureQuestion('Take Ghost Reaver. What does it cost?'), false);
  assert.equal(isPureQuestion(''), false);
});

test('a clean gain applies, and only a suppression waiver in words lets suppression go', () => {
  assert.equal(checkChange(input({ FullDPS: 1_100_000, TotalEHP: 49_800 }, { stat: 'FullDPS' }), CHOSEN).outcome, 'apply');
  const sup = { before: { ...BASE, SpellSuppressionChance: 100 }, after: { ...BASE, FullDPS: 1_200_000, SpellSuppressionChance: 60 } };
  assert.equal(checkChange(input({}, { ...sup, stat: 'FullDPS' }), CHOSEN).outcome, 'card');
  assert.equal(checkChange(input({}, { ...sup, stat: 'FullDPS' }), { ...CHOSEN, suppressionWaived: true }).outcome, 'apply');
  assert.equal(waivesSuppression('swap my boots, keep my spell suppression'), false);
  assert.equal(waivesSuppression('I do not care about suppression, get me the most damage'), true);
  assert.equal(waivesSuppression('more damage at any cost'), false);
  assert.equal(waivesSuppression('drop the suppression nodes if you need to'), true);
});

test('the honest reading: worse with typed custom modifiers off counts as worse, and a reading that could not run fails', () => {
  const honest = { before: BASE, after: { ...BASE, FullDPS: 1_100_000, ColdResist: 60 } };
  assert.equal(checkChange(input({ FullDPS: 1_100_000 }, { stat: 'FullDPS', honest }), CHOSEN).outcome, 'card');
  assert.ok(checkChange(input({ FullDPS: 1_100_000 }, { stat: 'FullDPS', honest }), CHOSEN).rows.some((r) => r.rule === 'honest'));
  assert.equal(checkChange(input({ FullDPS: 1_100_000 }, { stat: 'FullDPS', honest: null }), CHOSEN).outcome, 'card');
});

test('max hit, chaos, mana and the asked stat itself', () => {
  assert.ok(checkChange(input({ FullDPS: 1_100_000, PhysicalMaximumHitTaken: 9000 }, { stat: 'FullDPS' }), CHOSEN).rows.some((r) => r.rule === 'maxHit'));
  assert.equal(checkChange(input({ FullDPS: 1_100_000, PhysicalMaximumHitTaken: 9800 }, { stat: 'FullDPS' }), CHOSEN).outcome, 'apply', 'under five percent is not a break');
  assert.ok(checkChange(input({ FullDPS: 1_100_000, ChaosResist: 10, ChaosMaximumHitTaken: 6500 }, { stat: 'FullDPS' }), CHOSEN).rows.some((r) => r.rule === 'chaos'));
  assert.ok(checkChange(input({ FullDPS: 1_100_000, ManaPerSecondCost: 40 }, { stat: 'FullDPS' }), CHOSEN).rows.some((r) => r.rule === 'mana'));
  assert.ok(checkChange(input({ FullDPS: 950_000 }, { stat: 'FullDPS' }), CHOSEN).rows.some((r) => r.rule === 'trade'), 'the asked stat falling is no gain');
});

test('a fix with no stat asked may cost a little damage; a damage ask may not', () => {
  const fix = input({ FullDPS: 980_000 }, { warnBefore: ['Your unreserved Mana is negative'] });
  assert.equal(checkChange(fix, CHOSEN).outcome, 'apply');
  assert.equal(checkChange({ ...fix, stat: 'FullDPS' }, CHOSEN).outcome, 'card');
});

test('the character level moves only when the player says the character levelled, named change or not', () => {
  const raised = input({ FullDPS: 1_100_000 }, { stat: 'FullDPS', level: { before: 95, after: 100 } });
  const v = checkChange(raised, NAMED);
  assert.equal(v.outcome, 'card');
  assert.equal(v.rows[0]?.rule, 'level');
  assert.equal(checkChange(raised, { ...CHOSEN, levelAsked: true }).outcome, 'apply');
});

test('a change that is not a damage trade and fixes nothing may not lower a max hit or movement speed', () => {
  assert.ok(checkChange(input({ TotalEHP: 51_000, PhysicalMaximumHitTaken: 9860 }), CHOSEN).rows.some((r) => r.rule === 'maxHit'), '-1.4% physical max hit on "better boots"');
  assert.ok(checkChange(input({ TotalEHP: 51_000, EffectiveMovementSpeedMod: 1.98 }, { before: { ...BASE, EffectiveMovementSpeedMod: 2.09 } }), CHOSEN).rows.some((r) => r.rule === 'movement'));
  // gaining freeze immunity is a fix: a small max hit cost for it is not a break, a movement cost is (Walrus on the Quicksilver)
  const flask = { before: { ...BASE, FreezeAvoidChance: 0, EffectiveMovementSpeedMod: 2.09 } };
  assert.equal(checkChange(input({ FreezeAvoidChance: 100, EffectiveMovementSpeedMod: 2.09, PhysicalMaximumHitTaken: 9860 }, flask), CHOSEN).outcome, 'apply');
  assert.ok(checkChange(input({ FreezeAvoidChance: 100, EffectiveMovementSpeedMod: 1.98 }, flask), CHOSEN).rows.some((r) => r.rule === 'movement'));
});

test('a config-only change is the numbers read honestly: a lower number is no trade, a break still counts', () => {
  assert.equal(checkChange(input({ FullDPS: 600_000 }, { configOnly: true }), CHOSEN).outcome, 'apply');
  assert.equal(checkChange(input({ FullDPS: 600_000, FireResist: 60 }, { configOnly: true }), CHOSEN).outcome, 'card');
});

test('a resist craft the assistant chose that takes a capped resist under its cap is held, even as a fix', () => {
  // the chaos craft in place of the cold and lightning one: chaos up, lightning off its cap
  const craft = input({ ChaosResist: 42, ChaosMaximumHitTaken: 9000, LightningResist: 70 });
  const v = checkChange(craft, CHOSEN);
  assert.equal(v.outcome, 'card');
  assert.ok(v.rows.some((r) => r.rule === 'uncapped' && /Lightning resistance 75% -> 70%/.test(r.shown)), v.reason);
});

test('a held pick opens the answer with what it is, its gain and cost in numbers, and that the old item stays', () => {
  const asked = input({ FullDPS: 1_022_000, TotalEHP: 47_650 }, { stat: 'FullDPS' });
  const v = checkChange(asked, CHOSEN);
  assert.equal(v.outcome, 'card');
  assert.equal(heldLine(asked, v, { name: 'Perseverance', slot: 'Belt', ranked: true }), 'Best belt for Full DPS is Perseverance: Full DPS +2.2% but Effective HP -4.7%, so I left your belt on. Tap the card to equip it.');
  assert.match(heldLine(asked, v, { name: 'Spend on Full DPS', ranked: false }), /^Spend on Full DPS: Full DPS \+2\.2% but Effective HP -4\.7%, so I left the build as it was\. Tap the card to apply it\.$/);
  // a flask picked for freeze gains no damage; the line names the cost only and the slot as it was
  const flask = input({ TotalEHP: 48_900, Armour: 56_900, FreezeAvoidChance: 100 }, { before: { ...BASE, Armour: 67_300, FreezeAvoidChance: 20 } });
  const fv = checkChange(flask, CHOSEN);
  assert.match(heldLine(flask, fv, { name: 'Basalt Flask of the Penguin', slot: 'Flask 4', ranked: false }), /^Basalt Flask of the Penguin makes you immune to freeze but costs Armour .*-15\.5%.*, so I left Flask 4 as it was\. Tap the card to equip it\.$/);
});

test('a new freeze immunity the assistant chose goes in for a modest effective HP loss, not for a large one', () => {
  const lead = { stat: 'TotalEHP' };
  const modest = input({ TotalEHP: 48_900, FreezeAvoidChance: 100 }, { before: { ...BASE, FreezeAvoidChance: 20 }, ...lead });
  assert.equal(checkChange(modest, CHOSEN).outcome, 'apply');
  const large = input({ TotalEHP: 45_000, FreezeAvoidChance: 100 }, { before: { ...BASE, FreezeAvoidChance: 20 }, ...lead });
  assert.equal(checkChange(large, CHOSEN).outcome, 'card');
  // no immunity gained: the same -2.2% on an effective HP ask is still a fall of the asked stat
  assert.equal(checkChange(input({ TotalEHP: 48_900 }, lead), CHOSEN).outcome, 'card');
});

test('review F1: "What\'s next?" and its bare forms are upgrade asks, never a pure question that holds the app\'s fixes', () => {
  for (const q of ["What's next?", 'What next?', 'What can I do next?', 'What do I do next?']) assert.equal(isPureQuestion(q), false, q);
  assert.equal(isPureQuestion('How much life do I have?'), true);
});

test('review F2: losing the only Fortification source fails the gate as a layer, even with Fortification unticked (no number moves)', () => {
  const lost = input({ FullDPS: 1_200_000 }, { stat: 'FullDPS', itemLines: ['Loses Fortification (its only source was the Fortify gem): the engine shows no number for it, still gone in game'] });
  const v = checkChange(lost, CHOSEN);
  assert.equal(v.outcome, 'card');
  assert.ok(v.rows.some((r) => r.rule === 'layer' && /Fortification/.test(r.shown)), v.reason);
  assert.equal(checkChange(lost, NAMED).outcome, 'applyWithCost');
});

test('review F3: a minion build (player damage 0) is judged on its minions: a 30% minion damage loss fails the trade gate', () => {
  const minion = { ...BASE, FullDPS: 0, CombinedDPS: 0, MinionTotalDPS: 1_000_000 };
  const v = checkChange(input({ FullDPS: 0, CombinedDPS: 0, MinionTotalDPS: 700_000, TotalEHP: 52_000 }, { before: minion, stat: 'TotalEHP' }), CHOSEN);
  assert.notEqual(v.outcome, 'apply');
  assert.ok(v.rows.some((r) => r.rule === 'limit' && /Minion damage/.test(r.shown)), v.reason);
});

test('review F7: the numbers shown read the engine\'s own before; the adjusted before only decides pass or fail', () => {
  // the engine: 1M -> 936k (-6.4%); the old-debt repair alone took it to 900k, so the gate reads the change as +4%
  const asked = input({ FullDPS: 936_000, TotalEHP: 47_000 }, { stat: 'FullDPS', before: { ...BASE, FullDPS: 900_000 }, shownBefore: BASE });
  const v = checkChange(asked, CHOSEN);
  assert.equal(v.outcome, 'card', 'still judged on the adjusted before: +4% for -6% effective HP');
  assert.match(v.reason, /Full DPS -6\.4%/, v.reason);
  assert.doesNotMatch(v.reason, /\+4%/, v.reason);
  assert.doesNotMatch(heldLine(asked, v, { name: 'Belt', slot: 'Belt', ranked: true }), /\+4%/);
});
