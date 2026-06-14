import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs'
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

  // Regenerated from each .gcaproj's embedded `properties.thumbnail` data URL
  // on every dev start / build. Clean up stale ones so removed thumbnails
  // don't linger as orphan files.
  function cleanThumbnails(dir: string): void {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      if (/\.thumb\.(png|jpe?g|gif|webp)$/i.test(f)) {
        try { unlinkSync(join(dir, f)); } catch { /* ok */ }
      }
    }
  }

  function extractThumbnail(file: string, dataUrl: unknown, outDir: string): string | null {
    if (typeof dataUrl !== 'string') return null;
    const m = /^data:(image\/(png|jpeg|gif|webp));base64,(.+)$/i.exec(dataUrl);
    if (!m) return null;
    const mime = (m[1] || '').toLowerCase();
    const payload = m[3] || '';
    if (!mime || !payload) return null;
    const ext = mime === 'image/png' ? '.png'
              : mime === 'image/jpeg' ? '.jpg'
              : mime === 'image/gif' ? '.gif'
              : '.webp';
    const sidecar = `${file}.thumb${ext}`;
    try {
      writeFileSync(join(outDir, sidecar), Buffer.from(payload, 'base64'));
      return sidecar;
    } catch {
      return null;
    }
  }

  function generateIndex(outDir: string): void {
    if (!existsSync(modelsDir)) return;
    const outModelsDir = join(outDir, 'models');
    if (!existsSync(outModelsDir)) mkdirSync(outModelsDir, { recursive: true });
    cleanThumbnails(outModelsDir);

    const files = readdirSync(modelsDir).filter((f: string) => f.endsWith('.gcaproj'));
    const entries = files.map((file: string) => {
      try {
        const raw = readFileSync(join(modelsDir, file), 'utf-8');
        const model = JSON.parse(raw);
        const props = model.properties || {};
        const thumbnail = extractThumbnail(file, props.thumbnail, outModelsDir);
        return {
          id: file.replace('.gcaproj', ''),
          name: props.name || file,
          author: props.author || '',
          modelAuthor: props.modelAuthor || '',
          description: props.description || '',
          file,
          tags: props.tags || [],
          gridSize: `${props.gridWidth || '?'}x${props.gridHeight || '?'}`,
          ...(thumbnail ? { thumbnail } : {}),
        };
      } catch {
        return null;
      }
    }).filter(Boolean);

    // Alphabetical by display name (case-insensitive) so the library card order
    // stays stable across recompiles + model edits, instead of tracking the
    // filesystem's arbitrary readdir order.
    entries.sort((a: { name: string } | null, b: { name: string } | null) =>
      (a?.name || '').localeCompare(b?.name || '', undefined, { sensitivity: 'base' })
    );

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

/**
 * Vite plugin that scans public/macros/*.gcamacro at build time and generates
 * macros/index.json with metadata for the Modeler palette's Default Macros section.
 * Each .gcamacro file is JSON: { schemaVersion, name, description?, macroDef }.
 */
function macrosLibraryPlugin(): Plugin {
  const macrosDir = resolve(__dirname, 'public/macros');

  function generateIndex(outDir: string): void {
    if (!existsSync(macrosDir)) return;
    const files = readdirSync(macrosDir).filter((f: string) => f.endsWith('.gcamacro'));
    const entries = files.map((file: string) => {
      try {
        const raw = readFileSync(join(macrosDir, file), 'utf-8');
        const parsed = JSON.parse(raw);
        return {
          key: file.replace('.gcamacro', ''),
          name: parsed.name || file,
          description: parsed.description || '',
          file,
        };
      } catch {
        return null;
      }
    }).filter(Boolean);

    const outMacrosDir = join(outDir, 'macros');
    if (!existsSync(outMacrosDir)) mkdirSync(outMacrosDir, { recursive: true });
    writeFileSync(join(outMacrosDir, 'index.json'), JSON.stringify(entries, null, 2));
  }

  return {
    name: 'macros-library-index',
    configureServer() {
      generateIndex(resolve(__dirname, 'public'));
    },
    closeBundle() {
      generateIndex(resolve(__dirname, 'dist'));
    },
  };
}

// Web App Manifest, built from the active base path so start_url / scope / id
// and icon srcs are correct under the GitHub Pages '/GenesisCA/' subpath (and
// '/' in dev or inside the Tauri native shell). See docs/IMPACT_MAP_PWA_INSTALL.md.
function buildManifest(base: string) {
  return {
    name: 'GenesisCA',
    short_name: 'GenesisCA',
    description: 'IDE for modeling and simulating Cellular Automata',
    id: base,
    start_url: base,
    scope: base,
    display: 'standalone' as const,
    orientation: 'any' as const,
    background_color: '#0c0d10', // Nocturne --color-bg-app (no white splash flash)
    theme_color: '#e8a13a',      // Nocturne --color-accent
    icons: [
      { src: `${base}pwa-192x192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: `${base}pwa-512x512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: `${base}maskable-icon-512x512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}

export default defineConfig(({ command }) => {
  // GitHub Pages serves under '/GenesisCA/'; dev and the Tauri native shell serve
  // at root '/'. Tauri sets TAURI_ENV_* during its beforeBuildCommand, so the
  // native build gets base '/' (its webview loads dist/ from tauri://localhost/).
  const base = command === 'build' && !process.env.TAURI_ENV_PLATFORM ? '/GenesisCA/' : '/';
  return {
    base,
    plugins: [
      react(),
      modelsLibraryPlugin(),
      macrosLibraryPlugin(),
      // Keep VitePWA LAST: the library plugins generate models/macros index.json
      // + thumbnails in closeBundle(); the SW precache glob must run after them.
      VitePWA({
        registerType: 'prompt',
        manifest: buildManifest(base),
        includeAssets: ['favicon.ico', 'apple-touch-icon-180x180.png', 'icon.svg'],
        workbox: {
          // Overriding globPatterns REPLACES Workbox's default (**/*.{js,css,html}),
          // so re-list the shell + worker/wasm/icons, the library index, macros,
          // and thumbnails — the lean set, fully offline on the FIRST launch.
          // Model .gcaproj files are NOT precached (a couple embed large saved
          // sim-states — 5–11 MB — that would bloat the first-visit download);
          // they're runtime-cached on first open via the rule below.
          globPatterns: [
            '**/*.{js,css,html,ico,png,svg,woff2,wasm}',
            'models/index.json', 'models/*.thumb.{gif,png,jpg,jpeg,webp}',
            'macros/index.json', 'macros/*.gcamacro',
          ],
          navigateFallback: `${base}index.html`,
          maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
          runtimeCaching: [
            {
              urlPattern: ({ url }: { url: URL }) =>
                url.pathname.endsWith('/models/index.json') || url.pathname.endsWith('/macros/index.json'),
              handler: 'StaleWhileRevalidate',
              options: { cacheName: 'gca-index' },
            },
            {
              urlPattern: ({ url }: { url: URL }) =>
                url.pathname.endsWith('.gcaproj') || url.pathname.endsWith('.gcamacro'),
              handler: 'StaleWhileRevalidate',
              options: { cacheName: 'gca-models' },
            },
            {
              urlPattern: ({ url }: { url: URL }) => /\.thumb\.(gif|png|jpe?g|webp)$/.test(url.pathname),
              handler: 'CacheFirst',
              options: {
                cacheName: 'gca-thumbnails',
                expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 },
              },
            },
          ],
        },
        devOptions: { enabled: true, type: 'module' },
      }),
    ],
  };
})
