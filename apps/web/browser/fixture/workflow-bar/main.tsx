import { createRoot } from 'react-dom/client';

import '../fixture.css';
import { installFakeRuntime } from './fake-runtime.js';
import { WorkflowBarFixtureApp } from './WorkflowBarFixtureApp.js';

const root = createRoot(document.getElementById('root')!);

// Before React, because the container's workspace query fires on its first render and has to find a
// runtime already answering.
const runtime = installFakeRuntime();

// Deliberately not `StrictMode`, following the other fixtures: the input flow's draft reset and the
// attached-run sync are mount-ordering effects, and a double-invoked mount would have this page
// testing React's development behaviour rather than the client's own rules.
root.render(<WorkflowBarFixtureApp runtime={runtime} />);
