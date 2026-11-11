export type MergeConflict = { path: string[]; original: unknown; mine: unknown; theirs: unknown };
export type MergeResult<T> = { value: T; conflicts: MergeConflict[] };

const equal = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => equal(value, b[index]));
  if (record(a) && record(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
  }
  return false;
};
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Arrays are atomic; feature adapters merge ID-keyed records before resolving lane order. */
export function threeWayMerge<T>(original: T, mine: T, theirs: T): MergeResult<T> {
  const conflicts: MergeConflict[] = [];
  const merge = (base: unknown, local: unknown, remote: unknown, path: string[]): unknown => {
    if (equal(local, remote) || equal(remote, base)) return structuredClone(local);
    if (equal(local, base)) return structuredClone(remote);
    if (record(base) && record(local) && record(remote)) {
      const output: Record<string, unknown> = {};
      for (const key of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
        const result = merge(base[key], local[key], remote[key], [...path, key]);
        if (result !== undefined) Object.defineProperty(output, key, { value: result, enumerable: true, writable: true, configurable: true });
      }
      return output;
    }
    conflicts.push({ path, original: structuredClone(base), mine: structuredClone(local), theirs: structuredClone(remote) });
    return structuredClone(local);
  };
  return { value: merge(original, mine, theirs, []) as T, conflicts };
}
