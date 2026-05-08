import type { NodeTypeDef } from '../types';

export const FilterNeighborsNode: NodeTypeDef = {
  type: 'filterNeighbors',
  label: 'Filter Neighbors',
  description: 'Keeps neighbor indices whose attribute passes the comparison.',
  category: 'aggregation',
  color: '#e65100',
  ports: [
    { id: 'indexes', label: 'Indexes', kind: 'input', category: 'value', dataType: 'neighborIndex', isArray: true },
    { id: 'compare', label: 'Compare', kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '0' },
    { id: 'result', label: 'Filtered', kind: 'output', category: 'value', dataType: 'neighborIndex', isArray: true },
  ],
  defaultConfig: { neighborhoodId: '', attributeId: '', operation: 'equals' },
  compile: (nodeId, config, inputs) => {
    const nbrId = config.neighborhoodId as string || '_undef';
    const attr = config.attributeId as string || '_undef';
    const compare = inputs['compare'] || '0';
    const op = config.operation as string;
    const fi = `_fi${nodeId}`;
    const vl = `_v${nodeId}_resLen`;

    // Wave A.5 implicit-all default: when the Indexes input port is unconnected,
    // iterate over every slot of the configured neighborhood (loop bound =
    // nSz_<nbrId>) and the slot itself is the iteration index. When Indexes is
    // wired, iterate the explicit NeighborIndex array (legacy behavior).
    const indexes = inputs['indexes'];
    const isExplicit = !!indexes;
    const loopHeader = isExplicit
      ? `for (let ${fi} = 0; ${fi} < ${indexes}.length; ${fi}++) {`
      : `for (let ${fi} = 0; ${fi} < nSz_${nbrId}; ${fi}++) {`;
    const slotExpr = isExplicit ? `((${indexes}[${fi}]) | 0)` : fi;
    const elemExpr = `r_${attr}[nIdx_${nbrId}[idx * nSz_${nbrId} + ${slotExpr}]]`;

    let cond: string;
    switch (op) {
      case 'notEquals':    cond = `${elemExpr} !== ${compare}`; break;
      case 'greater':      cond = `${elemExpr} > ${compare}`; break;
      case 'lesser':       cond = `${elemExpr} < ${compare}`; break;
      case 'greaterEqual': cond = `${elemExpr} >= ${compare}`; break;
      case 'lesserEqual':  cond = `${elemExpr} <= ${compare}`; break;
      default:             cond = `${elemExpr} === ${compare}`; break; // equals
    }

    return [
      `_v${nodeId}_result.length = 0; let ${vl} = 0;`,
      loopHeader,
      `  if (${cond}) _v${nodeId}_result[${vl}++] = ${slotExpr};`,
      `}`,
    ].join(' ') + '\n';
  },
};
