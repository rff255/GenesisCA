#!/usr/bin/env node
// C7 (P7) — DETERMINISM GATE.
//
// GenesisCA draws every simulation decision from ONE seeded xorshift32 stream
// (`rngState` in the worker; `_rs` in the compiled JS/WASM code), so
// `setRngSeed(S)` + Reset reproduces a run exactly on the CPU engines. That
// guarantee is only as strong as the weakest draw: a single `Math.random()` on a
// simulation-semantic path silently un-pins the whole run, with no error
// anywhere and nothing in the type system to catch it.
//
// This gate greps `src/` for `Math.random` / `crypto.getRandomValues` and fails
// on anything not in the explicit allowlist below. Every allowlist entry states
// WHY the draw is not simulation-semantic.
//
//   node scripts/check-no-unseeded-random.mjs          # gate
//   node scripts/check-no-unseeded-random.mjs --list   # show every allowed hit
//
// Adding a random draw to the engine? Use the worker's `nextRandom()` (the
// shared stream) or a `getRandom` node — not `Math.random()`.
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve, dirname, relative, sep } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const LIST = process.argv.includes('--list');

/** Files where EVERY random draw is allowed, with the reason. Keep this list
 *  short and specific — a whole-directory exemption would defeat the gate. */
const ALLOWED_FILES = [
  // --- identity, not simulation -------------------------------------------
  ['src/model/ModelContext.tsx', 'id generation (genId) — identity, never read by the engine'],
  ['src/model/macroImport.ts', 'id regeneration for macro imports'],
  ['src/model/macroImportPlan.ts', 'id generation for imported macro elements (the M2 apply mints fresh ids)'],
  ['src/modeler/vpl/macroMoveScope.ts', 'node-id regeneration on a cross-scope move collision'],
  ['src/model/fileOperations.ts', 'preset id generation'],
  ['src/model/agentAttributeSplitMigration.ts', 'id generation in a load-time migration'],
  ['src/model/variableScopeMigration.ts', 'id generation in a load-time migration'],
  ['src/modeler/vpl/GraphEditor.tsx', 'node/edge id generation'],
  ['src/modeler/vpl/CaNode.tsx', 'node-config uid generation'],
  ['src/modeler/panels/MappingsPanelContent.tsx', 'sprite id generation'],
  ['src/modeler/panels/PropertiesPanelContent.tsx', 'end-condition id generation'],
  ['src/modeler/panels/VariegatedCellsPanelContent.tsx', 'face-pattern id generation'],

  // --- UI-only draws -------------------------------------------------------
  ['src/modeler/panels/LookupTableEditor.tsx',
    'the 🎲 button GENERATES a seed the model then stores, and the matrix mutate takes a fresh seed — the fill itself is already seeded (randomFillTableData)'],
  ['src/simulator/SimulatorView.tsx',
    'agent-brush seed points: a hand-drawn stroke is a one-off mutation that Reset never replays, and seeding it would make a REPEATED stroke lay down an identical cluster'],

  // --- dead code -----------------------------------------------------------
  ['src/simulator/engine/SimEngine.ts',
    'the legacy reference engine — imported by nothing (verified: no `from ".../SimEngine"` anywhere in src/)'],
];

const ALLOW_MAP = new Map(ALLOWED_FILES.map(([f, why]) => [f.split('/').join(sep), why]));
const PATTERN = /Math\s*\.\s*random|crypto\s*\.\s*getRandomValues/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const violations = [];
const allowed = [];
for (const file of walk(SRC)) {
  const rel = relative(ROOT, file);
  const lines = readFileSync(file, 'latin1').split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!PATTERN.test(line)) return;
    // A mention inside a comment is documentation, not a draw.
    const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, '');
    if (!PATTERN.test(code)) return;
    const why = ALLOW_MAP.get(rel);
    if (why) allowed.push({ rel, line: i + 1, text: line.trim(), why });
    else violations.push({ rel, line: i + 1, text: line.trim() });
  });
}

// Guard the guard: an allowlist entry naming a file that no longer has a draw is
// stale and must be removed, or it silently protects a future one.
const hit = new Set(allowed.map(a => a.rel));
const stale = [...ALLOW_MAP.keys()].filter(f => !hit.has(f));

if (LIST) {
  for (const a of allowed) console.log(`  allow ${a.rel}:${a.line}  ${a.text}\n        ↳ ${a.why}`);
}

let bad = false;
if (violations.length) {
  bad = true;
  console.error(`\nFAIL — ${violations.length} unseeded random draw(s) on a simulation-semantic path:`);
  for (const v of violations) {
    console.error(`  ${v.rel}:${v.line}\n    ${v.text}`);
  }
  console.error(`\n  Use the worker's nextRandom() (the shared seeded stream) or a getRandom node.`);
  console.error(`  If the draw is genuinely NOT simulation-semantic, add it to ALLOWED_FILES in`);
  console.error(`  scripts/check-no-unseeded-random.mjs WITH A REASON.\n`);
}
if (stale.length) {
  bad = true;
  console.error(`\nFAIL — ${stale.length} stale allowlist entr(y/ies) (no random draw left in the file):`);
  for (const f of stale) console.error(`  ${f}`);
  console.error(`  Remove them, or they silently protect a future draw.\n`);
}
if (bad) process.exit(1);

console.log(`OK — no unseeded Math.random() on simulation-semantic paths (${allowed.length} allowlisted draws in ${hit.size} files).`);
