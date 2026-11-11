// Glow rings over the nodes the assistant changed or points at (data-assistant-highlight = node id), kept on the nodes as the view moves.
import { useEffect, useRef } from 'react';
import { useHighlight } from '../assistant/bus';
import type { PassiveTree } from './PassiveTree';

export function AssistantRings({ tree }: { tree: PassiveTree | null }) {
  const h = useHighlight();
  const ids = h?.tab === 'tree' ? h.nodeIds ?? [] : [];
  const layer = useRef<HTMLDivElement>(null);
  const key = h?.key ?? 0;

  useEffect(() => {
    if (!tree || !ids.length) return;
    // Take the player to the nodes, centred in the free area between the panels (again shortly after, when the tab has only just become visible).
    const frame = () => {
      tree.frameNodes(ids);
      const ins = tree.opts.insets;
      if (!ins) return;
      const fw = tree.w - ins.left - ins.right;
      const fh = tree.h - ins.top - ins.bottom;
      if (fw > 0 && fh > 0) tree.view.s = Math.max(0.08, tree.view.s * Math.min(1, fw / tree.w, fh / tree.h));
      tree.view.x -= (ins.left - ins.right) / 2 / tree.view.s;
      tree.view.y -= (ins.top - ins.bottom) / 2 / tree.view.s;
      tree.requestDraw();
    };
    frame();
    const later = window.setTimeout(frame, 350);
    let raf = 0;
    const draw = () => {
      raf = 0;
      const rings = layer.current?.children;
      if (!rings) return;
      for (const el of rings) {
        const n = tree.nodeById(Number((el as HTMLElement).dataset.assistantHighlight));
        if (!n) continue;
        const [x, y] = tree.toScreen(n.x, n.y);
        const d = Math.round(tree.ringDiameter(n) / 2) * 2; // even, so the centre stays on a whole pixel
        const s = (el as HTMLElement).style;
        s.width = s.height = `${d}px`;
        s.transform = `translate(${Math.round(x - d / 2)}px, ${Math.round(y - d / 2)}px)`;
      }
    };
    const queue = () => { if (!raf) raf = requestAnimationFrame(draw); };
    queue();
    tree.host.addEventListener('treepaint', queue);
    return () => {
      window.clearTimeout(later);
      tree.host.removeEventListener('treepaint', queue);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [tree, key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!tree || !ids.length) return null;
  return (
    <div ref={layer} className="asst-rings" aria-hidden>
      {ids.map((id) => <i key={`${key}:${id}`} className="asst-ring" data-asst-ring="" data-assistant-highlight={id} />)}
    </div>
  );
}
