// Small rings at the edge of the free area for search matches that are out of view, pointing the way to them.
import { useEffect, useRef } from 'react';
import { searchHighlightHex, type PassiveTree } from './PassiveTree';

export function SearchEdge({ tree, on, search }: { tree: PassiveTree | null; on: boolean; search: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    let blank = false;
    const draw = () => {
      raf = 0;
      const host = tree?.host;
      const dpr = window.devicePixelRatio || 1;
      const W = host?.clientWidth ?? 0;
      const H = host?.clientHeight ?? 0;
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
        cv.width = Math.round(W * dpr);
        cv.height = Math.round(H * dpr);
        blank = true; // a resize clears it
      }
      const idle = !on || !tree || !search.trim();
      // No search and already blank: leave it. Clearing it on every tree paint re-sent a full-size layer each frame of a pan.
      if (idle && blank) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      blank = idle;
      if (idle) return;
      const ins = tree.opts.insets ?? { left: 0, top: 0, right: 0, bottom: 0 };
      const x0 = ins.left + 10;
      const y0 = ins.top + 10;
      const x1 = W - ins.right - 10;
      const y1 = H - ins.bottom - 10;
      const seen = new Set<string>();
      ctx.lineWidth = 2;
      const hex = searchHighlightHex(tree.host);
      const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ');
      ctx.strokeStyle = `rgba(${rgb}, .95)`;
      ctx.fillStyle = `rgba(${rgb}, .18)`;
      for (const [sx, sy] of tree.searchPoints()) {
        if (sx >= ins.left && sx <= W - ins.right && sy >= ins.top && sy <= H - ins.bottom) continue;
        const x = Math.min(x1, Math.max(x0, sx));
        const y = Math.min(y1, Math.max(y0, sy));
        const k = `${Math.round(x / 24)}:${Math.round(y / 24)}`;
        if (seen.has(k)) continue;
        seen.add(k);
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    };
    const queue = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };
    queue();
    const host = tree?.host;
    host?.addEventListener('treepaint', queue);
    return () => {
      host?.removeEventListener('treepaint', queue);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [tree, on, search]);
  return <canvas ref={ref} className="tt-edge" aria-hidden="true" />;
}
