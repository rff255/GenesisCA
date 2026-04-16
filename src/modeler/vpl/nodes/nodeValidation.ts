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
  }

  return issues;
}
