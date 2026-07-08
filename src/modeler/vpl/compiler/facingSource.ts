import type { GraphNode, GraphEdge, CAModel } from '../../../model/types';
import { agentAttrsOf } from '../../../model/attributeScope';
import { is3dModelLike } from './niCodec';

/** The FOV nodes (Sensing capability) whose `headingSource: 'facing'` reads a
 *  stored per-agent facing direction instead of the agent's velocity / wired inputs. */
const FACING_HEADING_NODES: ReadonlySet<string> = new Set(['getAgentsInView', 'senseHemifield']);
const HEADING_HANDLES: ReadonlySet<string> = new Set([
  'input_value_headingX', 'input_value_headingY', 'input_value_headingZ',
]);

/** True when `id` names a live VECTOR agent attribute (the only kind a `facing`
 *  heading source can read — a single direction). */
export function isFacingAttr(id: unknown, model: CAModel): boolean {
  return typeof id === 'string' && agentAttrsOf(model).some(a => a.id === id && a.type === 'vector');
}

/** Lower the `facing` heading source on the FOV nodes (Get Agents In View / Sense
 *  Hemifield) into the ALREADY-VERIFIED wired-heading composition: a per-agent
 *  `getCellAttribute` (Get Self Attribute) of the chosen VECTOR facing attribute →
 *  `breakVector` → the node's Heading X/Y[/Z] inputs, with `headingSource` set to
 *  `'wired'`. So the whole feature rides `lowerVectorAttrs` (which lowers the vector
 *  read into per-component scalar reads) + `expandComposites` (which collapses the
 *  synthesized Make/Break round-trip) with ZERO per-target emit — the heading is the
 *  facing attribute's components on JS / WASM / WebGPU, 2D + 3D.
 *
 *  MUST run BEFORE `lowerVectorAttrs` (so the synthesized `getCellAttribute` of the
 *  vector facing attr is lowered) and AFTER macro-expansion / reroute-collapse (a
 *  flat graph). Hot-path no-op (identity) when no FOV node uses a resolvable facing
 *  source. A `facingAttributeId` that isn't a live VECTOR agent attribute is SKIPPED
 *  (the node then falls back to the velocity source via `viewHeadingExprs`, and
 *  `nodeValidation` badges the missing config). Only the AGENT front-ends call this
 *  (the FOV nodes are `requirements.bondGraph`). */
export function lowerFacingSource(
  nodes: GraphNode[], edges: GraphEdge[], model: CAModel,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const facing = nodes.filter(n =>
    FACING_HEADING_NODES.has(n.data?.nodeType) &&
    n.data.config?.headingSource === 'facing' &&
    isFacingAttr(n.data.config?.facingAttributeId, model));
  if (facing.length === 0) return { nodes, edges };

  const is3d = is3dModelLike(model);
  const facingIds = new Set(facing.map(n => n.id));
  let uid = 0;
  const nid = () => `__facing${uid++}`;

  // Drop any pre-existing edge into a facing node's Heading ports (the facing source
  // overrides them — normally none, since those ports are hidden under 'facing').
  const outEdges: GraphEdge[] = edges.filter(e =>
    !(facingIds.has(e.target) && HEADING_HANDLES.has(e.targetHandle)));

  // Replace each facing FOV node with a CLONE whose headingSource is 'wired' — never
  // mutate the shared model node (top-level nodes are passed by reference through
  // macro-expansion, so a mutation would persist across recompiles).
  const outNodes: GraphNode[] = nodes.map(n =>
    facingIds.has(n.id)
      ? { ...n, data: { ...n.data, config: { ...n.data.config, headingSource: 'wired' } } }
      : n);

  // Synthesize the composition per facing node: getCellAttribute(facing) → breakVector
  // → the (now wired) Heading X/Y[/Z] inputs.
  for (const n of facing) {
    const facingId = n.data.config!.facingAttributeId as string;
    const getN: GraphNode = { id: nid(), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: 'getCellAttribute', config: { attributeId: facingId } } };
    const bv: GraphNode = { id: nid(), type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType: 'breakVector', config: {} } };
    outNodes.push(getN, bv);
    outEdges.push({ id: nid() + 'e', source: getN.id, sourceHandle: 'output_value_value', target: bv.id, targetHandle: 'input_value_vector' });
    outEdges.push({ id: nid() + 'e', source: bv.id, sourceHandle: 'output_value_x', target: n.id, targetHandle: 'input_value_headingX' });
    outEdges.push({ id: nid() + 'e', source: bv.id, sourceHandle: 'output_value_y', target: n.id, targetHandle: 'input_value_headingY' });
    if (is3d) outEdges.push({ id: nid() + 'e', source: bv.id, sourceHandle: 'output_value_z', target: n.id, targetHandle: 'input_value_headingZ' });
  }
  return { nodes: outNodes, edges: outEdges };
}
