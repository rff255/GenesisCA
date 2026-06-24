import type { NodeTypeDef } from '../types';

/** Join Agents — combine two agent id-arrays by union or intersection (Generic
 *  Agent Platform). The agent analogue of Join Neighbors over plain integer ids
 *  (the agent empty sentinel is -1, not INVALID_NI). Use it to merge nearby ∪
 *  bonded, or to intersect "nearby" with "of my type". Multi-output: `result`
 *  (the combined ids) + `count`. JS-only this milestone. */
export const JoinAgentsNode: NodeTypeDef = {
  type: 'joinAgents',
  label: 'Join Agents',
  description: 'Combines two agent id-arrays — union (all unique) or intersection (in both). Outputs the combined array + count.',
  category: 'aggregation',
  color: '#5e35b1',
  requirements: { bondGraph: true },
  ports: [
    { id: 'a', label: 'A', kind: 'input', category: 'value', dataType: 'integer', isArray: true },
    { id: 'b', label: 'B', kind: 'input', category: 'value', dataType: 'integer', isArray: true },
    { id: 'result', label: 'Result', kind: 'output', category: 'value', dataType: 'integer', isArray: true },
    { id: 'count', label: 'Count', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: { operation: 'union' },
  compile: (nodeId, config, inputs) => {
    const a = inputs['a'] || '[]';
    const b = inputs['b'] || '[]';
    const op = config.operation as string;
    const cnt = `_v${nodeId}_count`;
    const R = `_v${nodeId}_result`;
    if (op === 'intersection') {
      // ids present in BOTH a and b (deduped), excluding the -1 empty sentinel.
      return [
        `${R}.length = 0; let ${cnt} = 0;`,
        `{const __a=${a},__b=${b},__seen=new Set();`,
        ` for(let __i=0;__i<__a.length;__i++){const __x=(__a[__i])|0; if(__x!==-1&&!__seen.has(__x)&&__b.indexOf(__x)>=0){__seen.add(__x);${R}[${cnt}++]=__x;}}}`,
      ].join(' ') + '\n';
    }
    // union — all unique ids across a and b, excluding -1.
    return [
      `${R}.length = 0; let ${cnt} = 0;`,
      `{const __seen=new Set();`,
      ` const __push=(__arr)=>{for(let __i=0;__i<__arr.length;__i++){const __x=(__arr[__i])|0; if(__x!==-1&&!__seen.has(__x)){__seen.add(__x);${R}[${cnt}++]=__x;}}};`,
      ` __push(${a}); __push(${b});}`,
    ].join(' ') + '\n';
  },
};
