import { tr } from '../../../i18n';
/** A small line diff for comparing the file on disk with the filter the app would write. */

export interface DiffRow {
  kind: 'same' | 'add' | 'del' | 'gap';
  text: string;
  /** For 'gap': how many identical lines were folded. */
  folded?: number;
}

export interface DiffResult {
  rows: DiffRow[];
  added: number;
  removed: number;
  /** False when the two texts differ too much to diff line by line. */
  complete: boolean;
}

const normalise = (s: string): string[] => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

/** Myers O(ND) shortest edit script over lines, after trimming the common head and tail. Gives up past `maxD` edits. */
function myers(a: string[], b: string[], maxD: number): { op: 'same' | 'add' | 'del'; i: number }[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxD);
  const off = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!)) x = v[off + k + 1]!;
      else x = v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }
  if (found < 0) return null;
  // Walk back.
  const ops: { op: 'same' | 'add' | 'del'; i: number }[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const vv = trace[d]!;
    const k = x - y;
    let pk: number;
    if (k === -d || (k !== d && vv[off + k - 1]! < vv[off + k + 1]!)) pk = k + 1;
    else pk = k - 1;
    const px = vv[off + pk]!;
    const py = px - pk;
    while (x > px && y > py) {
      x--;
      y--;
      ops.push({ op: 'same', i: x });
    }
    if (x === px) {
      y--;
      ops.push({ op: 'add', i: y });
    } else {
      x--;
      ops.push({ op: 'del', i: x });
    }
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    ops.push({ op: 'same', i: x });
  }
  v = new Int32Array(0);
  return ops.reverse();
}

export function diffLines(oldText: string, newText: string, context = 3, maxRows = 600): DiffResult {
  const a = normalise(oldText);
  const b = normalise(newText);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);
  const ops = myers(am, bm, 1500);
  if (!ops) {
    return { rows: [{ kind: 'gap', text: tr('lootfilter_advanced_export_lineDiff.the_two_files_differ_too') }], added: bm.length, removed: am.length, complete: false };
  }
  const all: DiffRow[] = [];
  for (let i = 0; i < head; i++) all.push({ kind: 'same', text: a[i]! });
  for (const o of ops) all.push(o.op === 'same' ? { kind: 'same', text: am[o.i]! } : o.op === 'add' ? { kind: 'add', text: bm[o.i]! } : { kind: 'del', text: am[o.i]! });
  for (let i = a.length - tail; i < a.length; i++) all.push({ kind: 'same', text: a[i]! });
  let added = 0;
  let removed = 0;
  for (const r of all) {
    if (r.kind === 'add') added++;
    else if (r.kind === 'del') removed++;
  }
  // Fold long runs of unchanged lines.
  const keep = new Array<boolean>(all.length).fill(false);
  all.forEach((r, i) => {
    if (r.kind === 'same') return;
    for (let j = Math.max(0, i - context); j <= Math.min(all.length - 1, i + context); j++) keep[j] = true;
  });
  const rows: DiffRow[] = [];
  let run = 0;
  for (let i = 0; i < all.length; i++) {
    if (keep[i]) {
      if (run) rows.push({ kind: 'gap', text: tr('lootfilter_advanced_export_lineDiff.run_unchanged_lines', { run }), folded: run });
      run = 0;
      rows.push(all[i]!);
      if (rows.length >= maxRows) {
        rows.push({ kind: 'gap', text: tr('lootfilter_advanced_export_lineDiff.more_changes_not_shown') });
        return { rows, added, removed, complete: true };
      }
    } else run++;
  }
  if (run) rows.push({ kind: 'gap', text: tr('lootfilter_advanced_export_lineDiff.run_unchanged_lines', { run }), folded: run });
  return { rows, added, removed, complete: true };
}
