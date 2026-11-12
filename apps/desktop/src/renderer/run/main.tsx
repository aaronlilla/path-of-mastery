import { createRoot } from 'react-dom/client';
import type { RunBridge } from '../../shared/run/bridge.js';
import { RunApp } from './RunApp';
import type { RunMeta } from './presenter';
import type { RunServices } from './services';
import '../design/fonts/fonts.css';
import '../design/tokens.css';
import './run.css';

// The Run window has its own preload (main/run/preload.cjs), which exposes only `masteryRun`.
// The app may also expose `masteryRunMeta` (timeline title, owned/public) and public-side services.
declare global { interface Window { masteryRun?: RunBridge; masteryRunServices?: RunServices; masteryRunMeta?: RunMeta } }
const bridge = window.masteryRun;
createRoot(document.getElementById('root')!).render(bridge
  ? <RunApp bridge={bridge} meta={window.masteryRunMeta} services={window.masteryRunServices} />
  : <div className="run-root"><div className="run-wait">Run is not available in this window.</div></div>);
