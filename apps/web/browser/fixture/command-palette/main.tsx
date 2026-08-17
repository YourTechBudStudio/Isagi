import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '../fixture.css';
import { CommandPaletteFixtureApp } from './CommandPaletteFixtureApp.js';

// No runtime install: this page reaches no endpoint. The catalog is hardcoded
// and selection is local, which is the whole point of the phase — presentation
// settled before any data or focus wiring exists to argue with it.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CommandPaletteFixtureApp />
  </StrictMode>,
);
