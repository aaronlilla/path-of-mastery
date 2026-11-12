// Mounts the Atlas, Timelines and Marketplace areas inside the existing App shell. Each area mounts on its first
// visit and then stays mounted (hidden) below the 40 px title bar, so its selection, scroll, drafts and editor session survive area switches.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Area as ShellArea } from '../shell/routes.js';
import type { Area as AppArea } from '../TitleBar';
import { ErrorBoundary } from '../ErrorBoundary';
import { useToast } from '../ui';
import { call, on } from './bridge.js';
import type { AreaIntent, MasteryShell } from './shell.js';
import { AtlasHost } from './AtlasHost';
import { TimelinesHost } from './TimelinesHost';
import { MarketplaceHost } from './MarketplaceHost';
import { HumanCheckHost } from './HumanCheckDialog.js';
import { RunChoiceHost } from './RunChoiceDialog.js';
import { areaEnabled } from '../areaGate.js';
import { tr } from '../i18n';

const toApp = (a: ShellArea): AppArea => (a === 'build' ? 'builds' : a);
type Hosted = 'atlas' | 'timelines' | 'marketplace';
const HOSTED: readonly Hosted[] = ['atlas', 'timelines', 'marketplace'];
type ItemRoute = { kind: 'item'; publicId: string; revision?: number; view: 'detail' | 'run' };

export type MasteryAreasProps = {
  area: AppArea;
  setArea: (a: AppArea) => void;
  signedIn: boolean;
  aiAccess: boolean;
  accountId: string | null;
  signIn(): void;
  requestAiAccess(): void;
  followStarter?(starterId: string): Promise<void>;
};

export function MasteryAreas(p: MasteryAreasProps) {
  const toast = useToast();
  const [online, setOnline] = useState(() => navigator.onLine);
  const [intents, setIntents] = useState<Partial<Record<Hosted, AreaIntent>>>({});
  const [seen, setSeen] = useState<Set<Hosted>>(() => new Set());
  const { setArea } = p;

  useEffect(() => {
    const up = () => setOnline(true), down = () => setOnline(false);
    window.addEventListener('online', up); window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);
  useEffect(() => {
    if ((HOSTED as readonly string[]).includes(p.area)) setSeen((s) => (s.has(p.area as Hosted) ? s : new Set(s).add(p.area as Hosted)));
  }, [p.area]);

  const go = useCallback((area: ShellArea, intent?: AreaIntent) => {
    // Switched-off areas (areaGate.ts) are never opened: a link or event that asks for one says so once and changes nothing.
    if (!areaEnabled(area)) { toast({ text: area === 'marketplace' ? tr('mastery_MasteryAreas.the_marketplace_is_not_open') : tr('mastery_MasteryAreas.timelines_are_not_open_yet') }); return; }
    if (intent && (HOSTED as readonly string[]).includes(area)) setIntents((m) => ({ ...m, [area]: intent }));
    setArea(toApp(area));
  }, [setArea, toast]);

  // pathofmastery://item/... links: pushed while running, or queued in main from a cold start (asked once on mount).
  useEffect(() => {
    const open = (r: ItemRoute) => go('marketplace', { kind: 'public-item', publicId: r.publicId, ...(r.revision ? { revision: r.revision } : {}), ...(r.view === 'run' ? { view: 'run' as const } : {}) });
    void call<ItemRoute | null>('mastery:links').then((r) => { if (r) open(r); }, () => undefined);
    const offItem = on('mastery:push:item-link', (r) => open(r as ItemRoute));
    // The Run window's "Open timeline" / "Open source" (main resolves the pinned object; it never sends a path).
    const offRun = on('mastery:push:run-open', (raw) => {
      const r = raw as { target: 'timeline' | 'source' | 'publish' | 'lootfilter'; objectId: string; revisionId?: string; kind?: string };
      if (r.target === 'publish') { go('marketplace', { kind: 'publish', source: { kind: 'timeline', objectId: r.objectId } }); return; }
      if (r.target === 'lootfilter') { go('filter'); return; }
      const area: ShellArea = r.target === 'timeline' ? 'timelines' : r.kind === 'atlas' ? 'atlas' : r.kind === 'build' ? 'build' : 'timelines';
      go(area, { kind: 'open-document', objectId: r.objectId, ...(r.revisionId ? { revisionId: r.revisionId } : {}) });
    });
    // The Build workspace (not an area host) asks for an area through this event, e.g. "Send to timeline".
    const onGo = (e: Event) => { const d = (e as CustomEvent<{ area: ShellArea; intent?: AreaIntent }>).detail; if (d?.area) go(d.area, d.intent); };
    window.addEventListener('pom:mastery-go', onGo);
    return () => { offItem(); offRun(); window.removeEventListener('pom:mastery-go', onGo); };
  }, [go]);

  const shellFor = useMemo(() => (area: Hosted): MasteryShell => ({
    online,
    active: p.area === area,
    signedIn: p.signedIn,
    aiAccess: p.aiAccess,
    accountId: p.accountId,
    signIn: p.signIn,
    requestAiAccess: p.requestAiAccess,
    go,
    intent: intents[area] ?? null,
    clearIntent: () => setIntents((m) => { if (!m[area]) return m; const n = { ...m }; delete n[area]; return n; }),
    toast: (text) => toast({ text }),
    copyText: async (text) => { try { await navigator.clipboard.writeText(text); return true; } catch { return false; } },
    openExternal: (url) => { if (/^https:\/\//.test(url)) window.open(url, '_blank', 'noopener'); },
    followStarter: p.followStarter,
  }), [online, p.area, p.signedIn, p.aiAccess, p.accountId, p.signIn, p.requestAiAccess, p.followStarter, go, intents, toast]);

  const back = { label: tr('mastery_MasteryAreas.back_to_builds'), run: () => setArea('builds') };
  const pane = (area: Hosted, label: string, node: JSX.Element) => areaEnabled(area) && (seen.has(area) || p.area === area) && (
    <div key={area} className="mastery-area" data-area={area} hidden={p.area !== area} style={{ position: 'absolute', inset: '40px 0 0 0', overflow: 'auto', display: p.area === area ? undefined : 'none' }}>
      <ErrorBoundary scope="area" label={label} back={back}>{node}</ErrorBoundary>
    </div>
  );
  return (
    <>
      {pane('atlas', tr('mastery_MasteryAreas_2.atlas'), <AtlasHost shell={shellFor('atlas')} />)}
      {pane('timelines', tr('mastery_MasteryAreas_2.timelines'), <TimelinesHost shell={shellFor('timelines')} />)}
      {pane('marketplace', tr('mastery_MasteryAreas_2.marketplace'), <MarketplaceHost shell={shellFor('marketplace')} />)}
      <HumanCheckHost online={online} />
      <RunChoiceHost />
    </>
  );
}
