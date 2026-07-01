/**
 * Agent Output Mappings — the agent analogue of `linkedOutputMappings.ts`.
 *
 * `injectAgentLinkedOutputMappings` AUGMENTS the agent graph the way
 * `injectLinkedOutputMappings` augments the cell graph: for every `linked`
 * Attribute→Color mapping in `model.agentMappings` it synthesizes a small
 * self-contained colour pass —
 *
 *     getCellAttribute(agentAttr) → colorScale | categoricalColor → setCellLooks
 *
 * rooted at an `agentOutputMapping` node. In the AGENT loop, `getCellAttribute`
 * reads the agent's own attribute (`r_<attr>[idx]`) and `setCellLooks` writes the
 * agent colours buffer (`colors[idx*4]`) — the SAME emitters the cell colour pass
 * uses, so there is no per-target colour math.
 *
 * STANDALONE mappings synthesize nothing — the user's own `agentOutputMapping`
 * root carries the whole pass. If a LINKED mapping ALSO has a user-placed
 * `agentOutputMapping` root, a `sequence` is inserted (auto background `first`,
 * user graph `then`) so the user's graph overrides whichever agents it paints —
 * exactly the cell override-after-background behaviour.
 *
 * `compileAgentGraph` then compiles EVERY `agentOutputMapping` root (user +
 * synthesized) into a per-agent colour-pass function.
 *
 * FRESHNESS: the synthesized nodes are ephemeral (never serialized; rebuilt from
 * the live model each compile). The attribute is resolved live by id against
 * `agentAttributes`, so a stale `linked*` config can never emit a dangling read.
 */

import type { GraphNode, GraphEdge, CAModel } from '../../../model/types';
import { agentAttrsOf } from '../../../model/attributeScope';
import { handleId } from '../types';
import {
  buildColorScaleConfig, buildCategoricalConfig, mkLinkedNode,
} from './linkedOutputMappings';

const SYNTH_PREFIX = '__agentOM_';

/** Augment the agent graph with the synthesized colour passes for every linked
 *  agent mapping (sequenced with any user `agentOutputMapping` root of the same
 *  id). Hot-path no-op when the model has no linked agent mappings. */
export function injectAgentLinkedOutputMappings(
  agentNodes: GraphNode[],
  agentEdges: GraphEdge[],
  model: CAModel,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const linked = (model.agentMappings ?? []).filter(
    m => m.isAttributeToColor && m.linked && m.linkedAttributeId,
  );
  if (linked.length === 0) return { nodes: agentNodes, edges: agentEdges }; // hot-path no-op

  const agentAttrs = agentAttrsOf(model);
  const nodes = [...agentNodes];
  let edges = [...agentEdges];

  for (const m of linked) {
    const attr = agentAttrs.find(a => a.id === m.linkedAttributeId);
    if (!attr) continue; // stale link — skip (no dangling read)

    const P = `${SYNTH_PREFIX}${m.id}_`;

    // 1. value chain: getCellAttribute(agent attr) → (colorScale | categoricalColor)
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
    edges.push(valEdge(P + 'e_av', getAttrId, 'value', colorId, colorInPort));

    // 2. terminal setCellLooks (plain-colour mode) — writes the agent colours
    //    buffer, guarded by `activeViewer === <mappingId>` (the _isV_ hoist).
    const scvId = P + 'scv';
    nodes.push(mkLinkedNode(scvId, 'setCellLooks', { mappingId: m.id, useGlyph: false, setBackground: true }));
    edges.push(valEdge(P + 'e_r', colorId, 'r', scvId, 'r'));
    edges.push(valEdge(P + 'e_g', colorId, 'g', scvId, 'g'));
    edges.push(valEdge(P + 'e_b', colorId, 'b', scvId, 'b'));

    // 3. sequencing — attach to the FIRST user agentOutputMapping node for this id.
    const userRoot = nodes.find(
      n => n.data.nodeType === 'agentOutputMapping' && n.data.config.mappingId === m.id,
    );
    const doSrc = handleId({ id: 'do', kind: 'output', category: 'flow' });

    if (!userRoot) {
      // No user node → synthesize the root and run only the auto pass.
      const rootId = P + 'root';
      nodes.push(mkLinkedNode(rootId, 'agentOutputMapping', { mappingId: m.id }));
      edges.push(flowEdge(P + 'e_root', rootId, 'do', scvId, 'do'));
    } else {
      const userEdge = edges.find(e => e.source === userRoot.id && e.sourceHandle === doSrc);
      if (!userEdge) {
        // User node with no downstream → just run the auto pass after it.
        edges.push(flowEdge(P + 'e_root', userRoot.id, 'do', scvId, 'do'));
      } else {
        // Insert a Sequence: first = auto background, then = user's original graph.
        const seqId = P + 'seq';
        nodes.push(mkLinkedNode(seqId, 'sequence', { extraCount: 0 }));
        edges = edges.filter(e => e !== userEdge); // re-point immutably (no mutation)
        edges.push(flowEdge(P + 'e_seq_in', userRoot.id, 'do', seqId, 'do'));
        edges.push(flowEdge(P + 'e_seq_first', seqId, 'first', scvId, 'do'));
        edges.push({
          id: P + 'e_seq_then',
          source: seqId,
          target: userEdge.target,
          sourceHandle: handleId({ id: 'then', kind: 'output', category: 'flow' }),
          targetHandle: userEdge.targetHandle, // preserve the user's original target handle
        });
      }
    }
  }

  return { nodes, edges };
}

function valEdge(id: string, source: string, sPort: string, target: string, tPort: string): GraphEdge {
  return {
    id, source, target,
    sourceHandle: handleId({ id: sPort, kind: 'output', category: 'value' }),
    targetHandle: handleId({ id: tPort, kind: 'input', category: 'value' }),
  };
}

function flowEdge(id: string, source: string, sPort: string, target: string, tPort: string): GraphEdge {
  return {
    id, source, target,
    sourceHandle: handleId({ id: sPort, kind: 'output', category: 'flow' }),
    targetHandle: handleId({ id: tPort, kind: 'input', category: 'flow' }),
  };
}
