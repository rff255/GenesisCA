import { memo, useCallback, useState, useMemo, useSyncExternalStore } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import { getNodeDef } from './nodes/registry';
import { detectMissingConfig } from './nodes/nodeValidation';
import { handleId } from './types';
import type { NodeConfig } from './types';
import type { MacroPort } from '../../model/types';
import { useModel } from '../../model/ModelContext';
import {
  isConnectingGlobal,
  showPortLabelsGlobal,
  subscribeShowPortLabels,
  connectingFrom,
  subscribeConnectedHandles,
  getConnectedHandlesForNode,
} from './graphState';
import styles from './CaNode.module.css';

/** Returns dark text for light backgrounds, white text for dark backgrounds */
function textColorForBg(bgHex: string): string {
  const hex = bgHex.replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#1e2a3a' : '#ffffff';
}

/** Light-colored node backgrounds need a visible border instead of the bg color */
function borderColorFor(bgHex: string): string {
  const hex = bgHex.replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#b0b8c0' : bgHex;
}

interface CaNodeData {
  nodeType: string;
  config: NodeConfig;
  [key: string]: unknown;
}

function CaNodeComponent({ id, data }: NodeProps) {
  const nodeData = data as CaNodeData;
  const def = getNodeDef(nodeData.nodeType);
  const { model, updateMacro } = useModel();
  const { updateNodeData } = useReactFlow();
  // Subscribe to port-label toggle so memoized CaNodes re-render when it changes
  const showPortLabels = useSyncExternalStore(subscribeShowPortLabels, () => showPortLabelsGlobal);

  const updateConfig = useCallback(
    (key: string, value: string | number | boolean) => {
      const newConfig = { ...nodeData.config, [key]: value };
      // Reset constValue when constType changes to prevent stale values
      if (key === 'constType') {
        switch (value) {
          case 'bool':    newConfig.constValue = 'false'; break;
          case 'integer': newConfig.constValue = '0'; break;
          case 'float':   newConfig.constValue = '0'; break;
          case 'tag':     newConfig.constValue = '0'; newConfig.tagAttributeId = ''; break;
        }
      }
      updateNodeData(id, { ...nodeData, config: newConfig });
    },
    [id, nodeData, updateNodeData],
  );

  // --- Port editing callbacks for MacroInput/MacroOutput ---
  const macroDefIdForBoundary =
    (nodeData.nodeType === 'macroInput' || nodeData.nodeType === 'macroOutput')
      ? (nodeData.config.macroDefId as string)
      : '';
  const macroDefForBoundary = macroDefIdForBoundary
    ? (model.macroDefs || []).find(m => m.id === macroDefIdForBoundary)
    : undefined;

  const isMacroInput = nodeData.nodeType === 'macroInput';
  const isMacroOutput = nodeData.nodeType === 'macroOutput';

  const addPort = useCallback(() => {
    if (!macroDefForBoundary || !macroDefIdForBoundary) return;
    const field = isMacroInput ? 'exposedInputs' : 'exposedOutputs';
    const existing = macroDefForBoundary[field];
    const prefix = isMacroInput ? 'in' : 'out';
    const uid = `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const newPort: MacroPort = {
      portId: uid,
      label: `${isMacroInput ? 'Input' : 'Output'} ${existing.length + 1}`,
      dataType: 'any',
      category: 'value',
      internalNodeId: id,
      internalPortId: uid,
    };
    updateMacro(macroDefIdForBoundary, { [field]: [...existing, newPort] });
  }, [macroDefForBoundary, macroDefIdForBoundary, isMacroInput, id, updateMacro]);

  const removePort = useCallback((portId: string) => {
    if (!macroDefForBoundary || !macroDefIdForBoundary) return;
    const field = isMacroInput ? 'exposedInputs' : 'exposedOutputs';
    updateMacro(macroDefIdForBoundary, {
      [field]: macroDefForBoundary[field].filter(p => p.portId !== portId),
    });
  }, [macroDefForBoundary, macroDefIdForBoundary, isMacroInput, updateMacro]);

  const renamePort = useCallback((portId: string, newLabel: string) => {
    if (!macroDefForBoundary || !macroDefIdForBoundary) return;
    const field = isMacroInput ? 'exposedInputs' : 'exposedOutputs';
    updateMacro(macroDefIdForBoundary, {
      [field]: macroDefForBoundary[field].map(p =>
        p.portId === portId ? { ...p, label: newLabel } : p,
      ),
    });
  }, [macroDefForBoundary, macroDefIdForBoundary, isMacroInput, updateMacro]);

  const changePortCategory = useCallback((portId: string, cat: 'value' | 'flow') => {
    if (!macroDefForBoundary || !macroDefIdForBoundary) return;
    const field = isMacroInput ? 'exposedInputs' : 'exposedOutputs';
    updateMacro(macroDefIdForBoundary, {
      [field]: macroDefForBoundary[field].map(p =>
        p.portId === portId ? { ...p, category: cat } : p,
      ),
    });
  }, [macroDefForBoundary, macroDefIdForBoundary, isMacroInput, updateMacro]);

  if (!def) return <div className={styles.node}>Unknown node type</div>;

  // Dynamic port generation for macro nodes
  let inputPorts = def.ports.filter(p => p.kind === 'input');
  let outputPorts = def.ports.filter(p => p.kind === 'output');

  if (nodeData.nodeType === 'macro') {
    const macroDefId = nodeData.config.macroDefId as string;
    const macroDef = (model.macroDefs || []).find(m => m.id === macroDefId);
    if (macroDef) {
      inputPorts = macroDef.exposedInputs.map(p => ({
        id: p.portId,
        label: p.label,
        kind: 'input' as const,
        category: p.category || 'value' as const,
        dataType: (p.dataType || 'any') as 'any',
      }));
      outputPorts = macroDef.exposedOutputs.map(p => ({
        id: p.portId,
        label: p.label,
        kind: 'output' as const,
        category: p.category || 'value' as const,
        dataType: (p.dataType || 'any') as 'any',
      }));
    }
  }

  // MacroInput: output ports from exposedInputs (data flows into subgraph)
  if (nodeData.nodeType === 'macroInput') {
    const macroDefId = nodeData.config.macroDefId as string;
    const macroDef = (model.macroDefs || []).find(m => m.id === macroDefId);
    if (macroDef) {
      inputPorts = [];
      outputPorts = macroDef.exposedInputs.map(p => ({
        id: p.portId,
        label: p.label,
        kind: 'output' as const,
        category: p.category || 'value' as const,
        dataType: (p.dataType || 'any') as 'any',
      }));
    }
  }

  // MacroOutput: input ports from exposedOutputs (data flows out of subgraph)
  if (nodeData.nodeType === 'macroOutput') {
    const macroDefId = nodeData.config.macroDefId as string;
    const macroDef = (model.macroDefs || []).find(m => m.id === macroDefId);
    if (macroDef) {
      inputPorts = macroDef.exposedOutputs.map(p => ({
        id: p.portId,
        label: p.label,
        kind: 'input' as const,
        category: p.category || 'value' as const,
        dataType: (p.dataType || 'any') as 'any',
      }));
      outputPorts = [];
    }
  }

  // Switch: dynamic ports based on mode + caseCount
  if (nodeData.nodeType === 'switch') {
    const switchMode = (nodeData.config.mode as string) || 'conditions';
    const valType = (nodeData.config.valueType as string) || 'integer';
    const caseCount = Number(nodeData.config.caseCount) || 0;

    if (switchMode === 'conditions') {
      // No value input in conditions mode
      inputPorts = inputPorts.filter(p => p.id !== 'value');
      for (let i = 0; i < caseCount; i++) {
        inputPorts.push({
          id: `case_${i}_cond`, label: `Case ${i}`,
          kind: 'input' as const, category: 'value' as const,
          dataType: 'bool' as const, inlineWidget: 'bool', defaultValue: 'false',
        });
        outputPorts.push({
          id: `case_${i}`, label: `Case ${i}`,
          kind: 'output' as const, category: 'flow' as const,
        });
      }
    } else {
      // "by value" mode
      if (valType === 'tag') {
        // Tag mode: value input uses tag inline widget, cases are tag option selects (no input port)
        const tagAttrId = nodeData.config.tagAttributeId as string;
        const tagAttr = model.attributes.find(a => a.id === tagAttrId);
        const tagOpts = tagAttr?.tagOptions || [];
        // Override the value port's inline widget to tag
        inputPorts = inputPorts.map(p => p.id === 'value'
          ? { ...p, inlineWidget: 'tag' as const, dataType: 'any' as const }
          : p);
        for (let i = 0; i < caseCount; i++) {
          const tagIdx = Number(nodeData.config[`case_${i}_value`]) || 0;
          const tagName = tagOpts[tagIdx] ?? `#${tagIdx}`;
          outputPorts.push({
            id: `case_${i}`, label: tagName,
            kind: 'output' as const, category: 'flow' as const,
          });
        }
      } else {
        // Integer/Float mode: per-case comparison op + value input port
        for (let i = 0; i < caseCount; i++) {
          inputPorts.push({
            id: `case_${i}_val`, label: `Case ${i}`,
            kind: 'input' as const, category: 'value' as const,
            dataType: 'any' as const, inlineWidget: 'number', defaultValue: '0',
          });
          outputPorts.push({
            id: `case_${i}`, label: `Case ${i}`,
            kind: 'output' as const, category: 'flow' as const,
          });
        }
      }
    }
  }

  // GetModelAttribute: show R/G/B ports for color attrs, Value port for others
  if (nodeData.nodeType === 'getModelAttribute') {
    const isColor = nodeData.config.isColorAttr;
    outputPorts = outputPorts.filter(p =>
      isColor ? (p.id === 'r' || p.id === 'g' || p.id === 'b') : p.id === 'value',
    );
  }

  // LogicOperator: hide port B when operation is NOT (unary)
  if (nodeData.nodeType === 'logicOperator' && nodeData.config.operation === 'NOT') {
    inputPorts = inputPorts.filter(p => p.id !== 'b');
  }

  // UpdateAttribute: hide value port for unary operations (toggle, next, previous)
  if (nodeData.nodeType === 'updateAttribute') {
    const op = nodeData.config.operation as string;
    if (op === 'toggle' || op === 'next' || op === 'previous') {
      inputPorts = inputPorts.filter(p => p.id !== 'value');
    }
  }

  // GetRandom: show probability port only when randomType is 'bool'
  if (nodeData.nodeType === 'getRandom' && nodeData.config.randomType !== 'bool') {
    inputPorts = inputPorts.filter(p => p.id !== 'probability');
  }

  // Statement (Compare): hide y2 unless operation is a between-family op
  if (nodeData.nodeType === 'statement') {
    const stOp = nodeData.config.operation as string;
    if (stOp !== 'between' && stOp !== 'notBetween') {
      inputPorts = inputPorts.filter(p => p.id !== 'y2');
    }
  }

  // GroupCounting (Count Matching): hide compareHigh unless operation is a between-family op
  if (nodeData.nodeType === 'groupCounting') {
    const gcOp = nodeData.config.operation as string;
    if (gcOp !== 'between' && gcOp !== 'notBetween') {
      inputPorts = inputPorts.filter(p => p.id !== 'compareHigh');
    }
  }

  // Detect which input ports are connected (for inline widget visibility).
  // Uses a graph-level pub/sub in graphState.ts instead of useStore(edges) so this node only
  // re-renders when *its* connected handles actually change (not on every pan/zoom/store event).
  const connectedInputHandles = useSyncExternalStore(
    subscribeConnectedHandles,
    () => getConnectedHandlesForNode(id),
  );

  // Build a map of all port definitions for inline widget lookup
  const allInputPortDefs = useMemo(() => {
    if (!def) return new Map<string, typeof inputPorts[0]>();
    return new Map(def.ports.filter(p => p.kind === 'input').map(p => [p.id, p]));
  }, [def]);

  // Detect missing required config (shown as a warning badge in the node header)
  const configIssues = useMemo(
    () => detectMissingConfig(nodeData.nodeType, nodeData.config, model),
    [
      nodeData.nodeType,
      nodeData.config,
      model.attributes,
      model.neighborhoods,
      model.mappings,
      model.indicators,
      model.macroDefs,
    ],
  );

  const userLabel = nodeData.label as string | undefined;
  const isCollapsed = !!nodeData.isCollapsed;

  // Hover-to-uncollapse: temporarily expand when a connection is being dragged over
  const [hoverExpand, setHoverExpand] = useState(false);
  const onMouseEnter = useCallback(() => {
    if (isCollapsed && isConnectingGlobal) setHoverExpand(true);
  }, [isCollapsed]);
  const onMouseLeave = useCallback(() => {
    if (hoverExpand) setHoverExpand(false);
  }, [hoverExpand]);

  /** Prevent mouseDown on inputs/selects from initiating a node drag (LMB only, let RMB through for pan) */
  const stopDrag = useCallback((e: React.MouseEvent) => {
    if (e.button === 0) e.stopPropagation();
  }, []);
  /** Stop all propagation (for double-click, click handlers) */
  const stopAll = useCallback((e: React.MouseEvent) => e.stopPropagation(), []);

  const showExpanded = !isCollapsed || hoverExpand;

  const isCompact = nodeData.nodeType === 'step'
    || nodeData.nodeType === 'conditional'
    || nodeData.nodeType === 'sequence';

  // Dynamic height to fit all ports (compact flow nodes use tighter spacing)
  const maxPorts = Math.max(inputPorts.length, outputPorts.length);
  const portSpacing = isCompact ? 16 : 22;
  const nodeMinHeight = showExpanded ? Math.max(50, 24 + maxPorts * portSpacing + 6) : undefined;

  // --- Collapsed rendering ---
  if (!showExpanded) {
    const isConstant = nodeData.nodeType === 'getConstant';
    const isColorConstant = nodeData.nodeType === 'getColorConstant';
    const totalInputs = inputPorts.length;
    const totalOutputs = outputPorts.length;

    // Display text for collapsed node — user label always takes priority
    let collapsedLabel: string;
    if (userLabel) {
      collapsedLabel = userLabel;
    } else if (isConstant) {
      const cType = nodeData.config.constType as string;
      const cVal = nodeData.config.constValue as string;
      if (cType === 'bool') collapsedLabel = cVal === 'true' ? 'True' : 'False';
      else if (cType === 'tag') {
        const tagAttr = model.attributes.find(a => a.id === nodeData.config.tagAttributeId);
        const tagIdx = parseInt(cVal, 10) || 0;
        collapsedLabel = tagAttr?.tagOptions?.[tagIdx] ?? (cVal || '0');
      }
      else collapsedLabel = cVal || '0';
    } else if (nodeData.nodeType === 'getCellAttribute') {
      const attr = model.attributes.find(a => a.id === nodeData.config.attributeId);
      collapsedLabel = attr ? `Cell - ${attr.name}` : def.label;
    } else if (nodeData.nodeType === 'getModelAttribute') {
      const attr = model.attributes.find(a => a.id === nodeData.config.attributeId);
      collapsedLabel = attr ? `Model - ${attr.name}` : def.label;
    } else if (nodeData.nodeType === 'setAttribute') {
      const attr = model.attributes.find(a => a.id === nodeData.config.attributeId);
      if (attr) {
        const valConnected = connectedInputHandles.has(handleId({ id: 'value', kind: 'input', category: 'value' }));
        const inlineVal = nodeData.config._port_value as string | undefined;
        if (!valConnected && inlineVal !== undefined) {
          let displayVal: string = inlineVal;
          if (attr.type === 'tag') {
            const tagIdx = parseInt(inlineVal, 10) || 0;
            displayVal = attr.tagOptions?.[tagIdx] ?? inlineVal;
          } else if (attr.type === 'bool') {
            displayVal = inlineVal === 'true' || inlineVal === '1' ? 'True' : 'False';
          }
          collapsedLabel = `Set ${attr.name} = ${displayVal}`;
        } else {
          collapsedLabel = `Set - ${attr.name}`;
        }
      } else { collapsedLabel = def.label; }
    } else if (nodeData.nodeType === 'updateAttribute') {
      const attr = model.attributes.find(a => a.id === nodeData.config.attributeId);
      const op = (nodeData.config.operation as string) || 'increment';
      const opLabels: Record<string, string> = {
        increment: '+', decrement: '-', max: 'Max', min: 'Min',
        toggle: 'Toggle', or: 'OR', and: 'AND',
        next: 'Next', previous: 'Prev',
      };
      collapsedLabel = attr ? `${opLabels[op] ?? op} ${attr.name}` : def.label;
    } else if (nodeData.nodeType === 'getNeighborsAttribute' || nodeData.nodeType === 'getNeighborAttributeByIndex' || nodeData.nodeType === 'getNeighborsAttrByIndexes') {
      const attr = model.attributes.find(a => a.id === nodeData.config.attributeId);
      const nbr = model.neighborhoods.find(n => n.id === nodeData.config.neighborhoodId);
      collapsedLabel = attr && nbr ? `${nbr.name}[${attr.name}]` : def.label;
    } else if (nodeData.nodeType === 'setNeighborhoodAttribute' || nodeData.nodeType === 'setNeighborAttributeByIndex') {
      const attr = model.attributes.find(a => a.id === nodeData.config.attributeId);
      const nbr = model.neighborhoods.find(n => n.id === nodeData.config.neighborhoodId);
      collapsedLabel = attr && nbr ? `Set ${nbr.name}[${attr.name}]` : def.label;
    } else if (nodeData.nodeType === 'setColorViewer') {
      const mapping = model.mappings.find(m => m.id === nodeData.config.mappingId);
      collapsedLabel = mapping ? `Set A\u2192C - ${mapping.name}` : def.label;
    } else if (nodeData.nodeType === 'inputColor') {
      const mapping = model.mappings.find(m => m.id === nodeData.config.mappingId);
      collapsedLabel = mapping ? `C\u2192A: ${mapping.name}` : def.label;
    } else if (nodeData.nodeType === 'outputMapping') {
      const mapping = model.mappings.find(m => m.id === nodeData.config.mappingId);
      collapsedLabel = mapping ? `A\u2192C: ${mapping.name}` : def.label;
    } else if (nodeData.nodeType === 'getIndicator') {
      const ind = (model.indicators || []).find(i => i.id === nodeData.config.indicatorId);
      collapsedLabel = ind ? `Ind - ${ind.name}` : def.label;
    } else if (nodeData.nodeType === 'setIndicator') {
      const ind = (model.indicators || []).find(i => i.id === nodeData.config.indicatorId);
      collapsedLabel = ind ? `Set Ind - ${ind.name}` : def.label;
    } else if (nodeData.nodeType === 'updateIndicator') {
      const ind = (model.indicators || []).find(i => i.id === nodeData.config.indicatorId);
      collapsedLabel = ind ? `Upd Ind - ${ind.name}` : def.label;
    } else if (nodeData.nodeType === 'statement') {
      const op = (nodeData.config.operation as string) || '==';
      const xConn = connectedInputHandles.has(handleId({ id: 'x', kind: 'input', category: 'value' }));
      const yConn = connectedInputHandles.has(handleId({ id: 'y', kind: 'input', category: 'value' }));
      const xVal = xConn ? '?' : ((nodeData.config._port_x as string) ?? '0');
      const yVal = yConn ? '?' : ((nodeData.config._port_y as string) ?? '0');
      if (op === 'between' || op === 'notBetween') {
        const y2Conn = connectedInputHandles.has(handleId({ id: 'y2', kind: 'input', category: 'value' }));
        const y2Val = y2Conn ? '?' : ((nodeData.config._port_y2 as string) ?? '0');
        const verb = op === 'notBetween' ? 'out' : 'in';
        collapsedLabel = `${xVal} ${verb} [${yVal}..${y2Val}]`;
      } else {
        collapsedLabel = `${xVal} ${op} ${yVal}`;
      }
    } else if (nodeData.nodeType === 'arithmeticOperator') {
      const op = (nodeData.config.operation as string) || '+';
      const xConn = connectedInputHandles.has(handleId({ id: 'x', kind: 'input', category: 'value' }));
      const yConn = connectedInputHandles.has(handleId({ id: 'y', kind: 'input', category: 'value' }));
      const xVal = xConn ? '?' : ((nodeData.config._port_x as string) ?? '0');
      const yVal = yConn ? '?' : ((nodeData.config._port_y as string) ?? '0');
      const unary = op === 'sqrt' || op === 'abs';
      collapsedLabel = unary ? `${op}(${xVal})` : `${xVal} ${op} ${yVal}`;
    } else if (nodeData.nodeType === 'logicOperator') {
      collapsedLabel = (nodeData.config.operation as string) || 'OR';
    } else if (nodeData.nodeType === 'groupStatement') {
      const op = (nodeData.config.operation as string) || 'allIs';
      const opLabels: Record<string, string> = {
        allIs: 'All Is', noneIs: 'None Is', hasA: 'Has A',
        allGreater: 'All >', allLesser: 'All <',
        anyGreater: 'Any >', anyLesser: 'Any <',
      };
      const xConn = connectedInputHandles.has(handleId({ id: 'x', kind: 'input', category: 'value' }));
      const xVal = xConn ? '?' : ((nodeData.config._port_x as string) ?? '0');
      collapsedLabel = `${opLabels[op] ?? op} ${xVal}`;
    } else if (nodeData.nodeType === 'groupCounting') {
      const op = (nodeData.config.operation as string) || 'equals';
      const opLabels: Record<string, string> = {
        equals: '==', notEquals: '!=', greater: '>', lesser: '<',
      };
      const cmpConn = connectedInputHandles.has(handleId({ id: 'compare', kind: 'input', category: 'value' }));
      const cmpVal = cmpConn ? '?' : ((nodeData.config._port_compare as string) ?? '0');
      if (op === 'between' || op === 'notBetween') {
        const highConn = connectedInputHandles.has(handleId({ id: 'compareHigh', kind: 'input', category: 'value' }));
        const highVal = highConn ? '?' : ((nodeData.config._port_compareHigh as string) ?? '0');
        const verb = op === 'notBetween' ? 'out' : 'in';
        collapsedLabel = `Count ${verb} [${cmpVal}..${highVal}]`;
      } else {
        collapsedLabel = `Count ${opLabels[op] ?? op} ${cmpVal}`;
      }
    } else if (nodeData.nodeType === 'groupOperator') {
      const op = (nodeData.config.operation as string) || 'sum';
      const opLabels: Record<string, string> = {
        sum: 'Sum', mul: 'Product', max: 'Max', min: 'Min',
        mean: 'Mean', and: 'AND', or: 'OR', random: 'Random',
      };
      collapsedLabel = opLabels[op] ?? op;
    } else if (nodeData.nodeType === 'aggregate') {
      const op = (nodeData.config.operation as string) || 'sum';
      const opLabels: Record<string, string> = {
        sum: 'Sum', product: 'Product', max: 'Max', min: 'Min',
        average: 'Average', median: 'Median', and: 'AND', or: 'OR',
      };
      collapsedLabel = opLabels[op] ?? op;
    } else if (nodeData.nodeType === 'filterNeighbors') {
      const attr = model.attributes.find(a => a.id === nodeData.config.attributeId);
      const nbr = model.neighborhoods.find(n => n.id === nodeData.config.neighborhoodId);
      const op = (nodeData.config.operation as string) || 'equals';
      const opSymbols: Record<string, string> = {
        equals: '==', notEquals: '!=', greater: '>', lesser: '<',
        greaterEqual: '>=', lesserEqual: '<=',
      };
      collapsedLabel = attr && nbr ? `Filter ${nbr.name}[${attr.name}] ${opSymbols[op] ?? op}` : def.label;
    } else if (nodeData.nodeType === 'joinNeighbors') {
      const op = (nodeData.config.operation as string) || 'intersection';
      collapsedLabel = op === 'union' ? 'Join (OR)' : 'Join (AND)';
    } else {
      collapsedLabel = def.label;
    }

    // Color swatch for collapsed color constant
    const colorSwatchHex = isColorConstant
      ? `rgb(${nodeData.config.r || 128},${nodeData.config.g || 128},${nodeData.config.b || 128})`
      : undefined;

    // Color preview dot for nodes with unconnected color inline inputs
    let collapsedColorPreview: string | undefined;
    if (nodeData.nodeType === 'setColorViewer' || nodeData.nodeType === 'colorInterpolation') {
      // Check common port IDs for color channels
      const portIds = nodeData.nodeType === 'colorInterpolation'
        ? { r: 'r1', g: 'g1', b: 'b1' }
        : { r: 'r', g: 'g', b: 'b' };
      const rConn = connectedInputHandles.has(handleId({ id: portIds.r, kind: 'input', category: 'value' }));
      const gConn = connectedInputHandles.has(handleId({ id: portIds.g, kind: 'input', category: 'value' }));
      const bConn = connectedInputHandles.has(handleId({ id: portIds.b, kind: 'input', category: 'value' }));
      if (!rConn && !gConn && !bConn) {
        const pr = parseInt(String(nodeData.config[`_port_${portIds.r}`] ?? '0'), 10);
        const pg = parseInt(String(nodeData.config[`_port_${portIds.g}`] ?? '0'), 10);
        const pb = parseInt(String(nodeData.config[`_port_${portIds.b}`] ?? '0'), 10);
        collapsedColorPreview = `rgb(${pr},${pg},${pb})`;
      }
    }

    return (
      <div
        className={`${styles.node} ${isConstant || isColorConstant ? styles.collapsedConstant : styles.collapsed}`}
        style={{ borderColor: borderColorFor(def.color) }}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      >
        {isColorConstant ? (
          <div className={styles.collapsedColorSwatch} style={{ background: colorSwatchHex }} />
        ) : (
          <div className={styles.collapsedHeader} style={{ background: def.color, color: textColorForBg(def.color) }}>
            {collapsedLabel}
            {collapsedColorPreview && (
              <span className={styles.collapsedColorDot} style={{ background: collapsedColorPreview }} />
            )}
          </div>
        )}
        {configIssues.length > 0 && (
          <div className={styles.warningBadge} title={configIssues.join('\n')}>!</div>
        )}

        {/* Handles at center — still needed for edges */}
        {inputPorts.map(port => (
          <Handle
            key={handleId(port)}
            type="target"
            position={Position.Left}
            id={handleId(port)}
            className={port.category === 'flow' ? styles.handleFlow : styles.handleValue}
            style={{ top: '50%' }}
            title={port.label}
          />
        ))}
        {outputPorts.map(port => (
          <Handle
            key={handleId(port)}
            type="source"
            position={Position.Right}
            id={handleId(port)}
            className={port.category === 'flow' ? styles.handleFlow : styles.handleValue}
            style={{ top: '50%' }}
            title={port.label}
          />
        ))}

        {/* Port count indicators */}
        {totalInputs > 1 && (
          <div className={styles.portCountIndicator} style={{ left: -2 }}>
            {totalInputs}
          </div>
        )}
        {totalOutputs > 1 && (
          <div className={styles.portCountIndicator} style={{ right: -2 }}>
            {totalOutputs}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={`${styles.node} ${isCompact ? styles.compactNode : ''}`}
      style={{ borderColor: borderColorFor(def.color), minHeight: nodeMinHeight }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {userLabel && (
        <div className={styles.userLabel}>{userLabel}</div>
      )}
      <div className={styles.header} style={{ background: def.color, color: textColorForBg(def.color) }}>
        {def.label}
      </div>
      {configIssues.length > 0 && (
        <div className={styles.warningBadge} title={configIssues.join('\n')}>!</div>
      )}
      <div className={styles.body} onDoubleClick={stopAll}>
        {/* Node-specific config UI */}
        {nodeData.nodeType === 'getCellAttribute' && (
          <select
            className={styles.select}
            value={(nodeData.config.attributeId as string) || ''}
            onChange={e => updateConfig('attributeId', e.target.value)}
          >
            <option value="">Select...</option>
            {model.attributes
              .filter(a => !a.isModelAttribute)
              .map(a => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
          </select>
        )}

        {(nodeData.nodeType === 'getNeighborsAttribute'
          || nodeData.nodeType === 'getNeighborAttributeByIndex'
          || nodeData.nodeType === 'getNeighborsAttrByIndexes'
          || nodeData.nodeType === 'setNeighborhoodAttribute'
          || nodeData.nodeType === 'setNeighborAttributeByIndex'
          || nodeData.nodeType === 'filterNeighbors') && (
          <>
            <select
              className={styles.select}
              value={(nodeData.config.neighborhoodId as string) || ''}
              onChange={e => updateConfig('neighborhoodId', e.target.value)}
            >
              <option value="">Neighborhood...</option>
              {model.neighborhoods.map(n => (
                <option key={n.id} value={n.id}>{n.name}</option>
              ))}
            </select>
            <select
              className={styles.select}
              value={(nodeData.config.attributeId as string) || ''}
              onChange={e => updateConfig('attributeId', e.target.value)}
            >
              <option value="">Attribute...</option>
              {model.attributes
                .filter(a => !a.isModelAttribute)
                .map(a => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
            </select>
          </>
        )}

        {nodeData.nodeType === 'filterNeighbors' && (
          <select
            className={styles.select}
            value={(nodeData.config.operation as string) || 'equals'}
            onChange={e => updateConfig('operation', e.target.value)}
          >
            <option value="equals">==</option>
            <option value="notEquals">!=</option>
            <option value="greater">&gt;</option>
            <option value="lesser">&lt;</option>
            <option value="greaterEqual">&gt;=</option>
            <option value="lesserEqual">&lt;=</option>
          </select>
        )}

        {nodeData.nodeType === 'joinNeighbors' && (
          <select
            className={styles.select}
            value={(nodeData.config.operation as string) || 'intersection'}
            onChange={e => updateConfig('operation', e.target.value)}
          >
            <option value="intersection">Intersection (AND)</option>
            <option value="union">Union (OR)</option>
          </select>
        )}

        {nodeData.nodeType === 'getConstant' && (
          <>
            <select
              className={styles.select}
              value={(nodeData.config.constType as string) || 'integer'}
              onChange={e => updateConfig('constType', e.target.value)}
            >
              <option value="bool">Bool</option>
              <option value="integer">Integer</option>
              <option value="float">Float</option>
              <option value="tag">Tag</option>
            </select>
            {nodeData.config.constType === 'bool' ? (
              <select
                className={styles.select}
                value={String(nodeData.config.constValue) === 'true' ? 'true' : 'false'}
                onChange={e => updateConfig('constValue', e.target.value)}
              >
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : nodeData.config.constType === 'tag' ? (
              <>
                <select
                  className={styles.select}
                  value={(nodeData.config.tagAttributeId as string) || ''}
                  onChange={e => {
                    const newConfig = { ...nodeData.config, tagAttributeId: e.target.value, constValue: '0' };
                    updateNodeData(id, { ...nodeData, config: newConfig });
                  }}
                >
                  <option value="">Tag attr...</option>
                  {model.attributes
                    .filter(a => a.type === 'tag')
                    .map(a => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                </select>
                {(() => {
                  const tagAttr = model.attributes.find(a => a.id === nodeData.config.tagAttributeId);
                  const opts = tagAttr?.tagOptions || [];
                  return opts.length > 0 ? (
                    <select
                      className={styles.select}
                      value={(nodeData.config.constValue as string) || '0'}
                      onChange={e => updateConfig('constValue', e.target.value)}
                    >
                      {opts.map((t, i) => <option key={i} value={String(i)}>{t}</option>)}
                    </select>
                  ) : null;
                })()}
              </>
            ) : (
              <input
                className={styles.input}
                type="number"
                value={(nodeData.config.constValue as string) || '0'}
                onChange={e => updateConfig('constValue', e.target.value)}
              />
            )}
          </>
        )}

        {nodeData.nodeType === 'groupCounting' && (() => {
          const op = (nodeData.config.operation as string) || 'equals';
          const isBetween = op === 'between' || op === 'notBetween';
          return (
            <>
              <select
                className={styles.select}
                value={op}
                onChange={e => updateConfig('operation', e.target.value)}
              >
                <option value="equals">==</option>
                <option value="notEquals">!=</option>
                <option value="greater">&gt;</option>
                <option value="lesser">&lt;</option>
                <option value="between">Between</option>
                <option value="notBetween">Not Between</option>
              </select>
              {isBetween && (
                <div style={{ display: 'flex', gap: 4 }}>
                  <select
                    className={styles.select}
                    style={{ flex: 1 }}
                    value={(nodeData.config.lowOp as string) || '>='}
                    onChange={e => updateConfig('lowOp', e.target.value)}
                  >
                    <option value=">=">&gt;=</option>
                    <option value=">">&gt;</option>
                  </select>
                  <select
                    className={styles.select}
                    style={{ flex: 1 }}
                    value={(nodeData.config.highOp as string) || '<='}
                    onChange={e => updateConfig('highOp', e.target.value)}
                  >
                    <option value="<=">&lt;=</option>
                    <option value="<">&lt;</option>
                  </select>
                </div>
              )}
            </>
          );
        })()}

        {nodeData.nodeType === 'statement' && (() => {
          const op = (nodeData.config.operation as string) || '==';
          const isBetween = op === 'between' || op === 'notBetween';
          return (
            <>
              <select
                className={styles.select}
                value={op}
                onChange={e => updateConfig('operation', e.target.value)}
              >
                <option value="==">==</option>
                <option value="!=">!=</option>
                <option value=">">&gt;</option>
                <option value="<">&lt;</option>
                <option value=">=">&gt;=</option>
                <option value="<=">&lt;=</option>
                <option value="between">Between</option>
                <option value="notBetween">Not Between</option>
              </select>
              {isBetween && (
                <div style={{ display: 'flex', gap: 4 }}>
                  <select
                    className={styles.select}
                    style={{ flex: 1 }}
                    value={(nodeData.config.lowOp as string) || '>='}
                    onChange={e => updateConfig('lowOp', e.target.value)}
                  >
                    <option value=">=">&gt;=</option>
                    <option value=">">&gt;</option>
                  </select>
                  <select
                    className={styles.select}
                    style={{ flex: 1 }}
                    value={(nodeData.config.highOp as string) || '<='}
                    onChange={e => updateConfig('highOp', e.target.value)}
                  >
                    <option value="<=">&lt;=</option>
                    <option value="<">&lt;</option>
                  </select>
                </div>
              )}
            </>
          );
        })()}

        {nodeData.nodeType === 'logicOperator' && (
          <select
            className={styles.select}
            value={(nodeData.config.operation as string) || 'OR'}
            onChange={e => updateConfig('operation', e.target.value)}
          >
            <option value="AND">AND</option>
            <option value="OR">OR</option>
            <option value="XOR">XOR</option>
            <option value="NOT">NOT</option>
          </select>
        )}

        {nodeData.nodeType === 'setAttribute' && (
          <select
            className={styles.select}
            value={(nodeData.config.attributeId as string) || ''}
            onChange={e => updateConfig('attributeId', e.target.value)}
          >
            <option value="">Select...</option>
            {model.attributes
              .filter(a => !a.isModelAttribute)
              .map(a => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
          </select>
        )}

        {nodeData.nodeType === 'updateAttribute' && (() => {
          const selAttr = model.attributes.find(a => a.id === nodeData.config.attributeId);
          const dt = selAttr?.type || 'integer';
          const opsByType: Record<string, Array<{ value: string; label: string }>> = {
            bool: [{ value: 'toggle', label: 'Toggle' }, { value: 'or', label: 'OR' }, { value: 'and', label: 'AND' }],
            integer: [{ value: 'increment', label: 'Increment (+)' }, { value: 'decrement', label: 'Decrement (-)' }, { value: 'max', label: 'Max' }, { value: 'min', label: 'Min' }],
            float: [{ value: 'increment', label: 'Increment (+)' }, { value: 'decrement', label: 'Decrement (-)' }, { value: 'max', label: 'Max' }, { value: 'min', label: 'Min' }],
            tag: [{ value: 'next', label: 'Next' }, { value: 'previous', label: 'Previous' }],
          };
          const ops = opsByType[dt] ?? opsByType.integer!;
          return (
            <>
              <select
                className={styles.select}
                value={(nodeData.config.attributeId as string) || ''}
                onChange={e => {
                  const attr = model.attributes.find(a => a.id === e.target.value);
                  const newDt = attr?.type || 'integer';
                  const firstOp = (opsByType[newDt] ?? opsByType.integer)![0]!.value;
                  const newConfig: NodeConfig = { ...nodeData.config, attributeId: e.target.value, operation: firstOp };
                  if (newDt === 'tag' && attr?.tagOptions) {
                    newConfig._tagLen = attr.tagOptions.length;
                  }
                  updateNodeData(id, { ...nodeData, config: newConfig });
                }}
              >
                <option value="">Select...</option>
                {model.attributes
                  .filter(a => !a.isModelAttribute)
                  .map(a => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
              </select>
              <select
                className={styles.select}
                value={(nodeData.config.operation as string) || ops![0]!.value}
                onChange={e => updateConfig('operation', e.target.value)}
              >
                {ops!.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </>
          );
        })()}

        {(nodeData.nodeType === 'getIndicator' || nodeData.nodeType === 'setIndicator') && (
          <select
            className={styles.select}
            value={(nodeData.config.indicatorId as string) || ''}
            onChange={e => updateConfig('indicatorId', e.target.value)}
          >
            <option value="">Select...</option>
            {(model.indicators || [])
              .filter(i => i.kind === 'standalone')
              .map(i => (
                <option key={i.id} value={i.id}>{i.name}</option>
              ))}
          </select>
        )}

        {nodeData.nodeType === 'updateIndicator' && (() => {
          const selInd = (model.indicators || []).find(i => i.id === nodeData.config.indicatorId);
          const dt = selInd?.dataType || 'integer';
          const opsByType: Record<string, Array<{ value: string; label: string }>> = {
            bool: [{ value: 'toggle', label: 'Toggle' }, { value: 'or', label: 'OR' }, { value: 'and', label: 'AND' }],
            integer: [{ value: 'increment', label: 'Increment (+)' }, { value: 'decrement', label: 'Decrement (-)' }, { value: 'max', label: 'Max' }, { value: 'min', label: 'Min' }],
            float: [{ value: 'increment', label: 'Increment (+)' }, { value: 'decrement', label: 'Decrement (-)' }, { value: 'max', label: 'Max' }, { value: 'min', label: 'Min' }],
            tag: [{ value: 'next', label: 'Next' }, { value: 'previous', label: 'Previous' }],
          };
          const ops = opsByType[dt] ?? opsByType.integer!;
          return (
            <>
              <select
                className={styles.select}
                value={(nodeData.config.indicatorId as string) || ''}
                onChange={e => {
                  const ind = (model.indicators || []).find(i => i.id === e.target.value);
                  const newDt = ind?.dataType || 'integer';
                  const firstOp = (opsByType[newDt] ?? opsByType.integer)![0]!.value;
                  const newConfig: NodeConfig = { ...nodeData.config, indicatorId: e.target.value, operation: firstOp };
                  if (newDt === 'tag' && ind?.tagOptions) {
                    newConfig._tagLen = ind.tagOptions.length;
                  }
                  updateNodeData(id, { ...nodeData, config: newConfig });
                }}
              >
                <option value="">Select...</option>
                {(model.indicators || [])
                  .filter(i => i.kind === 'standalone')
                  .map(i => (
                    <option key={i.id} value={i.id}>{i.name}</option>
                  ))}
              </select>
              <select
                className={styles.select}
                value={(nodeData.config.operation as string) || ops![0]!.value}
                onChange={e => updateConfig('operation', e.target.value)}
              >
                {ops!.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </>
          );
        })()}

        {nodeData.nodeType === 'setColorViewer' && (() => {
          const allRgbConnected =
            connectedInputHandles.has(handleId({ id: 'r', kind: 'input', category: 'value' })) &&
            connectedInputHandles.has(handleId({ id: 'g', kind: 'input', category: 'value' })) &&
            connectedInputHandles.has(handleId({ id: 'b', kind: 'input', category: 'value' }));
          const pr = parseInt(String(nodeData.config._port_r ?? '0'), 10) || 0;
          const pg = parseInt(String(nodeData.config._port_g ?? '0'), 10) || 0;
          const pb = parseInt(String(nodeData.config._port_b ?? '0'), 10) || 0;
          const hex = `#${Math.min(255, Math.max(0, pr)).toString(16).padStart(2, '0')}${Math.min(255, Math.max(0, pg)).toString(16).padStart(2, '0')}${Math.min(255, Math.max(0, pb)).toString(16).padStart(2, '0')}`;
          return (
            <>
              <select
                className={styles.select}
                value={(nodeData.config.mappingId as string) || ''}
                onChange={e => updateConfig('mappingId', e.target.value)}
              >
                <option value="">Select Mapping...</option>
                {model.mappings
                  .filter(m => m.isAttributeToColor)
                  .map(m => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
              </select>
              {!allRgbConnected && (
                <input
                  type="color"
                  className={styles.input}
                  style={{ height: 24, padding: 1, cursor: 'pointer' }}
                  value={hex}
                  onChange={e => {
                    const h = e.target.value;
                    const nr = parseInt(h.slice(1, 3), 16);
                    const ng = parseInt(h.slice(3, 5), 16);
                    const nb = parseInt(h.slice(5, 7), 16);
                    updateNodeData(id, {
                      ...nodeData,
                      config: { ...nodeData.config, _port_r: String(nr), _port_g: String(ng), _port_b: String(nb) },
                    });
                  }}
                  onClick={e => e.stopPropagation()}
                  title="Default color (overridden per-channel by connections)"
                />
              )}
            </>
          );
        })()}

        {nodeData.nodeType === 'inputColor' && (
          <select
            className={styles.select}
            value={(nodeData.config.mappingId as string) || ''}
            onChange={e => updateConfig('mappingId', e.target.value)}
          >
            <option value="">Select Mapping...</option>
            {model.mappings
              .filter(m => !m.isAttributeToColor)
              .map(m => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
          </select>
        )}

        {nodeData.nodeType === 'outputMapping' && (
          <select
            className={styles.select}
            value={(nodeData.config.mappingId as string) || ''}
            onChange={e => updateConfig('mappingId', e.target.value)}
          >
            <option value="">Select Mapping...</option>
            {model.mappings
              .filter(m => m.isAttributeToColor)
              .map(m => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
          </select>
        )}

        {nodeData.nodeType === 'getModelAttribute' && (
          <select
            className={styles.select}
            value={(nodeData.config.attributeId as string) || ''}
            onChange={e => {
              const attrId = e.target.value;
              const attr = model.attributes.find(a => a.id === attrId);
              const newConfig = { ...nodeData.config, attributeId: attrId, isColorAttr: attr?.type === 'color' };
              updateNodeData(id, { ...nodeData, config: newConfig });
            }}
          >
            <option value="">Select...</option>
            {model.attributes
              .filter(a => a.isModelAttribute)
              .map(a => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
          </select>
        )}

        {nodeData.nodeType === 'stopEvent' && (
          <input
            className={styles.input}
            placeholder="Stop message..."
            value={(nodeData.config.message as string) ?? ''}
            onChange={e => updateConfig('message', e.target.value)}
            onMouseDown={stopDrag}
            onDoubleClick={stopAll}
            title="Shown in the simulator when this flow fires and pauses the run."
          />
        )}

        {nodeData.nodeType === 'tagConstant' && (
          <>
            <select
              className={styles.select}
              value={(nodeData.config.attributeId as string) || ''}
              onChange={e => updateConfig('attributeId', e.target.value)}
            >
              <option value="">Attr...</option>
              {model.attributes
                .filter(a => a.type === 'tag')
                .map(a => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
            </select>
            {(() => {
              const tagAttr = model.attributes.find(a => a.id === nodeData.config.attributeId);
              const opts = tagAttr?.tagOptions || [];
              return opts.length > 0 ? (
                <select
                  className={styles.select}
                  value={String(nodeData.config.tagIndex ?? 0)}
                  onChange={e => updateConfig('tagIndex', Number(e.target.value))}
                >
                  {opts.map((t, i) => <option key={i} value={String(i)}>{t}</option>)}
                </select>
              ) : null;
            })()}
          </>
        )}

        {nodeData.nodeType === 'getRandom' && (
          <>
            <select
              className={styles.select}
              value={(nodeData.config.randomType as string) || 'float'}
              onChange={e => updateConfig('randomType', e.target.value)}
            >
              <option value="bool">Bool</option>
              <option value="integer">Integer</option>
              <option value="float">Float</option>
            </select>
            {nodeData.config.randomType !== 'bool' && (
              <>
                <input
                  className={styles.input}
                  type="number"
                  placeholder="min"
                  value={(nodeData.config.min as string) || '0'}
                  onChange={e => updateConfig('min', e.target.value)}
                />
                <input
                  className={styles.input}
                  type="number"
                  placeholder="max"
                  value={(nodeData.config.max as string) || '1'}
                  onChange={e => updateConfig('max', e.target.value)}
                />
              </>
            )}
          </>
        )}

        {nodeData.nodeType === 'getColorConstant' && (() => {
          const r = parseInt(String(nodeData.config.r ?? '128'), 10) || 0;
          const g = parseInt(String(nodeData.config.g ?? '128'), 10) || 0;
          const b = parseInt(String(nodeData.config.b ?? '128'), 10) || 0;
          const hex = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
          return (
            <>
              <input
                type="color"
                className={styles.input}
                style={{ height: 24, padding: 1, cursor: 'pointer' }}
                value={hex}
                onChange={e => {
                  const h = e.target.value;
                  const nr = parseInt(h.slice(1, 3), 16);
                  const ng = parseInt(h.slice(3, 5), 16);
                  const nb = parseInt(h.slice(5, 7), 16);
                  // Batch update r, g, b
                  updateNodeData(id, {
                    ...nodeData,
                    config: { ...nodeData.config, r: String(nr), g: String(ng), b: String(nb) },
                  });
                }}
                onClick={e => e.stopPropagation()}
              />
              <input className={styles.input} type="number" placeholder="R" min={0} max={255}
                value={(nodeData.config.r as string) || '128'}
                onChange={e => updateConfig('r', e.target.value)} />
              <input className={styles.input} type="number" placeholder="G" min={0} max={255}
                value={(nodeData.config.g as string) || '128'}
                onChange={e => updateConfig('g', e.target.value)} />
              <input className={styles.input} type="number" placeholder="B" min={0} max={255}
                value={(nodeData.config.b as string) || '128'}
                onChange={e => updateConfig('b', e.target.value)} />
            </>
          );
        })()}

        {nodeData.nodeType === 'colorInterpolation' && (() => {
          const fromConnected =
            connectedInputHandles.has(handleId({ id: 'r1', kind: 'input', category: 'value' })) &&
            connectedInputHandles.has(handleId({ id: 'g1', kind: 'input', category: 'value' })) &&
            connectedInputHandles.has(handleId({ id: 'b1', kind: 'input', category: 'value' }));
          const toConnected =
            connectedInputHandles.has(handleId({ id: 'r2', kind: 'input', category: 'value' })) &&
            connectedInputHandles.has(handleId({ id: 'g2', kind: 'input', category: 'value' })) &&
            connectedInputHandles.has(handleId({ id: 'b2', kind: 'input', category: 'value' }));
          const fr = parseInt(String(nodeData.config._port_r1 ?? '0'), 10) || 0;
          const fg = parseInt(String(nodeData.config._port_g1 ?? '0'), 10) || 0;
          const fb = parseInt(String(nodeData.config._port_b1 ?? '0'), 10) || 0;
          const tr = parseInt(String(nodeData.config._port_r2 ?? '255'), 10) || 0;
          const tg = parseInt(String(nodeData.config._port_g2 ?? '255'), 10) || 0;
          const tb = parseInt(String(nodeData.config._port_b2 ?? '255'), 10) || 0;
          const fromHex = `#${Math.min(255,Math.max(0,fr)).toString(16).padStart(2,'0')}${Math.min(255,Math.max(0,fg)).toString(16).padStart(2,'0')}${Math.min(255,Math.max(0,fb)).toString(16).padStart(2,'0')}`;
          const toHex = `#${Math.min(255,Math.max(0,tr)).toString(16).padStart(2,'0')}${Math.min(255,Math.max(0,tg)).toString(16).padStart(2,'0')}${Math.min(255,Math.max(0,tb)).toString(16).padStart(2,'0')}`;
          return (
            <>
              {!fromConnected && (
                <>
                  <span style={{ fontSize: '0.6rem', color: '#8090a0' }}>Color From</span>
                  <input
                    type="color" className={styles.input}
                    style={{ height: 24, padding: 1, cursor: 'pointer' }}
                    value={fromHex}
                    onChange={e => {
                      const h = e.target.value;
                      updateNodeData(id, { ...nodeData, config: { ...nodeData.config,
                        _port_r1: String(parseInt(h.slice(1,3),16)),
                        _port_g1: String(parseInt(h.slice(3,5),16)),
                        _port_b1: String(parseInt(h.slice(5,7),16)),
                      }});
                    }}
                    onClick={e => e.stopPropagation()}
                  />
                </>
              )}
              {!toConnected && (
                <>
                  <span style={{ fontSize: '0.6rem', color: '#8090a0' }}>Color To</span>
                  <input
                    type="color" className={styles.input}
                    style={{ height: 24, padding: 1, cursor: 'pointer' }}
                    value={toHex}
                    onChange={e => {
                      const h = e.target.value;
                      updateNodeData(id, { ...nodeData, config: { ...nodeData.config,
                        _port_r2: String(parseInt(h.slice(1,3),16)),
                        _port_g2: String(parseInt(h.slice(3,5),16)),
                        _port_b2: String(parseInt(h.slice(5,7),16)),
                      }});
                    }}
                    onClick={e => e.stopPropagation()}
                  />
                </>
              )}
            </>
          );
        })()}

        {nodeData.nodeType === 'arithmeticOperator' && (
          <select
            className={styles.select}
            value={(nodeData.config.operation as string) || '+'}
            onChange={e => updateConfig('operation', e.target.value)}
          >
            <option value="+">+ Add</option>
            <option value="-">- Subtract</option>
            <option value="*">* Multiply</option>
            <option value="/">/ Divide</option>
            <option value="%">% Modulo</option>
            <option value="sqrt">Sqrt</option>
            <option value="pow">Power</option>
            <option value="abs">Abs</option>
            <option value="max">Max</option>
            <option value="min">Min</option>
            <option value="mean">Mean</option>
          </select>
        )}

        {nodeData.nodeType === 'groupStatement' && (
          <select
            className={styles.select}
            value={(nodeData.config.operation as string) || 'allIs'}
            onChange={e => updateConfig('operation', e.target.value)}
          >
            <option value="allIs">All Is</option>
            <option value="noneIs">None Is</option>
            <option value="hasA">Has A</option>
            <option value="allGreater">All Greater</option>
            <option value="allLesser">All Lesser</option>
            <option value="anyGreater">Any Greater</option>
            <option value="anyLesser">Any Lesser</option>
          </select>
        )}

        {nodeData.nodeType === 'groupOperator' && (
          <select
            className={styles.select}
            value={(nodeData.config.operation as string) || 'sum'}
            onChange={e => updateConfig('operation', e.target.value)}
          >
            <option value="sum">Sum</option>
            <option value="mul">Multiply</option>
            <option value="max">Max</option>
            <option value="min">Min</option>
            <option value="mean">Mean</option>
            <option value="and">AND (all)</option>
            <option value="or">OR (any)</option>
            <option value="random">Pick Random</option>
          </select>
        )}

        {nodeData.nodeType === 'aggregate' && (
          <select
            className={styles.select}
            value={(nodeData.config.operation as string) || 'sum'}
            onChange={e => updateConfig('operation', e.target.value)}
          >
            <option value="sum">Sum</option>
            <option value="product">Product</option>
            <option value="max">Max</option>
            <option value="min">Min</option>
            <option value="average">Average</option>
            <option value="median">Median</option>
            <option value="and">AND (all true)</option>
            <option value="or">OR (any true)</option>
          </select>
        )}

        {nodeData.nodeType === 'switch' && (() => {
          const switchMode = (nodeData.config.mode as string) || 'conditions';
          const valType = (nodeData.config.valueType as string) || 'integer';
          const caseCount = Number(nodeData.config.caseCount) || 0;
          const firstMatch = nodeData.config.firstMatchOnly !== false;
          const tagAttrId = nodeData.config.tagAttributeId as string;
          const tagAttr = model.attributes.find(a => a.id === tagAttrId);
          const tagOpts = tagAttr?.tagOptions || [];

          const removeCase = (i: number) => {
            const newConfig = { ...nodeData.config };
            for (let j = i; j < caseCount - 1; j++) {
              newConfig[`case_${j}_op`] = newConfig[`case_${j + 1}_op`] ?? '==';
              newConfig[`case_${j}_value`] = newConfig[`case_${j + 1}_value`] ?? '';
            }
            delete newConfig[`case_${caseCount - 1}_op`];
            delete newConfig[`case_${caseCount - 1}_value`];
            newConfig.caseCount = caseCount - 1;
            updateNodeData(id, { ...nodeData, config: newConfig });
          };

          const addCase = () => {
            const newConfig = { ...nodeData.config };
            newConfig[`case_${caseCount}_op`] = '==';
            newConfig[`case_${caseCount}_value`] = valType === 'tag' ? '0' : String(caseCount);
            newConfig.caseCount = caseCount + 1;
            updateNodeData(id, { ...nodeData, config: newConfig });
          };

          return (
            <>
              {/* Mode selector */}
              <select
                className={styles.select}
                value={switchMode}
                onChange={e => {
                  const newConfig = { ...nodeData.config, mode: e.target.value, caseCount: 0 };
                  updateNodeData(id, { ...nodeData, config: newConfig });
                }}
              >
                <option value="conditions">By Conditions</option>
                <option value="value">By Value</option>
              </select>

              {/* First match only toggle */}
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.68rem', color: '#a0b0c0', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={firstMatch}
                  onChange={e => updateConfig('firstMatchOnly', e.target.checked)}
                  style={{ cursor: 'pointer' }}
                />
                First match only
              </label>

              {/* Value mode: type selector */}
              {switchMode === 'value' && (
                <select
                  className={styles.select}
                  value={valType}
                  onChange={e => {
                    const newConfig = { ...nodeData.config, valueType: e.target.value, caseCount: 0 };
                    updateNodeData(id, { ...nodeData, config: newConfig });
                  }}
                >
                  <option value="integer">Integer</option>
                  <option value="float">Float</option>
                  <option value="tag">Tag</option>
                </select>
              )}

              {/* Value+Tag: tag attribute selector */}
              {switchMode === 'value' && valType === 'tag' && (
                <select
                  className={styles.select}
                  value={tagAttrId || ''}
                  onChange={e => {
                    const newConfig = { ...nodeData.config, tagAttributeId: e.target.value, caseCount: 0 };
                    updateNodeData(id, { ...nodeData, config: newConfig });
                  }}
                >
                  <option value="">Tag attr...</option>
                  {model.attributes
                    .filter(a => a.type === 'tag')
                    .map(a => (
                      <option key={a.id} value={a.id}>{a.name}{a.isModelAttribute ? ' (model)' : ''}</option>
                    ))}
                </select>
              )}

              {/* Per-case rows */}
              {Array.from({ length: caseCount }, (_, i) => (
                <div key={i} style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
                  {/* Case label for By Value mode */}
                  {switchMode === 'value' && (
                    <span style={{ fontSize: '0.62rem', color: '#8090a0', flexShrink: 0 }}>Case {i}</span>
                  )}
                  {/* By Value + int/float: comparison op */}
                  {switchMode === 'value' && valType !== 'tag' && (
                    <select
                      className={styles.select}
                      style={{ width: 42, flexShrink: 0 }}
                      value={(nodeData.config[`case_${i}_op`] as string) || '=='}
                      onChange={e => updateConfig(`case_${i}_op`, e.target.value)}
                    >
                      <option value="==">==</option>
                      <option value="!=">!=</option>
                      <option value=">">&gt;</option>
                      <option value="<">&lt;</option>
                      <option value=">=">&gt;=</option>
                      <option value="<=">&lt;=</option>
                    </select>
                  )}
                  {/* By Value + tag: tag option dropdown */}
                  {switchMode === 'value' && valType === 'tag' && (
                    <select
                      className={styles.select}
                      style={{ flex: 1 }}
                      value={(nodeData.config[`case_${i}_value`] as string) || '0'}
                      onChange={e => updateConfig(`case_${i}_value`, e.target.value)}
                    >
                      {tagOpts.map((t, ti) => (
                        <option key={ti} value={String(ti)}>{t}</option>
                      ))}
                      {tagOpts.length === 0 && <option value="0">(no tags)</option>}
                    </select>
                  )}
                  {/* By Conditions: just a label */}
                  {switchMode === 'conditions' && (
                    <span style={{ flex: 1, fontSize: '0.68rem', color: '#8090a0' }}>Case {i}</span>
                  )}
                  {/* Remove button */}
                  <button
                    style={{
                      background: 'none', border: 'none', color: '#f44336',
                      cursor: 'pointer', fontSize: '0.7rem', padding: '0 2px',
                    }}
                    onClick={() => removeCase(i)}
                    title="Remove case"
                  >
                    x
                  </button>
                </div>
              ))}
              <button
                className={styles.select}
                style={{ cursor: 'pointer', textAlign: 'center' }}
                onClick={addCase}
              >
                + Add Case
              </button>
            </>
          );
        })()}

        {nodeData.nodeType === 'getNeighborAttributeByTag' && (() => {
          const selNbr = model.neighborhoods.find(n => n.id === nodeData.config.neighborhoodId);
          const tags = selNbr?.tags || {};
          const tagNames = Object.values(tags);
          return (
            <>
              <select
                className={styles.select}
                value={(nodeData.config.neighborhoodId as string) || ''}
                onChange={e => updateConfig('neighborhoodId', e.target.value)}
              >
                <option value="">Neighborhood...</option>
                {model.neighborhoods.map(n => (
                  <option key={n.id} value={n.id}>{n.name}</option>
                ))}
              </select>
              <select
                className={styles.select}
                value={(nodeData.config.attributeId as string) || ''}
                onChange={e => updateConfig('attributeId', e.target.value)}
              >
                <option value="">Attribute...</option>
                {model.attributes
                  .filter(a => !a.isModelAttribute)
                  .map(a => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
              </select>
              <select
                className={styles.select}
                value={(nodeData.config.tagName as string) || ''}
                onChange={e => updateConfig('tagName', e.target.value)}
              >
                <option value="">Tag...</option>
                {tagNames.map(t => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
              {tagNames.length === 0 && selNbr && (
                <span style={{ fontSize: '0.6rem', color: '#f44336', fontStyle: 'italic' }}>
                  No tags on this neighborhood
                </span>
              )}
            </>
          );
        })()}

        {nodeData.nodeType === 'getNeighborIndexesByTags' && (() => {
          const selNbr = model.neighborhoods.find(n => n.id === nodeData.config.neighborhoodId);
          const tags = selNbr?.tags || {};
          const tagNames = Object.values(tags);
          const tagCount = Number(nodeData.config.tagCount) || 0;
          return (
            <>
              <select
                className={styles.select}
                value={(nodeData.config.neighborhoodId as string) || ''}
                onChange={e => {
                  const newConfig = { ...nodeData.config, neighborhoodId: e.target.value, tagCount: 0 };
                  updateNodeData(id, { ...nodeData, config: newConfig });
                }}
              >
                <option value="">Neighborhood...</option>
                {model.neighborhoods.map(n => (
                  <option key={n.id} value={n.id}>{n.name}</option>
                ))}
              </select>
              {Array.from({ length: tagCount }, (_, i) => (
                <div key={i} style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
                  <select
                    className={styles.select}
                    style={{ flex: 1 }}
                    value={(nodeData.config[`tag_${i}_name`] as string) || ''}
                    onChange={e => updateConfig(`tag_${i}_name`, e.target.value)}
                  >
                    <option value="">Tag...</option>
                    {tagNames.map(t => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                  <button
                    style={{
                      background: 'none', border: 'none', color: '#f44336',
                      cursor: 'pointer', fontSize: '0.7rem', padding: '0 2px',
                    }}
                    onClick={() => {
                      const newConfig = { ...nodeData.config };
                      for (let j = i; j < tagCount - 1; j++) {
                        newConfig[`tag_${j}_name`] = newConfig[`tag_${j + 1}_name`] ?? '';
                      }
                      delete newConfig[`tag_${tagCount - 1}_name`];
                      newConfig.tagCount = tagCount - 1;
                      updateNodeData(id, { ...nodeData, config: newConfig });
                    }}
                    title="Remove tag"
                  >
                    x
                  </button>
                </div>
              ))}
              <button
                className={styles.select}
                style={{ cursor: 'pointer', textAlign: 'center' }}
                onClick={() => {
                  const newConfig = { ...nodeData.config };
                  newConfig[`tag_${tagCount}_name`] = tagNames[0] || '';
                  newConfig.tagCount = tagCount + 1;
                  updateNodeData(id, { ...nodeData, config: newConfig });
                }}
              >
                + Add Tag
              </button>
            </>
          );
        })()}

        {nodeData.nodeType === 'macro' && (
          <span style={{ fontSize: '0.6rem', color: '#8060c0', fontStyle: 'italic' }}>
            Double-click to edit
          </span>
        )}

        {(isMacroInput || isMacroOutput) && macroDefForBoundary && (() => {
          const ports = isMacroInput
            ? macroDefForBoundary.exposedInputs
            : macroDefForBoundary.exposedOutputs;
          return (
            <>
              {ports.map(p => (
                <div key={p.portId} style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
                  <input
                    className={styles.input}
                    style={{ flex: 1 }}
                    value={p.label}
                    onChange={e => renamePort(p.portId, e.target.value)}
                    title="Port name"
                  />
                  <select
                    className={styles.select}
                    style={{ width: 52 }}
                    value={p.category}
                    onChange={e => changePortCategory(p.portId, e.target.value as 'value' | 'flow')}
                    title="Port category"
                  >
                    <option value="value">Val</option>
                    <option value="flow">Flow</option>
                  </select>
                  <button
                    style={{
                      background: 'none', border: 'none', color: '#f44336',
                      cursor: 'pointer', fontSize: '0.7rem', padding: '0 2px',
                    }}
                    onClick={() => removePort(p.portId)}
                    title="Remove port"
                  >
                    x
                  </button>
                </div>
              ))}
              <button
                className={styles.select}
                style={{ cursor: 'pointer', textAlign: 'center' }}
                onClick={addPort}
              >
                + Add Port
              </button>
            </>
          );
        })()}
      </div>

      {/* Input handles (left side) + external inline widgets + external labels */}
      {inputPorts.map((port, i) => {
        const portDef = allInputPortDefs.get(port.id) ?? port;
        const hid = handleId(port);
        const isConnected = connectedInputHandles.has(hid);
        const topPx = (isCompact ? 24 : 30) + i * portSpacing;

        // Determine effective widget type (dynamic for attribute-dependent nodes)
        let effectiveWidget = portDef.inlineWidget;
        const setAttrId = nodeData.config.attributeId as string;
        const setAttr = setAttrId ? model.attributes.find(a => a.id === setAttrId) : undefined;
        if (effectiveWidget && (nodeData.nodeType === 'setAttribute' || nodeData.nodeType === 'updateAttribute' || nodeData.nodeType === 'setNeighborhoodAttribute' || nodeData.nodeType === 'setNeighborAttributeByIndex') && port.id === 'value') {
          const attr = setAttr;
          if (!attr) {
            effectiveWidget = undefined;
          } else if (attr.type === 'bool') {
            effectiveWidget = 'bool';
          } else if (attr.type === 'integer' || attr.type === 'float') {
            effectiveWidget = 'number';
          } else if (attr.type === 'tag') {
            effectiveWidget = 'tag';
          } else {
            effectiveWidget = undefined;
          }
        }

        const showWidget = effectiveWidget && !isConnected && port.category === 'value';
        const configKey = `_port_${port.id}`;
        const val = (nodeData.config[configKey] as string) ?? portDef.defaultValue ?? '';

        // Port compatibility highlighting (also dim already-connected value inputs, except isArray)
        const cf = connectingFrom;
        const directionMatch = cf ? cf.kind !== 'input' : false; // input ports match when dragging from output
        const categoryMatch = cf ? port.category === cf.category && id !== cf.nodeId : null;
        const isArrayPort = !!portDef.isArray;
        const alreadyOccupied = isConnected && port.category === 'value' && !isArrayPort;
        const isCompatible = cf ? (directionMatch && categoryMatch && !alreadyOccupied) : null;
        const handleClass = [
          port.category === 'flow' ? styles.handleFlow : styles.handleValue,
          !isConnected && port.category === 'value' ? styles.handleUnconnected : '',
          cf && isCompatible ? styles.handleCompatible : '',
          cf && !isCompatible ? styles.handleIncompatible : '',
        ].filter(Boolean).join(' ');

        return (
          <div key={hid}>
            <Handle
              type="target"
              position={Position.Left}
              id={hid}
              className={handleClass}
              style={{ top: `${topPx}px` }}
              title={port.label}
            />
            {showWidget && (
              <div className={styles.inlineWidgetWrapper} style={{ top: `${topPx}px` }} onMouseDown={stopDrag} onDoubleClick={stopAll}>
                {effectiveWidget === 'bool' ? (
                  <select
                    className={styles.inlineWidget}
                    value={val === 'true' ? 'true' : 'false'}
                    onChange={e => updateConfig(configKey, e.target.value)}
                    onClick={e => e.stopPropagation()}
                    onMouseDown={stopDrag}
                  >
                    <option value="true">True</option>
                    <option value="false">False</option>
                  </select>
                ) : effectiveWidget === 'tag' ? (
                  <select
                    className={styles.inlineWidget}
                    value={val || '0'}
                    onChange={e => updateConfig(configKey, e.target.value)}
                    onClick={e => e.stopPropagation()}
                    onMouseDown={stopDrag}
                  >
                    {(setAttr?.tagOptions || []).map((t, ti) => (
                      <option key={ti} value={String(ti)}>{t}</option>
                    ))}
                    {(!setAttr?.tagOptions || setAttr.tagOptions.length === 0) && <option value="0">(no tags)</option>}
                  </select>
                ) : (
                  <input
                    className={styles.inlineWidget}
                    type="number"
                    value={val}
                    onChange={e => updateConfig(configKey, e.target.value)}
                    onClick={e => e.stopPropagation()}
                    onMouseDown={stopDrag}
                  />
                )}
              </div>
            )}
            {showPortLabels && !showWidget && (
              <div className={styles.portLabelLeft} style={{ top: `${topPx}px` }}>
                {port.label}
              </div>
            )}
          </div>
        );
      })}

      {/* Output handles (right side) + external labels */}
      {outputPorts.map((port, i) => {
        const hid = handleId(port);
        const topPx = (isCompact ? 24 : 30) + i * portSpacing;
        const cf = connectingFrom;
        const directionOk = cf ? cf.kind !== 'output' : false; // output ports match when dragging from input
        const isCompatible = cf ? (directionOk && port.category === cf.category && id !== cf.nodeId) : null;
        const handleClass = [
          port.category === 'flow' ? styles.handleFlow : styles.handleValue,
          cf && isCompatible ? styles.handleCompatible : '',
          cf && !isCompatible ? styles.handleIncompatible : '',
        ].filter(Boolean).join(' ');

        return (
          <div key={hid}>
            <Handle
              type="source"
              position={Position.Right}
              id={hid}
              className={handleClass}
              style={{ top: `${topPx}px` }}
              title={port.label}
            />
            {showPortLabels && (
              <div className={styles.portLabelRight} style={{ top: `${topPx}px` }}>
                {port.label}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Custom comparator: React Flow's updateNodeData replaces only the mutated node's `data`
// reference, so reference-equality on `data` correctly skips re-renders for untouched nodes.
// useModel() context changes still trigger re-renders regardless (as needed for boundary nodes).
export const CaNode = memo(CaNodeComponent, (prev, next) => {
  if (prev.id !== next.id) return false;
  if (prev.selected !== next.selected) return false;
  if (prev.dragging !== next.dragging) return false;
  const prevParent = (prev as NodeProps & { parentId?: string }).parentId;
  const nextParent = (next as NodeProps & { parentId?: string }).parentId;
  if (prevParent !== nextParent) return false;
  if (prev.data !== next.data) return false;
  return true;
});
