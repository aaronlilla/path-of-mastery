/** Seeded xorshift32 for reproducible property tests (no dependency). A failing case prints its seed and index. */
export function prng(seed: number) {
  let s = seed >>> 0 || 0x9e3779b9;
  const next = (): number => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
  return {
    next,
    int: (lo: number, hi: number): number => lo + Math.floor(next() * (hi - lo + 1)),
    bool: (p = 0.5): boolean => next() < p,
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!,
    hex: (n: number): string => Array.from({ length: n }, () => Math.floor(next() * 16).toString(16)).join(''),
  };
}
export type Rng = ReturnType<typeof prng>;
