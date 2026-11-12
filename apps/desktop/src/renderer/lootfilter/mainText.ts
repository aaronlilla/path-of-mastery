// Loot filter sentences that main or shared code builds as finished English (file write errors, warnings, diagnostics,
// build filter reasons), shown in the player's language at the place they are displayed.
import { fromMain, tr } from '../i18n';

/** A sentence from the filter checks (syntax messages, warnings, review notes, update diff lines). A "Title: text" pair is read as two parts. */
export function lfText(s: string): string {
  const whole = fromMain('ml_io_lf_text', s);
  if (whole !== s) return whole;
  const i = s.indexOf(': ');
  if (i > 0) {
    const a = fromMain('ml_io_lf_text', s.slice(0, i));
    const b = fromMain('ml_io_lf_text', s.slice(i + 2));
    if (a !== s.slice(0, i) || b !== s.slice(i + 2)) return `${a}: ${b}`;
  }
  return s;
}

/** "2 errors · 1 warning" for the Raw view's diagnostics. */
export function diagSummaryText(d: { kind: string; count?: number }[]): string {
  const sum = (k: string): number => d.filter((x) => x.kind === k).reduce((n, x) => n + (x.count ?? 1), 0);
  const e = sum('error');
  const w = sum('warning');
  return `${tr(e === 1 ? 'h_lootB_Guided.errors_one' : 'h_lootB_Guided.errors_other', { n: e })} · ${tr(w === 1 ? 'h_lootB_Guided.warnings_one' : 'h_lootB_Guided.warnings_other', { n: w })}`;
}

/** An error from main (file write, NeverSink download, prices, card list). */
export const lfNet = (s: string): string => fromMain('ml_io_lf_net', s);

/** A Build Filter name or reason. Reasons are joined sentences, so each sentence has its own template. */
export const lfBuild = (s: string): string => s.split(/(?<=[.!?]) (?=[A-Z])/).map((p) => fromMain('ml_io_lf_build', p)).join(' ');
