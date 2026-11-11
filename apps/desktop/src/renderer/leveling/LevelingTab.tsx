import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CandidateDto, GuideResult, LevelingProgressDto, SettingsPatch } from '../../shared/leveling/ipcTypes.js';
import type { GuideStep, StageRef } from '../../shared/leveling/types.js';
import { activeSpecOf, readFacts } from '../../shared/buildFacts.js';
import { addSpec, emptySpecXml, setSpecAttr } from '../../shared/treeSets.js';
import type { EngineBuild } from '../engineBuild';
import { Icon, Switch, useToast } from '../ui';
import './leveling.css';

type Gems = GuideResult['gems'];

const COLOUR: Record<string, string> = { R: 'var(--attr-str)', G: 'var(--attr-dex)', B: 'var(--attr-int)', W: 'var(--text-2)' };

/** Tab widths at or above this get the three columns (acts | steps | NOW); below it NOW is a sticky strip with a settings popover. */
const WIDE = 1000;

/** Steps drawn as flat one-line rows; the rest (gems, links, tree, swap, lab, gear) keep their card. */
const FLAT = new Set(['arrive', 'handin', 'text', 'flask']);

/** The gem chip of the Skills tab: a coloured pip and the name. */
function Gem({ name, colour }: { name: string; colour: string }) {
  return (
    <span className="lv-gem" title={name}>
      <i style={{ background: COLOUR[colour] ?? COLOUR.W }} />
      {name}
    </span>
  );
}

function ColourPips({ colours }: { colours: string }) {
  return (
    <span className="lv-pips" aria-label={`Sockets ${colours}`}>
      {[...colours].map((c, i) => (
        <i key={i} style={{ background: COLOUR[c] ?? COLOUR.W }} />
      ))}
    </span>
  );
}

function gemByName(gems: Gems, name: string): { name: string; colour: string } {
  for (const g of Object.values(gems)) if (g.name === name) return g;
  return { name, colour: 'W' };
}

function stageOf(stages: StageRef[], level: number): StageRef | undefined {
  return stages.find((s) => level >= s.lo && level <= s.hi) ?? stages[stages.length - 1];
}

const bandText = (s: StageRef): string => (s.hi >= 100 ? `${s.lo}+` : `${s.lo}-${s.hi}`);

/** The character level the guide is at: the area level of the last zone entered before the first step still to do. */
function currentLevel(steps: GuideStep[], ticked: Set<string>): number {
  let level = 1;
  for (const s of steps) {
    if (!ticked.has(s.id)) break;
    if (s.kind === 'arrive' && s.areaLevel > 0) level = s.areaLevel;
  }
  return level;
}

const Row = memo(function Row({ s, done, next, gems, nodeNames, stages, onTick }: { s: GuideStep; done: boolean; next: boolean; gems: Gems; nodeNames: Record<number, string>; stages: StageRef[]; onTick: (id: string, v: boolean) => void }) {
  const head = (() => {
    switch (s.kind) {
      case 'arrive':
        return (
          <>
            <span className="lv-tag">{s.areaLevel > 0 ? `Area ${s.areaLevel}` : 'Town'}</span>
            <span className="lv-main">{s.text}</span>
          </>
        );
      case 'handin':
        return <span className="lv-main">{s.text}</span>;
      case 'text':
        return <span className="lv-main">{s.text}</span>;
      case 'quest-reward':
        return (
          <span className="lv-main">
            <span className="lv-verb">Take</span> <Gem name={s.take} colour={gems[s.gemId]?.colour ?? 'W'} />
            <span className="lv-sub"> from {s.quest}. {s.why}</span>
            {s.alt && s.alt.length > 0 && <span className="lv-sub"> Others worth a look: {s.alt.join(', ')}.</span>}
          </span>
        );
      case 'buy':
        return (
          <span className="lv-main">
            <span className="lv-verb">Buy</span> from {s.npc}
            <span className="lv-chips">
              {s.gems.map((g) => (
                <Gem key={g.gemId} name={g.name} colour={gems[g.gemId]?.colour ?? 'W'} />
              ))}
            </span>
            <span className="lv-sub">{s.why}</span>
          </span>
        );
      case 'links':
        return (
          <span className="lv-main">
            <span className="lv-verb">Link</span> at level <span className="lv-num">{s.at.level}</span>
            {s.at.zone ? ` (${s.at.zone})` : ''}
            {s.groups.map((g, i) => (
              <span key={i} className="lv-linkrow">
                <span className="lv-slot">{g.slot || 'Any slot'}</span>
                <ColourPips colours={g.colours} />
                <span className="lv-chips">
                  {g.gems.map((n, k) => {
                    const gm = gemByName(gems, n);
                    return <Gem key={k} name={n} colour={gm.colour} />;
                  })}
                </span>
              </span>
            ))}
          </span>
        );
      case 'swap':
        return (
          <span className="lv-main lv-swap">
            <Icon name="swap" size={14} />
            <span>
              <b>Swap at level {s.level}.</b> Move from {s.from} to {s.to}.
            </span>
          </span>
        );
      case 'transfigure':
        return (
          <span className="lv-main">
            <span className="lv-verb">Transfigure</span> {s.gem}
            <span className="lv-sub">{s.how}</span>
          </span>
        );
      case 'tree':
        return (
          <span className="lv-main">
            <span className="lv-verb">Passive tree</span> <span className="lv-num">{s.points}</span> points by level <span className="lv-num">{s.level}</span>. Take {s.add.length} more.
            {s.notables.length > 0 && <span className="lv-sub"> Notables: {s.notables.join(', ')}.</span>}
            {s.add.length > 0 && <span className="lv-sub lv-nodes">{s.add.map((id) => nodeNames[id] ?? id).join(' · ')}</span>}
          </span>
        );
      case 'lab':
        return (
          <span className="lv-main">
            <span className="lv-verb">{s.which} Labyrinth</span> ascendancy points: {s.ascendNames.length ? s.ascendNames.join(', ') : 'any'}.
          </span>
        );
      case 'gear': {
        const st = stages.find((x) => x.id === s.stage);
        return (
          <span className="lv-main">
            <span className="lv-verb">
              Gear · stage {s.stage}
              {st ? ` (areas ${bandText(st)})` : ''}
            </span>
            <span className="lv-sub lv-gearlines">
              {s.lines.map((l, i) => (
                <span key={i} className="lv-block">
                  {l}{' '}
                </span>
              ))}
            </span>
          </span>
        );
      }
      case 'flask':
        return (
          <span className="lv-main">
            <span className="lv-verb">Flasks</span> {s.lines.join(' ')}
          </span>
        );
    }
  })();
  const notes = 'notes' in s ? s.notes : [];
  // Rows other than the next one are cut to one line; the pointer shows the whole text.
  const li = useRef<HTMLLIElement>(null);
  useLayoutEffect(() => {
    const body = li.current?.querySelector('.lv-body');
    if (li.current && body) li.current.title = (body.textContent ?? '').replace(/^Next/, '').replace(/\s+/g, ' ').trim();
  });
  return (
    <li ref={li} className={'lv-step lv-k-' + s.kind} data-step-id={s.id} data-kind={s.kind} data-flat={FLAT.has(s.kind) ? '' : undefined} data-done={done ? '' : undefined} data-next={next ? '' : undefined} tabIndex={next ? -1 : undefined} aria-current={next ? 'step' : undefined}>
      <button type="button" role="checkbox" aria-checked={done} aria-label={done ? 'Mark not done' : 'Mark done'} className="lv-chk" onClick={() => onTick(s.id, !done)}>
        {done && <Icon name="check" size={12} />}
      </button>
      <div className="lv-body">
        {next && <span className="lv-nextpill">Next</span>}
        {head}
        {notes.length > 0 && (
          <ul className="lv-notes">
            {notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
});

function Ring({ done, total }: { done: number; total: number }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return <span className="lv-ring" style={{ background: `conic-gradient(rgb(var(--area-build-rgb)) ${pct * 3.6}deg, rgba(var(--line-rgb), .12) 0)` }} aria-label={`${pct}% done`} />;
}

/** The guide's own controls. The NOW column holds them when the tab is wide; the Guide settings popover holds the same ones when it is not. */
function NowControls({ res, progress, patch, addTrees, nextTree, chosen }: { res: GuideResult; progress: LevelingProgressDto; patch: (p: SettingsPatch) => void; addTrees: () => void; nextTree: Extract<GuideStep, { kind: 'tree' }> | undefined; chosen: GuideResult['plan']['skills'][number] | undefined }) {
  return (
    <>
      <div className="lv-card">
        <div className="lv-label">Next passive tree</div>
        {nextTree ? (
          <div className="lv-sub">
            {nextTree.specTitle}: {nextTree.points} points{nextTree.notables.length ? `, ${nextTree.notables.slice(0, 3).join(', ')}` : ''}.
          </div>
        ) : (
          <div className="lv-sub">No more checkpoints.</div>
        )}
        <button type="button" className="btn gold" data-lg="control" onClick={addTrees} title="Adds one tree per checkpoint to this build, named Leveling 1 to n. One undo removes them.">
          <Icon name="tree" size={16} />
          Add checkpoint trees to build
        </button>
      </div>

      <div className="lv-card">
        <div className="lv-label">Leveling skill</div>
        {res.plan.swap ? (
          <>
            <div className="lv-sub">
              {chosen ? `${chosen.name} until level ${res.plan.swap.level}` : 'No leveling skill'}, then {res.plan.swap.name}.
            </div>
            <label className="lv-pick">
              <span className="sr">Leveling skill</span>
              <select className="input" aria-label="Leveling skill" value={progress.levelingSkill ?? ''} onChange={(e) => patch({ levelingSkill: e.target.value })}>
                <option value="">Best match{chosen ? ` (${chosen.name})` : ''}</option>
                {res.candidates.map((c: CandidateDto) => (
                  <option key={c.gemId} value={c.gemId}>
                    {c.name} ({c.reason || 'candidate'})
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : (
          <div className="lv-sub">{res.build.mainSkill || 'Your main skill'} is there from the start, so no other skill is needed.</div>
        )}
      </div>

      <div className="lv-card lv-opts">
        <label className="lv-opt">
          <Switch checked={progress.autoTick} onChange={(v) => patch({ autoTick: v })} label="Tick zones from the game log" />
          <span>Tick zones from the game log</span>
        </label>
        <label className="lv-opt">
          <Switch checked={progress.leagueStart} onChange={(v) => patch({ leagueStart: v })} label="League start route" />
          <span>League start route</span>
        </label>
        <div className="lv-sub">Levels are around the speedrun route. Your own pace will differ.</div>
      </div>
    </>
  );
}

export function LevelingTab({ buildId, xml, rev, eng, onOpenSkills }: { buildId: string; xml: string; rev: number; eng: EngineBuild; onOpenSkills?: () => void }) {
  const toast = useToast();
  const [res, setRes] = useState<GuideResult | null>(null);
  const [err, setErr] = useState('');
  const [act, setAct] = useState(1);
  const [progress, setProgress] = useState<LevelingProgressDto | null>(null);
  const [version, setVersion] = useState(0);
  const [placed, setPlaced] = useState(false);
  const [jump, setJump] = useState<{ n: number; focus: boolean }>({ n: 0, focus: false });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tabW, setTabW] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const stepsRef = useRef<HTMLElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const resRef = useRef<GuideResult | null>(null);
  const progRef = useRef<LevelingProgressDto | null>(null);
  resRef.current = res;
  progRef.current = progress;

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      void window.pom.leveling.guide({ buildId, xml }).then((r) => {
        if (!live) return;
        if (!r.ok) {
          // The error screen replaces the steps column, so its scroll is gone: the next guide opens at your place again.
          setPlaced(false);
          return setErr(r.error);
        }
        setErr('');
        setRes(r.value);
        setProgress(r.value.progress);
      });
    }, res ? 350 : 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // the guide follows the build text and the settings; ticks are local
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildId, xml, rev, version]);
  useEffect(() => setPlaced(false), [buildId]);

  // The tab's own width decides the layout (the assistant dock and the window both change it).
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setTabW(el.clientWidth));
    ro.observe(el);
    setTabW(el.clientWidth);
    return () => ro.disconnect();
  }, [!!res && !!progress]);

  const ticked = useMemo(() => new Set(progress?.ticked ?? []), [progress]);
  const tick = useCallback(
    (id: string, v: boolean) => {
      setProgress((p) => (p ? { ...p, ticked: v ? [...p.ticked.filter((x) => x !== id), id] : p.ticked.filter((x) => x !== id) } : p));
      void window.pom.leveling.tick(buildId, [id], v).then((r) => r.ok && setProgress(r.value));
    },
    [buildId],
  );
  const patch = useCallback(
    (p: SettingsPatch) => {
      void window.pom.leveling.settings(buildId, p).then((r) => {
        if (!r.ok) return toast({ text: r.error, kind: 'error' });
        setProgress(r.value);
        if (p.leagueStart !== undefined || p.levelingSkill !== undefined) setVersion((v) => v + 1);
      });
    },
    [buildId, toast],
  );

  /** The act holding the first step still to do (Act 1 when everything is done or nothing is loaded). */
  const actOfNext = (r: GuideResult, done: Set<string>): number => r.guide.acts.find((a) => a.steps.some((s) => !done.has(s.id)))?.act ?? r.guide.acts[0]?.act ?? 1;

  // Open at your place: the act of the first unticked step, with that step in view.
  useEffect(() => {
    if (placed || !res || !progress) return;
    setAct(actOfNext(res, new Set(progress.ticked)));
    setPlaced(true);
    setJump((j) => ({ n: j.n + 1, focus: false }));
  }, [placed, res, progress]);

  // Auto tick: a zone in the game log ticks the next arrive step for it, and the guide follows to the next step.
  useEffect(
    () =>
      window.pom.leveling.onZone((z) => {
        const r = resRef.current;
        const p = progRef.current;
        if (!r || !p || !p.autoTick) return;
        const done = new Set(p.ticked);
        for (const a of r.guide.acts) {
          const hit = a.steps.find((s) => s.kind === 'arrive' && !done.has(s.id) && s.zone.toLowerCase() === z.name.toLowerCase());
          if (hit) {
            done.add(hit.id);
            setAct(actOfNext(r, done));
            tick(hit.id, true);
            setJump((j) => ({ n: j.n + 1, focus: false }));
            return;
          }
        }
      }),
    [tick],
  );

  // A jump request: once the act is drawn, put the Next step in the middle of the steps column (and focus it when asked).
  useEffect(() => {
    if (!jump.n) return;
    const f = requestAnimationFrame(() => {
      const el = stepsRef.current?.querySelector<HTMLElement>('.lv-step[data-next]');
      if (!el) return;
      el.scrollIntoView({ block: 'center' });
      if (jump.focus) el.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(f);
  }, [jump]);

  // The settings popover closes on Esc and on a click outside the strip.
  useEffect(() => {
    if (!settingsOpen) return;
    const down = (e: PointerEvent): void => {
      if (!barRef.current?.contains(e.target as Node)) setSettingsOpen(false);
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setSettingsOpen(false);
    };
    document.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key);
    };
  }, [settingsOpen]);

  const addTrees = async () => {
    if (!res) return;
    const trees: { title: string; nodes: number[] }[] = [];
    const cum: number[] = [];
    const asc: number[] = [];
    for (const a of res.guide.acts) {
      for (const s of a.steps) {
        if (s.kind === 'lab') asc.push(...s.ascend);
        if (s.kind === 'tree') {
          cum.push(...s.add);
          trees.push({ title: s.specTitle, nodes: [...cum, ...asc] });
        }
      }
    }
    if (!trees.length) return toast({ text: 'This guide has no tree steps.', kind: 'error' });
    try {
      await eng.editXml((x) => {
        const f = readFacts(x);
        const spec = activeSpecOf(f);
        const base = { classId: spec?.classId ?? 0, ascendClassId: spec?.ascendClassId ?? 0, secondaryAscendClassId: 0 };
        let out = x;
        for (const t of trees) out = addSpec(out, setSpecAttr(emptySpecXml(t.title, base, spec?.treeVersion || undefined), 'nodes', t.nodes.join(',')));
        return out;
      });
      toast({ text: `Added ${trees.length} checkpoint trees (Leveling 1 to ${trees.length}). Undo with Ctrl Z.`, kind: 'ok' });
    } catch (e) {
      toast({ text: `The trees could not be added. ${e instanceof Error ? e.message : String(e)}`, kind: 'error' });
    }
  };

  if (err) {
    return (
      <div className="tabroot lv-root text-aa" data-screen-label="Leveling / Tab / Content">
        <div className="panel lv-empty" data-lg="panel">
          <div className="lv-errbox" role="alert">
            <Icon name="error" size={20} style={{ color: 'var(--negative-text)' }} />
            <b>The leveling guide could not be made.</b>
            <span className="lv-muted">{err}</span>
            <button
              type="button"
              className="btn gold"
              onClick={() => {
                setErr('');
                setRes(null);
                setPlaced(false);
                setVersion((v) => v + 1);
              }}
            >
              <Icon name="refresh" size={15} />
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }
  if (!res || !progress) {
    return (
      <div className="tabroot lv-root text-aa" data-screen-label="Leveling / Tab / Content">
        <div className="panel lv-panel lv-loading" data-lg="panel" aria-busy="true">
          <div className="lv-acts" aria-hidden="true">
            {Array.from({ length: 10 }, (_, i) => (
              <span key={i} className="lv-skel lv-skel-act" />
            ))}
          </div>
          <div className="lv-steps">
            <div className="lv-loadcap">
              <Icon name="refresh" size={16} spin />
              Making your leveling guide.
            </div>
            {Array.from({ length: 8 }, (_, i) => (
              <span key={i} className="lv-skel lv-skel-row" aria-hidden="true" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  const allSteps = res.guide.acts.flatMap((a) => a.steps);
  const level = currentLevel(allSteps, ticked);
  const stage = stageOf(res.guide.stages, level);
  const actData = res.guide.acts.find((a) => a.act === act) ?? res.guide.acts[0]!;
  const nextTree = allSteps.find((s): s is Extract<GuideStep, { kind: 'tree' }> => s.kind === 'tree' && !ticked.has(s.id));
  const nextStep = allSteps.find((s) => !ticked.has(s.id));
  const totalDone = allSteps.filter((s) => ticked.has(s.id)).length;
  const chosen = res.plan.skills[0];
  const wide = tabW === 0 || tabW >= WIDE;
  const jumpNext = (): void => {
    setAct(actOfNext(res, ticked));
    setJump((j) => ({ n: j.n + 1, focus: true }));
  };
  const controls = <NowControls res={res} progress={progress} patch={patch} addTrees={() => void addTrees()} nextTree={nextTree} chosen={chosen} />;
  const actDone = actData.steps.filter((s) => ticked.has(s.id)).length;

  return (
    <div className="tabroot lv-root text-aa" data-screen-label="Leveling / Tab / Content" ref={rootRef}>
      <div className="panel lv-panel" data-lg="panel" data-layout={wide ? 'wide' : 'narrow'}>
        <aside className="lv-acts" aria-label="Acts">
          <span className="lv-h">
            <Icon name="path" size={13} />
            ACTS
          </span>
          {res.guide.acts.map((a) => {
            const done = a.steps.filter((s) => ticked.has(s.id)).length;
            return (
              <button key={a.act} type="button" className="lv-act" aria-pressed={a.act === actData.act} onClick={() => setAct(a.act)}>
                <Ring done={done} total={a.steps.length} />
                <span className="lv-actname">Act {a.act}</span>
                <span className="lv-count">
                  {done}/{a.steps.length}
                </span>
              </button>
            );
          })}
        </aside>

        <main className="lv-steps" aria-label={`Act ${actData.act} steps`} ref={stepsRef}>
          {!wide && (
            <div className="lv-nowbar" ref={barRef} role="region" aria-label="Now">
              <span className="lv-nowtext" title="Your loot filter uses the same stages, so it switches with the area level.">
                {stage && <b className="lv-stageid">{stage.id}</b>}
                <span className="lv-stagename">{stage ? stage.name : 'Leveling'}</span>
                <span className="lv-facts">
                  · around level <span className="lv-num">{level}</span> · <span className="lv-num">{totalDone}</span> of <span className="lv-num">{allSteps.length}</span> steps
                </span>
              </span>
              {nextTree && <span className="lv-treechip">Next tree: {nextTree.specTitle}</span>}
              <span className="lv-sp" />
              <button type="button" className="btn sm" aria-haspopup="dialog" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((o) => !o)}>
                <Icon name="settings" size={14} />
                Guide settings
              </button>
              {settingsOpen && (
                <div className="lv-pop" role="dialog" aria-label="Guide settings">
                  {controls}
                </div>
              )}
            </div>
          )}
          <div className="lv-stephead">
            <h2 className="lv-title">
              Act {actData.act}
              <span className="lv-count">
                {actDone} of {actData.steps.length} done
              </span>
            </h2>
            <span className="lv-sp" />
            {nextStep && (
              <button type="button" className="btn sm" onClick={jumpNext}>
                <Icon name="arrow-down" size={14} />
                Jump to next step
              </button>
            )}
          </div>
          {!res.build.mainSkill && (
            <div className="lv-banner" role="note">
              <Icon name="info" size={16} style={{ flex: 'none', color: 'rgb(var(--area-build-rgb))' }} />
              <span style={{ flex: 1, minWidth: 0 }}>Your build has no main skill yet. Add one in Skills and this guide follows it.</span>
              {onOpenSkills && (
                <button type="button" className="btn sm" onClick={onOpenSkills}>
                  Open Skills
                </button>
              )}
            </div>
          )}
          {res.warning && <p className="lv-note">{res.warning}</p>}
          {res.treeNote && <p className="lv-note">{res.treeNote}</p>}
          <ol className="lv-list">
            {actData.steps.map((s) => (
              <Row key={s.id} s={s} done={ticked.has(s.id)} next={s.id === nextStep?.id} gems={res.gems} nodeNames={res.nodeNames} stages={res.guide.stages} onTick={tick} />
            ))}
          </ol>
        </main>

        {wide && (
          <aside className="lv-now" aria-label="Now">
            <span className="lv-h">
              <Icon name="target" size={13} />
              NOW
            </span>
            <div className="lv-card" data-testid="lv-now">
              <div className="lv-big">{stage ? `${stage.id} ${stage.name}` : 'Leveling'}</div>
              <div className="lv-sub">
                Around level <span className="lv-num">{level}</span>. <span className="lv-num">{totalDone}</span> of <span className="lv-num">{allSteps.length}</span> steps done.
              </div>
              <div className="lv-strip" role="list" aria-label="Filter stages">
                {res.guide.stages.map((s) => (
                  <div key={s.id} role="listitem" className="lv-stage" data-now={stage?.id === s.id ? '' : undefined}>
                    <b>{s.id}</b>
                    <span>{bandText(s)}</span>
                  </div>
                ))}
              </div>
              <div className="lv-sub">Your loot filter uses the same stages, so it switches with the area level.</div>
            </div>
            {controls}
          </aside>
        )}
      </div>
    </div>
  );
}
