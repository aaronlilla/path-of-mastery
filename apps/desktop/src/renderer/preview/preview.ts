// Next-league preview in the window: whether the app has an overlay, the player's on/off choice, and the preview
// engine's numbers for the build text the window shows (main runs them on a second engine, see main/preview/service.ts).
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { CommandParams, CommandResult } from '@pom/protocol';
import { shortPatch, type PreviewCommand, type PreviewInfo, type PreviewNote } from '../../shared/preview.js';
import { normaliseOutput } from '../displayStats';
import type { Output } from '../displayStatsTypes';
import { resolvePreview, type PvResult, type PvState } from './pvResult';

const KEY = 'pom.preview.on';
let state: { info: PreviewInfo | null; chosen: boolean } = { info: null, chosen: readChoice() };
let asked = false;
const subs = new Set<() => void>();

function readChoice(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

function set(next: Partial<typeof state>): void {
  state = { ...state, ...next };
  for (const s of subs) s();
}

function ask(): void {
  if (asked) return;
  asked = true;
  void window.pom.preview?.status().then((r) => r.ok && set({ info: r.value })).catch(() => undefined);
}

export interface PreviewView {
  /** The overlay, or null when the app offers no preview. */
  info: PreviewInfo | null;
  /** Preview numbers are showing (an overlay exists and the player turned it on). */
  on: boolean;
  /** "3.29" (live) and "3.30" (preview). */
  live: string;
  next: string;
  setOn(on: boolean): void;
}

export function usePreview(): PreviewView {
  const s = useSyncExternalStore(
    (f) => {
      ask();
      subs.add(f);
      return () => subs.delete(f);
    },
    () => state,
  );
  return {
    info: s.info,
    on: !!s.info && s.chosen,
    live: s.info?.live ?? '',
    next: s.info ? shortPatch(s.info.patch) : '',
    setOn: (on) => {
      try {
        localStorage.setItem(KEY, on ? '1' : '0');
      } catch {
        /* storage is optional */
      }
      set({ chosen: on });
    },
  };
}

/** Runs a read-only command on the preview engine for the build text `xml`. */
export async function previewCall<K extends PreviewCommand>(command: K, xml: string, params: Omit<CommandParams<K>, 'buildId'>): Promise<{ result: CommandResult<K>; ms: number }> {
  const r = await window.pom.preview.call(command, xml, params);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

/** Last preview calculation times, for a driver measuring what the second engine adds. */
const timing: { ms: number[] } = { ms: [] };
(globalThis as { __pomPreview?: typeof timing }).__pomPreview = timing;

/** The preview engine's stats for `xml` while `enabled`; follows every change of the build text. */
export function usePreviewStats(xml: string, enabled: boolean): { stats: Output | null; state: PvState } {
  const [res, setRes] = useState<PvResult<Output> | null>(null);
  useEffect(() => {
    if (!enabled || !xml) return;
    let live = true;
    void previewCall('getStats', xml, {})
      .then(({ result, ms }) => {
        if (!live) return;
        timing.ms.push(ms);
        const map: Record<string, unknown> = {};
        for (const v of result.stats) map[v.id] = v.value;
        setRes({ key: xml, val: normaliseOutput(map) });
      })
      .catch(() => live && setRes({ key: xml, val: null }));
    return () => {
      live = false;
    };
  }, [xml, enabled]);
  const r = resolvePreview(res, xml, enabled);
  return { stats: r.val, state: r.state };
}

/** The notes behind a changed gem (by name), node (by id) or unique (by name), or null when the notes leave it alone. */
export function notesFor(info: PreviewInfo | null, kind: 'gem' | 'node' | 'unique', key: string | number): PreviewNote[] | null {
  if (!info) return null;
  const ix = info.index;
  if (kind === 'node') return ix.nodes[String(key)] ?? null;
  if (kind === 'unique') return ix.uniques[String(key)] ?? null;
  const out: PreviewNote[] = [];
  for (const [id, notes] of Object.entries(ix.gems)) if ((ix.gemNames?.[id] ?? id) === key) out.push(...notes);
  return out.length ? out : null;
}

/** The text to show for a note: the patch-note line itself when the overlay carries it, else what it says changed. */
export const noteText = (info: PreviewInfo, n: PreviewNote): string => info.index.notes?.[String(n.cite)] ?? n.claim;

/** "+9.5%" / "-8.0%", and whether the change is good; null when either side is not a number or nothing changed. */
export function pctChange(now: unknown, was: unknown, lowerIsBetter = false): { text: string; good: boolean } | null {
  if (typeof now !== 'number' || typeof was !== 'number' || !Number.isFinite(now) || !Number.isFinite(was) || now === was) return null;
  const diff = now - was;
  const good = lowerIsBetter ? diff < 0 : diff > 0;
  if (was === 0) return { text: diff > 0 ? 'new' : 'gone', good };
  const p = (diff / Math.abs(was)) * 100;
  return { text: `${p > 0 ? '+' : ''}${Math.abs(p) < 0.1 ? p.toFixed(2) : p.toFixed(1)}%`, good };
}
