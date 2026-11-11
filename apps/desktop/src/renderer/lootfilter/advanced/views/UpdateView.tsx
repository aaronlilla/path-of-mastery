import { useEffect, useMemo, useState } from 'react';
import type { LfNav } from '../../LootFilterArea';
import { useLf } from '../../lfStore';
import { LabelChip } from '../../LabelChip';
import { Dialog, useToast } from '../../../ui';
import { generateFilter, type GenerateResult } from '../../../../shared/lootfilter/generate.js';
import { parseBlocks, type ParsedFilter } from '../../../../shared/lootfilter/blocks.js';
import { buildCatalog, type Catalog } from '../../../../shared/lootfilter/catalog.js';
import { STRICTNESS } from '../../../../shared/lootfilter/styles.js';
import { checkedText, plainNotes } from '../../../../shared/lootfilter/notes.js';
import { diffVersions, type VersionChange } from '../../../../shared/lootfilter/versionDiff.js';
import { Btn, Eyebrow, GroundBox, Head, Page, Panel, Spinner, plain, useGround } from '../strictness/kit';
import { compareVersions } from '../../../../shared/lootfilter/versions.js';
import { diffLines, type DiffResult } from '../export/lineDiff';
import { tr } from '../../../i18n';
import { lfNet, lfText } from '../../mainText';

const MAX_LISTED = 40;

type Choice = 'mine' | 'new';

function Group({ title, count, children }: { title: string; count: string; children: React.ReactNode }) {
  return (
    <>
      <div className="adv-s-grouphead">
        <Eyebrow>{title}</Eyebrow>
        <span className="adv-s-faint" style={{ whiteSpace: 'nowrap' }}>
          {count}
        </span>
      </div>
      {children}
    </>
  );
}

function Row({ c, choice, onChoice }: { c: VersionChange; choice?: Choice; onChoice?: (v: Choice) => void }) {
  const [ground] = useGround();
  return (
    <div className="adv-s-urow">
      <GroundBox kind={ground}>
        <LabelChip name={c.item} style={plain(c.style)} fontPx={14} autoFit bright={ground === 'bright'} hidden={c.hidden} hiddenLook="fade" />
      </GroundBox>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span style={{ color: 'var(--text-strong)', lineHeight: 1.4 }}>{lfText(c.what)}</span>
        <span className="adv-s-faint" style={{ lineHeight: 1.4 }}>
          {lfText(c.conflict ?? c.why)}
        </span>
      </div>
      {onChoice && choice ? (
        <div className="adv-s-seg" role="group" aria-label={tr('lootfilter_advanced_views_UpdateView.which_one_to_keep')}>
          <button type="button" aria-pressed={choice === 'mine'} onClick={() => onChoice('mine')}>
            {tr('lootfilter_advanced_views_UpdateView.keep_mine')}
          </button>
          <button type="button" aria-pressed={choice === 'new'} onClick={() => onChoice('new')}>
            {tr('lootfilter_advanced_views_UpdateView.take_new')}
          </button>
        </div>
      ) : (
        <span />
      )}
    </div>
  );
}

interface Loaded {
  version: string;
  text: string;
  parsed: ParsedFilter;
  catalog: Catalog;
}

/** NeverSink update: the newer release laid against your filter, with every change that touches your rules waiting for your choice. */
export function UpdateView({ nav: _nav }: { nav: LfNav }) {
  const lf = useLf();
  const toast = useToast();
  const up = lf.update;
  const [checking, setChecking] = useState(false);
  const [dl, setDl] = useState<{ busy: boolean; error?: string }>({ busy: false });
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [choice, setChoice] = useState<Record<string, Choice>>({});
  const [preview, setPreview] = useState<{ diff: DiffResult; version: string } | null>(null);

  // The newest installed version above the one in use is the one to merge. A release not downloaded yet has to be fetched first.
  const target = useMemo(() => lf.installed.map((i) => i.version).filter((v) => compareVersions(v, lf.baseVersion) > 0).sort((a, b) => compareVersions(b, a))[0] ?? null, [lf.installed, lf.baseVersion]);
  const waiting = !target && up?.newer && up.latest ? up.latest : null;
  const sid = (STRICTNESS[lf.doc.setup.strictness] ?? STRICTNESS[2]).id;
  const stName = (STRICTNESS[lf.doc.setup.strictness] ?? STRICTNESS[2]).name;

  useEffect(() => {
    setChoice({});
    if (!target) {
      setLoaded(null);
      return;
    }
    let dead = false;
    setLoadErr(null);
    void (async () => {
      const r = await window.pom.lootFilter.baseFile(target, sid);
      if (dead) return;
      if (!r.ok) {
        setLoadErr(lfNet(r.error));
        return;
      }
      await new Promise((res) => window.setTimeout(res, 16));
      const parsed = parseBlocks(r.value.text);
      if (!dead) setLoaded({ version: target, text: r.value.text, parsed, catalog: buildCatalog(parsed.blocks) });
    })();
    return () => {
      dead = true;
    };
  }, [target, sid]);

  const diff = useMemo(() => (loaded && lf.catalog ? diffVersions(lf.catalog, loaded.catalog, lf.doc.rules, loaded.version, stName) : null), [loaded, lf.catalog, lf.doc.rules, stName]);
  const pick = (id: string): Choice => choice[id] ?? 'mine';

  /** Rules to turn off: the ones the player gave up on a conflict ("Take new"). */
  const disabled = useMemo(() => {
    const ids = new Set<string>();
    for (const c of diff?.conflicts ?? []) if (pick(c.id) === 'new') c.rules.forEach((r) => ids.add(r.id));
    return ids;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diff, choice]);
  const mergedRules = useMemo(() => lf.doc.rules.map((r) => (disabled.has(r.id) ? { ...r, enabled: false } : r)), [lf.doc.rules, disabled]);
  const merged = useMemo<GenerateResult | null>(() => {
    if (!loaded) return null;
    return generateFilter({ baseText: loaded.text, parsed: loaded.parsed, baseVersion: loaded.version, strictness: lf.doc.setup.strictness, style: lf.doc.setup.style, rules: mergedRules, ...(lf.doc.buildName ? { buildName: lf.doc.buildName } : {}) });
  }, [loaded, mergedRules, lf.doc.setup.strictness, lf.doc.setup.style, lf.doc.buildName]);

  const download = async (): Promise<void> => {
    setDl({ busy: true });
    const r = await lf.downloadUpdate();
    setDl(r.ok ? { busy: false } : { busy: false, error: r.message });
    toast({ text: r.message, kind: r.ok ? 'ok' : 'error' });
  };
  const check = async (): Promise<void> => {
    setChecking(true);
    await lf.checkUpdate(true);
    setChecking(false);
  };
  const doMerge = (): void => {
    if (!diff || !loaded) return;
    const off = disabled;
    if (off.size) lf.setRules(tr('lootfilter_advanced_views_UpdateView.merged_neversink_version', { version: loaded.version }), (rs) => rs.map((r) => (off.has(r.id) ? { ...r, enabled: false } : r)));
    lf.setSettings({ baseVersion: loaded.version });
    toast({ text: tr('lootfilter_advanced_views_UpdateView.merged_count_changes_from_neversink', { count: diff.counts.total, version: loaded.version }), kind: 'ok' });
  };
  const doPreview = (): void => {
    if (!merged || !lf.gen || !loaded) return;
    setPreview({ diff: diffLines(lf.gen.text, merged.text, 2, 400), version: loaded.version });
  };

  const notes = up?.latest?.body ? plainNotes(up.latest.body) : '';
  const kept = lf.doc.rules.filter((r) => r.enabled).length - disabled.size;
  const total = diff?.counts.total ?? 0;

  let title = `NeverSink ${lf.baseVersion || tr('lootfilter_advanced_views_UpdateView_2.not_loaded')}`;
  let sub = '';
  if (target) {
    title = tr('lootfilter_advanced_views_UpdateView_2.neversink_to', { baseVersion: lf.baseVersion, target: target });
    sub = diff ? (total === 0 ? tr('lootfilter_advanced_views_UpdateView_2.no_changes_the_two_files_list') : tr(total === 1 ? 'h_lootB_Views.upd_sub_one' : 'h_lootB_Views.upd_sub_other', { total, clean: diff.counts.clean, conflicts: diff.counts.conflicts })) : loadErr ? tr('lootfilter_advanced_views_UpdateView_2.the_new_file_could_not_be') : tr('lootfilter_advanced_views_UpdateView_2.reading_the_new_file');
  } else if (waiting) {
    title = tr('lootfilter_advanced_views_UpdateView_2.neversink_to_2', { baseVersion: lf.baseVersion, tag: waiting.tag });
    sub = tr('lootfilter_advanced_views_UpdateView_2.download_it_to_see_what_changes');
  } else if (up?.error) sub = tr('lootfilter_advanced_views_UpdateView_2.could_not_check_for_a_newer');
  else if (up) sub = tr('lootfilter_advanced_views_UpdateView_2.you_have_the_latest_release', { checkedAt: lfText(checkedText(up.checkedAt)) });
  else sub = tr('lootfilter_advanced_views_UpdateView_2.not_checked_for_a_newer_release');

  return (
    <Page>
      <Head title={title} sub={sub}>
        {target && (
          <>
            <Btn icon="eye" onClick={doPreview} disabled={!merged}>
              {tr('lootfilter_advanced_views_UpdateView.preview_merged_filter')}
            </Btn>
            <Btn kind="gold" onClick={doMerge} disabled={!diff}>
              {total ? tr('lootfilter_advanced_views_UpdateView.merge_count_changes', { count: total }) : 'Switch to ' + target}
            </Btn>
          </>
        )}
        {waiting && (
          <Btn kind="gold" icon="download" onClick={() => void download()} disabled={dl.busy}>
            {dl.busy ? tr('lootfilter_advanced_views_UpdateView.downloading') : tr('lootfilter_advanced_views_UpdateView.download_tag', { tag: waiting.tag })}
          </Btn>
        )}
        {!target && !waiting && (
          <Btn icon="refresh" onClick={() => void check()} disabled={checking}>
            {checking ? tr('lootfilter_advanced_views_UpdateView.checking') : tr('lootfilter_advanced_views_UpdateView.check_now')}
          </Btn>
        )}
      </Head>

      <div className="adv-s-two upd">
        <div className="lf-card" style={{ padding: '8px 16px 14px', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {target && !diff ? (
            loadErr ? (
              <div style={{ padding: '14px 0', display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span className="adv-s-strong">{tr('lootfilter_advanced_views_UpdateView.could_not_read_neversink_target', { target })}</span>
                <span className="adv-s-muted">{loadErr}</span>
              </div>
            ) : (
              <div className="adv-s-row" style={{ padding: '14px 0' }}>
                <Spinner />
                <span className="adv-s-muted">{tr('lootfilter_advanced_views_UpdateView.comparing_neversink_target_with_base', { target, baseVersion: lf.baseVersion })}</span>
              </div>
            )
          ) : diff ? (
            <>
              {diff.conflicts.length > 0 && (
                <Group title={tr('lootfilter_advanced_views_UpdateView.conflicts_with_your_changes')} count={tr('lootfilter_advanced_views_UpdateView.count_changes', { count: diff.conflicts.length })}>
                  {diff.conflicts.slice(0, MAX_LISTED).map((c) => (
                    <Row key={c.id} c={c} choice={pick(c.id)} onChoice={(v) => setChoice((o) => ({ ...o, [c.id]: v }))} />
                  ))}
                  {diff.conflicts.length > MAX_LISTED && <span className="adv-s-faint">{tr('lootfilter_advanced_views_UpdateView.and_max_listed_more_kept', { MAX_LISTED: diff.conflicts.length - MAX_LISTED })}</span>}
                </Group>
              )}
              {diff.fresh.length > 0 && (
                <Group title={tr('lootfilter_advanced_views_UpdateView.new')} count={tr('lootfilter_advanced_views_UpdateView.count_changes', { count: diff.fresh.length })}>
                  {diff.fresh.slice(0, MAX_LISTED).map((c) => (
                    <Row key={c.id} c={c} />
                  ))}
                  {diff.fresh.length > MAX_LISTED && <span className="adv-s-faint">{tr('lootfilter_advanced_views_UpdateView.and_max_listed_more', { MAX_LISTED: diff.fresh.length - MAX_LISTED })}</span>}
                </Group>
              )}
              {diff.changed.length > 0 && (
                <Group title={tr('lootfilter_advanced_views_UpdateView.changed')} count={tr('lootfilter_advanced_views_UpdateView.count_changes', { count: diff.changed.length })}>
                  {diff.changed.slice(0, MAX_LISTED).map((c) => (
                    <Row key={c.id} c={c} />
                  ))}
                  {diff.changed.length > MAX_LISTED && <span className="adv-s-faint">{tr('lootfilter_advanced_views_UpdateView.and_max_listed_more', { MAX_LISTED: diff.changed.length - MAX_LISTED })}</span>}
                </Group>
              )}
              {total === 0 && <span className="adv-s-faint" style={{ padding: '14px 0' }}>{tr('lootfilter_advanced_views_UpdateView.nothing_in_the_item_tables', { stName })}</span>}
            </>
          ) : (
            <div style={{ padding: '14px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Eyebrow>{waiting ? tr('lootfilter_advanced_views_UpdateView.neversink_tag', { tag: waiting.tag }) : up && !up.error ? tr('lootfilter_advanced_views_UpdateView.up_to_date') : tr('lootfilter_advanced_views_UpdateView.release')}</Eyebrow>
              {waiting ? (
                <span className="adv-s-muted">{tr('lootfilter_advanced_views_UpdateView.neversink_tag_is_out_and', { tag: waiting.tag, baseVersion: lf.baseVersion, baseVersion2: lf.baseVersion })}</span>
              ) : up?.error ? (
                <span className="adv-s-muted">{tr('lootfilter_advanced_views_UpdateView.error_the_installed_neversink_files', { error: up.error })}</span>
              ) : up ? (
                <span className="adv-s-muted">
                  {tr('lootfilter_advanced_views_UpdateView.neversink_baseversion_is_the_latest', { baseVersion: up.latest?.tag ?? lf.baseVersion })}{up.latest?.publishedAt ? tr('lootfilter_advanced_views_UpdateView.published_tolocaledatestring', { toLocaleDateString: new Date(up.latest.publishedAt).toLocaleDateString() }) : ''}{tr('lootfilter_advanced_views_UpdateView.there_is_nothing_to_merge')}
                </span>
              ) : (
                <span className="adv-s-muted">{tr('lootfilter_advanced_views_UpdateView.the_app_has_not_asked')}</span>
              )}
              {dl.error && <span style={{ color: 'var(--negative-text)', fontSize: 12.5 }}>{dl.error}</span>}
              {notes && (
                <>
                  <Eyebrow>{tr('lootfilter_advanced_views_UpdateView.release_notes')}</Eyebrow>
                  <pre className="adv-s-notes">{notes}</pre>
                </>
              )}
            </div>
          )}
        </div>

        <Panel>
          <Eyebrow>{tr('lootfilter_advanced_views_UpdateView.summary')}</Eyebrow>
          {diff ? (
            <>
              <div className="adv-s-kv"><span>{tr('lootfilter_advanced_views_UpdateView.apply_cleanly')}</span><span>{diff.counts.clean}</span></div>
              <div className="adv-s-kv"><span>{tr('lootfilter_advanced_views_UpdateView.need_a_choice')}</span><span>{diff.counts.conflicts}</span></div>
              <div className="adv-s-kv"><span>{tr('lootfilter_advanced_views_UpdateView.your_customizations_kept')}</span><span>{kept}</span></div>
              <div className="adv-s-kv"><span>{tr('lootfilter_advanced_views_UpdateView.new_file_size')}</span><span>{merged ? tr('lootfilter_advanced_views_UpdateView.tolocalestring_kb_of_1_mb', { merged: Math.round(merged.bytes / 1024).toLocaleString() }) : tr('lootfilter_advanced_views_UpdateView.counting')}</span></div>
            </>
          ) : (
            <>
              <div className="adv-s-kv"><span>{tr('lootfilter_advanced_views_UpdateView.your_customizations_kept')}</span><span>{lf.doc.rules.filter((r) => r.enabled).length}</span></div>
              <div className="adv-s-kv"><span>{tr('lootfilter_advanced_views_UpdateView.file_size_now')}</span><span>{lf.gen ? tr('lootfilter_advanced_views_UpdateView.tolocalestring_kb_of_1_mb', { merged: Math.round(lf.gen.bytes / 1024).toLocaleString() }) : tr('lootfilter_advanced_views_UpdateView.counting')}</span></div>
            </>
          )}
          <span className="adv-s-note">{tr('lootfilter_advanced_views_UpdateView.your_customizations_always_win_a')}</span>
        </Panel>
      </div>

      {preview && (
        <Dialog size="large" icon="info" title={tr('lootfilter_advanced_views_UpdateView.merged_filter_neversink_version', { version: preview.version })} subtitle={tr('lootfilter_advanced_views_UpdateView.tolocalestring_lines_added_tolocales', { added: preview.diff.added.toLocaleString(), removed: preview.diff.removed.toLocaleString() })} cancelLabel={null} confirmLabel={tr('lootfilter_advanced_views_UpdateView.close')} onCancel={() => setPreview(null)} onConfirm={() => setPreview(null)}>
          <div style={{ maxHeight: 420, overflow: 'auto', font: "500 12px/1.6 'Geist Mono', monospace", color: 'var(--text-2)' }}>
            {preview.diff.rows.map((r, i) => (
              <div key={i} style={{ whiteSpace: 'pre', color: r.kind === 'add' ? 'var(--positive-text)' : r.kind === 'del' ? 'var(--negative-text)' : r.kind === 'gap' ? 'var(--text-faint)' : undefined }}>
                {r.kind === 'add' ? '+ ' : r.kind === 'del' ? '- ' : r.kind === 'gap' ? '  ... ' : '  '}
                {r.text}
              </div>
            ))}
          </div>
        </Dialog>
      )}
    </Page>
  );
}
