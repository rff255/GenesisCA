// =============================================================================
// AUTO-GENERATED — DO NOT EDIT BY HAND.
//
// Produced by `node scripts/gen-capability-docs.mjs` from the tables the engine
// actually enforces with (AGENT_NODE_REQUIREMENT, the node registry, the two
// agent supported-type sets, the WebGPU grid gate, and the capacity constants).
// Run `node scripts/gen-capability-docs.mjs --check` to fail on staleness.
//
// Editing this file is pointless: the next regeneration overwrites it, and the
// --check gate will flag whatever you wrote. Change the SOURCE table instead.
// =============================================================================

/** One agent node's per-target support + the capability that reveals it. */
export interface CapabilityNodeRow {
  type: string;
  label: string;
  category: string;
  /** The capability key that must be enabled for this node to appear. */
  capability: string | null;
  /** Human label for that key (e.g. "Motion = Force"). */
  capabilityLabel: string | null;
  /** Raw membership in each target's supported-type set. */
  wasm: boolean;
  webgpu: boolean;
  /** An event ROOT. The agent gates inspect the behaviour-reachable cone, which
   *  never contains a root, so set membership does not decide anything for it. */
  entryPoint: boolean;
  /** Rewritten into supported primitives BEFORE any target compiles, so it runs
   *  everywhere regardless of set membership. */
  lowered: boolean;
  /** Runs on the CPU on EVERY target by design (division event / agent init /
   *  the spawn pair) — absent from a supported set for a reason, not a gap. */
  cpuRoot: boolean;
  /** What to SHOW per target: 'yes' (in the set) | 'exempt' (runs anyway, for
   *  one of the three reasons above) | 'no' (a genuine gap — the node clamps
   *  that layer to a CPU engine). */
  wasmStatus: 'yes' | 'exempt' | 'no';
  webgpuStatus: 'yes' | 'exempt' | 'no';
}

/** A node the WebGPU CA-GRID engine rejects, and why. `condition` is empty when
 *  the node is rejected in every configuration. */
export interface GridRejectRow {
  type: string;
  label: string;
  condition: string;
  reason: string;
}

/** A resource bound. Class C limits are always stated WITH their number. */
export interface CapacityLimit {
  key: string;
  label: string;
  value: number;
  note: string;
}

export const AGENT_NODE_MATRIX: CapabilityNodeRow[] = [
  {
    "type": "addAgentToWorld",
    "label": "Add To World",
    "category": "output",
    "capability": null,
    "capabilityLabel": null,
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": true,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "affectCellsUnder",
    "label": "Affect Cells Under (CA Grid)",
    "category": "output",
    "capability": "fieldCoupling",
    "capabilityLabel": "Field coupling",
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "agentInit",
    "label": "Agent Init Event",
    "category": "event",
    "capability": null,
    "capabilityLabel": null,
    "wasm": false,
    "webgpu": false,
    "entryPoint": true,
    "lowered": false,
    "cpuRoot": true,
    "wasmStatus": "exempt",
    "webgpuStatus": "exempt"
  },
  {
    "type": "agentOutputMapping",
    "label": "Agent Output Mapping (A→C)",
    "category": "event",
    "capability": null,
    "capabilityLabel": null,
    "wasm": false,
    "webgpu": true,
    "entryPoint": true,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "exempt",
    "webgpuStatus": "yes"
  },
  {
    "type": "applyForce",
    "label": "Apply Force",
    "category": "output",
    "capability": "motionForce",
    "capabilityLabel": "Motion = Force",
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "applyForceToAgent",
    "label": "Apply Force (by ID)",
    "category": "output",
    "capability": "motionForce",
    "capabilityLabel": "Motion = Force",
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "applyForceToAgents",
    "label": "Apply Force To Agents",
    "category": "output",
    "capability": "motionForce",
    "capabilityLabel": "Motion = Force",
    "wasm": false,
    "webgpu": false,
    "entryPoint": false,
    "lowered": true,
    "cpuRoot": false,
    "wasmStatus": "exempt",
    "webgpuStatus": "exempt"
  },
  {
    "type": "behaviourStep",
    "label": "Behaviour Step",
    "category": "event",
    "capability": null,
    "capabilityLabel": null,
    "wasm": true,
    "webgpu": true,
    "entryPoint": true,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "breakBond",
    "label": "Break Bond",
    "category": "output",
    "capability": "bonds",
    "capabilityLabel": "Bonds",
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "createAgent",
    "label": "Create Agent",
    "category": "output",
    "capability": null,
    "capabilityLabel": null,
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": true,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "divideAgent",
    "label": "Divide Self",
    "category": "output",
    "capability": "division",
    "capabilityLabel": "Division",
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "divisionEvent",
    "label": "Division Event",
    "category": "event",
    "capability": "division",
    "capabilityLabel": "Division",
    "wasm": false,
    "webgpu": false,
    "entryPoint": true,
    "lowered": false,
    "cpuRoot": true,
    "wasmStatus": "exempt",
    "webgpuStatus": "exempt"
  },
  {
    "type": "fieldGradient",
    "label": "Field Gradient (CA Grid)",
    "category": "data",
    "capability": "fieldCoupling",
    "capabilityLabel": "Field coupling",
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "filterAgents",
    "label": "Filter Agents",
    "category": "aggregation",
    "capability": null,
    "capabilityLabel": null,
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "forEachBond",
    "label": "For Each Bond",
    "category": "flow",
    "capability": "bonds",
    "capabilityLabel": "Bonds",
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "formBond",
    "label": "Form Bond",
    "category": "output",
    "capability": "bonds",
    "capabilityLabel": "Bonds",
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "formBondBetween",
    "label": "Form Bond Between",
    "category": "output",
    "capability": "bonds",
    "capabilityLabel": "Bonds",
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "getAge",
    "label": "Get Age",
    "category": "data",
    "capability": "lifespan",
    "capabilityLabel": "Lifespan",
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "getAgentAttribute",
    "label": "Get Attribute (by ID)",
    "category": "data",
    "capability": null,
    "capabilityLabel": null,
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "getAgentOffset",
    "label": "Get Offset (by ID)",
    "category": "data",
    "capability": null,
    "capabilityLabel": null,
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "getAgentPosition",
    "label": "Get Position (by ID)",
    "category": "data",
    "capability": null,
    "capabilityLabel": null,
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "getAgentRadius",
    "label": "Get Radius (by ID)",
    "category": "data",
    "capability": null,
    "capabilityLabel": null,
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "getAgentsAttribute",
    "label": "Get Agents Attribute",
    "category": "data",
    "capability": null,
    "capabilityLabel": null,
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "getAgentsInView",
    "label": "Get Agents In View",
    "category": "data",
    "capability": "sensing",
    "capabilityLabel": "Sensing",
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "getBondAttribute",
    "label": "Get Bond Attribute",
    "category": "data",
    "capability": "bonds",
    "capabilityLabel": "Bonds",
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "getBondDegree",
    "label": "Get Bond Degree",
    "category": "data",
    "capability": "bonds",
    "capabilityLabel": "Bonds",
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "getBondedAgents",
    "label": "Get Bonded Agents",
    "category": "data",
    "capability": "bonds",
    "capabilityLabel": "Bonds",
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "getCurvature",
    "label": "Get Curvature",
    "category": "data",
    "capability": "bonds",
    "capabilityLabel": "Bonds",
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "getNearbyAgents",
    "label": "Get Nearby Agents",
    "category": "data",
    "capability": "sensing",
    "capabilityLabel": "Sensing",
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "getRadius",
    "label": "Get Radius",
    "category": "data",
    "capability": "body",
    "capabilityLabel": "Body",
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "getSelfHandle",
    "label": "Get Self Handle",
    "category": "data",
    "capability": null,
    "capabilityLabel": null,
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "getSelfPosition",
    "label": "Get Position",
    "category": "data",
    "capability": null,
    "capabilityLabel": null,
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "getVelocity",
    "label": "Get Velocity",
    "category": "data",
    "capability": "motionMoving",
    "capabilityLabel": "Motion (Velocity / Force)",
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "joinAgents",
    "label": "Join Agents",
    "category": "aggregation",
    "capability": null,
    "capabilityLabel": null,
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "killAgent",
    "label": "Kill Self",
    "category": "output",
    "capability": "populationDeath",
    "capabilityLabel": "Population (death)",
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "neighbourCensus",
    "label": "Neighbour Census",
    "category": "aggregation",
    "capability": "bondsOrSensing",
    "capabilityLabel": "Bonds or Sensing",
    "wasm": false,
    "webgpu": false,
    "entryPoint": false,
    "lowered": true,
    "cpuRoot": false,
    "wasmStatus": "exempt",
    "webgpuStatus": "exempt"
  },
  {
    "type": "neighbourDensity",
    "label": "Neighbour Density",
    "category": "data",
    "capability": "sensingOrCollision",
    "capabilityLabel": "Collision or Sensing",
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "periodicStep",
    "label": "Periodic Step",
    "category": "event",
    "capability": null,
    "capabilityLabel": null,
    "wasm": false,
    "webgpu": false,
    "entryPoint": true,
    "lowered": true,
    "cpuRoot": false,
    "wasmStatus": "exempt",
    "webgpuStatus": "exempt"
  },
  {
    "type": "pickNRandomAgents",
    "label": "Pick N Random Agents",
    "category": "aggregation",
    "capability": null,
    "capabilityLabel": null,
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "pickRandomAgent",
    "label": "Pick Random Agent",
    "category": "aggregation",
    "capability": null,
    "capabilityLabel": null,
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "readCellsUnder",
    "label": "Read Cells Under (CA Grid)",
    "category": "data",
    "capability": "fieldCoupling",
    "capabilityLabel": "Field coupling",
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "rewireBond",
    "label": "Rewire Bond",
    "category": "output",
    "capability": "bonds",
    "capabilityLabel": "Bonds",
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "sampleField",
    "label": "Sample Field (CA Grid)",
    "category": "data",
    "capability": "fieldCoupling",
    "capabilityLabel": "Field coupling",
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "secreteToField",
    "label": "Secrete To Field (CA Grid)",
    "category": "output",
    "capability": "fieldCoupling",
    "capabilityLabel": "Field coupling",
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "senseHemifield",
    "label": "Sense Hemifield",
    "category": "data",
    "capability": "sensing",
    "capabilityLabel": "Sensing",
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "setAgentAttribute",
    "label": "Set Attribute (by ID)",
    "category": "output",
    "capability": null,
    "capabilityLabel": null,
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "setAgentPosition",
    "label": "Set Position (by ID)",
    "category": "output",
    "capability": null,
    "capabilityLabel": null,
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "setAgentRadius",
    "label": "Set Radius (by ID)",
    "category": "output",
    "capability": "body",
    "capabilityLabel": "Body",
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "setAgentsAttribute",
    "label": "Set Agents Attribute",
    "category": "output",
    "capability": null,
    "capabilityLabel": null,
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "setAgentSprite",
    "label": "Set Sprite",
    "category": "color",
    "capability": null,
    "capabilityLabel": null,
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "setBondAttribute",
    "label": "Set Bond Attribute",
    "category": "output",
    "capability": "bonds",
    "capabilityLabel": "Bonds",
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "setTargetRadius",
    "label": "Set Target Radius",
    "category": "output",
    "capability": "growth",
    "capabilityLabel": "Growth",
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "setVelocity",
    "label": "Set Velocity",
    "category": "output",
    "capability": "motionMoving",
    "capabilityLabel": "Motion (Velocity / Force)",
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  },
  {
    "type": "transferBond",
    "label": "Transfer Bond",
    "category": "output",
    "capability": "bonds",
    "capabilityLabel": "Bonds",
    "wasm": true,
    "webgpu": true,
    "entryPoint": false,
    "lowered": false,
    "cpuRoot": false,
    "wasmStatus": "yes",
    "webgpuStatus": "yes"
  }
];

export const WEBGPU_GRID_REJECTS: GridRejectRow[] = [
  {
    "type": "moveSelfToNeighbor",
    "label": "Transfer Cell Attributes to Neighbor",
    "condition": "",
    "reason": "Transfer Cell Attributes to Neighbor requires asynchronous update mode — WebGPU is sync-only. Switch to WebAssembly / Debug target, or remove this node."
  },
  {
    "type": "setFacingOrientation",
    "label": "Set Facing Orientation",
    "condition": "",
    "reason": "Set Facing Orientation requires asynchronous update mode — WebGPU is sync-only. Switch to WebAssembly / Debug target, or remove this node."
  },
  {
    "type": "setNeighborOrientationByIndex",
    "label": "Set Neighbor Orientation By Index",
    "condition": "",
    "reason": "Set Neighbor Orientation By Index requires asynchronous update mode — WebGPU is sync-only. Switch to WebAssembly / Debug target, or remove this node."
  },
  {
    "type": "updateIndicator",
    "label": "Update Indicator",
    "condition": "operation = next / previous",
    "reason": "WebGPU runs cells in parallel; cyclic tag advancement (next/previous) from multiple cells produces an undefined result. Use Set Indicator with an explicit value, or switch target."
  },
  {
    "type": "updateIndicator",
    "label": "Update Indicator",
    "condition": "operation = toggle",
    "reason": "WebGPU runs cells in parallel; toggling a shared indicator from multiple cells per generation produces an undefined result. Use `or` (becomes true and stays true) or `and` for the inverse pattern, or switch target."
  }
];

export const CAPACITY_LIMITS: CapacityLimit[] = [
  {
    "key": "AGENT_NEARBY_SCRATCH_SLOTS",
    "label": "Proximity-query scratch slots (WebAssembly agents)",
    "value": 4,
    "note": "Simultaneous Get Nearby Agents / Get Agents In View producers in one agent graph. Above this the agent loop runs on JavaScript — a capacity clamp, never a wrong result."
  },
  {
    "key": "AGENT_WEBGPU_NEARBY_SLOTS",
    "label": "Array-producer slots (WebGPU agents)",
    "value": 6,
    "note": "Every array-producing node counts. A Neighbour Census emits two, so roughly three census nodes fit. Above this the agent loop falls back to a CPU engine."
  },
  {
    "key": "AGENT_GPU_ARRAY_CAP",
    "label": "Members per array (WebGPU agents)",
    "value": 2048,
    "note": "WGSL zero-initialises per-thread arrays, so these scratch buffers are capped rather than sized by Max Agents. A query returning more members is truncated."
  },
  {
    "key": "BOND_REQUEST_DEPTH_DEFAULT",
    "label": "Bond requests per agent per generation (default)",
    "value": 8,
    "note": "Set by Bond Requests / Agent / Step. Requests past the depth are rejected WHOLE — never half-applied — and a notice tells you to raise it."
  },
  {
    "key": "BOND_REQUEST_DEPTH_MAX",
    "label": "Bond requests per agent per generation (maximum)",
    "value": 64,
    "note": "The upper clamp on that setting."
  },
  {
    "key": "MAX_LAYOUT_ITERATIONS",
    "label": "Layout (solver relaxation) iterations",
    "value": 32,
    "note": "How many times the force integrator runs per generation. 1 = the historical engine exactly."
  },
  {
    "key": "AGENT_HASH_BIN_CAP",
    "label": "Spatial-hash bins",
    "value": 65536,
    "note": "The neighbour hash coarsens its bin edge rather than exceeding this, so per-generation cost tracks the agent population, not the world size."
  },
  {
    "key": "MAX_LOOKUP_AXES",
    "label": "Lookup Table axes",
    "value": 6,
    "note": "A table may be keyed by up to this many axes."
  },
  {
    "key": "MAX_LOOKUP_TABLE_ENTRIES",
    "label": "Lookup Table entries",
    "value": 1048576,
    "note": "The product of every axis length."
  },
  {
    "key": "MAX_INT_RANGE_SPAN",
    "label": "Integer-range axis span",
    "value": 4096,
    "note": "The widest integer range a single table axis may cover."
  }
];

/** Node counts, so prose never hard-codes a number that can rot. */
export const NODE_COUNTS = {
  "registry": 154,
  "hiddenMacro": 3,
  "selectable": 151,
  "agent": 54,
  "overseer": 20,
  "agentOnWasm": 48,
  "agentOnWebgpu": 49,
  "agentCpuRoots": 4,
  "agentLowered": 3,
  "agentGapsWasm": 0,
  "agentGapsWebgpu": 0
} as const;

/** The agent capability rows, in the order the Properties panel lists them. */
export const AGENT_CAPABILITY_LIST: Array<{
  key: string; label: string; description: string; requires: string;
}> = [
  {
    "key": "body",
    "label": "Body / Extent",
    "description": "A radius surface, rendered as a disc/sphere. Unlocks Get / Set Agent Radius.",
    "requires": ""
  },
  {
    "key": "collision",
    "label": "Collision",
    "description": "Volume exclusion. Soft-sphere = a springy repulsion force (transient overlap; tune Repulsion Stiffness; needs Motion=Force). Positional = a rigid no-overlap constraint (billiard-ball; works under any Motion). Unlocks Neighbour Density.",
    "requires": "Body"
  },
  {
    "key": "charge",
    "label": "Charge (long-range)",
    "description": "A repulsive 1/(1+d²) pair force with a finite cutoff — the only force with reach beyond contact distance, so it is what holds a grown bond graph OPEN instead of letting it collapse into a jammed blob. Tune Charge Strength (negative = repulsive) + Cutoff.",
    "requires": "Motion = Force"
  },
  {
    "key": "bonds",
    "label": "Bonds",
    "description": "Connectivity edges (Data — no forces) or spring physics (Physics — needs Motion=Force). Unlocks Form/Break Bond, For Each Bond, Get Bonded Agents.",
    "requires": ""
  },
  {
    "key": "autoBond",
    "label": "Auto-bond",
    "description": "Engine forms/breaks bonds by proximity (hysteresis).",
    "requires": "Bonds = Physics"
  },
  {
    "key": "growth",
    "label": "Growth",
    "description": "Radius ramps toward a target radius each step. Unlocks Set Target Radius.",
    "requires": "Body"
  },
  {
    "key": "division",
    "label": "Division",
    "description": "Structural-phase split along the tension (or spread) axis. Unlocks Divide Agent + the Division Event root.",
    "requires": "Body"
  },
  {
    "key": "lifespan",
    "label": "Lifespan",
    "description": "Per-agent age auto-increments. Unlocks Get Age.",
    "requires": ""
  },
  {
    "key": "populationBirth",
    "label": "Population — Birth",
    "description": "Spawn agents mid-step (eggs / projectiles / offspring). Unlocks Spawn Agent + the Spawn Event root.",
    "requires": "Motion"
  },
  {
    "key": "populationDeath",
    "label": "Population — Death",
    "description": "Kill agents mid-step. Unlocks Kill Agent.",
    "requires": ""
  },
  {
    "key": "sensing",
    "label": "Sensing",
    "description": "The spatial hash + neighbour queries. Unlocks Get Nearby Agents + Get Agents In View (directional vision cone).",
    "requires": ""
  },
  {
    "key": "orientation",
    "label": "Orientation / Facing",
    "description": "A stored per-agent facing (heading source for FOV + sprite rotation).",
    "requires": ""
  },
  {
    "key": "fieldCoupling",
    "label": "Field Coupling",
    "description": "The agent ⇄ cell-grid morphogen bridge. Unlocks Sample Field, Field Gradient, Read / Affect Cells Under, Secrete To Field.",
    "requires": "a cell attribute with Agent access"
  }
];
