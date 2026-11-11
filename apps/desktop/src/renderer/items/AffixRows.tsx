import type { ItemInfo } from '@pom/protocol';
import { getAppSettings } from '../appSettings';
import { defaultAffixRange } from '../../shared/settingsEffects';

/** The roll a newly chosen affix starts at: Settings > Default item affix quality. */
const newRange = () => defaultAffixRange(getAppSettings());
import { useEffect, useMemo, useRef, useState } from 'react';
import { middleTier, rolledByRow, sliderPosition, sliderTier } from './affixMath';
import { cmd } from './engine';
import type { DialogCtx } from './modDialogs';
import { PickButton, RollSlider, type MenuEntry, type TipSpec } from './parts';
import { BASE_KEY, gainText, rankAll, type RankCandidate } from './rank';
import type { ItemsEnv } from './useItems';
import { tr } from '../i18n';

interface AffixMod {
  id: string;
  lines: string[];
  level: number;
}
interface AffixGroup {
  label: string;
  haveRange: boolean;
  mods: AffixMod[];
}
interface AffixRow {
  type: 'Prefix' | 'Suffix';
  index: number;
  selected: string | null;
  range: number | null;
  fractured?: boolean;
  groups: AffixGroup[];
}
export interface AffixPool {
  prefixLimit: number;
  suffixLimit: number;
  rows: AffixRow[];
}
interface Choice {
  id: string | null;
  range: number;
  fractured?: boolean;
}
type Choices = { prefix: Choice[]; suffix: Choice[] };

function toChoice(rows: AffixRow[]): Choices {
  const pick = (t: 'Prefix' | 'Suffix') => rows.filter((r) => r.type === t).map((r) => ({ id: r.selected, range: r.range ?? newRange(), ...(r.fractured ? { fractured: true } : {}) }));
  return { prefix: pick('Prefix'), suffix: pick('Suffix') };
}

/** The rows of `text`: what each prefix and suffix may be. */
export async function loadAffixPool(text: string): Promise<AffixPool> {
  return (await cmd('itemPool', { itemText: text, kind: 'affixes' })).pool as AffixPool;
}

/** Writes the choice into the item through the engine. */
async function write(text: string, choice: Choices): Promise<string> {
  return (await cmd('itemAffix', { itemText: text, choice })).text;
}

/**
 * The prefix and suffix rows of a crafted magic or rare item (`UpdateAffixControls`): each row picks a modifier group, the tier
 * and the roll within it come from one slider, and a row's list can be ordered by the gain in a stat.
 */
export function AffixRows({ env, ctx, text, pool, poolErr, sortable, stat, info, onApply, openMenu }: { env: ItemsEnv; ctx: DialogCtx; text: string; pool: AffixPool | null; poolErr: string | null; sortable: boolean; stat: string; info: ItemInfo; onApply: (t: string) => void; openMenu: (anchor: HTMLElement, entries: MenuEntry[], width?: number) => void }) {
  const [applyErr, setErr] = useState<string | null>(null);
  const err = applyErr ?? poolErr;
  const [drag, setDrag] = useState<{ row: number; v: number } | null>(null);
  const [sorting, setSorting] = useState<{ row: number; p: number } | null>(null);
  const cache = useRef(new Map<string, number>());
  const stamp = useRef('');
  const busy = useRef(0);

  // A new item text starts clean: the rows come with it from the editor, so a new item never shows the last one's rows.
  useEffect(() => setErr(null), [text]);

  const choice = useMemo(() => (pool ? toChoice(pool.rows) : { prefix: [], suffix: [] }), [pool]);
  const rowChoice = (row: AffixRow, c: Choice): Choices => {
    const next = { prefix: choice.prefix.map((x) => ({ ...x })), suffix: choice.suffix.map((x) => ({ ...x })) };
    (row.type === 'Prefix' ? next.prefix : next.suffix)[row.index] = { ...c, ...(row.fractured && c.id === row.selected ? { fractured: true } : {}) };
    return next;
  };

  if (err) return <span className="it-sub" style={{ color: 'var(--negative-text)' }}>{err}</span>;
  if (!pool) return null;
  const def = env.powerStats?.find((s) => s.stat === stat);
  // The closed row shows the affix as the item has it, rolled (the list shows the series with #).
  const rolled = new Map<number, string>();
  for (const t of ['Prefix', 'Suffix'] as const) {
    const rows = pool.rows.map((r, i) => ({ r, i })).filter((x) => x.r.type === t);
    const counts = rows.map(({ r }) => r.groups.flatMap((g) => g.mods).find((m) => m.id === r.selected)?.lines.length ?? 0);
    const texts = rolledByRow((info.mods ?? []).filter((m) => (t === 'Prefix' ? m.prefix : m.suffix)).map((m) => m.text), counts);
    rows.forEach(({ i }, k) => texts[k] && rolled.set(i, texts[k]!));
  }

  const apply = async (c: Choices) => {
    const id = ++busy.current;
    try {
      const t = await write(text, c);
      if (id === busy.current) onApply(t);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const tipFor = (row: AffixRow, g: AffixGroup): TipSpec => {
    const m = g.mods[middleTier(g.mods.length)]!;
    const head = g.mods.length > 1 ? tr('items_AffixRows.length_tiers_level_level_to', { count: g.mods.length, level: g.mods[0]!.level, level2: g.mods[g.mods.length - 1]!.level }) : tr('items_AffixRows.level_level', { level: m.level });
    const tip: TipSpec = { lines: [{ text: head, colour: 'var(--text-muted)' }, ...m.lines.map((t) => ({ text: t, colour: 'var(--text-strong)' }))] };
    if (ctx.editFor) {
      const edit = ctx.editFor;
      tip.compares = [{ header: tr('items_AffixRows.adding_this_mod_will_give'), load: async () => env.previewPair(edit(text), edit(await write(text, rowChoice(row, { id: m.id, range: newRange() })))) }];
    }
    return tip;
  };

  /** Opens a row's list; with a sort chosen, the groups are ranked first (each by its middle tier in the item's slot). */
  const openRow = async (el: HTMLElement, row: AffixRow, i: number) => {
    const g = row.groups.find((x) => x.mods.some((m) => m.id === row.selected));
    let groups = row.groups;
    let gains = new Map<string, string>();
    if (def && ctx.slot && sortable) {
      if (stamp.current !== env.xml + text) {
        cache.current.clear();
        stamp.current = env.xml + text;
      }
      setSorting({ row: i, p: 0 });
      try {
        const cands: RankCandidate[] = [{ key: BASE_KEY, text, slots: [ctx.slot], base: false }];
        for (const gr of row.groups) cands.push({ key: `${i}|${gr.label}`, text: await write(text, rowChoice(row, { id: gr.mods[middleTier(gr.mods.length)]!.id, range: newRange() })), slots: [ctx.slot] });
        const values = await rankAll(def.stat, def.negate, cands, env.rank, cache.current, (p) => setSorting({ row: i, p }), () => true);
        if (values) {
          const base = values.get(BASE_KEY) ?? 0;
          const val = (gr: AffixGroup) => values.get(`${i}|${gr.label}`) ?? -Infinity;
          groups = [...row.groups].sort((a, b) => val(b) - val(a));
          gains = new Map(row.groups.map((gr) => [gr.label, Number.isFinite(val(gr)) ? gainText(val(gr) - base) : '']));
        }
      } catch {
        /* the list opens in upstream's order */
      }
      setSorting(null);
    }
    openMenu(
      el,
      [
        { key: 'none', label: tr('items_AffixRows.none'), on: !row.selected, run: () => void apply(rowChoice(row, { id: null, range: newRange() })) },
        ...groups.map<MenuEntry>((gr) => ({
          key: gr.label,
          label: gr.label,
          sub: gr.mods.length > 1 ? tr('items_AffixRows.length_tiers', { count: gr.mods.length }) : tr('items_AffixRows.level_level', { level: gr.mods[0]!.level }),
          right: gains.get(gr.label) || undefined,
          on: gr === g,
          tip: tipFor(row, gr),
          run: () => void apply(rowChoice(row, { id: gr.mods[middleTier(gr.mods.length)]!.id, range: newRange() })),
        })),
      ],
      440,
    );
  };

  return (
    <>
      {pool.rows.map((row, i) => {
        const g = row.groups.find((x) => x.mods.some((m) => m.id === row.selected));
        const idx = g ? g.mods.findIndex((m) => m.id === row.selected) : -1;
        const count = g?.mods.length ?? 0;
        const v = drag && drag.row === i ? drag.v : g ? sliderPosition(Math.max(0, idx), count, row.range ?? 0.5) : 0;
        const tier = g && count > 1 ? `T${count - idx}` : '';
        return (
          <div key={`${row.type}${row.index}`} className="it-mod" data-r="modrow">
            <span className="k">{row.type}:{row.fractured && <span className="sub">{tr('items_AffixRows.fractured')}</span>}</span>
            <div className="box" style={{ padding: 0 }}>
              <button type="button" className="it-pick" data-pick={`aff:${i}`} aria-haspopup="listbox" disabled={sorting !== null} style={{ flex: 1, height: 30, border: 0, background: 'transparent', boxShadow: 'none' }} onClick={(e) => void openRow(e.currentTarget, row, i)}>
                <span className="v" style={{ color: g ? 'var(--mod-explicit)' : 'var(--text-faint)' }}>{sorting?.row === i ? tr('items_AffixRows.sorting_v1', { sorting: Math.floor(sorting.p * 100) }) : g ? rolled.get(i) ?? g.label : tr('items_AffixRows.none')}</span>
                {tier && <span className="tiny" style={{ color: 'var(--text-muted)' }}>{tier}</span>}
              </button>
            </div>
            {g && g.haveRange ? (
              <RollSlider
                value={v}
                title={`${count > 1 ? `${tr('h_c_It.tier_of', { tier: count - idx, count })} ` : ''}${tr('h_c_It.drag_tier_roll')}`}
                onChange={(x) => setDrag({ row: i, v: x })}
                onCommit={(x) => {
                  setDrag(null);
                  const t = sliderTier(x, count);
                  void apply(rowChoice(row, { id: g.mods[t.index]!.id, range: t.range }));
                }}
              />
            ) : (
              <span />
            )}
          </div>
        );
      })}
    </>
  );
}
