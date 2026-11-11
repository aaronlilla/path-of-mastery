import type { BuildEdit, ConfigCatalog, ConfigOptionDef, ConfigState } from '@pom/protocol';
import { useEffect, useMemo, useState } from 'react';
import { setActiveSetXml, type BuildFacts } from '../../shared/buildFacts.js';
import { checkEditValue, CUSTOM_SECTION, parseNumberText, rowVisibility, sanitizeNumber, shownValue, SECTION_LOOK, sortSections, stripCodes, type CfgValue } from '../../shared/configLogic.js';
import { Icon, Select, Switch } from '../ui';
import { SetSelect } from './SetBar';
import { tr } from '../i18n';

interface Side {
  state: ConfigState | null;
}

function useConfigState(engineId: string | null | undefined, key: unknown): Side {
  const [s, setS] = useState<Side>({ state: null });
  useEffect(() => {
    if (!engineId) return;
    let live = true;
    void window.pom.sendCommand('configState', { buildId: engineId }).then((r) => live && r.ok && setS({ state: r.result.state }));
    return () => {
      live = false;
    };
  }, [engineId, key]);
  return s;
}

function NumberInput({ opt, value, onCommit }: { opt: ConfigOptionDef; value: CfgValue | undefined; onCommit: (v: number | null) => void }) {
  const shown = value === undefined ? '' : String(value);
  const [draft, setDraft] = useState<string | null>(null);
  const done = () => {
    const d = draft;
    setDraft(null);
    if (d === null || d === shown) return;
    const n = parseNumberText(d);
    if (n !== undefined) onCommit(n);
  };
  return <input className="cmp-in-num" value={draft ?? shown} inputMode="decimal" aria-label={stripCodes(opt.label)} onChange={(e) => setDraft(sanitizeNumber(opt.type, e.target.value))} onBlur={done} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />;
}

/** The control for one option of one build: a switch, a dropdown or a number box. */
function Control({ opt, state, onChange }: { opt: ConfigOptionDef; state: ConfigState | null; onChange: (value: CfgValue | null) => void }) {
  if (!state) return <span className="cmp-cv-none">…</span>;
  const v = shownValue(opt, state);
  if (opt.type === 'check') return <Switch checked={v === true} onChange={(on) => onChange(checkEditValue(opt, state, on))} label={stripCodes(opt.label)} />;
  if (opt.type === 'list' && opt.list) {
    const options = opt.list.map((l) => ({ value: String(l.val), label: stripCodes(l.label) }));
    const cur = v === undefined ? '' : String(v);
    return (
      <Select
        value={options.some((o) => o.value === cur) ? cur : (options[0]?.value ?? '')}
        options={options}
        width="100%"
        ariaLabel={stripCodes(opt.label)}
        onChange={(x) => {
          const item = opt.list!.find((l) => String(l.val) === x);
          onChange(item ? item.val : x);
        }}
      />
    );
  }
  if (opt.type === 'count' || opt.type === 'countAllowZero' || opt.type === 'integer' || opt.type === 'float') return <NumberInput opt={opt} value={v} onCommit={onChange} />;
  return <span className="cmp-cv-none">{v === undefined ? '' : String(v)}</span>;
}

interface Props {
  aEngineId: string | null;
  bEngineId: string | null;
  aFacts: BuildFacts;
  bFacts: BuildFacts;
  /** Changes when this build's numbers change; and the compared build's edit counter. */
  aKey: unknown;
  bKey: unknown;
  q: string;
  onlyDiff: boolean;
  editA: (e: BuildEdit) => Promise<unknown>;
  editB: (e: BuildEdit) => Promise<unknown>;
  editAXml: (fn: (xml: string) => string) => Promise<unknown>;
  editBXml: (fn: (xml: string) => string) => Promise<unknown>;
}

/** The Config sub-view: both builds' options with a control for each, and Show All / Hide Ineligible. */
export function ConfigView(p: Props) {
  const [catalog, setCatalog] = useState<ConfigCatalog | null>(null);
  const [showAll, setShowAll] = useState(false);
  const a = useConfigState(p.aEngineId, p.aKey);
  const b = useConfigState(p.bEngineId, p.bKey);
  useEffect(() => {
    let live = true;
    void window.pom.sendCommand('configCatalog', {}).then((r) => live && r.ok && setCatalog(r.result.catalog));
    return () => {
      live = false;
    };
  }, []);
  const cards = useMemo(() => {
    if (!catalog || !a.state || !b.state) return [];
    const q = p.q.trim().toLowerCase();
    const out: { title: string; rows: { opt: ConfigOptionDef; diff: boolean }[]; diffs: number }[] = [];
    for (const sec of sortSections(catalog.sections)) {
      if (sec.title === CUSTOM_SECTION) continue;
      const rows: { opt: ConfigOptionDef; diff: boolean }[] = [];
      for (const opt of catalog.options) {
        if (opt.section !== sec.title || opt.var === undefined || opt.type === 'label' || opt.type === 'text') continue;
        if (!rowVisibility(opt, a.state, showAll) && !rowVisibility(opt, b.state, showAll)) continue;
        if (q && !stripCodes(opt.label).toLowerCase().includes(q) && !sec.title.toLowerCase().includes(q)) continue;
        const va = shownValue(opt, a.state);
        const vb = shownValue(opt, b.state);
        const diff = String(va ?? '') !== String(vb ?? '');
        if (p.onlyDiff && !diff) continue;
        rows.push({ opt, diff });
      }
      rows.sort((x, y) => Number(y.diff) - Number(x.diff));
      if (rows.length) out.push({ title: sec.title, rows, diffs: rows.filter((r) => r.diff).length });
    }
    return out;
  }, [catalog, a.state, b.state, p.q, p.onlyDiff, showAll]);

  return (
    <div className="cmp-scroll scroll-thin cmp-cfg">
      <div className="cmp-tbar" style={{ padding: '0 0 8px', borderBottom: 0 }}>
        <SetSelect facts={p.aFacts} kind="configSet" caption={tr('compare_ConfigView.a_config_set')} onPick={(id) => void p.editAXml((x) => setActiveSetXml(x, 'configSet', id))} />
        <SetSelect facts={p.bFacts} kind="configSet" caption={tr('compare_ConfigView.b_config_set')} onPick={(id) => void p.editBXml((x) => setActiveSetXml(x, 'configSet', id))} />
        <button type="button" className="btn sm" data-lg="control" aria-pressed={showAll} title={showAll ? tr('compare_ConfigView.hide_options_these_builds_do') : tr('compare_ConfigView.also_show_options_these_builds')} onClick={() => setShowAll((v) => !v)}>
          {showAll ? tr('compare_ConfigView.hide_ineligible_configurations') : tr('compare_ConfigView.show_all_configurations')}
        </button>
      </div>
      {cards.map((c) => {
        const look = SECTION_LOOK[c.title];
        return (
          <div className="cmp-sec cfgv" data-lg="tile" key={c.title}>
            <div className="h">
              <Icon name="sliders" size={15} style={{ color: look?.tone ?? 'var(--gold-label)' }} />
              <span>{c.title}</span>
              {c.diffs > 0 && <span className="badge">{tr('compare_ConfigView.diffs_diff', { diffs: c.diffs })}</span>}
            </div>
            <div className="cmp-cv-row head">
              <span />
              <span>{tr('compare_ConfigView.a')}</span>
              <span>{tr('compare_ConfigView.b')}</span>
            </div>
            {c.rows.map(({ opt, diff }) => (
              <div className={'cmp-cv-row' + (diff ? ' diff' : '')} key={opt.var}>
                <span className="l" title={stripCodes(opt.label)} style={{ color: diff ? 'var(--text-strong)' : 'var(--text-3)' }}>{stripCodes(opt.label)}</span>
                <span className="c">
                  <Control opt={opt} state={a.state} onChange={(value) => void p.editA({ kind: 'setConfig', key: opt.var!, value })} />
                </span>
                <span className="c">
                  <Control opt={opt} state={b.state} onChange={(value) => void p.editB({ kind: 'setConfig', key: opt.var!, value })} />
                </span>
              </div>
            ))}
          </div>
        );
      })}
      {catalog && a.state && b.state && !cards.length && <div style={{ padding: '6px 4px', color: 'var(--text-muted)' }}>{p.q.trim() ? tr('compare_ConfigView.no_config_options_match_trim', { value: p.q.trim() }) : tr('compare_ConfigView.no_differences_in_this_view')}</div>}
      {(!catalog || !a.state || !b.state) && <div className="cmp-note"><span className="spinner" style={{ color: 'var(--gold-text)' }} />{tr('compare_ConfigView.reading_the_configuration_of_both')}</div>}
    </div>
  );
}
