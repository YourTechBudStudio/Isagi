import { Route, Routes } from 'react-router';

import { AgentPaneMocksPage } from './routes/dev/AgentPaneMocksPage.js';
import { WorkspacePage } from './routes/workspace/WorkspacePage.js';

export function App() {
  return (
    <Routes>
      {/* Dev-only mock preview (plan Phase 1). Never mounted in production. */}
      {import.meta.env.DEV ? (
        <Route element={<AgentPaneMocksPage />} path="/dev/agent-panes" />
      ) : null}
      <Route element={<WorkspacePage />} path="*" />
    </Routes>
  );
}
