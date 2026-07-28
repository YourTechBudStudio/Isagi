import { Route, Routes } from 'react-router';

import { TerminalCacheStatesPage } from './routes/dev/TerminalCacheStatesPage.js';
import { StartupGate } from './routes/startup/StartupGate.js';

export function App() {
  return (
    <Routes>
      {/*
        Development fixtures. Vite replaces `import.meta.env.DEV` with `false` in
        a production build, so the branch, the page, and its fixtures are dead
        code the bundler drops — a production build has no route here at all.
      */}
      {import.meta.env.DEV ? (
        <Route element={<TerminalCacheStatesPage />} path="/__dev/terminal-cache-states" />
      ) : null}
      <Route element={<StartupGate />} path="*" />
    </Routes>
  );
}
