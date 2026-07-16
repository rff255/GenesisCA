// DEV helper: inject a .gcaproj into the built viewer template to produce a
// runnable standalone .html for manual verification. Mirrors the escaping the
// real exportPresentation() will do, so this also validates that path.
//   node scripts/inject-test-model.mjs "public/models/Game Of Life.gcaproj" dist-viewer/test.html
import { readFileSync, writeFileSync } from 'node:fs';

const modelPath = process.argv[2];
const outPath = process.argv[3] || 'dist-viewer/test.html';
const template = readFileSync('public/viewer-template.html', 'utf8');
const modelJson = readFileSync(modelPath, 'utf8');

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const safe = modelJson
  .split('<').join('\\u003c')
  .split(LS).join('\\u2028')
  .split(PS).join('\\u2029');

// Target the <script id="genesis-model"> element SPECIFICALLY — the sentinel
// string also appears as a bundled JS constant (EMBEDDED_MODEL_PLACEHOLDER),
// so a bare string replace would hit the wrong one.
const out = template.replace(
  /(<script[^>]*id="genesis-model"[^>]*>)[\s\S]*?(<\/script>)/,
  (_m, open, close) => open + safe + close,
);
writeFileSync(outPath, out);
console.log(`Wrote ${outPath} (${(out.length / 1024).toFixed(0)} kB) from ${modelPath}`);
