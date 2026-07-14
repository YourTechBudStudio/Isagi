import { Route, Routes } from 'react-router';

import { HostRuntimeGate } from './routes/startup/HostRuntimeGate.js';
import { StartupGate } from './routes/startup/StartupGate.js';

export function App() {
  return (
    <Routes>
      <Route
        element={
          <HostRuntimeGate>
            <StartupGate />
          </HostRuntimeGate>
        }
        path="*"
      />
    </Routes>
  );
}
