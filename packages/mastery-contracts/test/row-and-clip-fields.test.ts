import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as contracts from '../src/index.js';
import { bundle, limits, plan, publicPayload, step } from './fixtures/v1.js';

function passes<T>(schema: contracts.Schema<T>, value: unknown): T {
  const result = schema.parse(value, limits);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error('Expected a valid fixture.');
  return result.value;
}
function fails<T>(schema: contracts.Schema<T>, value: unknown): void {
  const result = schema.parse(value, limits);
  assert.equal(result.ok, false, 'Expected a rejection.');
}
const row = (extra: object = {}) => ({ catalogId: 'fixture-map', quantity: 1, provenance: [], price: { status: 'unknown' as const, reason: 'No observed price.' }, ...extra });

// An atlas-lane timeline built from the shared fixtures, with an optional point range on its clip.
function atlasTimeline(range?: unknown) {
  const timeline = structuredClone(bundle().timeline);
  const clip = timeline.clips[0]!;
  timeline.lanes[0]!.type = 'atlas';
  clip.options[0]!.source.fallbackSnapshot = { kind: 'atlas', payload: plan() };
  clip.options[0]!.actions = [];
  if (range !== undefined) (clip as { atlasPointRange?: unknown }).atlasPointRange = range;
  return timeline;
}

test('contract schema version stays 1 so old stamps and revisions remain readable', () => {
  assert.equal(contracts.SCHEMA_VERSION, 1);
  const old = plan(); // no tier, purpose or point range anywhere
  assert.equal(JSON.stringify(old).includes('"tier"'), false);
  passes(contracts.atlasPlanSchema, old);
  passes(contracts.timelineBundleSchema, bundle());
  fails(contracts.atlasPlanSchema, { ...plan(), schemaVersion: 2 });
});

test('PracticalRow accepts optional Tier and Purpose and round-trips them', () => {
  const value = step();
  value.maps = [row({ tier: 16, purpose: 'Boss farm' }), row({ catalogId: 'other-map' })] as never;
  const parsed = passes(contracts.atlasStepSchema, JSON.parse(JSON.stringify(value)));
  assert.equal(parsed.maps[0]!.tier, 16);
  assert.equal(parsed.maps[0]!.purpose, 'Boss farm');
  assert.equal(parsed.maps[1]!.tier, undefined);
  assert.equal(parsed.maps[1]!.purpose, undefined);
  assert.deepEqual(parsed.maps.map(m => m.catalogId), ['fixture-map', 'other-map'], 'row order (priority) is preserved');
  value.favouriteMaps = [row({ tier: 1, purpose: '' })] as never;
  passes(contracts.atlasStepSchema, value);
});

test('Tier must be a positive safe integer and Purpose must be text within bounds', () => {
  for (const tier of [0, -1, 1.5, '16', null, Number.NaN]) {
    const value = step(); value.maps = [row({ tier })] as never;
    fails(contracts.atlasStepSchema, value);
  }
  const bad = step(); bad.maps = [row({ purpose: 5 })] as never; fails(contracts.atlasStepSchema, bad);
  const long = step(); long.maps = [row({ purpose: 'x'.repeat(limits.maxStringLength + 1) })] as never; fails(contracts.atlasStepSchema, long);
  const extra = step(); extra.maps = [row({ priority: 3 })] as never; fails(contracts.atlasStepSchema, extra);
});

test('Clip atlasPointRange is optional, half-open and nonempty', () => {
  passes(contracts.timelineSchema, atlasTimeline());
  const parsed = passes(contracts.timelineSchema, atlasTimeline({ start: 0, endExclusive: 10 }));
  assert.deepEqual(parsed.clips[0]!.atlasPointRange, { start: 0, endExclusive: 10 });
  passes(contracts.timelineSchema, atlasTimeline({ start: 10, endExclusive: 123456 }));
  for (const range of [{ start: 5, endExclusive: 5 }, { start: 6, endExclusive: 5 }, { start: -1, endExclusive: 5 }, { start: 0.5, endExclusive: 5 },
    { start: 0 }, { start: 0, endExclusive: 5, extra: 1 }, null, 'x']) fails(contracts.timelineSchema, atlasTimeline(range));
});

test('atlasPointRange is rejected on a non-atlas lane', () => {
  const timeline = structuredClone(bundle().timeline);
  (timeline.clips[0] as { atlasPointRange?: unknown }).atlasPointRange = { start: 0, endExclusive: 10 };
  fails(contracts.timelineSchema, timeline);
  const withBundle = structuredClone(bundle());
  (withBundle.timeline.clips[0] as { atlasPointRange?: unknown }).atlasPointRange = { start: 0, endExclusive: 10 };
  fails(contracts.timelineBundleSchema, withBundle);
});

test('public sanitizer keeps the new declared fields and strips undeclared siblings', () => {
  const input = publicPayload();
  const atlas = plan();
  atlas.stepsById['fixture-step']!.maps = [row({ tier: 14, purpose: 'Currency', privateNote: 'secret-marker' })] as never;
  input.document = { kind: 'atlas', payload: atlas };
  const result = contracts.sanitizePublicPayload(input, limits);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok || result.value.document.kind !== 'atlas') return;
  const map = result.value.document.payload.stepsById['fixture-step']!.maps[0]!;
  assert.equal(map.tier, 14);
  assert.equal(map.purpose, 'Currency');
  assert.equal(JSON.stringify(result.value).includes('secret-marker'), false);

  const timelineInput = publicPayload();
  if (timelineInput.document.kind !== 'timeline') throw new Error('Expected a timeline fixture.');
  const timeline = atlasTimeline({ start: 0, endExclusive: 20 });
  const atlasBundle = structuredClone(bundle());
  atlasBundle.timeline = timeline;
  atlasBundle.dependencies[0]!.snapshot = { kind: 'atlas', payload: plan() };
  Object.assign(timeline.clips[0]!, { privateAnnotation: 'clip-secret' });
  timelineInput.document = { kind: 'timeline', payload: atlasBundle };
  const second = contracts.sanitizePublicPayload(timelineInput, limits);
  assert.equal(second.ok, true, JSON.stringify(second));
  if (!second.ok || second.value.document.kind !== 'timeline') return;
  assert.deepEqual(second.value.document.payload.timeline.clips[0]!.atlasPointRange, { start: 0, endExclusive: 20 });
  assert.equal(JSON.stringify(second.value).includes('clip-secret'), false);
});
