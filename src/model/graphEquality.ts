/**
 * Structural equality for the plain-data graph shapes the reducer stores
 * (graph nodes / edges / macro defs): arrays, plain objects, primitives.
 *
 * WHY THIS EXISTS — the mount-time write-back must not dirty the model. The
 * GraphEditor syncs its canvas back to the model through SET_GRAPH /
 * SET_AGENT_GRAPH / SET_OVERSEER_GRAPH / UPDATE_MACRO, and one of the things
 * that triggers a sync is a React Flow `dimensions` change — which React Flow
 * emits for EVERY node when it first measures them after the editor mounts.
 * So merely opening the Modeler used to dispatch a graph write whose payload
 * was byte-for-byte the model's own graph, and the reducer flipped `isDirty`
 * (and SimulatorView soft-recompiled) for nothing. The reducer now treats a
 * graph write that deep-equals what it already holds as a NO-OP (it returns
 * the same state reference), and this comparer is what decides "equal".
 *
 * Rules, each deliberate:
 *  - REFERENCE fast path first — an untouched node keeps its `data` and
 *    `position` object references through the editor round trip, so most of a
 *    large graph compares in O(1) per node.
 *  - KEY-ORDER-INSENSITIVE — the stored graph has the file's key order, the
 *    editor rebuilds objects in its own; JSON.stringify would call them
 *    different.
 *  - A key whose value is `undefined` counts as ABSENT (the editor spreads
 *    optional fields as `undefined`; the file simply lacks them).
 *  - NaN equals NaN (the `Object.is` rule) so a NaN-carrying config cannot
 *    dirty the model on every sync.
 * Anything that is not an array / plain object / primitive (a typed array, a
 * Map) falls through to reference equality — nothing in a graph carries one.
 */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function deepEqualPlain(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqualPlain(a[i], b[i])) return false;
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    // Compare the union of keys, treating an `undefined` value as absent.
    for (const k of Object.keys(a)) {
      if (a[k] === undefined) continue;
      if (!deepEqualPlain(a[k], b[k])) return false;
    }
    for (const k of Object.keys(b)) {
      if (b[k] === undefined) continue;
      if (!(k in a) || a[k] === undefined) return false;
    }
    return true;
  }
  return false;
}

/** True when a graph write would leave the stored nodes AND edges unchanged. */
export function graphWriteIsNoop(
  curNodes: unknown, curEdges: unknown,
  nextNodes: unknown, nextEdges: unknown,
): boolean {
  return deepEqualPlain(curNodes, nextNodes) && deepEqualPlain(curEdges, nextEdges);
}
