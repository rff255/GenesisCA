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

export const MODEL_ELEMENT_DRAG_MIME = 'application/genesisca-model-element';

export type ModelElementDragPayload =
  | { kind: 'cell-attribute'; attributeId: string; attrType: 'bool' | 'integer' | 'float' | 'tag' | 'color' | 'neighborIndex' }
  | { kind: 'model-attribute'; attributeId: string; isColor: boolean }
  | { kind: 'neighborhood'; neighborhoodId: string }
  | { kind: 'mapping-a2c'; mappingId: string }
  | { kind: 'mapping-c2a'; mappingId: string }
  | { kind: 'indicator'; indicatorId: string };

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
    case 'indicator': return payload.indicatorId;
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
    { nodeType: 'setColorViewer', configKey: 'mappingId' },
  ],
  'indicator': [
    { nodeType: 'getIndicator', configKey: 'indicatorId' },
    { nodeType: 'setIndicator', configKey: 'indicatorId' },
    { nodeType: 'updateIndicator', configKey: 'indicatorId' },
  ],
};
