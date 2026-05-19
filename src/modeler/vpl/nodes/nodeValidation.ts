import type { NodeConfig, NodeTypeDef } from '../types';
import { parseHandleId } from '../types';
import type { CAModel } from '../../../model/types';
import { getNodeDef } from './registry';
import { buildVarMap, parseExpression, clampVisibleCount } from '../compiler/expression/parser';

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

  const hasCellAttr = (id: unknown) =>
    typeof id === 'string' && id.length > 0 &&
    model.attributes.some(a => a.id === id && !a.isModelAttribute);
  const hasModelAttr = (id: unknown) =>
    typeof id === 'string' && id.length > 0 &&
    model.attributes.some(a => a.id === id && a.isModelAttribute);
  const hasAnyAttr = (id: unknown) =>
    typeof id === 'string' && id.length > 0 &&
    model.attributes.some(a => a.id === id);
  const hasNeighborhood = (id: unknown) =>
    typeof id === 'string' && id.length > 0 &&
    model.neighborhoods.some(n => n.id === id);
  const hasMapping = (id: unknown) =>
    typeof id === 'string' && id.length > 0 &&
    model.mappings.some(m => m.id === id);
  const hasIndicator = (id: unknown) =>
    typeof id === 'string' && id.length > 0 &&
    (model.indicators || []).some(i => i.id === id);
  const hasMacroDef = (id: unknown) =>
    typeof id === 'string' && id.length > 0 &&
    (model.macroDefs || []).some(m => m.id === id);

  switch (nodeType) {
    case 'getCellAttribute':
      if (!hasCellAttr(config.attributeId)) issues.push('Select a cell attribute');
      break;

    case 'getModelAttribute':
      if (!hasModelAttr(config.attributeId)) issues.push('Select a model attribute');
      break;

    case 'setAttribute':
    case 'updateAttribute':
      if (!hasCellAttr(config.attributeId)) issues.push('Select a cell attribute');
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

    case 'inputColor':
    case 'outputMapping':
    case 'setColorViewer':
    case 'setCellGlyph':
      if (!hasMapping(config.mappingId)) issues.push('Select a mapping');
      break;

    case 'getIndicator':
    case 'setIndicator':
    case 'updateIndicator':
      if (!hasIndicator(config.indicatorId)) issues.push('Select an indicator');
      break;

    case 'getConstant':
      if (config.constType === 'tag') {
        if (!hasAnyAttr(config.tagAttributeId)) {
          issues.push('Select a tag attribute');
        } else {
          const attr = model.attributes.find(a => a.id === config.tagAttributeId);
          if (attr && attr.type !== 'tag') issues.push('Selected attribute is not a tag type');
        }
      }
      break;

    case 'tagConstant':
      if (!hasAnyAttr(config.tagAttributeId)) issues.push('Select a tag attribute');
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
        issues.push('Select an Interaction Table');
      } else {
        const attr = model.attributes.find(a => a.id === tableId);
        if (!attr) issues.push('Selected Interaction Table no longer exists');
        else if (attr.type !== 'interactionTable') issues.push('Selected attribute is not an Interaction Table');
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
            issues.push(`Payload ${i + 1}: selected attribute no longer exists`);
          }
        }
      }
      if (!anySlotConfigured && !config.transferOrientation) {
        issues.push('Configure at least one payload attribute or enable Transfer Orientation');
      }
      if (config.transferOrientation && !model.variegatedCells?.enabled) {
        issues.push('Transfer Orientation requires Variegated Cells to be enabled');
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
  return issues;
}

/** True when a node type can be added to / kept in the current model. Used to
 *  hide unavailable nodes from the palette and Add-Node menu. Mirrors
 *  `detectCapabilityRequirements(...).length === 0`. */
export function isNodeAvailable(def: NodeTypeDef, model: CAModel): boolean {
  if (!def.requirements) return true;
  if (def.requirements.async && model.properties.updateMode !== 'asynchronous') return false;
  if (def.requirements.variegated && !model.variegatedCells?.enabled) return false;
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
      issues.push('Move Self To Neighbor composes async-only neighbour writes — WebGPU is sync-only. Switch to WebAssembly / Debug target, or remove this node.');
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

/** Top-level model check — async + WebGPU is incompatible. Returns a
 *  human-readable message when the combination is invalid, else null.
 *  Intended for the Properties panel's status line and the
 *  WebGPU-compile entry point. */
export function detectWebGPUModelIncompatibilities(model: CAModel): string | null {
  if (!model.properties.useWebGPU) return null;
  if (model.properties.updateMode === 'asynchronous') {
    return 'WebGPU target requires synchronous update mode. Switch to Synchronous in Model Properties or change target.';
  }
  return null;
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
