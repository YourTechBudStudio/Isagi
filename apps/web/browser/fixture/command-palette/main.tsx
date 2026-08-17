import { createRoot } from 'react-dom/client';

import '../fixture.css';
import { CommandPaletteFixtureApp } from './CommandPaletteFixtureApp.js';
import { installFakeRuntime } from './fake-runtime.js';

// Before React, because the palette's workspace and control-plane queries fire on
// their first render and have to find a runtime already answering.
const runtime = installFakeRuntime();

// Deliberately not `StrictMode`, following the rail fixture. The palette's focus
// effects, the drawer's registration effect, and the focus router all depend on
// mount/cleanup ordering; a double-invoked mount would have this page testing
// React's development behaviour rather than the workbench's focus ownership.
createRoot(document.getElementById('root')!).render(<CommandPaletteFixtureApp runtime={runtime} />);
