// What a left click on a node does, as upstream's PassiveTreeView does it: a click on an allocated node removes it
// (an allocated mastery included, its effect goes with it); a click on an unallocated mastery opens the effect chooser
// instead of allocating; the chooser for an allocated mastery opens from a right click.
export type NodeClickPlan = 'chooser' | 'toggle';

export function nodeClickPlan(n: { isMastery: boolean; hasEffects: boolean; alloc: boolean; chooser: boolean }): NodeClickPlan {
  if (n.isMastery && n.hasEffects && n.chooser && !n.alloc) return 'chooser';
  return 'toggle';
}

/** True once a held left button has moved far enough to pan instead of click: upstream's test, more than 5 pixels
 *  on either axis (PassiveTreeView:Draw, `math.abs(cursorX - self.dragX) > 5 or math.abs(cursorY - self.dragY) > 5`). */
export function isDrag(dx: number, dy: number): boolean {
  return Math.abs(dx) > 5 || Math.abs(dy) > 5;
}
