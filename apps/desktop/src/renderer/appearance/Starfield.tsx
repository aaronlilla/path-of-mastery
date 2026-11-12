import { useEffect, useLayoutEffect, useRef } from 'react';
import {
  DEFAULT_PERFORMANCE_BUDGET, DEFAULT_RASTER_BUDGET, frameFallback, parallaxOffset, performanceFallback,
  rasterSize, starfieldPolicy, startStarfieldLoop,
  type FallbackReason, type PerformanceBudget, type PerformanceSample, type RasterBudget,
  type StarfieldContext, type StarfieldMode, type StarfieldPolicy,
} from './starfieldPolicy.js';
import './starfield.css';
import { tr } from '../i18n';

export type StarfieldDiagnostics = { policy: StarfieldPolicy; fallback: FallbackReason | null; updates: number; cachedPixels: number; frameP95Ms: number | null };
export type StarfieldProps = {
  mode: StarfieldMode; context: StarfieldContext; gameActive?: boolean; modalOpen?: boolean; dragging?: boolean;
  reducedMotion?: boolean; rasterBudget?: RasterBudget; performanceBudget?: PerformanceBudget;
  performanceSample?: PerformanceSample; onDiagnostics?: (sample: StarfieldDiagnostics) => void;
};

function random(seed: number) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}
function cacheStars(canvas: HTMLCanvasElement, index: number, single: boolean): boolean {
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  const rng = random(8317 + index * 173);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const count = single ? 310 : [170, 90, 50][index]!;
  for (let i = 0; i < count; i++) {
    const x = rng() * canvas.width, y = rng() * canvas.height;
    const radius = (.35 + rng() * (index === 2 ? 1 : .6)) * Math.min(canvas.width / 1440, 1.5);
    ctx.fillStyle = `rgba(181,201,230,${.18 + rng() * .55})`;
    ctx.beginPath(); ctx.arc(x, y, Math.max(.3, radius), 0, Math.PI * 2); ctx.fill();
    if (i % 29 === 0) {
      const glow = ctx.createRadialGradient(x, y, 0, x, y, radius * 5);
      glow.addColorStop(0, '#b5c9e622'); glow.addColorStop(1, '#b5c9e600');
      ctx.fillStyle = glow; ctx.fillRect(x - radius * 5, y - radius * 5, radius * 10, radius * 10);
    }
  }
  return true;
}

/** Mount behind the shell panels. The shell supplies game, dialog and editor-drag state. */
export function Starfield(props: StarfieldProps) {
  const root = useRef<HTMLDivElement>(null);
  const latest = useRef(props); latest.current = props;
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const canvases = Array.from(element.querySelectorAll('canvas'));
    const particles = Array.from(element.querySelectorAll<HTMLElement>('.mastery-starfield__particle'));
    const motion = window.matchMedia(tr('appearance_Starfield.prefers_reduced_motion_reduce'));
    let fallback: FallbackReason | null = null, updates = 0, pixels = 0, p95: number | null = null;
    let focused = document.hasFocus(), visible = document.visibilityState === 'visible';
    let pointer = { x: 0, y: 0 }, width = window.innerWidth, height = window.innerHeight;
    let policy: StarfieldPolicy, stop: (() => void) | undefined, cacheKey = '', disposed = false;
    let durations: number[] = [], sampleStart = performance.now();
    const particleSeeds = Array.from({ length: 24 }, (_, i) => {
      const rng = random(719 + i * 71); return { x: rng(), y: rng(), speed: .000001 + rng() * .000002, opacity: .08 + rng() * .12 };
    });
    const report = () => latest.current.onDiagnostics?.({ policy, fallback, updates, cachedPixels: pixels, frameP95Ms: p95 });
    const paintCache = () => {
      const size = rasterSize(width + 20, height + 20, window.devicePixelRatio, policy.layers, latest.current.rasterBudget ?? DEFAULT_RASTER_BUDGET);
      const key = `${size.width}:${size.height}:${policy.layers}`;
      if (key === cacheKey) return;
      cacheKey = key; pixels = 0;
      canvases.forEach((canvas, index) => {
        const enabled = index < policy.layers;
        canvas.hidden = !enabled;
        // Zero dimensions release the raster backing stores on fallback and unmount.
        canvas.width = enabled ? size.width : 0; canvas.height = enabled ? size.height : 0;
        if (enabled) { pixels += size.width * size.height; if (!cacheStars(canvas, index, policy.layers === 1)) fallback = 'canvas'; }
      });
    };
    const draw = (time: number) => {
      const start = performance.now();
      canvases.forEach((canvas, i) => {
        if (canvas.hidden) return;
        const offset = parallaxOffset(pointer.x, pointer.y, policy.parallax[i]!);
        canvas.style.transform = `translate3d(${offset.x}px,${offset.y}px,0)`;
        canvas.style.opacity = String(.72 + Math.sin(time / (8000 + i * 3100) + i * 2) * .055);
      });
      particles.forEach((particle, i) => {
        if (i >= policy.particles) return;
        const seed = particleSeeds[i]!;
        const y = ((seed.y - time * seed.speed) % 1 + 1) % 1;
        particle.style.transform = `translate3d(${seed.x * width}px,${y * height}px,0)`;
        particle.style.opacity = String(seed.opacity * Math.min(1, y * 12, (1 - y) * 12));
        particle.hidden = false;
      });
      updates++;
      durations.push(performance.now() - start);
      if (time - sampleStart >= 5000) {
        const sorted = [...durations].sort((a, b) => a - b);
        p95 = sorted[Math.ceil(sorted.length * .95) - 1] ?? null;
        fallback = frameFallback(durations, time - sampleStart, latest.current.performanceBudget ?? DEFAULT_PERFORMANCE_BUDGET);
        durations = []; sampleStart = time;
        if (fallback) apply(); else report();
      }
    };
    const apply = () => {
      if (disposed) return;
      stop?.(); stop = undefined;
      const p = latest.current;
      if (p.performanceSample) fallback ??= performanceFallback(p.performanceSample, p.performanceBudget);
      policy = starfieldPolicy({ mode: p.mode, context: p.context, focused, visible, gameActive: p.gameActive ?? false,
        reducedMotion: motion.matches || (p.reducedMotion ?? false), modalOpen: p.modalOpen ?? false, dragging: p.dragging ?? false, fallback: fallback !== null });
      paintCache();
      if (fallback && policy.layers !== 1) {
        policy = starfieldPolicy({ mode: 'Off', context: p.context, focused, visible, gameActive: false, reducedMotion: false, modalOpen: false, dragging: false, fallback: true });
        paintCache();
      }
      element.dataset.mode = policy.mode; element.dataset.animated = String(policy.animate);
      element.dataset.fallback = fallback ?? '';
      canvases.forEach((canvas) => { canvas.style.transform = ''; canvas.style.opacity = ''; });
      particles.forEach((particle) => { particle.hidden = true; });
      durations = []; sampleStart = performance.now();
      if (policy.animate && policy.hz !== 0) stop = startStarfieldLoop({ now: () => performance.now(), schedule: (cb, delay) => window.setTimeout(cb, delay), cancel: (id) => window.clearTimeout(id) }, policy.hz, draw);
      report();
    };
    const onFocus = () => { focused = true; apply(); };
    const onBlur = () => { focused = false; pointer = { x: 0, y: 0 }; apply(); };
    const onVisibility = () => { visible = document.visibilityState === 'visible'; apply(); };
    const onResize = () => { width = window.innerWidth; height = window.innerHeight; apply(); };
    const onPointer = (event: PointerEvent) => { if (policy.animate) pointer = { x: event.clientX / Math.max(1, width) * 2 - 1, y: event.clientY / Math.max(1, height) * 2 - 1 }; };
    const onLeave = () => { pointer = { x: 0, y: 0 }; };
    window.addEventListener('focus', onFocus); window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility); window.addEventListener('resize', onResize);
    window.addEventListener('pointermove', onPointer, { passive: true }); document.addEventListener('pointerleave', onLeave);
    motion.addEventListener('change', apply);
    refresh.current = apply; apply();
    return () => {
      disposed = true; stop?.(); refresh.current = () => {};
      window.removeEventListener('focus', onFocus); window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility); window.removeEventListener('resize', onResize);
      window.removeEventListener('pointermove', onPointer); document.removeEventListener('pointerleave', onLeave);
      motion.removeEventListener('change', apply);
      canvases.forEach((canvas) => { canvas.width = 0; canvas.height = 0; });
    };
  }, []);
  useLayoutEffect(() => refresh.current(), [props.mode, props.context.window, props.gameActive, props.modalOpen, props.dragging, props.reducedMotion, props.rasterBudget, props.performanceBudget, props.performanceSample]);
  return <div ref={root} className="mastery-starfield" aria-hidden="true" data-animated="false">
    {[0, 1, 2].map((i) => <canvas key={i} className="mastery-starfield__layer" />)}
    {Array.from({ length: 24 }, (_, i) => <i key={i} className="mastery-starfield__particle" hidden />)}
  </div>;
}
