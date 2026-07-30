import type { NodeTypeDef } from '../types';

/** Neighbour State Census — the multiset of neighbour states as ONE node with
 *  one labelled INTEGER output per state value of a tag/bool agent attribute,
 *  plus a `Total` (the live neighbour count).
 *
 *  This is the only legal input to a HOMOGENEOUS graph rule: a node cannot name
 *  its neighbours (there is no lattice ordering and the degree varies), so it can
 *  only read an order-independent, degree-tolerant aggregate — "2 red, 1 blue,
 *  0 green". Expressing that by hand meant
 *  `Get Bonded Agents → Get Agents Attribute → Count Matching` plus a tag constant
 *  ONCE PER STATE VALUE (9 nodes / 12 wires for a 4-state model, before the rule
 *  even starts).
 *
 *  `compile` returns '' — the node never reaches a compiler. A shared pre-compile
 *  transform (`expandNeighbourCensus`, censusExpand.ts) LOWERS it into exactly
 *  that hand-wired chain in ALL THREE agent front-ends, so it runs on JS, WASM and
 *  WebGPU with ZERO per-target emit (the `expandComposites` / `expandMultiAttrs` /
 *  `expandForceToAgents` pattern) and needs no entry in any supported-types set. */
export const NeighbourCensusNode: NodeTypeDef = {
  type: 'neighbourCensus',
  label: 'Neighbour Census',
  description: 'Counts the neighbours in each state of a tag/bool agent attribute — one output port per state value, plus the total. The input a graph rule reads.',
  category: 'aggregation',
  color: '#5e35b1',
  requirements: { bondGraph: true },
  ports: [
    // Only used by the `nearby` source; hidden for `bonded` (the default).
    { id: 'radius', label: 'Radius', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '5' },
    // The per-state count outputs (`count_<i>`) are DYNAMIC — derived from the
    // chosen attribute's options by `buildCensusPorts` (censusExpand.ts), which
    // BOTH CaNode and effectivePorts consume so they cannot drift.
    { id: 'total', label: 'Total', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  defaultConfig: { attributeId: '', source: 'bonded' },
  hiddenPorts: (config) => (config.source === 'nearby' ? [] : ['radius']),
  // Lowered before compile — see expandNeighbourCensus.
  compile: () => '',
};
