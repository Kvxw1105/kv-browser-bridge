import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { copyFileSync, existsSync, mkdirSync } from 'fs';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'copy-extension-assets',
      closeBundle() {
        const dist = resolve(__dirname, 'dist');
        if (!existsSync(dist)) mkdirSync(dist, { recursive: true });

        copyFileSync(resolve(__dirname, 'manifest.json'), resolve(dist, 'manifest.json'));
        copyFileSync(
          resolve(__dirname, 'src/content/element-picker.css'),
          resolve(dist, 'element-picker.css'),
        );

        const publicDir = resolve(__dirname, 'public');
        if (existsSync(publicDir)) {
          for (const file of ['icon-16.png', 'icon-48.png', 'icon-128.png']) {
            const src = resolve(publicDir, file);
            if (existsSync(src)) copyFileSync(src, resolve(dist, file));
          }
        }
      },
    },
  ],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        sidepanel: resolve(__dirname, 'sidepanel.html'),
        'privacy-service-worker': resolve(__dirname, 'src/background/privacy-service-worker.ts'),
        'content-script': resolve(__dirname, 'src/content/content-script.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: '[name][extname]',
      },
    },
  },
});
