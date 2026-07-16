import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, statSync } from 'fs'
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
        // 3D iff the model USES the depth axis (mirrors is3dModel in the app —
        // a 1-layer "3d" file runs the 2D fast path, so it lists as 2D here too).
        const is3d = props.dimension === '3d' && (props.gridDepth ?? 1) > 1;
        // Topology layers (mirrors CAModel.topologyMode defaults: absent →
        // gridCells on, agents off). A model can have BOTH — the library's
        // CA Grid / Agents quick filters are independent toggles, not a radio.
        const topo = model.topologyMode || {};
        return {
          id: file.replace('.gcaproj', ''),
          name: props.name || file,
          author: props.author || '',
          modelAuthor: props.modelAuthor || '',
          description: props.description || '',
          file,
          tags: props.tags || [],
          gridSize: `${props.gridWidth || '?'}x${props.gridHeight || '?'}${is3d ? `x${props.gridDepth}` : ''}`,
          dimension: is3d ? '3d' : '2d',
          hasGrid: topo.gridCells !== false,
          hasAgents: topo.agents === true,
          // File mtime (epoch ms) — powers the library's Newest/Oldest sort +
          // the card date stamp. The .gcaproj files are committed, so this is
          // the last-edited date of the shipped model.
          modified: (() => { try { return statSync(join(modelsDir, file)).mtimeMs; } catch { return 0; } })(),
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
    // Standard standalone PWA: own window + icon, no tabs/address bar, but the
    // browser keeps a thin title bar. (window-controls-overlay was evaluated and
    // dropped — it can't auto-hide that title bar; it only adds a per-user
    // "hide title bar" toggle, which fails the zero-effort bar. The clean,
    // toggle-free native header is the Tauri build instead.)
    display: 'standalone' as const,
    orientation: 'any' as const,
    background_color: '#0c0d10', // Nocturne --color-bg-app (no white splash flash)
    theme_color: '#e8a13a',      // Nocturne --color-accent
    icons: [
      { src: `${base}pwa-192x192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: `${base}pwa-512x512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: `${base}maskable-icon-512x512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    // Register GenesisCA as the OS handler for .gcaproj so double-clicking a
    // project file launches the installed PWA and loads it (File Handling API —
    // Chromium desktop + installed PWA only; a one-time permission prompt on
    // first use). The launchQueue consumer in App.tsx receives the opened file.
    file_handlers: [
      { action: base, accept: { 'application/x-genesisca-project': ['.gcaproj'] } },
    ],
  };
}

export default defineConfig(({ command, mode }) => {
  // ── PRESENTATION VIEWER build (`vite build --mode viewer`) ──────────────
  // A separate, tiny build that produces ONE fully-inlined self-contained HTML
  // (the "viewer template") shipped with the app + fetched at export time.
  // Entry = viewer.html (mounts only SimulatorView); NO PWA / models / macros
  // plugins (a viewer needs none and must never register a service worker).
  // The sim worker is inlined via a resolve.alias that swaps createSimWorker
  // for its `?worker&inline` variant. See docs/IMPACT_MAP_PRESENTATION_EXPORT.md.
  if (mode === 'viewer') {
    return {
      base: './', // relative asset URLs so the file opens from file://
      plugins: [react(), viteSingleFile()],
      resolve: {
        alias: [
          // Match the WHOLE relative specifier (a regex replaces only the
          // matched substring, so anchoring both ends avoids mangling the
          // leading "./" into the absolute replacement path).
          {
            find: /^\.\/createSimWorker$/,
            replacement: resolve(__dirname, 'src/simulator/createSimWorker.inline.ts'),
          },
        ],
      },
      build: {
        outDir: 'dist-viewer',
        emptyOutDir: true,
        // Emit ONE HTML with everything inlined; keep it uncompressed-legible.
        assetsInlineLimit: Infinity,
        chunkSizeWarningLimit: 20000,
        rollupOptions: { input: resolve(__dirname, 'viewer.html') },
      },
    };
  }

  // The production site is served at the ROOT of the custom domain
  // (https://genesisca.online/, pinned by public/CNAME), so the deploy now builds
  // with base '/' — the same as `npm run dev`, local `build` + `preview`, and the
  // Tauri native shell. GHPAGES is an opt-in fallback: set it to rebuild under the
  // '/GenesisCA/' subpath ONLY if the custom domain is removed and the bare
  // github.io project URL (rff255.github.io/GenesisCA/) is used directly.
  const base = process.env.GHPAGES ? '/GenesisCA/' : '/';
  return {
    base,
    plugins: [
      react(),
      modelsLibraryPlugin(),
      macrosLibraryPlugin(),
      // Keep VitePWA LAST: the library plugins generate models/macros index.json
      // + thumbnails in closeBundle(); the SW precache glob must run after them.
      VitePWA({
        // Silent DEFERRED update — 'prompt', NOT 'autoUpdate'. 'autoUpdate'
        // (skipWaiting + clientsClaim + a `controlling` → window.location.reload)
        // force-reloads EVERY open tab the moment a new deploy's SW activates in
        // the background — a few seconds after load — which wipes whatever the
        // user was doing (open model, mid-simulation). Since Pages redeploys on
        // every push to master, users hit that constantly. 'prompt' installs the
        // new SW but leaves it WAITING (no skipWaiting): the old version keeps
        // serving this session with NO surprise reload, and the update applies on
        // the next natural launch (all tabs closed → the waiting SW activates).
        // App.tsx registers with `immediate:true` and NO onNeedRefresh handler,
        // so there's no toast either — exactly the "applied on the next load, no
        // prompt" behaviour this comment always claimed (autoUpdate never gave it).
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
            // Library files exist only in the BUILD output (dist/), not dev-dist,
            // so precache them only for the build — otherwise Workbox warns they
            // match nothing during `vite dev`.
            ...(command === 'build'
              ? ['models/index.json', 'models/*.thumb.{gif,png,jpg,jpeg,webp}', 'macros/index.json', 'macros/*.gcamacro']
              : []),
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
        // Run the SW under `vite dev` too, so you can install + test the PWA
        // (offline, the install button, the WCO header) straight from
        // `npm run dev` at http://localhost:5173/ — no build/preview needed. The
        // library globs above are build-only, so dev emits no Workbox warnings.
        devOptions: { enabled: true, type: 'module' },
      }),
    ],
  };
})
