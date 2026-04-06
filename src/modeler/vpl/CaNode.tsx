import { memo, useCallback } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import { getNodeDef } from './nodes/registry';
import { handleId } from './types';
import type { NodeConfig } from './types';
import { useModel } from '../../model/ModelContext';
import styles from './CaNode.module.css';

interface CaNodeData {
  nodeType: string;
  config: NodeConfig;
  [key: string]: unknown;
}

function CaNodeComponent({ id, data }: NodeProps) {
  const nodeData = data as CaNodeData;
  const def = getNodeDef(nodeData.nodeType);
  const { model } = useModel();
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
        }
      }
      updateNodeData(id, { ...nodeData, config: newConfig });
    },
    [id, nodeData, updateNodeData],
  );

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

  const userLabel = nodeData.label as string | undefined;

  // Dynamic height to fit all ports
  const maxPorts = Math.max(inputPorts.length, outputPorts.length);
  const nodeMinHeight = Math.max(50, 30 + maxPorts * 22 + 10);

  return (
    <div className={styles.node} style={{ borderColor: def.color, minHeight: nodeMinHeight }}>
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

        {nodeData.nodeType === 'getNeighborsAttribute' && (
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

        {nodeData.nodeType === 'setColorViewer' && (
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

        {nodeData.nodeType === 'getModelAttribute' && (
          <select
            className={styles.select}
            value={(nodeData.config.attributeId as string) || ''}
            onChange={e => updateConfig('attributeId', e.target.value)}
          >
            <option value="">Select...</option>
            {model.attributes
              .filter(a => a.isModelAttribute)
              .map(a => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
          </select>
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

        {nodeData.nodeType === 'getColorConstant' && (
          <>
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
        )}

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
      </div>

      {/* Input handles (left side) */}
      {inputPorts.map((port, i) => (
        <Handle
          key={handleId(port)}
          type="target"
          position={Position.Left}
          id={handleId(port)}
          className={port.category === 'flow' ? styles.handleFlow : styles.handleValue}
          style={{ top: `${30 + i * 22}px` }}
          title={port.label}
        />
      ))}

      {/* Output handles (right side) */}
      {outputPorts.map((port, i) => (
        <Handle
          key={handleId(port)}
          type="source"
          position={Position.Right}
          id={handleId(port)}
          className={port.category === 'flow' ? styles.handleFlow : styles.handleValue}
          style={{ top: `${30 + i * 22}px` }}
          title={port.label}
        />
      ))}

      {/* Port labels */}
      <div className={styles.portLabels}>
        <div className={styles.inputLabels}>
          {inputPorts.map(p => (
            <div key={p.id} className={styles.portLabel}>{p.label}</div>
          ))}
        </div>
        <div className={styles.outputLabels}>
          {outputPorts.map(p => (
            <div key={p.id} className={styles.portLabel}>{p.label}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

export const CaNode = memo(CaNodeComponent);
