import { Route, Routes } from 'react-router';

// TEMPORARY (Phase 03, workflow-source-precedence): dev-only palette diagnostic
// fixture. Remove this import and the guarded route in Phase 04. See
// scratch/plans/workflow-source-precedence/decisions.md.
import { PaletteDiagnosticFixture } from './routes/__fixtures/PaletteDiagnosticFixture.js';
import { StartupGate } from './routes/startup/StartupGate.js';

export function App() {
  return (
    <Routes>
      {import.meta.env.DEV && (
        <Route path="/__fixtures/palette" element={<PaletteDiagnosticFixture />} />
      )}
      <Route element={<StartupGate />} path="*" />
    </Routes>
  );
}
