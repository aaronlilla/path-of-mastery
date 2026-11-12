// Small rules of the Tree screen that are plain arithmetic and wording: which stage the build header is in for its width.

/** The build header's stage by its own width, as the design steps it: 0 and 1 are wide (Save As and the share link sit in the
 *  header), 2 moves them and the level mode into the More menu, 3 drops the second point counter and the Save label, 4 is the phone layout. */
export function headerStage(width: number): 0 | 1 | 2 | 3 | 4 {
  return width >= 1490 ? 0 : width >= 1345 ? 1 : width >= 1110 ? 2 : width >= 600 ? 3 : 4;
}

/**
 * Whether a build name is too long for the header's single line at this header width and goes on a row of its own below the
 * buttons, where it wraps. Short names (24 characters or fewer) keep the one-line header. 10.5 px a character is the
 * header's 22 px display font, 640 px is what the buttons, point counters and class button take.
 */
export function nameNeedsRow(name: string, headerWidth: number): boolean {
  return name.length > 24 && name.length * 10.5 > headerWidth - 640;
}

/** What a tree version change removed, counted the way the header counts points. */
export interface ConvertDrop {
  /** Passive points that were allocated and are not any more (ascendancy nodes and the free class start not included). */
  points: number;
  /** Ascendancy nodes that were allocated and are not any more. */
  ascendancy: number;
  /** Passive points allocated before the change. */
  pointsBefore: number;
}

/** The Tree Converted dialog's sentence about what the new tree dropped, and why. */
export function convertedSentence(display: string, d: ConvertDrop | null): string {
  if (!d) return '';
  if (d.points === 0 && d.ascendancy === 0) return 'No passives were removed.';
  const asc = d.ascendancy > 0 ? ` and ${d.ascendancy.toLocaleString('en-US')} ascendancy ${d.ascendancy === 1 ? 'node' : 'nodes'}` : '';
  const all = d.points > 0 && d.points === d.pointsBefore;
  if (all) return `All ${d.points.toLocaleString('en-US')} passive points${asc} were removed: none of those nodes exist in tree version ${display}.`;
  return `${d.points.toLocaleString('en-US')} of ${d.pointsBefore.toLocaleString('en-US')} passive points${asc} were removed because those nodes do not exist in tree version ${display}.`;
}
