/**
 * Upstream's item source text marks names inline (`unique{Eye of Chayula}`, `currency{Vaal Orb}`, ...) and
 * `ItemsTab:FormatItemSource` turns each into a colour change for the name and back to the source colour after it.
 * This does the same to a tooltip segment: the braces go, the name takes its colour.
 */

export interface MarkedSeg {
  t: string;
  /** A CSS colour; absent when the segment keeps the colour of the line. */
  colour?: string;
}

const MARKER_COLOUR: Record<string, string> = {
  unique: 'var(--rarity-unique)',
  normal: 'var(--rarity-normal)',
  currency: 'var(--currency, #AA9E82)',
  prophecy: 'var(--prophecy, #B54BFF)',
};

const DEFAULT_COLOURS: Record<string, string> = { source: 'var(--mod-source)', magic: 'var(--mod-explicit)' };

const MARKER = /(unique|normal|currency|prophecy)\{([^}]+)\}/g;

export function expandMarkers<C extends string>(segs: { c?: C | null; t: string }[], colourOf: (c: C | null | undefined) => string | undefined = (c) => (c ? DEFAULT_COLOURS[c] : undefined)): MarkedSeg[] {
  const out: MarkedSeg[] = [];
  const push = (t: string, colour: string | undefined) => {
    if (t === '') return;
    out.push(colour ? { t, colour } : { t });
  };
  for (const s of segs) {
    const base = colourOf(s.c);
    let last = 0;
    for (const m of s.t.matchAll(MARKER)) {
      push(s.t.slice(last, m.index), base);
      push(m[2]!, MARKER_COLOUR[m[1]!]);
      last = m.index! + m[0].length;
    }
    push(s.t.slice(last), base);
  }
  return out;
}
