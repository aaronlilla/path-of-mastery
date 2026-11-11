// Tree motion. Short light effects that play over the tree
// canvas after a change has already been drawn: the canvas is never repainted per frame for them. Each effect is a few
// pre-rendered sprites (rings, flares, motes) and SVG strokes in a DOM layer over the canvas, moved and faded with WAAPI
// (transform and opacity only, so the compositor runs them). The layer never takes input, every effect ends by itself in
// under about a second, and nothing loops. Panning or zooming carries the running effects along with the tree.
// Reduced motion (the OS setting or Options > Animations off): every effect is a 120 ms fade in place, no movement.

export type FxKind = 'add' | 'rem' | 'gold' | 'search';

export interface FxView {
  x: number;
  y: number;
  s: number;
}

/** What an effect needs to know about a node: its tree position and its on-screen radius at the moment the effect starts. */
export interface FxNode {
  id: number;
  x: number;
  y: number;
  /** Hit radius in tree units. */
  r: number;
  /** Size of the node's art in tree units. */
  size: number;
  /** Diameter of the node's frame art in tree units (what a ring has to hug). */
  d: number;
  /** 0 normal, 1 notable, 2 keystone, 3 mastery, 4 socket, 5/6 starts. */
  t: number;
  /** Same group and orbit as the node it is linked from: drawn as an arc round this centre. */
  arc?: { cx: number; cy: number };
}

/** One step of a ripple: the node and the node it was reached from (its segment draws from there). */
export interface FxStep {
  node: FxNode;
  from: FxNode | null;
  /** Ripple order (0 first). */
  step: number;
}

const COL: Record<FxKind, string> = { add: '111,206,90', rem: '224,82,63', gold: '240,192,96', search: '61,226,226' };
/** Space (px) between a node's frame and the ring round it. */
const RIM_GAP = 5;
const EASE_OUT = 'cubic-bezier(.16,1,.3,1)';
const SOFT = 'cubic-bezier(.4,0,.2,1)';
const EASE = 'cubic-bezier(.2,0,0,1)';
const EASE_IN = 'cubic-bezier(.4,0,1,1)';
// The design's springs (tokens.css) as linear() shapes; plain ease where linear() is not supported.
let SPRING_GLASS = 'linear(0, 0.047, 0.159, 0.299, 0.444, 0.58, 0.698, 0.795, 0.872, 0.929, 0.969, 0.996, 1.013, 1.022, 1.025, 1.025, 1.023, 1.019, 1.016, 1.012, 1.009, 1.006, 1.004, 1.002, 1)';
let SPRING_HEAVY = 'linear(0, 0.049, 0.161, 0.297, 0.435, 0.561, 0.67, 0.759, 0.83, 0.884, 0.925, 0.954, 0.974, 0.987, 0.996, 1.001, 1.004, 1.005, 1.005, 1.005, 1.004, 1.003, 1.003, 1.002, 1)';
let springsChecked = false;
function springs(): void {
  if (springsChecked) return;
  springsChecked = true;
  try {
    document.createElement('div').animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1, easing: SPRING_GLASS }).cancel();
  } catch {
    SPRING_GLASS = SPRING_HEAVY = EASE;
  }
}

/** The design's spring easings (tokens.css) for components outside the tree layer. */
export function springEase(kind: 'glass' | 'heavy'): string {
  springs();
  return kind === 'glass' ? SPRING_GLASS : SPRING_HEAVY;
}

/** Ripple step (design: 2 x stagger). */
export const STEP_MS = 48;
/** More changed nodes than this at once (a tree set switch, an import) play no ripple: it would be noise, not feedback. */
export const MAX_RIPPLE = 90;

export function reducedMotion(): boolean {
  if (document.documentElement.getAttribute('data-reduced-motion') === 'on') return true;
  return !!(matchMedia('(prefers-reduced-motion: reduce)').matches);
}

// ---- sprites: drawn once per colour into small images, then only moved and faded ----------------------------------------
type Sprites = { ring: string; sigil: string; flare: string; mote: string; glow: string };
const spriteCache = new Map<FxKind, Sprites>();
function draw(size: number, fn: (g: CanvasRenderingContext2D, m: number) => void): string {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  if (g) fn(g, size / 2);
  return c.toDataURL();
}
export function sprites(k: FxKind): Sprites {
  const hit = spriteCache.get(k);
  if (hit) return hit;
  const c = COL[k];
  const out: Sprites = {
    // A thin glowing ring at the sprite's edge (node outline and jewel radius).
    ring: draw(160, (g, m) => {
      g.shadowColor = `rgba(${c},1)`;
      g.shadowBlur = 10;
      g.strokeStyle = `rgba(${c},.95)`;
      g.lineWidth = 3;
      g.beginPath();
      g.arc(m, m, m - 12, 0, 7);
      g.stroke();
      g.shadowBlur = 0;
      g.lineWidth = 1.2;
      g.strokeStyle = 'rgba(255,250,235,.85)';
      g.beginPath();
      g.arc(m, m, m - 12, 0, 7);
      g.stroke();
    }),
    // The design's sweep sigil: a ring with ticks and three bright arcs.
    sigil: draw(192, (g, m) => {
      const gr = g.createRadialGradient(m, m, 0, m, m, m);
      gr.addColorStop(0, `rgba(${c},0)`);
      gr.addColorStop(0.5, `rgba(${c},.08)`);
      gr.addColorStop(0.68, `rgba(${c},.26)`);
      gr.addColorStop(0.8, `rgba(${c},0)`);
      g.fillStyle = gr;
      g.fillRect(0, 0, 2 * m, 2 * m);
      g.shadowColor = `rgba(${c},1)`;
      g.shadowBlur = 10;
      g.strokeStyle = `rgba(${c},.95)`;
      g.lineWidth = 2.2;
      g.beginPath();
      g.arc(m, m, 66, 0, 7);
      g.stroke();
      g.shadowBlur = 4;
      g.lineWidth = 1;
      g.strokeStyle = `rgba(${c},.55)`;
      g.beginPath();
      g.arc(m, m, 54, 0, 7);
      g.stroke();
      for (let i = 0; i < 48; i++) {
        const a = (i / 48) * Math.PI * 2;
        const l = i % 4 ? 3 : 7;
        g.strokeStyle = `rgba(${c},${i % 4 ? 0.5 : 0.95})`;
        g.lineWidth = i % 4 ? 1 : 1.6;
        g.beginPath();
        g.moveTo(m + Math.cos(a) * 57, m + Math.sin(a) * 57);
        g.lineTo(m + Math.cos(a) * (57 + l), m + Math.sin(a) * (57 + l));
        g.stroke();
      }
      g.shadowBlur = 12;
      g.lineWidth = 3;
      g.lineCap = 'round';
      g.strokeStyle = 'rgba(255,250,235,.95)';
      for (let i = 0; i < 3; i++) {
        const a = i * 2.094 - 0.35;
        g.beginPath();
        g.arc(m, m, 74, a, a + 0.7);
        g.stroke();
      }
    }),
    // A four-point star with a hot core.
    flare: draw(192, (g, m) => {
      const core = g.createRadialGradient(m, m, 0, m, m, 34);
      core.addColorStop(0, 'rgba(255,252,242,1)');
      core.addColorStop(0.25, `rgba(${c},.9)`);
      core.addColorStop(1, `rgba(${c},0)`);
      g.fillStyle = core;
      g.fillRect(0, 0, 2 * m, 2 * m);
      const streak = (rot: number, len: number, th: number, al: number) => {
        g.save();
        g.translate(m, m);
        g.rotate(rot);
        g.scale(1, th);
        const sg = g.createRadialGradient(0, 0, 0, 0, 0, len);
        sg.addColorStop(0, `rgba(255,252,242,${al})`);
        sg.addColorStop(0.3, `rgba(${c},${al * 0.7})`);
        sg.addColorStop(1, `rgba(${c},0)`);
        g.fillStyle = sg;
        g.beginPath();
        g.arc(0, 0, len, 0, 7);
        g.fill();
        g.restore();
      };
      streak(0, 96, 0.05, 1);
      streak(Math.PI / 2, 96, 0.05, 1);
      streak(Math.PI / 4, 50, 0.06, 0.6);
      streak(-Math.PI / 4, 50, 0.06, 0.6);
    }),
    mote: draw(32, (g, m) => {
      const gr = g.createRadialGradient(m, m, 0, m, m, m);
      gr.addColorStop(0, 'rgba(255,252,242,1)');
      gr.addColorStop(0.3, `rgba(${c},.9)`);
      gr.addColorStop(1, `rgba(${c},0)`);
      g.fillStyle = gr;
      g.fillRect(0, 0, 2 * m, 2 * m);
    }),
    // A soft disc of light (node bloom).
    glow: draw(128, (g, m) => {
      const gr = g.createRadialGradient(m, m, 0, m, m, m);
      gr.addColorStop(0, `rgba(${c},.75)`);
      gr.addColorStop(0.45, `rgba(${c},.28)`);
      gr.addColorStop(1, `rgba(${c},0)`);
      g.fillStyle = gr;
      g.fillRect(0, 0, 2 * m, 2 * m);
    }),
  };
  spriteCache.set(k, out);
  return out;
}

// ---- the layer ----------------------------------------------------------------------------------------------------------
interface Group {
  el: HTMLDivElement;
  view: FxView;
  anims: Animation[];
  /** Ends when the view moves (the sweep: its snapshot cannot follow a pan). */
  fixed: boolean;
  timer: number;
  /** Tree centre on screen when the group was made: positions are relative to it, so a resize while it plays must not move the rings. */
  cx: number;
  cy: number;
  /** Old-picture patches (removed when a newer change starts). */
  patches: HTMLElement[];
}

const SVG = 'http://www.w3.org/2000/svg';

export class TreeFx {
  /** Clips the effects to the part of the tree the panels leave free (so glass panels never re-blur over a running effect). */
  readonly clip: HTMLDivElement;
  private readonly inner: HTMLDivElement;
  private groups = new Set<Group>();
  private w = 0;
  private h = 0;
  private box: [number, number, number, number] = [0, 0, 0, 0];
  /** Counts effects started (tests and the capture script read it). */
  played = 0;

  constructor(host: HTMLElement) {
    springs();
    this.clip = document.createElement('div');
    this.clip.className = 'tree-fx';
    this.clip.setAttribute('aria-hidden', 'true');
    this.clip.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;overflow:hidden;pointer-events:none;contain:strict;z-index:1';
    this.inner = document.createElement('div');
    this.inner.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0';
    this.clip.appendChild(this.inner);
    host.appendChild(this.clip);
  }

  /** The tree's size, and the free area (host px) the effects may draw in. */
  layout(w: number, h: number, box: [number, number, number, number] | null): void {
    this.w = w;
    this.h = h;
    const b = box ?? [0, 0, w, h];
    this.box = b;
    this.clip.style.left = b[0] + 'px';
    this.clip.style.top = b[1] + 'px';
    this.clip.style.width = Math.max(0, b[2] - b[0]) + 'px';
    this.clip.style.height = Math.max(0, b[3] - b[1]) + 'px';
    this.clip.style.right = '';
    this.clip.style.bottom = '';
    this.inner.style.transform = `translate(${-b[0]}px,${-b[1]}px)`;
  }

  get busy(): boolean {
    return this.groups.size > 0;
  }

  /** Keeps running effects on the tree while the view pans and zooms (called after every paint). */
  follow(v: FxView): void {
    if (!this.groups.size) return;
    const cx = this.w / 2;
    const cy = this.h / 2;
    for (const g of [...this.groups]) {
      const k = v.s / g.view.s;
      const dx = (g.view.x - v.x) * v.s;
      const dy = (g.view.y - v.y) * v.s;
      if (g.fixed) {
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5 || Math.abs(k - 1) > 1e-3) this.endFixed(g);
        continue;
      }
      g.el.style.transform = Math.abs(dx) < 1e-3 && Math.abs(dy) < 1e-3 && Math.abs(k - 1) < 1e-6 && g.cx === cx && g.cy === cy ? '' : `translate(${cx + dx}px,${cy + dy}px) scale(${k}) translate(${-g.cx}px,${-g.cy}px)`;
    }
  }

  /** Stops every effect at once. */
  clear(): void {
    for (const g of [...this.groups]) this.drop(g);
  }

  destroy(): void {
    this.clear();
    this.clip.remove();
  }

  private group(view: FxView, life: number, fixed = false): Group {
    const el = document.createElement('div');
    el.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;transform-origin:0 0';
    this.inner.appendChild(el);
    const g: Group = { el, view: { ...view }, anims: [], fixed, timer: 0, cx: this.w / 2, cy: this.h / 2, patches: [] };
    g.timer = window.setTimeout(() => this.drop(g), life + 120);
    this.groups.add(g);
    this.played++;
    return g;
  }

  private drop(g: Group): void {
    if (!this.groups.delete(g)) return;
    clearTimeout(g.timer);
    for (const a of g.anims) a.cancel();
    g.el.remove();
  }

  /** The view moved under a fixed effect: it fades out over quick 160 and the final state shows (design rule). */
  private endFixed(g: Group): void {
    if (!g.fixed) return;
    g.fixed = false;
    const a = g.el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: EASE_IN, fill: 'forwards' });
    g.anims.push(a);
    a.onfinish = () => this.drop(g);
  }

  private go(g: Group, el: Element, kf: Keyframe[], o: KeyframeAnimationOptions): Animation {
    const a = el.animate(kf, { fill: 'both', ...o });
    g.anims.push(a);
    return a;
  }

  private sprite(g: Group, url: string, cx: number, cy: number, size: number, blend = true): HTMLSpanElement {
    const s = document.createElement('span');
    s.style.cssText = `position:absolute;left:${(cx - size / 2).toFixed(1)}px;top:${(cy - size / 2).toFixed(1)}px;width:${size.toFixed(1)}px;height:${size.toFixed(1)}px;background:url(${url}) center/100% 100% no-repeat;opacity:0;will-change:transform,opacity${blend ? ';mix-blend-mode:screen' : ''}`;
    g.el.appendChild(s);
    return s;
  }

  /** A thin ring (constant line width at every zoom) of outer diameter `d` px round (cx, cy), with a short glow that stays near it. */
  private rim(g: Group, kind: FxKind, cx: number, cy: number, d: number): HTMLSpanElement {
    const c = COL[kind];
    const s = document.createElement('span');
    s.style.cssText = `position:absolute;left:${(cx - d / 2).toFixed(1)}px;top:${(cy - d / 2).toFixed(1)}px;width:${d.toFixed(1)}px;height:${d.toFixed(1)}px;box-sizing:border-box;border-radius:50%;border:1.5px solid rgba(${c},.95);box-shadow:0 0 4px rgba(${c},.7);opacity:0;will-change:transform,opacity;mix-blend-mode:screen`;
    g.el.appendChild(s);
    return s;
  }

  /** The outer diameter (px) of a ring that hugs the node's frame: the frame plus a few px each side. */
  private hug(view: FxView, n: FxNode): number {
    return Math.max(18, n.d * view.s) + 2 * RIM_GAP;
  }

  private screen(view: FxView, x: number, y: number): [number, number] {
    return [(x - view.x) * view.s + this.w / 2, (y - view.y) * view.s + this.h / 2];
  }

  private visible(view: FxView, n: FxNode, pad = 60): boolean {
    const [x, y] = this.screen(view, n.x, n.y);
    const b = this.box;
    return x > b[0] - pad && y > b[1] - pad && x < b[2] + pad && y < b[3] + pad;
  }

  /** The node's on-screen radius, never smaller than a dot you can see. */
  private rad(view: FxView, n: FxNode): number {
    return Math.max(7, n.r * view.s);
  }

  /** An SVG path along the connector from `a` to `b` (an arc when both sit on one orbit), in screen px. */
  private segPath(view: FxView, a: FxNode, b: FxNode): string {
    const [x1, y1] = this.screen(view, a.x, a.y);
    const [x2, y2] = this.screen(view, b.x, b.y);
    if (b.arc) {
      const r = Math.hypot(a.x - b.arc.cx, a.y - b.arc.cy) * view.s;
      const [cx, cy] = this.screen(view, b.arc.cx, b.arc.cy);
      const cross = (x1 - cx) * (y2 - cy) - (y1 - cy) * (x2 - cx);
      return `M${x1.toFixed(1)} ${y1.toFixed(1)}A${r.toFixed(1)} ${r.toFixed(1)} 0 0 ${cross > 0 ? 1 : 0} ${x2.toFixed(1)} ${y2.toFixed(1)}`;
    }
    return `M${x1.toFixed(1)} ${y1.toFixed(1)}L${x2.toFixed(1)} ${y2.toFixed(1)}`;
  }

  /**
   * Moment 04, allocation ripple: the new path lights one node at a time from the tree you already have. Each step 48 ms;
   * the segment into a node draws in over quick 160 in travel direction, and the node pops (0.6 -> 1.25 -> 1, smooth 260)
   * 100 ms after its segment starts, then the light fades. Notables and keystones get a larger sigil and rising motes.
   * Refund (`kind` 'rem'): the cut-off nodes flash red and fade (quick 160), farthest first, same step.
   */
  ripple(view: FxView, steps: FxStep[], kind: 'add' | 'rem', old?: { img: HTMLCanvasElement; k: number } | null): void {
    if (!steps.length || !this.w) return;
    const red = reducedMotion();
    // A newer change replaces what the old picture showed: earlier patches go at once.
    for (const g of this.groups) for (const p of g.patches) p.remove();
    if (old) {
      // The canvas already shows the new tree. Patches of the old picture cover each changed node and the segment into it,
      // and fade one step at a time, so the change is uncovered in ripple order without repainting the canvas.
      const byStep = new Map<number, FxStep[]>();
      for (const s of steps) {
        const k2 = red ? 0 : s.step;
        let a = byStep.get(k2);
        if (!a) byStep.set(k2, (a = []));
        a.push(s);
      }
      const pg = this.group(view, red ? 260 : (steps.reduce((m, s) => Math.max(m, s.step), 0) + 1) * STEP_MS + 420);
      for (const [st, items] of byStep) {
        const el = this.patch(view, old, items);
        if (!el) continue;
        pg.el.appendChild(el);
        pg.patches.push(el);
        this.go(pg, el, [{ opacity: 1 }, { opacity: 0 }], { duration: red ? 120 : 160, delay: red ? 0 : st * STEP_MS + (kind === 'add' ? 70 : 0), easing: EASE });
      }
    }
    const k: FxKind = kind === 'add' ? 'gold' : 'rem';
    const spr = sprites(k);
    const last = steps.reduce((m, s) => Math.max(m, s.step), 0);
    const life = red ? 260 : last * STEP_MS + 760;
    const g = this.group(view, life);
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('width', String(this.w));
    svg.setAttribute('height', String(this.h));
    svg.style.cssText = 'position:absolute;left:0;top:0;overflow:visible;mix-blend-mode:screen';
    g.el.appendChild(svg);
    const lw = Math.max(2, Math.min(9, 10 * view.s));
    const t0 = document.timeline.currentTime as number | null;
    for (const s of steps) {
      if (!this.visible(view, s.node, 200) && (!s.from || !this.visible(view, s.from, 200))) continue;
      const q = red ? 0 : s.step * STEP_MS;
      // segment
      if (s.from) {
        const d = this.segPath(view, s.from, s.node);
        const mk = (w: number, stroke: string) => {
          const p = document.createElementNS(SVG, 'path');
          p.setAttribute('d', d);
          p.setAttribute('fill', 'none');
          p.setAttribute('stroke', stroke);
          p.setAttribute('stroke-width', w.toFixed(1));
          p.setAttribute('stroke-linecap', 'round');
          p.setAttribute('pathLength', '1');
          p.setAttribute('stroke-dasharray', '1 1');
          p.style.opacity = '0';
          svg.appendChild(p);
          return p;
        };
        const halo = mk(lw * 2.6, `rgba(${COL[k]},.32)`);
        const core = mk(Math.max(1.2, lw * 0.7), kind === 'add' ? 'rgba(255,246,220,.95)' : `rgba(${COL[k]},.95)`);
        for (const p of [halo, core]) {
          if (red) {
            p.setAttribute('stroke-dasharray', 'none');
            this.go(g, p, [{ opacity: 0 }, { opacity: 0.9, offset: 0.5 }, { opacity: 0 }], { duration: 240 });
          } else if (kind === 'add') {
            // Draws in toward the new node, holds, fades.
            this.go(g, p, [{ strokeDashoffset: 1, opacity: 1, easing: EASE }, { strokeDashoffset: 0, opacity: 1, offset: 0.3, easing: 'linear' }, { strokeDashoffset: 0, opacity: 0.85, offset: 0.45, easing: EASE_IN }, { strokeDashoffset: 0, opacity: 0 }], { duration: 540, delay: q });
          } else {
            p.setAttribute('stroke-dasharray', 'none');
            this.go(g, p, [{ opacity: 0 }, { opacity: 1, offset: 0.25 }, { opacity: 0 }], { duration: 420, delay: q, easing: EASE });
          }
        }
      }
      // node
      const [x, y] = this.screen(view, s.node.x, s.node.y);
      const r = this.rad(view, s.node);
      const big = s.node.t === 1 || s.node.t === 2 || s.node.t === 4;
      const D = this.hug(view, s.node);
      const ring = this.rim(g, k, x, y, D);
      const glow = this.sprite(g, spr.glow, x, y, D * 1.3);
      if (red) {
        for (const el of [ring, glow]) this.go(g, el, [{ opacity: 0 }, { opacity: 0.85, offset: 0.5 }, { opacity: 0 }], { duration: 240 });
        continue;
      }
      const qn = q + (s.from ? 100 : 0);
      if (kind === 'add') {
        this.go(g, ring, [{ opacity: 0, transform: 'scale(.8)', easing: SPRING_GLASS }, { opacity: 1, transform: 'scale(1.1)', offset: 0.3, easing: SOFT }, { opacity: 0.9, transform: 'scale(1)', offset: 0.5, easing: EASE_IN }, { opacity: 0, transform: 'scale(1.04)' }], { duration: 620, delay: qn });
        this.go(g, glow, [{ opacity: 0, transform: 'scale(.5)', easing: EASE_OUT }, { opacity: 1, transform: 'scale(1)', offset: 0.35, easing: SOFT }, { opacity: 0, transform: 'scale(1.1)' }], { duration: 560, delay: qn });
        if (big) {
          const fl = this.sprite(g, spr.flare, x, y, D * (s.node.t === 2 ? 2.2 : 1.8));
          this.go(g, fl, [{ opacity: 0, transform: 'scale(.2) rotate(0deg)', easing: EASE_OUT }, { opacity: 1, transform: 'scale(1) rotate(12deg)', offset: 0.18, easing: SOFT }, { opacity: 0, transform: 'scale(.6) rotate(40deg)' }], { duration: 560, delay: qn });
          let seed = (s.node.id * 16807) % 2147483647 || 7;
          const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
          for (let i = 0; i < (s.node.t === 2 ? 8 : 5); i++) {
            const ang = -Math.PI / 2 + (rnd() - 0.5) * 2.4;
            const dist = D * (0.6 + rnd() * 0.8);
            const sz = 4 + rnd() * 5;
            const m = this.sprite(g, spr.mote, x, y, sz);
            const dx = Math.cos(ang) * dist;
            const dy = Math.sin(ang) * dist - r * 0.8;
            this.go(g, m, [{ opacity: 0, transform: 'translate(0,0)', easing: 'linear' }, { opacity: 1, transform: `translate(${(dx * 0.25).toFixed(1)}px,${(dy * 0.25).toFixed(1)}px)`, offset: 0.15, easing: EASE_OUT }, { opacity: 0, transform: `translate(${dx.toFixed(1)}px,${dy.toFixed(1)}px) scale(.3)` }], { duration: 620 + rnd() * 240, delay: qn + 30 + rnd() * 60 });
          }
        }
      } else {
        this.go(g, ring, [{ opacity: 0, transform: 'scale(1.12)', easing: EASE_OUT }, { opacity: 1, transform: 'scale(1)', offset: 0.25, easing: EASE_IN }, { opacity: 0, transform: 'scale(.85)' }], { duration: 420, delay: qn });
        this.go(g, glow, [{ opacity: 0 }, { opacity: 0.9, offset: 0.2, easing: EASE_IN }, { opacity: 0 }], { duration: 400, delay: qn });
      }
    }
    // One timeline tick for every animation in the moment, so the layers stay locked together.
    if (t0 !== null) for (const a of g.anims) a.startTime = t0 + 16;
  }

  /** A canvas holding the old picture under the given nodes and their segments only (everything else transparent). */
  private patch(view: FxView, old: { img: HTMLCanvasElement; k: number }, items: FxStep[]): HTMLCanvasElement | null {
    const lw = Math.max(4, 30 * view.s);
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const grow = (x: number, y: number, p: number) => {
      x0 = Math.min(x0, x - p);
      y0 = Math.min(y0, y - p);
      x1 = Math.max(x1, x + p);
      y1 = Math.max(y1, y + p);
    };
    const shapes: Array<(g: CanvasRenderingContext2D) => void> = [];
    for (const s of items) {
      const [x, y] = this.screen(view, s.node.x, s.node.y);
      const r = Math.max(4, s.node.size * 0.62 * view.s);
      grow(x, y, r + 2);
      shapes.push((g) => {
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.fill();
      });
      if (!s.from) continue;
      const [fx, fy] = this.screen(view, s.from.x, s.from.y);
      if (s.node.arc) {
        const [cx, cy] = this.screen(view, s.node.arc.cx, s.node.arc.cy);
        const R = Math.hypot(fx - cx, fy - cy);
        const a1 = Math.atan2(fy - cy, fx - cx);
        let da = Math.atan2(y - cy, x - cx) - a1;
        while (da > Math.PI) da -= 2 * Math.PI;
        while (da < -Math.PI) da += 2 * Math.PI;
        for (let i = 0; i <= 8; i++) grow(cx + Math.cos(a1 + (da * i) / 8) * R, cy + Math.sin(a1 + (da * i) / 8) * R, lw);
        shapes.push((g) => {
          g.beginPath();
          g.arc(cx, cy, R, a1, a1 + da, da < 0);
          g.stroke();
        });
      } else {
        grow(fx, fy, lw);
        shapes.push((g) => {
          g.beginPath();
          g.moveTo(fx, fy);
          g.lineTo(x, y);
          g.stroke();
        });
      }
    }
    x0 = Math.max(0, Math.floor(x0));
    y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(this.w, Math.ceil(x1));
    y1 = Math.min(this.h, Math.ceil(y1));
    if (x1 - x0 < 1 || y1 - y0 < 1) return null;
    const k = old.k;
    const W = Math.round((x1 - x0) * k);
    const H = Math.round((y1 - y0) * k);
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d');
    const m = document.createElement('canvas');
    m.width = W;
    m.height = H;
    const mg = m.getContext('2d');
    if (!g || !mg) return null;
    g.drawImage(old.img, x0 * k, y0 * k, W, H, 0, 0, W, H);
    mg.setTransform(k, 0, 0, k, -x0 * k, -y0 * k);
    mg.fillStyle = '#000';
    mg.strokeStyle = '#000';
    mg.lineWidth = lw;
    mg.lineCap = 'round';
    for (const f of shapes) f(mg);
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(m, 0, 0);
    m.width = 0;
    m.height = 0;
    c.style.cssText = `position:absolute;left:${x0}px;top:${y0}px;width:${x1 - x0}px;height:${y1 - y0}px;will-change:opacity`;
    return c;
  }

  /**
   * A single node lights up: a mastery effect chosen or swapped, a tattoo, a jewel socketed. The sigil grows out and turns
   * (glide 420 · heavy), a flare and a soft bloom under it.
   */
  bloom(view: FxView, n: FxNode, kind: FxKind = 'gold'): void {
    if (!this.w || !this.visible(view, n, 80)) return;
    const red = reducedMotion();
    const spr = sprites(kind);
    const g = this.group(view, red ? 260 : 900);
    const [x, y] = this.screen(view, n.x, n.y);
    const r = this.rad(view, n);
    const D = this.hug(view, n);
    const sig = this.sprite(g, spr.sigil, x, y, D * 1.45);
    const glow = this.sprite(g, spr.glow, x, y, D * 1.3);
    if (red) {
      for (const el of [sig, glow]) this.go(g, el, [{ opacity: 0 }, { opacity: 0.85, offset: 0.5 }, { opacity: 0 }], { duration: 240 });
      return;
    }
    const fl = this.sprite(g, spr.flare, x, y, D * 1.8);
    this.go(g, sig, [{ opacity: 0, transform: 'scale(.5) rotate(-40deg)', easing: SPRING_HEAVY }, { opacity: 1, transform: 'scale(1) rotate(0deg)', offset: 0.45, easing: SOFT }, { opacity: 0, transform: 'scale(1.3) rotate(40deg)' }], { duration: 860 });
    this.go(g, glow, [{ opacity: 0, transform: 'scale(.4)', easing: EASE_OUT }, { opacity: 1, transform: 'scale(1)', offset: 0.3, easing: SOFT }, { opacity: 0, transform: 'scale(1.15)' }], { duration: 760 });
    this.go(g, fl, [{ opacity: 0, transform: 'scale(.2) rotate(0deg)', easing: EASE_OUT }, { opacity: 1, transform: 'scale(1) rotate(12deg)', offset: 0.18, easing: SOFT }, { opacity: 0, transform: 'scale(.6) rotate(45deg)' }], { duration: 600, delay: 60 });
  }

  /** A ring pulses out from a node (class or ascendancy start after a pick: scale 1 -> 2.1, fades, smooth 260 + fade). */
  pulse(view: FxView, n: FxNode, kind: FxKind = 'gold'): void {
    if (!this.w || !this.visible(view, n, 120)) return;
    const red = reducedMotion();
    const spr = sprites(kind);
    const g = this.group(view, red ? 260 : 900);
    const [x, y] = this.screen(view, n.x, n.y);
    // A start node is small on screen: size the effect from at least a 16 px radius so the ring reads as a ring, not a hairline.
    const r = Math.max(16, this.rad(view, n));
    const ring = this.sprite(g, spr.ring, x, y, r * 3.2);
    const glow = this.sprite(g, spr.glow, x, y, r * 6);
    const sig = this.sprite(g, spr.sigil, x, y, r * 4.6);
    if (red) {
      for (const el of [ring, glow]) this.go(g, el, [{ opacity: 0 }, { opacity: 0.85, offset: 0.5 }, { opacity: 0 }], { duration: 240 });
      return;
    }
    this.go(g, ring, [{ opacity: 1, transform: 'scale(1)', easing: EASE_OUT }, { opacity: 0, transform: 'scale(2.4)' }], { duration: 780 });
    this.go(g, sig, [{ opacity: 0, transform: 'scale(.6) rotate(-30deg)', easing: SPRING_HEAVY }, { opacity: 1, transform: 'scale(1) rotate(0deg)', offset: 0.4, easing: SOFT }, { opacity: 0, transform: 'scale(1.25) rotate(25deg)' }], { duration: 780 });
    this.go(g, glow, [{ opacity: 0, transform: 'scale(.6)', easing: SPRING_GLASS }, { opacity: 0.9, transform: 'scale(1)', offset: 0.35, easing: SOFT }, { opacity: 0 }], { duration: 760 });
  }

  /**
   * A jewel's radius opens round its socket: the ring grows from the socket out to the radius (glide 420 · heavy) and
   * fades as the drawn radius takes over.
   */
  radius(view: FxView, n: FxNode, outer: number): void {
    if (!this.w) return;
    const red = reducedMotion();
    const spr = sprites('gold');
    const g = this.group(view, red ? 260 : 1000);
    const [x, y] = this.screen(view, n.x, n.y);
    const R = outer * view.s;
    const ring = this.sprite(g, spr.ring, x, y, R * 2 * (160 / 136));
    if (red) {
      this.go(g, ring, [{ opacity: 0 }, { opacity: 0.85, offset: 0.5 }, { opacity: 0 }], { duration: 240 });
      return;
    }
    this.go(g, ring, [{ opacity: 0, transform: 'scale(.12)', easing: SPRING_HEAVY }, { opacity: 1, transform: 'scale(1)', offset: 0.5, easing: SOFT }, { opacity: 0, transform: 'scale(1.02)' }], { duration: 900 });
    const glow = this.sprite(g, spr.glow, x, y, Math.max(40, this.rad(view, n) * 4));
    this.go(g, glow, [{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 0 }], { duration: 600 });
  }

  /** Search: each new match on screen gets one ring that settles onto it (1.8 -> 1, glide 420), then the drawn ring stays. */
  ping(view: FxView, nodes: FxNode[]): void {
    if (!this.w || !nodes.length) return;
    const red = reducedMotion();
    const spr = sprites('search');
    const vis = nodes.filter((n) => this.visible(view, n, 0)).slice(0, 160);
    if (!vis.length) return;
    const g = this.group(view, red ? 260 : 700);
    vis.forEach((n, i) => {
      const [x, y] = this.screen(view, n.x, n.y);
      const r = Math.max(8, n.r * 1.35 * view.s);
      const ring = this.sprite(g, spr.ring, x, y, r * 2 * (160 / 136));
      if (red) this.go(g, ring, [{ opacity: 0 }, { opacity: 0.8, offset: 0.5 }, { opacity: 0 }], { duration: 240 });
      else this.go(g, ring, [{ opacity: 0, transform: 'scale(1.8)', easing: EASE_OUT }, { opacity: 1, transform: 'scale(1)', offset: 0.6, easing: EASE_IN }, { opacity: 0, transform: 'scale(1)' }], { duration: 560, delay: Math.min(i, 8) * 12 });
    });
  }

  /**
   * Moment 05, the optimize sweep, on a snapshot of the old picture: a beam crosses the free area left to right in 840 ms
   * (linear) and uncovers the new tree; each changed node sparks as the beam edge reaches it. Any pan or zoom ends it
   * (160 ms fade). `snap` is the old frame at host size.
   */
  sweep(view: FxView, snap: HTMLCanvasElement, nodes: Array<{ n: FxNode; k: 'add' | 'rem' | null }>): Promise<void> {
    if (!this.w) return Promise.resolve();
    const red = reducedMotion();
    const D = 840;
    const g = this.group(view, red ? 160 : D + 900, true);
    const [bx0, by0, bx1, by1] = this.box;
    const W = bx1 - bx0;
    snap.style.cssText = `position:absolute;left:0;top:0;width:${this.w}px;height:${this.h}px;will-change:transform`;
    const outer = document.createElement('div');
    outer.style.cssText = `position:absolute;left:${bx0}px;top:0;height:${this.h}px;overflow:hidden;will-change:transform`;
    const holder = document.createElement('div');
    holder.style.cssText = `position:absolute;left:${-bx0}px;top:0`;
    holder.appendChild(snap);
    outer.appendChild(holder);
    g.el.appendChild(outer);
    return new Promise((res) => {
      const done = () => res();
      if (red) {
        outer.style.width = W + 'px';
        const a = this.go(g, outer, [{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: 'ease' });
        a.onfinish = done;
        a.oncancel = done;
        return;
      }
      const PAD = 60;
      const X0 = -PAD;
      const X1 = W + PAD;
      outer.style.width = W + 2 * PAD + 'px';
      // The old picture is uncovered at the beam edge: outer moves right, its content left by the same amount.
      this.go(g, outer, [{ transform: `translateX(${X0}px)` }, { transform: `translateX(${X1}px)` }], { duration: D, easing: 'linear' });
      this.go(g, holder, [{ transform: `translateX(${-X0}px)` }, { transform: `translateX(${-X1}px)` }], { duration: D, easing: 'linear' });
      const BW = 280;
      const beam = document.createElement('div');
      beam.style.cssText = `position:absolute;left:${bx0}px;top:${by0}px;width:${BW}px;height:${by1 - by0}px;will-change:transform,opacity;mix-blend-mode:screen;-webkit-mask-image:linear-gradient(180deg,transparent,#000 12%,#000 88%,transparent);mask-image:linear-gradient(180deg,transparent,#000 12%,#000 88%,transparent)`;
      beam.innerHTML =
        '<span style="position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(var(--accent-rgb,232,196,106),.05) 45%,rgba(var(--accent-rgb,232,196,106),.15) 86%,rgba(var(--line-rgb,255,240,210),.30))"></span>' +
        '<span style="position:absolute;inset:0;background:repeating-linear-gradient(90deg,transparent 0 11px,rgba(var(--line-rgb,255,240,210),.09) 11px 12px);-webkit-mask-image:linear-gradient(90deg,transparent,#000);mask-image:linear-gradient(90deg,transparent,#000)"></span>' +
        '<span style="position:absolute;right:-18px;top:0;bottom:0;width:36px;background:radial-gradient(50% 50% at 50% 50%,rgba(var(--line-rgb,255,240,210),.28),transparent)"></span>' +
        '<span style="position:absolute;right:-1px;top:0;bottom:0;width:2px;background:var(--gold-50,#fff6e0);box-shadow:0 0 8px 2px rgba(var(--line-rgb,255,240,210),.9),0 0 28px 8px rgba(var(--accent-rgb,232,196,106),.35)"></span>';
      g.el.appendChild(beam);
      const bxq = (q: number) => `translateX(${(X0 + (X1 - X0) * q - BW).toFixed(1)}px)`;
      const b = this.go(g, beam, [{ transform: bxq(0), opacity: 0 }, { transform: bxq(0.08), opacity: 1, offset: 0.08 }, { transform: bxq(0.92), opacity: 1, offset: 0.92 }, { transform: bxq(1), opacity: 0 }], { duration: D, easing: 'linear' });
      const at = (x: number) => Math.max(0, Math.min(1, (x - bx0 - X0) / (X1 - X0))) * D;
      let seed = 7;
      const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      let sparks = 0;
      for (const { n, k } of nodes) {
        if (n.t === 3 || n.t === 5 || n.t === 6 || !this.visible(view, n, 30)) continue;
        if (!k && ++sparks > 220) continue; // unchanged glints are decoration: cap them on huge builds
        const [x, y] = this.screen(view, n.x, n.y);
        const r = this.rad(view, n);
        const q = at(x);
        if (!k) {
          const f = this.sprite(g, sprites('gold').flare, x, y, r * 4.2);
          this.go(g, f, [{ opacity: 0, transform: 'scale(.3) rotate(0deg)', easing: EASE_OUT }, { opacity: 0.55, transform: 'scale(1) rotate(20deg)', offset: 0.22, easing: SOFT }, { opacity: 0, transform: 'scale(.7) rotate(45deg)' }], { duration: 480, delay: q });
          continue;
        }
        const spr = sprites(k);
        const up = k === 'add';
        const sig = this.sprite(g, spr.sigil, x, y, r * 3.4);
        this.go(
          g,
          sig,
          up
            ? [{ opacity: 0, transform: 'scale(.5) rotate(-40deg)', easing: EASE_OUT }, { opacity: 1, transform: 'scale(1) rotate(0deg)', offset: 0.3, easing: SOFT }, { opacity: 0, transform: 'scale(1.45) rotate(50deg)' }]
            : [{ opacity: 0, transform: 'scale(1.5) rotate(40deg)', easing: EASE_OUT }, { opacity: 1, transform: 'scale(1) rotate(0deg)', offset: 0.3, easing: SOFT }, { opacity: 0, transform: 'scale(.55) rotate(-60deg)' }],
          { duration: 760, delay: q },
        );
        const fl = this.sprite(g, spr.flare, x, y, r * 5.2);
        this.go(g, fl, [{ opacity: 0, transform: 'scale(.2) rotate(0deg)', easing: EASE_OUT }, { opacity: 1, transform: 'scale(1) rotate(12deg)', offset: 0.16, easing: SOFT }, { opacity: 0, transform: 'scale(.6) rotate(45deg)' }], { duration: 560, delay: q });
        for (let i = 0; i < 6; i++) {
          const ang = up ? -Math.PI / 2 + (rnd() - 0.5) * 2.4 : Math.PI / 2 + (rnd() - 0.5) * 2.8;
          const dist = r * (1.6 + rnd() * 1.8);
          const sz = 5 + rnd() * 5;
          const m = this.sprite(g, spr.mote, x, y, sz);
          const dx = Math.cos(ang) * dist;
          const dy = Math.sin(ang) * dist + (up ? -r * 0.8 : r * 1.2);
          this.go(g, m, [{ opacity: 0, transform: 'translate(0,0) scale(1)', easing: 'linear' }, { opacity: 1, transform: `translate(${(dx * 0.25).toFixed(1)}px,${(dy * 0.25).toFixed(1)}px) scale(1)`, offset: 0.15, easing: EASE_OUT }, { opacity: 0, transform: `translate(${dx.toFixed(1)}px,${dy.toFixed(1)}px) scale(.3)` }], { duration: 640 + rnd() * 260, delay: q + 30 + rnd() * 60 });
        }
      }
      const t0 = document.timeline.currentTime as number | null;
      if (t0 !== null) for (const a of g.anims) a.startTime = t0 + 16;
      b.onfinish = done;
      b.oncancel = done;
    });
  }
}
