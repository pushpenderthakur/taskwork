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
});