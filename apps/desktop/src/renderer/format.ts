import type { BuildEntry, BuildInfo } from '../shared/library.js';
import { tr } from './i18n';

const MONTHS = [tr('format.jan'), tr('format.feb'), tr('format.mar'), tr('format.apr'), tr('format.may'), tr('format.jun'), tr('format.jul'), tr('format.aug'), tr('format.sep'), tr('format.oct'), tr('format.nov'), tr('format.dec')];

/** "now", "12m ago", "5h ago", "Sep 25", or "Sep 25, 2025" for older than a year. */
export function formatWhen(ms: number, now = Date.now()): string {
  const diff = now - ms;
  if (diff < 60_000) return tr('h_rA_fmt.now');
  if (diff < 3_600_000) return tr('format.m_ago', { _000: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return tr('format.h_ago', { _600_000: Math.floor(diff / 3_600_000) });
  const d = new Date(ms);
  const base = `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, '0')}`;
  return diff > 365 * 86_400_000 ? `${base}, ${d.getFullYear()}` : base;
}

export function whoLabel(info: BuildInfo): string {
  return info.ascendClassName || info.className || tr('format.unknown_class');
}

/** "Level 96 Pathfinder" */
export function levelLabel(info: BuildInfo): string {
  if (!info.valid) return tr('format.not_a_path_of_building_file');
  return tr('format.level', { level: info.level, info: whoLabel(info) });
}

/** 3,123,221 -> 3.12M ; 19,055 -> 19.1k ; small numbers stay as they are. */
export function compactNumber(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (a >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return Math.round(n).toLocaleString('en-US');
}

export function exactNumber(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export function folderLabel(folder: string): string {
  return folder ? folder.split('/').join(' / ') : tr('format.builds');
}

/** Matches a library search: free words match name, class, ascendancy and main skill; class: and skill: narrow. */
export function matchesQuery(b: BuildEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = `${b.name} ${b.info.className} ${b.info.ascendClassName} ${b.info.mainSkill}`.toLowerCase();
  for (const tok of q.split(/\s+/)) {
    const m = /^(class|skill|level|lvl):(.*)$/.exec(tok);
    if (m) {
      const v = m[2] ?? '';
      if (!v) continue;
      if (m[1] === 'class') {
        if (!`${b.info.className} ${b.info.ascendClassName}`.toLowerCase().includes(v)) return false;
      } else if (m[1] === 'skill') {
        if (!b.info.mainSkill.toLowerCase().includes(v)) return false;
      } else {
        const cmp = /^([<>]=?|=)?(\d+)$/.exec(v);
        if (!cmp) return false;
        const n = Number(cmp[2]);
        const op = cmp[1] ?? '=';
        const lv = b.info.level;
        const ok = op === '>' ? lv > n : op === '>=' ? lv >= n : op === '<' ? lv < n : op === '<=' ? lv <= n : lv === n;
        if (!ok) return false;
      }
    } else if (!hay.includes(tok)) {
      return false;
    }
  }
  return true;
}

/** 264.97M reads 265M on the rail: three significant figures fit its 44 px. */
export function railShort(t: string): string {
  const m = /^(-?[\d.,]+)([KMB])$/i.exec(t.trim());
  if (!m || t.length <= 5) return t;
  const n = Number(m[1]!.replace(/,/g, ''));
  if (!Number.isFinite(n)) return t;
  return (n >= 100 ? String(Math.round(n)) : n >= 10 ? n.toFixed(1) : n.toFixed(2)) + m[2];
}
