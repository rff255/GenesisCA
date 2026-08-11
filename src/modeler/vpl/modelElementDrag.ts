/**
 * Drag-from-side-panel-to-canvas payload types + related-node mapping.
 *
 * Side panels (Attributes, Neighborhoods, Mappings, Properties → Indicators)
 * mark each item row as `draggable` and emit a payload of this type on
 * `dragstart`. The graph editor's drop handler decodes the payload, opens
 * a context menu listing nodes that consume/produce that element kind, and
 * pre-configures the chosen node with the element's id.
 *
 * Separate from the palette drag (`application/genesisca-palette`) so each
 * source has its own narrow payload schema and the drop handler can keep
 * the two paths visually distinct.
 */

import type { Node } from '@xyflow/react';
import type { PortDef } from './types';
import { getNodeDef } from './nodes/registry';
import { getEffectivePorts } from './effectivePorts';
import { handleKey, getActiveGraphKind } from './graphState';

export const MODEL_ELEMENT_DRAG_MIME = 'application/genesisca-model-element';

export type ModelElementDragPayload =
  | { kind: 'cell-attribute'; attributeId: string; attrType: 'bool' | 'integer' | 'float' | 'tag' | 'color' | 'neighborIndex' }
  | { kind: 'model-attribute'; attributeId: string; isColor: boolean }
  | { kind: 'neighborhood'; neighborhoodId: string }
  | { kind: 'mapping-a2c'; mappingId: string }
  | { kind: 'mapping-c2a'; mappingId: string }
  /** An AGENT Attribute→Color view (`model.agentMappings`) — a SEPARATE id-space
   *  from the cell mappings, so it needs its own kind rather than reusing
   *  `mapping-a2c` (whose related nodes are the LATTICE roots). */
  | { kind: 'agent-mapping'; mappingId: string }
  /** An AGENT Color→Attribute INPUT mapping (the `isAttributeToColor === false`
   *  half of `model.agentMappings`) — the agent Paint brush's graph. Its own kind
   *  so the drop offers the `agentInputMapping` root and NOT the A→C pair. */
  | { kind: 'agent-mapping-c2a'; mappingId: string }
  /** A Sprite Library asset (`model.sprites`) — the agent exhibition layer's
   *  image. Its only consumer is the agent-only Set Agent Sprite node. */
  | { kind: 'sprite'; spriteId: string }
  | { kind: 'indicator'; indicatorId: string }
  | { kind: 'variable'; variableId: string; varKind: 'scalar' | 'array' };

export interface RelatedNodeEntry {
  /** Node type to instantiate on pick. */
  nodeType: string;
  /** The config key on the new node that receives the dragged element's id. */
  configKey: string;
  /** Optional extra config entries (e.g. `{ isColorAttr: true }` for color
   *  model attributes so GetModelAttribute renders R/G/B output ports). */
  extraConfig?: Record<string, string | number | boolean>;
}

/** Read the right id field out of a payload for the chosen RelatedNodeEntry. */
export function payloadElementId(payload: ModelElementDragPayload): string {
  switch (payload.kind) {
    case 'cell-attribute': return payload.attributeId;
    case 'model-attribute': return payload.attributeId;
    case 'neighborhood': return payload.neighborhoodId;
    case 'mapping-a2c': return payload.mappingId;
    case 'mapping-c2a': return payload.mappingId;
    case 'agent-mapping': return payload.mappingId;
    case 'agent-mapping-c2a': return payload.mappingId;
    case 'sprite': return payload.spriteId;
    case 'indicator': return payload.indicatorId;
    case 'variable': return payload.variableId;
  }
}

/**
 * Each entry lists ONLY nodes that have the configKey directly on their own
 * body (i.e., the user can pick that element via a dropdown in the node's
 * config UI). Aggregation/filter/pick nodes that take a `values` or
 * neighbor-index array via an INPUT port are intentionally excluded — they
 * don't have a `attributeId` / `neighborhoodId` config field, so pre-filling
 * one wouldn't help and the node wouldn't visibly reference the dragged
 * element.
 */
export const RELATED_NODES: Record<ModelElementDragPayload['kind'], RelatedNodeEntry[]> = {
  'cell-attribute': [
    { nodeType: 'getCellAttribute', configKey: 'attributeId' },
    { nodeType: 'setAttribute', configKey: 'attributeId' },
    { nodeType: 'updateAttribute', configKey: 'attributeId' },
    { nodeType: 'getNeighborAttributeByIndex', configKey: 'attributeId' },
    { nodeType: 'getNeighborAttributeByTag', configKey: 'attributeId' },
    { nodeType: 'getNeighborsAttribute', configKey: 'attributeId' },
    { nodeType: 'getNeighborsAttrByIndexes', configKey: 'attributeId' },
    { nodeType: 'setNeighborhoodAttribute', configKey: 'attributeId' },
    { nodeType: 'setNeighborAttributeByIndex', configKey: 'attributeId' },
    { nodeType: 'filterNeighbors', configKey: 'attributeId' },
  ],
  'model-attribute': [
    // `isColorAttr` is overridden per-payload at insert time.
    { nodeType: 'getModelAttribute', configKey: 'attributeId' },
  ],
  'neighborhood': [
    { nodeType: 'getNeighborAttributeByTag', configKey: 'neighborhoodId' },
    { nodeType: 'getNeighborsAttribute', configKey: 'neighborhoodId' },
    { nodeType: 'getAllNeighborIndexes', configKey: 'neighborhoodId' },
    { nodeType: 'getNeighborIndexesByTags', configKey: 'neighborhoodId' },
    { nodeType: 'neighborIndexFromTag', configKey: 'neighborhoodId' },
    { nodeType: 'setNeighborhoodAttribute', configKey: 'neighborhoodId' },
  ],
  'mapping-c2a': [
    { nodeType: 'inputColor', configKey: 'mappingId' },
  ],
  'mapping-a2c': [
    { nodeType: 'outputMapping', configKey: 'mappingId' },
    { nodeType: 'setCellLooks', configKey: 'mappingId' },
  ],
  // The agent-layer twin of `mapping-a2c`: the Agent Output Mapping event root
  // (the agent analogue of `outputMapping`) plus Set Cell Looks, which is
  // universal and colours the agent for that view.
  'agent-mapping': [
    { nodeType: 'agentOutputMapping', configKey: 'mappingId' },
    { nodeType: 'setCellLooks', configKey: 'mappingId' },
  ],
  // The agent-layer twin of `mapping-c2a`: the Agent Input Mapping event root
  // (the agent analogue of `inputColor`). Set Cell Looks is NOT offered — its
  // viewer guard compares against a COLOUR viewer, which a C→A id never is.
  'agent-mapping-c2a': [
    { nodeType: 'agentInputMapping', configKey: 'mappingId' },
  ],
  // The ONLY node that consumes a sprite id. `setSprite` is already true in the
  // node's defaultConfig, so the facet that reads `spriteId` is on out of the
  // box — but state it here too, so the drop is correct whatever that default
  // becomes.
  'sprite': [
    { nodeType: 'setAgentSprite', configKey: 'spriteId', extraConfig: { setSprite: true } },
  ],
  'indicator': [
    { nodeType: 'getIndicator', configKey: 'indicatorId' },
    { nodeType: 'setIndicator', configKey: 'indicatorId' },
    { nodeType: 'updateIndicator', configKey: 'indicatorId' },
  ],
  'variable': [
    { nodeType: 'getVariable', configKey: 'variableId' },
    { nodeType: 'setVariable', configKey: 'variableId' },
    { nodeType: 'setArrayElement', configKey: 'variableId' },
  ],
};

/** RELATED_NODES entries filtered for payload specifics. Local variables are
 *  kind-gated: `setVariable` only writes scalars, `setArrayElement` only
 *  writes array elements — offering the wrong one would just spawn a node
 *  with an instant validation badge.
 *
 *  An AGENT view is additionally gated on the ACTIVE GRAPH: its mapping id only
 *  means anything to the agent colour pass, so dropping one on the Cells (or
 *  Overseer) canvas offers NOTHING rather than a Set Cell Looks whose viewer
 *  guard could never match. `isNodeAvailable` already hides the
 *  `agentOutputMapping` root off the Agents graph, but Set Cell Looks is
 *  universal and would otherwise leak through as silent dead code. Returning
 *  an empty list also zeroes `relatedNodePotentialPorts`, so the drag shows no
 *  port highlights there either — the "nothing to offer" state is visible.
 *
 *  A SPRITE is gated the same way, for the same reason at one remove: its only
 *  consumer (Set Agent Sprite) is `requirements.bondGraph`, so `isNodeAvailable`
 *  already keeps it off the Cells / Overseer drop MENU — but the drag HIGHLIGHT
 *  (`relatedNodePotentialPorts`) never consults that gate, so without this the
 *  canvas would light up ports for a node it would then refuse to create. */
export function relatedEntriesForPayload(payload: ModelElementDragPayload): RelatedNodeEntry[] {
  const entries = RELATED_NODES[payload.kind] ?? [];
  if (payload.kind === 'agent-mapping' || payload.kind === 'agent-mapping-c2a' || payload.kind === 'sprite') {
    return getActiveGraphKind() === 'agents' ? entries : [];
  }
  if (payload.kind !== 'variable') return entries;
  return entries.filter(e => {
    if (e.nodeType === 'setVariable') return payload.varKind === 'scalar';
    if (e.nodeType === 'setArrayElement') return payload.varKind === 'array';
    return true;
  });
}

// ---------------------------------------------------------------------------
// Compatible-handle computation for the panel-drag highlight + snap-to-port
// menu filter. Given the dragged element, find every existing canvas port
// that a to-be-spawned related node could connect to.
// ---------------------------------------------------------------------------

interface PortShape {
  kind: 'input' | 'output';
  category: 'flow' | 'value';
  dataType?: string;
  isArray?: boolean;
  /** Dual-mode relay port (valueSwitch) — see PortDef.arrayCapable. */
  arrayCapable?: boolean;
}

/** All effective port shapes that a related node would expose, given the
 *  payload (most importantly, isColorAttr for color model attributes). */
function relatedNodePotentialPorts(payload: ModelElementDragPayload): PortShape[] {
  const shapes: PortShape[] = [];
  for (const entry of relatedEntriesForPayload(payload)) {
    const def = getNodeDef(entry.nodeType);
    if (!def) continue;
    // Resolve the config the new node would spawn with so getEffectivePorts
    // can branch correctly (e.g., GetModelAttribute r/g/b vs value).
    const cfg: Record<string, unknown> = {
      ...def.defaultConfig,
      ...(entry.extraConfig ?? {}),
      [entry.configKey]: 'placeholder',
    };
    if (payload.kind === 'model-attribute') cfg.isColorAttr = payload.isColor;
    const ports = getEffectivePorts(def.type, cfg);
    for (const p of [...ports.inputs, ...ports.outputs]) {
      shapes.push({ kind: p.kind, category: p.category, dataType: p.dataType, isArray: p.isArray, arrayCapable: p.arrayCapable });
    }
  }
  return shapes;
}

function shapesMate(a: PortShape, b: PortShape): boolean {
  if (a.category !== b.category) return false;
  if (a.kind === b.kind) return false;
  if (a.category === 'flow') return true;
  // Asymmetric isArray rule: scalar source → array target is fine (compilers
  // wrap as `[src]` / `[s1, s2, ...]` via inputToSources). Only array source
  // → scalar target is rejected. Matches `portsCompatible` in GraphEditor.tsx
  // — keep the two in lockstep.
  const sourceIsArray = a.kind === 'output' ? !!a.isArray : !!b.isArray;
  const targetIsArray = a.kind === 'input' ? !!a.isArray : !!b.isArray;
  // Dual-mode relay (valueSwitch arrayCapable ports): the input side can carry an
  // array even when scalar-typed, so an array source into it isn't rejected.
  // Mirrors `portsCompatible` in GraphEditor.tsx — keep the two in lockstep.
  const targetArrayCapable = a.kind === 'input' ? !!a.arrayCapable : !!b.arrayCapable;
  if (sourceIsArray && !targetIsArray && !targetArrayCapable) return false;
  const da = a.dataType ?? 'any';
  const db = b.dataType ?? 'any';
  return da === 'any' || db === 'any' || da === db;
}

/** Build the set of compatible handle keys for the current panel drag against
 *  the current canvas nodes + edges. Excludes already-occupied non-array value
 *  inputs (matching CaNode's `alreadyOccupied` check). */
export function computeCompatibleHandlesForDrag(
  payload: ModelElementDragPayload,
  nodes: Node[],
  occupiedInputs: ReadonlySet<string>,
): Set<string> {
  const result = new Set<string>();
  const potentialShapes = relatedNodePotentialPorts(payload);
  if (potentialShapes.length === 0) return result;
  for (const node of nodes) {
    if (node.type !== 'caNode') continue;
    const data = node.data as { nodeType?: string; config?: Record<string, unknown> } | undefined;
    const t = data?.nodeType;
    if (!t) continue;
    const eff = getEffectivePorts(t, data?.config ?? {});
    const allPorts: PortDef[] = [...eff.inputs, ...eff.outputs];
    for (const port of allPorts) {
      // Skip occupied non-array value inputs.
      if (port.kind === 'input' && port.category === 'value' && !port.isArray) {
        if (occupiedInputs.has(`${node.id}|${port.id}`)) continue;
      }
      const portShape: PortShape = {
        kind: port.kind, category: port.category, dataType: port.dataType, isArray: port.isArray, arrayCapable: port.arrayCapable,
      };
      const hasMate = potentialShapes.some(ns => shapesMate(portShape, ns));
      if (hasMate) {
        result.add(handleKey(node.id, port.kind, port.category, port.id));
      }
    }
  }
  return result;
}

/** Find the canvas handle nearest the drop point within `radiusPx`. Iterates
 *  the highlighted set so we don't scan every handle in the DOM. Returns the
 *  matched handle DOM element + parsed info, or null. */
export function findNearestCompatibleHandle(
  compatibleHandles: ReadonlySet<string>,
  clientX: number,
  clientY: number,
  radiusPx: number,
): {
  nodeId: string;
  portId: string;
  kind: 'input' | 'output';
  category: 'flow' | 'value';
  dataType?: string;
  isArray?: boolean;
} | null {
  if (compatibleHandles.size === 0) return null;
  let best: { dist: number; info: { nodeId: string; portId: string; kind: 'input' | 'output'; category: 'flow' | 'value' } } | null = null;
  for (const key of compatibleHandles) {
    const [nodeId, kindS, categoryS, portId] = key.split('|') as [string, string, string, string];
    if (!nodeId || !portId) continue;
    const kind = kindS as 'input' | 'output';
    const category = categoryS as 'flow' | 'value';
    const nodeEl = document.querySelector(`[data-id="${nodeId}"]`);
    if (!nodeEl) continue;
    const handleId = `${kind}_${category}_${portId}`;
    const handleEl = nodeEl.querySelector(`[data-handleid="${handleId}"]`) as HTMLElement | null;
    if (!handleEl) continue;
    const r = handleEl.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dx = cx - clientX;
    const dy = cy - clientY;
    const dist = Math.hypot(dx, dy);
    if (dist <= radiusPx && (!best || dist < best.dist)) {
      best = { dist, info: { nodeId, portId, kind, category } };
    }
  }
  if (!best) return null;
  // Re-resolve dataType / isArray for the auto-connect step using the live config.
  return best.info;
}
