/** Rule Trace — the ORIGIN table (lowered node id → the USER node it stands for).
 *
 * The trace build records values and flow by the node ids the COMPILER sees, and
 * those are the ids AFTER the lowering chain (macro expansion, composite /
 * vector / multi-attr / census / periodic / density / force-broadcast lowering,
 * the synthesized linked colour passes). The graph editor only knows the ids the
 * USER placed, so every record has to be translatable back.
 *
 * **No id is ever renamed to make this work** (impact map §3): a rename changes
 * emitted text on every target and can flip accessor-CSE's "lexicographically
 * smallest id" canonical pick. Instead each lowering pass returns an ADDITIVE
 * `origin` map, and `compileGraph` / `compileAgentGraph` fold those maps in pass
 * order into one table. Folding TRANSLATES as it goes: a pass that synthesizes a
 * node from a node an EARLIER pass synthesized lands on the user node, not on the
 * intermediate.
 *
 * A lowered id that is absent from the table and is not a user node id is a
 * HARNESS FAILURE (`scripts/test-rule-trace.mjs`), never a silently dark node.
 */

/** Which component of a composite (vector / colour) port a lowered scalar node
 *  stands for. The UI reassembles `(x, y, z)` / `(r, g, b, a)` for the user's
 *  port from the per-component records. */
export type TraceComponent = 'x' | 'y' | 'z' | 'w' | 'r' | 'g' | 'b' | 'a';

export interface TraceOrigin {
  /** The id this lowered node stands for. A USER node id (top-level graph), an
   *  id INSIDE a macro def when `macroPath` is set, or the `linked:<mappingId>`
   *  sentinel for a synthesized colour pass (which has no user node at all). */
  nodeId: string;
  /** The user node's PORT this lowered node produces, when known. */
  portId?: string;
  /** The component of that port, for composite lowerings. */
  component?: TraceComponent;
  /** Macro instance ids from the outermost inwards. Empty / absent ⇒ `nodeId`
   *  lives in the top-level graph. */
  macroPath?: string[];
}

/** The folded table handed to the worker + the UI (a plain object so it survives
 *  `postMessage` structured clone unchanged). */
export type TraceOriginTable = Record<string, TraceOrigin>;

/** What a lowering pass returns. A `Map` (not a plain object) because passes
 *  build it incrementally and a Map keeps insertion order for the fold. */
export type TraceOriginMap = Map<string, TraceOrigin>;

/** The sentinel `nodeId` for a node synthesized by the linked-output-mapping
 *  injectors: those colour passes exist only in the compiled graph — there is no
 *  user node to light up, the MAPPING is the origin. */
export const linkedOriginId = (mappingId: string): string => `linked:${mappingId}`;

/** Is this origin's `nodeId` the linked-mapping sentinel rather than a node? */
export function isLinkedOrigin(o: TraceOrigin | undefined): boolean {
  return !!o && o.nodeId.startsWith('linked:');
}

/** Merge two origins, the OUTER (the one being resolved through) supplying what
 *  the inner one leaves unset. The inner origin's `portId` / `component` win:
 *  they describe the more specific thing (which component of which port). */
function mergeOrigin(inner: TraceOrigin, outer: TraceOrigin): TraceOrigin {
  const macroPath = [...(outer.macroPath ?? []), ...(inner.macroPath ?? [])];
  const out: TraceOrigin = { nodeId: outer.nodeId };
  const portId = inner.portId ?? outer.portId;
  const component = inner.component ?? outer.component;
  if (portId !== undefined) out.portId = portId;
  if (component !== undefined) out.component = component;
  if (macroPath.length > 0) out.macroPath = macroPath;
  return out;
}

/** Walk `id` through the table until it lands on something the table does not
 *  translate further (a user node, an in-macro node, or the linked sentinel).
 *  A USER id — one with no entry — resolves to ITSELF, so callers never have to
 *  special-case "this record was already a user node". Cycle-guarded. */
export function resolveTraceOrigin(loweredId: string, table: TraceOriginTable): TraceOrigin {
  let cur: TraceOrigin = { nodeId: loweredId };
  const seen = new Set<string>([loweredId]);
  for (let hops = 0; hops < 64; hops++) {
    const next = table[cur.nodeId];
    if (!next) return cur;
    if (seen.has(next.nodeId)) return cur;   // cycle — stop where we are
    seen.add(next.nodeId);
    cur = mergeOrigin(cur, next);
  }
  return cur;
}

/** Fold one pass's map into the accumulating table, translating each entry's
 *  `nodeId` through what is already there (so a pass building on an earlier
 *  pass's synthetic node records the USER node). Insertion-ordered, so a pass
 *  that synthesizes from its OWN earlier synthetic node composes too. */
export function foldOriginMap(table: TraceOriginTable, pass: TraceOriginMap | undefined): void {
  if (!pass) return;
  for (const [id, origin] of pass) {
    const base = table[origin.nodeId];
    table[id] = base ? mergeOrigin(origin, resolveTraceOrigin(origin.nodeId, table)) : { ...origin };
  }
}

// ---------------------------------------------------------------------------
// The trace build's compile options + result metadata
// ---------------------------------------------------------------------------

/** The additive option bag on `compileGraph` / `compileAgentGraph`. ABSENT ⇒ the
 *  normal build, byte-identical to the pre-trace compiler (invariant I1). */
export interface CompileOptions {
  /** Emit the TRACE build: per-node value records, per-flow-node execution
   *  records, a SINGLE-element body, accessor-CSE + aggregate fusion off. */
  trace?: boolean;
}

/** Every root the trace build emits. The worker keys its `traceFns` registry by
 *  these strings; `<id>` suffixes are the root node / mapping id. */
export type TraceRootKey = string;

// ---------------------------------------------------------------------------
// THE ROOT KEYS — one definition, three readers
// ---------------------------------------------------------------------------

/** The root keys live HERE, next to the compile-options type, because the
 *  COMPILER is what writes them (into `TraceCompileMeta.paramNames`) and the
 *  worker + the protocol only read them back. `traceProtocol.ts` re-exports all
 *  of it, so the engine side keeps importing from the protocol as before.
 *
 *  They were spelled by hand in three places until P7b (review finding F9):
 *  `compile.ts` built `` `gridPeriodic:${id}` `` inline, `traceProtocol.ts`
 *  filtered on the literal `'gridPeriodic:'`, and the same pair existed for
 *  `agentPeriodic` / the four mapping kinds. A key and its own prefix filter
 *  drifting apart is silent: the periodic root simply never pairs with its code
 *  and the trace for that root goes missing with no error anywhere. */
export const TRACE_ROOT_STEP = 'step';
export const TRACE_ROOT_INIT = 'init';
export const TRACE_ROOT_GRID_INIT = 'gridInit';
export const TRACE_ROOT_AGENT_BEHAVIOUR = 'agentBehaviour';
export const TRACE_ROOT_AGENT_INIT = 'agentInit';
export const TRACE_ROOT_AGENT_DIVISION = 'agentDivision';

/** The prefixes of the keyed roots — `<prefix>:<id>`. The BUILDERS below and the
 *  protocol's `keysWithPrefix` filter both read these, so a key can never be
 *  built under one spelling and looked up under another. */
export const TRACE_PREFIX_GRID_PERIODIC = 'gridPeriodic:';
export const TRACE_PREFIX_INPUT_COLOR = 'inputColor:';
export const TRACE_PREFIX_OUTPUT_MAPPING = 'outputMapping:';
export const TRACE_PREFIX_AGENT_PERIODIC = 'agentPeriodic:';
export const TRACE_PREFIX_AGENT_OUTPUT_MAPPING = 'agentOutputMapping:';
export const TRACE_PREFIX_AGENT_INPUT_MAPPING = 'agentInputMapping:';

export const traceGridPeriodicKey = (nodeId: string): TraceRootKey => TRACE_PREFIX_GRID_PERIODIC + nodeId;
export const traceInputColorKey = (mappingId: string): TraceRootKey => TRACE_PREFIX_INPUT_COLOR + mappingId;
export const traceOutputMappingKey = (mappingId: string): TraceRootKey => TRACE_PREFIX_OUTPUT_MAPPING + mappingId;
export const traceAgentPeriodicKey = (nodeId: string): TraceRootKey => TRACE_PREFIX_AGENT_PERIODIC + nodeId;
export const traceAgentOutputMappingKey = (mappingId: string): TraceRootKey => TRACE_PREFIX_AGENT_OUTPUT_MAPPING + mappingId;
export const traceAgentInputMappingKey = (mappingId: string): TraceRootKey => TRACE_PREFIX_AGENT_INPUT_MAPPING + mappingId;

export interface TraceCompileMeta {
  /** Root key → the emitted function's FULL parameter list, in order (including
   *  the appended `_traceIdx` / `_tr`). The runner names its sandbox wrappers
   *  from this — it is the only way it can tell `_rngState` from a cell attr. */
  paramNames: Record<TraceRootKey, string[]>;
  /** Lowered id → user node (see the module header). */
  origin: TraceOriginTable;
}
