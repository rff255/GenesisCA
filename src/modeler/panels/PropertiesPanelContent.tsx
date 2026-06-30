import { useModel } from '../../model/ModelContext';
import type {
  BoundaryTreatment, UpdateMode, AsyncScheme,
  EndConditions, EndConditionOp, IndicatorEndCondition,
} from '../../model/types';
import { IndicatorsPanelSection } from './IndicatorsPanelSection';
import { useDetailSelection, type PanelContentProps } from '../ModelerDetailContext';
import { useListReorder } from './useListReorder';
import { NumberField } from '../vpl/widgets/InlineWidgets';
import { cbNum, usesBondingPhysics, CENTER_BASED_DEFAULTS } from '../../model/centerBased';
import type { CenterBasedNumericKey } from '../../model/centerBased';
import { isAgentGraphWasmSupported } from '../vpl/compiler/agentWasm/compile';
import { isAgentGraphWebGPUSupported } from '../vpl/compiler/agentWebgpu/compile';
import styles from './PanelContent.module.css';

function newCondId(): string {
  return `ec_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

export function PropertiesPanelContent({ mode = 'list' }: PanelContentProps = {}) {
  const { model, updateProperties, reorderEndConditions, updateVariegatedCells, updateTopologyMode, updateCenterBased } = useModel();
  // Indicators are a master-detail sub-section: the list lives in this panel,
  // the selected indicator's editor opens in the shared second (detail) panel.
  // Selection rides Properties' single detail slot as an `indicator:<id>` key.
  const [indSel, setIndSel] = useDetailSelection('properties');
  const selIndId = indSel && indSel.startsWith('indicator:') ? indSel.slice(10) : null;
  const selectInd = (id: string | null) => setIndSel(id ? `indicator:${id}` : null);
  const { properties } = model;
  // 3D Grid CA / Bond-Graph Morphogenesis (M0a) mode state.
  const topo = model.topologyMode ?? { gridCells: true, agents: false };
  const is3d = (properties.dimension ?? '2d') === '3d';
  const ecReorder = useListReorder(
    properties.endConditions?.indicatorConditions || [],
    reorderEndConditions,
  );

  const ec = properties.endConditions;
  const ecEnabled = !!ec?.enabled;
  const updateEndConditions = (changes: Partial<EndConditions>) => {
    updateProperties({
      endConditions: {
        enabled: ecEnabled,
        maxGenerations: ec?.maxGenerations,
        indicatorConditions: ec?.indicatorConditions,
        ...changes,
      },
    });
  };
  // Spatial indicators (xAxis rows/columns) produce per-position-bin arrays, not
  // a scalar/category count, so they can't drive a numeric end condition.
  const isSpatialIndicator = (i: { kind: string; xAxis?: string }) =>
    i.kind === 'linked' && (i.xAxis === 'rows' || i.xAxis === 'columns' || i.xAxis === 'layers');
  const addIndicatorCondition = () => {
    const firstIndicator = (model.indicators || []).find(i => !isSpatialIndicator(i));
    if (!firstIndicator) return;
    // For linked-frequency indicators, seed a sensible default category so the
    // condition is immediately valid (not every user knows they need one).
    let category: string | undefined;
    let value = firstIndicator.defaultValue ?? '0';
    if (firstIndicator.kind === 'linked' && firstIndicator.linkedAggregation === 'frequency') {
      const linkedAttr = (model.attributes || []).find(a => a.id === firstIndicator.linkedAttributeId);
      if (linkedAttr?.type === 'bool') category = 'true';
      else if (linkedAttr?.type === 'tag') category = linkedAttr.tagOptions?.[0] ?? '';
      else if (linkedAttr?.type === 'integer') category = '0';
      // float: leave undefined — UI disables the row
      value = '0'; // frequency count
    }
    const cond: IndicatorEndCondition = {
      id: newCondId(),
      indicatorId: firstIndicator.id,
      op: '==',
      value,
      ...(category !== undefined ? { category } : {}),
    };
    updateEndConditions({ indicatorConditions: [...(ec?.indicatorConditions || []), cond] });
  };
  const updateIndicatorCondition = (id: string, changes: Partial<IndicatorEndCondition>) => {
    updateEndConditions({
      indicatorConditions: (ec?.indicatorConditions || []).map(c =>
        c.id === id ? { ...c, ...changes } : c,
      ),
    });
  };
  const removeIndicatorCondition = (id: string) => {
    updateEndConditions({
      indicatorConditions: (ec?.indicatorConditions || []).filter(c => c.id !== id),
    });
  };

  // Detail panel: render only the selected indicator's editor.
  if (mode === 'detail') {
    return <IndicatorsPanelSection mode="detail" selectedId={selIndId} onSelect={selectInd} />;
  }

  return (
    <div className={styles.fieldGroup}>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Structure</div>
        <div className={styles.fieldGroup}>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Boundary Treatment</label>
            <select
              className={styles.selectInput}
              value={properties.boundaryTreatment}
              onChange={e =>
                updateProperties({
                  boundaryTreatment: e.target.value as BoundaryTreatment,
                })
              }
            >
              <option value="torus">Torus</option>
              <option value="constant">Constant</option>
            </select>
          </div>
          <div className={styles.fieldRow}>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Grid Width</label>
              <NumberField
                className={styles.numberInput}
                value={properties.gridWidth}
                min={1}
                integer
                onNumber={n => updateProperties({ gridWidth: n })}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Grid Height</label>
              <NumberField
                className={styles.numberInput}
                value={properties.gridHeight}
                min={1}
                integer
                onNumber={n => updateProperties({ gridHeight: n })}
              />
            </div>
            {is3d && (
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Grid Depth</label>
                <NumberField
                  className={styles.numberInput}
                  value={properties.gridDepth ?? 1}
                  min={1}
                  integer
                  onNumber={n => updateProperties({ gridDepth: n })}
                />
              </div>
            )}
          </div>

          {/* Dimension — 2D lattice vs a W×H×D volume (3D Grid CA milestone). */}
          <div style={{ marginTop: 14, borderTop: '1px solid #333', paddingTop: 10 }}>
            <label className={styles.fieldLabel} style={{ marginBottom: 4 }}>Dimension</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2 }}>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 6, cursor: 'pointer', fontSize: '0.72rem' }}>
                <input
                  type="radio"
                  name="dimension"
                  value="2d"
                  checked={!is3d}
                  onChange={() => updateProperties({ dimension: '2d' })}
                  style={{ marginTop: 2 }}
                />
                <span>
                  <strong>2D (W&times;H grid)</strong>
                  <br />
                  <span style={{ color: '#888', fontSize: '0.66rem' }}>
                    Classic flat lattice. Rendered with the 2D canvas.
                  </span>
                </span>
              </label>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 6, cursor: 'pointer', fontSize: '0.72rem' }}>
                <input
                  type="radio"
                  name="dimension"
                  value="3d"
                  checked={is3d}
                  onChange={() => {
                    // Variegated Cells is 2D-only — force it off when going 3D.
                    if (model.variegatedCells?.enabled) updateVariegatedCells({ enabled: false });
                    updateProperties({ dimension: '3d', gridDepth: properties.gridDepth ?? 1 });
                  }}
                  style={{ marginTop: 2 }}
                />
                <span>
                  <strong>3D (W&times;H&times;D volume)</strong>
                  <br />
                  <span style={{ color: '#888', fontSize: '0.66rem' }}>
                    Voxel grid with a layer (Z) axis, rendered with an orbit camera + clip plane. Direct neighbour-index nodes are gated off; use parametric / slice neighbourhoods.
                  </span>
                </span>
              </label>
            </div>
          </div>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Execution</div>
        <div className={styles.fieldGroup}>
          {/* Cell-grid execution — the GRID's update mode + compile target. Hidden
              for an agents-only model (no lattice to simulate); the agent layer's
              own update mode + compile target live in the Bond-Graph Agents block. */}
          {topo.gridCells && (<>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Update Mode</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2 }}>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 6, cursor: properties.useWebGPU ? 'not-allowed' : 'pointer', fontSize: '0.72rem', opacity: properties.useWebGPU ? 0.55 : 1 }}>
                <input
                  type="radio"
                  name="updateMode"
                  value="synchronous"
                  checked={properties.updateMode !== 'asynchronous'}
                  onChange={() => updateProperties({ updateMode: 'synchronous' as UpdateMode })}
                  style={{ marginTop: 2 }}
                />
                <span>
                  <strong>Synchronous</strong>
                  <br />
                  <span style={{ color: '#888', fontSize: '0.66rem' }}>
                    All cells read from the previous generation and write to the next simultaneously. Classic CA behavior.
                  </span>
                </span>
              </label>
              <label
                style={{ display: 'flex', alignItems: 'flex-start', gap: 6, cursor: properties.useWebGPU ? 'not-allowed' : 'pointer', fontSize: '0.72rem', opacity: properties.useWebGPU ? 0.55 : 1 }}
                title={properties.useWebGPU ? 'WebGPU target requires synchronous update mode (cells run in parallel on the GPU).' : undefined}
              >
                <input
                  type="radio"
                  name="updateMode"
                  value="asynchronous"
                  checked={properties.updateMode === 'asynchronous'}
                  disabled={!!properties.useWebGPU}
                  onChange={() => updateProperties({ updateMode: 'asynchronous' as UpdateMode })}
                  style={{ marginTop: 2 }}
                />
                <span>
                  <strong>Asynchronous</strong>
                  <br />
                  <span style={{ color: '#888', fontSize: '0.66rem' }}>
                    Cells update one at a time using a single buffer. Each cell sees previous updates within the same generation. Enables number-conserving models.
                  </span>
                </span>
              </label>
            </div>
          </div>
          {properties.updateMode === 'asynchronous' && !properties.useWebGPU && (
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Asynchronous Update Scheme</label>
              <select
                className={styles.selectInput}
                value={properties.asyncScheme || 'random-order'}
                onChange={e =>
                  updateProperties({ asyncScheme: e.target.value as AsyncScheme })
                }
              >
                <option value="random-order">Random Order</option>
                <option value="random-independent">Random Independent</option>
                <option value="cyclic">Cyclic</option>
              </select>
              <span style={{ color: '#888', fontSize: '0.62rem', marginTop: 2, display: 'block' }}>
                {(properties.asyncScheme || 'random-order') === 'random-order' &&
                  'All cells update once per generation in random order (Fisher-Yates shuffle).'}
                {properties.asyncScheme === 'random-independent' &&
                  'N random cell picks with replacement per generation. Some cells may update 0 or 2+ times.'}
                {properties.asyncScheme === 'cyclic' &&
                  'A fixed random order decided at initialization, reused every generation. Fastest option.'}
              </span>
            </div>
          )}

          <div style={{ marginTop: 14, borderTop: '1px solid #333', paddingTop: 10 }}>
            <label className={styles.fieldLabel} style={{ marginBottom: 4 }}>Compile Target</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2 }}>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 6, cursor: 'pointer', fontSize: '0.72rem' }}>
                <input
                  type="radio"
                  name="compileTarget"
                  checked={!!properties.useWasm && !properties.useWebGPU}
                  onChange={() => updateProperties({ useWasm: true, useWebGPU: false })}
                  style={{ marginTop: 2 }}
                />
                <span>
                  <strong>WebAssembly (default)</strong>
                  <br />
                  <span style={{ color: '#888', fontSize: '0.66rem' }}>
                    Hand-compiled WASM module — typically several times faster than JS on dense neighborhoods. Production target for most models.
                  </span>
                </span>
              </label>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 6, cursor: 'pointer', fontSize: '0.72rem' }}>
                <input
                  type="radio"
                  name="compileTarget"
                  checked={!!properties.useWebGPU}
                  onChange={() => updateProperties({ useWebGPU: true, useWasm: false, updateMode: 'synchronous' })}
                  style={{ marginTop: 2 }}
                />
                <span>
                  <strong>WebGPU (sync only)</strong>
                  <br />
                  <span style={{ color: '#888', fontSize: '0.66rem' }}>
                    WGSL compute shaders on the GPU — designed for very large grids and math-heavy per-cell work. Requires synchronous update mode. Browser must support WebGPU (Chrome 127+, Firefox 141+, Safari 17.4+).{is3d ? ' In 3D, the GPU runs the simulation while the voxel renderer reads colours back each step.' : ''}
                  </span>
                </span>
              </label>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 6, cursor: 'pointer', fontSize: '0.72rem' }}>
                <input
                  type="radio"
                  name="compileTarget"
                  checked={!properties.useWasm && !properties.useWebGPU}
                  onChange={() => updateProperties({ useWasm: false, useWebGPU: false })}
                  style={{ marginTop: 2 }}
                />
                <span>
                  <strong>Debug / Reference (JS)</strong>
                  <br />
                  <span style={{ color: '#888', fontSize: '0.66rem' }}>
                    Plain JavaScript compile target. Slower but human-readable in Show Code, with full node coverage. Useful for prototyping and verifying WASM/WebGPU parity.
                  </span>
                </span>
              </label>
            </div>
            <span style={{ color: '#888', fontSize: '0.62rem', marginTop: 6, display: 'block' }}>
              Targets are mutually exclusive. Switching restarts the simulator (grid state is lost).
            </span>
            {/* B4B — WebGPU stop-check interval. Greyed unless WebGPU is selected. */}
            <div
              className={styles.field}
              style={{ marginTop: 10, opacity: properties.useWebGPU ? 1 : 0.45 }}
              title={
                properties.useWebGPU
                  ? 'Check stop events every N generations. Higher = faster on WebGPU but may overshoot a stop event by up to N-1 generations. JS / WASM ignore this.'
                  : 'WebGPU only — enable WebGPU above to use this setting.'
              }
            >
              <label className={styles.fieldLabel}>WebGPU stop-check interval</label>
              <NumberField
                className={styles.numberInput}
                min={1}
                integer
                disabled={!properties.useWebGPU}
                value={properties.webgpuStopCheckInterval ?? 1}
                onNumber={n => updateProperties({ webgpuStopCheckInterval: n })}
              />
              <span style={{ color: '#888', fontSize: '0.62rem', marginTop: 2, display: 'block' }}>
                1 = exact (default). Higher values amortize the per-step GPU stall but a stop event may surface up to K-1 generations late.
              </span>
            </div>
          </div>
          </>)}

          {/* Topology — which layer(s) the model uses. Grid Cells is the classic
              lattice CA; Bond-Graph Agents is the off-lattice agent rule graph
              (a second graph, switchable via the sub-tab strip above the canvas).
              ≥1 must stay checked (reducer-enforced; whichever is the only checked
              one is also UI-disabled so the user can't uncheck the last one). */}
          <div style={{ marginTop: 14, borderTop: '1px solid #333', paddingTop: 10 }}>
            <label className={styles.fieldLabel} style={{ marginBottom: 4 }}>Topology</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2 }}>
              <label
                style={{ display: 'flex', alignItems: 'flex-start', gap: 6, cursor: (topo.gridCells && !topo.agents) ? 'not-allowed' : 'pointer', fontSize: '0.72rem', opacity: (topo.gridCells && !topo.agents) ? 0.55 : 1 }}
                title={(topo.gridCells && !topo.agents) ? 'At least one topology must stay enabled.' : undefined}
              >
                <input
                  type="checkbox"
                  checked={topo.gridCells}
                  disabled={topo.gridCells && !topo.agents}
                  onChange={e => updateTopologyMode({ gridCells: e.target.checked })}
                  style={{ marginTop: 2 }}
                />
                <span>
                  <strong>Grid Cells</strong>
                  <br />
                  <span style={{ color: '#888', fontSize: '0.66rem' }}>
                    The classic lattice cellular automaton (this app's core).
                  </span>
                </span>
              </label>
              <label
                style={{ display: 'flex', alignItems: 'flex-start', gap: 6, cursor: (topo.agents && !topo.gridCells) ? 'not-allowed' : 'pointer', fontSize: '0.72rem', opacity: (topo.agents && !topo.gridCells) ? 0.55 : 1 }}
                title={(topo.agents && !topo.gridCells) ? 'At least one topology must stay enabled.' : undefined}
              >
                <input
                  type="checkbox"
                  checked={topo.agents}
                  disabled={topo.agents && !topo.gridCells}
                  onChange={e => updateTopologyMode({ agents: e.target.checked })}
                  style={{ marginTop: 2 }}
                />
                <span>
                  <strong>Bond-Graph Agents</strong>
                  <br />
                  <span style={{ color: '#888', fontSize: '0.66rem' }}>
                    Off-lattice agents that float in continuous space, joined by bonds that grow and divide into shape (morphogenesis). Adds a second <strong>Agents</strong> rule graph (switch graphs from the tab strip above the canvas). Runs on the Debug / Reference (JS) engine this release.
                  </span>
                </span>
              </label>
            </div>
          </div>

          {/* Bond-Graph Agents config — shown when the Agents topology is on.
              Capacity ceilings (allocated once; overflow rejects), the seed
              population, the soft-sphere force law, growth, and bonds. Every
              field is live-tunable except the ceilings (a maxAgents/maxBonds
              change re-allocates → a worker reinit). */}
          {topo.agents && (() => {
            const cb = model.centerBased;
            // "Use bonding physics" master toggle (req 10): when off, the engine
            // applies NO built-in forces (soft-sphere / springs / growth / auto-bond)
            // and the Forces + Bonds rows are hidden — agents move only by the
            // graph's Apply Force / Set Velocity. Resolved with the customForcesOnly
            // back-compat fallback so loaded files reflect their real behaviour.
            const bonding = usesBondingPhysics(cb);
            // Live WASM-target support for the CURRENT agent graph. The WASM agent
            // target is FULL-COVERAGE (the whole catalogue runs with JS bit-parity);
            // the only clamp is a per-node array-scratch-slot budget (too many
            // simultaneous Get-Nearby-Agents producers → JS). When false, picking
            // WASM is honest but the engine falls back to JS (agentTargetOf clamps).
            const agentWasmSupported = isAgentGraphWasmSupported(model);
            // PR7: live WebGPU-target support for the CURRENT agent graph (the
            // Boids node subset, 2D only). When false, picking WebGPU is honest
            // but the engine falls back to JS (agentTargetOf clamps).
            const agentWebgpuSupported = isAgentGraphWebGPUSupported(model);
            const num = (k: CenterBasedNumericKey) => cbNum(cb, k);
            const NF = (k: CenterBasedNumericKey, opts?: { min?: number; max?: number; step?: number; integer?: boolean }) => (
              <NumberField
                className={styles.numberInput}
                value={num(k)}
                min={opts?.min}
                max={opts?.max}
                step={opts?.step}
                integer={opts?.integer}
                onNumber={n => updateCenterBased({ [k]: n })}
              />
            );
            const Row = (label: string, field: React.ReactNode, hint?: string) => (
              <div style={{ marginBottom: 8 }}>
                <label className={styles.fieldLabel} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span>{label}</span>{field}
                </label>
                {hint && <span style={{ color: '#888', fontSize: '0.62rem', display: 'block' }}>{hint}</span>}
              </div>
            );
            return (
              <div style={{ marginTop: 14, borderTop: '1px solid #333', paddingTop: 10 }}>
                <label className={styles.fieldLabel} style={{ marginBottom: 6, color: '#b58fd6' }}>Bond-Graph Agents</label>
                {/* Agent Update Mode — INDEPENDENT of the grid's Update Mode radio
                    above. The user can run a synchronous grid rule with async
                    agents, and vice versa. Changing it re-allocates the attribute
                    buffers (double- vs single-buffered) → a full reinit (it's in
                    needsFullInit). */}
                <div style={{ fontSize: '0.6rem', color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '6px 0 4px' }}>Agent Update Mode</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 2, marginBottom: 4 }}>
                  {([
                    ['async', 'Asynchronous', 'Single-buffered attributes — a Set Agent Attribute to a neighbour is immediately visible to a later agent this step (sequential).'],
                    ['sync', 'Synchronous', 'Double-buffered attributes — every agent reads the previous step; writes are swapped in at the step’s end (parallel / snapshot semantics; required by the forthcoming WebGPU agent target).'],
                  ] as const).map(([val, title, hint]) => (
                    <label key={val} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, cursor: 'pointer', fontSize: '0.72rem' }}>
                      <input
                        type="radio"
                        name="agentUpdateMode"
                        checked={(cb?.agentUpdateMode ?? 'async') === val}
                        onChange={() => updateCenterBased({ agentUpdateMode: val })}
                        style={{ marginTop: 2 }}
                      />
                      <span><strong>{title}</strong><br /><span style={{ color: '#888', fontSize: '0.66rem' }}>{hint}</span></span>
                    </label>
                  ))}
                </div>
                <span style={{ color: '#888', fontSize: '0.62rem', display: 'block', marginBottom: 4 }}>
                  Independent of the grid&apos;s Update Mode. Positions are snapshot-integrated in both modes; this governs attribute read/write visibility.
                </span>

                {/* Agent Compile Target — INDEPENDENT of the grid's Compile Target
                    radio above. JS = full coverage. WASM = FULL coverage with JS
                    bit-parity (the whole catalogue; 2-5x faster on heavy rules);
                    clamps to JS only on the array-scratch-slot budget. WebGPU
                    (full coverage, 2D+3D, f32/statistical parity) builds a dedicated
                    agent GPU runtime + dispatches behaviour + force shaders per step,
                    else falls back to JS. */}
                <div style={{ fontSize: '0.6rem', color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '6px 0 4px' }}>Agent Compile Target</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 2, marginBottom: 4 }}>
                  {([
                    ['js', 'Debug / Reference (JS)', 'Plain JavaScript agent engine — full node coverage. The agent loop is O(N) via the spatial hash.', false],
                    ['wasm', 'WebAssembly', agentWasmSupported
                      ? 'This agent graph runs on WebAssembly with JS bit-parity (the whole node catalogue is supported). Independent of the grid target; typically 2-5x faster than JS for heavy per-agent rules.'
                      : 'Selectable, but this graph has too many simultaneous Get-Nearby-Agents producers for the WASM scratch budget, so it falls back to JS.', false],
                    ['webgpu', 'WebGPU', agentWebgpuSupported
                      ? 'This agent graph runs on WebGPU (the Boids node subset, 2D) — the behaviour + force passes dispatch on the GPU. Independent of the grid target; falls back to JS if WebGPU is unavailable.'
                      : 'Selectable, but this graph uses nodes not yet ported to the WebGPU agent loop (or is 3D), so it falls back to JS (bonds / division / field stay CPU).', false],
                  ] as const).map(([val, title, hint, disabled]) => (
                    <label
                      key={val}
                      style={{ display: 'flex', alignItems: 'flex-start', gap: 6, cursor: disabled ? 'not-allowed' : 'pointer', fontSize: '0.72rem', opacity: disabled ? 0.5 : 1 }}
                      title={undefined}
                    >
                      <input
                        type="radio"
                        name="agentCompileTarget"
                        disabled={disabled}
                        checked={(cb?.agentTarget ?? 'js') === val}
                        onChange={() => updateCenterBased({ agentTarget: val })}
                        style={{ marginTop: 2 }}
                      />
                      <span>
                        <strong>{title}</strong>
                        <br />
                        <span style={{ color: '#888', fontSize: '0.66rem' }}>{hint}</span>
                      </span>
                    </label>
                  ))}
                </div>
                <span style={{ color: '#888', fontSize: '0.62rem', display: 'block', marginBottom: 4 }}>
                  Independent of the grid&apos;s Compile Target. The grid and agents can run on different targets (e.g. WebGPU grid diffusion + WASM agents).
                </span>
                <div style={{ fontSize: '0.6rem', color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '6px 0 4px' }}>Capacity</div>
                {Row('Max Agents', NF('maxAgents', { min: 1, integer: true }), 'Over-allocated ceiling; overflow rejects (never wraps). Changing it re-inits the engine.')}
                {Row('Max Bonds / Agent', NF('maxBonds', { min: 0, integer: true }), '0 = no bonds (pure-force / charged-particle models); the bond store is then not allocated.')}
                <div style={{ fontSize: '0.6rem', color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '8px 0 4px' }}>Seeding</div>
                {Row('Seed Count', NF('seedCount', { min: 0, integer: true }), 'Agents laid down on Reset (0 = seed via the brush).')}
                {Row('Default Radius', NF('defaultRadius', { min: 0.01, step: 0.1 }))}
                {/* Motion — the velocity integrator; relevant to EVERY agent model
                    (a custom-force boids model lives entirely here), so always shown. */}
                <div style={{ fontSize: '0.6rem', color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '8px 0 4px' }}>Motion</div>
                {Row('Momentum', NF('momentum', { min: 0, max: 0.999, step: 0.05 }), '0 = overdamped (tissue); ~0.9 = flocking inertia.')}
                {Row('Max Speed', NF('maxSpeed', { min: 0, step: 0.1 }), 'Per-step speed cap (0 = uncapped).')}
                {Row('Neighbour Query Radius', NF('neighbourQueryRadius', { min: 1, step: 0.5 }), 'Get Nearby Agents radius the spatial-hash bin is sized to cover.')}
                {Row('Time Step Δt', NF('timeStep', { min: 0.001, step: 0.05 }), 'Auto-clamped against the stability bound.')}
                {Row('Drag η', NF('drag', { min: 0.01, step: 0.1 }), 'Overdamped drag (scales force → velocity).')}

                {/* Use bonding physics master toggle (req 10). OFF = no engine
                    forces (agents move only by graph forces); the Forces + Bonds
                    rows below appear only when ON. */}
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 6, cursor: 'pointer', fontSize: '0.72rem', margin: '12px 0 4px' }}>
                  <input type="checkbox" checked={bonding} onChange={e => {
                    const on = e.target.checked;
                    // Enabling bonding with no bond capacity is a foot-gun (nothing
                    // can bond). Bump maxBonds to the engine default when turning it
                    // on and the store is still empty.
                    const bumpBonds = on && (cb?.maxBonds ?? 0) <= 0;
                    updateCenterBased(bumpBonds ? { useBondingPhysics: on, maxBonds: CENTER_BASED_DEFAULTS.maxBonds } : { useBondingPhysics: on });
                  }} style={{ marginTop: 2 }} />
                  <span><strong>Use bonding physics</strong><br /><span style={{ color: '#888', fontSize: '0.66rem' }}>Engine soft-sphere repulsion / adhesion + bond springs + growth + auto-bond. Off = agents move only by graph-authored Apply Force / Set Velocity (the &quot;agents that have nothing to do with bonds&quot; case).</span></span>
                </label>
                {bonding && (<>
                  <div style={{ fontSize: '0.6rem', color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '8px 0 4px' }}>Forces</div>
                  {Row('Repulsion μ', NF('repulsionStiffness', { min: 0, step: 0.1 }), 'Volume-exclusion stiffness.')}
                  {Row('Adhesion μ', NF('adhesionStiffness', { min: 0, step: 0.1 }), 'Free-agent stickiness (0 = cohesion via bonds only).')}
                  {Row('Interaction Range', NF('interactionRange', { min: 1, step: 0.1 }), '× contact distance — the force cutoff.')}
                  {Row('Growth Rate', NF('growthRate', { min: 0, step: 0.01 }), 'Radius units/step toward the target radius.')}
                  <div style={{ fontSize: '0.6rem', color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '8px 0 4px' }}>Bonds</div>
                  <label style={{ display: 'flex', alignItems: 'flex-start', gap: 6, cursor: 'pointer', fontSize: '0.72rem', marginBottom: 6 }}>
                    <input type="checkbox" checked={!!cb?.autoBond} onChange={e => updateCenterBased({ autoBond: e.target.checked })} style={{ marginTop: 2 }} />
                    <span><strong>Auto-bond by distance</strong><br /><span style={{ color: '#888', fontSize: '0.66rem' }}>Bond agents within the form distance; break past the break distance (hysteresis). The simplest path to a glued cluster.</span></span>
                  </label>
                  {Row('Bond Stiffness λ', NF('bondStiffness', { min: 0, step: 0.1 }))}
                  {Row('Form Distance', NF('formDistance', { min: 1, step: 0.05 }), '× contact (auto-bond within).')}
                  {Row('Break Distance', NF('breakDistance', { min: 1, step: 0.05 }), '× contact (> form — hysteresis).')}
                </>)}
              </div>
            );
          })()}

          {/* End Conditions — optional, collapsible */}
          <div style={{ marginTop: 14, borderTop: '1px solid #333', paddingTop: 10 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={ecEnabled}
                onChange={e => updateEndConditions({ enabled: e.target.checked })}
              />
              <span style={{ fontSize: '0.78rem' }}>End Conditions</span>
            </label>
            <span style={{ color: '#888', fontSize: '0.62rem', marginTop: 2, display: 'block' }}>
              When enabled, the simulator auto-pauses once any of these conditions are met
              (max generations reached, or any indicator rule matches).
            </span>
            {ecEnabled && (
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Max Generations</label>
                  <NumberField
                    className={styles.numberInput}
                    min={0}
                    integer
                    placeholder="(no limit)"
                    value={ec?.maxGenerations}
                    onNumber={n => updateEndConditions({ maxGenerations: n })}
                    onClear={() => updateEndConditions({ maxGenerations: undefined })}
                  />
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Indicator Conditions</label>
                  {(model.indicators || []).length === 0 && (
                    <span style={{ color: '#888', fontSize: '0.68rem', fontStyle: 'italic' }}>
                      Define at least one indicator to add conditions.
                    </span>
                  )}
                  <div data-reorder-list>
                  {(ec?.indicatorConditions || []).map((cond, condIdx, condArr) => {
                    const ind = (model.indicators || []).find(i => i.id === cond.indicatorId);
                    const isFreq = ind?.kind === 'linked' && ind?.linkedAggregation === 'frequency';
                    const linkedAttr = isFreq
                      ? (model.attributes || []).find(a => a.id === ind.linkedAttributeId)
                      : undefined;
                    const freqKind = isFreq ? linkedAttr?.type : undefined; // 'bool'|'tag'|'integer'|'float'
                    const floatFreqDisabled = freqKind === 'float';
                    const isDragging = ecReorder.dragState?.id === cond.id;
                    const srcIdx = ecReorder.dragState ? condArr.findIndex(c => c.id === ecReorder.dragState!.id) : -1;
                    const showBefore = ecReorder.dragState?.overIdx === condIdx && srcIdx !== condIdx && srcIdx !== condIdx - 1;
                    const showAfter = ecReorder.dragState?.overIdx === condArr.length && condIdx === condArr.length - 1 && srcIdx !== condIdx;
                    return (
                      <div
                        key={cond.id}
                        data-reorder-row
                        className={`${isDragging ? styles.draggingRow : ''} ${showBefore ? styles.dropIndicatorBefore : ''} ${showAfter ? styles.dropIndicatorAfter : ''}`}
                        style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}
                      >
                        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                          <select
                            className={styles.selectInput}
                            style={{ flex: 1.4 }}
                            value={cond.indicatorId}
                            onChange={e => {
                              // Clear category on indicator change — the old key may be meaningless for the new indicator.
                              updateIndicatorCondition(cond.id, { indicatorId: e.target.value, category: undefined });
                            }}
                          >
                            {(model.indicators || [])
                              .filter(i => !isSpatialIndicator(i) || i.id === cond.indicatorId)
                              .map(i => (
                                <option key={i.id} value={i.id}>{i.name}</option>
                              ))}
                          </select>
                          {/* Category widget (linked-frequency only) */}
                          {isFreq && freqKind === 'bool' && (
                            <select
                              className={styles.selectInput}
                              style={{ flex: 1 }}
                              value={cond.category ?? 'true'}
                              onChange={e => updateIndicatorCondition(cond.id, { category: e.target.value })}
                              title="Category to monitor (count of cells with this value)"
                            >
                              <option value="true">true</option>
                              <option value="false">false</option>
                            </select>
                          )}
                          {isFreq && freqKind === 'tag' && (
                            <select
                              className={styles.selectInput}
                              style={{ flex: 1 }}
                              value={cond.category ?? (linkedAttr?.tagOptions?.[0] ?? '')}
                              onChange={e => updateIndicatorCondition(cond.id, { category: e.target.value })}
                              title="Tag to monitor (count of cells with this tag)"
                            >
                              {(linkedAttr?.tagOptions || []).map((tag, i) => (
                                <option key={i} value={tag}>{tag}</option>
                              ))}
                            </select>
                          )}
                          {isFreq && freqKind === 'integer' && (
                            <NumberField
                              className={styles.numberInput}
                              integer
                              style={{ flex: 1 }}
                              placeholder="value"
                              value={cond.category}
                              onNumber={n => updateIndicatorCondition(cond.id, { category: String(n) })}
                              onClear={() => updateIndicatorCondition(cond.id, { category: undefined })}
                              title="Integer value to monitor (count of cells with this value)"
                            />
                          )}
                          <select
                            className={styles.selectInput}
                            style={{ width: 52 }}
                            value={cond.op}
                            disabled={floatFreqDisabled}
                            onChange={e => updateIndicatorCondition(cond.id, { op: e.target.value as EndConditionOp })}
                          >
                            <option value="==">==</option>
                            <option value="!=">!=</option>
                            <option value=">">&gt;</option>
                            <option value="<">&lt;</option>
                            <option value=">=">&ge;</option>
                            <option value="<=">&le;</option>
                          </select>
                          {/* Value widget: scalar branches when NOT a frequency indicator;
                              count (number) when frequency (except float-binned, which is disabled) */}
                          {!isFreq && ind?.dataType === 'bool' ? (
                            <select
                              className={styles.selectInput}
                              style={{ flex: 1 }}
                              value={cond.value === '1' || cond.value === 'true' ? 'true' : 'false'}
                              onChange={e => updateIndicatorCondition(cond.id, { value: e.target.value })}
                            >
                              <option value="false">false</option>
                              <option value="true">true</option>
                            </select>
                          ) : !isFreq && ind?.dataType === 'tag' ? (
                            <select
                              className={styles.selectInput}
                              style={{ flex: 1 }}
                              value={cond.value}
                              onChange={e => updateIndicatorCondition(cond.id, { value: e.target.value })}
                            >
                              {(ind.tagOptions || []).map((tag, i) => (
                                <option key={i} value={String(i)}>{tag}</option>
                              ))}
                            </select>
                          ) : (
                            <NumberField
                              className={styles.numberInput}
                              integer={isFreq || ind?.dataType === 'integer'}
                              style={{ flex: 1 }}
                              value={cond.value}
                              disabled={floatFreqDisabled}
                              placeholder={isFreq ? 'count' : undefined}
                              onNumber={n => updateIndicatorCondition(cond.id, { value: String(n) })}
                            />
                          )}
                          <button
                            className={styles.dragHandle}
                            title="Drag to reorder"
                            onPointerDown={ecReorder.startDrag(cond.id)}
                            onClick={e => e.stopPropagation()}
                          >⋮⋮</button>
                          <button
                            className={styles.deleteButton}
                            style={{ padding: '2px 6px', fontSize: '0.7rem' }}
                            onClick={() => removeIndicatorCondition(cond.id)}
                            title="Remove condition"
                          >
                            &times;
                          </button>
                        </div>
                        {floatFreqDisabled && (
                          <span style={{ color: '#e0a050', fontSize: '0.62rem', fontStyle: 'italic', paddingLeft: 4 }}>
                            Decimal-binned frequency categories depend on runtime range. Change this indicator&apos;s aggregation to Total, or pick a different indicator.
                          </span>
                        )}
                      </div>
                    );
                  })}
                  </div>
                  <button
                    className={styles.addButton}
                    style={{ fontSize: '0.72rem', padding: '2px 8px', marginTop: 4 }}
                    disabled={(model.indicators || []).length === 0}
                    onClick={addIndicatorCondition}
                  >
                    + Add Indicator Condition
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <IndicatorsPanelSection mode="list" selectedId={selIndId} onSelect={selectInd} />

      {/* Variegated Cells — a specialised 2D-grid feature (directional per-cell
          interactions). The most setup-specific option, so it sits LAST, after the
          common Indicators / End Conditions. Only relevant with the CA grid on. */}
      {topo.gridCells && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Variegated Cells</div>
          <div className={styles.fieldGroup}>
            <label
              style={{ display: 'flex', alignItems: 'flex-start', gap: 6, cursor: is3d ? 'not-allowed' : 'pointer', fontSize: '0.72rem', opacity: is3d ? 0.55 : 1 }}
              title={is3d ? 'Variegated Cells is 2D-only (the orientation/face geometry is square-lattice).' : undefined}
            >
              <input
                type="checkbox"
                checked={!is3d && !!model.variegatedCells?.enabled}
                disabled={is3d}
                onChange={e => updateVariegatedCells({ enabled: e.target.checked })}
                style={{ marginTop: 2 }}
              />
              <span>
                <strong>Use Variegated Cells (Directional Interactions){is3d ? ' — 2D only' : ''}</strong>
                <br />
                <span style={{ color: '#888', fontSize: '0.66rem' }}>
                  Adds a per-cell orientation (0-3 = 90&deg; rotations) and face-pattern labels for directional rules (chemistry CA, micelle formation, chiral models). Configure face patterns in the dedicated <strong>Variegated Cells</strong> panel (V) on the left sidebar.{is3d ? ' Not available in 3D models.' : ''}
                </span>
              </span>
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
