import { Route, Routes } from 'react-router';

import { SignInMock } from './mocks/sign-in/SignInMock.js';
import { StartupGate } from './routes/startup/StartupGate.js';

export function App() {
  return (
    <Routes>
      {/* THROWAWAY MOCK (#65) — remove with src/mocks/sign-in. */}
      <Route element={<SignInMock />} path="/__mock/sign-in" />
      <Route element={<StartupGate />} path="*" />
    </Routes>
  );
}
