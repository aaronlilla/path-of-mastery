import type { BuildEdit, CalcDetail, CalcModRow, CalcViewRow, CalcViewSection } from '@pom/protocol';
import { useMemo, useRef, useState } from 'react';
import type { BuildFacts } from '../../shared/buildFacts.js';
import { columnTitles, isHeaderRow, lookOf, sectionTitle, shownSections, stripCodes } from '../../shared/calcsLogic.js';
import { Icon } from '../ui';
import { SkillSelectors } from './SkillSelectors';
import type { SideData } from './useSide';
import { label as lbl, tr } from '../i18n';

interface Line {
  key: string;
  label: string;
  a: string;
  b: string;
  diff: boolean;
  detailsA: CalcDetail[];
  detailsB: CalcDetail[];
}
interface Card {
  id: string;
  title: string;
  tone: string;
  icon: string;
  subs: { label: string; lines: Line[] }[];
  diffs: number;
}

/** A row's cells as one text, each with its column title when the table has them. */
function cellsText(row: CalcViewRow | undefined, titles: string[] | null): string {
  if (!row) return '';
  const out: string[] = [];
  row.cells.forEach((c, i) => {
    const t = stripCodes(c).trim();
    if (!t) return;
    const title = titles?.[row.cellIdx[i] ?? i];
    out.push(title && row.cells.length > 1 ? `${stripCodes(title).replace(/:$/, '')} ${t}` : t);
  });
  return out.join('  ·  ');
}

const detailsOf = (row: CalcViewRow | undefined): CalcDetail[] => row?.cellDetails.find((d) => d.length > 0) ?? [];

/** Pairs the two builds' sections by id, sub-sections by label and rows by label, as upstream's compare Calcs does. */
export function matchSections(a: CalcViewSection[], b: CalcViewSection[], onlyDiff: boolean): Card[] {
  const sa = new Map(shownSections(a).map((s) => [s.id, s]));
  const sb = new Map(shownSections(b).map((s) => [s.id, s]));
  const ids = [...sa.keys(), ...[...sb.keys()].filter((id) => !sa.has(id))];
  const cards: Card[] = [];
  for (const id of ids) {
    const A = sa.get(id);
    const B = sb.get(id);
    const labels = [...new Set([...(A?.subSections ?? []).map((x) => x.label), ...(B?.subSections ?? []).map((x) => x.label)])];
    const subs: Card['subs'] = [];
    for (const label of labels) {
      const ra = A?.subSections.find((x) => x.label === label);
      const rb = B?.subSections.find((x) => x.label === label);
      const read = (sub: typeof ra) => {
        const seen = new Map<string, number>();
        const m = new Map<string, { row: CalcViewRow; titles: string[] | null }>();
        let titles: string[] | null = sub ? columnTitles(sub) : null;
        for (const r of sub?.rows ?? []) {
          if (isHeaderRow(r)) {
            titles = r.cells.map(stripCodes);
            continue;
          }
          const base = stripCodes(r.label ?? '');
          const n = (seen.get(base) ?? 0) + 1;
          seen.set(base, n);
          m.set(`${base}#${n}`, { row: r, titles });
        }
        return m;
      };
      const ma = read(ra);
      const mb = read(rb);
      const keys = [...new Set([...ma.keys(), ...mb.keys()])];
      const lines: Line[] = keys
        .map((k) => {
          const x = ma.get(k);
          const y = mb.get(k);
          const ta = cellsText(x?.row, x?.titles ?? null) || '—';
          const tb = cellsText(y?.row, y?.titles ?? null) || '—';
          return { key: id + ':' + label + ':' + k, label: stripCodes((x?.row ?? y?.row)?.label ?? ''), a: ta, b: tb, diff: ta !== tb, detailsA: detailsOf(x?.row), detailsB: detailsOf(y?.row) };
        })
        .filter((l) => l.a !== '—' || l.b !== '—')
        .filter((l) => !onlyDiff || l.diff);
      if (lines.length) subs.push({ label, lines });
    }
    if (!subs.length) continue;
    const look = lookOf(id);
    cards.push({ id, title: sectionTitle((A ?? B)!), tone: look.tone, icon: look.icon, subs, diffs: subs.reduce((n, s) => n + s.lines.filter((l) => l.diff).length, 0) });
  }
  return cards;
}

interface Hover {
  line: Line;
  x: number;
  y: number;
}

interface ModTable {
  a: CalcModRow[] | null;
  b: CalcModRow[] | null;
}

interface Props {
  aSide: SideData;
  bSide: SideData;
  aEngineId: string | null;
  bEngineId: string | null;
  aFacts: BuildFacts;
  bFacts: BuildFacts;
  aXml: string;
  bXml: string;
  onlyDiff: boolean;
  editA: (e: BuildEdit) => Promise<unknown>;
  editB: (e: BuildEdit) => Promise<unknown>;
  editAXml: (fn: (xml: string) => string) => Promise<unknown>;
  editBXml: (fn: (xml: string) => string) => Promise<unknown>;
}

/** The Calcs sub-view: each build's skill controls, then the calculation sections of both side by side. */
export function CalcsView(p: Props) {
  const cards = useMemo(() => (p.aSide.view && p.bSide.view ? matchSections(p.aSide.view.sections, p.bSide.view.sections, p.onlyDiff) : []), [p.aSide.view, p.bSide.view, p.onlyDiff]);
  const [hover, setHover] = useState<Hover | null>(null);
  const [mods, setMods] = useState<ModTable | null>(null);
  const timer = useRef(0);
  const seq = useRef(0);
  const enter = (line: Line, el: HTMLElement) => {
    window.clearTimeout(timer.current);
    if (!line.detailsA.length && !line.detailsB.length) return;
    const r = el.getBoundingClientRect();
    timer.current = window.setTimeout(() => {
      const mine = ++seq.current;
      setHover({ line, x: r.left, y: r.bottom });
      setMods(null);
      const get = async (id: string | null, d: CalcDetail[]): Promise<CalcModRow[] | null> => {
        if (!id || !d.length) return null;
        const res = await window.pom.sendCommand('calcsMods', { buildId: id, detail: d[0]! });
        return res.ok ? (res.result.table?.rows ?? null) : null;
      };
      void Promise.all([get(p.aEngineId, line.detailsA), get(p.bEngineId, line.detailsB)]).then(([a, b]) => mine === seq.current && setMods({ a, b }));
    }, 220);
  };
  const leave = () => {
    window.clearTimeout(timer.current);
    seq.current++;
    setHover(null);
  };
  const lists = (s: SideData) => s.view?.view?.lists;
  const listLine = (cap: string, k: 'buff' | 'combat' | 'curse') => (
    <div className="cmp-lists">
      <span className="k">{cap}</span>
      <span className="v">{stripCodes(lists(p.aSide)?.[k] ?? '') || '—'}</span>
      <span className="v">{stripCodes(lists(p.bSide)?.[k] ?? '') || '—'}</span>
    </div>
  );
  return (
    <div className="cmp-scroll scroll-thin cmp-calcs">
      <div className="cmp-chead">
        <div className="side">
          <SkillSelectors tag="A" side={p.aSide} xml={p.aXml} facts={p.aFacts} mode="calcs" withMode apply={p.editA} applyXml={p.editAXml} />
        </div>
        <div className="side">
          <SkillSelectors tag="B" side={p.bSide} xml={p.bXml} facts={p.bFacts} mode="calcs" withMode apply={p.editB} applyXml={p.editBXml} />
        </div>
      </div>
      {p.aSide.view && p.bSide.view && (
        <div className="cmp-lists-box">
          <div className="cmp-lists head"><span className="k" /><span className="v">{tr('compare_CalcsView.a')}</span><span className="v">{tr('compare_CalcsView.b')}</span></div>
          {listLine(tr('compare_CalcsView.aura_and_buff_skills'), 'buff')}
          {listLine(tr('compare_CalcsView.combat_buffs'), 'combat')}
          {listLine(tr('compare_CalcsView.curses_and_debuffs'), 'curse')}
        </div>
      )}
      {(p.aSide.loading || p.bSide.loading || !p.aSide.view || !p.bSide.view) && <div className="cmp-note"><span className="spinner" style={{ color: 'var(--gold-text)' }} />{tr('compare_CalcsView.reading_the_calculation_breakdowns')}</div>}
      <div className="cmp-cardgrid">
        {cards.map((c) => (
          <div className="cmp-sec calc" data-lg="tile" key={c.id}>
            <div className="h">
              <Icon name={c.icon} size={15} style={{ color: `var(${c.tone})` }} />
              <span>{lbl(c.title)}</span>
              {c.diffs > 0 && <span className="badge">{tr('compare_CalcsView.diffs_diff', { diffs: c.diffs })}</span>}
              <span className="ab"><span>{tr('compare_CalcsView.a')}</span><span>{tr('compare_CalcsView.b')}</span></span>
            </div>
            {c.subs.map((s, si) => (
              <div key={s.label + si}>
                {si > 0 && <div className="cmp-subh">{lbl(s.label)}</div>}
                {s.lines.map((l) => (
                  <div className={'r' + (l.diff ? ' diff' : '')} key={l.key} onMouseEnter={(e) => enter(l, e.currentTarget)} onMouseLeave={leave}>
                    <span className="l" style={{ color: l.diff ? 'var(--text-strong)' : 'var(--text-3)' }}>{l.label ? lbl(l.label) : tr('compare_CalcsView.columns')}</span>
                    <span className="v">{l.a}</span>
                    <span className="v" style={{ color: l.diff ? 'var(--text-strong)' : 'var(--text-muted)' }}>{l.b}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        ))}
      </div>
      {!cards.length && p.aSide.view && p.bSide.view && <div style={{ padding: '6px 4px', color: 'var(--text-muted)' }}>{tr('compare_CalcsView.no_differences_in_this_view')}</div>}
      {hover && (
        <div className="cmp-bd" style={{ left: Math.min(hover.x, window.innerWidth - 640), top: Math.min(hover.y + 6, window.innerHeight - 280) }} data-lg="pop" data-solid="">
          <div className="t">{hover.line.label ? lbl(hover.line.label) : tr('compare_CalcsView.columns')}</div>
          {(['a', 'b'] as const).map((k) => (
            <div key={k} className="blk">
              <div className="s">{k === 'a' ? tr('compare_CalcsView.a_this_build') : tr('compare_CalcsView.b_compared_build')}</div>
              {mods === null ? (
                <span style={{ color: 'var(--text-faint)' }}>{tr('compare_CalcsView.reading')}</span>
              ) : !mods[k]?.length ? (
                <span style={{ color: 'var(--text-faint)' }}>{tr('compare_CalcsView.no_modifiers')}</span>
              ) : (
                <table>
                  <thead><tr><th>{tr('compare_CalcsView.value')}</th><th>{tr('compare_CalcsView.stat')}</th><th>{tr('compare_CalcsView.source')}</th><th>{tr('compare_CalcsView.source_name')}</th></tr></thead>
                  <tbody>
                    {mods[k]!.slice(0, 14).map((m, i) => (
                      <tr key={i}><td>{stripCodes(m.value)}</td><td>{m.name ?? ''}</td><td>{m.source}</td><td>{stripCodes(m.sourceName ?? '')}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
