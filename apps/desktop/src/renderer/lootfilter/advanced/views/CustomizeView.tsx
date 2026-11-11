import { useEffect, useMemo, useState } from 'react';
import { itemSectionHits, type CatalogItem, type TypeInfo } from '../../../../shared/lootfilter/catalog.js';
import { sectionOfType } from '../../../../shared/lootfilter/sections.js';
import { Icon } from '../../../ui';
import { useLf } from '../../lfStore';
import { useBuildLead } from '../../useBuildFilter';
import type { LfNav } from '../../LootFilterArea';
import { buildTree, findSection, ruleCounts, type SectionNode } from '../customize/model';
import { BuildTiers } from '../customize/BuildTiers';
import { RuleBuilder } from '../customize/RuleBuilder';
import { RulesList } from '../customize/RulesList';
import { TierList } from '../customize/TierList';
import { addCustomTier, customKey, customTierRules, onlyType, tierKeyOfItem } from '../shell/edits';
import { useAdvShell } from '../shell/selection';
import '../customize/adv-cz.css';
import { tr } from '../../../i18n';
import { groupName, sectionName } from '../../names';

const BUILD = 'build';
const RULES = '__rules';
const LETTERS = 'SABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DEFAULT_OPEN = 3;

/** Prices first, so the chips read top value to bottom the way the design sorts them. */
const byPrice = (price: (n: string) => number | undefined) => (a: CatalogItem, b: CatalogItem): number => (price(b.name) ?? -1) - (price(a.name) ?? -1);

export function CustomizeView({ nav }: { nav: LfNav }) {
  const lf = useLf();
  const sh = useAdvShell();
  const cat = lf.catalog;
  const [q, setQ] = useState('');
  const [onlyMod, setOnlyMod] = useState(false);
  const [onlyBuild, setOnlyBuild] = useState(false);
  const [openG, setOpenG] = useState<Record<string, boolean>>({});
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({});
  const [newRule, setNewRule] = useState(false);

  const tree = useMemo(() => (cat ? buildTree(cat) : []), [cat]);
  const counts = useMemo(() => (cat ? ruleCounts(lf.doc.rules, cat) : new Map<string, { mod: number; build: number }>()), [cat, lf.doc.rules]);
  const price = (n: string): number | undefined => lf.prices?.byName[n]?.chaos ?? lf.prices?.uniqueByBase[n];
  const byTier = useMemo(() => {
    const m = new Map<string, CatalogItem[]>();
    if (!cat) return m;
    for (const it of cat.items) {
      const k = tierKeyOfItem(lf.doc.rules, it);
      const l = m.get(k);
      if (l) l.push(it);
      else m.set(k, [it]);
    }
    const cmp = byPrice(price);
    for (const l of m.values()) l.sort(cmp);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cat, lf.doc.rules, lf.prices]);

  const buildCount = lf.doc.rules.filter((r) => r.source === 'build').length;
  const info = lf.build?.info;
  const lead = useBuildLead();
  const buildName = lead ? lead.replace(' · ', ', ') : info && (info.ascendClassName || info.className) ? `${info.ascendClassName || info.className}${info.mainSkill ? `, ${info.mainSkill}` : ''}` : lf.doc.buildName || tr('lootfilter_advanced_views_CustomizeView.build_rules');

  const wanted = typeof lf.ui.advSection === 'string' ? lf.ui.advSection : '';
  const alias = wanted === '__build' ? BUILD : wanted === '__rules' ? RULES : wanted;
  const found = alias === BUILD || alias === RULES ? undefined : findSection(tree, alias);
  const sectionId = alias === BUILD ? BUILD : alias === RULES ? RULES : found?.def.id ?? 'currency';
  const node: SectionNode | undefined = sectionId === BUILD || sectionId === RULES ? undefined : findSection(tree, sectionId);
  const isBuild = sectionId === BUILD;
  const isRules = sectionId === RULES;
  const seeInstead = node?.def.seeInstead ? findSection(tree, node.def.seeInstead) : undefined;
  const types: TypeInfo[] = node?.types ?? [];
  const setSection = (s: string): void => {
    lf.setUi('advSection', s);
    setNewRule(false);
  };

  // A view or a menu asked for a rule, an item or a tier.
  const focus = nav.advancedFocus;
  useEffect(() => {
    if (!focus || !cat) return;
    if (focus.ruleId) {
      const r = lf.doc.rules.find((x) => x.id === focus.ruleId);
      lf.setUi('advSection', r?.source === 'build' ? BUILD : r?.customTier ? sectionOfType(r.customTier.type).id : RULES);
      sh.select({ kind: 'rule', id: focus.ruleId });
      sh.openInspector();
      window.setTimeout(() => document.getElementById(`adv-cz-rule-${focus.ruleId}`)?.scrollIntoView({ block: 'center' }), 60);
    } else if (focus.item) {
      const it = cat.byName.get(focus.item);
      if (it) {
        lf.setUi('advSection', sectionOfType(it.type).id);
        sh.select({ kind: 'item', name: it.name });
        sh.openInspector();
      }
    }
    nav.clearAdvancedFocus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, cat]);
  const wantTier = typeof lf.ui.advTier === 'string' ? lf.ui.advTier : '';
  useEffect(() => {
    if (!wantTier) return;
    setOpenMap((o) => ({ ...o, [wantTier]: true }));
    window.setTimeout(() => document.getElementById(`adv-cz-tier-${wantTier}`)?.scrollIntoView({ block: 'center' }), 80);
    lf.setUi('advTier', null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantTier, sectionId]);

  // ---- tree -----------------------------------------------------------------------------------------
  const s = q.trim().toLowerCase();
  const itemHits = useMemo(() => {
    const m = new Map<string, number>();
    if (cat) for (const [id, names] of itemSectionHits(cat, s)) m.set(id, names.length);
    return m;
  }, [cat, s]);
  const sectionCount = (n: SectionNode): { mod: number; build: number } => {
    let mod = 0;
    let build = 0;
    for (const t of n.types) {
      const c = counts.get(t.type);
      if (c) {
        mod += c.mod;
        build += c.build;
      }
    }
    return { mod, build };
  };
  const visibleTree = tree
    .map((g) => ({
      ...g,
      sections: g.sections.filter((n) => {
        const c = sectionCount(n);
        if (onlyMod && !(c.mod > 0)) return false;
        if (onlyBuild && !(c.build > 0 || n.def.id === RULES)) return false;
        if (!s) return true;
        return n.def.name.toLowerCase().includes(s) || sectionName(n.def).toLowerCase().includes(s) || n.types.some((t) => t.type.toLowerCase().includes(s) || t.label.toLowerCase().includes(s)) || g.name.toLowerCase().includes(s) || groupName(g.name).toLowerCase().includes(s) || itemHits.has(n.def.id);
      }),
    }))
    .map((g) => ({ ...g, build: g.name === 'Your build' }))
    .filter((g) => (g.build ? (!onlyMod && (!s || buildName.toLowerCase().includes(s) || 'your build'.includes(s))) : g.sections.length > 0));

  const typeIds = types.map((t) => t.type);
  const resetSection = (): void => {
    if (!cat || !node) return;
    const gone = lf.doc.rules.filter((r) => r.source !== 'build' && onlyType(r, cat, typeIds));
    if (!gone.length) {
      sh.toastInfo(tr('lootfilter_advanced_views_CustomizeView.nothing_to_reset_here_this'));
      return;
    }
    const ids = new Set(gone.map((r) => r.id));
    lf.setRules(tr('lootfilter_advanced_views_CustomizeView.reset_name', { name: sectionName(node.def) }), (rs) => rs.filter((r) => !ids.has(r.id)));
    sh.toastUndo(tr('lootfilter_advanced_views_CustomizeView.name_reset_to_neversink_removed', { count: gone.length, name: sectionName(node.def) }));
  };

  const tierCount = types.reduce((n, t) => n + t.tiers.length, 0) + customTierRules(lf.doc.rules, typeIds).length;
  const itemCount = types.reduce((n, t) => n + t.tiers.reduce((m, ti) => m + (byTier.get(ti.key)?.length ?? 0), 0), 0) + customTierRules(lf.doc.rules, typeIds).reduce((n, r) => n + (byTier.get(customKey(r))?.length ?? 0), 0);
  const ruleTiers = types.reduce((n, t) => n + t.tiers.filter((ti) => !(byTier.get(ti.key)?.length)).length, 0);
  const title = isBuild ? buildName : isRules ? tr('lootfilter_advanced_views_CustomizeView.your_rules') : (node ? sectionName(node.def) : null) ?? tr('lootfilter_advanced_views_CustomizeView_2.customize');
  const sub = isBuild
    ? tr('lootfilter_advanced_views_CustomizeView.count_rules_made_from_your', { count: buildCount })
    : isRules
      ? tr('lootfilter_advanced_views_CustomizeView.count_rules_the_first_rule', { count: lf.doc.rules.length })
      : seeInstead
        ? tr('lootfilter_advanced_views_CustomizeView.lives_in_name', { name: sectionName(seeInstead.def) })
        : [tr(tierCount === 1 ? 'h_lootB_Guided.tiers_one' : 'h_lootB_Guided.tiers_other', { n: tierCount }) + (ruleTiers ? `, ${tr('h_lootB_Guided.matched_by_rule', { n: ruleTiers })}` : ''), itemCount ? tr(itemCount === 1 ? 'h_lootB_Guided.named_one' : 'h_lootB_Guided.named_other', { n: itemCount }) : '', tr('h_lootB_Guided.drag_hint')].filter(Boolean).join(' · ');

  const stacked = lf.doc.setup.stackedTiering !== false;
  const hasStacked = !!node && (node.def.scope === 'currency' || node.def.id === 'cards');
  const toggleStacked = (): void => {
    lf.edit(stacked ? tr('lootfilter_advanced_views_CustomizeView.stacked_tiering_off') : tr('lootfilter_advanced_views_CustomizeView.stacked_tiering_on'), (d) => {
      const su = { ...d.setup };
      if (stacked) su.stackedTiering = false;
      else delete su.stackedTiering;
      return { ...d, setup: su };
    });
    sh.toastUndo(stacked ? tr('lootfilter_advanced_views_CustomizeView.stacked_tiering_is_off_stacks') : tr('lootfilter_advanced_views_CustomizeView.stacked_tiering_is_on_stacks'));
  };
  const addTier = (): void => {
    const t = types[0];
    if (!t) return;
    const own = customTierRules(lf.doc.rules, [t.type]).length;
    const numbered = t.tiers.filter((x) => /^t\d/.test(x.tier)).length;
    const letter = LETTERS[Math.min(LETTERS.length - 1, numbered + own)]!;
    const lastLit = [...t.tiers].reverse().find((x) => x.kind !== 'Hide' && x.style.fg && x.style.bg);
    const rule = addCustomTier(lf, t.type, tr('lootfilter_advanced_views_CustomizeView.letter_tier_yours', { letter }), { ...(lastLit?.style ?? { fg: [200, 200, 200], bg: [0, 0, 0, 200], fs: 32 }) });
    setOpenMap((o) => ({ ...o, [customKey(rule)]: true }));
    sh.select({ kind: 'rule', id: rule.id });
    sh.openInspector();
    sh.toastUndo(tr('lootfilter_advanced_views_CustomizeView.added_name_drag_items_into', { name: rule.name }));
    window.setTimeout(() => document.getElementById(`adv-cz-tier-${customKey(rule)}`)?.scrollIntoView({ block: 'center' }), 120);
  };

  if (!cat) {
    return (
      <div className="adv-cz" style={{ alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
        {lf.baseLoading ? tr('lootfilter_advanced_views_CustomizeView.reading_neversink') : tr('lootfilter_advanced_views_CustomizeView_2.neversink_is_not_loaded')}
      </div>
    );
  }

  const sectionButton = (id: string, name: string, tip: string, extra: { mod?: number; build?: number; hits?: number; rules?: number }) => (
    <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 2, paddingLeft: 14 }}>
      <button type="button" className="adv-cz-sec" aria-current={sectionId === id} title={tip} onClick={() => setSection(id)}>
        <span className="ellipsis" style={{ flex: 1 }}>{name}</span>
        {extra.hits !== undefined && <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>{tr('lootfilter_advanced_views_CustomizeView.hits_match', { hits: extra.hits })}</span>}
        {extra.rules !== undefined && extra.rules > 0 && <span title={tr('lootfilter_advanced_views_CustomizeView.count_rules', { count: extra.rules })} className="adv-cz-badge" style={{ color: 'var(--positive-text)', background: 'rgba(79,220,124,.1)', boxShadow: 'inset 0 0 0 1px rgba(79,220,124,.3)' }}>{extra.rules}</span>}
        {extra.build !== undefined && extra.build > 0 && <span title={tr('lootfilter_advanced_views_CustomizeView.count_build_rules', { count: extra.build })} className="adv-cz-badge" style={{ color: 'var(--positive-text)', background: 'rgba(79,220,124,.1)', boxShadow: 'inset 0 0 0 1px rgba(79,220,124,.3)' }}>{extra.build}</span>}
        {extra.mod !== undefined && extra.mod > 0 && <span title={tr('lootfilter_advanced_views_CustomizeView.count_changes_from_neversink', { count: extra.mod })} className="adv-cz-badge">{extra.mod}</span>}
      </button>
    </div>
  );

  return (
    <div className="adv-cz" data-screen-label="Loot Filter / Customize">
      <div className="adv-cz-tree lf-card" data-lg="panel" data-screen-label="Loot Filter / Customize / Section tree">
        <div style={{ padding: '10px 10px 6px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ position: 'relative', display: 'flex' }}>
            <Icon name="search" size={15} style={{ position: 'absolute', left: 10, top: 9, color: 'var(--text-muted)' }} />
            <input className="adv-sh-field" style={{ paddingLeft: 30 }} aria-label={tr('lootfilter_advanced_views_CustomizeView.search_sections_and_items')} placeholder={tr('lootfilter_advanced_views_CustomizeView.search_sections_and_items')} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {[
              { l: tr('lootfilter_advanced_views_CustomizeView.modified_only'), on: onlyMod, set: () => setOnlyMod((v) => !v) },
              { l: tr('lootfilter_advanced_views_CustomizeView.build_rules_only'), on: onlyBuild, set: () => setOnlyBuild((v) => !v) },
            ].map((f) => (
              <button key={f.l} type="button" className="adv-cz-filter" aria-pressed={f.on} onClick={f.set}>
                {f.l}
              </button>
            ))}
          </div>
        </div>
        <div className="adv-cz-treelist lf-scroll">
          {visibleTree.map((g, gi) => {
            const modTotal = g.sections.reduce((n, x) => n + sectionCount(x).mod, 0);
            const holdsCurrent = g.build ? isBuild : g.sections.some((x) => x.def.id === sectionId);
            const isOpen = !!s || onlyMod || onlyBuild || (openG[g.name] ?? (gi < DEFAULT_OPEN || holdsCurrent));
            return (
              <div key={g.name}>
                <button type="button" className="adv-cz-group" onClick={() => setOpenG((c) => ({ ...c, [g.name]: !isOpen }))} aria-expanded={isOpen}>
                  <Icon name="chevron-right" size={12} style={{ flex: 'none', transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform .1s' }} />
                  <span className="ellipsis" style={{ flex: 1 }}>{groupName(g.name)}</span>
                  {modTotal > 0 && <span className="adv-cz-badge">{modTotal}</span>}
                </button>
                {isOpen && g.build && sectionButton(BUILD, buildName, tr('lootfilter_advanced_views_CustomizeView.rules_made_from_your_build'), { build: buildCount })}
                {isOpen && g.build && sectionButton(RULES, tr('lootfilter_advanced_views_CustomizeView.your_rules'), tr('lootfilter_advanced_views_CustomizeView.rules_you_wrote_highest_priority'), { rules: lf.doc.rules.length })}
                {isOpen &&
                  g.sections.map((n) => {
                    const c = sectionCount(n);
                    const hits = itemHits.get(n.def.id);
                    const tip = n.types.length ? `NeverSink name: ${n.types.map((t) => '$type->' + t.type).join(', ')}` : n.def.note ?? sectionName(n.def);
                    return sectionButton(n.def.id, sectionName(n.def), tip, { mod: n.def.id === RULES ? 0 : c.mod, ...(n.def.id === RULES ? { rules: lf.doc.rules.length } : {}), ...(hits !== undefined ? { hits } : {}) });
                  })}
              </div>
            );
          })}
          {visibleTree.length === 0 && <div style={{ padding: '24px 10px', color: 'var(--text-muted)', textAlign: 'center', lineHeight: 1.5 }}>{s ? tr('lootfilter_advanced_views_CustomizeView.no_sections_or_items_match') : tr('lootfilter_advanced_views_CustomizeView.no_sections_match')}</div>}
        </div>
      </div>

      <div className="adv-cz-main lf-card" data-lg="panel" data-screen-label="Loot Filter / Customize / Tier list">
        <div className="adv-cz-mhead">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, flex: '1 1 240px' }}>
            <span className="ellipsis" title={types.length ? `NeverSink name: ${types.map((t) => '$type->' + t.type).join(', ')}` : title} style={{ font: "600 22px/1.1 'Cormorant Garamond',serif", color: 'var(--text-display)' }}>{title}</span>
            <span className="ellipsis" title={sub} style={{ color: 'var(--text-muted)', fontSize: 12 }}>{sub}</span>
          </div>
          {!isBuild && !isRules && types.length > 0 && (
            <>
              <button type="button" className="adv-sh-btn" title={tr('lootfilter_advanced_views_CustomizeView.move_items_between_tiers_using')} onClick={() => nav.setAdvancedView('retier')}>
                <Icon name="coins" size={14} />
                {tr('lootfilter_advanced_views_CustomizeView.retier_from_prices')}
              </button>
              {hasStacked && (
                <button type="button" className="adv-sh-btn" title={tr('lootfilter_advanced_views_CustomizeView.stacks_of_cheap_currency_get')} aria-pressed={stacked} onClick={toggleStacked}>
                  <Icon name="layers" size={14} />
                  <span className="adv-sh-tog" data-on={stacked ? '1' : '0'}>
                    <span />
                  </span>
                  {tr('lootfilter_advanced_views_CustomizeView.stacked_tiering')}
                </button>
              )}
              <button type="button" className="adv-sh-btn" title={tr('lootfilter_advanced_views_CustomizeView.add_a_tier_you_can')} onClick={addTier}>
                <Icon name="plus" size={14} />
                {tr('lootfilter_advanced_views_CustomizeView.add_tier')}
              </button>
              <button type="button" className="adv-sh-btn" title={tr('lootfilter_advanced_views_CustomizeView.put_this_section_back_to')} onClick={resetSection}>
                <Icon name="reset" size={14} />
                {tr('lootfilter_advanced_views_CustomizeView.reset_section')}
              </button>
            </>
          )}
          {isRules && (
            <button type="button" className="adv-sh-btn gold" onClick={() => setNewRule((v) => !v)}>
              <Icon name="plus" size={14} />
              {tr('lootfilter_advanced_views_CustomizeView.new_rule')}
            </button>
          )}
        </div>
        <div className="adv-cz-mbody lf-scroll">
          {isBuild ? (
            <BuildTiers />
          ) : isRules ? (
            <>
              {newRule && (
                <RuleBuilder
                  sectionType={lf.ui.advLastType && typeof lf.ui.advLastType === 'string' ? lf.ui.advLastType : 'currency'}
                  onClose={() => setNewRule(false)}
                  onSaved={(id) => {
                    setNewRule(false);
                    sh.select({ kind: 'rule', id });
                    sh.toastUndo(tr('lootfilter_advanced_views_CustomizeView.added_the_rule'));
                  }}
                />
              )}
              <RulesList onlyBuild={false} />
              {types.length > 0 && (
                <>
                  <span className="adv-cz-typehead" style={{ marginTop: 6 }}>{tr('lootfilter_advanced_views_CustomizeView.neversink_s_own_tiers_for')}</span>
                  <TierList types={types} byTier={byTier} openMap={openMap} setOpen={(k, v) => setOpenMap((o) => ({ ...o, [k]: v }))} />
                </>
              )}
            </>
          ) : seeInstead ? (
            <div style={{ padding: '28px 16px', color: 'var(--text-muted)', lineHeight: 1.55, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
              <span>{node?.def.note}</span>
              <button type="button" className="adv-sh-btn" onClick={() => setSection(seeInstead.def.id)}>
                {tr('lootfilter_advanced_views_CustomizeView.open_name', { name: sectionName(seeInstead.def) })}
              </button>
            </div>
          ) : types.length ? (
            <TierList types={types} byTier={byTier} openMap={openMap} setOpen={(k, v) => setOpenMap((o) => ({ ...o, [k]: v }))} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

