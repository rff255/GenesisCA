import type { NodeConfig } from '../types';
import type { CAModel } from '../../../model/types';

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
    case 'getNeighborAttributeByIndex':
    case 'getNeighborsAttrByIndexes':
    case 'filterNeighbors':
    case 'setNeighborhoodAttribute':
    case 'setNeighborAttributeByIndex':
      if (!hasNeighborhood(config.neighborhoodId)) issues.push('Select a neighborhood');
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
