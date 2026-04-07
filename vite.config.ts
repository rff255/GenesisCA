import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import type { Plugin } from 'vite'

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Vite plugin that scans public/models/*.gcaproj at build time
 * and generates models/index.json with card metadata extracted from each model.
 * Runs on both dev server start and production build.
 */
function modelsLibraryPlugin(): Plugin {
  const modelsDir = resolve(__dirname, 'public/models');

  function generateIndex(outDir: string): void {
    if (!existsSync(modelsDir)) return;
    const files = readdirSync(modelsDir).filter((f: string) => f.endsWith('.gcaproj'));
    const entries = files.map((file: string) => {
      try {
        const raw = readFileSync(join(modelsDir, file), 'utf-8');
        const model = JSON.parse(raw);
        const props = model.properties || {};
        return {
          id: file.replace('.gcaproj', ''),
          name: props.name || file,
          author: props.author || '',
          description: props.description || '',
          file,
          tags: props.tags || [],
          gridSize: `${props.gridWidth || '?'}x${props.gridHeight || '?'}`,
        };
      } catch {
        return null;
      }
    }).filter(Boolean);

    const outModelsDir = join(outDir, 'models');
    if (!existsSync(outModelsDir)) mkdirSync(outModelsDir, { recursive: true });
    writeFileSync(join(outModelsDir, 'index.json'), JSON.stringify(entries, null, 2));
  }

  return {
    name: 'models-library-index',

    // Dev server: generate into public/ so Vite serves it
    configureServer() {
      generateIndex(resolve(__dirname, 'public'));
    },

    // Production build: generate into dist/ after files are copied
    closeBundle() {
      generateIndex(resolve(__dirname, 'dist'));
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [react(), modelsLibraryPlugin()],
  // base path only for production (GitHub Pages); dev uses root '/'
  base: command === 'build' ? '/GenesisCA/' : '/',
}))
