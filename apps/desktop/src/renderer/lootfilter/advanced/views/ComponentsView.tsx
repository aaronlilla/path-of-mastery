import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import type { LfNav } from '../../LootFilterArea';
import { formatPrice, useLf } from '../../lfStore';
import { LabelChip } from '../../LabelChip';
import { Dialog, Icon, Switch, useToast } from '../../../ui';
import { STRICTNESS } from '../../../../shared/lootfilter/styles.js';
import { Btn, Eyebrow, GroundBox, Head, Page, Panel, Seg, useGround } from '../strictness/kit';
import { useAdvShell } from '../shell/selection';
import { tr } from '../../../i18n';

type CTab = 'components' | 'states' | 'flows' | 'handoff';

const FOCUS: CSSProperties = { outline: '2px solid var(--gold-400)', outlineOffset: 2 };

function Spec({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return (
    <div className="adv-s-spec">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 6 }}>
        <span style={{ color: 'var(--text-2)', fontSize: 13 }}>{label}</span>
        {note ? <span style={{ color: 'var(--text-faint)', fontSize: 11.5, lineHeight: 1.4 }}>{note}</span> : null}
      </div>
      <div className="adv-s-states">{children}</div>
    </div>
  );
}

function St({ cap, children }: { cap: string; children: ReactNode }) {
  return (
    <div className="adv-s-state">
      {children}
      <span className="cap">{cap}</span>
    </div>
  );
}

/** The label box as the game draws it: the same two formulas LabelChip uses, shown as numbers. */
function geometry(pt: number): { size: number; fs: number; h: number; px: number; ratio: string } {
  const fs = Math.round(pt * 0.78);
  const h = Math.round(fs * 1.36);
  const px = Math.max(3, Math.round(fs * 0.2));
  return { size: pt, fs, h, px, ratio: (h / fs).toFixed(2) };
}

const TOKENS = ['--gold-300', '--gold-400', '--gold-600', '--surface-1', '--surface-3', '--text-display', '--text-strong', '--text-2', '--text-muted', '--positive-text', '--negative', '--warning', '--info', '--mod-crafted'];

const RAIL_SCREENS: { id: string; label: string }[] = [
  { id: 'filters', label: tr('lootfilter_advanced_views_ComponentsView.my_filters') },
  { id: 'overview', label: tr('lootfilter_advanced_views_ComponentsView.overview') },
  { id: 'customize', label: tr('lootfilter_advanced_views_ComponentsView.customize') },
  { id: 'simulate', label: tr('lootfilter_advanced_views_ComponentsView.simulate') },
  { id: 'themes', label: tr('lootfilter_advanced_views_ComponentsView.themes') },
  { id: 'advanced', label: tr('lootfilter_advanced_views_ComponentsView.advanced') },
  { id: 'export', label: tr('lootfilter_advanced_views_ComponentsView.export') },
  { id: 'components', label: tr('lootfilter_advanced_views_ComponentsView.components') },
];

interface Flow {
  title: string;
  sub: string;
  steps: { n: string; title: string; text: string; tag: string; go: () => void }[];
}

interface Specimen {
  tone: string;
  title: string;
  body: string;
  detail?: string;
  buttons: { label: string; primary?: boolean; go?: () => void }[];
}

/** Components: every control and state the loot filter uses, plus flows and handoff notes. */
export function ComponentsView({ nav }: { nav: LfNav }) {
  const lf = useLf();
  const toast = useToast();
  const shell = useAdvShell();
  const [ground, setGround] = useGround();
  const [tab, setTab] = useState<CTab>('components');
  const [seg, setSeg] = useState('Week');
  const [dlg, setDlg] = useState<Specimen | null>(null);

  const bright = ground === 'bright';
  const find = (n: string) => lf.catalog?.byName.get(n);
  const look = (n: string) => {
    const it = find(n);
    return it ? lf.evaluateCatalogItem(it)?.style ?? it.style : {};
  };
  const priceOf = (n: string): string | undefined => {
    const p = lf.prices?.byName[n]?.chaos;
    return p === undefined ? undefined : formatPrice(p, lf.prices?.divine ?? 0, lf.settings.currencyUnit);
  };
  // An item NeverSink really hides at the strictness in use, so "Hidden by strictness" is true of the label shown.
  const hiddenName = useMemo(() => {
    const c = lf.catalog;
    if (!c) return 'Orb of Alchemy';
    return c.byName.get('Orb of Alchemy')?.hidden ? 'Orb of Alchemy' : c.items.find((i) => i.type === 'currency' && i.hidden)?.name ?? 'Orb of Alchemy';
  }, [lf.catalog]);
  const labels: { cap: string; name: string; fs: number; price?: string; hidden?: boolean; locked?: boolean; ghost?: boolean }[] = [
    { cap: 'Size 18', name: 'Divine Orb', fs: 18 },
    { cap: 'Size 32', name: 'Divine Orb', fs: 32 },
    { cap: 'Size 45', name: 'Divine Orb', fs: 45 },
    { cap: tr('lootfilter_advanced_views_ComponentsView.with_price'), name: 'Chaos Orb', fs: 32, ...(priceOf('Chaos Orb') ? { price: priceOf('Chaos Orb')! } : {}) },
    { cap: tr('lootfilter_advanced_views_ComponentsView.hidden_by_strictness'), name: hiddenName, fs: 32, hidden: true },
    { cap: tr('lootfilter_advanced_views_ComponentsView.top_tier'), name: 'Mirror of Kalandra', fs: 45 },
    { cap: 'Locked', name: 'Exalted Orb', fs: 32, locked: true },
    { cap: tr('lootfilter_advanced_views_ComponentsView.ghosted_next_level_hides_it'), name: "Gemcutter's Prism", fs: 32, ghost: true },
  ];

  const folder = lf.gameFolder;
  const file = lf.doc.fileName;
  const kb = lf.gen ? Math.round(lf.gen.bytes / 1024) : 0;
  const errs: { tag: string; tone: string; border?: string; title: string; body: string; act: string; go: () => void; spec: Specimen }[] = [
    {
      tag: tr('lootfilter_advanced_views_ComponentsView_2.game_folder'), tone: 'var(--warning)', border: 'rgba(255,153,34,.35)', title: tr('lootfilter_advanced_views_ComponentsView.game_folder_not_found'), body: tr('lootfilter_advanced_views_ComponentsView.the_folder_was_moved_or'), act: tr('lootfilter_advanced_views_ComponentsView.choose_folder'), go: () => void lf.chooseFolder(),
      spec: { tone: 'var(--warning)', title: tr('lootfilter_advanced_views_ComponentsView.game_folder_not_found'), body: tr('lootfilter_advanced_views_ComponentsView.the_folder_set_for_this'), detail: folder, buttons: [{ label: tr('lootfilter_advanced_views_ComponentsView.not_now') }, { label: tr('lootfilter_advanced_views_ComponentsView.choose_folder'), primary: true }] },
    },
    {
      tag: tr('lootfilter_advanced_views_ComponentsView_2.write'), tone: 'var(--negative)', title: tr('lootfilter_advanced_views_ComponentsView.could_not_write_the_filter'), body: tr('lootfilter_advanced_views_ComponentsView.the_game_folder_refused_the'), act: tr('lootfilter_advanced_views_ComponentsView_2.open_export'), go: () => nav.setAdvancedView('export'),
      spec: { tone: 'var(--negative)', title: tr('lootfilter_advanced_views_ComponentsView.could_not_write_the_filter'), body: tr('lootfilter_advanced_views_ComponentsView.the_game_folder_did_not'), detail: `${folder}\\${file}`, buttons: [{ label: tr('lootfilter_advanced_views_ComponentsView.choose_another_folder'), go: () => nav.setAdvancedView('export') }, { label: tr('lootfilter_advanced_views_ComponentsView.try_again'), primary: true }] },
    },
    {
      tag: tr('lootfilter_advanced_views_ComponentsView_2.size'), tone: 'var(--warning)', border: 'rgba(255,153,34,.35)', title: tr('lootfilter_advanced_views_ComponentsView.filter_is_over_1_mb'), body: tr('lootfilter_advanced_views_ComponentsView.the_game_ignores_larger_filters'), act: tr('lootfilter_advanced_views_ComponentsView_2.open_strictness'), go: () => nav.setAdvancedView('strictness'),
      spec: { tone: 'var(--warning)', title: tr('lootfilter_advanced_views_ComponentsView.filter_is_over_the_1'), body: tr('lootfilter_advanced_views_ComponentsView.the_game_ignores_filters_larger'), detail: tr('lootfilter_advanced_views_ComponentsView.tolocalestring_kb_of_1_024', { kb: kb.toLocaleString(), value: lf.gen ? (lf.gen.baseBlocks + lf.gen.userBlocks).toLocaleString() : 0 }), buttons: [{ label: tr('lootfilter_advanced_views_ComponentsView.keep_name', { name: STRICTNESS[lf.doc.setup.strictness]?.name ?? 'this level' }) }, { label: tr('lootfilter_advanced_views_ComponentsView.raise_to_regular'), primary: true, go: () => nav.setAdvancedView('strictness') }] },
    },
    {
      tag: tr('lootfilter_advanced_views_ComponentsView_2.prices'), tone: 'var(--warning)', title: tr('lootfilter_advanced_views_ComponentsView.prices_are_out_of_date'), body: tr('lootfilter_advanced_views_ComponentsView.poe_ninja_could_not_be'), act: tr('lootfilter_advanced_views_ComponentsView_2.retry'), go: () => void lf.refreshPrices(true),
      spec: { tone: 'var(--warning)', title: tr('lootfilter_advanced_views_ComponentsView.prices_are_out_of_date'), body: tr('lootfilter_advanced_views_ComponentsView.poe_ninja_could_not_be'), buttons: [{ label: tr('lootfilter_advanced_views_ComponentsView.keep_old_prices') }, { label: tr('lootfilter_advanced_views_ComponentsView.retry'), primary: true }] },
    },
    {
      tag: tr('lootfilter_advanced_views_ComponentsView_2.build'), tone: 'var(--negative)', title: tr('lootfilter_advanced_views_ComponentsView.could_not_read_the_build'), body: tr('lootfilter_advanced_views_ComponentsView.the_build_code_is_not'), act: tr('lootfilter_advanced_views_ComponentsView_2.open_build'), go: () => nav.setAdvancedView('build'),
      spec: { tone: 'var(--negative)', title: tr('lootfilter_advanced_views_ComponentsView.could_not_read_the_build'), body: tr('lootfilter_advanced_views_ComponentsView.the_build_code_is_not'), buttons: [{ label: tr('lootfilter_advanced_views_ComponentsView.cancel') }, { label: tr('lootfilter_advanced_views_ComponentsView.open_build'), primary: true, go: () => nav.setAdvancedView('build') }] },
    },
    {
      tag: tr('lootfilter_advanced_views_ComponentsView_2.offline'), tone: 'var(--info)', title: tr('lootfilter_advanced_views_ComponentsView.you_are_offline'), body: tr('lootfilter_advanced_views_ComponentsView.everything_here_still_works_prices'), act: tr('lootfilter_advanced_views_ComponentsView_2.dismiss'), go: () => toast({ text: tr('lootfilter_advanced_views_ComponentsView.offline_mode'), kind: 'info' }),
      spec: { tone: 'var(--info)', title: tr('lootfilter_advanced_views_ComponentsView.you_are_offline'), body: tr('lootfilter_advanced_views_ComponentsView.everything_here_still_works_prices'), buttons: [{ label: tr('lootfilter_advanced_views_ComponentsView.ok'), primary: true }] },
    },
  ];

  const flows: Flow[] = [
    {
      title: tr('lootfilter_advanced_views_ComponentsView.make_a_filter_from_the'), sub: tr('lootfilter_advanced_views_ComponentsView.under_10_seconds'),
      steps: [
        { n: '1', title: tr('lootfilter_advanced_views_ComponentsView.start'), text: tr('lootfilter_advanced_views_ComponentsView.open_the_app_on_start'), tag: tr('lootfilter_advanced_views_ComponentsView_2.open_start'), go: () => nav.setAdvancedView('start') },
        { n: '2', title: tr('lootfilter_advanced_views_ComponentsView.make_filter'), text: tr('lootfilter_advanced_views_ComponentsView.one_click_reads_the_build'), tag: tr('lootfilter_advanced_views_ComponentsView_2.open_start'), go: () => nav.setAdvancedView('start') },
        { n: '3', title: tr('lootfilter_advanced_views_ComponentsView.overview'), text: tr('lootfilter_advanced_views_ComponentsView.chips_preview_the_result_nothing'), tag: tr('lootfilter_advanced_views_ComponentsView_2.open_overview'), go: () => nav.setAdvancedView('overview') },
        { n: '4', title: tr('lootfilter_advanced_views_ComponentsView.write_to_game'), text: tr('lootfilter_advanced_views_ComponentsView.one_click_writes_the_file'), tag: tr('lootfilter_advanced_views_ComponentsView_2.open_export'), go: () => nav.setAdvancedView('export') },
      ],
    },
    {
      title: tr('lootfilter_advanced_views_ComponentsView.ask_for_a_change'), sub: tr('lootfilter_advanced_views_ComponentsView.plain_language_reviewed_before_it'),
      steps: [
        { n: '1', title: tr('lootfilter_advanced_views_ComponentsView.ask'), text: tr('lootfilter_advanced_views_ComponentsView.open_the_ask_panel_and'), tag: tr('lootfilter_advanced_views_ComponentsView_2.open_ask_panel'), go: () => { nav.setAdvancedView('overview'); shell.openAsk(); } },
        { n: '2', title: tr('lootfilter_advanced_views_ComponentsView.plan'), text: tr('lootfilter_advanced_views_ComponentsView.the_agent_states_what_it'), tag: tr('lootfilter_advanced_views_ComponentsView_2.open_ask_panel'), go: () => shell.openAsk() },
        { n: '3', title: tr('lootfilter_advanced_views_ComponentsView.review'), text: tr('lootfilter_advanced_views_ComponentsView.every_change_is_listed_with'), tag: tr('lootfilter_advanced_views_ComponentsView_2.open_diff_review'), go: () => nav.setAdvancedView('diff') },
        { n: '4', title: tr('lootfilter_advanced_views_ComponentsView.apply'), text: tr('lootfilter_advanced_views_ComponentsView.apply_all_or_a_selection'), tag: tr('lootfilter_advanced_views_ComponentsView_2.open_diff_review'), go: () => nav.setAdvancedView('diff') },
      ],
    },
    {
      title: tr('lootfilter_advanced_views_ComponentsView.why_did_this_show'), sub: tr('lootfilter_advanced_views_ComponentsView.one_click_from_any_chip'),
      steps: [
        { n: '1', title: tr('lootfilter_advanced_views_ComponentsView.select'), text: tr('lootfilter_advanced_views_ComponentsView.click_a_chip_in_overview'), tag: tr('lootfilter_advanced_views_ComponentsView_2.open_overview'), go: () => nav.setAdvancedView('overview') },
        { n: '2', title: tr('lootfilter_advanced_views_ComponentsView.explain'), text: tr('lootfilter_advanced_views_ComponentsView.double_click_or_press_e'), tag: tr('lootfilter_advanced_views_ComponentsView_2.open_explain_drawer'), go: () => { nav.setAdvancedView('overview'); shell.explain('Divine Orb'); } },
        { n: '3', title: tr('lootfilter_advanced_views_ComponentsView.jump'), text: tr('lootfilter_advanced_views_ComponentsView.go_to_the_rule_that'), tag: tr('lootfilter_advanced_views_ComponentsView_2.open_customize'), go: () => nav.setAdvancedView('customize') },
        { n: '4', title: tr('lootfilter_advanced_views_ComponentsView.change'), text: tr('lootfilter_advanced_views_ComponentsView.edit_look_or_move_tier'), tag: tr('lootfilter_advanced_views_ComponentsView_2.open_inspector'), go: () => { nav.setAdvancedView('customize'); shell.openInspector(); } },
      ],
    },
    {
      title: tr('lootfilter_advanced_views_ComponentsView.keep_the_filter_current'), sub: tr('lootfilter_advanced_views_ComponentsView.suggestions_only_you_decide'),
      steps: [
        { n: '1', title: tr('lootfilter_advanced_views_ComponentsView.adapt'), text: tr('lootfilter_advanced_views_ComponentsView.suggestions_arrive_from_your_play'), tag: tr('lootfilter_advanced_views_ComponentsView_2.open_inbox'), go: () => nav.setAdvancedView('adapt') },
        { n: '2', title: tr('lootfilter_advanced_views_ComponentsView.retier'), text: tr('lootfilter_advanced_views_ComponentsView.prices_move_items_between_tiers'), tag: tr('lootfilter_advanced_views_ComponentsView_2.open_retier'), go: () => nav.setAdvancedView('retier') },
        { n: '3', title: tr('lootfilter_advanced_views_ComponentsView.update'), text: tr('lootfilter_advanced_views_ComponentsView.neversink_updates_merge_with_your'), tag: tr('lootfilter_advanced_views_ComponentsView_2.open_update'), go: () => nav.setAdvancedView('update') },
        { n: '4', title: tr('lootfilter_advanced_views_ComponentsView.write'), text: tr('lootfilter_advanced_views_ComponentsView.write_the_merged_file'), tag: tr('lootfilter_advanced_views_ComponentsView_2.open_export'), go: () => nav.setAdvancedView('export') },
      ],
    },
  ];

  const screens: { l: string; go: () => void }[] = [
    ...RAIL_SCREENS.map((s) => ({ l: s.label, go: () => nav.setAdvancedView(s.id) })),
    { l: tr('lootfilter_advanced_views_ComponentsView.diff_review'), go: () => nav.setAdvancedView('diff') },
    { l: tr('lootfilter_advanced_views_ComponentsView_2.settings'), go: () => shell.openSettings() },
    { l: tr('lootfilter_advanced_views_ComponentsView.command_palette'), go: () => shell.openPalette() },
    { l: tr('lootfilter_advanced_views_ComponentsView_2.explain'), go: () => shell.explain('Divine Orb') },
    ...errs.map((e) => ({ l: tr('lootfilter_advanced_views_ComponentsView.dialog_tolowercase', { tag: e.tag.toLowerCase() }), go: () => setDlg(e.spec) })),
  ];

  const downloadBundle = (): void => {
    const body = JSON.stringify(
      {
        app: tr('lootfilter_advanced_views_ComponentsView.path_of_mastery_loot_filter'),
        label: { font: 'Fontin SmallCaps', pxPerPt: 0.78, padEm: 0.2, lineEm: 1.36, border: 1, clamp: [18, 45], sizes: [18, 32, 45].map((p) => ({ pt: p, ...geometry(p) })) },
        strictness: STRICTNESS.map((s) => s.name),
        screens: screens.map((s) => s.l),
        dialogs: errs.map((e) => e.tag.toLowerCase()),
      },
      null,
      2,
    );
    try {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
      a.download = 'loot-filter-handoff.json';
      a.click();
      toast({ text: tr('lootfilter_advanced_views_ComponentsView.downloaded_loot_filter_handoff_json'), kind: 'ok' });
    } catch {
      toast({ text: tr('lootfilter_advanced_views_ComponentsView.the_handoff_file_could_not'), kind: 'error' });
    }
  };

  const tabOpts: { value: CTab; label: string; icon?: string }[] = [
    { value: 'components', label: tr('lootfilter_advanced_views_ComponentsView.components'), icon: 'layers' },
    { value: 'states', label: tr('lootfilter_advanced_views_ComponentsView.states_and_errors') },
    { value: 'flows', label: tr('lootfilter_advanced_views_ComponentsView.flows') },
    { value: 'handoff', label: tr('lootfilter_advanced_views_ComponentsView.handoff') },
  ];
  const cb: CSSProperties = { width: 15, height: 15, accentColor: 'var(--gold-400)', margin: 0 };
  const mute = bright ? 'rgba(24,20,14,.86)' : 'rgba(255,240,215,.62)';

  return (
    <Page>
      <Head title={tr('lootfilter_advanced_views_ComponentsView.components')} sub={tr('lootfilter_advanced_views_ComponentsView.every_control_and_state_used')}>
        <Seg<CTab> value={tab} label={tr('lootfilter_advanced_views_ComponentsView.section')} options={tabOpts} onChange={setTab} />
      </Head>

      {tab === 'components' && (
        <div className="lf-card" style={{ padding: '6px 18px 12px', display: 'flex', flexDirection: 'column' }}>
          {([
            [tr('lootfilter_advanced_views_ComponentsView_2.primary_button'), 'gold'],
            [tr('lootfilter_advanced_views_ComponentsView_2.secondary_button'), ''],
            [tr('lootfilter_advanced_views_ComponentsView_2.text_button'), 'text'],
            [tr('lootfilter_advanced_views_ComponentsView_2.destructive_button'), 'danger'],
          ] as const).map(([label, kind]) => (
            <Spec key={label} label={label}>
              {([tr('lootfilter_advanced_views_ComponentsView_2.default'), tr('lootfilter_advanced_views_ComponentsView_2.hover'), tr('lootfilter_advanced_views_ComponentsView_2.focus'), tr('lootfilter_advanced_views_ComponentsView_2.disabled')] as const).map((cap) => (
                <St key={cap} cap={cap}>
                  <button
                    type="button"
                    className={'adv-s-btn' + (kind ? ' ' + kind : '')}
                    disabled={cap === 'Disabled'}
                    style={{ padding: '0 14px', fontSize: 13, ...(cap === 'Focus' ? FOCUS : cap === 'Hover' ? (kind === 'gold' || kind === 'danger' ? { filter: 'brightness(1.1)' } : kind === 'text' ? { background: 'rgba(var(--accent-rgb),.1)' } : { borderColor: 'rgba(var(--accent-rgb),.45)', color: 'var(--text-strong)' }) : undefined) }}
                  >
                    <Icon name="gamepad" size={14} />
                    {tr('lootfilter_advanced_views_ComponentsView.write_to_game')}
                  </button>
                </St>
              ))}
            </Spec>
          ))}
          <Spec label={tr('lootfilter_advanced_views_ComponentsView.toggle')}>
            <St cap="Off"><Switch checked={false} onChange={() => undefined} label={tr('lootfilter_advanced_views_ComponentsView.off_example')} /></St>
            <St cap="On"><Switch checked onChange={() => undefined} label={tr('lootfilter_advanced_views_ComponentsView.on_example')} /></St>
            <St cap={tr('lootfilter_advanced_views_ComponentsView_2.focus')}><span style={{ ...FOCUS, borderRadius: 10, display: 'inline-flex' }}><Switch checked label={tr('lootfilter_advanced_views_ComponentsView.focus_example')} onChange={() => undefined} /></span></St>
            <St cap={tr('lootfilter_advanced_views_ComponentsView_2.disabled')}><span style={{ opacity: 0.45, display: 'inline-flex' }}><Switch checked disabled label={tr('lootfilter_advanced_views_ComponentsView.disabled_example')} onChange={() => undefined} /></span></St>
          </Spec>
          <Spec label={tr('lootfilter_advanced_views_ComponentsView.checkbox')}>
            <St cap="Unchecked"><input type="checkbox" style={cb} aria-label={tr('lootfilter_advanced_views_ComponentsView.unchecked_example')} readOnly /></St>
            <St cap="Checked"><input type="checkbox" checked style={cb} aria-label={tr('lootfilter_advanced_views_ComponentsView.checked_example')} readOnly /></St>
            <St cap={tr('lootfilter_advanced_views_ComponentsView_2.disabled')}><input type="checkbox" disabled style={cb} aria-label={tr('lootfilter_advanced_views_ComponentsView.disabled_example')} /></St>
          </Spec>
          <Spec label={tr('lootfilter_advanced_views_ComponentsView.text_field')}>
            <St cap={tr('lootfilter_advanced_views_ComponentsView_2.default')}><input className="input" style={{ width: 200, fontSize: 13 }} placeholder={tr('lootfilter_advanced_views_ComponentsView.search_items')} aria-label={tr('lootfilter_advanced_views_ComponentsView.default_example')} /></St>
            <St cap={tr('lootfilter_advanced_views_ComponentsView_2.focus')}><input className="input" style={{ width: 200, fontSize: 13, borderColor: 'rgba(var(--accent-rgb),.6)' }} defaultValue="Divine" aria-label={tr('lootfilter_advanced_views_ComponentsView.focus_example')} /></St>
            <St cap="Error"><input className="input bad" style={{ width: 200, fontSize: 13 }} defaultValue="Stygian Vse" aria-label={tr('lootfilter_advanced_views_ComponentsView.error_example')} /></St>
            <St cap={tr('lootfilter_advanced_views_ComponentsView_2.disabled')}><input className="input" style={{ width: 200, fontSize: 13, opacity: 0.4 }} disabled placeholder={tr('lootfilter_advanced_views_ComponentsView.read_only')} aria-label={tr('lootfilter_advanced_views_ComponentsView.disabled_example')} /></St>
          </Spec>
          <Spec label={tr('lootfilter_advanced_views_ComponentsView.segmented_control')}>
            <St cap=""><Seg value={seg} options={['Day', 'Week', 'League'].map((v) => ({ value: v, label: v }))} onChange={setSeg} /></St>
          </Spec>
          <Spec label={tr('lootfilter_advanced_views_ComponentsView.tags')}>
            <St cap="Neutral"><span className="adv-s-tag">{tr('lootfilter_advanced_views_ComponentsView.local')}</span></St>
            <St cap="Accent"><span className="adv-s-tag accent">{tr('lootfilter_advanced_views_ComponentsView.recommended')}</span></St>
            <St cap="Warning"><span className="adv-s-tag warn">{tr('lootfilter_advanced_views_ComponentsView.conflict')}</span></St>
            <St cap="Hidden tag">
              <GroundBox kind={ground}>
                <span style={{ font: '500 10.5px Geist', padding: '1px 5px', borderRadius: 4, border: `1px dashed ${mute}`, color: mute }}>{tr('lootfilter_advanced_views_ComponentsView.hidden')}</span>
              </GroundBox>
            </St>
          </Spec>
          <Spec label={tr('lootfilter_advanced_views_ComponentsView.sync_status')}>
            <St cap="Local only"><span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)', fontSize: 12.5 }}><Icon name="monitor" size={12} />{tr('lootfilter_advanced_views_ComponentsView.local_only')}</span></St>
            <St cap="Written to game"><span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--positive-text)', fontSize: 12.5 }}><Icon name="gamepad" size={12} />{tr('lootfilter_advanced_views_ComponentsView.written_to_game')}</span></St>
            <St cap="Synced to account"><span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--info)', fontSize: 12.5 }}><Icon name="cloud-check" size={12} />{tr('lootfilter_advanced_views_ComponentsView.synced_to_account')}</span></St>
            <St cap="Conflict"><span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--negative-text)', fontSize: 12.5 }}><Icon name="warning" size={12} />{tr('lootfilter_advanced_views_ComponentsView.conflict_2')}</span></St>
          </Spec>
          <Spec label={tr('lootfilter_advanced_views_ComponentsView.menu_item')}>
            <St cap={tr('lootfilter_advanced_views_ComponentsView_2.default')}><div className="menu-item" style={{ width: 220 }}>{tr('lootfilter_advanced_views_ComponentsView.move_to_tier')}</div></St>
            <St cap={tr('lootfilter_advanced_views_ComponentsView_2.hover')}><div className="menu-item" data-active="true" style={{ width: 220 }}>{tr('lootfilter_advanced_views_ComponentsView.move_to_tier')}</div></St>
            <St cap="Danger"><div className="menu-item danger" style={{ width: 220 }}>{tr('lootfilter_advanced_views_ComponentsView.hide_item')}</div></St>
          </Spec>
          <Spec label={tr('lootfilter_advanced_views_ComponentsView.toast')}>
            <St cap="With action">
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '10px 14px', borderRadius: 10, border: '1px solid rgba(var(--line-rgb),.14)', background: 'rgba(var(--shadow-rgb),calc(.4*var(--shadow-k)))', color: 'var(--text-strong)', fontSize: 13 }}>
                <span>{tr('lootfilter_advanced_views_ComponentsView.moved_divine_orb_to_a')}</span>
                <span style={{ color: 'var(--gold-text)', fontWeight: 600 }}>{tr('lootfilter_advanced_views_ComponentsView.undo')}</span>
              </div>
            </St>
          </Spec>
          <Spec label={tr('lootfilter_advanced_views_ComponentsView.item_label')} note={tr('lootfilter_advanced_views_ComponentsView.drawn_as_the_game_draws')}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minWidth: 0 }}>
              <Seg<'dark' | 'bright'> value={ground} label={tr('lootfilter_advanced_views_ComponentsView.ground')} options={[{ value: 'dark', label: tr('lootfilter_advanced_views_ComponentsView.dark_ground') }, { value: 'bright', label: tr('lootfilter_advanced_views_ComponentsView.bright_ground') }]} onChange={setGround} />
              {!lf.catalog ? (
                <span className="adv-s-faint">{lf.baseLoading ? tr('lootfilter_advanced_views_ComponentsView.reading_neversink') : tr('lootfilter_advanced_views_ComponentsView.no_neversink_items_loaded')}</span>
              ) : (
                <div className="adv-s-labels" style={{ background: bright ? 'radial-gradient(120% 90% at 50% 40%,#d8d2c4,#a9a292)' : 'radial-gradient(120% 90% at 50% 40%,#2a2419,#0d0b08)' }}>
                  {labels.map((x) => (
                    <div key={x.cap} style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start', opacity: x.ghost ? 0.55 : 1 }}>
                      <LabelChip name={x.name} style={look(x.name)} fontPx={Math.round(x.fs * 0.78)} bright={bright} {...(x.price ? { price: x.price } : {})} {...(x.hidden ? { hidden: true, hiddenLook: 'fade' as const, hidTag: 'Hidden' } : {})} {...(x.locked ? { locked: true } : {})} />
                      <span style={{ font: "500 11px 'Geist Mono'", color: mute }}>{x.cap}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Spec>
        </div>
      )}

      {tab === 'states' && (
        <>
          <div className="adv-s-errs">
            {errs.map((c) => (
              <div key={c.tag} className="lf-card adv-s-err" style={c.border ? { borderColor: c.border } : undefined}>
                <div className="adv-s-row">
                  <span className="adv-s-dot" style={{ background: c.tone }} />
                  <Eyebrow>{c.tag}</Eyebrow>
                </div>
                <h4>{c.title}</h4>
                <span style={{ color: 'var(--text-2)', lineHeight: 1.5, fontSize: 13 }}>{c.body}</span>
                <div className="adv-s-row" style={{ marginTop: 'auto', paddingTop: 4 }}>
                  <Btn onClick={c.go}>{c.act}</Btn>
                  <Btn kind="ghost" icon="window-max" onClick={() => setDlg(c.spec)}>
                    {tr('lootfilter_advanced_views_ComponentsView.show_as_dialog')}
                  </Btn>
                </div>
              </div>
            ))}
          </div>
          <div className="adv-s-two2">
            <Panel>
              <Eyebrow>{tr('lootfilter_advanced_views_ComponentsView.loading')}</Eyebrow>
              <span className="adv-s-muted">{tr('lootfilter_advanced_views_ComponentsView.reading_the_build_sections_appear')}</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <span className="adv-s-skel" style={{ width: '40%', height: 14 }} />
                <span className="adv-s-skel" style={{ width: '100%', height: 48 }} />
                <span className="adv-s-skel" style={{ width: '86%', height: 48 }} />
                <span className="adv-s-skel" style={{ width: '64%', height: 48 }} />
              </div>
              <div>
                <Btn icon="eye" onClick={() => nav.setAdvancedView('overview')}>{tr('lootfilter_advanced_views_ComponentsView.preview_in_overview')}</Btn>
              </div>
            </Panel>
            <Panel>
              <Eyebrow>{tr('lootfilter_advanced_views_ComponentsView.empty')}</Eyebrow>
              <span style={{ font: "600 19px 'Cormorant Garamond', serif", color: 'var(--text-display)' }}>{tr('lootfilter_advanced_views_ComponentsView.no_rules_yet')}</span>
              <span style={{ color: 'var(--text-2)', fontSize: 13, lineHeight: 1.5 }}>{tr('lootfilter_advanced_views_ComponentsView.this_filter_has_no_custom')}</span>
              <div className="adv-s-row">
                <Btn icon="wand" onClick={() => nav.setAdvancedView('build')}>{tr('lootfilter_advanced_views_ComponentsView.make_rules_from_build')}</Btn>
                <Btn icon="sparkle-fill" onClick={() => shell.openAsk()}>{tr('lootfilter_advanced_views_ComponentsView.ask')}</Btn>
              </div>
            </Panel>
          </div>
        </>
      )}

      {tab === 'flows' &&
        flows.map((f) => (
          <Panel key={f.title}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ font: "600 20px 'Cormorant Garamond', serif", color: 'var(--text-display)' }}>{f.title}</span>
              <span className="adv-s-muted">{f.sub}</span>
            </div>
            <div className="adv-s-flowsteps">
              {f.steps.map((s) => (
                <button key={s.n} type="button" className="adv-s-flowstep" onClick={s.go}>
                  <span style={{ font: "600 10.5px 'Geist Mono'", color: 'var(--gold-label)' }}>{s.n}</span>
                  <span style={{ color: 'var(--text-strong)', fontSize: 13, lineHeight: 1.35 }}>{s.title}</span>
                  <span style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.4 }}>{s.text}</span>
                  <span style={{ color: 'var(--gold-text)', fontSize: 12, marginTop: 'auto' }}>{s.tag} {'→'}</span>
                </button>
              ))}
            </div>
          </Panel>
        ))}

      {tab === 'handoff' && (
        <div className="adv-s-two2">
          <div className="adv-s-col">
            <Panel>
              <Eyebrow>{tr('lootfilter_advanced_views_ComponentsView.label_geometry')}</Eyebrow>
              <span className="adv-s-muted">{tr('lootfilter_advanced_views_ComponentsView.one_mapping_for_every_preview')}</span>
              <div className="adv-s-geom">
                {[tr('lootfilter_advanced_views_ComponentsView_2.size_2'), tr('lootfilter_advanced_views_ComponentsView_2.text'), tr('lootfilter_advanced_views_ComponentsView_2.height'), tr('lootfilter_advanced_views_ComponentsView_2.side_pad'), tr('lootfilter_advanced_views_ComponentsView_2.ratio')].map((h) => (
                  <span key={h} style={{ color: 'var(--text-faint)' }}>{h}</span>
                ))}
                {[18, 32, 45].flatMap((pt) => {
                  const g = geometry(pt);
                  return [`${g.size}`, `${g.fs}px`, `${g.h}px`, `${g.px}px`, g.ratio].map((v, i) => <span key={`${pt}:${i}`}>{v}</span>);
                })}
              </div>
            </Panel>
            <Panel>
              <Eyebrow>{tr('lootfilter_advanced_views_ComponentsView.type')}</Eyebrow>
              {[
                [tr('lootfilter_advanced_views_ComponentsView_2.screen_title'), "600 24px 'Cormorant Garamond'", 'Overview'],
                [tr('lootfilter_advanced_views_ComponentsView_2.eyebrow'), '600 10.5px Geist', tr('lootfilter_advanced_views_ComponentsView_2.game_folder')],
                [tr('lootfilter_advanced_views_ComponentsView_2.body'), '400 13.5px Geist', tr('lootfilter_advanced_views_ComponentsView.hides_currency_worth_less_than')],
                [tr('lootfilter_advanced_views_ComponentsView_2.code'), "500 12.5px 'Geist Mono'", tr('lootfilter_advanced_views_ComponentsView.show_boots_from_the_build')],
                [tr('lootfilter_advanced_views_ComponentsView_2.in_game_label'), "400 25px 'Fontin SmallCaps'", 'Divine Orb'],
              ].map(([k, f, s]) => (
                <div key={k} className="adv-s-trow2">
                  <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{k}</span>
                  <span style={{ font: f, color: 'var(--text-strong)' }}>{s}</span>
                </div>
              ))}
            </Panel>
          </div>
          <div className="adv-s-col">
            <Panel>
              <Eyebrow>{tr('lootfilter_advanced_views_ComponentsView.tokens_in_use')}</Eyebrow>
              <div className="adv-s-tokens">
                {TOKENS.map((k) => (
                  <div key={k} className="adv-s-row">
                    <span style={{ flex: 'none', width: 22, height: 22, borderRadius: 6, background: `var(${k})`, boxShadow: 'inset 0 0 0 1px rgba(var(--line-rgb),.2)' }} />
                    <span style={{ font: "500 11px 'Geist Mono'", color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{k}</span>
                  </div>
                ))}
              </div>
            </Panel>
            <Panel>
              <Eyebrow>{tr('lootfilter_advanced_views_ComponentsView.screens')}</Eyebrow>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {screens.map((s) => (
                  <Btn key={s.l} small onClick={s.go}>{s.l}</Btn>
                ))}
              </div>
            </Panel>
            <Panel>
              <Eyebrow>{tr('lootfilter_advanced_views_ComponentsView.open_items')}</Eyebrow>
              {[
                [tr('lootfilter_advanced_views_ComponentsView.fontin_smallcaps_is_loaded_from'), 'var(--warning)'],
                [tr('lootfilter_advanced_views_ComponentsView.sound_minimap_icon_and_beam'), 'var(--positive-text)'],
                [tr('lootfilter_advanced_views_ComponentsView.chips_never_take_theme_colours'), 'var(--positive-text)'],
                [tr('lootfilter_advanced_views_ComponentsView.prices_come_from_poe_ninja'), 'var(--text-muted)'],
              ].map(([t, c]) => (
                <div key={t} className="adv-s-row" style={{ alignItems: 'flex-start' }}>
                  <span className="adv-s-dot" style={{ background: c, marginTop: 6 }} />
                  <span style={{ color: 'var(--text-2)', fontSize: 13, lineHeight: 1.45 }}>{t}</span>
                </div>
              ))}
              <div>
                <Btn icon="download" onClick={downloadBundle}>{tr('lootfilter_advanced_views_ComponentsView.download_handoff_bundle')}</Btn>
              </div>
            </Panel>
          </div>
        </div>
      )}

      {dlg && (
        <Dialog
          size="small"
          icon={dlg.tone === 'var(--negative)' ? 'error' : dlg.tone === 'var(--info)' ? 'info' : 'warning'}
          title={dlg.title}
          cancelLabel={null}
          confirmLabel={dlg.buttons.find((b) => b.primary)?.label ?? tr('lootfilter_advanced_views_ComponentsView.ok')}
          altLabel={dlg.buttons.length > 1 ? dlg.buttons.find((b) => !b.primary)?.label : undefined}
          onAlt={() => {
            const b = dlg.buttons.find((x) => !x.primary);
            setDlg(null);
            b?.go?.();
          }}
          onCancel={() => setDlg(null)}
          onConfirm={() => {
            const b = dlg.buttons.find((x) => x.primary);
            setDlg(null);
            b?.go?.();
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <span style={{ color: 'var(--text-2)', lineHeight: 1.5 }}>{dlg.body}</span>
            {dlg.detail && <pre style={{ margin: 0, padding: '8px 10px', borderRadius: 8, background: 'rgba(var(--shadow-rgb),calc(.3*var(--shadow-k)))', color: 'var(--text-muted)', font: "500 12px 'Geist Mono'", whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{dlg.detail}</pre>}
          </div>
        </Dialog>
      )}
    </Page>
  );
}
