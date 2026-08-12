// ===========================================================================
// C1 (P2) — TARGET COMPATIBILITY DIAGNOSIS.
//
// "Which engines can this model use, and why not the others?" — answered BEFORE
// running, per layer (CA grid / agents) × per engine (JS / WASM / WebGPU).
//
// THE DESIGN RULE: every VERDICT is produced by the function that ENFORCES it —
// `detectWebGPUIncompatibilities`, `detectWebGPUModelIncompatibilities`,
// `isAgentGraphWasmSupported`, `isAgentGraphWebGPUSupported`, `agentTargetOf`,
// `residencyModelBlockers`, `resolveMaxBonds`. This module never re-implements a
// gate, so the readout cannot drift from the truth (the `resolveMaxBonds` /
// `modelAttrSlotKeys` single-source discipline).
//
// A gate that only answers for the CURRENTLY-selected target is asked
// HYPOTHETICALLY, by handing it a shallow probe clone with that target selected
// — the honest way to answer "could I use WebGPU?" without duplicating its logic.
//
// REASON TEXTS are a diagnostic layer ON TOP of the verdict. The agent gates
// return a bare boolean, so when one says "no" this module explains it by
// reading the gate's OWN tables (`AGENT_*_SUPPORTED_TYPES`, the capacity
// constants) and falls back to a generic, honest sentence when it cannot pin the
// reason down. The verdict itself NEVER depends on that explanation, so a reason
// can at worst be unhelpfully generic — never wrong about ✓/✗.
//
// The four classes come from the proposal's doctrine (§1.1 / §2):
//   S semantics       — the engine's execution model cannot express it (blocker)
//   R reproducibility — runs, but not bit-reproducibly (note)
//   F fast path       — runs identically; only ms/generation differ (note)
//   C capacity        — a resource bound with a NUMBER (blocker, number stated)
// ===========================================================================

import type { CAModel, CenterBasedConfig, EngineChoice, EngineId, GraphNode, ReproducibilityContract } from './types';
import type { NodeConfig } from '../modeler/vpl/types';
import { resolveMaxBonds } from './centerBased';
import { resolveEngines, gridWebgpuBlockers } from './engineResolution';
import { contractViolationFor, reproducibilityOf } from './reproducibility';
import { cellFieldAttrsOf } from './attributeScope';
import { residencyModelBlockers, type ResidencyGraphFacts } from './agentResidency';
import { detectWasmIncompatibilities } from '../modeler/vpl/nodes/nodeValidation';
import { isAgentGraphWasmSupported, AGENT_WASM_SUPPORTED_TYPES } from '../modeler/vpl/compiler/agentWasm/compile';
import { isAgentGraphWebGPUSupported, AGENT_WEBGPU_SUPPORTED_TYPES, AGENT_WEBGPU_NEARBY_SLOTS } from '../modeler/vpl/compiler/agentWebgpu/compile';
import { AGENT_NEARBY_SCRATCH_SLOTS } from '../simulator/engine/agentEngine';

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

export type ReasonClass = 'semantics' | 'reproducibility' | 'fastpath' | 'capacity';
export type { EngineId, EngineChoice } from './types';
export type LayerId = 'grid' | 'agents';

export interface Reason {
  class: ReasonClass;
  text: string;
}

export interface EngineVerdict {
  engine: EngineId;
  /** False ⇒ selecting this engine falls back to another one. */
  ok: boolean;
  /** Why it cannot run here (classes S / C). Empty when `ok`. */
  blockers: Reason[];
  /** Runs, but with a caveat (classes R / F). Never affects `ok`. */
  notes: Reason[];
}

export interface LayerDiagnosis {
  layer: LayerId;
  label: string;
  /** C4 — what the user SELECTED (may be `'auto'`). */
  selected: EngineChoice;
  /** What that selection asks for (for `'auto'`, the engine Auto picked). */
  requested: EngineId;
  /** What the engine will actually run (the real resolver / gate). */
  resolved: EngineId;
  /** Set only when `resolved !== requested` — the first blocking reason. */
  demotionReason?: Reason;
  /** C5 (P10) — set when the RESOLVED engine cannot honour the model's declared
   *  reproducibility contract. Not a blocker: the engine runs, it just delivers
   *  a weaker guarantee than the model claims. Straight from `resolveEngines`. */
  contractViolation?: Reason;
  verdicts: EngineVerdict[];
}

export interface TargetDiagnosis {
  layers: LayerDiagnosis[];
  /** C5 (P10) — the declared contract every verdict above was read against. */
  contract: ReproducibilityContract;
}

export const ENGINE_LABEL: Record<EngineId, string> = {
  js: 'Debug / Reference (JS)',
  wasm: 'WebAssembly',
  webgpu: 'WebGPU',
};

export const REASON_CLASS_TAG: Record<ReasonClass, string> = {
  semantics: 'S', reproducibility: 'R', fastpath: 'F', capacity: 'C',
};

export const REASON_CLASS_TITLE: Record<ReasonClass, string> = {
  semantics: 'Semantics — this engine’s execution model cannot express the rule.',
  reproducibility: 'Reproducibility — it runs correctly, but not bit-reproducibly.',
  fastpath: 'Fast path — it runs identically either way; only speed differs.',
  capacity: 'Capacity — a resource limit, not a concept.',
};

// The doctrine sentences, referenced by the reason texts + the Help explainer.
export const PRINCIPLE_SEQUENTIAL = 'Sequential rules (a write is visible to a later cell/agent in the SAME generation) run on the CPU engines only; the GPU runs parallel rules.';
export const PRINCIPLE_EXACT = 'CPU engines are exact (f64, one shared seeded stream — seeds pin a run); the GPU is statistical (f32, per-thread RNG — same distribution, never bitwise).';
export const PRINCIPLE_FASTPATH = 'Speed paths are eligibility, not correctness — an ineligible model computes exactly the same thing, just slower.';

const R = (cls: ReasonClass, text: string): Reason => ({ class: cls, text });

// ---------------------------------------------------------------------------
// Macro-aware node walk. The compilers flatten macros up front (`expandMacros`),
// so a node inside a macro instance is every bit as real as a top-level one —
// the same discipline `agentUsesField` uses in SimulatorView.
// ---------------------------------------------------------------------------

function walkNodes(
  roots: ReadonlyArray<GraphNode> | undefined,
  model: CAModel,
  visit: (nodeType: string, config: NodeConfig) => void,
): void {
  const macroDefs = model.macroDefs ?? [];
  const seen = new Set<string>();
  const scan = (nodes: ReadonlyArray<GraphNode> | undefined): void => {
    for (const n of nodes ?? []) {
      const t = n.data?.nodeType as string | undefined;
      if (!t) continue;
      const cfg = (n.data?.config ?? {}) as NodeConfig;
      if (t === 'macro') {
        const defId = cfg.macroDefId as string | undefined;
        if (defId && !seen.has(defId)) {
          seen.add(defId);
          scan(macroDefs.find(d => d.id === defId)?.nodes as ReadonlyArray<GraphNode> | undefined);
        }
        continue;
      }
      visit(t, cfg);
    }
  };
  scan(roots);
}

/** Walk ONLY the agent nodes reachable from the BEHAVIOUR root (its flow chain +
 *  every transitive value input), the same scope the agent compilers use for
 *  their `usesStructural` / `usesSpawn` / … flags. This matters: `divisionEvent`
 *  and `agentInit` are compiled separately on the CPU on every engine, so a
 *  Create Agent in the Init Event must NOT be reported as a residency blocker
 *  (Particle Life spawns its whole population there and IS resident).
 *
 *  Reachability over the model's own edges, not a re-derivation of a gate. A
 *  reached macro instance contributes its WHOLE body — conservative, and exactly
 *  what `expandMacros` produces. */
function behaviourReachedIds(model: CAModel): Set<string> {
  const nodes = model.agentGraphNodes ?? [];
  const edges = model.agentGraphEdges ?? [];
  const reached = new Set<string>();
  const queue: string[] = [];
  for (const n of nodes) {
    const t = n.data?.nodeType;
    if (t === 'behaviourStep' || t === 'periodicStep') { reached.add(n.id); queue.push(n.id); }
  }
  while (queue.length) {
    const id = queue.pop()!;
    for (const e of edges) {
      // The compilers' walk exactly: FLOW edges OUT of a reached node (its
      // downstream chain) + VALUE edges INTO a reached node (its input cone).
      // Following value edges OUTWARD would be wrong — a value producer shared
      // with the Division Event would drag that CPU-only subtree in.
      let next: string | null = null;
      if (e.source === id && e.sourceHandle?.startsWith('output_flow')) next = e.target;
      else if (e.target === id && e.targetHandle?.startsWith('input_value')) next = e.source;
      if (next && !reached.has(next)) { reached.add(next); queue.push(next); }
    }
  }
  return reached;
}

function walkAgentBehaviourNodes(
  model: CAModel,
  visit: (nodeType: string, config: NodeConfig) => void,
): void {
  const byId = new Map((model.agentGraphNodes ?? []).map(n => [n.id, n]));
  const reachedNodes = [...behaviourReachedIds(model)]
    .map(id => byId.get(id)).filter((n): n is GraphNode => !!n);
  walkNodes(reachedNodes, model, visit);
}

/** Dedupe reasons by text — the same node type placed twice must not produce the
 *  same sentence twice. */
function dedupe(reasons: Reason[]): Reason[] {
  const seen = new Set<string>();
  return reasons.filter(r => (seen.has(r.text) ? false : (seen.add(r.text), true)));
}

// ---------------------------------------------------------------------------
// CA-grid layer
// ---------------------------------------------------------------------------

function diagnoseGrid(model: CAModel): LayerDiagnosis {
  // C4 — `resolveEngines` is the single source for selected/requested/resolved.
  const res = resolveEngines(model).grid;

  // --- JS: the reference. Full coverage by construction. -------------------
  const js: EngineVerdict = {
    engine: 'js', ok: true, blockers: [],
    notes: [R('fastpath', 'Reference semantics — readable in Show Code and breakpointable, but the slowest engine. The other engines are verified bit-identical to it.')],
  };

  // --- WASM: full lattice catalogue. Ask the real per-node gate anyway, so a
  //     future WASM-only gap surfaces here without touching this file. -------
  const wasmBlockers: Reason[] = [];
  walkNodes(model.graphNodes, model, (t, cfg) => {
    for (const msg of detectWasmIncompatibilities(t, cfg, model)) wasmBlockers.push(R('semantics', msg));
  });
  const wasm: EngineVerdict = {
    engine: 'wasm', ok: wasmBlockers.length === 0, blockers: dedupe(wasmBlockers),
    notes: [R('reproducibility', 'Exact and seedable — f64 math on one shared seeded stream, bit-identical to the JS reference.')],
  };

  // --- WebGPU: the SAME blocker collection the resolution decides on, so the
  //     verdict and its explanation can never disagree. (`gridWebgpuBlockers`
  //     asks both gates with a WebGPU-selected probe clone — the model gate
  //     early-outs otherwise — so the answer is "could you?", not "did you?".)
  const gpuBlockers: Reason[] = [];
  {
    const b = gridWebgpuBlockers(model);
    if (b.modelIssue) gpuBlockers.push(R('semantics', `${b.modelIssue} ${PRINCIPLE_SEQUENTIAL}`));
    for (const msg of b.nodeIssues) gpuBlockers.push(R('semantics', msg));
  }
  // C5 — the honest per-device statement. The grid's per-cell PCG IS re-derived
  // by `setRngSeed` (the worker handler writes the WASM cell AND calls
  // `seedRngState`), so a fixed seed DOES reproduce a grid run on this device —
  // measured on a 5-run Overseer sweep. What f32 costs is comparability with the
  // CPU engines and across devices. This is why Exact still allows the GPU grid
  // while it rejects the GPU agent engine (see reproducibility.ts).
  const gpuNotes: Reason[] = [
    R('reproducibility', 'Statistical parity vs the CPU engines — f32 math and a per-cell RNG stream, so the numbers are never bit-identical to WASM/JS and may differ on another device. A fixed seed DOES reproduce a run on this device (Set Random Seed re-derives the per-cell streams), so Exact still allows the GPU here.'),
  ];
  if (model.properties.skipIsolatedEmpty?.enabled) {
    gpuNotes.push(R('fastpath', 'Skip Isolated Empty Cells is ignored on WebGPU — the GPU runs the whole grid every generation (same results, no sparse speed-up).'));
  }
  const webgpu: EngineVerdict = {
    engine: 'webgpu', ok: gpuBlockers.length === 0, blockers: dedupe(gpuBlockers), notes: gpuNotes,
  };

  const verdicts = [wasm, webgpu, js];
  const byId: Record<EngineId, EngineVerdict> = { js, wasm, webgpu };
  // The compilers return an error for a rejected target and the worker stays on
  // JS (the always-runnable fallback) — the documented grid demotion, decided by
  // `resolveEngines`. Auto never lands here (it only ever picks a passing engine).
  const demotionReason = res.resolved !== res.requested ? byId[res.requested].blockers[0] : undefined;

  return {
    layer: 'grid', label: 'CA Grid',
    selected: res.selected, requested: res.requested, resolved: res.resolved,
    demotionReason, verdicts,
  };
}

// ---------------------------------------------------------------------------
// Agents layer
// ---------------------------------------------------------------------------

/** Count the agent-array producers the two capacity gates budget for. The gates
 *  count them on the FLATTENED graph, so this walk is macro-aware for the same
 *  reason. Used ONLY to put a number on a capacity blocker — never to decide it. */
function countAgentArrayProducers(model: CAModel): { nearby: number; allProducers: number } {
  let nearby = 0, allProducers = 0;
  // The WebGPU budget counts EVERY array producer; the WASM one counts only the
  // two neighbour-query producers (the rest use the bump-pointer scratch).
  const WEBGPU_PRODUCERS = new Set([
    'getNearbyAgents', 'getAgentsInView', 'getBondedAgents', 'getAgentsAttribute',
    'filterAgents', 'joinAgents', 'pickNRandomAgents', 'neighbourCensus',
  ]);
  walkNodes(model.agentGraphNodes, model, (t) => {
    if (t === 'getNearbyAgents' || t === 'getAgentsInView') nearby++;
    if (WEBGPU_PRODUCERS.has(t)) allProducers += t === 'neighbourCensus' ? 2 : 1;
  });
  return { nearby, allProducers };
}

/** Best-effort: which agent node types are outside an engine's supported set.
 *  Reads the gate's OWN table. A node the flatten LOWERS away (census, periodic
 *  step, composites, multi-slot accessors…) would be a false positive, so the
 *  walk only reports a type the table rejects AND that is not a known lowering
 *  source. Purely explanatory — the verdict comes from the gate. */
const LOWERED_AWAY = new Set([
  // flattened / lowered before the gate sees the graph
  'macro', 'macroInput', 'macroOutput', 'reroute',
  'neighbourCensus', 'periodicStep', 'applyForceToAgents',
  'makeVector', 'breakVector', 'vectorOp', 'makeColor', 'breakColor',
  // roots compiled SEPARATELY on the CPU on every engine — never in the
  // behaviour cone the gate checks, so they can never be a reject reason.
  'agentInit', 'divisionEvent', 'agentOutputMapping', 'agentInputMapping', 'behaviourStep',
]);
function unsupportedAgentTypes(model: CAModel, table: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  // Behaviour-scoped, like the gate: a node only reachable from the Init /
  // Division / Output-Mapping roots is compiled on the CPU and is irrelevant.
  walkAgentBehaviourNodes(model, (t) => {
    if (!LOWERED_AWAY.has(t) && !table.has(t)) out.add(t);
  });
  return [...out];
}

/** The DOCUMENTED WebGPU agent fundamentals that are op-level (not type-level),
 *  so the supported-type table cannot show them. Detecting these exactly turns
 *  the generic fallback into a specific, correct sentence. */
function webgpuAgentFundamentals(model: CAModel): Reason[] {
  const out: Reason[] = [];
  // Cross-agent OVERWRITE with a WIRED, non-spawn-handle id — sequential-order
  // dependent, so the parallel GPU cannot honour it. Detected exactly the way the
  // gate does (same node types, same port names, same Create-Agent exemption).
  {
    const CROSS_AGENT_OVERWRITE = new Set(['setAttribute', 'setAgentsAttribute', 'setAgentPosition', 'setAgentRadius', 'setVelocity', 'setTargetRadius']);
    const nodes = model.agentGraphNodes ?? [];
    const edges = model.agentGraphEdges ?? [];
    const byId = new Map(nodes.map(n => [n.id, n] as const));
    const reached = behaviourReachedIds(model);   // behaviour-scoped, like the gate
    const hit = nodes.some(n => {
      if (!reached.has(n.id) || !CROSS_AGENT_OVERWRITE.has(n.data?.nodeType as string)) return false;
      const port = n.data.nodeType === 'setAgentsAttribute' ? 'agents' : 'agentId';
      const idEdge = edges.find(e => e.target === n.id && e.targetHandle === `input_value_${port}`);
      if (!idEdge) return false;                                                    // unwired = self (thread-own)
      return byId.get(idEdge.source)?.data?.nodeType !== 'createAgent';             // a staged newborn is exempt
    });
    if (hit) {
      out.push(R('semantics', `A cross-agent write (Set Attribute / Velocity / Agent Position / Agent Radius / Target Radius) is aimed at a wired agent id. Which write lands then depends on the order agents run in — well-defined on the sequential CPU engines, undefined for parallel GPU threads. ${PRINCIPLE_SEQUENTIAL}`));
    }
  }
  walkAgentBehaviourNodes(model, (t, cfg) => {
    const op = cfg.operation ?? cfg.op;
    if ((t === 'aggregate' || t === 'groupOperator') && (op === 'median' || op === 'random')) {
      out.push(R('semantics', `${t === 'aggregate' ? 'Aggregate' : 'Group Reduce'} with the “${op}” operation has no parallel form on the GPU (a sort / a shared-stream pick). ${PRINCIPLE_SEQUENTIAL}`));
    }
    if (t === 'updateIndicator' && (op === 'toggle' || op === 'next' || op === 'previous')) {
      out.push(R('semantics', `Update Indicator “${op}” mutates one shared accumulator in an order-dependent way — undefined when parallel threads write it. ${PRINCIPLE_SEQUENTIAL}`));
    }
  });
  return out;
}

function diagnoseAgents(model: CAModel): LayerDiagnosis {
  const cfg: CenterBasedConfig | undefined = model.centerBased;
  // C4 — selected / requested / resolved all come from the one resolver.
  const res = resolveEngines(model).agents!;

  // THE GATES — authoritative for every verdict below.
  const wasmSupported = isAgentGraphWasmSupported(model);
  const webgpuSupported = isAgentGraphWebGPUSupported(model);

  const producers = countAgentArrayProducers(model);

  // C7: an agent graph with NO behaviour root yet — the state EVERY freshly
  // created agent model (archetype or a hand-enabled Agents topology) is in.
  // Both compiled gates early-out on exactly this test, so without naming it the
  // fall-through below invents a capacity / fundamentals reason for a graph that
  // simply has no rule yet: technically a correct ✗, actively misleading as an
  // explanation. Mirrors `isAgentGraphWasmSupported`'s own early-out (top-level
  // nodes; a Periodic Step SYNTHESIZES a behaviour root at compile time).
  const noBehaviourRoot = !(model.agentGraphNodes ?? []).some(
    n => n.data.nodeType === 'behaviourStep' || n.data.nodeType === 'periodicStep');
  const emptyGraphReason = () => R('fastpath',
    'The Agents graph has no Behaviour Step (or Periodic Step) yet, so there is no per-agent rule to compile. Add one and this re-evaluates.');

  const js: EngineVerdict = {
    engine: 'js', ok: true, blockers: [],
    notes: [R('fastpath', 'Reference semantics — full node coverage. The agent loop is already O(N) via the spatial hash, so JS is a reasonable engine at small populations.')],
  };

  // --- WASM: full catalogue; the ONLY clamp is the scratch-slot budget. -----
  const wasmBlockers: Reason[] = [];
  if (!wasmSupported) {
    if (noBehaviourRoot) {
      wasmBlockers.push(emptyGraphReason());
    } else if (producers.nearby > AGENT_NEARBY_SCRATCH_SLOTS) {
      wasmBlockers.push(R('capacity', `${producers.nearby} simultaneous neighbour-query producers (Get Nearby Agents / Get Agents In View) — the WASM agent scratch budget is ${AGENT_NEARBY_SCRATCH_SLOTS}. Reuse one query result instead of repeating the query.`));
    } else {
      const unsupported = unsupportedAgentTypes(model, AGENT_WASM_SUPPORTED_TYPES);
      wasmBlockers.push(unsupported.length
        ? R('capacity', `The agent graph uses a node the WASM agent loop does not emit (${unsupported.slice(0, 4).join(', ')}). It falls back to the JS engine.`)
        : R('capacity', `This agent graph exceeds a WASM agent capacity budget (the array-producer scratch slots) and falls back to the JS engine.`));
    }
  }
  const wasm: EngineVerdict = {
    engine: 'wasm', ok: wasmSupported, blockers: wasmBlockers,
    notes: wasmSupported
      ? [R('reproducibility', 'Exact and seedable — f64 math on one shared seeded stream, bit-identical to the JS reference (enforced by the permanent parity harness). Typically 2–5× faster than JS on heavy per-agent rules.')]
      : [],
  };

  // --- WebGPU: the gate decides; the fundamentals scan explains. ------------
  const gpuBlockers: Reason[] = [];
  if (!webgpuSupported && noBehaviourRoot) {
    gpuBlockers.push(emptyGraphReason());
  } else if (!webgpuSupported) {
    const fundamentals = webgpuAgentFundamentals(model);
    if (producers.allProducers > AGENT_WEBGPU_NEARBY_SLOTS) {
      gpuBlockers.push(R('capacity', `${producers.allProducers} agent-array producers — the WebGPU agent register budget is ${AGENT_WEBGPU_NEARBY_SLOTS}. (A Neighbour Census counts as two.)`));
    }
    gpuBlockers.push(...fundamentals);
    if (gpuBlockers.length === 0) {
      const unsupported = unsupportedAgentTypes(model, AGENT_WEBGPU_SUPPORTED_TYPES);
      gpuBlockers.push(unsupported.length
        ? R('semantics', `The agent graph uses a node the WebGPU agent shader does not emit (${unsupported.slice(0, 4).join(', ')}).`)
        : R('semantics', `This agent graph uses one of the parallel-execution fundamentals the GPU cannot express — an order-dependent aggregate (median / uniform random), an order-dependent indicator op (toggle / next / previous), or a cross-agent overwrite aimed at a wired agent id. ${PRINCIPLE_SEQUENTIAL}`));
    }
  }

  const gpuNotes: Reason[] = [];
  if (webgpuSupported) {
    gpuNotes.push(R('reproducibility', 'Statistical parity — f32 math and a per-agent RNG stream. Statistically equivalent to the CPU engines, never bit-identical; Set Random Seed does not pin a run, so Overseer sweeps do not reproduce here.'));
    // C5 — say so on the ENGINE row too, so the consequence of picking it is
    // visible before it is picked (not only once it is the resolved engine).
    const contractNote = contractViolationFor('agents', 'webgpu', reproducibilityOf(model));
    if (contractNote) gpuNotes.push(R('reproducibility', contractNote));
    // Class F — residency, from the SAME predicate the worker uses.
    const facts = residencyFactsFromModel(model);
    const blockers = residencyModelBlockers(cfg, facts);
    if (blockers.length > 0 && blockers[0]) {
      gpuNotes.push(R('fastpath', `Not GPU-residency eligible — ${blockers[0].text}. The model still runs on the GPU, one generation per dispatch instead of a whole frame in one submit, so each generation pays a CPU↔GPU round-trip. ${PRINCIPLE_FASTPATH} At small populations the CPU engines are often faster.`));
    } else {
      gpuNotes.push(R('fastpath', 'GPU-residency eligible — a whole frame of generations runs in ONE submit with no CPU touch point between them (the fastest path at large populations).'));
    }
  }
  const webgpu: EngineVerdict = {
    engine: 'webgpu', ok: webgpuSupported, blockers: gpuBlockers, notes: gpuNotes,
  };

  const verdicts = [wasm, webgpu, js];
  const byId: Record<EngineId, EngineVerdict> = { js, wasm, webgpu };
  const demotionReason = res.resolved !== res.requested ? byId[res.requested].blockers[0] : undefined;

  return {
    layer: 'agents', label: 'Agents',
    selected: res.selected, requested: res.requested, resolved: res.resolved,
    demotionReason,
    contractViolation: res.contractViolation ? R('reproducibility', res.contractViolation) : undefined,
    verdicts,
  };
}

/** The residency facts this module can derive from the MODEL alone. Mirrors what
 *  SimulatorView computes for the compile path (`agentUsesField`) and what the
 *  WebGPU agent compiler reports (`usesStructural` / `usesRadiusWrite` /
 *  `usesSpawn` / `usesStop` / `usesIndicators`) — detected here from the node
 *  types that SET those compiler flags, so the readout needs no compile pass.
 *
 *  It is deliberately CONSERVATIVE: it can only ever report MORE blockers than
 *  the compiler would, never fewer, so the note can understate the fast path but
 *  never promise one the engine will not take. */
function residencyFactsFromModel(model: CAModel): ResidencyGraphFacts {
  const FIELD = new Set(['sampleField', 'fieldGradient', 'readCellsUnder', 'affectCellsUnder', 'secreteToField']);
  const STRUCTURAL = new Set(['divideAgent', 'formBond', 'breakBond', 'rewireBond', 'transferBond', 'killAgent']);
  const RADIUS_WRITE = new Set(['setAgentRadius', 'setTargetRadius']);
  const INDICATORS = new Set(['getIndicator', 'setIndicator', 'updateIndicator']);
  let structural = false, radiusWrite = false;
  let usesSpawn = false, usesStop = false, usesIndicators = false, usesSpriteWrite = false;
  // BEHAVIOUR-scoped, exactly like the compiler flags these mirror: an Init-Event
  // spawn / a Division-Event write is CPU-compiled on every engine and does NOT
  // block residency (Particle Life spawns its whole population in Init and IS
  // resident).
  walkAgentBehaviourNodes(model, (t) => {
    if (STRUCTURAL.has(t)) structural = true;
    if (RADIUS_WRITE.has(t)) radiusWrite = true;
    if (t === 'createAgent' || t === 'addAgentToWorld') usesSpawn = true;
    if (t === 'stopEvent') usesStop = true;
    if (INDICATORS.has(t)) usesIndicators = true;
    // Mirrors the WebGPU compiler's `usesSpriteWrite`: the engine ticks sprite
    // frames on the CPU once per generation, so a sprite-writing behaviour cannot
    // run a whole batch in one submit. (Conservative: the compiler flag is set only
    // when a facet actually WRITES a sprite run, this fires on the node alone.)
    if (t === 'setAgentSprite') usesSpriteWrite = true;
  });
  // The FIELD bridge is whole-graph: the worker's `agentUsesField` scans the
  // entire agent graph (any field node forces the per-generation CPU↔GPU field
  // round-trip regardless of which root reaches it).
  let usesField = false;
  walkNodes(model.agentGraphNodes, model, (t) => { if (FIELD.has(t)) usesField = true; });
  const hasStopMessages = usesStop || (() => {
    let cellStop = false;
    walkNodes(model.graphNodes, model, (t) => { if (t === 'stopEvent') cellStop = true; });
    return cellStop;
  })();
  return {
    residencyClean: !structural && !radiusWrite,
    usesField,
    hasAgentAccessibleField: cellFieldAttrsOf(model).length > 0,
    usesSpawn, usesStop, usesIndicators, usesSpriteWrite, hasStopMessages,
    bondSlots: resolveMaxBonds(model.centerBased),
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Per-layer × per-engine compatibility verdicts for a model, computed from the
 *  REAL gates. Pure — safe to call from a `useMemo` (it flattens the agent graph
 *  twice via the two agent gates, so memoise on `model`). */
export function diagnoseTargets(model: CAModel): TargetDiagnosis {
  const layers: LayerDiagnosis[] = [];
  if (model.topologyMode?.gridCells !== false) layers.push(diagnoseGrid(model));
  if (model.topologyMode?.agents) layers.push(diagnoseAgents(model));
  return { layers, contract: reproducibilityOf(model) };
}
