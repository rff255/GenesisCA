# Impact Map — PWA Install + Offline Support (and the Tauri path)

**Status:** Impact map (impact-map-first, pre-implementation, per project convention).
**Goal:** Make GenesisCA an installable app with full offline support on GitHub Pages — its own window, its own icon, no browser chrome — with an honest assessment of the PWA-now vs native-later (Tauri) path.
**Recon basis:** build/deploy, navbar UI, runtime/offline fetch surface, icon/brand palette, and library research (`vite-plugin-pwa@1.3.0` / Web App Manifest / `navigator.storage.persist()` / Tauri v2).

---

## 0. Decision summary (read first)

- **Approach:** `vite-plugin-pwa@1.3.0` with the **`generateSW`** (Workbox) strategy — **not** a hand-written `public/sw.js`. A hand-written SW silently breaks on every deploy because of Vite's content hashing (the "hashed bundle no longer matches the precache list" trap); `generateSW` computes the precache manifest from the real build output, eliminating that whole risk class.
- **The model library goes in PRECACHE, not runtime cache.** Runtime caching only stores a file *after* it's been fetched online once; the goal is offline-on-first-launch. The whole `public/models` + `public/macros` tree is emitted into `dist/` and is small (~1 MB), so it precaches cleanly.
- **The base-path gotcha is the single highest-risk item** (§B). Solved by deriving the manifest `scope`/`start_url`/`id` from the same conditional `base` the config already computes.
- **PWA does NOT raise memory limits — only storage durability.** This is decisive for whether Tauri is "later" or "soon" (§C).

---

## (A) Subsystem-by-subsystem impact map

### A.1 — Vite config & plugins — `vite.config.ts`

**Current state:** Vite 6.4.1; `base: command === 'build' ? '/GenesisCA/' : '/'` (vite.config.ts:149). Two custom plugins, `modelsLibraryPlugin()` (lines 15–102) and `macrosLibraryPlugin()` (lines 109–144), both running in `configureServer()` (dev, against `public/`) and `closeBundle()` (build, against `dist/`), generating `models/index.json` / `macros/index.json` and extracting `*.thumb.*` sidecars. No PWA tooling present.

**Changes required:**
1. Dev dep: `npm i -D vite-plugin-pwa@^1.3.0` (pulls Workbox 7.4.1). Optionally `@vite-pwa/assets-generator` to generate the icon set from one source SVG.
2. Register `VitePWA(...)` in the plugins array. The base must be threaded into the manifest (§B).
3. **Override `globPatterns`** to precache the worker, wasm, icons, AND the whole library tree (so it's offline on first launch). Setting `globPatterns` replaces Workbox's default `**/*.{js,css,html}`, so the shell files must be re-listed.

```ts
// vite.config.ts
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig(({ command }) => {
  const base = command === 'build' ? '/GenesisCA/' : '/'
  return {
    base,
    plugins: [
      react(),
      modelsLibraryPlugin(),
      macrosLibraryPlugin(),
      VitePWA({
        registerType: 'prompt',                 // see A.5 (prompt vs autoUpdate)
        manifest: buildManifest(base),          // §A.3
        includeAssets: ['favicon.ico', 'apple-touch-icon-180x180.png'],
        workbox: {
          globPatterns: [
            '**/*.{js,css,html,ico,png,svg,woff2,wasm}', // app shell + worker + chunks
            'models/index.json', 'models/*.gcaproj', 'models/*.thumb.{gif,png,jpg,jpeg,webp}',
            'macros/index.json', 'macros/*.gcamacro',
          ],
          navigateFallback: `${base}index.html`,
          runtimeCaching: [
            { urlPattern: ({ url }) => url.pathname.endsWith('/models/index.json') || url.pathname.endsWith('/macros/index.json'),
              handler: 'StaleWhileRevalidate', options: { cacheName: 'gca-index' } },
            { urlPattern: ({ url }) => url.pathname.endsWith('.gcaproj') || url.pathname.endsWith('.gcamacro'),
              handler: 'StaleWhileRevalidate', options: { cacheName: 'gca-models' } },
            { urlPattern: ({ url }) => /\.thumb\.(gif|png|jpe?g|webp)$/.test(url.pathname),
              handler: 'CacheFirst', options: { cacheName: 'gca-thumbnails', expiration: { maxEntries: 200, maxAgeSeconds: 60*60*24*30 } } },
          ],
          maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        },
        devOptions: { enabled: true, type: 'module' }, // test the SW under `npm run dev`
      }),
    ],
  }
})
```

**Risks:**
- **Glob-override foot-gun:** forgetting `html`/`css`/`js` would un-cache the app shell. The snippet keeps them.
- **`sim.worker.ts` hashing:** compiles to `dist/assets/sim.worker-<hash>.js` (~151 KB). Matched by `**/*.js`, so it precaches automatically — exactly the case a hand-written SW gets wrong.
- **Build-order race:** the library plugins emit `index.json`/thumbnails in `closeBundle()`; verify the emitted `dist/sw.js` precache list actually contains `models/index.json` + the `.thumb.*` files. Fallback: list them via Workbox `additionalManifestEntries` (Open Decision §D.8).

### A.2 — `index.html` `<head>` — `index.html`

**Current state:** `<head>` has ONLY `<meta charset>`, `<meta viewport>`, `<title>GenesisCA</title>`, plus the synchronous pre-paint theme script. No favicon, theme-color, manifest link, or apple-touch-icon.

**Changes:** `vite-plugin-pwa` injects `<link rel="manifest">` + the registration script automatically (do NOT hand-add the manifest link). Hand-add only what the plugin doesn't, using Vite's `%BASE_URL%` token (resolves `/` in dev, `/GenesisCA/` in build — matches the conditional base with zero branching):

```html
<link rel="icon" href="%BASE_URL%favicon.ico" sizes="any" />
<link rel="icon" type="image/svg+xml" href="%BASE_URL%icon.svg" />
<link rel="apple-touch-icon" href="%BASE_URL%apple-touch-icon-180x180.png" />
<meta name="theme-color" content="#e8a13a" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="apple-mobile-web-app-title" content="GenesisCA" />
```

- The pre-paint theme script reads only `localStorage` with a default fallback (no network) → **offline-safe, no change**, but a "must not regress" item.
- `theme-color` is static (browser/OS window chrome only). Use the Nocturne accent `#e8a13a` (default theme). Live-syncing it on theme switch is cosmetic → §D.4.

### A.3 — Web App Manifest + icon set

Generated by `vite-plugin-pwa` from the `manifest:` config → emitted as `dist/manifest.webmanifest` with `<link rel="manifest">` auto-injected (no standalone `public/manifest.json`, avoids drift).

```ts
function buildManifest(base: string) {
  return {
    name: 'GenesisCA', short_name: 'GenesisCA',
    description: 'IDE for modeling and simulating Cellular Automata',
    id: base, start_url: base, scope: base,    // stable, base-derived (§B)
    display: 'standalone', orientation: 'any',
    background_color: '#0c0d10',               // Nocturne --color-bg-app (no white splash flash)
    theme_color: '#e8a13a',                    // Nocturne --color-accent
    icons: [
      { src: `${base}pwa-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: `${base}pwa-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: `${base}pwa-maskable-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
```

**Icon set to PRODUCE** (recon confirmed **zero** icon assets exist anywhere):

| File (`public/`) | Size | Purpose | Required for |
|---|---|---|---|
| `favicon.ico` | 16/32/48 | tab icon | browsers (legacy) |
| `icon.svg` | vector | scalable tab icon | modern browsers |
| `apple-touch-icon-180x180.png` | 180×180 | iOS home screen | iOS (manifest ignored by Safari) |
| `pwa-192.png` | 192×192 | `purpose: any` | Chrome/Edge install + taskbar |
| `pwa-512.png` | 512×512 | `purpose: any` | splash / high-DPI |
| `pwa-maskable-512.png` | 512×512 | `purpose: maskable` | Android adaptive (safe-zone padded) |

**Design constraints:** the OS icon is theme-independent — design against **Nocturne** (`#0c0d10` bg + `#e8a13a` mark). Maskable: keep the mark inside the inner 80% (center 409×409 of 512) with a solid background to the edges so Android's crop never clips it; do NOT reuse the `any` icon as `maskable` unless it's safe-padded. **Write icon `src` as `${base}…`** to dodge the known intermittent `vite-plugin-pwa` non-prefix bug (issues #713/#396) — and verify the emitted `dist/manifest.webmanifest` after the first build.

### A.4 — Service worker / caching — explicit precache vs runtime list

The SW is **generated** by Workbox from A.1. GenesisCA's real fetch surface (recon-confirmed) maps as:

**PRECACHE (cache-first, revisioned, offline on first launch):**
- App shell (hashed — matched by glob, never hardcode hashes): `index.html` (via `navigateFallback`), `assets/index-<hash>.js`, `assets/index-<hash>.css`, `assets/sim.worker-<hash>.js` (the JS/WASM/WebGPU compile + sim loop, `new Worker(new URL('./engine/sim.worker.ts', import.meta.url), {type:'module'})` at SimulatorView.tsx:1605), plus code-split chunks (`gifenc`, `webm-muxer`) — all `**/*.js`.
- Library data (static `public/` → `dist/`): `models/index.json`, the **13** `models/*.gcaproj`, the **12** `models/*.thumb.*`, `macros/index.json`, the **3** `macros/*.gcamacro`.
- **Estimated total precache: ~1–1.5 MB** — well within any quota.

**RUNTIME CACHE (freshness / belt-and-suspenders):** `index.json` → `StaleWhileRevalidate`; `.gcaproj`/`.gcamacro` → `StaleWhileRevalidate`; `*.thumb.*` → `CacheFirst` + expiration.

**NOT cached / N/A (recon-confirmed):** no external `.wasm` (hand-emitted to a `Uint8Array` in-worker); no `.wgsl` (compiled to source strings in-worker); no web fonts (system fonts, inlined CSS); no API calls; no IndexedDB. All persistent state is `localStorage` (UI prefs, <100 KB total) + user-initiated `.gcaproj`/`.gcastate`/`.gcamacro` downloads/uploads (Blob/FileReader, no SW involvement).

### A.5 — `src/App.tsx` install button + `beforeinstallprompt` + `appinstalled`

**Current navbar (App.tsx:80–154):** GitHub link → `GenesisCA` title + `v1.19.0` badge → nav tabs → modelName → `?` → conditional `⤢` → `<ThemeSwitcher />` → `<FileMenu />`. Icon buttons use the inline `navIconBtn` style (App.tsx:59–64): transparent bg, `1px solid var(--color-widget-border)`, `var(--radius-md)`, 28×24px, centered flex.

**Lifecycle:** capture `beforeinstallprompt` → `preventDefault()` + stash → show the install button only while a stashed prompt exists → on click `await prompt.prompt()` then read `userChoice`, clear the stash (one-shot) → `appinstalled` fires → "installed" toast, hide button.

**Implementation:** new `src/components/InstallButton.tsx`, inserted between `<ThemeSwitcher />` and `<FileMenu />`. Self-hides when not installable, so zero clutter on browsers/sessions where install isn't offered. Reuses the `navIconBtn` style (lift it to a shared module — `?`/`⤢` use it too). It lives in `AppInner`'s subtree, so `onInstalled` can call `showToast(...)` directly (no CustomEvent needed, unlike FileMenu).

**`registerType` (prompt vs autoUpdate):** `'autoUpdate'` activates a new deploy silently (simplest); `'prompt'` surfaces an "update available — reload?" toast via `registerSW({ onNeedRefresh })`. **Recommend `'prompt'`** — consistent with the app's toast-driven, don't-yank-state philosophy (cf. the `beforeunload` dirty guard).

### A.6 — "Offline ready" toast (reuse existing mechanism)

Existing toast: `App.tsx` local `useState` + `setTimeout` 3500 ms, `<div className={styles.toast}>` (App.module.css:93–113), `1px solid var(--color-accent)`, `animation: toastIn`. Two new moments, both via `showToast` (no new UI), from the plugin's `virtual:pwa-register`:

```ts
import { registerSW } from 'virtual:pwa-register'
registerSW({
  onOfflineReady() { showToast('GenesisCA is ready to work offline.') },
  onNeedRefresh()  { showToast('Update available — reload to apply.') }, // if registerType:'prompt'
})
```
Plus the `appinstalled` toast from `InstallButton`. `onOfflineReady` (SW cached) and `appinstalled` (installed) are distinct events — keep the copy distinct. No new modal for v1 (the browser's native install prompt is the confirmation UI).

### A.7 — Storage persistence via `navigator.storage.persist()`

`persist()` changes **eviction policy only** — it does NOT raise the quota and does NOT touch memory/heap. Chromium quota is already ~60% of disk per origin regardless. GenesisCA's footprint (~1.5 MB precache + <100 KB localStorage) is nowhere near any limit. Value here is narrow: exempt the SW caches + localStorage from **LRU eviction under disk pressure**. Installing the PWA makes the browser **auto-grant** `persist()` without a prompt (heuristics: install state, engagement, bookmarks). One fire-and-forget call on mount:

```ts
useEffect(() => { navigator.storage?.persist?.().catch(() => {}) }, [])
```
**Explicit non-goal:** this does NOTHING for 25M-cell grid memory pressure (renderer heap / WASM32 4 GiB address space, untouched by install or persist). Do not let "install the PWA" be conflated with "more RAM for big grids" — that's the Tauri crux (§C).

### A.8 — Version-bump touch points

No new ones. The manifest is intentionally **version-less** (install identity is `id`/`start_url`, not a version string; do NOT add a `version` field). SW precache is content-revisioned by Workbox (file hashes), so cache invalidation is automatic per deploy, independent of the app version string. The `/updateversion` four-file sweep (`package.json`, `package-lock.json`, `src/App.tsx` `v1.X.Y`, `README.md` badge) is unchanged. Worth one CLAUDE.md line noting the version-less manifest.

### A.9 — Docs to update (project "keep ALL sources of truth in sync" rule)

1. **Code + comments** — `vite.config.ts` (PWA block + glob-override + base-derived scope comments), `index.html` (`%BASE_URL%` icon links), `src/App.tsx` (install button + `registerSW` + `persist()`), new `src/components/InstallButton.tsx`.
2. **`CLAUDE.md`** — new "## PWA / Offline Support" section (generateSW, precache-vs-runtime split, base-path scope derivation, install lifecycle, `persist()` = storage-not-memory, version-less manifest); update the Project Structure tree (`public/` icons, `src/components/InstallButton.tsx`, generated `dist/sw.js` + `dist/manifest.webmanifest`); note in hosting that the app is an installable offline PWA.
3. **`src/help/HelpView.tsx`** — "Install / Offline" subsection (how to install, full library is offline, saved files remain local downloads, the offline-ready/installed toasts).
4. **`README.md`** — "Install / Offline (PWA)" section near hosting/usage; the public URL is installable.
5. **`docs/NODES_REFERENCE.md`** — not affected (no node-system change).

---

## (B) The GitHub Pages base-path `/GenesisCA/` scope/start_url gotcha

GitHub Pages serves from `https://rff255.github.io/GenesisCA/`. Three values must match the subpath or install/offline breaks: `start_url` (launch target), `scope` (SW control + in-app navigations), and the SW registration path. Dev runs at `/`, build at `/GenesisCA/`, so a hardcoded `start_url: '/'` works in dev and silently breaks production.

**Handling (matches the existing conditional base):**
1. Drive everything from the same `base = command === 'build' ? '/GenesisCA/' : '/'`.
2. `base` is already set on the Vite config (line 149) — the PWA plugin reads it and derives SW scope + registration automatically. Do NOT register the SW manually with a hardcoded scope.
3. Explicitly set `id`/`start_url`/`scope` to `base` in the manifest (belt-and-suspenders against plugin defaults).
4. Write icon `src` as `${base}pwa-512.png` (dodges the #713 non-prefix bug).
5. `index.html` icon links use `%BASE_URL%` (never hardcode `/GenesisCA/` in source).
6. `navigateFallback: ${base}index.html` so offline navigations resolve the shell under the subpath.

**Post-first-build verification:** `dist/manifest.webmanifest` → `start_url`/`scope`/`id` = `/GenesisCA/`, every icon `src` begins `/GenesisCA/`; `dist/index.html` → manifest link + icon hrefs under `/GenesisCA/`, SW registration present; `dist/sw.js` precache list contains the hashed bundles, the worker, `models/index.json`, the `.gcaproj` + `.thumb.*` files, all `/GenesisCA/`-prefixed; DevTools → Application shows Installable + SW active scope `/GenesisCA/`; toggle Offline → hard reload still loads app + library.

---

## (C) Honest recommendation — PWA now, Tauri later

Against the three stated goals: **(1) avoid browser resource limits, (2) own Windows app with its own icon, (3) install to other systems soon.**

| Goal | PWA delivers? | Precise truth |
|---|---|---|
| (1) Avoid resource limits | **Storage: yes. Memory: no.** | PWA + `persist()` improves **storage durability** + gives a generous **disk** quota (~60% of disk). It does NOT raise **RAM/heap/WASM-memory** — 25M-cell grids + `wasmMemory` are bound by V8 + the WASM32 4 GiB address space whether installed or not. |
| (2) Own Windows app + icon | **Yes (mostly)** | Installed PWA = its own Start-menu/taskbar entry, own window (`display:standalone`, no browser chrome), own icon. A real launchable app — but installed *via the browser*, not a double-click `.exe`/`.msi`. |
| (3) Install to other systems | **Yes** | Any HTTPS visitor on Chrome/Edge (Win/Mac/Linux/Android) installs from the browser; iOS via Add to Home Screen. Zero distribution infra. |

**The decisive distinction is memory vs storage.** If "avoid browser resource limits" means the big-grid memory ceiling, PWA does nothing for it — only a native shell escapes the tab memory model + storage quotas. If it means "stop evicting my cached models" / "guaranteed offline," PWA + `persist()` is exactly right.

**Tauri v2 (the native follow-up):** wraps the unchanged `dist/` in a Rust host using the OS webview (WebView2/Chromium on Windows), emits real `.msi` (WiX, Windows-only build) + `-setup.exe` (NSIS, cross-buildable) + macOS `.dmg` + Linux `.deb`/`.rpm`/`.AppImage`. Its `fs` plugin gives true native file read/write **bypassing browser storage quotas entirely**, and the app runs as a native process not bound to a tab's memory model. ~3–10 MB bundle vs Electron's ~85 MB. **Prototype-first caveat for THIS app:** Tauri uses the host webview, so on **macOS/Linux it's WebKit, where WebGPU + some Canvas/WASM behaviors differ** — GenesisCA's WebGPU compile target may need to fall back to WASM/JS on those targets. On Windows (WebView2 = Chromium) parity with the PWA is high.

**One-line recommendation:** ship the PWA now (installable Windows app + own icon + cross-platform install + full offline, today, near-zero risk, reuses `dist/`); plan Tauri v2 as a follow-up if the real constraint is memory or native filesystem — same `dist/`, real `.msi`/`.exe`, native fs, no quota — and prototype WebGPU-on-WebKit before committing to non-Windows native builds.

---

## (D) Open decisions

1. **Which "resource limit" do you mean?** Disk/cache durability (PWA solves it) vs RAM for large grids (only Tauri solves it). Determines whether Tauri is "later" or "soon."
2. **Icon/logo design.** No mark exists. Direction + palette (recommendation: Nocturne `#0c0d10` + `#e8a13a`). `@vite-pwa/assets-generator` from one source SVG, or hand-cut PNGs.
3. **SW update UX:** `autoUpdate` (silent) vs `prompt` (reload toast). Recommendation: `prompt`.
4. **Runtime theme-color sync** on Nocturne↔Blender switch, or static Nocturne amber? Recommendation: static for v1.
5. **Custom pre-install explainer modal**, or browser native prompt only? Recommendation: native only for v1.
6. **Thumbnail precache scope** — precache all 12 (~150 KB) vs runtime-only; confirm after first build no single thumb is unexpectedly large.
7. **Pre-existing `dist/index.html` `data-theme="blender"` hardcode** — still intended now that `ThemeSwitcher` defaults to `nocturne`? (Not PWA-caused; the static `theme-color` should match the real default. Candidate spin-off.)
8. **Verify build-order** between the library plugins (`closeBundle`) and the PWA precache manifest; fall back to `additionalManifestEntries` if the generated `index.json`/thumbnails aren't present when Workbox computes the precache.

---

*Next step after decisions: an implementation plan `.md` + an illustrated HTML mockup (navbar install button + the two toasts), per the project's "illustrated plans for UI changes" rule, before implementation.*
