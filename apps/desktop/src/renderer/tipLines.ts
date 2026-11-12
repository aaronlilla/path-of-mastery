// The default / Alt split of a hover tooltip's item lines (pure, so it can be tested without a window).
import type { TooltipLine } from '@pom/protocol';

/** Lines only the Alt view shows: the engine's "Tip" lines and the item's "Source: ..." line. */
export function isDetailLine(l: TooltipLine): boolean {
  return l.k === 'tip' || (l.segs.length > 0 && l.segs.every((s) => s.c === 'source'));
}

/** The lines to draw: all of them with `detail`, else without the detail-only ones and without the dividers they leave doubled or dangling. */
export function shownLines(lines: TooltipLine[], detail: boolean): TooltipLine[] {
  if (detail) return lines;
  const out: TooltipLine[] = [];
  for (const l of lines) {
    if (isDetailLine(l)) continue;
    if (l.k === 'sep' && out.length > 0 && out[out.length - 1]!.k === 'sep') continue;
    out.push(l);
  }
  while (out.length > 0 && out[out.length - 1]!.k === 'sep') out.pop();
  return out;
}
