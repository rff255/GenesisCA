import type { NodeTypeDef } from '../types';
import { is3dModelLike } from '../compiler/niCodec';

/** Grid Periodic Event — a GLOBAL, once-per-firing-generation root for the cell
 *  grid. The periodic sibling of the Grid Init Event, exactly as the Grid Init
 *  Event is the global sibling of the per-cell Init Event.
 *
 *  ## Global, NOT per cell
 *  It runs EXACTLY ONCE on a generation where `generation % Period === Phase` —
 *  it has no "current cell", so the per-cell reads (Get Cell Attribute / Get Cell
 *  Position) don't apply. Loop inside DO and write arbitrary cells with **Set
 *  Cell (at Position)**: periodically drop substrate, re-seed a region, redraw a
 *  boundary. It can equally read an indicator and fire a **Stop Event** — the
 *  "check the measurement, decide whether to keep running" protocol, in the rule
 *  graph rather than the Overseer.
 *
 *  Several are allowed per model (each with its own cadence); a period of 1 fires
 *  every generation.
 *
 *  ## When it runs
 *  At the TOP of the generation, BEFORE the agent step and BEFORE the cell step —
 *  so anything it writes is visible to THIS generation's rules (the same ordering
 *  reason the agent field deposit precedes the cell step).
 *
 *  ## How it runs — one JS function in the worker, on every compile target
 *  Like the Grid Init Event (and the Agent Init Event / Division Event), it
 *  compiles to ONE JS function the worker executes; the WASM / WebGPU step
 *  compilers never see this root. So it works identically on JS, WASM and WebGPU
 *  with NO per-target emit. On the WebGPU grid target the worker reads the cell
 *  attributes back before running it and uploads them after, so a periodic write
 *  can neither read nor clobber stale GPU state (that round-trip is paid ONLY on
 *  a firing generation).
 *
 *  Value-outs expose the grid dimensions — `width` (W), `height` (H) and, in a 3D
 *  model, `depth` (D) — plus `stepIndex` = ⌊generation / Period⌋, the count of
 *  firings so far.
 *
 *  compile() returns '' — the compiler emits the once-per-firing function. */
export const GridPeriodicEventNode: NodeTypeDef = {
  type: 'gridPeriodic',
  label: 'Grid Periodic Event',
  description: 'Runs ONCE GLOBALLY (not per cell) every Nth generation — loop here + Set Cell (at Position) to add substrate, or read an indicator and fire a Stop Event. Outputs the grid width / height / depth + Step Index = ⌊generation / Period⌋.',
  category: 'event',
  // Event roots are white (the CA-grid standard: Step / Init Event / Grid Init).
  color: '#ffffff',
  ports: [
    { id: 'do', label: 'DO', kind: 'output', category: 'flow' },
    { id: 'width', label: 'width', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'height', label: 'height', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'depth', label: 'depth', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'stepIndex', label: 'Step Index', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  // `depth` exists only in a 3D grid — hidden in 2D (the compiler emits no `D`
  // preamble there, so a wired 2D `depth` port would read as undefined).
  hiddenPorts: (_config, model) => (is3dModelLike(model) ? [] : ['depth']),
  defaultConfig: { period: 10, phase: 0 },
  compile: () => '',  // root node — the compiler emits the once-per-firing function
};
