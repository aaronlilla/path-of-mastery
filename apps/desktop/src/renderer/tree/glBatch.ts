// Small WebGL2 helpers for the tree: instanced sprite batches and a quad (connector) batch. One draw call per batch.

export function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const mk = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  for (const s of gl.getAttachedShaders(p) ?? []) gl.deleteShader(s);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('program: ' + gl.getProgramInfoLog(p));
  return p;
}

/** Floats per sprite instance: centre (2), half size (2), uv rect (4), rotation (1), colour as 4 bytes (1). */
export const INSTANCE_FLOATS = 10;

export function packColor(r: number, g: number, b: number, a: number): number {
  const q = (v: number) => (v <= 0 ? 0 : v >= 1 ? 255 : (v * 255) | 0);
  return (q(r) | (q(g) << 8) | (q(b) << 16) | (q(a) << 24)) >>> 0;
}

/** A growing list of sprite instances drawn from one texture. */
export class SpriteBatch {
  n = 0;
  f32: Float32Array;
  u32: Uint32Array;
  buf: WebGLBuffer;
  vao: WebGLVertexArrayObject;
  uploaded = -1;
  /** Multiplier on half sizes (the search rings shrink with zoom). */
  scaleKind: 'fixed' | 'ring' = 'fixed';

  constructor(
    gl: WebGL2RenderingContext,
    readonly sheet: number,
    cornerBuf: WebGLBuffer,
    cap = 256,
  ) {
    const ab = new ArrayBuffer(cap * INSTANCE_FLOATS * 4);
    this.f32 = new Float32Array(ab);
    this.u32 = new Uint32Array(ab);
    this.buf = gl.createBuffer()!;
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    const stride = INSTANCE_FLOATS * 4;
    const attr = (loc: number, size: number, type: number, norm: boolean, off: number) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, type, norm, stride, off);
      gl.vertexAttribDivisor(loc, 1);
    };
    attr(1, 2, gl.FLOAT, false, 0);
    attr(2, 2, gl.FLOAT, false, 8);
    attr(3, 4, gl.FLOAT, false, 16);
    attr(4, 1, gl.FLOAT, false, 32);
    attr(5, 4, gl.UNSIGNED_BYTE, true, 36);
    gl.bindVertexArray(null);
  }

  clear(): void {
    this.n = 0;
  }

  /** Deletes the GPU buffer and vertex array (the tree's context outlives the tree). */
  free(gl: WebGL2RenderingContext): void {
    gl.deleteBuffer(this.buf);
    gl.deleteVertexArray(this.vao);
    this.n = 0;
  }

  push(cx: number, cy: number, hw: number, hh: number, u0: number, v0: number, u1: number, v1: number, rot: number, color: number): void {
    if ((this.n + 1) * INSTANCE_FLOATS > this.f32.length) {
      const ab = new ArrayBuffer(this.f32.byteLength * 2);
      const f = new Float32Array(ab);
      f.set(this.f32);
      this.f32 = f;
      this.u32 = new Uint32Array(ab);
    }
    const f = this.f32;
    const o = this.n * INSTANCE_FLOATS;
    f[o] = cx;
    f[o + 1] = cy;
    f[o + 2] = hw;
    f[o + 3] = hh;
    f[o + 4] = u0;
    f[o + 5] = v0;
    f[o + 6] = u1;
    f[o + 7] = v1;
    f[o + 8] = rot;
    this.u32[o + 9] = color;
    this.n++;
  }

  upload(gl: WebGL2RenderingContext, version: number): void {
    if (this.uploaded === version) return;
    this.uploaded = version;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, this.f32.subarray(0, this.n * INSTANCE_FLOATS), gl.DYNAMIC_DRAW);
  }
}

/** Floats per connector vertex: position (2), local uv (2), atlas rect (4), colour (1). */
export const QUAD_FLOATS = 9;

/** Textured quads with arbitrary corners (connectors), drawn with one indexed call. */
export class QuadBatch {
  n = 0;
  f32 = new Float32Array(4 * QUAD_FLOATS * 512);
  u32 = new Uint32Array(this.f32.buffer);
  buf: WebGLBuffer;
  vao: WebGLVertexArrayObject;
  uploaded = -1;

  constructor(gl: WebGL2RenderingContext, readonly sheet: number, indexBuf: WebGLBuffer) {
    this.buf = gl.createBuffer()!;
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    const stride = QUAD_FLOATS * 4;
    const attr = (loc: number, size: number, type: number, norm: boolean, off: number) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, type, norm, stride, off);
    };
    attr(0, 2, gl.FLOAT, false, 0);
    attr(1, 2, gl.FLOAT, false, 8);
    attr(2, 4, gl.FLOAT, false, 16);
    attr(3, 4, gl.UNSIGNED_BYTE, true, 32);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuf);
    gl.bindVertexArray(null);
  }

  clear(): void {
    this.n = 0;
  }

  /** Deletes the GPU buffer and vertex array (the tree's context outlives the tree). */
  free(gl: WebGL2RenderingContext): void {
    gl.deleteBuffer(this.buf);
    gl.deleteVertexArray(this.vao);
    this.n = 0;
  }

  private grow(): void {
    if ((this.n + 1) * 4 * QUAD_FLOATS > this.f32.length) {
      const f = new Float32Array(this.f32.length * 2);
      f.set(this.f32);
      this.f32 = f;
      this.u32 = new Uint32Array(f.buffer);
    }
  }

  /** corners: x1,y1 .. x4,y4; local: u1,v1 .. u4,v4 within the sprite; the sprite's uv rect is u[uo..uo+3]. */
  push(c: ArrayLike<number>, local: ArrayLike<number>, u: Float32Array, uo: number, color: number): void {
    this.grow();
    const f = this.f32;
    const r0 = u[uo]!;
    const r1 = u[uo + 1]!;
    const r2 = u[uo + 2]!;
    const r3 = u[uo + 3]!;
    let o = this.n * 4 * QUAD_FLOATS;
    for (let k = 0; k < 4; k++) {
      f[o] = c[k * 2]!;
      f[o + 1] = c[k * 2 + 1]!;
      f[o + 2] = local[k * 2]!;
      f[o + 3] = local[k * 2 + 1]!;
      f[o + 4] = r0;
      f[o + 5] = r1;
      f[o + 6] = r2;
      f[o + 7] = r3;
      this.u32[o + 8] = color;
      o += QUAD_FLOATS;
    }
    this.n++;
  }

  /** One tile of a long line: corners tile[o..o+7], tile length ul in sprite widths. */
  pushTile(tile: ArrayLike<number>, to: number, ul: number, u: Float32Array, uo: number, color: number): void {
    this.grow();
    const f = this.f32;
    const r0 = u[uo]!;
    const r1 = u[uo + 1]!;
    const r2 = u[uo + 2]!;
    const r3 = u[uo + 3]!;
    let o = this.n * 4 * QUAD_FLOATS;
    for (let k = 0; k < 4; k++) {
      f[o] = tile[to + k * 2]!;
      f[o + 1] = tile[to + k * 2 + 1]!;
      f[o + 2] = k < 2 ? 0 : ul;
      f[o + 3] = k === 0 || k === 3 ? 1 : 0;
      f[o + 4] = r0;
      f[o + 5] = r1;
      f[o + 6] = r2;
      f[o + 7] = r3;
      this.u32[o + 8] = color;
      o += QUAD_FLOATS;
    }
    this.n++;
  }

  upload(gl: WebGL2RenderingContext, version: number): void {
    if (this.uploaded === version) return;
    this.uploaded = version;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, this.f32.subarray(0, this.n * 4 * QUAD_FLOATS), gl.DYNAMIC_DRAW);
  }
}

export const SPRITE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_corner;
layout(location=1) in vec2 a_center;
layout(location=2) in vec2 a_half;
layout(location=3) in vec4 a_uv;
layout(location=4) in float a_rot;
layout(location=5) in vec4 a_col;
uniform vec4 u_view;
uniform vec2 u_res;
uniform float u_hs;
out vec2 v_uv;
out vec4 v_col;
void main() {
  vec2 l = (a_corner * 2.0 - 1.0) * a_half * u_hs;
  float c = cos(a_rot), s = sin(a_rot);
  vec2 w = a_center + vec2(c * l.x - s * l.y, s * l.x + c * l.y);
  vec2 px = (w - u_view.xy) * u_view.z + u_res * 0.5;
  gl_Position = vec4(px.x / u_res.x * 2.0 - 1.0, 1.0 - px.y / u_res.y * 2.0, 0.0, 1.0);
  v_uv = mix(a_uv.xy, a_uv.zw, a_corner);
  v_col = a_col;
}`;

export const QUAD_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_pos;
layout(location=1) in vec2 a_loc;
layout(location=2) in vec4 a_rect;
layout(location=3) in vec4 a_col;
uniform vec4 u_view;
uniform vec2 u_res;
out vec2 v_uv;
out vec4 v_col;
void main() {
  vec2 px = (a_pos - u_view.xy) * u_view.z + u_res * 0.5;
  gl_Position = vec4(px.x / u_res.x * 2.0 - 1.0, 1.0 - px.y / u_res.y * 2.0, 0.0, 1.0);
  v_uv = mix(a_rect.xy, a_rect.zw, a_loc);
  v_col = a_col;
}`;

export const TEX_FS = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
in vec2 v_uv;
in vec4 v_col;
out vec4 o;
void main() {
  vec4 t = texture(u_tex, v_uv);
  o = vec4(t.rgb * v_col.rgb, t.a) * v_col.a;
}`;

export const BG_VS = `#version 300 es
precision highp float;
uniform vec4 u_view;
uniform vec2 u_res;
uniform float u_tile;
out vec2 v_uv;
void main() {
  vec2 c = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(c * 2.0 - 1.0, 0.0, 1.0);
  vec2 px = vec2(c.x, 1.0 - c.y) * u_res;
  vec2 w = (px - u_res * 0.5) / u_view.z + u_view.xy;
  v_uv = w / u_tile;
}`;

export const BG_FS = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
in vec2 v_uv;
out vec4 o;
void main() {
  vec4 t = texture(u_tex, v_uv);
  o = vec4(t.rgb, 1.0);
}`;
