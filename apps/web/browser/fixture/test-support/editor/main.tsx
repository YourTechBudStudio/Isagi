import { createRoot } from 'react-dom/client';

import '../../fixture.css';
import { EditorTestSupportApp } from './EditorTestSupportApp.js';
import { installFakeRuntime } from './fake-runtime.js';

// Before React, because the surface-detail query fires on its first render and
// has to find a runtime already answering.
const runtime = installFakeRuntime();

// Deliberately not `StrictMode`, following the command-palette and rail
// harnesses. The container's mount-time ensure, the frame-load handover, and the
// focus router all depend on mount/cleanup ordering; a double-invoked mount would
// have this page testing React's development behaviour rather than the pane's.
createRoot(document.getElementById('root')!).render(<EditorTestSupportApp runtime={runtime} />);
