import { useEffect, useMemo, useRef, useState } from 'react';
import type { LfNav } from '../../LootFilterArea';
import { useLf } from '../../lfStore';
import { useToast } from '../../../ui';
import type { Block } from '../../../../shared/lootfilter/types.js';
import { validateFilter, type Issue } from '../../../../shared/lootfilter/syntax.js';
import { useSharedPreflight } from '../export/usePreflight';
import { diagnose, yourRulesView, type Diag, type MatchItem } from '../../../../shared/lootfilter/yourRules.js';
import { Btn, Eyebrow, Head, Page, Seg, useWindow } from '../strictness/kit';
import { highlight } from '../raw/highlight';
import { isEditable, rulesToText, textToRules } from '../raw/convert';
import { tr } from '../../../i18n';
import { diagSummaryText, lfNet, lfText } from '../../mainText';

const ROW = 22;
const OB_ROW = 32;
const GUTTER = 56;

type Tab = 'mine' | 'full';

interface OutlineRow {
  kind: 'Show' | 'Hide' | 'Min';
  name: string;
  /** Line in the text on screen. */
  line: number;
  end: number;
}

function Tokens({ text }: { text: string }) {
  return (
    <>
      {highlight(text).map((k, i) => (
        <span key={i} style={{ color: k.c }}>
          {k.s}
        </span>
      ))}
    </>
  );
}

function CodeLine({ n, text, on, sev, top, onClick }: { n: number; text: string; on: boolean; sev?: 'error' | 'warning'; top: number; onClick: () => void }) {
  return (
    <div className={'adv-s-ln' + (on ? ' on' : '') + (sev === 'error' ? ' err' : sev === 'warning' ? ' warn' : '')} style={{ top }} onClick={onClick} data-line={n}>
      <span>{n}</span>
      <span>
        <Tokens text={text} />
      </span>
    </div>
  );
}

/** A text box that shows the same colours as the read view: the coloured text sits under a see-through textarea. */
function CodeEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const lines = value.split('\n');
  const widest = lines.reduce((m, l) => Math.max(m, l.length), 0);
  return (
    <div className="adv-s-codescroll">
      <div className="adv-s-editbox" style={{ height: (lines.length + 1) * ROW, minWidth: `calc(${GUTTER}px + ${widest + 4}ch)` }}>
        {lines.map((l, i) => (
          <div key={i} className="adv-s-ln static" style={{ top: i * ROW }}>
            <span>{i + 1}</span>
            <span>
              <Tokens text={l} />
            </span>
          </div>
        ))}
        <textarea className="adv-s-edit" value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} wrap="off" aria-label={tr('lootfilter_advanced_views_RawView.filter_code_for_your_rules')} autoFocus />
      </div>
    </div>
  );
}

const dotColour = (k: Diag['kind']): string => (k === 'error' ? 'var(--negative)' : k === 'warning' ? 'var(--warning)' : k === 'info' ? 'var(--info)' : 'var(--positive-text)');

/** Advanced: the player's own rules as filter code (and the whole generated file), with an outline, diagnostics and an editor. */
export function RawView({ nav: _nav }: { nav: LfNav }) {
  const lf = useLf();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('mine');
  const [line, setLine] = useState(1);
  const [jump, setJump] = useState<{ line: number; n: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [draftIssues, setDraftIssues] = useState<Issue[]>([]);
  const [busy, setBusy] = useState(false);

  const gen = lf.gen;
  const buildName = lf.doc.buildName ?? lf.build?.name ?? '';
  const yv = useMemo(() => (gen ? yourRulesView(gen.text, gen.baseStartLine, lf.doc.name, buildName || undefined) : null), [gen, lf.doc.name, buildName]);
  const fullLines = useMemo(() => (gen ? gen.text.split('\n') : []), [gen]);
  const lines = tab === 'mine' ? yv?.lines ?? [] : fullLines;
  const fromFile = (n: number): number | null => (tab === 'mine' ? yv?.fromFile(n) ?? null : n);
  const win = useWindow(editing ? 0 : lines.length, ROW, 20);

  const tierStyle = (t: { type: string; tier: string }) => lf.catalog?.tierByKey.get(`${t.type}|${t.tier}`)?.style;

  // Outline of the blocks on screen.
  const outline = useMemo<OutlineRow[]>(() => {
    const rows: OutlineRow[] = [];
    const rules = new Map(lf.doc.rules.map((r) => [r.id, r]));
    for (const b of lf.genBlocks as Block[]) {
      const at = fromFile(b.line);
      if (at === null || (tab === 'mine' && !b.ruleId)) continue;
      let name = '';
      if (b.ruleId) name = rules.get(b.ruleId)?.name ?? b.headerComment.replace(/^#\s*/, '').replace(/pom:rule=\S+\s*/, '');
      else if (b.tag) name = `${b.tag.type} ${b.tag.tier}`;
      else name = b.headerComment.replace(/^#\s*/, '').replace(/%[A-Z]+\d*/g, '').trim();
      rows.push({ kind: b.kind === 'Minimal' ? 'Min' : b.kind, name: name.trim() || tr('lootfilter_advanced_views_RawView_2.unnamed_block'), line: at, end: at + (b.endLine - b.line) });
    }
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lf.genBlocks, lf.doc.rules, tab, yv]);
  const ow = useWindow(outline.length, OB_ROW, 10);

  // Real problems, with the line shown on screen.
  const universe = useMemo<MatchItem[]>(() => {
    const seen = new Map<string, MatchItem>();
    for (const it of lf.catalog?.items ?? []) seen.set(it.name, it.class ? { name: it.name, class: it.class } : { name: it.name });
    for (const b of lf.engineBases?.bases ?? []) if (!seen.has(b.name)) seen.set(b.name, { name: b.name, class: b.class });
    return [...seen.values()];
  }, [lf.catalog, lf.engineBases]);
  const pre = useSharedPreflight();
  const diags = useMemo<Diag[]>(() => {
    if (!gen || !lf.validation) return [];
    return diagnose({ blocks: lf.genBlocks, issues: lf.validation.issues, rules: lf.doc.rules, baseStartLine: gen.baseStartLine, bytes: gen.bytes, universe, lineOf: (n) => fromFile(n), scope: tab === 'mine' ? 'rules' : 'file', warnings: pre.list });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gen, lf.validation, lf.genBlocks, lf.doc.rules, universe, tab, yv, pre.list]);
  const sevByLine = useMemo(() => {
    const m = new Map<number, 'error' | 'warning'>();
    for (const d of diags) if (d.kind === 'error' || d.kind === 'warning') if (m.get(d.line) !== 'error') m.set(d.line, d.kind);
    return m;
  }, [diags]);

  const others = lf.doc.rules.filter((r) => r.enabled && !isEditable(r)).length;
  const editDiags = useMemo<Diag[]>(() => {
    const out: Diag[] = draftIssues.map((i) => ({ line: i.line, kind: i.severity, text: i.message }));
    out.sort((a, b) => (a.kind === b.kind ? a.line - b.line : a.kind === 'error' ? -1 : 1));
    if (!out.some((d) => d.kind === 'error')) out.push({ line: 1, kind: 'ok', text: tr('lootfilter_advanced_views_RawView.no_errors_in_this_text') });
    if (others > 0) out.push({ line: 1, kind: 'info', text: tr('lootfilter_advanced_views_RawView.count_other_rules_tier_restyles', { count: others }) });
    return out;
  }, [draftIssues, others]);
  const shown = editing ? editDiags : diags;

  const goLine = (n: number): void => {
    if (editing) return;
    setLine(n);
    setJump((j) => ({ line: n, n: (j?.n ?? 0) + 1 }));
  };
  useEffect(() => {
    if (jump && !editing) win.scrollTo(jump.line - 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump, tab]);
  const activeOutline = outline.findIndex((o) => line >= o.line && line <= o.end);
  useEffect(() => {
    if (!editing && jump && activeOutline >= 0) ow.scrollTo(activeOutline);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump]);

  // ---- editing your rules as text ----
  const startText = useRef('');
  const startEdit = (): void => {
    const t = rulesToText(lf.doc.rules, (r) => tierStyle(r), lf.doc.name, buildName);
    startText.current = t;
    setDraft(t);
    setEditing(true);
  };
  useEffect(() => {
    if (!editing) return;
    const t = window.setTimeout(() => setDraftIssues(validateFilter(draft).issues), 150);
    return () => window.clearTimeout(t);
  }, [editing, draft]);
  const finishEdit = (): void => {
    if (draft === startText.current) {
      setEditing(false);
      return;
    }
    const topOthers = Math.max(0, ...lf.doc.rules.filter((r) => !isEditable(r)).map((r) => r.priority));
    const res = textToRules(draft, { newId: lf.newId, existing: lf.doc.rules, baseAbove: topOthers, tierStyle: (t) => tierStyle(t) });
    if (!res.ok) {
      setDraftIssues(res.errors.map((e) => ({ line: e.line, severity: 'error', code: 'text', message: e.message })));
      toast({ text: tr('lootfilter_advanced_views_RawView.not_saved_fix_count_lines', { count: res.errors.length }), kind: 'error' });
      return;
    }
    lf.setRules(tr('lootfilter_advanced_views_RawView.edited_your_rules_as_text'), (rs) => [...rs.filter((r) => !isEditable(r)), ...res.rules]);
    setEditing(false);
    toast({ text: `${tr(res.rules.length === 1 ? 'h_lootB_Views.saved_rules_one' : 'h_lootB_Views.saved_rules_other', { n: res.rules.length })}${res.ignoredMinimal ? ` ${tr(res.ignoredMinimal === 1 ? 'h_lootB_Views.minimal_one' : 'h_lootB_Views.minimal_other', { n: res.ignoredMinimal })}` : ''}`, kind: 'ok' });
  };

  // ---- test in game folder ----
  const runTest = async (): Promise<void> => {
    if (!gen) return;
    setBusy(true);
    const name = lf.doc.fileName.replace(/\.filter$/i, '') + ' (test).filter';
    const r = await window.pom.lootFilter.write({ folder: lf.settings.gameFolder, fileName: name, fileText: gen.fileText, overwrite: 'changed' });
    setBusy(false);
    if (!r.ok) toast({ text: r.error, kind: 'error' });
    else if (r.value.kind === 'written') toast({ text: tr('lootfilter_advanced_views_RawView.test_filter_written_next_to', { name }), kind: 'ok' });
    else if (r.value.kind === 'needs-confirm') toast({ text: tr('lootfilter_advanced_views_RawView.a_file_called_name_is', { name, folder: r.value.folder }), kind: 'error' });
    else toast({ text: lfNet(r.value.message), kind: 'error' });
  };

  const tabOpts: { value: Tab; label: string }[] = [
    { value: 'mine', label: tr('lootfilter_advanced_views_RawView.your_rules') },
    { value: 'full', label: tr('lootfilter_advanced_views_RawView.full_filter') },
  ];

  return (
    <Page fill>
      <Head title={tr('lootfilter_advanced_views_RawView.advanced')}>
        <Seg<Tab> value={tab} label={tr('lootfilter_advanced_views_RawView.which_part_of_the_filter')} options={tabOpts} onChange={(t) => { if (!editing) { setTab(t); setLine(1); setJump(null); } }} />
        {tab === 'mine' && <Btn onClick={editing ? finishEdit : startEdit} disabled={!gen}>{editing ? tr('lootfilter_advanced_views_RawView.done_editing') : tr('lootfilter_advanced_views_RawView.edit')}</Btn>}
        <Btn icon="gamepad" onClick={() => void runTest()} disabled={!gen || busy || editing} title={tr('lootfilter_advanced_views_RawView.writes_the_filter_as_a')}>
          {tr('lootfilter_advanced_views_RawView.test_in_game_folder')}
        </Btn>
      </Head>

      <div className="adv-s-raw">
        <div className="lf-card adv-s-outline">
          <Eyebrow>{tr('lootfilter_advanced_views_RawView.outline')}</Eyebrow>
          {editing ? (
            <span className="adv-s-faint" style={{ paddingTop: 8 }}>{tr('lootfilter_advanced_views_RawView.the_outline_comes_back_when')}</span>
          ) : outline.length === 0 ? (
            <span className="adv-s-faint" style={{ paddingTop: 8 }}>{gen ? tr('lootfilter_advanced_views_RawView.no_rule_writes_a_block') : tr('lootfilter_advanced_views_RawView.reading_neversink')}</span>
          ) : (
            <div className="adv-s-outline-list" ref={ow.ref}>
              <div style={{ height: ow.total, position: 'relative' }}>
                {outline.slice(ow.from, ow.to).map((o, k) => {
                  const i = ow.from + k;
                  return (
                    <button key={o.line} type="button" className={'adv-s-ob' + (i === activeOutline ? ' on' : '')} style={{ top: i * OB_ROW }} onClick={() => goLine(o.line)} title={tr('lootfilter_advanced_views_RawView.kind_at_line_line_name', { kind: o.kind, line: o.line, name: o.name })}>
                      <span className={'k ' + o.kind.toLowerCase()}>{o.kind}</span>
                      <span className="t">{o.name}</span>
                      <span className="n">{o.line}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="lf-card adv-s-code">
          {editing ? (
            <CodeEditor value={draft} onChange={setDraft} />
          ) : !gen ? (
            <span className="adv-s-faint" style={{ padding: '14px 16px' }}>{lf.baseLoading ? tr('lootfilter_advanced_views_RawView.reading_neversink') : tr('lootfilter_advanced_views_RawView.no_filter_text_yet')}</span>
          ) : (
            <div className="adv-s-codescroll" ref={win.ref} data-testid="code-scroll">
              <div style={{ height: win.total, position: 'relative' }}>
                {Array.from({ length: Math.max(0, win.to - win.from) }, (_, k) => {
                  const i = win.from + k;
                  const n = i + 1;
                  return <CodeLine key={n} n={n} text={lines[i] ?? ''} on={n === line} {...(sevByLine.get(n) ? { sev: sevByLine.get(n)! } : {})} top={i * ROW} onClick={() => setLine(n)} />;
                })}
              </div>
            </div>
          )}
        </div>

        <div className="lf-card adv-s-diag">
          <div className="adv-s-row" style={{ gap: 10, paddingBottom: 4 }}>
            <Eyebrow>{tr('lootfilter_advanced_views_RawView.diagnostics')}</Eyebrow>
            <span className="adv-s-faint">{gen && lf.validation ? diagSummaryText(shown) : tr('lootfilter_advanced_views_RawView.checking')}</span>
          </div>
          {shown.filter((d) => d.kind !== 'ok').slice(0, 120).map((d, i) => (
            <button key={i} type="button" className="adv-s-dg" onClick={() => goLine(d.line)} disabled={editing}>
              <i style={{ background: dotColour(d.kind) }} />
              <b>{tr('lootfilter_advanced_views_RawView.line_line', { line: d.line })}</b>
              <span style={{ lineHeight: 1.4 }}>{lfText(d.text)}</span>
            </button>
          ))}
          {shown.length > 120 && <span className="adv-s-faint">{tr('lootfilter_advanced_views_RawView.and_length_more', { value: shown.length - 120 })}</span>}
        </div>
      </div>
    </Page>
  );
}
