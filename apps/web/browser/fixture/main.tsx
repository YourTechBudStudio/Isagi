import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './fixture.css';
import { FixtureApp } from './FixtureApp.js';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <FixtureApp />
  </StrictMode>,
);
