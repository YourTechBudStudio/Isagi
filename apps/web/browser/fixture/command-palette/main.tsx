import { createRoot } from 'react-dom/client';

import '../fixture.css';
import { CommandPaletteFixtureApp } from './CommandPaletteFixtureApp.js';
import { installFakeRuntime } from './fake-runtime.js';
import { PathCompletionPreview } from './PathCompletionPreview.js';

const root = createRoot(document.getElementById('root')!);

// Story #39, phase 02: a temporary preview of the target path interaction, off the
// normal entry entirely — no fake runtime, no palette, no workspace store. Phase 03
// deletes this branch along with the preview it renders.
if (new URLSearchParams(window.location.search).get('pathPreview') === '1') {
  root.render(<PathCompletionPreview />);
} else {
  // Before React, because the palette's workspace and control-plane queries fire on
  // their first render and have to find a runtime already answering.
  const runtime = installFakeRuntime();

  // Deliberately not `StrictMode`, following the rail fixture. The palette's focus
  // effects, the drawer's registration effect, and the focus router all depend on
  // mount/cleanup ordering; a double-invoked mount would have this page testing
  // React's development behaviour rather than the workbench's focus ownership.
  root.render(<CommandPaletteFixtureApp runtime={runtime} />);
}
