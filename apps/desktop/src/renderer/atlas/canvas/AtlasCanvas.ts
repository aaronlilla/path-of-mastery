import { fitView, hitNode, nodeRadius, screenPoint, worldPoint, type CanvasModel, type Overlay, type Point, type View } from './model.js';
import type { ArtResolver, NodeArt, Sprite, SpriteSource } from './art.js';
import { tr } from '../../i18n';

// Atlas tree renderer (Canvas 2D). The atlas has under 1,000 nodes, so a 2D canvas with culling repaints a full frame in a
// few milliseconds and gives us what the old WebGL path lacked: filled node discs, round-clipped icons, orbit arcs and text.
// It paints only when something changed (state, view, size, art arriving).
export type PaintState = { allocated: readonly string[]; matches: ReadonlySet<string>; repair: ReadonlySet<string>; focused: string | null; overlay: Overlay | null; marks?: ReadonlyMap<string, 'want' | 'avoid'> };
export type CanvasCallbacks = { hover: (id: string | null) => void; activate: (id: string) => void; /** Right-click on a node; return true when handled (the browser menu is then suppressed). */ secondary?: (id: string) => boolean; status: (status: 'ready' | 'lost' | 'unavailable') => void; view?: (view: View) => void };

const ICON_PX = 64;
const TILE = 128, MAX_TILES = 400; // art tiles in device px; 400 tiles hold ~26 MB (more when the screen needs them)
const images = new Map<string, Promise<HTMLImageElement | null>>();
function loadImage(url: string): Promise<HTMLImageElement | null> {
  let hit = images.get(url);
  if (!hit) {
    hit = new Promise(done => { const image = new Image(); image.onload = () => done(image); image.onerror = () => done(null); image.src = url; });
    images.set(url, hit);
  }
  return hit;
}

export class AtlasCanvas {
  private ctx: CanvasRenderingContext2D;
  private frame = 0;
  private disposed = false;
  private observer: ResizeObserver;
  private view: View = { x: 0, y: 0, scale: 0.1 };
  private sized = false;
  private width = 1;
  private height = 1;
  private dpr = 1;
  private state: PaintState = { allocated: [], matches: new Set(), repair: new Set(), focused: null, overlay: null };
  private allocated = new Set<string>();
  /** Unallocated nodes next to an allocated one (through gateway links too): drawn with the CanAllocate frame. */
  private reachable = new Set<string>();
  private patterns = new WeakMap<object, CanvasPattern | null>();
  private tiles = new Map<string, HTMLCanvasElement>();
  private stale: { z: number; tiles: Map<string, HTMLCanvasElement> } | null = null;
  private spare: HTMLCanvasElement[] = [];
  private tileKey = '';
  private tileZ = 0;
  /** Bumped when the allocation changes: the art tiles repaint. */
  private layerVersion = 0;
  private pointer: { id: number; x: number; y: number; moved: boolean } | null = null;
  private hovered: string | null = null;
  private cleanups: (() => void)[] = [];
  private icons = new Map<string, HTMLCanvasElement | null>();

  constructor(readonly canvas: HTMLCanvasElement, readonly model: CanvasModel, private callbacks: CanvasCallbacks, private art?: ArtResolver, initialView?: View) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas display is unavailable.');
    this.ctx = ctx;
    if (initialView && Number.isFinite(initialView.x) && Number.isFinite(initialView.y) && Number.isFinite(initialView.scale) && initialView.scale > 0) {
      this.view = { ...initialView }; this.sized = true;
    }
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas);
    this.listen('pointerdown', (e: PointerEvent) => {
      if (e.button !== 0) return;
      canvas.focus(); canvas.setPointerCapture(e.pointerId);
      this.pointer = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
    });
    this.listen('pointermove', (e: PointerEvent) => {
      if (this.pointer) {
        const dx = e.clientX - this.pointer.x, dy = e.clientY - this.pointer.y;
        if (this.pointer.moved || Math.hypot(dx, dy) > 3) {
          this.pointer.moved = true; canvas.dataset.dragging = 'true';
          this.view = { ...this.view, x: this.view.x - dx / this.view.scale, y: this.view.y - dy / this.view.scale };
          this.pointer.x = e.clientX; this.pointer.y = e.clientY;
          this.setHover(null); this.changedView();
        }
      } else this.setHover(this.hit(e));
    });
    this.listen('pointerup', (e: PointerEvent) => {
      const p = this.pointer; this.pointer = null; delete canvas.dataset.dragging;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      if (p && !p.moved) { const id = this.hit(e); if (id) this.callbacks.activate(id); }
    });
    this.listen('contextmenu', e => { const id = this.hit(e); if (id && this.callbacks.secondary?.(id)) e.preventDefault(); });
    this.listen('pointercancel', () => { this.pointer = null; delete canvas.dataset.dragging; this.setHover(null); });
    this.listen('lostpointercapture', () => { this.pointer = null; delete canvas.dataset.dragging; });
    this.listen('pointerleave', e => {
      if (!this.pointer && (!(e.relatedTarget instanceof Node) || !canvas.parentElement?.contains(e.relatedTarget))) this.setHover(null);
    });
    this.listen('wheel', (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect(), delta = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
      this.zoomAt(Math.exp(-Math.max(-300, Math.min(300, delta)) * 0.0015), { x: e.clientX - rect.left, y: e.clientY - rect.top });
    }, { passive: false });
    this.listen('keydown', (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 'f') this.fit(this.state.allocated);
      else if (key === '+' || key === '=') this.zoom(1.25);
      else if (key === '-') this.zoom(1 / 1.25);
      else if (key.startsWith('arrow')) {
        const delta = 64 / this.view.scale;
        this.view = { ...this.view, x: this.view.x + (key === 'arrowleft' ? -delta : key === 'arrowright' ? delta : 0),
          y: this.view.y + (key === 'arrowup' ? -delta : key === 'arrowdown' ? delta : 0) };
        this.changedView();
      } else return;
      e.preventDefault();
    });
    // Light/dark switches change the stage colours: repaint (styles settle on the next frame).
    const themes = new MutationObserver(() => this.schedule());
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode', 'data-theme'] });
    this.cleanups.push(() => themes.disconnect());
    this.callbacks.status('ready');
    this.resize();
  }

  private listen<K extends keyof HTMLElementEventMap>(event: K, fn: (e: HTMLElementEventMap[K]) => void, options?: AddEventListenerOptions): void {
    this.canvas.addEventListener(event, fn, options);
    this.cleanups.push(() => this.canvas.removeEventListener(event, fn, options));
  }
  private setHover(id: string | null): void {
    if (id === this.hovered) return;
    this.hovered = id; this.canvas.dataset.hover = id ?? '';
    this.callbacks.hover(id); this.schedule();
  }
  private hit(e: MouseEvent): string | null {
    const rect = this.canvas.getBoundingClientRect();
    return hitNode(this.model, { x: e.clientX - rect.left, y: e.clientY - rect.top }, this.view, this.width, this.height);
  }
  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, rect.width); this.height = Math.max(1, rect.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.width * this.dpr); this.canvas.height = Math.round(this.height * this.dpr);
    if (!this.sized && rect.width > 0 && rect.height > 0) { this.sized = true; this.fit(this.state.allocated); }
    this.schedule(); // one paint per frame: a resize and a state change in the same frame share it
  }
  setState(state: PaintState): void {
    this.state = state;
    // The start node beside the root is always allocated in game (cost 0), so its links light up like GGG's atlas start.
    const graph = this.model.graph;
    this.allocated = new Set([graph.rootId, ...graph.adjacent.get(graph.rootId) ?? [], ...state.allocated]);
    this.reachable = new Set([...this.allocated].flatMap(id => graph.adjacent.get(id) ?? []).filter(id => !this.allocated.has(id)));
    const painted = [...state.allocated].sort().join(',');
    if (painted !== this.canvas.dataset.allocated) this.layerVersion++;
    this.canvas.dataset.allocated = painted; // the exact node set painted, for checks
    this.schedule();
  }
  setView(view: View): void {
    if (!Number.isFinite(view.x) || !Number.isFinite(view.y) || !Number.isFinite(view.scale) || view.scale <= 0) return;
    if (view.x === this.view.x && view.y === this.view.y && view.scale === this.view.scale) return;
    this.view = { ...view }; this.schedule();
  }
  getView(): View { return { ...this.view }; }
  /** Screen position (CSS px inside the canvas) of a node, for the tooltip. */
  nodeScreen(id: string): { x: number; y: number; r: number } | null {
    const n = this.model.nodes[this.model.denseById.get(id) ?? -1];
    if (!n?.position) return null;
    const p = screenPoint(n.position, this.view, this.width, this.height);
    return { ...p, r: Math.max(3, nodeRadius(n) * this.view.scale) };
  }
  fit(ids: readonly string[]): void {
    const view = fitView(this.model, ids, this.width, this.height);
    if (view) { this.view = view; this.changedView(); }
  }
  focusNode(id: string): void {
    const p = this.model.nodes[this.model.denseById.get(id) ?? -1]?.position;
    if (p) { this.view = { x: p.x, y: p.y, scale: Math.max(this.view.scale, 0.35) }; this.changedView(); }
  }
  zoom(factor: number): void { this.zoomAt(factor, { x: this.width / 2, y: this.height / 2 }); }
  private zoomAt(factor: number, at: { x: number; y: number }): void {
    const before = worldPoint(at, this.view, this.width, this.height);
    const scale = Math.min(4, Math.max(0.02, this.view.scale * factor));
    this.view = { scale, x: before.x - (at.x - this.width / 2) / scale, y: before.y - (at.y - this.height / 2) / scale };
    this.changedView();
  }
  private changedView(): void { this.callbacks.view?.({ ...this.view }); this.schedule(); }
  private schedule(): void {
    if (this.frame || this.disposed) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.paint(); });
  }

  /** A round-clipped copy of the node's icon, cached per sprite rectangle; null while the sheet loads or when missing. */
  private icon(art: NodeArt): HTMLCanvasElement | null {
    const key = `${art.url}|${art.x},${art.y},${art.w},${art.h}`;
    if (this.icons.has(key)) return this.icons.get(key)!;
    this.icons.set(key, null);
    void loadImage(art.url).then(image => {
      if (!image || this.disposed) return;
      const c = document.createElement('canvas'); c.width = c.height = ICON_PX;
      const g = c.getContext('2d'); if (!g) return;
      g.beginPath(); g.arc(ICON_PX / 2, ICON_PX / 2, ICON_PX / 2, 0, Math.PI * 2); g.clip();
      g.drawImage(image, art.x, art.y, art.w, art.h, 0, 0, ICON_PX, ICON_PX);
      this.icons.set(key, c); this.schedule();
    });
    return null;
  }
  private css(name: string, fallback: string): string { return getComputedStyle(this.canvas).getPropertyValue(name).trim() || fallback; }

  /**
   * The art layer in screen tiles, like GGG's renderer: each TILE x TILE device-pixel tile is painted once per scale and
   * allocation state, then panning only copies tiles (a full repaint of ~4,000 sprites takes ~80 ms on a CPU canvas).
   * New tiles paint within a small per-frame budget; until a new scale is ready the previous scale's tiles stand in.
   * Returns the node icons on screen (the proof hook).
   */
  private paintTiles(sprite: SpriteSource): number {
    const ctx = this.ctx, z = this.view.scale * this.dpr, key = `${z}|${this.layerVersion}`;
    if (key !== this.tileKey) {
      if (this.tiles.size) this.stale = { z: this.tileZ, tiles: this.tiles };
      this.tiles = new Map(); this.tileKey = key; this.tileZ = z;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const W = this.canvas.width, H = this.canvas.height;
    const ox = Math.round(W / 2 - this.view.x * z), oy = Math.round(H / 2 - this.view.y * z);
    if (this.stale) {
      const s = this.stale, k = z / s.z, sx = W / 2 - this.view.x * z, sy = H / 2 - this.view.y * z;
      for (const [id, tile] of s.tiles) { const [tx, ty] = id.split(',').map(Number); ctx.drawImage(tile, sx + tx! * TILE * k, sy + ty! * TILE * k, TILE * k, TILE * k); }
    }
    // The cache must hold every tile on screen, or painting the last ones evicts the first and the canvas never settles.
    const cap = Math.max(MAX_TILES, (Math.ceil(W / TILE) + 1) * (Math.ceil(H / TILE) + 1));
    const deadline = performance.now() + 8; let missing = false;
    for (let ty = Math.floor(-oy / TILE); ty * TILE + oy < H; ty++) for (let tx = Math.floor(-ox / TILE); tx * TILE + ox < W; tx++) {
      const id = `${tx},${ty}`; let tile = this.tiles.get(id);
      if (tile) { this.tiles.delete(id); this.tiles.set(id, tile); } // most recently used last
      else if (performance.now() < deadline) {
        tile = this.spare.pop() ?? document.createElement('canvas'); tile.width = tile.height = TILE;
        const g = tile.getContext('2d')!, wt = TILE / z;
        g.setTransform(z, 0, 0, z, -tx * TILE, -ty * TILE);
        this.paintArt(g, sprite, { x: tx * wt, y: ty * wt }, { x: (tx + 1) * wt, y: (ty + 1) * wt });
        this.tiles.set(id, tile);
        while (this.tiles.size > cap) { const [old, c] = this.tiles.entries().next().value!; this.tiles.delete(old); this.spare.push(c); }
      } else { missing = true; continue; }
      ctx.drawImage(tile, ox + tx * TILE, oy + ty * TILE);
    }
    if (missing) this.schedule(); else this.stale = null;
    const tl = worldPoint({ x: 0, y: 0 }, this.view, this.width, this.height), br = worldPoint({ x: this.width, y: this.height }, this.view, this.width, this.height);
    return this.model.nodes.filter(n => n.position && n.position.x > tl.x && n.position.x < br.x && n.position.y > tl.y && n.position.y < br.y && this.iconOf(n, sprite, z)).length;
  }
  private iconOf(n: CanvasModel['nodes'][number], sprite: SpriteSource, z: number): Sprite | null {
    const kind = n.type === 'Notable' ? 'notable' : n.type === 'Keystone' ? 'keystone' : n.type === 'Wormhole' ? 'wormhole' : n.type === 'Mastery' ? 'mastery' : 'normal';
    const name = kind === 'wormhole' ? 'Wormhole' : n.icon;
    return name ? sprite(kind === 'mastery' ? 'mastery' : `${kind}${this.allocated.has(n.nodeId) ? 'Active' : 'Inactive'}`, name, z) : null;
  }

  /**
   * The tree in the official art, ported from GGG's own skill tree renderer (the saved copy under resources/atlas/evidence:
   * drawTile, drawGroupBackground, drawGroupNodePaths, drawGroupNodes). Every sprite is drawn
   * at its sheet size / sheet zoom in world units, from the sheet whose zoom fits the view. Paints the world box tl..br.
   */
  private paintArt(ctx: CanvasRenderingContext2D, sprite: SpriteSource, tl: Point, br: Point): void {
    const model = this.model, nodes = model.nodes, graph = model.graph, zoom = this.view.scale, z = zoom * this.dpr;
    const get = (family: string, name: string) => sprite(family, name, z);
    const put = (s: Sprite, x: number, y: number, w = s.w / s.zoom, h = s.h / s.zoom) => ctx.drawImage(s.image, s.x, s.y, s.w, s.h, x - w / 2, y - h / 2, w, h);
    // Box overlap with a margin for frame and line art (a gateway frame is 290 world units wide).
    const hits = (x0: number, y0: number, x1: number, y1: number, pad = 160) => x1 > tl.x - pad && x0 < br.x + pad && y1 > tl.y - pad && y0 < br.y + pad;
    const on = (id: string) => this.allocated.has(id);
    // Backdrop: the tiled background, then the atlas background art at 2.8173 x its sheet size (GGG's constant).
    const tile = get('background', 'Background2'), pattern = tile && this.pattern(tile);
    if (pattern) { ctx.fillStyle = pattern; ctx.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y); }
    const backdrop = get('atlasBackground', 'AtlasPassiveBackground');
    if (backdrop && model.backdrop) put(backdrop, model.backdrop.x, model.backdrop.y, 2.8173 * backdrop.w / backdrop.zoom, 2.8173 * backdrop.h / backdrop.zoom);
    // Section backgrounds (up to ~1,550 world units wide, so culled with a wide margin).
    for (const g of model.groups) {
      if (!hits(g.x, g.y, g.x, g.y, 900)) continue;
      const s = get('groupBackground', g.image); if (s) put(s, g.x + g.offsetX, g.y + g.offsetY);
    }
    // Connectors: the Normal art, with Intermediate (one end allocated) or Active (both) on top. GGG's PSLineDeco end caps
    // sit under the node frames, so they are not drawn.
    model.edges.forEach(([ai, bi], i) => {
      const a = nodes[ai]!, b = nodes[bi]!, pa = a.position, pb = b.position, arc = model.arcs[i];
      if (!pa || !pb || !(arc ? hits(arc.cx - arc.r, arc.cy - arc.r, arc.cx + arc.r, arc.cy + arc.r)
        : hits(Math.min(pa.x, pb.x), Math.min(pa.y, pb.y), Math.max(pa.x, pb.x), Math.max(pa.y, pb.y)))) return;
      const state = on(a.nodeId) && on(b.nodeId) ? 'Active' : on(a.nodeId) || on(b.nodeId) ? 'Intermediate' : 'Normal';
      for (const art of state === 'Normal' ? ['Normal'] : ['Normal', state]) {
        if (!arc) { const s = get('line', `LineConnector${art}`); if (s) this.lineArt(ctx, s, pa, pb); continue; }
        const s = get('line', `Orbit${arc.orbit}${art}`); if (!s) continue;
        const a0 = Math.atan2(pa.y - arc.cy, pa.x - arc.cx), a1 = Math.atan2(pb.y - arc.cy, pb.x - arc.cx);
        let d = a1 - a0; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
        this.arcArt(ctx, s, arc.cx, arc.cy, d >= 0 ? a0 : a1, Math.abs(d), art === 'Active', zoom);
      }
    });
    // The start (the root and the start node beside it share one spot): GGG's start art, no icon or frame.
    const start = new Set([graph.rootId, ...graph.adjacent.get(graph.rootId) ?? []]);
    const startAt = nodes[model.denseById.get(graph.rootId) ?? -1]?.position, startArt = get('startNode', 'AtlasPassiveSkillScreenStart');
    if (startAt && startArt && hits(startAt.x, startAt.y, startAt.x, startAt.y, 650)) put(startArt, startAt.x, startAt.y);
    // Nodes: icon from the active or disabled sheet, then the frame for its state. Icons and frames are square at sprite width.
    for (const n of nodes) {
      const p = n.position;
      if (!p || start.has(n.nodeId) || !hits(p.x, p.y, p.x, p.y)) continue;
      const active = on(n.nodeId), can = !active && this.reachable.has(n.nodeId), icon = this.iconOf(n, sprite, z);
      if (icon) put(icon, p.x, p.y, icon.w / icon.zoom, icon.w / icon.zoom);
      if (n.type === 'Mastery') continue;
      const framed = n.type === 'Notable' ? 'Notable' : n.type === 'Keystone' ? 'Keystone' : n.type === 'Wormhole' ? 'Wormhole' : null;
      const frame = framed ? get('frame', `${framed}Frame${active ? 'Allocated' : can ? 'CanAllocate' : 'Unallocated'}`)
        : get('frame', active ? 'PSSkillFrameActive' : can ? 'PSSkillFrameHighlighted' : 'PSSkillFrame');
      if (frame) put(frame, p.x, p.y, frame.w / frame.zoom, frame.w / frame.zoom);
    }
  }
  private pattern(s: Sprite): CanvasPattern | null {
    if (!this.patterns.has(s.image)) {
      const p = this.ctx.createPattern(s.image, 'repeat');
      p?.setTransform(new DOMMatrix().scale(1 / s.zoom));
      this.patterns.set(s.image, p);
    }
    return this.patterns.get(s.image)!;
  }
  /** GGG drawStraightPath: the connector sprite tiled along the link, the last piece cut to length. */
  private lineArt(ctx: CanvasRenderingContext2D, s: Sprite, a: Point, b: Point): void {
    const len = Math.hypot(b.x - a.x, b.y - a.y), seg = s.w / s.zoom, h = s.h / s.zoom;
    ctx.save(); ctx.translate(a.x, a.y); ctx.rotate(Math.atan2(b.y - a.y, b.x - a.x));
    for (let d = 0; d < len; d += seg) { const piece = Math.min(seg, len - d); ctx.drawImage(s.image, s.x, s.y, s.w * piece / seg, s.h, d, -h / 2, piece, h); }
    ctx.restore();
  }
  /** GGG drawArc: quarter-orbit sprites turned into place, clipped to the ring and, for a last partial quarter, to its wedge. */
  private arcArt(ctx: CanvasRenderingContext2D, s: Sprite, cx: number, cy: number, start: number, sweep: number, active: boolean, zoom: number): void {
    const w = s.w / s.zoom, h = s.h / s.zoom;
    const outer = (s.w + Math.round((active ? 0 : 16) * zoom)) / s.zoom, inner = Math.max(0, (s.w - Math.round((active ? 44 : 28) * zoom)) / s.zoom);
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(start - Math.PI);
    ctx.beginPath(); ctx.arc(0, 0, outer, 0, 2 * Math.PI, false); ctx.arc(0, 0, inner, 0, 2 * Math.PI, true); ctx.clip();
    for (let left = sweep, i = Math.ceil(sweep / (Math.PI / 2)); i > 0; i--) {
      if (left < Math.PI / 2) {
        ctx.save(); ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, outer, Math.PI, left + Math.PI, false); ctx.clip();
        ctx.drawImage(s.image, s.x, s.y, s.w, s.h, -w, -h, w, h); ctx.restore();
      } else { ctx.drawImage(s.image, s.x, s.y, s.w, s.h, -w, -h, w, h); ctx.rotate(Math.PI / 2); left -= Math.PI / 2; }
    }
    ctx.restore();
  }

  private paint(): void {
    if (this.disposed) return;
    const ctx = this.ctx, { scale } = this.view, dpr = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    // The canvas is always a dark night-sky stage (the game art is made for it), so it uses its own bright accent in both modes.
    const accent = this.css('--atlas-on-canvas', '110,180,255'), line = this.css('--atlas-canvas-line', '214,222,240');
    const add = this.css('--atlas-canvas-add', '#6fce5a'), remove = '#ff6a55', warn = '#f0b44b', search = '#ff8a2e', disc = '#12141b';
    const text = this.css('--atlas-canvas-text', '#ece6da'), labelBg = this.css('--atlas-canvas-label-bg', 'rgba(0,0,0,.55)');
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * (this.width / 2 - this.view.x * scale), dpr * (this.height / 2 - this.view.y * scale));
    const px = 1 / scale; // one CSS pixel in world units
    const pad = 80 * px + 150, tl = worldPoint({ x: 0, y: 0 }, this.view, this.width, this.height), br = worldPoint({ x: this.width, y: this.height }, this.view, this.width, this.height);
    const inView = (x: number, y: number) => x > tl.x - pad && x < br.x + pad && y > tl.y - pad && y < br.y + pad;
    const overlay = this.state.overlay, nodes = this.model.nodes;
    const status = (id: string) => overlay?.added.has(id) ? 'added' : overlay?.removed.has(id) ? 'removed' : this.allocated.has(id) ? 'on' : 'off';
    const hash = this.model.scope.datasetHash, sprite0 = this.art?.sprite, sprite: SpriteSource | undefined = sprite0 && ((f, n, z) => sprite0(f, n, z, hash)), artReady = !!sprite?.('frame', 'PSSkillFrame', scale * dpr);

    // Edges: neutral first, allocated on top, preview dashed.
    const edgePath = (want: (a: string, b: string) => boolean) => {
      ctx.beginPath();
      this.model.edges.forEach(([ai, bi], i) => {
        const a = nodes[ai]!, b = nodes[bi]!;
        if (!a.position || !b.position || !want(a.nodeId, b.nodeId)) return;
        if (!inView(a.position.x, a.position.y) && !inView(b.position.x, b.position.y) && !inView((a.position.x + b.position.x) / 2, (a.position.y + b.position.y) / 2)) return;
        const arc = this.model.arcs[i];
        if (arc) {
          const a0 = Math.atan2(a.position.y - arc.cy, a.position.x - arc.cx), a1 = Math.atan2(b.position.y - arc.cy, b.position.x - arc.cx);
          let d = a1 - a0; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
          ctx.moveTo(a.position.x, a.position.y); ctx.arc(arc.cx, arc.cy, arc.r, a0, a0 + d, d < 0);
        } else { ctx.moveTo(a.position.x, a.position.y); ctx.lineTo(b.position.x, b.position.y); }
      });
    };
    ctx.lineCap = 'round';
    // With the official sheets loaded the tree is GGG's art (paintArt); until then, plain discs and strokes.
    const drawnIcons = artReady ? this.paintTiles(sprite!) : 0;
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * (this.width / 2 - this.view.x * scale), dpr * (this.height / 2 - this.view.y * scale));
    if (!artReady) {
      edgePath((a, b) => !(this.allocated.has(a) && this.allocated.has(b)));
      ctx.strokeStyle = `rgba(${line},.22)`; ctx.lineWidth = Math.max(1.4 * px, 6); ctx.stroke();
      edgePath((a, b) => this.allocated.has(a) && this.allocated.has(b) && !overlay?.removed.has(a) && !overlay?.removed.has(b));
      ctx.strokeStyle = `rgba(${accent},.95)`; ctx.lineWidth = Math.max(2.6 * px, 11); ctx.stroke();
    }
    if (overlay) {
      ctx.setLineDash([10 * px, 7 * px]);
      const reach = (id: string) => this.allocated.has(id) || overlay.added.has(id);
      edgePath((a, b) => (overlay.added.has(a) || overlay.added.has(b)) && reach(a) && reach(b)); ctx.strokeStyle = add; ctx.lineWidth = Math.max(2.4 * px, 10); ctx.stroke();
      edgePath((a, b) => (overlay.removed.has(a) || overlay.removed.has(b))); ctx.strokeStyle = remove; ctx.stroke();
      ctx.setLineDash([]);
    }

    // Nodes.
    const showIcons = scale * 42 >= 6;
    for (const n of nodes) {
      if (!n.position || !inView(n.position.x, n.position.y)) continue;
      const { x, y } = n.position, s = status(n.nodeId), on = s === 'on' || s === 'added';
      const r = Math.max(nodeRadius(n), 2.5 * px);
      // With art, the sprites carry the allocation state: only previews and hover get a ring on top.
      if (!artReady) {
        if (on && s === 'on') { ctx.beginPath(); ctx.arc(x, y, r + Math.max(10, 5 * px), 0, Math.PI * 2); ctx.fillStyle = `rgba(${accent},.18)`; ctx.fill(); }
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = n.isRoot ? `rgba(${accent},.9)` : disc; ctx.fill();
        const art = showIcons && !n.isRoot && n.asset ? this.art?.(n.asset, n.nodeId, this.model.scope.datasetHash) : null, icon = art ? this.icon(art) : null;
        if (icon) {
          ctx.globalAlpha = on ? 1 : n.nodeId === this.hovered ? 0.85 : 0.5;
          const ir = r * 0.86; ctx.drawImage(icon, x - ir, y - ir, ir * 2, ir * 2); ctx.globalAlpha = 1;
        } else if (!n.isRoot) { ctx.beginPath(); ctx.arc(x, y, r * 0.45, 0, Math.PI * 2); ctx.fillStyle = on ? `rgba(${accent},.9)` : `rgba(${line},.28)`; ctx.fill(); }
      }
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      if (s === 'added') { ctx.setLineDash([8 * px, 5 * px]); ctx.strokeStyle = add; ctx.lineWidth = Math.max(2.5 * px, 8); ctx.stroke(); ctx.setLineDash([]); }
      else if (s === 'removed') { ctx.strokeStyle = remove; ctx.lineWidth = Math.max(2.5 * px, 8); ctx.stroke(); }
      else if (artReady) { if (n.nodeId === this.hovered) { ctx.strokeStyle = `rgba(${line},.85)`; ctx.lineWidth = Math.max(1.5 * px, 6); ctx.stroke(); } }
      else if (on) { ctx.strokeStyle = `rgb(${accent})`; ctx.lineWidth = Math.max(2.2 * px, n.type === 'Keystone' ? 12 : 9); ctx.stroke(); }
      else { ctx.strokeStyle = n.nodeId === this.hovered ? `rgba(${line},.85)` : `rgba(${line},.4)`; ctx.lineWidth = Math.max(1.1 * px, n.type === 'Keystone' || n.type === 'Notable' ? 6 : 4); ctx.stroke(); }
      const mark = this.state.marks?.get(n.nodeId);
      const ring = mark ? (mark === 'want' ? add : remove) : this.state.repair.has(n.nodeId) ? warn : this.state.matches.has(n.nodeId) ? search : this.state.focused === n.nodeId ? text : null;
      if (ring) { ctx.beginPath(); ctx.arc(x, y, r + Math.max(8, 4 * px), 0, Math.PI * 2); ctx.strokeStyle = ring; ctx.lineWidth = Math.max(2 * px, 6); ctx.stroke(); }
    }

    // Test hooks: icons drawn and the painted zoom, so Fit and zoom are measurable.
    this.canvas.dataset.icons = String(artReady ? drawnIcons : [...this.icons.values()].filter(Boolean).length);
    this.canvas.dataset.scale = this.view.scale.toFixed(4);
    // Labels (screen space): Start always; keystone and notable names once zoomed in enough to read them.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = text; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.font = '600 12px Geist, sans-serif';
    for (const n of nodes) {
      if (!n.position || !inView(n.position.x, n.position.y)) continue;
      const big = n.type === 'Keystone' || n.type === 'Notable';
      if (!n.isRoot && !(big && scale >= 0.42) && !(n.type === 'Keystone' && scale >= 0.2)) continue;
      const p = screenPoint(n.position, this.view, this.width, this.height), r = Math.max(3, nodeRadius(n) * scale);
      ctx.fillStyle = labelBg; const label = n.isRoot ? tr('atlas_canvas_AtlasCanvas.start') : n.name, w = ctx.measureText(label).width;
      ctx.fillRect(p.x - w / 2 - 4, p.y + r + 3, w + 8, 16); ctx.fillStyle = text; ctx.fillText(label, p.x, p.y + r + 5);
    }
  }
  // Kept for API compatibility with callers of the old WebGL renderer.
  contextLost(): void { /* 2D canvas: nothing to restore */ }
  contextRestored(): void { this.schedule(); }
  destroy(): void {
    this.disposed = true; if (this.frame) cancelAnimationFrame(this.frame);
    this.observer.disconnect(); for (const cleanup of this.cleanups) cleanup();
    this.icons.clear(); this.tiles.clear(); this.stale = null; this.spare = [];
  }
}
