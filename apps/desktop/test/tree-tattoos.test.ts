import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countedTattoos, tattooCount, tattooEligible, tattoosFor, tattooTooltip, type Tattoo } from '../src/renderer/tree/tattoos.js';

const T = (over: Partial<Tattoo> & { dn: string }): Tattoo => ({ key: over.dn, sd: ['+3% to Chaos Resistance'], targetType: 'Small Strength', targetValue: '', minConnected: 0, icon: 'icon.png', effectImage: 'fx.png', ...over });

test('a tattoo fits the node kind it targets', () => {
  const all = [
    T({ dn: 'Str tattoo', targetType: 'Small Strength' }),
    T({ dn: 'Dex tattoo', targetType: 'Small Dexterity' }),
    T({ dn: 'Any attribute', targetType: 'Small Attribute' }),
    T({ dn: 'Keystone tattoo', targetType: 'Keystone' }),
    T({ dn: 'Old one', targetType: 'Small Strength', legacy: true }),
    T({ dn: 'Needs links', targetType: 'Small Strength', minConnected: 3 }),
    T({ dn: 'Notable +30', targetType: 'Notable', targetValue: '+30 to Dexterity' }),
  ];
  const str = { name: 'Strength', type: 'Normal', firstStat: '+10 to Strength', linked: 2 };
  assert.deepEqual(tattoosFor(all, str, false).map((t) => t.dn), ['Any attribute', 'Str tattoo']);
  assert.deepEqual(tattoosFor(all, str, true).map((t) => t.dn), ['Any attribute', 'Old one', 'Str tattoo']);
  assert.deepEqual(tattoosFor(all, { ...str, linked: 3 }, false).map((t) => t.dn), ['Any attribute', 'Needs links', 'Str tattoo']);
  assert.deepEqual(tattoosFor(all, { name: 'Acrobatics', type: 'Keystone', firstStat: '', linked: 1 }, false).map((t) => t.dn), ['Keystone tattoo']);
  assert.deepEqual(tattoosFor(all, { name: 'Heart of the Warrior', type: 'Notable', firstStat: '+30 to Dexterity', linked: 2 }, false).map((t) => t.dn), ['Notable +30']);
});

test('which nodes can be right-clicked for a tattoo', () => {
  const base = { name: 'x', type: 'Normal', firstStat: '', linked: 1, tattooed: false };
  assert.ok(tattooEligible({ ...base, name: 'Dexterity' }));
  assert.ok(tattooEligible({ ...base, type: 'Keystone' }));
  assert.ok(tattooEligible({ ...base, name: 'Tattoo of the Ramako Scout', tattooed: true }));
  assert.ok(tattooEligible({ ...base, type: 'Notable', firstStat: '+30 to Strength' }));
  assert.ok(!tattooEligible({ ...base, type: 'Notable', firstStat: '10% increased Damage' }));
  assert.ok(tattooEligible({ ...base, type: 'Mastery', unallocatedMastery: true }), 'an unallocated mastery takes a runegraft');
  assert.ok(!tattooEligible({ ...base, type: 'Mastery' }), 'an allocated mastery opens the mastery dialog');
  assert.ok(!tattooEligible({ ...base, name: '10% increased Life' }));
});

const XML = `<PathOfBuilding>
\t<Tree activeSpec="1">
\t\t<Spec treeVersion="3_29" nodes="1,2">
\t\t\t<Sockets/>
\t\t</Spec>
\t\t<Spec treeVersion="3_29" nodes="3">
\t\t\t<Overrides>
\t\t\t\t<Override activeEffectImage="a.png" dn="Old" icon="b.png" nodeId="55">
\t\t\t\t\t+1 to something
\t\t\t\t</Override>
\t\t\t</Overrides>
\t\t</Spec>
\t</Tree>
</PathOfBuilding>`;

test('the count is per tree set and leaves runegrafts out', () => {
  assert.equal(tattooCount(XML, 1), 0);
  assert.equal(tattooCount(XML, 2), 1);
});

test('the Tattoo Count tooltip lists each distinct tattoo line with its multiplier, as the original does', () => {
  const n = (name: string, stats: string[], tattoo = true) => ({ name, stats, tattoo });
  const tip = tattooTooltip([
    n('Honoured Tattoo of the Dove', ['+4% to Chaos Resistance']),
    n('Honoured Tattoo of the Dove', ['+4% to Chaos Resistance', 'Limited to 1 Honoured Tattoo']),
    n('Tattoo of the Flock', ['1% increased effect of Auras', 'per Tribe']),
    n('Runegraft of the Warp', ['Something']),
    n('Conquered node', ['Not a tattoo'], false),
  ]);
  assert.equal(tip, '(2) +4% to Chaos Resistance\n(1) 1% increased effect of Auras per Tribe');
  assert.equal(countedTattoos([n('Runegraft of the Warp', []), n('Other', [])]).length, 1);
});
