import { defineConfig, minimal2023Preset } from '@vite-pwa/assets-generator/config'

// Generates the PWA icon set from public/icon.svg (the two-cell mark) into public/:
//   pwa-64x64.png, pwa-192x192.png, pwa-512x512.png  (purpose: any)
//   maskable-icon-512x512.png                         (purpose: maskable)
//   apple-touch-icon-180x180.png                      (iOS home screen)
//   favicon.ico
// Run with:  npx pwa-assets-generator
// The source already paints a full-bleed Nocturne (#0c0d10) tile and keeps the
// cells inside the maskable safe circle, so maskable/apple only add a touch of
// padding on the SAME dark background (seamless — no white halo from the default).
export default defineConfig({
  headLinkOptions: { preset: '2023' },
  preset: {
    ...minimal2023Preset,
    maskable: { sizes: [512], padding: 0.06, resizeOptions: { background: '#0c0d10' } },
    apple: { sizes: [180], padding: 0.06, resizeOptions: { background: '#0c0d10' } },
  },
  images: ['public/icon.svg'],
})
