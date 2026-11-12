import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { FightResult } from '@pom/protocol';
import { DEFAULT_NUM_FORMAT, formatNumSep, type NumFormat } from '../../shared/calcsLogic';
import type { EngineHandle } from '../engineHandle';
import { Icon } from '../ui';
import type { OpenBuild } from '../types';
import { CalcSelect } from '../calcs/CalcControls';
import { binsOf, dpsAt, fightEnd, fmtM, fmtS, lanesOf, niceStep, rowsOf } from './fightLogic';
import '../calcs/calcs.css';
import './fight.css';
import { tr } from '../i18n';

/** tr() whose values are React nodes: the text is split around the values. */
function rich(key: string, vals: Record<string, ReactNode>): ReactNode {
  const names = Object.keys(vals);
  const text = (tr as unknown as (k: string, o: object) => string)(key, Object.fromEntries(names.map((n, i) => [n, `\u0001${i}\u0002`])));
  return text.split(/\u0001(\d+)\u0002/).map((part, i) => (i % 2 ? <Fragment key={i}>{vals[names[Number(part)]!]}</Fragment> : part));
}

const RUNS = 500;
const BOSSES = [
  { value: 'Pinnacle', label: tr('h_f_Fight.boss_median') },
  { value: 'Uber', label: tr('h_f_Fight.boss_uber') },
];

/** What a run was started with; the tab says so when the boxes no longer match the numbers on screen. */
interface Setup { boss: string; life: number | null; cap: number }
const NAMED = 'name:'; // a boss picked by name from the game files
const same = (a: Setup, b: Setup) => a.boss === b.boss && a.life === b.life && a.cap === b.cap;

export interface FightTabProps {
  build: OpenBuild;
  engine: EngineHandle | null;
  fmt?: NumFormat;
}

export function FightTab({ build, engine, fmt }: FightTabProps) {
  const nf = fmt ?? DEFAULT_NUM_FORMAT;
  const [boss, setBoss] = useState('Pinnacle');
  const [lifeText, setLifeText] = useState<string | null>(null); // null: the game's life for the boss
  const [capText, setCapText] = useState('60');
  const [avg, setAvg] = useState<{ r: FightResult; setup: Setup } | null>(null);
  const [dice, setDice] = useState<{ r: FightResult; setup: Setup } | null>(null);
  const [busy, setBusy] = useState<'avg' | 'dice' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const version = engine?.version ?? 0;
  const ready = !!engine && build.engine.state === 'ready';

  const life = lifeText === null ? null : Number(lifeText.replace(/\D/g, '')) || null;
  const cap = Math.min(600, Math.max(1, Number(capText) || 60));
  const setup: Setup = { boss, life, cap };

  const run = useCallback(
    async (runs: number, s: Setup) => {
      if (!engine) return;
      const mine = ++seq.current;
      setBusy(runs ? 'dice' : 'avg');
      setError(null);
      try {
        const named = s.boss.startsWith(NAMED);
        const options: Record<string, unknown> = { boss: named ? 'Pinnacle' : s.boss, maxTime: s.cap, runs };
        if (named) options.bossName = s.boss.slice(NAMED.length);
        if (s.life) options.life = s.life;
        const r = await engine.call('fightSim', { options });
        if (mine !== seq.current) return;
        (runs ? setDice : setAvg)({ r, setup: s });
      } catch (e) {
        if (mine === seq.current) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (mine === seq.current) setBusy(null);
      }
    },
    [engine],
  );

  // One average fight when the tab opens and after every change to the build; a range from before the change is dropped.
  const first = useRef(true);
  useEffect(() => {
    if (!ready) return;
    if (!first.current) setDice(null);
    first.current = false;
    void run(0, setup);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, version, build.id]);

  if (!ready) {
    return (
      <div className="tabroot calc-root fight-root" data-screen-label="Fight / Tab / Content">
        <div className="calc-note" role="status">
          <b>{tr('h_f_Fight.no_fight_head')}</b>  {tr('h_f_Fight.no_fight_body')}
          {build.engine.state === 'unavailable' && <span> {build.engine.reason}</span>}
          {build.engine.state === 'loading' && <span>  {tr('h_f_Fight.engine_loading')}</span>}
        </div>
      </div>
    );
  }

  const bosses = [...BOSSES, ...(avg?.r.boss.pinnacles ?? []).map((n) => ({ value: NAMED + n, label: n }))];
  const shownLife = lifeText !== null ? lifeText : avg ? String(Math.round(avg.r.boss.life)) : '';
  const fmtLife = (t: string) => (t ? formatNumSep(t, nf) : '');
  const stale = avg && !same(avg.setup, setup);
  const status = busy ? (busy === 'dice' ? tr('h_f_Fight.running_n', { n: RUNS }) : tr('h_f_Fight.running')) : stale ? tr('h_f_Fight.stale') : dice && same(dice.setup, setup) ? tr('h_f_Fight.last_n', { n: RUNS }) : avg ? tr('h_f_Fight.last_avg') : '';
  // A 500-run on a changed setup refreshes the average fight first: the range only shows beside an average of the same setup.
  const go = (runs: number) => void (runs && stale ? run(0, setup).then(() => run(runs, setup)) : run(runs, setup));
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      (e.target as HTMLInputElement).blur();
      go(0);
    }
  };

  return (
    <div className="tabroot calc-root fight-root" data-screen-label="Fight / Tab / Content" data-density="compact">
      <div className="calc-tb tab-tb" data-lg="panel" role="group" aria-label={tr('h_f_Fight.setup_aria')}>
        <CalcSelect
          caption={tr('h_f_Fight.boss_cap')}
          ariaLabel={tr('h_f_Fight.boss_aria')}
          grow={0}
          basis={270}
          value={boss}
          valueNode={bosses.find((b) => b.value === boss)?.label ?? boss}
          options={bosses.map((b) => ({ value: b.value, node: b.label }))}
          onChange={(v) => {
            setBoss(v);
            setLifeText(null);
          }}
        />
        <label className="calc-num" title={tr('h_f_Fight.life_title', { src: avg?.r.boss.lifeSource ?? tr('h_f_Fight.life_default') })}>
          <span className="k">{tr('h_f_Fight.boss_life')}</span>
          <input value={fmtLife(shownLife)} inputMode="numeric" aria-label={tr('h_f_Fight.boss_life_aria')} onChange={(e) => setLifeText(e.target.value.replace(/\D/g, '').slice(0, 11))} onKeyDown={onKey} />
        </label>
        <label className="calc-num sm" title={tr('h_f_Fight.cap_title')}>
          <span className="k">{tr('h_f_Fight.cap_label')}</span>
          <input value={capText} inputMode="numeric" aria-label={tr('h_f_Fight.cap_aria')} onChange={(e) => setCapText(e.target.value.replace(/\D/g, '').slice(0, 3))} onKeyDown={onKey} />
        </label>
        <div className="right">
        <span className="status" role="status">{status}</span>
        <button type="button" className="btn" disabled={!!busy} onClick={() => go(RUNS)}>
          <Icon name="play" size={13} /> {tr('h_f_Fight.run_n', { n: RUNS })}
        </button>
        <button type="button" className="btn gold" disabled={!!busy} onClick={() => go(0)}>
          <Icon name="play" size={13} />  {tr('h_f_Fight.run_one')}
        </button>
        </div>
      </div>
      <div className="calc-body" aria-busy={!!busy}>
        <div className="f-body">
          {error && !avg ? (
            <div className="calc-note" role="alert" style={{ position: 'static', padding: 32 }}>
              <b>{tr('h_f_Fight.failed_head')}</b> {error}
            </div>
          ) : !avg ? (
            <div className="calc-note" role="status" style={{ position: 'static', padding: 32 }}>{tr('h_f_Fight.fighting')}</div>
          ) : (
            <>
              {error && <div className="f-empty" role="alert"><span><b>{tr('h_f_Fight.last_failed')}</b> {error}</span></div>}
              <Tiles avg={avg.r} dice={dice && same(dice.setup, avg.setup) ? dice.r : null} cap={avg.setup.cap} />
              <Chart avg={avg.r} dice={dice && same(dice.setup, avg.setup) ? dice.r : null} />
              <div className="f-bottom">
                <Events r={avg.r} />
                <Spread dice={dice && same(dice.setup, avg.setup) ? dice.r : null} />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const refLabel = (r: FightResult) => (r.steady.stat === 'FullDPS' ? tr('h_f_Fight.ref_full') : tr('h_f_Fight.ref_combined'));

function Tiles({ avg, dice, cap }: { avg: FightResult; dice: FightResult | null; cap: number }) {
  const T = avg.ttk.seconds;
  const refDps = avg.steady.dps;
  const diceT = dice?.ttk.median ?? null;
  const rolled = dice && T !== null && diceT !== null && fmtS(diceT) !== fmtS(T) ? ' ' + tr('h_f_Fight.rolled', { t: fmtS(diceT) }) : '';
  const bossTxt = avg.boss.name ? tr('h_f_Fight.boss_named', { name: avg.boss.name, life: fmtM(avg.boss.life) }) : tr('h_f_Fight.boss_plain', { life: fmtM(avg.boss.life) });
  const diff = refDps > 0 ? Math.round(Math.abs(1 - avg.avgDps / refDps) * 100) : 0; // the sim's gap as a share of the reference figure
  const cull = avg.boss.cullPercent;
  const culled = T !== null && cull > 0 ? ' ' + tr('h_f_Fight.culled', { pct: +cull.toFixed(1) }) : '';
  const dealt = T !== null ? avg.boss.life * (1 - cull / 100) : avg.avgDps * fightEnd(avg);
  return (
    <div className="f-tiles">
      <div className="f-tile ttk" role="group" aria-label={tr('h_f_Fight.ttk_aria')}>
        <div className="k">{dice ? tr('h_f_Fight.ttk_k_avg') : tr('h_f_Fight.ttk_k')}</div>
        {T === null ? (
          <>
            <div className="v">{tr('h_f_Fight.not_killed')}</div>
            <div className="sub">{tr('h_f_Fight.not_killed_sub', { cap, boss: bossTxt })}</div>
          </>
        ) : (
          <>
            <div className="v">{fmtS(T)}<small>s</small></div>
            {(culled || rolled) && <div className="sub">{(culled + rolled).trim()}</div>}
          </>
        )}
        {dice && <Range r={dice} />}
      </div>
      <div className="f-tile plain" role="group" aria-label={tr('h_f_Fight.avg_aria')}>
        <div className="k">{tr('h_f_Fight.avg_k')}</div>
        <div className="v">{fmtM(avg.avgDps)}</div>
        <div className="sub">{culled ? tr('h_f_Fight.avg_sub_cull', { dealt: fmtM(dealt), t: fmtS(fightEnd(avg)), pct: +cull.toFixed(1) }) : tr('h_f_Fight.avg_sub', { dealt: fmtM(dealt), t: fmtS(fightEnd(avg)) })}</div>
        <div className="cmp" aria-hidden="true"><i style={{ width: `${refDps > 0 ? Math.min(100, Math.round((avg.avgDps / refDps) * 100)) : 0}%` }} /></div>
      </div>
      <div className="f-tile plain" role="group" aria-label={refLabel(avg)} title={tr('h_f_Fight.steady')}>
        <div className="k">{refLabel(avg).toUpperCase()}</div>
        <div className="v">{fmtM(refDps)}</div>
        <div className="sub"><span className="dl">{avg.avgDps <= refDps ? tr('h_f_Fight.sim_lower', { diff: diff }) : tr('h_f_Fight.sim_higher', { diff: diff })}</span></div>
        <div className="cmp" aria-hidden="true"><i style={{ width: '100%', background: '#9cc8ff' }} /></div>
      </div>
    </div>
  );
}

function Range({ r }: { r: FightResult }) {
  const { p10, p90, median, min, max } = r.ttk;
  if (median === null || p10 === null || p90 === null || min === null || max === null) {
    return <div className="rng"><div className="line">{tr('h_f_Fight.range_none', { n: r.runs })}</div></div>;
  }
  const lo = Math.floor(min), hi = Math.max(lo + 1, Math.ceil(max));
  const pct = (v: number) => ((v - lo) / (hi - lo)) * 100;
  const miss = r.runs - r.killedRuns;
  const same = fmtS(p10) === fmtS(p90);
  return (
    <div className="rng">
      <div className="line">{same ? rich('h_f_Fight.kills_same', { t: <em>{fmtS(median)} s</em> }) : rich('h_f_Fight.kills_range', { range: <em>{tr('h_f_Fight.range_em', { a: fmtS(p10), b: fmtS(p90) })}</em>, m: <em>{fmtS(median)} s</em> })}</div>
      <div className="track" aria-hidden="true"><div className="rail" /><div className="seg" style={{ left: `${pct(p10)}%`, width: `${Math.max(0.5, pct(p90) - pct(p10))}%` }} /><div className="mid" style={{ left: `${pct(median)}%` }} /></div>
      <div className="ticks" aria-hidden="true">{!same && <span style={{ left: `${pct(p10)}%` }}>{fmtS(p10)} s</span>}<span style={{ left: `${pct(median)}%`, color: 'var(--gold-text)' }}>{fmtS(median)} s</span>{!same && <span style={{ left: `${pct(p90)}%` }}>{fmtS(p90)} s</span>}</div>
      <div className="meta">{[same ? '' : tr('h_f_Fight.meta_band'), tr('h_f_Fight.meta_fast', { a: fmtS(min), b: fmtS(max) }), miss > 0 ? tr('h_f_Fight.meta_miss', { n: miss }) : ''].filter(Boolean).join(' ')}</div>
    </div>
  );
}

/** The width of an element, kept up to date. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

function Chart({ avg, dice }: { avg: FightResult; dice: FightResult | null }) {
  const [ref, w] = useWidth();
  const T = fightEnd(avg);
  return (
    <section className="f-card" aria-label={tr('h_f_Fight.dps_over_time')}>
      <div className="hd"><span className="t">{tr('h_f_Fight.dps_over_time')}</span></div>
      <div className="bd">
        <div className="f-legend" style={{ paddingLeft: AXIS_L }}>
          <span><i style={{ width: 18, height: 3, background: '#ffd27a' }} />{tr('h_f_Fight.sim_dps')}</span>
          <span><i style={{ width: 18, height: 0, borderTop: '2px dashed #9cc8ff' }} />{refLabel(avg)}</span>
          <span><i style={{ width: 18, height: 0, borderTop: '2px dotted rgba(246,236,218,.7)' }} />{tr('h_f_Fight.avg_aria')}</span>
          {dice && dice.ttk.p10 !== null && <span><i style={{ width: 14, height: 10, background: 'rgba(240,140,82,.3)', border: '1px dashed rgba(240,140,82,.7)' }} />{tr('h_f_Fight.kill_range')}</span>}
        </div>
        <div className="f-chart" ref={ref}>{w > 0 && T > 0 && <ChartSvg avg={avg} dice={dice} w={w} />}</div>
      </div>
    </section>
  );
}

/** Left edge of the plot inside the chart; the legend starts at the same x. */
const AXIS_L = 124;

function ChartSvg({ avg, dice, w }: { avg: FightResult; dice: FightResult | null; w: number }) {
  const T = fightEnd(avg);
  const lanes = lanesOf(avg);
  const nRows = lanes.reduce((n, l) => n + l.rows.length, 0);
  const L = AXIS_L, R = 18, TOP = 14, PH = 210, LANE = 24, AX = 26;
  const baseY = TOP + PH + (nRows ? 10 + nRows * LANE : 0);
  const H = baseY + AX - (nRows ? 6 : -4);
  const band = dice && dice.ttk.p10 !== null && dice.ttk.p90 !== null ? { a: dice.ttk.p10, b: dice.ttk.p90 } : null;
  const xMax = Math.max(T, band?.b ?? 0, dice?.ttk.max ?? 0) * 1.1;
  const xs = Math.max(1, niceStep(xMax, 8));
  const xTop = Math.ceil(xMax / xs) * xs;
  const ymax0 = Math.max(avg.avgDps, avg.steady.dps, ...avg.dpsSeries) * 1.1;
  const ys = niceStep(ymax0, 5);
  const yMax = Math.ceil(ymax0 / ys) * ys;
  const X = (t: number) => L + (t / xTop) * (w - L - R);
  const Y = (v: number) => TOP + PH - (v / yMax) * PH;
  // One point per second of the fight, at the middle of that second; the line starts at 0 s and ends at the kill.
  const s = avg.dpsSeries;
  const pts: Array<[number, number]> = s.length ? [[0, s[0]!], ...s.map((v, k): [number, number] => [Math.min(k + 0.5, T), v]), [T, s[s.length - 1]!]] : [];
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)} ${Y(p[1]).toFixed(1)}`).join(' ');
  const flip = (txt: string, x: number) => (x + 8 + txt.length * 6.7 > w - R ? { x: X(T) - 8, textAnchor: 'end' as const } : { x: x + 8 });
  const dieTxt = tr(avg.killed ? (avg.boss.cullPercent > 0 ? 'h_f_Fight.die_culled' : 'h_f_Fight.die_dies') : 'h_f_Fight.die_cap', { t: fmtS(T) }) + (dice ? ' ' + tr('h_f_Fight.die_avg') : '');
  const rangeTxt = band ? (fmtS(band.a) === fmtS(band.b) ? tr('h_f_Fight.range_every', { t: fmtS(band.a) }) : tr('h_f_Fight.range_here', { a: fmtS(band.a), b: fmtS(band.b) })) : '';
  const avgTxt = tr('h_f_Fight.avg_line', { v: fmtM(avg.avgDps) });
  const refTxt = tr('h_f_Fight.ref_line', { label: refLabel(avg), v: fmtM(avg.steady.dps) });
  const gridY: number[] = [];
  for (let v = 0; v <= yMax + 1e-6; v += ys) gridY.push(v);
  const gridX: number[] = [];
  for (let t = 0; t <= xTop + 1e-6; t += xs) gridX.push(t);
  let rowNo = 0;
  return (
    <svg width={w} height={H} viewBox={`0 0 ${w} ${H}`} role="img" aria-label={tr(avg.killed ? 'h_f_Fight.chart_aria_dies' : 'h_f_Fight.chart_aria_alive', { start: fmtM(s[0] ?? 0), peak: fmtM(Math.max(...s, 0)), t: fmtS(T) })}>
      <defs><linearGradient id="fight-ar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ffd27a" stopOpacity=".32" /><stop offset="1" stopColor="#ffd27a" stopOpacity=".03" /></linearGradient></defs>
      {gridY.map((v) => (
        <g key={`y${v}`}>
          <line x1={L} x2={w - R} y1={Y(v)} y2={Y(v)} stroke={`rgba(255,236,200,${v === 0 ? 0.22 : 0.07})`} />
          <text x={L - 10} y={Y(v) + 4} textAnchor="end">{v === 0 ? '0' : fmtM(v)}</text>
        </g>
      ))}
      {gridX.map((t) => (
        <g key={`x${t}`}>
          <line x1={X(t)} x2={X(t)} y1={TOP} y2={baseY} stroke="rgba(255,236,200,.04)" />
          <text x={X(t)} y={baseY + 17} textAnchor="middle">{t} s</text>
        </g>
      ))}
      {band && (
        <g>
          <rect x={X(band.a)} y={TOP} width={Math.max(1, X(band.b) - X(band.a))} height={baseY - TOP} fill="rgba(240,140,82,.10)" />
          <line x1={X(band.a)} x2={X(band.a)} y1={TOP} y2={baseY} stroke="rgba(240,140,82,.55)" strokeDasharray="3 3" />
          <line x1={X(band.b)} x2={X(band.b)} y1={TOP} y2={baseY} stroke="rgba(240,140,82,.55)" strokeDasharray="3 3" />
          <text {...flip(rangeTxt, X(T))} y={TOP + 13} style={{ fill: 'var(--area-build)', fontWeight: 600 }}>{rangeTxt}</text>
        </g>
      )}
      {d && <path d={`${d} L${X(T)} ${Y(0)} L${X(0)} ${Y(0)} Z`} fill="url(#fight-ar)" />}
      <line x1={L} x2={w - R} y1={Y(avg.steady.dps)} y2={Y(avg.steady.dps)} stroke="#9cc8ff" strokeWidth="1.5" strokeDasharray="6 5" />
      <text x={L + 6} y={Y(avg.steady.dps) - 6} style={{ fill: '#9cc8ff' }}>{refTxt}</text>
      {d && <path d={d} fill="none" stroke="#ffd27a" strokeWidth="2.4" strokeLinejoin="round" />}
      <line x1={L} x2={X(T)} y1={Y(avg.avgDps)} y2={Y(avg.avgDps)} stroke="rgba(246,236,218,.55)" strokeWidth="1" strokeDasharray="2 4" />
      {X(T) + 8 + avgTxt.length * 6.7 < w - R && <text x={X(T) + 8} y={Y(avg.avgDps) + 4} style={{ fill: 'var(--text-2)' }}>{avgTxt}</text>}
      <line x1={X(T)} x2={X(T)} y1={TOP} y2={baseY} stroke="var(--gold-400)" strokeWidth="2" />
      {s.length > 0 && <circle cx={X(T)} cy={Y(s[s.length - 1]!)} r="4.5" fill="var(--gold-400)" stroke="var(--surface-0)" strokeWidth="2" />}
      <text {...flip(dieTxt, X(T))} y={TOP + (band ? 31 : 14)} style={{ fill: 'var(--gold-text)', fontWeight: 600, fontSize: 12 }}>{dieTxt}</text>
      {lanes.flatMap((lane) =>
        lane.rows.map((bars, i) => {
          const y = TOP + PH + 10 + rowNo++ * LANE;
          return (
            <g key={lane.name + i}>
              {i === 0 && <text className="lane-n" x={L - 10} y={y + 16} textAnchor="end">{lane.name}</text>}
              <line x1={L} x2={w - R} y1={y + LANE - 1} y2={y + LANE - 1} stroke="rgba(255,236,200,.05)" />
              {bars.map((b, k) => {
                const x = X(b.a), bw = Math.max(X(b.b) - X(b.a), 4);
                const fits = bw > b.text.length * 6.4 + 10;
                const off = !fits && x + bw + 6 + b.text.length * 6.4 > w - R;
                return (
                  <g key={k}>
                    <rect x={x} y={y + 3} width={bw} height={LANE - 7} rx="4" fill={b.col} />
                    <text className={`bar-t${b.dark && fits ? ' dark' : ''}`} x={fits ? x + 6 : off ? x - 6 : x + bw + 6} textAnchor={off ? 'end' : 'start'} y={y + 16}>{b.text}</text>
                  </g>
                );
              })}
            </g>
          );
        }),
      )}
    </svg>
  );
}

function Events({ r }: { r: FightResult }) {
  const rows = rowsOf(r);
  return (
    <section className="f-card" aria-label={tr('h_f_Fight.events_title')}>
      <div className="hd"><span className="t">{tr('h_f_Fight.events_title')}</span></div>
      <div className="bd ev">
        {rows.map((e, i) => (
          <div key={i} className={`f-ev${e.kind === 'end' ? ' end' : ''}`} tabIndex={0} title={e.title}>
            <span className="t">{fmtS(e.t)} s</span>
            <svg className="g" viewBox="0 0 10 10" aria-hidden="true">
              {e.kind === 'low' ? <path d="M5 9 1 2h8z" fill={e.colour} /> : e.kind === 'end' ? <path d="M5 0l5 5-5 5-5-5z" fill={e.colour} /> : <circle cx="5" cy="5" r="4" fill={e.colour} />}
            </svg>
            <span className="l">{e.label}</span>
            <span className="d">{e.dps !== null && e.kind !== 'start' ? tr('h_f_Fight.dps_v', { v: fmtM(e.dps) }) : ''}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function Spread({ dice }: { dice: FightResult | null }) {
  if (!dice) {
    return (
      <section className="f-card" aria-label={tr('h_f_Fight.spread_aria')}>
        <div className="hd"><span className="t">{tr('h_f_Fight.spread_title')}</span></div>
        <div className="bd"><div className="f-empty"><span>{tr('h_f_Fight.no_spread_body', { n: RUNS })}</span></div></div>
      </section>
    );
  }
  const ttks = dice.ttks ?? [];
  return (
    <section className="f-card" aria-label={tr('h_f_Fight.spread_aria')}>
      <div className="hd"><span className="t">{tr('h_f_Fight.spread_title')}</span></div>
      <div className="bd">
        {ttks.length === 0 ? <div className="f-empty"><span><b>{tr('h_f_Fight.no_kills_head')}</b> {tr('h_f_Fight.no_kills_body', { n: dice.runs })}</span></div> : <HistBox dice={dice} ttks={ttks} />}
      </div>
    </section>
  );
}

function HistBox({ dice, ttks }: { dice: FightResult; ttks: number[] }) {
  const [ref, w] = useWidth();
  return <div ref={ref}>{w > 0 && <Hist dice={dice} ttks={ttks} w={w} />}</div>;
}

function Hist({ dice, ttks, w }: { dice: FightResult; ttks: number[]; w: number }) {
  const { lo, step, counts } = binsOf(ttks);
  const H = 168, L = 8, R = 8, TOP = 16, BOT = 48;
  const mx = Math.max(...counts), bw = (w - L - R) / counts.length;
  const { p10, p90, median } = dice.ttk;
  const every = Math.max(1, Math.ceil(counts.length / 14));
  return (
    <svg className="f-hist" width={w} height={H} viewBox={`0 0 ${w} ${H}`} role="img" aria-label={tr('h_f_Fight.hist_aria', { n: dice.runs, a: fmtS(ttks[0]!), b: fmtS(ttks[ttks.length - 1]!), m: median === null ? '' : fmtS(median) })}>
      {counts.map((c, k) => {
        const h = (c / mx) * (H - TOP - BOT), x = L + k * bw;
        const inside = p10 !== null && p90 !== null && lo + (k + 1) * step > p10 && lo + k * step <= p90;
        return (
          <g key={k}>
            <rect x={x + 1.5} y={H - BOT - h} width={Math.max(1, bw - 3)} height={h} rx="3" fill={inside ? 'rgba(240,140,82,.75)' : 'rgba(240,140,82,.28)'} />
            {k % every === 0 && <text x={x} y={H - BOT + 16} textAnchor="middle">{lo + k * step}</text>}
          </g>
        );
      })}
      {median !== null && <text x={Math.min(w - 40, Math.max(40, L + ((median - lo) / step) * bw))} y={TOP - 2} textAnchor="middle" style={{ fill: 'var(--gold-text)', fontWeight: 600 }}>{tr('h_f_Fight.usually', { t: fmtS(median) })}</text>}
      <text x={w / 2} y={H - 6} textAnchor="middle">{tr('h_f_Fight.hist_axis', { n: dice.runs })}</text>
    </svg>
  );
}
