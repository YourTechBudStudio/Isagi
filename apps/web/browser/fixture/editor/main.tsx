import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '../fixture.css';
import { EditorGalleryApp } from './EditorGalleryApp.js';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <EditorGalleryApp />
  </StrictMode>,
);
