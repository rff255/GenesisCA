import { EMPTY_MODEL } from './defaultModel';
import { defaultCenterBasedConfig, CENTER_BASED_DEFAULTS } from './centerBased';
import { AGENT_PRESETS, computeCapabilityClosure } from './agentCapabilities';
import type { AgentCapabilities, CAModel, CenterBasedConfig, ReproducibilityContract } from './types';

/** ---------------------------------------------------------------------------
 *  MODEL ARCHETYPES (C7 / proposal P6) — "navigable by intent".
 *
 *  `File ▾ → New` opens a chooser whose cards each SEED a coherent starting
 *  point: topology + dimension + the agent capability profile + the engine
 *  intent + the reproducibility contract. Every seeded field is an ordinary
 *  model property the user edits afterwards in the panel it belongs to — this
 *  is a SEED, not a wizard, and it introduces NO new schema.
 *
 *  This module is pure data + one builder (no React, no side effects) so the
 *  verification harnesses can import it and assert the seeds directly.
 *
 *  THE INVARIANT: `buildArchetypeModel('empty')` returns `EMPTY_MODEL` VERBATIM,
 *  so today's New behaviour is reachable in one click and is what the gate
 *  asserts field-for-field.
 *  ------------------------------------------------------------------------- */

export type ArchetypeId =
  | 'ca2d' | 'ca3d' | 'particles' | 'flocking' | 'tissue' | 'gra' | 'caOnAgents' | 'empty';

export interface ModelArchetype {
  id: ArchetypeId;
  label: string;
  /** One line, shown on the card. */
  description: string;
  /** Short chips under the description (topology / paradigm / contract). */
  tags: string[];
}

/** The GRA capability profile, DERIVED FROM THE SHIPPED FLAGSHIPS rather than
 *  from a named preset.
 *
 *  The runbook suggested `AGENT_PRESETS.socialGraph` ("or the closest bonds-data
 *  profile"), but the audit says otherwise: both shipped graph-rewriting models
 *  (`SDCA — Couplers and Decouplers`, and `Cubic GRA` before it was retired
 *  from the library) run
 *  `motion:force · body · collision:soft · bonds:physics · charge:ON · sensing`,
 *  and NOT `division` (their triangle split is Create Agent + Rewire, not Divide
 *  Agent). `socialGraph` is `static / no body / bonds:data / charge:off`, i.e. it
 *  has NO layout at all — a graph seeded from it renders as a pile and the whole
 *  long-range charge force (the thing that unfolds a grown graph) is switched
 *  off. No shipped GRA model uses it.
 *
 *  This profile deep-equals no named preset, so the Properties preset chip reads
 *  "Custom" — which is exactly what the two shipped flagships read today. */
export const GRA_PROFILE: AgentCapabilities = computeCapabilityClosure({
  motion: 'force', body: true, collision: 'soft', bonds: 'physics', charge: 'on',
  autoBond: false, growth: false, division: false, lifespan: false,
  populationBirth: true, populationDeath: false, sensing: true,
  sensingHeadingSource: 'velocity', orientation: false, fieldCoupling: false,
  appearance: true,
});

export const MODEL_ARCHETYPES: ModelArchetype[] = [
  {
    id: 'ca2d', label: 'Classic CA (2D)',
    description: 'A 2D lattice of cells with a Generation Step rule.',
    tags: ['grid', '2D', 'exact'],
  },
  {
    id: 'ca3d', label: '3D CA',
    description: 'A voxel volume — the same rules, one more axis.',
    tags: ['grid', '3D 50³', 'exact'],
  },
  {
    id: 'particles', label: 'Particle system',
    description: 'Force-driven points with soft-sphere collision — N-body / SPH-lite physics.',
    tags: ['agents', 'Particle', 'statistical'],
  },
  {
    id: 'flocking', label: 'Flocking',
    description: 'Sensing + steering forces + facing — cohesion, separation, alignment.',
    tags: ['agents', 'Boids', 'statistical'],
  },
  {
    id: 'tissue', label: 'Bonded tissue / morphogenesis',
    description: 'Soft-body cells: bonded, growing, dividing tissue coupled to a morphogen field.',
    tags: ['agents', 'Morphogenesis', 'exact'],
  },
  {
    id: 'gra', label: 'Graph automaton (GRA)',
    description: 'Nodes joined by bonds the rule rewrites — census → table → verb.',
    tags: ['agents', 'bonds + charge', 'exact'],
  },
  {
    id: 'caOnAgents', label: 'CA on agents',
    description: 'A fixed lattice of static agents running a totalistic rule by sensing.',
    tags: ['agents', 'CA-on-Agents', 'exact'],
  },
  {
    id: 'empty', label: 'Empty',
    description: "Today's New, unchanged — a bare 2D grid with nothing seeded.",
    tags: ['grid', '2D'],
  },
];

/** Per-archetype agent seeds. Deliberately MINIMAL: only the fields without
 *  which the archetype would be incoherent (a population to see, a bond store to
 *  bond into, the charge that unfolds a graph). Everything else stays at the
 *  engine defaults so the seeded surface is small and defensible. */
interface AgentSeed {
  profile: AgentCapabilities;
  /** Agent world = the grid frame, 1:1 (Decision D-FIELD). */
  world: { w: number; h: number };
  maxAgents: number;
  seedCount: number;
  seedPattern: 'compact' | 'scatter';
  defaultRadius: number;
  /** Only for bonded archetypes — `resolveMaxBonds` returns 0 when the ceiling is
   *  0 even if the profile says `bonds: 'physics'`, so a bonded archetype that
   *  left `defaultCenterBasedConfig()`'s 0 in place would silently have no bond
   *  store. */
  maxBonds?: number;
  autoBond?: boolean;
}

const AGENT_SEEDS: Partial<Record<ArchetypeId, AgentSeed>> = {
  particles: {
    profile: AGENT_PRESETS.particle,
    world: { w: 120, h: 120 }, maxAgents: 1000, seedCount: 300,
    seedPattern: 'scatter', defaultRadius: 1,
  },
  flocking: {
    profile: AGENT_PRESETS.boids,
    world: { w: 120, h: 120 }, maxAgents: 600, seedCount: 260,
    seedPattern: 'scatter', defaultRadius: 1,
  },
  tissue: {
    profile: AGENT_PRESETS.morphogenesis,
    world: { w: 100, h: 100 }, maxAgents: 1500, seedCount: 12,
    seedPattern: 'compact', defaultRadius: 1.6,
    maxBonds: CENTER_BASED_DEFAULTS.maxBonds, autoBond: true,
  },
  gra: {
    profile: GRA_PROFILE,
    world: { w: 200, h: 200 }, maxAgents: 2000, seedCount: 4,
    seedPattern: 'compact', defaultRadius: 1.5,
    // Auto-bond is deliberately OFF: a GRA forms bonds BY RULE, and forming them
    // by distance instead would fight the rule (and make geometry feed topology).
    maxBonds: CENTER_BASED_DEFAULTS.maxBonds, autoBond: false,
  },
  caOnAgents: {
    profile: AGENT_PRESETS.caOnAgents,
    world: { w: 60, h: 60 }, maxAgents: 1040, seedCount: 256,
    seedPattern: 'compact', defaultRadius: 0.45,
  },
};

/** Which archetypes declare `statistical` (C5). The two GPU-population
 *  paradigms: a large interchangeable population is exactly the shape that wants
 *  the WebGPU agent target, whose per-agent PCG is seeded once at runtime
 *  creation and so cannot be pinned by `setRngSeed`. Declaring the contract up
 *  front lets C4's Auto pick WebGPU for them WITHOUT a contract violation. */
const STATISTICAL: ReadonlySet<ArchetypeId> = new Set<ArchetypeId>(['particles', 'flocking']);

/** The Properties panel uses `useBondingPhysics` for progressive disclosure (the
 *  Forces + Bonds rows appear only when it is on), while the ENGINE behaviour has
 *  been profile-driven since the honest-controls pass. Seeding the two
 *  independently is exactly how they drift, so it is DERIVED: any archetype whose
 *  profile turns on engine physics also shows the knobs that tune it. */
function bondingPhysicsFor(p: AgentCapabilities): boolean {
  return p.collision !== 'off' || p.bonds === 'physics' || p.growth;
}

const ARCHETYPE_NAME: Record<ArchetypeId, string> = {
  ca2d: 'Untitled CA',
  ca3d: 'Untitled 3D CA',
  particles: 'Untitled Particle System',
  flocking: 'Untitled Flocking Model',
  tissue: 'Untitled Tissue',
  gra: 'Untitled Graph Automaton',
  caOnAgents: 'Untitled CA on Agents',
  empty: EMPTY_MODEL.properties.name,
};

/** Build the seed model for an archetype.
 *
 *  `'empty'` returns `EMPTY_MODEL` itself (the exact object today's New uses), so
 *  the historical path is preserved byte-for-byte. Everything else is a fresh
 *  deep-ish clone with the archetype's fields applied — no mutation of
 *  EMPTY_MODEL, whose nested arrays are shared module state. */
export function buildArchetypeModel(id: ArchetypeId): CAModel {
  if (id === 'empty') return EMPTY_MODEL;

  const base: CAModel = {
    ...EMPTY_MODEL,
    properties: { ...EMPTY_MODEL.properties, name: ARCHETYPE_NAME[id] },
    // Fresh arrays — EMPTY_MODEL's are shared module state and the reducer
    // treats the model as immutable but the graph editor appends in place.
    attributes: [], neighborhoods: [], mappings: [], indicators: [],
    graphNodes: [], graphEdges: [], agentGraphNodes: [], agentGraphEdges: [],
    macroDefs: [],
    topologyMode: { gridCells: true, agents: false },
  };
  // Contract: `exact` is the default everywhere; only the GPU-population
  // archetypes declare `statistical`.
  const contract: ReproducibilityContract = STATISTICAL.has(id) ? 'statistical' : 'exact';
  base.properties.reproducibility = contract;

  if (id === 'ca2d') return base;

  if (id === 'ca3d') {
    base.properties.dimension = '3d';
    base.properties.gridWidth = 50;
    base.properties.gridHeight = 50;
    base.properties.gridDepth = 50;
    return base;
  }

  const seed = AGENT_SEEDS[id];
  if (!seed) return base;   // unreachable — every non-grid archetype has a seed

  // Agents-only, matching the shipped agent samples (the grid layer is dead
  // weight for a model with no cell rule, and enabling it would surface the
  // "No Step node" compile error on a freshly-created model).
  base.topologyMode = { gridCells: false, agents: true };
  base.properties.gridWidth = seed.world.w;
  base.properties.gridHeight = seed.world.h;

  const cb: CenterBasedConfig = {
    ...defaultCenterBasedConfig(),
    maxAgents: seed.maxAgents,
    seedCount: seed.seedCount,
    seedPattern: seed.seedPattern,
    defaultRadius: seed.defaultRadius,
    worldWidth: seed.world.w,
    worldHeight: seed.world.h,
    agentCapabilities: { ...seed.profile },
    useBondingPhysics: bondingPhysicsFor(seed.profile),
  };
  if (seed.maxBonds !== undefined) cb.maxBonds = seed.maxBonds;
  if (seed.autoBond !== undefined) cb.autoBond = seed.autoBond;
  base.centerBased = cb;
  return base;
}
