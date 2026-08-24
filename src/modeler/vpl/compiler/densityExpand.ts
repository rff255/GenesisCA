/**
 * Neighbour Density — the optional **Radius** override, as a target-independent
 * pre-compile graph transform.
 *
 * `neighbourDensity` normally reads the ENGINE's per-agent reduction
 * `_agentDensity[idx]` — one number the fused force pass counts for free while it
 * walks the neighbour stencil. That reduction has TWO properties a rule cannot
 * change: its cutoff is **RELATIVE** (`interactionRange × (r_i + r_j)`, i.e. it
 * scales with the pair's summed radii) and it is **ONE GENERATION STALE** (the
 * force pass runs AFTER the behaviour, so the behaviour reads the previous step's
 * count). That is exactly right for crowding rules driven by the engine's own
 * contact scale, and wrong when the rule means "how many agents are within 12
 * world units of me, right now".
 *
 * So the node gains an optional `radius` input. **UNWIRED / 0 ⇒ nothing changes**
 * (the node compiles verbatim to the engine reduction, on every target). ACTIVE ⇒
 * this module rewrites the node into
 *
 *     Get Nearby Agents(radius) → Array Length → (the density value)
 *
 * BEFORE any target compiles, so the override reuses the already-verified
 * `getNearbyAgents` / `arrayLength` emitters ENTIRELY — **ZERO new per-target
 * emit**, the sanctioned "lower to primitives" pattern (`expandMacros` /
 * `collapseReroutes` / `expandNeighbourCensus` / `expandForceToAgents` /
 * `expandMultiAttrs` / `lowerVectorAttrs` / `expandComposites`). It runs in all
 * three agent front-ends right after `expandNeighbourCensus`, so the agent-target
 * GATE inspects the FLATTENED graph and sees only node types it already supports
 * — the override runs on JS, WASM and WebGPU by construction, and bit-parity is
 * inherited from the primitives.
 *
 * THE SEMANTIC DIFFERENCE IS REAL AND IS DOCUMENTED ON THE NODE:
 *  - unwired → the engine reduction: relative cutoff, one generation stale, free.
 *  - active  → a FRESH count of the OTHER ALIVE agents whose torus-shortest
 *    distance is `≤ radius`, this generation, at an ABSOLUTE radius. It costs one
 *    spatial-hash query (the same one `Get Nearby Agents` costs).
 *
 * TWO CAVEATS INHERITED FROM `getNearbyAgents`, both stated on the node:
 *  - the query radius should be ≤ the model's **Neighbour Query Radius**
 *    (Properties › Motion) — the hash's 3×3(×3) stencil is sized to that, so a
 *    larger radius silently UNDER-counts;
 *  - the lowering consumes ONE agent-array-producer slot of the per-target budget
 *    (WASM `AGENT_NEARBY_SCRATCH_SLOTS` = 4, WebGPU `AGENT_WEBGPU_NEARBY_SLOTS` = 6).
 *    Both gates count the FLATTENED graph, so they see it automatically — no gate
 *    edit is needed and a graph over budget clamps to JS exactly as it would with
 *    a hand-wired Get Nearby Agents.
 *
 * Three rules the implementation keeps (the `censusExpand` discipline):
 *  - **Deterministic synthetic ids** (`${densityId}__dn…`) so WASM bytes / WGSL
 *    text stay byte-stable across recompiles.
 *  - **Emit only a CONSUMED output** — an active-radius node nothing reads
 *    synthesizes nothing.
 *  - **Hot-path no-op** when no density node has an active radius (returns the
 *    SAME arrays), so every existing model compiles byte-identically.
 */

import type { CAModel, GraphNode, GraphEdge, MacroDef } from '../../../model/types';

/** The optional Radius input port on `neighbourDensity`. */
export const DENSITY_RADIUS_PORT = 'radius';
/** Its target handle (`input_<category>_<portId>`). */
export const DENSITY_RADIUS_HANDLE = `input_value_${DENSITY_RADIUS_PORT}`;
/** Its inline-widget config key (the `_port_<portId>` convention). */
export const DENSITY_RADIUS_CONFIG = `_port_${DENSITY_RADIUS_PORT}`;

/** The inline half of the activation predicate: a finite, strictly-positive
 *  number typed into the Radius widget. Blank / absent / 0 / a non-number all mean
 *  "use the engine reduction" — which is why the port's `defaultValue` is `'0'`
 *  and a fresh node behaves exactly as it always did. */
export function densityRadiusInlineActive(config: Record<string, unknown> | undefined): boolean {
  const raw = config?.[DENSITY_RADIUS_CONFIG];
  if (raw === undefined || raw === null || raw === '') return false;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0;
}

/** THE ACTIVATION PREDICATE, in one place: the Radius is active when the port is
 *  WIRED (any source — a model attribute, an expression, a per-agent read) OR
 *  carries a positive inline value. Everything else keeps the engine reduction. */
export function densityRadiusActive(
  nodeId: string,
  config: Record<string, unknown> | undefined,
  edges: ReadonlyArray<GraphEdge>,
): boolean {
  for (const e of edges) {
    if (e.target === nodeId && e.targetHandle === DENSITY_RADIUS_HANDLE) return true;
  }
  return densityRadiusInlineActive(config);
}

/**
 * Does anything in the agent graph still read the ENGINE's density reduction?
 *
 * The reduction's only writer is the force pass's neighbour scan, so this is the
 * predicate the THREE density gates share (`resolveAgentFieldGates`'s `density`
 * SoA field, SimulatorView's `agentUsesDensity` → the worker's `doScan`, and the
 * C2 pipeline panel's `usesDensity` row). A `divideAgent` always counts (its
 * degenerate-axis fallback reads density in the engine); a `neighbourDensity`
 * counts ONLY while its Radius is inactive — an active Radius lowers the node
 * away, so nothing would read the reduction and running the scan for it would be
 * exactly the dead scan P1 removed.
 *
 * Macro-aware (the compilers flatten macros up front), and each macroDef is
 * scanned against ITS OWN edges — a Radius fed from a `macroInput` is a real edge
 * inside that def, so it reads as wired.
 */
export function agentGraphReadsEngineDensity(model: CAModel): boolean {
  if (!model.topologyMode?.agents) return false;
  const macroDefs: MacroDef[] = model.macroDefs ?? [];
  const seen = new Set<string>();
  const scan = (nodes: ReadonlyArray<GraphNode> | undefined, edges: ReadonlyArray<GraphEdge> | undefined): boolean => {
    const es = edges ?? [];
    for (const n of nodes ?? []) {
      const t = n.data?.nodeType as string | undefined;
      if (!t) continue;
      if (t === 'divideAgent') return true;
      if (t === 'neighbourDensity') {
        if (!densityRadiusActive(n.id, n.data?.config as Record<string, unknown> | undefined, es)) return true;
        continue;
      }
      if (t === 'macro') {
        const defId = (n.data?.config as Record<string, unknown> | undefined)?.['macroDefId'] as string | undefined;
        if (defId && !seen.has(defId)) {
          seen.add(defId);
          const def = macroDefs.find(d => d.id === defId);
          if (def && scan(def.nodes as ReadonlyArray<GraphNode>, def.edges as ReadonlyArray<GraphEdge>)) return true;
        }
      }
    }
    return false;
  };
  return scan(model.agentGraphNodes, model.agentGraphEdges);
}

/** Lower every ACTIVE-radius `neighbourDensity` into Get Nearby Agents → Array
 *  Length. Hot-path no-op (same arrays) when none is active. */
export function expandDensityRadius(
  nodes: GraphNode[], edges: GraphEdge[], _model: CAModel,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  let any = false;
  for (const nd of nodes) {
    if (nd.data.nodeType === 'neighbourDensity'
      && densityRadiusActive(nd.id, nd.data.config as Record<string, unknown> | undefined, edges)) { any = true; break; }
  }
  if (!any) return { nodes, edges };

  const outNodes: GraphNode[] = [];
  const outEdges: GraphEdge[] = [];
  const remapSrc = new Map<string, { source: string; sourceHandle: string }>();
  const remapTgt = new Map<string, { target: string; targetHandle: string }>();
  const expandedIds = new Set<string>();

  for (const nd of nodes) {
    const cfg = (nd.data.config ?? {}) as Record<string, unknown>;
    if (nd.data.nodeType !== 'neighbourDensity' || !densityRadiusActive(nd.id, cfg, edges)) { outNodes.push(nd); continue; }
    expandedIds.add(nd.id);

    // Nothing reads the count ⇒ synthesize nothing (the census "consumed ports only"
    // rule). The node + its radius edge are then simply dropped.
    let consumed = false;
    for (const e of edges) if (e.source === nd.id && e.sourceHandle === 'output_value_value') { consumed = true; break; }
    if (!consumed) continue;

    const gatherId = `${nd.id}__dnG`;
    const lenId = `${nd.id}__dnLen`;
    // Carry the inline radius across; a WIRED radius overrides it, exactly as on
    // the density node itself (the remap below repoints that edge at the gather).
    const gCfg: Record<string, string | number | boolean> = {};
    const r = cfg[DENSITY_RADIUS_CONFIG];
    if (r !== undefined) gCfg[DENSITY_RADIUS_CONFIG] = r as string | number | boolean;
    outNodes.push({ id: gatherId, type: 'caNode', position: nd.position, data: { nodeType: 'getNearbyAgents', config: gCfg } });
    outNodes.push({ id: lenId, type: 'caNode', position: nd.position, data: { nodeType: 'arrayLength', config: {} } });
    outEdges.push({ id: `${nd.id}__dnE`, source: gatherId, sourceHandle: 'output_value_agents', target: lenId, targetHandle: 'input_value_array' });

    remapTgt.set(`${nd.id} ${DENSITY_RADIUS_HANDLE}`, { target: gatherId, targetHandle: DENSITY_RADIUS_HANDLE });
    remapSrc.set(`${nd.id} output_value_value`, { source: lenId, sourceHandle: 'output_value_length' });
  }

  for (const e of edges) {
    const rs = remapSrc.get(`${e.source} ${e.sourceHandle}`);
    const rt = remapTgt.get(`${e.target} ${e.targetHandle}`);
    // An edge touching a REMOVED node's port that no remap claimed is stale → drop.
    if (!rs && expandedIds.has(e.source)) continue;
    if (!rt && expandedIds.has(e.target)) continue;
    outEdges.push({
      ...e,
      source: rs ? rs.source : e.source,
      sourceHandle: rs ? rs.sourceHandle : e.sourceHandle,
      target: rt ? rt.target : e.target,
      targetHandle: rt ? rt.targetHandle : e.targetHandle,
    });
  }

  return { nodes: outNodes, edges: outEdges };
}
