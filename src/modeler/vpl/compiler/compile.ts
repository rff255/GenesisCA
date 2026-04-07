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

const MULTI_OUTPUT_TYPES = new Set(['inputColor', 'getColorConstant', 'macro']);

interface RootCompileResult {
  valueLines: string[];
  flowLines: string[];
  /** Node IDs that need scratch array declarations (GetNeighborsAttribute nodes).
   *  scratchVarName is the full variable name (e.g., _scr_n123 or _mnABC_scr_n123). */
  scratchNodes: Array<{ scratchVarName: string; nbrId: string }>;
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
  const scratchNodes: Array<{ scratchVarName: string; nbrId: string }> = [];

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
      if (srcNode && MULTI_OUTPUT_TYPES.has(srcNode.data.nodeType)) {
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

      // Resolve inputs
      const iInputVars: Record<string, string> = {};
      for (const port of iDef.ports) {
        if (port.kind !== 'input' || port.category !== 'value') continue;
        const src = inner.inputToSource.get(`${innerNodeId}:${port.id}`);
        if (src) {
          compileInnerValueNode(src.nodeId);
          iInputVars[port.id] = innerVarName(src.nodeId, src.portId);
        }
      }

      const code = iDef.compile(innerNodeId, iNode.data.config, iInputVars);
      if (code) {
        // Rewrite variable names in emitted code to use scoped prefix
        const scopedCode = code.replace(
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
          } else if (srcNode && MULTI_OUTPUT_TYPES.has(srcNode.data.nodeType)) {
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
      if (srcNode && MULTI_OUTPUT_TYPES.has(srcNode.data.nodeType)) {
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
      const iInputVars: Record<string, string> = {};
      for (const port of iDef.ports) {
        if (port.kind !== 'input' || port.category !== 'value') continue;
        const src = nestedInner.inputToSource.get(`${nid}:${port.id}`);
        if (src) {
          compileNestedNode(src.nodeId);
          iInputVars[port.id] = nestedVarName(src.nodeId, src.portId);
        }
      }
      const code = iDef.compile(nid, iNode.data.config, iInputVars);
      if (code) {
        const scopedCode = code
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
          if (parentNode && MULTI_OUTPUT_TYPES.has(parentNode.data.nodeType)) {
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
      if (srcNode && MULTI_OUTPUT_TYPES.has(srcNode.data.nodeType)) {
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
          const condVar = condSrc ? innerFlowVarName(condSrc.nodeId, condSrc.portId) : 'false';
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
          const countVar = countSrc ? innerFlowVarName(countSrc.nodeId, countSrc.portId) : '0';
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
      s => `  const ${s.scratchVarName} = new Array(nSz_${s.nbrId});`,
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
