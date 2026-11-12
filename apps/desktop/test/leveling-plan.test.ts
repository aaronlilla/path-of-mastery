import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avail, resolveGem } from '../src/shared/leveling/offers.js';
import { planLeveling, rankCandidates } from '../src/shared/leveling/plan.js';
import { loadAll } from './levelingHelpers.js';

const PCONC = 'Metadata/Items/Gems/SkillGemPoisonousConcoction';
const CAUSTIC = 'Metadata/Items/Gems/SkillGemPoisonArrow';
const sup = (n: string) => 'Metadata/Items/Gems/SupportGem' + n;

test('Ranger PConc swaps at 12 (a1q3) after Caustic Arrow on a bow', async () => {
  const { data } = await loadAll();
  const plan = planLeveling({ className: 'Ranger', mainSkillId: PCONC, mainSupportIds: [sup('LesserPoison'), sup('FasterAttack')], ruthless: false }, data);
  assert.equal(plan.swap?.level, 12);
  assert.equal(plan.swap?.questId, 'a1q3');
  assert.equal(plan.swap?.areaLevel, 12);
  const s0 = plan.skills[0]!;
  assert.equal(s0.gemId, CAUSTIC);
  assert.equal(s0.name, 'Caustic Arrow');
  assert.ok(s0.weaponClasses.includes('Bows'));
  const a = avail(data, s0.gemId, 'Ranger', false)!;
  assert.ok(a.level <= 4, 'the leveling skill is available at level 4 or lower');
  assert.equal(s0.from, 1);
  assert.equal(s0.to, 11);
});

test('Witch PConc swaps at 31 through Siosa and may use a bridge skill', async () => {
  const { data } = await loadAll();
  const plan = planLeveling({ className: 'Witch', mainSkillId: PCONC, mainSupportIds: [], ruthless: false }, data);
  assert.equal(plan.swap?.level, 31);
  assert.equal(plan.swap?.source, 'siosa');
  assert.equal(plan.swap?.questId, 'a3q12');
  assert.ok(plan.skills.length >= 1);
  assert.equal(plan.skills[plan.skills.length - 1]!.to, 30);
});

test('Scion PConc gives a plan at 12 without throwing', async () => {
  const { data } = await loadAll();
  const plan = planLeveling({ className: 'Scion', mainSkillId: PCONC, mainSupportIds: [sup('LesserPoison')], ruthless: false }, data);
  assert.equal(plan.swap?.level, 12);
  assert.ok(plan.skills[0]);
});

test('Shadow PConc swaps at 12 from the vendor', async () => {
  const { data } = await loadAll();
  const plan = planLeveling({ className: 'Shadow', mainSkillId: PCONC, mainSupportIds: [], ruthless: false }, data);
  assert.equal(plan.swap?.level, 12);
  assert.equal(plan.swap?.source, 'vendor');
});

test('ruthless Witch PConc has no siosa or lilly source', async () => {
  const { data } = await loadAll();
  const profile = { className: 'Witch', mainSkillId: PCONC, mainSupportIds: [], ruthless: true };
  const plan = planLeveling(profile, data);
  assert.ok(plan.swap === null || (plan.swap.source !== 'siosa' && plan.swap.source !== 'lilly'));
  for (const gem of [PCONC, ...plan.skills.flatMap((s) => [s.gemId, ...s.supports])]) {
    const a = avail(data, gem, 'Witch', true);
    assert.ok(!a || ['start', 'chest', 'quest'].includes(a.kind), `${gem} ${a?.kind}`);
  }
});

test('a main skill at level 4 or lower has no leveling skill', async () => {
  const { data } = await loadAll();
  const plan = planLeveling({ className: 'Ranger', mainSkillId: CAUSTIC, mainSupportIds: [], ruthless: false }, data);
  assert.deepEqual(plan, { swap: null, skills: [] });
});

test('an override replaces the best candidate', async () => {
  const { data } = await loadAll();
  const profile = { className: 'Ranger', mainSkillId: PCONC, mainSupportIds: [], ruthless: false };
  const ranked = rankCandidates(profile, data);
  assert.ok(ranked.length > 3 && ranked[0]!.reason.length > 0);
  const other = ranked.find((r) => r.candidate.gemId !== CAUSTIC)!.candidate.gemId;
  const plan = planLeveling(profile, data, other);
  assert.equal(plan.skills[0]!.gemId, other);
  assert.equal(plan.skills.length, 1);
});

test('an old Poison Arrow build resolves to the same gemId as Caustic Arrow', async () => {
  const { idx } = await loadAll();
  const viaId = resolveGem({ gemId: CAUSTIC }, idx);
  assert.equal(viaId, CAUSTIC);
  assert.equal(resolveGem({ skillId: 'PoisonArrow' }, idx), viaId);
  assert.equal(resolveGem({ nameSpec: 'Poison Arrow' }, idx), viaId);
  assert.equal(resolveGem({ nameSpec: 'Caustic Arrow' }, idx), viaId);
  // a transfigured record lands on its base gem
  assert.equal(resolveGem({ gemId: 'Metadata/Items/Gems/SkillGemCausticArrowAltX' }, idx), viaId);
  // game id and record key spell the same gem two ways for some gems
  assert.equal(resolveGem({ gemId: 'Metadata/Items/Gems/SkillGemNewArcticArmour' }, idx), 'Metadata/Items/Gems/SkillGemArcticArmour');
});
