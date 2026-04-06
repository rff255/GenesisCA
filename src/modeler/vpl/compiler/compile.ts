import type { GraphNode, GraphEdge } from '../../../model/types';
import { getNodeDef } from '../nodes/registry';
import { parseHandleId } from '../types';

// ---------------------------------------------------------------------------
// Graph adjacency helpers
// ---------------------------------------------------------------------------

function buildAdjacency(graphNodes: GraphNode[], graphEdges: GraphEdge[]) {
  const nodeMap = new Map<string, GraphNode>();
  for (const n of graphNodes) nodeMap.set(n.id, n);

  // Target value input → source output
  const inputToSource = new Map<string, { nodeId: string; portId: string }>();
  // Source flow output → target flow inputs
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
// Compile a single root's subgraph
// ---------------------------------------------------------------------------

function compileRoot(
  rootNode: GraphNode,
  rootFlowPort: string,
  nodeMap: Map<string, GraphNode>,
  inputToSource: Map<string, { nodeId: string; portId: string }>,
  flowOutputToTargets: Map<string, Array<{ nodeId: string; portId: string }>>,
): string[] {
  const MULTI_OUTPUT_TYPES = new Set(['inputColor', 'getColorConstant']);
  const compiled = new Set<string>();
  const valueLines: string[] = [];

  /** Get the variable name for a source node+port, handling multi-output nodes */
  function varName(sourceNodeId: string, sourcePortId: string): string {
    const sourceNode = nodeMap.get(sourceNodeId);
    if (sourceNode && MULTI_OUTPUT_TYPES.has(sourceNode.data.nodeType)) {
      return `_v${sourceNodeId}_${sourcePortId}`;
    }
    return `_v${sourceNodeId}`;
  }

  /** Recursively compile a value node and return its variable name */
  function compileValueNode(nodeId: string): string {
    if (compiled.has(nodeId)) return `_v${nodeId}`;
    compiled.add(nodeId);

    const node = nodeMap.get(nodeId);
    if (!node) return 'undefined';
    const def = getNodeDef(node.data.nodeType);
    if (!def) return 'undefined';

    // InputColor root: r/g/b are function parameters, declared in the function header
    if (node.data.nodeType === 'inputColor') {
      return `_v${nodeId}`;
    }

    const inputVars: Record<string, string> = {};
    for (const port of def.ports) {
      if (port.kind !== 'input' || port.category !== 'value') continue;
      const source = inputToSource.get(`${nodeId}:${port.id}`);
      if (source) {
        compileValueNode(source.nodeId); // ensure dependency is compiled
        inputVars[port.id] = varName(source.nodeId, source.portId);
      }
    }

    const code = def.compile(nodeId, node.data.config, inputVars);
    if (code) valueLines.push('  ' + code.trimEnd());

    return `_v${nodeId}`;
  }

  /** Walk flow graph collecting all value dependencies */
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

  // --- Pass 2: Flow graph ---
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
        // Regular output node (setAttribute, setColorViewer, etc.)
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

  compileFlowChain(rootNode.id, rootFlowPort, '  ');

  return [...valueLines, '', ...flowLines];
}


// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CompileResult {
  stepCode: string;
  inputColorCodes: Array<{ mappingId: string; code: string }>;
  error?: string;
}

/**
 * Compile a node graph into JavaScript function strings.
 * Returns separate functions for Step and each InputColor root.
 */
export function compileGraph(
  graphNodes: GraphNode[],
  graphEdges: GraphEdge[],
): CompileResult {
  if (graphNodes.length === 0) {
    return { stepCode: '', inputColorCodes: [], error: 'No nodes in graph.' };
  }

  const { nodeMap, inputToSource, flowOutputToTargets } = buildAdjacency(graphNodes, graphEdges);
  // --- Compile Step function ---
  const stepNode = graphNodes.find(n => n.data.nodeType === 'step');
  let stepCode = '';
  if (stepNode) {
    const lines = compileRoot(stepNode, 'do', nodeMap, inputToSource, flowOutputToTargets);
    stepCode = [
      '(function(cell, neighbors, modelAttrs, _out) {',
      '  const result = _out.state; for (const _k in cell) result[_k] = cell[_k];',
      '  const viewers = _out.viewers;',
      '',
      ...lines,
      '',
      '  return { state: result, viewers };',
      '})',
    ].join('\n');
  }

  // --- Compile InputColor functions ---
  const inputColorNodes = graphNodes.filter(n => n.data.nodeType === 'inputColor');
  const inputColorCodes: Array<{ mappingId: string; code: string }> = [];

  for (const icNode of inputColorNodes) {
    const mappingId = icNode.data.config.mappingId as string || '';
    const lines = compileRoot(icNode, 'do', nodeMap, inputToSource, flowOutputToTargets);
    const code = [
      '(function(_r, _g, _b, cell, modelAttrs, _out) {',
      '  const result = _out.state; for (const _k in cell) result[_k] = cell[_k];',
      '  const viewers = _out.viewers;',
      `  const _v${icNode.id}_r = _r; const _v${icNode.id}_g = _g; const _v${icNode.id}_b = _b;`,
      '',
      ...lines,
      '',
      '  return { state: result, viewers };',
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
): {
  stepFn: Function | null;
  inputColorFns: Array<{ mappingId: string; fn: Function }>;
  stepCode: string;
  inputColorCodes: Array<{ mappingId: string; code: string }>;
  error?: string;
} {
  const result = compileGraph(graphNodes, graphEdges);

  let stepFn: Function | null = null;
  if (result.stepCode) {
    try {
      // eslint-disable-next-line no-eval
      stepFn = eval(result.stepCode) as Function;
    } catch (e) {
      return {
        stepFn: null,
        inputColorFns: [],
        stepCode: result.stepCode,
        inputColorCodes: result.inputColorCodes,
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
        stepFn: null,
        inputColorFns: [],
        stepCode: result.stepCode,
        inputColorCodes: result.inputColorCodes,
        error: `InputColor compilation error: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  return {
    stepFn,
    inputColorFns,
    stepCode: result.stepCode,
    inputColorCodes: result.inputColorCodes,
    error: result.error,
  };
}
