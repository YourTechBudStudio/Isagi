import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '../fixture.css';
import { UpdateGalleryApp } from './UpdateGalleryApp.js';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <UpdateGalleryApp />
  </StrictMode>,
);
