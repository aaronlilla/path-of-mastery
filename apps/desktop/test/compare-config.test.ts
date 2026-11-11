import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeConfigOf, readFacts, setConfigInputs } from '../src/shared/buildFacts.js';
import { defaultOf, effectiveConfig, normaliseConfig, type ConfigOption, type ConfigSchema } from '../src/shared/comparePower.js';

// The Compare tab holds each build's config the way upstream's `configTab.input` does: every option's default, then
// the inputs the build saved. Copy Config writes B's whole input over A's (CompareTab:CopyCompareConfig).

const SCHEMA: ConfigSchema = {
  sections: [{ name: 'General', col: 1 }],
  options: [
    { var: 'bandit', type: 'list', label: 'Bandit quest:', section: 'General', defaultIndex: 1, list: [{ val: 'None', label: 'Kill all' }, { val: 'Oak', label: 'Help Oak' }] },
    { var: 'enemyIsBoss', type: 'list', label: 'Is the enemy a Boss?', section: 'General', apply: true, defaultIndex: 3, list: [{ val: 'None', label: 'No' }, { val: 'Boss', label: 'Boss' }, { val: 'Pinnacle', label: 'Pinnacle' }] },
    { var: 'targetBrandedEnemy', type: 'check', label: 'Targeting the Branded enemy', section: 'General', apply: true, defaultState: true },
    { var: 'usePowerCharges', type: 'check', label: 'Use power charges', section: 'General', apply: true },
  ],
};
const opt = (v: string): ConfigOption => SCHEMA.options.find((o) => o.var === v)!;

const build = (attrs: string, config: string | null) => `<PathOfBuilding><Build ${attrs}/>${config === null ? '' : `<Config>${config}</Config>`}</PathOfBuilding>`;

test('an option a build never saved holds its default, not "off"', () => {
  assert.equal(defaultOf(opt('bandit')), 'None');
  assert.equal(defaultOf(opt('enemyIsBoss')), 'Pinnacle');
  assert.equal(defaultOf(opt('targetBrandedEnemy')), true);
  assert.equal(defaultOf(opt('usePowerCharges')), undefined);
  const cfg = effectiveConfig(readFacts(build('level="90"', '<Input name="usePowerCharges" boolean="true"/>')), SCHEMA);
  assert.equal(cfg.get('enemyIsBoss'), 'Pinnacle');
  assert.equal(cfg.get('targetBrandedEnemy'), true);
  assert.equal(cfg.get('usePowerCharges'), true);
});

test('a saved input wins over the default', () => {
  const cfg = effectiveConfig(readFacts(build('level="90"', '<Input name="targetBrandedEnemy" boolean="false"/><Input name="enemyIsBoss" string="None"/>')), SCHEMA);
  assert.equal(cfg.get('targetBrandedEnemy'), false);
  assert.equal(cfg.get('enemyIsBoss'), 'None');
});

test('the <Build> quest pick only counts for a build with no <Config>', () => {
  // ConfigTab:Load starts from fresh config sets, so the pick Build.lua put into the input before it is gone.
  assert.equal(effectiveConfig(readFacts(build('bandit="Oak"', '')), SCHEMA).get('bandit'), 'None');
  assert.equal(effectiveConfig(readFacts(build('bandit="Oak"', null)), SCHEMA).get('bandit'), 'Oak');
});

test('rows differ by the original rule: normalised values compared as text', () => {
  const a = effectiveConfig(readFacts(build('', '<Input name="targetBrandedEnemy" boolean="false"/>')), SCHEMA);
  const b = effectiveConfig(readFacts(build('', '')), SCHEMA);
  const differing = SCHEMA.options.filter((o) => {
    const [x, y] = normaliseConfig(o, a.get(o.var), b.get(o.var));
    return String(x) !== String(y);
  });
  assert.deepEqual(differing.map((o) => o.var), ['targetBrandedEnemy']);
});

test('Copy Config writes the compared build\'s whole input over this one, defaults included', () => {
  const a = build('', '<Input name="enemyIsBoss" string="Boss"/><Input name="usePowerCharges" boolean="true"/>');
  const b = build('', '<Input name="targetBrandedEnemy" boolean="false"/>');
  const values: Record<string, string | number | boolean> = {};
  for (const [k, v] of effectiveConfig(readFacts(b), SCHEMA)) values[k] = v;
  const copied = activeConfigOf(readFacts(setConfigInputs(a, values)));
  // B never saved enemyIsBoss, so its default (Pinnacle) replaces A's Boss; A's power charges stay (B holds no such input).
  assert.equal(copied.get('enemyIsBoss'), 'Pinnacle');
  assert.equal(copied.get('targetBrandedEnemy'), false);
  assert.equal(copied.get('usePowerCharges'), true);
});
