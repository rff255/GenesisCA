#!/usr/bin/env node
/**
 * Generates public/macros/GRA Rule Table.gcamacro — the authoring idiom of the
 * Graph-Rewriting Automata milestone, as a droppable default macro:
 *
 *     Neighbour Census ─┐
 *     Get Self Attribute ├→ Table Lookup (tag-valued) → Switch ─┬→ Idle (unwired)
 *                        ┘   "the rule IS a table"              ├→ Divide Agent
 *                                                               ├→ Kill Agent
 *                                                               ├→ Form Bond
 *                                                               └→ Break Bond
 *
 * That is the whole reduction the milestone rests on: a node-local graph rule is
 * `(own state, counts of neighbour states) → a table → one of a few verbs`, so the
 * user never meets a gluing morphism. Each verb line carries a labelled flow
 * reroute so the shape reads at a glance on drop (reroutes are collapsed at
 * compile time — they cost nothing).
 *
 * The three model-specific references are deliberately LEFT BLANK — the census
 * attribute, the own-state attribute and the rule table are per-model, so the
 * dropped macro shows amber "select a…" badges that tell the user exactly what to
 * fill in. Case 0 is Idle and is intentionally unwired: doing nothing is a verb.
 *
 * ⚠️ Vite indexes public/macros/ at STARTUP (and at closeBundle), so after
 * running this either restart the dev server or run a build, or index.json will
 * not list the macro.
 *
 * Re-run: node scripts/gen-gra-rule-table-macro.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../public/macros/GRA Rule Table.gcamacro');

const MACRO_ID = 'mac_gra_rule_table';
let c = 0;
const id = (p) => `${p}_gra${(c++).toString(36)}`;

const nodes = [], edges = [];
const node = (nodeType, config, col, row) => {
  const n = { id: id('n'), type: 'caNode', position: { x: col * 240, y: row * 110 }, data: { nodeType, config: config || {} } };
  nodes.push(n); return n;
};
const reroute = (label, col, row) => {
  const n = {
    id: id('r'), type: 'rerouteNode', position: { x: col * 240, y: row * 110 },
    data: { nodeType: 'reroute', portCategory: 'flow', label, config: {} },
  };
  nodes.push(n); return n;
};
const E = (s, sp, t, tp, cat) => edges.push({ id: id('e'), source: s.id, target: t.id, sourceHandle: `output_${cat}_${sp}`, targetHandle: `input_${cat}_${tp}` });
const vE = (s, sp, t, tp) => E(s, sp, t, tp, 'value');
const fE = (s, sp, t, tp) => E(s, sp, t, tp, 'flow');

// --- boundary --------------------------------------------------------------
const IN_DO = 'in_gra_do';
const OUT_NEXT = 'out_gra_next';
const mIn = node('macroInput', { macroDefId: MACRO_ID }, 0, 2);
const mOut = node('macroOutput', { macroDefId: MACRO_ID }, 6, 2);

// --- read: own state + the neighbour multiset -------------------------------
const own = node('getCellAttribute', { attributeId: '' }, 1, 0);
const census = node('neighbourCensus', { attributeId: '', source: 'bonded' }, 1, 1.4);

// --- decide: the rule table -------------------------------------------------
// Two axes by default: own state × the count of neighbours in state 1. Add axes
// on the Lookup Table attribute (Attributes ▸ the table) and wire more census
// ports here to widen the rule.
const table = node('lookupInteraction', { tableId: '' }, 2.4, 0.7);
vE(own, 'value', table, 'axis_0');
vE(census, 'count_1', table, 'axis_1');

// --- act: one branch per verb ----------------------------------------------
const sw = node('switch', {
  mode: 'value', valueType: 'integer', caseCount: 5, firstMatchOnly: true,
  _port_case_0_val: '0', _port_case_1_val: '1', _port_case_2_val: '2',
  _port_case_3_val: '3', _port_case_4_val: '4',
}, 3.6, 1.4);
vE(table, 'value', sw, 'value');
fE(mIn, IN_DO, sw, 'check');
fE(sw, 'next', mOut, OUT_NEXT);

// Case 0 = Idle: deliberately UNWIRED (doing nothing is a verb).
const idle = reroute('Idle - no verb', 4.7, 0.2);
fE(sw, 'case_0', idle, 'in');

const verbs = [
  ['case_1', 'Divide', 'divideAgent', {}],
  ['case_2', 'Die', 'killAgent', {}],
  ['case_3', 'Bond', 'formBond', {}],
  ['case_4', 'Unbond', 'breakBond', {}],
];
verbs.forEach(([caseId, label, verbType, cfg], i) => {
  const r = reroute(label, 4.7, 1.1 + i * 0.8);
  const v = node(verbType, cfg, 5.5, 1.1 + i * 0.8);
  fE(sw, caseId, r, 'in');
  fE(r, 'out', v, 'do');
});

const file = {
  schemaVersion: 1,
  name: 'GRA Rule Table',
  description: 'The graph-rewriting authoring idiom: neighbour census + own state → a rule table → one of {Idle, Divide, Die, Bond, Unbond}. Pick the census attribute, the own-state attribute and the Lookup Table after dropping.',
  macroDef: {
    id: MACRO_ID,
    name: 'GRA Rule Table',
    nodes, edges,
    exposedInputs: [{
      portId: IN_DO, label: 'Do', dataType: 'any', category: 'flow',
      internalNodeId: mIn.id, internalPortId: IN_DO,
    }],
    exposedOutputs: [{
      portId: OUT_NEXT, label: 'Next', dataType: 'any', category: 'flow',
      internalNodeId: mOut.id, internalPortId: OUT_NEXT,
    }],
  },
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(file, null, 2));
console.log(`Wrote ${OUT}  nodes: ${nodes.length}, edges: ${edges.length}`);
