/* Path of Mastery icon pack.
   One line set on a 24 grid, 2px stroke (1.33px at 16), round caps and joins, currentColor.
   Usage: <pom-icon name="search" size="16"></pom-icon>   attrs: name, size (px, default 16), stroke, label (sets role=img + aria-label; otherwise decorative).
   Colour comes from the parent `color`. Game glyphs (element, pool, attribute) take their token colour from the caller. */
(function () {
  if (window.POM_ICONS) return;
  const f = (d) => `<path d="${d}" fill="currentColor" stroke="none"></path>`;
  const c = (x, y, r, fill) => `<circle cx="${x}" cy="${y}" r="${r}"${fill ? ' fill="currentColor" stroke="none"' : ''}></circle>`;
  const r = (x, y, w, h, rx = 2) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}"></rect>`;
  const p = (d, extra = '') => `<path d="${d}"${extra}></path>`;
  const poly = (pts) => 'M' + pts.map((q) => q[0].toFixed(2) + ' ' + q[1].toFixed(2)).join('L') + 'Z';
  const star = (cx, cy, R, ri, n = 5, rot = -90) => { const o = []; for (let i = 0; i < n * 2; i++) { const a = (rot + i * 180 / n) * Math.PI / 180, rr = i % 2 ? ri : R; o.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]); } return poly(o); };
  const gear = () => { const o = []; for (let i = 0; i < 8; i++) { const a = i * 45; [[-15, 7.2], [-8, 9.8], [8, 9.8], [15, 7.2]].forEach(([d, rr]) => { const t = (a + d) * Math.PI / 180; o.push([12 + rr * Math.cos(t), 12 + rr * Math.sin(t)]); }); } return poly(o); };
  const spark = (cx, cy, s) => `M${cx} ${cy - s}c${s * .08} ${s * .62} ${s * .38} ${s * .92} ${s} ${s}c-${s * .62} ${s * .08}-${s * .92} ${s * .38}-${s} ${s}c-${s * .08}-${s * .62}-${s * .38}-${s * .92}-${s}-${s}c${s * .62}-${s * .08} ${s * .92}-${s * .38} ${s}-${s}z`;
  const SH = 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z';
  const CLOUD = 'M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9z';
  const FILE = 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7zM14 2v4a2 2 0 0 0 2 2h4';
  const FOLDER = 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z';
  const DROP = 'M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5S5 13 5 15a7 7 0 0 0 7 7z';
  const HEART = 'M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7z';
  const MSG = 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z';
  const SPK = 'M11 5L6 9H2v6h4l5 4z';
  const BELL = 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0';
  const SWORD = 'M14.5 17.5L3 6V3h3l11.5 11.5M13 19l6-6M16 16l4 4M19 21l2-2';
  const ROT = 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5';
  const THUMB = 'M7 10v12M15 5.88L14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88z';
  const HEX = 'M12 2l8.66 5v10L12 22l-8.66-5V7z';

  const I = {
    // Navigation
    'chevron-down': p('M6 9l6 6 6-6'), 'chevron-up': p('M18 15l-6-6-6 6'), 'chevron-left': p('M15 18l-6-6 6-6'), 'chevron-right': p('M9 18l6-6-6-6'),
    'chevrons-left': p('M11 17l-5-5 5-5M18 17l-5-5 5-5'), 'chevrons-right': p('M13 17l5-5-5-5M6 17l5-5-5-5'), 'chevrons-up-down': p('M7 15l5 5 5-5M7 9l5-5 5 5'),
    'caret-down': f('M6 9h12l-6 7z'), 'caret-right': f('M9 6v12l7-6z'),
    'arrow-left': p('M19 12H5M12 19l-7-7 7-7'), 'arrow-right': p('M5 12h14M12 5l7 7-7 7'), 'arrow-up': p('M12 19V5M5 12l7-7 7 7'), 'arrow-down': p('M12 5v14M19 12l-7 7-7-7'),
    'arrow-up-right': p('M7 17L17 7M7 7h10v10'), 'arrow-down-right': p('M7 7l10 10M17 7v10H7'), 'arrow-up-down': p('M21 16l-4 4-4-4M17 20V4M3 8l4-4 4 4M7 4v16'),
    'swap': p('M8 3L4 7l4 4M4 7h16M16 21l4-4-4-4M20 17H4'), 'corner-up-left': p('M9 14L4 9l5-5M20 20v-7a4 4 0 0 0-4-4H4'),
    'external': p('M15 3h6v6M10 14L21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'),
    'home': p('M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z'), 'menu': p('M4 6h16M4 12h16M4 18h16'),
    'more': c(5, 12, 1.6, 1) + c(12, 12, 1.6, 1) + c(19, 12, 1.6, 1), 'more-vertical': c(12, 5, 1.6, 1) + c(12, 12, 1.6, 1) + c(12, 19, 1.6, 1),
    'grip': [5, 12, 19].map((y) => c(9, y, 1.5, 1) + c(15, y, 1.5, 1)).join(''),
    'sidebar-left': r(3, 3, 18, 18) + p('M9 3v18'), 'sidebar-right': r(3, 3, 18, 18) + p('M15 3v18'), 'panel-bottom': r(3, 3, 18, 18) + p('M3 15h18'),
    'layout': r(3, 3, 7, 9, 1) + r(14, 3, 7, 5, 1) + r(14, 12, 7, 9, 1) + r(3, 16, 7, 5, 1),
    'window-max': r(4, 4, 16, 16, 2), 'window-restore': r(3, 8, 13, 13, 2) + p('M8 8V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-3'), 'window-min': p('M5 12h14'),
    'maximize': p('M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7'), 'minimize': p('M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7'),
    'fullscreen': p('M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3'),
    'log-out': p('M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9'), 'log-in': p('M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3'),
    // Actions
    'plus': p('M12 5v14M5 12h14'), 'minus': p('M5 12h14'), 'x': p('M18 6L6 18M6 6l12 12'), 'check': p('M20 6L9 17l-5-5'),
    'check-circle': c(12, 12, 9.5) + p('M8.5 12.5l2.5 2.5 5-5.5'), 'x-circle': c(12, 12, 9.5) + p('M15 9l-6 6M9 9l6 6'),
    'plus-circle': c(12, 12, 9.5) + p('M12 8v8M8 12h8'), 'minus-circle': c(12, 12, 9.5) + p('M8 12h8'),
    'search': c(11, 11, 7) + p('M20 20l-4-4'), 'filter': p('M22 3H2l8 9.46V19l4 2v-8.54z'),
    'sliders': p('M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4'),
    'settings': p(gear()) + c(12, 12, 3),
    'edit': p('M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5zM15 5l4 4'), 'rename': p('M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z'),
    'trash': p('M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6'),
    'copy': r(9, 9, 13, 13, 2) + p('M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'),
    'duplicate': r(8, 8, 14, 14, 2) + p('M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2M15 12v6M12 15h6'),
    'clipboard': r(8, 2, 8, 4, 1) + p('M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2'),
    'clipboard-check': r(8, 2, 8, 4, 1) + p('M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M9 14l2 2 4-4'),
    'paste': r(8, 2, 8, 4, 1) + p('M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M12 10v7M9 14l3 3 3-3'),
    'save': p('M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2zM17 21v-8H7v8M7 3v5h8'),
    'download': p('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3'), 'upload': p('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12'),
    'import': p('M14 2H6a2 2 0 0 0-2 2v6M14 2v6h6M20 8v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2M2 15h10M9 12l3 3-3 3'),
    'export': p('M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3M14 2v6h6v3M10 14h12M19 11l3 3-3 3'),
    'share': c(18, 5, 3) + c(6, 12, 3) + c(18, 19, 3) + p('M8.59 13.51l6.83 3.98M15.41 6.51l-6.82 3.98'),
    'link': p('M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'),
    'unlink': p('M18.84 12.25l1.72-1.71a5 5 0 0 0-7.07-7.07l-1.72 1.71M5.17 11.75l-1.71 1.71a5 5 0 0 0 7.07 7.07l1.71-1.71M8 2v3M2 8h3M16 22v-3M22 16h-3'),
    'refresh': p('M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16M16 16h5v5'),
    'reset': p(ROT), 'history': p(ROT + 'M12 7v5l4 2'),
    'undo': p('M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11'), 'redo': p('M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13'),
    'lock': r(4, 11, 16, 10, 2) + p('M8 11V7a4 4 0 0 1 8 0v4'), 'unlock': r(4, 11, 16, 10, 2) + p('M8 11V7a4 4 0 0 1 7.9-1'),
    'eye': p('M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z') + c(12, 12, 3),
    'eye-off': p('M9.9 4.24A9.1 9.1 0 0 1 12 4c6.5 0 10 8 10 8a13.2 13.2 0 0 1-1.67 2.68M6.61 6.61A13.5 13.5 0 0 0 2 12s3.5 8 10 8a9.7 9.7 0 0 0 5.39-1.61M14.12 14.12a3 3 0 1 1-4.24-4.24M2 2l20 20'),
    'pin': p('M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z'),
    'star': p(star(12, 12.6, 10, 4.3)), 'star-fill': f(star(12, 12.6, 10, 4.3)) + p(star(12, 12.6, 10, 4.3)),
    'bookmark': p('M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z'),
    'tag': p('M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4z') + c(7.5, 7.5, 1.6, 1),
    'folder': p(FOLDER), 'folder-plus': p(FOLDER + 'M12 10v6M9 13h6'),
    'folder-open': p('M6 14l1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2'),
    'file': p(FILE), 'file-text': p(FILE + 'M16 13H8M16 17H8M10 9H8'), 'file-plus': p(FILE + 'M12 12v6M9 15h6'),
    'files': p('M20 7h-3a2 2 0 0 1-2-2V2M9 18a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h7l4 4v10a2 2 0 0 1-2 2zM3 7.6v12.8A1.6 1.6 0 0 0 4.6 22h9.8'),
    'archive': r(2, 3, 20, 5, 1) + p('M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4'),
    'inbox': p('M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z'),
    'send': p('M22 2L11 13M22 2l-7 20-4-9-9-4z'),
    'zoom-in': c(11, 11, 7) + p('M20 20l-4-4M11 8v6M8 11h6'), 'zoom-out': c(11, 11, 7) + p('M20 20l-4-4M8 11h6'),
    'crosshair': c(12, 12, 9.5) + p('M22 12h-4M6 12H2M12 6V2M12 22v-4'),
    'move': p('M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20'),
    'play': f('M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5z'),
    'pause': f('M6 4h4v16H6zM14 4h4v16h-4z'), 'stop': f('M6 6h12v12H6z'),
    'volume': p(SPK + 'M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14'), 'volume-low': p(SPK + 'M15.54 8.46a5 5 0 0 1 0 7.07'), 'volume-off': p(SPK + 'M22 9l-6 6M16 9l6 6'),
    'bell': p(BELL), 'bell-off': p('M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7M10.3 21a1.94 1.94 0 0 0 3.4 0M2 2l20 20'),
    'keyboard': r(2, 5, 20, 14, 2) + p('M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M10 13h4M7 16h10'),
    'command': p('M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z'),
    'power': p('M12 2v10M18.4 6.6a9 9 0 1 1-12.77.04'),
    'type': p('M4 7V4h16v3M9 20h6M12 4v16'), 'code': p('M16 18l6-6-6-6M8 6l-6 6 6 6'), 'terminal': p('M4 17l6-6-6-6M12 19h8'),
    'mouse': p('M3 3l7.07 16.97 2.51-7.39 7.39-2.51z'),
    'image': r(3, 3, 18, 18, 2) + c(9, 9, 2) + p('M21 15l-3.09-3.09a2 2 0 0 0-2.82 0L6 21'),
    'palette': p('M12 22a10 10 0 1 1 10-10c0 2.5-2 3.5-4 3.5h-2a2 2 0 0 0-1.5 3.3c.8.9.2 3.2-2.5 3.2z') + c(13.5, 6.5, 1.1, 1) + c(17.5, 10.5, 1.1, 1) + c(8.5, 7.5, 1.1, 1) + c(6.5, 12.5, 1.1, 1),
    'wand': p('M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M17.8 6.2L19 5M3 21l9-9M12.2 6.2L11 5'),
    'sparkle': p(spark(12, 12, 9.5)), 'sparkle-fill': f(spark(12, 12, 9.5)),
    'sparkles': p(spark(10, 11, 8) + spark(19.5, 4.5, 2.5) + spark(19.5, 18.5, 2)),
    'zap': p('M13 2L3 14h9l-1 8 10-12h-9z'), 'flag': p('M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7'),
    'target': c(12, 12, 9.5) + c(12, 12, 5.5) + c(12, 12, 1.6, 1),
    'shield-check': p(SH + 'M9 12l2 2 4-4'), 'ban': c(12, 12, 9.5) + p('M5.3 5.3l13.4 13.4'),
    'lightbulb': p('M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5M9 18h6M10 22h4'),
    'book': p('M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20'),
    'note': p('M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5zM15 3v6h6M7 13h8M7 17h5'),
    'wrench': p('M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z'),
    // Status
    'info': c(12, 12, 9.5) + p('M12 16v-4.5M12 8h.01'), 'warning': p('M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01'),
    'error': c(12, 12, 9.5) + p('M12 7.5v5M12 16.5h.01'), 'help': c(12, 12, 9.5) + p('M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01'),
    'clock': c(12, 12, 9.5) + p('M12 7v5l3 2'), 'loader': p('M21 12a9 9 0 1 1-6.22-8.56'),
    'hourglass': p('M5 22h14M5 2h14M17 22v-4.17a2 2 0 0 0-.59-1.42L12 12l-4.41 4.41A2 2 0 0 0 7 17.83V22M7 2v4.17a2 2 0 0 0 .59 1.42L12 12l4.41-4.41A2 2 0 0 0 17 6.17V2'),
    'dot': c(12, 12, 4, 1), 'circle-dot': c(12, 12, 9.5) + c(12, 12, 3, 1),
    'wifi-off': p('M2 2l20 20M8.5 16.5a5 5 0 0 1 7 0M2 8.82a15 15 0 0 1 4.17-2.65M10.66 5c4.01-.36 8.14.9 11.34 3.76M16.85 11.25a10 10 0 0 1 2.22 1.68M5 13a10 10 0 0 1 5.24-2.76M12 20h.01'),
    // Data & view
    'grid': r(3, 3, 7, 7, 1.5) + r(14, 3, 7, 7, 1.5) + r(3, 14, 7, 7, 1.5) + r(14, 14, 7, 7, 1.5),
    'list': p('M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01'), 'list-ordered': p('M10 6h11M10 12h11M10 18h11M4 6h1v4M4 10h2M6 18H4c0-1 2-2 2-3s-1-1.5-2-1'),
    'rows': r(3, 3, 18, 18) + p('M3 9h18M3 15h18'), 'columns': r(3, 3, 18, 18) + p('M12 3v18'), 'table': r(3, 3, 18, 18) + p('M3 9h18M3 15h18M9 9v12'),
    'chart-line': p('M3 3v18h18M7 15l4-4 3 3 6-6'), 'chart-bar': p('M3 3v18h18M8 17v-4M13 17V8M18 17v-7'),
    'trend-up': p('M22 7l-8.5 8.5-5-5L2 17M16 7h6v6'), 'trend-down': p('M22 17l-8.5-8.5-5 5L2 7M16 17h6v-6'),
    'pie': p('M21.21 15.89A10 10 0 1 1 8 2.83M22 12A10 10 0 0 0 12 2v10z'), 'layers': p('M12 2L2 7l10 5 10-5zM2 17l10 5 10-5M2 12l10 5 10-5'),
    'calendar': r(3, 4, 18, 18, 2) + p('M16 2v4M8 2v4M3 10h18'), 'hash': p('M4 9h16M4 15h16M10 3L8 21M16 3l-2 18'),
    'percent': p('M19 5L5 19') + c(6.5, 6.5, 2.5) + c(17.5, 17.5, 2.5), 'sigma': p('M18 7V4H6l6 8-6 8h12v-3'),
    'calculator': r(4, 2, 16, 20, 2) + p('M8 6h8M16 14v4M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M8 18h.01M12 18h.01'),
    'gauge': p('M12 14l4-4M3.34 19a10 10 0 1 1 17.32 0'), 'activity': p('M22 12h-4l-3 9L9 3l-3 9H2'),
    'compare': c(18, 18, 3) + c(6, 6, 3) + p('M13 6h3a2 2 0 0 1 2 2v7M11 18H8a2 2 0 0 1-2-2V9M15 3l-2 3 2 3M9 21l2-3-2-3'),
    'scale': p('M16 16l3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1zM2 16l3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1zM7 21h10M12 3v18M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2'),
    'diff': p('M12 3v14M5 10h14M5 21h14'),
    // Account & sync
    'user': c(12, 8, 4) + p('M20 21a8 8 0 0 0-16 0'), 'users': c(9, 7, 4) + p('M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75'),
    'user-plus': c(9, 7, 4) + p('M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M19 8v6M22 11h-6'),
    'cloud': p(CLOUD), 'cloud-check': p(CLOUD + 'M9.5 14l2 2 3.5-3.5'), 'cloud-up': p(CLOUD + 'M12 17v-5M9.5 14.5L12 12l2.5 2.5'), 'cloud-down': p(CLOUD + 'M12 11v5M9.5 13.5L12 16l2.5-2.5'),
    'cloud-off': p('M2 2l20 20M5.78 5.78A7 7 0 0 0 9 19h8.5a4.5 4.5 0 0 0 1.31-.2M21.53 16.5A4.5 4.5 0 0 0 17.5 10h-1.79A7 7 0 0 0 10.2 5.12'),
    'monitor': r(2, 3, 20, 14, 2) + p('M8 21h8M12 17v4'), 'hard-drive': p('M22 12H2M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11zM6 16h.01M10 16h.01'),
    'globe': c(12, 12, 9.5) + p('M2.5 12h19M12 2.5a14.5 14.5 0 0 1 0 19 14.5 14.5 0 0 1 0-19'),
    'message': p(MSG), 'assistant': p(MSG) + p(spark(12, 10, 3.6)),
    'key': c(7.5, 15.5, 5.5) + p('M21 2l-9.6 9.6M15.5 7.5l3 3L22 7l-3-3'),
    'thumbs-up': p(THUMB), 'thumbs-down': `<g transform="matrix(1 0 0 -1 0 24)">${p(THUMB)}</g>`,
    'mail': r(2, 4, 20, 16, 2) + p('M22 7l-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7'),
    'crown': p('M2 5l3.5 12h13L22 5l-6 6.5-4-7.5-4 7.5zM5 21h14'),
    'sun': c(12, 12, 4) + p('M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41'),
    'moon': p('M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z'), 'contrast': c(12, 12, 9.5) + f('M12 2.5a9.5 9.5 0 0 1 0 19z'),
    // Passive tree & build
    'tree': c(12, 12.5, 3) + c(5, 4.5, 2.5) + c(19, 4.5, 2.5) + c(12, 20.5, 2.5) + p('M9.9 10.2L6.7 6.4M14.1 10.2l3.2-3.8M12 15.5V18'),
    'node': c(12, 12, 5), 'notable': c(12, 12, 8) + c(12, 12, 3.5), 'keystone': c(12, 12, 9.5) + p('M12 6l6 6-6 6-6-6z'),
    'mastery': c(12, 12, 9.5) + p(spark(12, 12, 5.5)), 'jewel-socket': c(12, 12, 9.5) + p('M12 7l4.3 2.5v5L12 17l-4.3-2.5v-5z'),
    'ascendancy': p('M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6zM12 7l2.5 4.5L12 16l-2.5-4.5z'),
    'path': c(5.5, 18.5, 2.5) + c(18.5, 5.5, 2.5) + p('M7.5 16.5l9-9', ' stroke-dasharray="2.5 3"'),
    'node-add': c(10, 14, 6) + p('M19 2v6M16 5h6'), 'level-up': p('M17 11l-5-5-5 5M17 18l-5-5-5 5'),
    'pantheon': p('M3 21h18M5 21V11M9.5 21V11M14.5 21V11M19 21V11M2.5 11h19L12 4z'),
    'bandit': p('M3 10c0-2 1-3 3-3h12c2 0 3 1 3 3 0 3-2 5-5 5-2 0-3-1.5-4-1.5S10 15 8 15c-3 0-5-2-5-5z') + c(8, 10.5, 1.3, 1) + c(16, 10.5, 1.3, 1),
    'loadout': p('M12 2L2 7l10 5 10-5zM2 17l10 5 10-5M2 12l10 5 10-5'),
    // Skills
    'gem': p('M6 3h12l4 6-10 12L2 9zM11 3L8 9l4 12 4-12-3-6M2 9h20'),
    'gem-support': p('M12 3l7 9-7 9-7-9zM12 9v6M9 12h6'), 'socket': c(12, 12, 8.5) + c(12, 12, 4),
    'links': p('M9 17H7A5 5 0 0 1 7 7h2M15 7h2a5 5 0 1 1 0 10h-2M8 12h8'),
    'aura': c(12, 12, 2.5, 1) + c(12, 12, 6.5, 0).replace('>', ' stroke-dasharray="2.5 2.6">') + c(12, 12, 10),
    'curse': p(HEX) + c(12, 12, 3),
    'minion': p('M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z') + c(9, 10, 1.3, 1) + c(15, 10, 1.3, 1),
    'totem': r(8.5, 2, 7, 5.5, 1) + r(7, 7.5, 10, 5.5, 1) + r(8.5, 13, 7, 5, 1) + p('M12 18v4M7 22h10'),
    'trap': p('M2 19h20M4 19l2.5-7 2.5 7 2.5-7 2.5 7 2.5-7 2.5 7'),
    'mine': c(11, 14, 7) + p('M15.5 8.5l2-2M18.5 3v1.5M21.5 6H20M20.5 3.5l-1 1'),
    'projectile': p('M3 12h14M13 7l5 5-5 5M3 7h5M3 17h5'),
    'melee': p(SWORD), 'swords': p(SWORD + 'M14.5 6.5L18 3h3v3l-3.5 3.5M5 14l4 4M7 17l-3 3M3 19l2 2'),
    'bow': p('M5 3a16 16 0 0 1 16 16M5 3l16 16M3 21l9-9M12 12H8.5M12 12v3.5'),
    'spell': p('M4 20L14 10') + p(spark(17.5, 6.5, 3.5)), 'speed': p('M13 19l9-7-9-7zM2 19l9-7-9-7z'),
    'trigger': p('M13 2L3 14h9l-1 8 10-12h-9z'),
    // Items
    'weapon': p(SWORD), 'axe': p('M14 12l-8.5 8.5a2.12 2.12 0 1 1-3-3L11 9M15 13L9 7l4-4 6 6h3a8 8 0 0 1-7 7z'),
    'shield': p(SH), 'helmet': p('M5 20v-9a7 7 0 0 1 14 0v9h-4v-5H9v5zM12 4v5'),
    'body-armour': p('M8 3L4 6v5l2 1v9h12v-9l2-1V6l-4-3c-.5 1.5-2 2.5-4 2.5S8.5 4.5 8 3z'),
    'gloves': p('M18 11V6a2 2 0 0 0-4 0v1M14 10V4a2 2 0 0 0-4 0v2M10 10.5V6a2 2 0 0 0-4 0v8M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15'),
    'boots': p('M6 3h6v8l6 3a3 3 0 0 1 2 2.8V20H5V4a1 1 0 0 1 1-1zM5 17h15'),
    'amulet': p('M5 3c0 5 3 8 7 9 4-1 7-4 7-9') + c(12, 16.5, 4.5),
    'ring': c(12, 14.5, 7) + p('M9.5 5L12 2.5 14.5 5 12 7.5z'),
    'belt': r(2, 9, 20, 6, 1) + r(9, 7.5, 6, 9, 1) + p('M12 12h3'),
    'flask': p('M9 2h6M10 2v6L5.5 17.5A3 3 0 0 0 8.2 22h7.6a3 3 0 0 0 2.7-4.5L14 8V2M7 15h10'),
    'quiver': p('M7 8h10l-1.5 13h-7zM9.5 8L8 2M12 8V2M14.5 8L16 2'),
    'jewel': p('M12 2.5l8 4.75v9.5L12 21.5l-8-4.75v-9.5zM12 8l4 2.3v4.4L12 17l-4-2.3v-4.4z'),
    'map': p('M14.1 6.3L9.9 4.2a2 2 0 0 0-1.8 0L3.6 6.5A1 1 0 0 0 3 7.4v12.2a1 1 0 0 0 1.4.9l3.7-1.8a2 2 0 0 1 1.8 0l4.2 2.1a2 2 0 0 0 1.8 0l4.5-2.3a1 1 0 0 0 .6-.9V5.4a1 1 0 0 0-1.4-.9l-3.7 1.8a2 2 0 0 1-1.8 0zM9 4v15M15 6v15'),
    'fragment': p('M13 2l7 7-4 12-9-3-4-9zM11.5 11.5L20 9M11.5 11.5L7 18'),
    'orb': c(12, 12, 8.5) + p('M8.5 9.5a4 4 0 0 1 4-3'), 'coins': c(8, 8, 6) + p('M18.09 10.37A6 6 0 1 1 10.34 18M7 6h1v4M16.71 13.88l.7.71-2.82 2.82'),
    'stash': p('M3 10h18v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 10V8a5 5 0 0 1 5-5h8a5 5 0 0 1 5 5v2M10 10v3h4v-3'),
    'anvil': p('M7 10H6a4 4 0 0 1-4-4 1 1 0 0 1 1-1h4M7 5a1 1 0 0 1 1-1h13a1 1 0 0 1 1 1 7 7 0 0 1-7 7H8a1 1 0 0 1-1-1zM9 12v5M15 12v5M5 20a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3 1 1 0 0 1-1 1H6a1 1 0 0 1-1-1'),
    'scroll': p('M15 12h-5M15 8h-5M19 17V5a2 2 0 0 0-2-2H4M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3'),
    'corrupted': c(12, 12, 9.5) + p('M8 8.5l4 7.5 4-7.5'), 'unique': p(star(12, 12, 10, 6, 4, -90)),
    // Stats & damage (colour with the matching --dmg-*, --pool-*, --stat-* token)
    'life': p(HEART), 'mana': p(DROP), 'energy-shield': p(SH + 'M13 7l-3 5h4l-3 5'),
    'armour': p(SH + 'M12 2v20M4.5 10h15'), 'evasion': p('M12.67 19a2 2 0 0 0 1.416-.588l6.154-6.172a6 6 0 0 0-8.49-8.49L5.586 9.914A2 2 0 0 0 5 11.328V18a1 1 0 0 0 1 1zM16 8L2 22M17.5 15H9'),
    'ward': c(12, 12, 9.5) + p('M12 5v14M6 8.5l12 7M18 8.5l-12 7'), 'block': p(SH) + f('M12 3.1L5 5.7V12c0 4.8 5.8 8.3 7 9z').replace('stroke="none"', 'stroke="none" opacity=".45"'),
    'suppress': p(SH) + p(spark(12, 11.5, 4)), 'ehp': p(SH + 'M12 16.5c-2-1.5-3.5-2.6-3.5-4.3a1.8 1.8 0 0 1 3.5-.9 1.8 1.8 0 0 1 3.5.9c0 1.7-1.5 2.8-3.5 4.3z'),
    'resist': p(SH + 'M8.5 11h7M8.5 14.5h7'), 'leech': p(DROP + 'M12 11v6M9.5 14.5L12 17l2.5-2.5'), 'regen': p(HEART + 'M12 9v6M9 12h6'),
    'fire': p('M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z'),
    'cold': p('M2 12h20M12 2v20M20 16l-4-4 4-4M4 8l4 4-4 4M16 4l-4 4-4-4M8 20l4-4 4 4'),
    'lightning': p('M13 2L3 14h9l-1 8 10-12h-9z'),
    'chaos': p('M12 11a2 2 0 0 1 4 0 4 4 0 0 1-8 0 6 6 0 0 1 12 0 8 8 0 0 1-16 0'),
    'physical': p(star(12, 12, 10, 5, 8, -90)),
    'crit': p('M12 2v5M12 17v5M2 12h5M17 12h5M5 5l3 3M19 5l-3 3M5 19l3-3M19 19l-3-3') + c(12, 12, 1.8, 1),
    'dps': p(SWORD + 'M14.5 6.5L18 3h3v3l-3.5 3.5M5 14l4 4M7 17l-3 3M3 19l2 2'),
    'duration': p('M5 22h14M5 2h14M17 22v-4.17a2 2 0 0 0-.59-1.42L12 12l-4.41 4.41A2 2 0 0 0 7 17.83V22M7 2v4.17a2 2 0 0 0 .59 1.42L12 12l4.41-4.41A2 2 0 0 0 17 6.17V2'),
    'area': c(12, 12, 9.5).replace('>', ' stroke-dasharray="3 2.6">') + c(12, 12, 1.8, 1) + p('M12 12h7'),
    'accuracy': c(12, 12, 9.5) + c(12, 12, 5.5) + c(12, 12, 1.6, 1),
    'attr-str': f('M5 5h14v14H5z'), 'attr-dex': f('M12 4l9 16H3z'), 'attr-int': c(12, 12, 8, 1),
    // Loot filter
    'beam': p('M10 2h4l1 15h-6zM4 20.5c0-1.4 3.6-2.5 8-2.5s8 1.1 8 2.5-3.6 2.5-8 2.5-8-1.1-8-2.5z'),
    'minimap': p('M20 10c0 4.99-5.54 10.19-7.4 11.8a1 1 0 0 1-1.2 0C9.54 20.19 4 14.99 4 10a8 8 0 0 1 16 0') + c(12, 10, 3),
    'border': r(3, 3, 18, 18, 2) + `<rect x="7.5" y="7.5" width="9" height="9" rx="1" stroke-dasharray="2 2"></rect>`,
    'strictness': p('M12 14l4-4M3.34 19a10 10 0 1 1 17.32 0'), 'gamepad': r(2, 6, 20, 12, 3) + p('M6 12h4M8 10v4M15 13h.01M18 11h.01'),
    'shape-circle': c(12, 12, 8), 'shape-square': r(4, 4, 16, 16, 1), 'shape-diamond': p('M12 3l9 9-9 9-9-9z'), 'shape-triangle': p('M12 3.5l9.5 16.5h-19z'),
    'shape-hexagon': p(HEX), 'shape-star': p(star(12, 12.6, 10, 4.3)), 'shape-pentagon': p(star(12, 12.8, 9.5, 9.5 * Math.cos(Math.PI / 5), 5).replace(/L[^L]*?L/g, (m) => m)),
    // Wealth & trade
    'wallet': p('M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4'),
    'snapshot': p('M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z') + c(12, 13, 3.5),
    'receipt': p('M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1zM16 8H8M16 12H8M13 16H8'),
    'market': p('M3 9l1.5-5h15L21 9M3 9h18M3 9v1.5a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0V9M5 13.5V21h14v-7.5M10 21v-4h4v4'),
    'bag': p('M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4zM3 6h18M16 10a4 4 0 0 1-8 0'),
    'trophy': p('M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18M4 22h16M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22M18 2H6v7a6 6 0 0 0 12 0z'),
    'timer': c(12, 14, 8) + p('M10 2h4M12 14l3-3'), 'trade': p('M8 3L4 7l4 4M4 7h16M16 21l4-4-4-4M20 17H4'),
  };
  // pentagon: 5 outer points only
  I['shape-pentagon'] = p(poly([0, 1, 2, 3, 4].map((i) => { const a = (-90 + i * 72) * Math.PI / 180; return [12 + 9.5 * Math.cos(a), 12.8 + 9.5 * Math.sin(a)]; })));

  const ALIAS = { close: 'x', delete: 'trash', gear: 'settings', options: 'settings', pencil: 'edit', 'alert': 'warning', 'alert-circle': 'error', question: 'help', sort: 'arrow-up-down', ai: 'sparkle', skills: 'gem', items: 'weapon', calcs: 'calculator', config: 'sliders', notes: 'note', party: 'users', 'import-export': 'swap', spinner: 'loader', strength: 'attr-str', dexterity: 'attr-dex', intelligence: 'attr-int', es: 'energy-shield', cast: 'spell', attack: 'melee', library: 'folder', build: 'tree', wealth: 'coins', 'loot-filter': 'filter', sell: 'tag', price: 'tag', chat: 'message', account: 'user', sync: 'refresh', local: 'monitor', optimize: 'wand', explain: 'help', whisper: 'message', diamond: 'shape-diamond' };

  const CATS = {
    'Navigation': ['chevron-down', 'chevron-up', 'chevron-left', 'chevron-right', 'chevrons-left', 'chevrons-right', 'chevrons-up-down', 'caret-down', 'caret-right', 'arrow-left', 'arrow-right', 'arrow-up', 'arrow-down', 'arrow-up-right', 'arrow-down-right', 'arrow-up-down', 'swap', 'corner-up-left', 'external', 'home', 'menu', 'more', 'more-vertical', 'grip', 'sidebar-left', 'sidebar-right', 'panel-bottom', 'layout', 'window-min', 'window-max', 'window-restore', 'maximize', 'minimize', 'fullscreen', 'log-in', 'log-out'],
    'Actions': ['plus', 'minus', 'x', 'check', 'plus-circle', 'minus-circle', 'check-circle', 'x-circle', 'search', 'filter', 'sliders', 'settings', 'edit', 'rename', 'trash', 'copy', 'duplicate', 'clipboard', 'clipboard-check', 'paste', 'save', 'download', 'upload', 'import', 'export', 'share', 'link', 'unlink', 'refresh', 'reset', 'history', 'undo', 'redo', 'lock', 'unlock', 'eye', 'eye-off', 'pin', 'star', 'star-fill', 'bookmark', 'tag', 'folder', 'folder-open', 'folder-plus', 'file', 'file-text', 'file-plus', 'files', 'archive', 'inbox', 'send', 'zoom-in', 'zoom-out', 'crosshair', 'move', 'play', 'pause', 'stop', 'volume', 'volume-low', 'volume-off', 'bell', 'bell-off', 'keyboard', 'command', 'power', 'type', 'code', 'terminal', 'mouse', 'image', 'palette', 'wand', 'sparkle', 'sparkle-fill', 'sparkles', 'zap', 'flag', 'target', 'lightbulb', 'book', 'note', 'wrench'],
    'Status': ['info', 'warning', 'error', 'help', 'check-circle', 'shield-check', 'ban', 'clock', 'hourglass', 'loader', 'dot', 'circle-dot', 'wifi-off'],
    'Data and view': ['grid', 'list', 'list-ordered', 'rows', 'columns', 'table', 'chart-line', 'chart-bar', 'trend-up', 'trend-down', 'pie', 'layers', 'calendar', 'hash', 'percent', 'sigma', 'calculator', 'gauge', 'activity', 'compare', 'scale', 'diff'],
    'Account and sync': ['user', 'users', 'user-plus', 'cloud', 'cloud-check', 'cloud-up', 'cloud-down', 'cloud-off', 'monitor', 'hard-drive', 'globe', 'message', 'assistant', 'key', 'thumbs-up', 'thumbs-down', 'mail', 'crown', 'sun', 'moon', 'contrast'],
    'Passive tree and build': ['tree', 'node', 'notable', 'keystone', 'mastery', 'jewel-socket', 'ascendancy', 'path', 'node-add', 'level-up', 'pantheon', 'bandit', 'loadout'],
    'Skills': ['gem', 'gem-support', 'socket', 'links', 'aura', 'curse', 'minion', 'totem', 'trap', 'mine', 'projectile', 'melee', 'swords', 'bow', 'spell', 'speed', 'trigger'],
    'Items': ['weapon', 'axe', 'shield', 'helmet', 'body-armour', 'gloves', 'boots', 'amulet', 'ring', 'belt', 'flask', 'quiver', 'jewel', 'map', 'fragment', 'orb', 'coins', 'stash', 'anvil', 'scroll', 'corrupted', 'unique'],
    'Stats and damage': ['life', 'mana', 'energy-shield', 'ward', 'armour', 'evasion', 'block', 'suppress', 'ehp', 'resist', 'leech', 'regen', 'fire', 'cold', 'lightning', 'chaos', 'physical', 'crit', 'dps', 'speed', 'accuracy', 'area', 'duration', 'attr-str', 'attr-dex', 'attr-int'],
    'Loot filter': ['beam', 'minimap', 'volume', 'border', 'palette', 'type', 'strictness', 'list-ordered', 'eye', 'eye-off', 'gamepad', 'shape-circle', 'shape-square', 'shape-diamond', 'shape-triangle', 'shape-hexagon', 'shape-pentagon', 'shape-star'],
    'Wealth and trade': ['coins', 'wallet', 'stash', 'snapshot', 'chart-line', 'trend-up', 'trend-down', 'receipt', 'market', 'bag', 'trade', 'tag', 'trophy', 'timer', 'crown'],
  };

  // Label → icon, for lists whose labels come from data: <pom-icon auto="{{ item.label }}">. No match renders nothing.
  const WORDS = [
    [/^(my )?filters?$|^my filters/i, 'files'], [/^overview$/i, 'layout'], [/^customi[sz]e/i, 'sliders'], [/^simulate/i, 'chart-bar'], [/^themes?$/i, 'palette'], [/^advanced$/i, 'code'], [/^components$/i, 'layers'],
    [/^save as/i, 'file-plus'], [/^save/i, 'save'], [/^write( to game| now)?/i, 'gamepad'], [/^(delete|remove|discard)/i, 'trash'], [/^rename/i, 'rename'], [/^duplicate/i, 'duplicate'],
    [/^import/i, 'import'], [/^export/i, 'export'], [/^copy/i, 'copy'], [/^share/i, 'share'], [/^(version )?history/i, 'history'], [/^undo/i, 'undo'], [/^redo/i, 'redo'], [/^(reset|revert|restore)/i, 'reset'],
    [/^(open in|open on|view on)/i, 'external'], [/^(new|add|create|start a new)/i, 'plus'], [/^edit/i, 'edit'], [/^(preview|review|show)/i, 'eye'], [/^hide/i, 'eye-off'], [/^(apply|accept|keep)/i, 'check'],
    [/^(ask|assistant)/i, 'assistant'], [/^explain/i, 'help'], [/^(search|find)/i, 'search'], [/^(sort)/i, 'arrow-up-down'], [/^filter/i, 'filter'], [/^(settings|options|preferences)/i, 'settings'], [/^help/i, 'help'], [/^about/i, 'info'],
    [/^(sync|refresh|reload|retry|try again|update)/i, 'refresh'], [/^(sign in|log in)/i, 'log-in'], [/^(sign out|log out)/i, 'log-out'], [/^(download)/i, 'download'], [/^upload/i, 'upload'], [/^(paste)/i, 'paste'],
    [/^(sound|audio)/i, 'volume'], [/^(beam|light beam)/i, 'beam'], [/^(minimap|icon)/i, 'minimap'], [/^(colou?rs?|palette|style)/i, 'palette'], [/^(text|font)/i, 'type'], [/^border/i, 'border'], [/^(strictness)/i, 'strictness'], [/^(tiers?|retier)/i, 'list-ordered'], [/^rules?/i, 'code'],
    [/^(simple|guided)( mode)?$/i, 'sparkle'], [/^full( mode)?$/i, 'layout'], [/^inspector/i, 'sidebar-right'], [/^(inbox|adapt)/i, 'inbox'], [/^(diff|changes)/i, 'diff'],
    [/^tree$|passive tree/i, 'tree'], [/^skills?$/i, 'gem'], [/^items?$/i, 'body-armour'], [/^calcs?$/i, 'calculator'], [/^config(uration)?$/i, 'sliders'], [/^notes?$/i, 'note'], [/^party$/i, 'users'], [/^compare/i, 'compare'], [/^builds?$/i, 'tree'], [/^wealth$/i, 'coins'], [/^loot filter/i, 'filter'],
    [/^(currency|orbs?)$/i, 'orb'], [/^fragments?/i, 'fragment'], [/^maps?$/i, 'map'], [/^(gems?|skill gems?)$/i, 'gem'], [/^uniques?$/i, 'unique'], [/^(jewels?|cluster jewels?)$/i, 'jewel'], [/^flasks?$/i, 'flask'], [/^(weapons?)$/i, 'weapon'], [/^(armou?r|armour pieces)$/i, 'body-armour'], [/^(accessories|rings?|amulets?)$/i, 'ring'], [/^(stash|tabs?)$/i, 'stash'], [/^sessions?$/i, 'timer'], [/^strateg/i, 'map'], [/^market/i, 'market'], [/^(snapshots?)$/i, 'snapshot'],
    [/^(general)$/i, 'settings'], [/^(account)/i, 'user'], [/^(appearance|theme)/i, 'palette'], [/^(keyboard|shortcuts)/i, 'keyboard'], [/^(privacy|security)/i, 'lock'], [/^(notifications?)/i, 'bell'], [/^(language)/i, 'globe'], [/^(data|storage)/i, 'hard-drive'], [/^(cloud)/i, 'cloud'], [/^(local|this pc)/i, 'monitor'],
    [/^(light)$/i, 'sun'], [/^(dark)$/i, 'moon'], [/^(system)$/i, 'monitor'],
    [/^saving$/i, 'save'], [/^startup$/i, 'power'], [/^prices?$/i, 'tag'], [/^(display|interface|appearance)$/i, 'monitor'], [/^performance$/i, 'gauge'], [/^(updates?)$/i, 'cloud-down'], [/^(sync|syncing)$/i, 'refresh'], [/^(game|game folder)$/i, 'gamepad'], [/^(filters?|filter)$/i, 'filter'], [/^(sounds?)$/i, 'volume'], [/^(assistant|agents?|ai)$/i, 'assistant'], [/^(connections?|integrations?)$/i, 'link'], [/^(overview)$/i, 'layout'], [/^(all)$/i, 'grid'], [/^(rares?)$/i, 'ring'], [/^(essences?)$/i, 'orb'], [/^(divination|cards?)$/i, 'layers'], [/^(scarabs?)$/i, 'fragment'], [/^(dump \d+)$/i, 'inbox'],
  ];
  // Each label is matched against the word list once: running ~150 patterns for every icon drawn was a large part of building
  // the Loot Filter's screens.
  const FOR = new Map();
  const iconFor = (label) => { const key = String(label || ''); let r = FOR.get(key); if (r !== undefined) return r; const l = key.replace(/[…·✦›]/g, '').trim(); const m = l ? WORDS.find((w) => w[0].test(l)) : null; r = m ? m[1] : ''; if (FOR.size < 5000) FOR.set(key, r); return r; };
  window.POM_ICONS = I; window.POM_ICON_ALIAS = ALIAS; window.POM_ICON_CATS = CATS; window.pomIconFor = iconFor;
  window.pomIcon = (name, size = 16, sw) => { const b = I[ALIAS[name] || name]; if (!b) return ''; return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw || 2}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:block;flex:none">${b}</svg>`; };

  if (!document.getElementById('pom-icon-css')) { const s = document.createElement('style'); s.id = 'pom-icon-css'; s.textContent = 'pom-icon{display:inline-flex;flex:none;align-items:center;justify-content:center;line-height:0;vertical-align:-.2em}pom-icon[spin]{animation:pomspin 1s linear infinite}@keyframes pomspin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){pom-icon[spin]{animation-duration:3s}}'; document.head.appendChild(s); }

  const SVGS = new Map();
  let sprite = null;
  const SYMBOLS = new Set();
  function symbolFor(name, body) {
    const id = 'pom-i-' + name;
    if (!SYMBOLS.has(id) || !sprite || !sprite.isConnected) {
      if (!sprite || !sprite.isConnected) {
        sprite = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        sprite.setAttribute('aria-hidden', 'true');
        sprite.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
        document.body.appendChild(sprite);
        SYMBOLS.clear();
      }
      const t = document.createElement('template');
      t.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg"><symbol id="${id}" viewBox="0 0 24 24">${body}</symbol></svg>`;
      sprite.appendChild(t.content.firstElementChild.firstElementChild);
      SYMBOLS.add(id);
    }
    return id;
  }
  class PomIcon extends HTMLElement {
    static get observedAttributes() { return ['name', 'auto', 'size', 'stroke', 'label']; }
    connectedCallback() { this.render(); }
    attributeChangedCallback() { if (this.isConnected) this.render(); }
    render() {
      const n = this.getAttribute('name') || (this.hasAttribute('auto') ? iconFor(this.getAttribute('auto')) : ''); const s = +(this.getAttribute('size') || 16);
      if (!n) { if (this._svg && this._svg.parentNode === this) this.removeChild(this._svg); this._svg = null; this._k = ''; this.style.display = 'none'; return; }
      if (this.style.display === 'none') this.style.display = '';
      const sw = this.getAttribute('stroke') || (s <= 12 ? 2.4 : s >= 22 ? 1.75 : 2);
      const key = n + '|' + s + '|' + sw; if (this._k === key) return; this._k = key;
      const lbl = this.getAttribute('label');
      if (lbl) { this.setAttribute('role', 'img'); this.setAttribute('aria-label', lbl); } else this.setAttribute('aria-hidden', 'true');
      // Only ever touch our own <svg> node; React may own other children of this element.
      // Each name, size and stroke is parsed once and cloned after: parsing the markup for every icon was the largest single
      // cost of opening a build or a tab (hundreds of icons, 60 to 90 ms).
      let tpl = SVGS.get(key);
      if (!tpl) {
        const t = document.createElement('template');
        const body = I[ALIAS[n] || n];
        // A known icon draws its shapes once, as a symbol, and every copy is an <svg> holding one <use> of it: copying the
        // shapes into each icon was most of the cost of building a screen (about 14 µs an icon, thousands on Calcs). The
        // outer <svg> keeps its attributes, which the shapes inherit, so it draws the same.
        t.innerHTML = body ? window.pomIcon(n, s, sw).replace(body, `<use href="#${symbolFor(ALIAS[n] || n, body)}"></use>`) : `<svg width="${s}" height="${s}" viewBox="0 0 24 24" style="display:block"><rect x="4" y="4" width="16" height="16" rx="3" fill="none" stroke="currentColor" stroke-dasharray="3 3"></rect></svg>`;
        tpl = t.content.firstElementChild; tpl.setAttribute('data-pom', '');
        SVGS.set(key, tpl);
      }
      const svg = tpl.cloneNode(true);
      if (this._svg && this._svg.parentNode === this) this.replaceChild(svg, this._svg); else this.appendChild(svg);
      this._svg = svg;
    }
  }
  if (!customElements.get('pom-icon')) customElements.define('pom-icon', PomIcon);
})();
