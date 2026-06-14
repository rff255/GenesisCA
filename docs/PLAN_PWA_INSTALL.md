# Implementation Plan — Installable Offline PWA + Tauri scaffold

Companion to [IMPACT_MAP_PWA_INSTALL.md](IMPACT_MAP_PWA_INSTALL.md). Illustrated mockup: [PLAN_PWA_INSTALL.html](PLAN_PWA_INSTALL.html).

## Decisions (locked with the user)

- **Icon:** the **two-cell** mark (first cleavage) — amber cells on the Nocturne near-black tile; doubles as a cellular-automaton nod. Refined geometry in `PLAN_PWA_INSTALL.html`.
- **Core goal:** **offline + durable cache** — a PWA fully covers this. (`persist()` for durability; not a memory lever.)
- **Scope this pass:** **PWA now + Tauri scaffold.** Ship the installable offline PWA, and stand up `src-tauri/` wrapping the same `dist/` (native `.msi`/`.exe` follow-up; build needs a Rust toolchain on the machine).
- **SW update UX:** `registerType: 'prompt'` + an "update available — reload?" toast (consistent with the app's toast/dirty-guard philosophy).
- **theme-color:** static Nocturne amber `#e8a13a` for v1 (live theme sync deferred).
- **Pre-install explainer modal:** none for v1 — the browser's native prompt is the confirmation UI.

## Phase 1 — Two-cell icon set

1. Author `public/icon.svg` — the two-cell mark on the dark rounded tile (exact geometry from the mockup). Doubles as the scalable SVG favicon and the generator source.
2. `npm i -D @vite-pwa/assets-generator`; add `pwa-assets.config.ts` (background `#0c0d10`, maskable padding so the cells stay inside the safe circle). Generate into `public/`: `pwa-192.png`, `pwa-512.png`, `pwa-maskable-512.png`, `apple-touch-icon-180x180.png`, `favicon.ico`.
3. Verify each PNG visually + confirm the maskable mark sits inside the inner-80% safe zone.

## Phase 2 — PWA core

4. `npm i -D vite-plugin-pwa` (Workbox 7.4.1).
5. `vite.config.ts`: import `VitePWA`; add `buildManifest(base)` (name/short_name/description, `id`/`start_url`/`scope = base`, `display:'standalone'`, `background_color:'#0c0d10'`, `theme_color:'#e8a13a'`, the three icons with `${base}…` src); register the plugin with the `workbox` block from the impact map (`globPatterns` incl. the library tree, `runtimeCaching` for index/models/thumbnails, `navigateFallback: ${base}index.html`, `maximumFileSizeToCacheInBytes`), `registerType:'prompt'`, `devOptions:{enabled:true,type:'module'}`.
6. `src/vite-env.d.ts`: add `/// <reference types="vite-plugin-pwa/client" />` so `virtual:pwa-register` types resolve.
7. `index.html`: add `%BASE_URL%` favicon/svg/apple-touch links + `theme-color` + the three apple-mobile-web-app metas. (Do NOT hand-add the manifest link — the plugin injects it.)
8. `src/components/InstallButton.tsx` (new): capture `beforeinstallprompt` (`preventDefault` + stash), render only while a prompt is stashed, on click `prompt()` + read `userChoice` + clear; listen for `appinstalled` → `onInstalled()`. Styled with the shared `navIconBtn`.
9. `src/App.tsx`: lift `navIconBtn` to a shared style (or export); render `<InstallButton onInstalled={() => showToast('GenesisCA installed — available offline.')}/>` between `<ThemeSwitcher/>` and `<FileMenu/>`; on mount call `registerSW({ onOfflineReady, onNeedRefresh })` (→ `showToast`) and `navigator.storage?.persist?.()`.

## Phase 3 — Tauri v2 scaffold

10. `npm i -D @tauri-apps/cli@^2` and `npm i @tauri-apps/api@^2`.
11. Create `src-tauri/`: `Cargo.toml`, `tauri.conf.json` (`build.frontendDist: "../dist"`, `beforeDevCommand: "npm run dev"`, `beforeBuildCommand: "npm run build"`, `devUrl: "http://localhost:5173"`, app `identifier`, a window 1280×800 titled "GenesisCA"), `src/main.rs` + `src/lib.rs`, `build.rs`, `capabilities/default.json`. Generate native icons with `tauri icon public/icon.svg` (emits `src-tauri/icons/*` incl. `icon.ico`/`icon.icns`).
12. **Base-path conflict (critical):** GitHub Pages needs `base:'/GenesisCA/'`; Tauri serves `dist/` at the **root** (`tauri://localhost/`), so the Tauri build needs `base:'/'`. Tauri sets `TAURI_ENV_*` during `beforeBuildCommand`, so switch the Vite base:
    ```ts
    const base = (command === 'build' && !process.env.TAURI_ENV_PLATFORM) ? '/GenesisCA/' : '/'
    ```
    The manifest/SW are inert inside Tauri (native webview doesn't "install" a PWA), so this divergence is harmless.
13. `package.json` scripts: `"tauri": "tauri"`. (`npm run tauri dev` / `npm run tauri build` produce `.msi`+NSIS `.exe`.)
14. **Prerequisite (cannot be done in-repo):** building Tauri needs the **Rust toolchain** (`rustup`/`cargo`) + WebView2 (preinstalled on Win10+). The scaffold is committed regardless; `tauri build` is run by the user once Rust is installed. Document this in the README.

## Phase 4 — Docs (keep all sources of truth in sync)

15. `CLAUDE.md`: new "## PWA / Offline Support" section (generateSW, precache-vs-runtime, base-derived scope, install lifecycle, `persist()` = storage-not-memory, version-less manifest, the Tauri base switch); update the Project Structure tree (`public/` icons, `pwa-assets.config.ts`, `src/components/InstallButton.tsx`, `src-tauri/`).
16. `src/help/HelpView.tsx`: "Install / Offline" subsection.
17. `README.md`: "Install / Offline (PWA)" + a "Native build (Tauri)" note with the Rust prerequisite.

## Phase 5 — Verify

18. `npx tsc -b` clean.
19. Dev: SW registers under `devOptions`; install affordance appears; offline-ready toast fires.
20. `npm run build` → inspect `dist/manifest.webmanifest` (`start_url`/`scope`/`id` = `/GenesisCA/`, icon `src` all `/GenesisCA/`-prefixed) and `dist/sw.js` precache (hashed bundles + worker + `models/index.json` + `.gcaproj` + `.thumb.*`). Preview build → DevTools → Application shows Installable + SW active scope `/GenesisCA/`; toggle Offline, hard reload, confirm app + library load.
21. Tauri: `cargo --version` check; if present, `npm run tauri build` with `TAURI` base switch and confirm the window loads the app at root. If Rust absent, stop at scaffold + document.

## Out of scope (v1)

Runtime theme-color sync, custom pre-install modal, moving `.gcaproj`/`.gcastate` onto the Tauri native `fs` plugin (the real "no quota" win — follow-up), WebGPU-on-WebKit fallback validation for non-Windows Tauri targets.
