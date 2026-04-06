import type { GraphNode, GraphEdge } from '../../../model/types';
import { getNodeDef } from '../nodes/registry';
import { parseHandleId } from '../types';

/**
 * Compile a node graph into a JavaScript function string.
 *
 * Strategy: two-pass compilation.
 *   Pass 1: Compile all VALUE nodes (data, logic, aggregation) at the top
 *           level so their variables are accessible everywhere.
 *   Pass 2: Walk the FLOW graph (Step → Conditional → SetAttribute, etc.)
 *           and emit only control flow and output statements.
 *
 * The generated function has signature:
 *   (cell, neighbors, modelAttrs) => { state, viewers }
 */
export function compileGraph(
  graphNodes: GraphNode[],
  graphEdges: GraphEdge[],
): { code: string; error?: string } {
  if (graphNodes.length === 0) {
    return { code: '', error: 'No nodes in graph.' };
  }

  // Build lookup maps
  const nodeMap = new Map<string, GraphNode>();
  for (const n of graphNodes) nodeMap.set(n.id, n);

  // Target input → source output mapping (for value connections)
  const inputToSource = new Map<string, { nodeId: string; portId: string }>();
  // Source flow output → target flow input mapping
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

  // ---------- Pass 1: Compile all value nodes ----------

  const valueLines: string[] = [];
  const compiled = new Set<string>();

  /** Recursively compile a value node and its upstream dependencies */
  function compileValueNode(nodeId: string): string {
    if (compiled.has(nodeId)) return `_v${nodeId}`;
    compiled.add(nodeId);

    const node = nodeMap.get(nodeId);
    if (!node) return 'undefined';

    const def = getNodeDef(node.data.nodeType);
    if (!def) return 'undefined';

    // Resolve inputs by recursively compiling upstream value nodes
    const inputVars: Record<string, string> = {};
    for (const port of def.ports) {
      if (port.kind !== 'input' || port.category !== 'value') continue;
      const source = inputToSource.get(`${nodeId}:${port.id}`);
      if (source) {
        inputVars[port.id] = compileValueNode(source.nodeId);
      }
    }

    const code = def.compile(nodeId, node.data.config, inputVars);
    if (code) valueLines.push('  ' + code.trimEnd());

    return `_v${nodeId}`;
  }

  // Walk the entire graph and compile every value node that any flow/output
  // node depends on. This hoists all declarations to function scope.
  function collectValueDeps(nodeId: string): void {
    const node = nodeMap.get(nodeId);
    if (!node) return;
    const def = getNodeDef(node.data.nodeType);
    if (!def) return;

    // Compile value inputs of this node
    for (const port of def.ports) {
      if (port.kind !== 'input' || port.category !== 'value') continue;
      const source = inputToSource.get(`${nodeId}:${port.id}`);
      if (source) compileValueNode(source.nodeId);
    }

    // Recurse into flow targets
    for (const port of def.ports) {
      if (port.kind !== 'output' || port.category !== 'flow') continue;
      const targets = flowOutputToTargets.get(`${nodeId}:${port.id}`);
      if (targets) {
        for (const t of targets) collectValueDeps(t.nodeId);
      }
    }
  }

  // Find the Step node (root)
  const stepNode = graphNodes.find(n => n.data.nodeType === 'step');
  if (!stepNode) {
    return { code: '', error: 'No Step node found. Add a Step node as the entry point.' };
  }

  // Collect and compile all value dependencies starting from Step
  collectValueDeps(stepNode.id);

  // ---------- Pass 2: Walk flow graph, emit control flow + outputs ----------

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
        // Get the condition variable (already compiled in pass 1)
        const condSource = inputToSource.get(`${node.id}:condition`);
        const condVar = condSource ? `_v${condSource.nodeId}` : 'false';

        const hasElse = flowOutputToTargets.has(`${node.id}:else`);
        flowLines.push(`${indent}if (${condVar}) {`);
        compileFlowChain(node.id, 'then', indent + '  ');
        if (hasElse) {
          flowLines.push(`${indent}} else {`);
          compileFlowChain(node.id, 'else', indent + '  ');
        }
        flowLines.push(`${indent}}`);
      } else {
        // Output node (setAttribute, setColorViewer, etc.)
        const inputVars: Record<string, string> = {};
        for (const port of def.ports) {
          if (port.kind !== 'input' || port.category !== 'value') continue;
          const source = inputToSource.get(`${node.id}:${port.id}`);
          if (source) {
            inputVars[port.id] = `_v${source.nodeId}`;
          }
        }
        const code = def.compile(node.id, node.data.config, inputVars);
        if (code) flowLines.push(indent + code.trimEnd());
      }
    }
  }

  compileFlowChain(stepNode.id, 'do', '  ');

  // ---------- Assemble ----------

  const body = [
    '(function(cell, neighbors, modelAttrs) {',
    '  const result = { ...cell };',
    '  const viewers = {};',
    '',
    '  // Value computations (hoisted)',
    ...valueLines,
    '',
    '  // Control flow and outputs',
    ...flowLines,
    '',
    '  return { state: result, viewers };',
    '})',
  ].join('\n');

  return { code: body };
}

/**
 * Compile graph and create an executable function.
 */
export function compileAndBuild(
  graphNodes: GraphNode[],
  graphEdges: GraphEdge[],
): {
  fn: ((cell: Record<string, unknown>, neighbors: Record<string, Record<string, unknown>[]>, modelAttrs: Record<string, unknown>) => { state: Record<string, unknown>; viewers: Record<string, { r: number; g: number; b: number }> }) | null;
  code: string;
  error?: string;
} {
  const { code, error } = compileGraph(graphNodes, graphEdges);
  if (error || !code) {
    return { fn: null, code, error };
  }
  try {
    // eslint-disable-next-line no-eval
    const fn = eval(code) as ReturnType<typeof compileAndBuild>['fn'];
    return { fn, code };
  } catch (e) {
    return { fn: null, code, error: `Compilation error: ${e instanceof Error ? e.message : String(e)}` };
  }
}
