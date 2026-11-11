import type { Known } from '@pom/mastery-contracts';
import type { Area } from '../shell/routes.js';

export type StarfieldMode = 'Full' | 'Calm' | 'Off';
export type StarfieldContext = { window: 'main'; area: Area } | { window: 'run' };
export type StarfieldInputs = {
  mode: StarfieldMode; context: StarfieldContext; focused: boolean; visible: boolean;
  gameActive: boolean; reducedMotion: boolean; modalOpen: boolean; dragging: boolean; fallback: boolean;
};
export type StarfieldPolicy = {
  mode: StarfieldMode; layers: 1 | 3; animate: boolean; hz: 0 | 15 | 30;
  particles: number; parallax: readonly [number, number, number]; twinkle: boolean;
};
export const STARFIELD_LIMITS = Object.freeze({ particles: 24, parallax: [3, 6, 9] as const, gameHz: 15 });
export function starfieldPolicy(input: StarfieldInputs): StarfieldPolicy {
  const off = input.mode === 'Off' || input.context.window === 'run' || input.reducedMotion || input.fallback;
  const mode = off ? 'Off' : input.gameActive ? 'Calm' : input.mode;
  const animate = !off && input.focused && input.visible && !input.modalOpen && !input.dragging;
  const calm = mode === 'Calm';
  return {
    mode, layers: off ? 1 : 3, animate, hz: animate ? calm ? 15 : 30 : 0,
    particles: animate ? calm ? 8 : STARFIELD_LIMITS.particles : 0,
    parallax: animate ? calm ? [1, 2, 3] : STARFIELD_LIMITS.parallax : [0, 0, 0],
    twinkle: animate,
  };
}

export function parallaxOffset(x: number, y: number, limit: number): { x: number; y: number } {
  const clamp = (n: number) => Number.isFinite(n) ? Math.max(-1, Math.min(1, n)) : 0;
  const bound = Number.isFinite(limit) ? Math.max(0, Math.min(9, limit)) : 0;
  const px = clamp(x), py = clamp(y), scale = bound / Math.max(1, Math.hypot(px, py));
  return { x: px * scale, y: py * scale };
}

export type RasterBudget = { maxWidth: number; maxHeight: number; maxDpr: number; maxTotalPixels: number };
export const DEFAULT_RASTER_BUDGET: RasterBudget = Object.freeze({ maxWidth: 2048, maxHeight: 1152, maxDpr: 1.5, maxTotalPixels: 6_000_000 });
export function rasterSize(width: number, height: number, dpr: number, layers: 1 | 3, budget = DEFAULT_RASTER_BUDGET) {
  const safe = (n: number, fallback = 1) => Number.isFinite(n) && n > 0 ? n : fallback;
  const ratio = Math.min(safe(dpr), safe(budget.maxDpr));
  const w = safe(width) * ratio, h = safe(height) * ratio;
  const scale = Math.min(1, safe(budget.maxWidth) / w, safe(budget.maxHeight) / h, Math.sqrt(safe(budget.maxTotalPixels) / (w * h * layers)));
  return { width: Math.max(1, Math.floor(w * scale)), height: Math.max(1, Math.floor(h * scale)) };
}

export type PerformanceSample = {
  baseline: 'tree-only'; machine: string; hardware: string; dpi: number; powerMode: string;
  intervalMs: number; sampledAt: string;
  baselineCpuPercentOneCore: Known<number>; cpuPercentOneCore: Known<number>;
  baselineGpuPercent: Known<number>; gpuPercent: Known<number>;
  baselineInputP95Ms: Known<number>; inputP95Ms: Known<number>;
  baselineTreePaintP95Ms: Known<number>; treePaintP95Ms: Known<number>;
};
export type PerformanceBudget = { frameP95Ms: number; inputDeltaMs: number; treePaintDeltaMs: number };
// Initial guard thresholds; to be checked against a tree-only baseline.
export const DEFAULT_PERFORMANCE_BUDGET: PerformanceBudget = Object.freeze({ frameP95Ms: 2, inputDeltaMs: 4, treePaintDeltaMs: 2 });
export type FallbackReason = 'cpu' | 'gpu' | 'input' | 'tree-paint' | 'frame' | 'canvas';
export function performanceFallback(sample: PerformanceSample, budget = DEFAULT_PERFORMANCE_BUDGET): FallbackReason | null {
  if (sample.baseline !== 'tree-only' || !sample.machine.trim() || !sample.hardware.trim() || !sample.powerMode.trim()
    || !Number.isFinite(sample.dpi) || sample.dpi <= 0 || !Number.isFinite(sample.intervalMs) || sample.intervalMs < 1000
    || !Number.isFinite(Date.parse(sample.sampledAt))) return null;
  const value = (n: Known<number>) => n.status === 'known' && Number.isFinite(n.value) && n.value >= 0 && n.evidenceId.trim() ? n.value : null;
  const delta = (current: Known<number>, baseline: Known<number>) => {
    const c = value(current), b = value(baseline); return c === null || b === null ? null : c - b;
  };
  const cpu = delta(sample.cpuPercentOneCore, sample.baselineCpuPercentOneCore);
  const gpu = delta(sample.gpuPercent, sample.baselineGpuPercent);
  const input = delta(sample.inputP95Ms, sample.baselineInputP95Ms);
  const paint = delta(sample.treePaintP95Ms, sample.baselineTreePaintP95Ms);
  if (cpu !== null && cpu >= 1) return 'cpu';
  if (gpu !== null && gpu >= 2) return 'gpu';
  if (input !== null && input > budget.inputDeltaMs) return 'input';
  if (paint !== null && paint > budget.treePaintDeltaMs) return 'tree-paint';
  return null;
}

export function frameFallback(durations: readonly number[], intervalMs: number, budget = DEFAULT_PERFORMANCE_BUDGET): FallbackReason | null {
  if (intervalMs < 5000 || durations.length < 30 || durations.some((n) => !Number.isFinite(n) || n < 0)) return null;
  const sorted = [...durations].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * .95) - 1]! > budget.frameP95Ms ? 'frame' : null;
}

export type FrameClock = { now: () => number; schedule: (callback: () => void, delayMs: number) => number; cancel: (id: number) => void };
// A single timer schedules actual backdrop updates, including the game-active 15 Hz cap.
export function startStarfieldLoop(clock: FrameClock, hz: 15 | 30, draw: (time: number) => void): () => void {
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    draw(clock.now());
    if (!stopped) timer = clock.schedule(tick, Math.ceil(1000 / hz));
  };
  let timer = clock.schedule(tick, Math.ceil(1000 / hz));
  return () => { stopped = true; clock.cancel(timer); };
}
