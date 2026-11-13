/**
 * Vite configuration.
 *
 * `@vitejs/plugin-react` adds JSX and Fast Refresh; `@tailwindcss/vite` compiles
 * the Tailwind v4 stylesheet on the fly (no PostCSS config needed).
 */
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // The API only trusts CLIENT_ORIGIN (default http://localhost:5173). Letting
    // Vite fall back to 5174 when the port is taken would make every API call
    // fail CORS, so fail loudly instead.
    strictPort: true,
  },
  preview: {
    strictPort: true,
  },
});