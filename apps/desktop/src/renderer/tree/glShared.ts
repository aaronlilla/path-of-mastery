// One WebGL2 context for every passive tree in the window. Creating a context costs about 165 ms the first time and
// 30 ms after that, on every build open; this one is made once and kept. It draws into a canvas that is never in the
// page: each tree copies the finished frame into its own display canvases (see PassiveTree.present).
// Kept here: the programs, the shared quad buffers and the ring texture (none depends on the build), and the sheet
// textures by URL (they depend on the tree version only). Each tree frees its own batches when it is destroyed.

import { BG_FS, BG_VS, QUAD_VS, SPRITE_VS, TEX_FS, compile } from './glBatch.js';

export interface TreeGL {
  gl: WebGL2RenderingContext;
  /** The off-page canvas the trees draw into; grows to the largest tree and never shrinks. */
  surface: HTMLCanvasElement;
  spriteProg: WebGLProgram;
  quadProg: WebGLProgram;
  bgProg: WebGLProgram;
  cornerBuf: WebGLBuffer;
  indexBuf: WebGLBuffer;
  bgVao: WebGLVertexArrayObject;
  /** The soft ring for the search, hover and radius rings (left half thin, right half heavy). */
  ring: WebGLTexture;
}

/** A tree using the shared context: told when the context is lost and when it is back. */
export interface TreeGLUser {
  contextLost(): void;
  contextRestored(): void;
}

let cur: TreeGL | null = null;
let surface: HTMLCanvasElement | null = null;
let lost = false;
const users = new Set<TreeGLUser>();

interface Sheet {
  tex: Promise<WebGLTexture | null>;
  /** Set once the upload finished. */
  done: WebGLTexture | null;
  refs: number;
  group: string;
}
const sheets = new Map<string, Sheet>();
let ringTextures = 0;

/** GPU textures the trees hold right now (sheets cached by URL plus the ring). */
export function liveTreeTextures(): number {
  let n = ringTextures;
  for (const s of sheets.values()) if (s.done) n++;
  return n;
}

function setup(gl: WebGL2RenderingContext, canvas: HTMLCanvasElement): TreeGL {
  const cornerBuf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  const indexBuf = gl.createBuffer()!;
  const idx = new Uint32Array(6 * 8192);
  for (let q = 0; q < 8192; q++) idx.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3], q * 6);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuf);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  return {
    gl,
    surface: canvas,
    spriteProg: compile(gl, SPRITE_VS, TEX_FS),
    quadProg: compile(gl, QUAD_VS, TEX_FS),
    bgProg: compile(gl, BG_VS, BG_FS),
    cornerBuf,
    indexBuf,
    bgVao: gl.createVertexArray()!,
    ring: makeRing(gl),
  };
}

function makeRing(gl: WebGL2RenderingContext): WebGLTexture {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = S * 2;
  c.height = S;
  const g = c.getContext('2d')!;
  g.strokeStyle = '#fff';
  // Left: a thin ring for the jewel radii (they are huge, so a thin line stays readable). Right: a heavier ring for
  // the search and compare markers, which are small on screen.
  for (const [x, w, halo] of [[0, 5, 12], [S, 14, 26]] as const) {
    g.globalAlpha = 1;
    g.lineWidth = w;
    g.beginPath();
    g.arc(x + S / 2, S / 2, S / 2 - 12, 0, Math.PI * 2);
    g.stroke();
    g.globalAlpha = 0.25;
    g.lineWidth = halo;
    g.stroke();
  }
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, c);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  ringTextures = 1;
  return tex;
}

/** The shared context, made on first use. Null while the context is lost (a tree then waits for contextRestored). */
export function treeGL(): TreeGL | null {
  if (lost) return null;
  if (cur) return cur;
  surface = document.createElement('canvas');
  surface.width = 16;
  surface.height = 16;
  const gl = surface.getContext('webgl2', { alpha: false, antialias: false, powerPreference: 'high-performance', depth: false, stencil: false });
  if (!gl) throw new Error('WebGL2 is not available');
  surface.addEventListener('webglcontextlost', (e) => {
    // Without preventDefault the browser never gives the context back.
    e.preventDefault();
    lost = true;
    cur = null;
    sheets.clear();
    ringTextures = 0;
    for (const u of users) u.contextLost();
  });
  surface.addEventListener('webglcontextrestored', () => {
    lost = false;
    cur = setup(gl, surface!);
    for (const u of users) u.contextRestored();
  });
  cur = setup(gl, surface);
  return cur;
}

export function addTreeGLUser(u: TreeGLUser): void {
  users.add(u);
}

export function removeTreeGLUser(u: TreeGLUser): void {
  users.delete(u);
}

/** Makes the surface at least w by h pixels. Growing it clears it; every paint draws the whole frame anyway. */
export function fitSurface(t: TreeGL, w: number, h: number): void {
  const s = t.surface;
  if (s.width < w || s.height < h) {
    s.width = Math.max(s.width, w);
    s.height = Math.max(s.height, h);
  }
}

/**
 * A sheet texture by key (its URL), shared by every tree that shows the same tree version. `group` is the tree
 * version's base path: textures nobody uses any more stay for the last version asked for (the next build most likely
 * uses the same one) and are deleted when another version is asked for.
 */
export function acquireSheet(key: string, group: string, make: (gl: WebGL2RenderingContext) => Promise<WebGLTexture | null>): { tex: Promise<WebGLTexture | null>; release: () => void } {
  const t = treeGL();
  if (!t) return { tex: Promise.resolve(null), release: () => undefined };
  for (const [k, s] of sheets) {
    if (s.refs > 0 || s.group === group) continue;
    if (s.done) t.gl.deleteTexture(s.done);
    else void s.tex.then((x) => x && cur?.gl.deleteTexture(x));
    sheets.delete(k);
  }
  let s = sheets.get(key);
  if (!s) {
    const entry: Sheet = { tex: Promise.resolve(null), done: null, refs: 0, group };
    entry.tex = make(t.gl).then(
      (tex) => {
        // Lost (or evicted) while loading: the texture belongs to nothing.
        if (sheets.get(key) !== entry) {
          if (tex && cur?.gl === t.gl) t.gl.deleteTexture(tex);
          return null;
        }
        // A sheet that failed to load is asked for again by the next tree.
        if (!tex) sheets.delete(key);
        entry.done = tex;
        return tex;
      },
      () => {
        if (sheets.get(key) === entry) sheets.delete(key);
        return null;
      },
    );
    sheets.set(key, (s = entry));
  }
  s.refs++;
  const held = s;
  let done = false;
  return {
    tex: s.tex,
    // Releases this hold only: an entry dropped meanwhile (failed load, lost context) and replaced is not touched.
    release: () => {
      if (done) return;
      done = true;
      if (sheets.get(key) === held && held.refs > 0) held.refs--;
    },
  };
}
