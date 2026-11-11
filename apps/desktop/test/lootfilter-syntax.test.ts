import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { validateFilter, tokenize, MAX_FILTER_BYTES } from '../src/shared/lootfilter/syntax.js';
import { STRICTNESS } from '../src/shared/lootfilter/styles.js';
import { NEVERSINK_DIR } from './lootfilterHelpers.js';

function codes(text: string): string[] {
  return validateFilter(text).issues.map((i) => `${i.severity}:${i.code}`);
}

test('the checker accepts all seven NeverSink 8.20.1d files with zero errors', () => {
  for (const s of STRICTNESS) {
    const text = readFileSync(join(NEVERSINK_DIR, s.file), 'utf8');
    const r = validateFilter(text);
    const errs = r.issues.filter((i) => i.severity === 'error').slice(0, 5);
    assert.equal(r.errors, 0, `${s.file}: ${JSON.stringify(errs)}`);
    assert.ok(r.blocks > 400, `${s.file} has ${r.blocks} blocks`);
  }
});

test('the NeverSink folder holds the licence beside the files', () => {
  assert.ok(readdirSync(NEVERSINK_DIR).includes('LICENSE'));
  assert.match(readFileSync(join(NEVERSINK_DIR, 'LICENSE'), 'utf8'), /MIT License/);
});

test('specimens: each kind of broken line is caught', () => {
  assert.deepEqual(codes('Show\n\tSetFontSize 99\n'), ['error:bad-value']);
  assert.deepEqual(codes('Show\n\tSetFontSize 0\n'), ['error:bad-value']);
  assert.deepEqual(codes('Show\n\tSetTextColor 255 0\n'), ['error:bad-value']);
  assert.deepEqual(codes('Show\n\tSetTextColor 256 0 0\n'), ['error:bad-value']);
  assert.deepEqual(codes('Show\n\tPlayAlertSound 17 100\n'), ['error:bad-value']);
  assert.deepEqual(codes('Show\n\tPlayAlertSound 3 301\n'), ['error:bad-value']);
  assert.deepEqual(codes('Show\n\tMinimapIcon 3 Red Star\n'), ['error:bad-value']);
  assert.deepEqual(codes('Show\n\tMinimapIcon 1 Teal Star\n'), ['error:bad-value']);
  assert.deepEqual(codes('Show\n\tMinimapIcon 1 Red Blob\n'), ['error:bad-value']);
  assert.deepEqual(codes('Show\n\tPlayEffect Red Perm\n'), ['error:bad-value']);
  assert.deepEqual(codes('Show\n\tFrobnicate 3\n'), ['error:unknown-keyword']);
  assert.deepEqual(codes('SetFontSize 30\n'), ['error:outside-block']);
  assert.deepEqual(codes('Show\n\tBaseType "Chaos Orb\n'), ['error:unterminated-string']);
  assert.deepEqual(codes('Show\n\tRarity Mythic\n'), ['error:bad-value']);
  assert.deepEqual(codes('Show\n\tItemLevel >= abc\n'), ['error:bad-value']);
  assert.deepEqual(codes('Show\n\tCorrupted Maybe\n'), ['error:bad-value']);
  assert.deepEqual(codes('Show\n\tWaystoneTier >= 10\n'), ['error:poe2-only']);
  assert.deepEqual(codes('Show extra\n'), ['error:block-extra']);
  assert.deepEqual(codes('Minimal\n\tBaseType "x"\n'), ['warning:ruthless-only']);
  assert.deepEqual(codes('Show\n\tContinue 1\n'), ['error:bad-value']);
});

test('specimens: valid lines pass, including the awkward ones', () => {
  const ok = [
    'Show # %D8 $type->x $tier->y',
    '\tClass == "Body Armours" Gloves',
    '\tBaseType == "Chaos Orb" "Divine Orb"',
    '\tRarity Normal Magic',
    '\tRarity > Magic',
    '\tItemLevel >= 84',
    '\tHasExplicitMod >=2 "Of Haast" "of Tzteosh"',
    '\tHasExplicitMod >= 2 "x"',
    '\tHasExplicitMod =0 "x"',
    '\tSockets >= 5GGG',
    '\tLinkedSockets 6',
    '\tHasInfluence Shaper Elder',
    '\tCorrupted False',
    '\tIdentified True',
    '\tStackSize >= 5',
    '\tSetBackgroundColor 255 255 255',
    '\tSetBackgroundColor 255 255 255 120',
    '\tPlayAlertSound None',
    '\tPlayAlertSound 3 150',
    '\tPlayAlertSoundPositional 16 50',
    '\tCustomAlertSound "Map.mp3" 100',
    '\tCustomAlertSoundOptional "Map.mp3"',
    '\tMinimapIcon -1',
    '\tMinimapIcon 2 Cyan Diamond',
    '\tPlayEffect None',
    '\tPlayEffect Red Temp',
    '\tDisableDropSound',
    '\tContinue',
    '',
    'Hide # c',
    '\tBaseType "Scroll of Wisdom"',
    'Import "MyRules.filter" Optional',
  ].join('\n');
  const r = validateFilter(ok);
  assert.deepEqual(r.issues, []);
});

test('a file over 1 MB is an error', () => {
  const big = 'Show\n' + '\tBaseType "x"\n'.repeat(Math.ceil(MAX_FILTER_BYTES / 13) + 10);
  assert.ok(codes(big).includes('error:too-big'));
});

test('tokenizer keeps quoted strings whole and stops at comments', () => {
  const t = tokenize('\tBaseType == "Chaos Orb" "Divine" # comment "x"');
  assert.deepEqual(
    t.tokens.map((x) => x.text),
    ['BaseType', '==', 'Chaos Orb', 'Divine'],
  );
});
