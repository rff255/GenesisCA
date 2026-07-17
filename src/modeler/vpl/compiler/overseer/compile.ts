/**
 * Overseer compiler — compiles the experiment orchestration graph into an
 * ASYNC JS driver function BODY (for `new AsyncFunction('O', body)`).
 *
 * The Overseer is NOT a compile target: it is the driver that CALLS the
 * simulation, executing on the main thread at experiment tempo (a few node
 * evaluations per run) and awaiting worker round-trips through the `O` runtime
 * API (see simulator/engine/overseerRuntime.ts). The CA itself keeps running
 * on whichever compile target the model selects (JS / WASM / WebGPU) — same
 * posture as the agent colour pass.
 *
 * Design notes (mirrors docs/PLAN_OVERSEER.md D-OV-2):
 * - Front-end pipeline is the standard one: expandMacros → collapseReroutes →
 *   expandMultiAttrs. The graph the emitters see is flat.
 * - VALUE nodes reuse their per-node JS `compile()` verbatim (getConstant,
 *   arithmetic, expression, Compare, getRandom, getModelAttribute, the ov*
 *   readers, …) so scalar semantics stay in lockstep with the Cells/Agents
 *   compilers. The driver preamble provides the symbols they reference
 *   (`modelAttrs`, `_rs`).
 * - Values are RE-EVALUATED at every flow statement that consumes them (each
 *   statement is wrapped in its own `{ … }` block): a Read Indicator consumed
 *   after a Run reads the POST-run value. The exceptions are ACTION RESULT
 *   ports (Run Until Stop's atGeneration/stoppedBy) and For-Each loop
 *   variables — those are captured once when the action/iteration runs and
 *   referenced afterwards (declared as function-scope `let`s / loop locals).
 * - `if (O.aborted) return;` is injected after every await and at loop
 *   back-edges so Abort lands within one batch.
 * - Defence-in-depth: every node reachable from the Experiment root must be an
 *   overseer node or in OVERSEER_UNIVERSAL_TYPES, else a compile error — the
 *   editor gating should make this unreachable, but hand-edited files exist.
 */

import type { GraphNode, GraphEdge, CAModel } from '../../../../model/types';
import { getNodeDef } from '../../nodes/registry';
import { OVERSEER_UNIVERSAL_TYPES } from '../../nodes/nodeValidation';
import { parseHandleId } from '../../types';
import { getInlineValue } from '../inlinePort';
import { expandMacros } from '../macroExpand';
import { collapseReroutes } from '../rerouteCollapse';
import { expandMultiAttrs } from '../multiAttrExpand';

export interface OverseerCompileResult {
  /** The async driver function BODY (param name `O`), or null when the graph
   *  has no Experiment root (nothing to run — not an error). */
  driverCode: string | null;
  error: string | null;
}

/** Action node types the flow walk emits itself (their def.compile is ''). */
const OV_ACTION_TYPES = new Set<string>([
  'ovResetBoard', 'ovRunGenerations', 'ovRunUntilStop', 'ovSetSeed',
  'ovSetModelAttribute', 'ovRandomizeTable', 'ovLoadPreset', 'ovCollectSample', 'ovCollectSpatial',
  'ovClearSeries', 'ovLog', 'ovStopExperiment', 'ovScreenshot',
  'ovStartRecording', 'ovStopRecording',
]);

export function compileOverseerGraph(
  overseerNodes: GraphNode[],
  overseerEdges: GraphEdge[],
  model: CAModel,
): OverseerCompileResult {
  // ---- front-end pipeline (shared transforms) -----------------------------
  const expanded = expandMacros(overseerNodes, overseerEdges, model);
  if (expanded.error) return { driverCode: null, error: `[overseer] ${expanded.error}` };
  const collapsed = collapseReroutes(expanded.nodes, expanded.edges);
  const flat = expandMultiAttrs(collapsed.nodes, collapsed.edges, model);
  const nodes = flat.nodes;
  const edges = flat.edges;

  const root = nodes.find(n => n.data.nodeType === 'experiment');
  if (!root) return { driverCode: null, error: null };

  // ---- adjacency (same shapes as the cell compiler) -----------------------
  const nodeMap = new Map<string, GraphNode>();
  for (const n of nodes) nodeMap.set(n.id, n);
  const inputToSource = new Map<string, { nodeId: string; portId: string }>();
  const inputToSources = new Map<string, Array<{ nodeId: string; portId: string }>>();
  const flowOutputToTargets = new Map<string, Array<{ nodeId: string; portId: string }>>();
  for (const edge of edges) {
    const sh = parseHandleId(edge.sourceHandle);
    const th = parseHandleId(edge.targetHandle);
    if (!sh || !th) continue;
    if (th.category === 'value') {
      const key = `${edge.target}:${th.portId}`;
      inputToSource.set(key, { nodeId: edge.source, portId: sh.portId });
      const arr = inputToSources.get(key) ?? [];
      arr.push({ nodeId: edge.source, portId: sh.portId });
      inputToSources.set(key, arr);
    }
    if (sh.category === 'flow' && th.category === 'flow') {
      const key = `${edge.source}:${sh.portId}`;
      const arr = flowOutputToTargets.get(key) ?? [];
      arr.push({ nodeId: edge.target, portId: th.portId });
      flowOutputToTargets.set(key, arr);
    }
  }

  // ---- reachability + allowlist validation --------------------------------
  const flowReached = new Set<string>();
  {
    const stack = [root.id];
    while (stack.length) {
      const id = stack.pop()!;
      if (flowReached.has(id)) continue;
      flowReached.add(id);
      for (const [key, targets] of flowOutputToTargets) {
        if (!key.startsWith(`${id}:`)) continue;
        for (const t of targets) stack.push(t.nodeId);
      }
    }
  }
  const reached = new Set<string>(flowReached);
  {
    const stack = [...flowReached];
    while (stack.length) {
      const id = stack.pop()!;
      for (const [key, sources] of inputToSources) {
        if (!key.startsWith(`${id}:`)) continue;
        for (const s of sources) {
          if (!reached.has(s.nodeId)) { reached.add(s.nodeId); stack.push(s.nodeId); }
        }
      }
    }
  }
  for (const id of reached) {
    const n = nodeMap.get(id);
    if (!n) continue;
    const t = n.data.nodeType;
    if (t === 'experiment') continue;
    const def = getNodeDef(t);
    if (!def) return { driverCode: null, error: `[overseer] Unknown node type "${t}".` };
    if (!def.requirements?.overseer && !OVERSEER_UNIVERSAL_TYPES.has(t)) {
      return { driverCode: null, error: `[overseer] "${def.label}" cannot run in the Overseer graph (per-cell/per-agent node).` };
    }
  }

  // ---- action-result declarations (function-scope lets) -------------------
  const decls: string[] = [];
  for (const n of nodes) {
    if (!reached.has(n.id)) continue;
    if (n.data.nodeType === 'ovRunUntilStop') {
      decls.push(`  let _v${n.id}_atGeneration = 0, _v${n.id}_stoppedBy = 0;`);
    }
  }

  // ---- value emission ------------------------------------------------------
  // In-scope For-Each loops (their element/index vars are only referenceable
  // inside their body during the walk).
  const loopScopes: string[] = [];
  let compileError: string | null = null;

  /** The variable/expression a (source node, port) resolves to. */
  function refFor(srcId: string, portId: string): { ref: string; kind: 'emit' | 'preset' } {
    const src = nodeMap.get(srcId);
    const t = src?.data.nodeType;
    if (t === 'ovRunUntilStop') return { ref: `_v${srcId}_${portId}`, kind: 'preset' };
    if (t === 'forEachInArray') {
      if (!loopScopes.includes(srcId)) {
        compileError = compileError ?? '[overseer] A For Each In Array Element/Index is used outside its loop body.';
      }
      return { ref: portId === 'index' ? `_fei${srcId}` : `_v${srcId}_element`, kind: 'preset' };
    }
    if (t === 'loop') {
      // The Loop node's per-iteration counter (`index` output) — the `_l<id>`
      // loop variable, in scope only inside the BODY chain.
      if (!loopScopes.includes(srcId)) {
        compileError = compileError ?? '[overseer] A Loop Index is used outside its loop body.';
      }
      return { ref: `_l${srcId}`, kind: 'preset' };
    }
    if (t === 'getModelAttribute' && src?.data.config.isColorAttr) {
      return { ref: `_v${srcId}_${portId}`, kind: 'emit' };
    }
    return { ref: `_v${srcId}`, kind: 'emit' };
  }

  /** Does a source (node, port) yield an array? (Static isArray port only —
   *  the overseer value set has no getVariable/valueSwitch array relays.) */
  function sourceYieldsArray(srcId: string, portId: string): boolean {
    const src = nodeMap.get(srcId);
    if (!src) return false;
    const def = getNodeDef(src.data.nodeType);
    return !!def?.ports.find(p => p.id === portId)?.isArray;
  }

  /** Emit a value node (and its deps) into `into`, deduped per-statement. */
  function emitValueNode(nodeId: string, into: string[], emitted: Set<string>, indent: string): void {
    if (emitted.has(nodeId)) return;
    emitted.add(nodeId);
    const node = nodeMap.get(nodeId);
    if (!node) return;
    const t = node.data.nodeType;
    // Preset sources never emit (their variable already exists in scope).
    if (t === 'ovRunUntilStop' || t === 'forEachInArray' || t === 'loop' || t === 'experiment') return;
    const def = getNodeDef(t);
    if (!def) return;

    const inputVars: Record<string, string> = {};
    const resolvePort = (portId: string, isArray: boolean | undefined): void => {
      const key = `${nodeId}:${portId}`;
      const sources = inputToSources.get(key);
      if (isArray && sources && sources.length > 1) {
        for (const s of sources) emitValueNode(s.nodeId, into, emitted, indent);
        inputVars[portId] = `[${sources.map(s => refFor(s.nodeId, s.portId).ref).join(', ')}]`;
        return;
      }
      const source = inputToSource.get(key);
      if (source) {
        emitValueNode(source.nodeId, into, emitted, indent);
        const r = refFor(source.nodeId, source.portId).ref;
        inputVars[portId] = isArray && !sourceYieldsArray(source.nodeId, source.portId) ? `[${r}]` : r;
      }
    };
    for (const port of def.ports) {
      if (port.kind !== 'input' || port.category !== 'value') continue;
      resolvePort(port.id, port.isArray);
      if (inputVars[port.id] === undefined) {
        const inlineVal = getInlineValue(port, node.data.config);
        if (inlineVal !== undefined) inputVars[port.id] = inlineVal;
      }
    }
    // Dynamic value-input ports (expression's sliced xN, switch case inputs on
    // a value node — defensive) live only in the edge map.
    for (const [key, source] of inputToSource) {
      if (!key.startsWith(`${nodeId}:`)) continue;
      const portId = key.slice(nodeId.length + 1);
      if (def.ports.some(p => p.kind === 'input' && p.category === 'value' && p.id === portId)) continue;
      emitValueNode(source.nodeId, into, emitted, indent);
      inputVars[portId] = refFor(source.nodeId, source.portId).ref;
    }
    const code = def.compile(nodeId, node.data.config, inputVars, model.properties.boundaryTreatment, undefined);
    if (code) {
      for (const line of code.trimEnd().split('\n')) into.push(indent + line);
    }
  }

  /** Resolve one value input of a FLOW node into an expression string,
   *  emitting dependencies into `into` (per-statement emitted set). */
  function resolveFlowInput(
    nodeId: string, portId: string, into: string[], emitted: Set<string>, indent: string,
    opts?: { isArray?: boolean; fallback?: string },
  ): string {
    const source = inputToSource.get(`${nodeId}:${portId}`);
    if (source) {
      emitValueNode(source.nodeId, into, emitted, indent);
      const r = refFor(source.nodeId, source.portId).ref;
      if (opts?.isArray && !sourceYieldsArray(source.nodeId, source.portId)) return `[${r}]`;
      return r;
    }
    const node = nodeMap.get(nodeId);
    const def = node ? getNodeDef(node.data.nodeType) : undefined;
    const port = def?.ports.find(p => p.id === portId);
    if (port && node) {
      const inlineVal = getInlineValue(port, node.data.config);
      if (inlineVal !== undefined) return inlineVal;
    }
    return opts?.fallback ?? '0';
  }

  // ---- flow walk ------------------------------------------------------------
  const flowLines: string[] = [];
  const cfgStr = (n: GraphNode, key: string, dflt = ''): string => String(n.data.config[key] ?? dflt);

  function emitFlowChain(sourceId: string, portId: string, indent: string, target: string[]): void {
    const targets = flowOutputToTargets.get(`${sourceId}:${portId}`);
    if (!targets || targets.length === 0) return;
    for (const tgt of targets) {
      emitFlowNode(tgt.nodeId, indent, target);
    }
  }

  function emitFlowNode(nodeId: string, indent: string, target: string[]): void {
    const node = nodeMap.get(nodeId);
    if (!node) return;
    const t = node.data.nodeType;
    const emitted = new Set<string>();
    const inner = indent + '  ';

    if (t === 'sequence') {
      // Transparent: FIRST, THEN, THEN_2… then the pass-through NEXT.
      emitFlowChain(nodeId, 'first', indent, target);
      emitFlowChain(nodeId, 'then', indent, target);
      const extra = Number(node.data.config.extraCount) || 0;
      for (let i = 2; i < extra + 2; i++) emitFlowChain(nodeId, `then_${i}`, indent, target);
      emitFlowChain(nodeId, 'next', indent, target);
      return;
    }

    if (t === 'conditional') {
      const stmt: string[] = [];
      stmt.push(indent + '{');
      const cond = resolveFlowInput(nodeId, 'condition', stmt, emitted, inner, { fallback: 'false' });
      stmt.push(`${inner}if (${cond}) {`);
      target.push(...stmt);
      emitFlowChain(nodeId, 'then', inner + '  ', target);
      target.push(`${inner}} else {`);
      emitFlowChain(nodeId, 'else', inner + '  ', target);
      target.push(`${inner}}`);
      target.push(indent + '}');
      emitFlowChain(nodeId, 'next', indent, target);
      return;
    }

    if (t === 'loop') {
      const stmt: string[] = [];
      stmt.push(indent + '{');
      const count = resolveFlowInput(nodeId, 'count', stmt, emitted, inner, { fallback: '1' });
      stmt.push(`${inner}const _lc${nodeId} = Math.max(0, Math.floor(${count}));`);
      stmt.push(`${inner}for (let _l${nodeId} = 0; _l${nodeId} < _lc${nodeId}; _l${nodeId}++) {`);
      stmt.push(`${inner}  if (O.aborted) return;`);
      target.push(...stmt);
      loopScopes.push(nodeId);
      emitFlowChain(nodeId, 'body', inner + '  ', target);
      loopScopes.pop();
      target.push(`${inner}}`);
      target.push(indent + '}');
      emitFlowChain(nodeId, 'next', indent, target);
      return;
    }

    if (t === 'forEachInArray') {
      const stmt: string[] = [];
      stmt.push(indent + '{');
      const arr = resolveFlowInput(nodeId, 'array', stmt, emitted, inner, { isArray: true, fallback: '[]' });
      stmt.push(`${inner}const _arr${nodeId} = ${arr};`);
      stmt.push(`${inner}for (let _fei${nodeId} = 0; _fei${nodeId} < _arr${nodeId}.length; _fei${nodeId}++) {`);
      stmt.push(`${inner}  if (O.aborted) return;`);
      stmt.push(`${inner}  const _v${nodeId}_element = _arr${nodeId}[_fei${nodeId}];`);
      target.push(...stmt);
      loopScopes.push(nodeId);
      emitFlowChain(nodeId, 'body', inner + '  ', target);
      loopScopes.pop();
      target.push(`${inner}}`);
      target.push(indent + '}');
      emitFlowChain(nodeId, 'next', indent, target);
      return;
    }

    if (t === 'switch') {
      const mode = cfgStr(node, 'mode', 'conditions');
      const firstMatchOnly = node.data.config.firstMatchOnly !== false;
      const valType = cfgStr(node, 'valueType', 'integer');
      const caseCount = Number(node.data.config.caseCount) || 0;
      const hasDefault = flowOutputToTargets.has(`${nodeId}:default`);
      if (caseCount === 0) {
        emitFlowChain(nodeId, 'default', indent, target);
        emitFlowChain(nodeId, 'next', indent, target);
        return;
      }
      const stmt: string[] = [];
      stmt.push(indent + '{');
      const caseConditions: string[] = [];
      for (let ci = 0; ci < caseCount; ci++) {
        if (mode === 'conditions') {
          const condSource = inputToSource.get(`${nodeId}:case_${ci}_cond`);
          if (condSource) {
            emitValueNode(condSource.nodeId, stmt, emitted, inner);
            caseConditions.push(refFor(condSource.nodeId, condSource.portId).ref);
          } else {
            caseConditions.push(cfgStr(node, `_port_case_${ci}_cond`) === 'true' ? '1' : '0');
          }
        } else {
          const valVar = resolveFlowInput(nodeId, 'value', stmt, emitted, inner, { fallback: '0' });
          if (valType === 'tag') {
            caseConditions.push(`(${valVar} === ${cfgStr(node, `case_${ci}_value`, '0') || '0'})`);
          } else {
            const op = cfgStr(node, `case_${ci}_op`, '==') || '==';
            const jsOp = op === '==' ? '===' : op === '!=' ? '!==' : op;
            const caseValSource = inputToSource.get(`${nodeId}:case_${ci}_val`);
            let caseValVar: string;
            if (caseValSource) {
              emitValueNode(caseValSource.nodeId, stmt, emitted, inner);
              caseValVar = refFor(caseValSource.nodeId, caseValSource.portId).ref;
            } else {
              caseValVar = cfgStr(node, `_port_case_${ci}_val`) || cfgStr(node, `case_${ci}_value`) || '0';
            }
            caseConditions.push(`(${valVar} ${jsOp} ${caseValVar})`);
          }
        }
      }
      target.push(...stmt);
      if (firstMatchOnly) {
        for (let ci = 0; ci < caseCount; ci++) {
          target.push(`${inner}${ci === 0 ? 'if' : '} else if'} (${caseConditions[ci]}) {`);
          emitFlowChain(nodeId, `case_${ci}`, inner + '  ', target);
        }
        if (hasDefault) {
          target.push(`${inner}} else {`);
          emitFlowChain(nodeId, 'default', inner + '  ', target);
        }
        target.push(`${inner}}`);
      } else {
        target.push(`${inner}let _sw${nodeId} = false;`);
        for (let ci = 0; ci < caseCount; ci++) {
          target.push(`${inner}if (${caseConditions[ci]}) { _sw${nodeId} = true;`);
          emitFlowChain(nodeId, `case_${ci}`, inner + '  ', target);
          target.push(`${inner}}`);
        }
        if (hasDefault) {
          target.push(`${inner}if (!_sw${nodeId}) {`);
          emitFlowChain(nodeId, 'default', inner + '  ', target);
          target.push(`${inner}}`);
        }
      }
      target.push(indent + '}');
      emitFlowChain(nodeId, 'next', indent, target);
      return;
    }

    if (OV_ACTION_TYPES.has(t)) {
      const stmt: string[] = [];
      stmt.push(indent + '{');
      switch (t) {
        case 'ovResetBoard':
          stmt.push(`${inner}await O.reset();`);
          break;
        case 'ovRunGenerations': {
          const count = resolveFlowInput(nodeId, 'count', stmt, emitted, inner, { fallback: '1' });
          stmt.push(`${inner}await O.run(${count});`);
          break;
        }
        case 'ovRunUntilStop': {
          const maxGens = resolveFlowInput(nodeId, 'maxGens', stmt, emitted, inner, { fallback: '100000' });
          stmt.push(`${inner}const _r = await O.runUntilStop(${maxGens});`);
          stmt.push(`${inner}_v${nodeId}_atGeneration = _r.atGeneration; _v${nodeId}_stoppedBy = _r.stoppedBy;`);
          break;
        }
        case 'ovSetSeed': {
          const seed = resolveFlowInput(nodeId, 'seed', stmt, emitted, inner, { fallback: '12345' });
          stmt.push(`${inner}await O.setSeed(${seed});`);
          stmt.push(`${inner}_rs = ((${seed}) >>> 0) || 0x12345678;`);
          break;
        }
        case 'ovSetModelAttribute': {
          const value = resolveFlowInput(nodeId, 'value', stmt, emitted, inner, { fallback: '0' });
          stmt.push(`${inner}await O.setAttr(${JSON.stringify(cfgStr(node, 'attributeId'))}, ${value});`);
          break;
        }
        case 'ovRandomizeTable': {
          const seed = resolveFlowInput(nodeId, 'seed', stmt, emitted, inner, { fallback: '1' });
          const density = resolveFlowInput(nodeId, 'density', stmt, emitted, inner, { fallback: '0.2' });
          stmt.push(`${inner}await O.randomizeTable(${JSON.stringify(cfgStr(node, 'tableId'))}, ${seed}, ${density});`);
          break;
        }
        case 'ovLoadPreset':
          stmt.push(`${inner}await O.loadPreset(${JSON.stringify(cfgStr(node, 'presetId'))});`);
          break;
        case 'ovCollectSample': {
          const value = resolveFlowInput(nodeId, 'value', stmt, emitted, inner, { fallback: '0' });
          stmt.push(`${inner}O.sample(${JSON.stringify(cfgStr(node, 'series', 'samples'))}, ${value}, ${JSON.stringify(cfgStr(node, 'scope', 'experiment'))});`);
          break;
        }
        case 'ovCollectSpatial': {
          const series = cfgStr(node, 'series', 'profile');
          stmt.push(`${inner}O.sampleSpatial(${JSON.stringify(series)}, ${JSON.stringify(cfgStr(node, 'indicatorId'))}, ${JSON.stringify(cfgStr(node, 'category'))}, ${JSON.stringify(cfgStr(node, 'chart') || series)});`);
          break;
        }
        case 'ovClearSeries':
          stmt.push(`${inner}O.clearSeries(${JSON.stringify(cfgStr(node, 'series', 'samples'))});`);
          break;
        case 'ovLog': {
          const hasValue = inputToSource.has(`${nodeId}:value`);
          const value = hasValue ? resolveFlowInput(nodeId, 'value', stmt, emitted, inner) : 'undefined';
          stmt.push(`${inner}O.logT(${JSON.stringify(cfgStr(node, 'text'))}, ${value});`);
          break;
        }
        case 'ovStopExperiment':
          stmt.push(`${inner}O.stopExperiment(${JSON.stringify(cfgStr(node, 'message', 'Experiment stopped'))});`);
          stmt.push(`${inner}return;`);
          break;
        case 'ovScreenshot':
          stmt.push(`${inner}await O.screenshot(${JSON.stringify(cfgStr(node, 'label', 'capture'))});`);
          break;
        case 'ovStartRecording':
          stmt.push(`${inner}await O.startRecording();`);
          break;
        case 'ovStopRecording':
          stmt.push(`${inner}await O.stopRecording();`);
          break;
      }
      stmt.push(`${inner}if (O.aborted) return;`);
      stmt.push(indent + '}');
      target.push(...stmt);
      emitFlowChain(nodeId, 'next', indent, target);
      return;
    }

    // Unknown flow node in the chain — the allowlist validation above should
    // have caught it; keep the walk resilient.
    compileError = compileError ?? `[overseer] Unsupported flow node "${t}" in the experiment chain.`;
  }

  emitFlowChain(root.id, 'do', '  ', flowLines);
  if (compileError) return { driverCode: null, error: compileError };

  const body = [
    "'use strict';",
    '  // Overseer driver — generated by compileOverseerGraph. Runs on the main',
    '  // thread; every await is a worker round-trip through the O runtime API.',
    '  const modelAttrs = O.modelAttrs;',
    '  let _rs = ((O.initialSeed | 0) >>> 0) || 0x12345678;',
    '  void modelAttrs; void _rs;',
    ...decls,
    ...flowLines,
  ].join('\n');
  return { driverCode: body, error: null };
}
