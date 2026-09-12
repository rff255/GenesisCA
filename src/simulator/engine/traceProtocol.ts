/** Rule Trace — the WORKER PROTOCOL (P2): the message shapes, the root keys, and
 *  the one helper that turns a TRACE BUILD's compile results into the payload.
 *
 *  DOM-free, and free of the COMPILER at runtime: every `compile.ts` import is
 *  `import type`, erased at build. Its one runtime import is the compiler's
 *  `traceOrigin.ts`, for the root keys alone — a side-effect-free module whose
 *  other exports tree-shake away, so the worker bundle still carries nothing but
 *  the key strings it always did (P7b / F9: those keys had been spelled once
 *  here and once in the compiler, and a key built under one spelling and
 *  filtered under another fails SILENTLY). The worker, the main thread and a
 *  Node harness can all import this module. It exists so the two sides of the
 *  protocol are ONE declaration rather than two mirrored guesses — the
 *  `agentAbi.ts` discipline, applied to a message instead of an ABI.
 *
 *  WHO OWNS WHAT
 *   - The MAIN THREAD compiles the graph twice while a trace target exists: the
 *     normal build (the engines) and `compileGraph(…, { trace: true })` (the
 *     trace). It ships the trace build's code + `trace.paramNames` here, and
 *     KEEPS `trace.origin` (the lowered-id → user-node table) for itself: the
 *     worker never needs it, because breakpoints arrive ALREADY LOWERED.
 *   - The WORKER evals the codes, runs them in the `traceRunner` sandbox against
 *     the live state, and posts an event log back. It holds no presentation
 *     state (impact map D3).
 */

import type { CompileResult, AgentCompileResult } from '../../modeler/vpl/compiler/compile';

// ---------------------------------------------------------------------------
// Root keys — the strings `CompileResult.trace.paramNames` is keyed by
// ---------------------------------------------------------------------------

/** The trace registry's key for one emitted root. MUST match the keys
 *  `compile.ts` writes into `traceParamNames`, so since P7b (review finding F9)
 *  there is exactly ONE definition of them — in the COMPILER's `traceOrigin.ts`,
 *  because the compiler is the side that WRITES them — and this module simply
 *  re-exports it. Every existing engine-side import keeps working unchanged.
 *
 *  `traceOrigin.ts` is side-effect-free ESM whose other exports (the origin
 *  resolver) the worker never references, so this costs the worker bundle only
 *  the key strings it already carried. */
export {
  TRACE_ROOT_STEP, TRACE_ROOT_INIT, TRACE_ROOT_GRID_INIT,
  TRACE_ROOT_AGENT_BEHAVIOUR, TRACE_ROOT_AGENT_INIT, TRACE_ROOT_AGENT_DIVISION,
  TRACE_PREFIX_GRID_PERIODIC, TRACE_PREFIX_INPUT_COLOR, TRACE_PREFIX_OUTPUT_MAPPING,
  TRACE_PREFIX_AGENT_PERIODIC, TRACE_PREFIX_AGENT_OUTPUT_MAPPING, TRACE_PREFIX_AGENT_INPUT_MAPPING,
  traceGridPeriodicKey, traceInputColorKey, traceOutputMappingKey,
  traceAgentPeriodicKey, traceAgentOutputMappingKey, traceAgentInputMappingKey,
} from '../../modeler/vpl/compiler/traceOrigin';
export type { TraceRootKey } from '../../modeler/vpl/compiler/traceOrigin';

import {
  TRACE_PREFIX_GRID_PERIODIC, TRACE_PREFIX_AGENT_PERIODIC,
  type TraceRootKey,
} from '../../modeler/vpl/compiler/traceOrigin';

// ---------------------------------------------------------------------------
// The target
// ---------------------------------------------------------------------------

/** ONE element per graph kind (impact map §0): a cell target drives the cell
 *  graph's roots, an agent target the agent graph's. A grid+agents model can
 *  carry one of each. */
export type TraceTarget =
  | { kind: 'cell'; idx: number }
  | { kind: 'agent'; id: number };

// ---------------------------------------------------------------------------
// The codes payload
// ---------------------------------------------------------------------------

/** A periodic root's trace code. `rootKey` is carried explicitly because
 *  `CompileResult.gridPeriodicCodes` does NOT record its node id — see
 *  `traceCodesFromCompile`. The worker fires it on its OWN cadence test
 *  (`generation % period === phase`), exactly like the engine's copy, so the two
 *  never need to be index-paired. */
export interface TracePeriodicCode {
  rootKey: TraceRootKey;
  period: number;
  phase: number;
  code: string;
}

export interface TraceCellCodes {
  /** Root key → the emitted fn's FULL parameter list (`CompileResult.trace.paramNames`). */
  paramNames: Record<TraceRootKey, string[]>;
  stepCode?: string;
  initCode?: string;
  gridInitCode?: string;
  gridPeriodicCodes?: TracePeriodicCode[];
  inputColorCodes?: Array<{ mappingId: string; code: string }>;
  outputMappingCodes?: Array<{ mappingId: string; code: string }>;
}

export interface TraceAgentCodes {
  paramNames: Record<TraceRootKey, string[]>;
  behaviourCode?: string;
  initCode?: string;
  divisionCode?: string;
  periodicCodes?: TracePeriodicCode[];
  outputMappingCodes?: Array<{ mappingId: string; code: string }>;
  inputMappingCodes?: Array<{ mappingId: string; code: string; channels: number; spawner?: boolean }>;
}

export interface TraceCodes {
  cell?: TraceCellCodes;
  agent?: TraceAgentCodes;
}

/** Build the `setTrace` payload from the TRACE BUILD's compile results.
 *
 *  ⚠ THE ONE NON-OBVIOUS PAIRING. `CompileResult.gridPeriodicCodes` carries only
 *  `{period, phase, code}` — the compiler never puts the periodic root's NODE ID
 *  in the result (the engine has never needed it). `trace.paramNames` however is
 *  keyed `gridPeriodic:<nodeId>`. Both are produced by the SAME
 *  `graphNodes.filter(...)` loop, in the same order, so the i-th code belongs to
 *  the i-th `gridPeriodic:` key. That INDEX pairing is the only link, so it is
 *  made once, here, rather than at each call site. (Object key order is
 *  insertion order for non-numeric string keys — guaranteed by the spec.)
 */
export function traceCodesFromCompile(
  cellRes?: CompileResult | null,
  agentRes?: AgentCompileResult | null,
): TraceCodes {
  const out: TraceCodes = {};
  const keysWithPrefix = (paramNames: Record<string, string[]>, prefix: string): string[] =>
    Object.keys(paramNames).filter(k => k.startsWith(prefix));

  if (cellRes?.trace) {
    const paramNames = cellRes.trace.paramNames;
    const gpKeys = keysWithPrefix(paramNames, TRACE_PREFIX_GRID_PERIODIC);
    const cell: TraceCellCodes = { paramNames };
    if (cellRes.stepCode) cell.stepCode = cellRes.stepCode;
    if (cellRes.initCode) cell.initCode = cellRes.initCode;
    if (cellRes.gridInitCode) cell.gridInitCode = cellRes.gridInitCode;
    if (cellRes.gridPeriodicCodes?.length) {
      cell.gridPeriodicCodes = cellRes.gridPeriodicCodes.map((p, i) => ({
        rootKey: gpKeys[i] ?? `${TRACE_PREFIX_GRID_PERIODIC}#${i}`,
        period: p.period, phase: p.phase, code: p.code,
      }));
    }
    if (cellRes.inputColorCodes?.length) cell.inputColorCodes = cellRes.inputColorCodes.map(c => ({ mappingId: c.mappingId, code: c.code }));
    if (cellRes.outputMappingCodes?.length) cell.outputMappingCodes = cellRes.outputMappingCodes.map(c => ({ mappingId: c.mappingId, code: c.code }));
    out.cell = cell;
  }

  if (agentRes?.trace) {
    const paramNames = agentRes.trace.paramNames;
    const apKeys = keysWithPrefix(paramNames, TRACE_PREFIX_AGENT_PERIODIC);
    const agent: TraceAgentCodes = { paramNames };
    if (agentRes.behaviourCode) agent.behaviourCode = agentRes.behaviourCode;
    if (agentRes.initCode) agent.initCode = agentRes.initCode;
    if (agentRes.divisionCode) agent.divisionCode = agentRes.divisionCode;
    if (agentRes.periodicCodes?.length) {
      agent.periodicCodes = agentRes.periodicCodes.map((p, i) => ({
        rootKey: apKeys[i] ?? `${TRACE_PREFIX_AGENT_PERIODIC}#${i}`,
        period: p.period, phase: p.phase, code: p.code,
      }));
    }
    if (agentRes.outputMappingCodes?.length) agent.outputMappingCodes = agentRes.outputMappingCodes.map(c => ({ mappingId: c.mappingId, code: c.code }));
    if (agentRes.inputMappingCodes?.length) {
      agent.inputMappingCodes = agentRes.inputMappingCodes.map(c => ({
        mappingId: c.mappingId, code: c.code, channels: c.channels, ...(c.spawner ? { spawner: true } : {}),
      }));
    }
    out.agent = agent;
  }
  return out;
}

// ---------------------------------------------------------------------------
// main thread → worker
// ---------------------------------------------------------------------------

/** Set (or update) the trace session.
 *
 *  - `target` is the COMPLETE intent, never a delta: one target sets that kind
 *    and CLEARS the other, an array of two sets both, `null` clears both. (A
 *    single field with delta semantics would be ambiguous the moment a
 *    grid+agents model wanted to drop only one of its two targets.) Clearing the
 *    target KEEPS the compiled fns, so resuming costs no re-eval.
 *  - `codes` ABSENT ⇒ the worker keeps the fns it has (a breakpoint / cadence
 *    change costs nothing). PRESENT ⇒ every root is re-eval'd and per-root
 *    failures come back as `traceCompileErrors`.
 *  - `breakpoints` are LOWERED node ids. The main thread owns the origin table,
 *    so it resolves user ids → lowered ids before sending; the worker only ever
 *    does set membership on the ids it sees in the event log.
 */
export interface SetTraceMsg {
  type: 'setTrace';
  target: TraceTarget | TraceTarget[] | null;
  codes?: TraceCodes;
  breakpoints?: string[];
  /** Trace BEFORE every generation (and honour breakpoints). Default false =
   *  the SAMPLED cadence: one trace per batch, at the batch end. */
  everyGen?: boolean;
}

/** Trace the current state NOW (the simulation is paused, or the user asked).
 *
 *  ⚠ NO SENDER at present (P7b / review finding F12). Setting a target used to
 *  post this straight after `setTrace`, whose handler ALREADY ends in
 *  `scheduleTraceOfCurrentState()` — so every target set ran two identical
 *  traces of every root and filed two replies into the timeline ring. The
 *  redundant post is gone. The message and its handler are KEPT because they are
 *  the seam a "re-trace now" gesture needs (and the one the on-demand cadence is
 *  named after); a future sender must not re-introduce the duplicate — check
 *  whether the state-changing message it follows already schedules a trace. */
export interface RequestTraceMsg { type: 'requestTrace' }

/** Drop the target, the fns, the breakpoints — the whole session. */
export interface ClearTraceMsg { type: 'clearTrace' }

// ---------------------------------------------------------------------------
// worker → main thread
// ---------------------------------------------------------------------------

/** WHY a trace is an approximation rather than a prediction. One token per term
 *  in the worker's `traceApproximateTerm`; the panel turns it into a sentence.
 *
 *  - `asyncCells`     the cell's real turn comes after some neighbours have
 *                     already written this generation
 *  - `asyncAgents`    agent attributes are single-buffered (the engine default)
 *  - `indicators`     the rule accumulates into an indicator every OTHER element
 *                     also writes this generation
 *  - `agentField`     the agents deposit into a cell field AFTER the trace point
 *  - `staleAgentHash` a spatial-hash query against a hash built for an earlier
 *                     generation (the agents have moved since it was binned)
 *  - `rng`            the sandbox draws from its own per-(element, generation)
 *                     stream, so the draws differ from the real run's (D1)
 */
export type TraceApproximateTerm =
  | 'asyncCells' | 'asyncAgents' | 'indicators' | 'agentField' | 'staleAgentHash' | 'rng';

/** One traced root. `events` / `writes` are `traceRunner.ts`'s own types — the
 *  reply is a plain structured-clonable object (no typed arrays, no transfers:
 *  an event log is small and the copy is cheaper than the transfer bookkeeping). */
export interface TraceReplyMsg {
  type: 'trace';
  /** Monotonic per worker. The UI drops an out-of-order arrival rather than
   *  showing an older trace over a newer one. */
  seq: number;
  root: TraceRootKey;
  /** The generation the traced element was about to compute. */
  gen: number;
  target: TraceTarget;
  events: unknown[];
  writes: unknown[];
  truncated: boolean;
  /** RULE TRACE (P5) — THE ELEMENT'S CURRENT STATE, read at the trace point.
   *
   *  The event log says what the rule COMPUTED and `writes` say what it WOULD
   *  write; neither says what the element's attributes are RIGHT NOW, and the
   *  Values tab's whole shape is `current → next`. Reading it here rather than
   *  from a main-thread `getState` is not an optimisation but a correctness
   *  requirement: `getState` answers at some later time, and a trace taken
   *  before generation N must be paired with the state of generation N — the
   *  state the rule actually read.
   *
   *  Keyed by attribute id for a cell (plus `orientation` when variegated), and
   *  for an agent by attribute id plus the engine field names the agent
   *  inspector uses (`x`, `y`, `z`, `vx`, `vy`, `vz`, `radius`, `targetRadius`,
   *  `age`, `bondDegree`, `density`). Absent for a GLOBAL root (grid init, a
   *  periodic event), which has no element. */
  snapshot?: Record<string, number>;
  /** The trace CANNOT be an exact prediction of this element's next state —
   *  see `traceApproximateTerm` in the worker for the exact terms (async
   *  updates, RNG, indicator accumulation, a stale neighbour hash, a field the
   *  agents deposit into after the trace was taken). */
  approximate: boolean;
  /** WHICH term fired, when `approximate` is true (P7b / review finding F6).
   *
   *  The worker is the only side that KNOWS: two of the terms are read off the
   *  emitted TEXT (does this root draw from the RNG? does it write an indicator
   *  accumulator?) and one off the run's own state (is the spatial hash a
   *  generation old?), none of which the main thread can see. Before P7b it
   *  shipped only the boolean and the panel guessed the sentence from the MODEL —
   *  which for a synchronous, agent-free model that merely accumulates an
   *  indicator had nothing to guess from and fell back to the circular "see the
   *  badge for why". A TERM rather than a sentence: user-facing vocabulary stays
   *  on the main thread (impact map D3 — the worker holds no presentation state),
   *  and a term the panel does not recognise degrades to that same fallback
   *  instead of putting worker prose on screen.
   *
   *  Exactly ONE term: the first that fired, in "changes the answer most" order.
   *  The badge's tooltip lists them all regardless. */
  approximateReason?: TraceApproximateTerm;
  /** Set when the traced fn threw (captured by the sandbox, never rethrown). */
  error?: string;
}

/** A breakpoint hit. Posted AFTER the batch's own `stepped`, so the main thread
 *  sees an ordinary completed batch and then the pause reason (invariant I4). */
export interface TraceBreakMsg {
  type: 'traceBreak';
  root: TraceRootKey;
  /** The generation that was NOT run. */
  gen: number;
  /** The LOWERED id that matched — the main thread resolves it for display. */
  nodeId: string;
}

/** The traced element no longer exists (the agent died, the grid shrank). The
 *  worker clears the target and keeps the fns. */
export interface TraceTargetLostMsg {
  type: 'traceTargetLost';
  /** WHICH target was dropped. `'both'` only for a sandbox breach, which ends
   *  the whole session. Explicit, so the main thread never has to infer the
   *  kind from the prose `reason`. */
  kind: 'cell' | 'agent' | 'both';
  reason: string;
}

/** Per-root eval failures from a `setTrace` carrying codes. A trace build that
 *  fails to eval is a COMPILER bug, so it is surfaced rather than swallowed. */
export interface TraceCompileErrorsMsg {
  type: 'traceCompileErrors';
  errors: Array<{ root: TraceRootKey; message: string }>;
}

// (P7b / review finding F9: the `TraceWorkerMsg` / `TraceReply` umbrella unions
// were exported but never referenced — every consumer names the ONE message it
// handles. Removed rather than kept as decoration; a union nobody narrows is a
// second place to forget a new message kind.)
