import { useEffect, useMemo, useState } from 'react';
import type { VersionInfo } from '../../shared/accounts.js';
import { describeChange } from '../../shared/syncXml.js';
import { exactNumber } from '../format';
import { Dialog, Icon } from '../ui';
import { engineStats, type CompareStats } from './xmlStats';
import { acctText, useAcct, useAcctCall } from './useAccount';
import { tr } from '../i18n';

function dayLabel(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const t = new Date(now);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const day0 = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day0(t) - day0(d)) / 86_400_000);
  if (diff === 0) return tr('accounts_HistoryDialog.today_hm', { hm });
  if (diff === 1) return tr('accounts_HistoryDialog.yesterday_hm', { hm });
  return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit' });
}

interface Row {
  key: string;
  icon: string;
  label: string;
  colour: string;
  text: string;
  tone: 'up' | 'down' | 'flat';
}

function signed(n: number, digits = 0): string {
  const s = exactNumber(Math.abs(Math.round(n * 10 ** digits) / 10 ** digits));
  return `${n < 0 ? '-' : '+'}${s}`;
}

/** What restoring would change, next to the build as it is now. All numbers are the engine's. */
export function diffRows(sel: CompareStats | null, cur: CompareStats | null): Row[] {
  if (!sel || !cur) return [];
  const rows: Row[] = [];
  const tone = (d: number): Row['tone'] => (d > 0 ? 'up' : d < 0 ? 'down' : 'flat');
  if (sel.fullDps != null && cur.fullDps != null) {
    const d = sel.fullDps - cur.fullDps;
    const pct = cur.fullDps ? (d / cur.fullDps) * 100 : 0;
    rows.push({ key: 'dps', icon: 'dps', label: tr('accounts_HistoryDialog.combined_dps'), colour: 'var(--stat-dps)', text: d === 0 ? tr('accounts_HistoryDialog.no_change') : `${signed(d)} (${pct >= 0 ? '+' : '-'}${Math.abs(pct).toFixed(1)}%)`, tone: tone(d) });
  }
  if (sel.life != null && cur.life != null) {
    const d = sel.life - cur.life;
    rows.push({ key: 'life', icon: 'life', label: tr('accounts_HistoryDialog.life'), colour: 'var(--pool-life)', text: d === 0 ? tr('accounts_HistoryDialog.no_change') : signed(d), tone: tone(d) });
  }
  if (sel.chaosRes != null && cur.chaosRes != null) {
    const d = sel.chaosRes - cur.chaosRes;
    rows.push({ key: 'chaos', icon: 'chaos', label: tr('accounts_HistoryDialog.chaos_resistance'), colour: 'var(--dmg-chaos)', text: d === 0 ? tr('accounts_HistoryDialog.no_change') : `${signed(d)}%`, tone: tone(d) });
  }
  rows.push({ key: 'pts', icon: 'tree', label: tr('accounts_HistoryDialog.passive_points'), colour: 'var(--text-3)', text: `${sel.passives}`, tone: 'flat' });
  return rows;
}

export function VersionHistoryDialog({ localId, name, onClose, onRestored }: { localId: string; name: string; onClose: () => void; onRestored: (id: string, copy: boolean) => void }) {
  const a = useAcct();
  const call = useAcctCall();
  const [versions, setVersions] = useState<VersionInfo[] | null | undefined>(undefined);
  const [sel, setSel] = useState(1);
  const [curXml, setCurXml] = useState<string | null>(null);
  const [curStats, setCurStats] = useState<CompareStats | null>(null);
  const [selXml, setSelXml] = useState<string | null>(null);
  const [selStats, setSelStats] = useState<CompareStats | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const r = await a.api.versions(localId);
      if (!alive) return;
      setVersions(r.ok ? r.value : null);
      const cur = await window.pom.lib.read(localId);
      if (!alive || !cur.ok) return;
      setCurXml(cur.value.xml);
      setCurStats(await engineStats(cur.value.xml));
    })();
    return () => {
      alive = false;
    };
  }, [a.api, localId]);

  const v = versions?.[Math.min(sel, (versions?.length ?? 1) - 1)];
  useEffect(() => {
    if (!v) return;
    let alive = true;
    setSelXml(null);
    setSelStats(null);
    void (async () => {
      const t = await a.api.versionText(localId, v.rev);
      if (!alive || !t.ok || !t.value) return;
      setSelXml(t.value);
      const s = await engineStats(t.value);
      if (alive) setSelStats(s);
    })();
    return () => {
      alive = false;
    };
  }, [a.api, localId, v?.rev]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => diffRows(selStats, curStats), [selStats, curStats]);
  const since = selXml && curXml && v && !v.current ? acctText(describeChange(selXml, curXml)) : '';
  const label = v ? dayLabel(v.at) : '';

  const restore = async (copy: boolean) => {
    if (!v) return;
    setBusy(true);
    const ok = copy ? await call(a.api.restoreAsCopy(localId, v.rev, tr('accounts_HistoryDialog_2.restored_label', { label }))) : await call(a.api.restore(localId, v.rev, `from ${label}`));
    setBusy(false);
    if (ok) {
      onRestored(copy && typeof ok === 'object' ? (ok as { id: string }).id : localId, copy);
      onClose();
    }
  };

  const nothing = versions === null;
  const only = (versions?.length ?? 0) <= 1;
  return (
    <Dialog
      size="large"
      icon="history"
      title={tr('accounts_HistoryDialog.version_history')}
      subtitle={tr('accounts_HistoryDialog.name_versions_are_kept_90', { name })}
      cancelLabel={tr('accounts_HistoryDialog.cancel')}
      altLabel={nothing || only ? undefined : tr('accounts_HistoryDialog.restore_as_copy')}
      altIcon="duplicate"
      confirmLabel={nothing ? null : tr('accounts_HistoryDialog.restore_this_version')}
      confirmIcon="history"
      confirmDisabled={!v || v.current || busy}
      confirmBusy={busy}
      note={nothing ? undefined : v && v.current ? tr('accounts_HistoryDialog.pick_an_earlier_version') : tr('accounts_HistoryDialog.restoring_adds_a_new_version')}
      onCancel={onClose}
      onAlt={() => void restore(true)}
      onConfirm={() => void restore(false)}
    >
      {versions === undefined ? (
        <div className="acct-hist-empty">{tr('accounts_HistoryDialog.loading_versions')}</div>
      ) : nothing ? (
        <div className="acct-hist-empty">
          <Icon name="cloud-off" size={20} />
          <b>{tr('accounts_HistoryDialog.this_build_is_not_in')}</b>
          <span>{tr('accounts_HistoryDialog.versions_are_kept_for_builds')}</span>
        </div>
      ) : (
        <div className="acct-hist">
          <div className="ah-list" role="listbox" aria-label={tr('accounts_HistoryDialog.versions')}>
            {versions.map((x, i) => (
              <button key={x.rev} type="button" role="option" aria-selected={i === sel} className="ah-ver" data-on={i === sel} onClick={() => setSel(i)}>
                <Icon name={x.current ? 'circle-dot' : 'dot'} size={14} style={{ marginTop: 2, color: i === sel ? 'var(--gold-text)' : 'var(--text-faint)' }} />
                <span className="ah-tx">
                  <span className="ah-top">
                    <span className="ah-t">{x.current ? tr('accounts_HistoryDialog.now') : dayLabel(x.at)}</span>
                    <span className="ah-dev">
                      <Icon name={x.here ? 'monitor' : 'cloud'} size={11} />
                      {acctText(x.deviceName)}
                    </span>
                    {x.current && <span className="ah-cur">{tr('accounts_HistoryDialog.current')}</span>}
                  </span>
                  <span className="ah-note">{x.note ? acctText(x.note) : (x.rev === 1 ? tr('accounts_HistoryDialog.created') : tr('accounts_HistoryDialog.edited'))}</span>
                </span>
              </button>
            ))}
          </div>
          <div className="ah-detail">
            {v && v.current ? (
              <div className="ah-lead">{tr('accounts_HistoryDialog.this_is_the_build_as')}</div>
            ) : (
              <>
                <div className="ah-lead">
                  {tr('accounts_HistoryDialog.restoring')} <b>{label}</b> {tr('accounts_HistoryDialog.will_give_you')}
                </div>
                <div className="ah-stats" data-lg="tile">
                  {rows.length === 0 ? (
                    <span className="ah-wait">{tr('accounts_HistoryDialog.reading_the_numbers')}</span>
                  ) : (
                    rows.map((r) => (
                      <div key={r.key} className="ah-r">
                        <span className="ah-l" style={{ color: r.colour }}>
                          <Icon name={r.icon} size={13} />
                          {r.label}
                        </span>
                        <span className="ah-vv" data-tone={r.tone}>
                          {r.tone !== 'flat' && <Icon name={r.tone === 'up' ? 'arrow-up' : 'arrow-down'} size={12} />}
                          {r.text}
                        </span>
                      </div>
                    ))
                  )}
                </div>
                {since && <div className="ah-since">{tr('accounts_HistoryDialog.changes_since_then_since', { since })}</div>}
              </>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
