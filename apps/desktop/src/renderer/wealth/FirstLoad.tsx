import type { WealthView } from '../../shared/wealth.js';
import type { Sub } from './useWealth.js';
import { Eyebrow, Panel } from './wui.js';

import { loadSteps } from './loadSteps.js';
import { tr } from '../i18n';

const Bar = ({ w = '100%', h = 14 }: { w?: string | number; h?: number }) => <span className="w-sk" style={{ width: w, height: h }} />;

/** The first-load state: the same cards the screen will show, as skeletons, with the live progress on top. */
export function FirstLoad({ w, sub }: { w: WealthView; sub: Sub }) {
  const s = loadSteps(w);
  const frac = w.prices.progress ? w.prices.progress.done / Math.max(1, w.prices.progress.total) : w.prices.lines > 0 ? 1 : 0;
  return (
    <div className="w-firstload" data-state="loading" data-sub={sub} role="status" aria-live="polite">
      <Panel className="w-fl-head">
        <div className="w-fl-steps">
          <span className="w-fl-step" data-done={w.prices.lines > 0}><i />{s.prices}</span>
          {s.stash && <span className="w-fl-step" data-done={!!w.sync.lastSyncAt}><i />{s.stash}</span>}
        </div>
        <span className="w-fl-bar"><b style={{ width: `${Math.round(frac * 100)}%` }} /></span>
      </Panel>
      {(sub === 'overview' || sub === 'sessions') && (
        <div className="w-fl-grid">
          <Panel className="w-fl-big"><Eyebrow>{sub === 'overview' ? tr('wealth_FirstLoad.net_worth') : tr('wealth_FirstLoad.sessions')}</Eyebrow><div className="w-fl-in"><Bar w={180} h={34} /><Bar w="100%" h={120} /></div></Panel>
          <Panel className="w-fl-card"><Eyebrow>{sub === 'overview' ? tr('wealth_FirstLoad.running_session') : tr('wealth_FirstLoad.detail')}</Eyebrow><div className="w-fl-in"><Bar w="60%" /><Bar /><Bar w="80%" /><Bar w="45%" /></div></Panel>
          <Panel className="w-fl-card"><Eyebrow>{sub === 'overview' ? tr('wealth_FirstLoad.breakdown') : tr('wealth_FirstLoad.value_added')}</Eyebrow><div className="w-fl-in"><Bar /><Bar /><Bar w="70%" /><Bar w="55%" /></div></Panel>
          <Panel className="w-fl-card"><Eyebrow>{sub === 'overview' ? tr('wealth_FirstLoad.movers') : tr('wealth_FirstLoad.gained')}</Eyebrow><div className="w-fl-in"><Bar /><Bar w="85%" /><Bar w="60%" /></div></Panel>
        </div>
      )}
      {(sub === 'stash' || sub === 'market') && (
        <Panel className="w-fl-table"><Eyebrow>{sub === 'market' ? tr('wealth_FirstLoad.prices') : tr('wealth_FirstLoad.stash')}</Eyebrow><div className="w-fl-in">{Array.from({ length: 9 }, (_, i) => <Bar key={i} w={`${96 - (i % 4) * 9}%`} h={22} />)}</div></Panel>
      )}
      {(sub === 'strategies' || sub === 'filter') && (
        <div className="w-fl-grid two">
          <Panel className="w-fl-table"><Eyebrow>{sub === 'filter' ? tr('wealth_FirstLoad.your_filter') : tr('wealth_FirstLoad.strategies')}</Eyebrow><div className="w-fl-in">{Array.from({ length: 6 }, (_, i) => <Bar key={i} w={`${92 - (i % 3) * 10}%`} h={26} />)}</div></Panel>
          <Panel className="w-fl-card"><Eyebrow>{tr('wealth_FirstLoad.detail')}</Eyebrow><div className="w-fl-in"><Bar w="55%" h={28} /><Bar /><Bar w="90%" /><Bar w="70%" /></div></Panel>
        </div>
      )}
    </div>
  );
}
