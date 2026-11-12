import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { STRICTNESS } from '../../../../shared/lootfilter/styles.js';
import { customSounds } from '../../../../shared/lootfilter/preflight.js';
import { allWarnings, type Warning } from '../../../../shared/lootfilter/warnings.js';
import { useLf } from '../../lfStore';
import { tr } from '../../../i18n';
import { lfText } from '../../mainText';

export interface PreflightRow {
  k: 'ok' | 'warn' | 'bad' | 'wait';
  t: string;
  s: string;
  /** What the button does. Fix copies a sound in; Jump opens the rule or the text; Open opens the rule. */
  a?: { label: string; kind: 'fix-sound' | 'rule' | 'text'; ruleId?: string; file?: string };
}

export interface Preflight {
  rows: PreflightRow[];
  errors: number;
  warnings: number;
  /** Every warning, the same list the Advanced diagnostics show. */
  list: Warning[];
  /** Looks at the game folder again (after a sound was copied in). */
  recheck(): void;
}

const MB = 1024 * 1024;
const SHOW = 8;
const MAX_ROWS = 40;

/**
 * The preflight list, worked out once from the filter that would be written. The Export screen lists it and the
 * status bar counts it, so the two always agree.
 */
export function usePreflight(): Preflight {
  const lf = useLf();
  const { gen, doc, validation: v } = lf;
  const [present, setPresent] = useState<Set<string> | null>(null);
  const [tick, setTick] = useState(0);
  const recheck = useCallback(() => setTick((t) => t + 1), []);

  const sounds = useMemo(() => (gen ? [...new Set(customSounds(gen.text).map((s) => s.file).filter((f) => !/[\\/]/.test(f)))] : []), [gen]);
  useEffect(() => {
    if (!sounds.length) {
      setPresent(new Set());
      return;
    }
    let dead = false;
    void window.pom.lootFilter.filesExist(lf.settings.gameFolder, sounds).then((r) => {
      if (!dead) setPresent(r.ok ? new Set(r.value.map((x) => x.toLowerCase())) : null);
    });
    return () => {
      dead = true;
    };
  }, [sounds, lf.settings.gameFolder, tick]);

  const classOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of lf.catalog?.items ?? []) if (it.class) m.set(it.name, it.class);
    for (const bs of lf.engineBases?.bases ?? []) if (!m.has(bs.name)) m.set(bs.name, bs.class);
    return (n: string) => m.get(n);
  }, [lf.catalog, lf.engineBases]);

  return useMemo<Preflight>(() => {
    const rows: PreflightRow[] = [];
    if (!gen) return { rows: [{ k: 'wait', t: tr('lootfilter_advanced_export_usePreflight.building_the_filter'), s: tr('lootfilter_advanced_export_usePreflight.the_neversink_file_is_still') }], errors: 0, warnings: 0, recheck, list: [] };
    const kb = gen.bytes / 1024;
    const over = gen.bytes >= MB;
    rows.push({ k: over ? 'bad' : gen.bytes >= 0.9 * MB ? 'warn' : 'ok', t: tr('lootfilter_advanced_export_usePreflight.file_size'), s: over ? tr('lootfilter_advanced_export_usePreflight.tofixed_kb_over_the_1', { kb: kb.toFixed(0) }) : tr('lootfilter_advanced_export_usePreflight.tofixed_kb_of_the_1', { kb: kb.toFixed(0) }) });
    rows.push({ k: 'ok', t: tr('lootfilter_advanced_export_usePreflight_2.rules'), s: tr('lootfilter_advanced_export_usePreflight.tolocalestring_rules_tolocalestring2', { count: lf.genBlocks.length.toLocaleString(), count2: gen.text.split('\n').length.toLocaleString() }) });
    let errors = over ? 1 : 0;
    if (!v) rows.push({ k: 'wait', t: tr('lootfilter_advanced_export_usePreflight_2.errors'), s: tr('lootfilter_advanced_export_usePreflight.checking_the_syntax') });
    else {
      errors += v.errors;
      rows.push(v.errors === 0 ? { k: 'ok', t: tr('lootfilter_advanced_export_usePreflight_2.errors'), s: tr('lootfilter_advanced_export_usePreflight.none_nothing_blocks_the_write') } : { k: 'bad', t: tr('lootfilter_advanced_export_usePreflight_2.errors'), s: tr('lootfilter_advanced_export_usePreflight.count_errors_in_the_filter', { count: v.errors }) });
      for (const i of v.issues.filter((x) => x.severity === 'error').slice(0, SHOW)) rows.push({ k: 'bad', t: tr('lootfilter_advanced_export_usePreflight.error_on_line_line', { line: i.line }), s: lfText(i.message), a: { label: tr('lootfilter_advanced_export_usePreflight.open_text'), kind: 'text' } });
    }
    const wrote = new Map(gen.applied.map((a) => [a.ruleId, a.written + a.restyled]));
    const idle = doc.rules.filter((r) => r.enabled && !(wrote.get(r.id) ?? 0) && !gen.needsReview.some((n) => n.ruleId === r.id));
    const list = allWarnings({
      blocks: lf.genBlocks,
      text: gen.text,
      bytes: gen.bytes,
      maxBytes: MB,
      // Until the folder has been looked at, a sound counts as there: no false alarm.
      exists: (f) => (present ? present.has(f.toLowerCase()) : true),
      ruleName: (id) => doc.rules.find((r) => r.id === id)?.name,
      classOf,
      issues: v?.issues ?? [],
      needsReview: gen.needsReview,
      idle: idle.map((r) => ({ id: r.id, ...(r.name ? { name: r.name } : {}) })),
    });
    const shown = list.filter((w) => w.kind !== 'size');
    for (const w of shown.slice(0, MAX_ROWS)) {
      const a: PreflightRow['a'] | undefined = w.kind === 'sound' ? { label: tr('lootfilter_advanced_export_usePreflight.fix'), kind: 'fix-sound', ...(w.file ? { file: w.file } : {}) } : w.ruleId ? { label: w.kind === 'review' || w.kind === 'idle' ? tr('lootfilter_advanced_export_usePreflight.open_rule') : tr('lootfilter_advanced_export_usePreflight.jump'), kind: 'rule', ruleId: w.ruleId } : w.line ? { label: tr('lootfilter_advanced_export_usePreflight.open_text'), kind: 'text' } : undefined;
      rows.push({ k: 'warn', t: lfText(w.title), s: lfText(w.text), ...(a ? { a } : {}) });
    }
    if (shown.length > MAX_ROWS) rows.push({ k: 'warn', t: tr('lootfilter_advanced_export_usePreflight.more_warnings'), s: tr('lootfilter_advanced_export_usePreflight.max_rows_more_listed_in', { MAX_ROWS: shown.length - MAX_ROWS }) });
    return { rows, errors, warnings: list.length, recheck, list };
  }, [gen, lf.genBlocks, v, present, doc.rules, recheck, classOf]);
}

/** AdvancedApp works the list out once; the Export screen reads the same one. */
export const PreflightCtx = createContext<Preflight | null>(null);
export function useSharedPreflight(): Preflight {
  const p = useContext(PreflightCtx);
  if (!p) throw new Error('usePreflight outside the shell');
  return p;
}

export { strictName } from '../../names';
