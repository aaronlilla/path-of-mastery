// Community builds: the list in the Library, the "Similar builds" dialog, and the publish dialog with "My published builds".
import { useCallback, useEffect, useState } from 'react';
import { communityClassLabel, PUBLISH_CONSENT, stripNotes, type CommunityBuild } from '../shared/community.js';
import { readBuildInfo } from '../shared/buildXml.js';
import { useAcct } from './accounts/useAccount';
import { Dialog, useToast } from './ui';
import { tr, fromMain } from './i18n';

type Load<T> = { state: 'loading' } | { state: 'error'; error: string } | { state: 'ok'; value: T };

function useLoad<T>(fetcher: () => Promise<{ ok: true; value: T } | { ok: false; error: string }>, deps: unknown[]): [Load<T>, () => void] {
  const [s, setS] = useState<Load<T>>({ state: 'loading' });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let on = true;
    setS({ state: 'loading' });
    void fetcher().then((r) => on && setS(r.ok ? { state: 'ok', value: r.value } : { state: 'error', error: r.error }));
    return () => void (on = false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return [s, () => setTick((n) => n + 1)];
}

/** One community build: name, class, level, author, and Open. Report asks first and needs an account. */
function CommunityRow({ b, onOpen, openLabel = tr('community_2.open') }: { b: CommunityBuild; onOpen: (b: CommunityBuild) => void; openLabel?: string }) {
  const acct = useAcct();
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  const [done, setDone] = useState(false);
  const report = async () => {
    if (!acct.signedIn) return void acct.openSignIn();
    const r = await window.pom.account.communityReport(b.id, tr('community.reported_from_the_app'));
    setAsking(false);
    if (r.ok) setDone(true);
    else toast({ text: r.error, kind: 'error' });
  };
  return (
    <div className="com-item" data-source={b.source}>
      <button type="button" className="com-open" aria-label={tr('community.openlabel_name_v3_level_level', { openLabel, name: b.name, value: communityClassLabel(b), level: b.level })} onClick={() => onOpen(b)}>
        <span className="com-name">
          <span className="t">{b.name}</span>
          {b.source === 'curated' && <span className="com-badge" title={tr('community.picked_by_the_app_s')}>{tr('community.curated')}</span>}
        </span>
        <span className="com-meta">
          {tr('community.v1_lv_level', { value: communityClassLabel(b), level: b.level })}
          {b.mainSkill ? ` · ${b.mainSkill}` : ''}
          {b.author ? tr('community.by_author', { author: b.author }) : ''}
        </span>
      </button>
      <span className="com-act">
        {done ? (
          <span className="com-note" role="status">{tr('community.reported_thank_you')}</span>
        ) : asking ? (
          <>
            <span className="com-note">{tr('community.report_this_build')}</span>
            <button type="button" className="btn sm danger" onClick={() => void report()}>{tr('community.report')}</button>
            <button type="button" className="btn sm ghost" onClick={() => setAsking(false)}>{tr('community.cancel')}</button>
          </>
        ) : (
          <>
            <span className="com-go" aria-hidden>{openLabel}</span>
            <button type="button" className="com-report" aria-label={tr('community.report_name', { name: b.name })} title={tr('community.report_this_build_as_spam')} onClick={() => setAsking(true)}>{tr('community.report')}</button>
          </>
        )}
      </span>
    </div>
  );
}

/** The Library's Community section: newest community builds, real ones only. An empty list says so. */
export function CommunityList({ onOpen, onManage }: { onOpen: (b: CommunityBuild) => void; onManage: () => void }) {
  const [s, retry] = useLoad(() => window.pom.account.communityList({ limit: 12 }), []);
  return (
    <div className="com-list" aria-live="polite">
      {s.state === 'loading' && <div className="com-empty">{tr('community.loading_community_builds')}</div>}
      {s.state === 'error' && (
        <div className="com-empty bad" role="alert">
          {tr('community.could_not_load_community_builds', { error: s.error, value: ' ' })}
          <button type="button" className="btn sm" onClick={retry}>{tr('community.try_again')}</button>
        </div>
      )}
      {s.state === 'ok' && s.value.length === 0 && <div className="com-empty">{tr('community.no_community_builds_yet_publish')}</div>}
      {s.state === 'ok' && s.value.map((b) => <CommunityRow key={b.id} b={b} onOpen={onOpen} />)}
      <div className="com-foot">
        <button type="button" className="btn sm ghost" onClick={onManage}>{tr('community.my_published_builds')}</button>
      </div>
    </div>
  );
}

/** Community builds with the same class and main skill as the open build. */
export function SimilarBuildsDialog({ xml, onOpen, onClose }: { xml: string; onOpen: (b: CommunityBuild) => void; onClose: () => void }) {
  const info = readBuildInfo(xml);
  const [s, retry] = useLoad(
    () => (info.className && info.mainSkill ? window.pom.account.communitySimilar({ className: info.className, ascendClassName: info.ascendClassName, mainSkill: info.mainSkill }) : Promise.resolve({ ok: true as const, value: [] as CommunityBuild[] })),
    [info.className, info.ascendClassName, info.mainSkill],
  );
  const what = [info.ascendClassName && info.ascendClassName !== 'None' ? info.ascendClassName : info.className, info.mainSkill].filter(Boolean).join(' · ');
  return (
    <Dialog icon="share" size={s.state === 'error' ? 'small' : 'medium'} title={tr('community.similar_builds')} subtitle={what ? tr('community.community_builds_with_the_same', { what }) : tr('community.this_build_has_no_class')} cancelLabel={null} confirmLabel={null} onCancel={onClose}>
      <div className="com-list" aria-live="polite">
        {s.state === 'loading' && <div className="com-empty">{tr('community.looking_for_similar_builds')}</div>}
        {s.state === 'error' && (
          <div className="com-empty bad" role="alert" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 'var(--s-4)' }}>
            <span>{tr('community.could_not_load_similar_builds', { error: s.error, value: ' ' })}</span>
            <button type="button" className="btn sm" onClick={retry}>{tr('community.try_again')}</button>
          </div>
        )}
        {s.state === 'ok' && s.value.length === 0 && <div className="com-empty">{tr('community.no_similar_community_builds_yet')}</div>}
        {s.state === 'ok' && s.value.map((b) => <CommunityRow key={b.id} b={b} onOpen={onOpen} />)}
      </div>
    </Dialog>
  );
}

/** My published builds, with Unpublish. Used inside the publish dialog and on its own from the Library. */
function Mine({ reload }: { reload: number }) {
  const toast = useToast();
  const [s, retry] = useLoad(() => window.pom.account.communityMine(), [reload]);
  const [busy, setBusy] = useState<string | null>(null);
  const remove = async (b: CommunityBuild) => {
    setBusy(b.id);
    const r = await window.pom.account.communityUnpublish(b.id);
    setBusy(null);
    if (r.ok) {
      toast({ text: tr('community.name_is_no_longer_public', { name: b.name }), kind: 'ok' });
      retry();
    } else toast({ text: r.error, kind: 'error' });
  };
  return (
    <section aria-label={tr('community.my_published_builds')} className="com-mine">
      <div className="lbl">{tr('community.my_published_builds_2')}</div>
      {s.state === 'loading' && <div className="com-empty">{tr('community.loading')}</div>}
      {s.state === 'error' && <div className="com-empty bad" role="alert">{tr('community.could_not_load_your_builds', { error: s.error })}</div>}
      {s.state === 'ok' && s.value.length === 0 && <div className="com-empty">{tr('community.you_have_not_published_any')}</div>}
      {s.state === 'ok' &&
        s.value.map((b) => (
          <div key={b.id} className="com-item">
            <div className="com-open" style={{ cursor: 'default' }}>
              <span className="com-name"><span className="t">{b.name}</span>{b.hidden && <span className="com-badge warn" title={tr('community.three_players_reported_this_build')}>{tr('community.hidden_after_reports')}</span>}</span>
              <span className="com-meta">{tr('community.v1_lv_level', { value: communityClassLabel(b), level: b.level })}{b.mainSkill ? ` · ${b.mainSkill}` : ''}</span>
            </div>
            <span className="com-act">
              <button type="button" className="btn sm" disabled={busy === b.id} aria-label={tr('community.unpublish_name', { name: b.name })} onClick={() => void remove(b)}>{tr('community.unpublish')}</button>
            </span>
          </div>
        ))}
    </section>
  );
}

/** Publishing is a deliberate act: the player names the build, picks a display name and ticks that it becomes public. */
export function PublishDialog({ name, xml, onClose }: { name: string; xml: string; onClose: () => void }) {
  const acct = useAcct();
  const toast = useToast();
  const user = acct.view?.auth.state === 'signedIn' ? acct.view.auth.user : null;
  const [title, setTitle] = useState(name);
  const [author, setAuthor] = useState(user?.name ?? '');
  const [notes, setNotes] = useState(false);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [published, setPublished] = useState(false);
  useEffect(() => {
    if (user && !author) setAuthor(user.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);
  const info = readBuildInfo(xml);
  const ready = !!user && consent && title.trim().length > 0 && info.valid && !!info.className && !!info.mainSkill;
  const publish = useCallback(async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    const r = await window.pom.account.communityPublish({
      name: title.trim(),
      author: author.trim(),
      xml: notes ? xml : stripNotes(xml),
      className: info.className,
      ascendClassName: info.ascendClassName === 'None' ? '' : info.ascendClassName,
      level: info.level,
      mainSkill: info.mainSkill,
      treeVersion: info.treeVersion,
    });
    setBusy(false);
    if (r.ok) {
      setPublished(true);
      setReload((n) => n + 1);
      toast({ text: tr('community.trim_is_published', { title: title.trim() }), kind: 'ok' });
    } else setError(r.error);
  }, [ready, busy, title, author, notes, xml, info.className, info.ascendClassName, info.level, info.mainSkill, info.treeVersion, toast]);

  if (!user) {
    return (
      <Dialog icon="user" title={tr('community.publish_to_community')} subtitle={tr('community.publishing_needs_an_account_so')} confirmLabel={tr('community.sign_in')} onCancel={onClose} onConfirm={() => { onClose(); acct.openSignIn(); }} />
    );
  }
  return (
    <Dialog
      icon="share"
      size="medium"
      title={tr('community.publish_to_community')}
      subtitle={tr('community.share_this_build_with_every')}
      confirmLabel={published ? tr('community.publish_again') : tr('community.publish')}
      confirmIcon="share"
      confirmDisabled={!ready}
      confirmBusy={busy}
      cancelLabel={tr('community.close')}
      onCancel={onClose}
      onConfirm={() => void publish()}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {!info.className || !info.mainSkill ? <div className="field-msg bad" role="alert">{tr('community.add_a_main_skill_to')}</div> : null}
        <label className="field-label">
          <span className="lbl">{tr('community.name')}</span>
          <input className="input" data-autofocus aria-label={tr('community.name')} value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="field-label">
          <span className="lbl">{tr('community.shown_as_author')}</span>
          <input className="input" aria-label={tr('community.display_name')} value={author} maxLength={40} onChange={(e) => setAuthor(e.target.value)} />
          <span className="field-msg">{tr('community.not_your_email_leave_it')}</span>
        </label>
        <label className="com-check">
          <input type="checkbox" checked={notes} onChange={(e) => setNotes(e.target.checked)} />
          <span>{tr('community.include_my_build_notes_left')}</span>
        </label>
        <label className="com-check">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span>{fromMain('ml_mastery_text', PUBLISH_CONSENT)}</span>
        </label>
        <div role="alert" className={'field-msg' + (error ? ' bad' : '')} style={{ minHeight: 18 }}>{error ?? (published ? tr('community.published_it_shows_in_similar') : '')}</div>
        <Mine reload={reload} />
      </div>
    </Dialog>
  );
}

/** "My published builds" on its own, opened from the Library. */
export function MyPublishedDialog({ onClose }: { onClose: () => void }) {
  const acct = useAcct();
  if (!acct.signedIn) return <Dialog icon="user" title={tr('community.my_published_builds')} subtitle={tr('community.sign_in_to_see_and')} confirmLabel={tr('community.sign_in')} onCancel={onClose} onConfirm={() => { onClose(); acct.openSignIn(); }} />;
  return (
    <Dialog icon="share" size="medium" title={tr('community.my_published_builds')} subtitle={tr('community.unpublish_removes_a_build_from')} cancelLabel={tr('community.close')} confirmLabel={null} onCancel={onClose}>
      <Mine reload={0} />
    </Dialog>
  );
}
