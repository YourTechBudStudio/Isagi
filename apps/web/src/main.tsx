import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';

import { App } from './App.js';
import { queryClient } from './lib/query/client.js';
import { ToastProvider } from './lib/toast/index.js';

import '@xterm/xterm/css/xterm.css';
import './styles.css';

const rootElement = document.querySelector('#root');

if (!rootElement) {
  throw new Error('Root element not found');
}

// TEMPORARY (Phase 03) — development-only entry into the terminal runtime-failure
// boot surface via `?boot-fixture`. `import.meta.env.DEV` is statically false in
// production builds, so this branch and its dynamic import are dead-code-
// eliminated and the fixture module never ships. Phase 04 removes this branch and
// `routes/startup/boot-failure-fixture.tsx`.
if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('boot-fixture')) {
  void import('./routes/startup/boot-failure-fixture.js').then((module) => {
    module.mountBootFailureFixture(rootElement);
  });
} else {
  createRoot(rootElement).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </ToastProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}
