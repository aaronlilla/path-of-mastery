import './design/fonts/fonts.css';
import './design/tokens.css';
import './design/responsive.css';
import './ui.css';
import './shell.css';
import './library.css';
import './screens.css';
import './tree.css';
import './tabs2.css';
import './buildsArea.css';
import { DEFAULT_SETTINGS } from '../shared/library.js';
import { initI18n } from './i18nLoad';

const container = document.getElementById('root');
if (!container) throw new Error('missing #root element');

// The language is set before any screen code loads, so strings built at load time are already in it.
void (async () => {
  const saved = await window.pom.settings.get();
  await initI18n(saved.ok ? saved.value.language : DEFAULT_SETTINGS.language);
  const [{ StrictMode }, { createRoot }, { App }, { installControlWheel }, { installFocusLayers }, { installAutoTitles }, { ErrorBoundary }, { ToastHost }] = await Promise.all([
    import('react'),
    import('react-dom/client'),
    import('./App'),
    import('./controlWheel'),
    import('./focusLayers'),
    import('./autoTitles'),
    import('./ErrorBoundary'),
    import('./ui'),
  ]);
  installControlWheel();
  installFocusLayers();
  installAutoTitles();
  createRoot(container).render(
    <StrictMode>
      <ErrorBoundary scope="app" label="Path of Mastery">
        <ToastHost>
          <App />
        </ToastHost>
      </ErrorBoundary>
    </StrictMode>,
  );
})();
