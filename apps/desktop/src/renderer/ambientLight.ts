// @ts-nocheck
// Copied unchanged from the design prototype (design/pom/ambient-light.js): the key light, shafts and dust over the passive tree.
/* Path of Mastery: dynamic key light over the passive tree.
   PomLight.mount(host) fills host with two canvases:
   1 light: a low-resolution buffer (1/5 scale, blurred, scaled up by CSS) holding a key light above the tree and
     soft volumetric shafts. Shafts drift and breathe on smooth noise; the source leans slowly toward the pointer.
   2 dust: motes drift through the shafts and only show where light falls on them.
   Accent colour comes from --accent-rgb, so it follows the theme. Light mode uses soft-light and no dust.
   Pauses when the page is hidden or the host is off-screen. prefers-reduced-motion renders one still frame. */
(function () {
  if (window.PomLight) return;
  const RM = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const noise = (seed) => { let s = seed; const r = []; for (let i = 0; i < 256; i++) { s = (s * 16807) % 2147483647; r.push(s / 2147483647); } return (t) => { const i = Math.floor(t), f = t - i, u = f * f * (3 - 2 * f); return r[i & 255] * (1 - u) + r[(i + 1) & 255] * u; }; };
  const SCALE = 5;

  function mount(host) {
    if (!host || host.__pomLight) return; host.__pomLight = true;
    const mk = (css) => { const c = document.createElement('canvas'); c.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;' + css; host.appendChild(c); return c; };
    const cv = mk('image-rendering:auto'), dc = mk('');
    const cx = cv.getContext('2d'), dx = dc.getContext('2d');
    const beams = Array.from({ length: 8 }, (_, i) => ({ a: -34 + i * 9.5 + (i % 2 ? 2 : -2), w: 2.2 + (i * 7 % 5) * .9, n: noise(101 + i * 17), d: noise(301 + i * 29), sp: .05 + (i % 3) * .025, k: .6 + ((i * 13) % 7) / 10 }));
    const motes = Array.from({ length: 90 }, (_, i) => { const r = noise(900 + i); return { x: Math.random(), y: Math.random(), z: .4 + Math.random() * .6, ph: Math.random() * 100, r }; });
    let W = 0, H = 0, DW = 0, DH = 0, acc = [233, 190, 110], light = false, px = .5, lx = .5, raf = 0, last = 0, vis = true, tick = 0;
    const read = () => { const v = getComputedStyle(host).getPropertyValue('--accent-rgb').split(',').map(Number); if (v.length === 3 && v.every(n => !isNaN(n))) acc = v; light = document.documentElement.getAttribute('data-mode') === 'light'; cv.style.mixBlendMode = light ? 'soft-light' : 'screen'; dc.style.mixBlendMode = 'screen'; dc.style.display = light ? 'none' : ''; };
    const size = () => { const r = host.getBoundingClientRect(); const w = Math.max(1, Math.round(host.clientWidth || r.width)), h = Math.max(1, Math.round(host.clientHeight || r.height)); if (w === DW && h === DH) return; DW = w; DH = h; W = Math.ceil(w / SCALE); H = Math.ceil(h / SCALE); cv.width = W; cv.height = H; dc.width = w; dc.height = h; };
    const onMove = (e) => { const r = host.getBoundingClientRect(); if (r.width) px = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
    window.addEventListener('pointermove', onMove, { passive: true });
    const io = 'IntersectionObserver' in window ? new IntersectionObserver((es) => { vis = es[0].isIntersecting; if (vis) loop(); }) : null; io && io.observe(host);

    function draw(t) {
      if (tick++ % 45 === 0) { read(); size(); }
      const [r, g, b] = acc, k = (light ? .55 : 1) * .5;
      lx += (px - lx) * .02;
      const sx = W * (.58 + (lx - .5) * .16), sy = -H * .14, breathe = .92 + .08 * Math.sin(t * .00045);
      cx.setTransform(1, 0, 0, 1, 0, 0); cx.globalCompositeOperation = 'source-over'; cx.clearRect(0, 0, W, H); cx.filter = 'blur(' + Math.max(1.5, W / 220) + 'px)';
      const key = cx.createRadialGradient(sx, sy, 0, sx, sy, H * 1.15);
      key.addColorStop(0, `rgba(${r},${g},${b},${.3 * k * breathe})`); key.addColorStop(.42, `rgba(${r},${g},${b},${.085 * k * breathe})`); key.addColorStop(1, `rgba(${r},${g},${b},0)`);
      cx.fillStyle = key; cx.fillRect(0, 0, W, H);
      cx.globalCompositeOperation = 'lighter';
      const L = Math.hypot(W, H) * 1.05, ts = t / 1000;
      for (const bm of beams) {
        const ang = (90 + bm.a + (bm.d(ts * bm.sp) - .5) * 7) * Math.PI / 180, hw = (bm.w * (.75 + bm.n(ts * bm.sp * 1.7 + 40) * .5)) * Math.PI / 180;
        const inten = Math.pow(bm.n(ts * bm.sp), 1.6) * .11 * bm.k * k * breathe; if (inten < .004) continue;
        const gr = cx.createRadialGradient(sx, sy, 0, sx, sy, L);
        gr.addColorStop(0, `rgba(${r},${g},${b},${inten})`); gr.addColorStop(.55, `rgba(${r},${g},${b},${inten * .35})`); gr.addColorStop(1, `rgba(${r},${g},${b},0)`);
        cx.fillStyle = gr; cx.beginPath(); cx.moveTo(sx, sy); cx.lineTo(sx + Math.cos(ang - hw) * L, sy + Math.sin(ang - hw) * L); cx.lineTo(sx + Math.cos(ang + hw) * L, sy + Math.sin(ang + hw) * L); cx.closePath(); cx.fill();
      }
      cx.filter = 'none';
      if (light) return;
      dx.clearRect(0, 0, DW, DH);
      const SX = sx * SCALE, SY = sy * SCALE, R = Math.hypot(DW, DH);
      for (const m of motes) {
        if (!RM) { m.y -= .00006 * m.z; m.x += (m.r(ts * .2 + m.ph) - .5) * .0004; if (m.y < -.02) { m.y = 1.02; m.x = Math.random(); } if (m.x < 0) m.x += 1; if (m.x > 1) m.x -= 1; }
        const X = m.x * DW, Y = m.y * DH, dxl = X - SX, dyl = Y - SY, dist = Math.hypot(dxl, dyl), a = Math.atan2(dyl, dxl) * 180 / Math.PI - 90;
        let lit = 0; for (const bm of beams) { const c = bm.a + (bm.d(ts * bm.sp) - .5) * 7, dd = Math.abs(a - c); if (dd < bm.w * 1.2) lit = Math.max(lit, (1 - dd / (bm.w * 1.2)) * Math.pow(bm.n(ts * bm.sp), 1.6) * bm.k); }
        lit = lit * .85 + .15; const fall = Math.max(0, 1 - dist / (R * .95)); const tw = .6 + .4 * Math.sin(ts * 1.3 + m.ph);
        const al = lit * fall * tw * .55 * m.z; if (al < .02) continue;
        dx.fillStyle = `rgba(${Math.min(255, r + 30)},${Math.min(255, g + 30)},${Math.min(255, b + 30)},${al})`; dx.beginPath(); dx.arc(X, Y, .5 + m.z * 1.1, 0, 6.283); dx.fill();
      }
    }
    function loop() { cancelAnimationFrame(raf); if (RM) { read(); size(); draw(0); return; } const f = (t) => { if (!host.isConnected) { window.removeEventListener('pointermove', onMove); io && io.disconnect(); return; } if (document.hidden || !vis) return; if (t - last > 32) { last = t; draw(t); } raf = requestAnimationFrame(f); }; raf = requestAnimationFrame(f); }
    document.addEventListener('visibilitychange', () => { if (!document.hidden) loop(); });
    window.addEventListener('storage', (e) => { if (e.key === 'pom-theme' || e.key === 'pom-mode') setTimeout(read, 50); });
    new MutationObserver(() => setTimeout(read, 30)).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-mode'] });
    read(); size(); loop();
  }
  window.PomLight = { mount };
})();

export {};
