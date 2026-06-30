/**
 * Agent Output Mappings — the agent analogue of `linkedOutputMappings.ts`.
 *
 * For each `linked` Attribute→Color mapping in `model.agentMappings`, this
 * synthesizes a small self-contained node graph that auto-generates a per-AGENT
 * colour pass:
 *
 *     getCellAttribute(agentAttr) → colorScale | categoricalColor → setCellLooks
 *
 * rooted at an `outputMapping` node. In the AGENT loop, `getCellAttribute` reads
 * the agent's own attribute (`r_<attr>[idx]`) and `setCellLooks` writes the agent
 * colours buffer (`colors[idx*4]`) — the SAME emitters the cell colour pass uses,
 * so there is no per-target colour math. The compiler (compile.ts
 * `compileAgentGraph`) compiles each returned graph into a per-agent colour-pass
 * function, so the user defines an agent VIEW by picking an attribute → colour
 * instead of hand-wiring Set Cell Looks in the Behaviour Step.
 *
 * FRESHNESS: ephemeral (never serialized; rebuilt from the live model each
 * compile). The attribute is resolved live by id against `agentAttributes`, so a
 * stale `linked*` config can never emit a dangling read.
 */

import type { GraphNode, GraphEdge, CAModel } from '../../../model/types';
import { agentAttrsOf } from '../../../model/attributeScope';
import {
  buildColorScaleConfig, buildCategoricalConfig,
  mkLinkedNode, linkedValEdge, linkedFlowEdge,
} from './linkedOutputMappings';

const SYNTH_PREFIX = '__agentOM_';

export interface AgentColorPassGraph {
  mappingId: string;
  rootId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** One self-contained colour-pass graph per linked agent mapping. The compiler
 *  compiles each `rootId` (an `outputMapping` root) into a per-agent loop. Empty
 *  array (hot-path) when the model has no linked agent mappings. */
export function buildAgentColorPassGraphs(model: CAModel): AgentColorPassGraph[] {
  const linked = (model.agentMappings ?? []).filter(
    m => m.isAttributeToColor && m.linked && m.linkedAttributeId,
  );
  if (linked.length === 0) return [];
  const agentAttrs = agentAttrsOf(model);
  const out: AgentColorPassGraph[] = [];

  for (const m of linked) {
    const attr = agentAttrs.find(a => a.id === m.linkedAttributeId);
    if (!attr) continue; // stale link — skip (no dangling read)

    const P = `${SYNTH_PREFIX}${m.id}_`;
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    // value chain: getCellAttribute(agent attr) → (colorScale | categoricalColor)
    const getAttrId = P + 'getattr';
    nodes.push(mkLinkedNode(getAttrId, 'getCellAttribute', { attributeId: attr.id }));

    const colorId = P + 'color';
    let colorInPort: string;
    if (attr.type === 'tag') {
      nodes.push(mkLinkedNode(colorId, 'categoricalColor', buildCategoricalConfig(m, attr)));
      colorInPort = 'index';
    } else {
      nodes.push(mkLinkedNode(colorId, 'colorScale', buildColorScaleConfig(m, attr)));
      colorInPort = 't';
    }
    edges.push(linkedValEdge(P + 'e_av', getAttrId, 'value', colorId, colorInPort));

    // terminal setCellLooks (plain-colour mode) — writes the agent colours buffer,
    // guarded by `activeViewer === <mappingId>` (the _isV_ hoist) so only the
    // active agent viewer paints.
    const scvId = P + 'scv';
    nodes.push(mkLinkedNode(scvId, 'setCellLooks', { mappingId: m.id, useGlyph: false, setBackground: true }));
    edges.push(linkedValEdge(P + 'e_r', colorId, 'r', scvId, 'r'));
    edges.push(linkedValEdge(P + 'e_g', colorId, 'g', scvId, 'g'));
    edges.push(linkedValEdge(P + 'e_b', colorId, 'b', scvId, 'b'));

    // outputMapping root → setCellLooks
    const rootId = P + 'root';
    nodes.push(mkLinkedNode(rootId, 'outputMapping', { mappingId: m.id }));
    edges.push(linkedFlowEdge(P + 'e_root', rootId, 'do', scvId, 'do'));

    out.push({ mappingId: m.id, rootId, nodes, edges });
  }
  return out;
}
