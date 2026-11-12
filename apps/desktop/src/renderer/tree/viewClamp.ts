// Keeps the tree on screen. Upstream clamps the view's offset so the tree can never be dragged out of reach
// (PassiveTreeView:Draw, "Clamp zoom offset"); this does the same by keeping the middle of the view inside the box that holds
// every node, so some of the tree is always in view at any zoom.

export interface View {
  x: number;
  y: number;
  s: number;
}

export interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** The view with its centre moved back inside `b` when it had left it. */
export function clampView(v: View, b: Bounds): View {
  const x = Math.min(b.maxX, Math.max(b.minX, v.x));
  const y = Math.min(b.maxY, Math.max(b.minY, v.y));
  return x === v.x && y === v.y ? v : { x, y, s: v.s };
}
