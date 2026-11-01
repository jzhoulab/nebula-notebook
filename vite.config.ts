import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      // Relative asset URLs: the same build serves at '/' or under a proxy
      // prefix (lib/basePath.ts reads the base back from the bundle's URL).
      base: './',
      server: {
        port: 3000,
        host: '0.0.0.0',
        allowedHosts: true, // Allow all hosts (for internal cluster access)
        watch: {
          ignored: [
            '**/*.ipynb',
            '**/.nebula/**',
          ],
        },
        proxy: {
          '/api': {
            target: `http://localhost:${env.VITE_API_PORT || '8000'}`,
            changeOrigin: true,
            ws: true,
          },
          '/ws': {
            target: `http://localhost:${env.VITE_API_PORT || '8000'}`,
            changeOrigin: true,
            ws: true,
          },
        },
      },
      plugins: [tailwindcss(), react()],
      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY)
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        },
        // nebula-autocomplete is a symlinked file: dep with its own
        // node_modules — dedupe so CodeMirror resolves to a single instance
        // (duplicate @codemirror/state instances break extensions).
        dedupe: ['@codemirror/state', '@codemirror/view'],
      }
    };
});
