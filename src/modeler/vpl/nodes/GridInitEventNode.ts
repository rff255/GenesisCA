import type { NodeTypeDef } from '../types';
import { is3dModelLike } from '../compiler/niCodec';

/** Grid Init Event — a once-per-Reset GLOBAL setup root for the cell grid.
 *
 *  Unlike the per-cell Init Event (which the engine runs once for EVERY lattice
 *  cell), this runs EXACTLY ONCE — the free-form, imperative counterpart, mirroring
 *  the Agent Init Event. Wire a Loop (or nested Loops) inside the DO chain and
 *  write to arbitrary cells with Set Cell (at Position) to seed the grid
 *  procedurally: a centred seed box, N random seeds, a drawn shape, etc.
 *
 *  Value-outs expose the grid dimensions — `width` (W), `height` (H) and, in a 3D
 *  model, `depth` (D) — so seeding stays grid-size-independent (seed the middle at
 *  width/2, …). It has NO "current cell", so the per-cell reads (Get Cell
 *  Attribute / Get Cell Position) don't apply here; write with Set Cell (at
 *  Position).
 *
 *  Runs after default attribute values (and after the per-cell Init Event, if
 *  any) and before the first colour pass, on Reset AND first load; NOT on Load
 *  State. Singleton (one per model, like Step / Init Event). Executes as a JS
 *  function in the worker on ALL compile targets (like the Agent Init Event): it
 *  writes the CPU/wasm attribute buffers once, then the worker syncs / uploads
 *  them — so it works identically on JS, WASM and WebGPU with no per-target emit.
 *
 *  compile() returns '' — the compiler emits the once-only setup function. */
export const GridInitEventNode: NodeTypeDef = {
  type: 'gridInit',
  label: 'Grid Init Event',
  description: 'Runs ONCE on Reset — loop here + Set Cell (at Position) to seed the grid procedurally. Outputs the grid width / height / depth.',
  category: 'event',
  // Event roots are white (the CA-grid standard: Step / Init Event / Output Mapping).
  color: '#ffffff',
  ports: [
    { id: 'do', label: 'DO', kind: 'output', category: 'flow' },
    { id: 'width', label: 'width', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'height', label: 'height', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'depth', label: 'depth', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  // `depth` exists only in a 3D grid — hidden in 2D (the compiler emits no `D`
  // preamble there, so a wired 2D `depth` port would read as undefined).
  hiddenPorts: (_config, model) => (is3dModelLike(model) ? [] : ['depth']),
  defaultConfig: {},
  compile: () => '',  // root node — the compiler emits the once-only setup function
};
