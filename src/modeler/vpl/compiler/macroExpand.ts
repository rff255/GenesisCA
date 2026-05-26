/** Shared macro flattening for all three compile targets.
 *
 * `expandMacros` replaces every `macro` instance in the graph with the
 * referenced MacroDef's internal nodes (ids prefixed `m<instanceId>_`) plus
 * rewritten bridge edges (MacroInput ports alias the outer source; MacroOutput
 * inputs become the macro instance's downstream consumers). Boundary nodes
 * (`macroInput` / `macroOutput`) are dropped. Recurses so nested macros expand
 * too, with a depth-20 guard.
 *
 * After expansion the graph is FLAT — no `macro` / `macroInput` / `macroOutput`
 * nodes remain — so every downstream analysis (sink analysis, loop-invariance,
 * accessor-CSE, volatile hoisting) and per-node emitter sees one uniform graph.
 *
 * This was historically duplicated verbatim inside wasm/compile.ts and
 * webgpu/compile.ts; the JS compiler now uses it too (replacing its separate
 * lazy macro-inlining path), so all three targets share one implementation.
 */

import type { CAModel, GraphNode, GraphEdge } from '../../../model/types';

/** Parse a React Flow handle id of the form `<input|output>_<value|flow>_<portId>`. */
function parseHandle(handleId: string | undefined): { category: 'value' | 'flow'; portId: string } | null {
  if (!handleId) return null;
  const m = handleId.match(/^(?:input|output)_(value|flow)_(.+)$/);
  if (!m) return null;
  return { category: m[1] as 'value' | 'flow', portId: m[2]! };
}

export function expandMacros(
  graphNodes: GraphNode[],
  graphEdges: GraphEdge[],
  model: CAModel,
  depth = 0,
): { nodes: GraphNode[]; edges: GraphEdge[]; error?: string } {
  if (depth > 20) return { nodes: graphNodes, edges: graphEdges, error: 'macro recursion depth > 20' };
  const macroInstances = graphNodes.filter(n => n.data.nodeType === 'macro');
  if (macroInstances.length === 0) return { nodes: graphNodes, edges: graphEdges };

  const macroDefs = model.macroDefs ?? [];

  // Index outer edges by source/target for fast bridge lookup.
  const edgesByTarget = new Map<string, GraphEdge[]>();
  const edgesBySource = new Map<string, GraphEdge[]>();
  for (const e of graphEdges) {
    const t = edgesByTarget.get(e.target); if (t) t.push(e); else edgesByTarget.set(e.target, [e]);
    const s = edgesBySource.get(e.source); if (s) s.push(e); else edgesBySource.set(e.source, [e]);
  }

  const removedNodeIds = new Set(macroInstances.map(m => m.id));
  const newNodes: GraphNode[] = [];
  const newEdges: GraphEdge[] = [];

  // Carry over all non-macro outer nodes.
  for (const n of graphNodes) if (!removedNodeIds.has(n.id)) newNodes.push(n);
  // Carry over outer edges that don't touch any macro instance.
  for (const e of graphEdges) {
    if (!removedNodeIds.has(e.source) && !removedNodeIds.has(e.target)) newEdges.push(e);
  }

  for (const m of macroInstances) {
    const def = macroDefs.find(d => d.id === m.data.config.macroDefId);
    if (!def) continue;
    const prefix = `m${m.id}_`;

    // Map external sources for each input port (via outer edges arriving at the macro instance).
    const extInMap = new Map<string, { source: string; sourceHandle: string }>();
    const extInArr = edgesByTarget.get(m.id) ?? [];
    for (const e of extInArr) extInMap.set(e.targetHandle ?? '', { source: e.source, sourceHandle: e.sourceHandle ?? '' });

    // Outer edges consuming the macro instance's output ports.
    const extOutArr = edgesBySource.get(m.id) ?? [];

    // Copy internal non-boundary nodes with prefixed ids.
    for (const inner of def.nodes) {
      if (inner.data.nodeType === 'macroInput' || inner.data.nodeType === 'macroOutput') continue;
      newNodes.push({ ...inner, id: prefix + inner.id });
    }

    // Copy internal edges, rewriting endpoints.
    for (const e of def.edges) {
      const srcInner = def.nodes.find(n => n.id === e.source);
      const tgtInner = def.nodes.find(n => n.id === e.target);
      const srcIsBoundary = srcInner?.data.nodeType === 'macroInput' || srcInner?.data.nodeType === 'macroOutput';
      const tgtIsBoundary = tgtInner?.data.nodeType === 'macroInput' || tgtInner?.data.nodeType === 'macroOutput';
      if (srcIsBoundary && tgtIsBoundary) continue; // pure boundary-to-boundary — no work

      if (srcInner?.data.nodeType === 'macroInput') {
        // MacroInput output → wire from the outer source feeding the matching instance port.
        const ep = parseHandle(e.sourceHandle);
        const epPortId = ep?.portId ?? e.sourceHandle ?? '';
        let ext: { source: string; sourceHandle: string } | undefined;
        for (const [th, src] of extInMap) {
          const parsed = parseHandle(th);
          if (parsed?.portId === epPortId) { ext = src; break; }
        }
        if (!ext) continue;
        newEdges.push({
          ...e,
          id: prefix + e.id,
          source: ext.source,
          sourceHandle: ext.sourceHandle,
          target: prefix + e.target,
        });
        continue;
      }

      if (tgtInner?.data.nodeType === 'macroOutput') {
        // Internal source → MacroOutput input: re-target every outer consumer of
        // that macro output port to the internal source directly.
        const epPortId = parseHandle(e.targetHandle)?.portId ?? e.targetHandle ?? '';
        for (const eOut of extOutArr) {
          const epExt = parseHandle(eOut.sourceHandle);
          if (epExt?.portId !== epPortId) continue;
          newEdges.push({
            ...eOut,
            source: prefix + e.source,
            sourceHandle: e.sourceHandle,
          });
        }
        continue;
      }

      // Internal-to-internal: just prefix endpoints.
      newEdges.push({
        ...e,
        id: prefix + e.id,
        source: prefix + e.source,
        target: prefix + e.target,
      });
    }
  }

  // Recurse — nested macros appear as `macro` nodes in newNodes.
  return expandMacros(newNodes, newEdges, model, depth + 1);
}
