import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '../fixture.css';
import { RailReorderApp } from './RailReorderApp.js';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RailReorderApp />
  </StrictMode>,
);
