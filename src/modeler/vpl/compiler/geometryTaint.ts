// ===========================================================================
// C8 (P9) — THE PRESENTATIONAL-GEOMETRY TAINT CHECK.
//
// ONE question, answered statically from the model alone:
//
//     Does geometry ever feed a model DECISION?
//
// If it never does, the whole force / motion / layout block is *presentation* —
// where things sit, not what the simulation computes — and the pipeline panel
// says so. If it does, the model is in today's exact, seeded, lockstep regime
// and nothing changes.
//
// ---------------------------------------------------------------------------
// THIS IS A GRANT OF FREEDOMS, NOT A COMPATIBILITY GATE (proposal §P9)
// ---------------------------------------------------------------------------
// A model whose rules read positions into decisions is FULLY SUPPORTED. Reading
// a position is a PROMOTION: it moves the layout physics from "how the
// simulation looks" into "part of what the simulation computes", and the
// exactness obligations follow from that promotion. So a "tainted" verdict is
// never an error, never a warning, and never blocks anything — it only means the
// layout is load-bearing, so the freedoms P9 would grant (ticking the layout on
// its own cadence, keeping it GPU-side with no readback) are not available.
//
// C8 is DETECTION ONLY. No cadence or location decoupling is implemented here,
// and NOTHING in the engine, the compilers or the worker changes.
//
// ---------------------------------------------------------------------------
// THE CRITERION IS DATAFLOW TAINT, NOT "no position-reading node"
// ---------------------------------------------------------------------------
// Geometry is presentational iff no dataflow path in any rule graph leads from a
// GEOMETRY READ into NON-GEOMETRIC STATE. A geometry read that feeds only a
// geometry WRITE keeps geometry in a closed loop and stays presentational —
// `Cubic GRA`'s midpoint newborn placement (`Get Self Position` + `Get Agent
// Position` → an expression → `Create Agent`'s x/y) is exactly this: the emergent
// topology is identical under any layout, only WHERE things sit differs.
//
// SOURCES (a value read that depends on where things are):
//   · positions / offsets — getSelfPosition, getAgentPosition, getAgentOffset,
//     behaviourStep.myX/myY/myZ, divisionEvent.axisDefaultX/Y/Z
//   · velocity — getVelocity, behaviourStep has none (velocity is a read node)
//   · curvature — getCurvature (a fold over bonded partners' OFFSETS)
//   · proximity queries — getNearbyAgents, getAgentsInView, senseHemifield,
//     neighbourDensity, neighbourCensus with `source: 'nearby'`
//   · field samples at the agent's location — sampleField, fieldGradient,
//     readCellsUnder
//   · bond geometry — forEachBond.currentLength
//   · body size WHEN THE ENGINE'S GROWTH RAMP ADVANCES IT — see RADIUS below
//
// ENGINE-GEOMETRIC CONFIG (geometry → topology with no wire to follow):
//   · a reachable Divide Agent whose RESOLVED partition is `tension` — geometry
//     decides which bonds each daughter keeps
//   · auto-bond ON — the engine forms and breaks bonds BY DISTANCE
//
// SINKS (non-geometric state):
//   · attribute writes — setAttribute (self or by id), updateAttribute,
//     setBondAttribute
//   · indicators — setIndicator, updateIndicator
//   · halt — stopEvent
//   · field deposits — affectCellsUnder, secreteToField (UNCONDITIONAL: the
//     deposit LOCATION is the agent's position, and the cell rule then reads that
//     cell, so the closed agent↔grid loop is geometry → cell state by construction)
//   · structural verbs — divideAgent, killAgent, formBond, breakBond, rewireBond,
//     transferBond, createAgent, addAgentToWorld — tainted when their flow
//     CONDITION cone is tainted or a partner/target id is geometry-derived
//   · ANY OTHER FLOW NODE. The allowlist below names the geometry-only sinks;
//     everything else with a flow port taints. That inversion is what makes the
//     check conservative and future-proof: a new state-writing node taints from
//     the day it is added, unless someone deliberately allowlists it.
//
// GEOMETRY-ONLY SINKS (never taint, whatever feeds them):
//   applyForce / applyForceToAgent / applyForceToAgents, setVelocity,
//   setAgentPosition, setAgentRadius, setTargetRadius, setCellLooks,
//   setAgentSprite. Plus two geometry-only INPUT PORTS on otherwise-tainting
//   verbs: `createAgent.{x,y,z,radius}` (the Cubic-GRA-midpoint rule) and
//   `divideAgent.{axisX,axisY,axisZ,asymmetry}` (the axis only picks daughter
//   POSITIONS — the case where it also picks which bonds each daughter keeps is
//   the `tension` partition, which taints on its own).
//
// ---------------------------------------------------------------------------
// RADIUS — a deliberate, gated EXTENSION of the runbook's source list
// ---------------------------------------------------------------------------
// The body radius is written by the ENGINE'S GROWTH RAMP, which lives INSIDE the
// force-iteration loop (C2's `forces` group) — precisely the block P9 wants to
// decouple. So "divide when radius ≥ 2.9" IS a geometry-timed decision whenever
// growth is on. But with growth OFF the radius only ever changes when the graph
// writes it, and reading it is then an ordinary graph-owned state read.
//
// So radius reads (getRadius, getAgentRadius, behaviourStep.myRadius/myArea,
// divisionEvent.myArea) are a geometry source IFF the engine growth ramp is
// active — resolved with `usesEngineGrowth` + `growthRate`, the SAME resolvers
// the pipeline panel reads, never a parallel truth.
//
// AGE is NOT a source: the engine advances it exactly once per generation (the
// force pass increments, the driver subtracts `iterations − 1`), so it is a
// generation counter, not geometry.
// TOPOLOGY IS NOT GEOMETRY: bond degree, the bonded 1-ring, bond attributes and
// `forEachBond.partnerId` are graph structure. Topology that was BUILT from
// distance is covered by the auto-bond rule above, which taints the model
// outright.
//
// ---------------------------------------------------------------------------
// THE CELL GRAPH
// ---------------------------------------------------------------------------
// A lattice cell's position is FIXED — `Get Cell Position` is an index into an
// immutable grid, not a moving position — so no cell node is a geometry source.
// The one place agent geometry reaches cell state is the FIELD BRIDGE, and that
// is caught at the DEPOSIT (`affectCellsUnder` / `secreteToField`), on the agent
// side, before it ever becomes cell state. So the cell graph contributes no
// taint and is deliberately not walked.
//
// PURE. No React, no worker, no compiler state — safe in a `useMemo` and in a
// Node harness (`scripts/test-geometry-taint.mjs` pins the verdicts against a
// recorded hand-audit of the shipped models).
// ===========================================================================

import type { CAModel, GraphEdge, GraphNode } from '../../../model/types';
import { cbNum, resolveMaxBonds, usesEngineGrowth, usesEngineSprings } from '../../../model/centerBased';
import { dividePartitionFromConfig } from './dividePartition';
import { expandMacros } from './macroExpand';
import { collapseReroutes } from './rerouteCollapse';

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/** One hop of a witness path. */
export interface TaintStep {
  /** Node id in the FLATTENED graph (macro internals carry their prefixed id). */
  nodeId: string;
  nodeType: string;
  /** Human-readable node name, plus its attribute/variable where it has one. */
  label: string;
  /** The port the taint left / entered by, when the hop is a wire. */
  port?: string;
  /** Set on the first step: why this counts as a geometry read. */
  sourceKind?: string;
  /** Set on the last step: why this counts as non-geometric state. */
  sinkKind?: string;
}

/** WHY a model is not presentational — a readable path from a geometry read to
 *  the state it decides, or a one-step statement for an engine-config taint. */
export interface TaintPath {
  /** e.g. `Get Nearby Agents → For Each In Array → Aggregate → Set Attribute "alive"`. */
  summary: string;
  steps: TaintStep[];
  /** How the taint reached the sink:
   *   dataflow      — a wire carries a geometry-derived value into state
   *   condition     — a branch CONDITION is geometry-derived, so the decision is
   *   location      — the write lands wherever the agent is (a field deposit)
   *   engine-config — geometry → topology with no wire to follow (tension
   *                   partition, auto-bond), or an unanalysable construct */
  via: 'dataflow' | 'condition' | 'location' | 'engine-config';
}

export interface GeometryTaintResult {
  /** False for a model with no agent layer: it has no layout physics, so
   *  "presentational" is not a meaningful thing to say about it. */
  applicable: boolean;
  /** True ⇒ geometry never feeds a model decision ⇒ the force / motion / layout
   *  block is presentation. Always false when `applicable` is false. */
  presentational: boolean;
  /** The most explanatory reason it is NOT presentational (undefined when it is). */
  witness?: TaintPath;
  /** Every reason found, in a deterministic order (the UI shows the first; the
   *  harness prints them all). Capped — see MAX_WITNESSES. */
  witnesses: TaintPath[];
}

const MAX_WITNESSES = 12;

// ---------------------------------------------------------------------------
// Node vocabulary
// ---------------------------------------------------------------------------

/** Geometry-source OUTPUT ports, per node type. `'*'` = every output port. */
const GEOMETRY_SOURCE_PORTS: Record<string, { ports: '*' | string[]; kind: string }> = {
  getSelfPosition:   { ports: '*',                          kind: 'reads this agent’s position' },
  getAgentPosition:  { ports: '*',                          kind: 'reads another agent’s position' },
  getAgentOffset:    { ports: '*',                          kind: 'reads the offset / distance to another agent' },
  getVelocity:       { ports: '*',                          kind: 'reads a velocity' },
  getCurvature:      { ports: '*',                          kind: 'folds the offsets to the bonded partners' },
  getNearbyAgents:   { ports: '*',                          kind: 'a proximity query — which agents are within a radius' },
  getAgentsInView:   { ports: '*',                          kind: 'a proximity + field-of-view query' },
  senseHemifield:    { ports: '*',                          kind: 'a proximity query split left / right of the heading' },
  neighbourDensity:  { ports: '*',                          kind: 'counts the agents within the interaction range' },
  sampleField:       { ports: '*',                          kind: 'samples the cell field AT this agent’s position' },
  fieldGradient:     { ports: '*',                          kind: 'samples the cell field’s gradient AT this agent’s position' },
  readCellsUnder:    { ports: '*',                          kind: 'reads the cells under this agent' },
  forEachBond:       { ports: ['currentLength'],            kind: 'the CURRENT length of a bond — a distance' },
  behaviourStep:     { ports: ['myX', 'myY', 'myZ'],        kind: 'reads this agent’s position' },
  divisionEvent:     { ports: ['axisDefaultX', 'axisDefaultY', 'axisDefaultZ'], kind: 'the division axis the engine resolved from the mother’s geometry' },
};

/** Radius / area reads — a geometry source ONLY when the engine growth ramp
 *  advances the radius (see the RADIUS note in the header). */
const RADIUS_SOURCE_PORTS: Record<string, '*' | string[]> = {
  getRadius: '*',
  getAgentRadius: '*',
  behaviourStep: ['myRadius', 'myArea'],
  divisionEvent: ['myArea'],
};
const RADIUS_SOURCE_KIND = 'reads the body radius, which the engine’s growth ramp advances inside the force loop';

/** `neighbourCensus` is a source only in its PROXIMITY mode; over the bonded
 *  1-ring it is pure topology. The config key is the node's own `source`. */
const CENSUS_PROXIMITY_KIND = 'a proximity census — which agents are within a radius';

/** Flow nodes that can never taint, whatever feeds them: they write geometry
 *  (or pure presentation) and nothing else. */
const GEOMETRY_ONLY_SINKS = new Set([
  'applyForce', 'applyForceToAgent', 'applyForceToAgents',
  'setVelocity', 'setAgentPosition', 'setAgentRadius', 'setTargetRadius',
  'setCellLooks', 'setAgentSprite',
]);

/** Pure control flow — never a sink; it only routes. */
const CONTROL_FLOW = new Set([
  'conditional', 'sequence', 'switch', 'loop', 'forEachInArray', 'forEachBond',
  'behaviourStep', 'periodicStep', 'agentInit', 'divisionEvent', 'agentOutputMapping',
  'agentInputMapping',
]);

/** Local variables are per-agent, per-step SCRATCH, not state — so a write is a
 *  CONDUIT, not a sink. Taint flows through the variable id instead. */
const VARIABLE_WRITES = new Set(['setVariable', 'setArrayElement']);

/** Structural verbs. They taint on a tainted flow CONDITION or a geometry-derived
 *  agent id, but their geometry-only value ports (below) are exempt. */
const STRUCTURAL_VERBS = new Set([
  'divideAgent', 'killAgent', 'formBond', 'breakBond', 'rewireBond',
  'transferBond', 'createAgent', 'addAgentToWorld',
]);

/** Value INPUT ports that carry geometry into an otherwise-tainting verb and
 *  therefore do not taint it. */
const GEOMETRY_ONLY_INPUT_PORTS: Record<string, Set<string>> = {
  createAgent: new Set(['x', 'y', 'z', 'radius']),
  divideAgent: new Set(['axisX', 'axisY', 'axisZ', 'asymmetry']),
};

/** Field deposits taint unconditionally — the deposit LOCATION is the agent's
 *  position, so the cell state that results is geometry-dependent whatever the
 *  deposited value is. */
const FIELD_DEPOSITS = new Set(['affectCellsUnder', 'secreteToField']);

/** Human sink descriptions for the witness. */
const SINK_KIND: Record<string, string> = {
  setAttribute: 'writes an agent attribute (its own, or another’s by id)',
  updateAttribute: 'modifies an agent attribute',
  setBondAttribute: 'writes a bond attribute',
  setIndicator: 'writes an indicator',
  updateIndicator: 'modifies an indicator',
  stopEvent: 'halts the simulation',
  affectCellsUnder: 'deposits into the cell field under this agent',
  secreteToField: 'deposits into the cell field at this agent’s position',
  divideAgent: 'divides this agent',
  killAgent: 'kills this agent',
  formBond: 'forms a bond',
  breakBond: 'breaks a bond',
  rewireBond: 'moves a bond',
  transferBond: 'hands a bond to a new partner',
  createAgent: 'creates an agent',
  addAgentToWorld: 'adds an agent to the world',
};

/** Readable node names for the witness (no registry import — this module stays
 *  dependency-light so it is cheap in a `useMemo` and in a Node harness). */
const NODE_LABEL: Record<string, string> = {
  getSelfPosition: 'Get Self Position', getAgentPosition: 'Get Agent Position',
  getAgentOffset: 'Get Agent Offset', getVelocity: 'Get Velocity',
  getCurvature: 'Get Curvature', getNearbyAgents: 'Get Nearby Agents',
  getAgentsInView: 'Get Agents In View', senseHemifield: 'Sense Hemifield',
  neighbourDensity: 'Neighbour Density', neighbourCensus: 'Neighbour Census',
  sampleField: 'Sample Field', fieldGradient: 'Field Gradient',
  readCellsUnder: 'Read Cells Under', affectCellsUnder: 'Affect Cells Under',
  secreteToField: 'Secrete To Field', forEachBond: 'For Each Bond',
  forEachInArray: 'For Each In Array', behaviourStep: 'Behaviour Step',
  periodicStep: 'Periodic Step', agentInit: 'Agent Init Event',
  divisionEvent: 'Division Event', agentOutputMapping: 'Agent Output Mapping',
  agentInputMapping: 'Agent Input Mapping',
  getRadius: 'Get Radius', getAgentRadius: 'Get Agent Radius',
  getAgentsAttribute: 'Get Agents Attribute', getAgentAttribute: 'Get Agent Attribute',
  getCellAttribute: 'Get Self Attribute', setAttribute: 'Set Attribute',
  updateAttribute: 'Update Attribute',
  setBondAttribute: 'Set Bond Attribute',
  getBondAttribute: 'Get Bond Attribute', setIndicator: 'Set Indicator',
  updateIndicator: 'Update Indicator', stopEvent: 'Stop Event',
  divideAgent: 'Divide Agent', killAgent: 'Kill Agent', formBond: 'Form Bond',
  breakBond: 'Break Bond', rewireBond: 'Rewire Bond',
  transferBond: 'Transfer Bond',
  createAgent: 'Create Agent',
  addAgentToWorld: 'Add Agent To World', setVariable: 'Set Variable',
  setArrayElement: 'Set Array Element', getVariable: 'Get Variable',
  aggregate: 'Aggregate', groupOperator: 'Group Reduce', statement: 'Compare',
  logicOperator: 'Logic', arithmeticOperator: 'Math', expression: 'Expression',
  valueSwitch: 'Value Switch', lookupInteraction: 'Table Lookup',
  conditional: 'If / Then', switch: 'Switch', loop: 'Loop', sequence: 'Sequence',
  applyForce: 'Apply Force', setVelocity: 'Set Velocity',
  setAgentPosition: 'Set Agent Position', setCellLooks: 'Set Cell Looks',
};

function humanise(nodeType: string): string {
  const known = NODE_LABEL[nodeType];
  if (known) return known;
  // camelCase → Title Case, so an unknown node still reads as words.
  const spaced = nodeType.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** The node's label plus the thing it names, so a witness distinguishes
 *  `Set Attribute "alive"` from `Set Attribute "carrying"`. */
function labelOf(node: GraphNode): string {
  const cfg = node.data?.config ?? {};
  const subject = cfg.attributeId ?? cfg.variableId ?? cfg.indicatorId ?? cfg.tableId;
  const base = humanise(node.data?.nodeType ?? '?');
  return subject ? `${base} “${String(subject)}”` : base;
}

// ---------------------------------------------------------------------------
// Handle parsing
// ---------------------------------------------------------------------------

const HANDLE_RE = /^(input|output)_(value|flow)_(.+)$/;

interface Handle { dir: 'input' | 'output'; category: 'value' | 'flow'; port: string }

function parseHandle(h: string | undefined): Handle | null {
  const m = HANDLE_RE.exec(h ?? '');
  if (!m) return null;
  return { dir: m[1] as 'input' | 'output', category: m[2] as 'value' | 'flow', port: m[3]! };
}

const key = (nodeId: string, port: string) => `${nodeId}:${port}`;

// ---------------------------------------------------------------------------
// The analysis
// ---------------------------------------------------------------------------

/** Does the model's layout physics ever feed a model decision?
 *
 *  Conservative by construction: an unknown flow node taints, a macro that
 *  cannot be expanded taints, and every "clean" classification is an explicit
 *  entry in one of the tables above. */
export function analyzeGeometryTaint(model: CAModel): GeometryTaintResult {
  if (!model.topologyMode?.agents) {
    return { applicable: false, presentational: false, witnesses: [] };
  }

  const witnesses: TaintPath[] = [];
  const addWitness = (w: TaintPath) => {
    if (witnesses.length >= MAX_WITNESSES) return;
    if (witnesses.some(x => x.summary === w.summary)) return;
    witnesses.push(w);
  };

  const cfg = model.centerBased;

  // -------------------------------------------------------------------------
  // 1. ENGINE-GEOMETRIC CONFIG — geometry → topology with no wire to follow.
  //    Auto-bond is resolved with the SAME expression the pipeline panel uses
  //    (springs ∧ autoBond ∧ bonds > 0), so the check cannot claim a phase the
  //    engine does not run.
  // -------------------------------------------------------------------------
  const autoBondActive = usesEngineSprings(cfg) && !!cfg?.autoBond && resolveMaxBonds(cfg) > 0;
  if (autoBondActive) {
    addWitness({
      via: 'engine-config',
      summary: 'Auto-bond forms and breaks bonds BY DISTANCE — the topology your rule reads is built from where agents sit.',
      steps: [{
        nodeId: '', nodeType: 'engine:autoBond', label: 'Auto-bond by distance',
        sourceKind: 'the engine bonds agents that come within '
          + `${cbNum(cfg, 'formDistance')}×contact and breaks past ${cbNum(cfg, 'breakDistance')}×contact`,
        sinkKind: 'changes the bond graph',
      }],
    });
  }

  // -------------------------------------------------------------------------
  // 2. FLATTEN — the same two structural transforms every compiler front-end
  //    runs first, so macro internals and reroute relays are analysed for real
  //    rather than treated as opaque. A macro that CANNOT be expanded taints.
  // -------------------------------------------------------------------------
  const rawNodes = (model.agentGraphNodes ?? []) as GraphNode[];
  const rawEdges = (model.agentGraphEdges ?? []) as GraphEdge[];
  const expanded = expandMacros([...rawNodes], [...rawEdges], model);
  if (expanded.error) {
    addWitness({
      via: 'engine-config',
      summary: `The agent graph could not be flattened (${expanded.error}), so it is treated as geometry-coupled.`,
      steps: [{ nodeId: '', nodeType: 'macro', label: 'Macro expansion', sinkKind: 'unanalysable' }],
    });
  }
  const flat = collapseReroutes(expanded.nodes, expanded.edges);
  const nodes = flat.nodes;
  const edges = flat.edges;
  const byId = new Map(nodes.map(n => [n.id, n]));

  // A macro instance that survived expansion has no definition — unanalysable.
  for (const n of nodes) {
    if (n.data?.nodeType === 'macro' || n.data?.nodeType === 'macroInput' || n.data?.nodeType === 'macroOutput') {
      addWitness({
        via: 'engine-config',
        summary: 'A macro instance could not be resolved, so its contents are treated as geometry-coupled.',
        steps: [{ nodeId: n.id, nodeType: 'macro', label: labelOf(n), sinkKind: 'unanalysable' }],
      });
    }
  }

  // --- edge indexes ---------------------------------------------------------
  /** value edges INTO a node: target → [{ sourcePortKey, targetPort }] */
  const valueIn = new Map<string, Array<{ from: string; fromPort: string; port: string }>>();
  /** value edges OUT of a node port: `${nodeId}:${port}` → [targetNodeId] */
  const valueOut = new Map<string, string[]>();
  /** flow edges OUT of a node: nodeId → [{ port, target }] */
  const flowOut = new Map<string, Array<{ port: string; target: string }>>();

  for (const e of edges) {
    const s = parseHandle(e.sourceHandle);
    const t = parseHandle(e.targetHandle);
    if (!s || !t) continue;
    if (s.category === 'value' && t.category === 'value') {
      const list = valueIn.get(e.target);
      const entry = { from: e.source, fromPort: s.port, port: t.port };
      if (list) list.push(entry); else valueIn.set(e.target, [entry]);
      const k = key(e.source, s.port);
      const outs = valueOut.get(k);
      if (outs) outs.push(e.target); else valueOut.set(k, [e.target]);
    } else if (s.category === 'flow' && t.category === 'flow') {
      const list = flowOut.get(e.source);
      const entry = { port: s.port, target: e.target };
      if (list) list.push(entry); else flowOut.set(e.source, [entry]);
    }
  }

  // --- geometry sources -----------------------------------------------------
  const radiusIsGeometry = usesEngineGrowth(cfg) && cbNum(cfg, 'growthRate') > 0;

  /** Which of a node's OUTPUT ports are geometry sources, with the reason. */
  function sourcePortsOf(node: GraphNode): Array<{ port: '*' | string; kind: string }> {
    const t = node.data?.nodeType ?? '';
    const out: Array<{ port: '*' | string; kind: string }> = [];
    const geo = GEOMETRY_SOURCE_PORTS[t];
    if (geo) {
      if (geo.ports === '*') out.push({ port: '*', kind: geo.kind });
      else for (const p of geo.ports) out.push({ port: p, kind: geo.kind });
    }
    if (radiusIsGeometry) {
      const rad = RADIUS_SOURCE_PORTS[t];
      if (rad === '*') out.push({ port: '*', kind: RADIUS_SOURCE_KIND });
      else if (rad) for (const p of rad) out.push({ port: p, kind: RADIUS_SOURCE_KIND });
    }
    // The census reads the bonded 1-ring (topology) OR a proximity set. Only the
    // proximity mode is a geometry read.
    if (t === 'neighbourCensus' && String(node.data?.config?.source ?? 'bonded') === 'nearby') {
      out.push({ port: '*', kind: CENSUS_PROXIMITY_KIND });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // 3. THE FIXPOINT. Value taint and flow-gate taint feed each other (a value
  //    written into a local variable under a geometry-dependent branch is
  //    tainted even when the value itself is a constant), so both are iterated
  //    together until nothing new is discovered.
  // -------------------------------------------------------------------------

  /** Tainted value ports (`${nodeId}:${port}`) → how they got tainted. */
  const taintedPorts = new Map<string, { fromKey?: string; sourceKind?: string; viaVar?: string }>();
  /** Tainted local-variable ids → the port key (or gate key) that tainted them. */
  const taintedVars = new Map<string, { fromKey?: string; gateKey?: string }>();
  /** Sinks found, keyed by node id so a re-run does not duplicate them. */
  const sinks = new Map<string, TaintPath>();

  const markPort = (k: string, origin: { fromKey?: string; sourceKind?: string; viaVar?: string }) => {
    if (taintedPorts.has(k)) return false;
    taintedPorts.set(k, origin);
    return true;
  };

  /** Is this input port exempt (it carries geometry INTO a geometry-only slot)? */
  const isExemptInput = (nodeType: string, port: string) =>
    GEOMETRY_ONLY_INPUT_PORTS[nodeType]?.has(port) ?? false;

  /** The tainted, non-exempt value inputs of a node, as [port, sourceKey] pairs. */
  function taintedInputsOf(node: GraphNode): Array<{ port: string; fromKey: string }> {
    const t = node.data?.nodeType ?? '';
    const hits: Array<{ port: string; fromKey: string }> = [];
    for (const e of valueIn.get(node.id) ?? []) {
      if (isExemptInput(t, e.port)) continue;
      const k = key(e.from, e.fromPort);
      if (taintedPorts.has(k)) hits.push({ port: e.port, fromKey: k });
    }
    // A Get Variable reads a tainted variable.
    if (t === 'getVariable') {
      const v = String(node.data?.config?.variableId ?? '');
      if (v && taintedVars.has(v)) hits.push({ port: 'variable', fromKey: `var:${v}` });
    }
    return hits;
  }

  /** Seed + propagate value taint to a fixpoint. Returns true when it grew. */
  function propagateValues(): boolean {
    let grew = false;
    // Seed the declared sources.
    for (const n of nodes) {
      for (const s of sourcePortsOf(n)) {
        if (s.port === '*') {
          // Every WIRED output port of the node (the wiring is the ground truth,
          // so dynamic ports are covered without a port table).
          for (const e of edges) {
            if (e.source !== n.id) continue;
            const h = parseHandle(e.sourceHandle);
            if (!h || h.category !== 'value') continue;
            if (markPort(key(n.id, h.port), { sourceKind: s.kind })) grew = true;
          }
        } else if (markPort(key(n.id, s.port), { sourceKind: s.kind })) grew = true;
      }
    }
    // Propagate: any tainted non-exempt input taints every wired output.
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of nodes) {
        const t = n.data?.nodeType ?? '';
        // Control flow and sinks do not forward value taint through this rule;
        // control-flow OUTPUTS (element / index / partnerId …) are handled below.
        if (VARIABLE_WRITES.has(t)) continue;
        const hits = taintedInputsOf(n);
        if (hits.length === 0) continue;
        // `forEachBond` iterates the bond list (topology), so a tainted input —
        // it has none today — must not taint `partnerId`. Its geometry output is
        // declared as a source instead.
        if (t === 'forEachBond') continue;
        for (const e of edges) {
          if (e.source !== n.id) continue;
          const h = parseHandle(e.sourceHandle);
          if (!h || h.category !== 'value') continue;
          if (markPort(key(n.id, h.port), { fromKey: hits[0]!.fromKey })) { changed = true; grew = true; }
        }
      }
    }
    return grew;
  }

  // --- the flow walk --------------------------------------------------------

  interface Gate { tainted: boolean; viaKey?: string }

  /** Ports whose taint elevates the gate of a control node's BRANCH outputs. */
  function gateInputsOf(node: GraphNode): Array<{ port: string; fromKey: string }> {
    const t = node.data?.nodeType ?? '';
    const hits = taintedInputsOf(node);
    if (hits.length === 0) return [];
    switch (t) {
      case 'conditional': return hits.filter(h => h.port === 'condition');
      case 'loop': return hits.filter(h => h.port === 'count' || h.port === 'from' || h.port === 'to');
      case 'forEachInArray': return hits.filter(h => h.port === 'array');
      case 'switch': return hits; // value + every case_N_cond / case_N_val
      default: return [];
    }
  }

  /** Record a sink, building its witness by walking the taint back to a source. */
  function recordSink(node: GraphNode, reason: { fromKey?: string; port?: string; gate?: Gate; unconditional?: boolean }): boolean {
    if (sinks.has(node.id)) return false;
    const t = node.data?.nodeType ?? '';
    const sinkKind = SINK_KIND[t] ?? 'writes model state';

    if (reason.unconditional) {
      const label = labelOf(node);
      sinks.set(node.id, {
        via: 'location',
        summary: `${label} — the deposit lands on the cells under this agent, so WHERE it is decides which cells change.`,
        steps: [{
          nodeId: node.id, nodeType: t, label,
          sourceKind: 'the deposit location is this agent’s position',
          sinkKind,
        }],
      });
      return true;
    }

    const via: TaintPath['via'] = reason.fromKey ? 'dataflow' : 'condition';
    const steps = walkBack(reason.fromKey ?? reason.gate?.viaKey);
    const sinkLabel = reason.port ? `${labelOf(node)} · ${reason.port}` : labelOf(node);
    steps.push({ nodeId: node.id, nodeType: t, label: sinkLabel, port: reason.port, sinkKind });

    const head = steps.slice(0, -1).map(s => s.label);
    const tail = steps[steps.length - 1]!.label;
    const summary = head.length === 0
      ? tail
      : `${head.join(' → ')}${via === 'condition' ? ' ⟹ decides whether to run ⟹ ' : ' → '}${tail}`;
    sinks.set(node.id, { via, summary, steps });
    return true;
  }

  /** Reconstruct the chain of hops from a tainted port back to its source. The
   *  first step names the PORT that made it geometry, so a multi-output node
   *  (`Behaviour Step · myRadius` vs `· myBondDegree`) is unambiguous. */
  function walkBack(startKey: string | undefined): TaintStep[] {
    const chain: TaintStep[] = [];
    const seen = new Set<string>();
    let k = startKey;
    let guard = 0;
    while (k && !seen.has(k) && guard++ < 200) {
      seen.add(k);
      if (k.startsWith('var:')) {
        const v = k.slice(4);
        chain.push({ nodeId: '', nodeType: 'variable', label: `variable “${v}”` });
        const o = taintedVars.get(v);
        k = o?.fromKey ?? o?.gateKey;
        continue;
      }
      const sep = k.lastIndexOf(':');
      const nodeId = k.slice(0, sep);
      const port = k.slice(sep + 1);
      const n = byId.get(nodeId);
      if (!n) break;
      const origin = taintedPorts.get(k);
      chain.push({
        nodeId, nodeType: n.data?.nodeType ?? '?', port,
        label: origin?.sourceKind ? `${labelOf(n)} · ${port}` : labelOf(n),
        sourceKind: origin?.sourceKind,
      });
      if (origin?.sourceKind) break;   // reached the geometry read
      k = origin?.fromKey;
    }
    return chain.reverse();
  }

  /** Walk one root's flow tree, carrying the accumulated branch gate. */
  function walkFlow(startId: string, gate: Gate, visited: Map<string, boolean>): boolean {
    let grew = false;
    const stack: Array<{ id: string; gate: Gate }> = [{ id: startId, gate }];
    while (stack.length) {
      const { id, gate: g } = stack.pop()!;
      const prev = visited.get(id);
      // Revisit only when arriving with a STRICTLY stronger (tainted) gate.
      if (prev !== undefined && (prev || !g.tainted)) continue;
      visited.set(id, g.tainted);

      const node = byId.get(id);
      if (!node) continue;
      const t = node.data?.nodeType ?? '';
      const hits = taintedInputsOf(node);

      // --- classify the node --------------------------------------------------
      if (VARIABLE_WRITES.has(t)) {
        const v = String(node.data?.config?.variableId ?? '');
        if (v && !taintedVars.has(v)) {
          if (hits.length > 0) { taintedVars.set(v, { fromKey: hits[0]!.fromKey }); grew = true; }
          else if (g.tainted) { taintedVars.set(v, { gateKey: g.viaKey }); grew = true; }
        }
      } else if (FIELD_DEPOSITS.has(t)) {
        if (recordSink(node, { unconditional: true })) grew = true;
      } else if (GEOMETRY_ONLY_SINKS.has(t)) {
        // Never taints — it writes geometry (or presentation) and nothing else.
      } else if (STRUCTURAL_VERBS.has(t)) {
        if (hits.length > 0) { if (recordSink(node, { fromKey: hits[0]!.fromKey, port: hits[0]!.port })) grew = true; }
        else if (g.tainted) { if (recordSink(node, { gate: g })) grew = true; }
        // A tension partition is geometry → topology with no wire to follow.
        if (t === 'divideAgent') {
          const spec = dividePartitionFromConfig(node.data?.config ?? {}, model);
          if (spec.mode === 'tension' && !sinks.has(`${node.id}:tension`)) {
            sinks.set(`${node.id}:tension`, {
              via: 'engine-config',
              summary: 'Divide Agent partitions the mother’s bonds by the TENSION AXIS — geometry decides which bonds each daughter keeps.',
              steps: [{
                nodeId: node.id, nodeType: t, label: labelOf(node),
                sourceKind: 'the tension axis is computed from the bonded partners’ offsets',
                sinkKind: 'decides which daughter keeps which bond',
              }],
            });
            grew = true;
          }
        }
      } else if (!CONTROL_FLOW.has(t)) {
        // THE CONSERVATIVE DEFAULT: any other flow node writes model state.
        if (hits.length > 0) { if (recordSink(node, { fromKey: hits[0]!.fromKey, port: hits[0]!.port })) grew = true; }
        else if (g.tainted) { if (recordSink(node, { gate: g })) grew = true; }
      }

      // --- descend ------------------------------------------------------------
      const gateHits = gateInputsOf(node);
      const branchGate: Gate = gateHits.length > 0
        ? { tainted: true, viaKey: gateHits[0]!.fromKey }
        : g;
      for (const { port, target } of flowOut.get(id) ?? []) {
        // `next` leaves the construct and returns to the enclosing gate; every
        // other flow output is a BRANCH body, gated by this node's condition.
        stack.push({ id: target, gate: port === 'next' ? g : branchGate });
      }
    }
    return grew;
  }

  const ROOT_TYPES = new Set(['behaviourStep', 'periodicStep', 'agentInit', 'divisionEvent', 'agentOutputMapping', 'agentInputMapping']);
  const roots = nodes.filter(n => ROOT_TYPES.has(n.data?.nodeType ?? ''));

  // Iterate value taint ⇄ flow walk until neither grows (both are monotone, so
  // this terminates; the bound is belt-and-braces for a pathological graph).
  for (let pass = 0; pass < 16; pass++) {
    let grew = propagateValues();
    const visited = new Map<string, boolean>();
    for (const r of roots) if (walkFlow(r.id, { tainted: false }, visited)) grew = true;
    if (!grew) break;
  }

  for (const w of [...sinks.values()]) addWitness(w);

  // Deterministic order: engine-config statements first (they are the most
  // explanatory), then dataflow paths sorted by summary.
  const VIA_RANK: Record<TaintPath['via'], number> = {
    'engine-config': 0, dataflow: 1, condition: 2, location: 3,
  };
  witnesses.sort((a, b) => VIA_RANK[a.via] - VIA_RANK[b.via] || a.summary.localeCompare(b.summary));

  return {
    applicable: true,
    presentational: witnesses.length === 0,
    witness: witnesses[0],
    witnesses,
  };
}

/** The sentence the pipeline panel puts on the force / motion / layout rows when
 *  the model passes. Exported so the UI, Help and the harness share one string. */
export const PRESENTATION_ONLY_LABEL = 'presentation only — does not affect your rule';

/** The one-line explanation shown beside the label / in the compatibility
 *  readout. */
export const PRESENTATION_ONLY_EXPLAINER =
  'No rule in this model reads geometry into a decision, so the layout physics only decide where things sit — never what the simulation computes.';

/** The counterpart sentence when geometry IS load-bearing. Deliberately framed
 *  as a promotion, not a problem (proposal §P9). */
export const GEOMETRY_PROMOTED_EXPLAINER =
  'This model reads geometry into its rule, so the layout physics are part of what the simulation computes — not just how it looks.';
