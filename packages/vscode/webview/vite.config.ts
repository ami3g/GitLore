import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, '../dist/webview'),
    emptyOutDir: true,
    lib: {
      entry: resolve(__dirname, 'index.tsx'),
      name: 'GitLoreWebview',
      formats: ['iife'],
      fileName: () => 'app.js',
    },
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        assetFileNames: 'app.[ext]',
      },
    },
  },
  define: {
    'process.env.NODE_ENV': '"production"',
  },
});
