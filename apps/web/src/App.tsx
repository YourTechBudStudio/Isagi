import { Route, Routes } from 'react-router';

import { WorkspacePage } from './routes/workspace/WorkspacePage.js';

export function App() {
  return (
    <Routes>
      <Route element={<WorkspacePage />} path="*" />
    </Routes>
  );
}
