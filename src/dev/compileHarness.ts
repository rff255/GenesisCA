// DEV-ONLY cross-target compile harness.
//
// Not imported by any production code path — it exists so a `preview_eval`
// can compile a model on all three targets (JS / WASM / WebGPU) through the
// SAME call signatures the simulator uses, and compare emitted output for the
// byte-identity regression checks the 3D Grid CA milestone relies on.
//
// Usage from preview_eval (cache-bust the import — Vite's dev module cache is
// sticky for compiler files):
//   const t = '?t=' + Date.now();
//   const { compileAll } = await import('/src/dev/compileHarness.ts' + t);
//   const r = compileAll(model);   // { js, wasm, webgpu }
//
// `wasm.bytesJoined` is `Array.from(bytes).join(',')` so two compiles can be
// string-compared for byte equality.

import type { CAModel } from '../model/types';
import { migrateAgentAttributeSplit } from '../model/agentAttributeSplitMigration';
import { migrateVariableScopeSplit } from '../model/variableScopeMigration';
import { migrateAgentTypeRemoval } from '../model/agentTypeRemovalMigration';
import { migrateFormBondBetween } from '../model/formBondBetweenMigration';
import { migrateSetAgentAttribute } from '../model/setAgentAttributeMigration';
import { migrateSetAgentsAttribute } from '../model/setAgentsAttributeMigration';
import { migrateGetRandomRange } from '../model/getRandomRangeMigration';
import { migrateAgentCapabilities } from '../model/agentCapabilities';
import { migrateEngineField } from '../model/engineFieldMigration';
import { migrateReproducibilityField } from '../model/reproducibilityMigration';
import { compileGraph, compileAgentGraph } from '../modeler/vpl/compiler/compile';
import { compileGraphWasm } from '../modeler/vpl/compiler/wasm/compile';
import { computeLayoutFromModel, buildViewerIds } from '../modeler/vpl/compiler/wasm/layout';
import { compileGraphWebGPU } from '../modeler/vpl/compiler/webgpu/compile';
import { compileAgentGraphWasmForModel, isAgentGraphWasmSupported } from '../modeler/vpl/compiler/agentWasm/compile';
import { compileAgentGraphWebGPUForModel, isAgentGraphWebGPUSupported } from '../modeler/vpl/compiler/agentWebgpu/compile';
import { compileOverseerGraph } from '../modeler/vpl/compiler/overseer/compile';

export interface CompileAllResult {
  /** `gridInitCode` + `gridPeriodicCode` are the CELL graph's GLOBAL, once-per-
   *  event functions. Like the agent division/init pair they are JS-on-CPU on
   *  EVERY compile target, so they appear on NO other surface here - hashing them
   *  separately is what keeps the byte-identity gate from having a blind spot over
   *  them (the D1 reasoning, applied to the cell side). They are kept OUT of
   *  `fullCode` deliberately: that hash predates them and must not move. */
  js: { stepCode: string; fullCode: string; gridInitCode: string; gridPeriodicCode: string; error: string | null };
  wasm: { total: number; bytesLen: number; bytesJoined: string; error: string | null };
  webgpu: { shaderCode: string; error: string | null };
  /** Bond-Graph Agents: the compiled agent behaviour loop (JS) + the PR6b-1 WASM
   *  agent-loop skeleton. Empty for a non-agent model. `wasm.supported` is the
   *  `isAgentGraphWasmSupported` gate; `wasm.bytesJoined` is the joined byte
   *  string for the JS↔WASM byte-shape + parity checks. */
  agent: {
    behaviourCode: string;
    /** The single-agent DIVISION EVENT function + the once-per-reset AGENT INIT
     *  function. Both are JS-on-CPU on EVERY agent target (`AGENT_WASM_CPU_ROOT_TYPES`),
     *  so they appear on no other surface — which is exactly why they must be
     *  hashed here: without them the project's primary byte-identity gate has a
     *  blind spot over the whole `division` / `init` ABI (Impact Map §5.5). */
    divisionCode: string;
    initCode: string;
    /** The GLOBAL Population Periodic Event functions (JS-on-CPU on every agent
     *  target, like division/init) - joined so the byte-identity gate covers them
     *  too. Empty for a model with no `agentPeriodic` root. */
    periodicCode: string;
    error: string | null;
    wasm: { supported: boolean; bytesLen: number; bytesJoined: string; supportedTypes: string[]; error: string | null };
    /** PR7/G1+G2 — the WebGPU agent behaviour SHADER (WGSL source). `supported`
     *  is the `isAgentGraphWebGPUSupported` gate; `shaderCode` is the emitted
     *  WGSL module (empty for a non-agent / unsupported model). */
    webgpu: { supported: boolean; shaderCode: string; supportedTypes: string[]; error: string | null;
      /** A1.5 — the per-mapping GPU Output-Mapping colour-pass WGSL modules +
       *  whether the whole OM graph compiled. Empty for a non-OM / unsupported model. */
      omShaders: Array<{ mappingId: string; code: string }>; omSupported: boolean };
  };
  /** Overseer — the async experiment DRIVER body (main-thread JS, not a compile
   *  target; see compiler/overseer/compile.ts). `driverCode` is null when the
   *  feature is off or the graph has no Experiment root. */
  overseer: { driverCode: string | null; error: string | null };
}

export function compileAll(model: CAModel): CompileAllResult {
  const out: CompileAllResult = {
    js: { stepCode: '', fullCode: '', gridInitCode: '', gridPeriodicCode: '', error: null },
    wasm: { total: 0, bytesLen: 0, bytesJoined: '', error: null },
    webgpu: { shaderCode: '', error: null },
    agent: {
      behaviourCode: '', divisionCode: '', initCode: '', periodicCode: '', error: null,
      wasm: { supported: false, bytesLen: 0, bytesJoined: '', supportedTypes: [], error: null },
      webgpu: { supported: false, shaderCode: '', supportedTypes: [], error: null, omShaders: [], omSupported: true },
    },
    overseer: { driverCode: null, error: null },
  };
  // JS — capture step + initCode + all inputColor + all outputMapping code so
  // OM/IC/init emits (e.g. setCellLooks colour writes) are searchable.
  try {
    const js = compileGraph(model.graphNodes, model.graphEdges, model) as {
      stepCode?: string; initCode?: string; gridInitCode?: string; error?: string;
      gridPeriodicCodes?: Array<{ period: number; phase: number; code: string }>;
      inputColorCodes?: Array<{ code: string }>; outputMappingCodes?: Array<{ code: string }>;
    };
    out.js.stepCode = js.stepCode || '';
    const parts = [js.stepCode || '', js.initCode || ''];
    out.js.gridInitCode = js.gridInitCode || '';
    out.js.gridPeriodicCode = (js.gridPeriodicCodes || []).map(gp => '// period=' + gp.period + ' phase=' + gp.phase + '\n' + gp.code).join('\n');
    for (const ic of js.inputColorCodes || []) parts.push(ic.code);
    for (const om of js.outputMappingCodes || []) parts.push(om.code);
    out.js.fullCode = parts.join('\n');
    out.js.error = js.error || null;
  } catch (e) {
    out.js.error = String((e as Error)?.message || e);
  }
  // WASM
  try {
    const layout = computeLayoutFromModel(model);
    const viewerIds = buildViewerIds(model);
    out.wasm.total = layout.total;
    const wa = compileGraphWasm(model.graphNodes, model.graphEdges, model, layout, viewerIds);
    const bytes = wa.bytes || new Uint8Array();
    out.wasm.bytesLen = bytes.length;
    out.wasm.bytesJoined = Array.from(bytes).join(',');
    out.wasm.error = (wa as { error?: string }).error || null;
  } catch (e) {
    out.wasm.error = String((e as Error)?.message || e);
  }
  // WebGPU
  try {
    const wg = compileGraphWebGPU(model.graphNodes, model.graphEdges, model);
    out.webgpu.shaderCode = wg.shaderCode || '';
    out.webgpu.error = (wg as { error?: string }).error || null;
  } catch (e) {
    out.webgpu.error = String((e as Error)?.message || e);
  }
  // Bond-Graph Agents — compile the agent rule graph (JS).
  try {
    const ag = compileAgentGraph(model.agentGraphNodes || [], model.agentGraphEdges || [], model);
    out.agent.behaviourCode = ag.behaviourCode || '';
    out.agent.divisionCode = ag.divisionCode || '';
    out.agent.initCode = ag.initCode || '';
    out.agent.periodicCode = (ag.periodicCodes || []).map(c => '// period=' + c.period + ' phase=' + c.phase + '\n' + c.code).join('\n');
    out.agent.error = ag.error || null;
  } catch (e) {
    out.agent.error = String((e as Error)?.message || e);
  }
  // Bond-Graph Agents — the PR6b-1 WASM agent-loop skeleton.
  try {
    out.agent.wasm.supported = isAgentGraphWasmSupported(model);
    if (model.topologyMode?.agents && model.centerBased) {
      const r = compileAgentGraphWasmForModel(model);
      out.agent.wasm.bytesLen = r.bytes.length;
      out.agent.wasm.bytesJoined = Array.from(r.bytes).join(',');
      out.agent.wasm.supportedTypes = r.supportedTypes;
      out.agent.wasm.error = r.error || null;
    }
  } catch (e) {
    out.agent.wasm.error = String((e as Error)?.message || e);
  }
  // Bond-Graph Agents — the PR7/G1+G2 WebGPU agent-loop behaviour shader.
  try {
    out.agent.webgpu.supported = isAgentGraphWebGPUSupported(model);
    if (model.topologyMode?.agents && model.centerBased) {
      const r = compileAgentGraphWebGPUForModel(model);
      out.agent.webgpu.shaderCode = r.shaderCode;
      out.agent.webgpu.supportedTypes = r.supportedTypes;
      out.agent.webgpu.error = r.error || null;
      out.agent.webgpu.omShaders = (r.omShaders ?? []).map(o => ({ mappingId: o.mappingId, code: o.code }));
      out.agent.webgpu.omSupported = r.omSupported ?? true;
    }
  } catch (e) {
    out.agent.webgpu.error = String((e as Error)?.message || e);
  }
  // Overseer — the async experiment driver (only when the feature is enabled).
  try {
    if (model.overseerConfig?.enabled) {
      const r = compileOverseerGraph(model.overseerGraphNodes || [], model.overseerGraphEdges || [], model);
      out.overseer.driverCode = r.driverCode;
      out.overseer.error = r.error;
    }
  } catch (e) {
    out.overseer.error = String((e as Error)?.message || e);
  }
  return out;
}

/** Apply the same additive LOAD_MODEL migration guards the reducer applies, so
 *  a raw library `.gcaproj` JSON compiles identically to one loaded through the
 *  app. Mutates + returns the model. */
export function migrateForHarness(m: CAModel): CAModel {
  m.graphNodes ||= [];
  m.graphEdges ||= [];
  m.overseerGraphNodes ||= [];
  m.overseerGraphEdges ||= [];
  m.macroDefs ||= [];
  m.indicators ||= [];
  m.variables ||= [];
  m.properties.tags ||= [];
  m.properties.updateMode ||= 'synchronous';
  m.properties.asyncScheme ||= 'random-order';
  if (m.properties.modelAuthor === undefined) m.properties.modelAuthor = '';
  if (!m.properties.dimension) m.properties.dimension = '2d';
  if (m.properties.gridDepth === undefined) m.properties.gridDepth = 1;
  if (!m.topologyMode) m.topologyMode = { gridCells: true, agents: false };
  for (const n of m.neighborhoods) { n.margin ??= 2; n.includeCentralCell ??= false; }
  // Generic Agent Platform — mirror LOAD_MODEL: split legacy agent-state cell
  // attributes into agentAttributes[] (+ agentAccess on field attrs) and move
  // agent-referenced cell variables into the agent variable set. No-op for
  // non-agent / already-split models.
  m = migrateAgentTypeRemoval(m);
  // Retire Form Bond Between -> a `formBond` with `agentA` wired (mirrors LOAD_MODEL).
  m = migrateFormBondBetween(m);
  // Retire Set Agent Attribute -> a `setAttribute` with `agentId` wired (mirrors LOAD_MODEL).
  m = migrateSetAgentAttribute(m);
  // Retire Set Agents Attribute -> a `setAttribute` with `agentId` wired to the
  // id ARRAY (mirrors LOAD_MODEL).
  m = migrateSetAgentsAttribute(m);
  // Get Random: legacy config.min/max -> the new min/max PORTS (mirrors LOAD_MODEL).
  m = migrateGetRandomRange(m);
  m = migrateAgentAttributeSplit(m);
  m = migrateVariableScopeSplit(m);
  // Agent Capability Profiles: seed an explicit profile via the usage-widened
  // inference (mirrors LOAD_MODEL) so the audit + parity harness see it.
  m = migrateAgentCapabilities(m);
  // C4 (P1): seed an explicit `properties.engine` from the legacy flags
  // (mirrors LOAD_MODEL). Byte-identical by construction — the mapping is the
  // explicit equivalent of what the file already does.
  m = migrateEngineField(m);
  // C5 (P10): seed the declared reproducibility contract (mirrors LOAD_MODEL).
  // Records what the file already does — it never changes a resolved engine.
  m = migrateReproducibilityField(m);
  return m;
}
