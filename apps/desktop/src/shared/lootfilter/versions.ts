/** Natural order for tags like 8.20.1d: numbers compare as numbers, trailing letters as text. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): (number | string)[] => (v.match(/\d+|[A-Za-z]+/g) ?? []).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i];
    const q = y[i];
    if (p === undefined) return -1; // 8.20.1 < 8.20.1d
    if (q === undefined) return 1;
    if (typeof p === 'number' && typeof q === 'number') {
      if (p !== q) return p < q ? -1 : 1;
    } else if (String(p) !== String(q)) return String(p) < String(q) ? -1 : 1;
  }
  return 0;
}
