/**
 * The "System" UI scale for a window of `width` x `height` physical pixels. The design is drawn for 1920 wide: up to
 * there the layout reflows at 1x; above it the UI grows in proportion to the window (2560 wide = 1.33x), limited by
 * the window's height (1000 px of design height) and capped at 2x. Rounded to 0.01.
 */
export function autoUiScale(width: number, height: number): number {
  const factor = Math.max(1, Math.min(width / 1920, height / 1000, 2));
  return Math.round(factor * 100) / 100;
}
