import type { NodeTypeDef } from '../types';
import { is3dModelLike } from '../compiler/niCodec';

/** Get Grid Dimensions — outputs the SIZE of the world the rule runs in:
 *  `width` (columns), `height` (rows) and, in a 3D model, `depth` (layers).
 *
 *  UNIVERSAL: available on BOTH the Cells graph (the lattice grid size) and the
 *  Agents graph (the agent world size — the agent world IS the cell grid, 1:1,
 *  so the two report the same numbers). It reads no per-cell / per-agent state,
 *  so it works in EVERY event on both graphs (Step / Init / Grid Init / Input
 *  Mapping / Output Mapping — Behaviour Step / Agent Init / Division Event /
 *  Agent Output Mapping).
 *
 *  Why it exists: a rule that wants to be grid-size INDEPENDENT (seed the middle,
 *  normalise a coordinate to 0..1, fade by distance from an edge, keep agents
 *  inside the world) had to either hard-code the dimensions — silently wrong the
 *  moment the user resizes the grid in the simulator — or route them through the
 *  event roots that happen to expose them (the Grid Init Event's width/height/
 *  depth, the Init Event's maxX/maxY, the Agent Init Event's World Width/Height).
 *  This node exposes them everywhere, always LIVE (a simulator Resize is picked up
 *  on the next recompile; nothing is baked into the model file).
 *
 *  Multi-output: each port resolves via the `_v<id>_<portId>` convention
 *  (registered in `MULTI_OUTPUT_TYPES`). `depth` only exists in a 3D model
 *  (hidden via `hiddenPorts` in 2D, where it is always 1).
 *
 *  All six compile surfaces: the dimensions are compile-time constants on the
 *  cell targets (JS reads the `W`/`H`/`D` step params; WASM/WebGPU bake the
 *  literals from the layout) and thread through the agent ABI on the agent
 *  targets (JS `_fieldW`/`_fieldH`/`_fieldTotal`, WASM's fieldW/H/D params,
 *  WebGPU's `control.fieldW/H/D`). Pure + input-free ⇒ loop-invariant, so it is
 *  hoisted out of the per-cell / per-agent loop on every target. */
export const GetGridDimensionsNode: NodeTypeDef = {
  type: 'getGridDimensions',
  label: 'Get Grid Dimensions',
  description: 'Outputs the size of the world — grid Width, Height (and Depth in 3D) — so a rule can be written independently of the grid size (centre-relative seeding, normalised coordinates, edge distance).',
  agentLabel: 'Get World Dimensions',
  agentDescription: "Outputs the size of the agent world — Width, Height (and Depth in 3D). The agent world IS the cell grid, so these are the grid's dimensions.",
  category: 'data',
  color: '#1565c0',
  ports: [
    { id: 'width', label: 'Width', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'height', label: 'Height', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'depth', label: 'Depth', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  // Depth only means something in a 3D model (a 2D grid / agent world is 1 layer
  // deep). Hidden in 2D, like Get Cell Position's `layer` and Get Self Position's `z`.
  hiddenPorts: (_config, model) => (is3dModelLike(model) ? [] : ['depth']),
  defaultConfig: {},
  compile: (nodeId, _config, _inputs, _boundary, ctx) => {
    const is3d = !!ctx?.is3d;
    if (ctx?.agentGraph) {
      // Agents: the world IS the cell grid 1:1. `_fieldW` / `_fieldH` /
      // `_fieldTotal` ride EVERY agent root's ABI (behaviour / division / init /
      // output mapping). `_fieldD` does NOT — the Agent Init Event's ABI omits it
      // — so derive the depth from the total (exactly what the Agent Init Event's
      // own World Depth port does), which is correct on all four roots.
      const depth = is3d
        ? `((_fieldW > 0 && _fieldH > 0) ? Math.round(_fieldTotal / (_fieldW * _fieldH)) : 1)`
        : '1';
      return `const _v${nodeId}_width = _fieldW; const _v${nodeId}_height = _fieldH; const _v${nodeId}_depth = ${depth};\n`;
    }
    // Cells: `W` / `H` are step params on every cell entry point; `D` only exists
    // in a 3D model (2D signatures stay byte-identical — a 2D depth is 1).
    return `const _v${nodeId}_width = W; const _v${nodeId}_height = H; const _v${nodeId}_depth = ${is3d ? 'D' : '1'};\n`;
  },
};
