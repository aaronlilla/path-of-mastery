// Renderer host for the Marketplace area: the feed and detail, Saved, Publish, Creator, Report and the moderation queue,
// all backed by the real main process over the mastery bridge (marketplacePorts.ts).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { unknown } from '../../shared/atlas/graph.js';
import type { LeagueStamp, PublicItemPayload } from '@pom/mastery-contracts';
import { MarketplaceArea } from '../marketplace/MarketplaceArea.js';
import type { CopyTarget } from '../marketplace/services.js';
import type { Direction, ViewerState } from '../marketplace/presenter.js';
import { SavedBrowser } from '../marketplace/saved/index.js';
import { PublishDialog } from '../marketplace/publish/PublishDialog.js';
import type { PublishSource, PublishType } from '../marketplace/publish/port.js';
import { CreatorArea, type CreatorView } from '../marketplace/creator/index.js';
import { ModerationQueue } from '../marketplace/moderation/ModerationQueue.js';
import { ReportDialog } from '../marketplace/moderation/ReportDialog.js';
import type { ReportTarget } from '../marketplace/moderation/presenter.js';
import { call } from './bridge.js';
import type { AreaIntent, MasteryShell } from './shell.js';
import { client, createCreatorPort, createModerationPort, createPublishPort, createServices, signInFlow, type PortEnv } from './marketplacePorts.js';
import { tr } from '../i18n';

type Mode = { kind: 'feed' } | { kind: 'saved' } | { kind: 'creator'; view: CreatorView; nonce: number } | { kind: 'moderation' };
type Leagues = { active: LeagueStamp; archives: { name: string; stamp: LeagueStamp }[] };
type Viewer = Pick<ViewerState, 'ownPostIds' | 'votes' | 'saved'>;

const NO_STAMP: LeagueStamp = { leagueId: unknown(tr('mastery_MarketplaceHost.no_league_is_loaded')), realm: unknown(tr('mastery_MarketplaceHost.no_league_is_loaded')), mode: unknown(tr('mastery_MarketplaceHost.no_league_is_loaded')),
  patchVersion: unknown(tr('mastery_MarketplaceHost.no_league_is_loaded')), datasetVersion: unknown(tr('mastery_MarketplaceHost.no_league_is_loaded')), createdAt: new Date(0).toISOString() };
const leagueName = (s: LeagueStamp): string | null => (s.leagueId.status === 'known' ? s.leagueId.value : null);
const WORKSPACES = 'mastery:workspaces';

async function loadLeagues(): Promise<Leagues> {
  try {
    const active = await call<{ stamp: LeagueStamp }>(WORKSPACES, { schemaVersion: 1, method: 'active' });
    const archives = await call<{ stamp: LeagueStamp }[]>(WORKSPACES, { schemaVersion: 1, method: 'archives' }).catch(() => []);
    return { active: active.stamp, archives: archives.flatMap(a => { const name = leagueName(a.stamp); return name ? [{ name, stamp: a.stamp }] : []; }) };
  } catch { return { active: NO_STAMP, archives: [] }; }
}

export function MarketplaceHost({ shell }: { shell: MasteryShell }) {
  const shellRef = useRef(shell); shellRef.current = shell;
  const [leagues, setLeagues] = useState<Leagues>({ active: NO_STAMP, archives: [] });
  const leaguesRef = useRef(leagues); leaguesRef.current = leagues;
  const [viewer, setViewer] = useState<Viewer>({ ownPostIds: [], votes: {}, saved: {} });
  const [mode, setMode] = useState<Mode>({ kind: 'feed' });
  const [open, setOpen] = useState<{ publicId: string; nonce: number } | null>(null);
  const [publish, setPublish] = useState<{ type?: PublishType; objectId?: string; source?: PublishSource | null } | null>(null);
  const [report, setReport] = useState<ReportTarget | null>(null);
  const nonce = useRef(0), pendingRevision = useRef<{ publicId: string; revision: number } | null>(null);
  const followState = useRef({ dot: false });
  const refreshRef = useRef<() => void>(() => undefined);
  const openItemRef = useRef<(publicId: string, revision?: number) => void>(() => undefined);

  const env = useMemo<PortEnv>(() => ({
    shell: () => shellRef.current, stamp: () => leaguesRef.current.active, leagueName: () => leagueName(leaguesRef.current.active), afterChange: () => refreshRef.current(), openItem: (publicId, revision) => openItemRef.current(publicId, revision),
  }), []);
  const ports = useMemo(() => {
    const base = createServices(env, followState.current);
    return {
      services: { ...base,
        // A deep link to one revision resolves that exact revision the first time the area asks for the item.
        item: (request: Parameters<typeof base.item>[0]) => {
          const pin = pendingRevision.current;
          if (pin && pin.publicId === request.publicId && request.revision === undefined) { pendingRevision.current = null; return base.item({ ...request, revision: pin.revision }); }
          return base.item(request);
        } },
      publish: createPublishPort(env), creator: createCreatorPort(env), moderation: createModerationPort(env),
    };
  }, [env]);

  useEffect(() => { void loadLeagues().then(setLeagues); }, [shell.online]);
  useEffect(() => {
    if (!shell.signedIn) return;
    void client.call('creatorPreference', {}).then(r => { if (r.ok && r.value.ok) followState.current.dot = r.value.value.showNewPostDot; }, () => undefined);
  }, [shell.signedIn]);

  const refreshViewer = useCallback(async () => {
    const next: Viewer = { ownPostIds: [], votes: {}, saved: {} };
    const saved = await client.call('saved', {}).catch(() => null);
    if (saved?.ok) for (const ref of saved.value) next.saved[ref.publicId] = { objectId: ref.objectId };
    if (shellRef.current.signedIn) {
      const activity = await client.call('activity', {}).catch(() => null);
      if (activity?.ok) {
        const latest = new Map<string, { sequence: number; direction: Direction }>();
        for (const e of activity.value) {
          if (e.operation !== 'vote' || e.state === 'cancelled' || e.state === 'failed') continue;
          const b = e.body as { request: { postId: string; direction: Direction }; clientSequence: number };
          const seen = latest.get(b.request.postId);
          if (!seen || seen.sequence < b.clientSequence) latest.set(b.request.postId, { sequence: b.clientSequence, direction: b.request.direction });
        }
        for (const [postId, v] of latest) next.votes[postId] = v.direction;
      }
      if (shellRef.current.online) {
        const posts = await client.call('posts', {}).catch(() => null);
        if (posts?.ok && posts.value.ok) next.ownPostIds = posts.value.value.items.map(p => String(p.postId));
      }
    }
    setViewer(next);
  }, []);
  refreshRef.current = () => { void refreshViewer(); };
  useEffect(() => { void refreshViewer(); }, [refreshViewer, shell.signedIn, shell.online]);

  const enterModeration = useCallback(async () => {
    const s = shellRef.current;
    if (!s.signedIn) { s.toast(tr('mastery_MarketplaceHost.sign_in_to_open_moderation')); s.signIn(); return; }
    // Only the server decides the role: the queue read answers a missing role with an error.
    const probe = await client.call('modQueue', { kind: 'report', status: 'open' }).catch(() => null);
    if (probe?.ok && probe.value.ok) setMode({ kind: 'moderation' });
    else s.toast(probe ? tr('mastery_MarketplaceHost.you_do_not_have_access') : tr('mastery_MarketplaceHost.moderation_is_unavailable_right_now'));
  }, []);
  const goView = useCallback((view: 'feed' | 'saved' | 'mine' | 'inbox' | 'moderation') => {
    if (view === 'feed') setMode({ kind: 'feed' });
    else if (view === 'saved') setMode({ kind: 'saved' });
    else if (view === 'moderation') void enterModeration();
    else setMode({ kind: 'creator', view: { view }, nonce: ++nonce.current });
  }, [enterModeration]);
  const openItem = useCallback((publicId: string, revision?: number) => {
    pendingRevision.current = revision ? { publicId, revision } : null;
    setMode({ kind: 'feed' }); setOpen({ publicId, nonce: ++nonce.current });
  }, []);

  openItemRef.current = openItem;
  const intent = shell.intent;
  useEffect(() => {
    if (!intent) return;
    const handled = ((i: AreaIntent): boolean => {
      switch (i.kind) {
        case 'public-item':
          openItem(i.publicId, i.revision);
          if (i.view === 'run') void (async () => {
            const got = await ports.services.item({ publicId: i.publicId as never, ...(i.revision ? { revision: i.revision } : {}) }).catch(() => null);
            if (!got || !got.result.ok) { shellRef.current.toast(tr('mastery_MarketplaceHost.this_item_is_unavailable')); return; }
            const started = await ports.services.run(got.result.value, 'detail').catch(() => ({ status: 'blocked' as const, reason: tr('mastery_MarketplaceHost.the_run_could_not_start') }));
            if (started.status === 'blocked') shellRef.current.toast(started.reason);
          })();
          return true;
        case 'publish': setPublish(i.source ? { type: i.source.kind, objectId: i.source.objectId } : {}); return true;
        case 'creator': setMode({ kind: 'creator', view: { view: 'profile', who: i.name ? { name: i.name } : { own: true } }, nonce: ++nonce.current }); return true;
        case 'marketplace-view': goView(i.view); return true;
        default: return false; // another area's intent
      }
    })(intent);
    if (handled) shellRef.current.clearIntent();
  }, [intent]); // eslint-disable-line react-hooks/exhaustive-deps

  // "Publish" from the Run window or a document: open the dialog on that exact document when it can be published.
  useEffect(() => {
    if (!publish?.objectId || publish.source !== undefined || !publish.type) return;
    let live = true;
    void ports.publish.sources(publish.type).then(list => list.find(s => s.objectId === publish.objectId) ?? null, () => null)
      .then(found => { if (live) setPublish(p => p && p.objectId === publish.objectId ? { ...p, source: found } : p); });
    return () => { live = false; };
  }, [publish, ports]);

  const sendToTimeline = useCallback(async (payload: PublicItemPayload) => {
    try {
      const ref = await ports.services.save(payload);
      shellRef.current.go('timelines', { kind: 'send-to-timeline', source: { kind: 'saved', objectId: ref.objectId } });
    } catch { shellRef.current.toast(tr('mastery_MarketplaceHost.could_not_save_this_item')); }
  }, [ports]);
  const openCopy = useCallback((target: CopyTarget) => {
    const p = target.payload, s = shellRef.current;
    const credit = p ? tr('mastery_MarketplaceHost.copied_from_title_by_displayname', { title: p.title, displayName: p.creator.displayName }) : '';
    // Build: the post's build code becomes a new build in Builds (App.tsx 'pom-open-build-copy'), opened as the current Build.
    if (p && p.document.kind === 'build' && p.document.payload.buildCode) {
      window.dispatchEvent(new CustomEvent('pom-open-build-copy', { detail: { name: p.title, code: p.document.payload.buildCode, credit } }));
      return;
    }
    // Atlas plan: an owned copy of the published plan opens in Atlas.
    if (p && p.document.kind === 'atlas') {
      const plan = { ...structuredClone(p.document.payload), title: p.title, stamp: { ...p.document.payload.stamp, createdAt: new Date().toISOString() } };
      void call<{ source: { objectId: string } }>('mastery:atlas-port', { method: 'create', args: [plan, credit] })
        .then(record => { s.toast(tr('mastery_MarketplaceHost.opened_a_copy_of_title', { title: p.title, credit })); s.go('atlas', { kind: 'open-document', objectId: record.source.objectId }); },
          () => s.toast(tr('mastery_MarketplaceHost.could_not_make_a_copy')));
      return;
    }
    s.toast(target.kind === 'build' ? tr('mastery_MarketplaceHost.this_post_has_no_build')
      : tr('mastery_MarketplaceHost.saved_to_your_saved_items'));
    s.go(target.kind === 'build' ? 'build' : 'timelines');
  }, []);
  /** Atlas "Compare with my plan": the published plan is kept as a read-only saved plan and opens on the right. */
  const comparePlan = useCallback((p: PublicItemPayload) => {
    if (p.document.kind !== 'atlas') return;
    const s = shellRef.current;
    void call<{ objectId: string }>('mastery:atlas-port', { method: 'savedCopy', args: [p.document.payload, `${p.publicId}:${p.publishedRevision.displayRevision as number}`, p.title] })
      .then(r => s.go('atlas', { kind: 'compare-plan', objectId: r.objectId }), () => s.toast(tr('mastery_MarketplaceHost.could_not_open_the_comparison')));
  }, []);
  const asTarget = (p: PublicItemPayload): ReportTarget => ({ kind: 'item', postId: p.publishedRevision.postId, revisionId: p.publishedRevision.revisionId, title: p.title, revisionLabel: String(p.publishedRevision.displayRevision) });

  const leagueList = leagues.archives.map(a => a.name);
  const activeName = leagueName(leagues.active);
  const fullViewer: ViewerState = { signedIn: shell.signedIn, ...viewer, activeLeague: activeName };
  const back = mode.kind === 'feed' ? null : <div style={{ padding: '8px 12px' }}><button type="button" className="btn" onClick={() => setMode({ kind: 'feed' })}>{tr('mastery_MarketplaceHost.back_to_marketplace')}</button></div>;

  return <>
    {/* The feed stays mounted while Saved or Creator is open so Back returns to the same rows and scroll. */}
    <div hidden={mode.kind !== 'feed'} style={{ height: '100%' }}>
      <MarketplaceArea key={open?.nonce ?? 0} services={ports.services} viewer={fullViewer} online={shell.online} league={leagues.active}
        leagues={[...(activeName ? [{ name: activeName, stamp: leagues.active }] : []), ...leagues.archives]}
        onSignIn={shell.signIn} onPublish={() => setPublish({})} onNavigate={to => goView(to)} onReport={p => setReport(asTarget(p))}
        onCreator={(name, publicId) => setMode({ kind: 'creator', view: { view: 'profile', who: publicId ? { name, publicId } : { name } }, nonce: ++nonce.current })}
        onOpenCopy={openCopy} onCompare={comparePlan} onSendToTimeline={p => void sendToTimeline(p)} onSaved={() => refreshRef.current()}
        {...(open ? { initialPublicId: open.publicId } : {})} />
    </div>
    {mode.kind === 'saved' && <div style={{ height: '100%', overflow: 'auto' }}>{back}
      <SavedBrowser client={client} online={shell.online} signedIn={shell.signedIn} signIn={() => signInFlow(env)} activeLeague={activeName} stamp={leagues.active}
        copyText={shell.copyText} openExternal={url => ports.services.openExternal(url)}
        onOpen={p => openItem(p.publicId, p.publishedRevision.displayRevision as number)} onSendToTimeline={p => void sendToTimeline(p)} onBrowse={() => setMode({ kind: 'feed' })} />
    </div>}
    {mode.kind === 'creator' && <div style={{ height: '100%', overflow: 'auto' }}>
      <CreatorArea key={mode.nonce} port={ports.creator} services={ports.services} viewer={fullViewer} account={shell.accountId}
        leagues={[...(activeName ? [{ id: activeName, label: activeName }] : []), ...leagueList.map(n => ({ id: n, label: n }))]} initial={mode.view}
        onBack={() => setMode({ kind: 'feed' })} onOpen={item => openItem(item.publicId, item.publishedRevision.displayRevision as number)}
        onReport={c => setReport({ kind: 'creator', creatorId: c.id, name: c.name })} onSignIn={shell.signIn}
        onEditPost={() => shell.toast(tr('mastery_MarketplaceHost.editing_a_published_post_is'))} onViewPost={() => shell.toast(tr('mastery_MarketplaceHost.open_this_post_from_the'))}
        onNewPost={() => setPublish({})} />
    </div>}
    {mode.kind === 'moderation' && <div style={{ height: '100%', overflow: 'auto' }}>{back}<ModerationQueue port={ports.moderation} access="granted" /></div>}
    {publish && (!publish.objectId || publish.source !== undefined) && <PublishDialog port={ports.publish} {...(publish.type ? { type: publish.type } : {})}
      {...(publish.source ? { source: publish.source } : {})} onClose={() => setPublish(null)}
      onPublished={() => refreshRef.current()} onOpenMyPosts={() => { setPublish(null); goView('mine'); }} />}
    {report && <ReportDialog target={report} port={ports.moderation} onClose={() => setReport(null)} />}
  </>;
}
