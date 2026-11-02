import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';

import { App } from '../../../../src/App.js';
import { applyThemeHint } from '../../../../src/lib/appearance/theme.js';
import { connectAuthSignal } from '../../../../src/lib/auth/state.js';
import { AppStateProvider } from '../../../../src/lib/state/AppStateProvider.js';
import { ToastProvider } from '../../../../src/lib/toast/index.js';
import { createFixtureRegistry } from '../registry.js';

import '@xterm/xterm/css/xterm.css';
import '../../fixture.css';

/**
 * A test-support harness for the startup gate: the production `App`, mounted exactly as `main.tsx`
 * mounts it (one registry with browser revalidation and the auth signal connected, the toast
 * provider, the router). Nothing is faked in the page. The spec plays the runtime from outside
 * with Playwright request and socket routing, so the runtime's state survives the reload a
 * sign-in performs, which an in-page `fetch` stub cannot.
 */
applyThemeHint();
const registry = createFixtureRegistry();
connectAuthSignal(registry);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div data-startup-test-support className="contents">
      <AppStateProvider registry={registry}>
        <ToastProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </ToastProvider>
      </AppStateProvider>
    </div>
  </StrictMode>,
);
