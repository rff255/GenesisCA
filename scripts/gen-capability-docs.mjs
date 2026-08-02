// ===========================================================================
// C3 (P8) — GENERATE the Help capability/limits matrix FROM THE GATE TABLES.
//
// The proposal's diagnosis of the present drift is blunt: "hand-maintained
// tables are how the current drift happened". They were right — before this
// script, HelpView claimed "around 115 selectable node types (42 of them agent
// nodes)" while docs/NODES_REFERENCE.md claimed 150 / 53. Both were typed by
// hand, so both were free to rot.
//
// This emits a COMMITTED module (src/help/capabilityMatrix.gen.ts) that HelpView
// imports, built from the SAME objects the engine enforces with:
//
//   • AGENT_NODE_REQUIREMENT          — node -> capability
//   • the node registry               — labels, categories, which nodes are agent nodes
//   • AGENT_WASM_SUPPORTED_TYPES      — the WASM agent gate's OWN set
//   • AGENT_WEBGPU_SUPPORTED_TYPES    — the WebGPU agent gate's OWN set
//   • detectWebGPUIncompatibilities   — PROBED, not transcribed (see below)
//   • the capacity constants          — imported, so the numbers are the real ones
//
// THE REJECT SETS ARE COMPUTED, NEVER LISTED. A per-target reject is
// `registry agent nodes − SUPPORTED_TYPES`, so a node added to the catalogue and
// forgotten in a supported set appears in the docs on the next run instead of
// silently becoming unsupported-but-undocumented.
//
// Usage:
//   node scripts/gen-capability-docs.mjs           # write the module
//   node scripts/gen-capability-docs.mjs --check    # fail if the committed file is stale
//
// --check is the gate: adding a node without regenerating is a red check rather
// than drift. Nothing here is time- or environment-dependent, so the output is
// byte-stable across machines.
// ===========================================================================
import { build } from 'esbuild';
import { writeFileSync, readFileSync, rmSync, mkdtempSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src', 'help', 'capabilityMatrix.gen.ts');

// The repo's established pattern for importing TS from a node-only script:
// write a temp entry into scripts/ (so its relative ../src specifiers resolve),
// esbuild-bundle it, dynamic-import the bundle by file URL (required on Windows).
const ENTRY = `
export { AGENT_NODE_REQUIREMENT, capReqLabel, AGENT_CAPABILITY_ROWS, capabilityRowLabel } from '../src/model/agentCapabilities.ts';
export { getAllNodeDefs } from '../src/modeler/vpl/nodes/registry.ts';
export { AGENT_WASM_SUPPORTED_TYPES, AGENT_WASM_CPU_ROOT_TYPES } from '../src/modeler/vpl/compiler/agentWasm/compile.ts';
export { AGENT_WEBGPU_SUPPORTED_TYPES, AGENT_WEBGPU_NEARBY_SLOTS } from '../src/modeler/vpl/compiler/agentWebgpu/compile.ts';
export { detectWebGPUIncompatibilities } from '../src/modeler/vpl/nodes/nodeValidation.ts';
export { expandNeighbourCensus } from '../src/modeler/vpl/compiler/censusExpand.ts';
export { expandForceToAgents } from '../src/modeler/vpl/compiler/forceToAgentsExpand.ts';
export { expandPeriodicSteps } from '../src/modeler/vpl/compiler/periodicExpand.ts';
export { AGENT_NEARBY_SCRATCH_SLOTS, AGENT_HASH_BIN_CAP } from '../src/simulator/engine/agentEngine.ts';
export { BOND_REQUEST_DEPTH_MAX, CENTER_BASED_DEFAULTS, MAX_LAYOUT_ITERATIONS } from '../src/model/centerBased.ts';
export { MAX_LOOKUP_AXES, MAX_LOOKUP_TABLE_ENTRIES, MAX_INT_RANGE_SPAN } from '../src/modeler/vpl/compiler/variegation.ts';
`;
const dir = mkdtempSync(join(tmpdir(), 'gca-capdocs-'));
const entryPath = join(ROOT, 'scripts', '__capdocs_entry.ts');
writeFileSync(entryPath, ENTRY);
const outPath = join(dir, 'bundle.mjs');
await build({ entryPoints: [entryPath], bundle: true, format: 'esm', platform: 'node', outfile: outPath, logLevel: 'error', absWorkingDir: process.cwd() });
const m = await import(pathToFileURL(outPath).href);
rmSync(entryPath, { force: true });

const {
  AGENT_NODE_REQUIREMENT, capReqLabel, AGENT_CAPABILITY_ROWS, capabilityRowLabel,
  getAllNodeDefs,
  AGENT_WASM_SUPPORTED_TYPES, AGENT_WASM_CPU_ROOT_TYPES,
  AGENT_WEBGPU_SUPPORTED_TYPES, AGENT_WEBGPU_NEARBY_SLOTS,
  detectWebGPUIncompatibilities,
  expandNeighbourCensus, expandForceToAgents, expandPeriodicSteps,
  AGENT_NEARBY_SCRATCH_SLOTS, AGENT_HASH_BIN_CAP,
  BOND_REQUEST_DEPTH_MAX, CENTER_BASED_DEFAULTS, MAX_LAYOUT_ITERATIONS,
  MAX_LOOKUP_AXES, MAX_LOOKUP_TABLE_ENTRIES, MAX_INT_RANGE_SPAN,
} = m;

const defs = getAllNodeDefs();

// `HIDDEN_FROM_MENU` is module-private in registry.ts; these three are the macro
// BOUNDARY nodes, which exist only inside a macro subgraph and are never offered
// in a menu. Kept here (rather than silently folded into a count) so the number
// the docs quote can be reconciled with the registry length.
const HIDDEN_MACRO_TYPES = ['macro', 'macroInput', 'macroOutput'];

const isAgent = (d) => d.requirements?.bondGraph === true;
const isOverseer = (d) => d.requirements?.overseer === true;

const agentDefs = defs.filter(isAgent).sort((a, b) => a.type.localeCompare(b.type));

// --- LOWERED node types: probed, not listed ---------------------------------
// Some nodes are absent from a supported set because a shared pre-compile
// transform REWRITES them into primitives the targets already compile — the
// `expandMacros` / `expandComposites` pattern. They run on every target, so
// reporting them as "unsupported" would be exactly the drift P8 exists to stop.
//
// We find them by ASKING the shipped transforms: feed each a one-node graph and
// see whether the node survives. Adding a new lowering transform means adding it
// to this probe list — a deliberate one-line edit, not a silent hand-written set.
const LOWERING_TRANSFORMS = [expandNeighbourCensus, expandForceToAgents, expandPeriodicSteps];
const PROBE_MODEL = { properties: {}, attributes: [], agentAttributes: [], agentGraphNodes: [], agentGraphEdges: [] };
function isLowered(type) {
  const probe = [{ id: '__probe', type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: type, config: {} } }];
  for (const fn of LOWERING_TRANSFORMS) {
    let out;
    try { out = fn(probe, [], PROBE_MODEL); } catch { continue; }
    // Gone from the output ⇒ this transform owns (and lowers) the type.
    if (!out.nodes.some((n) => n.data?.nodeType === type)) return true;
  }
  return false;
}

// --- the per-target agent matrix -------------------------------------------
// Support is membership in the gate's OWN set — the same lookup
// `isAgentGraphWasmSupported` / `isAgentGraphWebGPUSupported` perform per node.
//
// A node OUTSIDE a set is not automatically a gap. Three derived exemptions:
//   entryPoint — an event ROOT. The agent gates walk the BEHAVIOUR-reachable
//                cone, which by construction never contains a root, so a root's
//                membership does not decide anything.
//   lowered    — rewritten before any target compiles (probed above).
//   cpuRoot    — kept on the CPU by design on EVERY target (the division event /
//                agent init and the spawn pair).
// What survives all three is a genuine per-target gap.
const agentRows = agentDefs.map((d) => {
  const cap = AGENT_NODE_REQUIREMENT[d.type];
  const entryPoint = d.category === 'event';
  const lowered = isLowered(d.type);
  const cpuRoot = AGENT_WASM_CPU_ROOT_TYPES.has(d.type);
  const wasm = AGENT_WASM_SUPPORTED_TYPES.has(d.type);
  const webgpu = AGENT_WEBGPU_SUPPORTED_TYPES.has(d.type);
  const exempt = entryPoint || lowered || cpuRoot;
  return {
    type: d.type,
    label: d.agentLabel ?? d.label,
    category: d.category ?? '',
    capability: cap ?? null,
    capabilityLabel: cap ? capReqLabel(cap) : null,
    wasm, webgpu, entryPoint, lowered, cpuRoot,
    // What the Help matrix should SHOW per target: 'yes' | 'exempt' | 'no'.
    wasmStatus: wasm ? 'yes' : exempt ? 'exempt' : 'no',
    webgpuStatus: webgpu ? 'yes' : exempt ? 'exempt' : 'no',
  };
});

// --- the WebGPU GRID reject set: PROBED, not transcribed ---------------------
// `detectWebGPUIncompatibilities` is an inline switch, not an exported list, so
// the only way to read it without duplicating it is to ASK it. We probe every
// registry node with a bare config (catches the unconditional rejects) and with
// each candidate operation below (catches the config-dependent ones).
//
// The candidate list is the probe's INPUT SPACE — the gate still produces every
// verdict. A future gate that rejects some other node under one of these ops is
// picked up with no edit here.
const PROBE_OPS = [
  null, 'toggle', 'next', 'previous', 'increment', 'decrement', 'max', 'min', 'or', 'and', 'set',
];
const gridRejects = [];
for (const d of defs) {
  const seen = new Map();   // reason -> { unconditional, ops[] }
  for (const op of PROBE_OPS) {
    const cfg = op === null ? {} : { operation: op };
    let issues = [];
    try { issues = detectWebGPUIncompatibilities(d.type, cfg, { properties: {} }) ?? []; }
    catch { continue; }   // a node whose gate needs more context than a probe gives
    for (const text of issues) {
      if (!seen.has(text)) seen.set(text, { unconditional: false, ops: [] });
      const e = seen.get(text);
      // The BARE-config probe rejecting it proves the reject does not depend on
      // configuration. Without this the same reason recurs under every candidate
      // op and an unconditional reject reads as a config-dependent one.
      if (op === null) e.unconditional = true; else e.ops.push(op);
    }
  }
  for (const [reason, e] of seen) {
    gridRejects.push({
      type: d.type,
      label: d.label,
      // Empty ⇒ rejected regardless of configuration.
      condition: e.unconditional ? '' : `operation = ${e.ops.join(' / ')}`,
      reason,
    });
  }
}
gridRejects.sort((a, b) => a.type.localeCompare(b.type) || a.condition.localeCompare(b.condition));

// --- capacity limits (Class C: a limit is always stated WITH its number) -----
const limits = [
  { key: 'AGENT_NEARBY_SCRATCH_SLOTS', label: 'Proximity-query scratch slots (WebAssembly agents)',
    value: AGENT_NEARBY_SCRATCH_SLOTS,
    note: 'Simultaneous Get Nearby Agents / Get Agents In View producers in one agent graph. Above this the agent loop runs on JavaScript — a capacity clamp, never a wrong result.' },
  { key: 'AGENT_WEBGPU_NEARBY_SLOTS', label: 'Array-producer slots (WebGPU agents)',
    value: AGENT_WEBGPU_NEARBY_SLOTS,
    note: 'Every array-producing node counts. A Neighbour Census emits two, so roughly three census nodes fit. Above this the agent loop falls back to a CPU engine.' },
  { key: 'AGENT_GPU_ARRAY_CAP', label: 'Members per array (WebGPU agents)',
    value: 2048,
    note: 'WGSL zero-initialises per-thread arrays, so these scratch buffers are capped rather than sized by Max Agents. A query returning more members is truncated.' },
  { key: 'BOND_REQUEST_DEPTH_DEFAULT', label: 'Bond requests per agent per generation (default)',
    value: CENTER_BASED_DEFAULTS.bondRequestDepth,
    note: 'Set by Bond Requests / Agent / Step. Requests past the depth are rejected WHOLE — never half-applied — and a notice tells you to raise it.' },
  { key: 'BOND_REQUEST_DEPTH_MAX', label: 'Bond requests per agent per generation (maximum)',
    value: BOND_REQUEST_DEPTH_MAX, note: 'The upper clamp on that setting.' },
  { key: 'MAX_LAYOUT_ITERATIONS', label: 'Layout (solver relaxation) iterations',
    value: MAX_LAYOUT_ITERATIONS,
    note: 'How many times the force integrator runs per generation. 1 = the historical engine exactly.' },
  { key: 'AGENT_HASH_BIN_CAP', label: 'Spatial-hash bins',
    value: AGENT_HASH_BIN_CAP,
    note: 'The neighbour hash coarsens its bin edge rather than exceeding this, so per-generation cost tracks the agent population, not the world size.' },
  { key: 'MAX_LOOKUP_AXES', label: 'Lookup Table axes', value: MAX_LOOKUP_AXES,
    note: 'A table may be keyed by up to this many axes.' },
  { key: 'MAX_LOOKUP_TABLE_ENTRIES', label: 'Lookup Table entries', value: MAX_LOOKUP_TABLE_ENTRIES,
    note: 'The product of every axis length.' },
  { key: 'MAX_INT_RANGE_SPAN', label: 'Integer-range axis span', value: MAX_INT_RANGE_SPAN,
    note: 'The widest integer range a single table axis may cover.' },
];

// --- counts (the numbers the Help prose used to type by hand) ---------------
const counts = {
  registry: defs.length,
  hiddenMacro: HIDDEN_MACRO_TYPES.length,
  selectable: defs.length - HIDDEN_MACRO_TYPES.length,
  agent: agentDefs.length,
  overseer: defs.filter(isOverseer).length,
  agentOnWasm: agentRows.filter((r) => r.wasmStatus === 'yes').length,
  agentOnWebgpu: agentRows.filter((r) => r.webgpuStatus === 'yes').length,
  agentCpuRoots: agentRows.filter((r) => r.cpuRoot).length,
  agentLowered: agentRows.filter((r) => r.lowered).length,
  /** Genuine per-target gaps (exemptions already discounted). */
  agentGapsWasm: agentRows.filter((r) => r.wasmStatus === 'no').length,
  agentGapsWebgpu: agentRows.filter((r) => r.webgpuStatus === 'no').length,
};

// --- capability rows (the Properties panel's own list, in ITS order) --------
// AGENT_CAPABILITY_ROWS entries carry their own metadata; take only what the
// docs need so a future field added there cannot silently widen this module.
const capabilityRows = AGENT_CAPABILITY_ROWS.map((r) => ({
  key: r.key,
  label: capabilityRowLabel(r.key),
  description: r.description ?? '',
  requires: r.requires ?? '',
}));

// ---------------------------------------------------------------------------
const J = (v) => JSON.stringify(v, null, 2);
const source = `// =============================================================================
// AUTO-GENERATED — DO NOT EDIT BY HAND.
//
// Produced by \`node scripts/gen-capability-docs.mjs\` from the tables the engine
// actually enforces with (AGENT_NODE_REQUIREMENT, the node registry, the two
// agent supported-type sets, the WebGPU grid gate, and the capacity constants).
// Run \`node scripts/gen-capability-docs.mjs --check\` to fail on staleness.
//
// Editing this file is pointless: the next regeneration overwrites it, and the
// --check gate will flag whatever you wrote. Change the SOURCE table instead.
// =============================================================================

/** One agent node's per-target support + the capability that reveals it. */
export interface CapabilityNodeRow {
  type: string;
  label: string;
  category: string;
  /** The capability key that must be enabled for this node to appear. */
  capability: string | null;
  /** Human label for that key (e.g. "Motion = Force"). */
  capabilityLabel: string | null;
  /** Raw membership in each target's supported-type set. */
  wasm: boolean;
  webgpu: boolean;
  /** An event ROOT. The agent gates inspect the behaviour-reachable cone, which
   *  never contains a root, so set membership does not decide anything for it. */
  entryPoint: boolean;
  /** Rewritten into supported primitives BEFORE any target compiles, so it runs
   *  everywhere regardless of set membership. */
  lowered: boolean;
  /** Runs on the CPU on EVERY target by design (division event / agent init /
   *  the spawn pair) — absent from a supported set for a reason, not a gap. */
  cpuRoot: boolean;
  /** What to SHOW per target: 'yes' (in the set) | 'exempt' (runs anyway, for
   *  one of the three reasons above) | 'no' (a genuine gap — the node clamps
   *  that layer to a CPU engine). */
  wasmStatus: 'yes' | 'exempt' | 'no';
  webgpuStatus: 'yes' | 'exempt' | 'no';
}

/** A node the WebGPU CA-GRID engine rejects, and why. \`condition\` is empty when
 *  the node is rejected in every configuration. */
export interface GridRejectRow {
  type: string;
  label: string;
  condition: string;
  reason: string;
}

/** A resource bound. Class C limits are always stated WITH their number. */
export interface CapacityLimit {
  key: string;
  label: string;
  value: number;
  note: string;
}

export const AGENT_NODE_MATRIX: CapabilityNodeRow[] = ${J(agentRows)};

export const WEBGPU_GRID_REJECTS: GridRejectRow[] = ${J(gridRejects)};

export const CAPACITY_LIMITS: CapacityLimit[] = ${J(limits)};

/** Node counts, so prose never hard-codes a number that can rot. */
export const NODE_COUNTS = ${J(counts)} as const;

/** The agent capability rows, in the order the Properties panel lists them. */
export const AGENT_CAPABILITY_LIST: Array<{
  key: string; label: string; description: string; requires: string;
}> = ${J(capabilityRows)};
`;

const wanted = source.replace(/\r\n/g, '\n');
if (process.argv.includes('--check')) {
  if (!existsSync(OUT)) {
    console.error('STALE: src/help/capabilityMatrix.gen.ts does not exist. Run: node scripts/gen-capability-docs.mjs');
    process.exit(1);
  }
  const have = readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n');
  if (have !== wanted) {
    // Report the first differing line — enough to see WHAT drifted without
    // dumping a whole generated file into the console.
    const a = have.split('\n'), b = wanted.split('\n');
    let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
    console.error('STALE: src/help/capabilityMatrix.gen.ts no longer matches the gate tables.');
    console.error(`  first difference at line ${i + 1}`);
    console.error(`  committed: ${(a[i] ?? '<eof>').slice(0, 160)}`);
    console.error(`  generated: ${(b[i] ?? '<eof>').slice(0, 160)}`);
    console.error('  fix: node scripts/gen-capability-docs.mjs');
    process.exit(1);
  }
  console.log(`capability docs up to date (${counts.agent} agent nodes, ${gridRejects.length} grid rejects, ${limits.length} limits)`);
} else {
  writeFileSync(OUT, wanted, 'utf8');
  console.log(`wrote src/help/capabilityMatrix.gen.ts`);
  console.log(`  ${counts.registry} registry node types (${counts.selectable} selectable, ${counts.agent} agent, ${counts.overseer} overseer)`);
  console.log(`  agent nodes on WASM ${counts.agentOnWasm}/${counts.agent}, on WebGPU ${counts.agentOnWebgpu}/${counts.agent} (${counts.agentCpuRoots} CPU-root)`);
  console.log(`  ${gridRejects.length} WebGPU grid rejects, ${limits.length} capacity limits`);
}
