/** Rule Trace — the WORKER PROTOCOL (P2): the message shapes, the root keys, and
 *  the one helper that turns a TRACE BUILD's compile results into the payload.
 *
 *  DOM-free and dependency-free at RUNTIME (every `compile.ts` import is
 *  `import type`, erased at build) so the worker, the main thread and a Node
 *  harness can all import it. It exists so the two sides of the protocol are ONE
 *  declaration rather than two mirrored guesses — the `agentAbi.ts` discipline,
 *  applied to a message instead of an ABI.
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
 *  `compile.ts` writes into `traceParamNames` — the helpers below are the only
 *  place either side spells them. */
export type TraceRootKey = string;

export const TRACE_ROOT_STEP = 'step';
export const TRACE_ROOT_INIT = 'init';
export const TRACE_ROOT_GRID_INIT = 'gridInit';
export const TRACE_ROOT_AGENT_BEHAVIOUR = 'agentBehaviour';
export const TRACE_ROOT_AGENT_INIT = 'agentInit';
export const TRACE_ROOT_AGENT_DIVISION = 'agentDivision';

export const traceGridPeriodicKey = (nodeId: string): TraceRootKey => `gridPeriodic:${nodeId}`;
export const traceInputColorKey = (mappingId: string): TraceRootKey => `inputColor:${mappingId}`;
export const traceOutputMappingKey = (mappingId: string): TraceRootKey => `outputMapping:${mappingId}`;
export const traceAgentPeriodicKey = (nodeId: string): TraceRootKey => `agentPeriodic:${nodeId}`;
export const traceAgentOutputMappingKey = (mappingId: string): TraceRootKey => `agentOutputMapping:${mappingId}`;
export const traceAgentInputMappingKey = (mappingId: string): TraceRootKey => `agentInputMapping:${mappingId}`;

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
    const gpKeys = keysWithPrefix(paramNames, 'gridPeriodic:');
    const cell: TraceCellCodes = { paramNames };
    if (cellRes.stepCode) cell.stepCode = cellRes.stepCode;
    if (cellRes.initCode) cell.initCode = cellRes.initCode;
    if (cellRes.gridInitCode) cell.gridInitCode = cellRes.gridInitCode;
    if (cellRes.gridPeriodicCodes?.length) {
      cell.gridPeriodicCodes = cellRes.gridPeriodicCodes.map((p, i) => ({
        rootKey: gpKeys[i] ?? `gridPeriodic:#${i}`,
        period: p.period, phase: p.phase, code: p.code,
      }));
    }
    if (cellRes.inputColorCodes?.length) cell.inputColorCodes = cellRes.inputColorCodes.map(c => ({ mappingId: c.mappingId, code: c.code }));
    if (cellRes.outputMappingCodes?.length) cell.outputMappingCodes = cellRes.outputMappingCodes.map(c => ({ mappingId: c.mappingId, code: c.code }));
    out.cell = cell;
  }

  if (agentRes?.trace) {
    const paramNames = agentRes.trace.paramNames;
    const apKeys = keysWithPrefix(paramNames, 'agentPeriodic:');
    const agent: TraceAgentCodes = { paramNames };
    if (agentRes.behaviourCode) agent.behaviourCode = agentRes.behaviourCode;
    if (agentRes.initCode) agent.initCode = agentRes.initCode;
    if (agentRes.divisionCode) agent.divisionCode = agentRes.divisionCode;
    if (agentRes.periodicCodes?.length) {
      agent.periodicCodes = agentRes.periodicCodes.map((p, i) => ({
        rootKey: apKeys[i] ?? `agentPeriodic:#${i}`,
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

/** Trace the current state NOW (the simulation is paused, or the user asked). */
export interface RequestTraceMsg { type: 'requestTrace' }

/** Drop the target, the fns, the breakpoints — the whole session. */
export interface ClearTraceMsg { type: 'clearTrace' }

// ---------------------------------------------------------------------------
// worker → main thread
// ---------------------------------------------------------------------------

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
  /** The trace CANNOT be an exact prediction of this element's next state —
   *  see `traceApproximateReason` in the worker for the exact terms (async
   *  updates, RNG, indicator accumulation, a stale neighbour hash, a field the
   *  agents deposit into after the trace was taken). */
  approximate: boolean;
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

export type TraceWorkerMsg = SetTraceMsg | RequestTraceMsg | ClearTraceMsg;
export type TraceReply = TraceReplyMsg | TraceBreakMsg | TraceTargetLostMsg | TraceCompileErrorsMsg;
