import { createRoot } from 'react-dom/client';

import '../fixture.css';
import { installFakeRuntime } from './fake-runtime.js';
import { createScriptedEngine } from './scripted-engine.js';
import { WorkflowInspectorFixtureApp } from './WorkflowInspectorFixtureApp.js';

const root = createRoot(document.getElementById('root')!);

// Before React, because the workspace query fires on the container's first render and has to find a
// runtime already answering.
const runtime = installFakeRuntime();

// Wraps the real ELK engine so a spec can hold, reorder and fail its answers. The layouts it returns
// are real ones; only their timing is scripted.
const engine = createScriptedEngine();

// Exposed for the specs that need to change what the runtime says between assertions, and to count
// the requests the inspector actually made. Scaffolding, never product.
declare global {
  interface Window {
    inspectorFixture?: typeof runtime;
    inspectorEngine?: typeof engine;
  }
}
window.inspectorFixture = runtime;
window.inspectorEngine = engine;

// Deliberately not `StrictMode`, following the other fixtures: the coordinator's start ordering and
// the layout worker's lifecycle are mount-ordering rules, and a double-invoked mount would have this
// page testing React's development behaviour rather than the client's own.
root.render(<WorkflowInspectorFixtureApp runtime={runtime} engine={engine} />);
