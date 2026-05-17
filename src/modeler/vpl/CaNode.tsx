import { memo, useCallback, useState, useMemo, useRef, useSyncExternalStore } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import { getNodeDef } from './nodes/registry';
import { detectMissingConfig, detectCapabilityRequirements, detectWebGPUIncompatibilities, detectWasmIncompatibilities, countMacroSubgraphIssues } from './nodes/nodeValidation';
import { INTERPOLATION_METHODS, INTERPOLATION_SHORT_LABELS, DEFAULT_INTERPOLATION_METHOD } from './nodes/interpolationMethods';
import type { InterpolationMethod } from './nodes/interpolationMethods';
import { buildVarMap, parseExpression, clampVisibleCount, VISIBLE_PORT_IDS, MAX_VISIBLE } from './compiler/expression/parser';
import { handleId } from './types';
import type { NodeConfig, PortDef } from './types';
import type { MacroPort } from '../../model/types';
import { useModel } from '../../model/ModelContext';
import {
  isConnectingGlobal,
  showPortLabelsGlobal,
  subscribeShowPortLabels,
  connectingFrom,
  subscribeConnectingFrom,
  subscribeConnectedHandles,
  getConnectedHandlesForNode,
  subscribeConnectionHazards,
  getConnectionHazardsForNode,
  compatibleHandlesForDrag,
  subscribeCompatibleHandlesForDrag,
  handleKey,
} from './graphState';

/** Snapshot getter for useSyncExternalStore — must return a stable reference
 *  when nothing changed (otherwise React thinks the store keeps changing).
 *  connectingFrom is either null or a fresh object set once per drag, so
 *  identity equality is the right semantics. */
function getConnectingFromSnapshot() {
  return connectingFrom;
}

/** Snapshot getter for the panel-drag compatible-handles set. The setter
 *  swaps the entire set reference on change, so identity equality is right. */
function getCompatibleHandlesSnapshot() {
  return compatibleHandlesForDrag;
}
import styles from './CaNode.module.css';
import { InlineNumberInput, InlineBoolSelect, InlineTagSelect } from './widgets/InlineWidgets';

/** Pick the handle CSS class for a port based on its category + data type.
 *  Flow → green; NeighborIndex value → amber; everything else → cyan. */
function portHandleClass(port: PortDef): string {
  if (port.category === 'flow') return styles.handleFlow!;
  if (port.dataType === 'neighborIndex') return styles.handleNeighborIndex!;
  return styles.handleValue!;
}

/** Returns dark text for light backgrounds, white text for dark backgrounds */
function textColorForBg(bgHex: string): string {
  const hex = bgHex.replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#1e2a3a' : '#ffffff';
}

/** True when the chosen text colour for this bg is DARK (luminance > 0.6).
 *  We use this to suppress the global text-shadow on dark text — the body's
 *  `0 1px 0 rgba(0,0,0,0.55)` is designed for light-on-dark UI; on dark text
 *  it just smears each glyph downward. */
function isLightHeaderBg(bgHex: string): boolean {
  const hex = bgHex.replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6;
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

/** Gradient-editor UI for the Color Scale node. Renders a CSS gradient bar
 *  with draggable color-stop markers, a detail row for the selected stop
 *  (numeric position + color picker + delete), and an "+ Add Stop" button.
 *  Stops live in node.data.config as `stopCount` + `stop_<i>_(position|r|g|b)`. */
function ColorScaleEditor({ id, nodeData }: { id: string; nodeData: CaNodeData }) {
  const { updateNodeData } = useReactFlow();
  const [selectedStopIdx, setSelectedStopIdx] = useState<number>(0);
  const barRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<
    { idx: number; startX: number; startP: number; barWidth: number } | null
  >(null);

  type StopUI = { p: number; r: number; g: number; b: number };
  const stopCount = Math.max(0, Number(nodeData.config.stopCount) || 0);
  const stops: StopUI[] = [];
  for (let i = 0; i < stopCount; i++) {
    stops.push({
      p: Number(nodeData.config[`stop_${i}_position`] ?? '0'),
      r: parseInt(String(nodeData.config[`stop_${i}_r`] ?? '0'), 10) || 0,
      g: parseInt(String(nodeData.config[`stop_${i}_g`] ?? '0'), 10) || 0,
      b: parseInt(String(nodeData.config[`stop_${i}_b`] ?? '0'), 10) || 0,
    });
  }
  const safeIdx = Math.min(Math.max(0, selectedStopIdx), Math.max(0, stops.length - 1));
  const selStop = stops[safeIdx];

  const stopDrag = (e: React.MouseEvent) => {
    if (e.button === 0) e.stopPropagation();
  };

  const writeStops = (next: StopUI[]) => {
    const newConfig: NodeConfig = { ...nodeData.config };
    for (const k of Object.keys(newConfig)) {
      if (/^stop_\d+_(position|r|g|b)$/.test(k)) delete newConfig[k];
    }
    next.forEach((s, i) => {
      newConfig[`stop_${i}_position`] = String(s.p);
      newConfig[`stop_${i}_r`] = String(s.r | 0);
      newConfig[`stop_${i}_g`] = String(s.g | 0);
      newConfig[`stop_${i}_b`] = String(s.b | 0);
    });
    newConfig.stopCount = next.length;
    updateNodeData(id, { ...nodeData, config: newConfig });
  };

  const updateStop = (i: number, patch: Partial<StopUI>) => {
    writeStops(stops.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  };

  const sampleAt = (p: number): { r: number; g: number; b: number } => {
    if (stops.length === 0) return { r: 0, g: 0, b: 0 };
    const sorted = [...stops].sort((a, b) => a.p - b.p);
    if (p <= sorted[0]!.p) return { r: sorted[0]!.r, g: sorted[0]!.g, b: sorted[0]!.b };
    if (p >= sorted[sorted.length - 1]!.p) {
      const s = sorted[sorted.length - 1]!;
      return { r: s.r, g: s.g, b: s.b };
    }
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i]!;
      const b = sorted[i + 1]!;
      if (p < b.p && b.p !== a.p) {
        const t = (p - a.p) / (b.p - a.p);
        return {
          r: Math.round(a.r + t * (b.r - a.r)),
          g: Math.round(a.g + t * (b.g - a.g)),
          b: Math.round(a.b + t * (b.b - a.b)),
        };
      }
    }
    return { r: 0, g: 0, b: 0 };
  };

  const addStop = () => {
    const sorted = [...stops].sort((a, b) => a.p - b.p);
    const last = sorted[sorted.length - 1];
    const prev = sorted[sorted.length - 2];
    let np = 0.5;
    let sample = { r: 128, g: 128, b: 128 };
    if (last && prev) {
      np = (last.p + prev.p) / 2;
      sample = sampleAt(np);
    } else if (last) {
      np = Math.min(1, last.p + 0.1);
      sample = { r: last.r, g: last.g, b: last.b };
    }
    const next = [...stops, { p: np, ...sample }];
    writeStops(next);
    setSelectedStopIdx(next.length - 1);
  };

  const deleteStop = (i: number) => {
    if (stops.length <= 2) return;
    const next = stops.filter((_, j) => j !== i);
    writeStops(next);
    setSelectedStopIdx(Math.max(0, Math.min(i, next.length - 1)));
  };

  const sortedForCss = [...stops].sort((a, b) => a.p - b.p);
  const gradStops = sortedForCss.length === 0
    ? 'rgb(0,0,0)'
    : sortedForCss
        .map(s => `rgb(${s.r},${s.g},${s.b}) ${Math.max(0, Math.min(1, s.p)) * 100}%`)
        .join(', ');
  const barBg = `linear-gradient(to right, ${gradStops})`;

  return (
    <>
      <div
        ref={barRef}
        style={{
          position: 'relative',
          height: 22,
          width: '100%',
          background: barBg,
          border: '1px solid #2a3a4a',
          borderRadius: 3,
          cursor: 'crosshair',
        }}
        onMouseDown={stopDrag}
        onClick={(e) => {
          if (!barRef.current || dragRef.current) return;
          if (e.target !== barRef.current) return;
          const rect = barRef.current.getBoundingClientRect();
          const p = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
          const sampled = sampleAt(p);
          const next = [...stops, { p, ...sampled }];
          writeStops(next);
          setSelectedStopIdx(next.length - 1);
        }}
      >
        {stops.map((s, i) => (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: `calc(${Math.max(0, Math.min(1, s.p)) * 100}% - 6px)`,
              top: -3,
              width: 12,
              height: 28,
              background: `rgb(${s.r},${s.g},${s.b})`,
              border: i === safeIdx ? '2px solid #4cc9f0' : '1px solid #cfd8dc',
              borderRadius: 2,
              cursor: 'grab',
              boxSizing: 'border-box',
            }}
            onMouseDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              e.stopPropagation();
              if (!barRef.current) return;
              const rect = barRef.current.getBoundingClientRect();
              dragRef.current = { idx: i, startX: e.clientX, startP: s.p, barWidth: rect.width };
              setSelectedStopIdx(i);
              const onMove = (ev: MouseEvent) => {
                const d = dragRef.current;
                if (!d) return;
                const dp = (ev.clientX - d.startX) / d.barWidth;
                const newP = Math.max(0, Math.min(1, d.startP + dp));
                updateStop(d.idx, { p: newP });
              };
              const onUp = () => {
                dragRef.current = null;
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
              };
              window.addEventListener('mousemove', onMove);
              window.addEventListener('mouseup', onUp);
            }}
            onClick={(e) => {
              e.stopPropagation();
              setSelectedStopIdx(i);
            }}
            title={`Stop ${i}: pos ${s.p.toFixed(3)}, rgb(${s.r},${s.g},${s.b})`}
          />
        ))}
      </div>

      {selStop && (
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <InlineNumberInput
            className={styles.input}
            min={0}
            max={1}
            step={0.01}
            value={String(selStop.p)}
            onChange={(v) => updateStop(safeIdx, { p: parseFloat(v) || 0 })}
            onMouseDown={stopDrag}
            style={{ width: 60 }}
            title="Stop position"
          />
          <input
            type="color"
            className={styles.input}
            style={{ height: 24, padding: 1, cursor: 'pointer', flex: 1 }}
            value={`#${[selStop.r, selStop.g, selStop.b]
              .map(c => Math.min(255, Math.max(0, c)).toString(16).padStart(2, '0'))
              .join('')}`}
            onChange={(e) => {
              const h = e.target.value;
              updateStop(safeIdx, {
                r: parseInt(h.slice(1, 3), 16),
                g: parseInt(h.slice(3, 5), 16),
                b: parseInt(h.slice(5, 7), 16),
              });
            }}
            onClick={(e) => e.stopPropagation()}
          />
          <button
            onClick={() => deleteStop(safeIdx)}
            disabled={stops.length <= 2}
            style={{
              background: 'none',
              border: 'none',
              color: stops.length <= 2 ? '#586060' : '#f44336',
              cursor: stops.length <= 2 ? 'not-allowed' : 'pointer',
              fontSize: '0.7rem',
              padding: '0 2px',
            }}
            title={stops.length <= 2 ? 'A scale must have at least 2 stops' : 'Delete this stop'}
          >
            x
          </button>
        </div>
      )}

      <button
        className={styles.select}
        style={{ cursor: 'pointer', textAlign: 'center' }}
        onClick={addStop}
      >
        + Add Stop
      </button>
    </>
  );
}

function CaNodeComponent({ id, data }: NodeProps) {
  const nodeData = data as CaNodeData;
  const def = getNodeDef(nodeData.nodeType);
  const { model, updateMacro } = useModel();
  const { updateNodeData } = useReactFlow();
  // Subscribe to port-label toggle so memoized CaNodes re-render when it changes
  const showPortLabels = useSyncExternalStore(subscribeShowPortLabels, () => showPortLabelsGlobal);
  // Subscribe to connectingFrom so this memoized node re-renders the moment a
  // connection drag starts/ends — needed for compatible/incompatible port
  // highlight classes, which read connectingFrom directly during render.
  useSyncExternalStore(subscribeConnectingFrom, getConnectingFromSnapshot);
  // Subscribe to the panel-drag compatible-handles set so this memoized node
  // re-renders when the user starts/stops dragging a side-panel item. Each
  // handle reads the snapshot below to decide whether to glow.
  const compatibleHandles = useSyncExternalStore(subscribeCompatibleHandlesForDrag, getCompatibleHandlesSnapshot);

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

  // Sequence: dynamic flow output ports beyond the static FIRST/THEN.
  // extraCount=0 → just FIRST/THEN; extraCount=2 → FIRST, THEN, Then 3, Then 4.
  if (nodeData.nodeType === 'sequence') {
    const extraCount = Number(nodeData.config.extraCount) || 0;
    for (let i = 2; i < 2 + extraCount; i++) {
      outputPorts.push({
        id: `then_${i}`, label: `Then ${i + 1}`,
        kind: 'output' as const, category: 'flow' as const,
      });
    }
  }

  // Expression: show only `visibleCount` of the 8 input ports, relabelled with
  // the user's variable names. Mirrors effectivePorts.ts (UI-only — all 8 ports
  // stay in def.ports so the compilers resolve them).
  if (nodeData.nodeType === 'expression') {
    const visibleCount = clampVisibleCount(nodeData.config.visibleCount);
    inputPorts = inputPorts.slice(0, visibleCount).map(p => {
      const nm = nodeData.config[`_varName_${p.id}`];
      return (typeof nm === 'string' && nm.trim()) ? { ...p, label: nm.trim() } : p;
    });
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

  // GetRandom: probability port only for bool; options + fallback only for options mode.
  // Mirror of the same logic in effectivePorts.ts — they MUST stay in sync.
  if (nodeData.nodeType === 'getRandom') {
    const rt = nodeData.config.randomType as string;
    if (rt !== 'bool') inputPorts = inputPorts.filter(p => p.id !== 'probability');
    if (rt !== 'options') inputPorts = inputPorts.filter(p => p.id !== 'options' && p.id !== 'fallback');
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

  // Connection-kind hazards (e.g. list-position int wired into a NeighborIndex port).
  // Same single-pub/sub pattern as connectedHandles; identity-stable when unchanged so
  // memoized nodes only re-render when their own hazard list actually changes.
  const connectionHazards = useSyncExternalStore(
    subscribeConnectionHazards,
    () => getConnectionHazardsForNode(id),
  );

  // Build a map of all port definitions for inline widget lookup
  const allInputPortDefs = useMemo(() => {
    if (!def) return new Map<string, typeof inputPorts[0]>();
    return new Map(def.ports.filter(p => p.kind === 'input').map(p => [p.id, p]));
  }, [def]);

  // Detect missing required config (shown as a warning badge in the node header).
  // When the model targets WebGPU, also surface target-specific rejections
  // (async-only nodes, non-parallel-safe Update Indicator ops) so the user
  // sees them in the modeler before hitting the runtime compile error.
  const configIssues = useMemo(
    () => {
      const useWebGPU = !!model.properties.useWebGPU;
      const useWasm = !!model.properties.useWasm && !useWebGPU;
      const base = detectMissingConfig(nodeData.nodeType, nodeData.config, model, connectedInputHandles);
      const capability = detectCapabilityRequirements(nodeData.nodeType, model);
      const own = useWebGPU
        ? [...base, ...capability, ...detectWebGPUIncompatibilities(nodeData.nodeType, nodeData.config, model)]
        : useWasm
          ? [...base, ...capability, ...detectWasmIncompatibilities(nodeData.nodeType, nodeData.config, model)]
          : [...base, ...capability];
      // Bubble up internal-node warnings on macro instances so they're visible
      // without expanding the macro (and recursively through nested macros).
      if (nodeData.nodeType === 'macro') {
        const macroDefId = nodeData.config.macroDefId;
        if (typeof macroDefId === 'string' && macroDefId.length > 0) {
          const innerCount = countMacroSubgraphIssues(macroDefId, model, useWebGPU, useWasm);
          if (innerCount > 0) {
            own.push(`${innerCount} internal warning${innerCount === 1 ? '' : 's'} (expand macro to see)`);
          }
        }
      }
      // Connection-kind hazards (typed-port mismatches that the runtime would silently accept)
      if (connectionHazards.length > 0) {
        for (const h of connectionHazards) own.push(h);
      }
      return own;
    },
    [
      nodeData.nodeType,
      nodeData.config,
      model.attributes,
      model.neighborhoods,
      model.mappings,
      model.indicators,
      model.macroDefs,
      model.properties.useWebGPU,
      model.properties.useWasm,
      model.properties.updateMode,
      model.variegatedCells?.enabled,
      connectionHazards,
      connectedInputHandles,
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
    } else if (nodeData.nodeType === 'expression') {
      const expr = ((nodeData.config.expression as string) ?? '').trim();
      collapsedLabel = expr ? (expr.length > 18 ? `${expr.slice(0, 18)}…` : expr) : 'Expression';
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
    } else if (nodeData.nodeType === 'colorScale') {
      const m = ((nodeData.config.method as string) || DEFAULT_INTERPOLATION_METHOD) as InterpolationMethod;
      const nStops = Math.max(0, Number(nodeData.config.stopCount) || 0);
      collapsedLabel = `Color Scale · ${INTERPOLATION_SHORT_LABELS[m] ?? m} · ${nStops} stops`;
    } else if (nodeData.nodeType === 'proportionMap') {
      const m = ((nodeData.config.method as string) || DEFAULT_INTERPOLATION_METHOD) as InterpolationMethod;
      collapsedLabel = `Prop Map · ${INTERPOLATION_SHORT_LABELS[m] ?? m}`;
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
    if (nodeData.nodeType === 'setColorViewer') {
      const rConn = connectedInputHandles.has(handleId({ id: 'r', kind: 'input', category: 'value' }));
      const gConn = connectedInputHandles.has(handleId({ id: 'g', kind: 'input', category: 'value' }));
      const bConn = connectedInputHandles.has(handleId({ id: 'b', kind: 'input', category: 'value' }));
      if (!rConn && !gConn && !bConn) {
        const pr = parseInt(String(nodeData.config._port_r ?? '0'), 10);
        const pg = parseInt(String(nodeData.config._port_g ?? '0'), 10);
        const pb = parseInt(String(nodeData.config._port_b ?? '0'), 10);
        collapsedColorPreview = `rgb(${pr},${pg},${pb})`;
      }
    } else if (nodeData.nodeType === 'colorScale') {
      if ((Number(nodeData.config.stopCount) || 0) >= 1) {
        const r = parseInt(String(nodeData.config.stop_0_r ?? '0'), 10) || 0;
        const g = parseInt(String(nodeData.config.stop_0_g ?? '0'), 10) || 0;
        const b = parseInt(String(nodeData.config.stop_0_b ?? '0'), 10) || 0;
        collapsedColorPreview = `rgb(${r},${g},${b})`;
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
          <div className={styles.collapsedHeader} style={{ background: def.color, color: textColorForBg(def.color), textShadow: isLightHeaderBg(def.color) ? 'none' : undefined }}>
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
            className={portHandleClass(port)}
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
            className={portHandleClass(port)}
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
      <div className={styles.header} style={{ background: def.color, color: textColorForBg(def.color), textShadow: isLightHeaderBg(def.color) ? 'none' : undefined }}>
        {def.label}
      </div>
      {configIssues.length > 0 && (
        <div className={styles.warningBadge} title={configIssues.join('\n')}>!</div>
      )}
      <div className={`${styles.body} nodrag`} onDoubleClick={stopAll}>
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

        {/* Wave A.6: nodes that walk a configured neighborhood (getNeighborsAttribute,
            setNeighborhoodAttribute) keep both Neighborhood + Attribute. */}
        {(nodeData.nodeType === 'getNeighborsAttribute'
          || nodeData.nodeType === 'setNeighborhoodAttribute') && (
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

        {/* Wave A.6: NI-consuming access nodes drop the Neighborhood dropdown —
            each NI carries its own (dr, dc) inline. Only Attribute is configured. */}
        {(nodeData.nodeType === 'getNeighborAttributeByIndex'
          || nodeData.nodeType === 'getNeighborsAttrByIndexes'
          || nodeData.nodeType === 'setNeighborAttributeByIndex'
          || nodeData.nodeType === 'filterNeighbors') && (
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
              <InlineNumberInput
                className={styles.input}
                value={(nodeData.config.constValue as string) || '0'}
                onChange={v => updateConfig('constValue', v)}
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
              <option value="options">Options</option>
            </select>
            {(nodeData.config.randomType === 'integer' || nodeData.config.randomType === 'float') && (
              <>
                <InlineNumberInput
                  className={styles.input}
                  placeholder="min"
                  value={(nodeData.config.min as string) || '0'}
                  onChange={v => updateConfig('min', v)}
                />
                <InlineNumberInput
                  className={styles.input}
                  placeholder="max"
                  value={(nodeData.config.max as string) || '1'}
                  onChange={v => updateConfig('max', v)}
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
              <InlineNumberInput className={styles.input} placeholder="R" min={0} max={255}
                value={(nodeData.config.r as string) || '128'}
                onChange={v => updateConfig('r', v)} />
              <InlineNumberInput className={styles.input} placeholder="G" min={0} max={255}
                value={(nodeData.config.g as string) || '128'}
                onChange={v => updateConfig('g', v)} />
              <InlineNumberInput className={styles.input} placeholder="B" min={0} max={255}
                value={(nodeData.config.b as string) || '128'}
                onChange={v => updateConfig('b', v)} />
            </>
          );
        })()}

        {nodeData.nodeType === 'colorScale' && (
          <ColorScaleEditor id={id} nodeData={nodeData} />
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

        {nodeData.nodeType === 'expression' && (() => {
          const visibleCount = clampVisibleCount(nodeData.config.visibleCount);
          const formula = (nodeData.config.expression as string) ?? '';
          const { map, errors: varErrors } = buildVarMap(nodeData.config, visibleCount);
          let parseErr: string | null = varErrors[0] ?? null;
          if (!parseErr && formula.trim()) {
            const res = parseExpression(formula, map);
            if ('error' in res) parseErr = res.error;
          }
          const setVisible = (next: number) => {
            const clamped = Math.max(1, Math.min(MAX_VISIBLE, next));
            const newConfig: NodeConfig = { ...nodeData.config, visibleCount: clamped };
            // Hidden ports: drop their name + inline value so config stays clean.
            for (let i = clamped; i < MAX_VISIBLE; i++) {
              const pid: string = VISIBLE_PORT_IDS[i]!;
              delete newConfig[`_varName_${pid}`];
              delete newConfig[`_port_${pid}`];
            }
            updateNodeData(id, { ...nodeData, config: newConfig });
          };
          return (
            <>
              <textarea
                className={styles.input}
                style={{ fontFamily: 'monospace', resize: 'vertical', boxSizing: 'border-box' }}
                rows={3}
                value={formula}
                placeholder="e.g. a + b*c - pow(d, 2)"
                spellCheck={false}
                onChange={e => updateConfig('expression', e.target.value)}
                onMouseDown={stopDrag}
                onDoubleClick={stopAll}
              />
              {parseErr && (
                <div style={{ color: '#f44336', fontSize: '0.65rem' }}>{parseErr}</div>
              )}
              {Array.from({ length: visibleCount }, (_, i) => {
                const pid = VISIBLE_PORT_IDS[i]!;
                return (
                  <div key={pid} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    <span style={{ fontSize: '0.6rem', opacity: 0.6, width: 10, textAlign: 'center' }}>{pid}</span>
                    <input
                      className={styles.input}
                      style={{ flex: 1 }}
                      type="text"
                      value={(nodeData.config[`_varName_${pid}`] as string) ?? ''}
                      placeholder={pid}
                      spellCheck={false}
                      onChange={e => updateConfig(`_varName_${pid}`, e.target.value)}
                      onMouseDown={stopDrag}
                      onDoubleClick={stopAll}
                    />
                  </div>
                );
              })}
              <div style={{ display: 'flex', gap: 4, alignItems: 'center', justifyContent: 'flex-end' }}>
                <button
                  className={styles.select}
                  style={{
                    cursor: visibleCount <= 1 ? 'not-allowed' : 'pointer',
                    opacity: visibleCount <= 1 ? 0.4 : 1,
                    textAlign: 'center', flex: 1,
                  }}
                  onClick={() => setVisible(visibleCount - 1)}
                  disabled={visibleCount <= 1}
                  title="Remove last input port"
                >
                  −
                </button>
                <button
                  className={styles.select}
                  style={{
                    cursor: visibleCount >= MAX_VISIBLE ? 'not-allowed' : 'pointer',
                    opacity: visibleCount >= MAX_VISIBLE ? 0.4 : 1,
                    textAlign: 'center', flex: 1,
                  }}
                  onClick={() => setVisible(visibleCount + 1)}
                  disabled={visibleCount >= MAX_VISIBLE}
                  title="Add another input port"
                >
                  +
                </button>
              </div>
            </>
          );
        })()}

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

        {(nodeData.nodeType === 'colorScale' || nodeData.nodeType === 'proportionMap') && (
          <select
            className={styles.select}
            value={(nodeData.config.method as string) || DEFAULT_INTERPOLATION_METHOD}
            onChange={e => updateConfig('method', e.target.value)}
            title="Interpolation curve"
          >
            {INTERPOLATION_METHODS.map(m => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
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

        {nodeData.nodeType === 'sequence' && (() => {
          const extraCount = Number(nodeData.config.extraCount) || 0;
          const addThen = () => {
            updateNodeData(id, {
              ...nodeData,
              config: { ...nodeData.config, extraCount: extraCount + 1 },
            });
          };
          const removeThen = () => {
            if (extraCount === 0) return;
            updateNodeData(id, {
              ...nodeData,
              config: { ...nodeData.config, extraCount: extraCount - 1 },
            });
          };
          return (
            <div style={{ display: 'flex', gap: 4, alignItems: 'center', justifyContent: 'flex-end' }}>
              <button
                className={styles.select}
                style={{
                  cursor: extraCount === 0 ? 'not-allowed' : 'pointer',
                  opacity: extraCount === 0 ? 0.4 : 1,
                  textAlign: 'center', flex: 1,
                }}
                onClick={removeThen}
                disabled={extraCount === 0}
                title="Remove last Then output"
              >
                −
              </button>
              <button
                className={styles.select}
                style={{ cursor: 'pointer', textAlign: 'center', flex: 1 }}
                onClick={addThen}
                title="Add another Then output"
              >
                +
              </button>
            </div>
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

        {nodeData.nodeType === 'getAllNeighborIndexes' && (
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
        )}

        {/* Wave A.6: neighborIndexFromOffset has no body widget — dr/dc are
            input ports with their own inline number widgets. */}

        {nodeData.nodeType === 'neighborIndexFromTag' && (() => {
          const selNbr = model.neighborhoods.find(n => n.id === nodeData.config.neighborhoodId);
          const tagNames = selNbr?.tags ? Object.values(selNbr.tags) : [];
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
                value={(nodeData.config.tagName as string) || ''}
                onChange={e => updateConfig('tagName', e.target.value)}
              >
                <option value="">Tag...</option>
                {tagNames.map(t => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
              {selNbr && tagNames.length === 0 && (
                <span style={{ fontSize: '0.6rem', color: '#f44336', fontStyle: 'italic' }}>
                  No tags on this neighborhood
                </span>
              )}
            </>
          );
        })()}

        {/* Wave A.6: flipNeighborIndex is pure bit math — only the mode (which
            axis to mirror across) is configurable; no neighborhood needed. */}
        {nodeData.nodeType === 'flipNeighborIndex' && (
          <select
            className={styles.select}
            value={(nodeData.config.mode as string) || 'horizontal'}
            onChange={e => updateConfig('mode', e.target.value)}
            title="Which axis to mirror across"
          >
            <option value="horizontal">Flip horizontal (negate dCol)</option>
            <option value="vertical">Flip vertical (negate dRow)</option>
            <option value="both">Flip both (180° rotate)</option>
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
        // Panel-drag highlight: same magenta glow as the connection-drag
        // compatibility hint. Only one of the two highlight states can be
        // active at a time (connection drag vs. panel drag).
        const panelDragHighlight = !cf && compatibleHandles.has(handleKey(id, port.kind, port.category, port.id));
        const handleClass = [
          portHandleClass(port),
          !isConnected && port.category === 'value' ? styles.handleUnconnected : '',
          cf && isCompatible ? styles.handleCompatible : '',
          cf && !isCompatible ? styles.handleIncompatible : '',
          panelDragHighlight ? styles.handleCompatible : '',
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
              <div className={`${styles.inlineWidgetWrapper} nodrag`} style={{ top: `${topPx}px` }} onDoubleClick={stopAll}>
                {effectiveWidget === 'bool' ? (
                  <InlineBoolSelect
                    className={styles.inlineWidget}
                    value={val}
                    onChange={next => updateConfig(configKey, next)}
                    onClick={e => e.stopPropagation()}
                    onMouseDown={stopDrag}
                  />
                ) : effectiveWidget === 'tag' ? (
                  <InlineTagSelect
                    className={styles.inlineWidget}
                    value={val}
                    options={setAttr?.tagOptions || []}
                    onChange={next => updateConfig(configKey, next)}
                    onClick={e => e.stopPropagation()}
                    onMouseDown={stopDrag}
                  />
                ) : (
                  <InlineNumberInput
                    className={styles.inlineWidget}
                    value={val}
                    onChange={next => updateConfig(configKey, next)}
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
        const panelDragHighlight = !cf && compatibleHandles.has(handleKey(id, port.kind, port.category, port.id));
        const handleClass = [
          portHandleClass(port),
          cf && isCompatible ? styles.handleCompatible : '',
          cf && !isCompatible ? styles.handleIncompatible : '',
          panelDragHighlight ? styles.handleCompatible : '',
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
  if (prev.data !== next.data) return false;
  return true;
});
