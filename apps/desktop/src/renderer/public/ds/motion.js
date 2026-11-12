/* Path of Mastery: shared motion layer. Every screen uses it, so no page hand-rolls its own.
   Loaded from every DC helmet. Everything runs on WAAPI (transform + opacity), is interruptible, and respects
   prefers-reduced-motion or <html data-reduced-motion="on"> (then every moment is a 120 ms opacity fade).
   Moments handled here:
   - Menus and popovers ([data-lg="pop"]): grow in (smooth 260, spring-glass), rows stagger 60 + 24 ms × i (max 8); close fades back up (quick 160, ease-in).
   - Dialogs (a pop/panel centred with left:50%, or after a scrim): rise and settle (glide 420, spring-heavy); scrims fade.
   - Floating panels ([data-lg="panel"] mounted after load): rise 6 px (smooth 260).
   - Tab content (any [data-screen-label*="/ Tab /"] subtree): toolbar and cards stagger up 8 px.
   - Segmented controls and tab rows: the active highlight slides from the old item to the new one (smooth 260).
   - Buttons whose label changes length resize smoothly (moment 9).
   Tooltips (pointer-events:none) stay instant. Opt out with data-motion="off" on any element. */
(function () {
  if (window.PomMotion) return;
  const d = document.documentElement; d.setAttribute('data-motion', 'on');
  const SP = {
    glass: 'linear(0, 0.047, 0.159, 0.299, 0.444, 0.58, 0.698, 0.795, 0.872, 0.929, 0.969, 0.996, 1.013, 1.022, 1.025, 1.025, 1.023, 1.019, 1.016, 1.012, 1.009, 1.006, 1.004, 1.002, 1)',
    heavy: 'linear(0, 0.049, 0.161, 0.297, 0.435, 0.561, 0.67, 0.759, 0.83, 0.884, 0.925, 0.954, 0.974, 0.987, 0.996, 1.001, 1.004, 1.005, 1.005, 1.005, 1.004, 1.003, 1.003, 1.002, 1)',
    snappy: 'linear(0, 0.052, 0.166, 0.299, 0.428, 0.544, 0.642, 0.723, 0.788, 0.839, 0.879, 0.909, 0.932, 0.95, 0.963, 0.973, 0.98, 0.985, 0.989, 0.992, 0.994, 0.996, 0.997, 0.998, 1)',
    ease: 'cubic-bezier(.2,0,0,1)', easeIn: 'cubic-bezier(.4,0,1,1)'
  };
  try { document.createElement('div').animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1, easing: SP.glass }).cancel(); } catch (e) { SP.glass = SP.heavy = SP.snappy = SP.ease; }
  const RM = () => (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) || d.getAttribute('data-reduced-motion') === 'on';
  const st = document.createElement('style');
  st.textContent = '[data-motion] [data-lg="pop"]{animation:none !important}' +
    '@keyframes pom-skel{from{background-position:-480px 0}to{background-position:480px 0}}' +
    '[data-skel]{background:linear-gradient(90deg,rgba(var(--line-rgb),.045) 0,rgba(var(--line-rgb),.11) 160px,rgba(var(--line-rgb),.045) 320px) 0 0/960px 100% !important;animation:pom-skel 1.4s linear infinite;border-radius:6px}' +
    '@media (prefers-reduced-motion: reduce){[data-skel]{animation:none}}';
  (document.head || d).appendChild(st);
  const layer = () => { let l = document.getElementById('pom-motion-layer'); if (!l) { l = document.createElement('div'); l.id = 'pom-motion-layer'; l.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147482000'; document.body.appendChild(l); } return l; };
  const off = (el) => !!(el.closest && el.closest('[data-motion="off"],[data-motion="self"]'));
  const cancel = (el) => { if (el.getAnimations) el.getAnimations().forEach(a => { if (a.id === 'pom') a.cancel(); }); };
  const anim = (el, kf, o) => { cancel(el); const a = el.animate(kf, Object.assign({ fill: 'backwards' }, o)); a.id = 'pom'; return a; };
  const fade = (el, delay) => anim(el, [{ opacity: 0 }, { opacity: 1 }], { duration: 120, delay: delay || 0 });
  const base = (el) => el.style.transform || '';
  const isScrim = (el) => { const s = el.style; return el.tagName === 'DIV' && !el.children.length && (s.height === '3000px' || s.inset === '0px' || (s.left === '0px' && s.right === '0px')) && (/blur/.test(s.backdropFilter || s.webkitBackdropFilter || '') || /void-rgb|scrim/.test(s.background)); };
  const kindOf = (el) => {
    if (!(el instanceof HTMLElement) || off(el)) return null;
    const lg = el.getAttribute('data-lg');
    if (isScrim(el)) return 'scrim';
    if (lg !== 'pop' && lg !== 'panel') return null;
    /* Tooltips stay instant. A tooltip is marked role="tooltip" or does not take the pointer; pointer-events usually comes
       from a stylesheet (.tt-tip) or a wrapper, so the computed value counts, not only the inline one. Before, the tree's
       node tooltip was taken for a menu: it grew in on every hover, and on leave its ghost faded out at the box the
       motion layer had measured, the page's top-left corner when it was measured before the tooltip was placed. */
    if (el.getAttribute('role') === 'tooltip' || el.style.pointerEvents === 'none' || getComputedStyle(el).pointerEvents === 'none') return null;
    const prev = el.previousElementSibling;
    if (el.style.left === '50%' || /translate\(-50%/.test(el.style.transform) || (prev && isScrim(prev))) return 'dialog';
    return lg === 'pop' ? 'menu' : 'panel';
  };
  const tracked = new Set();
  const snap = () => { for (const el of tracked) { if (!el.isConnected) continue; const r = el.getBoundingClientRect(); if (!r.width) continue; el.__pomR = { l: r.left, t: r.top, w: r.width, h: r.height, s: el.offsetWidth ? r.width / el.offsetWidth : 1 }; } };
  ['pointerdown', 'keydown', 'wheel'].forEach(t => addEventListener(t, snap, true));

  function rowsOf(el) {
    const out = []; const all = el.querySelectorAll('[style*="cursor: pointer"],[style*="cursor:pointer"]');
    for (const r of all) { if (out.length >= 12) break; if (out.some(o => o.contains(r))) continue; const h = r.offsetHeight; if (h >= 22 && h <= 64) out.push(r); }
    return out;
  }
  function enter(el, kind, i) {
    tracked.add(el); requestAnimationFrame(snap);
    if (RM()) { fade(el); return; }
    const b = base(el), D = i ? Math.min(i, 8) * 24 : 0;
    if (kind === 'scrim') { anim(el, [{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: SP.ease }); return; }
    if (kind === 'menu') {
      el.style.transformOrigin = el.style.transformOrigin || 'top center';
      anim(el, [{ opacity: 0, transform: b + ' translateY(-6px) scale(.97)' }, { opacity: 1, transform: b || 'none' }], { duration: 260, easing: SP.glass });
      rowsOf(el).forEach((r, k) => anim(r, [{ opacity: 0, transform: 'translateY(-3px)' }, { opacity: 1, transform: 'none' }], { duration: 160, delay: 60 + Math.min(k, 8) * 24, easing: SP.ease }));
    } else if (kind === 'dialog') {
      anim(el, [{ opacity: 0, transform: b + ' translateY(12px) scale(.965)' }, { opacity: 1, transform: b || 'none' }], { duration: 420, easing: SP.heavy });
      rowsOf(el).slice(0, 8).forEach((r, k) => anim(r, [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 260, delay: 120 + k * 24, easing: SP.ease }));
    } else {
      anim(el, [{ opacity: 0, transform: b + ' translateY(6px) scale(.985)' }, { opacity: 1, transform: b || 'none' }], { duration: 260, delay: D, easing: SP.glass });
    }
  }
  function exit(el) {
    if (el.__pomExiting) return; el.__pomExiting = true;
    const r = el.__pomR; tracked.delete(el); const k = el.__pomK; el.__pomK = null; if (!r || !r.w) return;
    const g = el; const s = r.s || 1;
    g.style.position = 'fixed'; g.style.left = r.l + 'px'; g.style.top = r.t + 'px'; g.style.right = 'auto'; g.style.bottom = 'auto'; g.style.margin = '0';
    g.style.width = (r.w / s) + 'px'; g.style.height = k === 'scrim' ? (r.h / s) + 'px' : (r.h / s) + 'px'; g.style.maxHeight = 'none'; g.style.transformOrigin = '0 0'; g.style.transform = s !== 1 ? `scale(${s})` : 'none'; g.style.pointerEvents = 'none';
    const th = el.__pomTheme; if (th) { g.setAttribute('data-theme', th[0]); if (th[1]) g.setAttribute('data-mode', th[1]); }
    layer().appendChild(g);
    const t = g.style.transform === 'none' ? '' : g.style.transform;
    const kf = RM() || k === 'scrim' ? [{ opacity: 1 }, { opacity: 0 }] : k === 'dialog' ? [{ opacity: 1, transform: t || 'none' }, { opacity: 0, transform: t + ' translateY(6px) scale(.98)' }] : [{ opacity: 1, transform: t || 'none' }, { opacity: 0, transform: t + ' translateY(-4px) scale(.98)' }];
    const a = g.animate(kf, { duration: RM() ? 120 : k === 'dialog' ? 200 : 160, easing: SP.easeIn, fill: 'forwards' });
    a.onfinish = a.oncancel = () => { g.remove(); };
  }
  function tabEnter(root) {
    if (RM()) { fade(root); return; }
    const picks = []; const add = (el) => { if (el && !picks.includes(el) && picks.length < 16 && !picks.some(p => p.contains(el))) picks.push(el); };
    root.querySelectorAll('[data-r~="tab-tb"]').forEach(add);
    root.querySelectorAll('[data-card],[data-r~="tab-body"] > [data-lg],[data-r~="tab-body"] > div > [data-lg="panel"]').forEach(add);
    if (!picks.length) root.querySelectorAll('[data-lg="panel"]').forEach(add);
    anim(root, [{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: SP.ease });
    picks.forEach((el, k) => anim(el, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 260, delay: 40 + Math.min(k, 8) * 24, easing: SP.glass }));
  }
  const themeOf = (el) => { const t = el.closest && el.closest('[data-theme]'); if (!t || t === d) return null; return [t.getAttribute('data-theme'), t.getAttribute('data-mode')]; };
  let loadT = performance.now();
  const mo = new MutationObserver((ms) => {
    const now = performance.now(), streaming = now - loadT < 1200;
    let stag = 0;
    for (const m of ms) {
      if (m.target && m.target.id === 'pom-motion-layer') continue;
      if (m.type === 'characterData' || (m.type === 'childList' && m.target.nodeType === 1 && m.target.closest && m.target.closest('button'))) labelChange(m.target.nodeType === 3 ? m.target.parentElement : m.target);
      for (const n of m.removedNodes) { if (n.nodeType !== 1 || n.parentNode) continue; if (n.__pomK) exit(n); else if (n.querySelectorAll) n.querySelectorAll('[data-lg="pop"],[data-lg="panel"]').forEach(c => { if (c.__pomK && c.__pomR) { /* nested: parent removal takes it out too */ } }); }
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1 || n.parentNode === layer()) continue;
        const k = kindOf(n);
        if (k) { n.__pomK = k; n.__pomTheme = themeOf(n); if (!(streaming && k === 'panel')) enter(n, k, stag++); else tracked.add(n); continue; }
        if (!streaming && n.querySelector) {
          const tab = n.matches && n.matches('[data-screen-label*="/ Tab /"]') ? n : n.querySelector('[data-screen-label*="/ Tab /"]');
          if (tab) { tabEnter(tab); continue; }
          n.querySelectorAll('[data-lg="pop"],[data-lg="panel"]').forEach(c => { const kk = kindOf(c); if (kk && !c.__pomK) { c.__pomK = kk; c.__pomTheme = themeOf(c); enter(c, kk, stag++); } });
          const s = n.querySelector && [...n.children].find(isScrim); if (s && !s.__pomK) { s.__pomK = 'scrim'; enter(s, 'scrim'); }
        }
      }
    }
  });
  const start = () => { loadT = performance.now(); mo.observe(document.body, { childList: true, subtree: true, characterData: true }); document.querySelectorAll('[data-lg="pop"],[data-lg="panel"]').forEach(c => { const k = kindOf(c); if (k) { c.__pomK = k; tracked.add(c); } }); };
  if (document.body) start(); else addEventListener('DOMContentLoaded', start);

  /* sliding highlight for segmented controls and tab rows */
  const bgOf = (el) => { const cs = getComputedStyle(el); const img = cs.backgroundImage !== 'none', col = cs.backgroundColor, a = /rgba\([^)]*,\s*0\)|transparent/.test(col) || col === 'rgba(0, 0, 0, 0)'; return img || !a; };
  function activeIn(p) { const kids = [...p.children].filter(c => c.nodeType === 1 && c.offsetWidth); if (kids.length < 2 || kids.length > 12) return null; const on = kids.filter(bgOf); return on.length === 1 ? on[0] : null; }
  function segGroup(t) { for (let el = t, i = 0; el && i < 4; el = el.parentElement, i++) { const p = el.parentElement; if (!p) return null; const a = activeIn(p); if (a) { const kids = [...p.children]; const sameH = kids.every(k => Math.abs(k.offsetHeight - a.offsetHeight) < 3); if (sameH) return { p, a }; } } return null; }
  addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !(e.target instanceof Element) || off(e.target)) return; const g = segGroup(e.target); if (!g) return;
    const pr = g.p.getBoundingClientRect(), ar = g.a.getBoundingClientRect(), cs = getComputedStyle(g.a);
    const snapA = { l: ar.left - pr.left, t: ar.top - pr.top, w: ar.width, h: ar.height, bg: cs.backgroundImage !== 'none' ? cs.backgroundImage : cs.backgroundColor, sh: cs.boxShadow, br: cs.borderRadius, s: g.p.offsetWidth ? pr.width / g.p.offsetWidth : 1 };
    const up = () => { removeEventListener('pointerup', up, true); setTimeout(() => requestAnimationFrame(() => slide(g.p, snapA)), 0); };
    addEventListener('pointerup', up, true);
  }, true);
  function slide(p, from) {
    if (!p.isConnected || RM()) return; const a = activeIn(p); if (!a) return;
    const pr = p.getBoundingClientRect(), ar = a.getBoundingClientRect(), s = from.s || 1, to = { l: ar.left - pr.left, t: ar.top - pr.top, w: ar.width, h: ar.height };
    if (Math.abs(to.l - from.l) < 2 && Math.abs(to.t - from.t) < 2) return;
    const cs = getComputedStyle(p); if (cs.position === 'static') p.style.position = 'relative'; if (cs.isolation !== 'isolate') p.style.isolation = 'isolate';
    const g = document.createElement('div'); g.setAttribute('data-motion', 'off');
    g.style.cssText = `position:absolute;left:${to.l / s}px;top:${to.t / s}px;width:${to.w / s}px;height:${to.h / s}px;z-index:-1;pointer-events:none;border-radius:${from.br};background:${from.bg};box-shadow:${from.sh}`;
    p.insertBefore(g, p.firstChild);
    const ac = getComputedStyle(a); const keep = [a.style.getPropertyValue('background'), a.style.getPropertyPriority('background'), a.style.getPropertyValue('box-shadow'), a.style.getPropertyPriority('box-shadow')];
    a.style.setProperty('background', 'transparent', 'important'); a.style.setProperty('box-shadow', 'none', 'important');
    const dx = (from.l - to.l) / s, dy = (from.t - to.t) / s, sx = from.w / to.w, sy = from.h / to.h;
    const an = g.animate([{ transform: `translate(${dx}px,${dy}px) scale(${sx},${sy})` }, { transform: 'none' }], { duration: 260, easing: SP.glass }); g.style.transformOrigin = '0 0';
    const done = () => { g.remove(); if (a.isConnected) { if (keep[0]) a.style.setProperty('background', keep[0], keep[1]); else a.style.removeProperty('background'); if (keep[2]) a.style.setProperty('box-shadow', keep[2], keep[3]); else a.style.removeProperty('box-shadow'); } };
    an.onfinish = an.oncancel = done;
  }

  /* moment 9: label-change resize */
  const widths = new WeakMap();
  addEventListener('pointerdown', (e) => { const b = e.target instanceof Element && e.target.closest('button'); if (b) widths.set(b, b.offsetWidth); }, true);
  function labelChange(n) {
    const b = n && n.closest && n.closest('button'); if (!b || RM() || off(b)) return; const w0 = widths.get(b); if (!w0) return;
    requestAnimationFrame(() => { const w1 = b.offsetWidth; widths.set(b, w1); if (Math.abs(w1 - w0) < 3) return;
      b.style.overflow = 'hidden'; anim(b, [{ width: w0 + 'px' }, { width: w1 + 'px' }], { duration: 260, easing: SP.glass });
      [...b.childNodes].forEach(c => { if (c.nodeType === 1) anim(c, [{ opacity: 0 }, { opacity: 1 }], { duration: 160, delay: 40 }); }); });
  }
  window.PomMotion = { SP, reduced: RM, enter, tabEnter };
})();
