import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';

import { App } from './App.js';
import { applyThemeHint } from './lib/appearance/theme.js';
import { AppStateProvider } from './lib/state/AppStateProvider.js';
import { connectBrowserRevalidation } from './lib/state/policy.js';
import { makeAppRegistry } from './lib/state/registry.js';
import { ToastProvider } from './lib/toast/index.js';

import '@xterm/xterm/css/xterm.css';
import './styles.css';

const rootElement = document.querySelector('#root');

if (!rootElement) {
  throw new Error('Root element not found');
}

applyThemeHint();

// One app session per page: every atom, query cache and app service lives in this registry.
const registry = makeAppRegistry();
connectBrowserRevalidation(registry, window, () => document.visibilityState === 'visible');

createRoot(rootElement).render(
  <StrictMode>
    <AppStateProvider registry={registry}>
      <ToastProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ToastProvider>
    </AppStateProvider>
  </StrictMode>,
);
