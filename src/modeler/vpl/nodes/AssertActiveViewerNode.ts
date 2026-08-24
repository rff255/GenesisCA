import type { NodeTypeDef } from '../types';

/**
 * Assert Active Output Mapping — run a branch ONLY while the simulator is
 * showing a particular Attribute→Color viewer.
 *
 * WHY: a model often computes attributes that exist purely to be LOOKED AT
 * (a smoothed field, a debug gradient, a per-cell statistic). That work runs on
 * every cell of every generation even when the user is looking at a different
 * viewer. Wiring it under this node's IF ACTIVE branch makes it cost nothing
 * whenever its viewer is not on screen.
 *
 * SHAPE — this is `conditional` minus the ELSE, and that is deliberate:
 *   - `IF ACTIVE` is a real BRANCH port, so sink analysis SINKS the values it
 *     alone consumes INSIDE the guard. That is the whole point: a `next`-style
 *     pass-through is transparent to every analyzer, so the guarded work would
 *     still be computed above the branch and nothing would be saved.
 *   - `DONE` (`next`) keeps its universal meaning — it runs UNCONDITIONALLY,
 *     right after this node, at the same scope. Making `next` itself the guard
 *     would break the documented invariant that `A.next → B` compiles
 *     byte-identically to `parent → [A, B]`.
 *
 * SEMANTICS: the test is always "is the simulator's active viewer THIS
 * mapping", on every entry point. Inside an Output Mapping pass that is
 * trivially true for the pass's own mapping (the worker dispatches only the
 * active viewer's pass) and trivially false for any other — a harmless no-op
 * either way, so the node is not restricted to the Step.
 *
 * LATTICE-ONLY (`LATTICE_ONLY_TYPES`): the cell targets all carry a viewer
 * comparison (JS's `_isV_<safeId>` hoist, WASM's per-step `viewerLocals` i32,
 * WGSL's `control.activeViewer`), but the WebGPU AGENT shader carries no
 * activeViewer at all — so shipping this on the Agents graph would be a partial
 * target set. It runs on ALL THREE cell targets instead.
 */
export const AssertActiveViewerNode: NodeTypeDef = {
  type: 'assertActiveViewer',
  label: 'Assert Active Output Mapping',
  description: 'Runs its IF ACTIVE branch only while the chosen Attribute→Color mapping is the viewer currently selected in the simulator — so visualization-only work costs nothing when you are looking at something else. DONE always runs.',
  category: 'flow',
  color: '#1b5e20',
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    // DONE renders FIRST among the outputs so it stays aligned with the DO
    // input (the horizontal through-line the other flow nodes keep); the
    // guarded branch hangs below.
    { id: 'next', label: 'DONE', kind: 'output', category: 'flow' },
    { id: 'then', label: 'IF ACTIVE', kind: 'output', category: 'flow' },
  ],
  defaultConfig: {},
  compile: () => '',  // Compiler handles control flow nodes specially
};
