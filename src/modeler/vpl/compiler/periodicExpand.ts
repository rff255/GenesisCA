/**
 * Periodic Step — target-independent pre-compile graph transform.
 *
 * A `periodicStep` root is EDITOR SUGAR for the hand-wired
 *
 *     Get Generation ─┬→ Math(%, period) → Compare(== phase) → If/Then → [chain]
 *                     └→ Math(/, period) → Math(floor)       → Step Index
 *
 * gate, hung off the ONE `behaviourStep` root the agent compilers look for. This
 * module rewrites every Periodic Step into exactly that, BEFORE any target
 * compiles, so the cadence reuses the already-verified `getGeneration` /
 * `arithmeticOperator` / `statement` / `conditional` / `sequence` emitters
 * ENTIRELY — **ZERO new per-target emit**, the sanctioned "lower to primitives"
 * pattern (`expandMacros` / `collapseReroutes` / `expandNeighbourCensus` /
 * `expandForceToAgents` / `lowerVectorAttrs` / `expandComposites`).
 *
 * It runs in all three agent front-ends right after `expandNeighbourCensus`; the
 * agent-target GATE then inspects the FLATTENED graph and sees only node types it
 * already supports, so `periodicStep` needs no entry in
 * `AGENT_WASM_SUPPORTED_TYPES` / `AGENT_WEBGPU_SUPPORTED_TYPES` and runs on JS,
 * WASM and WebGPU by construction. Bit-parity is inherited from the primitives.
 *
 * ## The shape it builds
 *
 * Let `B` = the user's `behaviourStep` (or a synthesized one) and
 * `P₁ … Pₙ` = the Periodic Steps in graph order. Branch order is
 *
 *     [everything B.do already ran]  then  [P₁'s gate, …, Pₙ's gate]
 *
 * i.e. **the unconditional chain runs first, then the periodic ones** — the
 * intuitive reading of "the always-on part, plus these periodic parts". The order
 * is made EXPLICIT with a `sequence` node rather than left to the edge-array
 * order of a flow fan-out (both compile the same, but the sequence is what the
 * emitted graph says).
 *
 * Rules the implementation keeps:
 *  - **Deterministic synthetic ids** (`${rootId}__ps…`, `__psSeq`, `__psGen`) so
 *    WASM bytes / WGSL text stay byte-stable across recompiles (the
 *    `multiAttrExpand` / `censusExpand` discipline).
 *  - **ONE shared `Get Generation`** fanned out to every gate (accessor-CSE is
 *    gated OFF in async agent mode, so duplicates would NOT be merged).
 *  - **Emit only CONSUMED ports** — `Step Index` synthesizes its ⌊gen/period⌋
 *    chain only when something reads it.
 *  - **At most ONE `behaviourStep` in the output**, so the singleton the three
 *    agent compilers look up with `nodes.find(...)` still holds.
 *
 * Hot-path no-op when the graph has no Periodic Step (returns the SAME arrays),
 * so every existing model compiles byte-identically.
 */

import type { CAModel, GraphNode, GraphEdge } from '../../../model/types';

/** Clamp a Periodic Step's config to the values the lowering can emit:
 *  `period ≥ 1` (0 would make `gen % period` a divide-by-zero, which the Math
 *  node maps to 0 — silently firing on phase 0 forever) and `phase` folded into
 *  `[0, period)` so a phase past the period is never a dead branch. */
export function periodicParams(config: Record<string, unknown> | undefined): { period: number; phase: number } {
  const rawP = Number(config?.['period']);
  const period = Number.isFinite(rawP) ? Math.max(1, Math.floor(rawP)) : 1;
  const rawPh = Number(config?.['phase']);
  const phase0 = Number.isFinite(rawPh) ? Math.floor(rawPh) : 0;
  // Fold negatives too — ((p % n) + n) % n.
  const phase = ((phase0 % period) + period) % period;
  return { period, phase };
}

const mkNode = (
  id: string, nodeType: string, position: { x: number; y: number },
  config: Record<string, string | number | boolean> = {},
): GraphNode => ({ id, type: 'caNode', position, data: { nodeType, config } });

export function expandPeriodicSteps(
  nodes: GraphNode[], edges: GraphEdge[], _model: CAModel,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const periodics = nodes.filter(n => n.data.nodeType === 'periodicStep');
  if (periodics.length === 0) return { nodes, edges };

  const outNodes: GraphNode[] = [];
  const outEdges: GraphEdge[] = [];
  const remapSrc = new Map<string, { source: string; sourceHandle: string }>();
  const periodicIds = new Set(periodics.map(n => n.id));

  // The root every gate hangs off: the user's Behaviour Step when present (its
  // own chain keeps running unconditionally), else a synthesized one. Either way
  // exactly ONE ends up in the output, so `nodes.find(behaviourStep)` in the
  // three agent compilers still resolves to a single root.
  const existing = nodes.find(n => n.data.nodeType === 'behaviourStep');
  const anchor = periodics[0]!;
  const rootId = existing ? existing.id : `${anchor.id}__psRoot`;
  for (const n of nodes) {
    if (periodicIds.has(n.id)) continue;      // the Periodic Step roots dissolve
    outNodes.push(n);
  }
  if (!existing) outNodes.push(mkNode(rootId, 'behaviourStep', anchor.position));

  // ONE shared Get Generation, fanned out to every gate (and to every Step Index
  // chain). Deterministic id anchored on the FIRST periodic root.
  const genId = `${anchor.id}__psGen`;
  outNodes.push(mkNode(genId, 'getGeneration', anchor.position));

  // Branch heads, in order: whatever the root already ran, then each gate.
  const branchHeads: Array<{ target: string; targetHandle: string }> = [];
  const rootDoEdges = edges.filter(e => e.source === rootId && e.sourceHandle === 'output_flow_do');
  for (const e of rootDoEdges) branchHeads.push({ target: e.target, targetHandle: e.targetHandle });

  for (const p of periodics) {
    const { period, phase } = periodicParams(p.data.config);
    const modId = `${p.id}__psMod`;
    const cmpId = `${p.id}__psCmp`;
    const ifId = `${p.id}__psIf`;
    // gen % period
    outNodes.push(mkNode(modId, 'arithmeticOperator', p.position, { operation: '%', _port_y: String(period) }));
    outEdges.push({ id: `${p.id}__psEg`, source: genId, sourceHandle: 'output_value_value', target: modId, targetHandle: 'input_value_x' });
    // (gen % period) === phase
    outNodes.push(mkNode(cmpId, 'statement', p.position, { operation: '==', compareType: 'numerical', _port_y: String(phase) }));
    outEdges.push({ id: `${p.id}__psEm`, source: modId, sourceHandle: 'output_value_result', target: cmpId, targetHandle: 'input_value_x' });
    // If / Then — the gate. The Periodic Step's DO consumers become its THEN
    // consumers (the `next`/DONE continuation is deliberately left free: a
    // Periodic Step's chain is its own, and the NEXT gate is a sibling branch of
    // the sequence, not a continuation of this one).
    outNodes.push(mkNode(ifId, 'conditional', p.position));
    outEdges.push({ id: `${p.id}__psEc`, source: cmpId, sourceHandle: 'output_value_result', target: ifId, targetHandle: 'input_value_condition' });
    branchHeads.push({ target: ifId, targetHandle: 'input_flow_check' });

    // Step Index = ⌊gen / period⌋ — synthesized ONLY when consumed.
    const wantsStepIndex = edges.some(e => e.source === p.id && e.sourceHandle === 'output_value_stepIndex');
    if (wantsStepIndex) {
      const divId = `${p.id}__psDiv`;
      const flrId = `${p.id}__psFlr`;
      outNodes.push(mkNode(divId, 'arithmeticOperator', p.position, { operation: '/', _port_y: String(period) }));
      outNodes.push(mkNode(flrId, 'arithmeticOperator', p.position, { operation: 'floor' }));
      outEdges.push({ id: `${p.id}__psEd`, source: genId, sourceHandle: 'output_value_value', target: divId, targetHandle: 'input_value_x' });
      outEdges.push({ id: `${p.id}__psEf`, source: divId, sourceHandle: 'output_value_result', target: flrId, targetHandle: 'input_value_x' });
      // Remapped below.
      remapSrc.set(`${p.id} output_value_stepIndex`, { source: flrId, sourceHandle: 'output_value_result' });
    }
    // The Periodic Step's DO consumers hang off the gate's THEN.
    remapSrc.set(`${p.id} output_flow_do`, { source: ifId, sourceHandle: 'output_flow_then' });
  }

  // Wire the root to the branch heads. One branch ⇒ a direct edge; several ⇒ a
  // Sequence (`first`, `then`, `then_2` … `then_k`, `extraCount = k - 1`) so the
  // order above is stated by the graph rather than inferred from edge order.
  const dropRootDo = new Set(rootDoEdges.map(e => e.id));
  if (branchHeads.length === 1) {
    const h = branchHeads[0]!;
    outEdges.push({ id: `${anchor.id}__psE0`, source: rootId, sourceHandle: 'output_flow_do', target: h.target, targetHandle: h.targetHandle });
  } else {
    const seqId = `${anchor.id}__psSeq`;
    outNodes.push(mkNode(seqId, 'sequence', anchor.position, { extraCount: branchHeads.length - 2 }));
    outEdges.push({ id: `${anchor.id}__psEs`, source: rootId, sourceHandle: 'output_flow_do', target: seqId, targetHandle: 'input_flow_do' });
    branchHeads.forEach((h, i) => {
      const port = i === 0 ? 'first' : i === 1 ? 'then' : `then_${i}`;
      outEdges.push({ id: `${anchor.id}__psEb${i}`, source: seqId, sourceHandle: `output_flow_${port}`, target: h.target, targetHandle: h.targetHandle });
    });
  }

  for (const e of edges) {
    if (dropRootDo.has(e.id)) continue;   // re-issued above (direct or via the sequence)
    const rs = remapSrc.get(`${e.source} ${e.sourceHandle}`);
    // An edge touching a dissolved Periodic Step port that no remap claimed is
    // stale (e.g. a Step Index wire the scan above already routed) → drop it
    // rather than silently repoint it.
    if (!rs && periodicIds.has(e.source)) continue;
    if (periodicIds.has(e.target)) continue;   // a Periodic Step has no inputs
    outEdges.push({
      ...e,
      source: rs ? rs.source : e.source,
      sourceHandle: rs ? rs.sourceHandle : e.sourceHandle,
    });
  }

  return { nodes: outNodes, edges: outEdges };
}
