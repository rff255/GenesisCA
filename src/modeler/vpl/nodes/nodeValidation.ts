import type { NodeConfig } from '../types';
import type { CAModel } from '../../../model/types';
import { getNodeDef } from './registry';

/** Return a list of human-readable issue strings for a node's configuration.
 *  Empty array = node is fully configured.
 *
 *  The rules here mirror the compile-time fallbacks in `compiler/compile.ts`
 *  (which emit `_undef` placeholders for unresolved references). A warning badge
 *  in the UI surfaces these cases before the user runs the simulation. */
export function detectMissingConfig(
  nodeType: string,
  config: NodeConfig,
  model: CAModel,
): string[] {
  const issues: string[] = [];

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
    case 'getNeighborsAttrByIndexes':
    case 'filterNeighbors':
    case 'setNeighborAttributeByIndex':
      // Wave A.6: NI-consuming nodes — only attrId required. The NI input
      // carries its own (dr, dc) offset; no neighborhood needed.
      if (!hasCellAttr(config.attributeId)) issues.push('Select a cell attribute');
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
  depth: number = 0,
): number {
  if (depth > MAX_MACRO_DEPTH) return 0;
  const def = (model.macroDefs || []).find(m => m.id === macroDefId);
  if (!def) return 0;
  let count = 0;
  for (const node of def.nodes) {
    const t = node.data?.nodeType;
    if (!t) continue;
    if (t === 'macroInput' || t === 'macroOutput' || t === 'commentNode' || t === 'groupNode') continue;
    const cfg = node.data.config || {};
    count += detectMissingConfig(t, cfg, model).length;
    if (useWebGPU) count += detectWebGPUIncompatibilities(t, cfg, model).length;
    if (t === 'macro') {
      const innerId = cfg.macroDefId;
      if (typeof innerId === 'string' && innerId.length > 0) {
        count += countMacroSubgraphIssues(innerId, model, useWebGPU, depth + 1);
      }
    }
  }
  return count;
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
 *  Mirrors the worker-side rejection list — keep in sync with `compileGraphWebGPU`. */
export function detectWebGPUIncompatibilities(
  nodeType: string,
  config: NodeConfig,
  _model: CAModel,
): string[] {
  const issues: string[] = [];
  switch (nodeType) {
    // Async-only nodes (also rejected for sync targets, but the message here
    // is WebGPU-specific because the user might otherwise switch to async to
    // make them work — and async is incompatible with WebGPU).
    case 'setNeighborhoodAttribute':
    case 'setNeighborAttributeByIndex':
      issues.push('WebGPU target requires synchronous mode; this node only works in asynchronous mode. Switch target or remove this node.');
      break;
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
  }
  return issues;
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
