/** Rule Trace — the write-recording SANDBOX the trace build runs inside.
 *
 * The trace build (`compileGraph(…, { trace: true })`) is an ordinary compiled
 * JS function: it reads the live engine buffers and it WRITES to them. Running it
 * against the real arrays would apply a generation the engine has not taken yet —
 * so every argument is wrapped BY KIND before the call (impact map §4):
 *
 * | arg kind          | wrapper                                                  |
 * |-------------------|----------------------------------------------------------|
 * | typed array/Array | shadow proxy — a read sees a write made in THIS trace (the
 * |                   | async `r === w` alias, `fromWriteBuffer` reads), every other
 * |                   | index reads live state, and nothing lands on the base array |
 * | plain object      | shallow copy + one level of array copies                   |
 * | function          | recording stub (Create Agent must not spawn)               |
 * | primitive         | pass-through                                               |
 *
 * INVARIANT I2 — the real buffers are byte-identical around a trace. The harness
 * hashes them before and after; the only way a write can escape is a method that
 * hands out a VIEW, so `.subarray` / `.slice` on a wrapped argument throw
 * `TraceSandboxEscape` rather than silently leaking (a guard for a FUTURE node
 * emitter — no shipped emitter calls either on a parameter).
 *
 * DOM-free on purpose: the worker imports it, and so does the Node harness
 * (`scripts/test-rule-trace.mjs`). No `self`, no `postMessage`, no DOM types.
 */

// ---------------------------------------------------------------------------
// The event log
// ---------------------------------------------------------------------------

/** A bounded copy of an array value. `len` is the TRUE length — `arr` may be
 *  shorter (see `TRACE_MAX_ARRAY`), because `_scr_<id>` / `_v<id>_vals` can be a
 *  whole neighbourhood and a record must stay cheap to ship. */
export interface TraceArrayValue { arr: number[]; len: number }

export type TraceValue = number | boolean | string | TraceArrayValue | undefined;

export type TraceEvent =
  /** a value node's output port produced `value` */
  | ['v', string, string, TraceValue]
  /** this flow node ran */
  | ['f', string]
  /** this flow OUTPUT port was taken */
  | ['o', string, string]
  /** a stubbed host function was called (`Create Agent`, `Add Agent To World`) */
  | ['q', string, TraceValue[]];

/** What the emitted trace code calls. The compiler emits `_tr.v/.f/.o` only. */
export interface TraceRecorder {
  v(nodeId: string, portId: string, value: unknown): void;
  f(nodeId: string): void;
  o(nodeId: string, portId: string): void;
}

/** One index a traced element WOULD have written, and what was there before. */
export interface TraceWrite {
  /** The emitted parameter name (`w_alive`, `_agentForceX`, `colors`, …). */
  param: string;
  index: number;
  value: number;
  /** The live value at that index — so the UI can show `3 → 5`. */
  prev: number;
}

export interface TraceResult {
  events: TraceEvent[];
  writes: TraceWrite[];
  /** The event cap was hit; `events` is a PREFIX of what the element did. */
  truncated: boolean;
  /** The traced function threw. The sandbox never rethrows into the caller
   *  (except `TraceSandboxEscape`, which is a programming error). */
  error?: string;
}

/** Thrown when emitted code reaches for a method that would hand it a live VIEW
 *  of a wrapped buffer. Not a user-facing condition — it means a node emitter
 *  started calling `.subarray` / `.slice` on a parameter and the sandbox must be
 *  taught how to wrap it. */
export class TraceSandboxEscape extends Error {
  constructor(param: string, method: string) {
    super(`Rule Trace sandbox escape: the traced code called .${method}() on "${param}". `
      + 'That would hand out a live view of an engine buffer — teach traceRunner.ts to wrap it.');
    this.name = 'TraceSandboxEscape';
  }
}

export const TRACE_MAX_EVENTS = 5000;
/** Elements of an array value copied into a record (plus the true length). */
export const TRACE_MAX_ARRAY = 64;

// ---------------------------------------------------------------------------
// Value encoding
// ---------------------------------------------------------------------------

function isArrayLike(v: unknown): v is ArrayLike<number> {
  if (Array.isArray(v) || ArrayBuffer.isView(v as ArrayBufferView)) return true;
  // A wrapped argument is a PROXY, and `ArrayBuffer.isView` answers false for one
  // (it tests an internal slot the proxy does not have). Fall back to the duck
  // test, or a record whose value IS a wrapped buffer would encode as `undefined`.
  if (typeof v !== 'object' || v === null) return false;
  const len = (v as { length?: unknown }).length;
  return typeof len === 'number' && Number.isInteger(len) && len >= 0;
}

/** Copy a recorded value into something safe to keep and to ship. Arrays are
 *  copied EAGERLY and BOUNDED: `_scr_<id>` is reused scratch, so holding the
 *  reference would make every record of that node show the final contents. */
export function encodeTraceValue(v: unknown): TraceValue {
  if (v === undefined || v === null) return undefined;
  const t = typeof v;
  if (t === 'number' || t === 'boolean' || t === 'string') return v as TraceValue;
  if (isArrayLike(v)) {
    const len = v.length;
    const n = Math.min(len, TRACE_MAX_ARRAY);
    const arr: number[] = new Array(n);
    for (let i = 0; i < n; i++) arr[i] = Number(v[i]);
    return { arr, len };
  }
  return undefined;   // an object with no numeric shape carries nothing useful
}

// ---------------------------------------------------------------------------
// Argument wrapping
// ---------------------------------------------------------------------------

/** Bulk writers: harmless to ignore (the trace drops the bulk `w.set(r)` copy
 *  anyway) but catastrophic to let through — `w_x.set(r_x)` on a real buffer
 *  would rewrite the whole grid. */
const NOOP_METHODS = new Set(['set', 'fill', 'copyWithin', 'sort', 'reverse']);
/** View producers — see TraceSandboxEscape. */
const ESCAPE_METHODS = new Set(['subarray', 'slice']);

interface ShadowEntry { param: string; base: ArrayLike<number>; shadow: Map<number, number> }

function wrapArray(base: ArrayLike<number>, param: string, shadows: ShadowEntry[]): unknown {
  const shadow = new Map<number, number>();
  shadows.push({ param, base, shadow });
  const noop = () => undefined;
  let proxy: ArrayLike<number>;
  proxy = new Proxy(base as object, {
    get(target, prop, recv) {
      if (typeof prop === 'string') {
        // Numeric index: the write made in THIS trace wins, else live state.
        const n = +prop;
        if (Number.isInteger(n) && n >= 0) {
          const s = shadow.get(n);
          return s !== undefined ? s : (target as unknown as ArrayLike<number>)[n];
        }
        if (prop === 'length') return (target as unknown as ArrayLike<number>).length;
        if (NOOP_METHODS.has(prop)) return noop;
        if (ESCAPE_METHODS.has(prop)) return () => { throw new TraceSandboxEscape(param, prop); };
      }
      if (prop === Symbol.iterator) {
        // `for..of` must see the SHADOW values, so iterate through this proxy's
        // own numeric get rather than the base array's iterator.
        return function* iter() {
          const len = (target as unknown as ArrayLike<number>).length;
          for (let i = 0; i < len; i++) yield proxy[i];
        };
      }
      const val = Reflect.get(target, prop, recv);
      return typeof val === 'function' ? (val as (...a: unknown[]) => unknown).bind(target) : val;
    },
    set(_target, prop, value) {
      if (typeof prop === 'string') {
        const n = +prop;
        if (Number.isInteger(n) && n >= 0) { shadow.set(n, Number(value)); return true; }
      }
      return true;   // swallow anything else (a `.length = 0` on a plain Array)
    },
  }) as ArrayLike<number>;
  return proxy;
}

/** Shallow copy + one level of array copies — the shape of `modelAttrs`,
 *  `_linkedResults`, `_lookupTables`, `cachedInteractionTables`. Read-mostly, but
 *  an indicator/linked write must not reach the engine's object. */
function wrapObject(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (Array.isArray(v)) out[k] = v.slice();
    else if (ArrayBuffer.isView(v as ArrayBufferView)) {
      const tv = v as unknown as { slice: () => unknown };
      out[k] = typeof tv.slice === 'function' ? tv.slice() : v;
    } else out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// runTrace
// ---------------------------------------------------------------------------

export interface RunTraceOptions {
  /** The eval'd trace function for one root. */
  fn: (...args: unknown[]) => unknown;
  /** The engine's own arg list for that root (`buildLoopArgs()` & co), WITHOUT
   *  the trailing trace args — those are appended here. */
  args: unknown[];
  /** The emitted function's full parameter list (`CompileResult.trace.paramNames`),
   *  including the trailing `_traceIdx` / `_tr`. Used to name writes and to find
   *  `_rngState`. */
  paramNames: string[];
  /** The cell / agent being traced. Omitted for a GLOBAL root (grid init, a
   *  periodic event, agent init) — those take no element index. */
  elementIdx?: number;
  /** The generation the trace is taken at — half of the RNG seed, so re-tracing
   *  the same element at the same generation gives the same draws (D1). */
  generation?: number;
  maxEvents?: number;
  /** ALIAS BY IDENTITY (default true): the SAME array object passed under two
   *  parameter names (`r_x` and `w_x` in asynchronous cell mode, `attrRead` and
   *  `attrWrite` in the default async agent mode) gets ONE shadow, so a self-read
   *  after a self-write sees the write — exactly the single-buffer semantics the
   *  engine has there. Two independent shadows for one buffer would de-alias
   *  what the model deliberately aliases (the Snake's read-after-write turn).
   *
   *  Set it FALSE only where the CPU aliases what the engine does NOT: the
   *  WebGPU grid target that dropped its separate sync WRITE buffer for memory
   *  (`attrWriteAliased`) — there the GPU still has two buffers, so the trace
   *  must keep reads pre-state and writes shadowed apart. */
  sharedProxies?: boolean;
}

/** Deterministic per-(element, generation) RNG seed. The engine's shared stream
 *  cannot be used: reading it is fine, but the trace must not ADVANCE it, and a
 *  re-trace of the same element must produce the same draws. */
export function traceRngSeed(elementIdx: number, generation: number): number {
  const a = Math.imul(elementIdx + 1, 0x9e3779b1) >>> 0;
  const b = Math.imul(generation + 1, 0x85ebca6b) >>> 0;
  const s = (a ^ b) >>> 0;
  return s === 0 ? 0x12345678 : s;
}

export function runTrace(o: RunTraceOptions): TraceResult {
  const maxEvents = o.maxEvents ?? TRACE_MAX_EVENTS;
  const events: TraceEvent[] = [];
  let truncated = false;

  const push = (e: TraceEvent): void => {
    if (events.length >= maxEvents) { truncated = true; return; }
    events.push(e);
  };

  const recorder: TraceRecorder = {
    v(nodeId, portId, value) { push(['v', nodeId, portId, encodeTraceValue(value)]); },
    f(nodeId) { push(['f', nodeId]); },
    o(nodeId, portId) { push(['o', nodeId, portId]); },
  };

  const shadows: ShadowEntry[] = [];
  const elementIdx = o.elementIdx ?? 0;
  const generation = o.generation ?? 0;
  const shared = o.sharedProxies !== false;
  /** base array → its proxy, so an aliased buffer is wrapped ONCE (see
   *  `sharedProxies`). The first parameter name to reach a buffer names it. */
  const proxyByBase = new Map<object, unknown>();

  const wrapped: unknown[] = o.args.map((arg, i) => {
    const name = o.paramNames[i] ?? `arg${i}`;
    // The RNG cell is REPLACED, not wrapped: the trace draws from a private
    // stream seeded from (element, generation) so it neither advances the
    // engine's stream nor changes answer between two traces of the same state.
    if (name === '_rngState') return new Uint32Array([traceRngSeed(elementIdx, generation)]);
    if (arg === null || arg === undefined) return arg;
    const t = typeof arg;
    if (t === 'number' || t === 'string' || t === 'boolean') return arg;
    if (t === 'function') {
      // Create Agent returns a HANDLE; -1 is its documented "no slot" answer, so
      // a traced spawn configures nothing and nothing downstream misreads it.
      const isCreate = name === '_agentCreate';
      return (...a: unknown[]) => {
        push(['q', name, a.map(encodeTraceValue)]);
        return isCreate ? -1 : undefined;
      };
    }
    if (isArrayLike(arg)) {
      if (shared) {
        const existing = proxyByBase.get(arg as object);
        if (existing !== undefined) return existing;
        const p = wrapArray(arg as ArrayLike<number>, name, shadows);
        proxyByBase.set(arg as object, p);
        return p;
      }
      return wrapArray(arg as ArrayLike<number>, name, shadows);
    }
    return wrapObject(arg as Record<string, unknown>);
  });

  // The trailing trace args, in the order the emit declares them. A root with no
  // element (`gridInit`, a periodic event) declares only `_tr`.
  //
  // The engine deliberately passes MORE args than some roots declare — `_generation`
  // is pushed unconditionally while its parameter is gated (`params <= args` is the
  // safe direction, sim.worker.ts). For a normal call an extra trailing arg is
  // ignored; here it would SHIFT `_traceIdx` / `_tr` past the declared slots and the
  // body would call `_tr.v` on a number. So the wrapped list is cut (or padded) to
  // exactly the declared parameter count before the trace args are appended.
  const trailing = o.paramNames[o.paramNames.length - 2] === '_traceIdx' ? 2 : 1;
  const declared = Math.max(0, o.paramNames.length - trailing);
  wrapped.length = declared;                          // drop extras / pad with holes
  for (let i = 0; i < declared; i++) if (!(i in wrapped)) wrapped[i] = undefined;
  if (trailing === 2) wrapped.push(elementIdx);
  wrapped.push(recorder);

  let error: string | undefined;
  try {
    o.fn(...wrapped);
  } catch (e) {
    if (e instanceof TraceSandboxEscape) throw e;   // a compiler bug, not a run
    error = e instanceof Error ? e.message : String(e);
  }

  const writes: TraceWrite[] = [];
  for (const s of shadows) {
    for (const [index, value] of s.shadow) {
      writes.push({ param: s.param, index, value, prev: Number(s.base[index]) });
    }
  }

  return { events, writes, truncated, ...(error !== undefined ? { error } : {}) };
}
