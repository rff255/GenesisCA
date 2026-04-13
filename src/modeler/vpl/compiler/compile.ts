import type { GraphNode, GraphEdge, CAModel } from '../../../model/types';
import { getNodeDef } from '../nodes/registry';
import { parseHandleId } from '../types';
import type { PortDef } from '../types';

/**
 * Get the inline widget value for an unconnected port.
 * Returns the literal string if the port has an inline widget and a value is set in config,
 * otherwise returns undefined.
 */
function getInlineValue(port: PortDef, config: Record<string, string | number | boolean>): string | undefined {
  if (!port.inlineWidget) return undefined;
  const configKey = `_port_${port.id}`;
  const val = config[configKey];
  if (val === undefined || val === '') {
    return port.defaultValue;
  }
  const s = String(val);
  if (port.inlineWidget === 'bool') {
    return s === 'true' ? '1' : '0';
  }
  return s;
}

// ---------------------------------------------------------------------------
// Graph adjacency helpers
// ---------------------------------------------------------------------------

function buildAdjacency(graphNodes: GraphNode[], graphEdges: GraphEdge[]) {
  const nodeMap = new Map<string, GraphNode>();
  for (const n of graphNodes) nodeMap.set(n.id, n);

  const inputToSource = new Map<string, { nodeId: string; portId: string }>();
  const inputToSources = new Map<string, Array<{ nodeId: string; portId: string }>>();
  const flowOutputToTargets = new Map<string, Array<{ nodeId: string; portId: string }>>();

  for (const edge of graphEdges) {
    const sourceHandle = parseHandleId(edge.sourceHandle);
    const targetHandle = parseHandleId(edge.targetHandle);
    if (!sourceHandle || !targetHandle) continue;

    if (targetHandle.category === 'value') {
      const key = `${edge.target}:${targetHandle.portId}`;
      inputToSource.set(key, { nodeId: edge.source, portId: sourceHandle.portId });
      // Also collect ALL sources for multi-input ports (e.g., aggregate)
      const arr = inputToSources.get(key) ?? [];
      arr.push({ nodeId: edge.source, portId: sourceHandle.portId });
      inputToSources.set(key, arr);
    }

    if (sourceHandle.category === 'flow') {
      const key = `${edge.source}:${sourceHandle.portId}`;
      const existing = flowOutputToTargets.get(key) ?? [];
      existing.push({ nodeId: edge.target, portId: targetHandle.portId });
      flowOutputToTargets.set(key, existing);
    }
  }

  return { nodeMap, inputToSource, inputToSources, flowOutputToTargets };
}

// ---------------------------------------------------------------------------
// Compile a single root's subgraph (per-cell body)
// ---------------------------------------------------------------------------

const MULTI_OUTPUT_TYPES = new Set(['inputColor', 'getColorConstant', 'macro', 'colorInterpolation']);

/** Check if a node's data uses multi-output variable naming */
function isMultiOutput(data: { nodeType: string; config: Record<string, string | number | boolean> }): boolean {
  if (MULTI_OUTPUT_TYPES.has(data.nodeType)) return true;
  if (data.nodeType === 'getModelAttribute' && data.config.isColorAttr) return true;
  if (data.nodeType === 'groupStatement' || data.nodeType === 'groupCounting'
    || data.nodeType === 'groupOperator') return true;
  return false;
}

interface RootCompileResult {
  valueLines: string[];
  flowLines: string[];
  /** Nodes that need pre-loop declarations.
   *  nbrId: sized array for neighborhood scratch (GetNeighborsAttribute).
   *  initExpr: literal init expression for reusable scratch (e.g., '[]'). */
  scratchNodes: Array<{ scratchVarName: string; nbrId?: string; initExpr?: string }>;
}

function compileRoot(
  rootNode: GraphNode,
  rootFlowPort: string,
  nodeMap: Map<string, GraphNode>,
  inputToSource: Map<string, { nodeId: string; portId: string }>,
  inputToSources: Map<string, Array<{ nodeId: string; portId: string }>>,
  flowOutputToTargets: Map<string, Array<{ nodeId: string; portId: string }>>,
  _model?: CAModel,
): RootCompileResult {
  const compiled = new Set<string>();
  const valueLines: string[] = [];
  const scratchNodes: Array<{ scratchVarName: string; nbrId?: string; initExpr?: string }> = [];

  function varName(sourceNodeId: string, sourcePortId: string): string {
    const sourceNode = nodeMap.get(sourceNodeId);
    if (sourceNode && isMultiOutput(sourceNode.data)) {
      return `_v${sourceNodeId}_${sourcePortId}`;
    }
    // GetNeighborsAttribute uses _scr_ prefix for its scratch array
    if (sourceNode?.data.nodeType === 'getNeighborsAttribute') {
      return `_scr_${sourceNodeId}`;
    }
    // GetNeighborsAttrByIndexes uses _v{id}_vals scratch array
    if (sourceNode?.data.nodeType === 'getNeighborsAttrByIndexes') {
      return `_v${sourceNodeId}_vals`;
    }
    return `_v${sourceNodeId}`;
  }

  // Track macro definitions currently being expanded (recursion guard)
  const expandingMacroDefs = new Set<string>();

  /**
   * Inline a macro's value subgraph. Compiles all internal value nodes with
   * scoped variable names, then emits output assignments.
   */
  function inlineMacroValues(macroNodeId: string, macroNode: GraphNode): void {
    if (compiled.has(`__macro_${macroNodeId}`)) return;
    compiled.add(`__macro_${macroNodeId}`);

    const macroDefId = macroNode.data.config.macroDefId as string;
    if (!macroDefId || !_model) return;
    const macroDef = (_model.macroDefs || []).find(m => m.id === macroDefId);
    if (!macroDef) {
      valueLines.push(`      // ERROR: MacroDef "${macroDefId}" not found`);
      return;
    }

    // Recursion guard
    if (expandingMacroDefs.has(macroDefId)) {
      valueLines.push(`      // ERROR: Circular macro reference "${macroDef.name}"`);
      return;
    }
    if (expandingMacroDefs.size >= 20) {
      valueLines.push(`      // ERROR: Macro nesting depth exceeded (max 20)`);
      return;
    }
    expandingMacroDefs.add(macroDefId);

    // Build local adjacency for the macro's internal graph
    const inner = buildAdjacency(macroDef.nodes, macroDef.edges);
    const prefix = `_m${macroNodeId}`;

    // Find boundary nodes
    const macroInputNode = macroDef.nodes.find(
      n => (n.data as Record<string, unknown>).nodeType === 'macroInput',
    );
    const macroOutputNode = macroDef.nodes.find(
      n => (n.data as Record<string, unknown>).nodeType === 'macroOutput',
    );

    // Build alias map: MacroInput output ports → outer variables
    const inputAliases = new Map<string, string>(); // "portId" → outer var name
    if (macroInputNode) {
      for (const ep of macroDef.exposedInputs) {
        // Find what's connected to the MacroNode's corresponding input handle in the outer graph
        const outerSource = inputToSource.get(`${macroNodeId}:${ep.portId}`);
        if (outerSource) {
          compileValueNode(outerSource.nodeId);
          inputAliases.set(ep.portId, varName(outerSource.nodeId, outerSource.portId));
        }
      }
    }

    // Scoped varName for internal nodes
    function innerVarName(srcNodeId: string, srcPortId: string): string {
      // MacroInput ports → resolve to outer aliases
      if (macroInputNode && srcNodeId === macroInputNode.id) {
        return inputAliases.get(srcPortId) || 'undefined';
      }
      const srcNode = inner.nodeMap.get(srcNodeId);
      if (srcNode && isMultiOutput(srcNode.data)) {
        return `${prefix}_v${srcNodeId}_${srcPortId}`;
      }
      if (srcNode?.data.nodeType === 'getNeighborsAttribute') {
        return `${prefix}_scr_${srcNodeId}`;
      }
      return `${prefix}_v${srcNodeId}`;
    }

    // Compile internal value nodes
    const innerCompiled = new Set<string>();

    function compileInnerValueNode(innerNodeId: string): void {
      if (innerCompiled.has(innerNodeId)) return;
      innerCompiled.add(innerNodeId);

      const iNode = inner.nodeMap.get(innerNodeId);
      if (!iNode) return;
      const nt = iNode.data.nodeType;

      // Skip boundary nodes
      if (nt === 'macroInput' || nt === 'macroOutput') return;

      // Recursive macro inlining
      if (nt === 'macro') {
        inlineNestedMacroValues(macroNodeId, innerNodeId, iNode, inner, prefix);
        return;
      }

      const iDef = getNodeDef(nt);
      if (!iDef) return;

      // Track scratch arrays
      if (nt === 'getNeighborsAttribute') {
        const nbrId = iNode.data.config.neighborhoodId as string || '_undef';
        scratchNodes.push({ scratchVarName: `${prefix}_scr_${innerNodeId}`, nbrId });
      }
      if (nt === 'groupStatement' || nt === 'groupCounting') {
        scratchNodes.push({ scratchVarName: `${prefix}_v${innerNodeId}_indexes`, initExpr: '[]' });
      }
      if (nt === 'getNeighborsAttrByIndexes') {
        scratchNodes.push({ scratchVarName: `${prefix}_v${innerNodeId}_vals`, initExpr: '[]' });
      }

      // Resolve inputs
      const iInputVars: Record<string, string> = {};
      for (const port of iDef.ports) {
        if (port.kind !== 'input' || port.category !== 'value') continue;
        const src = inner.inputToSource.get(`${innerNodeId}:${port.id}`);
        if (src) {
          compileInnerValueNode(src.nodeId);
          iInputVars[port.id] = innerVarName(src.nodeId, src.portId);
        } else {
          const iNode2 = inner.nodeMap.get(innerNodeId);
          if (iNode2) {
            const inlineVal = getInlineValue(port, iNode2.data.config);
            if (inlineVal !== undefined) iInputVars[port.id] = inlineVal;
          }
        }
      }

      const code = iDef.compile(innerNodeId, iNode.data.config, iInputVars);
      if (code) {
        // Rewrite variable names in emitted code to use scoped prefix
        // Note: multi-output vars use _v{id}_{port} — the trailing _ breaks \b, so we
        // also replace _v{id}_ (with trailing underscore) before the word-boundary version.
        const scopedCode = code.replace(
          new RegExp(`\\b_v${innerNodeId}_`, 'g'),
          `${prefix}_v${innerNodeId}_`,
        ).replace(
          new RegExp(`\\b_v${innerNodeId}\\b`, 'g'),
          `${prefix}_v${innerNodeId}`,
        ).replace(
          new RegExp(`\\b_scr_${innerNodeId}\\b`, 'g'),
          `${prefix}_scr_${innerNodeId}`,
        ).replace(
          new RegExp(`\\b_nb${innerNodeId}\\b`, 'g'),
          `${prefix}_nb${innerNodeId}`,
        );
        valueLines.push('      ' + scopedCode.trimEnd());
      }
    }

    // Compile all value dependencies by tracing from MacroOutput inputs
    if (macroOutputNode) {
      for (const ep of macroDef.exposedOutputs) {
        const src = inner.inputToSource.get(`${macroOutputNode.id}:${ep.portId}`);
        if (src) {
          compileInnerValueNode(src.nodeId);
          // Emit output assignment: _v${macroNodeId}_${portId} = innerVar
          const innerVar = innerVarName(src.nodeId, src.portId);
          valueLines.push(`      const _v${macroNodeId}_${ep.portId} = ${innerVar};`);
        }
      }
    }

    expandingMacroDefs.delete(macroDefId);
  }

  /**
   * Handle nested macros inside a macro subgraph.
   */
  function inlineNestedMacroValues(
    outerMacroNodeId: string,
    innerMacroNodeId: string,
    innerMacroNode: GraphNode,
    parentAdjacency: ReturnType<typeof buildAdjacency>,
    parentPrefix: string,
  ): void {
    const macroDefId = innerMacroNode.data.config.macroDefId as string;
    if (!macroDefId || !_model) return;
    const macroDef = (_model.macroDefs || []).find(m => m.id === macroDefId);
    if (!macroDef) return;

    if (expandingMacroDefs.has(macroDefId) || expandingMacroDefs.size >= 20) {
      valueLines.push(`      // ERROR: Circular/deep macro "${macroDef.name}"`);
      return;
    }
    expandingMacroDefs.add(macroDefId);

    const nestedInner = buildAdjacency(macroDef.nodes, macroDef.edges);
    const nestedPrefix = `${parentPrefix}_m${innerMacroNodeId}`;

    const nestedInputNode = macroDef.nodes.find(
      n => (n.data as Record<string, unknown>).nodeType === 'macroInput',
    );
    const nestedOutputNode = macroDef.nodes.find(
      n => (n.data as Record<string, unknown>).nodeType === 'macroOutput',
    );

    // Resolve input aliases from parent adjacency
    const nestedAliases = new Map<string, string>();
    if (nestedInputNode) {
      for (const ep of macroDef.exposedInputs) {
        const src = parentAdjacency.inputToSource.get(`${innerMacroNodeId}:${ep.portId}`);
        if (src) {
          // The source is in the parent scope — use parent's varName
          const srcNode = parentAdjacency.nodeMap.get(src.nodeId);
          if (srcNode && srcNode.data.nodeType === 'macroInput') {
            // It's the parent's MacroInput — handled by parent's alias chain
            nestedAliases.set(ep.portId, `${parentPrefix}_v${src.nodeId}_${src.portId}`);
          } else if (srcNode && isMultiOutput(srcNode.data)) {
            nestedAliases.set(ep.portId, `${parentPrefix}_v${src.nodeId}_${src.portId}`);
          } else if (srcNode?.data.nodeType === 'getNeighborsAttribute') {
            nestedAliases.set(ep.portId, `${parentPrefix}_scr_${src.nodeId}`);
          } else {
            nestedAliases.set(ep.portId, `${parentPrefix}_v${src.nodeId}`);
          }
        }
      }
    }

    function nestedVarName(srcNodeId: string, srcPortId: string): string {
      if (nestedInputNode && srcNodeId === nestedInputNode.id) {
        return nestedAliases.get(srcPortId) || 'undefined';
      }
      const srcNode = nestedInner.nodeMap.get(srcNodeId);
      if (srcNode && isMultiOutput(srcNode.data)) {
        return `${nestedPrefix}_v${srcNodeId}_${srcPortId}`;
      }
      if (srcNode?.data.nodeType === 'getNeighborsAttribute') {
        return `${nestedPrefix}_scr_${srcNodeId}`;
      }
      return `${nestedPrefix}_v${srcNodeId}`;
    }

    const nestedCompiled = new Set<string>();

    function compileNestedNode(nid: string): void {
      if (nestedCompiled.has(nid)) return;
      nestedCompiled.add(nid);
      const iNode = nestedInner.nodeMap.get(nid);
      if (!iNode) return;
      const nt = iNode.data.nodeType;
      if (nt === 'macroInput' || nt === 'macroOutput') return;
      if (nt === 'macro') {
        inlineNestedMacroValues(outerMacroNodeId, nid, iNode, nestedInner, nestedPrefix);
        return;
      }
      const iDef = getNodeDef(nt);
      if (!iDef) return;
      if (nt === 'getNeighborsAttribute') {
        const nbrId = iNode.data.config.neighborhoodId as string || '_undef';
        scratchNodes.push({ scratchVarName: `${nestedPrefix}_scr_${nid}`, nbrId });
      }
      if (nt === 'groupStatement' || nt === 'groupCounting') {
        scratchNodes.push({ scratchVarName: `${nestedPrefix}_v${nid}_indexes`, initExpr: '[]' });
      }
      if (nt === 'getNeighborsAttrByIndexes') {
        scratchNodes.push({ scratchVarName: `${nestedPrefix}_v${nid}_vals`, initExpr: '[]' });
      }
      const iInputVars: Record<string, string> = {};
      for (const port of iDef.ports) {
        if (port.kind !== 'input' || port.category !== 'value') continue;
        const src = nestedInner.inputToSource.get(`${nid}:${port.id}`);
        if (src) {
          compileNestedNode(src.nodeId);
          iInputVars[port.id] = nestedVarName(src.nodeId, src.portId);
        } else {
          const nNode = nestedInner.nodeMap.get(nid);
          if (nNode) {
            const inlineVal = getInlineValue(port, nNode.data.config);
            if (inlineVal !== undefined) iInputVars[port.id] = inlineVal;
          }
        }
      }
      const code = iDef.compile(nid, iNode.data.config, iInputVars);
      if (code) {
        const scopedCode = code
          .replace(new RegExp(`\\b_v${nid}_`, 'g'), `${nestedPrefix}_v${nid}_`)
          .replace(new RegExp(`\\b_v${nid}\\b`, 'g'), `${nestedPrefix}_v${nid}`)
          .replace(new RegExp(`\\b_scr_${nid}\\b`, 'g'), `${nestedPrefix}_scr_${nid}`)
          .replace(new RegExp(`\\b_nb${nid}\\b`, 'g'), `${nestedPrefix}_nb${nid}`);
        valueLines.push('      ' + scopedCode.trimEnd());
      }
    }

    if (nestedOutputNode) {
      for (const ep of macroDef.exposedOutputs) {
        const src = nestedInner.inputToSource.get(`${nestedOutputNode.id}:${ep.portId}`);
        if (src) {
          compileNestedNode(src.nodeId);
          const innerVar = nestedVarName(src.nodeId, src.portId);
          // Use parent prefix for the inner macro node's output variables
          const parentNode = parentAdjacency.nodeMap.get(innerMacroNodeId);
          if (parentNode && isMultiOutput(parentNode.data)) {
            valueLines.push(`      const ${parentPrefix}_v${innerMacroNodeId}_${ep.portId} = ${innerVar};`);
          } else {
            valueLines.push(`      const ${parentPrefix}_v${innerMacroNodeId} = ${innerVar};`);
          }
        }
      }
    }

    expandingMacroDefs.delete(macroDefId);
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

    // MacroNode — inline the subgraph
    if (node.data.nodeType === 'macro') {
      inlineMacroValues(nodeId, node);
      return `_v${nodeId}`;
    }

    // MacroInput/MacroOutput — never compiled directly at root level
    if (node.data.nodeType === 'macroInput' || node.data.nodeType === 'macroOutput') {
      return `_v${nodeId}`;
    }

    // Track GetNeighborsAttribute nodes for scratch declaration
    if (node.data.nodeType === 'getNeighborsAttribute') {
      const nbrId = node.data.config.neighborhoodId as string || '_undef';
      scratchNodes.push({ scratchVarName: `_scr_${nodeId}`, nbrId });
    }
    // Track aggregation nodes that need reusable scratch arrays (only when indexes output is connected)
    let needsIndexes = false;
    if (node.data.nodeType === 'groupStatement' || node.data.nodeType === 'groupCounting') {
      // Check if any downstream node reads the indexes output
      for (const [, src] of inputToSource) {
        if (src.nodeId === nodeId && src.portId === 'indexes') { needsIndexes = true; break; }
      }
    }
    if (needsIndexes) {
      scratchNodes.push({ scratchVarName: `_v${nodeId}_indexes`, initExpr: '[]' });
    }
    if (node.data.nodeType === 'getNeighborsAttrByIndexes') {
      scratchNodes.push({ scratchVarName: `_v${nodeId}_vals`, initExpr: '[]' });
    }

    const inputVars: Record<string, string> = {};
    for (const port of def.ports) {
      if (port.kind !== 'input' || port.category !== 'value') continue;
      // Multi-input support for isArray ports (e.g., Aggregate node)
      const sources = inputToSources.get(`${nodeId}:${port.id}`);
      if (port.isArray && sources && sources.length > 1) {
        for (const s of sources) compileValueNode(s.nodeId);
        inputVars[port.id] = `[${sources.map(s => varName(s.nodeId, s.portId)).join(', ')}]`;
      } else {
        const source = inputToSource.get(`${nodeId}:${port.id}`);
        if (source) {
          compileValueNode(source.nodeId);
          inputVars[port.id] = varName(source.nodeId, source.portId);
        } else {
          const inlineVal = getInlineValue(port, node.data.config);
          if (inlineVal !== undefined) inputVars[port.id] = inlineVal;
        }
      }
    }

    // For aggregation nodes, pass whether indexes output is connected (for optimization)
    const compileConfig = (node.data.nodeType === 'groupStatement' || node.data.nodeType === 'groupCounting')
      ? { ...node.data.config, _indexesConnected: needsIndexes }
      : node.data.config;
    const code = def.compile(nodeId, compileConfig, inputVars);
    if (code) valueLines.push('      ' + code.trimEnd());

    return `_v${nodeId}`;
  }

  function collectValueDeps(nodeId: string): void {
    const node = nodeMap.get(nodeId);
    if (!node) return;
    const def = getNodeDef(node.data.nodeType);
    if (!def) return;

    // For macro nodes, resolve value inputs from exposed input ports
    if (node.data.nodeType === 'macro' && _model) {
      const macroDefId = node.data.config.macroDefId as string;
      const macroDef = (_model.macroDefs || []).find(m => m.id === macroDefId);
      if (macroDef) {
        for (const ep of macroDef.exposedInputs) {
          if (ep.category === 'value') {
            const source = inputToSource.get(`${nodeId}:${ep.portId}`);
            if (source) compileValueNode(source.nodeId);
          }
        }
        // Follow flow output edges from the macro to downstream nodes
        for (const ep of macroDef.exposedOutputs) {
          if (ep.category === 'flow') {
            const targets = flowOutputToTargets.get(`${nodeId}:${ep.portId}`);
            if (targets) {
              for (const t of targets) collectValueDeps(t.nodeId);
            }
          }
        }
      }
      return;
    }

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

  /**
   * Inline a macro's flow chain. Follows the internal flow from MacroInput's
   * flow output port through the internal subgraph.
   */
  function inlineMacroFlow(macroNodeId: string, macroNode: GraphNode, indent: string): void {
    const macroDefId = macroNode.data.config.macroDefId as string;
    if (!macroDefId || !_model) return;
    const macroDefMaybe = (_model.macroDefs || []).find(m => m.id === macroDefId);
    if (!macroDefMaybe) return;
    const md = macroDefMaybe; // local const so TS narrows in closures

    if (expandingMacroDefs.has(macroDefId) || expandingMacroDefs.size >= 20) {
      flowLines.push(`${indent}// ERROR: Circular/deep macro flow "${md.name}"`);
      return;
    }
    expandingMacroDefs.add(macroDefId);

    const inner = buildAdjacency(md.nodes, md.edges);
    const prefix = `_m${macroNodeId}`;

    // Find boundary nodes
    const macroInputNode = md.nodes.find(
      n => (n.data as Record<string, unknown>).nodeType === 'macroInput',
    );

    // Build scoped varName for reading value ports inside the flow chain
    function innerFlowVarName(srcNodeId: string, srcPortId: string): string {
      if (macroInputNode && srcNodeId === macroInputNode.id) {
        // Resolve to outer variable via alias
        const ep = md.exposedInputs.find(p => p.portId === srcPortId);
        if (ep) {
          const outerSrc = inputToSource.get(`${macroNodeId}:${ep.portId}`);
          if (outerSrc) return varName(outerSrc.nodeId, outerSrc.portId);
        }
        return 'undefined';
      }
      const srcNode = inner.nodeMap.get(srcNodeId);
      if (srcNode && isMultiOutput(srcNode.data)) {
        return `${prefix}_v${srcNodeId}_${srcPortId}`;
      }
      if (srcNode?.data.nodeType === 'getNeighborsAttribute') {
        return `${prefix}_scr_${srcNodeId}`;
      }
      return `${prefix}_v${srcNodeId}`;
    }

    // Compile internal flow chain starting from MacroInput's flow output ports
    function compileInnerFlow(srcNodeId: string, srcPortId: string, ind: string): void {
      const targets = inner.flowOutputToTargets.get(`${srcNodeId}:${srcPortId}`);
      if (!targets || targets.length === 0) return;

      for (const t of targets) {
        const iNode = inner.nodeMap.get(t.nodeId);
        if (!iNode) continue;
        const nt = iNode.data.nodeType;

        // If we hit MacroOutput, we've reached the end of the macro's flow
        if (nt === 'macroOutput') continue;

        const iDef = getNodeDef(nt);
        if (!iDef) continue;

        if (nt === 'conditional') {
          const condSrc = inner.inputToSource.get(`${iNode.id}:condition`);
          let condVar: string;
          if (condSrc) {
            condVar = innerFlowVarName(condSrc.nodeId, condSrc.portId);
          } else {
            const condPort = iDef.ports.find(p => p.id === 'condition');
            const inlineVal = condPort ? getInlineValue(condPort, iNode.data.config) : undefined;
            condVar = inlineVal ?? 'false';
          }
          const hasElse = inner.flowOutputToTargets.has(`${iNode.id}:else`);
          flowLines.push(`${ind}if (${condVar}) {`);
          compileInnerFlow(iNode.id, 'then', ind + '  ');
          if (hasElse) {
            flowLines.push(`${ind}} else {`);
            compileInnerFlow(iNode.id, 'else', ind + '  ');
          }
          flowLines.push(`${ind}}`);
        } else if (nt === 'sequence') {
          compileInnerFlow(iNode.id, 'first', ind);
          compileInnerFlow(iNode.id, 'then', ind);
        } else if (nt === 'loop') {
          const countSrc = inner.inputToSource.get(`${iNode.id}:count`);
          let countVar: string;
          if (countSrc) {
            countVar = innerFlowVarName(countSrc.nodeId, countSrc.portId);
          } else {
            const countPort = iDef.ports.find(p => p.id === 'count');
            const inlineVal = countPort ? getInlineValue(countPort, iNode.data.config) : undefined;
            countVar = inlineVal ?? '0';
          }
          const loopVar = `${prefix}_li${iNode.id}`;
          flowLines.push(`${ind}for (let ${loopVar} = 0; ${loopVar} < ${countVar}; ${loopVar}++) {`);
          compileInnerFlow(iNode.id, 'body', ind + '  ');
          flowLines.push(`${ind}}`);
        } else {
          // Regular action node — compile with scoped inputs
          const iInputVars: Record<string, string> = {};
          for (const port of iDef.ports) {
            if (port.kind !== 'input' || port.category !== 'value') continue;
            const src = inner.inputToSource.get(`${iNode.id}:${port.id}`);
            if (src) {
              iInputVars[port.id] = innerFlowVarName(src.nodeId, src.portId);
            } else {
              const inlineVal = getInlineValue(port, iNode.data.config);
              if (inlineVal !== undefined) iInputVars[port.id] = inlineVal;
            }
          }
          const code = iDef.compile(iNode.id, iNode.data.config, iInputVars);
          if (code) {
            // Scope the emitted code
            const scopedCode = code
              .replace(new RegExp(`\\b_v${iNode.id}\\b`, 'g'), `${prefix}_v${iNode.id}`)
              .replace(new RegExp(`\\b_scr_${iNode.id}\\b`, 'g'), `${prefix}_scr_${iNode.id}`)
              .replace(new RegExp(`\\b_nb${iNode.id}\\b`, 'g'), `${prefix}_nb${iNode.id}`);
            flowLines.push(ind + scopedCode.trimEnd());
          }
        }
      }
    }

    // Start flow from MacroInput's flow output ports
    if (macroInputNode) {
      // Find which flow ports on the MacroInput connect into the subgraph
      for (const ep of md.exposedInputs) {
        if (ep.category === 'flow') {
          compileInnerFlow(macroInputNode.id, ep.portId, indent);
        }
      }
    }

    expandingMacroDefs.delete(macroDefId);
  }

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
        let condVar: string;
        if (condSource) {
          condVar = varName(condSource.nodeId, condSource.portId);
        } else {
          const condPort = def.ports.find(p => p.id === 'condition');
          const inlineVal = condPort ? getInlineValue(condPort, node.data.config) : undefined;
          condVar = inlineVal ?? 'false';
        }
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
        let countVar: string;
        if (countSource) {
          countVar = varName(countSource.nodeId, countSource.portId);
        } else {
          const countPort = def.ports.find(p => p.id === 'count');
          const inlineVal = countPort ? getInlineValue(countPort, node.data.config) : undefined;
          countVar = inlineVal ?? '0';
        }
        flowLines.push(`${indent}for (let _li${node.id} = 0; _li${node.id} < ${countVar}; _li${node.id}++) {`);
        compileFlowChain(node.id, 'body', indent + '  ');
        flowLines.push(`${indent}}`);
      } else if (node.data.nodeType === 'switch') {
        const switchMode = (node.data.config.mode as string) || 'conditions';
        const firstMatchOnly = node.data.config.firstMatchOnly !== false;
        const valType = (node.data.config.valueType as string) || 'integer';
        const caseCount = Number(node.data.config.caseCount) || 0;
        const hasDefault = flowOutputToTargets.has(`${node.id}:default`);

        if (caseCount === 0) {
          compileFlowChain(node.id, 'default', indent);
        } else {
          // Build condition expressions for each case
          const caseConditions: string[] = [];
          for (let ci = 0; ci < caseCount; ci++) {
            if (switchMode === 'conditions') {
              // Read bool condition input
              const condSource = inputToSource.get(`${node.id}:case_${ci}_cond`);
              if (condSource) {
                caseConditions.push(varName(condSource.nodeId, condSource.portId));
              } else {
                const condVal = (node.data.config[`_port_case_${ci}_cond`] as string);
                caseConditions.push(condVal === 'true' ? '1' : '0');
              }
            } else {
              // "by value" mode — resolve value input and build comparison
              const valSource = inputToSource.get(`${node.id}:value`);
              let valVar: string;
              if (valSource) {
                valVar = varName(valSource.nodeId, valSource.portId);
              } else {
                const valPort = def.ports.find(p => p.id === 'value');
                const inlineVal = valPort ? getInlineValue(valPort, node.data.config) : undefined;
                valVar = inlineVal ?? '0';
              }
              if (valType === 'tag') {
                // Tag: equality against tag index
                const tagIdx = (node.data.config[`case_${ci}_value`] as string) || '0';
                caseConditions.push(`(${valVar} === ${tagIdx})`);
              } else {
                // Int/Float: configurable comparison op
                const op = (node.data.config[`case_${ci}_op`] as string) || '==';
                const jsOp = op === '==' ? '===' : op === '!=' ? '!==' : op;
                const caseValSource = inputToSource.get(`${node.id}:case_${ci}_val`);
                let caseValVar: string;
                if (caseValSource) {
                  caseValVar = varName(caseValSource.nodeId, caseValSource.portId);
                } else {
                  caseValVar = (node.data.config[`_port_case_${ci}_val`] as string)
                    ?? (node.data.config[`case_${ci}_value`] as string) ?? '0';
                }
                caseConditions.push(`(${valVar} ${jsOp} ${caseValVar})`);
              }
            }
          }

          if (firstMatchOnly) {
            // if / else-if chain
            for (let ci = 0; ci < caseCount; ci++) {
              const prefix = ci === 0 ? 'if' : '} else if';
              flowLines.push(`${indent}${prefix} (${caseConditions[ci]}) {`);
              compileFlowChain(node.id, `case_${ci}`, indent + '  ');
            }
            if (hasDefault) {
              flowLines.push(`${indent}} else {`);
              compileFlowChain(node.id, 'default', indent + '  ');
            }
            flowLines.push(`${indent}}`);
          } else {
            // All matches: independent if blocks + default guard
            flowLines.push(`${indent}let _sw${node.id} = false;`);
            for (let ci = 0; ci < caseCount; ci++) {
              flowLines.push(`${indent}if (${caseConditions[ci]}) { _sw${node.id} = true;`);
              compileFlowChain(node.id, `case_${ci}`, indent + '  ');
              flowLines.push(`${indent}}`);
            }
            if (hasDefault) {
              flowLines.push(`${indent}if (!_sw${node.id}) {`);
              compileFlowChain(node.id, 'default', indent + '  ');
              flowLines.push(`${indent}}`);
            }
          }
        }
      } else if (node.data.nodeType === 'macro') {
        // Inline macro flow chain
        inlineMacroFlow(node.id, node, indent);
        // After the macro's internal flow, continue with any flow outputs from the MacroNode
        // (MacroOutput flow ports map to MacroNode's flow output ports)
      } else {
        const inputVars: Record<string, string> = {};
        for (const port of def.ports) {
          if (port.kind !== 'input' || port.category !== 'value') continue;
          const source = inputToSource.get(`${node.id}:${port.id}`);
          if (source) {
            inputVars[port.id] = varName(source.nodeId, source.portId);
          } else {
            const inlineVal = getInlineValue(port, node.data.config);
            if (inlineVal !== undefined) inputVars[port.id] = inlineVal;
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
  const isAsync = model.properties.updateMode === 'asynchronous';
  const cellAttrs = model.attributes
    .filter(a => !a.isModelAttribute)
    .map(a => ({ id: a.id, type: a.type }));
  const neighborhoods = model.neighborhoods.map(n => ({ id: n.id }));

  const parts: string[] = ['total'];
  for (const a of cellAttrs) parts.push(`r_${a.id}`);
  for (const a of cellAttrs) parts.push(`w_${a.id}`);
  for (const n of neighborhoods) { parts.push(`nIdx_${n.id}`); parts.push(`nSz_${n.id}`); }
  parts.push('modelAttrs', 'colors', 'activeViewer', '_indicators', '_linkedResults');
  if (isAsync) parts.push('order');

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
  parts.push('modelAttrs', 'colors', 'activeViewer', '_indicators', '_linkedResults');
  return parts.join(', ');
}

// ---------------------------------------------------------------------------
// Linked indicator code generation (injected into step function)
// ---------------------------------------------------------------------------

function buildLinkedIndicatorCode(model: CAModel): {
  preLoopDecls: string[];
  inLoopLines: string[];
  postLoopLines: string[];
} {
  const postLoopLines: string[] = [];

  const watched = (model.indicators || []).filter(
    i => i.kind === 'linked' && i.watched && i.linkedAttributeId,
  );
  if (watched.length === 0) return { preLoopDecls: [], inLoopLines: [], postLoopLines };

  // All linked indicators are computed as post-loop passes over the final buffer.
  // This is correct for both sync mode (w_ has new values after loop) and async mode
  // (single buffer is fully updated). A separate pass over a typed array is fast
  // (sequential memory scan, perfect cache locality) and avoids the async-mode bug
  // where mid-loop aggregation sees a mix of old and new values.
  for (const ind of watched) {
    const attr = model.attributes.find(a => a.id === ind.linkedAttributeId);
    if (!attr || attr.isModelAttribute) continue;
    const wVar = `w_${attr.id}`;
    const key = JSON.stringify(ind.id);

    if (ind.linkedAggregation === 'total') {
      postLoopLines.push(
        `  { let _s = 0; for (let _i = 0; _i < total; _i++) _s += ${wVar}[_i];` +
        ` _linkedResults[${key}] = _s; }`,
      );
    } else if (attr.type === 'bool') {
      postLoopLines.push(
        `  { let _t = 0; for (let _i = 0; _i < total; _i++) if (${wVar}[_i]) _t++;` +
        ` _linkedResults[${key}] = { 'true': _t, 'false': total - _t }; }`,
      );
    } else if (attr.type === 'tag') {
      const tagLen = attr.tagOptions?.length || 1;
      const tagNames = JSON.stringify(attr.tagOptions || []);
      postLoopLines.push(
        `  { const _c = new Int32Array(${tagLen});` +
        ` for (let _i = 0; _i < total; _i++) _c[${wVar}[_i]]++;` +
        ` const _tn = ${tagNames}; const _f = {};` +
        ` for (let _ti = 0; _ti < ${tagLen}; _ti++) _f[_tn[_ti]] = _c[_ti];` +
        ` _linkedResults[${key}] = _f; }`,
      );
    } else if (attr.type === 'integer') {
      postLoopLines.push(
        `  { const _f = {};` +
        ` for (let _i = 0; _i < total; _i++) { const _k = ${wVar}[_i]; _f[_k] = (_f[_k] || 0) + 1; }` +
        ` _linkedResults[${key}] = _f; }`,
      );
    } else if (attr.type === 'float') {
      const bc = ind.binCount || 10;
      postLoopLines.push(
        `  { let _mn = Infinity, _mx = -Infinity;` +
        ` for (let _i = 0; _i < total; _i++) { const _v = ${wVar}[_i]; if (_v < _mn) _mn = _v; if (_v > _mx) _mx = _v; }` +
        ` if (_mn === _mx) _mx = _mn + 1;` +
        ` const _bw = (_mx - _mn) / ${bc}; const _bins = new Int32Array(${bc});` +
        ` for (let _i = 0; _i < total; _i++) { let _b = (${wVar}[_i] - _mn) / _bw | 0; if (_b >= ${bc}) _b = ${bc - 1}; _bins[_b]++; }` +
        ` const _f = {};` +
        ` for (let _bi = 0; _bi < ${bc}; _bi++)` +
        ` { const _lo = (_mn + _bi * _bw).toFixed(2); const _hi = (_mn + (_bi + 1) * _bw).toFixed(2);` +
        ` _f[_lo + '\\u2013' + _hi] = _bins[_bi]; }` +
        ` _linkedResults[${key}] = _f; }`,
      );
    }
  }

  return { preLoopDecls: [], inLoopLines: [], postLoopLines };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CompileResult {
  stepCode: string;
  inputColorCodes: Array<{ mappingId: string; code: string }>;
  outputMappingCodes: Array<{ mappingId: string; code: string }>;
  error?: string;
}

export function compileGraph(
  graphNodes: GraphNode[],
  graphEdges: GraphEdge[],
  model?: CAModel,
): CompileResult {
  if (graphNodes.length === 0) {
    return { stepCode: '', inputColorCodes: [], outputMappingCodes: [], error: 'No nodes in graph.' };
  }

  if (!model) {
    return { stepCode: '', inputColorCodes: [], outputMappingCodes: [], error: 'Model required for SoA compilation.' };
  }

  const isAsync = model.properties.updateMode === 'asynchronous';

  // --- Validate async-only nodes in sync mode ---
  // getNeighborAttributeByIndex is read-only so it works in both sync and async modes
  const ASYNC_ONLY_TYPES = new Set(['setNeighborhoodAttribute', 'setNeighborAttributeByIndex']);
  let asyncValidationError: string | undefined;
  if (!isAsync) {
    const offending = graphNodes.find(n => ASYNC_ONLY_TYPES.has(n.data.nodeType));
    if (offending) {
      const label = offending.data.nodeType === 'setNeighborhoodAttribute'
        ? 'Set Neighborhood Attribute' : 'Set Neighbor Attr By Index';
      asyncValidationError = `Node "${label}" requires Asynchronous update mode. Change in Model Properties > Execution.`;
    }
  }

  const { nodeMap, inputToSource, inputToSources, flowOutputToTargets } = buildAdjacency(graphNodes, graphEdges);

  // Pre-resolve neighborhood tag names to indices for GetNeighborAttributeByTag nodes
  for (const node of graphNodes) {
    if (node.data.nodeType === 'getNeighborAttributeByTag') {
      const nbrId = node.data.config.neighborhoodId as string;
      const nbr = model.neighborhoods.find(n => n.id === nbrId);
      const tagName = node.data.config.tagName as string;
      const tagEntry = nbr?.tags
        ? Object.entries(nbr.tags).find(([, name]) => name === tagName)
        : undefined;
      node.data.config._resolvedTagIndex = tagEntry !== undefined ? Number(tagEntry[0]) : 0;
    }
    if (node.data.nodeType === 'getNeighborIndexesByTags') {
      const nbrId = node.data.config.neighborhoodId as string;
      const nbr = model.neighborhoods.find(n => n.id === nbrId);
      const tagCount = Number(node.data.config.tagCount) || 0;
      const indices: number[] = [];
      for (let i = 0; i < tagCount; i++) {
        const tagName = node.data.config[`tag_${i}_name`] as string;
        const tagEntry = nbr?.tags
          ? Object.entries(nbr.tags).find(([, name]) => name === tagName)
          : undefined;
        indices.push(tagEntry !== undefined ? Number(tagEntry[0]) : 0);
      }
      node.data.config._resolvedTagIndexes = JSON.stringify(indices);
    }
  }
  const { params: loopParams, cellAttrs } = buildLoopParams(model);
  const cellParams = buildCellParams(model);

  // Generate attribute copy lines (previous → next generation)
  // In async mode, r_ and w_ are the same buffer so copy lines are skipped
  const copyLines = isAsync
    ? []
    : cellAttrs.map(a => `      w_${a.id}[idx] = r_${a.id}[idx];`);

  // --- Compile Step function (loop-wrapped) ---
  const stepNode = graphNodes.find(n => n.data.nodeType === 'step');
  let stepCode = '';
  if (stepNode) {
    const { valueLines, flowLines, scratchNodes } = compileRoot(
      stepNode, 'do', nodeMap, inputToSource, inputToSources, flowOutputToTargets, model,
    );

    // Scratch array declarations (before the loop)
    const scratchDecls = scratchNodes.map(
      s => s.nbrId
        ? `  const ${s.scratchVarName} = new Array(nSz_${s.nbrId});`
        : `  const ${s.scratchVarName} = ${s.initExpr ?? '[]'};`,
    );

    // Build linked indicator aggregation code (injected into the loop)
    const linked = buildLinkedIndicatorCode(model);

    if (isAsync) {
      // Async mode: iterate cells via shuffled order array
      stepCode = [
        `(function(${loopParams}) {`,
        ...scratchDecls,
        ...linked.preLoopDecls,
        '  for (let _i = 0; _i < total; _i++) {',
        '    const idx = order[_i];',
        '    const colorIdx = idx * 4;',
        ...copyLines,
        ...valueLines,
        '',
        ...flowLines,
        ...linked.inLoopLines,
        '  }',
        ...linked.postLoopLines,
        '})',
      ].join('\n');
    } else {
      // Sync mode: sequential iteration
      stepCode = [
        `(function(${loopParams}) {`,
        ...scratchDecls,
        ...linked.preLoopDecls,
        '  for (let idx = 0; idx < total; idx++) {',
        '    const colorIdx = idx * 4;',
        ...copyLines,
        ...valueLines,
        '',
        ...flowLines,
        ...linked.inLoopLines,
        '  }',
        ...linked.postLoopLines,
        '})',
      ].join('\n');
    }
  }

  // --- Compile InputColor functions (per-cell, not loop-wrapped) ---
  const inputColorNodes = graphNodes.filter(n => n.data.nodeType === 'inputColor');
  const inputColorCodes: Array<{ mappingId: string; code: string }> = [];

  for (const icNode of inputColorNodes) {
    const mappingId = icNode.data.config.mappingId as string || '';
    const { valueLines, flowLines } = compileRoot(
      icNode, 'do', nodeMap, inputToSource, inputToSources, flowOutputToTargets, model,
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

  // --- Compile Output Mapping functions (loop-wrapped, always sequential, no copy lines) ---
  const outputMappingNodes = graphNodes.filter(n => n.data.nodeType === 'outputMapping');
  const outputMappingCodes: Array<{ mappingId: string; code: string }> = [];

  // Output mapping uses sync-style loop params (no order) regardless of updateMode
  const omParamParts: string[] = ['total'];
  for (const a of cellAttrs) omParamParts.push(`r_${a.id}`);
  for (const a of cellAttrs) omParamParts.push(`w_${a.id}`);
  const neighborhoods = model.neighborhoods.map(n => ({ id: n.id }));
  for (const n of neighborhoods) { omParamParts.push(`nIdx_${n.id}`); omParamParts.push(`nSz_${n.id}`); }
  omParamParts.push('modelAttrs', 'colors', 'activeViewer', '_indicators', '_linkedResults');
  const omParams = omParamParts.join(', ');

  for (const omNode of outputMappingNodes) {
    const mappingId = omNode.data.config.mappingId as string || '';
    const { valueLines, flowLines, scratchNodes } = compileRoot(
      omNode, 'do', nodeMap, inputToSource, inputToSources, flowOutputToTargets, model,
    );
    const scratchDecls = scratchNodes.map(
      s => s.nbrId
        ? `  const ${s.scratchVarName} = new Array(nSz_${s.nbrId});`
        : `  const ${s.scratchVarName} = ${s.initExpr ?? '[]'};`,
    );
    const code = [
      `(function(${omParams}) {`,
      ...scratchDecls,
      '  for (let idx = 0; idx < total; idx++) {',
      '    const colorIdx = idx * 4;',
      ...valueLines,
      '',
      ...flowLines,
      '  }',
      '})',
    ].join('\n');
    outputMappingCodes.push({ mappingId, code });
  }

  const error = asyncValidationError
    ?? (!stepNode ? 'No Step node found. Add a Step node as the entry point.' : undefined);

  return { stepCode, inputColorCodes, outputMappingCodes, error };
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
  outputMappingCodes: Array<{ mappingId: string; code: string }>;
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
        outputMappingCodes: result.outputMappingCodes,
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
        outputMappingCodes: result.outputMappingCodes,
        error: `InputColor compilation error: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  return {
    stepFn, inputColorFns,
    stepCode: result.stepCode, inputColorCodes: result.inputColorCodes,
    outputMappingCodes: result.outputMappingCodes, error: result.error,
  };
}
