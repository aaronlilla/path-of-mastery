import type { ItemInfo, ItemMod } from '@pom/protocol';
import { useEffect, useState } from 'react';
import { cmd } from './engine';
import { altVariants, clusterEnchants, setAltVariant, setCatalyst, setClusterSpec, setEnchantBlock } from './itemText';
import { PickButton, type MenuEntry } from './parts';
import { setGroupVariant, setVersion, type VariantModel } from './variantGroups';
import { label, tr } from '../i18n';

type Edit = (fn: (t: string) => string) => void;
type OpenMenu = (anchor: HTMLElement, entries: MenuEntry[], width?: number) => void;

// ---- alternate variants ------------------------------------------------------------------------------------------------------

export function AltVariantRows({ text, names, edit, openMenu }: { text: string; names: string[]; edit: Edit; openMenu: OpenMenu }) {
  const alts = altVariants(text);
  if (!alts.length || names.length < 2) return null;
  return (
    <>
      {alts.map((a) => (
        <div key={a.sel} className="it-frow">
          <span className="k" style={{ width: 66, whiteSpace: 'nowrap' }}>{a.label}</span>
          <PickButton dataKey={`ed:${a.sel}`} value={names[Math.min(names.length, a.value) - 1]} onOpen={(el) => openMenu(el, names.map((n, i) => ({ key: String(i), label: n, on: i + 1 === a.value, run: () => edit((t) => setAltVariant(t, a.sel, i + 1)) })), 320)} />
        </div>
      ))}
    </>
  );
}

// ---- versions and variant groups ---------------------------------------------------------------------------------------------

export function VariantGroupRows({ model, edit, openMenu }: { model: VariantModel; edit: Edit; openMenu: OpenMenu }) {
  return (
    <>
      {model.versions.length > 1 && (
        <div className="it-frow">
          <span className="k" style={{ width: 66, whiteSpace: 'nowrap' }}>{tr('items_EditorExtras.version')}</span>
          <PickButton
            dataKey="ed:version"
            value={model.versions[(model.selectedVersion ?? 1) - 1] ?? ''}
            onOpen={(el) => openMenu(el, model.versions.map((n, i) => ({ key: String(i), label: n, on: i + 1 === model.selectedVersion, run: () => edit((t) => setVersion(t, i + 1)) })), 320)}
          />
        </div>
      )}
      {model.groups.map((g, gi) => {
        const cur = g.options.find((o) => o.variantId === g.selected);
        return (
          <div key={g.groupId} className="it-frow">
            <span className="k" style={{ width: 66, whiteSpace: 'nowrap' }}>{gi === 0 ? tr('items_EditorExtras.variant') : tr('items_EditorExtras.variant_gi', { gi: gi + 1 })}</span>
            <PickButton
              dataKey={`ed:vgroup${g.groupId}`}
              value={cur?.label ?? (g.options.length ? g.options[0]!.label : tr('items_EditorExtras_2.no_available_variants'))}
              disabled={!g.enabled}
              onOpen={(el) => openMenu(el, g.options.map((o) => ({ key: String(o.variantId), label: o.label, on: o.variantId === g.selected, run: () => edit((t) => setGroupVariant(t, g.groupId, o.variantId)) })), 320)}
            />
          </div>
        );
      })}
    </>
  );
}

// ---- catalyst ---------------------------------------------------------------------------------------------------------------

const CATALYSTS: Array<[string, string]> = [
  ['Abrasive', tr('h_c_It.cat_attack')],
  ['Accelerating', tr('h_c_It.cat_speed')],
  ['Dextral', label('Suffix')],
  ['Fertile', tr('h_c_It.cat_life_mana')],
  ['Imbued', tr('mastery_StarterChooser.caster')],
  ['Intrinsic', tr('h_c_It.cat_attribute')],
  ['Noxious', tr('h_c_It.cat_phys_chaos')],
  ['Prismatic', tr('h_c_It.cat_resistance')],
  ['Sinistral', label('Prefix')],
  ['Tempering', tr('h_c_It.cat_defense')],
  ['Turbulent', tr('h_c_It.cat_elemental')],
  ['Unstable', tr('h_c_It.cat_critical')],
];

export function CatalystRow({ info, text, edit, openMenu }: { info: ItemInfo; text: string; edit: Edit; openMenu: OpenMenu }) {
  const cur = CATALYSTS.find((c) => c[0] === info.catalyst);
  const [q, setQ] = useState(String(info.catalystQuality ?? 20));
  useEffect(() => setQ(String(info.catalystQuality ?? 20)), [info.catalystQuality, info.catalyst]);
  return (
    <div className="it-frow">
      <span className="k">{tr('items_EditorExtras.catalyst')}</span>
      <PickButton
        dataKey="ed:catalyst"
        value={cur ? `${cur[0]} (${cur[1]})` : tr('items_EditorExtras.catalyst')}
        colour={cur ? undefined : 'var(--text-muted)'}
        onOpen={(el) =>
          openMenu(
            el,
            [{ key: 'none', label: tr('items_EditorExtras.none'), on: !cur, run: () => edit((t) => setCatalyst(t, null, 0)) }, ...CATALYSTS.map<MenuEntry>(([n, d]) => ({ key: n, label: `${n} (${d})`, on: n === cur?.[0], run: () => edit((t) => setCatalyst(t, n, info.catalystQuality ?? 20)) }))],
            280,
          )
        }
      />
      {cur && (
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: 'var(--text-3)' }}>
          {tr('items_EditorExtras.quality')}
          <input
            className="it-input"
            style={{ width: 56, textAlign: 'center' }}
            inputMode="numeric"
            maxLength={2}
            aria-label={tr('items_EditorExtras.catalyst_quality')}
            value={q}
            onChange={(e) => setQ(e.target.value.replace(/\D/g, ''))}
            onBlur={() => {
              const n = parseInt(q, 10);
              if (Number.isFinite(n) && n !== info.catalystQuality) edit((t) => setCatalyst(t, cur[0], n));
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        </label>
      )}
      <span style={{ display: 'none' }}>{text.length}</span>
    </div>
  );
}

// ---- cluster jewel ----------------------------------------------------------------------------------------------------------

interface ClusterPool {
  size: string | null;
  minNodes: number;
  maxNodes: number;
  skills: Array<{ id: string; name: string; enchant: string[] }>;
  selected: string | null;
  nodeCount: number | null;
}

/** The skill and the number of added passives of a crafted cluster jewel (`UpdateClusterJewelControls`, `CraftClusterJewel`). */
export function ClusterRow({ text, mods, edit, openMenu }: { text: string; mods: ItemMod[]; edit: Edit; openMenu: OpenMenu }) {
  const [pool, setPool] = useState<ClusterPool | null>(null);
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let dead = false;
    void cmd('itemPool', { itemText: text, kind: 'cluster' })
      .then((r) => !dead && setPool(r.pool as ClusterPool))
      .catch(() => !dead && setPool(null));
    return () => {
      dead = true;
    };
  }, [text]);
  useEffect(() => setCount(null), [pool?.nodeCount]);
  if (!pool || !pool.skills.length) return null;
  const skill = pool.skills.find((s) => s.id === pool.selected) ?? pool.skills[0]!;
  const n = Math.min(pool.maxNodes, Math.max(pool.minNodes, count ?? pool.nodeCount ?? pool.minNodes));
  const rawMods = mods.map((m) => ({ bucket: m.bucket, rawLine: m.rawLine }));
  const apply = (sk: ClusterPool['skills'][number], nodes: number) => edit((t) => setClusterSpec(setEnchantBlock(t, rawMods, clusterEnchants(pool.size, nodes, sk.enchant)), sk.id, nodes));
  return (
    <>
      <div className="it-frow">
        <span className="k">{tr('items_EditorExtras.skill')}</span>
        <PickButton dataKey="ed:cluster" value={skill.name} onOpen={(el) => openMenu(el, pool.skills.map((s) => ({ key: s.id, label: s.name, on: s.id === skill.id, run: () => apply(s, n) })), 300)} />
      </div>
      <div className="it-frow">
        <span className="k" style={{ whiteSpace: 'nowrap', width: 'auto' }}>{tr('items_EditorExtras.added_passives')}</span>
        <input type="range" min={pool.minNodes} max={pool.maxNodes} step={1} value={n} aria-label={tr('items_EditorExtras.added_passives_2')} disabled={pool.maxNodes <= pool.minNodes} onChange={(e) => setCount(parseInt(e.target.value, 10))} onPointerUp={() => count !== null && apply(skill, count)} onKeyUp={() => count !== null && apply(skill, count)} style={{ width: 150 }} />
        <span style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{n}</span>
      </div>
    </>
  );
}
