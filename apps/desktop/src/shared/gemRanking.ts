/**
 * The Skills gem picker's DPS ranking. Every gem the picker can list for a group is scored by the engine (`gemPower`) in
 * one pass, and the list only changes order once a pass is finished: while the first pass runs the list is held, and
 * while a later pass runs (a gem was just added) the last finished order stays on screen until the new one is ready.
 */

/** The engine's percent change per gem id; null where the engine gives no figure (the gem cannot support the group). */
export type GemScores = Record<string, number | null>;

/** A finished pass: the figures and the build version they were measured on. */
export interface RankPass {
  version: number;
  scores: GemScores;
}

export interface PickerView<T> {
  /** The rows to draw, best first. */
  rows: T[];
  /** The first `ranked` rows have a figure; the rest go under a "No DPS change" divider. */
  ranked: number;
  /** Index of the first row of the "Other skills that raise DPS" section, or -1. */
  actives: number;
  /** Index of the first gem already in the group (they come last), or -1. */
  inGroup: number;
  /** No pass has finished for this group yet: the list waits for it instead of showing an order that will move. */
  held: boolean;
  /** Row 0 was lifted out of its DPS place because its name is exactly what was typed; it belongs to no DPS section. */
  pinned: boolean;
  /** The order is from an older version of the build; a new pass is running. */
  stale: boolean;
}

const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);

/** Gems with a figure first, highest first and ties by name; gems without one after them, by name. */
export function rankRows<T extends { id: string; name: string }>(rows: T[], scores: GemScores): { rows: T[]; ranked: number } {
  const has: T[] = [];
  const rest: T[] = [];
  for (const r of rows) (typeof scores[r.id] === 'number' ? has : rest).push(r);
  has.sort((a, b) => (scores[b.id] as number) - (scores[a.id] as number) || byName(a, b));
  rest.sort(byName);
  return { rows: [...has, ...rest], ranked: has.length };
}

/**
 * What the picker shows for the search results `rows`, given the group's last finished pass.
 * `sections` (adding to a group that has an active skill): ranked supports first, then actives that raise DPS as their own
 * ranked block, then the rest by name (a support at 0% included), each capped at `limit`. `inGroup`: gems already in the group, moved to the end in search order.
 */
export function pickerView<T extends { id: string; name: string; support?: boolean }>(
  rows: T[],
  o: {
    sort: boolean;
    pass: RankPass | undefined;
    version: number;
    limit: number;
    sections?: boolean;
    inGroup?: ReadonlySet<string>;
    /** The typed name: a gem named exactly this (any case) goes first, whatever the figures say. */
    exact?: string;
  },
): PickerView<T> {
  if (o.sort && !o.pass) return { rows: [], ranked: 0, actives: -1, inGroup: -1, held: true, pinned: false, stale: false };
  const mine = o.inGroup ? rows.filter((r) => o.inGroup!.has(r.id)) : [];
  const rest = mine.length ? rows.filter((r) => !o.inGroup!.has(r.id)) : rows;
  let body = rest;
  let ranked = 0;
  let actives = -1;
  let cap = o.limit;
  if (o.sort && o.pass) {
    const sc = o.pass.scores;
    if (o.sections) {
      // Each section is capped on its own, so the actives section is still there below a long block of supports.
      const fig = (r: T) => sc[r.id] ?? 0;
      const isSup = (r: T) => !!r.support && fig(r) !== 0;
      const isAct = (r: T) => !r.support && fig(r) > 0;
      const sup = rankRows(rest.filter(isSup), sc).rows.slice(0, o.limit);
      const act = rankRows(rest.filter(isAct), sc).rows.slice(0, o.limit);
      const tail = rest.filter((r) => !isSup(r) && !isAct(r)).sort(byName).slice(0, o.limit);
      body = [...sup, ...act, ...tail];
      ranked = sup.length + act.length;
      cap = body.length + mine.length;
      if (act.length) actives = sup.length;
    } else {
      ({ rows: body, ranked } = rankRows(rest, sc));
    }
  }
  let pinned = false;
  const ex = o.exact?.trim().toLowerCase();
  const at0 = ex ? body.findIndex((r) => r.name.toLowerCase() === ex) : -1;
  if (at0 > 0) {
    body = [body[at0]!, ...body.slice(0, at0), ...body.slice(at0 + 1)];
    // The moved row sits above the rows it jumped, so section starts after its old place shift down one place.
    // It is not counted into a section: the picker labels it as the exact match, so its own figure stays honest.
    if (at0 >= ranked && o.sort && o.pass) ranked++;
    if (actives >= 0 && at0 >= actives) actives++;
    pinned = true;
  }
  const all = [...body, ...mine].slice(0, cap);
  const at = (i: number) => (i >= 0 && i < all.length ? i : -1);
  return {
    rows: all,
    ranked: Math.min(ranked, all.length),
    actives: at(actives),
    inGroup: mine.length ? at(body.length) : -1,
    held: false,
    pinned,
    stale: !!o.pass && o.sort && o.pass.version !== o.version,
  };
}

/**
 * Scores `ids` into `out` in chunks, skipping ids already in it, so a pass stopped part way (the picker switched to
 * another gem's row) carries on from where it was. Returns true once every id has a score, false if `alive` turned false.
 * A chunk the engine fails on scores null.
 */
export async function scoreGems(ids: string[], ask: (chunk: string[]) => Promise<GemScores>, out: GemScores, alive: () => boolean, onProgress: (done: number) => void, chunk = 24): Promise<boolean> {
  const todo = ids.filter((id) => !(id in out));
  onProgress(ids.length - todo.length);
  for (let i = 0; i < todo.length; i += chunk) {
    if (!alive()) return false;
    const part = todo.slice(i, i + chunk);
    let r: GemScores = {};
    try {
      r = await ask(part);
    } catch {
      r = {};
    }
    // The figures are kept even when the pass was stopped meanwhile: they belong to the same build version.
    for (const id of part) out[id] = r[id] ?? null;
    if (!alive()) return false;
    onProgress(ids.length - todo.length + i + part.length);
  }
  return true;
}
