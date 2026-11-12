import type { BuildEdit, ItemInfo, ItemMod } from '@pom/protocol';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog, Icon } from '../ui';
import { Over, useLocalMenu } from './dialogs';
import { ItemTooltip } from './ItemTooltip';
import { addExplicitLines, addImplicit, addImplicitMod, enchantEntry, poolLines, replaceImplicits, setCorrupted, setCorruptedRange, setCrucible, setEnchantSlot, type PoolKind } from './itemText';
import { PickButton, type MenuEntry, type TipSpec } from './parts';
import { BASE_KEY, gainText, rankAll, type RankCandidate } from './rank';
import { cmd } from './engine';
import { compareLines } from './statCompare';
import type { ItemsEnv } from './useItems';
import { tr } from '../i18n';

/** Where the item under the dialog is or would be: modifiers are ranked and compared with the item there. */
export interface DialogCtx {
  slot?: string;
  /** The edit that puts the item text in that slot. */
  editFor?: (text: string) => BuildEdit;
}

/** The item as it would be after a change, drawn as its tooltip (upstream previews on the confirm button). */
function Preview({ env, text }: { env: ItemsEnv; text: string }) {
  const [info, setInfo] = useState<ItemInfo | null>(null);
  useEffect(() => {
    let dead = false;
    const t = window.setTimeout(() => {
      void env
        .info(text, {})
        .then((i) => !dead && setInfo(i))
        .catch(() => !dead && setInfo(null));
    }, 120);
    return () => {
      dead = true;
      window.clearTimeout(t);
    };
  }, [text, env]);
  if (!info?.valid) return null;
  return (
    <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 4 }}>
      <ItemTooltip info={info} style={{ maxWidth: 420, boxShadow: 'none' }} />
    </div>
  );
}

/** What a change to the item does to the build: the item with it against the item without, in the item's slot. */
function Changes({ env, ctx, from, to, header }: { env: ItemsEnv; ctx: DialogCtx; from: string; to: string; header: string }) {
  const [lines, setLines] = useState<ReturnType<typeof compareLines> | null>(null);
  useEffect(() => {
    setLines(null);
    if (!ctx.editFor || from === to) return;
    let dead = false;
    const t = window.setTimeout(() => {
      void env
        .previewPair(ctx.editFor!(from), ctx.editFor!(to))
        .then((d) => !dead && setLines(compareLines(d, env.skillKind)))
        .catch(() => !dead && setLines([]));
    }, 250);
    return () => {
      dead = true;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, env.xml]);
  if (!ctx.editFor || from === to) return null;
  return (
    <div className="it-cmp" style={{ margin: 0 }}>
      <span className="h">{header}</span>
      {lines === null ? <span style={{ color: 'var(--text-faint)' }}>{tr('items_modDialogs.calculating')}</span> : lines.length === 0 ? <span style={{ color: 'var(--text-faint)' }}>{tr('items_modDialogs.no_changes_to_the_build')}</span> : lines.map((l) => <span key={l.stat} className={'c ' + (l.good ? 'good' : 'bad')}>{l.text}</span>)}
    </div>
  );
}

/** The tooltip of a modifier in a picker: its lines, and what adding it does to the build. */
function modTip(env: ItemsEnv, ctx: DialogCtx, lines: string[], baseText: string, resultText: () => string, header = tr('items_modDialogs_2.adding_this_mod_will_give')): TipSpec {
  const spec: TipSpec = { lines: lines.map((t) => ({ text: t, colour: 'var(--text-strong)' })) };
  if (ctx.editFor) {
    const edit = ctx.editFor;
    spec.compares = [{ header, load: () => env.previewPair(edit(baseText), edit(resultText())) }];
  }
  return spec;
}

// ---- sorting a picker's list by a stat ---------------------------------------------------------------------------------------

/**
 * The picker's entries ordered by the gain in a chosen stat (`getSortValue`): each entry's item goes to the engine in the
 * item's slot, in batches. With no stat chosen the entries stay in upstream's order.
 */
function useStatSort<T>(env: ItemsEnv, ctx: DialogCtx, entries: T[], keyOf: (e: T) => string, textOf: (e: T) => string, baseText: string) {
  const [stat, setStat] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [rank, setRank] = useState<{ stat: string; value: Map<string, number> } | null>(null);
  const cache = useRef(new Map<string, number>());
  const stamp = useRef('');
  const def = env.powerStats?.find((s) => s.stat === stat);
  useEffect(() => {
    if (!def || !ctx.slot) {
      setRank(null);
      setProgress(null);
      return;
    }
    let alive = true;
    if (stamp.current !== env.xml + baseText) {
      cache.current.clear();
      stamp.current = env.xml + baseText;
    }
    setProgress(0);
    const slot = ctx.slot;
    const cands: RankCandidate[] = [{ key: BASE_KEY, text: baseText, slots: [slot] }, ...entries.map((e) => ({ key: keyOf(e), text: textOf(e), slots: [slot] }))];
    void rankAll(def.stat, def.negate, cands, env.rank, cache.current, (p) => alive && setProgress(p), () => alive)
      .then((values) => {
        if (!alive || !values) return;
        setRank({ stat: def.stat, value: values });
        setProgress(null);
      })
      .catch(() => {
        if (alive) {
          setRank(null);
          setProgress(null);
        }
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def?.stat, entries, ctx.slot, env.xml, baseText]);
  const ordered = useMemo(() => {
    if (!rank || rank.stat !== stat) return entries;
    const idx = new Map(entries.map((e, i) => [e, i]));
    return [...entries].sort((a, b) => {
      const va = rank.value.get(keyOf(a)) ?? -Infinity;
      const vb = rank.value.get(keyOf(b)) ?? -Infinity;
      if (va !== vb) return vb > va ? 1 : -1;
      return idx.get(a)! - idx.get(b)!;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, rank, stat]);
  const gain = (e: T): string | undefined => {
    if (!rank || rank.stat !== stat) return undefined;
    const base = rank.value.get(BASE_KEY);
    const v = rank.value.get(keyOf(e));
    return base === undefined || v === undefined || !Number.isFinite(v) ? undefined : gainText(v - base);
  };
  return { stat, setStat, progress, ordered, gain, enabled: Boolean(ctx.slot && env.powerStats) };
}

function SortRow({ env, sort, open }: { env: ItemsEnv; sort: { stat: string; setStat: (s: string) => void; progress: number | null }; open: ReturnType<typeof useLocalMenu>['open'] }) {
  const label = sort.stat ? env.powerStats?.find((s) => s.stat === sort.stat)?.label ?? sort.stat : tr('items_modDialogs_2.default');
  return (
    <div>
      <div className="lbl">{tr('items_modDialogs.sort_by')}{sort.progress !== null ? ` (${Math.floor(sort.progress * 100)}%)` : ''}</div>
      <PickButton
        dataKey="mod:sort"
        value={label}
        onOpen={(el) =>
          open(
            el,
            [{ key: '', label: tr('items_modDialogs.default'), on: !sort.stat, run: () => sort.setStat('') } as MenuEntry, ...(env.powerStats ?? []).map<MenuEntry>((s) => ({ key: s.stat, label: s.label, on: s.stat === sort.stat, run: () => sort.setStat(s.stat) }))],
            240,
          )
        }
      />
    </div>
  );
}

function usePool<T>(text: string, kind: 'mods' | 'corrupt' | 'enchant' | 'anoint' | 'crucible' | 'implicits') {
  const [pool, setPool] = useState<T | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let dead = false;
    void cmd('itemPool', { itemText: text, kind })
      .then((r) => !dead && setPool(r.pool as T))
      .catch((e: Error) => !dead && setErr(e.message));
    return () => {
      dead = true;
    };
    // The lists depend on the item's base and influences, which the dialog does not change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);
  return { pool, err };
}

const modLabel = (lines: string[]) => lines.join('/');

export interface PoolEntry {
  id: string;
  lines: string[];
  tags: string[];
  type: string | null;
  affix: string | null;
  group: string | null;
  level: number | null;
  kind: 'custom' | 'crafted' | 'implicit';
  source: string;
  essence?: string | null;
  title?: string;
}

// ---- Add Modifier to Item --------------------------------------------------------------------------------------

interface ModPool {
  sources: { id: string; label: string; mods: PoolEntry[] }[];
}

export function AddModDialog({ env, ctx, text, info, onClose, onApply }: { env: ItemsEnv; ctx: DialogCtx; text: string; info: ItemInfo | null; onClose: () => void; onApply: (text: string) => void }) {
  const { pool, err } = usePool<ModPool>(text, 'mods');
  const { open, node } = useLocalMenu(env);
  const [src, setSrc] = useState('');
  const [pick, setPick] = useState<string>('');
  const [custom, setCustom] = useState('');
  const sources = useMemo(() => [...(pool?.sources ?? []), { id: 'CUSTOM', label: tr('items_modDialogs.custom'), mods: [] as PoolEntry[] }], [pool]);
  const cur = sources.find((s) => s.id === src) ?? sources[0];
  const isCustom = cur?.id === 'CUSTOM';
  const mods = useMemo(() => (isCustom ? [] : cur?.mods ?? []), [cur, isCustom]);
  const resultFor = (m: PoolEntry): string => addExplicitLines(text, poolLines(m.tags, m.kind === 'crafted' ? 'crafted' : 'custom', m.lines));
  const sort = useStatSort(env, ctx, mods, (m) => `${m.source}:${m.id}`, resultFor, text);
  const entry = isCustom ? undefined : sort.ordered.find((m) => `${m.source}:${m.id}` === pick) ?? sort.ordered[0];
  const label = (m: PoolEntry): string => {
    if (m.source === 'ESSENCE') return `${m.essence ?? ''}   [${modLabel(m.lines)}] (${m.type})`;
    if (m.source === 'PREFIX' || m.source === 'SUFFIX') return `${m.affix ?? ''}   [${modLabel(m.lines)}]`;
    return `${modLabel(m.lines)}${m.type ? ` (${m.type})` : ''}`;
  };
  const result = isCustom ? (custom.trim() ? addExplicitLines(text, poolLines([], 'custom', [custom.trim()])) : text) : entry ? resultFor(entry) : text;
  return (
    <Over>
      <Dialog size="medium" title={tr('items_modDialogs.add_modifier_to_item')} subtitle={info?.name} confirmLabel={tr('items_modDialogs.add')} confirmIcon="plus" confirmDisabled={result === text} onCancel={onClose} onConfirm={() => onApply(result)}>
        <div className="it-dlg">
          {err && <span style={{ color: 'var(--negative-text)' }}>{err}</span>}
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ width: 200 }}>
              <div className="lbl">{tr('items_modDialogs.source')}</div>
              <PickButton dataKey="mod:src" value={cur?.label ?? '…'} disabled={sources.length < 2} onOpen={(el) => open(el, sources.map((s) => ({ key: s.id, label: s.label, on: s.id === cur?.id, run: () => { setSrc(s.id); setPick(''); } })), 200)} />
            </div>
            {!isCustom && sort.enabled && (
              <div style={{ width: 240 }}>
                <SortRow env={env} sort={sort} open={open} />
              </div>
            )}
          </div>
          {isCustom ? (
            <div>
              <div className="lbl">{tr('items_modDialogs.custom_modifier')}</div>
              <input className="it-input" style={{ width: '100%' }} autoFocus value={custom} onChange={(e) => setCustom(e.target.value)} placeholder={tr('items_modDialogs.n40_to_fire_resistance')} aria-label={tr('items_modDialogs.custom_modifier')} />
              <div className="it-sub" style={{ marginTop: 6, whiteSpace: 'normal' }}>{tr('items_modDialogs.type_the_modifier_as_the')}</div>
            </div>
          ) : (
            <div>
              <div className="lbl">{tr('items_modDialogs.modifier')}</div>
              <PickButton
                dataKey="mod:pick"
                value={sort.progress !== null ? tr('items_modDialogs_2.sorting', { progress: Math.floor(sort.progress * 100) }) : entry ? label(entry) : tr('items_modDialogs_2.none_available')}
                disabled={sort.progress !== null}
                onOpen={(el) =>
                  open(
                    el,
                    sort.ordered.map<MenuEntry>((m) => ({
                      key: `${m.source}:${m.id}`,
                      label: label(m),
                      sub: m.level ? tr('items_modDialogs.level_level', { level: m.level }) : undefined,
                      right: sort.gain(m),
                      on: m === entry,
                      tip: modTip(env, ctx, m.lines, text, () => resultFor(m)),
                      run: () => setPick(`${m.source}:${m.id}`),
                    })),
                    560,
                  )
                }
              />
            </div>
          )}
          <Changes env={env} ctx={ctx} from={text} to={result} header={tr('items_modDialogs_2.adding_this_mod_will_give')} />
          <Preview env={env} text={result} />
        </div>
      </Dialog>
      {node}
    </Over>
  );
}

// ---- Add Crucible Modifier to Item -------------------------------------------------------------------------------------

interface CruciblePool {
  nodes: Array<Array<{ id: string; lines: string[]; tier: number | null; type: string | null; tags: string[] }>>;
  selected: Array<string | null>;
}

export function CrucibleDialog({ env, ctx, text, info, mods, onClose, onApply }: { env: ItemsEnv; ctx: DialogCtx; text: string; info: ItemInfo | null; mods: ItemMod[]; onClose: () => void; onApply: (text: string) => void }) {
  const { pool, err } = usePool<CruciblePool>(text, 'crucible');
  const { open, node } = useLocalMenu(env);
  const [picks, setPicks] = useState<Array<string | null> | null>(null);
  const chosen = picks ?? pool?.selected ?? [null, null, null, null, null];
  const rawMods = mods.map((m) => ({ bucket: m.bucket, rawLine: m.rawLine }));
  const byId = useMemo(() => {
    const m = new Map<string, CruciblePool['nodes'][number][number]>();
    for (const n of pool?.nodes ?? []) for (const e of n) m.set(e.id, e);
    return m;
  }, [pool]);
  const build = (ids: Array<string | null>): string => {
    const seen = new Set<string>();
    const entries: string[] = [];
    for (const id of ids) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const e = byId.get(id);
      if (e) entries.push(...poolLines(e.tags, 'crucible', e.lines));
    }
    return setCrucible(text, rawMods, entries);
  };
  const result = build(chosen);
  const labelOf = (e: CruciblePool['nodes'][number][number]) => tr('items_modDialogs.lines_tier_tier', { lines: modLabel(e.lines), tier: e.tier ?? '' });
  return (
    <Over>
      <Dialog size="medium" title={tr('items_modDialogs.add_crucible_modifier_to_item')} subtitle={info?.name} confirmLabel={tr('items_modDialogs.add')} confirmIcon="plus" onCancel={onClose} onConfirm={() => onApply(result)}>
        <div className="it-dlg">
          {err && <span style={{ color: 'var(--negative-text)' }}>{err}</span>}
          {[0, 1, 2, 3, 4].map((i) => {
            const cur = chosen[i] ? byId.get(chosen[i]!) : undefined;
            return (
              <div key={i}>
                <div className="lbl">{tr('items_modDialogs.node_v2', { value: i + 1 })}</div>
                <PickButton
                  dataKey={`cru:${i}`}
                  value={cur ? labelOf(cur) : tr('items_modDialogs_2.none')}
                  onOpen={(el) =>
                    open(
                      el,
                      [
                        { key: 'none', label: tr('items_modDialogs.none'), on: !cur, run: () => setPicks(chosen.map((p, j) => (j === i ? null : p))) },
                        ...(pool?.nodes[i] ?? []).map<MenuEntry>((e) => ({
                          key: e.id,
                          label: labelOf(e),
                          on: e.id === chosen[i],
                          tip: modTip(env, ctx, e.lines, text, () => build(chosen.map((p, j) => (j === i ? e.id : p)))),
                          run: () => setPicks(chosen.map((p, j) => (j === i ? e.id : p))),
                        })),
                      ],
                      560,
                    )
                  }
                />
              </div>
            );
          })}
          <Changes env={env} ctx={ctx} from={text} to={result} header="Adding these mods will give:" />
          <Preview env={env} text={result} />
        </div>
      </Dialog>
      {node}
    </Over>
  );
}

// ---- Add Implicit ------------------------------------------------------------------------------------------------------------

interface ImplicitPool {
  sources: Array<{ id: string; label: string; groups: Array<{ label: string; mods: PoolEntry[] }> }>;
}

export function ImplicitPickDialog({ env, ctx, text, info, mods, onClose, onApply }: { env: ItemsEnv; ctx: DialogCtx; text: string; info: ItemInfo | null; mods: ItemMod[]; onClose: () => void; onApply: (text: string) => void }) {
  const { pool, err } = usePool<ImplicitPool>(text, 'implicits');
  const { open, node } = useLocalMenu(env);
  const [src, setSrc] = useState('');
  const [groupKey, setGroupKey] = useState('');
  const [pick, setPick] = useState('');
  const [custom, setCustom] = useState('');
  const sources = useMemo(() => [...(pool?.sources ?? []).map((s) => ({ id: s.id, label: s.label, groups: s.groups })), { id: 'CUSTOM', label: tr('items_modDialogs.custom'), groups: [] as ImplicitPool['sources'][number]['groups'] }], [pool]);
  const cur = sources.find((s) => s.id === src) ?? sources[0]!;
  const isCustom = cur.id === 'CUSTOM';
  const rawMods = mods.map((m) => ({ bucket: m.bucket, rawLine: m.rawLine }));
  const kindOf = (id: string): 'exarch' | 'eater' | 'vestigial' => (id === 'EXARCH' ? 'exarch' : id === 'EATER' ? 'eater' : 'vestigial');
  const resultFor = (m: PoolEntry): string => addImplicitMod(text, rawMods, kindOf(cur.id), poolLines(m.tags, kindOf(cur.id) as PoolKind, m.lines));
  // The groups ranked by their best modifier when sorting; the modifiers of the open group by their own gain.
  const allMods = useMemo(() => cur.groups.flatMap((g) => g.mods), [cur]);
  const sort = useStatSort(env, ctx, allMods, (m) => `${m.source}:${m.id}`, resultFor, text);
  const gainOf = new Map(allMods.map((m) => [`${m.source}:${m.id}`, sort.gain(m)]));
  const groups = useMemo(() => {
    if (!sort.stat) return cur.groups;
    const order = new Map(sort.ordered.map((m, i) => [`${m.source}:${m.id}`, i]));
    const rank = (g: (typeof cur.groups)[number]) => Math.min(...g.mods.map((m) => order.get(`${m.source}:${m.id}`) ?? Infinity));
    return [...cur.groups].sort((a, b) => rank(a) - rank(b)).map((g) => ({ ...g, mods: [...g.mods].sort((a, b) => (order.get(`${a.source}:${a.id}`) ?? 0) - (order.get(`${b.source}:${b.id}`) ?? 0)) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur, sort.ordered, sort.stat]);
  const group = groups.find((g) => g.label === groupKey) ?? groups[0];
  const vest = cur.id === 'VESTIGIAL';
  const entry = isCustom ? undefined : vest ? group?.mods[0] : group?.mods.find((m) => `${m.source}:${m.id}` === pick) ?? group?.mods[0];
  const result = isCustom ? (custom.trim() ? addImplicit(text, custom.trim(), 'custom') : text) : entry ? resultFor(entry) : text;
  return (
    <Over>
      <Dialog size="medium" title={tr('items_modDialogs.add_implicit_to_item')} subtitle={info?.name} confirmLabel={tr('items_modDialogs.add')} confirmIcon="plus" confirmDisabled={result === text} onCancel={onClose} onConfirm={() => onApply(result)}>
        <div className="it-dlg">
          {err && <span style={{ color: 'var(--negative-text)' }}>{err}</span>}
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ width: 200 }}>
              <div className="lbl">{tr('items_modDialogs.source')}</div>
              <PickButton dataKey="imp:src" value={cur.label} disabled={sources.length < 2} onOpen={(el) => open(el, sources.map((s) => ({ key: s.id, label: s.label, on: s.id === cur.id, run: () => { setSrc(s.id); setGroupKey(''); setPick(''); } })), 200)} />
            </div>
            {!isCustom && sort.enabled && (
              <div style={{ width: 240 }}>
                <SortRow env={env} sort={sort} open={open} />
              </div>
            )}
          </div>
          {isCustom ? (
            <div>
              <div className="lbl">{tr('items_modDialogs.custom_implicit')}</div>
              <input className="it-input" style={{ width: '100%' }} autoFocus value={custom} onChange={(e) => setCustom(e.target.value)} placeholder={tr('items_modDialogs.n1_to_level_of_socketed')} aria-label={tr('items_modDialogs.custom_implicit')} />
              <div className="it-sub" style={{ marginTop: 6, whiteSpace: 'normal' }}>{tr('items_modDialogs.type_the_modifier_as_the_2')}</div>
            </div>
          ) : (
            <>
              <div>
                <div className="lbl">{vest ? tr('items_modDialogs.modifier') : tr('items_modDialogs.type')}</div>
                <PickButton
                  dataKey="imp:group"
                  value={sort.progress !== null ? tr('items_modDialogs_2.sorting', { progress: Math.floor(sort.progress * 100) }) : group?.label ?? tr('items_modDialogs_2.none_available')}
                  disabled={sort.progress !== null}
                  onOpen={(el) =>
                    open(
                      el,
                      groups.map<MenuEntry>((g) => ({
                        key: g.label,
                        label: g.label,
                        on: g === group,
                        tip: g.mods[0] ? modTip(env, ctx, g.mods[0].lines.concat(g.mods[0].title ? [tr('items_modDialogs_2.source', { title: g.mods[0].title })] : []), text, () => resultFor(g.mods[0]!), tr('items_modDialogs.adding_this_implicit_will_give')) : undefined,
                        run: () => { setGroupKey(g.label); setPick(''); },
                      })),
                      560,
                    )
                  }
                />
              </div>
              {!vest && (
                <div>
                  <div className="lbl">{tr('items_modDialogs.modifier')}</div>
                  <PickButton
                    dataKey="imp:pick"
                    value={entry ? modLabel(entry.lines) : tr('items_modDialogs_2.none_available')}
                    onOpen={(el) =>
                      open(
                        el,
                        (group?.mods ?? []).map<MenuEntry>((m) => ({
                          key: `${m.source}:${m.id}`,
                          label: modLabel(m.lines),
                          right: gainOf.get(`${m.source}:${m.id}`),
                          on: m === entry,
                          tip: modTip(env, ctx, m.lines, text, () => resultFor(m), tr('items_modDialogs.adding_this_implicit_will_give')),
                          run: () => setPick(`${m.source}:${m.id}`),
                        })),
                        560,
                      )
                    }
                  />
                </div>
              )}
            </>
          )}
          <Changes env={env} ctx={ctx} from={text} to={result} header="Adding this implicit will give:" />
          <Preview env={env} text={result} />
        </div>
      </Dialog>
      {node}
    </Over>
  );
}

// ---- Enchant -----------------------------------------------------------------------------------------------------

interface EnchantPool {
  table: Record<string, unknown> | null;
  sources: { label: string; name: string }[];
}

export function EnchantDialog({ env, ctx, text, info, mods, slot, onClose, onApply }: { env: ItemsEnv; ctx: DialogCtx; text: string; info: ItemInfo | null; mods: ItemMod[]; slot: number; onClose: () => void; onApply: (text: string) => void }) {
  const { pool, err } = usePool<EnchantPool>(text, 'enchant');
  const { open, node } = useLocalMenu(env);
  const [skill, setSkill] = useState('');
  const [source, setSource] = useState('');
  const [pick, setPick] = useState('');
  const table = pool?.table ?? {};
  const sourceNames = new Set((pool?.sources ?? []).map((s) => s.name));
  const haveSkills = Object.keys(table).length > 0 && !Object.keys(table).some((k) => sourceNames.has(k));
  // The skills the build uses (its gems), unless the box asks for all of them; with none in use the box is on and locked.
  const [allSkills, setAllSkills] = useState(false);
  const used = useMemo(() => new Set([...env.xml.matchAll(/<Gem\b[^>]*\bnameSpec="([^"]+)"/g)].map((m) => m[1]!)), [env.xml]);
  const usedKeys = haveSkills ? Object.keys(table).filter((k) => used.has(k)) : [];
  const forceAll = haveSkills && usedKeys.length === 0;
  const skills = haveSkills ? (allSkills || forceAll ? Object.keys(table) : usedKeys).sort() : [];
  const curSkill = skills.includes(skill) ? skill : skills[0] ?? '';
  const bySource = (haveSkills ? (table[curSkill] as Record<string, string[]>) : (table as unknown as Record<string, string[]>)) ?? {};
  const srcList = (pool?.sources ?? []).filter((s) => Array.isArray(bySource[s.name]));
  const curSrc = srcList.find((s) => s.name === source) ?? srcList[0];
  const list: string[] = useMemo(() => (curSrc ? (bySource[curSrc.name] as string[]) : []), [curSrc, bySource]);
  const rawMods = mods.map((m) => ({ bucket: m.bucket, rawLine: m.rawLine }));
  const entries = (l: string) => {
    const m = /^([^/]+)\/([^/]+)$/.exec(l);
    return m ? [enchantEntry(m[1]!), enchantEntry(m[2]!)] : [enchantEntry(l)];
  };
  const resultFor = (l: string) => setEnchantSlot(text, rawMods, slot, entries(l));
  const sort = useStatSort(env, ctx, list, (l) => l, resultFor, text);
  const line = sort.ordered.find((l) => l === pick) ?? sort.ordered[0];
  const result = line ? resultFor(line) : text;
  const removed = setEnchantSlot(text, rawMods, slot, null);
  const hasHere = mods.filter((m) => m.bucket === 'enchant' && m.rawLine !== null).length >= slot;
  return (
    <Over>
      <Dialog size="medium" title={tr('items_modDialogs.enchant_item')} subtitle={`${info?.name ?? ''}${slot > 1 ? ` · ${tr('h_c_It.enchantment_n', { n: slot })}` : ''}`} confirmLabel={tr('items_modDialogs.enchant')} confirmIcon="check" confirmDisabled={!line} altLabel={hasHere ? tr('items_modDialogs.remove') : undefined} altIcon="trash" onAlt={() => onApply(removed)} onCancel={onClose} onConfirm={() => onApply(result)}>
        <div className="it-dlg">
          {err && <span style={{ color: 'var(--negative-text)' }}>{err}</span>}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            {haveSkills && (
              <div style={{ width: 220 }}>
                <div className="lbl">{tr('items_modDialogs.skill')}</div>
                <PickButton dataKey="ench:skill" value={curSkill} onOpen={(el) => open(el, skills.map((s) => ({ key: s, label: s, on: s === curSkill, run: () => { setSkill(s); setPick(''); } })), 220)} />
              </div>
            )}
            {haveSkills && (
              <label title={tr('items_modDialogs.show_all_skills_not_just')} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, height: 32, color: 'var(--text-2)', cursor: forceAll ? 'default' : 'pointer' }}>
                <input type="checkbox" checked={allSkills || forceAll} disabled={forceAll} onChange={(e) => setAllSkills(e.target.checked)} aria-label={tr('items_modDialogs.all_skills')} />
                {tr('items_modDialogs.all_skills')}
              </label>
            )}
            <div style={{ width: 220 }}>
              <div className="lbl">{tr('items_modDialogs.source')}</div>
              <PickButton dataKey="ench:src" value={curSrc?.label ?? '…'} onOpen={(el) => open(el, srcList.map((s) => ({ key: s.name, label: s.label, on: s.name === curSrc?.name, run: () => { setSource(s.name); setPick(''); } })), 220)} />
            </div>
            {sort.enabled && (
              <div style={{ width: 240 }}>
                <SortRow env={env} sort={sort} open={open} />
              </div>
            )}
          </div>
          <div>
            <div className="lbl">{tr('items_modDialogs.enchantment')}</div>
            <PickButton
              dataKey="ench:pick"
              value={sort.progress !== null ? tr('items_modDialogs_2.sorting', { progress: Math.floor(sort.progress * 100) }) : line ?? tr('items_modDialogs_2.none_available')}
              disabled={sort.progress !== null}
              onOpen={(el) =>
                open(
                  el,
                  sort.ordered.map<MenuEntry>((l) => ({ key: l, label: l, right: sort.gain(l), on: l === line, tip: modTip(env, ctx, l.split('/'), text, () => resultFor(l), tr('items_modDialogs.enchanting_will_give')), run: () => setPick(l) })),
                  560,
                )
              }
            />
          </div>
          <Changes env={env} ctx={ctx} from={text} to={result} header="Enchanting will give:" />
          <Preview env={env} text={result} />
        </div>
      </Dialog>
      {node}
    </Over>
  );
}

// ---- Anoint -------------------------------------------------------------------------------------------------------

interface AnointPool {
  nodes: { id?: number; name: string; stats: string[]; oils: string[] }[];
}

export function AnointDialog({ env, ctx, text, info, mods, slot, onClose, onApply }: { env: ItemsEnv; ctx: DialogCtx; text: string; info: ItemInfo | null; mods: ItemMod[]; slot: number; onClose: () => void; onApply: (text: string) => void }) {
  const { pool, err } = usePool<AnointPool>(text, 'anoint');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (pool?.nodes ?? []).filter((n) => !words.length || words.every((w) => `${n.name} ${n.stats.join(' ')}`.toLowerCase().includes(w)));
  const rawMods = mods.map((m) => ({ bucket: m.bucket, rawLine: m.rawLine }));
  const anoints = mods.filter((m) => /^Allocates /.test(m.text)).map((m) => m.text.replace(/^Allocates /, ''));
  const current = anoints[slot - 1];
  const result = sel ? setEnchantSlot(text, rawMods, slot, [enchantEntry(tr('items_modDialogs.allocates_sel', { sel }))]) : text;
  const removed = setEnchantSlot(text, rawMods, slot, null);
  const node = sel ? pool?.nodes.find((n) => n.name === sel) : undefined;
  const allocated = node?.id !== undefined && (env.tree?.allocated ?? []).includes(node.id);
  const already = Boolean(sel) && anoints.includes(sel!);
  const target = sel ? result : removed;
  return (
    <Over>
      <Dialog
        size="small"
        title={tr('items_modDialogs.anoint_item')}
        subtitle={`${info?.name ?? ''}${slot > 1 ? ` · ${tr('h_c_It.anoint_n', { n: slot })}` : ''}`}
        confirmLabel={sel ? tr('items_modDialogs.anoint_sel', { sel }) : current ? tr('items_modDialogs.remove_current', { current }) : tr('items_modDialogs.no_anoint')}
        confirmDisabled={!sel && !current}
        onCancel={onClose}
        onConfirm={() => onApply(sel ? result : removed)}
      >
        <div className="it-dlg">
          {err && <span style={{ color: 'var(--negative-text)' }}>{err}</span>}
          <div className="it-search">
            <Icon name="search" size={15} />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('items_modDialogs.search_notables')} aria-label={tr('items_modDialogs.search_notables')} />
          </div>
          <div className="it-box" style={{ height: 300 }} role="listbox" aria-label={tr('items_modDialogs.notables')}>
            {shown.slice(0, 300).map((n) => (
              <div key={n.name} role="option" aria-selected={sel === n.name} className="it-li" style={{ height: 'auto', minHeight: 34, padding: '5px 10px', alignItems: 'flex-start', flexDirection: 'column', gap: 2 }} onClick={() => setSel(sel === n.name ? null : n.name)}>
                <span style={{ color: 'var(--mod-explicit)', fontWeight: 500 }}>{n.name}</span>
                <span className="it-sub" style={{ fontSize: 11.5, whiteSpace: 'normal' }}>{n.stats.join(' · ')}</span>
              </div>
            ))}
            {shown.length === 0 && <div className="it-empty"><span className="s">{tr('items_modDialogs.no_notables_match')}</span></div>}
          </div>
          {sel && allocated && <span className="it-sub" style={{ whiteSpace: 'normal' }}>{tr('items_modDialogs.anointing_sel_changes_nothing_becaus', { sel })}</span>}
          {sel && !allocated && already && <span className="it-sub" style={{ whiteSpace: 'normal' }}>{tr('items_modDialogs.anointing_sel_changes_nothing_becaus_2', { sel })}</span>}
          {(!sel || (!allocated && !already)) && <Changes env={env} ctx={ctx} from={text} to={target} header={sel ? tr('items_modDialogs.anointing_sel_will_give_you', { sel }) : tr('items_modDialogs.removing_the_anoint_will_give')} />}
          {sel && <Preview env={env} text={result} />}
        </div>
      </Dialog>
    </Over>
  );
}

// ---- Corrupt ----------------------------------------------------------------------------------------------------------

interface CorruptPool {
  lists: Record<string, PoolEntry[]>;
  glimpse: boolean;
}

export function CorruptDialog({ env, ctx, text, info, mods, onClose, onApply }: { env: ItemsEnv; ctx: DialogCtx; text: string; info: ItemInfo | null; mods: ItemMod[]; onClose: () => void; onApply: (text: string) => void }) {
  const { pool, err } = usePool<CorruptPool>(text, 'corrupt');
  const { open, node } = useLocalMenu(env);
  const unique = info?.rarity === 'UNIQUE' || info?.rarity === 'RELIC';
  const srcWord = (s: string) => (s === 'Corrupted' ? tr('items_EditorPanel.corrupted') : s);
  const sourceList = [...(pool?.glimpse ? ['Glimpse of Chaos'] : []), 'Corrupted', 'Scourge'];
  const [source, setSource] = useState('');
  const [tab, setTab] = useState<'implicits' | 'rolls'>('implicits');
  const [picks, setPicks] = useState<Array<PoolEntry | null>>([null, null, null, null, null]);
  const [ranges, setRanges] = useState<Record<number, number>>({});
  const cur = sourceList.includes(source) ? source : sourceList[0]!;
  const scourge = cur === 'Scourge';
  const count = scourge ? (unique ? 4 : 3) : 2;
  const rawMods = mods.map((m) => ({ bucket: m.bucket, rawLine: m.rawLine }));
  const kind = scourge ? 'scourge' : 'implicit';
  // Every modifier the source offers, ranked as the only implicit the item gains.
  const pooled = useMemo(() => (!pool ? [] : scourge ? [...(pool.lists['ScourgeUpside'] ?? []), ...(pool.lists['ScourgeDownside'] ?? [])] : pool.lists[cur] ?? []), [pool, scourge, cur]);
  const resultOnly = (m: PoolEntry) => setCorrupted(replaceImplicits(text, rawMods, kind, poolLines(m.tags, scourge ? 'scourge' : 'implicit', m.lines)), true);
  const sort = useStatSort(env, ctx, pooled, (m) => `${m.source}:${m.id}`, resultOnly, text);
  const listFor = (i: number): PoolEntry[] => {
    if (!pool) return [];
    const base = scourge ? pool.lists[i < 2 ? 'ScourgeUpside' : 'ScourgeDownside'] ?? [] : pool.lists[cur] ?? [];
    const other = scourge ? picks[i < 2 ? 1 - i : 5 - i] : null;
    const chosen = new Set(picks.slice(0, count).filter((p, j) => p && j !== i).map((p) => p!.group));
    const allowed = base.filter((m) => (scourge ? !other || m.group !== other.group : !chosen.has(m.group)));
    if (!sort.stat) return allowed;
    const idx = new Map(sort.ordered.map((m, k) => [`${m.source}:${m.id}`, k]));
    return [...allowed].sort((a, b) => (idx.get(`${a.source}:${a.id}`) ?? 0) - (idx.get(`${b.source}:${b.id}`) ?? 0));
  };
  const chosen = picks.slice(0, count).filter((p): p is PoolEntry => Boolean(p));
  const entries = chosen.flatMap((m) => poolLines(m.tags, scourge ? 'scourge' : 'implicit', m.lines));
  const scalable = mods.filter((m) => m.scalable && m.rawLine !== null && m.bucket === 'explicit');
  let result = text;
  if (chosen.length) result = replaceImplicits(result, rawMods, scourge ? 'scourge' : 'implicit', entries);
  for (const m of scalable) if (ranges[m.rawLine!] !== undefined) result = setCorruptedRange(result, m.rawLine!, ranges[m.rawLine!]!);
  result = setCorrupted(result, true);
  return (
    <Over>
      <Dialog size="medium" title={tr('items_modDialogs.corrupt_item')} subtitle={info?.name} confirmLabel={tr('items_modDialogs.corrupt')} confirmIcon="corrupted" altLabel={info?.corrupted ? tr('items_modDialogs.uncorrupt') : undefined} altIcon="undo" onAlt={() => onApply(setCorrupted(text, false))} onCancel={onClose} onConfirm={() => onApply(result)}>
        <div className="it-dlg">
          {err && <span style={{ color: 'var(--negative-text)' }}>{err}</span>}
          {unique && (
            <div className="it-seg tall" role="tablist" style={{ alignSelf: 'flex-start' }}>
              {(['implicits', 'rolls'] as const).map((t) => (
                <button key={t} type="button" role="tab" aria-checked={tab === t} aria-selected={tab === t} onClick={() => setTab(t)} style={tab === t ? { background: 'linear-gradient(180deg, var(--surface-5), var(--surface-4))', color: 'var(--text-strong)' } : undefined}>
                  {t === 'implicits' ? tr('items_modDialogs.implicits') : tr('items_modDialogs.roll_ranges')}
                </button>
              ))}
            </div>
          )}
          {info?.implicitsLocked && tab === 'implicits' ? (
            <span className="it-sub">{tr('items_modDialogs.this_items_implicits_cannot_be')}</span>
          ) : tab === 'implicits' || !unique ? (
            <>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div style={{ width: 220 }}>
                  <div className="lbl">{tr('items_modDialogs.source')}</div>
                  <PickButton dataKey="cor:src" value={srcWord(cur)} disabled={sourceList.length < 2} onOpen={(el) => open(el, sourceList.map((s) => ({ key: s, label: srcWord(s), on: s === cur, run: () => { setSource(s); setPicks([null, null, null, null, null]); } })), 220)} />
                </div>
                {sort.enabled && (
                  <div style={{ width: 240 }}>
                    <SortRow env={env} sort={sort} open={open} />
                  </div>
                )}
              </div>
              {Array.from({ length: count }, (_, i) => (
                <div key={i}>
                  <div className="lbl">{tr('items_modDialogs.implicit_v2', { value: i + 1 })}</div>
                  <PickButton
                    dataKey={`cor:imp${i}`}
                    value={sort.progress !== null ? tr('items_modDialogs_2.sorting', { progress: Math.floor(sort.progress * 100) }) : picks[i] ? modLabel(picks[i]!.lines) : tr('items_modDialogs_2.none')}
                    disabled={sort.progress !== null}
                    onOpen={(el) =>
                      open(
                        el,
                        [
                          { key: 'none', label: tr('items_modDialogs.none'), on: !picks[i], run: () => setPicks(picks.map((p, j) => (j === i ? null : p))) },
                          ...listFor(i).map<MenuEntry>((m, k) => ({
                            key: `${m.id}:${k}`,
                            label: modLabel(m.lines),
                            right: sort.gain(m),
                            on: picks[i]?.id === m.id,
                            tip: modTip(env, ctx, m.lines, setCorrupted(text, true), () => resultOnly(m), tr('items_modDialogs.corrupting_will_give')),
                            run: () => setPicks(picks.map((p, j) => (j === i ? m : p))),
                          })),
                        ],
                        480,
                      )
                    }
                  />
                </div>
              ))}
              {(pool?.lists[cur === 'Scourge' ? 'ScourgeUpside' : cur] ?? []).length === 0 && pool && <span className="it-sub">{tr('items_modDialogs.this_item_has_no_cur', { cur })}</span>}
            </>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {scalable.length === 0 && <span className="it-sub">{tr('items_modDialogs.this_item_has_no_modifier')}</span>}
              {scalable.map((m) => {
                const v = ranges[m.rawLine!] ?? 1;
                return (
                  <div key={m.rawLine} style={{ display: 'grid', gridTemplateColumns: '48px 120px minmax(0,1fr)', gap: 10, alignItems: 'center' }}>
                    <span className="it-sub" style={{ textAlign: 'right' }}>{v.toFixed(2)}</span>
                    <input type="range" min={0.78} max={1.22} step={0.01} value={v} aria-label={tr('items_modDialogs.corrupted_roll_range')} onChange={(e) => setRanges({ ...ranges, [m.rawLine!]: parseFloat(e.target.value) })} />
                    <span style={{ color: 'var(--mod-explicit)', whiteSpace: 'normal' }}>{m.text}</span>
                  </div>
                );
              })}
            </div>
          )}
          <Changes env={env} ctx={ctx} from={text} to={result} header="Corrupting will give:" />
          <Preview env={env} text={result} />
        </div>
      </Dialog>
      {node}
    </Over>
  );
}
