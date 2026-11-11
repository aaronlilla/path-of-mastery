import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RASTER_BUDGET, frameFallback, parallaxOffset, performanceFallback, rasterSize,
  starfieldPolicy, startStarfieldLoop, type PerformanceSample, type StarfieldInputs,
} from '../src/renderer/appearance/starfieldPolicy.js';

const normal: StarfieldInputs = { mode: 'Full', context: { window: 'main', area: 'atlas' }, focused: true, visible: true,
  gameActive: false, reducedMotion: false, modalOpen: false, dragging: false, fallback: false };
const known = (value: number) => ({ status: 'known' as const, value, evidenceId: 'synthetic-test-sample' });
const unknown = { status: 'unknown' as const, reason: 'No OS measurement' };
const sample = (): PerformanceSample => ({ baseline: 'tree-only', machine: 'synthetic', hardware: 'synthetic CPU/GPU', dpi: 96,
  powerMode: 'synthetic', intervalMs: 10000, sampledAt: '2026-10-11T00:00:00Z',
  baselineCpuPercentOneCore: known(5), cpuPercentOneCore: known(5.3), baselineGpuPercent: known(10), gpuPercent: known(11),
  baselineInputP95Ms: known(8), inputP95Ms: known(10), baselineTreePaintP95Ms: known(4), treePaintP95Ms: known(5) });

test('Full uses exactly three cached layers with bounded particles and parallax', () => {
  assert.deepEqual(starfieldPolicy(normal), { mode: 'Full', layers: 3, animate: true, hz: 30, particles: 24, parallax: [3, 6, 9], twinkle: true });
});
test('Calm is sparse and never exceeds 15 Hz', () => {
  const p = starfieldPolicy({ ...normal, mode: 'Calm' });
  assert.equal(p.hz, 15); assert.equal(p.particles, 8); assert.deepEqual(p.parallax, [1, 2, 3]);
});
test('game focus selects Calm unless the saved setting is Off', () => {
  for (const mode of ['Full', 'Calm', 'Off'] as const) {
    const p = starfieldPolicy({ ...normal, mode, gameActive: true });
    assert.equal(p.mode, mode === 'Off' ? 'Off' : 'Calm'); assert.ok(p.hz <= 15);
  }
});
test('Off, Run, reduced motion and fallback are one static layer without a loop', () => {
  for (const patch of [{ mode: 'Off' as const }, { context: { window: 'run' as const } }, { reducedMotion: true }, { fallback: true }]) {
    assert.deepEqual(starfieldPolicy({ ...normal, ...patch }), { mode: 'Off', layers: 1, animate: false, hz: 0, particles: 0, parallax: [0, 0, 0], twinkle: false });
  }
});
test('blur, hidden, modal and drag cancel every kind of movement', () => {
  for (const patch of [{ focused: false }, { visible: false }, { modalOpen: true }, { dragging: true }]) {
    const p = starfieldPolicy({ ...normal, ...patch });
    assert.equal(p.animate, false); assert.equal(p.hz, 0); assert.equal(p.particles, 0); assert.equal(p.twinkle, false);
    assert.deepEqual(p.parallax, [0, 0, 0]); assert.equal(p.layers, 3);
    assert.equal(starfieldPolicy(normal).animate, true);
  }
});
test('all six areas use the same policy without changing shell state', () => {
  for (const area of ['build', 'atlas', 'timelines', 'marketplace', 'wealth', 'filter'] as const) {
    assert.deepEqual(starfieldPolicy({ ...normal, context: { window: 'main', area } }), starfieldPolicy(normal));
  }
});
test('parallax clamps pointer overshoot and invalid values to the declared ceilings', () => {
  for (const limit of [3, 6, 9]) assert.deepEqual(parallaxOffset(50, 0, limit), { x: limit, y: 0 });
  assert.deepEqual(parallaxOffset(NaN, Infinity, 9), { x: 0, y: 0 });
  assert.deepEqual(parallaxOffset(1, 0, 100), { x: 9, y: 0 });
});
test('diagonal pointer movement cannot exceed the total 3/6/9px displacement', () => {
  for (const limit of [3, 6, 9]) for (const [x, y] of [[1, 1], [-1, -1], [80, -80]]) {
    const offset = parallaxOffset(x!, y!, limit);
    assert.ok(Math.hypot(offset.x, offset.y) <= limit + 1e-12);
  }
});
test('raster cache respects total pixels, dimension and DPR caps at high DPI', () => {
  for (const [w, h, dpr] of [[800, 600, 1], [1440, 900, 1.5], [7680, 4320, 4]]) for (const layers of [1, 3] as const) {
    const r = rasterSize(w!, h!, dpr!, layers);
    assert.ok(r.width <= DEFAULT_RASTER_BUDGET.maxWidth); assert.ok(r.height <= DEFAULT_RASTER_BUDGET.maxHeight);
    assert.ok(r.width * r.height * layers <= DEFAULT_RASTER_BUDGET.maxTotalPixels);
    assert.ok(r.width <= w! * Math.min(dpr!, DEFAULT_RASTER_BUDGET.maxDpr));
    assert.ok(Math.abs(r.width / r.height - w! / h!) < .01);
  }
});
test('invalid and zero viewport dimensions cannot allocate an unbounded cache', () => {
  for (const n of [0, -1, Infinity, NaN]) {
    const r = rasterSize(n, n, n, 3); assert.deepEqual(r, { width: 1, height: 1 });
  }
});
test('OS targets use baseline deltas and exact strict CPU/GPU ceilings', () => {
  assert.equal(performanceFallback(sample()), null);
  assert.equal(performanceFallback({ ...sample(), cpuPercentOneCore: known(6) }), 'cpu');
  assert.equal(performanceFallback({ ...sample(), gpuPercent: known(12) }), 'gpu');
  assert.equal(performanceFallback({ ...sample(), cpuPercentOneCore: known(4), gpuPercent: known(9) }), null);
});
test('input and tree paint regressions trigger auto-static independently', () => {
  assert.equal(performanceFallback({ ...sample(), inputP95Ms: known(12.01) }), 'input');
  assert.equal(performanceFallback({ ...sample(), treePaintP95Ms: known(6.01) }), 'tree-paint');
  assert.equal(performanceFallback({ ...sample(), inputP95Ms: known(12), treePaintP95Ms: known(6) }), null);
});
test('Unknown GPU and CPU stay unverified rather than becoming zero or passing evidence', () => {
  const s = { ...sample(), cpuPercentOneCore: unknown, gpuPercent: unknown };
  assert.equal(performanceFallback(s), null);
  assert.equal(performanceFallback({ ...s, inputP95Ms: known(20) }), 'input');
  assert.equal(performanceFallback({ ...sample(), baselineCpuPercentOneCore: unknown, cpuPercentOneCore: known(99) }), null);
});
test('missing metadata, short intervals and invalid measurements are not qualification', () => {
  for (const patch of [{ machine: '' }, { hardware: '' }, { powerMode: '' }, { intervalMs: 0 }, { intervalMs: NaN }, { dpi: NaN }, { sampledAt: 'invalid' }]) {
    assert.equal(performanceFallback({ ...sample(), cpuPercentOneCore: known(99), ...patch }), null);
  }
  for (const value of [NaN, Infinity, -1]) assert.equal(performanceFallback({ ...sample(), cpuPercentOneCore: known(value) }), null);
});
test('frame fallback waits for a five-second window and enough real samples', () => {
  assert.equal(frameFallback(Array(150).fill(3), 4999), null);
  assert.equal(frameFallback(Array(29).fill(3), 5000), null);
  assert.equal(frameFallback(Array(150).fill(3), 5000), 'frame');
  assert.equal(frameFallback(Array(150).fill(2), 5000), null);
  assert.equal(frameFallback([NaN, ...Array(150).fill(3)], 5000), null);
});
test('single slow outliers do not cause fallback, sustained p95 misses do', () => {
  assert.equal(frameFallback([...Array(99).fill(.1), 30], 5000), null);
  assert.equal(frameFallback([...Array(90).fill(.1), ...Array(10).fill(3)], 5000), 'frame');
});

function fakeClock() {
  let time = 0, nextId = 0;
  const pending = new Map<number, { cb: () => void; due: number }>();
  return { now: () => time, schedule: (cb: () => void, delay: number) => { const id = ++nextId; pending.set(id, { cb, due: time + delay }); return id; },
    cancel: (id: number) => { pending.delete(id); }, pending,
    advance: (ms: number) => { const end = time + ms; while (true) {
      const next = [...pending.entries()].sort((a, b) => a[1].due - b[1].due)[0];
      if (!next || next[1].due > end) break;
      time = next[1].due; pending.delete(next[0]); next[1].cb();
    } time = end; },
  };
}
test('game-active loop schedules at most 15 updates per second, with no RAF polling', () => {
  const clock = fakeClock(), times: number[] = [];
  const stop = startStarfieldLoop(clock, 15, (time) => times.push(time));
  clock.advance(1000); assert.equal(times.length, 14); assert.ok(times.every((t, i) => i === 0 || t - times[i - 1]! >= 1000 / 15));
  assert.equal(clock.pending.size, 1); stop(); assert.equal(clock.pending.size, 0);
  clock.advance(10000); assert.equal(times.length, 14);
});
test('cancelling inside a frame cannot reschedule a fallback or unfocused loop', () => {
  const clock = fakeClock(); let frames = 0;
  const stop = startStarfieldLoop(clock, 30, () => { frames++; stop(); });
  clock.advance(1000); assert.equal(frames, 1); assert.equal(clock.pending.size, 0); stop();
});
test('a cancelled queued callback is harmless even if delivered late', () => {
  const clock = fakeClock(); let frames = 0;
  const stop = startStarfieldLoop(clock, 30, () => { frames++; });
  const callback = [...clock.pending.values()][0]!.cb; stop(); callback();
  assert.equal(frames, 0); assert.equal(clock.pending.size, 0);
});
