import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'fixture',
  base: '/',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../../.browser-dist',
    emptyOutDir: true,
  },
});
