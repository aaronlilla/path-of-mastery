import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Rule } from '../src/shared/lootfilter/types.js';
import { parseBlocks } from '../src/shared/lootfilter/blocks.js';
import { buildCatalog } from '../src/shared/lootfilter/catalog.js';
import { diffVersions } from '../src/shared/lootfilter/versionDiff.js';
import { NEVERSINK_DIR } from './lootfilterHelpers.js';

const OLD = readFileSync(join(NEVERSINK_DIR, '2-SEMI-STRICT.filter'), 'utf8');

/** The bundled file with a few tier moves, like a point release: one item moves down a tier, one is new, one tier gets another sound. */
export function newerVersion(text: string): string {
  const lines = text.split('\n');
  const at = (tier: string): number => lines.findIndex((l) => l.startsWith('Show') && l.includes('$type->currency') && l.includes(`$tier->${tier}`));
  const annul = at('t3annul');
  const chaos = at('t4chaos');
  assert.ok(annul > 0 && chaos > 0);
  const bt = (from: number): number => from + 1 + lines.slice(from + 1).findIndex((l) => l.trim().startsWith('BaseType =='));
  const a = bt(annul);
  const c = bt(chaos);
  lines[a] = lines[a]!.replace('"Orb of Annulment" ', '').replace('BaseType == ', 'BaseType == "Orb of Testing" ');
  lines[c] = lines[c]!.replace('BaseType == ', 'BaseType == "Orb of Annulment" ');
  for (let i = annul; i < annul + 12; i++) if (lines[i]!.includes('PlayAlertSound 2 300')) lines[i] = lines[i]!.replace('PlayAlertSound 2 300', 'PlayAlertSound 7 300');
  return lines.join('\n');
}

const cat = (t: string) => buildCatalog(parseBlocks(t).blocks);
const rule = (over: Partial<Rule> & { id: string }): Rule => ({ source: 'advanced', enabled: true, priority: 1, targets: [], ...over });

test('a point release is read as one new item, one tier move and one look change', () => {
  const d = diffVersions(cat(OLD), cat(newerVersion(OLD)), [], '8.21.0', 'Semi-Strict');
  const byId = new Map(d.changes.map((c) => [c.id, c]));
  assert.equal(byId.get('new:Orb of Testing')?.what, 'Orb of Testing added to B tier');
  assert.equal(byId.get('move:Orb of Annulment')?.what, 'Orb of Annulment moves from B to C');
  const look = d.changes.find((c) => c.kind === 'look');
  assert.equal(look?.what, 'Currency B tier: sound changed');
  assert.equal(d.counts.total, 3);
  assert.equal(d.counts.clean, 3);
  assert.equal(d.counts.conflicts, 0);
});

test('a change that touches something the player overrode is a conflict with the rule named', () => {
  const rules = [
    rule({ id: 'mine', name: 'Annulment, loud', visibility: 'show', targets: [{ conditions: [{ key: 'BaseType', op: '==', values: ['Orb of Annulment'] }] }] }),
    rule({ id: 'tier', name: 'Quieter B tier', targets: [{ tag: { type: 'currency', tier: 't3annul' } }], style: { sound: null } }),
    rule({ id: 'off', name: 'Switched off', enabled: false, targets: [{ conditions: [{ key: 'BaseType', op: '==', values: ['Orb of Annulment'] }] }] }),
  ];
  const d = diffVersions(cat(OLD), cat(newerVersion(OLD)), rules, '8.21.0', 'Semi-Strict');
  assert.equal(d.counts.conflicts, 2);
  assert.equal(d.counts.clean, 1);
  const move = d.conflicts.find((c) => c.id === 'move:Orb of Annulment')!;
  assert.deepEqual(move.rules.map((r) => r.id), ['mine']);
  assert.match(move.conflict!, /Annulment, loud/);
  const look = d.conflicts.find((c) => c.kind === 'look')!;
  assert.deepEqual(look.rules.map((r) => r.id), ['tier']);
});

test('a rule that restyles a tier the new file no longer has is listed with a choice', () => {
  const gone = OLD.replace(/\$tier->t4chaos/g, '$tier->t4chaosgone');
  const rules = [rule({ id: 'x', name: 'Chaos look', targets: [{ tag: { type: 'currency', tier: 't4chaos' } }], style: { fs: 40 } })];
  const d = diffVersions(cat(OLD), cat(gone), rules, '8.21.0', 'Semi-Strict');
  const row = d.conflicts.find((c) => c.id.startsWith('tag:x'));
  assert.ok(row, 'the rule is listed');
  assert.match(row.what, /tier is gone/);
});

test('two identical files have no changes', () => {
  const d = diffVersions(cat(OLD), cat(OLD), [rule({ id: 'a', targets: [{ tag: { type: 'currency', tier: 't4chaos' } }] })], '8.20.1d', 'Semi-Strict');
  assert.equal(d.counts.total, 0);
});
