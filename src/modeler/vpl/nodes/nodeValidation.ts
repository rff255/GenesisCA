import type { NodeConfig, NodeTypeDef } from '../types';
import { parseHandleId } from '../types';
import type { CAModel } from '../../../model/types';
import { cellFieldAttrsOf, BOND_ATTRIBUTE_TYPES } from '../../../model/attributeScope';
import { agentNodeRequirement, nodeSatisfiesCapabilities, resolveAgentProfile, capReqLabel } from '../../../model/agentCapabilities';
import { getNodeDef } from './registry';
import { CURRENT_VIEWER_SENTINEL } from './SetCellLooksNode';
import { buildVarMap, parseExpression, clampVisibleCount } from '../compiler/expression/parser';
import { getActiveGraphKind } from '../graphState';
import { VECTOR_LOWERED } from '../compiler/vectorAttr';
import { multiAttrSlotIndices, slotAttrKey } from '../compiler/multiAttrExpand';
import { censusAttribute, censusOptions } from '../compiler/censusExpand';
import { isGraphFrequencyMetric, type GraphMetric } from '../../../simulator/engine/graphMetrics';
import { indicatorScalarBlocker } from '../../../model/indicatorValue';
import { isMultiAxisTable, resolveAxes, MAX_LOOKUP_TABLE_ENTRIES } from '../compiler/variegation';
import { is3dModelLike } from '../compiler/niCodec';
import { inputBrushKindForNode, inputParamsForNode } from '../../../model/inputMappingParams';

/** Return a list of human-readable issue strings for a node's configuration.
 *  Empty array = node is fully configured.
 *
 *  The rules here mirror the compile-time fallbacks in `compiler/compile.ts`
 *  (which emit `_undef` placeholders for unresolved references). A warning badge
 *  in the UI surfaces these cases before the user runs the simulation.
 *
 *  `connectedHandles` (optional): set of raw handle IDs (e.g.
 *  `input_value_indexes`) that have at least one incoming edge. The format
 *  matches what `graphState.getConnectedHandlesForNode` returns. Used to flag
 *  required array inputs that the user forgot to wire up — without this,
 *  nodes like `filterNeighbors` silently produce empty results because their
 *  compile() emit falls back to `[]` for unconnected array inputs (Wave A.6
 *  dropped the implicit-all default). When omitted, edge-dependent checks
 *  are skipped (preserves callers without easy access to edges). */
/** Input-mapping ROOTS (`inputColor` / `agentInputMapping`): their value outputs
 *  are DYNAMIC — one per resolved CHANNEL of the referenced mapping's declared
 *  `parameters`. Two things are worth badging, and BOTH need the connected-handle
 *  set (which records output handles too), because neither is an error in the
 *  abstract:
 *    · a mapping that declares NO parameters (`parameters: []`) is a perfectly
 *      valid "stamp" mapping — unless the root is actually WIRED from a value
 *      port, in which case the graph reads something that does not exist;
 *    · an edge from a port the parameters no longer produce (a deleted / retyped
 *      parameter) — the same STALE CHANNEL the compiler reports by name. */
function inputParamIssues(
  nodeType: string,
  config: NodeConfig,
  model: CAModel,
  connectedHandles?: ReadonlySet<string>,
): string[] {
  if (!connectedHandles) return [];
  const wired: string[] = [];
  for (const h of connectedHandles) {
    if (h.startsWith('output_value_')) wired.push(h.slice('output_value_'.length));
  }
  if (wired.length === 0) return [];
  const resolved = inputParamsForNode(nodeType, config, model);
  if (resolved.channels.length === 0) {
    return ['This mapping declares no parameters — the wired value outputs do not exist'];
  }
  const live = new Set(resolved.channels.map(c => c.portId));
  const stale = wired.filter(p => !live.has(p));
  return stale.length > 0
    ? [`Wired from a parameter this mapping no longer declares (${stale.join(', ')})`]
    : [];
}

export function detectMissingConfig(
  nodeType: string,
  config: NodeConfig,
  model: CAModel,
  connectedHandles?: ReadonlySet<string>,
): string[] {
  const issues: string[] = [];
  /** Raw handle name — encoded by graphState as `input_value_<portId>` or
   *  `input_flow_<portId>`. Both forms are checked because flow-input ports
   *  use the same encoding. */
  const isInputConnected = (portId: string): boolean | undefined => {
    if (!connectedHandles) return undefined;
    return connectedHandles.has(`input_value_${portId}`)
      || connectedHandles.has(`input_flow_${portId}`);
  };

  // A stored `vector` attribute is LOWERED (into per-component Make/Break Vector, or
  // config-slot expansion for moveSelfToNeighbor) before compile for every node in
  // `VECTOR_LOWERED` — the own Get/Set, the neighbour reads, the by-id agent
  // read/write, the neighbour writes, and moveSelfToNeighbor. Any OTHER node that
  // references a vector attribute is NOT lowered: it emits `r_<id>[…]` / `w_<id>[…]`
  // against the component-expanded buffer that has no `<id>` array, so the step
  // crashes at run time with `r_<id>/w_<id> is not defined`. Surface it as a badge
  // here so the user sees it in the modeler instead. These are the shapes with no
  // vector representation: array-of-vectors reads (`getNeighborsAttribute` /
  // `getAgentsAttribute` / `getNeighborsAttrByIndexes`), `filterNeighbors` (scalar
  // comparison), `updateAttribute` (inc/dec/max/min undefined on a vector), and the
  // field-bridge nodes — read this one via Get Cell Attribute + Break Vector instead.
  // The check covers both the common `config.attributeId` key AND moveSelfToNeighbor's
  // per-slot `attr_${i}` payload keys (but moveSelfToNeighbor IS lowered, so it's
  // exempt via VECTOR_LOWERED).
  if (!VECTOR_LOWERED.has(nodeType)) {
    const isVectorAttrId = (id: unknown): boolean =>
      typeof id === 'string' && !!id &&
      [...model.attributes, ...(model.agentAttributes ?? [])].some(x => x.id === id && x.type === 'vector');
    if (isVectorAttrId(config.attributeId)) {
      issues.push('This node can’t read/write a Vector attribute — read it via Get (Self) Attribute + Break Vector (or Get Neighbor Attr / Get Agent Attribute for a neighbour/agent), then wire the components.');
    }
  }

  const hasCellAttr = (id: unknown) =>
    typeof id === 'string' && id.length > 0 &&
    model.attributes.some(a => a.id === id && !a.isModelAttribute);
  // Generic Agent Platform: the agent attribute set (separate id-space).
  const hasAgentAttr = (id: unknown) =>
    typeof id === 'string' && id.length > 0 &&
    (model.agentAttributes ?? []).some(a => a.id === id);
  // Graph-Rewriting Automata (P2): the BOND attribute set (per-EDGE state — a
  // third id-space). Checks the RAW list so a bonds-off model still tells the user
  // "select an attribute" vs. the capability badge that says bonds are off.
  const hasBondAttr = (id: unknown) =>
    typeof id === 'string' && id.length > 0 &&
    (model.bondAttributes ?? []).some(a => a.id === id);
  // getCellAttribute/setAttribute/updateAttribute are UNIVERSAL — they read/write
  // the OWN cell on the Cells graph (a cell attr) or the OWN agent on the Agents
  // graph (an agent attr). The node carries no graph-kind, so accept EITHER id;
  // the (graph-aware) dropdown prevents picking the wrong one.
  const hasOwnAttr = (id: unknown) => hasCellAttr(id) || hasAgentAttr(id);
  /** A cell attribute the agents may read via the field bridge (agentAccess
   *  read|readWrite). */
  const hasFieldReadAttr = (id: unknown) =>
    typeof id === 'string' && id.length > 0 &&
    model.attributes.some(a => a.id === id && !a.isModelAttribute &&
      (a.agentAccess === 'read' || a.agentAccess === 'readWrite'));
  /** A cell attribute the agents may write via the field bridge (readWrite). */
  const hasFieldWriteAttr = (id: unknown) =>
    typeof id === 'string' && id.length > 0 &&
    model.attributes.some(a => a.id === id && !a.isModelAttribute && a.agentAccess === 'readWrite');
  const hasModelAttr = (id: unknown) =>
    typeof id === 'string' && id.length > 0 &&
    model.attributes.some(a => a.id === id && a.isModelAttribute);
  // Tag-attribute pickers (Get Constant / Compare tag mode) reference a tag
  // attribute for its OPTION NAMES. Graph-aware scope = every attribute whose
  // discrete value the active graph can read/compare: Cells graph → model.attributes
  // (cell + model); Agents graph → agent attributes + agent-accessible CELL FIELD
  // attributes (agentAccess read|readWrite — an agent samples/deposits a discrete
  // cell field and then compares it) + shared model attributes. Without this an
  // agent (or cell field) tag attribute triggers a false "Select a tag attribute"
  // badge on the Agents graph. Mirrors CaNode's tagAttrScope.
  const tagAttrScope = () => getActiveGraphKind() === 'agents'
    ? [...(model.agentAttributes ?? []), ...cellFieldAttrsOf(model), ...model.attributes.filter(a => a.isModelAttribute)]
    : model.attributes;
  const findTagAttr = (id: unknown) =>
    typeof id === 'string' && id.length > 0
      ? tagAttrScope().find(a => a.id === id)
      : undefined;
  const hasTagAttr = (id: unknown) => !!findTagAttr(id);
  const hasNeighborhood = (id: unknown) =>
    typeof id === 'string' && id.length > 0 &&
    model.neighborhoods.some(n => n.id === id);
  const hasMapping = (id: unknown) =>
    typeof id === 'string' && id.length > 0 &&
    model.mappings.some(m => m.id === id);
  // Generic Agent Platform: the AGENT Attribute→Color views (separate id-space
  // from the cell mappings). Used by agentOutputMapping + by setCellLooks on the
  // Agents graph (which colours an agent for an agent viewer).
  /** Direction-scoped agent-mapping checks. `agentMappings` holds BOTH directions
   *  (discriminated by `isAttributeToColor`, like the cell list), so an A->C root
   *  pointed at a C->A mapping (or vice versa) would compile to a pass nothing
   *  ever runs -- badge it instead. */
  const hasAgentMappingDir = (id: unknown, a2c: boolean) =>
    typeof id === 'string' && id.length > 0 &&
    (model.agentMappings ?? []).some(m => m.id === id && m.isAttributeToColor === a2c);
  const hasIndicator = (id: unknown) =>
    typeof id === 'string' && id.length > 0 &&
    (model.indicators || []).some(i => i.id === id);
  const hasMacroDef = (id: unknown) =>
    typeof id === 'string' && id.length > 0 &&
    (model.macroDefs || []).some(m => m.id === id);

  /** Multi-attribute slots: every EXTRA slot must resolve in the node's scope
   *  (same rule per node type as the primary `attributeId` check). */
  const checkSlots = (has: (id: unknown) => boolean, what: string): void => {
    for (const i of multiAttrSlotIndices(config)) {
      if (!has(config[slotAttrKey(i)])) issues.push(`Select ${what} (slot ${i})`);
    }
  };

  switch (nodeType) {
    case 'getCellAttribute':
      // Universal: a cell attr (Cells graph) OR an agent attr (Agents graph).
      if (!hasOwnAttr(config.attributeId)) issues.push('Select an attribute');
      checkSlots(hasOwnAttr, 'an attribute');
      break;

    case 'getModelAttribute':
      if (!hasModelAttr(config.attributeId)) issues.push('Select a model attribute');
      checkSlots(hasModelAttr, 'a model attribute');
      break;

    case 'setAttribute':
    case 'updateAttribute':
      // Universal: a cell attr (Cells graph) OR an agent attr (Agents graph).
      if (!hasOwnAttr(config.attributeId)) issues.push('Select an attribute');
      if (nodeType === 'setAttribute') checkSlots(hasOwnAttr, 'an attribute');
      break;

    // Grid Init Event write primitive — always writes a CELL attribute.
    case 'setCellAtPosition':
      if (!hasCellAttr(config.attributeId)) issues.push('Select an attribute');
      break;

    // Generic Agent Platform — field-bridge READ nodes: the cell attribute must
    // be agent-readable (agentAccess read|readWrite), or the field channel param
    // isn't threaded and the emit references `_field__undef`.
    case 'sampleField':
    case 'fieldGradient':
    case 'readCellsUnder':
      if (!hasCellAttr(config.attributeId)) issues.push('Select a field (cell) attribute');
      else if (!hasFieldReadAttr(config.attributeId)) issues.push('This cell attribute is not agent-accessible — set its Agent access to Read or Read & Write');
      break;
    // Field-bridge WRITE nodes: the cell attribute must be agent-writable (readWrite).
    case 'affectCellsUnder':
    case 'secreteToField':
      if (!hasCellAttr(config.attributeId)) issues.push('Select a field (cell) attribute');
      else if (!hasFieldWriteAttr(config.attributeId)) issues.push('This cell attribute is read-only to agents — set its Agent access to Read & Write');
      break;

    // Generic Agent Platform — other-agent attribute read/write (by id) + the
    // agent-equivalent gather / filter / write-many nodes. All target the AGENT
    // attribute set.
    case 'getAgentAttribute':
    case 'setAgentAttribute':
      // Single-agent (scalar agentId) — only the attribute is required.
      if (!hasAgentAttr(config.attributeId)) issues.push('Select an agent attribute');
      checkSlots(hasAgentAttr, 'an agent attribute');
      break;

    case 'getAgentsAttribute':
    case 'setAgentsAttribute':
    case 'filterAgents':
      // Array-consuming: an unconnected Agents input falls back to `[]` and
      // silently produces an empty/no-op result (mirrors the lattice Filter /
      // Get-Neighbors-Attr badge).
      if (!hasAgentAttr(config.attributeId)) issues.push('Select an agent attribute');
      if (isInputConnected('agents') === false) {
        issues.push('Connect an Agents input (e.g. from Get Nearby Agents or Get Bonded Agents)');
      }
      break;

    // Graph-Rewriting Automata (P5) — the DIVISION BOND PARTITION. A
    // `byBondAttribute` partition whose attribute was deleted / is of an
    // unusable type DEGRADES TO the geometric split in the engine, so the badge
    // is what stops that being a silent mis-partition.
    case 'divideAgent':
      if (String(config.partition ?? 'tension') === 'byBondAttribute') {
        if (!hasBondAttr(config.partitionAttributeId)) {
          issues.push('Select a bond attribute for the partition (it falls back to the tension axis otherwise)');
        } else if ((model.bondAttributes ?? []).some(
          a => a.id === config.partitionAttributeId && !BOND_ATTRIBUTE_TYPES.includes(a.type))) {
          issues.push('That bond attribute type cannot select a daughter (use binary / integer / decimal / tag)');
        }
      }
      break;

    // Graph-Rewriting Automata (P2) — per-EDGE state, keyed by the partner id.
    case 'getBondAttribute':
    case 'setBondAttribute':
      if (!hasBondAttr(config.attributeId)) issues.push('Select a bond attribute');
      if (isInputConnected('partnerId') === false) {
        issues.push('Connect a Partner input (e.g. from For Each Bond or Get Bonded Agents)');
      }
      break;

    case 'neighbourCensus': {
      // The output ports ARE the attribute's state values, so an unset / removed /
      // no-longer-enumerable attribute means the node has nothing to count.
      if (!censusAttribute(config, model)) {
        issues.push('Select a tag or binary agent attribute (its state values become the count ports)');
      } else if (censusOptions(censusAttribute(config, model)).length === 0) {
        issues.push('The chosen tag attribute has no options yet — add some to get count ports');
      }
      // The capability gate is TYPE-level (Bonds or Sensing), so it cannot tell the
      // two sources apart. Badge the config-specific mismatch here instead: a
      // bonded census in a bonds-off model reads an empty 1-ring every step, and a
      // nearby census with Sensing off reads an empty proximity set.
      const prof = model.centerBased?.agentCapabilities;
      if (prof) {
        if (config.source === 'nearby') {
          if (!prof.sensing) issues.push('Nearby source needs the Sensing capability (Properties › Bond-Graph Agents)');
        } else if (prof.bonds === 'off') {
          issues.push('Bonded source needs the Bonds capability (Properties › Bond-Graph Agents)');
        }
      }
      break;
    }

    case 'joinAgents':
      if (isInputConnected('a') === false) issues.push('Connect input A');
      if (isInputConnected('b') === false) issues.push('Connect input B');
      break;

    case 'pickRandomAgent':
    case 'pickNRandomAgents':
      if (isInputConnected('agents') === false) {
        issues.push('Connect an Agents input (e.g. from Get Nearby Agents or Filter Agents)');
      }
      break;

    case 'getNeighborsAttribute':
    case 'setNeighborhoodAttribute':
      // Wave A.6: nodes that walk a configured neighborhood — both nbrId
      // and attrId required.
      if (!hasNeighborhood(config.neighborhoodId)) issues.push('Select a neighborhood');
      if (!hasCellAttr(config.attributeId)) issues.push('Select a cell attribute');
      break;

    case 'getNeighborAttributeByIndex':
    case 'setNeighborAttributeByIndex':
      // Wave A.6: NI-consuming nodes — only attrId required. The NI input
      // carries its own (dr, dc) offset; no neighborhood needed. The scalar
      // `index` input has a sensible fallback (NI=0 = self) so we don't
      // require it; users get the centre cell which the warning badge can't
      // distinguish from intentional self-reference.
      if (!hasCellAttr(config.attributeId)) issues.push('Select a cell attribute');
      break;

    case 'filterNeighbors':
    case 'getNeighborsAttrByIndexes':
      // Wave A.6: array-consuming NI nodes. Indexes input is required —
      // the implicit-all default was dropped in A.6, so an unconnected
      // input falls back to `[]` and silently produces an empty result.
      if (!hasCellAttr(config.attributeId)) issues.push('Select a cell attribute');
      if (isInputConnected('indexes') === false) {
        issues.push('Connect an Indexes input (e.g. from Get All Neighbor Indexes)');
      }
      break;

    case 'pickRandomNeighbor':
    case 'pickNRandomNeighbors':
      // Returns INVALID_NI / empty array when input is unconnected. Surface
      // it explicitly so the user doesn't wonder why nothing happens.
      if (isInputConnected('indexes') === false) {
        issues.push('Connect an Indexes input (e.g. from Filter Neighbors or Get All Neighbor Indexes)');
      }
      break;

    case 'getRandom':
      // Options mode requires a wired Options input — without one the node
      // unconditionally emits the Fallback value, which is almost never the
      // user's intent. Other modes (bool/integer/float) need no extra config.
      if ((config.randomType as string) === 'options') {
        if (isInputConnected('options') === false) {
          issues.push('Options mode: wire one or more sources to the Options input');
        }
      }
      break;

    case 'forEachInArray':
      if (isInputConnected('array') === false) {
        issues.push('Connect an Array input — body will not execute otherwise');
      }
      break;

    case 'joinNeighbors':
      if (isInputConnected('a') === false) {
        issues.push('Connect input A');
      }
      if (isInputConnected('b') === false) {
        issues.push('Connect input B');
      }
      break;

    case 'arrayElement':
    case 'arrayLength':
      if (isInputConnected('array') === false) {
        issues.push('Connect an Array input');
      }
      break;

    case 'getNeighborAttributeByTag': {
      if (!hasNeighborhood(config.neighborhoodId)) issues.push('Select a neighborhood');
      if (!hasCellAttr(config.attributeId)) issues.push('Select a cell attribute');
      const tagName = config.tagName;
      if (typeof tagName !== 'string' || tagName.length === 0) {
        issues.push('Select a tag');
      } else if (typeof config.neighborhoodId === 'string') {
        const nbr = model.neighborhoods.find(n => n.id === config.neighborhoodId);
        const tagValues = nbr?.tags ? Object.values(nbr.tags) : [];
        if (nbr && !tagValues.includes(tagName)) {
          issues.push(`Tag "${tagName}" not found in neighborhood`);
        }
      }
      break;
    }

    case 'getAllNeighborIndexes':
      // Wave A.6: needs the neighborhood to know which (dr, dc) offsets to
      // enumerate. Emits literal packed NIs.
      if (!hasNeighborhood(config.neighborhoodId)) issues.push('Select a neighborhood');
      break;

    case 'neighborIndexFromTag': {
      // Wave A.6: tags are per-neighborhood, so the neighborhood is still
      // load-bearing (resolved to packed (dr, dc) at compile time).
      if (!hasNeighborhood(config.neighborhoodId)) {
        issues.push('Select a neighborhood');
      } else {
        const tagName = config.tagName;
        if (typeof tagName !== 'string' || tagName.length === 0) {
          issues.push('Select a tag');
        } else {
          const nbr = model.neighborhoods.find(n => n.id === config.neighborhoodId);
          const tagValues = nbr?.tags ? Object.values(nbr.tags) : [];
          if (nbr && !tagValues.includes(tagName)) {
            issues.push(`Tag "${tagName}" not found in neighborhood`);
          }
        }
      }
      break;
    }

    // Wave A.6: neighborIndexFromOffset and flipNeighborIndex have no required
    // config — dr/dc are runtime inputs; flip mode has a default.

    case 'getNeighborIndexesByTags': {
      if (!hasNeighborhood(config.neighborhoodId)) issues.push('Select a neighborhood');
      const tagCount = Number(config.tagCount) || 0;
      if (tagCount === 0) {
        issues.push('Add at least one tag');
      } else {
        // Require at least one tag row to have a non-empty tag name
        let anyFilled = false;
        for (let i = 0; i < tagCount; i++) {
          const name = config[`tag_${i}_name`];
          if (typeof name === 'string' && name.length > 0) { anyFilled = true; break; }
        }
        if (!anyFilled) issues.push('Select a tag name');
      }
      break;
    }

    case 'setCellLooks':
      // The "Current Simulator Selected" sentinel is always valid — it targets
      // whichever viewer is active at runtime, not a model mapping. Accept a CELL
      // mapping (Cells graph) OR an AGENT mapping (Agents graph — colours an agent).
      // The AGENT arm is direction-scoped: Set Cell Looks writes a COLOUR, so a
      // C->A input-mapping id there is dead code (its `_isV_` guard compares
      // against a colour viewer, which a C->A id never is). The picker already
      // filters; this badges a pasted / hand-edited config.
      if (config.mappingId !== CURRENT_VIEWER_SENTINEL
        && !hasMapping(config.mappingId) && !hasAgentMappingDir(config.mappingId, true)) {
        issues.push('Select a mapping');
      }
      // The 3D voxel renderer consumes only the RGBA colors buffer — glyph
      // output silently doesn't render there.
      if (config.useGlyph === true
        && model.properties.dimension === '3d' && (model.properties.gridDepth ?? 1) > 1) {
        issues.push('Glyphs are not rendered in the 3D view (background color only)');
      }
      break;

    case 'inputColor':
    case 'outputMapping':
      if (!hasMapping(config.mappingId)) issues.push('Select a mapping');
      if (nodeType === 'inputColor') issues.push(...inputParamIssues(nodeType, config, model, connectedHandles));
      break;

    // Generic Agent Platform — the agent analogue of outputMapping. Roots a
    // per-agent colour/exhibition pass over an AGENT mapping.
    case 'agentOutputMapping':
      if (!hasAgentMappingDir(config.mappingId, true)) issues.push('Select an agent view (mapping)');
      break;

    // The agent analogue of inputColor -- roots a single-agent graph the Paint
    // brush runs on each painted agent (its C->A mapping is the brush tab).
    case 'agentInputMapping':
      if (!hasAgentMappingDir(config.mappingId, false)) issues.push('Select an agent input mapping');
      issues.push(...inputParamIssues(nodeType, config, model, connectedHandles));
      break;

    case 'setAgentSprite':
      // Only the "Change sprite" facet needs a sprite asset; the frame/speed-only
      // uses (untick Change sprite) need none.
      if (config.setSprite !== false && !(model.sprites ?? []).some(s => s.id === config.spriteId)) {
        issues.push('Select a sprite (or untick "Change sprite")');
      }
      break;

    case 'setIndicator':
    case 'updateIndicator':
      if (!hasIndicator(config.indicatorId)) issues.push('Select an indicator');
      break;

    // Get Indicator READS, so it accepts any indicator whose value is a single
    // number (standalone / linked Total / a scalar graph metric). A frequency map,
    // a degree histogram or a spatial curve has no single value to read — badge it
    // with the shape rather than letting the node emit a meaningless slot read.
    case 'getIndicator': {
      const ind = (model.indicators || []).find(i => i.id === config.indicatorId);
      if (!ind) { issues.push('Select an indicator'); break; }
      const blocker = indicatorScalarBlocker(ind);
      if (blocker) issues.push(`"${ind.name}" is ${blocker} — pick a single-value indicator`);
      break;
    }

    // Overseer nodes — required configs. (Series names are free strings with
    // defaults, so only the reference-typed configs badge.)
    case 'ovSetModelAttribute':
      if (!model.attributes.some(a => a.isModelAttribute && a.id === config.attributeId)) {
        issues.push('Select a model attribute');
      }
      break;
    case 'ovRandomizeTable':
      if (!model.attributes.some(a => a.isModelAttribute && a.type === 'lookupTable' && a.id === config.tableId)) {
        issues.push('Select a Lookup Table');
      }
      break;
    case 'ovLoadPreset':
      if (!(model.presets ?? []).some(p => p.id === config.presetId)) {
        issues.push('Select a preset');
      }
      break;
    case 'ovReadIndicator': {
      const ind = (model.indicators ?? []).find(i => i.id === config.indicatorId);
      if (!ind) { issues.push('Select an indicator'); break; }
      // Spatial indicators are position-binned arrays, not scalars — excluded
      // (same boundary as End Conditions).
      if (ind.kind === 'linked' && ind.xAxis && ind.xAxis !== 'generation') {
        issues.push('Spatial indicators (rows/columns/layers axis) cannot be read as a scalar');
      }
      // GRA P6 — a frequency-shaped GRAPH metric (degree histogram) needs a
      // category (the degree bucket) exactly like a linked-frequency indicator.
      const isFreq = (ind.kind === 'linked' && (ind.linkedAggregation ?? 'frequency') === 'frequency')
        || (ind.kind === 'graph' && isGraphFrequencyMetric((ind.graphMetric ?? 'nodeCount') as GraphMetric));
      if (isFreq && !String(config.category ?? '')) {
        issues.push('Pick the frequency category to read');
      }
      break;
    }
    case 'ovCollectSample':
    case 'ovClearSeries':
    case 'ovSeriesStat':
      if (!String(config.series ?? '').trim()) issues.push('Name the sample series');
      break;
    case 'ovCollectSpatial': {
      // The inverse of ovReadIndicator: this one requires a SPATIAL indicator.
      if (!String(config.series ?? '').trim()) issues.push('Name the spatial series');
      const sInd = (model.indicators ?? []).find(i => i.id === config.indicatorId);
      if (!sInd) { issues.push('Select a spatial indicator'); break; }
      const isSpatial = sInd.kind === 'linked' && sInd.xAxis && sInd.xAxis !== 'generation';
      if (!isSpatial) { issues.push('The indicator must have a spatial X-axis (rows / columns / layers)'); break; }
      const spatialFreq = (sInd.linkedAggregation ?? 'frequency') === 'frequency';
      if (spatialFreq && !String(config.category ?? '')) {
        issues.push('Pick the category (series) to capture');
      }
      break;
    }
    case 'ovSweepValues':
      if (config.mode !== 'linspace') {
        const anyVal = String(config.list ?? '').split(',').some(s => Number.isFinite(parseFloat(s.trim())));
        if (!anyVal) issues.push('Enter at least one sweep value');
      }
      break;

    case 'getConstant':
      if (config.constType === 'tag') {
        if (!hasTagAttr(config.tagAttributeId)) {
          issues.push('Select a tag attribute');
        } else {
          const attr = findTagAttr(config.tagAttributeId);
          if (attr && attr.type !== 'tag') issues.push('Selected attribute is not a tag type');
        }
      } else if (config.constType === 'faceLabel') {
        if (!model.variegatedCells?.enabled) {
          issues.push('Face Label requires Variegated Cells enabled');
        } else {
          const palettes = model.variegatedCells?.facePalettes ?? [];
          const palId = String(config.facePaletteId ?? '');
          const pal = palettes.find(p => p.id === palId) ?? palettes[0];
          const labels = pal?.labels ?? [];
          const name = String(config.constValue ?? 'none');
          if (name !== 'none' && !labels.includes(name)) {
            issues.push(`Face label "${name}" not in the selected palette`);
          }
        }
      }
      break;

    case 'statement':
      if (config.compareType === 'tag') {
        if (!hasTagAttr(config.tagAttributeId)) {
          issues.push('Select a tag attribute');
        } else {
          const attr = findTagAttr(config.tagAttributeId);
          if (attr && attr.type !== 'tag') issues.push('Selected attribute is not a tag type');
        }
      }
      break;

    case 'expression': {
      const visibleCount = clampVisibleCount(config.visibleCount);
      const { map, errors } = buildVarMap(config, visibleCount);
      for (const e of errors) issues.push(e);
      const formula = String(config.expression ?? '');
      if (!formula.trim()) {
        issues.push('Enter a formula');
      } else if (errors.length === 0) {
        const res = parseExpression(formula, map);
        if ('error' in res) issues.push(`Formula error: ${res.error}`);
      }
      break;
    }

    // Rotate Around Axis is Rodrigues about an arbitrary 3D axis — a 2D model
    // has no Z, so a stale config carrying it (authored in 3D, or hand-edited)
    // would silently degenerate. The op is filtered out of the 2D dropdown; this
    // badge surfaces the leftover.
    case 'vectorOp':
      if (config.op === 'rotateAxis' && !is3dModelLike(model)) {
        issues.push('Rotate Around Axis needs a 3D model (use Rotate for the XY plane)');
      }
      break;

    case 'macro':
      if (!hasMacroDef(config.macroDefId)) issues.push('Macro definition not found');
      break;

    case 'stopEvent': {
      const msg = config.message;
      if (typeof msg !== 'string' || msg.trim().length === 0) {
        issues.push('Set a stop message');
      }
      break;
    }

    case 'getFacingLabels':
    case 'getFacingOrientation':
    case 'setFacingOrientation': {
      // Face encounters are intrinsic to the grid (1 step in 1 of 8 fixed
      // directions). No neighborhood needed — just pick a direction.
      const tag = config.directionTag;
      const VALID = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
      if (typeof tag !== 'string' || tag.length === 0) {
        issues.push('Pick a direction (N/E/S/W or a diagonal)');
      } else if (!VALID.includes(tag)) {
        issues.push(`Direction "${tag}" is not one of N/NE/E/SE/S/SW/W/NW`);
      }
      break;
    }

    case 'lookupInteraction':
    case 'interactionTableMap': {
      const tableId = config.tableId;
      if (typeof tableId !== 'string' || tableId.length === 0) {
        issues.push('Select a Lookup Table');
      } else {
        const attr = model.attributes.find(a => a.id === tableId);
        if (!attr) issues.push('Selected Lookup Table no longer exists');
        else if (attr.type !== 'lookupTable') issues.push('Selected attribute is not a Lookup Table');
        else if (isMultiAxisTable(attr)) {
          // BOTH checks run for a multi-axis table (they are independent — the
          // size check must NOT sit in a sibling else-if the Table Map branch
          // shadows, or an oversized 2-axis Table Map is never size-badged).
          const r = resolveAxes(attr, model);
          // Table Map's shape is two parallel index arrays — a multi-axis table
          // fits only when it has exactly 2 axes (else the compilers emit empty).
          if (nodeType === 'interactionTableMap' && r.axes.length !== 2) {
            issues.push(`Table Map needs a 2-axis table (this one has ${r.axes.length} axes) — use Table Lookup instead`);
          }
          if (r.total > MAX_LOOKUP_TABLE_ENTRIES) {
            issues.push(`Lookup Table too large (${r.total.toLocaleString()} entries > ${MAX_LOOKUP_TABLE_ENTRIES.toLocaleString()})`);
          }
        }
      }
      break;
    }

    case 'getVariable':
    case 'setVariable':
    case 'setArrayElement': {
      const variableId = config.variableId;
      // Generic Agent Platform: resolve against the active graph's variable set
      // (agent graph → agentVariables, cell graph → variables). The two are
      // disjoint id-spaces; checking both avoids a false "no longer exists" badge
      // when this validation runs without a definite graph context.
      const variables = getActiveGraphKind() === 'agents'
        ? (model.agentVariables || [])
        : (model.variables || []);
      if (typeof variableId !== 'string' || variableId.length === 0) {
        issues.push('Select a Local Variable');
      } else {
        const v = variables.find(x => x.id === variableId);
        if (!v) {
          issues.push('Selected variable no longer exists');
        } else if (nodeType === 'setVariable' && v.kind !== 'scalar') {
          issues.push('Selected variable is an Array — use Set Array Element instead');
        } else if (nodeType === 'setArrayElement' && v.kind !== 'array') {
          issues.push('Selected variable is a Scalar — use Set Variable instead');
        }
      }
      break;
    }

    case 'moveSelfToNeighbor': {
      const payloadCount = Math.max(1, Number(config.payloadCount) || 1);
      let anySlotConfigured = false;
      for (let i = 0; i < payloadCount; i++) {
        const attrId = config[`attr_${i}`];
        if (typeof attrId === 'string' && attrId.length > 0) {
          anySlotConfigured = true;
          if (!hasCellAttr(attrId)) {
            issues.push(`Attribute ${i + 1}: selected attribute no longer exists`);
          }
        }
      }
      if (!anySlotConfigured && !config.includeOrientation) {
        issues.push('Configure at least one attribute to transfer or enable Include Orientation');
      }
      if (config.includeOrientation && !model.variegatedCells?.enabled) {
        issues.push('Include Orientation requires Variegated Cells to be enabled');
      }
      break;
    }
    // L2 — Periodic Step. `period` must be ≥ 1: 0 makes `gen % period` a
    // divide-by-zero, which the Math node maps to 0, so the gate would fire on
    // every generation at phase 0 — wrong AND silent. `phase` is folded into
    // [0, period) by the lowering, but a phase the user typed past the period is
    // almost certainly a mistake, so say so.
    case 'periodicStep': {
      const period = Number(config.period);
      if (!Number.isFinite(period) || Math.floor(period) < 1) {
        issues.push('Period must be a whole number of 1 or more.');
      } else {
        const phase = Number(config.phase);
        if (Number.isFinite(phase) && (phase < 0 || Math.floor(phase) >= Math.floor(period))) {
          issues.push(`Phase must be between 0 and ${Math.floor(period) - 1} for a period of ${Math.floor(period)}.`);
        }
      }
      break;
    }
    case 'getAgentsInView':
    case 'senseHemifield': {
      // The FOV `facing` heading source reads a stored VECTOR agent attribute (a
      // direction). Requires a valid vector attr + the Orientation capability
      // (which represents "this model uses a stored facing").
      if (config.headingSource === 'facing') {
        const attrId = config.facingAttributeId;
        const attr = typeof attrId === 'string'
          ? (model.agentAttributes ?? []).find(a => a.id === attrId) : undefined;
        if (!attr || attr.type !== 'vector') {
          issues.push('Facing heading source: select a vector agent attribute (the stored direction).');
        } else if (!resolveAgentProfile(model).orientation) {
          issues.push('The Facing heading source needs the Orientation capability. Enable it in Model Properties > Agent Capabilities.');
        }
      }
      break;
    }
  }

  return issues;
}

/**
 * Walk a macro's subgraph and return the total count of internal-node
 * configuration warnings (and, if `useWebGPU`, WebGPU incompatibilities).
 *
 * Recurses into nested macros up to `MAX_MACRO_DEPTH` (mirrors the macro
 * inliner's recursion guard in `compiler/compile.ts`). Boundary nodes
 * (`macroInput`, `macroOutput`) and structural-only nodes (`commentNode`,
 * `groupNode`) carry no validateable config and are skipped.
 *
 * Used by CaNode to "bubble up" warnings from internal nodes onto the macro
 * instance's amber `!` badge, so misconfigurations are visible without
 * expanding the macro.
 */
const MAX_MACRO_DEPTH = 20;

export function countMacroSubgraphIssues(
  macroDefId: string,
  model: CAModel,
  useWebGPU: boolean,
  useWasm: boolean = false,
  depth: number = 0,
): number {
  if (depth > MAX_MACRO_DEPTH) return 0;
  const def = (model.macroDefs || []).find(m => m.id === macroDefId);
  if (!def) return 0;
  // Build a per-internal-node "connected input ports" map from the macroDef's
  // edges so detectMissingConfig can flag required-array-input misses
  // (e.g. filterNeighbors with no Indexes input). The pub/sub system that
  // CaNode uses for the main graph only tracks main-graph edges, so for
  // macro internals we compute it locally each time. Cheap — a typical macro
  // has tens of edges.
  // Build raw-handle set per node (matches graphState.getConnectedHandlesForNode
  // format so detectMissingConfig's isInputConnected can resolve port IDs the
  // same way for both main-graph and macro-internal nodes).
  const connectedByNode = new Map<string, Set<string>>();
  for (const edge of def.edges) {
    if (!edge.target || !edge.targetHandle) continue;
    if (!parseHandleId(edge.targetHandle)) continue; // skip malformed handles
    let s = connectedByNode.get(edge.target);
    if (!s) { s = new Set(); connectedByNode.set(edge.target, s); }
    s.add(edge.targetHandle);
  }
  let count = 0;
  for (const node of def.nodes) {
    const t = node.data?.nodeType;
    if (!t) continue;
    if (t === 'macroInput' || t === 'macroOutput' || t === 'commentNode' || t === 'groupNode') continue;
    const cfg = node.data.config || {};
    const conn = connectedByNode.get(node.id);
    count += detectMissingConfig(t, cfg, model, conn).length;
    count += detectCapabilityRequirements(t, model).length;
    if (useWebGPU) count += detectWebGPUIncompatibilities(t, cfg, model).length;
    else if (useWasm) count += detectWasmIncompatibilities(t, cfg, model).length;
    if (t === 'macro') {
      const innerId = cfg.macroDefId;
      if (typeof innerId === 'string' && innerId.length > 0) {
        count += countMacroSubgraphIssues(innerId, model, useWebGPU, useWasm, depth + 1);
      }
    }
  }
  return count;
}

/** Capability-requirements check.
 *
 *  Reads `NodeTypeDef.requirements` and emits a human-readable issue per
 *  unmet flag. The model-level state interrogated:
 *    - `requirements.async` → `model.properties.updateMode === 'asynchronous'`
 *    - `requirements.variegated` → `model.variegatedCells?.enabled === true`
 *
 *  Returns `[]` when the node has no requirements OR all requirements are
 *  satisfied. Returns one string per unmet requirement otherwise. CaNode's
 *  warning badge consumes the result, and `isNodeAvailable` wraps it for
 *  palette/Add-Node-menu filtering.
 *
 *  Defence-in-depth: the JS / WASM / WebGPU compilers also reject offending
 *  nodes at compile time, so a `.gcaproj` loaded with incompatible nodes
 *  doesn't silently misbehave even if the badge is missed.
 */
export function detectCapabilityRequirements(
  nodeType: string,
  model: CAModel,
): string[] {
  const def = getNodeDef(nodeType);
  if (!def?.requirements) return [];
  const issues: string[] = [];
  if (def.requirements.async && model.properties.updateMode !== 'asynchronous') {
    issues.push(`"${def.label}" requires asynchronous update mode. Change in Model Properties > Execution.`);
  }
  if (def.requirements.variegated && !model.variegatedCells?.enabled) {
    issues.push(`"${def.label}" requires Variegated Cells enabled. Enable it in Model Properties > Execution.`);
  }
  // Generic 2D-only gate. (Currently NO node sets `lattice2d`: the neighborIndex
  // family was un-gated once the 3-axis (dr, dc, dl) codec landed on all three
  // targets in PR10 — it now packs three 10-bit fields in 3D. The flag is kept
  // as generic 2D-only infrastructure, so the message must NOT claim a 2-axis-NI
  // reason that PR10 made false.)
  if (def.requirements.lattice2d && model.properties.dimension === '3d') {
    issues.push(`"${def.label}" requires a 2D lattice and isn't available in a 3D model.`);
  }
  // Bond-Graph Agents: agent-world nodes need the Agents topology enabled. The
  // active-sub-tab half of the gate (`lattice` hidden on the Agents graph,
  // `bondGraph` hidden on the Cells graph) lives in `isNodeAvailable` via the
  // `activeGraphKind` module global — it can't be expressed from `(nodeType,
  // model)` alone, so the validation badge only flags the model-level half.
  if (def.requirements.bondGraph && !model.topologyMode?.agents) {
    issues.push(`"${def.label}" requires the Bond-Graph Agents topology. Enable it in Model Properties > Execution > Topology.`);
  }
  // Overseer: experiment-orchestration nodes need the Overseer enabled. Same
  // split as bondGraph — the sub-tab half of the gate lives in isNodeAvailable.
  if (def.requirements.overseer && !model.overseerConfig?.enabled) {
    issues.push(`"${def.label}" requires the Overseer. Enable it in Model Properties > Execution.`);
  }
  // Agent Capability Profiles: a bond-graph node whose capability is OFF in the
  // resolved profile gets an INFORMATIONAL badge (STEP 1 is editor-surface-only —
  // the compiler still emits unconditionally, so a placed violator keeps working;
  // the badge guides the user to enable the capability or remove the node).
  if (def.requirements.bondGraph && model.topologyMode?.agents) {
    const key = agentNodeRequirement(nodeType);
    if (key && !nodeSatisfiesCapabilities(nodeType, resolveAgentProfile(model))) {
      issues.push(`"${def.label}" needs the ${capReqLabel(key)} capability, which is off in this model's Agent Capabilities. Enable it in Model Properties > Agent Capabilities, or remove the node.`);
    }
  }
  return issues;
}

/** Bond-Graph Agents: node types that are LATTICE-only (no meaning in an agent
 *  rule graph) — the cell event roots, the neighbour / neighbour-index family,
 *  neighbourhood writes, and Get Cell Position (agents use Get Self Position).
 *  Hidden on the Agents sub-tab. Kept as a set (rather than a per-node
 *  `requirements.lattice` flag on ~20 files) so the lattice/agent boundary lives
 *  in one place; the `requirements.lattice` flag still works for any future
 *  per-node case. Nodes NOT here and NOT `bondGraph` are universal (arithmetic,
 *  Get/Set Attribute over the shared attributes via D-IDX, conditionals, Get
 *  Random, Set Cell Looks, …) — available in BOTH graphs. */
export const LATTICE_ONLY_TYPES = new Set<string>([
  // cell event roots (the agent graph is rooted at behaviourStep)
  'step', 'initEvent', 'inputColor', 'outputMapping',
  // Grid Init Event + its write primitive — seed the LATTICE grid (agents use the
  // Agent Init Event + Create Agent).
  'gridInit', 'setCellAtPosition',
  // neighbour + neighbour-index access (agents have no lattice neighbourhood)
  'getNeighborsAttribute', 'getNeighborAttributeByIndex', 'getNeighborAttributeByTag',
  'getNeighborIndexesByTags', 'getNeighborsAttrByIndexes', 'getAllNeighborIndexes',
  'neighborIndexFromOffset', 'neighborIndexFromTag', 'flipNeighborIndex',
  'breakDownNeighborIndex', 'pickRandomNeighbor', 'pickNRandomNeighbors',
  'filterNeighbors', 'joinNeighbors',
  // neighbourhood writes
  'setNeighborhoodAttribute', 'setNeighborAttributeByIndex', 'markCellUpdated',
  // cell position (agents use Get Self Position)
  'getCellPosition',
  // move-into-neighbour (number-conserving lattice transfer) — agents have no
  // lattice neighbourhood, they move by Apply Force / Set Velocity / Set Position.
  'moveSelfToNeighbor',
  // Variegated-cells orientation / facing nodes: they read the per-CELL
  // orientation buffer + grid-fixed facing directions, which agents don't have.
  // (They're `requirements.variegated`-gated, so without listing them here a
  // 2D grid+agents model with variegation enabled would surface them on the
  // Agents sub-tab.)
  'getOrientation', 'setOrientation',
  'getFacingOrientation', 'setFacingOrientation',
  'getNeighborOrientationByIndex', 'setNeighborOrientationByIndex',
  'getFacingLabels', 'getAllFacingLabels', 'interactionTableMap',
]);

/** Overseer: the EXPLICIT ALLOWLIST of shared (non-`requirements.overseer`)
 *  node types available on the Overseer graph. The Overseer runs at EXPERIMENT
 *  tempo on the main thread — there is no per-cell / per-agent context — so
 *  almost every node in the catalogue is meaningless there (own-attribute
 *  accessors, neighbour access, Set Cell Looks, indicator writers, the whole
 *  bondGraph set). Only context-free value plumbing + the flow constructs make
 *  sense. An allowlist (not a blocklist) is the safety boundary: a node type
 *  NOT listed here and NOT `requirements.overseer` can never be placed on the
 *  Overseer graph, and the overseer compiler independently rejects it
 *  (defence-in-depth). Every listed node's JS `compile()` is context-free
 *  (emits `const _v<id> = <expr>` over its inputs) or reads symbols the driver
 *  preamble provides (`modelAttrs` for getModelAttribute, `_rs` for getRandom). */
export const OVERSEER_UNIVERSAL_TYPES = new Set<string>([
  // flow constructs (compiled by the overseer compiler's own flow walk)
  'sequence', 'conditional', 'loop', 'forEachInArray', 'switch',
  // context-free value plumbing (their def.compile() is reused verbatim)
  'getConstant', 'arithmeticOperator', 'expression', 'statement',
  'logicOperator', 'getRandom', 'valueSwitch', 'proportionMap',
  'interpolation', 'arrayElement', 'arrayLength', 'getModelAttribute',
]);

/** Agent nodes that READ agent state — INVALID in the Agent Init Event, which runs
 *  ONCE per Reset (there is no "current agent" and no live population to scan) and
 *  is for SPAWNING + configuring NEW agents by handle (Create Agent → Set Agent
 *  Position/Radius/Attribute → Add Agent To World). Two ways such a node breaks the
 *  init closure:
 *    • SELF readers emit the per-agent loop variable `idx` (e.g. `_agentX[idx]`);
 *      `idx` doesn't exist in the non-looping init function.
 *    • BY-ID readers emit a range guard `… < highWater` (and array readers also
 *      `_alive[id]`). Per [agentAbi.ts](../compiler/agentAbi.ts) `deriveAgentAbi`,
 *      `highWater` + `_alive` are in the loop/division ABI ONLY — NOT init — so the
 *      compiled init closure references an undefined `highWater`/`_alive`.
 *  Either way `runAgentInit` throws a cryptic `[agents] init … failed: <sym> is not
 *  defined` and the whole init aborts (no agents spawn) — the footgun this badge
 *  preempts. So EVERY agent-SoA reader is unconditionally init-invalid (wiring makes
 *  no difference: a wired by-id read still emits `< highWater`).
 *
 *  NOT here (genuinely valid in init): the by-id SETTERS — `setAgentAttribute` /
 *  `setAgentPosition` / `setAgentRadius` / `setAgentSprite` / `setAgentsAttribute`
 *  relax their range guard to `_agentMaxAgents` (which IS in the init ABI) under the
 *  init/behaviour root; and the array ops that touch NO init-absent symbol
 *  (`joinAgents` / `pickRandomAgent` / `pickNRandomAgents` — they only index their
 *  input id array + `_rs`, so they run fine over a Local-Variable handle array). */
const AGENT_SELF_ONLY_TYPES = new Set<string>([
  // self identity / geometry readers (emit bare `idx`)
  'getSelfPosition', 'getSelfHandle', 'getRadius', 'getAge', 'getBondDegree',
  'neighbourDensity', 'getCurvature',
  // self-centred neighbour access + the self bond loop
  'getNearbyAgents', 'getAgentsInView', 'senseHemifield', 'getBondedAgents', 'forEachBond',
  // by-id readers — emit `< highWater` (getAgentOffset also `_agentX[idx]`); array
  // readers (getAgentsAttribute/filterAgents) also `_alive[id]`. None is in the
  // init ABI, so all throw in init regardless of wiring.
  'getAgentOffset', 'getAgentPosition', 'getVelocity', 'getAgentRadius',
  'getAgentAttribute', 'getAgentsAttribute', 'filterAgents',
  // P2 bond attributes — both scan the SELF bond list (`idx * maxBonds`,
  // `_agentBondCount[idx]`), neither of which is in the init ABI.
  'getBondAttribute', 'setBondAttribute',
  // self writers. `setVelocity` is CONDITIONAL — see AGENT_SELF_ONLY_WHEN_UNWIRED.
  // `killAgent` is unconditional even though it now takes an optional id: its
  // `_killRequest` buffer is loop-only in the ABI, so neither wiring works in init.
  'setVelocity', 'applyForce', 'setTargetRadius', 'divideAgent', 'formBond', 'breakBond', 'rewireBond', 'transferBond', 'killAgent',
  // field bridge (sampled/deposited at the SELF position)
  'sampleField', 'fieldGradient', 'readCellsUnder', 'affectCellsUnder', 'secreteToField',
  // universal self-attribute nodes (on the agent SoA at idx) — valid in the
  // Behaviour Step, invalid in the Init Event
  'getCellAttribute', 'setAttribute', 'updateAttribute',
]);

/** Optional-id nodes whose init-validity depends on WIRING: unwired they write the
 *  per-agent loop variable `idx` (init-invalid), wired they take the by-id setter's
 *  `_agentMaxAgents` guard, which IS in the init ABI — so seeding a newborn's
 *  velocity on its Create Agent handle is legitimate. Value = the id port to test.
 *  (Kill Agent is NOT here: its `_killRequest` buffer is loop-only either way.) */
const AGENT_SELF_ONLY_WHEN_UNWIRED: Record<string, string> = {
  setVelocity: 'agentId',
  setTargetRadius: 'agentId',
};

/** Memoised "which nodes reachable from the agentInit root are init-invalid agent
 *  readers" set, keyed on the agent graph arrays' identity (ModelContext hands
 *  fresh arrays on every edit, so this invalidates naturally). */
let _agentInitSelfCache: { nodes: unknown; edges: unknown; mappings: unknown; set: Map<string, string> } | null = null;

/** Kill Agent is init-invalid EITHER WAY (its `_killRequest` buffer is loop-only
 *  in the init ABI) but SPAWNER-valid when wired — the spawner kind carries the
 *  lane so a brush can remove agents by id. Unwired it targets `idx`, which a
 *  spawner does not have, so it stays reported there. */
const SPAWNER_SELF_ONLY_WHEN_UNWIRED: Record<string, string> = {
  ...AGENT_SELF_ONLY_WHEN_UNWIRED,
  killAgent: 'agentId',
};

function agentInitSelfOnlyNodeIds(model: CAModel): Map<string, string> {
  const nodes = model.agentGraphNodes ?? [];
  const edges = model.agentGraphEdges ?? [];
  // The SPAWNER roots are resolved from `agentMappings`, so a brush-kind flip
  // must invalidate this cache too (it changes which roots have no `self`).
  const mappings = model.agentMappings;
  if (_agentInitSelfCache && _agentInitSelfCache.nodes === nodes
    && _agentInitSelfCache.edges === edges && _agentInitSelfCache.mappings === mappings) {
    return _agentInitSelfCache.set;
  }
  /** nodeId -> the reason string (which selfless root it was reached from). */
  const result = new Map<string, string>();
  // EVERY root whose ABI has no `self`: the Agent Init Event and every
  // SPAWNER-kind Agent Input Mapping. They share the footgun exactly (no `idx`,
  // no live-population buffers), so they share one walk.
  const selflessRoots = nodes.filter(n =>
    n.data?.nodeType === 'agentInit'
    || (n.data?.nodeType === 'agentInputMapping'
      && inputBrushKindForNode('agentInputMapping', n.data?.config, model) === 'spawner'));
  for (const initNode of selflessRoots) {
    const isSpawner = initNode.data?.nodeType === 'agentInputMapping';
    const whenUnwired = isSpawner ? SPAWNER_SELF_ONLY_WHEN_UNWIRED : AGENT_SELF_ONLY_WHEN_UNWIRED;
    const nodeMap = new Map(nodes.map(n => [n.id, n] as const));
    // flow-output adjacency (src → targets) + value-input adjacency (node → sources).
    const flowOut = new Map<string, string[]>();
    const valIn = new Map<string, string[]>();
    // `${nodeId}:${portId}` for every wired value INPUT — the wiredness test the
    // conditional (optional-id) types below need.
    const wiredValuePorts = new Set<string>();
    for (const e of edges) {
      const sh = e.sourceHandle || '', th = e.targetHandle || '';
      if (sh.startsWith('output_flow_') && th.startsWith('input_flow_')) {
        (flowOut.get(e.source) ?? (flowOut.set(e.source, []), flowOut.get(e.source)!)).push(e.target);
      } else if (sh.startsWith('output_value_') && th.startsWith('input_value_')) {
        (valIn.get(e.target) ?? (valIn.set(e.target, []), valIn.get(e.target)!)).push(e.source);
        wiredValuePorts.add(`${e.target}:${th.slice('input_value_'.length)}`);
      }
    }
    // Flow-reachable from init (the nodes that RUN in the init function body).
    const reached = new Set<string>();
    const stack = [initNode.id];
    while (stack.length) {
      const id = stack.pop()!;
      if (reached.has(id)) continue;
      reached.add(id);
      for (const t of flowOut.get(id) ?? []) stack.push(t);
    }
    // + their transitive value cone (the value nodes they compile).
    const vseen = new Set<string>(reached);
    const vstack = [...reached];
    while (vstack.length) {
      const id = vstack.pop()!;
      for (const s of valIn.get(id) ?? []) if (!vseen.has(s)) { vseen.add(s); vstack.push(s); }
    }
    for (const id of vseen) {
      const n = nodeMap.get(id);
      if (!n || !AGENT_SELF_ONLY_TYPES.has(n.data?.nodeType)) continue;
      // Conditional types are init-valid once their id port is wired (by-id guard).
      const idPort = whenUnwired[n.data?.nodeType];
      if (idPort && wiredValuePorts.has(`${id}:${idPort}`)) continue;
      if (!result.has(id)) {
        result.set(id, isSpawner
          ? 'Reads agent state — unavailable in a SPAWNER-kind Agent Input Mapping, which runs ONCE per brush application (no current agent) to CREATE agents by handle: Create Agent → Set Agent Position/Radius/Attribute → Add Agent To World. Switch the mapping to the Editor brush kind to run per painted agent.'
          : 'Reads agent state — unavailable in the Agent Init Event, which runs once (no current agent, no live population) to SPAWN + configure NEW agents by handle: Create Agent → Set Agent Position/Radius/Attribute → Add Agent To World.');
      }
    }
  }
  _agentInitSelfCache = { nodes, edges, mappings, set: result };
  return result;
}

/** Design-time badge for the SELFLESS-ROOT footgun: a per-agent (self) node
 *  wired into a root whose ABI has no current agent — the Agent Init Event, or a
 *  SPAWNER-kind Agent Input Mapping. Returns an issue string ONLY for a node in
 *  `AGENT_SELF_ONLY_TYPES` that is reachable (flow or value cone) from such a
 *  root on the Agents graph, and the string names WHICH root. Empty otherwise. */
export function detectAgentInitContextIssue(nodeId: string, model: CAModel): string[] {
  if (getActiveGraphKind() !== 'agents' || !model.topologyMode?.agents) return [];
  const reason = agentInitSelfOnlyNodeIds(model).get(nodeId);
  return reason ? [reason] : [];
}

/** True when a node type can be added to / kept in the current model. Used to
 *  hide unavailable nodes from the palette and Add-Node menu. Mirrors
 *  `detectCapabilityRequirements(...).length === 0`. */
export function isNodeAvailable(def: NodeTypeDef, model: CAModel): boolean {
  // Bond-Graph Agents: hide lattice-only nodes on the Agents sub-tab (checked
  // FIRST, before the no-requirements early return, since these nodes carry no
  // `requirements` object). The active-graph kind is a module global (default
  // `'cells'`), so a single-graph model is unaffected.
  const kind = getActiveGraphKind();
  if (kind === 'agents' && LATTICE_ONLY_TYPES.has(def.type)) return false;
  // Overseer graph: an explicit ALLOWLIST — only overseer nodes (checked below)
  // and the context-free universal subset exist there. Everything else (the
  // whole per-cell/per-agent catalogue) is hidden.
  if (kind === 'overseer' && !def.requirements?.overseer && !OVERSEER_UNIVERSAL_TYPES.has(def.type)) return false;
  if (!def.requirements) return true;
  if (def.requirements.async && model.properties.updateMode !== 'asynchronous') return false;
  if (def.requirements.variegated && !model.variegatedCells?.enabled) return false;
  if (def.requirements.lattice2d && model.properties.dimension === '3d') return false;
  // Bond-Graph Agents: gate by BOTH the model topology AND the active sub-tab.
  // An agent node needs the Agents topology enabled and is only offered while
  // the user edits the Agents graph; a lattice node is hidden on the Agents
  // graph.
  if (def.requirements.bondGraph) {
    if (!model.topologyMode?.agents) return false;
    if (kind !== 'agents') return false;
    // Agent Capability Profiles: hide a node whose capability is off in the
    // resolved profile from the palette / quick-add / connection-drop menus, so a
    // paradigm shows only its relevant nodes. Only reached on the Agents graph
    // with the topology on ⇒ the profile is explicit (O(1)).
    if (!nodeSatisfiesCapabilities(def.type, resolveAgentProfile(model))) return false;
  }
  // Overseer nodes: need the feature enabled AND the Overseer sub-tab active.
  // With the feature off (or on any other graph) they are invisible everywhere.
  if (def.requirements.overseer) {
    if (!model.overseerConfig?.enabled) return false;
    if (kind !== 'overseer') return false;
  }
  if (def.requirements.lattice && kind !== 'cells') return false;
  return true;
}

/** True when a macro can be dropped on the ACTIVE graph — every internal node must
 *  be compatible with the active graph kind. A CELL macro containing a lattice-only
 *  node (neighbour access, cell event roots, …) can't run on the Agents graph, and
 *  an AGENT macro containing a `bondGraph` node can't run on the Cells graph — either
 *  would fail to compile after the drop. Recurses into nested macro instances (cycle
 *  guarded). Universal-only macros are available on BOTH graphs (the common case).
 *  Prevents the confusing "dropped a macro that silently won't compile" failure. */
export function isMacroAvailableOnGraph(
  macroNodes: ReadonlyArray<{ data?: { nodeType?: string; config?: Record<string, unknown> } }> | undefined,
  model: CAModel,
  seen: Set<string> = new Set(),
): boolean {
  const kind = getActiveGraphKind();
  for (const n of macroNodes ?? []) {
    const t = n.data?.nodeType;
    if (!t || t === 'macroInput' || t === 'macroOutput') continue;
    if (t === 'macro') {
      const defId = n.data?.config?.macroDefId;
      if (typeof defId === 'string' && !seen.has(defId)) {
        seen.add(defId);
        const nested = model.macroDefs?.find(d => d.id === defId);
        if (nested && !isMacroAvailableOnGraph(nested.nodes, model, seen)) return false;
      }
      continue;
    }
    if (kind === 'agents') {
      // Lattice-only nodes (neighbour family, cell roots, …) can't run on agents.
      if (LATTICE_ONLY_TYPES.has(t) || getNodeDef(t)?.requirements?.lattice) return false;
      // Overseer (experiment) nodes can't run inside a cell/agent rule either.
      if (getNodeDef(t)?.requirements?.overseer) return false;
    } else if (kind === 'cells') {
      // Bond-graph (agent-only) + overseer nodes can't run on the cell grid.
      const req = getNodeDef(t)?.requirements;
      if (req?.bondGraph || req?.overseer) return false;
    } else if (kind === 'overseer') {
      // The Overseer graph is allowlist-only: every internal node must be an
      // overseer node or in the universal subset.
      if (!getNodeDef(t)?.requirements?.overseer && !OVERSEER_UNIVERSAL_TYPES.has(t)) return false;
    }
  }
  return true;
}

/** Wave 3 — return WebGPU-target-specific issues for a node configuration.
 *
 *  WebGPU runs cells in parallel on the GPU, so any rule whose result depends
 *  on the order in which cells fire is ill-defined under that target. This is
 *  a SEPARATE function (not folded into `detectMissingConfig`) so the existing
 *  call sites stay untouched and the warning badge can render WebGPU issues
 *  with a distinct icon/colour or only when the user has selected WebGPU.
 *
 *  Caller pattern: `[...detectMissingConfig(...), ...detectWebGPUIncompatibilities(nodeType, config, model)]`
 *  when `model.properties.useWebGPU` is true.
 *
 *  Mirrors the worker-side rejection list — keep in sync with `compileGraphWebGPU`.
 *
 *  Note: async-only nodes (setNeighborhoodAttribute, setNeighborAttributeByIndex)
 *  are NOT listed here. They surface via `detectCapabilityRequirements` with
 *  "requires async mode", and the model-level `detectWebGPUModelIncompatibilities`
 *  surfaces the "WebGPU requires sync mode" half — together unambiguous. */
export function detectWebGPUIncompatibilities(
  nodeType: string,
  config: NodeConfig,
  _model: CAModel,
): string[] {
  const issues: string[] = [];
  switch (nodeType) {
    // Order-dependent indicator updates.
    case 'updateIndicator': {
      const op = config.operation;
      if (op === 'toggle') {
        issues.push('WebGPU runs cells in parallel; toggling a shared indicator from multiple cells per generation produces an undefined result. Use `or` (becomes true and stays true) or `and` for the inverse pattern, or switch target.');
      } else if (op === 'next' || op === 'previous') {
        issues.push('WebGPU runs cells in parallel; cyclic tag advancement (next/previous) from multiple cells produces an undefined result. Use Set Indicator with an explicit value, or switch target.');
      }
      break;
    }
    // Variegated Cells: async-only orientation writes — WebGPU is sync-only,
    // so they're never reachable. detectWebGPUModelIncompatibilities also
    // rejects async-mode at the model level, but flagging the node surfaces
    // the issue directly on the badge.
    case 'setFacingOrientation':
      issues.push('Set Facing Orientation requires asynchronous update mode — WebGPU is sync-only. Switch to WebAssembly / Debug target, or remove this node.');
      break;
    case 'setNeighborOrientationByIndex':
      issues.push('Set Neighbor Orientation By Index requires asynchronous update mode — WebGPU is sync-only. Switch to WebAssembly / Debug target, or remove this node.');
      break;
    case 'moveSelfToNeighbor':
      issues.push('Transfer Cell Attributes to Neighbor requires asynchronous update mode — WebGPU is sync-only. Switch to WebAssembly / Debug target, or remove this node.');
      break;
  }
  return issues;
}

/** Wave A — return WASM-target-specific issues for a node configuration.
 *
 *  Mirrors `detectWebGPUIncompatibilities` so WASM-only gaps surface as
 *  warning badges in the modeler instead of init-time errors. Currently the
 *  WASM target covers the full node catalogue (Variegated Cells nodes +
 *  Init Event landed in Phase 8) so this function returns no issues. The
 *  scaffold + call site is kept so future WASM-only gaps can be reported
 *  here without touching the rest of the validation pipeline.
 *
 *  Caller pattern: `[...detectMissingConfig(...), ...detectWasmIncompatibilities(nodeType, config, model)]`
 *  when `model.properties.useWasm` is true and `useWebGPU` is false. */
export function detectWasmIncompatibilities(
  _nodeType: string,
  _config: NodeConfig,
  _model: CAModel,
): string[] {
  return [];
}

/** Bond-Graph Agents: the agent engine is JS-reference-only for v1 (Decision
 *  D-TARGET) — the agent loop + structural-phase reads are not yet ported to
 *  the WASM/WebGPU emitters. A model with the Agents topology enabled is
 *  force-restricted to the JS (Debug/Reference) compile target. Returns the
 *  restriction message when a non-JS target is selected on an agent model, else
 *  null. The simulator's compile path consumes this to force the JS target (so
 *  it's an enforcement, not just a badge), and the Properties status line shows
 *  it. The CELL field path is unaffected — only the AGENT engine forces JS.
 *
 *  DEPRECATED / UNUSED: no longer wired into any compile gate. Agents now run on
 *  WASM too (resolved via `agentTargetOf` on `model.centerBased.agentTarget`) and
 *  the GRID target is independent, so this grid-flag-keyed restriction is obsolete.
 *  Its only remaining caller is the (also-unused) detectWasmModelIncompatibilities. */
export function detectAgentTargetRestriction(model: CAModel): string | null {
  if (!model.topologyMode?.agents) return null;
  if (model.properties.useWebGPU || model.properties.useWasm) {
    return 'Bond-Graph Agents run on the Debug / Reference (JS) engine this release. WebAssembly and WebGPU agent compilation are a later milestone — the simulator will use the JS target.';
  }
  return null;
}

/** Top-level model check for the WebGPU GRID/cell-field target. Returns a
 *  human-readable message when the WebGPU target is invalid, else null.
 *  Intended for the Properties panel's status line and the WebGPU-compile entry
 *  point.
 *
 *  NOTE: this does NOT block an agents model. The GRID/cell-field compile target
 *  (useWebGPU/useWasm) is INDEPENDENT of the agent engine's target — a WebGPU
 *  grid runs the cell CA on the GPU while agents stay JS (resolved separately
 *  via `agentTargetOf` on `model.centerBased.agentTarget`). Routing the old
 *  agent-forces-JS restriction in here silently negated that shipped feature, so
 *  it was removed (the restriction keyed off the GRID flags, not the agent
 *  target). */
export function detectWebGPUModelIncompatibilities(model: CAModel): string | null {
  if (!model.properties.useWebGPU) return null;
  if (model.properties.updateMode === 'asynchronous') {
    // C6 (P5) — the doctrine vocabulary (Principle 1): asynchronous IS the
    // sequential mode, and the GPU runs only parallel rules. Same words as the
    // Update Mode radio's subtitle, so the readout and the control agree.
    return 'Asynchronous is the SEQUENTIAL update mode (a write is visible to a later cell in the same generation), and WebGPU runs cells in parallel. Switch to Synchronous in Model Properties, or run this model on a CPU engine (WebAssembly / Debug JS).';
  }
  return null;
}

/** Top-level model check for the WASM target — currently only the agent-model
 *  force-JS restriction (the WASM target otherwise covers the full lattice
 *  node catalogue). Mirrors `detectWebGPUModelIncompatibilities`. */
export function detectWasmModelIncompatibilities(model: CAModel): string | null {
  if (!model.properties.useWasm) return null;
  return detectAgentTargetRestriction(model);
}

/** Detect a connection-kind hazard between two ports.
 *
 *  The classic hazard: a node emits an `integer` (or `integer[]`) that *looks*
 *  like a coord-handle but is actually a list-position into the source array
 *  (e.g. `groupOperator.index`, `groupCounting.indexes`). When wired into a
 *  port that expects a `neighborIndex`, the runtime accepts the value (because
 *  it's just a number) but looks up the WRONG neighbor.
 *
 *  Returns a human-readable warning when the source-port type is incompatible
 *  with a `neighborIndex` target port (i.e. the source is anything other than
 *  `neighborIndex` or `any`). Returns null otherwise.
 *
 *  GraphEditor walks all edges, calls this per edge, and aggregates the
 *  results into the per-node hazards map (`graphState.connectionHazardsMap`).
 *  CaNode's warning badge surfaces them alongside config-missing issues. */
export function detectEdgeHazard(
  srcNodeType: string,
  srcPortId: string,
  tgtNodeType: string,
  tgtPortId: string,
): string | null {
  const srcDef = getNodeDef(srcNodeType);
  const tgtDef = getNodeDef(tgtNodeType);
  if (!srcDef || !tgtDef) return null;
  const srcPort = srcDef.ports.find(p => p.id === srcPortId);
  const tgtPort = tgtDef.ports.find(p => p.id === tgtPortId);
  if (!srcPort || !tgtPort) return null;
  if (tgtPort.category !== 'value' || tgtPort.dataType !== 'neighborIndex') return null;
  if (srcPort.dataType === 'neighborIndex' || srcPort.dataType === 'any' || srcPort.dataType === undefined) {
    return null;
  }
  return `${srcDef.label} "${srcPort.label}" carries a list-position (${srcPort.dataType}); ${tgtDef.label} "${tgtPort.label}" expects a NeighborIndex (coord handle). Use Filter Neighbors / Get Neighbor Indexes By Tags / Pick Random Neighbor instead.`;
}
