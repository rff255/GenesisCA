#!/usr/bin/env node
// CONTEXT BUDGET GATE for CLAUDE.md.
//
// `CLAUDE.md` is injected into EVERY Claude Code session, so every byte is paid
// for by every task — including one-line fixes that touch none of it. Before the
// 2026-09-06 split it had grown to 6,753 lines / 1.85 MB (~460K tokens), because
// the documentation-consistency rule told each feature to append a section to it
// and nothing was ever ejected. It was append-only by construction.
//
// The fix is structural: CLAUDE.md carries project-wide RULES and a ROUTING
// TABLE; subsystem detail lives in `docs/areas/*.md` and is read on demand. This
// gate is what keeps that true, since the failure mode is silent and gradual.
//
// It checks three things:
//   1. SIZE      — CLAUDE.md stays within the budget below.
//   2. POINTERS  — every `docs/areas/*.md` named in CLAUDE.md actually exists
//                  (a dead routing entry is worse than a long file: the reader
//                  is sent somewhere and finds nothing).
//   3. ORPHANS   — every file in `docs/areas/` is reachable from CLAUDE.md
//                  (an unrouted area doc is a doc nobody will ever open).
//
//   node scripts/check-claude-md-budget.mjs           # gate
//   node scripts/check-claude-md-budget.mjs --top     # what is taking the room
//
// If you are here because the gate failed: the question is not "how do I raise
// the cap", it is "which area doc does this belong in". Raise MAX_* only if the
// project-wide RULES themselves genuinely grew.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLAUDE_MD = path.join(ROOT, 'CLAUDE.md');
const AREAS_DIR = path.join(ROOT, 'docs/areas');

const MAX_LINES = 600;
const MAX_BYTES = 60 * 1024;

const showTop = process.argv.includes('--top');

const raw = fs.readFileSync(CLAUDE_MD, 'utf8');
const lines = raw.split('\n');
const bytes = Buffer.byteLength(raw, 'utf8');
const nLines = lines.length - (raw.endsWith('\n') ? 1 : 0);

let bad = false;

// ---------------------------------------------------------------- 1. size
const pct = (a, b) => `${((a / b) * 100).toFixed(0)}%`;
const sizeOk = nLines <= MAX_LINES && bytes <= MAX_BYTES;
console.log(
  `CLAUDE.md  ${nLines}/${MAX_LINES} lines (${pct(nLines, MAX_LINES)})   ` +
  `${(bytes / 1024).toFixed(1)}/${(MAX_BYTES / 1024).toFixed(0)} KB (${pct(bytes, MAX_BYTES)})   ` +
  (sizeOk ? 'OK' : 'FAIL'),
);
if (!sizeOk) {
  bad = true;
  console.error('\nFAIL — CLAUDE.md is over its context budget.');
  console.error('  Subsystem detail belongs in docs/areas/<area>.md; CLAUDE.md carries the');
  console.error('  project-wide rule plus one row in the routing table. The test for keeping');
  console.error('  something here: would a session working on an UNRELATED part of the');
  console.error('  codebase be worse off without it? If no, it is area detail.\n');
}

// ---------------------------------------------------------------- 2/3. routing integrity
const referenced = new Set(
  [...raw.matchAll(/docs\/areas\/([A-Za-z0-9._-]+)\.md/g)].map((m) => m[1]),
);
const present = new Set(
  fs.existsSync(AREAS_DIR)
    ? fs.readdirSync(AREAS_DIR).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3))
    : [],
);

const dead = [...referenced].filter((a) => !present.has(a)).sort();
const orphans = [...present].filter((a) => !referenced.has(a) && a !== 'README').sort();

if (dead.length) {
  bad = true;
  console.error(`FAIL — ${dead.length} routing entr${dead.length === 1 ? 'y points' : 'ies point'} at a missing area doc:`);
  for (const a of dead) console.error(`  docs/areas/${a}.md`);
  console.error('  A dead pointer sends the reader nowhere. Create the file or fix the row.\n');
}
if (orphans.length) {
  bad = true;
  console.error(`FAIL — ${orphans.length} area doc(s) are not reachable from CLAUDE.md:`);
  for (const a of orphans) console.error(`  docs/areas/${a}.md`);
  console.error('  Add a row to the routing table, or nobody will ever open it.\n');
}

// ---------------------------------------------------------------- --top
if (showTop) {
  const secs = [];
  let cur = null;
  let fence = false;
  lines.forEach((l, i) => {
    if (/^```/.test(l)) fence = !fence;
    if (!fence && /^#{1,2} /.test(l)) {
      if (cur) { cur.end = i; secs.push(cur); }
      cur = { title: l.replace(/^#+ /, ''), start: i, bytes: 0 };
    }
    if (cur) cur.bytes += Buffer.byteLength(l, 'utf8') + 1;
  });
  if (cur) { cur.end = lines.length; secs.push(cur); }
  console.log('\nlargest sections:');
  for (const s of secs.sort((a, b) => b.bytes - a.bytes).slice(0, 12)) {
    console.log(`  ${String((s.bytes / 1024).toFixed(1)).padStart(6)} KB  ${s.title.slice(0, 70)}`);
  }
}

if (bad) process.exit(1);
console.log(`OK — ${present.size} area docs, all routed, all present.`);
