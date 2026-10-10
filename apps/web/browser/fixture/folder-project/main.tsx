import { createRoot } from 'react-dom/client';

import '../fixture.css';
import { installFakeRuntime } from './fake-runtime.js';
import { FolderProjectApp } from './FolderProjectApp.js';
import { fixtureRegistry } from './registry.js';

if (new URLSearchParams(window.location.search).get('app') === 'state-transitions') {
  // The state-transitions page: the production entry itself, over an instrumented fake runtime.
  // Mounting `src/main.tsx` rather than a fixture tree keeps the provider stack, the startup gate
  // and the workspace page exactly what the app ships, so the specs that read this page observe
  // production state behaviour and need no edit when the state library underneath changes. The
  // runtime is installed first, because the control-plane read fires on the first render.
  const { installStateTransitionsRuntime } = await import('./state-transitions/runtime.js');
  installStateTransitionsRuntime();
  await import('../../../src/main.js');
} else {
  // Before React: the workspace query fires on the first render and has to find a
  // runtime already answering.
  installFakeRuntime(fixtureRegistry);

  // Deliberately not `StrictMode`. The recheck prototype is a mutation with two
  // awaited stages, and a double-invoked mount would have the fixture judging
  // React's development behaviour rather than the sequence being designed.
  createRoot(document.getElementById('root')!).render(<FolderProjectApp />);
}
