import { useState, type ReactNode } from 'react';
import type { CatalogItem, TierInfo, TypeInfo } from '../../../../shared/lootfilter/catalog.js';
import type { LabelStyle, Rule } from '../../../../shared/lootfilter/types.js';
import { rgba } from '../../../../shared/lootfilter/styles.js';
import { typeName } from '../../../../shared/lootfilter/sections.js';
import { Icon } from '../../../ui';
import { LabelChip, groundFor } from '../../LabelChip';
import { useLf } from '../../lfStore';
import { AdvChip, DRAG_MIME } from '../shell/AdvChip';
import { currentLook, customKey, customNames, customTierRules, moveItemToCustomTier, setTierHidden, tierHidden } from '../shell/edits';
import { useAdvShell } from '../shell/selection';
import { tr } from '../../../i18n';

const ITEM_CAP = 80;

/** One tier's frame: chevron, on switch, name, count, the Aa look swatch, and the body of chips. */
export function Frame({
  id,
  open,
  onToggle,
  off,
  onSwitch,
  name,
  nameTitle,
  count,
  look,
  selected,
  onSelect,
  onLook,
  actions,
  over,
  dropProps,
  children,
}: {
  id: string;
  open: boolean;
  onToggle: () => void;
  off: boolean;
  onSwitch: () => void;
  name: string;
  nameTitle: string;
  count: string;
  look: LabelStyle;
  selected: boolean;
  onSelect: () => void;
  onLook: () => void;
  actions: ReactNode;
  over?: boolean;
  dropProps?: Record<string, unknown>;
  children: ReactNode;
}) {
  return (
    <div
      id={id}
      className="adv-cz-tier"
      {...dropProps}
      style={{ borderColor: over ? 'var(--gold-400)' : selected ? 'rgba(var(--accent-rgb),.5)' : 'rgba(var(--line-rgb),.08)', background: over ? 'rgba(var(--accent-rgb),.08)' : selected ? 'rgba(var(--accent-rgb),.05)' : 'rgba(var(--shadow-rgb),calc(.18*var(--shadow-k)))' }}
    >
      <div className="adv-cz-thead" style={{ opacity: off ? 0.6 : 1 }}>
        <button type="button" className="adv-sh-ib sm" title={open ? tr('lootfilter_advanced_customize_TierList.collapse_tier') : tr('lootfilter_advanced_customize_TierList.expand_tier')} aria-label={open ? tr('lootfilter_advanced_customize_TierList.collapse_tier') : tr('lootfilter_advanced_customize_TierList.expand_tier')} aria-expanded={open} onClick={onToggle}>
          <Icon name="chevron-right" size={12} style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .1s' }} />
        </button>
        <label title={tr('lootfilter_advanced_customize_TierList.tier_on_or_off')} style={{ flex: 'none', display: 'flex', alignItems: 'center', cursor: 'pointer', height: 28 }}>
          <input type="checkbox" checked={!off} aria-label={tr('lootfilter_advanced_customize_TierList.tier_on')} style={{ width: 15, height: 15, accentColor: 'var(--gold-400)', margin: 0 }} onChange={onSwitch} />
        </label>
        <button type="button" className="adv-cz-tname" title={nameTitle} style={{ textDecoration: off ? 'line-through' : 'none' }} onClick={onSelect}>
          {name}
        </button>
        <span style={{ flex: 'none', color: 'var(--text-muted)', fontSize: 12, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{count}</span>
        {over && <span style={{ flex: 'none', color: 'var(--gold-text)', fontSize: 12, whiteSpace: 'nowrap' }}>{tr('lootfilter_advanced_customize_TierList.drop_to_move_here')}</span>}
        <button
          type="button"
          title={tr('lootfilter_advanced_customize_TierList.tier_look_click_to_edit')}
          aria-label={tr('lootfilter_advanced_customize_TierList.edit_tier_look')}
          className="adv-cz-aa"
          style={{ border: `1px solid ${rgba(look.bd ?? [0, 0, 0, 0])}`, background: rgba(look.bg ?? [0, 0, 0, 150]), color: rgba(look.fg ?? [200, 200, 200]), opacity: off ? 0.5 : 1 }}
          onClick={onLook}
        >
          {tr('lootfilter_advanced_customize_TierList.aa')}
        </button>
        <span style={{ flex: 1 }} />
        {actions}
      </div>
      {open && children}
    </div>
  );
}

const countText = (n: number, by: boolean): string => (n ? tr('lootfilter_advanced_customize_TierList.count_items', { count: n }) : by ? tr('lootfilter_advanced_customize_TierList_2.matches_by_rule') : tr('lootfilter_advanced_customize_TierList_2.no_named_items'));

function TierCard({ tier, items, open, onToggle, dragName, setDragName }: { tier: TierInfo; items: CatalogItem[]; open: boolean; onToggle: () => void; dragName: string | null; setDragName: (n: string | null) => void }) {
  const lf = useLf();
  const sh = useAdvShell();
  const [over, setOver] = useState(false);
  const [all, setAll] = useState(false);
  const off = tierHidden(lf.doc.rules, tier);
  const look = currentLook(lf, { kind: 'tier', tier });
  const selected = sh.selected?.kind === 'tier' && sh.selected.key === tier.key;
  const bright = sh.ground === 'bright';
  const gt = bright ? 'rgba(24,20,14,.86)' : 'rgba(255,240,215,.62)';
  const shown = all ? items : items.slice(0, ITEM_CAP);
  const canDrop = !!dragName;
  return (
    <Frame
      id={`adv-cz-tier-${tier.key}`}
      open={open}
      onToggle={onToggle}
      off={off}
      onSwitch={() => sh.toastUndo(setTierHidden(lf, tier, !off))}
      name={tier.label}
      nameTitle={tr('lootfilter_advanced_customize_TierList.neversink_name_type_type_tier', { type: tier.type, tier: tier.tier })}
      count={countText(items.length, tier.conditional)}
      look={look}
      selected={selected}
      onSelect={() => {
        sh.select({ kind: 'tier', key: tier.key });
        sh.openInspector();
      }}
      onLook={() => {
        sh.select({ kind: 'tier', key: tier.key });
        sh.openInspector('style');
      }}
      actions={
        <button
          type="button"
          className="adv-sh-ib sm"
          title={tr('lootfilter_advanced_customize_TierList.tier_actions')}
          aria-label={tr('lootfilter_advanced_customize_TierList.tier_actions')}
          onClick={(e) => {
            const b = e.currentTarget.getBoundingClientRect();
            sh.select({ kind: 'tier', key: tier.key });
            sh.openTierMenu({ x: b.left - 180, y: b.bottom + 4 }, tier.key);
          }}
        >
          <Icon name="more" size={12} />
        </button>
      }
      over={over}
      dropProps={{
        onDragOver: (e: React.DragEvent) => {
          if (!canDrop) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          setOver(true);
        },
        onDragLeave: () => setOver(false),
        onDrop: (e: React.DragEvent) => {
          setOver(false);
          const n = e.dataTransfer.getData(DRAG_MIME) || e.dataTransfer.getData('text/plain');
          setDragName(null);
          if (n) {
            e.preventDefault();
            sh.moveToTier(n, tier);
          }
        },
      }}
    >
      <div className="adv-cz-tground" style={{ background: bright ? groundFor('bright') : 'rgba(var(--shadow-rgb),calc(.34*var(--shadow-k)))' }}>
        {shown.map((it) => (
          <AdvChip key={it.name} item={it} draggable onDragState={setDragName} />
        ))}
        {items.length > ITEM_CAP && (
          <button type="button" className="adv-sh-btn sm ground" onClick={() => setAll((a) => !a)}>
            {all ? tr('lootfilter_advanced_customize_TierList.show_fewer') : tr('lootfilter_advanced_customize_TierList.show_all_length', { count: items.length })}
          </button>
        )}
        {over && <span style={{ flex: 'none', width: 2, height: 26, borderRadius: 1, background: 'var(--gold-400)', boxShadow: '0 0 8px var(--gold-400)' }} />}
        {items.length === 0 && (
          <span style={{ color: gt, fontSize: 12.5 }}>
            {tier.conditional ? tr('lootfilter_advanced_customize_TierList.no_named_items_this_tier') : tr('lootfilter_advanced_customize_TierList.nothing_here_drag_an_item')}
          </span>
        )}
      </div>
    </Frame>
  );
}

/** A tier the player added: a rule whose base types are the items in it. */
function CustomTierCard({ rule, items, open, onToggle, dragName, setDragName }: { rule: Rule; items: CatalogItem[]; open: boolean; onToggle: () => void; dragName: string | null; setDragName: (n: string | null) => void }) {
  const lf = useLf();
  const sh = useAdvShell();
  const [over, setOver] = useState(false);
  const look = currentLook(lf, { kind: 'rule', rule });
  const selected = sh.selected?.kind === 'rule' && sh.selected.id === rule.id;
  const bright = sh.ground === 'bright';
  const gt = bright ? 'rgba(24,20,14,.86)' : 'rgba(255,240,215,.62)';
  const names = customNames(rule);
  const shownNames = new Set(items.map((i) => i.name));
  return (
    <Frame
      id={`adv-cz-tier-${customKey(rule)}`}
      open={open}
      onToggle={onToggle}
      off={!rule.enabled}
      onSwitch={() => lf.updateRule(rule.id, { enabled: !rule.enabled }, rule.enabled ? tr('lootfilter_advanced_customize_TierList.switched_off_name', { name: rule.name }) : tr('lootfilter_advanced_customize_TierList.switched_on_name', { name: rule.name }))}
      name={rule.name ?? tr('lootfilter_advanced_customize_TierList_2.added_tier')}
      nameTitle={tr('lootfilter_advanced_customize_TierList.a_tier_you_added_it')}
      count={names.length ? tr('lootfilter_advanced_customize_TierList.count_items', { count: names.length }) : tr('lootfilter_advanced_customize_TierList_2.no_items_yet')}
      look={look}
      selected={selected}
      onSelect={() => {
        sh.select({ kind: 'rule', id: rule.id });
        sh.openInspector();
      }}
      onLook={() => {
        sh.select({ kind: 'rule', id: rule.id });
        sh.openInspector('style');
      }}
      actions={
        <button
          type="button"
          className="adv-sh-ib sm"
          title={tr('lootfilter_advanced_customize_TierList.delete_this_tier')}
          aria-label={tr('lootfilter_advanced_customize_TierList.delete_tier')}
          onClick={() => {
            lf.removeRule(rule.id, tr('lootfilter_advanced_customize_TierList_2.deleted', { name: rule.name }));
            sh.toastUndo(tr('lootfilter_advanced_customize_TierList_2.deleted', { name: rule.name }));
          }}
        >
          <Icon name="trash" size={13} />
        </button>
      }
      over={over}
      dropProps={{
        onDragOver: (e: React.DragEvent) => {
          if (!dragName) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          setOver(true);
        },
        onDragLeave: () => setOver(false),
        onDrop: (e: React.DragEvent) => {
          setOver(false);
          const n = e.dataTransfer.getData(DRAG_MIME) || e.dataTransfer.getData('text/plain');
          setDragName(null);
          const it = n ? lf.catalog?.byName.get(n) : undefined;
          if (it) {
            e.preventDefault();
            sh.toastUndo(moveItemToCustomTier(lf, it, rule));
          }
        },
      }}
    >
      <div className="adv-cz-tground" style={{ background: bright ? groundFor('bright') : 'rgba(var(--shadow-rgb),calc(.34*var(--shadow-k)))' }}>
        {items.map((it) => (
          <AdvChip key={it.name} item={it} draggable onDragState={setDragName} />
        ))}
        {names
          .filter((n) => !shownNames.has(n))
          .map((n) => (
            <LabelChip key={n} name={n} style={look} bright={bright} title={n} />
          ))}
        {names.length === 0 && <span style={{ color: gt, fontSize: 12.5 }}>{tr('lootfilter_advanced_customize_TierList.nothing_here_yet_drag_an')}</span>}
      </div>
    </Frame>
  );
}

export function TierList({ types, byTier, openMap, setOpen }: { types: TypeInfo[]; byTier: Map<string, CatalogItem[]>; openMap: Record<string, boolean>; setOpen: (k: string, v: boolean) => void }) {
  const lf = useLf();
  const [dragName, setDragName] = useState<string | null>(null);
  const multi = types.length > 1;
  const custom = customTierRules(lf.doc.rules, types.map((t) => t.type));
  return (
    <>
      {types.map((type) => (
        <div key={type.type} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {multi && (
            <span className="adv-cz-typehead" title={tr('lootfilter_advanced_customize_TierList.neversink_name_type_type', { type: type.type })}>
              {typeName(type.type, type.label)}
            </span>
          )}
          {type.tiers.map((t, i) => (
            <TierCard key={t.key} tier={t} items={byTier.get(t.key) ?? []} open={openMap[t.key] ?? (multi ? false : i < 3)} onToggle={() => setOpen(t.key, !(openMap[t.key] ?? (multi ? false : i < 3)))} dragName={dragName} setDragName={setDragName} />
          ))}
          {custom
            .filter((r) => r.customTier!.type === type.type)
            .map((r) => (
              <CustomTierCard key={r.id} rule={r} items={(byTier.get(customKey(r)) ?? [])} open={openMap[customKey(r)] ?? true} onToggle={() => setOpen(customKey(r), !(openMap[customKey(r)] ?? true))} dragName={dragName} setDragName={setDragName} />
            ))}
        </div>
      ))}
    </>
  );
}
