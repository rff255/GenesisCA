/**
 * Reroute collapse — target-independent pre-compile edge rewrite.
 *
 * A *reroute* is an editor-only visual node (React Flow `type: 'rerouteNode'`,
 * like comment / group nodes — NOT a registry `NodeTypeDef`). It is a movable
 * relay dot placed on a wire so users can bend connections around other nodes
 * and fan a single output out to many consumers without long crossing wires.
 *
 * A reroute always relays an OUTPUT port's reference, never an input. So it has
 * exactly ONE inbound edge (the relayed output, which may itself be another
 * reroute's output) and any number of outbound edges. This pass removes reroute
 * nodes entirely and rewires each real consumer directly to the real source:
 *
 *     A.out → R → B,C,D            (what the user sees)
 *     A.out → B,  A.out → C, …     (what the compiler sees)
 *
 * Two shapes the pass must handle (both fall out for free):
 *   - Many reroutes per port  — `A.out → R1`, `A.out → R2` (ordinary fan-out).
 *   - Many reroutes per link  — `A.out → R1 → R2 → R3 → B` (a chain), resolved
 *     transitively back to A.
 *
 * Mirrors `canonicalizeAccessorEdges` / `injectLinkedOutputMappings`: a pure
 * graph transform that runs before sink analysis / CSE / buildAdjacency in all
 * three compilers, so the JS / WASM / WebGPU emitters never see a reroute and
 * need zero per-target changes. `A → R → B` compiles byte-identically to
 * `A → B`.
 *
 * Unlike accessor-CSE this is sound in BOTH sync and async modes: a reroute is
 * a pure wire relay — collapsing it changes neither read/write ordering nor the
 * set of values any node sees.
 */

import type { GraphNode, GraphEdge } from '../../../model/types';

/** Marker for a reroute node in the serialized graph (set at creation). */
const REROUTE_TYPE = 'rerouteNode';

/**
 * Remove every reroute node and rewrite the edges so each real (non-reroute)
 * consumer is wired straight to the real source it ultimately relays from.
 *
 * Hot-path no-op when the graph contains no reroutes (the overwhelmingly common
 * case): the input arrays are returned unchanged.
 */
export function collapseReroutes(
  nodes: GraphNode[],
  edges: GraphEdge[],
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const rerouteIds = new Set<string>();
  for (const n of nodes) if (n.type === REROUTE_TYPE) rerouteIds.add(n.id);
  if (rerouteIds.size === 0) return { nodes, edges };

  // Each reroute relays exactly one output → map reroute id to its single
  // inbound edge. First inbound wins (reroute inputs are single-occupancy; this
  // is defensive against a hand-edited file with a stray extra edge).
  const inboundOf = new Map<string, GraphEdge>();
  for (const e of edges) {
    if (rerouteIds.has(e.target) && !inboundOf.has(e.target)) inboundOf.set(e.target, e);
  }

  // Resolve a reroute back to its real (non-reroute) source, walking through
  // any chain of reroutes. Memoized over the whole walked path; cycle-guarded
  // (editor validation prevents cycles, but a hand-edited file might not).
  const memo = new Map<string, { source: string; sourceHandle: string } | null>();
  const resolve = (startId: string): { source: string; sourceHandle: string } | null => {
    const cached = memo.get(startId);
    if (cached !== undefined) return cached;
    const path: string[] = [];
    const seen = new Set<string>();
    let cur = startId;
    let result: { source: string; sourceHandle: string } | null = null;
    for (;;) {
      if (seen.has(cur)) { result = null; break; }       // cycle
      seen.add(cur);
      path.push(cur);
      const inb = inboundOf.get(cur);
      if (!inb) { result = null; break; }                // dangling reroute (no input)
      if (!rerouteIds.has(inb.source)) {                 // reached a real source
        result = { source: inb.source, sourceHandle: inb.sourceHandle };
        break;
      }
      const next = memo.get(inb.source);                 // upstream already resolved?
      if (next !== undefined) { result = next; break; }
      cur = inb.source;                                  // keep walking the chain
    }
    for (const id of path) memo.set(id, result);
    return result;
  };

  const out: GraphEdge[] = [];
  for (const e of edges) {
    if (rerouteIds.has(e.target)) continue;              // wire INTO a reroute: drop
    if (rerouteIds.has(e.source)) {                      // reroute output → consumer: rewrite
      const real = resolve(e.source);
      if (!real) continue;                               // dangling chain: leave consumer unconnected
      out.push({ ...e, source: real.source, sourceHandle: real.sourceHandle });
    } else {
      out.push(e);                                       // untouched
    }
  }

  return { nodes: nodes.filter(n => !rerouteIds.has(n.id)), edges: out };
}
