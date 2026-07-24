// GPU uniform-layout regression harness — WGSL struct  ⇄  TypedArray writer.
//
// WHY THIS EXISTS (a real shipped bug the render harness could not catch)
//   L1's free-mode voxel render presented every frame, compacted the right cells
//   and wrote a correct indirect draw — and displayed NOTHING. The cause was not
//   in any of those: `VoxelView` declared `clipFwd : vec3<f32>` (align 16, SIZE
//   12) immediately followed by `ambient : f32`, so WGSL's natural offset rule
//     offset(m) = roundUp(align(m), offset(prev) + size(prev))
//   placed `ambient` at byte 124 — INSIDE clipFwd's trailing pad — while
//   uploadVoxelView wrote the whole scalar block from byte 128. Every scalar was
//   one float out: the shader read `cubeScale` from the specular slot, which is
//   0 by default, so all 36 cube vertices collapsed onto the cell centre and the
//   pass rasterised zero pixels. The members past `bg` were unaffected (a vec4
//   re-aligns the layout), which is exactly why the compaction — the only thing a
//   GPU-buffer probe could see — looked perfectly healthy.
//
//   The lesson generalises: a uniform-layout desync produces NO error, NO warning
//   and NO wrong-looking buffer. It only shows up as pixels, and only if you look
//   at them. So this check is COMPUTED from source rather than structural: it
//   derives the shader's byte layout from the WGSL text and the writer's byte
//   layout from its index assignments, and cross-checks them.
//
// THE TWO ASSERTIONS (both fire on the bug above; neither replicates any logic)
//   1. NO WRITE LANDS IN PADDING — every byte the writer touches must fall inside
//      a declared member. (The buggy writer put clipAxis at 156, which is the pad
//      before `bg`.)
//   2. NO MEMBER BYTE IS LEFT UNWRITTEN — every byte of every member must be
//      covered. (The buggy shader's `ambient` at 124 was never written, so it read
//      whatever the zero-init left there.)
//   Plus: the declared *_BYTES constant must equal the computed struct size.
//
// Run from the repo root:  node scripts/verify-render-uniform-layouts.mjs
import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = (p) => join(ROOT, 'src', p);

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok  ${name}`);
  else { console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); failures++; }
};
const section = (t) => console.log(`\n=== ${t} ===`);

// ---------------------------------------------------------------------------
// WGSL host-shareable layout (spec §14.4.4: "Alignment and Size").
// Only the types our uniform structs actually use — an unknown type THROWS so a
// new member can never be silently skipped (a skip would fake a pass).
// ---------------------------------------------------------------------------
const WGSL_TYPES = {
  'f32': [4, 4], 'i32': [4, 4], 'u32': [4, 4],
  'vec2<f32>': [8, 8], 'vec2<i32>': [8, 8], 'vec2<u32>': [8, 8],
  // vec3 is THE trap: align 16, size 12 — it does NOT round its own size up.
  'vec3<f32>': [12, 16], 'vec3<i32>': [12, 16], 'vec3<u32>': [12, 16],
  'vec4<f32>': [16, 16], 'vec4<i32>': [16, 16], 'vec4<u32>': [16, 16],
  'mat2x2<f32>': [16, 8], 'mat3x3<f32>': [48, 16], 'mat4x4<f32>': [64, 16],
};
const roundUp = (align, n) => Math.ceil(n / align) * align;

/** Parse `struct NAME { ... };` out of a source file and compute each member's
 *  byte offset per the WGSL layout rules, honouring @align(n) / @size(n). */
function parseWgslStruct(src, structName) {
  const m = new RegExp(`struct\\s+${structName}\\s*\\{`).exec(src);
  if (!m) throw new Error(`struct ${structName} not found`);
  const open = src.indexOf('{', m.index);
  const close = src.indexOf('}', open);
  if (close < 0) throw new Error(`struct ${structName} is unterminated`);
  const members = [];
  let off = 0, structAlign = 1;
  for (let line of src.slice(open + 1, close).split('\n')) {
    line = line.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    const mm = /^((?:@\w+\([^)]*\)\s*)*)([A-Za-z_]\w*)\s*:\s*([^,]+),?$/.exec(line);
    if (!mm) throw new Error(`${structName}: unparseable member line: ${line}`);
    const [, attrsRaw, name, typeRaw] = mm;
    const type = typeRaw.trim();
    const base = WGSL_TYPES[type];
    if (!base) throw new Error(`${structName}.${name}: unsupported type '${type}' — add it to WGSL_TYPES`);
    let [size, align] = base;
    const aAttr = /@align\((\d+)\)/.exec(attrsRaw);
    const sAttr = /@size\((\d+)\)/.exec(attrsRaw);
    if (aAttr) align = Number(aAttr[1]);
    if (sAttr) size = Number(sAttr[1]);
    off = roundUp(align, off);
    members.push({ name, type, offset: off, size });
    structAlign = Math.max(structAlign, align);
    off += size;
  }
  return { members, size: roundUp(structAlign, off) };
}

/** Collect the byte offsets a TypedArray-writer function actually writes.
 *  Handles `f[12] = …`, `u[38] = …` and the `for (let i = 0; i < 16; i++) f[i] = …`
 *  matrix loop. Only identifiers bound to a TypedArray view over the buffer count,
 *  so an unrelated `arr[3] = x` cannot inflate the coverage. */
function parseWriterOffsets(src, fnName) {
  const m = new RegExp(`function\\s+${fnName}\\s*\\(`).exec(src);
  if (!m) throw new Error(`writer ${fnName} not found`);
  let i = src.indexOf('{', m.index), depth = 0, body = '';
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { body = src.slice(i, j + 1); break; } }
  }
  if (!body) throw new Error(`writer ${fnName} body is unterminated`);

  // Which identifiers are typed-array views, and how wide is each element?
  const views = new Map();
  for (const d of body.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*new\s+(Float32Array|Uint32Array|Int32Array|Float64Array)\s*\(/g)) {
    views.set(d[1], d[2] === 'Float64Array' ? 8 : 4);
  }
  if (views.size === 0) throw new Error(`${fnName}: found no TypedArray view bindings`);

  const bytes = new Set();
  const mark = (view, index) => {
    const w = views.get(view);
    for (let b = 0; b < w; b++) bytes.add(index * w + b);
  };
  // Literal-index assignments.
  for (const a of body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\[\s*(\d+)\s*\]\s*=/g)) {
    if (views.has(a[1])) mark(a[1], Number(a[2]));
  }
  // The matrix loop: for (let i = 0; i < N; i++) view[i] = …
  for (const a of body.matchAll(/for\s*\(\s*let\s+(\w+)\s*=\s*0\s*;\s*\1\s*<\s*(\d+)\s*;\s*\1\+\+\s*\)\s*([A-Za-z_$][\w$]*)\s*\[\s*\1\s*\]/g)) {
    if (!views.has(a[3])) continue;
    for (let k = 0; k < Number(a[2]); k++) mark(a[3], k);
  }
  return bytes;
}

const fileCache = new Map();
const readSrc = (rel) => {
  if (!fileCache.has(rel)) fileCache.set(rel, readFileSync(SRC(rel), 'utf8'));
  return fileCache.get(rel);
};

// ---------------------------------------------------------------------------
// The registry. EVERY WGSL uniform struct that is filled by a hand-written
// TypedArray writer belongs here — that pairing is the whole bug class. A struct
// whose members are baked into the shader source (the agent Control /
// ForceControl uniforms, written field-by-field from the compiler's layout) is
// out of scope; those cannot drift from a separate index table because there
// isn't one.
// ---------------------------------------------------------------------------
const REGISTRY = [
  { label: 'VoxelView (L1 lattice voxel render)', file: 'simulator/engine/webgpuRuntime.ts',
    struct: 'VoxelView', writer: 'uploadVoxelView', bytesConst: 'VOXEL_VIEW_BYTES' },
  { label: 'RenderView3D (phase C agent spheres)', file: 'simulator/engine/agentWebgpuRuntime.ts',
    struct: 'RenderView3D', writer: 'uploadAgentRenderView3D', bytesConst: 'RENDER_VIEW_3D_BYTES' },
  { label: 'RenderView (A1/A2 agent discs)', file: 'simulator/engine/agentWebgpuRuntime.ts',
    struct: 'RenderView', writer: 'uploadAgentRenderView', bytesConst: 'RENDER_VIEW_BYTES' },
];

section('WGSL uniform struct ⇄ TypedArray writer byte layout');
for (const e of REGISTRY) {
  let parsed, written, declared;
  try {
    const src = readSrc(e.file);
    parsed = parseWgslStruct(src, e.struct);
    written = parseWriterOffsets(src, e.writer);
    const bc = new RegExp(`${e.bytesConst}\\s*=\\s*(\\d+)`).exec(src);
    declared = bc ? Number(bc[1]) : null;
  } catch (err) {
    check(`${e.label}: parsed`, false, err.message);
    continue;
  }

  // The buffer must never be SMALLER than the struct (an under-allocation is an
  // out-of-bounds shader read), and never more than a 16-byte rounding LARGER
  // (a bigger gap means members were removed and the constant went stale).
  // RenderView is legitimately 84 bytes in a 96-byte (16-rounded) allocation.
  check(`${e.label}: ${e.bytesConst} covers the struct without going stale`,
    declared !== null && declared >= parsed.size && declared - parsed.size < 16,
    `declared ${declared}, struct computes to ${parsed.size}`);

  // 1. No write may land in padding (or past the struct).
  const memberBytes = new Set();
  for (const mem of parsed.members) for (let b = 0; b < mem.size; b++) memberBytes.add(mem.offset + b);
  const stray = [...written].filter(b => !memberBytes.has(b)).sort((a, b) => a - b);
  check(`${e.label}: no writer byte lands in struct padding`,
    stray.length === 0,
    stray.length ? `bytes [${stray.slice(0, 8).join(', ')}${stray.length > 8 ? ', …' : ''}] are padding — the writer's index table is out of step with the shader` : '');

  // 2. Every member byte must be written (an unwritten member reads zero-init).
  const gaps = parsed.members.filter(mem => {
    for (let b = 0; b < mem.size; b++) if (!written.has(mem.offset + b)) return true;
    return false;
  });
  check(`${e.label}: every declared member is written`,
    gaps.length === 0,
    gaps.length ? `unwritten: ${gaps.map(g => `${g.name}@${g.offset}`).join(', ')}` : '');
}

// ---------------------------------------------------------------------------
// The one invariant the layout maths cannot express: the WGSL text must keep the
// attribute that pins the scalar block. Deleting `@align(16)` re-introduces the
// exact shipped bug, and the checks above WOULD catch it — this names it so the
// failure reads as a cause rather than a symptom.
// ---------------------------------------------------------------------------
section('VoxelView scalar-block pin');
{
  const src = readSrc('simulator/engine/webgpuRuntime.ts');
  const s = /struct VoxelView\s*\{[\s\S]*?\}/.exec(src)?.[0] ?? '';
  check('VoxelView pins `ambient` to a fresh 16-byte slot [@align(16); invisible-voxels bug]',
    /@align\(16\)\s*ambient/.test(s),
    'without it `ambient` lands at 124 (inside clipFwd\'s pad) and every scalar below shifts one float — cubeScale reads specular (0) ⇒ zero-size cubes ⇒ a blank canvas');
}

section('RESULT');
if (failures === 0) console.log('GPU UNIFORM LAYOUTS ✓');
else console.log(`${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
