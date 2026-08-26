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
 *   - MacroControl.target.nodeId — for BOTH target kinds (Explicit Controls,
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
 * MacroInterfaceGroup.id, and a chained target's `controlId` — the last one is a
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
    ...p,                       // carries `groupId` for free
    internalNodeId: idMap.get(p.internalNodeId) ?? p.internalNodeId,
  });

  // `...c` carries id / name / groupId / description VERBATIM; only the target's
  // nodeId moves. Both arms remap it: a `config` target names an internal node,
  // and a `control` target names a nested macro INSTANCE node — both live in
  // `raw.nodes` and therefore in `idMap`. `configKey` and `controlId` are
  // preserved (the portId rule — see the doc block above).
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
 * Walks the top-level graph AND every macro's subgraph (instances can be nested
 * inside other macros). Used for the "linked copies" count badge on macro nodes
 * and shared with the palette's project-macro reference filter / undoMacro's
 * ref-check — instances sharing one macroDefId are "linked" (editing one's
 * internals changes all).
 */
export function countMacroInstances(
  model: { graphNodes: GraphNode[]; macroDefs?: MacroDef[] },
  macroDefId: string,
): number {
  if (!macroDefId) return 0;
  let count = 0;
  const visit = (nodes: GraphNode[]) => {
    for (const n of nodes) {
      if (n.data?.nodeType !== 'macro') continue;
      const cfg = n.data.config as Record<string, unknown> | undefined;
      if (cfg?.macroDefId === macroDefId) count++;
    }
  };
  visit(model.graphNodes);
  for (const md of model.macroDefs || []) visit(md.nodes);
  return count;
}
