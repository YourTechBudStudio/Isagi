import { createRoot } from 'react-dom/client';

import '../fixture.css';
import { installFakeRuntime } from './fake-runtime.js';
import { FolderProjectApp } from './FolderProjectApp.js';

// Before React: the workspace query fires on the first render and has to find a
// runtime already answering.
installFakeRuntime();

// Deliberately not `StrictMode`. The recheck prototype is a mutation with two
// awaited stages, and a double-invoked mount would have the fixture judging
// React's development behaviour rather than the sequence being designed.
createRoot(document.getElementById('root')!).render(<FolderProjectApp />);
