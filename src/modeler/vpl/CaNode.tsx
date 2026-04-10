import { memo, useCallback, useState, useMemo } from 'react';
import { Handle, Position, useReactFlow, useStore } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import { getNodeDef } from './nodes/registry';
import { handleId } from './types';
import type { NodeConfig } from './types';
import type { MacroPort } from '../../model/types';
import { useModel } from '../../model/ModelContext';
import { isConnectingGlobal, showPortLabelsGlobal, connectingFrom } from './graphState';
import styles from './CaNode.module.css';

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

  // Detect which input ports are connected (for inline widget visibility)
  const connectedInputHandles = useStore(
    useCallback(
      (state: { edges: Array<{ target: string; targetHandle?: string | null }> }) =>
        new Set(
          state.edges
            .filter(e => e.target === id)
            .map(e => e.targetHandle ?? ''),
        ),
      [id],
    ),
  );

  // Build a map of all port definitions for inline widget lookup
  const allInputPortDefs = useMemo(() => {
    if (!def) return new Map<string, typeof inputPorts[0]>();
    return new Map(def.ports.filter(p => p.kind === 'input').map(p => [p.id, p]));
  }, [def]);

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

  const showExpanded = !isCollapsed || hoverExpand;

  // Dynamic height to fit all ports
  const maxPorts = Math.max(inputPorts.length, outputPorts.length);
  const nodeMinHeight = showExpanded ? Math.max(50, 30 + maxPorts * 22 + 10) : undefined;

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
      collapsedLabel = attr ? `Set - ${attr.name}` : def.label;
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
    } else {
      collapsedLabel = def.label;
    }

    // Color swatch for collapsed color constant
    const colorSwatchHex = isColorConstant
      ? `rgb(${nodeData.config.r || 128},${nodeData.config.g || 128},${nodeData.config.b || 128})`
      : undefined;

    return (
      <div
        className={`${styles.node} ${isConstant || isColorConstant ? styles.collapsedConstant : styles.collapsed}`}
        style={{ borderColor: def.color }}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      >
        {isColorConstant ? (
          <div className={styles.collapsedColorSwatch} style={{ background: colorSwatchHex }} />
        ) : (
          <div className={styles.collapsedHeader} style={{ background: def.color }}>
            {collapsedLabel}
          </div>
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

  const isCompact = nodeData.nodeType === 'step';

  return (
    <div
      className={`${styles.node} ${isCompact ? styles.compactNode : ''}`}
      style={{ borderColor: def.color, minHeight: nodeMinHeight }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {userLabel && (
        <div className={styles.userLabel}>{userLabel}</div>
      )}
      <div className={styles.header} style={{ background: def.color }}>
        {def.label}
      </div>
      <div className={styles.body}>
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
          || nodeData.nodeType === 'setNeighborAttributeByIndex') && (
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

        {nodeData.nodeType === 'groupCounting' && (
          <select
            className={styles.select}
            value={(nodeData.config.operation as string) || 'equals'}
            onChange={e => updateConfig('operation', e.target.value)}
          >
            <option value="equals">Equals</option>
            <option value="notEquals">Not Equals</option>
            <option value="greater">Greater Than</option>
            <option value="lesser">Lesser Than</option>
          </select>
        )}

        {nodeData.nodeType === 'statement' && (
          <select
            className={styles.select}
            value={(nodeData.config.operation as string) || '=='}
            onChange={e => updateConfig('operation', e.target.value)}
          >
            <option value="==">==</option>
            <option value="!=">!=</option>
            <option value=">">&gt;</option>
            <option value="<">&lt;</option>
            <option value=">=">&gt;=</option>
            <option value="<=">&lt;=</option>
          </select>
        )}

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
        const topPx = 30 + i * 22;

        // Determine effective widget type (dynamic for attribute-dependent nodes)
        let effectiveWidget = portDef.inlineWidget;
        const setAttrId = nodeData.config.attributeId as string;
        const setAttr = setAttrId ? model.attributes.find(a => a.id === setAttrId) : undefined;
        if (effectiveWidget && (nodeData.nodeType === 'setAttribute' || nodeData.nodeType === 'setNeighborhoodAttribute' || nodeData.nodeType === 'setNeighborAttributeByIndex') && port.id === 'value') {
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

        // Port compatibility highlighting (also dim already-connected value inputs)
        const cf = connectingFrom;
        const directionMatch = cf ? cf.kind !== 'input' : false; // input ports match when dragging from output
        const categoryMatch = cf ? port.category === cf.category && id !== cf.nodeId : null;
        const alreadyOccupied = isConnected && port.category === 'value';
        const isCompatible = cf ? (directionMatch && categoryMatch && !alreadyOccupied) : null;
        const handleClass = [
          port.category === 'flow' ? styles.handleFlow : styles.handleValue,
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
              <div className={styles.inlineWidgetWrapper} style={{ top: `${topPx}px` }}>
                {effectiveWidget === 'bool' ? (
                  <select
                    className={styles.inlineWidget}
                    value={val === 'true' ? 'true' : 'false'}
                    onChange={e => updateConfig(configKey, e.target.value)}
                    onClick={e => e.stopPropagation()}
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
                  />
                )}
              </div>
            )}
            {showPortLabelsGlobal && !showWidget && (
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
        const topPx = 30 + i * 22;
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
            {showPortLabelsGlobal && (
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

export const CaNode = memo(CaNodeComponent);
