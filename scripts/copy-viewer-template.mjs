// Copies the single-file presentation viewer build into public/ so it is:
//   • fetchable at /viewer-template.html during `npm run dev` (export works in dev), and
//   • copied into dist/ by the main `vite build` (Vite copies publicDir → outDir),
//     where the PWA precache picks it up (offline export).
// Run automatically by `npm run build:viewer` (see package.json).
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';

const src = 'dist-viewer/viewer.html';
const dest = 'public/viewer-template.html';

if (!existsSync(src)) {
  console.error(`[copy-viewer-template] missing ${src} — did the viewer build run?`);
  process.exit(1);
}
if (!existsSync('public')) mkdirSync('public', { recursive: true });
copyFileSync(src, dest);
console.log(`[copy-viewer-template] ${src} → ${dest}`);
