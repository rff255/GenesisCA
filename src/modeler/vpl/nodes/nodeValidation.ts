import type { NodeConfig, NodeTypeDef } from '../types';
import { parseHandleId } from '../types';
import type { CAModel } from '../../../model/types';
import { cellFieldAttrsOf } from '../../../model/attributeScope';
import { agentNodeRequirement, nodeSatisfiesCapabilities, resolveAgentProfile, capReqLabel } from '../../../model/agentCapabilities';
import { getNodeDef } from './registry';
import { CURRENT_VIEWER_SENTINEL } from './SetCellLooksNode';
import { buildVarMap, parseExpression, clampVisibleCount } from '../compiler/expression/parser';
import { getActiveGraphKind } from '../graphState';
import { VECTOR_LOWERED } from '../compiler/vectorAttr';

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
  const hasAgentMapping = (id: unknown) =>
    typeof id === 'string' && id.length > 0 &&
    (model.agentMappings ?? []).some(m => m.id === id);
  const hasIndicator = (id: unknown) =>
    typeof id === 'string' && id.length > 0 &&
    (model.indicators || []).some(i => i.id === id);
  const hasMacroDef = (id: unknown) =>
    typeof id === 'string' && id.length > 0 &&
    (model.macroDefs || []).some(m => m.id === id);

  switch (nodeType) {
    case 'getCellAttribute':
      // Universal: a cell attr (Cells graph) OR an agent attr (Agents graph).
      if (!hasOwnAttr(config.attributeId)) issues.push('Select an attribute');
      break;

    case 'getModelAttribute':
      if (!hasModelAttr(config.attributeId)) issues.push('Select a model attribute');
      break;

    case 'setAttribute':
    case 'updateAttribute':
      // Universal: a cell attr (Cells graph) OR an agent attr (Agents graph).
      if (!hasOwnAttr(config.attributeId)) issues.push('Select an attribute');
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
      if (config.mappingId !== CURRENT_VIEWER_SENTINEL
        && !hasMapping(config.mappingId) && !hasAgentMapping(config.mappingId)) {
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
      break;

    // Generic Agent Platform — the agent analogue of outputMapping. Roots a
    // per-agent colour/exhibition pass over an AGENT mapping.
    case 'agentOutputMapping':
      if (!hasAgentMapping(config.mappingId)) issues.push('Select an agent view (mapping)');
      break;

    case 'setAgentSprite':
      // Only the "Change sprite" facet needs a sprite asset; the frame/speed-only
      // uses (untick Change sprite) need none.
      if (config.setSprite !== false && !(model.sprites ?? []).some(s => s.id === config.spriteId)) {
        issues.push('Select a sprite (or untick "Change sprite")');
      }
      break;

    case 'getIndicator':
    case 'setIndicator':
    case 'updateIndicator':
      if (!hasIndicator(config.indicatorId)) issues.push('Select an indicator');
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

/** Agent nodes that intrinsically read/write the CURRENT agent (they emit the
 *  per-agent loop variable `idx`), so they are INVALID in the Agent Init Event —
 *  which runs ONCE per Reset, NOT once per agent (there is no "current agent"
 *  there). Dropping one under the agentInit root compiles to code referencing an
 *  undefined `idx` and fails at runtime with a cryptic "init compile failed: idx
 *  is not defined". In the Init Event you instead SPAWN + configure NEW agents by
 *  handle (Create Agent → Set Agent Position/Radius/Attribute → Add Agent To
 *  World). Excludes the by-id reader/writer nodes (getAgentPosition / getAgentOffset
 *  / getVelocity / setAgentAttribute / …): those address a specific agent via a
 *  wired handle and ARE valid in init, so badging them would be a false positive. */
const AGENT_SELF_ONLY_TYPES = new Set<string>([
  // self identity / geometry readers
  'getSelfPosition', 'getSelfHandle', 'getRadius', 'getAge', 'getBondDegree',
  'neighbourDensity', 'getCurvature',
  // self-centred neighbour access + the self bond loop
  'getNearbyAgents', 'getAgentsInView', 'senseHemifield', 'getBondedAgents', 'forEachBond',
  // self writers
  'setVelocity', 'applyForce', 'setTargetRadius', 'divideAgent', 'formBond', 'breakBond', 'killAgent',
  // field bridge (sampled/deposited at the SELF position)
  'sampleField', 'fieldGradient', 'readCellsUnder', 'affectCellsUnder', 'secreteToField',
  // universal self-attribute nodes (on the agent SoA at idx) — valid in the
  // Behaviour Step, invalid in the Init Event
  'getCellAttribute', 'setAttribute', 'updateAttribute',
]);

/** Memoised "which nodes reachable from the agentInit root are self-only" set,
 *  keyed on the agent graph arrays' identity (ModelContext hands fresh arrays on
 *  every edit, so this invalidates naturally). */
let _agentInitSelfCache: { nodes: unknown; edges: unknown; set: Set<string> } | null = null;

function agentInitSelfOnlyNodeIds(model: CAModel): Set<string> {
  const nodes = model.agentGraphNodes ?? [];
  const edges = model.agentGraphEdges ?? [];
  if (_agentInitSelfCache && _agentInitSelfCache.nodes === nodes && _agentInitSelfCache.edges === edges) {
    return _agentInitSelfCache.set;
  }
  const result = new Set<string>();
  const initNode = nodes.find(n => n.data?.nodeType === 'agentInit');
  if (initNode) {
    const nodeMap = new Map(nodes.map(n => [n.id, n] as const));
    // flow-output adjacency (src → targets) + value-input adjacency (node → sources).
    const flowOut = new Map<string, string[]>();
    const valIn = new Map<string, string[]>();
    for (const e of edges) {
      const sh = e.sourceHandle || '', th = e.targetHandle || '';
      if (sh.startsWith('output_flow_') && th.startsWith('input_flow_')) {
        (flowOut.get(e.source) ?? (flowOut.set(e.source, []), flowOut.get(e.source)!)).push(e.target);
      } else if (sh.startsWith('output_value_') && th.startsWith('input_value_')) {
        (valIn.get(e.target) ?? (valIn.set(e.target, []), valIn.get(e.target)!)).push(e.source);
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
      if (n && AGENT_SELF_ONLY_TYPES.has(n.data?.nodeType)) result.add(id);
    }
  }
  _agentInitSelfCache = { nodes, edges, set: result };
  return result;
}

/** Design-time badge for the Init-vs-Behaviour footgun: a per-agent (self) node
 *  wired into the Agent Init Event. Returns an issue string ONLY for a node in
 *  `AGENT_SELF_ONLY_TYPES` that is reachable (flow or value cone) from the
 *  agentInit root on the Agents graph. Empty otherwise. */
export function detectAgentInitContextIssue(nodeId: string, model: CAModel): string[] {
  if (getActiveGraphKind() !== 'agents' || !model.topologyMode?.agents) return [];
  return agentInitSelfOnlyNodeIds(model).has(nodeId)
    ? ['Reads/writes the CURRENT agent — invalid in the Agent Init Event (it runs once, not per-agent). Spawn + configure new agents by handle instead: Create Agent → Set Agent Position/Radius/Attribute → Add Agent To World.']
    : [];
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
    if (kind === 'cells') return false;
    // Agent Capability Profiles: hide a node whose capability is off in the
    // resolved profile from the palette / quick-add / connection-drop menus, so a
    // paradigm shows only its relevant nodes. Only reached on the Agents graph
    // with the topology on ⇒ the profile is explicit (O(1)).
    if (!nodeSatisfiesCapabilities(def.type, resolveAgentProfile(model))) return false;
  }
  if (def.requirements.lattice && kind === 'agents') return false;
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
    return 'WebGPU target requires synchronous update mode. Switch to Synchronous in Model Properties or change target.';
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
