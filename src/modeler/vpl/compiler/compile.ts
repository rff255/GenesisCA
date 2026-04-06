import type { GraphNode, GraphEdge, CAModel } from '../../../model/types';
import { getNodeDef } from '../nodes/registry';
import { parseHandleId } from '../types';

// ---------------------------------------------------------------------------
// Graph adjacency helpers
// ---------------------------------------------------------------------------

function buildAdjacency(graphNodes: GraphNode[], graphEdges: GraphEdge[]) {
  const nodeMap = new Map<string, GraphNode>();
  for (const n of graphNodes) nodeMap.set(n.id, n);

  const inputToSource = new Map<string, { nodeId: string; portId: string }>();
  const flowOutputToTargets = new Map<string, Array<{ nodeId: string; portId: string }>>();

  for (const edge of graphEdges) {
    const sourceHandle = parseHandleId(edge.sourceHandle);
    const targetHandle = parseHandleId(edge.targetHandle);
    if (!sourceHandle || !targetHandle) continue;

    if (targetHandle.category === 'value') {
      inputToSource.set(
        `${edge.target}:${targetHandle.portId}`,
        { nodeId: edge.source, portId: sourceHandle.portId },
      );
    }

    if (sourceHandle.category === 'flow') {
      const key = `${edge.source}:${sourceHandle.portId}`;
      const existing = flowOutputToTargets.get(key) ?? [];
      existing.push({ nodeId: edge.target, portId: targetHandle.portId });
      flowOutputToTargets.set(key, existing);
    }
  }

  return { nodeMap, inputToSource, flowOutputToTargets };
}

// ---------------------------------------------------------------------------
// Compile a single root's subgraph (per-cell body)
// ---------------------------------------------------------------------------

const MULTI_OUTPUT_TYPES = new Set(['inputColor', 'getColorConstant']);

interface RootCompileResult {
  valueLines: string[];
  flowLines: string[];
  /** Node IDs that need scratch array declarations (GetNeighborsAttribute nodes) */
  scratchNodes: Array<{ nodeId: string; nbrId: string }>;
}

function compileRoot(
  rootNode: GraphNode,
  rootFlowPort: string,
  nodeMap: Map<string, GraphNode>,
  inputToSource: Map<string, { nodeId: string; portId: string }>,
  flowOutputToTargets: Map<string, Array<{ nodeId: string; portId: string }>>,
  _model?: CAModel,
): RootCompileResult {
  const compiled = new Set<string>();
  const valueLines: string[] = [];
  const scratchNodes: Array<{ nodeId: string; nbrId: string }> = [];

  function varName(sourceNodeId: string, sourcePortId: string): string {
    const sourceNode = nodeMap.get(sourceNodeId);
    if (sourceNode && MULTI_OUTPUT_TYPES.has(sourceNode.data.nodeType)) {
      return `_v${sourceNodeId}_${sourcePortId}`;
    }
    // GetNeighborsAttribute uses _scr_ prefix for its scratch array
    if (sourceNode?.data.nodeType === 'getNeighborsAttribute') {
      return `_scr_${sourceNodeId}`;
    }
    return `_v${sourceNodeId}`;
  }

  function compileValueNode(nodeId: string): string {
    if (compiled.has(nodeId)) return `_v${nodeId}`;
    compiled.add(nodeId);

    const node = nodeMap.get(nodeId);
    if (!node) return 'undefined';
    const def = getNodeDef(node.data.nodeType);
    if (!def) return 'undefined';

    if (node.data.nodeType === 'inputColor') {
      return `_v${nodeId}`;
    }

    // MacroNode — skip during compilation (macros are not yet compilable,
    // they need MacroInput/MacroOutput nodes inside before compilation can inline them)
    if (node.data.nodeType === 'macro') {
      return `_v${nodeId}`;
    }

    // Track GetNeighborsAttribute nodes for scratch declaration
    if (node.data.nodeType === 'getNeighborsAttribute') {
      const nbrId = node.data.config.neighborhoodId as string || '_undef';
      scratchNodes.push({ nodeId, nbrId });
    }

    const inputVars: Record<string, string> = {};
    for (const port of def.ports) {
      if (port.kind !== 'input' || port.category !== 'value') continue;
      const source = inputToSource.get(`${nodeId}:${port.id}`);
      if (source) {
        compileValueNode(source.nodeId);
        inputVars[port.id] = varName(source.nodeId, source.portId);
      }
    }

    const code = def.compile(nodeId, node.data.config, inputVars);
    if (code) valueLines.push('      ' + code.trimEnd());

    return `_v${nodeId}`;
  }

  function collectValueDeps(nodeId: string): void {
    const node = nodeMap.get(nodeId);
    if (!node) return;
    const def = getNodeDef(node.data.nodeType);
    if (!def) return;

    for (const port of def.ports) {
      if (port.kind !== 'input' || port.category !== 'value') continue;
      const source = inputToSource.get(`${nodeId}:${port.id}`);
      if (source) compileValueNode(source.nodeId);
    }

    for (const port of def.ports) {
      if (port.kind !== 'output' || port.category !== 'flow') continue;
      const targets = flowOutputToTargets.get(`${nodeId}:${port.id}`);
      if (targets) {
        for (const t of targets) collectValueDeps(t.nodeId);
      }
    }
  }

  collectValueDeps(rootNode.id);

  const flowLines: string[] = [];

  function compileFlowChain(sourceNodeId: string, sourcePortId: string, indent: string): void {
    const targets = flowOutputToTargets.get(`${sourceNodeId}:${sourcePortId}`);
    if (!targets || targets.length === 0) return;

    for (const target of targets) {
      const node = nodeMap.get(target.nodeId);
      if (!node) continue;
      const def = getNodeDef(node.data.nodeType);
      if (!def) continue;

      if (node.data.nodeType === 'conditional') {
        const condSource = inputToSource.get(`${node.id}:condition`);
        const condVar = condSource ? varName(condSource.nodeId, condSource.portId) : 'false';
        const hasElse = flowOutputToTargets.has(`${node.id}:else`);
        flowLines.push(`${indent}if (${condVar}) {`);
        compileFlowChain(node.id, 'then', indent + '  ');
        if (hasElse) {
          flowLines.push(`${indent}} else {`);
          compileFlowChain(node.id, 'else', indent + '  ');
        }
        flowLines.push(`${indent}}`);
      } else if (node.data.nodeType === 'sequence') {
        compileFlowChain(node.id, 'first', indent);
        compileFlowChain(node.id, 'then', indent);
      } else if (node.data.nodeType === 'loop') {
        const countSource = inputToSource.get(`${node.id}:count`);
        const countVar = countSource ? varName(countSource.nodeId, countSource.portId) : '0';
        flowLines.push(`${indent}for (let _li${node.id} = 0; _li${node.id} < ${countVar}; _li${node.id}++) {`);
        compileFlowChain(node.id, 'body', indent + '  ');
        flowLines.push(`${indent}}`);
      } else {
        const inputVars: Record<string, string> = {};
        for (const port of def.ports) {
          if (port.kind !== 'input' || port.category !== 'value') continue;
          const source = inputToSource.get(`${node.id}:${port.id}`);
          if (source) {
            inputVars[port.id] = varName(source.nodeId, source.portId);
          }
        }
        const code = def.compile(node.id, node.data.config, inputVars);
        if (code) flowLines.push(indent + code.trimEnd());
      }
    }
  }

  compileFlowChain(rootNode.id, rootFlowPort, '      ');

  return { valueLines, flowLines, scratchNodes };
}

// ---------------------------------------------------------------------------
// Build parameter lists from model (without idx — loop is inside)
// ---------------------------------------------------------------------------

function buildLoopParams(model: CAModel): {
  params: string;
  cellAttrs: Array<{ id: string; type: string }>;
  neighborhoods: Array<{ id: string }>;
} {
  const cellAttrs = model.attributes
    .filter(a => !a.isModelAttribute)
    .map(a => ({ id: a.id, type: a.type }));
  const neighborhoods = model.neighborhoods.map(n => ({ id: n.id }));

  // Parameters: total, read attrs, write attrs, full neighbor index arrays + sizes, modelAttrs, colors, activeViewer
  const parts: string[] = ['total'];
  for (const a of cellAttrs) parts.push(`r_${a.id}`);
  for (const a of cellAttrs) parts.push(`w_${a.id}`);
  for (const n of neighborhoods) { parts.push(`nIdx_${n.id}`); parts.push(`nSz_${n.id}`); }
  parts.push('modelAttrs', 'colors', 'activeViewer');

  return { params: parts.join(', '), cellAttrs, neighborhoods };
}

/** Per-cell params (for InputColor which is called per-cell) */
function buildCellParams(model: CAModel): string {
  const cellAttrs = model.attributes.filter(a => !a.isModelAttribute);
  const neighborhoods = model.neighborhoods;
  const parts: string[] = ['idx'];
  for (const a of cellAttrs) parts.push(`r_${a.id}`);
  for (const a of cellAttrs) parts.push(`w_${a.id}`);
  for (const n of neighborhoods) { parts.push(`nIdx_${n.id}`); parts.push(`nSz_${n.id}`); }
  parts.push('modelAttrs', 'colors', 'activeViewer');
  return parts.join(', ');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CompileResult {
  stepCode: string;
  inputColorCodes: Array<{ mappingId: string; code: string }>;
  error?: string;
}

export function compileGraph(
  graphNodes: GraphNode[],
  graphEdges: GraphEdge[],
  model?: CAModel,
): CompileResult {
  if (graphNodes.length === 0) {
    return { stepCode: '', inputColorCodes: [], error: 'No nodes in graph.' };
  }

  if (!model) {
    return { stepCode: '', inputColorCodes: [], error: 'Model required for SoA compilation.' };
  }

  const { nodeMap, inputToSource, flowOutputToTargets } = buildAdjacency(graphNodes, graphEdges);
  const { params: loopParams, cellAttrs } = buildLoopParams(model);
  const cellParams = buildCellParams(model);

  // Generate attribute copy lines (previous → next generation)
  const copyLines = cellAttrs.map(a => `      w_${a.id}[idx] = r_${a.id}[idx];`);

  // --- Compile Step function (loop-wrapped) ---
  const stepNode = graphNodes.find(n => n.data.nodeType === 'step');
  let stepCode = '';
  if (stepNode) {
    const { valueLines, flowLines, scratchNodes } = compileRoot(
      stepNode, 'do', nodeMap, inputToSource, flowOutputToTargets, model,
    );

    // Scratch array declarations (before the loop)
    const scratchDecls = scratchNodes.map(
      s => `  const _scr_${s.nodeId} = new Array(nSz_${s.nbrId});`,
    );

    stepCode = [
      `(function(${loopParams}) {`,
      ...scratchDecls,
      '  for (let idx = 0; idx < total; idx++) {',
      '    const colorIdx = idx * 4;',
      ...copyLines,
      ...valueLines,
      '',
      ...flowLines,
      '  }',
      '})',
    ].join('\n');
  }

  // --- Compile InputColor functions (per-cell, not loop-wrapped) ---
  const inputColorNodes = graphNodes.filter(n => n.data.nodeType === 'inputColor');
  const inputColorCodes: Array<{ mappingId: string; code: string }> = [];

  for (const icNode of inputColorNodes) {
    const mappingId = icNode.data.config.mappingId as string || '';
    const { valueLines, flowLines } = compileRoot(
      icNode, 'do', nodeMap, inputToSource, flowOutputToTargets, model,
    );
    // InputColor is called per-cell (for painted cells only), keep per-cell signature
    const icCopyLines = cellAttrs.map(a => `  w_${a.id}[idx] = r_${a.id}[idx];`);
    const code = [
      `(function(_r, _g, _b, ${cellParams}) {`,
      '  const colorIdx = idx * 4;',
      ...icCopyLines,
      `  const _v${icNode.id}_r = _r; const _v${icNode.id}_g = _g; const _v${icNode.id}_b = _b;`,
      '',
      ...valueLines,
      '',
      ...flowLines,
      '})',
    ].join('\n');
    inputColorCodes.push({ mappingId, code });
  }

  const error = !stepNode ? 'No Step node found. Add a Step node as the entry point.' : undefined;

  return { stepCode, inputColorCodes, error };
}

/**
 * Compile graph and create executable functions.
 */
export function compileAndBuild(
  graphNodes: GraphNode[],
  graphEdges: GraphEdge[],
  model?: CAModel,
): {
  stepFn: Function | null;
  inputColorFns: Array<{ mappingId: string; fn: Function }>;
  stepCode: string;
  inputColorCodes: Array<{ mappingId: string; code: string }>;
  error?: string;
} {
  const result = compileGraph(graphNodes, graphEdges, model);

  let stepFn: Function | null = null;
  if (result.stepCode) {
    try {
      // eslint-disable-next-line no-eval
      stepFn = eval(result.stepCode) as Function;
    } catch (e) {
      return {
        stepFn: null, inputColorFns: [],
        stepCode: result.stepCode, inputColorCodes: result.inputColorCodes,
        error: `Step compilation error: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  const inputColorFns: Array<{ mappingId: string; fn: Function }> = [];
  for (const ic of result.inputColorCodes) {
    try {
      // eslint-disable-next-line no-eval
      const fn = eval(ic.code) as Function;
      inputColorFns.push({ mappingId: ic.mappingId, fn });
    } catch (e) {
      return {
        stepFn: null, inputColorFns: [],
        stepCode: result.stepCode, inputColorCodes: result.inputColorCodes,
        error: `InputColor compilation error: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  return { stepFn, inputColorFns, stepCode: result.stepCode, inputColorCodes: result.inputColorCodes, error: result.error };
}
