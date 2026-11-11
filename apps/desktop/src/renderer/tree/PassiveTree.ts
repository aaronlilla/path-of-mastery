// WebGL2 passive tree renderer. Replaces both of the older renderers (the first port of upstream's Lua view and the
// design's Canvas 2D tree component): same component interface as the design's, upstream's draw rules (PassiveTreeView.lua),
// upstream's sprite sheets, everything batched into instanced quads. It draws only when something changes.
//
//   const tree = new PassiveTree(hostElement, { base: '/tree/3_29/' });
//   await tree.ready;
//   tree.setState(engineTreeState);           // what the engine's `treeState` returns
//   hostElement.addEventListener('nodehover', (e) => ...);
//
// Events (CustomEvent on the host, bubbling and composed): treeready, nodehover, nodeleave, nodeclick, allocchange,
// masteryclick. See each dispatch below.

import {
  CONN_STATES,
  NODE_ASCEND_START,
  NODE_CLASS_START,
  NODE_KEYSTONE,
  NODE_MASTERY,
  NODE_NORMAL,
  NODE_NOTABLE,
  NODE_SOCKET,
  SPRITE_HALF,
  buildExtension,
  buildTree,
  packExtraSprites,
  dependents,
  findPath,
  makeGraph,
  type BuiltTree,
  type ConnState,
  type Connector,
  type ExtraPlacement,
  type Extension,
  type Graph,
  type TNode,
  type TreeData,
} from './treeLayout.js';
import { compileSearch } from './treeSearch.js';
import { isDrag, nodeClickPlan } from './treeClick.js';
import { clampView, type Bounds } from './viewClamp.js';
import type { JewelInfo, TreeState } from './treeTypes.js';
import { TreeFx, MAX_RIPPLE, reducedMotion, type FxNode, type FxStep } from './treeFx.js';
import { QuadBatch, SpriteBatch, packColor } from './glBatch.js';
import { acquireSheet, addTreeGLUser, fitSurface, liveTreeTextures, removeTreeGLUser, treeGL, type TreeGL, type TreeGLUser } from './glShared.js';

export interface PassiveTreeOptions {
  /** Directory holding tree.json and the sprite sheets (default '/tree/3_29/'). */
  base?: string;
  /** Initial framing: around the allocated nodes, or the whole tree. */
  fit?: 'alloc' | 'all';
  /** Frame exactly these nodes instead (the compare view frames both builds' allocated nodes together). */
  frame?: Iterable<number>;
  /** Multiplier on the fitted scale. */
  zoom?: number;
  /** Never fit smaller than this scale: a build spread over the whole tree is framed round its middle at this scale instead. */
  minFitScale?: number;
  /** Smallest half-width of the framed box in tree units (default 3600; 0 frames the nodes exactly). */
  minSpan?: number;
  /** Fixed screen scale (css px per tree unit); overrides fit. */
  scale?: number;
  /** Centre on the class start instead of the fitted box. */
  center?: 'start';
  dx?: number;
  dy?: number;
  /** false: no hover, click or drag (thumbnails). */
  interactive?: boolean;
  /** Search ring colour. */
  searchColor?: string;
  /** Emit `masteryclick` instead of toggling an unallocated mastery (the host draws the effect chooser). */
  masteryPicker?: boolean;
  /** Apply clicks to the local allocation (the design's behaviour). Turn off when the engine owns the allocation. */
  autoApply?: boolean;
  /** Pixels at each edge the host covers with panels; the first framing fits inside what is left. */
  insets?: { left: number; top: number; right: number; bottom: number };
  /** Cap on the device pixel ratio the canvas renders at. */
  maxDpr?: number;
  background?: string;
  /** Tree data instead of fetching tree.json from base. */
  data?: TreeData;
}

export interface NodeSummary {
  id: number;
  t: number;
  /** Name and stat lines (short keys n and s). */
  n: string;
  s: string[];
  x: number;
  y: number;
  a?: string;
  /** Mastery effects: [effect id, stat lines]. */
  me?: Array<{ e: number; s: string[] }>;
}

export interface FrameStats {
  paintMs: number;
  rebuildMs: number;
  instances: number;
  quads: number;
  drawCalls: number;
}

type Rgba = [number, number, number, number];

const FLAG_SIZE = 1 << 17;
const SEARCH_TYPE = ['Normal', 'Notable', 'Keystone', 'Mastery', 'Socket', 'ClassStart', 'AscendClassStart'];

interface PNode {
  n: TNode;
  /** Frame sprite for the states allocated, path, unallocated (-1: none). */
  fr: Int32Array;
  /** 1 class start, 2 ascendancy start. */
  special: number;
  ovSpr: number;
}

/** A rectangle in tree units: x0, y0, x1, y1. */
type Box = [number, number, number, number];

interface PConn {
  c: Connector;
  /** Sprite for Normal, Intermediate, Active. */
  spr: Int32Array;
  /** Long lines: the tiles, 9 numbers each (4 corners, tile length). */
  tile: number[] | null;
}
const WHITE = packColor(1, 1, 1, 1);
const RED: Rgba = [1, 0, 0, 1];
const GREEN: Rgba = [0, 1, 0, 1];
const BLUE: Rgba = [0, 0, 1, 1];

const RING_REST_MS = 250;
/** Longer than a sweeping pointer stays on any one node (measured at most 137 ms at 350 px/s). A node's path and tooltip wait this long, so a sweep blinks neither. */
export const HOVER_REST_MS = 140;
const NO_NODES = new Set<number>();
const L_GROUP = 0;
const L_EFFECT = 1;
const L_ICON = 2;
const L_FRAME = 3;
const L_RING = 4;
const L_SEARCH = 5;
const LAYERS = 6;

const TIMELESS_RINGS: Array<[RegExp, string]> = [
  [/^Brutal Restraint/, 'Maraketh'],
  [/^Elegant Hubris/, 'EternalEmpire'],
  [/^Glorious Vanity/, 'Vaal'],
  [/^Lethal Pride/, 'Karui'],
  [/^Militant Faith/, 'Templar'],
  [/^Heroic Tragedy/, 'Kalguur'],
];

const hexColor = (h: string): Rgba => {
  const s = h.replace('#', '');
  return [parseInt(s.slice(0, 2), 16) / 255, parseInt(s.slice(2, 4), 16) / 255, parseInt(s.slice(4, 6), 16) / 255, 1];
};

/** The search highlight colour on the tree canvas as #rrggbb: the player's "Highlighted nodes" setting (`--highlight`), cyan by default as in the prototype. */
export function searchHighlightHex(el: Element): string {
  const v = getComputedStyle(el).getPropertyValue('--highlight').trim();
  return /^#[0-9a-f]{6}$/i.test(v) ? v : '#3de2e2';
}

/** Node Power: the least a node's art is multiplied by (upstream goes to pure black; this keeps no-power nodes readable). */
const HEAT_FLOOR = 0.1;

export class PassiveTree implements TreeGLUser {
  readonly host: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly ready: Promise<void>;
  opts: PassiveTreeOptions;

  // data
  data!: TreeData;
  tree!: BuiltTree;
  ext: Extension = { nodes: [], byId: new Map(), subgraphs: [], connectors: [], links: [] };
  graph!: Graph;
  state: TreeState | null = null;
  alloc = new Set<number>();
  masteries = new Map<number, number>();
  jewels = new Map<number, number>();
  jewelInfo = new Map<number, JewelInfo>();
  overrides = new Map<number, { name: string; stats: string[]; text: string; tattoo?: boolean; conquered?: boolean; abyss?: boolean }>();
  power: Map<number, { offence: number; defence: number }> | null = null;
  /** The compared build's allocation (green: only there, red: only here). */
  compareAlloc: Set<number> | null = null;
  compareMasteries: Map<number, number> | null = null;
  compareJewels: Map<number, number> | null = null;
  private _overlay: { added?: number[]; removed?: number[]; ringsOnly?: boolean } | null = null;
  private _search = '';
  private _heat = false;
  /** Node Power colouring: one stat (a single colour channel) or offence and defence; the player's colour theme. */
  heatSingle = false;
  heatTheme: 'red-blue' | 'red-green' | 'green-blue' = 'red-blue';
  private matchSet = new Set<number>();

  // view
  view = { x: 0, y: 0, s: 0.05 };
  w = 0;
  h = 0;
  dpr = 1;
  private touched = false;

  // interaction
  hover: TNode | null = null;
  path: number[] = [];
  private pathSet = new Set<number>();
  private depSet = new Set<number>();
  private hoverRadius: Array<{ inner2: number; outer2: number; col: Rgba; packed: number; css: string }> | null = null;
  /** Waits for the pointer to rest on a socket before its radius shows, so sweeping past never flashes the rings. */
  private ringTimer = 0;
  private ringLayer: SVGSVGElement | null = null;
  /** The node's path and dependents are worked out at once (a click uses them) but drawn only once the pointer stays. */
  private pathHeld = false;
  private pathTimer = 0;
  /** A jewel radius drawn round a socket on request (the Items tab's radius viewer). */
  private radiusPreview: { socket: number; title: string; label: string; index?: number | null } | null = null;

  // drawing (the context and programs are shared by every tree: glShared.ts)
  private shared: TreeGL | null = null;
  private gl!: WebGL2RenderingContext;
  private spriteProg!: WebGLProgram;
  private quadProg!: WebGLProgram;
  private bgProg!: WebGLProgram;
  private cornerBuf!: WebGLBuffer;
  private indexBuf!: WebGLBuffer;
  private bgVao!: WebGLVertexArrayObject;
  private textures: Array<WebGLTexture | null> = [];
  /** Releases for the shared sheet textures this tree holds (called on destroy). */
  private sheetHolds: Array<() => void> = [];
  private base = '';
  private atlas: ExtraPlacement[] = [];
  private ctx2d: CanvasRenderingContext2D;
  /**
   * The part of the view the panels leave free, as its own canvas over the full one. Glass panels blur what is under
   * them again every frame that changes anything under them; a hover only redraws this canvas, so the full canvas under
   * the panels stays still and the panels are not filtered again. Null without panel insets.
   */
  private mid: HTMLCanvasElement | null = null;
  private midCtx: CanvasRenderingContext2D | null = null;
  /** The middle canvas in device pixels of the full canvas, and in host CSS pixels. */
  private midRect: { x: number; y: number; w: number; h: number; css: Box } | null = null;
  /** The next paint must update the full canvas (anything but a hover inside the middle canvas). */
  private needFull = true;
  /** Where the hover drawn last changed the picture (tree units). */
  private shownHoverBox: Box | null = null;
  /** The largest half size of any node art, in tree units (the margin round a node a hover can repaint). */
  private nodePad = 0;
  private connBox: Float32Array = new Float32Array(0);
  private connsOf = new Map<number, number[]>();
  private loaded: boolean[] = [];
  private procSheet = -1;
  private spU!: Float32Array;
  private spH!: Float32Array;
  private spSheet!: Int32Array;
  private staticBatches: SpriteBatch[][] = [];
  private dynBatches: Map<number, SpriteBatch>[] = [];
  private quads = new Map<number, QuadBatch>();
  private staticDirty = true;
  private dynDirty = true;
  private version = 0;
  private staticVersion = 0;
  private raf = 0;
  private destroyed = false;
  private ro?: ResizeObserver;
  private lastStats: FrameStats = { paintMs: 0, rebuildMs: 0, instances: 0, quads: 0, drawCalls: 0 };
  /** Benchmarks set this to wait for the GPU (gl.finish) after each paint. */
  syncAfterPaint = false;
  /** Textures created and not yet deleted, over every tree in the page (a version switch must leave only the new tree's). */
  static get liveTextures(): number {
    return liveTreeTextures();
  }

  // hit testing
  private grid = new Map<number, TNode[]>();
  private readonly cell = 400;

  /** Short light effects over the canvas (allocate ripple, bloom, sweep...); null for non-interactive trees. */
  private fx: TreeFx | null = null;
  private curAsc: string | undefined;
  private curAsc2: string | undefined;
  private classStartId = -1;

  constructor(host: HTMLElement, opts: PassiveTreeOptions = {}) {
    this.host = host;
    this.opts = { fit: 'alloc', zoom: 1, interactive: true, autoApply: true, maxDpr: 2, ...opts };
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none';
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.style.overflow = 'hidden';
    host.appendChild(this.canvas);
    this.ctx2d = this.canvas.getContext('2d', { alpha: false })!;
    this.ready = this.init();
  }

  // -----------------------------------------------------------------------------------------------------------
  // setup

  private async init(): Promise<void> {
    // Registered first: a tree made while the context is lost starts blank and draws once contextRestored arrives.
    addTreeGLUser(this);
    const t = treeGL();
    if (t) this.bindShared(t);
    this.resetBatches(null);

    const base = (this.base = this.opts.base ?? 'tree/3_29/');
    this.data = this.opts.data ?? ((await (await fetch(base + 'tree.json')).json()) as TreeData);
    if (this.destroyed) return;
    this.atlas = packExtraSprites(this.data);
    this.tree = buildTree(this.data);
    this.graph = makeGraph(this.tree, this.ext);
    this.prepareSprites();
    this.procSheet = this.data.sheets.length;
    this.useRing();
    this.buildGrid();

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.host);
    this.bind();
    if (this.opts.interactive !== false) this.fx = new TreeFx(this.host);
    this.resize();
    // Sheets load in parallel; each one draws as soon as it is in. A tree version already shown is still on the GPU.
    await Promise.race([this.loadSheets(), new Promise((r) => setTimeout(r, 15000))]);
    if (!this.touched) this.fit();
    this.requestDraw();
    this.host.dispatchEvent(new CustomEvent('treeready', { bubbles: true, composed: true }));
  }

  private prepareSprites(): void {
    const n = this.data.sprites.length;
    this.spU = new Float32Array(n * 4);
    this.spH = new Float32Array(n * 2);
    this.spSheet = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const [sh, x, y, w, h] = this.data.sprites[i]!;
      const sheet = this.data.sheets[sh!]!;
      // Half a texel in from the edge so neighbours in the sheet don't bleed in.
      this.spU[i * 4] = (x! + 0.5) / sheet.w;
      this.spU[i * 4 + 1] = (y! + 0.5) / sheet.h;
      this.spU[i * 4 + 2] = (x! + w! - 0.5) / sheet.w;
      this.spU[i * 4 + 3] = (y! + h! - 0.5) / sheet.h;
      this.spH[i * 2] = w! * SPRITE_HALF;
      this.spH[i * 2 + 1] = h! * SPRITE_HALF;
      this.spSheet[i] = sh!;
    }
  }

  private bindShared(t: TreeGL): void {
    this.shared = t;
    this.gl = t.gl;
    this.spriteProg = t.spriteProg;
    this.quadProg = t.quadProg;
    this.bgProg = t.bgProg;
    this.cornerBuf = t.cornerBuf;
    this.indexBuf = t.indexBuf;
    this.bgVao = t.bgVao;
  }

  /** Drops every batch; with `gl`, deletes their GPU buffers first. */
  private resetBatches(gl: WebGL2RenderingContext | null): void {
    if (gl) {
      for (const layer of this.staticBatches) for (const b of layer) b.free(gl);
      for (const m of this.dynBatches) for (const b of m.values()) b.free(gl);
      for (const q of this.quads.values()) q.free(gl);
    }
    this.staticBatches = [];
    this.dynBatches = [];
    for (let i = 0; i < LAYERS; i++) {
      this.staticBatches.push([]);
      this.dynBatches.push(new Map());
    }
    this.dynArr = [];
    this.quads = new Map();
    this.staticDirty = true;
    this.dynDirty = true;
  }

  /** Every sheet from the shared cache (loaded and uploaded the first time a tree version is shown). */
  private loadSheets(): Promise<unknown> {
    for (const r of this.sheetHolds) r();
    this.sheetHolds = [];
    const base = this.base;
    const t = this.shared;
    return Promise.all(
      this.data.sheets.map((s, i) => {
        const key = s.file ? base + s.file : `${base}#atlas${i}`;
        const hold = acquireSheet(key, base, (gl) => (s.file ? this.loadSheet(gl, i, base + s.file) : this.loadAtlas(gl, i, this.atlas, base)));
        this.sheetHolds.push(hold.release);
        return hold.tex.then((tex) => {
          if (this.destroyed || !tex || this.shared !== t) return;
          this.textures[i] = tex;
          this.loaded[i] = true;
          this.requestDraw();
        });
      }),
    );
  }

  private useRing(): void {
    if (!this.shared || this.procSheet < 0) return;
    this.textures[this.procSheet] = this.shared.ring;
    this.loaded[this.procSheet] = true;
  }

  /** Draws the connector PNGs into the atlas sheet `i`. */
  private async loadAtlas(gl: WebGL2RenderingContext, i: number, placed: ExtraPlacement[], base: string): Promise<WebGLTexture | null> {
    const sheet = this.data.sheets[i]!;
    const c = document.createElement('canvas');
    c.width = sheet.w;
    c.height = sheet.h;
    const g = c.getContext('2d')!;
    await Promise.all(
      placed.map(async (p) => {
        const bmp = await createImageBitmap(await (await fetch(base + p.file)).blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
        g.drawImage(bmp, p.x, p.y);
        bmp.close?.();
      }),
    );
    return this.uploadSheet(gl, i, c, true);
  }

  private async loadSheet(gl: WebGL2RenderingContext, i: number, url: string): Promise<WebGLTexture | null> {
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'premultiply', colorSpaceConversion: 'none' });
      const tex = this.uploadSheet(gl, i, bmp, false);
      bmp.close?.();
      return tex;
    } catch (e) {
      console.error('tree sheet failed', url, e);
      return null;
    }
  }

  private uploadSheet(gl: WebGL2RenderingContext, i: number, src: ImageBitmap | HTMLCanvasElement, premultiply: boolean): WebGLTexture | null {
    try {
      if (gl.isContextLost()) return null;
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, i === this.bgSheet() ? gl.REPEAT : gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, i === this.bgSheet() ? gl.REPEAT : gl.CLAMP_TO_EDGE);
      const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
      if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 4);
      return tex;
    } catch (e) {
      console.error('tree sheet upload failed', i, e);
      return null;
    }
  }

  private bgSheet(): number {
    const i = this.data.named['Background2'];
    return i !== undefined && i >= 0 ? this.spSheet[i]! : -1;
  }

  /** Sets the panel insets and frames the tree again when the player has not moved the view. */
  setInsets(i: { left: number; top: number; right: number; bottom: number }): void {
    const o = this.opts.insets;
    this.opts.insets = i;
    if (!this.touched && this.tree) this.fit();
    if (!o || o.left !== i.left || o.top !== i.top || o.right !== i.right || o.bottom !== i.bottom) {
      this.layoutMid();
      this.requestDraw();
    }
  }

  /** Frees what is this tree's own on the GPU (its batches) and lets go of the shared sheets; the context stays. */
  destroy(): void {
    this.moving(false);
    this.destroyed = true;
    clearTimeout(this.ringTimer);
    clearTimeout(this.pathTimer);
    this.ringLayer?.remove();
    cancelAnimationFrame(this.zoomRaf);
    clearTimeout(this.searchTimer);
    this.fx?.destroy();
    this.fx = null;
    this.offKeys?.();
    this.ro?.disconnect();
    cancelAnimationFrame(this.raf);
    removeTreeGLUser(this);
    this.resetBatches(this.shared && !this.gl.isContextLost() ? this.gl : null);
    for (const r of this.sheetHolds) r();
    this.sheetHolds = [];
    this.textures = [];
    this.shared = null;
    for (const c of [this.canvas, this.mid]) {
      if (!c) continue;
      c.remove();
      // A canvas's backing store goes with its size, not with the element.
      c.width = 0;
      c.height = 0;
    }
    this.mid = null;
    this.midCtx = null;
  }

  /** The shared context is gone (driver reset, GPU process restart): nothing of it is usable until it is back. */
  contextLost(): void {
    this.shared = null;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.textures = [];
    this.loaded = [];
    this.sheetHolds = [];
    this.resetBatches(null);
  }

  /** The context is back, empty: everything is uploaded again and the tree redrawn. */
  contextRestored(): void {
    const t = treeGL();
    if (!t || this.destroyed) return;
    this.bindShared(t);
    this.resetBatches(null);
    if (this.data) {
      this.useRing();
      void this.loadSheets();
    }
    this.requestDraw();
  }

  /** Places the middle canvas inside the panel insets (8 px in, so a panel's blur never reaches it). */
  private layoutMid(): void {
    const ins = this.opts.insets;
    const k = this.w ? this.canvas.width / this.w : 0;
    let r: typeof this.midRect = null;
    if (ins && k && this.opts.interactive !== false) {
      const M = 8;
      const x = Math.ceil((ins.left + M) * k);
      const y = Math.ceil((ins.top + M) * k);
      const x1 = Math.floor((this.w - ins.right - M) * k);
      const y1 = Math.floor((this.h - ins.bottom - M) * k);
      if (x1 - x >= 64 && y1 - y >= 64) r = { x, y, w: x1 - x, h: y1 - y, css: [x / k, y / k, x1 / k, y1 / k] };
    }
    this.needFull = true;
    this.midRect = r;
    this.fx?.layout(this.w, this.h, r ? r.css : null);
    if (!r) {
      if (this.mid) {
        this.mid.remove();
        this.mid.width = 0;
        this.mid.height = 0;
      }
      this.mid = null;
      this.midCtx = null;
      return;
    }
    if (!this.mid) {
      this.mid = document.createElement('canvas');
      this.canvas.after(this.mid);
      this.midCtx = this.mid.getContext('2d', { alpha: false });
    }
    if (this.mid.width !== r.w || this.mid.height !== r.h) {
      this.mid.width = r.w;
      this.mid.height = r.h;
    }
    this.mid.style.cssText = `position:absolute;left:${r.css[0]}px;top:${r.css[1]}px;width:${r.w / k}px;height:${r.h / k}px;display:block;pointer-events:none`;
  }

  // -----------------------------------------------------------------------------------------------------------
  // public state

  // ---- motion (treeFx) -------------------------------------------------------------------------------------------------
  /** The picture on screen right now (full canvas with the middle canvas over it), for effects that cover the change until they uncover it. */
  private snapshot(): { img: HTMLCanvasElement; k: number } | null {
    if (!this.fx || !this.w || !this.canvas.width || this.destroyed) return null;
    const c = document.createElement('canvas');
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    const g = c.getContext('2d');
    if (!g) return null;
    g.drawImage(this.canvas, 0, 0);
    if (this.mid && this.midRect) g.drawImage(this.mid, this.midRect.x, this.midRect.y);
    return { img: c, k: this.canvas.width / this.w };
  }

  /** Outer diameter (px) of a ring that hugs the node's visible frame (measured from the art, not the click radius). */
  ringDiameter(n: TNode): number {
    const vis = this.frameVis.get(n.id) ?? this.fxNode(n).d * 0.9; // 0.9: the usual visible share of the sprite (read off the drawn frames), until the art is measured
    const px = vis * this.view.s;
    return Math.max(px + 5, Math.min(12, px * 1.5 + 4)); // 1 px gap outside the frame plus the 1.5 px border each side; a tiny node floors at 12 px but never past 1.5x its frame + 4
  }

  private fxNode(n: TNode): FxNode {
    const r = Math.sqrt(n.rsq) || 30;
    return { id: n.id, x: n.x, y: n.y, r, size: r * 2, d: Math.min(this.frameD.get(n.id) || Infinity, r * 2.1), t: n.t }; // d: plain nodes' frame sprites have a transparent margin; the hit radius is the visible edge
  }

  /** The step's node, with the arc centre when it is linked from a node on the same orbit of the same group. */
  private fxStep(n: TNode, from: TNode | null, step: number): FxStep {
    const node = this.fxNode(n);
    if (from && n.group && from.group === n.group && n.orbit === from.orbit && n.orbit > 0) node.arc = { cx: n.group.x, cy: n.group.y };
    return { node, from: from ? this.fxNode(from) : null, step };
  }

  /** Ripple order over `ids` (the changed nodes): from the nodes in `roots` outwards (added) or from `click` outwards, farthest first (removed). */
  private fxSteps(ids: number[], roots: Set<number>, kind: 'add' | 'rem', click?: number): FxStep[] {
    const set = new Set(ids);
    const dist = new Map<number, number>();
    const from = new Map<number, number | null>();
    let queue: number[] = [];
    if (kind === 'add') {
      for (const id of ids) {
        const n = this.nodeById(id);
        const r = n?.linked.find((o) => roots.has(o));
        if (n && r !== undefined) {
          dist.set(id, 0);
          from.set(id, r);
          queue.push(id);
        }
      }
    } else if (click !== undefined && set.has(click)) {
      dist.set(click, 0);
      from.set(click, null);
      queue.push(click);
    }
    while (queue.length) {
      const next: number[] = [];
      for (const id of queue) {
        const n = this.nodeById(id);
        if (!n) continue;
        for (const o of n.linked) {
          if (!set.has(o) || dist.has(o)) continue;
          dist.set(o, dist.get(id)! + 1);
          from.set(o, id);
          next.push(o);
        }
      }
      queue = next;
    }
    for (const id of ids) if (!dist.has(id)) dist.set(id, 0); // not reachable through the changed set: plays with the first step
    const max = Math.max(0, ...dist.values());
    const out: FxStep[] = [];
    for (const id of ids) {
      const n = this.nodeById(id);
      if (!n) continue;
      let f: TNode | undefined;
      const fid = from.get(id);
      if (fid !== undefined && fid !== null) f = this.nodeById(fid);
      else if (kind === 'rem') f = this.nodeById(n.linked.find((o) => this.alloc.has(o)) ?? -1);
      out.push(this.fxStep(n, f ?? null, kind === 'add' ? dist.get(id)! : max - dist.get(id)!));
    }
    return out;
  }

  /** Plays the ripple for a change of the allocation (called while the canvas still shows the old picture; `this.alloc` is already the new one). */
  private playAlloc(added: number[], removed: number[], click?: number): void {
    const fx = this.fx;
    if (!fx || !this.tree || added.length + removed.length > MAX_RIPPLE) return;
    const plain = (ids: number[]) =>
      ids.filter((id) => {
        const n = this.nodeById(id);
        return !!n && n.t !== NODE_MASTERY && n.t !== NODE_CLASS_START && n.t !== NODE_ASCEND_START;
      });
    const add = plain(added);
    const rem = plain(removed);
    if (!add.length && !rem.length) return;
    const old = reducedMotion() ? null : this.snapshot();
    const view = { ...this.view };
    if (rem.length) fx.ripple(view, this.fxSteps(rem, this.alloc, 'rem', click), 'rem', old);
    if (add.length) {
      const roots = new Set(this.alloc);
      for (const id of add) roots.delete(id);
      fx.ripple(view, this.fxSteps(add, roots, 'add'), 'add', old);
    }
  }

  private searchTimer = 0;
  /** New search matches get one ring that settles onto them (debounced, so typing does not ping every letter). */
  private fxPing(prev: Set<number>): void {
    if (!this.fx || !this.matchSet.size) return;
    const fresh = [...this.matchSet].filter((id) => !prev.has(id));
    if (!fresh.length) return;
    clearTimeout(this.searchTimer);
    this.searchTimer = window.setTimeout(() => {
      if (this.destroyed || !this.fx) return;
      const nodes = fresh
        .map((id) => this.nodeById(id))
        .filter((n): n is TNode => !!n)
        .map((n) => this.fxNode(n));
      this.fx.ping({ ...this.view }, nodes);
    }, 200);
  }

  /** What the engine changed that the player has not already seen: nodes, mastery effects, tattoos, jewels, class. */
  private playStateDiff(prev: { alloc: Set<number>; masteries: Map<number, number>; jewels: Map<number, number>; tattoos: Set<number>; cls: number; asc: number }, state: TreeState): void {
    const fx = this.fx;
    if (!fx) return;
    const view = { ...this.view };
    if (prev.cls !== state.classId || prev.asc !== state.ascendClassId) {
      // A new class or ascendancy: a ring pulses out from its start; no node ripple (most of the tree changes).
      const starts = this.tree.ascStarts.filter((a) => a.asc && (a.asc === this.curAsc || a.asc === this.curAsc2));
      const st = starts[0] ?? this.nodeById(this.classStartId);
      if (st) fx.pulse(view, this.fxNode(st), 'gold');
      return;
    }
    const added = [...this.alloc].filter((id) => !prev.alloc.has(id));
    const removed = [...prev.alloc].filter((id) => !this.alloc.has(id));
    if (added.length || removed.length) this.playAlloc(added, removed);
    for (const [id, eff] of this.masteries) {
      if (prev.masteries.get(id) === eff) continue;
      const n = this.nodeById(id);
      if (n) fx.bloom(view, this.fxNode(n), 'gold');
    }
    const tattooed = new Set([...this.overrides].filter(([, o]) => o.tattoo).map(([id]) => id));
    for (const id of new Set([...tattooed, ...prev.tattoos])) {
      if (tattooed.has(id) === prev.tattoos.has(id)) continue;
      const n = this.nodeById(id);
      if (n) fx.bloom(view, this.fxNode(n), 'gold');
    }
    for (const [id, item] of this.jewels) {
      if (prev.jewels.get(id) === item) continue;
      const n = this.nodeById(id);
      const label = this.jewelInfo.get(id)?.radius;
      if (!n || !label) continue;
      const outer = Math.max(0, ...this.radiusBands(label).map((b) => b.outer));
      if (outer > 0) fx.radius(view, this.fxNode(n), outer);
    }
  }

  /** Sets the build's tree. Call again after every change the engine makes. */
  setState(state: TreeState): void {
    const prev = this.state && this.fx && this.w ? { alloc: new Set(this.alloc), masteries: new Map(this.masteries), jewels: new Map(this.jewels), tattoos: new Set([...this.overrides].filter(([, o]) => o.tattoo).map(([id]) => id)), cls: this.state.classId, asc: this.state.ascendClassId } : null;
    this.state = state;
    this.ext = buildExtension(this.tree, state.generated);
    this.graph = makeGraph(this.tree, this.ext);
    this.alloc = new Set(state.allocated);
    this.masteries = new Map(state.masteries);
    this.jewels = new Map(state.jewels);
    this.overrides.clear();
    for (const c of state.changed) {
      this.overrides.set(c.id, { name: c.name, stats: c.stats, text: (c.name + '\n' + c.stats.join('\n')).toLowerCase(), tattoo: !!c.tattoo, conquered: !!c.conquered, abyss: c.conqueredBy === 'abyss' });
    }
    const cls = this.tree.data.classes[String(state.classId)];
    this.classStartId = cls?.start ?? -1;
    this.curAsc = cls?.asc[String(state.ascendClassId)]?.id;
    this.curAsc2 = state.secondaryAscendClassId ? this.tree.data.alt[String(state.secondaryAscendClassId)]?.id : undefined;
    if (this.classStartId >= 0) this.alloc.add(this.classStartId);
    for (const a of this.tree.ascStarts) if (a.asc && (a.asc === this.curAsc || a.asc === this.curAsc2)) this.alloc.add(a.id);
    this.buildGrid();
    this.matchSet.clear();
    this.recomputeSearch();
    const hovered = this.hover;
    this.hover = null;
    this.path = [];
    this.pathSet.clear();
    this.depSet.clear();
    this.hoverRadius = null;
    this.staticDirty = true;
    this.dynDirty = true;
    if (!this.touched && this.w) this.fit();
    if (prev) this.playStateDiff(prev, state);
    this.requestDraw();
    // The node under the pointer stays hovered across the change, its path and dependents worked out again: the tooltip
    // shows the node's new state at once (it used to vanish after a click until the pointer moved).
    if (hovered && this.opts.interactive !== false && !this.destroyed) {
      const n = this.nodeAt_(hovered.id);
      if (n) this.setHover(n);
    }
  }

  /** The design's `alloc` property: a plain set of allocated ids (no engine state). */
  setAlloc(ids: Iterable<number>): void {
    this.alloc = new Set(ids);
    if (this.classStartId >= 0) this.alloc.add(this.classStartId);
    this.dynDirty = true;
    this.requestDraw();
  }

  /**
   * The optimize sweep: switches to the allocation `to` and fires allocchange with the difference. The new
   * allocation is drawn at once; a snapshot of the old picture is uncovered by a beam crossing the tree left to right
   * (840 ms), and the promise resolves when it ends. Nothing waits for it.
   */
  sweep(to: Iterable<number>): Promise<void> {
    const from = new Set(this.alloc);
    const next = new Set(to);
    const snap = this.fx && !this.destroyed ? this.snapshot() : null;
    this.setAlloc(next);
    const added = [...this.alloc].filter((id) => !from.has(id));
    const removed = [...from].filter((id) => !this.alloc.has(id));
    this.host.dispatchEvent(new CustomEvent('allocchange', { bubbles: true, composed: true, detail: { count: this.alloc.size, added, removed, sweep: true } }));
    if (!this.fx || !snap || !this.tree) return Promise.resolve();
    const nodes: Array<{ n: FxNode; k: 'add' | 'rem' | null }> = [];
    const seen = new Set<number>();
    for (const [ids, k] of [[added, 'add'], [removed, 'rem']] as const) {
      for (const id of ids) {
        const n = this.nodeById(id);
        if (n) nodes.push({ n: this.fxNode(n), k });
        seen.add(id);
      }
    }
    for (const id of this.alloc) {
      if (seen.has(id)) continue;
      const n = this.nodeById(id);
      if (n) nodes.push({ n: this.fxNode(n), k: null });
    }
    return this.fx.sweep({ ...this.view }, snap.img, nodes);
  }

  setJewelInfo(info: Record<number, JewelInfo> | Map<number, JewelInfo>): void {
    this.jewelInfo = info instanceof Map ? new Map(info) : new Map(Object.entries(info).map(([k, v]) => [Number(k), v]));
    this.dynDirty = true;
    this.requestDraw();
  }

  /** Draws the radius of a jewel (`label`: Small ... Massive or Variable) round a socket, tinting the nodes inside it. */
  setRadiusPreview(socketId: number | null, label = 'Large', title = '', index?: number | null): void {
    this.radiusPreview = socketId === null ? null : { socket: socketId, title, label, index };
    this.dynDirty = true;
    this.requestDraw();
  }

  /** The ring or rings of one radius label: a fixed radius is one disc, Variable is the bands upstream shows. */
  private radiusBands(label: string, index?: number | null): Array<{ inner: number; outer: number; col: Rgba; packed: number }> {
    const variable = label === 'Variable';
    const chosen = index ? this.data.jewelRadius[index - 1] : undefined;
    return this.data.jewelRadius
      .filter((r) => (chosen ? r === chosen : r.label === label && (variable ? r.inner !== 0 : r.inner === 0)))
      .map((r) => {
        const col = hexColor(r.col);
        return { inner: r.inner, outer: r.outer, col, packed: packColor(col[0], col[1], col[2], 1) };
      });
  }

  /** Per-node power for the heat view, each 0..1 (the host normalises against its own maximum). */
  setPower(power: Record<number, { offence: number; defence: number }> | Map<number, { offence: number; defence: number }> | null): void {
    this.power = power === null ? null : power instanceof Map ? power : new Map(Object.entries(power).map(([k, v]) => [Number(k), v]));
    this.dynDirty = true;
    this.requestDraw();
  }

  /** Compare against another build: nodes only there draw green, nodes only here red, changed masteries and jewels blue. */
  setCompare(other: TreeState | null): void {
    if (!other) {
      this.compareAlloc = null;
      this.compareMasteries = null;
      this.compareJewels = null;
    } else {
      this.compareAlloc = new Set(other.allocated);
      const cls = this.tree.data.classes[String(other.classId)];
      if (cls) this.compareAlloc.add(cls.start);
      this.compareMasteries = new Map(other.masteries);
      this.compareJewels = new Map(other.jewels);
    }
    this.dynDirty = true;
    this.requestDraw();
  }

  get search(): string {
    return this._search;
  }
  set search(v: string) {
    this._search = v ?? '';
    const prevMatches = new Set(this.matchSet);
    this.recomputeSearch();
    this.fxPing(prevMatches);
    this.dynDirty = true;
    this.requestDraw();
  }

  get overlay(): { added?: number[]; removed?: number[]; ringsOnly?: boolean } | null {
    return this._overlay;
  }
  set overlay(v: { added?: number[]; removed?: number[]; ringsOnly?: boolean } | null) {
    this._overlay = v;
    this.dynDirty = true;
    this.requestDraw();
  }

  setHeatStyle(single: boolean, theme: 'red-blue' | 'red-green' | 'green-blue'): void {
    this.heatSingle = single;
    this.heatTheme = theme;
    this.dynDirty = true;
    this.requestDraw();
  }

  get heat(): boolean {
    return this._heat;
  }
  set heat(v: boolean) {
    this._heat = v;
    this.dynDirty = true;
    this.requestDraw();
  }

  get stats(): FrameStats {
    return this.lastStats;
  }

  nodeById(id: number): TNode | undefined {
    return this.ext.byId.get(id) ?? this.tree.byId.get(id);
  }

  private recomputeSearch(): void {
    this.matchSet.clear();
    const test = compileSearch(this._search);
    if (!test) return;
    for (const n of this.drawNodes()) {
      if (n.t === NODE_CLASS_START || n.t === NODE_ASCEND_START) continue;
      const o = this.overrides.get(n.id);
      const lines = o?.stats ?? n.stats;
      const all = n.mastery ? [...lines, ...n.mastery.effects.flatMap((e) => e.s)] : lines;
      if (n.t === NODE_MASTERY && !all.length) continue;
      if (test({ name: o?.name ?? n.name, lines: all, type: SEARCH_TYPE[n.t] ?? '', recipe: n.recipe })) this.matchSet.add(n.id);
    }
  }

  /** The nodes the search matches, and how many of them are allocated. */
  searchResults(): { ids: number[]; allocated: number } {
    const ids = [...this.matchSet];
    return { ids, allocated: ids.filter((id) => this.alloc.has(id)).length };
  }

  // -----------------------------------------------------------------------------------------------------------
  // geometry helpers

  toScreen(x: number, y: number): [number, number] {
    return [(x - this.view.x) * this.view.s + this.w / 2, (y - this.view.y) * this.view.s + this.h / 2];
  }
  toTree(sx: number, sy: number): [number, number] {
    return [(sx - this.w / 2) / this.view.s + this.view.x, (sy - this.h / 2) / this.view.s + this.view.y];
  }

  private drawNodesCache: TNode[] | null = null;
  private drawNodesExt: Extension | null = null;
  /** Every node that is drawn: static nodes in real groups plus the build's generated cluster nodes. */
  drawNodes(): TNode[] {
    if (this.drawNodesCache && this.drawNodesExt === this.ext) return this.drawNodesCache;
    const out: TNode[] = [];
    for (const n of this.tree.nodes) if (n.group && !n.group.proxy && !this.isProxyNode(n)) out.push(n);
    // Cluster-socket stand-ins replace nothing in `out` (the static copies sit in hidden proxy groups).
    for (const n of this.ext.nodes) out.push(n);
    this.drawNodesCache = out;
    this.drawNodesExt = this.ext;
    return out;
  }

  private boundsCache: { for: TNode[]; b: Bounds } | null = null;
  /** The box that holds every drawn node (tree units). */
  private nodeBounds(): Bounds {
    const nodes = this.drawNodes();
    if (this.boundsCache?.for === nodes) return this.boundsCache.b;
    const b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    for (const n of nodes) {
      b.minX = Math.min(b.minX, n.x);
      b.maxX = Math.max(b.maxX, n.x);
      b.minY = Math.min(b.minY, n.y);
      b.maxY = Math.max(b.maxY, n.y);
    }
    if (!(b.minX <= b.maxX)) return { minX: -1e5, maxX: 1e5, minY: -1e5, maxY: 1e5 };
    this.boundsCache = { for: nodes, b };
    return b;
  }

  /** Pulls the view back when a drag or zoom took its middle off the tree. */
  private clampToTree(): void {
    const v = clampView(this.view, this.nodeBounds());
    if (v !== this.view) this.view = v;
  }

  private proxyIds: Set<number> | null = null;
  private isProxyNode(n: TNode): boolean {
    if (!this.proxyIds) {
      this.proxyIds = new Set();
      for (const r of this.data.nodes) if (r.px) this.proxyIds.add(r.id);
    }
    return this.proxyIds.has(n.id);
  }

  private buildGrid(): void {
    this.drawNodesCache = null;
    this.grid.clear();
    const c = this.cell;
    for (const n of this.drawNodes()) {
      if (n.rsq <= 0) continue;
      const k = Math.floor(n.x / c) * 100003 + Math.floor(n.y / c);
      let l = this.grid.get(k);
      if (!l) this.grid.set(k, (l = []));
      l.push(n);
    }
  }

  /** The node under a point in tree space (upstream: within the node's rsq), nearest centre wins. */
  nodeAtTree(tx: number, ty: number): TNode | null {
    const c = this.cell;
    const cx = Math.floor(tx / c);
    const cy = Math.floor(ty / c);
    let best: TNode | null = null;
    let bd = Infinity;
    for (let i = cx - 1; i <= cx + 1; i++) {
      for (let j = cy - 1; j <= cy + 1; j++) {
        const l = this.grid.get(i * 100003 + j);
        if (!l) continue;
        for (const n of l) {
          const dx = tx - n.x;
          const dy = ty - n.y;
          const d = dx * dx + dy * dy;
          if (d <= n.rsq && d < bd) {
            bd = d;
            best = n;
          }
        }
      }
    }
    return best;
  }

  nodeAt(sx: number, sy: number): TNode | null {
    const [tx, ty] = this.toTree(sx, sy);
    return this.nodeAtTree(tx, ty);
  }

  summary(n: TNode): NodeSummary {
    const o = this.overrides.get(n.id);
    return { id: n.id, t: n.t, n: o?.name ?? n.name, s: o?.stats ?? n.stats, x: n.x, y: n.y, a: n.asc, me: n.mastery?.effects };
  }

  /** Radius of a node on screen, for popovers. */
  screenRadius(n: TNode): number {
    return Math.sqrt(n.rsq) * this.view.s;
  }

  // -----------------------------------------------------------------------------------------------------------
  // view

  private resize(): void {
    const W = this.host.clientWidth;
    const H = this.host.clientHeight;
    if (!W || !H) return;
    const dpr = Math.min(this.opts.maxDpr ?? 2, window.devicePixelRatio || 1);
    this.w = W;
    this.h = H;
    this.dpr = dpr;
    const cw = Math.round(W * dpr);
    const ch = Math.round(H * dpr);
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    this.layoutMid();
    if (!this.touched && this.tree) this.fit();
    else if (this.tree && !this.anyNodeOnScreen()) this.fit();
    this.requestDraw();
    // An open tooltip is placed and height-capped for the host's size: re-send it so it re-measures for the new size
    // and moves with its node. Before, it kept its old box after a window resize, its footer (refund points, gold,
    // shortcuts) below the window until the pointer moved.
    if (this.hover && !this.zoomRaf && !this.dragging) this.emitHover(this.hover);
  }

  /** True when at least one node is inside the canvas; a window resize can leave a panned view looking at empty space. */
  private anyNodeOnScreen(): boolean {
    for (const n of this.drawNodes()) {
      const [sx, sy] = this.toScreen(n.x, n.y);
      if (sx >= 0 && sy >= 0 && sx <= this.w && sy <= this.h) return true;
    }
    return false;
  }

  /** Frames the allocated nodes (or the whole tree). */
  fit(): void {
    if (!this.tree || !this.w || !this.h) return;
    const o = this.opts;
    let nodes: TNode[];
    if (o.frame) nodes = [...o.frame].map((id) => this.nodeAt_(id)).filter((n): n is TNode => !!n && !!n.group);
    else if (o.fit === 'all' || !this.alloc.size) nodes = this.drawNodes();
    else nodes = [...new Set([...this.alloc, ...(this.compareAlloc ?? [])])].map((id) => this.nodeAt_(id)).filter((n): n is TNode => !!n && !!n.group);
    if (!nodes.length) nodes = this.drawNodes();
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const n of nodes) {
      x0 = Math.min(x0, n.x);
      y0 = Math.min(y0, n.y);
      x1 = Math.max(x1, n.x);
      y1 = Math.max(y1, n.y);
    }
    // A handful of nodes (a new build is the class start alone) still shows a readable stretch of the tree around them.
    if (o.minSpan !== 0) {
      const half = o.minSpan ?? 3600;
      const cx0 = (x0 + x1) / 2;
      const cy0 = (y0 + y1) / 2;
      if (x1 - x0 < half * 2) {
        x0 = cx0 - half;
        x1 = cx0 + half;
      }
      if (y1 - y0 < half * 2) {
        y0 = cy0 - half;
        y1 = cy0 + half;
      }
    }
    const z = o.zoom ?? 1;
    if (o.insets && o.scale === undefined && o.center !== 'start') {
      const { left, top, right, bottom } = o.insets;
      const fw = Math.max(50, this.w - left - right);
      const fh = Math.max(50, this.h - top - bottom);
      const m = 60; // a node's own size and a little air, in tree units
      let sf = Math.min((fw - 48) / (x1 - x0 + m * 2), (fh - 48) / (y1 - y0 + m * 2)) * z;
      let cx = (x0 + x1) / 2;
      let cy = (y0 + y1) / 2;
      if (o.minFitScale && sf < o.minFitScale && nodes.length > 8) {
        // Too spread out to show whole at a readable size (far cluster jewels): frame the middle of the nodes instead.
        const xs = nodes.map((n) => n.x).sort((a, b) => a - b);
        const ys = nodes.map((n) => n.y).sort((a, b) => a - b);
        cx = xs[Math.floor(xs.length / 2)]!;
        cy = ys[Math.floor(ys.length / 2)]!;
        sf = o.minFitScale;
      }
      // The framed box's centre goes to the centre of the free area, not of the whole host.
      this.view = { x: cx - (left + fw / 2 - this.w / 2) / sf, y: cy - (top + fh / 2 - this.h / 2) / sf, s: sf };
      this.requestDraw();
      return;
    }
    const pad = 700;
    const s = o.scale ?? Math.min(this.w / (x1 - x0 + pad * 2), this.h / (y1 - y0 + pad * 2)) * z;
    if (o.center === 'start') {
      const cs = this.nodeAt_(this.classStartId);
      if (cs) {
        this.view = { x: cs.x + (o.dx ?? 0), y: cs.y + (o.dy ?? 0), s };
        this.requestDraw();
        return;
      }
    }
    this.view = { x: (x0 + x1) / 2 + (o.dx ?? 0), y: (y0 + y1) / 2 + (o.dy ?? 0), s };
    this.requestDraw();
  }

  private nodeAt_(id: number): TNode | undefined {
    return this.nodeById(id);
  }

  /** Brings node `id` to the middle of the free area (between the panels) and shows its tooltip; `s` also sets the scale. */
  focusNode(id: number, s?: number): void {
    const n = this.nodeById(id);
    if (!n) return;
    if (s) this.view.s = s;
    else this.view.s = Math.max(this.view.s, 0.22);
    const ins = this.opts.insets;
    const cx = ins ? ins.left + (this.w - ins.left - ins.right) / 2 : this.w / 2;
    const cy = ins ? ins.top + (this.h - ins.top - ins.bottom) / 2 : this.h / 2;
    this.view.x = n.x - (cx - this.w / 2) / this.view.s;
    this.view.y = n.y - (cy - this.h / 2) / this.view.s;
    this.touched = true;
    this.requestDraw();
    this.cursor = [cx, cy];
    this.setHover(n);
  }

  /** Keyboard walking: the hovered node moves to the nearest node in a direction (from the middle of the view at first). */
  stepHover(dx: number, dy: number): void {
    const from = this.hover;
    const [fx, fy] = from ? [from.x, from.y] : this.toTree(this.w / 2, this.h / 2);
    const ins = this.opts.insets ?? { left: 0, top: 0, right: 0, bottom: 0 };
    let best: TNode | null = null;
    let bs = Infinity;
    for (const n of this.drawNodes()) {
      if (n === from || n.rsq <= 0) continue;
      const [sx, sy] = this.toScreen(n.x, n.y);
      if (sx < ins.left || sy < ins.top || sx > this.w - ins.right || sy > this.h - ins.bottom) continue;
      const ddx = n.x - fx;
      const ddy = n.y - fy;
      const d = Math.hypot(ddx, ddy);
      let score: number;
      if (!from) score = d;
      else {
        if (!d) continue;
        const cos = (ddx * dx + ddy * dy) / d;
        if (cos < 0.5) continue;
        score = d * (2 - cos);
      }
      if (score < bs) {
        bs = score;
        best = n;
      }
    }
    if (best) {
      this.touched = true;
      this.setHover(best);
    }
  }

  /** Enter on the keyboard-hovered node: the same as clicking it. */
  activateHover(): void {
    if (this.hover) this.click(this.hover);
  }

  /** Where the matches of the search are on screen (for the markers at the edge of the view). */
  searchPoints(): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (const id of this.matchSet) {
      const n = this.nodeById(id);
      if (n) out.push(this.toScreen(n.x, n.y));
    }
    return out;
  }

  /** Centres the view on a set of nodes and zooms so they are easy to see (a close view for one node, wider for many). */
  frameNodes(ids: number[]): void {
    const ns = ids.map((id) => this.nodeById(id)).filter((n): n is TNode => !!n);
    if (!ns.length) return;
    const x0 = Math.min(...ns.map((n) => n.x));
    const x1 = Math.max(...ns.map((n) => n.x));
    const y0 = Math.min(...ns.map((n) => n.y));
    const y1 = Math.max(...ns.map((n) => n.y));
    const pad = 600;
    const fit = Math.min(this.w / (x1 - x0 + pad * 2), this.h / (y1 - y0 + pad * 2));
    this.view.x = (x0 + x1) / 2;
    this.view.y = (y0 + y1) / 2;
    this.view.s = Math.max(0.12, Math.min(0.45, fit));
    this.touched = true;
    this.requestDraw();
  }

  /** Eases the view so node `id` ends up at screen point (sx, sy). Resolves when done. */
  panTo(id: number, sx: number, sy: number, ms = 320): Promise<void> {
    const n = this.nodeById(id);
    if (!n) return Promise.resolve();
    const s = this.view.s;
    const x1 = n.x - (sx - this.w / 2) / s;
    const y1 = n.y - (sy - this.h / 2) / s;
    const x0 = this.view.x;
    const y0 = this.view.y;
    if (Math.hypot((x1 - x0) * s, (y1 - y0) * s) < 4) return Promise.resolve();
    this.touched = true;
    return new Promise((res) => {
      const t0 = performance.now();
      const step = (t: number) => {
        const k = Math.min(1, (t - t0) / ms);
        const e = 1 - Math.pow(1 - k, 3);
        this.view.x = x0 + (x1 - x0) * e;
        this.view.y = y0 + (y1 - y0) * e;
        this.requestDraw();
        if (k < 1) requestAnimationFrame(step);
        else res();
      };
      requestAnimationFrame(step);
    });
  }

  // -----------------------------------------------------------------------------------------------------------
  // interaction

  private bind(): void {
    const host = this.host;
    let down: { x: number; y: number; vx: number; vy: number } | null = null;
    let moved = false;
    const local = (e: MouseEvent): [number, number] => {
      const r = host.getBoundingClientRect();
      const k = this.w / (r.width || 1);
      return [(e.clientX - r.left) * k, (e.clientY - r.top) * k];
    };
    host.addEventListener('pointerdown', (e) => {
      // Only the left button drags and clicks; upstream ignores the middle one and uses the right one on release.
      if (e.button !== 0) return;
      this.touched = true;
      down = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y };
      moved = false;
      host.setPointerCapture(e.pointerId);
    });
    host.addEventListener('pointermove', (e) => {
      if (down) {
        const k = this.w / (host.getBoundingClientRect().width || 1);
        const dx = (e.clientX - down.x) * k;
        const dy = (e.clientY - down.y) * k;
        // Upstream starts a drag only past 5 pixels on one axis (PassiveTreeView:Draw). The old test (|dx| + |dy| > 4)
        // turned an ordinary click with a little hand movement into a 5-pixel pan, and the click never reached the node.
        if (!moved && isDrag(e.clientX - down.x, e.clientY - down.y)) {
          moved = true;
          this.dragging = true;
          this.moving(true);
          host.classList.add('drag');
          // The tooltip belongs to the node under a still pointer: it goes while the tree pans.
          if (this.hover) this.setHover(null);
        }
        if (moved) {
          this.view.x = down.vx - dx / this.view.s;
          this.view.y = down.vy - dy / this.view.s;
          this.clampToTree();
          this.requestDraw();
          return;
        }
      }
      if (this.opts.interactive === false) return;
      const [sx, sy] = local(e);
      this.cursor = this.pointer = [sx, sy];
      // While a wheel zoom eases, the tooltip stays hidden even when the pointer moves; the node under the pointer is
      // hovered once the zoom settles (wheelZoom -> hoverCursor, which reads this latest position).
      if (this.zoomRaf) return;
      this.setHover(this.nodeAt(sx, sy));
    });
    host.addEventListener('pointerup', (e) => {
      if (e.button === 2) {
        // Right click: Ctrl zooms out; otherwise the host decides (a jewel socket's item, a tattoo, a mastery).
        if (this.opts.interactive === false) return;
        const [sx, sy] = local(e);
        if (e.ctrlKey) {
          this.zoomBy(-2, sx, sy);
          this.hoverCursor();
        } else {
          // Like a left click, the node under the release point is the one acted on, even while a wheel zoom eases and
          // the hover (and its tooltip) is held back.
          const n = this.nodeAt(sx, sy);
          this.cursor = [sx, sy];
          if (n !== this.hover) this.setHover(n);
          if (n) this.host.dispatchEvent(new CustomEvent('noderightclick', { bubbles: true, composed: true, detail: { id: n.id, node: this.summary(n), alloc: this.alloc.has(n.id), sx, sy } }));
        }
        return;
      }
      if (e.button !== 0) return;
      host.classList.remove('drag');
      const wasDown = down;
      down = null;
      this.dragging = false;
      this.moving(false);
      if (!wasDown || this.opts.interactive === false) return;
      const [sx, sy] = local(e);
      this.cursor = this.pointer = [sx, sy];
      if (moved) {
        // A pan ended: the node now under the pointer gets its tooltip back.
        this.setHover(this.nodeAt(sx, sy));
        return;
      }
      if (e.ctrlKey) {
        // Ctrl click zooms in on the point, like upstream.
        this.zoomBy(2, sx, sy);
        this.hoverCursor();
        return;
      }
      // The node under the release point is the one clicked (upstream reads hoverNode on release), even when no
      // pointermove has hovered it yet (a click right after a zoom, a pan, or a tooltip that was hidden).
      const n = this.nodeAt(sx, sy);
      if (n !== this.hover) this.setHover(n);
      if (n) this.click(n);
    });
    host.addEventListener('pointercancel', () => {
      host.classList.remove('drag');
      down = null;
      this.dragging = false;
      this.moving(false);
    });
    host.addEventListener('pointerleave', () => {
      if (down) return; // captured: a pan that leaves the canvas is still a pan
      this.cursor = this.pointer = null;
      if (this.hover) this.setHover(null);
    });
    host.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.touched = true;
        const [sx, sy] = local(e);
        // Shift makes each notch three steps; Windows turns Shift+wheel into a sideways scroll, so read either axis.
        const d = e.deltaY || e.deltaX;
        const f = Math.exp(-d * 0.0015 * (e.shiftKey ? 3 : 1));
        this.cursor = this.pointer = [sx, sy];
        this.moving(true, 180);
        // The tooltip hides while the view zooms and comes back for the node under the pointer once it settles
        // (re-sending it only at the wheel event left it where the node was before the eased zoom moved it).
        if (this.hover) this.setHover(null);
        this.wheelZoom(f, sx, sy);
      },
      { passive: false },
    );
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Shift') return;
      this.setTrace(e.type === 'keydown');
    };
    // The window losing focus or being hidden ends a trace and hides the node tooltip.
    const blur = () => {
      this.setTrace(false);
      // Nothing pending may bring the tooltip back without the pointer: the zoom jumps to its goal, and the pointer
      // position a settling zoom would hover is forgotten until the pointer moves again.
      if (this.zoomRaf) {
        cancelAnimationFrame(this.zoomRaf);
        this.zoomRaf = 0;
        if (!this.destroyed) this.zoomAt(this.zoomGoal / this.view.s, this.zoomAnchor[0], this.zoomAnchor[1]);
      }
      this.cursor = this.pointer = null;
      if (this.hover && !this.destroyed) this.setHover(null);
    };
    const vis = () => { if (document.visibilityState === 'hidden') blur(); };
    document.addEventListener('visibilitychange', vis);
    window.addEventListener('keydown', key);
    window.addEventListener('keyup', key);
    window.addEventListener('blur', blur);
    this.offKeys = () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('keyup', key);
      window.removeEventListener('blur', blur);
      document.removeEventListener('visibilitychange', vis);
    };
  }

  /** The last pointer position over the tree, in host pixels. */
  private cursor: [number, number] | null = null;
  /** The same, but only ever set by the real pointer (focusNode moves `cursor` too). */
  private pointer: [number, number] | null = null;

  /** Hovers the node under the last pointer position (after a zoom settles). */
  private hoverCursor(): void {
    if (this.destroyed || this.opts.interactive === false || !this.cursor || this.dragging) return;
    const n = this.nodeAt(this.cursor[0], this.cursor[1]);
    if (n && n === this.hover) this.emitHover(n); // same node, new place on screen
    else this.setHover(n);
  }

  /** Sends the hovered node again with its path and dependents worked out on the current allocation (after an edit). */
  refreshHover(): void {
    const h = this.hover;
    if (!h || this.destroyed) return;
    this.hover = null;
    this.setHover(h);
  }
  private offKeys: (() => void) | null = null;

  /** Scales the view by `f` keeping the tree point under (sx, sy) where it is (default: the pointer, else the middle). */
  zoomAt(f: number, sx: number = this.cursor?.[0] ?? this.w / 2, sy: number = this.cursor?.[1] ?? this.h / 2): void {
    this.touched = true;
    const [tx, ty] = this.toTree(sx, sy);
    this.view.s = Math.max(0.02, Math.min(1.2, this.view.s * f));
    this.view.x = tx - (sx - this.w / 2) / this.view.s;
    this.view.y = ty - (sy - this.h / 2) / this.view.s;
    this.clampToTree();
    this.requestDraw();
  }

  private zoomGoal = 0;
  /** A left-button drag (pan) is in progress: no tooltip shows until it ends. */
  private dragging = false;
  private movingTimer = 0;
  /** Marks the page while the tree pans or zooms: tree.css drops the ambient light then (a pan redrew it every frame; the glass blur stays, see tree.css). idleMs: clear after that long without another call. */
  private moving(on: boolean, idleMs = 0): void {
    clearTimeout(this.movingTimer);
    document.documentElement.toggleAttribute('data-tree-moving', on);
    if (on && idleMs) this.movingTimer = window.setTimeout(() => this.moving(false), idleMs);
  }
  private zoomAnchor: [number, number] = [0, 0];
  private zoomRaf = 0;
  private zoomLast = 0;
  /** Wheel zoom eases towards its goal (exponential follow, tau 70 ms) and keeps the point under the pointer; reduced motion jumps. */
  private wheelZoom(f: number, sx: number, sy: number): void {
    if (reducedMotion()) {
      this.zoomAt(f, sx, sy);
      this.hoverCursor();
      return;
    }
    if (!this.zoomRaf) this.zoomGoal = this.view.s;
    this.zoomGoal = Math.max(0.02, Math.min(1.2, this.zoomGoal * f));
    this.zoomAnchor = [sx, sy];
    if (this.zoomRaf) return;
    this.zoomLast = performance.now();
    const step = () => {
      this.zoomRaf = 0;
      if (this.destroyed) return;
      const now = performance.now();
      const dt = Math.min(64, now - this.zoomLast);
      this.zoomLast = now;
      const cur = this.view.s;
      const k = 1 - Math.exp(-dt / 70);
      let nxt = cur * Math.pow(this.zoomGoal / cur, k);
      const done = Math.abs(Math.log(this.zoomGoal / nxt)) < 0.003;
      if (done) nxt = this.zoomGoal;
      this.zoomAt(nxt / cur, this.zoomAnchor[0], this.zoomAnchor[1]);
      if (!done && Math.abs(this.view.s - cur) > 1e-9) this.zoomRaf = requestAnimationFrame(step);
      else this.hoverCursor();
    };
    this.zoomRaf = requestAnimationFrame(step);
  }

  /** Upstream's zoom steps (keys and clicks): each step is 1.2 times. */
  zoomBy(steps: number, sx?: number, sy?: number): void {
    this.zoomAt(Math.pow(1.2, steps), sx, sy);
  }

  // ---- Shift: path tracing ---------------------------------------------------------------------------------------------
  /** While Shift is held the nodes the pointer walks over, each linked to the last, make the path a click allocates. */
  traceMode = false;
  tracePath: number[] = [];
  private setTrace(on: boolean): void {
    if (on === this.traceMode) return;
    this.traceMode = on;
    this.tracePath = [];
    if (this.hover) {
      const h = this.hover;
      this.hover = null;
      this.setHover(h);
    }
  }

  /** Sets the hovered node and works out its path (unallocated) or dependents (allocated). */
  setHover(n: TNode | null): void {
    if (n === this.hover) return;
    this.hover = n;
    clearTimeout(this.ringTimer);
    clearTimeout(this.pathTimer);
    this.pathHeld = !!n && !this.traceMode && !!this.pointerOn(n.id);
    if (this.pathHeld) {
      this.pathTimer = window.setTimeout(() => {
        this.pathHeld = false;
        this.dynDirty = true;
        this.requestDraw();
      }, HOVER_REST_MS);
    }
    this.path = [];
    this.pathSet.clear();
    this.depSet.clear();
    this.hoverRadius = null;
    if (n && this.traceMode && !this.alloc.has(n.id)) {
      // Trace: the pointer's walk builds the path, each node linked to the one before it.
      const last = this.tracePath[this.tracePath.length - 1];
      if (last === undefined) {
        const p = findPath(this.graph, this.alloc, this.roots(), n.id);
        if (p) this.tracePath = p.slice();
      } else if (n.id !== last) {
        const lastNode = this.nodeById(last);
        if (lastNode && n.linked.includes(last)) {
          const at = this.tracePath.indexOf(n.id);
          if (at >= 0) {
            this.tracePath.splice(at, 1);
            this.tracePath.push(n.id);
          } else if (lastNode.t !== NODE_MASTERY) this.tracePath.push(n.id);
        }
      }
      this.path = this.tracePath.slice();
      for (const id of this.path) this.pathSet.add(id);
    } else if (n) {
      if (this.alloc.has(n.id)) {
        if (n.t !== NODE_CLASS_START && n.t !== NODE_ASCEND_START) {
          // What is cut off is measured from the class and ascendancy starts; every allocated node is a root only for path finding.
          const starts = [...this.alloc].filter((id) => { const t = this.nodeById(id)?.t; return t === NODE_CLASS_START || t === NODE_ASCEND_START; });
          for (const d of dependents(this.graph, this.alloc, starts, n.id)) this.depSet.add(d);
        }
      } else if (n.t !== NODE_MASTERY || n.mastery) {
        const p = findPath(this.graph, this.alloc, this.roots(), n.id);
        if (p) {
          this.path = p;
          for (const id of p) this.pathSet.add(id);
        }
      }
      if (n.t === NODE_SOCKET) {
        this.ringTimer = window.setTimeout(() => {
          if (this.hover !== n || this.destroyed) return;
          this.hoverRadius = this.radiusFor(n);
          this.dynDirty = true;
          this.requestDraw();
        }, RING_REST_MS);
      }
    }
    this.host.style.cursor = n ? 'pointer' : '';
    this.dynDirty = true;
    // Draw now rather than at the next animation frame: the browser still shows it at the next vsync, but the work is
    // done by then and the hover costs one rebuild, not a rebuild plus a wait. Not a full paint: a hover inside the
    // middle canvas only redraws that one (a pending full paint stays full).
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.paint();
    // While a wheel zoom eases or a drag pans, the node's path and dependents are worked out (a click during the zoom
    // still allocates the node under the release point) but no tooltip is sent: it comes when the zoom settles
    // (hoverCursor) or the drag ends.
    if (n && !this.zoomRaf && !this.dragging) this.emitHover(n);
    else this.host.dispatchEvent(new CustomEvent('nodeleave', { bubbles: true, composed: true }));
  }

  private roots(): number[] {
    return [...this.alloc];
  }

  private radiusFor(socket: TNode): Array<{ inner2: number; outer2: number; col: Rgba; packed: number; css: string }> | null {
    const info = this.jewelInfo.get(socket.id);
    const variable = info?.radius === 'Variable';
    const out: Array<{ inner2: number; outer2: number; col: Rgba; packed: number; css: string }> = [];
    for (const r of this.data.jewelRadius) {
      if (variable ? r.inner === 0 : r.inner !== 0) continue;
      const col = hexColor(r.col);
      out.push({ inner2: r.inner * r.inner, outer2: r.outer * r.outer, col, packed: packColor(col[0], col[1], col[2], 1), css: r.col });
    }
    return out;
  }

  /** Where the real pointer is, if it is on node `id`: a hover from search focus or key walking has no pointer position. */
  pointerOn(id: number): { cx: number; cy: number } | null {
    const p = this.pointer;
    return p && this.nodeAt(p[0], p[1])?.id === id ? { cx: p[0], cy: p[1] } : null;
  }

  private emitHover(n: TNode): void {
    const [sx, sy] = this.toScreen(n.x, n.y);
    this.host.dispatchEvent(
      new CustomEvent('nodehover', {
        bubbles: true,
        composed: true,
        detail: { id: n.id, node: this.summary(n), sx, sy, r: this.screenRadius(n), ...this.pointerOn(n.id), path: this.path, alloc: this.alloc.has(n.id), dist: this.path.length, dependents: [...this.depSet] },
      }),
    );
  }

  /** The nodes with the same name as mastery `id` (a mastery's other choices), with their screen positions. */
  sisters(id: number): Array<{ id: number; sx: number; sy: number; alloc: boolean; eff?: number; can: boolean }> {
    const n = this.nodeById(id);
    if (!n) return [];
    const out = [];
    for (const m of this.drawNodes()) {
      if (m === n || m.t !== NODE_MASTERY || m.name !== n.name) continue;
      const [sx, sy] = this.toScreen(m.x, m.y);
      out.push({ id: m.id, sx, sy, alloc: this.alloc.has(m.id), eff: this.masteries.get(m.id), can: this.canReach(m) });
    }
    return out;
  }

  /** A mastery can be picked when a node of its group is allocated. */
  private canReach(m: TNode): boolean {
    for (const l of m.linked) if (this.alloc.has(l)) return true;
    return false;
  }

  masteryDetail(id: number) {
    const n = this.nodeById(id)!;
    const [sx, sy] = this.toScreen(n.x, n.y);
    return { id, node: this.summary(n), sx, sy, r: this.screenRadius(n), alloc: this.alloc.has(id), can: this.canReach(n), eff: this.masteries.get(id), sisters: this.sisters(id), effects: n.mastery?.effects ?? [] };
  }

  /** Allocates a mastery with the given effect id (the engine's id, from `effects`). */
  setMastery(id: number, effect: number): void {
    const n = this.nodeById(id);
    if (!n || n.t !== NODE_MASTERY) return;
    const was = this.alloc.has(id);
    this.masteries.set(id, effect);
    this.alloc.add(id);
    this.dynDirty = true;
    this.requestDraw();
    this.host.dispatchEvent(new CustomEvent('allocchange', { bubbles: true, composed: true, detail: { count: this.alloc.size, added: was ? [] : [id], removed: [], id, mastery: effect } }));
  }

  clearMastery(id: number): void {
    if (!this.alloc.has(id)) return;
    this.masteries.delete(id);
    this.alloc.delete(id);
    this.dynDirty = true;
    this.requestDraw();
    this.host.dispatchEvent(new CustomEvent('allocchange', { bubbles: true, composed: true, detail: { count: this.alloc.size, added: [], removed: [id], id } }));
  }

  /** Same as hovering the node: shows its path and fires nodehover. */
  previewHover(id: number): void {
    const n = this.nodeById(id);
    if (n) this.setHover(n);
  }

  /** Set by the host (Smart pathing): called first on a plain click; returning true means the host handled it. */
  clickGate: ((id: number) => boolean) | null = null;

  private click(n: TNode): void {
    if (this.clickGate && !this.traceMode && this.clickGate(n.id)) return;
    const alloc = this.alloc.has(n.id);
    this.host.dispatchEvent(new CustomEvent('nodeclick', { bubbles: true, composed: true, detail: { id: n.id, node: this.summary(n), alloc, path: this.path, dependents: [...this.depSet], trace: this.traceMode && this.tracePath.length > 1 && this.tracePath[this.tracePath.length - 1] === n.id ? this.tracePath.slice() : undefined } }));
    if (nodeClickPlan({ isMastery: n.t === NODE_MASTERY, hasEffects: !!n.mastery, alloc, chooser: !!this.opts.masteryPicker }) === 'chooser') {
      this.host.dispatchEvent(new CustomEvent('masteryclick', { bubbles: true, composed: true, detail: this.masteryDetail(n.id) }));
      return;
    }
    if (this.opts.autoApply === false) return;
    this.toggle(n);
  }

  private toggle(n: TNode): void {
    if (n.t === NODE_CLASS_START || n.t === NODE_ASCEND_START) return;
    let added: number[] = [];
    let removed: number[] = [];
    if (this.alloc.has(n.id)) {
      removed = [n.id, ...this.depSet];
      for (const id of removed) {
        this.alloc.delete(id);
        this.masteries.delete(id);
      }
    } else if (this.path.length) {
      added = this.path.slice();
      for (const id of added) this.alloc.add(id);
    } else {
      return;
    }
    this.playAlloc(added, removed, n.id);
    this.hover = null;
    this.setHover(n);
    this.dynDirty = true;
    this.requestDraw();
    this.host.dispatchEvent(new CustomEvent('allocchange', { bubbles: true, composed: true, detail: { count: this.alloc.size, added, removed, id: n.id } }));
  }

  // -----------------------------------------------------------------------------------------------------------
  // drawing

  /** Paints immediately (and drops a pending animation-frame paint). */
  drawNow(): void {
    this.needFull = true;
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.paint();
  }

  requestDraw(): void {
    this.needFull = true;
    if (this.raf || this.destroyed) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.paint();
    });
  }

  private stat(layer: number, sheet: number): SpriteBatch {
    const arr = this.staticBatches[layer]!;
    let b = arr.find((x) => x.sheet === sheet);
    if (!b) {
      b = new SpriteBatch(this.gl, sheet, this.cornerBuf);
      arr.push(b);
    }
    return b;
  }

  /** Pushes sprite `i` at (cx, cy); flipV mirrors it vertically; mul scales its size. */
  private put(b: SpriteBatch, i: number, cx: number, cy: number, color: number, flipV = false, rot = 0): void {
    if (i < 0) return;
    const u = this.spU;
    const o = i * 4;
    b.push(cx, cy, this.spH[i * 2]!, this.spH[i * 2 + 1]!, u[o]!, flipV ? u[o + 3]! : u[o + 1]!, u[o + 2]!, flipV ? u[o + 1]! : u[o + 3]!, rot, color);
  }

  private named(name: string | undefined): number {
    if (!name) return -1;
    return this.data.named[name] ?? -1;
  }

  /** Group art, ascendancy emblems and class start art: only changes with the build's class and cluster jewels. */
  private rebuildStatic(): void {
    for (const layer of this.staticBatches) for (const b of layer) b.clear();
    const bg3 = this.named('PSGroupBackground3');
    const bg2 = this.named('PSGroupBackground2');
    const bg1 = this.named('PSGroupBackground1');
    // The design draws no class illustration behind the tree (only the ascendancy emblems and the group art), so none is painted.
    const groupArt = (g: { x: number; y: number; oo: Set<number>; asc?: string; ascStart: boolean; proxy?: boolean }, expansion: boolean, tint: number) => {
      if (g.asc) {
        if (!g.ascStart) return;
        const sel = g.asc === this.curAsc || g.asc === this.curAsc2;
        const sprite = this.named('Classes' + g.asc);
        if (sprite >= 0) this.put(this.stat(L_GROUP, this.spSheet[sprite]!), sprite, g.x, g.y, sel ? tint : packColor(1, 1, 1, 0.5));
        return;
      }
      if (g.oo.has(3)) {
        const s = expansion ? this.named('GroupBackgroundLargeHalfAlt') : bg3;
        if (s < 0) return;
        const b = this.stat(L_GROUP, this.spSheet[s]!);
        const hh = this.spH[s * 2 + 1]!;
        this.put(b, s, g.x, g.y - hh, tint, false);
        this.put(b, s, g.x, g.y + hh, tint, true);
      } else if (g.oo.has(2)) {
        const s = expansion ? this.named('GroupBackgroundMediumAlt') : bg2;
        if (s >= 0) this.put(this.stat(L_GROUP, this.spSheet[s]!), s, g.x, g.y, tint);
      } else if (g.oo.has(1)) {
        const s = expansion ? this.named('GroupBackgroundSmallAlt') : bg1;
        if (s >= 0) this.put(this.stat(L_GROUP, this.spSheet[s]!), s, g.x, g.y, tint);
      }
    };
    for (const g of this.tree.groups.values()) if (!g.proxy) groupArt(g, false, WHITE);
    for (const sg of this.ext.subgraphs) groupArt(sg.group, true, WHITE);
    this.staticVersion++;
    this.staticDirty = false;
  }

  private overlayName(n: TNode, state: 'alloc' | 'path' | 'unalloc'): string | undefined {
    const ov = this.data.overlays[n.t === NODE_NOTABLE ? 'Notable' : n.t === NODE_KEYSTONE ? 'Keystone' : 'Normal'];
    if (!ov) return undefined;
    const key = state + (n.asc ? 'Ascend' : '') + (n.blighted ? 'Blighted' : '');
    const name = ov[key];
    if (typeof name !== 'string') return undefined;
    if (n.asc) {
      const prefix = this.data.prefixes[n.asc];
      if (prefix && this.data.named[prefix + name] !== undefined) return prefix + name;
    }
    return name;
  }

  private jewelOverlay(info: JewelInfo, ex: boolean): string | undefined {
    const b = info.base;
    const alt = ex ? 'Alt' : '';
    if (b === 'Crimson Jewel') return 'JewelSocketActiveRed' + alt;
    if (b === 'Viridian Jewel') return 'JewelSocketActiveGreen' + alt;
    if (b === 'Cobalt Jewel') return 'JewelSocketActiveBlue' + alt;
    if (b === 'Prismatic Jewel') return 'JewelSocketActivePrismatic' + alt;
    if (/Abyss/.test(b) || /^(Searching|Murderous|Hypnotic|Ghastly) Eye/.test(b)) return 'JewelSocketActiveAbyss' + alt;
    if (b === 'Ursine Charm') return 'CharmSocketActiveStr';
    if (b === 'Corvine Charm') return 'CharmSocketActiveInt';
    if (b === 'Lupine Charm') return 'CharmSocketActiveDex';
    if (b === 'Timeless Jewel') return 'JewelSocketActiveLegion' + alt;
    if (b === 'Large Cluster Jewel') return 'JewelSocketActiveAltPurple';
    if (b === 'Medium Cluster Jewel') return 'JewelSocketActiveAltBlue';
    if (b === 'Small Cluster Jewel') return 'JewelSocketActiveAltRed';
    return undefined;
  }

  // ---- precomputed draw data (rebuilt when the tree or the build's cluster jewels change) ----------------------------

  private pn: PNode[] = [];
  /** Each node's frame art diameter in tree units, for rings that hug it. */
  private frameD = new Map<number, number>();
  /** Sprites used as each node's frame/icon, the visible share of each sprite (opaque bounds), and the node's visible frame size in tree units. */
  private frameSpr = new Map<number, number[]>();
  private visRatio = new Map<number, [number, number]>();
  private frameVis = new Map<number, number>();

  /** Reads the sheets' alpha once to find how big each frame really shows (the sprites have a transparent margin). */
  private async measureFrames(): Promise<void> {
    const bySheet = new Map<number, number[]>();
    for (const l of this.frameSpr.values()) for (const i of l) if (!this.visRatio.has(i)) {
      const sh = this.spSheet[i]!;
      if (!bySheet.has(sh)) bySheet.set(sh, []);
      if (!bySheet.get(sh)!.includes(i)) bySheet.get(sh)!.push(i);
    }
    for (const [sh, list] of bySheet) {
      const file = this.data.sheets[sh]?.file;
      if (!file) continue;
      try {
        const bmp = await createImageBitmap(await (await fetch(this.base + file)).blob());
        const c = document.createElement('canvas');
        c.width = bmp.width;
        c.height = bmp.height;
        const g = c.getContext('2d', { willReadFrequently: true })!;
        g.drawImage(bmp, 0, 0);
        bmp.close?.();
        for (const i of list) {
          const [, x, y, w, h] = this.data.sprites[i]!;
          const px = g.getImageData(x!, y!, w!, h!).data;
          let x0 = w!, x1 = -1, y0 = h!, y1 = -1;
          for (let yy = 0; yy < h!; yy++) for (let xx = 0; xx < w!; xx++) if (px[(yy * w! + xx) * 4 + 3]! > 128) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (yy < y0) y0 = yy; if (yy > y1) y1 = yy; }
          this.visRatio.set(i, x1 < 0 ? [1, 1] : [(x1 - x0 + 1) / w!, (y1 - y0 + 1) / h!]);
        }
      } catch { /* the 0.7 estimate stays */ }
    }
    if (this.destroyed) return;
    this.frameVis.clear();
    for (const [id, l] of this.frameSpr) {
      let d = 0;
      for (const i of l) {
        const r = this.visRatio.get(i);
        if (r) d = Math.max(d, this.spH[i * 2]! * 2 * r[0], this.spH[i * 2 + 1]! * 2 * r[1]);
      }
      if (d > 0) this.frameVis.set(id, d);
    }
    this.requestDraw();
  }
  private pc: PConn[] = [];
  private prepFor: Extension | null = null;
  private dynArr: Array<Array<SpriteBatch | undefined>> = [];
  private flag = {
    alloc: new Uint8Array(FLAG_SIZE),
    path: new Uint8Array(FLAG_SIZE),
    dep: new Uint8Array(FLAG_SIZE),
    cmp: new Uint8Array(FLAG_SIZE),
    add: new Uint8Array(FLAG_SIZE),
    rem: new Uint8Array(FLAG_SIZE),
  };

  private prepareDraw(): void {
    if (this.prepFor === this.ext) return;
    this.prepFor = this.ext;
    const pn: PNode[] = [];
    const states: Array<'alloc' | 'path' | 'unalloc'> = ['alloc', 'path', 'unalloc'];
    for (const n of this.drawNodes()) {
      const fr = new Int32Array(3).fill(-1);
      let special = 0;
      let ovSpr = -1;
      if (n.t === NODE_CLASS_START) {
        special = 1;
      } else if (n.t === NODE_ASCEND_START) {
        special = 2;
        let name = 'AscendancyMiddle';
        const prefix = n.asc ? this.data.prefixes[n.asc] : undefined;
        if (prefix && this.data.named[prefix + name] !== undefined) name = prefix + name;
        ovSpr = this.named(name);
      } else if (n.t === NODE_SOCKET) {
        const ovs = this.data.overlays['Socket'];
        states.forEach((s, i) => {
          const nm = ovs?.[s + (n.ex ? 'Alt' : '')];
          if (typeof nm === 'string') fr[i] = this.named((n.name === 'Charm Socket' ? 'Azmeri' : '') + nm);
        });
      } else if (n.t !== NODE_MASTERY) {
        states.forEach((s, i) => {
          const on = this.overlayName(n, s);
          if (on) fr[i] = this.named(on);
        });
      }
      pn.push({ n, fr, special, ovSpr });
    }
    this.pn = pn;

    const pc: PConn[] = [];
    const add = (c: Connector) => {
      const spr = new Int32Array(3);
      CONN_STATES.forEach((s, i) => (spr[i] = this.named(c.type + s)));
      let tile: number[] | null = null;
      if (c.endS !== undefined && c.endS > 1) {
        // Long lines tile the line sprite.
        tile = [];
        const v = c.vert.Normal;
        const k = Math.ceil(c.endS);
        const lerp = (a0: number, a1: number, t: number) => a0 + (a1 - a0) * t;
        for (let i = 0; i < k; i++) {
          const t0 = i / c.endS;
          const t1 = Math.min(1, (i + 1) / c.endS);
          tile.push(
            lerp(v[0]!, v[6]!, t0), lerp(v[1]!, v[7]!, t0), lerp(v[2]!, v[4]!, t0), lerp(v[3]!, v[5]!, t0),
            lerp(v[2]!, v[4]!, t1), lerp(v[3]!, v[5]!, t1), lerp(v[0]!, v[6]!, t1), lerp(v[1]!, v[7]!, t1),
            (t1 - t0) * c.endS,
          );
        }
      }
      pc.push({ c, spr, tile });
    };
    for (const c of this.tree.connectors) add(c);
    for (const c of this.ext.connectors) add(c);
    this.pc = pc;

    // What a hover can repaint: node art round each node, and every connector touching a node (its corners in all states).
    let pad = 0;
    let used: number[] = [];
    const half = (i: number) => {
      if (i >= 0) { pad = Math.max(pad, this.spH[i * 2]!, this.spH[i * 2 + 1]!); used.push(i); }
    };
    // Only art a hover changes counts: frames (path, hover and dependent colours; a socket's frame is its art) and a
    // mastery's inactive and hovered icons. Icons and effects follow allocation alone.
    this.frameD.clear();
    this.frameSpr.clear();
    for (const { n, fr } of pn) {
      const before = pad;
      pad = 0;
      used = [];
      for (const f of fr) half(f);
      if (n.mastery) {
        half(n.mastery.inactive);
        half(n.mastery.connected);
      }
      this.frameD.set(n.id, pad * 2);
      this.frameSpr.set(n.id, used);
      pad = Math.max(pad, before);
    }
    void this.measureFrames();
    // Abyss frames are chosen by name while drawing; a quarter more covers them.
    this.nodePad = pad * 1.25;
    this.connBox = new Float32Array(pc.length * 4);
    this.connsOf = new Map();
    pc.forEach(({ c }, k) => {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const st of CONN_STATES) {
        const v = c.vert[st];
        for (let j = 0; j + 1 < v.length; j += 2) {
          x0 = Math.min(x0, v[j]!);
          x1 = Math.max(x1, v[j]!);
          y0 = Math.min(y0, v[j + 1]!);
          y1 = Math.max(y1, v[j + 1]!);
        }
      }
      this.connBox.set([x0, y0, x1, y1], k * 4);
      for (const id of [c.n1, c.n2]) {
        let l = this.connsOf.get(id);
        if (!l) this.connsOf.set(id, (l = []));
        l.push(k);
      }
    });
  }

  /** Where the current hover changes the picture (tree units): the hovered node, its path or dependents, their
   *  connectors, and a hovered socket's jewel radius. Null with nothing hovered. */
  private hoverBounds(): Box | null {
    const h = this.hover;
    if (!h) return null;
    this.prepareDraw();
    const b: Box = [Infinity, Infinity, -Infinity, -Infinity];
    const pad = this.nodePad;
    const cb = this.connBox;
    const pc = this.pc;
    // A connector changes only when both its ends are allocated, hovered, on the path or dependent (rebuildDynamic).
    const lit = (id: number) => id === h.id || this.alloc.has(id) || this.pathSet.has(id) || this.depSet.has(id);
    const node = (id: number) => {
      const n = id === h.id ? h : this.nodeById(id);
      if (!n) return;
      b[0] = Math.min(b[0], n.x - pad);
      b[1] = Math.min(b[1], n.y - pad);
      b[2] = Math.max(b[2], n.x + pad);
      b[3] = Math.max(b[3], n.y + pad);
      for (const k of this.connsOf.get(id) ?? []) {
        const c = pc[k]!.c;
        if (!lit(c.n1 === id ? c.n2 : c.n1)) continue;
        b[0] = Math.min(b[0], cb[k * 4]!);
        b[1] = Math.min(b[1], cb[k * 4 + 1]!);
        b[2] = Math.max(b[2], cb[k * 4 + 2]!);
        b[3] = Math.max(b[3], cb[k * 4 + 3]!);
      }
    };
    node(h.id);
    for (const id of this.path) node(id);
    for (const id of this.depSet) node(id);
    if (this.hoverRadius) {
      let r = 0;
      for (const x of this.hoverRadius) r = Math.max(r, Math.sqrt(x.outer2));
      r += pad;
      b[0] = Math.min(b[0], h.x - r);
      b[1] = Math.min(b[1], h.y - r);
      b[2] = Math.max(b[2], h.x + r);
      b[3] = Math.max(b[3], h.y + r);
    }
    return b;
  }

  /** True when the tree box lies inside the middle canvas (a null box changes nothing). */
  private inMid(b: Box | null): boolean {
    if (!b) return true;
    const r = this.midRect;
    if (!r) return false;
    const [x0, y0] = this.toScreen(b[0], b[1]);
    const [x1, y1] = this.toScreen(b[2], b[3]);
    return x0 >= r.css[0] + 2 && y0 >= r.css[1] + 2 && x1 <= r.css[2] - 2 && y1 <= r.css[3] - 2;
  }

  private dynBatch(layer: number, sheet: number): SpriteBatch {
    let arr = this.dynArr[layer];
    if (!arr) arr = this.dynArr[layer] = [];
    let b = arr[sheet];
    if (!b) {
      b = new SpriteBatch(this.gl, sheet, this.cornerBuf);
      if (layer === L_SEARCH) b.scaleKind = 'ring';
      arr[sheet] = b;
      this.dynBatches[layer]!.set(sheet, b);
    }
    return b;
  }

  private setFlags(f: Uint8Array, ids: Iterable<number> | null | undefined): void {
    f.fill(0);
    if (!ids) return;
    for (const id of ids) if (id >= 0 && id < FLAG_SIZE) f[id] = 1;
  }

  /** Connectors, node art, rings: everything that changes with allocation, hover, search and compare. */
  private rebuildDynamic(): void {
    this.prepareDraw();
    for (const m of this.dynBatches) for (const b of m.values()) b.clear();
    for (const q of this.quads.values()) q.clear();
    const hover = this.hover;
    const hoverId = hover?.id ?? -1;
    const pathOn = !!hover && this.path.length > 0 && !this.pathHeld;
    const fl = this.flag;
    this.setFlags(fl.alloc, this.alloc);
    this.setFlags(fl.path, this.pathHeld ? NO_NODES : this.pathSet);
    this.setFlags(fl.dep, this.pathHeld ? NO_NODES : this.depSet);
    this.setFlags(fl.cmp, this.compareAlloc);
    this.setFlags(fl.add, this._overlay?.added);
    this.setFlags(fl.rem, this._overlay?.removed);
    const alloc = fl.alloc;
    const pathF = fl.path;
    const depF = fl.dep;
    const cmpF = fl.cmp;
    const hasCmp = !!this.compareAlloc;
    const hasAdd = !!this._overlay?.added?.length;
    const hasRem = !!this._overlay?.removed?.length;
    // Smart pathing marks are rings only: the links around them keep their normal colour.
    const tint = !this._overlay?.ringsOnly;
    const addF = fl.add;
    const remF = fl.rem;
    const hasDep = this.depSet.size > 0 && !this.pathHeld;
    const u = this.spU;
    const sheetOf = this.spSheet;
    const curAsc = this.curAsc;
    const curAsc2 = this.curAsc2;
    const cWhite = WHITE;
    const cFade = packColor(0.75, 0.75, 0.75, 1);
    const cRed = packColor(1, 0, 0, 1);
    const cGreen = packColor(0, 1, 0, 1);
    const cBlue = packColor(0, 0, 1, 1);

    // ---- connectors
    for (const { c, spr, tile } of this.pc) {
      const n1 = c.n1;
      const n2 = c.n2;
      const a = alloc[n1] === 1;
      const b = alloc[n2] === 1;
      let si = a && b ? 2 : pathOn && (a || n1 === hoverId || pathF[n1] === 1) && (b || n2 === hoverId || pathF[n2] === 1) ? 1 : 0;
      let color = cWhite;
      if (hasCmp) {
        const base = cmpF[n1] === 1 && cmpF[n2] === 1 ? 2 : 0;
        if (base === 2 && si !== 2) {
          si = 2;
          color = cGreen;
        } else if (base !== 2 && si === 2) {
          color = cRed;
        }
      }
      if (tint && hasAdd && (addF[n1] === 1 || addF[n2] === 1) && (a || addF[n1] === 1) && (b || addF[n2] === 1)) {
        si = 2;
        color = cGreen;
      }
      if (tint && hasRem && (remF[n1] === 1 || remF[n2] === 1) && (a || remF[n1] === 1) && (b || remF[n2] === 1)) {
        si = 2;
        color = cRed;
      }
      if (hasDep && (depF[n1] === 1 || n1 === hoverId) && (depF[n2] === 1 || n2 === hoverId)) color = cRed;
      else if (c.asc !== undefined && c.asc !== curAsc && c.asc !== curAsc2) color = cFade;
      const sprite = spr[si]!;
      if (sprite < 0) continue;
      const sheet = sheetOf[sprite]!;
      let q = this.quads.get(sheet);
      if (!q) this.quads.set(sheet, (q = new QuadBatch(this.gl, sheet, this.indexBuf)));
      if (tile) {
        for (let o = 0; o < tile.length; o += 9) {
          const ul = tile[o + 8]!;
          q.pushTile(tile, o, ul, u, sprite * 4, color);
        }
      } else {
        q.push(c.vert[CONN_STATES[si]!], c.uv, u, sprite * 4, color);
      }
    }

    // ---- nodes
    const power = this._heat ? this.power : null;
    const classStart = this.classStartId;
    const inactiveStart = this.named('PSStartNodeBackgroundInactive');
    const putTo = (layer: number, i: number, x: number, y: number, color: number) => {
      if (i < 0) return;
      const b = this.dynBatch(layer, sheetOf[i]!);
      const o = i * 4;
      b.push(x, y, this.spH[i * 2]!, this.spH[i * 2 + 1]!, u[o]!, u[o + 1]!, u[o + 2]!, u[o + 3]!, 0, color);
    };
    const radius = this.hoverRadius;
    const previewSocket = this.radiusPreview ? this.nodeById(this.radiusPreview.socket) : undefined;
    const previewBands = this.radiusPreview && previewSocket ? this.radiusBands(this.radiusPreview.label, this.radiusPreview.index) : null;
    for (const { n, fr, special, ovSpr } of this.pn) {
      const id = n.id;
      if (special === 1) {
        putTo(L_FRAME, id === classStart ? n.startArt : inactiveStart, n.x, n.y, cWhite);
        continue;
      }
      if (special === 2) {
        putTo(L_FRAME, ovSpr, n.x, n.y, cWhite);
        continue;
      }
      const cm = hasCmp ? cmpF[id] === 1 : false;
      const isAlloc = alloc[id] === 1 || cm;
      // Colour of the node's art in compare mode: only there green, only here red, changed mastery or jewel blue.
      let cpk = cWhite;
      if (hasCmp) {
        const a = alloc[id] === 1;
        if (cm && !a) cpk = cGreen;
        else if (!cm && a) cpk = cRed;
        else if (n.t === NODE_MASTERY && cm && a && this.masteries.get(id) !== this.compareMasteries?.get(id)) cpk = cBlue;
        else if (n.t === NODE_SOCKET && cm && a && this.jewels.get(id) !== this.compareJewels?.get(id)) cpk = cBlue;
      }
      let tint = cpk;
      const state = isAlloc || power || n === hover ? 0 : pathF[id] === 1 ? 1 : 2;
      let base = -1;
      let effect = -1;
      let frame = fr[state]!;
      // An abyss-conquered notable or keystone gets the abyss frames (PassiveTreeView.lua: isAbyssConquered).
      if ((n.t === NODE_NOTABLE || n.t === NODE_KEYSTONE) && this.overrides.get(id)?.abyss) {
        const an = this.named(`Abyss${n.asc ? 'Ascendancy' : n.t === NODE_KEYSTONE ? 'Keystone' : 'Notable'}Frame${['Allocated', 'CanAllocate', 'Unallocated'][state]}`);
        if (an >= 0) frame = an;
      }
      if (n.t === NODE_SOCKET) {
        base = frame;
        frame = -1;
        const info = this.jewelInfo.get(id);
        if (isAlloc && info) {
          const jn = this.jewelOverlay(info, !!n.ex);
          if (jn) frame = this.named(jn);
        }
      } else if (n.t === NODE_MASTERY) {
        if (n.mastery) {
          if (isAlloc) {
            base = n.mastery.active;
            effect = n.mastery.effect;
          } else if (n === hover) {
            base = n.mastery.connected;
          } else {
            base = n.mastery.inactive;
          }
        } else {
          base = n.masteryBase;
        }
      } else {
        base = isAlloc || power ? n.iconActive : n.iconInactive;
        // A tattooed node shows the tattoo's icon and its glow, and a node the build conquers keeps its own art.
        const ov = this.overrides.get(id);
        const tat = ov?.tattoo ? this.data.tattoos?.[ov.name] : undefined;
        if (tat) {
          const ic = tat.ic[isAlloc ? 0 : 1];
          if (ic >= 0) base = ic;
          if (tat.fx >= 0 && isAlloc) effect = tat.fx;
        }
      }
      // A jewel socket's art is its frame, and a mastery's is a faint emblem rather than an icon inside a frame: blackened for "no
      // power" either shows as a solid dark blot instead of a node, so they keep their own art unless the heat view has
      // something to say about them (sockets carry no power).
      const noPowerMastery = n.t === NODE_MASTERY && !((power?.get(id)?.offence ?? 0) > 0 || (power?.get(id)?.defence ?? 0) > 0);
      if (power && !isAlloc && !noPowerMastery && n.t !== NODE_SOCKET) {
        const p = power.get(id);
        if (p) {
          // PassiveTreeView.lua: one stat is a single channel, offence and defence mix into the third.
          const off = Math.min(Math.sqrt(Math.max(p.offence, 0) * 1.5), 1);
          const def = Math.min(Math.sqrt(Math.max(p.defence, 0) * 1.5), 1);
          const mix = Math.min((Math.max(off - 0.5, 0) + Math.max(def - 0.5, 0)) / 2, 1);
          const th = this.heatTheme;
          let r: number, g: number, b: number;
          if (this.heatSingle) [r, g, b] = th === 'red-green' ? [0, off, 0] : th === 'green-blue' ? [0, 0, off] : [off, 0, 0];
          else [r, g, b] = th === 'red-green' ? [off, def, mix] : th === 'green-blue' ? [mix, off, def] : [off, mix, def];
          // Upstream multiplies the icon by this colour: weak nodes go near black, strong ones bright red or blue. HEAT_FLOOR keeps them findable.
          tint = packColor(Math.max(r, HEAT_FLOOR), Math.max(g, HEAT_FLOOR), Math.max(b, HEAT_FLOOR), 1);
        } else {
          tint = packColor(HEAT_FLOOR, HEAT_FLOOR, HEAT_FLOOR, 1);
        }
      }
      if (effect >= 0) putTo(L_EFFECT, effect, n.x, n.y, cpk);
      if (base >= 0) putTo(n.t === NODE_SOCKET ? L_FRAME : L_ICON, base, n.x, n.y, n.t === NODE_SOCKET && depF[id] === 1 ? cRed : tint);
      if (frame >= 0) {
        // PassiveTreeView.lua leaves the heat colour set while it draws the frame, so the ring is tinted with the art.
        let oc = tint;
        if (hover && hover !== n) {
          if (depF[id] === 1) oc = cRed;
          else if (radius) {
            const dx = n.x - hover.x;
            const dy = n.y - hover.y;
            const d2 = dx * dx + dy * dy;
            for (const r of radius) {
              if (d2 >= r.inner2 && d2 <= r.outer2) {
                oc = r.packed;
                break;
              }
            }
          }
        }
        if (previewBands && previewSocket && oc === tint) {
          const dx = n.x - previewSocket.x;
          const dy = n.y - previewSocket.y;
          const d2 = dx * dx + dy * dy;
          for (const b of previewBands) {
            if (d2 >= b.inner * b.inner && d2 <= b.outer * b.outer) {
              oc = b.packed;
              break;
            }
          }
        }
        putTo(L_FRAME, frame, n.x, n.y, oc);
      }
    }

    // ---- rings: jewel radius for the hovered socket, radii of allocated sockets with radius jewels, search matches
    const ring = this.procSheet;
    const ringSprite = (cx: number, cy: number, half: number, color: Rgba, batchLayer: number, thick = false) => {
      const b = this.dynBatch(batchLayer, ring);
      b.push(cx, cy, half, half, thick ? 0.5 : 0, 0, thick ? 1 : 0.5, 1, 0, packColor(color[0], color[1], color[2], color[3]));
    };
    for (const [socketId, info] of this.jewelInfo) {
      if (alloc[socketId] !== 1 || !info.radius) continue;
      const s = this.nodeById(socketId);
      if (!s) continue;
      const rd = this.data.jewelRadius.find((r) => r.label === info.radius && r.inner === 0);
      if (!rd) continue;
      this.drawJewelRadius(s, info, rd.outer);
    }
    if (previewBands && previewSocket && this.radiusPreview) {
      for (const b of previewBands) {
        if (b.inner === 0) continue;
        ringSprite(previewSocket.x, previewSocket.y, b.outer, b.col, L_RING);
        if (b.inner > 0) ringSprite(previewSocket.x, previewSocket.y, b.inner, b.col, L_RING);
      }
      const fixed = previewBands.find((b) => b.inner === 0);
      if (fixed) this.drawJewelRadius(previewSocket, { title: this.radiusPreview.title, base: '', radius: this.radiusPreview.label }, fixed.outer);
    }
    if (this.matchSet.size) {
      const sc = hexColor(this.opts.searchColor ?? searchHighlightHex(this.host));
      for (const id of this.matchSet) {
        const n = this.nodeById(id);
        if (n) ringSprite(n.x, n.y, Math.sqrt(n.rsq || 900) * 1.35, sc, L_SEARCH, true);
      }
    }
    if (hasAdd || hasRem) {
      const rr = (ids: number[] | undefined, col: Rgba) => {
        for (const id of ids ?? []) {
          const n = this.nodeById(id);
          if (n) ringSprite(n.x, n.y, Math.max(40, Math.sqrt(n.rsq || 2500) * 1.25), col, L_RING, true);
        }
      };
      rr(this._overlay?.added, GREEN);
      rr(this._overlay?.removed, RED);
    }
    this.version++;
    this.dynDirty = false;
  }

  /** The rested-on socket's jewel radii as hairlines: the same width at every zoom, which a stretched ring sprite cannot be. */
  private drawHoverRings(): void {
    const radius = this.hoverRadius;
    const h = this.hover;
    if (!this.ringLayer) {
      if (!radius) return;
      this.ringLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      this.ringLayer.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
      this.host.appendChild(this.ringLayer);
    }
    const layer = this.ringLayer;
    if (!radius || !h) {
      if (layer.childElementCount) layer.replaceChildren();
      return;
    }
    layer.setAttribute('viewBox', `0 0 ${this.w} ${this.h}`);
    const [cx, cy] = this.toScreen(h.x, h.y);
    const circle = (r: number, css: string) => {
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', String(cx));
      c.setAttribute('cy', String(cy));
      c.setAttribute('r', String(r * this.view.s));
      c.setAttribute('fill', 'none');
      c.setAttribute('stroke', css);
      c.setAttribute('stroke-width', '1.5');
      c.setAttribute('stroke-opacity', '.6');
      c.setAttribute('vector-effect', 'non-scaling-stroke');
      return c;
    };
    layer.replaceChildren(...radius.flatMap((r) => (r.inner2 > 0 ? [circle(Math.sqrt(r.outer2), r.css), circle(Math.sqrt(r.inner2), r.css)] : [circle(Math.sqrt(r.outer2), r.css)])));
  }

  private drawJewelRadius(socket: TNode, info: JewelInfo, outer: number): void {
    let sprite1 = -1;
    let sprite2 = -1;
    for (const [re, prefix] of TIMELESS_RINGS) {
      if (re.test(info.title)) {
        sprite1 = this.named(prefix + 'JewelCircle1');
        sprite2 = this.named(prefix + 'JewelCircle2');
      }
    }
    if (sprite1 < 0) {
      sprite1 = this.named('JewelCircle1');
      sprite2 = this.named('JewelCircle1Inverse');
    }
    const tint = packColor(1, 1, 1, 0.7);
    const put = (i: number, rot: number) => {
      if (i < 0) return;
      const b = this.dynBatch(L_RING, this.spSheet[i]!);
      const u = this.spU;
      b.push(socket.x, socket.y, outer, outer, u[i * 4]!, u[i * 4 + 1]!, u[i * 4 + 2]!, u[i * 4 + 3]!, rot, tint);
    };
    put(sprite1, -0.7);
    put(sprite2, 0.7);
  }

  paint(): void {
    if (this.destroyed || !this.shared || !this.w) return;
    const gl = this.gl;
    const t0 = performance.now();
    let rebuildMs = 0;
    if (this.staticDirty || this.dynDirty) {
      const r0 = performance.now();
      if (this.staticDirty) this.rebuildStatic();
      if (this.dynDirty) this.rebuildDynamic();
      rebuildMs = performance.now() - r0;
    }
    // The frame is drawn into the top left of the shared surface (GL counts rows from the bottom).
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    fitSurface(this.shared, cw, ch);
    gl.viewport(0, this.shared.surface.height - ch, cw, ch);
    const bg = hexColor(this.opts.background ?? '#07090c');
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const v = this.view;
    let calls = 0;
    let instances = 0;
    let quads = 0;

    // background tile
    const bgSprite = this.named('Background2');
    if (bgSprite >= 0 && this.loaded[this.spSheet[bgSprite]!]) {
      gl.useProgram(this.bgProg);
      gl.uniform4f(gl.getUniformLocation(this.bgProg, 'u_view'), v.x, v.y, v.s, 0);
      gl.uniform2f(gl.getUniformLocation(this.bgProg, 'u_res'), this.w, this.h);
      gl.uniform1f(gl.getUniformLocation(this.bgProg, 'u_tile'), (this.data.sprites[bgSprite]![3]! * SPRITE_HALF * 2.5));
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.textures[this.spSheet[bgSprite]!]!);
      gl.uniform1i(gl.getUniformLocation(this.bgProg, 'u_tex'), 0);
      gl.bindVertexArray(this.bgVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      calls++;
    }

    const zoom = (v.s * this.data.size) / Math.min(this.w, this.h);
    const drawSprites = (b: SpriteBatch, ver = this.version) => {
      if (!b.n || !this.loaded[b.sheet]) return;
      b.upload(gl, ver);
      gl.bindTexture(gl.TEXTURE_2D, this.textures[b.sheet]!);
      // Search circles hug their node (1.35 times its radius) and never shrink below 8 px, as the design draws them.
      gl.uniform1f(this.uHs, b.scaleKind === 'ring' ? Math.max(1, 8 / (Math.sqrt(900) * 1.35 * v.s)) : 1);
      gl.bindVertexArray(b.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, b.n);
      calls++;
      instances += b.n;
    };
    gl.useProgram(this.spriteProg);
    this.uHs = gl.getUniformLocation(this.spriteProg, 'u_hs')!;
    gl.uniform4f(gl.getUniformLocation(this.spriteProg, 'u_view'), v.x, v.y, v.s, 0);
    gl.uniform2f(gl.getUniformLocation(this.spriteProg, 'u_res'), this.w, this.h);
    gl.uniform1i(gl.getUniformLocation(this.spriteProg, 'u_tex'), 0);
    gl.activeTexture(gl.TEXTURE0);
    for (const b of this.staticBatches[L_GROUP]!) drawSprites(b, this.staticVersion);

    // Mastery and other effect sprites go first, then connectors (so orbit arcs stay visible over an effect), then icons, frames, rings.
    gl.useProgram(this.spriteProg);
    for (const b of this.dynBatches[L_EFFECT]!.values()) drawSprites(b);

    // connectors
    gl.useProgram(this.quadProg);
    gl.uniform4f(gl.getUniformLocation(this.quadProg, 'u_view'), v.x, v.y, v.s, 0);
    gl.uniform2f(gl.getUniformLocation(this.quadProg, 'u_res'), this.w, this.h);
    gl.uniform1i(gl.getUniformLocation(this.quadProg, 'u_tex'), 0);
    for (const q of this.quads.values()) {
      if (!q.n || !this.loaded[q.sheet]) continue;
      q.upload(gl, this.version);
      gl.bindTexture(gl.TEXTURE_2D, this.textures[q.sheet]!);
      gl.bindVertexArray(q.vao);
      gl.drawElements(gl.TRIANGLES, q.n * 6, gl.UNSIGNED_INT, 0);
      calls++;
      quads += q.n;
    }

    gl.useProgram(this.spriteProg);
    for (let layer = L_ICON; layer < LAYERS; layer++) {
      for (const b of this.dynBatches[layer]!.values()) drawSprites(b);
    }
    gl.bindVertexArray(null);
    this.present(cw, ch);
    this.fx?.follow(this.view);
    if (this.syncAfterPaint) gl.finish();
    this.lastStats = { paintMs: performance.now() - t0, rebuildMs, instances, quads, drawCalls: calls };
    this.drawHoverRings();
    this.host.dispatchEvent(new Event('treepaint'));
  }

  private uHs: WebGLUniformLocation | null = null;

  /** Paints that updated the full canvas, and paints that updated only the middle one (for benchmarks). */
  readonly presents = { full: 0, mid: 0 };

  /** Copies the frame to the display canvases: the middle one always, the full one unless only a hover inside the middle changed. */
  private present(cw: number, ch: number): void {
    const src = this.shared!.surface;
    const box = this.hoverBounds();
    const r = this.midRect;
    const full = this.needFull || !r || !this.midCtx || !this.inMid(box) || !this.inMid(this.shownHoverBox);
    if (full && r && this.midCtx) {
      // The middle canvas covers the centre of the full one: only the four bands round it are copied.
      const g = this.ctx2d;
      const band = (x: number, y: number, w: number, h: number) => w > 0 && h > 0 && g.drawImage(src, x, y, w, h, x, y, w, h);
      band(0, 0, cw, r.y);
      band(0, r.y + r.h, cw, ch - r.y - r.h);
      band(0, r.y, r.x, r.h);
      band(r.x + r.w, r.y, cw - r.x - r.w, r.h);
    } else if (full) this.ctx2d.drawImage(src, 0, 0, cw, ch, 0, 0, cw, ch);
    if (full) this.presents.full++;
    else this.presents.mid++;
    if (r && this.midCtx) this.midCtx.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    this.shownHoverBox = box;
    this.needFull = false;
  }
}
