// Label text must stay readable under every theme and scope: no rule may draw its text and its background
// in the same or a near-same colour. Contrast is computed per written block, against the block's own background.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateFilter } from '../src/shared/lootfilter/generate.js';
import { blockStyle, parseBlocks } from '../src/shared/lootfilter/blocks.js';
import { STRICTNESS, STYLES, contrast } from '../src/shared/lootfilter/styles.js';
import { themeScopeOfType } from '../src/shared/lootfilter/sections.js';
import type { Block } from '../src/shared/lootfilter/types.js';
import { NEVERSINK_DIR } from './lootfilterHelpers.js';

const NOW = new Date('2026-09-30T12:00:00Z');
const MIN = 3;
const text = readFileSync(join(NEVERSINK_DIR, STRICTNESS[2]!.file), 'utf8');
const gen = (o: { style?: number; styleCurrency?: number; styleGear?: number }) =>
  generateFilter({ baseText: text, baseVersion: '8.20.1d', strictness: 2, style: o.style ?? 0, ...(o.styleCurrency !== undefined ? { styleCurrency: o.styleCurrency } : {}), ...(o.styleGear !== undefined ? { styleGear: o.styleGear } : {}), rules: [], now: NOW });

const baseBlocks = parseBlocks(text).blocks;
function madeBlocks(out: string): Block[] {
  const made = parseBlocks(out).blocks.filter((b) => !b.ruleId);
  return made.slice(made.length - baseBlocks.length);
}
/** Contrast of a block's text over its background, or undefined when it sets no text colour or is hidden. */
function ratio(b: Block): number | undefined {
  if (b.kind === 'Hide') return undefined;
  const s = blockStyle(b);
  if (!s.fg || !s.bg) return undefined;
  if ((s.bg[3] ?? 255) < 60) return undefined;
  return contrast(s.fg, s.bg);
}

const BASE = madeBlocks(gen({}).text);

/** Blocks that are unreadable under a theme although they were readable in NeverSink's own colours. */
function broken(out: string, scope: 'all' | 'currency' | 'gear'): string[] {
  const made = madeBlocks(out);
  const bad: string[] = [];
  made.forEach((b, i) => {
    const sc = themeScopeOfType(baseBlocks[i]!.tag?.type);
    if (scope !== 'all' && sc !== scope) return;
    const r = ratio(b);
    const was = ratio(BASE[i]!);
    if (r === undefined) return;
    if (r < MIN && (was === undefined || was >= MIN)) bad.push(`line ${baseBlocks[i]!.line} ${baseBlocks[i]!.tag?.type}/${baseBlocks[i]!.tag?.tier}: ${r.toFixed(2)}:1 (NeverSink ${was === undefined ? 'n/a' : was.toFixed(2)}:1)`);
  });
  return bad;
}

for (const [i, st] of STYLES.entries()) {
  test(`theme ${st.name}: no label under ${MIN}:1 that NeverSink had readable (whole filter)`, () => {
    const bad = broken(gen({ style: i }).text, 'all');
    assert.deepEqual(bad.slice(0, 8), [], `${bad.length} unreadable labels`);
  });
  test(`theme ${st.name}: currency scope and gear scope stay readable`, () => {
    assert.deepEqual(broken(gen({ styleCurrency: i }).text, 'currency').slice(0, 8), []);
    assert.deepEqual(broken(gen({ styleGear: i }).text, 'gear').slice(0, 8), []);
  });
}
