/* Path of Mastery: liquid glass surfaces.
   Any element with data-lg="panel|pop|control" gets a per-size SVG refraction filter
   (edge bending + frost), technique after rdev/liquid-glass-react (MIT).
   Layers per Apple's recipe: diffusion (blur+saturate) → edge refraction → pointer-lit specular rim
   (::before ring) → faint dark outer edge + inner sheen (::after) → press glow/gel squish (controls) → grow-in (popovers).
   Modes: liquid (regular, more diffusion, iOS 27 default), clear (low diffusion, for busy backdrops behind a dim layer), frosted.
   Chromium only for displacement; other engines fall back to frosted blur.
   window.pomGlass.set('liquid'|'clear'|'frosted') switches globally (persisted).
   Interior pointer light is damped (--lg-in, --ilx/--ily); the ::before edge rim keeps full pointer tracking. */
(function () {
  if (window.pomGlass) return;
  var NS = 'http://www.w3.org/2000/svg';
  var ua = navigator.userAgent;
  var canLiquid = /Chrome|Chromium|Edg\//.test(ua) && !/Firefox|FxiOS/.test(ua);
  var mode = 'liquid';
  try { mode = localStorage.getItem('pom-glass') || 'liquid'; } catch (e) {}
  var K = {
    tile:    { blur: 0, sat: 1, fb: 0, bez: 1, s: 0, ab: 0 },
    panel:   { blur: 9,  sat: 1.55, fb: 20, bez: 30, s: 1.7, ab: 0.05 },
    pop:     { blur: 12, sat: 1.5,  fb: 22, bez: 24, s: 1.6, ab: 0.05 },
    control: { blur: 1.2, sat: 1.4, fb: 8,  bez: 12, s: 2.0, ab: 0.08 }
  };
  var CLEAR = { blur: 0.35, sat: 1.15, fb: 0.4 };
  var RIM = 'radial-gradient(140% 140% at var(--lx,30%) var(--ly,-10%),rgba(var(--rim),var(--r1)),rgba(var(--rim),calc(var(--r1)*.27)) 30%,rgba(var(--rim),calc(var(--r1)*.06)) 60%,rgba(var(--rim),calc(var(--r1)*.18)) 100%)';
  /* :where() keeps this default at zero specificity, so a stylesheet that positions a glass element (a dialog, a popover) wins. Before, it forced position:relative over .w-dialog{position:fixed} and the Sell dialog rendered cut off at the bottom-left. */
  var CSS = ':where([data-lg]:not([style*="position: absolute"]):not([style*="position: fixed"])){position:relative}' +
    '[data-lg]{isolation:isolate;--rim:var(--rim-rgb,255,248,232);--r1:.34;--lg-in:.15}' +
    '[data-lg]::before{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;z-index:2;padding:1px;background:' + RIM + ';' +
      '-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask:linear-gradient(#000 0 0) content-box exclude,linear-gradient(#000 0 0)}' +
    '[data-lg]::after{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;z-index:-1;' +
      'box-shadow:inset 0 0 0 1px rgba(var(--shadow-rgb,0,0,0),calc(.42*var(--shadow-k,1))),inset 0 1.5px 1px -1px rgba(255,255,255,.12),inset 0 -14px 24px -18px rgba(var(--line-rgb),.05);' +
      'background:radial-gradient(circle at var(--px,50%) var(--py,50%),rgba(var(--rim),calc(var(--glow,0)*var(--lg-in,.15))),transparent 60%);transition:--glow .25s}' +
    /* light-shaped tint instead of a flat top-to-bottom gradient */
    '[data-lg="panel"]{background:radial-gradient(120% 95% at var(--ilx,30%) var(--ily,0%),rgba(var(--glass-hi-rgb),.56),rgba(var(--glass-rgb),.7) 58%,rgba(var(--void-rgb),.76)) !important;border-color:transparent !important}' +
    '[data-lg="pop"]{background:radial-gradient(120% 95% at var(--ilx,30%) var(--ily,0%),rgba(var(--glass-hi-rgb),.72),rgba(var(--glass-rgb),.84) 60%,rgba(var(--void-rgb),.88)) !important;border-color:transparent !important;animation:pom-lg-in .34s cubic-bezier(.25,1.35,.4,1) both;transform-origin:top center}' +
    '[data-lg="pop"][data-solid]{background:radial-gradient(120% 95% at var(--ilx,30%) var(--ily,0%),rgb(var(--glass-hi-rgb)),rgb(var(--glass-rgb)) 60%,rgb(var(--void-rgb))) !important}' +
    /* tiles: nested surfaces. No refraction (glass never on glass), same lit rim, pointer glow and depth */
    '[data-lg="tile"]{--r1:.2;background:radial-gradient(130% 110% at var(--ilx,30%) var(--ily,0%),rgba(var(--line-rgb),.035),rgba(var(--line-rgb),.012) 55%,transparent 85%),rgba(var(--void-rgb),.34) !important;border-color:transparent !important;' +
      'box-shadow:inset 0 1px 2px rgba(var(--shadow-rgb,0,0,0),calc(.35*var(--shadow-k,1))),0 1px 0 rgba(255,255,255,.025) !important;transition:scale .35s cubic-bezier(.3,1.7,.45,1)}' +
    '[data-lg="tile"]:hover{--glow:.045}' +
    '[data-lg="tile"][data-sel]{--rim:var(--accent-rgb,240,196,112);--r1:.6;--glow:.08;background:radial-gradient(120% 120% at var(--ilx,30%) var(--ily,0%),rgba(var(--accent-rgb),.2),rgba(var(--accent-rgb),.05) 55%,rgba(var(--accent-rgb),.015)),rgba(var(--void-rgb),.5) !important;' +
      'box-shadow:0 0 0 1px rgba(var(--accent-rgb),.22),0 0 26px -6px rgba(var(--accent-rgb),.32),inset 0 0 22px -8px rgba(var(--accent-rgb),.28) !important}' +
    '[data-lg="control"]{transition:scale .35s cubic-bezier(.3,1.7,.45,1)}' +
    '[data-lg="control"]:hover{--glow:.05}[data-lg="control"]:active{--glow:.11;scale:.96}' +
    '@keyframes pom-lg-in{from{opacity:0;scale:.9}60%{opacity:1}}' +
    '@property --glow{syntax:"<number>";inherits:false;initial-value:0}' +
    /* The pointer-light variables are written on every mouse move. Left inheritable, each write made the browser restyle every
       element inside the panel (the whole stat sidebar, the whole header) on every frame. They are only read by the glass element
       and its own two pseudo-elements, so they stay on it; the universal syntax keeps the var() fallbacks working when unset. */
    ['--lx', '--ly', '--ilx', '--ily', '--px', '--py'].map(function (v) { return '@property ' + v + '{syntax:"*";inherits:false}'; }).join('') +
    '[data-lg]::before,[data-lg]::after{--lx:inherit;--ly:inherit;--ilx:inherit;--ily:inherit;--px:inherit;--py:inherit}';
  var defs = null, cache = {}, seen = new WeakSet(), els = new Set(), n = 0;
  function root() {
    if (defs && defs.isConnected) return defs;
    var s = document.createElementNS(NS, 'svg');
    s.setAttribute('aria-hidden', 'true');
    s.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
    defs = document.createElementNS(NS, 'defs'); s.appendChild(defs); document.body.appendChild(s);
    return defs;
  }
  function sdf(px, py, bx, by, r) {
    var qx = Math.abs(px) - bx + r, qy = Math.abs(py) - by + r;
    var ox = Math.max(qx, 0), oy = Math.max(qy, 0);
    return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - r;
  }
  /* The map is written straight out as an uncompressed bitmap (BMP) data URL. It used to go through a canvas and a PNG encode,
     which cost 5 to 10 ms per panel size (240 ms when a build opens, 320 ms on Loot Filter's Full view). The pixels are the same:
     the same values, rounded the way canvas pixel data rounds them. */
  function makeMap(w, h, r, bez) {
    var k = Math.min(1, 220 / Math.max(w, h)), cw = Math.max(8, Math.ceil(w * k)), ch = Math.max(8, Math.ceil(h * k));
    var px8 = new Uint8ClampedArray(2);
    var row = (cw * 3 + 3) & ~3, size = 54 + row * ch, buf = new Uint8Array(size), dv = new DataView(buf.buffer);
    buf[0] = 66; buf[1] = 77; dv.setUint32(2, size, true); dv.setUint32(10, 54, true);
    dv.setUint32(14, 40, true); dv.setInt32(18, cw, true); dv.setInt32(22, ch, true); dv.setUint16(26, 1, true); dv.setUint16(28, 24, true);
    dv.setUint32(34, row * ch, true); dv.setInt32(38, 2835, true); dv.setInt32(42, 2835, true);
    var bx = w / 2, by = h / 2, rr = Math.min(r, bx, by), e = 1;
    for (var y = 0; y < ch; y++) {
      var o = 54 + (ch - 1 - y) * row; /* BMP rows run bottom to top */
      for (var x = 0; x < cw; x++, o += 3) {
        var px = (x + 0.5) / k - bx, py = (y + 0.5) / k - by;
        var dist = -sdf(px, py, bx, by, rr), m = dist < bez ? Math.pow(1 - Math.max(dist, 0) / bez, 2) : 0;
        if (m === 0) { buf[o] = 128; buf[o + 1] = 128; buf[o + 2] = 128; continue; } /* inside the bezel: no bend */
        var gx = sdf(px + e, py, bx, by, rr) - sdf(px - e, py, bx, by, rr);
        var gy = sdf(px, py + e, bx, by, rr) - sdf(px, py - e, bx, by, rr);
        var gl = Math.sqrt(gx * gx + gy * gy) || 1; gx /= gl; gy /= gl;
        px8[0] = 128 - gx * m * 127; px8[1] = 128 - gy * m * 127;
        buf[o] = 128; buf[o + 1] = px8[1]; buf[o + 2] = px8[0]; /* blue, green, red */
      }
    }
    var bin = '';
    for (var i = 0; i < size; i += 8192) bin += String.fromCharCode.apply(null, buf.subarray(i, Math.min(size, i + 8192)));
    return 'data:image/bmp;base64,' + btoa(bin);
  }
  function prim(tag, a) { var el = document.createElementNS(NS, tag); for (var k in a) el.setAttribute(k, a[k]); return el; }
  function filterFor(w, h, r, kind) {
    var key = mode + ':' + kind + ':' + w + 'x' + h + ':' + r;
    if (cache[key] && cache[key].isConnected) return cache[key].id;
    var P = params(kind), bez = Math.max(8, Math.min(P.bez, Math.min(w, h) * 0.3)), S = bez * P.s, ab = S * P.ab;
    var f = prim('filter', { id: 'pom-lg-' + (++n), x: 0, y: 0, width: w, height: h, filterUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB' });
    f.appendChild(prim('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: P.blur, result: 'b' }));
    f.appendChild(prim('feImage', { href: makeMap(w, h, r, bez), x: 0, y: 0, width: w, height: h, preserveAspectRatio: 'none', result: 'm' }));
    /* One bend for all three colours, at the green channel's strength. The red/green/blue split (three displacements,
       three channel picks, two blends) doubled what every glass surface cost the compositor on each frame under it, and
       its fringe never showed: against the split version no pixel moves more than 9 of 255, and 99% not at all. */
    f.appendChild(prim('feDisplacementMap', { in: 'b', in2: 'm', scale: S - ab, xChannelSelector: 'R', yChannelSelector: 'G', result: 'd' }));
    f.appendChild(prim('feColorMatrix', { in: 'd', type: 'saturate', values: P.sat }));
    root().appendChild(f); cache[key] = f;
    return f.id;
  }
  function params(kind) {
    var P = K[kind] || K.panel; if (mode !== 'clear') return P;
    var o = {}; for (var k in P) o[k] = P[k]; o.blur = P.blur * CLEAR.blur; o.sat = CLEAR.sat + (P.sat - 1) * 0.5; o.fb = P.fb * CLEAR.fb; o.s = P.s * 1.25; return o;
  }
  function pageFrosted() { var m = document.querySelector('meta[name="pom-glass"]'); return !!(m && m.getAttribute('content') === 'frosted'); }
  /* Sizes are read for every element first and written afterwards. Reading one element's size right after writing
     another's style makes the browser lay the whole page out again each time: on the Config tab that was half a second per open. */
  function measure(el) {
    var kind = el.getAttribute('data-lg') || 'panel'; if (kind === 'tile') return null;
    /* A solid pop (data-solid) paints an opaque background over its whole box, so a refraction filter under it never shows.
       It used to build a new refraction map and SVG filter for every size the box took (each node tooltip on the tree). */
    if (el.hasAttribute('data-solid')) return { el: el, solid: true };
    if (mode === 'frosted' || !canLiquid || pageFrosted()) return { el: el, kind: kind, frosted: true };
    var w = Math.round(el.offsetWidth / 4) * 4, h = Math.round(el.offsetHeight / 4) * 4;
    if (!w || !h) return null;
    return { el: el, kind: kind, w: w, h: h, r: Math.round(parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0) };
  }
  function commit(m) {
    var el = m.el, v;
    /* saturate(1) shows nothing, but like any backdrop filter it keeps the pop on its own compositing surface, so its text
       lands on the same pixels as before (with none, text in a pop at a fractional position moved by a fraction of a pixel). */
    if (m.solid) v = 'saturate(1)';
    else if (m.frosted) { var P = params(m.kind); v = 'blur(' + P.fb + 'px) saturate(' + P.sat + ')'; }
    else v = 'url(#' + filterFor(m.w, m.h, m.r, m.kind) + ')';
    if (el.__lgf === v) return; el.__lgf = v;
    el.style.backdropFilter = el.style.webkitBackdropFilter = v;
  }
  function applyAll(list) {
    var ms = [], i;
    for (i = 0; i < list.length; i++) { var m = measure(list[i]); if (m) ms.push(m); }
    for (i = 0; i < ms.length; i++) commit(ms[i]);
  }
  var ro = new ResizeObserver(function (list) { applyAll(list.map(function (e) { return e.target; })); });
  function scan() {
    var fresh = [];
    document.querySelectorAll('[data-lg]').forEach(function (el) { if (seen.has(el)) return; seen.add(el); els.add(el); fresh.push(el); });
    if (!fresh.length) return;
    applyAll(fresh);
    fresh.forEach(function (el) { if (el.getAttribute('data-lg') !== 'tile') ro.observe(el); });
  }
  var mx = -1, my = -1, raf = 0;
  /* A value is written only when it changed, and never between two reads. Each write repaints the glass surface (the rim
     is a masked layer as large as the surface) and filters its backdrop again, so the light moves in steps a pixel compare
     cannot tell from smooth: a 2% step of the rim or a 0.5% step of the inner light changes no pixel by more than 4 of 255.
     Sweeping the pointer over the tree dropped 194 of ~700 frames with 0.1% steps, 62 with these. */
  function q(v, step) { return Math.round(v / step) * step; }
  /* A value is written only when it changed, and never between two reads. */
  function put(el, c, name, v) { if (c[name] === v) return; c[name] = v; el.style.setProperty(name, v); }
  function light() {
    raf = 0;
    var boxes = [], H = innerHeight, i;
    els.forEach(function (el) {
      if (!el.isConnected) { els.delete(el); return; }
      var b = el.getBoundingClientRect(); if (b.bottom < 0 || b.top > H || !b.width) return;
      boxes.push(el, b);
    });
    for (i = 0; i < boxes.length; i += 2) {
      var el = boxes[i], b = boxes[i + 1], c = el.__lgv || (el.__lgv = {});
      var cx = b.left + b.width / 2, cy = b.top + b.height / 2, dx = mx - cx, dy = my - cy, L = Math.hypot(dx, dy) || 1;
      put(el, c, '--lx', q(50 + dx / L * 55, 2) + '%');
      put(el, c, '--ly', q(50 + dy / L * 55, 2) + '%');
      put(el, c, '--ilx', q(40 + dx / L * 6, 0.5) + '%'); put(el, c, '--ily', q(15 + dy / L * 6, 0.5) + '%');
      if (mx >= b.left && mx <= b.right && my >= b.top && my <= b.bottom) {
        put(el, c, '--px', ((mx - b.left) / b.width * 100).toFixed(1) + '%');
        put(el, c, '--py', ((my - b.top) / b.height * 100).toFixed(1) + '%');
      }
    }
  }
  function start() {
    var st = document.createElement('style'); st.id = 'pom-lg-css'; st.textContent = CSS; document.head.appendChild(st);
    /* While a button is held (panning the tree, dragging a slider) the light stays put. A pan moves the pointer every frame,
       and each light write repaints every glass surface: on a tree pan that tripled the GPU process's work per frame. */
    addEventListener('pointermove', function (e) { if (e.buttons) return; mx = e.clientX; my = e.clientY; if (!raf) raf = requestAnimationFrame(light); }, { passive: true });
    scan();
    new MutationObserver(function () { scan(); }).observe(document.body, { childList: true, subtree: true });
  }
  window.pomGlass = {
    get mode() { return mode; }, supported: canLiquid,
    set: function (m) { if (m === mode) return; mode = m; try { localStorage.setItem('pom-glass', m); } catch (e) {} var live = []; els.forEach(function (el) { if (el.isConnected) live.push(el); else els.delete(el); }); applyAll(live); }
  };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
