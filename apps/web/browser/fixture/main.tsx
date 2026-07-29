import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '../../src/styles.css';
import { FixtureApp } from './FixtureApp.js';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <FixtureApp />
  </StrictMode>,
);
