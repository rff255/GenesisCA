import type { MacroDef, MacroPort, MacroControl, GraphNode, GraphEdge } from './types';
import { migrateColorInterpolationInMacroDef } from './colorScaleMigration';
import { migrateTagConstantInMacroDef } from './tagConstantMigration';
import { migrateGetRandomRangeInMacroDef } from './getRandomRangeMigration';
import { migrateMoveSelfToNeighborInMacroDef } from './moveSelfToNeighborMigration';
import { migrateSetCellLooksInMacroDef } from './setCellLooksMigration';
import { migrateAgentTypeRemovalInMacroDef } from './agentTypeRemovalMigration';
import { migrateFormBondBetweenInMacroDef } from './formBondBetweenMigration';
import { migrateSetAgentAttributeInMacroDef } from './setAgentAttributeMigration';
import { migrateSetAgentsAttributeInMacroDef } from './setAgentsAttributeMigration';

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Deep-clone a MacroDef and regenerate every internal identifier so two drops of
 * the same default macro into a project (or the same macro into two projects)
 * never collide on node/edge/macro IDs.
 *
 * Remaps:
 *   - MacroDef.id
 *   - every node.id in the subgraph (including group/commentNode children)
 *   - every edge.id, edge.source, edge.target
 *   - MacroPort.internalNodeId references (to keep boundary ports wired)
 *   - MacroControl.target.nodeId — for ALL THREE target kinds (Explicit Controls,
 *     impact-map F1/R2). A control that survives with an UN-remapped nodeId is
 *     worse than one that vanishes: it resolves to a DIFFERENT internal node and
 *     silently edits the wrong parameter.
 *
 * Also migrates legacy `data.parentId` group memberships: translates child
 * positions (relative to the group) back to absolute and drops the field.
 * Groups are free-floating area markers now and don't own their children.
 *
 * Internal port ids (sourceHandle/targetHandle strings, MacroPort.internalPortId,
 * MacroPort.portId) are intentionally preserved — they're stable identifiers
 * inside the subgraph and don't collide across macro instances because each
 * MacroDef.id differs.
 *
 * PRESERVED for the SAME reason: MacroControl.id, MacroControl.groupId,
 * MacroInterfaceGroup.id, a facet target's `facet` name, and a chained target's
 * `controlId` — the last one is a
 * def-local id an OUTER def names, and both defs are cloned in the same
 * operation, so preserving it is exactly what keeps the chain resolving.
 *
 * ⚠ THE ONE THING MOST LIKELY TO GO WRONG: this is a hand-written object literal
 * with NO spread of `raw`, on the path of every import, paste and independent
 * duplicate. A field left off the literal is SILENTLY DROPPED — the macro still
 * works, the interface is just gone, with no error, no badge and no console line.
 * Every new MacroDef-level field must be added here.
 */
export function cloneMacroWithFreshIds(rawIn: MacroDef): MacroDef {
  // Rewrite any legacy colorInterpolation / tagConstant / moveSelfToNeighbor
  // nodes inside the source MacroDef BEFORE the id remap. All migrations are
  // idempotent — they return the same reference when no matching nodes exist.
  const raw = migrateSetAgentsAttributeInMacroDef(migrateSetAgentAttributeInMacroDef(migrateFormBondBetweenInMacroDef(migrateGetRandomRangeInMacroDef(
    migrateAgentTypeRemovalInMacroDef(migrateSetCellLooksInMacroDef(migrateMoveSelfToNeighborInMacroDef(
      migrateTagConstantInMacroDef(migrateColorInterpolationInMacroDef(rawIn)),
    ))),
  ))));
  const newMacroId = genId('mac');
  const idMap = new Map<string, string>();
  const mapId = (oldId: string): string => {
    const existing = idMap.get(oldId);
    if (existing) return existing;
    const fresh = genId('n');
    idMap.set(oldId, fresh);
    return fresh;
  };

  // Pre-register all node ids so later references (edge endpoints,
  // MacroPort.internalNodeId) map consistently regardless of iteration order.
  for (const n of raw.nodes) mapId(n.id);

  // Snapshot group positions BEFORE id remap so the legacy-parentId migration
  // can resolve relative coords. Index by ORIGINAL id.
  const groupPos = new Map<string, { x: number; y: number }>();
  for (const n of raw.nodes) {
    if (n.type === 'groupNode') groupPos.set(n.id, n.position);
  }

  const nodes: GraphNode[] = raw.nodes.map(n => {
    const data = { ...n.data } as Record<string, unknown>;
    let position = { ...n.position };
    if ('parentId' in data) {
      const parentOld = data.parentId as string | undefined;
      const parent = parentOld ? groupPos.get(parentOld) : undefined;
      if (parent) position = { x: position.x + parent.x, y: position.y + parent.y };
      delete data.parentId;
    }
    // Update macroDefId on boundary nodes (macroInput/macroOutput) to point at the new MacroDef.
    const config: GraphNode['data']['config'] = { ...n.data.config };
    if ((n.data.nodeType === 'macroInput' || n.data.nodeType === 'macroOutput') && 'macroDefId' in config) {
      config.macroDefId = newMacroId;
    }
    return {
      ...n,
      id: mapId(n.id),
      position,
      data: { ...(data as GraphNode['data']), config },
    };
  });

  const edges: GraphEdge[] = raw.edges.map(e => ({
    id: genId('e'),
    source: idMap.get(e.source) ?? e.source,
    target: idMap.get(e.target) ?? e.target,
    sourceHandle: e.sourceHandle,
    targetHandle: e.targetHandle,
  }));

  const remapPort = (p: MacroPort): MacroPort => ({
    ...p,
    internalNodeId: idMap.get(p.internalNodeId) ?? p.internalNodeId,
  });

  // `...c` carries id / name / groupId / description VERBATIM; only the target's
  // nodeId moves. ALL THREE arms remap it: a `config` target names an internal
  // node, a `control` target names a nested macro INSTANCE node, and a `facet`
  // target names an internal node whose multi-key editor it binds (D11) — all
  // live in `raw.nodes` and therefore in `idMap`. The spread is deliberately
  // kind-AGNOSTIC, so a fourth target kind inherits the remap; `configKey`,
  // `controlId` and `facet` are preserved (the portId rule — see the doc block).
  const remapControl = (c: MacroControl): MacroControl => ({
    ...c,
    target: { ...c.target, nodeId: idMap.get(c.target.nodeId) ?? c.target.nodeId },
  });

  return {
    id: newMacroId,
    name: raw.name,
    nodes,
    edges,
    exposedInputs: raw.exposedInputs.map(remapPort),
    exposedOutputs: raw.exposedOutputs.map(remapPort),
    // Conditional spreads, deliberately: a def with NO controls must clone to a
    // def with NO `controls` key — not `controls: []` — so "absent ⇒ today's
    // files, exactly" survives every clone (invariant 8).
    ...(raw.controls ? { controls: raw.controls.map(remapControl) } : {}),
    ...(raw.groups ? { groups: raw.groups.map(g => ({ ...g })) } : {}),
  };
}

/**
 * Count how many macro instances in the model reference a given MacroDef id.
 *
 * THE ONE model-wide macro-instance walk. It visits ALL FOUR stores — the Cells
 * graph, the Agents graph, the Overseer graph and every macro's subgraph
 * (instances nest inside other macros) — because "linked" is a MODEL-WIDE
 * property: instances sharing one macroDefId all change when any one's
 * internals are edited, wherever they happen to live. Consumers: the
 * "linked copies" count badge on a macro node (CaNode), `undoMacro`'s
 * def-removal ref-check, and `countInstancesEverywhere` (macroMoveScope), which
 * is a thin alias so the move-across-a-boundary gesture and the badge can never
 * disagree about what "how many instances" means.
 *
 * ⚠ IT WALKED ONLY `graphNodes` + `macroDefs` UNTIL 2026-09 — it predated the
 * Agents and Overseer graphs — so a linked duplicate made on either of those
 * counted 1 and the badge (shown at 2+) never appeared there. Any NEW top-level
 * graph store must be added to the `visit` list below, and to the caller's
 * memo/effect dependency arrays (a right answer that is never recomputed is the
 * same bug wearing a different hat).
 *
 * `excludeNodeId` skips one instance by node id — `undoMacro` needs it because
 * the model's copy of the live graph can still hold the very node being undone
 * (the canvas→model sync is debounced).
 */
export function countMacroInstances(
  model: {
    graphNodes?: GraphNode[];
    agentGraphNodes?: GraphNode[];
    overseerGraphNodes?: GraphNode[];
    macroDefs?: MacroDef[];
  },
  macroDefId: string,
  excludeNodeId?: string,
): number {
  if (!macroDefId) return 0;
  let count = 0;
  const visit = (nodes: GraphNode[] | undefined) => {
    for (const n of nodes ?? []) {
      if (n.data?.nodeType !== 'macro') continue;
      if (excludeNodeId !== undefined && n.id === excludeNodeId) continue;
      const cfg = n.data.config as Record<string, unknown> | undefined;
      if (cfg?.macroDefId === macroDefId) count++;
    }
  };
  visit(model.graphNodes);
  visit(model.agentGraphNodes);
  visit(model.overseerGraphNodes);
  for (const md of model.macroDefs || []) visit(md.nodes);
  return count;
}
