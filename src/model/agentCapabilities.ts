// ===========================================================================
// Agent Capability Profiles — presets, the mode-aware dependency graph, the
// node→capability requirement table, the usage-aware migration inference, and
// the per-agent footprint estimate. The SINGLE source of truth consumed at the
// three enforcement gates (UI auto-enable, node palette/badge gating, migration
// inference) + the Properties footprint readout.
//
// v1 (STEP 0/1) is EDITOR-SURFACE ONLY: nothing here changes the SoA layout or
// the engine step — it drives which palette nodes / Behaviour-Step ports /
// Edit-panel rows appear, and estimates the per-agent footprint a tighter
// profile WOULD save. Phase 2 (STEP 3+) binds `computeAgentMemoryLayout` to the
// profile using the SAME field groups this estimate enumerates.
// ===========================================================================

import type {
  AgentCapabilities, BondsMode, CAModel, GraphNode, MotionMode,
} from './types';
import { resolveMaxBonds, cbNum, usesBondingPhysics } from './centerBased';

// ---------------------------------------------------------------------------
// Capability requirement keys — the atomic gate a node / migration references.
// ---------------------------------------------------------------------------

export type AgentCapKey =
  | 'body' | 'growth' | 'division' | 'lifespan'
  | 'bonds' | 'bondsPhysics' | 'autoBond'
  | 'sensing' | 'orientation' | 'fieldCoupling'
  | 'collision' | 'sensingOrCollision'
  | 'motionMoving' | 'motionForce'
  | 'populationBirth' | 'populationDeath';

interface CapReq {
  /** Human label used in the amber badge + the "requires X" tooltip. */
  label: string;
  /** True when the profile already satisfies this requirement. */
  satisfied: (p: AgentCapabilities) => boolean;
  /** Mutate the profile so `satisfied` becomes true (migration usage-widening).
   *  Only sets the DIRECT capability — transitive deps are closed afterwards by
   *  `computeCapabilityClosure`. Widening can only ADD capabilities, so it is
   *  always behaviour-preserving (STEP 1 is editor-only; the SoA never shrinks). */
  widen: (p: AgentCapabilities) => void;
}

const CAP_REQS: Record<AgentCapKey, CapReq> = {
  body: { label: 'Body', satisfied: p => p.body, widen: p => { p.body = true; } },
  growth: { label: 'Growth', satisfied: p => p.growth, widen: p => { p.growth = true; } },
  division: { label: 'Division', satisfied: p => p.division, widen: p => { p.division = true; } },
  lifespan: { label: 'Lifespan', satisfied: p => p.lifespan, widen: p => { p.lifespan = true; } },
  bonds: { label: 'Bonds', satisfied: p => p.bonds !== 'off', widen: p => { if (p.bonds === 'off') p.bonds = 'data'; } },
  bondsPhysics: { label: 'Bonds (Physics)', satisfied: p => p.bonds === 'physics', widen: p => { p.bonds = 'physics'; } },
  autoBond: { label: 'Auto-bond', satisfied: p => p.autoBond, widen: p => { p.autoBond = true; p.bonds = 'physics'; } },
  sensing: { label: 'Sensing', satisfied: p => p.sensing, widen: p => { p.sensing = true; } },
  orientation: { label: 'Orientation', satisfied: p => p.orientation, widen: p => { p.orientation = true; } },
  fieldCoupling: { label: 'Field coupling', satisfied: p => p.fieldCoupling, widen: p => { p.fieldCoupling = true; } },
  collision: { label: 'Collision', satisfied: p => p.collision !== 'off', widen: p => { if (p.collision === 'off') p.collision = 'soft'; } },
  sensingOrCollision: { label: 'Collision or Sensing', satisfied: p => p.sensing || p.collision !== 'off', widen: p => { p.sensing = true; } },
  motionMoving: { label: 'Motion (Velocity / Force)', satisfied: p => p.motion !== 'static', widen: p => { if (p.motion === 'static') p.motion = 'force'; } },
  motionForce: { label: 'Motion = Force', satisfied: p => p.motion === 'force', widen: p => { p.motion = 'force'; } },
  populationBirth: { label: 'Population (birth)', satisfied: p => p.populationBirth, widen: p => { p.populationBirth = true; } },
  populationDeath: { label: 'Population (death)', satisfied: p => p.populationDeath, widen: p => { p.populationDeath = true; } },
};

export function capReqLabel(key: AgentCapKey): string { return CAP_REQS[key].label; }

// ---------------------------------------------------------------------------
// Node → capability requirement. The single source consumed by BOTH the palette
// gate (`isNodeAvailable` / the amber badge) AND the migration usage-widening.
// A node NOT listed here is a CORE agent node (always available when Agents is
// on — e.g. Behaviour Step, Get Self Position, Get/Set Agent Attribute-by-id,
// the array-tier plumbing) OR a universal node. Only nodes that should VANISH
// when their capability is off are listed.
//
// The net-new nodes (spawnAgent / spawnEvent / getAgentsInView / senseHemifield
// / getAge) are listed ahead of their implementation (STEP 5) — harmless until
// the node types exist.
// ---------------------------------------------------------------------------

export const AGENT_NODE_REQUIREMENT: Record<string, AgentCapKey> = {
  // event root
  divisionEvent: 'division',
  spawnEvent: 'populationBirth',
  // self / geometry reads
  getRadius: 'body',
  setAgentRadius: 'body',
  setTargetRadius: 'growth',
  getBondDegree: 'bonds',
  getCurvature: 'bonds',
  getBondedAgents: 'bonds',
  forEachBond: 'bonds',
  formBond: 'bonds',
  breakBond: 'bonds',
  neighbourDensity: 'sensingOrCollision',
  getVelocity: 'motionMoving',
  setVelocity: 'motionMoving',
  applyForce: 'motionForce',
  // sensing
  getNearbyAgents: 'sensing',
  getAgentsInView: 'sensing',
  senseHemifield: 'sensing',
  // structural
  divideAgent: 'division',
  killAgent: 'populationDeath',
  spawnAgent: 'populationBirth',
  // lifespan
  getAge: 'lifespan',
  // field bridge
  sampleField: 'fieldCoupling',
  fieldGradient: 'fieldCoupling',
  readCellsUnder: 'fieldCoupling',
  affectCellsUnder: 'fieldCoupling',
  secreteToField: 'fieldCoupling',
};

/** The capability a node type requires, or null when it is a core / universal
 *  node (always available on the Agents graph). */
export function agentNodeRequirement(nodeType: string): AgentCapKey | null {
  return AGENT_NODE_REQUIREMENT[nodeType] ?? null;
}

/** True when the profile permits this node type (core nodes always pass). */
export function nodeSatisfiesCapabilities(nodeType: string, profile: AgentCapabilities): boolean {
  const key = agentNodeRequirement(nodeType);
  return key === null || CAP_REQS[key].satisfied(profile);
}

// ---------------------------------------------------------------------------
// Dependency closure — auto-enable hard prerequisites (mirrors how enabling
// bonding physics already bumps maxBonds off 0). Idempotent; run after every
// toggle edit and after migration widening.
// ---------------------------------------------------------------------------

export function computeCapabilityClosure(input: AgentCapabilities): AgentCapabilities {
  const p: AgentCapabilities = { ...input };
  // Iterate to a small fixpoint (deps are shallow; two passes always converge).
  for (let i = 0; i < 3; i++) {
    // Auto-bond needs physics bonds.
    if (p.autoBond && p.bonds !== 'physics') p.bonds = 'physics';
    // Physics bonds need force motion.
    if (p.bonds === 'physics' && p.motion !== 'force') p.motion = 'force';
    // Soft collision needs Body + Force motion; positional needs Body.
    if (p.collision === 'soft') { p.body = true; if (p.motion !== 'force') p.motion = 'force'; }
    if (p.collision === 'positional') p.body = true;
    // Growth + Division need Body.
    if (p.growth) p.body = true;
    if (p.division) p.body = true;
    // Population birth needs a way to move a newborn — a static graph gets velocity
    // (the Spawn payload writes a velocity), matching the migration widening.
    if (p.populationBirth && p.motion === 'static') p.motion = 'velocity';
    // FOV heading from facing needs Orientation.
    if (p.sensingHeadingSource === 'facing') p.orientation = true;
  }
  return p;
}

/** Apply a single capability edit from the Properties panel, cascading the
 *  REMOVAL of hard prerequisites (turning Body off also drops Growth/Division/
 *  Collision; dropping Motion below Force demotes physics bonds / soft collision),
 *  then re-closing hard-dep ADDITIONS. So a toggle always lands the profile in a
 *  consistent state (the picker flips to Custom when it stops matching a preset). */
export function applyCapabilityEdit<K extends keyof AgentCapabilities>(
  profile: AgentCapabilities, key: K, value: AgentCapabilities[K],
): AgentCapabilities {
  const p: AgentCapabilities = { ...profile };
  (p as unknown as Record<string, unknown>)[key as string] = value;
  // Removal cascades — a closure only ADDS, so drop dependents explicitly here.
  if (key === 'body' && value === false) { p.growth = false; p.division = false; p.collision = 'off'; }
  if (key === 'motion' && value !== 'force') {
    if (p.bonds === 'physics') p.bonds = 'data';
    p.autoBond = false;
    if (p.collision === 'soft') p.collision = 'off';
  }
  if (key === 'bonds' && value !== 'physics') p.autoBond = false;
  return computeCapabilityClosure(p);
}

// ---------------------------------------------------------------------------
// Presets — named paradigm profiles. `Full` ≡ `Morphogenesis` (deep-equal).
// ---------------------------------------------------------------------------

export type AgentPresetKey =
  | 'particle' | 'boids' | 'vivarium' | 'morphogenesis' | 'socialGraph' | 'caOnAgents';

function preset(
  motion: MotionMode, body: boolean, collision: AgentCapabilities['collision'], bonds: BondsMode,
  extra: Partial<AgentCapabilities>,
): AgentCapabilities {
  return computeCapabilityClosure({
    motion, body, collision, bonds,
    autoBond: false, growth: false, division: false, lifespan: false,
    populationBirth: false, populationDeath: false, sensing: false,
    sensingHeadingSource: 'velocity', orientation: false, fieldCoupling: false,
    appearance: true,
    ...extra,
  });
}

export const AGENT_PRESETS: Record<AgentPresetKey, AgentCapabilities> = {
  particle: preset('force', true, 'soft', 'off', { populationDeath: true }),
  boids: preset('force', true, 'off', 'off', { sensing: true, orientation: true }),
  vivarium: preset('force', true, 'soft', 'off', {
    division: true, lifespan: true, populationBirth: true, populationDeath: true,
    sensing: true, orientation: true,
  }),
  morphogenesis: preset('force', true, 'soft', 'physics', {
    autoBond: true, growth: true, division: true, lifespan: true,
    populationBirth: true, populationDeath: true, sensing: true, fieldCoupling: true,
  }),
  socialGraph: preset('static', false, 'off', 'data', {}),
  caOnAgents: preset('static', true, 'off', 'off', { sensing: true }),
};

/** `Full` is the everything-on paradigm — identical to Morphogenesis (a STEP 1
 *  gate: `Full` deep-equals `Morphogenesis`). Exposed as its own name for the
 *  migration "legacy ⇒ Full" base + the docs. */
export const FULL_AGENT_PROFILE: AgentCapabilities = AGENT_PRESETS.morphogenesis;

export interface AgentPresetMeta { key: AgentPresetKey; label: string; description: string }
export const AGENT_PRESET_META: AgentPresetMeta[] = [
  { key: 'particle', label: 'Particle System', description: 'Force-driven points with soft-sphere collision — N-body / SPH-lite physics. No bonds, growth, or division.' },
  { key: 'boids', label: 'Boids / Flocking', description: 'Sensing + steering forces + facing. Cohesion / separation / alignment over nearby agents.' },
  { key: 'vivarium', label: 'Vivarium / Ecology', description: 'Sensing creatures that age, reproduce (division), and die — a living ecology with population dynamics.' },
  { key: 'morphogenesis', label: 'Morphogenesis / Cells', description: 'The full soft-body cell: bonded, growing, dividing tissue coupled to a morphogen field. Everything on.' },
  { key: 'socialGraph', label: 'Social Network / Graph', description: 'Static nodes joined by data-only edges (traverse + render, no springs). No radius, force, or division.' },
  { key: 'caOnAgents', label: 'CA on Agents', description: 'A fixed lattice of static agents running a totalistic rule via nearby-agent sensing.' },
];

/** The friendly default a freshly-enabled Agents topology starts from (a
 *  paradigm, not the heavyweight everything-on). The user re-picks from the
 *  Properties preset row. */
export function defaultAgentCapabilities(): AgentCapabilities {
  return { ...AGENT_PRESETS.boids };
}

function profilesEqual(a: AgentCapabilities, b: AgentCapabilities): boolean {
  return a.motion === b.motion && a.body === b.body && a.collision === b.collision
    && a.bonds === b.bonds && a.autoBond === b.autoBond && a.growth === b.growth
    && a.division === b.division && a.lifespan === b.lifespan
    && a.populationBirth === b.populationBirth && a.populationDeath === b.populationDeath
    && a.sensing === b.sensing && a.sensingHeadingSource === b.sensingHeadingSource
    && a.orientation === b.orientation && a.fieldCoupling === b.fieldCoupling
    && a.appearance === b.appearance;
}

/** Which named preset a profile matches, or `'custom'`. `Full` maps to
 *  `morphogenesis` (they are deep-equal). */
export function matchAgentPreset(profile: AgentCapabilities): AgentPresetKey | 'custom' {
  const p = computeCapabilityClosure(profile);
  for (const meta of AGENT_PRESET_META) {
    if (profilesEqual(p, AGENT_PRESETS[meta.key])) return meta.key;
  }
  return 'custom';
}

// ---------------------------------------------------------------------------
// Migration inference — config base widened by a graph-usage scan. The scan can
// only ADD capabilities, so it is always behaviour-preserving. Explicit profile
// on the config wins.
// ---------------------------------------------------------------------------

function scanUsedRequirements(model: CAModel): Set<AgentCapKey> {
  const used = new Set<AgentCapKey>();
  const scan = (nodes: GraphNode[] | undefined) => {
    for (const n of nodes ?? []) {
      const t = n.data?.nodeType;
      if (typeof t !== 'string') continue;
      const key = agentNodeRequirement(t);
      if (key) used.add(key);
    }
  };
  scan(model.agentGraphNodes);
  // Macro internals — a Divide / Form Bond inside a macro must widen too (M7).
  // macroDefs are shared with the cell graph, but cell-only macros contain no
  // agent nodes (none map to a requirement), so scanning all of them only ever
  // widens on genuine agent-node usage.
  for (const def of model.macroDefs ?? []) scan(def.nodes);
  return used;
}

/** Infer the Agent Capability Profile for a model without an explicit one.
 *
 *  A MINIMAL honest base (everything off · static motion · appearance on) widened
 *  by two safe signals: (a) ENGINE-driven capabilities that have no node — bonding
 *  physics (soft-sphere collision + growth + auto-bond, from `usesBondingPhysics`);
 *  (b) the agent-graph's actual node usage (via the SAME requirement table the gate
 *  uses). Then Body is turned on for any MOVING model (a moving agent has extent),
 *  and the profile is dependency-closed.
 *
 *  KEY PROPERTY: widening only ADDS, and the node-usage widen uses the same table
 *  as `nodeSatisfiesCapabilities`, so the inferred profile can NEVER hide a node
 *  the graph uses — provably behaviour-preserving (v1 is editor-only anyway). This
 *  is tighter (more honest) than the handoff's config-base-Full approach while
 *  keeping the same safety guarantee — a maxBonds>0 model that never touches bonds
 *  no longer shows the whole morphogenesis palette. */
export function inferAgentProfile(model: CAModel): AgentCapabilities {
  const explicit = model.centerBased?.agentCapabilities;
  if (explicit) return computeCapabilityClosure(explicit);
  const cfg = model.centerBased;
  const p: AgentCapabilities = {
    motion: 'static', body: false, collision: 'off', bonds: 'off',
    autoBond: false, growth: false, division: false, lifespan: false,
    populationBirth: false, populationDeath: false, sensing: false,
    sensingHeadingSource: 'velocity', orientation: false, fieldCoupling: false,
    appearance: true,
  };
  // (a) Engine-physics signal — the soft-sphere collision (+ auto-bond springs)
  //     run with no node, so a bonding-physics config implies those capabilities.
  if (usesBondingPhysics(cfg)) {
    p.collision = 'soft'; p.body = true; p.motion = 'force';
    if (cfg?.autoBond) { p.bonds = 'physics'; p.autoBond = true; }
  }
  // (b) Node usage.
  for (const key of scanUsedRequirements(model)) CAP_REQS[key].widen(p);
  // A moving agent has physical extent (renders as a disc, collides) — keep Body
  // on so the Radius surface stays available. Only a truly static graph/data model
  // (Social Graph) drops it.
  if (p.motion !== 'static') p.body = true;
  return computeCapabilityClosure(p);
}

/** LOAD_MODEL migration: seed an explicit Agent Capability Profile on an agent
 *  model that has none, via the usage-widened inference (so legacy files load
 *  with an honest, behaviour-preserving profile and every gate is thereafter
 *  O(1)). No-op for non-agent models + models that already carry a profile.
 *  Mutates + returns the model (mirrors the other `migrate*` helpers). */
export function migrateAgentCapabilities(model: CAModel): CAModel {
  if (!model.topologyMode?.agents || !model.centerBased) return model;
  if (model.centerBased.agentCapabilities) return model;
  model.centerBased = { ...model.centerBased, agentCapabilities: inferAgentProfile(model) };
  return model;
}

/** The resolved profile used by every gate. O(1) when the config carries an
 *  explicit profile (the common case after LOAD_MODEL migration / enable-seed);
 *  otherwise infers it. A non-agent model has no profile — callers gate on
 *  `model.topologyMode?.agents` first. */
export function resolveAgentProfile(model: CAModel): AgentCapabilities {
  return inferAgentProfile(model);
}

// ---------------------------------------------------------------------------
// Capability metadata for the Properties panel — label, one-line description,
// the palette nodes a capability unlocks, and its hard prerequisites (for the
// "requires X" hint). Rendered as progressive-disclosure rows.
// ---------------------------------------------------------------------------

/** The capability fields that are plain booleans (rendered as a checkbox in the
 *  Properties panel). `motion`/`collision`/`bonds` are modes (segmented control /
 *  select); `sensingHeadingSource` is advanced (not surfaced in v1). */
export type BoolCapKey =
  | 'body' | 'autoBond' | 'growth' | 'division' | 'lifespan'
  | 'populationBirth' | 'populationDeath' | 'sensing' | 'orientation'
  | 'fieldCoupling' | 'appearance';

export interface CapabilityRowMeta {
  /** Which profile field this row edits (a boolean toggle, or a mode key). */
  key: keyof AgentCapabilities;
  label: string;
  description: string;
  /** Human "requires …" hint (hard deps). */
  requires?: string;
}

export const AGENT_CAPABILITY_ROWS: CapabilityRowMeta[] = [
  { key: 'body', label: 'Body / Extent', description: 'A radius surface, rendered as a disc/sphere. Unlocks Get / Set Agent Radius.' },
  { key: 'collision', label: 'Collision', description: 'Soft-sphere repulsion/adhesion (needs Motion=Force) or hard positional correction. Unlocks Neighbour Density.', requires: 'Body' },
  { key: 'bonds', label: 'Bonds', description: 'Connectivity edges (Data) or spring physics (needs Motion=Force). Unlocks Form/Break Bond, For Each Bond, Get Bonded Agents.' },
  { key: 'autoBond', label: 'Auto-bond', description: 'Engine forms/breaks bonds by proximity (hysteresis).', requires: 'Bonds = Physics' },
  { key: 'growth', label: 'Growth', description: 'Radius ramps toward a target radius each step. Unlocks Set Target Radius.', requires: 'Body' },
  { key: 'division', label: 'Division', description: 'Structural-phase split along the tension (or spread) axis. Unlocks Divide Agent + the Division Event root.', requires: 'Body' },
  { key: 'lifespan', label: 'Lifespan', description: 'Per-agent age auto-increments. Unlocks Get Age.' },
  { key: 'populationBirth', label: 'Population — Birth', description: 'Spawn agents mid-step (eggs / projectiles / offspring). Unlocks Spawn Agent + the Spawn Event root.', requires: 'Motion' },
  { key: 'populationDeath', label: 'Population — Death', description: 'Kill agents mid-step. Unlocks Kill Agent.' },
  { key: 'sensing', label: 'Sensing', description: 'The spatial hash + neighbour queries. Unlocks Get Nearby Agents + the directional-FOV nodes.' },
  { key: 'orientation', label: 'Orientation / Facing', description: 'A stored per-agent facing (heading source for FOV + sprite rotation).' },
  { key: 'fieldCoupling', label: 'Field Coupling', description: 'The agent ⇄ cell-grid morphogen bridge. Unlocks Sample Field, Field Gradient, Read / Affect Cells Under, Secrete To Field.', requires: 'a cell attribute with Agent access' },
];

// ---------------------------------------------------------------------------
// Per-agent footprint estimate — the "cost of generality" readout. Enumerates
// the SAME field groups Phase 2's `computeAgentMemoryLayout(profile)` will gate,
// so the estimate and the real allocation stay consistent. v1 is a display-only
// what-if (the real engine still allocates the full struct until STEP 3).
// ---------------------------------------------------------------------------

export interface FootprintGroup { label: string; bytes: number; core?: boolean }
export interface AgentFootprint { bytesPerAgent: number; is3d: boolean; groups: FootprintGroup[] }

function is3dAgentModel(model: CAModel): boolean {
  return model.properties.dimension === '3d' && (model.properties.gridDepth ?? 1) > 1;
}

/** Estimate the per-agent SoA byte footprint of a profile (core + enabled groups
 *  + user agent attributes), for the model's dimension. Bound to the Properties
 *  readout so the user sees a social-graph agent shrink vs a morphogenesis one. */
export function estimateAgentFootprint(profile: AgentCapabilities, model: CAModel): AgentFootprint {
  const is3d = is3dAgentModel(model);
  const p = computeCapabilityClosure(profile);
  const maxBonds = resolveMaxBonds(model.centerBased);
  const groups: FootprintGroup[] = [];
  const F = is3d ? 8 : 0; // extra f64 per 3D-only field

  // Honest core (always). alive 1 + colors 4 + position(x,y,xNext,yNext) + velocity
  // + force + radius + lineage/epoch/bondCount. In 3D: + z,zNext,vz,forceZ.
  const coreBytes = 1 + 4 + (4 * 8) + (2 * 8) + (2 * 8) + 8 + (3 * 4) + (4 * F);
  groups.push({ label: 'Core (position · velocity · force · radius · id)', bytes: coreBytes, core: true });

  // User agent attributes — always present, part of the struct.
  let attrBytes = 0;
  for (const a of model.agentAttributes ?? []) attrBytes += attrKindBytesOf(a.type);
  if (attrBytes > 0) groups.push({ label: `Agent attributes (${(model.agentAttributes ?? []).length})`, bytes: attrBytes, core: true });

  if (p.lifespan) groups.push({ label: 'Lifespan (age)', bytes: 8 });
  if (p.growth || p.body) groups.push({ label: 'Body / Growth (target radius)', bytes: 8 });
  if (p.collision !== 'off' || p.sensing) groups.push({ label: 'Collision / Sensing (density)', bytes: 8 });
  if (p.division) groups.push({ label: 'Division (axis · request)', bytes: (2 * 8) + 8 + 1 + F });
  if (p.bonds !== 'off') {
    const store = 28 * maxBonds;
    groups.push({ label: `Bond store (× ${maxBonds})`, bytes: store });
    if (p.bonds === 'physics') groups.push({ label: 'Bond physics (form/break request)', bytes: (2 * 8) + (2 * 4) });
  }
  if (p.populationDeath) groups.push({ label: 'Population — death (kill request)', bytes: 1 });
  if (p.populationBirth) groups.push({ label: 'Population — birth (spawn request)', bytes: 1 + (2 * 8) + 8 + (2 * 8) + 1 + (2 * F) });
  if (p.appearance) groups.push({ label: 'Appearance (sprite state)', bytes: 4 + (4 * 8) });

  const bytesPerAgent = groups.reduce((s, g) => s + g.bytes, 0);
  return { bytesPerAgent, is3d, groups };
}

/** Byte width of a cell/agent attribute runtime type (mirrors the agent SoA
 *  typed-array kind in `agentEngine.ts`: bool→1, integer/tag/neighborIndex→4,
 *  float→8). Inlined so this model-layer module carries no worker-engine import. */
function attrKindBytesOf(type: string): number {
  if (type === 'bool') return 1;
  if (type === 'integer' || type === 'tag' || type === 'neighborIndex') return 4;
  return 8;
}

// Re-export for callers that want the raw resolver.
export { cbNum };
