import { createRoot } from 'react-dom/client';

import '../fixture.css';
import { installFakeRuntime } from './fake-runtime.js';
import { RailReorderApp } from './RailReorderApp.js';

// Before React, because the rail's workspace query fires on its first render and
// has to find a runtime already answering.
installFakeRuntime();

// Deliberately not `StrictMode`. The rail's drag engine registers sources
// through ref callbacks and reads live geometry; a double-invoked mount would
// have the fixture testing React's development behaviour rather than the rail's.
createRoot(document.getElementById('root')!).render(<RailReorderApp />);
