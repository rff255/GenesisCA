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
import { migrateAgentCapabilities } from '../model/agentCapabilities';
import { compileGraph, compileAgentGraph } from '../modeler/vpl/compiler/compile';
import { compileGraphWasm } from '../modeler/vpl/compiler/wasm/compile';
import { computeLayoutFromModel, buildViewerIds } from '../modeler/vpl/compiler/wasm/layout';
import { compileGraphWebGPU } from '../modeler/vpl/compiler/webgpu/compile';
import { compileAgentGraphWasmForModel, isAgentGraphWasmSupported } from '../modeler/vpl/compiler/agentWasm/compile';
import { compileAgentGraphWebGPUForModel, isAgentGraphWebGPUSupported } from '../modeler/vpl/compiler/agentWebgpu/compile';

export interface CompileAllResult {
  js: { stepCode: string; fullCode: string; error: string | null };
  wasm: { total: number; bytesLen: number; bytesJoined: string; error: string | null };
  webgpu: { shaderCode: string; error: string | null };
  /** Bond-Graph Agents: the compiled agent behaviour loop (JS) + the PR6b-1 WASM
   *  agent-loop skeleton. Empty for a non-agent model. `wasm.supported` is the
   *  `isAgentGraphWasmSupported` gate; `wasm.bytesJoined` is the joined byte
   *  string for the JS↔WASM byte-shape + parity checks. */
  agent: {
    behaviourCode: string;
    error: string | null;
    wasm: { supported: boolean; bytesLen: number; bytesJoined: string; supportedTypes: string[]; error: string | null };
    /** PR7/G1+G2 — the WebGPU agent behaviour SHADER (WGSL source). `supported`
     *  is the `isAgentGraphWebGPUSupported` gate; `shaderCode` is the emitted
     *  WGSL module (empty for a non-agent / unsupported model). */
    webgpu: { supported: boolean; shaderCode: string; supportedTypes: string[]; error: string | null };
  };
}

export function compileAll(model: CAModel): CompileAllResult {
  const out: CompileAllResult = {
    js: { stepCode: '', fullCode: '', error: null },
    wasm: { total: 0, bytesLen: 0, bytesJoined: '', error: null },
    webgpu: { shaderCode: '', error: null },
    agent: {
      behaviourCode: '', error: null,
      wasm: { supported: false, bytesLen: 0, bytesJoined: '', supportedTypes: [], error: null },
      webgpu: { supported: false, shaderCode: '', supportedTypes: [], error: null },
    },
  };
  // JS — capture step + initCode + all inputColor + all outputMapping code so
  // OM/IC/init emits (e.g. setCellLooks colour writes) are searchable.
  try {
    const js = compileGraph(model.graphNodes, model.graphEdges, model) as {
      stepCode?: string; initCode?: string; error?: string;
      inputColorCodes?: Array<{ code: string }>; outputMappingCodes?: Array<{ code: string }>;
    };
    out.js.stepCode = js.stepCode || '';
    const parts = [js.stepCode || '', js.initCode || ''];
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
    }
  } catch (e) {
    out.agent.webgpu.error = String((e as Error)?.message || e);
  }
  return out;
}

/** Apply the same additive LOAD_MODEL migration guards the reducer applies, so
 *  a raw library `.gcaproj` JSON compiles identically to one loaded through the
 *  app. Mutates + returns the model. */
export function migrateForHarness(m: CAModel): CAModel {
  m.graphNodes ||= [];
  m.graphEdges ||= [];
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
  m = migrateAgentAttributeSplit(m);
  m = migrateVariableScopeSplit(m);
  // Agent Capability Profiles: seed an explicit profile via the usage-widened
  // inference (mirrors LOAD_MODEL) so the audit + parity harness see it.
  m = migrateAgentCapabilities(m);
  return m;
}
