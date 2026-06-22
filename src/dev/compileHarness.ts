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
import { compileGraph, compileAgentGraph } from '../modeler/vpl/compiler/compile';
import { compileGraphWasm } from '../modeler/vpl/compiler/wasm/compile';
import { computeLayoutFromModel, buildViewerIds } from '../modeler/vpl/compiler/wasm/layout';
import { compileGraphWebGPU } from '../modeler/vpl/compiler/webgpu/compile';

export interface CompileAllResult {
  js: { stepCode: string; fullCode: string; error: string | null };
  wasm: { total: number; bytesLen: number; bytesJoined: string; error: string | null };
  webgpu: { shaderCode: string; error: string | null };
  /** Bond-Graph Agents: the compiled agent behaviour loop (JS-only). Empty for
   *  a non-agent model. Asserted on for the agent-loop shape checks (idx <
   *  highWater / !_alive / no _row / no colorIdx). */
  agent: { behaviourCode: string; error: string | null };
}

export function compileAll(model: CAModel): CompileAllResult {
  const out: CompileAllResult = {
    js: { stepCode: '', fullCode: '', error: null },
    wasm: { total: 0, bytesLen: 0, bytesJoined: '', error: null },
    webgpu: { shaderCode: '', error: null },
    agent: { behaviourCode: '', error: null },
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
  // Bond-Graph Agents — compile the agent rule graph (JS-only).
  try {
    const ag = compileAgentGraph(model.agentGraphNodes || [], model.agentGraphEdges || [], model);
    out.agent.behaviourCode = ag.behaviourCode || '';
    out.agent.error = ag.error || null;
  } catch (e) {
    out.agent.error = String((e as Error)?.message || e);
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
  return m;
}
