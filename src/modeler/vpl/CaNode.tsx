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
      updateNodeData(id, { ...nodeData, config: newConfig });
    },
    [id, nodeData, updateNodeData],
  );

  if (!def) return <div className={styles.node}>Unknown node type</div>;

  const inputPorts = def.ports.filter(p => p.kind === 'input');
  const outputPorts = def.ports.filter(p => p.kind === 'output');

  return (
    <div className={styles.node} style={{ borderColor: def.color }}>
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
                value={(nodeData.config.constValue as string) || 'false'}
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
