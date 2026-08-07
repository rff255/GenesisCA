/**
 * Runtime migration: Get Random's numeric interval moved from CONFIG keys
 * (`min` / `max`) to real INPUT PORTS, so a rule can drive the range from a
 * model attribute, an expression or any other wire.
 *
 * An inline-widget port stores its value under `_port_<portId>`, so a legacy
 * node's `config.min` / `config.max` must be re-keyed or the compilers would
 * silently fall back to the port defaults (0 / 1) — e.g. Amphiphile's
 * `integer 1..3` would become `0..1`. The move is value-for-value, so the
 * emitted code is byte-identical after migration.
 *
 * Applies to the CELL graph, the AGENT graph, the OVERSEER graph and every
 * macroDef (Get Random is universal — it appears in all four). Idempotent: a
 * node that already carries `_port_min` / `_port_max` (or neither legacy key)
 * is left alone, and a model with nothing to migrate is returned by reference.
 */

import type { CAModel, GraphNode, GraphEdge, MacroDef } from './types';

const LEGACY: Array<['min' | 'max', '_port_min' | '_port_max']> = [
  ['min', '_port_min'],
  ['max', '_port_max'],
];

function migrateNode(node: GraphNode): GraphNode {
  const cfg = node.data.config as unknown as Record<string, unknown>;
  const newCfg: Record<string, unknown> = { ...cfg };
  for (const [legacy, port] of LEGACY) {
    if (legacy in newCfg) {
      // Only seed the port when it has no explicit value — a node touched by
      // the new UI already owns the truth.
      if (!(port in newCfg)) newCfg[port] = newCfg[legacy];
      delete newCfg[legacy];
    }
  }
  return { ...node, data: { ...node.data, config: newCfg as GraphNode['data']['config'] } };
}

function migratePair(
  nodes: GraphNode[],
  edges: GraphEdge[],
): { nodes: GraphNode[]; edges: GraphEdge[]; changed: boolean } {
  let changed = false;
  const newNodes = nodes.map(n => {
    if (n.data?.nodeType !== 'getRandom') return n;
    const cfg = n.data.config as unknown as Record<string, unknown> | undefined;
    // Any legacy key present ⇒ rewrite (seeding the port only when it has no
    // explicit value), so the saved config stops carrying dead data either way.
    if (!cfg || (!('min' in cfg) && !('max' in cfg))) return n;
    changed = true;
    return migrateNode(n);
  });
  return { nodes: changed ? newNodes : nodes, edges, changed };
}

/** Migrate every graph (cells / agents / overseer) + all macroDefs in one pass.
 *  Returns the same model reference when nothing matched (idempotent). */
export function migrateGetRandomRange(model: CAModel): CAModel {
  const cell = migratePair(model.graphNodes ?? [], model.graphEdges ?? []);
  const agent = migratePair(model.agentGraphNodes ?? [], model.agentGraphEdges ?? []);
  const overseer = migratePair(model.overseerGraphNodes ?? [], model.overseerGraphEdges ?? []);

  let anyMacroChanged = false;
  const newMacroDefs = (model.macroDefs ?? []).map(md => {
    const r = migratePair(md.nodes, md.edges);
    if (!r.changed) return md;
    anyMacroChanged = true;
    return { ...md, nodes: r.nodes, edges: r.edges } as MacroDef;
  });

  if (!cell.changed && !agent.changed && !overseer.changed && !anyMacroChanged) return model;
  return {
    ...model,
    ...(cell.changed ? { graphNodes: cell.nodes } : {}),
    ...(agent.changed ? { agentGraphNodes: agent.nodes } : {}),
    ...(overseer.changed ? { overseerGraphNodes: overseer.nodes } : {}),
    macroDefs: anyMacroChanged ? newMacroDefs : model.macroDefs,
  };
}

/** Convenience for macro-import call sites — migrates one MacroDef in place
 *  (returns the same reference if nothing matched). */
export function migrateGetRandomRangeInMacroDef(md: MacroDef): MacroDef {
  const r = migratePair(md.nodes, md.edges);
  return r.changed ? { ...md, nodes: r.nodes, edges: r.edges } : md;
}
