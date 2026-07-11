import { Route, Routes } from 'react-router';

import { StartupGate } from './routes/startup/StartupGate.js';

export function App() {
  return (
    <Routes>
      <Route element={<StartupGate />} path="*" />
    </Routes>
  );
}
