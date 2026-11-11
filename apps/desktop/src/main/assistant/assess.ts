// The assessed-candidate adapter: a solver result is checked on scratch copies before its card shows, and what
// the checks found is frozen into one record (AssessedCandidate). The card draws from it; Apply takes its id and the live-build
// revision it was checked against, never the result's index. The engine fields are to move into the engine's own record later.
import { createHash } from 'node:crypto';
import type { AssessedCandidate, AssessedFinding, AssessedFix } from '../../shared/assistant/types.js';
import { statMeta } from '../../shared/assistant/statLabels.js';
import { auditBuild } from './audit.js';
import { readEquipped, xmlHash } from './buildReaders.js';
import { unmetGems } from './gemFit.js';
import { lostBuffs } from './itemFit.js';
import { applyEdits, buildWarnings, fixManaShortfall, fixOldShortfalls, fixRequirements, guardBreaks, sideEffects } from './playerSense.js';
import { statMap, withScratch, xmlOf, type Scalar, type ToolContext, type ToolEdit } from './tools.js';

export interface AssessInput {
  solveId: string;
  /** The result's XML, fetched once. */
  xml: string;
  liveBuildId: string;
  liveXml: string;
  sidebar?: AssessedCandidate['sidebar'];
}

/** The engine's record id for a result: the sha256 of its build text (solver.rs xml_hash). Fetch by this id; a list index moves on a re-sort. */
export const resultHash = (xml: string): string => createHash('sha256').update(xml).digest('hex');

const num = (s: Record<string, Scalar>, k: string): number => (typeof s[k] === 'number' ? (s[k] as number) : 0);

/** "Full DPS -3.1%, Effective HP +0.4%" for what a fix moved. */
function delta(before: Record<string, Scalar>, after: Record<string, Scalar>): string {
  const dmg = num(before, 'FullDPS') > 0 ? 'FullDPS' : 'CombinedDPS';
  return [dmg, 'TotalEHP']
    .filter((id) => num(before, id) > 0)
    .map((id) => {
      const p = Math.round(((num(after, id) - num(before, id)) / num(before, id)) * 1000) / 10;
      return `${statMeta(id).label} ${p >= 0 ? '+' : '-'}${Math.abs(p)}%`;
    })
    .join(', ');
}

const MIN_LISTINGS = 3;

/** Divines of the equipped uniques that have a market price, and which have none. */
async function priceOf(ctx: ToolContext, xml: string, rec: AssessedCandidate): Promise<void> {
  const uniques = [...new Set(readEquipped(xml).filter((i) => /unique/i.test(i.rarity) && i.name).map((i) => i.name))];
  if (!uniques.length) return;
  try {
    const r = await ctx.prices?.lookup(uniques);
    if (!r || !r.chaosPerDivine) return;
    let divines = 0;
    const unpriced: string[] = [];
    uniques.forEach((name, k) => {
      const live = (r.lines[k] ?? []).filter((l) => l.name === name && (l.listings === undefined || l.listings >= MIN_LISTINGS));
      if (live.length) divines += Math.min(...live.map((l) => l.chaos)) / r.chaosPerDivine;
      else unpriced.push(name);
    });
    rec.price = { divines: Math.round(divines * 100) / 100, coverage: (uniques.length - unpriced.length) / uniques.length, unpriced };
    rec.status.price = unpriced.length ? 'estimated' : 'computed';
  } catch {
    // stays unknown: the card says so
  }
}

/** Returns the build text with the listed fixes applied (the result's own text when nothing was fixed). */
async function check(ctx: ToolContext, i: AssessInput, rec: AssessedCandidate): Promise<string> {
  const live = await statMap(ctx, i.liveBuildId);
  const oldShort = new Set((await unmetGems(ctx, i.liveBuildId)).map((g) => g.key));
  const fixes: AssessedFix[] = [];
  const found: AssessedFinding[] = [];
  const auditEdits: ToolEdit[] = [];
  let fixedXml = i.xml;
  await withScratch(ctx, i.xml, async (b) => {
    const audit = await auditBuild(ctx, b, i.xml);
    const start = await statMap(ctx, b);
    const fullDps = num(start, 'FullDPS') > 0;
    // The fixers edit the scratch copy; each one's engine delta is what it moved.
    const step = async <T extends { edits: ToolEdit[]; lines: string[] }>(why: string, run: () => Promise<T>): Promise<T> => {
      const before = await statMap(ctx, b);
      const r = await run();
      if (r.edits.length) fixes.push({ what: r.lines[0] ?? why, why, delta: delta(before, await statMap(ctx, b)) });
      else for (const l of r.lines) found.push({ id: `unfixed:${found.length}`, hard: false, text: l });
      return r;
    };
    const req = await step('A gem needs more Strength, Dexterity or Intelligence than the build has.', () => fixRequirements(ctx, b, oldShort));
    for (const u of req.unfixed) found.push({ id: `requirement:${found.length}`, hard: true, text: u });
    await step('A gem was already short of an attribute in your build and still is.', () => fixOldShortfalls(ctx, b, oldShort, fullDps));
    await step('The main skill costs more mana than the build gets back.', () => fixManaShortfall(ctx, b, fullDps));

    // What the audit found that the fixers above did not cover.
    const reqFixed = fixes.some((f) => /Strength|Dexterity|Intelligence/.test(f.why));
    for (const f of audit.findings) {
      if (f.kind === 'requirement' && reqFixed) continue;
      found.push({ id: f.id, hard: f.fatal, text: f.shown, ...(f.fix ? { fix: f.fix } : {}) });
      if (f.fatal && f.fix && f.edits?.length) {
        fixes.push({ what: f.fix, why: f.shown, delta: audit.fixAll?.shown ?? '' });
        auditEdits.push(...f.edits);
      }
    }
    // The listed fixes go into the build Apply sets, not only onto the card.
    if (auditEdits.length) await applyEdits(ctx, b, auditEdits, fullDps);

    // Against the open build, after the fixes: a defence layer lost, a resist under its cap, a new warning, a lost buff.
    const after = await statMap(ctx, b);
    const [wl, wr] = await Promise.all([buildWarnings(ctx, i.liveBuildId), buildWarnings(ctx, b)]);
    // A new warning is a break in game; a layer or resist your build had and this one trades away is a cost against your build, not a failure.
    for (const t of sideEffects(live, after, wl, wr).hard) found.push({ id: `side:${found.length}`, hard: wr.includes(t) && !wl.includes(t), text: wr.includes(t) ? t : `Against your build: ${t}` });
    for (const t of guardBreaks(live, after, false)) found.push({ id: `guard:${found.length}`, hard: false, text: `Against your build: ${t}` });
    for (const t of (await lostBuffs(ctx, i.liveBuildId, i.liveXml, i.xml)).lines) found.push({ id: `buff:${found.length}`, hard: false, text: t });
    if (fixes.length) fixedXml = await xmlOf(ctx, b);
  });

  rec.findings = found;
  rec.fixes = fixes;
  const blockers = found.filter((f) => f.hard && !f.fix);
  if (blockers.length) {
    rec.verdict = 'notReady';
    rec.why = `${blockers[0]!.text}${blockers.length > 1 ? ` (and ${blockers.length - 1} more)` : ''}`;
  } else if (fixes.length) {
    rec.verdict = 'fix';
    rec.why = `${fixes.length} fix${fixes.length === 1 ? '' : 'es'}.`;
  } else {
    rec.verdict = 'ready';
    rec.why = 'Nothing found that stops it working in game.';
  }
  rec.status.checks = 'computed';
  return fixedXml;
}

/** Checks one result and freezes the record; `xml` is the build to apply (the result with the listed fixes). Never throws: a check that cannot run leaves the verdict `unresolved` and says so. */
export async function assessCandidate(ctx: ToolContext, i: AssessInput): Promise<{ rec: AssessedCandidate; xml: string }> {
  const hash = resultHash(i.xml);
  const rec: AssessedCandidate = {
    id: hash,
    solveId: i.solveId,
    xmlHash: hash,
    sourceRevision: xmlHash(i.liveXml),
    ...(i.sidebar ? { sidebar: i.sidebar } : {}),
    findings: [],
    verdict: 'unresolved',
    why: '',
    fixes: [],
    price: { divines: null, coverage: null, unpriced: [] },
    status: { sidebar: i.sidebar ? 'computed' : 'unknown', checks: 'unknown', price: 'unknown' },
  };
  await priceOf(ctx, i.xml, rec);
  let xml = i.xml;
  try {
    xml = await check(ctx, i, rec);
  } catch (e) {
    rec.status.checks = 'failed';
    rec.why = `The checks could not run: ${e instanceof Error ? e.message : String(e)}`;
  }
  return { rec, xml };
}
