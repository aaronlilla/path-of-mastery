import { useMemo, useState } from 'react';
import { STRICTNESS } from '../../../../shared/lootfilter/styles.js';
import type { TierInfo } from '../../../../shared/lootfilter/catalog.js';
import { Icon } from '../../../ui';
import { classKey, classPortrait } from '../../../art';
import { FitGroup, LabelChip, groundFor } from '../../LabelChip';
import { useLf } from '../../lfStore';
import type { LfNav } from '../../LootFilterArea';
import { buildBoard } from '../overview/board';
import { AdvChip } from '../shell/AdvChip';
import { currentLook, tierHidden } from '../shell/edits';
import type { Rule } from '../../../../shared/lootfilter/types.js';
import { useAdvShell } from '../shell/selection';
import '../overview/adv-ov.css';
import { tr } from '../../../i18n';
import { lfBuild } from '../../mainText';
import { strictName } from '../../names';

function RuleChip({ rule, name: rawName }: { rule: Rule; name: string }) {
  const name = lfBuild(rawName);
  const lf = useLf();
  const sh = useAdvShell();
  const sel = sh.selected?.kind === 'rule' && sh.selected.id === rule.id;
  return (
    <LabelChip
      name={name}
      style={currentLook(lf, { kind: 'rule', rule })}
      bright={sh.ground === 'bright'}
      selected={sel}
      title={`${name}${rule.why ? '. ' + lfBuild(rule.why) : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        sh.select({ kind: 'rule', id: rule.id });
        sh.openInspector();
      }}
    />
  );
}

function TierSample({ tier, name }: { tier: TierInfo; name: string }) {
  const lf = useLf();
  const sh = useAdvShell();
  const look = currentLook(lf, { kind: 'tier', tier });
  const off = tierHidden(lf.doc.rules, tier);
  const selected = sh.selected?.kind === 'tier' && sh.selected.key === tier.key;
  return (
    <LabelChip
      name={name}
      style={look}
      hidden={off}
      hiddenLook="fade"
      bright={sh.ground === 'bright'}
      selected={selected}
      title={tr('lootfilter_advanced_views_OverviewView.name_click_to_edit_its', { name })}
      onClick={(e) => {
        e.stopPropagation();
        sh.select({ kind: 'tier', key: tier.key });
        sh.openInspector();
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        const it = lf.catalog?.items.find((x) => x.type === tier.type && x.tier === tier.tier);
        if (it) sh.explain(it.name);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        sh.select({ kind: 'tier', key: tier.key });
        sh.openTierMenu({ x: e.clientX, y: e.clientY }, tier.key);
      }}
    />
  );
}

export function OverviewView({ nav }: { nav: LfNav }) {
  const lf = useLf();
  const sh = useAdvShell();
  const [ghost, setGhost] = useState(false);
  const strict = lf.doc.setup.strictness;
  const loading = lf.baseLoading || !lf.catalog;
  const board = useMemo(
    () => (loading ? [] : buildBoard(lf)),
    // The board depends on the rules, the catalog, prices and the evaluated filter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loading, lf.catalog, lf.doc.rules, lf.prices, lf.gen],
  );
  const nextName = strict < 6 ? strictName(strict + 1) : '';
  const dismissed = lf.ui.advSummaryDismissed === lf.doc.id;
  const showSummary = !dismissed && !!lf.gen && !lf.doc.written && (lf.ui.advSummary === lf.doc.id || (!!lf.doc.buildName && lf.doc.rules.length > 0));
  const buildRules = lf.doc.rules.filter((r) => r.source === 'build').length;
  const otherRules = lf.doc.rules.length - buildRules;
  const portrait = lf.build ? classPortrait(classKey(lf.build.info)) : '';
  const bright = sh.ground === 'bright';

  return (
    <div className="adv-ov" data-screen-label="Loot Filter / Overview">
      {showSummary && (
        <div className="adv-ov-summary lf-card" data-lg="panel" data-screen-label="Loot Filter / Overview / Summary card" style={{ borderColor: 'rgba(var(--accent-rgb),.32)' }}>
          {portrait && <img src={portrait} alt="" style={{ flex: 'none', width: 42, height: 42, borderRadius: '50%', objectFit: 'cover', boxShadow: '0 0 0 1px rgba(var(--accent-rgb),.45)' }} />}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span className="lf-eyebrow">{tr('lootfilter_advanced_views_OverviewView.filter_ready')}</span>
            <span style={{ color: 'var(--text-strong)', fontSize: 14, lineHeight: 1.45, textWrap: 'pretty' }}>
              {tr('lootfilter_advanced_views_OverviewView.built_from_neversink_baseversion_nam', { baseVersion: lf.baseVersion, name: strictName(strict) })}
              {buildRules ? tr('lootfilter_advanced_views_OverviewView.plus_count_rules_for_your', { count: buildRules }) : ''}
              {otherRules ? tr(`h_lootB_Views.${buildRules ? 'and_other' : 'plus_other'}_${otherRules === 1 ? 'one' : 'other'}`, { n: otherRules }) : ''}{tr('lootfilter_advanced_views_OverviewView.nothing_is_written_to_the')}
            </span>
          </div>
          <button
            type="button"
            className="adv-sh-btn"
            onClick={() => {
              lf.setUi('advSection', 'build');
              nav.setAdvancedView('customize');
            }}
          >
            <Icon name="eye" size={14} />
            {tr('lootfilter_advanced_views_OverviewView.review_build_rules')}
          </button>
          <button type="button" className="adv-sh-ib" title={tr('lootfilter_advanced_views_OverviewView.dismiss')} aria-label={tr('lootfilter_advanced_views_OverviewView.dismiss')} onClick={() => lf.setUi('advSummaryDismissed', lf.doc.id)}>
            <Icon name="x" size={14} />
          </button>
        </div>
      )}
      <div className="adv-ov-head">
        <span className="adv-ov-title">{tr('lootfilter_advanced_views_OverviewView.overview')}</span>
        <span className="adv-ov-sub">{tr('lootfilter_advanced_views_OverviewView.every_chip_is_drawn_the')}</span>
        <button type="button" className="adv-sh-btn sm" disabled={strict >= 6} title={tr('lootfilter_advanced_views_OverviewView.fade_the_items_the_next')} onClick={() => setGhost((g) => !g)} aria-pressed={ghost}>
          <span className="adv-sh-tog" data-on={ghost && strict < 6 ? '1' : '0'}>
            <span />
          </span>
          {strict < 6 ? tr('lootfilter_advanced_views_OverviewView.preview_nextname', { nextName }) : tr('lootfilter_advanced_views_OverviewView.strictest_level')}
        </button>
        <span className="adv-sh-seg" title={tr('lootfilter_advanced_views_OverviewView.ground_behind_chips')} role="group" aria-label={tr('lootfilter_advanced_views_OverviewView.ground_behind_chips')}>
          <button type="button" aria-pressed={!bright} onClick={() => sh.setGround('dark')}>
            {tr('lootfilter_advanced_views_OverviewView.dark_ground')}
          </button>
          <button type="button" aria-pressed={bright} onClick={() => sh.setGround('bright')}>
            {tr('lootfilter_advanced_views_OverviewView.bright_ground')}
          </button>
        </span>
      </div>
      <div className="adv-ov-grid lf-scroll" aria-busy={loading}>
        {loading &&
          Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="adv-ov-card lf-card" data-lg="panel" style={{ padding: 14, gap: 10 }}>
              <span className="adv-ov-skel" style={{ width: '30%', height: 12 }} />
              <span className="adv-ov-skel" style={{ width: '70%', height: 12 }} />
              <span className="adv-ov-skel" style={{ width: '100%', height: 84 }} />
            </div>
          ))}
        {!loading && board.length === 0 && <div style={{ gridColumn: '1 / -1', padding: 24, color: 'var(--text-muted)' }}>{tr('lootfilter_advanced_views_OverviewView.neversink_s_file_has_no')}</div>}
        {board.map((c) => {
          const n = c.chips.length;
          return (
            <section key={c.id} className="adv-ov-card lf-card" data-lg="panel" data-card="">
              <div className="adv-ov-chead" title={c.note}>
                <span className="lf-eyebrow">{c.title.toUpperCase()}</span>
                <span style={{ color: 'var(--text-faint)', fontSize: 12, whiteSpace: 'nowrap' }}>{c.total > n ? tr('lootfilter_advanced_views_OverviewView.n_of_total_items', { n, total: c.total }) : tr('lootfilter_advanced_views_OverviewView.count_items', { count: n })}</span>
                <span style={{ flex: 1 }} />
                <button type="button" className="adv-sh-btn text sm" style={{ height: 26, padding: '0 8px' }} title={tr('lootfilter_advanced_views_OverviewView.open_title_in_customize', { title: c.title })} onClick={() => (c.section === 'build' ? (lf.setUi('advSection', 'build'), nav.setAdvancedView('customize')) : sh.goSection(c.section))}>
                  <Icon name="edit" size={14} />
                  {tr('lootfilter_advanced_views_OverviewView.edit')}
                </button>
              </div>
              <div className="adv-ov-ground" style={{ background: groundFor(bright ? 'bright' : 'desert') }}>
                <FitGroup>
                {c.chips.map((ch) =>
                  ch.kind === 'item' ? (
                    <AdvChip key={ch.item.name} item={ch.item} ghost={ghost} />
                  ) : ch.kind === 'rule' ? (
                    <RuleChip key={ch.rule.id} rule={ch.rule} name={ch.name} />
                  ) : (
                    <TierSample key={ch.tier.key} tier={ch.tier} name={ch.name} />
                  ),
                )}
                </FitGroup>
                {c.empty && <span style={{ color: bright ? 'rgba(24,20,14,.72)' : 'rgba(255,240,215,.62)', fontSize: 12.5 }}>{c.empty}</span>}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
