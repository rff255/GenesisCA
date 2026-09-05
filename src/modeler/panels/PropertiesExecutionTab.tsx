import { useMemo, useState, type ReactNode } from 'react';
import { useModel } from '../../model/ModelContext';
import type {
  UpdateMode, AsyncScheme, SkipIsolatedEmptyConfig, EngineChoice, EngineId, ReproducibilityContract,
} from '../../model/types';
import { REPRODUCIBILITY_LABEL, REPRODUCIBILITY_SUMMARY, REPRODUCIBILITY_GUARDRAIL } from '../../model/reproducibility';
import { resolveEngines, engineFlags, type LayerResolution } from '../../model/engineResolution';
import { isAgentGraphWasmSupported } from '../vpl/compiler/agentWasm/compile';
import { isAgentGraphWebGPUSupported } from '../vpl/compiler/agentWebgpu/compile';
import { NumberField } from '../vpl/widgets/InlineWidgets';
import {
  Section, ToggleCard, Segmented, Field, FieldRow, Hint, SubLabel, CheckRow, Advanced, Badge, Callout,
  type SegmentOption,
} from './propertiesWidgets';
import styles from './PanelContent.module.css';

const ENGINE_LABEL_SHORT: Record<EngineId, string> = { js: 'JS', wasm: 'WebAssembly', webgpu: 'WebGPU' };

// --- C4 (P1) — the ENGINE segment ------------------------------------------
// One control per layer: an INTENT (`Auto`) or an engine. Auto shows what it
// resolved to and why, so the pick is never silent. JS is demoted behind an
// "Advanced" reveal — it is the readable semantic reference (and the fallback
// engine), not a production choice. The reveal is forced open while JS is the
// current selection, so the selected option is never hidden.
function EngineSegment({ label, res, onSelect, hints, webgpuDisabledReason, advanced }: {
  label: string;
  res: LayerResolution;
  onSelect: (choice: EngineChoice) => void;
  /** Per-engine descriptions (live, so they can reflect this model's gates). */
  hints: Record<EngineChoice, string>;
  webgpuDisabledReason?: string;
  /** Extra rows inside the Advanced reveal (the grid's WebGPU stop-check interval). */
  advanced?: ReactNode;
}) {
  const [advOpenState, setAdvOpen] = useState(false);
  const advOpen = advOpenState || res.selected === 'js';
  const demoted = res.resolved !== res.requested;
  const badge = res.auto
    ? { text: `Auto → ${ENGINE_LABEL_SHORT[res.resolved]}`, amber: false }
    : demoted
      ? { text: `${ENGINE_LABEL_SHORT[res.requested]} → running ${ENGINE_LABEL_SHORT[res.resolved]}`, amber: true }
      : null;
  const options: SegmentOption<EngineChoice>[] = [
    { value: 'auto', label: 'Auto', title: `Recommended. ${hints.auto}` },
    { value: 'wasm', label: 'WASM', title: hints.wasm },
    { value: 'webgpu', label: 'WebGPU', title: hints.webgpu, disabled: !!webgpuDisabledReason, disabledReason: webgpuDisabledReason },
  ];
  if (advOpen) options.push({ value: 'js', label: 'Debug JS', title: hints.js });
  return (
    <div>
      <SubLabel right={badge && <Badge kind={badge.amber ? 'warn' : 'ok'} title={res.reason || undefined}>{badge.text}</Badge>}>{label}</SubLabel>
      <Segmented ariaLabel={label} value={res.selected} options={options} onChange={onSelect} />
      {res.reason && <Callout kind={demoted ? 'warn' : 'info'}>{res.reason}</Callout>}
      <Advanced open={advOpen} onToggle={() => setAdvOpen(o => !o)} title="Debugging engines and tuning knobs — not needed to run a model">
        {!advOpen ? null : (
          <>
            <Hint>
              <b>Debug JS</b> — the readable semantic reference the other engines are verified against, and the source Show Code displays. Breakpointable, but the slowest engine.
            </Hint>
            {advanced}
          </>
        )}
      </Advanced>
    </div>
  );
}

/**
 * Properties › Execution — "how does it run?". Reproducibility first (it
 * GOVERNS the engine picks: Auto = the fastest engine that satisfies it), then
 * the grid engine, the agent engine (same shape, only with Agents on), and the
 * performance options.
 */
export function PropertiesExecutionTab() {
  const { model, updateProperties, updateCenterBased } = useModel();
  const { properties } = model;
  const topo = model.topologyMode ?? { gridCells: true, agents: false };
  const is3d = (properties.dimension ?? '2d') === '3d';
  // Does the model carry an embedded BOARD? Exactly the four fields
  // applySimulationState's own `hasGrid` requires — a controls-only snapshot is
  // not a board, and "Reset restores saved board" would then be inert.
  const sSim = model.simulationState;
  const hasSavedBoard = !!sSim && sSim.width != null && sSim.height != null && sSim.attributes != null && sSim.colors != null;
  // C4 (P1) — the resolved engine per layer, from the ONE resolver. Everything
  // that used to key off the raw `useWebGPU` / `useWasm` mirror flags reads this
  // instead, so `engine: 'auto'` lights up the same UI an explicit pick does.
  const engines = useMemo(() => resolveEngines(model), [model]);
  const gridIsWebgpu = engines.grid.resolved === 'webgpu';
  const contract = engines.contract;
  const violation = engines.agents?.contractViolation ?? engines.grid.contractViolation ?? null;
  const isAsync = properties.updateMode === 'asynchronous';
  const asyncScheme = properties.asyncScheme || 'random-order';
  const cb = model.centerBased;

  // Live per-target support for the CURRENT agent graph — the hints name what
  // this graph can actually do on each engine (the gates clamp to JS otherwise).
  const agentWasmSupported = topo.agents && isAgentGraphWasmSupported(model);
  const agentWebgpuSupported = topo.agents && isAgentGraphWebGPUSupported(model);
  const agentGraphEmpty = !(model.agentGraphNodes ?? []).some(
    n => n.data.nodeType === 'behaviourStep' || n.data.nodeType === 'periodicStep');
  const noRuleYetHint = 'The Agents graph has no Behaviour Step (or Agent Periodic Step) yet, so there is no per-agent rule to compile. Add one and this re-evaluates.';

  // Skip Isolated Empty Cells — opt-in large-grid optimization (CA-grid only).
  const cellAttrs = model.attributes.filter(a => !a.isModelAttribute);
  const sie = properties.skipIsolatedEmpty;
  const emptyAttr = sie ? cellAttrs.find(a => a.id === sie.emptyAttributeId) : undefined;
  const defaultEmptyValue = (t?: string) => (t === 'bool' ? 'false' : '0');
  const patchSie = (changes: Partial<SkipIsolatedEmptyConfig>) => {
    const base: SkipIsolatedEmptyConfig = sie ?? { enabled: false, emptyAttributeId: '', emptyValue: '0', rangeKind: 'neighborhood' };
    updateProperties({ skipIsolatedEmpty: { ...base, ...changes } });
  };
  const rangeKind = sie?.rangeKind ?? 'neighborhood';

  return (
    <>
      <Section id="exec.repro" title="Reproducibility">
        <div className={styles.fieldGroup}>
          {/* C5 (P10) — the declared reproducibility contract. FIRST and OUTSIDE
              the grid-cells gate: it governs the engine picks (Auto = the fastest
              engine that satisfies it) and matters most for an agents-only model,
              where the GPU agent engine is the one thing Exact rules out. */}
          <Field label="Contract" title={REPRODUCIBILITY_GUARDRAIL}>
            <Segmented
              ariaLabel="Reproducibility contract"
              value={contract}
              onChange={c => updateProperties({ reproducibility: c as ReproducibilityContract })}
              options={(['exact', 'statistical'] as ReproducibilityContract[]).map(c => ({
                value: c, label: REPRODUCIBILITY_LABEL[c], title: REPRODUCIBILITY_SUMMARY[c],
              }))}
            />
            <Hint>{REPRODUCIBILITY_SUMMARY[contract]}</Hint>
          </Field>
          {violation && <Callout kind="warn">⚠ {violation}</Callout>}
          {/* What Reset does. Shown ONLY when the model actually carries an embedded
              BOARD: with none there is nothing to restore, so the control could do
              nothing and is hidden rather than greyed. Both actions stay on the
              simulator's ■ button's own menu, so nothing becomes unreachable. */}
          {hasSavedBoard && (
            <CheckRow
              checked={properties.resetRestoresBoard === true}
              onChange={v => updateProperties({ resetRestoresBoard: v })}
              label="Reset restores the saved board"
              title="This model carries a saved board. On: Reset reseeds from the rules and then applies that board on top — for a board that is DATA (imported map layers, a hand-painted start) no Init Event can regenerate. Off: Reset reseeds only. The simulator's ■ button offers both actions on hover / right-click either way."
            />
          )}
        </div>
      </Section>

      {topo.gridCells && (
        <Section id="exec.grid" title="Grid engine">
          <div className={styles.fieldGroup}>
            <Field
              label="Update mode"
              title="Synchronous (parallel): every cell reads the previous generation and writes the next simultaneously — classic CA, runs on all engines. Asynchronous (sequential): cells update one at a time in one buffer, each seeing earlier updates this generation — number-conserving models; CPU engines only."
            >
              <Segmented
                ariaLabel="Grid update mode"
                value={isAsync ? 'asynchronous' : 'synchronous'}
                onChange={v => updateProperties({ updateMode: v as UpdateMode })}
                options={[
                  { value: 'synchronous', label: 'Synchronous', title: 'Parallel — all cells read the previous generation and write the next at once. Runs on every engine.' },
                  {
                    value: 'asynchronous', label: 'Asynchronous', title: 'Sequential — one shared buffer, cells update in turn and see earlier writes this generation. CPU engines only.',
                    disabled: gridIsWebgpu,
                    disabledReason: 'This model runs on WebGPU, where cells update in parallel — asynchronous mode is a CPU-engine rule. Pick WASM or Auto below to use it.',
                  },
                ]}
              />
              <Hint>{isAsync ? 'Sequential — a cell sees earlier writes this generation. CPU engines only.' : 'Parallel — runs on every engine.'}</Hint>
            </Field>
            {isAsync && !gridIsWebgpu && (
              <Field
                label="Update scheme"
                title="Random Order: every cell once per generation in a fresh Fisher–Yates order. Random Independent: N picks with replacement (a cell may update 0 or 2+ times). Cyclic: one random order decided at initialization and reused — the fastest."
              >
                <select
                  className={styles.selectInput}
                  value={asyncScheme}
                  onChange={e => updateProperties({ asyncScheme: e.target.value as AsyncScheme })}
                >
                  <option value="random-order">Random Order</option>
                  <option value="random-independent">Random Independent</option>
                  <option value="cyclic">Cyclic</option>
                </select>
              </Field>
            )}
            {/* C4 (P1) — the ENGINE pick. `Auto` declares an INTENT and shows what
                it resolved to. The selection writes `properties.engine` AND its
                legacy mirror (useWasm/useWebGPU) in one dispatch, so an older build
                opening the file sees the same engine. Picking WebGPU explicitly also
                forces synchronous update mode, exactly as the old radio did. */}
            <EngineSegment
              label="Engine"
              res={engines.grid}
              onSelect={choice => {
                const flags = engineFlags(
                  choice === 'auto' ? resolveEngines({ ...model, properties: { ...properties, engine: 'auto' } }).grid.requested : choice,
                );
                updateProperties(choice === 'webgpu'
                  ? { engine: choice, ...flags, updateMode: 'synchronous' }
                  : { engine: choice, ...flags });
              }}
              hints={{
                auto: 'Picks the fastest engine this model can use, and re-picks as you edit. Never picks an engine the model cannot run on.',
                wasm: 'Hand-compiled WebAssembly — typically several times faster than JS on dense neighborhoods, and exact: f64 math on one shared seeded stream, bit-identical to the JS reference.',
                webgpu: 'WGSL compute shaders on the GPU — for very large grids and math-heavy per-cell work. Runs parallel rules only (synchronous update mode) and needs a browser with WebGPU. Statistical parity: f32 math + a per-cell RNG.'
                  + (is3d ? ' In 3D the GPU runs the simulation while the voxel renderer reads colours back each step.' : ''),
                js: 'The readable semantic reference — breakpointable in devtools and the source Show Code displays, but the slowest engine.',
              }}
              advanced={(
                /* B4B — WebGPU stop-check interval. Disabled in place unless the
                   RESOLVED grid engine is WebGPU (so it lights up under Auto → WebGPU). */
                <FieldRow
                  label="WebGPU stop-check interval"
                  muted={!gridIsWebgpu}
                  title={gridIsWebgpu
                    ? 'Check stop events every N generations. 1 = exact (default). Higher amortizes the per-step GPU stall, but a stop event may surface up to N−1 generations late. JS / WASM ignore this.'
                    : 'WebGPU only — this model is not running on WebGPU.'}
                >
                  <NumberField
                    className={`${styles.numberInput} ${styles.numSmall}`}
                    min={1} integer
                    disabled={!gridIsWebgpu}
                    value={properties.webgpuStopCheckInterval ?? 1}
                    onNumber={n => updateProperties({ webgpuStopCheckInterval: n })}
                  />
                </FieldRow>
              )}
            />
            <Hint>Switching engines restarts the simulator (grid state is lost). Diagnostics lists what each engine can run, and why.</Hint>
          </div>
        </Section>
      )}

      {topo.agents && engines.agents && (
        <Section id="exec.agents" title="Agent engine">
          <div className={styles.fieldGroup}>
            {/* Agent Update Mode — INDEPENDENT of the grid's. Changing it
                re-allocates the attribute buffers (double- vs single-buffered) →
                a full reinit (it's in needsFullInit). */}
            <Field
              label="Agent update mode"
              title="Independent of the grid's update mode. Positions are snapshot-integrated in both modes; this governs attribute read/write visibility between agents. Asynchronous (sequential): single-buffered — a Set Attribute aimed at a neighbour is visible to a later agent this step; a cross-agent write needs a CPU engine. Synchronous (parallel): double-buffered — every agent reads the previous step; writes land at the step's end. All three agent engines honour both."
            >
              <Segmented
                ariaLabel="Agent update mode"
                value={cb?.agentUpdateMode ?? 'async'}
                onChange={v => updateCenterBased({ agentUpdateMode: v as 'async' | 'sync' })}
                options={[
                  { value: 'async', label: 'Asynchronous', title: 'Sequential — single-buffered attributes; a neighbour write is visible to later agents this step. A cross-agent write needs a CPU engine.' },
                  { value: 'sync', label: 'Synchronous', title: 'Parallel — double-buffered attributes; every agent reads the previous step. Runs on all engines.' },
                ]}
              />
              <Hint>{(cb?.agentUpdateMode ?? 'async') === 'sync' ? 'Parallel — every agent reads the previous step.' : 'Sequential — a neighbour write is visible to later agents this step.'}</Hint>
            </Field>
            <EngineSegment
              label="Agent engine"
              res={engines.agents}
              onSelect={choice => updateCenterBased({ agentTarget: choice })}
              hints={{
                auto: 'Picks the fastest agent engine this graph can use, and re-picks as you edit the agent rule.',
                wasm: agentWasmSupported
                  ? 'This agent graph runs on WebAssembly with JS bit-parity (the whole node catalogue is supported). Typically 2–5× faster than JS for heavy per-agent rules.'
                  : agentGraphEmpty ? noRuleYetHint
                  : 'Selectable, but this graph has too many simultaneous Get-Nearby-Agents producers for the WASM scratch budget, so it falls back to JS.',
                webgpu: agentWebgpuSupported
                  ? 'This agent graph runs on WebGPU — behaviour + force passes dispatch on the GPU. Custom-force, async, bond-free models (the Particle Life / Boids class) run whole frames RESIDENT on the GPU; others pay a CPU↔GPU round-trip per generation, sized by the live population. Below a few thousand agents JS/WASM is usually faster. Statistical parity: f32 + a per-agent RNG.'
                    + ((model.bondAttributes?.length ?? 0) > 0
                      ? ' Bond attributes run on the GPU too; when BOTH endpoints write the same attribute in the SAME step, which write lands is order-undefined there — write from one side, or make the rule symmetric.'
                      : '')
                  : agentGraphEmpty ? noRuleYetHint
                  : 'Selectable, but this graph uses a WebGPU-fundamental reject (median / uniform-random aggregate, toggle/next/previous indicator ops, a cross-agent overwrite aimed at a wired agent id, or too many array producers), so it falls back to JS.',
                js: 'The reference agent engine — full node coverage, and the source Show Code displays. The agent loop is O(N) via the spatial hash, so JS is workable at small populations.',
              }}
            />
            <Hint>Independent of the grid’s engine — e.g. WebGPU grid diffusion + WASM agents.</Hint>
          </div>
        </Section>
      )}

      {topo.gridCells && (
        <Section id="exec.perf" title="Performance">
          <ToggleCard
            title="Skip Isolated Empty Cells"
            on={!!sie?.enabled}
            onChange={on => patchSie({ enabled: on })}
            line="Large-grid speedup: only cells within a range of a non-empty cell run the Generation Step + Output Mapping. Synchronous CA-grid models only; painting stays ungated."
            unlocks={<>surface-only stepping for compact structures growing through a large empty volume (accretion, crystal growth). No effect on WebGPU, agent-topology or glyph models.</>}
          >
            <Field label="Empty attribute" title="The cell attribute whose value says 'this cell is empty'.">
              <select className={styles.selectInput} value={sie?.emptyAttributeId ?? ''}
                onChange={e => { const a = cellAttrs.find(x => x.id === e.target.value); patchSie({ emptyAttributeId: e.target.value, emptyValue: defaultEmptyValue(a?.type) }); }}>
                <option value="">— select —</option>
                {cellAttrs.filter(a => a.type === 'tag' || a.type === 'bool' || a.type === 'integer' || a.type === 'float').map(a =>
                  <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>
            {emptyAttr && sie && (
              <Field label="Empty value" title="A cell holding this value is empty.">
                {emptyAttr.type === 'tag' ? (
                  <select className={styles.selectInput} value={sie.emptyValue} onChange={e => patchSie({ emptyValue: e.target.value })}>
                    {(emptyAttr.tagOptions ?? []).map((o, i) => <option key={i} value={String(i)}>{o}</option>)}
                  </select>
                ) : emptyAttr.type === 'bool' ? (
                  <select className={styles.selectInput} value={sie.emptyValue} onChange={e => patchSie({ emptyValue: e.target.value })}>
                    <option value="false">False</option>
                    <option value="true">True</option>
                  </select>
                ) : (
                  <NumberField className={styles.numberInput} integer={emptyAttr.type === 'integer'}
                    value={Number(sie.emptyValue) || 0} onNumber={n => patchSie({ emptyValue: String(n) })} />
                )}
              </Field>
            )}
            <Field label="Processing range" title="An empty cell is ACTIVE (still processed) when a non-empty cell lies within this range. It must cover every neighbourhood the rule reads.">
              <Segmented
                ariaLabel="Processing range kind"
                value={rangeKind}
                onChange={v => patchSie({ rangeKind: v as 'neighborhood' | 'radius' })}
                options={[
                  { value: 'neighborhood', label: 'Neighbourhood', title: 'Use one of the model’s neighbourhoods as the range (symmetrized).' },
                  { value: 'radius', label: 'Distance', title: 'A radius + metric.' },
                ]}
              />
            </Field>
            {rangeKind === 'neighborhood' ? (
              <Field label="Range neighbourhood" title="The neighbourhood whose extent defines the active range.">
                <select className={styles.selectInput} value={sie?.neighborhoodId ?? ''} onChange={e => patchSie({ neighborhoodId: e.target.value })}>
                  <option value="">— select —</option>
                  {model.neighborhoods.map(n => <option key={n.id} value={n.id}>{n.name}</option>)}
                </select>
              </Field>
            ) : (
              <div className={styles.fieldRow}>
                {/* max 15 keeps the worst-case (3D chebyshev, 31³) offset set under the
                    engine's 30000-offset cap (nearCount is Uint16). */}
                <Field label="Radius" title="Cells. Sensible ranges are tiny (1–3).">
                  <NumberField className={styles.numberInput} min={1} max={15} integer value={sie?.radius ?? 1} onNumber={n => patchSie({ radius: n })} />
                </Field>
                <Field label="Metric" title="Box (Chebyshev) / Diamond (Manhattan) / Sphere (Euclidean).">
                  <select className={styles.selectInput} value={sie?.radiusMetric ?? 'chebyshev'}
                    onChange={e => patchSie({ radiusMetric: e.target.value as SkipIsolatedEmptyConfig['radiusMetric'] })}>
                    <option value="chebyshev">Box (Chebyshev)</option>
                    <option value="manhattan">Diamond (Manhattan)</option>
                    <option value="euclidean">Sphere (Euclidean)</option>
                  </select>
                </Field>
              </div>
            )}
            <Hint>Isolated empty cells keep their state and colour and are not processed. Make sure the range covers your rule’s neighbourhood reads.</Hint>
          </ToggleCard>
        </Section>
      )}
    </>
  );
}
