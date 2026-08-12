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
  | 'collision' | 'sensingOrCollision' | 'bondsOrSensing'
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
  // Disjunctive, like sensingOrCollision: the Neighbour Census reads EITHER the
  // bonded 1-ring OR a proximity set, chosen by a per-node `source` config the
  // type-keyed table cannot see. The config-specific mismatch (a bonded census in
  // a bonds-off model) is badged by `detectMissingConfig` instead.
  bondsOrSensing: { label: 'Bonds or Sensing', satisfied: p => p.bonds !== 'off' || p.sensing, widen: p => { if (p.bonds === 'off') p.bonds = 'data'; } },
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
// on — e.g. Behaviour Step, Get Self Position, Get Agent Attribute-by-id,
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
  // The census reads the bonded 1-ring OR a proximity set (a per-node `source`
  // config). The table is type-keyed, so it takes the DISJUNCTION and
  // `detectMissingConfig` badges the config-specific mismatch.
  neighbourCensus: 'bondsOrSensing',
  forEachBond: 'bonds',
  formBond: 'bonds',
  breakBond: 'bonds',
  // Graph-Rewriting Automata (P4): the atomic move-an-edge verb.
  rewireBond: 'bonds',
  // Graph-Rewriting Automata (B9): hand an edge to a new partner, rewriting the
  // third party's slot IN PLACE (order-preserving, unlike Rewire).
  transferBond: 'bonds',
  // Graph-Rewriting Automata (P2): per-EDGE user state. No bonds ⇒ no edges to
  // carry it (and the store allocates zero bond-attribute bytes).
  getBondAttribute: 'bonds',
  setBondAttribute: 'bonds',
  neighbourDensity: 'sensingOrCollision',
  getVelocity: 'motionMoving',
  setVelocity: 'motionMoving',
  applyForce: 'motionForce',
  applyForceToAgent: 'motionForce',
  applyForceToAgents: 'motionForce',
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
    // SOFT collision is a penalty FORCE ⇒ needs Body + Force motion (the integrator
    // applies it). POSITIONAL collision is a position CONSTRAINT applied after
    // integration ⇒ needs only Body (it works under any Motion — it edits xNext).
    if (p.collision === 'soft') { p.body = true; if (p.motion !== 'force') p.motion = 'force'; }
    if (p.collision === 'positional') p.body = true;
    // L1 — long-range charge is a FORCE, so it needs the force integrator. It needs
    // no Body: charge acts between CENTRES and never reads a radius. Normalise an
    // absent value (JSON that predates the field) to 'off' so a legacy profile still
    // deep-equals its preset.
    if (p.charge !== 'on') p.charge = 'off';
    if (p.charge === 'on' && p.motion !== 'force') p.motion = 'force';
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
    p.charge = 'off';   // charge is a force — it cannot survive dropping below Motion=Force
  }
  if (key === 'bonds' && value !== 'physics') p.autoBond = false;
  return computeCapabilityClosure(p);
}

// ---------------------------------------------------------------------------
// C1 (P4 — "no silent resolution") — WHY a capability is on.
//
// Ticking Collision = Soft silently turns Body + Motion = Force on. The panel
// showed the result with no cause. These helpers DERIVE the cause from
// `computeCapabilityClosure` itself — never a hand-written dependency table —
// so a future edit to the closure updates the annotations for free.
// ---------------------------------------------------------------------------

/** The all-off baseline every driver probe starts from. Deliberately NOT run
 *  through the closure: it must be the true zero so a probe's closure delta is
 *  attributable entirely to the ONE capability the probe sets. */
function offCapabilityBaseline(): AgentCapabilities {
  return {
    motion: 'static', body: false, collision: 'off', charge: 'off', bonds: 'off',
    autoBond: false, growth: false, division: false, lifespan: false,
    populationBirth: false, populationDeath: false, sensing: false,
    sensingHeadingSource: 'velocity', orientation: false, fieldCoupling: false,
    appearance: false,
  };
}

/** Ranks the ordered (3-state) capability values so "did the closure RAISE it?"
 *  is decidable for modes as well as booleans. Anything unlisted is boolean. */
function capStrength(profile: AgentCapabilities, key: keyof AgentCapabilities): number {
  const v = profile[key] as unknown;
  if (key === 'motion') return v === 'force' ? 2 : v === 'velocity' ? 1 : 0;
  if (key === 'bonds') return v === 'physics' ? 2 : v === 'data' ? 1 : 0;
  if (key === 'collision') return v === 'positional' ? 2 : v === 'soft' ? 1 : 0;
  if (key === 'charge') return v === 'on' ? 1 : 0;
  if (key === 'sensingHeadingSource') return v === 'velocity' ? 0 : 1;
  return v === true ? 1 : 0;
}

/** The capability rows a driver probe may report (the ones the panel renders +
 *  motion, which is its own segmented control). `sensingHeadingSource` and
 *  `appearance` are excluded as drivers: the first is a sub-choice of Sensing,
 *  the second gates nothing structural. */
const CLOSURE_PROBE_KEYS: ReadonlyArray<keyof AgentCapabilities> = [
  'motion', 'body', 'collision', 'charge', 'bonds', 'autoBond', 'growth',
  'division', 'lifespan', 'populationBirth', 'populationDeath', 'sensing',
  'orientation', 'fieldCoupling', 'sensingHeadingSource',
];

/** For each capability that is ON in `profile`, which OTHER enabled capabilities
 *  FORCE it on (via `computeCapabilityClosure`). Derivation: close a baseline
 *  containing ONLY capability J at the profile's value and see which other keys
 *  the closure raised — those are J's hard requirements. Inverting that gives,
 *  per row, its drivers.
 *
 *  The result drives the Properties "(required by X)" annotations, so a row the
 *  user cannot meaningfully turn off says so, and names what is holding it. */
export function capabilityClosureDrivers(
  profile: AgentCapabilities,
): Partial<Record<keyof AgentCapabilities, Array<keyof AgentCapabilities>>> {
  const out: Partial<Record<keyof AgentCapabilities, Array<keyof AgentCapabilities>>> = {};
  for (const driver of CLOSURE_PROBE_KEYS) {
    // Only an ENABLED capability can be forcing anything.
    if (capStrength(profile, driver) === 0) continue;
    const probe = offCapabilityBaseline();
    (probe as unknown as Record<string, unknown>)[driver as string] = profile[driver];
    const closed = computeCapabilityClosure(probe);
    for (const forced of CLOSURE_PROBE_KEYS) {
      if (forced === driver) continue;
      // The closure raised `forced` above the baseline AND the live profile has
      // it at least that strong ⇒ this driver is (one reason) it is on.
      if (capStrength(closed, forced) > 0 && capStrength(profile, forced) >= capStrength(closed, forced)) {
        (out[forced] ??= []).push(driver);
      }
    }
  }
  return out;
}

/** Human label for a capability row — reads `AGENT_CAPABILITY_ROWS` (declared
 *  below) so the annotation and the row it names can never disagree; falls back
 *  to the key for the few non-row capabilities (motion). */
export function capabilityRowLabel(key: keyof AgentCapabilities): string {
  const row = AGENT_CAPABILITY_ROWS.find(r => r.key === key);
  if (row) return row.label;
  if (key === 'motion') return 'Motion';
  if (key === 'sensingHeadingSource') return 'FOV heading source';
  return String(key);
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
    motion, body, collision, bonds, charge: 'off',
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
    && a.charge === b.charge
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
    // `charge` is net-new (L1), so NO legacy file can have used it: the inference
    // has no signal to widen on and must always land on 'off' — which is what keeps
    // every pre-L1 model byte-identical on all three targets.
    motion: 'static', body: false, collision: 'off', bonds: 'off', charge: 'off',
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
  // (c) Byte-identity for the DECOUPLED physics gates (usesEngineSprings /
  //     usesEngineGrowth). The legacy `usesBondingPhysics` bundle ran bond SPRINGS
  //     on ANY bond + the growth RAMP whenever growthRate>0. The decoupled engine
  //     now gates springs on `bonds==='physics'` and the ramp on the `growth`
  //     capability, so the inferred profile must widen those to true wherever the
  //     old bundle was active — else a migrated bonding file would silently lose
  //     springs (a manual Form-Bond graph infers bonds='data') or growth. Only
  //     ADDS capabilities, so it stays behaviour-preserving.
  if (usesBondingPhysics(cfg)) {
    if (p.bonds !== 'off') p.bonds = 'physics';
    if (cbNum(cfg, 'growthRate') > 0) p.growth = true;
  }
  // A moving agent has physical extent (renders as a disc, collides) — keep Body
  // on so the Radius surface stays available. Only a truly static graph/data model
  // (Social Graph) drops it.
  if (p.motion !== 'static') p.body = true;
  return computeCapabilityClosure(p);
}

/** LOAD_MODEL migration: seed an explicit Agent Capability Profile on an agent
 *  model that has none, via the usage-widened inference (so legacy files load
 *  with an honest, behaviour-preserving profile and every gate is thereafter
 *  O(1)). No-op for non-agent models.
 *  Mutates + returns the model (mirrors the other `migrate*` helpers).
 *
 *  C6 (P5): a profile that IS present is COMPLETED rather than passed through
 *  untouched. A hand-edited file can carry a PARTIAL profile (say
 *  `{ motion: 'force' }`), which is truthy — so the old early return let it
 *  through, and `collisionMode`, which falls back per-FIELD, then silently
 *  resolved that model's collision from the legacy flags. Worse, saving wrote the
 *  partial profile straight back, so "re-save to bake the profile" would not have
 *  fixed it.
 *
 *  The gaps are filled from the SAME inference the fully-absent case uses (the
 *  legacy flags + the node-usage scan), with the explicit keys winning — so the
 *  completed profile resolves exactly the way the legacy arms would have. That
 *  makes this BEHAVIOUR-PRESERVING by construction, not by measurement: for a
 *  complete profile every inferred key is overwritten, and the only key the
 *  shipped library omits is the net-new `charge`, which inference sets to `'off'`
 *  — already what `usesCharge` (strict `=== 'on'`, no fallback) resolves. */
export function migrateAgentCapabilities(model: CAModel): CAModel {
  if (!model.topologyMode?.agents || !model.centerBased) return model;
  const caps = model.centerBased.agentCapabilities;
  let next: AgentCapabilities;
  if (!caps) {
    next = inferAgentProfile(model);
  } else {
    // `inferAgentProfile` short-circuits on an explicit profile, so infer against a
    // shallow clone WITHOUT one to get the from-scratch baseline to fill from.
    const bare = { ...model, centerBased: { ...model.centerBased, agentCapabilities: undefined } };
    next = computeCapabilityClosure({ ...inferAgentProfile(bare), ...caps });
  }
  model.centerBased = { ...model.centerBased, agentCapabilities: next };
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
  { key: 'collision', label: 'Collision', description: 'Volume exclusion. Soft-sphere = a springy repulsion force (transient overlap; tune Repulsion Stiffness; needs Motion=Force). Positional = a rigid no-overlap constraint (billiard-ball; works under any Motion). Unlocks Neighbour Density.', requires: 'Body' },
  { key: 'charge', label: 'Charge (long-range)', description: 'A repulsive 1/(1+d²) pair force with a finite cutoff — the only force with reach beyond contact distance, so it is what holds a grown bond graph OPEN instead of letting it collapse into a jammed blob. Tune Charge Strength (negative = repulsive) + Cutoff.', requires: 'Motion = Force' },
  { key: 'bonds', label: 'Bonds', description: 'Connectivity edges (Data — no forces) or spring physics (Physics — needs Motion=Force). Unlocks Form/Break Bond, For Each Bond, Get Bonded Agents.' },
  { key: 'autoBond', label: 'Auto-bond', description: 'Engine forms/breaks bonds by proximity (hysteresis).', requires: 'Bonds = Physics' },
  { key: 'growth', label: 'Growth', description: 'Radius ramps toward a target radius each step. Unlocks Set Target Radius.', requires: 'Body' },
  { key: 'division', label: 'Division', description: 'Structural-phase split along the tension (or spread) axis. Unlocks Divide Agent + the Division Event root.', requires: 'Body' },
  { key: 'lifespan', label: 'Lifespan', description: 'Per-agent age auto-increments. Unlocks Get Age.' },
  { key: 'populationBirth', label: 'Population — Birth', description: 'Spawn agents mid-step (eggs / projectiles / offspring). Unlocks Spawn Agent + the Spawn Event root.', requires: 'Motion' },
  { key: 'populationDeath', label: 'Population — Death', description: 'Kill agents mid-step. Unlocks Kill Agent.' },
  { key: 'sensing', label: 'Sensing', description: 'The spatial hash + neighbour queries. Unlocks Get Nearby Agents + Get Agents In View (directional vision cone).' },
  { key: 'orientation', label: 'Orientation / Facing', description: 'A stored per-agent facing (heading source for FOV + sprite rotation).' },
  { key: 'fieldCoupling', label: 'Field Coupling', description: 'The agent ⇄ cell-grid morphogen bridge. Unlocks Sample Field, Field Gradient, Read / Affect Cells Under, Secrete To Field.', requires: 'a cell attribute with Agent access' },
];

/** Capability rows HIDDEN from the Properties panel in v1 because the nodes /
 *  engine effect they gate are not yet implemented (STEP 5 — Population birth's
 *  Spawn Agent + Spawn Event nodes, and directional Orientation's FOV heading).
 *  Exposing a toggle that unlocks nothing is exactly the "unfinished feature
 *  exposed" the honest-core contract forbids. The rows/schema/presets stay intact
 *  (so a preset that sets these matches + the footprint counts them); only the
 *  Properties render is filtered. Remove a key here when its feature lands. NB:
 *  `populationBirth` is unrelated to the ALWAYS-available init-time spawning
 *  (Create Agent / Add To World in the Agent Init Event) — that is a core path. */
export const HIDDEN_CAP_ROWS_V1: ReadonlySet<keyof AgentCapabilities> = new Set([
  'populationBirth', // Spawn Agent / Spawn Event nodes are not registered yet.
  // 'orientation' un-hidden: it now gates the FOV `facing` heading source (Get
  // Agents In View / Sense Hemifield read a stored vector facing attribute).
]);

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
