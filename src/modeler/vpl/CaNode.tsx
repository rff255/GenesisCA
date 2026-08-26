import { Fragment, memo, useCallback, useEffect, useRef, useState, useMemo, useSyncExternalStore } from 'react';
import { Handle, Position, useReactFlow, useUpdateNodeInternals } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import { getNodeDef } from './nodes/registry';
import { CURRENT_VIEWER_SENTINEL } from './nodes/SetCellLooksNode';
import { ARITHMETIC_UNARY_OPS } from './nodes/ArithmeticOperatorNode';
import { detectMissingConfig, detectCapabilityRequirements, detectWebGPUIncompatibilities, detectWasmIncompatibilities, countMacroSubgraphIssues, detectAgentInitContextIssue } from './nodes/nodeValidation';
import { resolveEngines } from '../../model/engineResolution';
import { INTERPOLATION_METHODS, INTERPOLATION_SHORT_LABELS, DEFAULT_INTERPOLATION_METHOD } from './nodes/interpolationMethods';
import type { InterpolationMethod } from './nodes/interpolationMethods';
import { buildVarMap, parseExpression, clampVisibleCount, VISIBLE_PORT_IDS, MAX_VISIBLE, FORMULA_NODE_TYPES } from './compiler/expression/parser';
import type { ExprAst } from './compiler/expression/parser';
import { buildLogicVarMap, parseLogicExpression } from './compiler/expression/logicParser';
import type { LogicAst } from './compiler/expression/logicParser';
import { ExpressionFormula, namesFromVarMap } from './widgets/ExpressionFormula';
import { LogicalFormula } from './widgets/LogicalFormula';
import { handleId } from './types';
import type { NodeConfig, PortDef } from './types';
import type { MacroPort, MacroControl } from '../../model/types';
import { useModel } from '../../model/ModelContext';
import { countMacroInstances } from '../../model/macroImport';
import { typeDisplayName } from '../../model/typeLabels';
import { cellAttrsOf, bondAttrsOf } from '../../model/attributeScope';
import { vectorPortDims } from './compiler/vectorAttr';
import { is3dModelLike } from './compiler/niCodec';
import { MULTI_ATTR_TYPES, multiAttrExtraCount, buildExtraSlotPorts } from './compiler/multiAttrExpand';
// Explicit Controls: the ONE inline-widget resolution + the two attribute
// scopes, dually consumed here and by a control bound to the same key.
import { inlineWidgetFor, ownAttrListFor, tagAttrScopeFor, eligibleControlKeys, describeControlTarget, applyInterfaceEdit, groupSections, resolveControlDescriptor, applyControlValue, CONTROL_BLOCK_NEEDS_ATTENTION } from './explicitControls';
import type { ControlKeyDescriptor, InterfaceEdit, ControlDescriptor } from './explicitControls';
import { buildCensusPorts, censusAttributes } from './compiler/censusExpand';
import { buildBondAttrPorts } from './bondAttrPorts';
import { isGraphFrequencyMetric, degreeHistogramKeys, type GraphMetric } from '../../simulator/engine/graphMetrics';
import { indicatorScalarBlocker } from '../../model/indicatorValue';
import { resolveMaxBonds } from '../../model/centerBased';
import { applyLookupAxisPorts } from './nodes/LookupInteractionNode';
import { buildInputParamPorts, isInputMappingRoot } from '../../model/inputMappingParams';
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
  getActiveGraphKind,
  displayNodeLabel,
  getControlPick,
  subscribeControlPick,
  setControlPick,
  getOpenMacroScope,
  subscribeOpenMacroScope,
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
import { InlineNumberInput, InlineBoolSelect, InlineTagSelect, InlineGlyphInput } from './widgets/InlineWidgets';
import { ColorField } from './widgets/ColorField';
import { hexToRgba, rgbaToHex, isOpaque, OPAQUE } from '../../model/colorHex';
import { readCategoricalEntries, readCategoricalDefault, categoricalHasAlpha, type CategoricalEntry } from './nodes/CategoricalColorNode';
import { readColorScaleStopsRaw, writeColorScaleStops, colorScaleHasAlpha } from './nodes/ColorScaleNode';
import { colorConstantHasAlpha } from './nodes/GetColorConstantNode';
import { GradientStopsEditor, type GradStop } from './widgets/GradientStopsEditor';

/** Pick the handle CSS class for a port based on its category + data type.
 *  Flow → green; NeighborIndex value → amber; everything else → cyan. */
function portHandleClass(port: PortDef): string {
  if (port.category === 'flow') return styles.handleFlow!;
  if (port.dataType === 'neighborIndex') return styles.handleNeighborIndex!;
  if (port.dataType === 'vector') return styles.handleVector!;
  if (port.dataType === 'color') return styles.handleColor!;
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

/** Expression node width bounds (px) for the corner resize grip.
 *
 *  MIN mirrors `.node { min-width: 150px }` in CaNode.module.css — CSS wins over
 *  an inline `width` below it anyway, so clamping to the same number keeps the
 *  stored value honest instead of recording a width the layout ignores. (The
 *  drag's real floor is the node's NATURAL width when that is known — see
 *  `exprNaturalWRef`.) MAX is a sanity bound: past it a node stops reading as a
 *  node on the canvas, and a formula that wide is better split into two nodes. */
const EXPR_MIN_W = 150;
const EXPR_MAX_W = 720;

/** Gradient-editor UI for the Color Scale node — a thin wrapper mapping the
 *  node's flat config (`stopCount` + `stop_<i>_(position|r|g|b|a)`) to/from the
 *  shared GradientStopsEditor (which also provides the palette presets).
 *
 *  Reuses the node's OWN parser + writer, so the editor and the compiler can
 *  never disagree about what the config means (the CategoricalColorEditor rule).
 *  A hand-rolled copy here is exactly how the `a` key went missing: this wrapper
 *  used to parse and write only position/r/g/b, so a stop's alpha was silently
 *  discarded on the way into config and read back opaque — the picker looked
 *  like it refused any alpha but 255, while the compiler was alpha-ready all
 *  along. Read via the RAW (unsorted) parser: the widget addresses stops by
 *  array index, so a sorted read would retarget a drag past a neighbour. */
function ColorScaleEditor({ id, nodeData }: { id: string; nodeData: CaNodeData }) {
  const { updateNodeData } = useReactFlow();
  const stops: GradStop[] = readColorScaleStopsRaw(nodeData.config);
  const setStops = (next: GradStop[]) => {
    updateNodeData(id, { ...nodeData, config: writeColorScaleStops(nodeData.config, next) as NodeConfig });
  };
  return <GradientStopsEditor stops={stops} onChange={setStops} />;
}

/**
 * EXPLICIT CONTROLS — ONE row of a CLOSED macro instance's interface: the
 * author's label on the left, the LIVE widget on the right.
 *
 * There is no local state and no default: `desc.value` is read fresh from
 * `def.nodes[k].data.config[key]` on every render (D1 — ONE storage location),
 * so a change made INSIDE the macro, or by a LINKED sibling instance, shows
 * here on the next paint with no propagation machinery at all.
 *
 * The widget KIND is likewise derived per render (D2 / R4): retype the bound
 * attribute inside the macro and this row swaps number → tag → bool by itself.
 *
 * A BLOCKED control renders its value READ-ONLY with the reason underneath
 * (D8 — report, never drop). Its `onChange` is never reached, and
 * `applyControlValue` refuses it anyway, so inertness is structural.
 */
function MacroControlRow({ desc, onChange, needsAttention }: {
  desc: ControlDescriptor;
  onChange: (next: string) => void;
  needsAttention: boolean;
}) {
  const stopDrag = (e: React.MouseEvent) => { if (e.button === 0) e.stopPropagation(); };
  const stopAll = (e: React.MouseEvent) => e.stopPropagation();
  const guards = { onMouseDown: stopDrag, onClick: stopAll };
  const w = styles.ctlWidget;

  const widget = (() => {
    if (desc.block) {
      // Read-only: the value the macro currently holds (empty for an orphan).
      return <span className={styles.ctlBlockedValue}>{desc.value || '—'}</span>;
    }
    switch (desc.kind) {
      case 'number':
        return (
          <InlineNumberInput
            className={`${styles.input} ${w} nodrag`}
            value={desc.value}
            onChange={onChange}
            {...guards}
          />
        );
      case 'bool':
        return (
          <InlineBoolSelect
            className={`${styles.select} ${w} nodrag`}
            value={desc.value}
            onChange={onChange}
            {...guards}
          />
        );
      case 'glyph':
        return (
          <InlineGlyphInput
            className={`${styles.input} ${w} nodrag`}
            value={desc.value}
            onChange={onChange}
            {...guards}
          />
        );
      case 'checkbox':
        return (
          <input
            type="checkbox"
            className="nodrag"
            checked={desc.value === 'true'}
            onChange={e => onChange(e.target.checked ? 'true' : 'false')}
            {...guards}
            style={{ flex: '0 0 auto', cursor: 'pointer' }}
          />
        );
      case 'color':
        return (
          <input
            type="color"
            className={`${w} nodrag`}
            value={/^#[0-9a-fA-F]{6}$/.test(desc.value) ? desc.value : '#50c8ff'}
            onChange={e => onChange(e.target.value)}
            {...guards}
            style={{ height: 20, padding: 0, background: 'transparent', border: '1px solid var(--color-widget-border)', borderRadius: 3, cursor: 'pointer' }}
          />
        );
      case 'text':
        return (
          <input
            type="text"
            className={`${styles.input} ${w} nodrag`}
            value={desc.value}
            onChange={e => onChange(e.target.value)}
            {...guards}
          />
        );
      case 'textarea':
        // A formula is far too wide for the right-hand column — it takes the
        // whole row below the label (see `ctlRowStacked`).
        return (
          <textarea
            className={`${styles.input} nodrag`}
            value={desc.value}
            onChange={e => onChange(e.target.value)}
            {...guards}
            rows={2}
            style={{ width: '100%', resize: 'vertical', fontFamily: 'var(--font-mono, monospace)' }}
          />
        );
      // tag / select / element — all index-or-id keyed option lists.
      default:
        return (
          <select
            className={`${styles.select} ${w} nodrag`}
            value={desc.value}
            onChange={e => onChange(e.target.value)}
            {...guards}
          >
            {(desc.options ?? []).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            {/* A value the live option list no longer contains would otherwise
                render as the FIRST option — a silent lie about what is stored. */}
            {(desc.options ?? []).every(o => o.value !== desc.value) && (
              <option value={desc.value}>{desc.value === '' ? '(unset)' : `${desc.value} (?)`}</option>
            )}
          </select>
        );
    }
  })();

  const stacked = !desc.block && desc.kind === 'textarea';
  return (
    <div className={styles.ctlRowWrap}>
      <div className={stacked ? styles.ctlRowStacked : styles.ctlRow}>
        <span className={styles.ctlLabel} title={desc.label}>{desc.label}</span>
        {widget}
      </div>
      {desc.block && (
        <div
          className={styles.ctlReason}
          style={needsAttention ? { color: 'var(--color-danger, #f44336)' } : undefined}
          title={desc.reason}
        >
          {desc.reason}
        </div>
      )}
    </div>
  );
}

/** Palette editor for the Categorical Color node: one color swatch per index
 *  entry (entry i == index i), plus a default color for out-of-range indices.
 *  Entries live in node.data.config as `count` + `entry_<i>_(r|g|b)` + `default_(r|g|b)`. */
function CategoricalColorEditor({ id, nodeData }: { id: string; nodeData: CaNodeData }) {
  const { updateNodeData } = useReactFlow();
  // `a` optional — absent means opaque. Reuses the node's OWN parsers so the
  // editor and the compiler can never disagree about what the config means.
  type E = CategoricalEntry;
  const entries: E[] = readCategoricalEntries(nodeData.config);
  const def: E = readCategoricalDefault(nodeData.config);
  const stopDrag = (e: React.MouseEvent) => { if (e.button === 0) e.stopPropagation(); };
  // Any entry declaring alpha widens the WHOLE palette's config (a mixed palette
  // must write every entry's `a`, else an opaque one would read as undefined and
  // silently take the pre-alpha emit path for that entry).
  const anyAlpha = (list: E[], d: E) => list.some(e => !isOpaque(e)) || !isOpaque(d);
  const writeAll = (next: E[], d: E) => {
    const cfg: NodeConfig = { ...nodeData.config };
    for (const k of Object.keys(cfg)) if (/^entry_\d+_(r|g|b|a)$/.test(k)) delete cfg[k];
    delete cfg.default_a;
    const withA = anyAlpha(next, d);
    next.forEach((e, i) => {
      cfg[`entry_${i}_r`] = String(e.r | 0);
      cfg[`entry_${i}_g`] = String(e.g | 0);
      cfg[`entry_${i}_b`] = String(e.b | 0);
      if (withA) cfg[`entry_${i}_a`] = String((e.a ?? OPAQUE) | 0);
    });
    cfg.default_r = String(d.r | 0);
    cfg.default_g = String(d.g | 0);
    cfg.default_b = String(d.b | 0);
    if (withA) cfg.default_a = String((d.a ?? OPAQUE) | 0);
    cfg.count = next.length;
    updateNodeData(id, { ...nodeData, config: cfg });
  };
  const writeEntries = (next: E[]) => writeAll(next, def);
  const setDefault = (c: E) => writeAll(entries, c);
  const swatch = (val: E, onChange: (c: E) => void) => (
    <ColorField
      value={rgbaToHex(val)}
      onChange={(h) => {
        const n = hexToRgba(h);
        onChange(n.a === OPAQUE ? { r: n.r, g: n.g, b: n.b } : { r: n.r, g: n.g, b: n.b, a: n.a });
      }}
      style={{ height: 24, flex: 1 }}
    />
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }} onMouseDown={stopDrag}>
      {entries.map((e, i) => (
        <div key={i} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <span style={{ width: 28, fontSize: '0.7rem', opacity: 0.8 }}>#{i}</span>
          {swatch(e, c => writeEntries(entries.map((x, j) => (j === i ? c : x))))}
          <button onClick={() => writeEntries(entries.filter((_, j) => j !== i))}
            style={{ background: 'none', border: 'none', color: '#f44336', cursor: 'pointer', fontSize: '0.7rem', padding: '0 2px' }}
            title="Delete this color">x</button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <span style={{ width: 28, fontSize: '0.7rem', opacity: 0.6 }}>else</span>
        {swatch(def, setDefault)}
      </div>
      <button className={styles.select} style={{ cursor: 'pointer', textAlign: 'center' }}
        onClick={() => writeEntries([...entries, def])}>
        + Add Color
      </button>
    </div>
  );
}

/** Optional per-node "Cone color" for the two FOV sensing nodes (Get Agents In
 *  View / Sense Hemifield). DISPLAY-ONLY — the simulator's vision-cone overlay
 *  tints this node's wedges with it; no compiler on any target reads
 *  `config.visionColor`. Empty (the ⟳ reset) restores the automatic palette
 *  slot. A cosmetic RGB picker (never an 8-digit hex) per the RGBA-colours
 *  rule; `nodrag` because it sits in the node body. */
function VisionColorRow({ value, onChange }: { value?: string; onChange: (v: string) => void }) {
  const set = typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
  return (
    <>
      <label style={{ fontSize: '0.6rem', color: '#999' }}>Cone color (display)</label>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <input
          type="color"
          className="nodrag"
          value={set ? value! : '#50c8ff'}
          onMouseDown={e => { if (e.button === 0) e.stopPropagation(); }}
          onChange={e => onChange(e.target.value)}
          style={{ flex: 1, height: 22, padding: 0, background: 'transparent', border: '1px solid #2d4059', borderRadius: 3, cursor: 'pointer' }}
          title="Tint this node's vision cones in the simulator (Show vision). Leave unset for the automatic palette."
        />
        <button
          className="nodrag"
          onMouseDown={e => { if (e.button === 0) e.stopPropagation(); }}
          onClick={() => onChange('')}
          disabled={!set}
          style={{ background: 'none', border: 'none', color: set ? '#999' : '#555', cursor: set ? 'pointer' : 'default', fontSize: '0.7rem', padding: '0 2px' }}
          title="Use the automatic palette color"
        >{'⟳'}</button>
      </div>
    </>
  );
}

function CaNodeComponent({ id, data }: NodeProps) {
  const nodeData = data as CaNodeData;
  const def = getNodeDef(nodeData.nodeType);
  const { model, updateMacro, importMacro } = useModel();
  // Generic Agent Platform: the OWN-attribute dropdowns (Get/Set/Update Attribute)
  // list the AGENT attribute set on the Agents graph and the CELL attribute set on
  // the Cells graph. Nodes are remounted on graph swap, so reading the kind at
  // render time is correct.
  const ownAttrList = ownAttrListFor(model);
  // Tag-attribute pickers (Get Constant / Compare / Switch tag mode) reference a
  // tag attribute purely for its OPTION NAMES. Scope = every attribute whose
  // discrete value the active graph can meaningfully read/compare:
  //  - Cells graph → model.attributes (cell + model) — byte-identical to the
  //    historical behaviour.
  //  - Agents graph → agent attributes + agent-accessible CELL FIELD attributes
  //    (agentAccess read|readWrite, via cellFieldAttrsOf) + shared model attributes.
  //    The cell-field arm matters when an agent samples/deposits a discrete cell
  //    field (Sample Field / Read Cells Under / Affect Cells Under / Secrete To
  //    Field) and then needs to compare or produce that CELL attribute's tag value
  //    on the Agents graph. (ownAttrList — used by Get/Set/Update Attribute — stays
  //    agent-only: those read/write the OWN agent via D-IDX, not the field.)
  const tagAttrScope = tagAttrScopeFor(model);
  const { updateNodeData } = useReactFlow();
  const updateNodeInternals = useUpdateNodeInternals();
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
          case 'bool':        newConfig.constValue = 'false'; break;
          case 'integer':     newConfig.constValue = '0'; break;
          case 'float':       newConfig.constValue = '0'; break;
          case 'tag':         newConfig.constValue = '0'; newConfig.tagAttributeId = ''; break;
          case 'orientation': newConfig.constValue = '0'; break;
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

  // --- EXPLICIT CONTROLS: the interface editor --------------------------------
  // Every mutation goes through the ONE semantics builder in explicitControls.ts
  // (`applyInterfaceEdit`), which returns the WHOLE `changes` object for exactly
  // ONE `updateMacro` — so this component is a thin dispatcher and the harness
  // drives the SAME code the UI does (the `inlineWidgetFor` extraction
  // precedent). Ids are minted HERE, keeping the builder deterministic.

  const groupsOf = macroDefForBoundary?.groups ?? [];
  const controlsOf = macroDefForBoundary?.controls ?? [];

  const editInterface = useCallback((edit: InterfaceEdit) => {
    if (!macroDefForBoundary || !macroDefIdForBoundary) return;
    updateMacro(macroDefIdForBoundary, applyInterfaceEdit(macroDefForBoundary, edit));
  }, [macroDefForBoundary, macroDefIdForBoundary, updateMacro]);

  /** Arm pick mode — the control itself is created only when a parameter is
   *  actually clicked, so cancelling (Esc / a scope change) leaves NOTHING
   *  behind. */
  const startPick = useCallback((controlId: string | 'new', groupId?: string) => {
    if (!macroDefIdForBoundary) return;
    setControlPick({ defId: macroDefIdForBoundary, controlId, ...(groupId ? { groupId } : {}) });
  }, [macroDefIdForBoundary]);

  const renameControl = useCallback((controlId: string, name: string) =>
    editInterface({ kind: 'control-rename', controlId, name }), [editInterface]);
  const removeControl = useCallback((controlId: string) =>
    editInterface({ kind: 'control-remove', controlId }), [editInterface]);
  const setControlGroup = useCallback((controlId: string, groupId: string) =>
    editInterface({ kind: 'control-group', controlId, groupId }), [editInterface]);
  const setPortGroup = useCallback((portId: string, groupId: string) =>
    editInterface({ kind: 'port-group', side: isMacroInput ? 'in' : 'out', portId, groupId }), [editInterface, isMacroInput]);
  const renameGroup = useCallback((groupId: string, name: string) =>
    editInterface({ kind: 'group-rename', groupId, name }), [editInterface]);
  const removeGroup = useCallback((groupId: string) =>
    editInterface({ kind: 'group-remove', groupId }), [editInterface]);

  const addGroup = useCallback(() => {
    editInterface({
      kind: 'group-add',
      group: {
        id: `grp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
        name: `Group ${groupsOf.length + 1}`,
      },
    });
  }, [editInterface, groupsOf.length]);

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

  // Vector stored attribute / variable: flip the value port to the composite
  // `vector` type so its HANDLE renders teal (portHandleClass) and the connection
  // highlight/validation agree. Covers the own Get/Set, the neighbour reads, the
  // by-id agent read/write, the neighbour writes, and Get/Set Variable — one rule
  // via vectorPortDims (null for every other node type, so calling it generically is
  // precise). Mirrors effectivePorts.getEffectivePorts (drag/drop + drop-menu) +
  // isValidConnection. The inline number widget is dropped (a vector isn't a scalar).
  if (vectorPortDims(nodeData.nodeType, nodeData.config, model)) {
    inputPorts = inputPorts.map(p => (p.id === 'value' ? { ...p, dataType: 'vector' as const, inlineWidget: undefined } : p));
    outputPorts = outputPorts.map(p => (p.id === 'value' ? { ...p, dataType: 'vector' as const } : p));
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
        const tagAttr = tagAttrScope.find(a => a.id === tagAttrId);
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
      } else if (valType === 'neighborIndex') {
        // Neighbor Index mode: the switched value AND each case's match value
        // are WIRED (there's no inline editor for a packed neighbor index).
        // Comparison is equality only. Suppress the value port's inline widget.
        inputPorts = inputPorts.map(p => p.id === 'value'
          ? { ...p, inlineWidget: undefined, dataType: 'neighborIndex' as const }
          : p);
        for (let i = 0; i < caseCount; i++) {
          inputPorts.push({
            id: `case_${i}_val`, label: `Case ${i}`,
            kind: 'input' as const, category: 'value' as const,
            dataType: 'neighborIndex' as const,
          });
          outputPorts.push({
            id: `case_${i}`, label: `Case ${i}`,
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
    // Keep the DONE pass-through at the TOP of the outputs (above the dynamic
    // CASE_N + DEFAULT ports) so chained nodes stay horizontally aligned with
    // the CHECK input. Mirrors effectivePorts.ts.
    outputPorts = [...outputPorts.filter(p => p.id === 'next'), ...outputPorts.filter(p => p.id !== 'next')];
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

  // Multi-attribute slots: extra `value_${i}` ports on the five accessor nodes
  // (get: outputs, set: inputs with type-adaptive inline widgets). Built by the
  // shared helper so this render + effectivePorts can't drift. See
  // multiAttrExpand.ts (the compile-time expansion into single-slot primitives).
  if (MULTI_ATTR_TYPES.has(nodeData.nodeType)) {
    const extraSlots = buildExtraSlotPorts(nodeData.nodeType, nodeData.config, model);
    inputPorts = [...inputPorts, ...extraSlots.inputs];
    outputPorts = [...outputPorts, ...extraSlots.outputs];
  }

  // Neighbour Census: one integer output per state value of the chosen tag/bool
  // agent attribute, labelled with the option name, BEFORE the static Total.
  // ONE shared builder with effectivePorts.ts (buildCensusPorts) so the render
  // and the drag/drop port model can't drift. See censusExpand.ts.
  if (nodeData.nodeType === 'neighbourCensus') {
    const censusPorts = buildCensusPorts(nodeData.nodeType, nodeData.config, model);
    outputPorts = [...censusPorts.outputs, ...outputPorts];
  }

  // Form Bond: one initial-value input per BOND attribute (P2), labelled with the
  // attribute name + a type-adaptive inline widget. Same shared builder as
  // effectivePorts.ts (buildBondAttrPorts). See bondAttrPorts.ts.
  if (nodeData.nodeType === 'formBond') {
    const bondPorts = buildBondAttrPorts(nodeData.nodeType, model);
    inputPorts = [...inputPorts, ...bondPorts.inputs];
  }

  // Input Mapping roots (cell `inputColor` / `agentInputMapping`): one value
  // output per resolved CHANNEL of the referenced mapping's declared
  // `parameters`. No declared parameters ⇒ the legacy colour parameter ⇒ the
  // historical R/G/B ports (so every existing model's wires are untouched).
  // ONE shared builder with effectivePorts.ts (buildInputParamPorts).
  if (isInputMappingRoot(nodeData.nodeType)) {
    const paramPorts = buildInputParamPorts(nodeData.nodeType, nodeData.config, model);
    outputPorts = [...outputPorts, ...paramPorts.outputs];
  }

  // Table Lookup: shape the index inputs per the referenced table — legacy
  // 2-axis keeps Row/Col (axis_* dropped); a MULTI-AXIS table shows one input
  // per axis, labeled with the axis names. ONE shared shaper with
  // effectivePorts.ts (applyLookupAxisPorts) so the two can't drift.
  if (nodeData.nodeType === 'lookupInteraction') {
    inputPorts = applyLookupAxisPorts(inputPorts, nodeData.config, model);
  }

  // Expression / Logical Expression: show only `visibleCount` of the 8 input
  // ports, relabelled with the user's variable names. Mirrors effectivePorts.ts
  // (UI-only — all 8 ports stay in def.ports so the compilers resolve them).
  if (FORMULA_NODE_TYPES.has(nodeData.nodeType)) {
    const visibleCount = clampVisibleCount(nodeData.config.visibleCount);
    inputPorts = inputPorts.slice(0, visibleCount).map(p => {
      const nm = nodeData.config[`_varName_${p.id}`];
      return (typeof nm === 'string' && nm.trim()) ? { ...p, label: nm.trim() } : p;
    });
  }

  // Mode-dependent static-port hiding is declared once on each node def
  // (def.hiddenPorts(config) → port ids to drop) and applied here AND in
  // effectivePorts.ts via the same hook, so the rule can't drift between the
  // two. Covers GetModelAttribute (r/g/b vs value), Logic NOT, Update
  // Attribute / Update Indicator unary ops, Get Random (probability/options/
  // fallback by type), Compare / Count Matching between-bounds, Group Reduce
  // Position, Math unary Y, … Nodes that ADD/transform ports per config
  // (switch/sequence/expression, above) keep that logic inline — this hook
  // only removes static ports.
  if (def?.hiddenPorts) {
    // The active rule graph is threaded so a UNIVERSAL node can drop a port that
    // only means something on one graph (setAttribute's optional `agentId`).
    const hidden = def.hiddenPorts(nodeData.config, model, getActiveGraphKind());
    if (hidden.length > 0) {
      const drop = new Set(hidden);
      inputPorts = inputPorts.filter(p => !drop.has(p.id));
      outputPorts = outputPorts.filter(p => !drop.has(p.id));
    }
  }

  // Detect which input ports are connected (for inline widget visibility).
  // Uses a graph-level pub/sub in graphState.ts instead of useStore(edges) so this node only
  // re-renders when *its* connected handles actually change (not on every pan/zoom/store event).
  const connectedInputHandles = useSyncExternalStore(
    subscribeConnectedHandles,
    () => getConnectedHandlesForNode(id),
  );

  // EXPLICIT CONTROLS — pick mode. Same single-pub/sub pattern: a `memo`'d node
  // would otherwise never learn the mode was armed.
  const controlPick = useSyncExternalStore(subscribeControlPick, getControlPick);

  // The parameters of THIS node a pick would bind — computed ONLY while pick
  // mode is armed AND this node really belongs to the def being edited (the
  // scope effect seeds the canvas from `def.nodes` with ids UNCHANGED, so an id
  // lookup inside that def is exact). Gating on both is what keeps
  // `eligibleControlKeys` — which calls `getEffectivePorts` — off every node's
  // ordinary render path.
  //
  // `connectedInputHandles` is the LIVE canvas set rather than `def.edges`: it
  // is what actually decides whether the in-place widget is rendered, so
  // passing it makes the in-place / overlay partition below exact by
  // construction (a wired port shows no widget, so it can only be offered as an
  // overlay row).
  const pickRows: ControlKeyDescriptor[] = useMemo(() => {
    if (!controlPick) return [];
    const pickDef = (model.macroDefs || []).find(d => d.id === controlPick.defId);
    if (!pickDef || !pickDef.nodes.some(n => n.id === id)) return [];
    return eligibleControlKeys(nodeData.nodeType, nodeData.config, model, connectedInputHandles);
  }, [controlPick, model, id, nodeData.nodeType, nodeData.config, connectedInputHandles]);

  // The in-place / overlay PARTITION (deviation V6, extended): a class-A key is
  // outlined on its REAL widget when that widget is on screen, and appears as an
  // overlay row when it is not — which happens exactly when the port is WIRED
  // (`showWidget` = kind && !isConnected). Both sides read the same `wired`
  // flag, computed from the same live handle set, so the two are exact
  // complements: every eligible key is offered EXACTLY once.
  const pickInPlaceKeys = useMemo(
    () => new Set(pickRows.filter(r => r.klass === 'A' && !r.wired).map(r => r.configKey)),
    [pickRows],
  );
  const pickOverlayRows = useMemo(
    () => pickRows.filter(r => r.klass !== 'A' || r.wired),
    [pickRows],
  );

  /**
   * Bind the armed pick to ONE (nodeId, configKey) — ONE `updateMacro`.
   *
   * `controlId: 'new'` APPENDS a control named after the parameter's own label;
   * a real id RE-BINDS that control, preserving its `id` / `name` / `groupId`
   * (the ✎ path — a fresh id would strand every chained target naming it).
   */
  const bindPick = useCallback((configKey: string, label: string) => {
    const pick = getControlPick();
    if (!pick) return;
    const pickDef = (model.macroDefs || []).find(d => d.id === pick.defId);
    if (!pickDef) { setControlPick(null); return; }
    const target: MacroControl['target'] = { kind: 'config', nodeId: id, configKey };
    const edit: InterfaceEdit = pick.controlId === 'new'
      ? {
        kind: 'control-add',
        control: {
          id: `ctl_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
          name: label,
          target,
          ...(pick.groupId ? { groupId: pick.groupId } : {}),
        },
      }
      // Re-bind (✎): `applyInterfaceEdit` moves the TARGET only, preserving the
      // control's id / name / groupId — a fresh id would strand every chained
      // target naming it.
      : { kind: 'control-rebind', controlId: pick.controlId, target };
    updateMacro(pick.defId, applyInterfaceEdit(pickDef, edit));
    setControlPick(null);
  }, [model, id, updateMacro]);

  // --- EXPLICIT CONTROLS: the CLOSED INSTANCE's interface (P3) ---------------
  // The macro def this node instantiates. Hoisted above `configIssues` so the
  // roll-up below can count blocked controls; `linkCount` / `makeIndependent`
  // read the same const further down.
  const macroDefId = nodeData.nodeType === 'macro' ? (nodeData.config.macroDefId as string | undefined) : undefined;

  // R7 — the def(s) currently OPEN for editing. A control whose target lives in
  // an open def renders disabled: the open canvas re-syncs that def through the
  // 100 ms debounce, so an instance-side write would be clobbered.
  const openScopeIds = useSyncExternalStore(subscribeOpenMacroScope, getOpenMacroScope);

  /**
   * The interface this instance renders, already SECTIONED.
   *
   * Ordered by `groupSections`, which is `orderByGroup` — the SAME call the
   * boundary editor reorders `exposedInputs` with — so the closed instance and
   * the editor cannot disagree about what the interface looks like.
   *
   * Every row carries a resolved descriptor; an unresolvable one comes back
   * with `block` + a sentence rather than being dropped (D8).
   */
  const controlSections = useMemo(() => {
    if (!macroDefId) return [];
    const mdef = (model.macroDefs || []).find(m => m.id === macroDefId);
    const controls = mdef?.controls ?? [];
    if (controls.length === 0) return [];
    return groupSections(controls, mdef?.groups ?? []).map(sec => ({
      group: sec.group,
      rows: sec.items.map(control => ({
        control,
        desc: resolveControlDescriptor(model, macroDefId, control, openScopeIds),
      })),
    }));
  }, [model, macroDefId, openScopeIds]);

  /** How many controls are BROKEN (orphaned / circular) — the badge roll-up.
   *  `wired` / `scope-open` are deliberate states and deliberately not counted. */
  const controlIssueCount = useMemo(
    () => controlSections.reduce(
      (n, s) => n + s.rows.filter(r => r.desc.block && CONTROL_BLOCK_NEEDS_ATTENTION.has(r.desc.block)).length,
      0,
    ),
    [controlSections],
  );

  /** The LIVE model, read by the control write handler. A captured closure can
   *  be one edit behind (the `commitAgentSweep` ref-leads-state trap), and this
   *  handler builds a whole node array from it. Assigned during render so it
   *  leads any state the same paint produced. */
  const modelRef = useRef(model);
  modelRef.current = model;

  /**
   * Commit ONE control edit — exactly ONE `updateMacro` (D6).
   *
   * `applyControlValue` returns the def that OWNS the key (a NESTED def for a
   * chained control) with its fully-patched node array, and `null` when the
   * control is BLOCKED — so a disabled row's handler is inert STRUCTURALLY, not
   * by a UI convention.
   */
  const setControlValue = useCallback((control: MacroControl, value: string) => {
    if (!macroDefId) return;
    const patch = applyControlValue(modelRef.current, macroDefId, control, value, getOpenMacroScope());
    if (!patch) return;
    updateMacro(patch.defId, { nodes: patch.nodes });
  }, [macroDefId, updateMacro]);

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
      // C4 - badge for the engine that will actually RUN. Under `engine: 'auto'`
      // the legacy mirror flags can lag a graph edit, so read the resolution
      // (memoised per model object, so this stays O(1) per node).
      const resolvedGrid = resolveEngines(model).grid.resolved;
      const useWebGPU = resolvedGrid === 'webgpu';
      const useWasm = resolvedGrid === 'wasm';
      const base = detectMissingConfig(nodeData.nodeType, nodeData.config, model, connectedInputHandles);
      const capability = detectCapabilityRequirements(nodeData.nodeType, model);
      // Init-vs-Behaviour footgun: a per-agent (self) node wired into the Agent
      // Init Event (which has no per-agent `idx` loop) — a design-time warning
      // instead of the cryptic "init compile failed: idx is not defined" at runtime.
      const initCtx = detectAgentInitContextIssue(id, model);
      const own = useWebGPU
        ? [...base, ...capability, ...initCtx, ...detectWebGPUIncompatibilities(nodeData.nodeType, nodeData.config, model)]
        : useWasm
          ? [...base, ...capability, ...initCtx, ...detectWasmIncompatibilities(nodeData.nodeType, nodeData.config, model)]
          : [...base, ...capability, ...initCtx];
      // Bubble up internal-node warnings on macro instances so they're visible
      // without expanding the macro (and recursively through nested macros).
      if (nodeData.nodeType === 'macro') {
        if (typeof macroDefId === 'string' && macroDefId.length > 0) {
          const innerCount = countMacroSubgraphIssues(macroDefId, model, useWebGPU, useWasm);
          if (innerCount > 0) {
            own.push(`${innerCount} internal warning${innerCount === 1 ? '' : 's'} (expand macro to see)`);
          }
        }
        // EXPLICIT CONTROLS (D8) — an orphaned or circular control is REPORTED,
        // never dropped: the row renders disabled with its reason, and this
        // rolls it onto the badge so a COLLAPSED instance still says so.
        if (controlIssueCount > 0) {
          own.push(`${controlIssueCount} control${controlIssueCount === 1 ? '' : 's'} ${controlIssueCount === 1 ? 'needs' : 'need'} attention`);
        }
      }
      // Connection-kind hazards (typed-port mismatches that the runtime would silently accept)
      if (connectionHazards.length > 0) {
        for (const h of connectionHazards) own.push(h);
      }
      // Declared-but-unwired alpha (the silent-transparency trap): setting a
      // non-opaque alpha on a colour node's palette grows its A OUTPUT port
      // (Option A), but nothing flows until that port is wired into Set Cell
      // Looks' A input — the alpha otherwise has NO effect anywhere, which
      // reads as "transparency doesn't work". Surface it as a badge.
      const declaredAlpha =
        nodeData.nodeType === 'colorScale' ? colorScaleHasAlpha(nodeData.config)
        : nodeData.nodeType === 'categoricalColor' ? categoricalHasAlpha(nodeData.config)
        : nodeData.nodeType === 'getColorConstant' ? colorConstantHasAlpha(nodeData.config)
        : false;
      if (declaredAlpha && !connectedInputHandles.has('output_value_a')) {
        own.push("Alpha is set but the A output is unwired — wire it into Set Cell Looks' A input for the transparency to take effect");
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
      // detectMissingConfig reads variables/agentVariables/agentAttributes and
      // detectCapabilityRequirements reads topologyMode/dimension — without these
      // deps the memoized badge goes stale on a Local-Variable kind change, an
      // agent-attribute edit, or a topology/dimension toggle.
      model.variables,
      model.agentVariables,
      model.agentAttributes,
      model.topologyMode,
      // C4: the resolved grid engine - Auto re-picks as the graph is edited, so
      // the selection AND the inputs the Auto policy reads are the real dependency.
      model.properties.engine,
      model.properties.useWebGPU,
      model.properties.useWasm,
      model.overseerConfig?.enabled,
      model.graphNodes,
      model.properties.updateMode,
      model.properties.dimension,
      model.variegatedCells?.enabled,
      // detectAgentInitContextIssue walks the agent graph (flow + value cone from
      // the agentInit root) — recompute the badge when the agent graph changes.
      id,
      model.agentGraphNodes,
      model.agentGraphEdges,
      connectionHazards,
      connectedInputHandles,
      // EXPLICIT CONTROLS — the roll-up's own input.
      macroDefId,
      controlIssueCount,
    ],
  );

  const userLabel = nodeData.label as string | undefined;
  const isCollapsed = !!nodeData.isCollapsed;

  // Hover-to-uncollapse: temporarily expand when a connection is being dragged over
  const [hoverExpand, setHoverExpand] = useState(false);
  const onMouseEnter = useCallback(() => {
    if (!isCollapsed || !isConnectingGlobal) return;
    // Only force-expand to DISAMBIGUATE which port the wire should land on. The
    // compatible side depends on the drag origin: dragging from an output, the
    // wire connects to one of OUR inputs; from an input, to one of our outputs.
    // If that side has a single category-matching port there's nothing to choose
    // — releasing on the collapsed node lands on it directly — so stay collapsed.
    const cf = connectingFrom;
    if (cf) {
      const side = cf.kind === 'input' ? outputPorts : inputPorts;
      let compatibleCount = 0;
      for (const p of side) {
        if (p.category === cf.category && id !== cf.nodeId) compatibleCount++;
      }
      if (compatibleCount <= 1) return;
    }
    setHoverExpand(true);
  }, [isCollapsed, inputPorts, outputPorts, id]);
  const onMouseLeave = useCallback(() => {
    if (hoverExpand) setHoverExpand(false);
  }, [hoverExpand]);

  /** Prevent mouseDown on inputs/selects from initiating a node drag (LMB only, let RMB through for pan) */
  const stopDrag = useCallback((e: React.MouseEvent) => {
    if (e.button === 0) e.stopPropagation();
  }, []);
  /** Stop all propagation (for double-click, click handlers) */
  const stopAll = useCallback((e: React.MouseEvent) => e.stopPropagation(), []);
  /** Height of the expression textarea at the start of a resize drag (mousedown),
   *  so mouseup can detect a deliberate resize and persist it to config. Width is
   *  the NODE's (see `_exprW` below), so the textarea only resizes vertically. */
  const exprResizeStartRef = useRef<{ h: number } | null>(null);
  /** Expression node WIDTH drag (the grip at the node's bottom-right corner).
   *  Live width is held in local state so a drag re-renders only this node —
   *  committing to config on every pointermove would spam `updateNodeData` and
   *  the debounced graph sync. Committed to `_exprW` on pointerup. */
  const [exprDragW, setExprDragW] = useState<number | null>(null);
  //  `cur` LEADS the state: pointerup runs in the same gesture as the moves, and
  //  React batches, so a fast (or synthetic) drag commits before any re-render —
  //  reading the render-time `exprDragW` there would see the value from BEFORE
  //  the drag and silently discard it (the `commitAgentSweep` fast-click trap).
  const exprDragRef = useRef<{ x: number; w: number; min: number; cur: number } | null>(null);
  /** The node's NATURAL (content-derived) width, sampled the first time a drag
   *  starts while no explicit width is set — that measurement IS the natural
   *  width, and it becomes the drag's lower bound so a resize can never make the
   *  node narrower than it would be on its own. A node reloaded with a saved
   *  width has no such sample, so it falls back to `EXPR_MIN_W` — which is the
   *  CSS `.node { min-width }` floor anyway, and a double-click on the grip
   *  restores auto-sizing. */
  const exprNaturalWRef = useRef<number | null>(null);
  const nodeRootRef = useRef<HTMLDivElement | null>(null);
  /** Expression node: the rendered formula is the node's FACE and the text
   *  editor collapses below it. This latch keeps the editor open while the
   *  user is TYPING — without it, the moment a fresh node's text first parses
   *  the derived "renders fine ⇒ collapsed" rule would shut the textarea under
   *  the cursor. Session-scoped on purpose: only an explicit toggle persists
   *  (`_exprExpanded`), so a saved model reopens showing the formula. */
  const [exprEditLatch, setExprEditLatch] = useState(false);
  const exprTextRef = useRef<HTMLTextAreaElement | null>(null);
  /** One-shot focus for the render right after the user OPENS the editor —
   *  never on mount, which would steal focus while a graph loads. */
  const exprWantFocusRef = useRef(false);
  useEffect(() => {
    if (!exprWantFocusRef.current) return;
    exprWantFocusRef.current = false;
    exprTextRef.current?.focus();
  });

  // Linked-copies badge (Blender-style): how many macro instances share this
  // node's MacroDef. Only shown at 2+ (single-user macros show nothing).
  // (`macroDefId` is hoisted above `configIssues` — the control roll-up needs it.)
  const linkCount = useMemo(
    () => (typeof macroDefId === 'string' && macroDefId.length > 0 ? countMacroInstances(model, macroDefId) : 0),
    [model.graphNodes, model.macroDefs, macroDefId],
  );
  const [showLinkMenu, setShowLinkMenu] = useState(false);
  /** Break the link for THIS instance only: clone the MacroDef and retarget the node. */
  const makeIndependent = useCallback(() => {
    if (!macroDefId) return;
    const srcDef = (model.macroDefs || []).find(m => m.id === macroDefId);
    if (!srcDef) { setShowLinkMenu(false); return; }
    const newId = importMacro(srcDef);
    updateNodeData(id, { ...nodeData, config: { ...nodeData.config, macroDefId: newId } });
    setShowLinkMenu(false);
  }, [id, nodeData, macroDefId, model.macroDefs, importMacro, updateNodeData]);

  const showExpanded = !isCollapsed || hoverExpand;

  // Collapsed nodes fan their CONNECTED handles out around the vertical centre
  // (see the collapsed render branch). Those positions change when an edge is
  // added/removed WITHOUT the node's size changing, so React Flow won't
  // re-measure handle bounds on its own — nudge it whenever the connected set
  // or the collapse state flips.
  useEffect(() => {
    if (isCollapsed) updateNodeInternals(id);
  }, [updateNodeInternals, id, isCollapsed, showExpanded, connectedInputHandles]);

  // Re-measure handle bounds whenever the VISIBLE (post-hiddenPorts / dynamic)
  // port set changes. A config that hides/shows or SWAPS ports — Vector Op's
  // `op` dropdown (add[a,b] → scale[a,s], or add → dot swapping result→value),
  // Get Agent Position's `mode`, Switch/Sequence dynamic ports, … — can keep the
  // node HEIGHT unchanged, so React Flow's ResizeObserver never fires and a
  // newly-shown handle keeps stale/absent bounds → it silently rejects
  // connections until something else forces a remeasure. Keying on the port-id
  // signature fixes that for every config-driven port change in one place.
  const portIdSignature = inputPorts.map(p => p.id).join(',') + '|' + outputPorts.map(p => p.id).join(',');
  useEffect(() => {
    updateNodeInternals(id);
  }, [updateNodeInternals, id, portIdSignature]);

  const isCompact = nodeData.nodeType === 'step'
    || nodeData.nodeType === 'conditional'
    || nodeData.nodeType === 'sequence';

  // The two MAIN execution/flow ports — the primary flow IN (the single flow
  // input) and the primary flow OUT (the `next` continuation, or the first flow
  // output for event roots / Sequence). These are lifted out of the body and
  // pinned at the vertical centre of the header (Unreal-blueprint style: one
  // exec pin in at top-left, one out at top-right), so the body rows below carry
  // only the data ports + any branch flow ports (THEN/ELSE/BODY/CASE_N…).
  const mainFlowIn = inputPorts.find(p => p.category === 'flow') ?? null;
  const mainFlowOut =
    outputPorts.find(p => p.id === 'next') ??
    outputPorts.find(p => p.category === 'flow') ??
    null;
  const bodyInputPorts = mainFlowIn ? inputPorts.filter(p => p !== mainFlowIn) : inputPorts;
  const bodyOutputPorts = mainFlowOut ? outputPorts.filter(p => p !== mainFlowOut) : outputPorts;

  // Dynamic height to fit the BODY ports (the lifted main flow ports live in the
  // header and don't occupy a body row). Body ports use a single uniform spacing
  // across ALL node types so a branch flow output (THEN/ELSE on Conditional,
  // THEN/Then-N on Sequence) lands on the exact same row grid as BODY/CASE/DEFAULT
  // on Loop/ForEach/Switch. (Previously the `isCompact` nodes — step/conditional/
  // sequence — used tighter spacing, which, once the main flow ports moved to the
  // header, left their remaining body ports sitting higher and closer together
  // than every other node.)
  // Body-port handles are absolutely positioned from the NODE's top, so when a
  // user label (rename) adds its strip above the header, the body's first row
  // shifts down by exactly the label height — add it to the base or the data /
  // branch ports ride up onto the header and overlap the main flow pins. The
  // main flow handles need no adjustment: they live INSIDE the header (top:50%)
  // and move with it. USER_LABEL_HEIGHT mirrors .userLabel in CaNode.module.css
  // (var(--space-1) padding ×2 + ~14px line + 1px border-bottom ≈ 21px, measured).
  const USER_LABEL_HEIGHT = 21;
  const PORT_TOP_BASE = 30 + (userLabel ? USER_LABEL_HEIGHT : 0);
  const maxPorts = Math.max(bodyInputPorts.length, bodyOutputPorts.length);
  const portSpacing = 22;
  const nodeMinHeight = showExpanded ? Math.max(50, PORT_TOP_BASE + maxPorts * portSpacing) : undefined;

  // --- Expression node: user-resizable WIDTH -------------------------------
  // A formula is a picture that gets WIDE (`contain: inline-size` deliberately
  // keeps it from widening the node, so a long one scrolls inside the body).
  // The fix is to let the user widen the NODE and have the formula fill it:
  // `.body` is a flex column whose children stretch, and the formula's root is
  // `align-self: stretch`, so one width on the root reaches every control —
  // formula, textarea and the two collapsible summary rows alike.
  //
  // `_exprW` is that width. It USED to size only the textarea (which, with
  // `min-width: 100%` on a content-sized node, already dragged the node wider
  // whenever the editor happened to be open) — one width, now honest about what
  // it sizes and available in EVERY state, including the default one where the
  // editor is collapsed and the formula IS the node's face. Same key, same
  // stored numbers, so a model saved before this keeps its width.
  //
  // Compiler-invisible by the documented convention: `_`-prefixed and neither
  // `_port_*` nor `_varName_*`, which is exactly what accessorCSE's purity-key
  // filter drops — so it cannot perturb CSE or any emit.
  // Both free-text formula nodes (math Expression + boolean Logical Expression)
  // share this machinery — same key, same grip, same bounds.
  const isExpression = FORMULA_NODE_TYPES.has(nodeData.nodeType);
  const exprCfgW = isExpression ? Number(nodeData.config._exprW) || 0 : 0;
  /** The width actually applied this render: a live drag beats the stored value,
   *  and 0/absent means auto (content-sized, the historical default). */
  const exprWidth = isExpression ? (exprDragW ?? (exprCfgW > 0 ? exprCfgW : null)) : null;

  const onExprGripDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const w = nodeRootRef.current?.offsetWidth ?? EXPR_MIN_W;
    // No explicit width yet ⇒ what we just measured IS the natural width.
    if (exprCfgW <= 0) exprNaturalWRef.current = w;
    exprDragRef.current = { x: e.clientX, w, min: Math.max(EXPR_MIN_W, exprNaturalWRef.current ?? 0), cur: w };
    setExprDragW(w);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onExprGripMove = (e: React.PointerEvent) => {
    const d = exprDragRef.current;
    if (!d) return;
    d.cur = Math.round(Math.min(EXPR_MAX_W, Math.max(d.min, d.w + (e.clientX - d.x))));
    setExprDragW(d.cur);
  };
  const onExprGripUp = (e: React.PointerEvent) => {
    const d = exprDragRef.current;
    if (!d) return;
    exprDragRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    setExprDragW(null);
    if (d.cur === exprCfgW) return;
    updateNodeData(id, { ...nodeData, config: { ...nodeData.config, _exprW: d.cur } });
  };
  /** Double-click the grip ⇒ back to auto-sizing (the splitter convention). */
  const onExprGripDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    exprDragRef.current = null;
    setExprDragW(null);
    if (exprCfgW <= 0) return;
    const newConfig: NodeConfig = { ...nodeData.config };
    delete newConfig._exprW;
    updateNodeData(id, { ...nodeData, config: newConfig });
  };

  // A width change moves the RIGHT-EDGE output handles without necessarily
  // changing the node's HEIGHT, and the port-signature effect above keys on port
  // IDS — so neither of the existing re-measure triggers is guaranteed to fire.
  // React Flow's own ResizeObserver does catch a width change, but nudging it
  // here is cheap and makes the guarantee explicit rather than incidental (the
  // documented cost of a stale handle bound is a port that silently refuses
  // connections). Runs during the drag too, so edges track the grip live.
  useEffect(() => {
    if (isExpression) updateNodeInternals(id);
  }, [updateNodeInternals, id, isExpression, exprWidth]);

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
        const tagAttr = tagAttrScope.find(a => a.id === nodeData.config.tagAttributeId);
        const tagIdx = parseInt(cVal, 10) || 0;
        collapsedLabel = tagAttr?.tagOptions?.[tagIdx] ?? (cVal || '0');
      }
      else collapsedLabel = cVal || '0';
    } else if (nodeData.nodeType === 'getCellAttribute') {
      const attr = ownAttrList.find(a => a.id === nodeData.config.attributeId);
      const extra = multiAttrExtraCount(nodeData.config);
      collapsedLabel = (attr ? `Cell - ${attr.name}` : displayNodeLabel(def)) + (extra > 0 ? ` +${extra}` : '');
    } else if (nodeData.nodeType === 'getModelAttribute') {
      const attr = model.attributes.find(a => a.id === nodeData.config.attributeId);
      const extra = multiAttrExtraCount(nodeData.config);
      collapsedLabel = (attr ? `Model - ${attr.name}` : displayNodeLabel(def)) + (extra > 0 ? ` +${extra}` : '');
    } else if (nodeData.nodeType === 'setAttribute') {
      const attr = ownAttrList.find(a => a.id === nodeData.config.attributeId);
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
        const extra = multiAttrExtraCount(nodeData.config);
        if (extra > 0) collapsedLabel += ` +${extra}`;
      } else { collapsedLabel = displayNodeLabel(def); }
    } else if (nodeData.nodeType === 'updateAttribute') {
      const attr = ownAttrList.find(a => a.id === nodeData.config.attributeId);
      const op = (nodeData.config.operation as string) || 'increment';
      const opLabels: Record<string, string> = {
        increment: '+', decrement: '-', max: 'Max', min: 'Min',
        toggle: 'Toggle', or: 'OR', and: 'AND',
        next: 'Next', previous: 'Prev',
      };
      collapsedLabel = attr ? `${opLabels[op] ?? op} ${attr.name}` : displayNodeLabel(def);
    } else if (nodeData.nodeType === 'getNeighborsAttribute' || nodeData.nodeType === 'getNeighborAttributeByIndex' || nodeData.nodeType === 'getNeighborsAttrByIndexes') {
      const attr = model.attributes.find(a => a.id === nodeData.config.attributeId);
      const nbr = model.neighborhoods.find(n => n.id === nodeData.config.neighborhoodId);
      collapsedLabel = attr && nbr ? `${nbr.name}[${attr.name}]` : displayNodeLabel(def);
    } else if (nodeData.nodeType === 'setNeighborhoodAttribute' || nodeData.nodeType === 'setNeighborAttributeByIndex') {
      const attr = model.attributes.find(a => a.id === nodeData.config.attributeId);
      const nbr = model.neighborhoods.find(n => n.id === nodeData.config.neighborhoodId);
      collapsedLabel = attr && nbr ? `Set ${nbr.name}[${attr.name}]` : displayNodeLabel(def);
    } else if (nodeData.nodeType === 'sampleField' || nodeData.nodeType === 'fieldGradient'
      || nodeData.nodeType === 'readCellsUnder' || nodeData.nodeType === 'affectCellsUnder'
      || nodeData.nodeType === 'secreteToField') {
      // Field-bridge nodes target a CELL (field) attribute.
      const attr = cellAttrsOf(model).find(a => a.id === nodeData.config.attributeId);
      collapsedLabel = attr ? `${displayNodeLabel(def)} · ${attr.name}` : displayNodeLabel(def);
    } else if (nodeData.nodeType === 'neighbourCensus') {
      const attr = censusAttributes(model).find(a => a.id === nodeData.config.attributeId);
      const src = nodeData.config.source === 'nearby' ? ' (nearby)' : '';
      collapsedLabel = attr ? `Census · ${attr.name}${src}` : displayNodeLabel(def);
    } else if (nodeData.nodeType === 'setCellLooks') {
      const glyphTag = nodeData.config.useGlyph ? ' + glyph' : '';
      if (nodeData.config.mappingId === CURRENT_VIEWER_SENTINEL) {
        collapsedLabel = `Looks - Current Selected${glyphTag}`;
      } else {
        // Cell OR agent mapping (Set Cell Looks is universal across both graphs).
        const mapping = model.mappings.find(m => m.id === nodeData.config.mappingId)
          ?? (model.agentMappings ?? []).find(m => m.id === nodeData.config.mappingId);
        collapsedLabel = mapping ? `Looks - ${mapping.name}${glyphTag}` : displayNodeLabel(def);
      }
    } else if (nodeData.nodeType === 'inputColor') {
      const mapping = model.mappings.find(m => m.id === nodeData.config.mappingId);
      collapsedLabel = mapping ? `C\u2192A: ${mapping.name}` : displayNodeLabel(def);
    } else if (nodeData.nodeType === 'outputMapping') {
      const mapping = model.mappings.find(m => m.id === nodeData.config.mappingId);
      collapsedLabel = mapping ? `A\u2192C: ${mapping.name}` : displayNodeLabel(def);
    } else if (nodeData.nodeType === 'assertActiveViewer') {
      const mapping = model.mappings.find(m => m.id === nodeData.config.mappingId);
      collapsedLabel = mapping ? `If viewing: ${mapping.name}` : displayNodeLabel(def);
    } else if (nodeData.nodeType === 'agentOutputMapping') {
      const mapping = (model.agentMappings ?? []).find(m => m.id === nodeData.config.mappingId);
      collapsedLabel = mapping ? `Agent A\u2192C: ${mapping.name}` : displayNodeLabel(def);
    } else if (nodeData.nodeType === 'agentInputMapping') {
      const mapping = (model.agentMappings ?? []).find(m => m.id === nodeData.config.mappingId);
      collapsedLabel = mapping ? `Agent C\u2192A: ${mapping.name}` : displayNodeLabel(def);
    } else if (nodeData.nodeType === 'setAgentSprite') {
      const sprite = (model.sprites ?? []).find(s => s.id === nodeData.config.spriteId);
      collapsedLabel = sprite ? `Sprite - ${sprite.name}` : displayNodeLabel(def);
    } else if (nodeData.nodeType === 'getIndicator') {
      const ind = (model.indicators || []).find(i => i.id === nodeData.config.indicatorId);
      collapsedLabel = ind ? `Ind - ${ind.name}` : displayNodeLabel(def);
    } else if (nodeData.nodeType === 'setIndicator') {
      const ind = (model.indicators || []).find(i => i.id === nodeData.config.indicatorId);
      collapsedLabel = ind ? `Set Ind - ${ind.name}` : displayNodeLabel(def);
    } else if (nodeData.nodeType === 'updateIndicator') {
      const ind = (model.indicators || []).find(i => i.id === nodeData.config.indicatorId);
      collapsedLabel = ind ? `Upd Ind - ${ind.name}` : displayNodeLabel(def);
    } else if (nodeData.nodeType === 'statement') {
      const op = (nodeData.config.operation as string) || '==';
      const cmpType = (nodeData.config.compareType as string) || 'numerical';
      // Format an inline operand by the chosen compare type so the collapsed
      // title reads naturally (tag NAME instead of its index; True/False for bool).
      const fmtOperand = (raw: string): string => {
        if (cmpType === 'bool') return (raw === 'true' || raw === '1') ? 'True' : 'False';
        if (cmpType === 'tag') {
          const tagAttr = tagAttrScope.find(a => a.id === nodeData.config.tagAttributeId);
          const idx = parseInt(raw, 10) || 0;
          return tagAttr?.tagOptions?.[idx] ?? raw;
        }
        return raw;
      };
      const xConn = connectedInputHandles.has(handleId({ id: 'x', kind: 'input', category: 'value' }));
      const yConn = connectedInputHandles.has(handleId({ id: 'y', kind: 'input', category: 'value' }));
      const xVal = xConn ? '?' : fmtOperand((nodeData.config._port_x as string) ?? '0');
      const yVal = yConn ? '?' : fmtOperand((nodeData.config._port_y as string) ?? '0');
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
      const unary = ARITHMETIC_UNARY_OPS.has(op);
      collapsedLabel = unary ? `${op}(${xVal})` : `${xVal} ${op} ${yVal}`;
    } else if (FORMULA_NODE_TYPES.has(nodeData.nodeType)) {
      const expr = ((nodeData.config.expression as string) ?? '').trim();
      const fallback = nodeData.nodeType === 'expression' ? 'Expression' : 'Logic formula';
      collapsedLabel = expr ? (expr.length > 18 ? `${expr.slice(0, 18)}…` : expr) : fallback;
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
      collapsedLabel = attr && nbr ? `Filter ${nbr.name}[${attr.name}] ${opSymbols[op] ?? op}` : displayNodeLabel(def);
    } else if (nodeData.nodeType === 'joinNeighbors') {
      const op = (nodeData.config.operation as string) || 'intersection';
      collapsedLabel = op === 'union' ? 'Join (OR)' : 'Join (AND)';
    } else {
      collapsedLabel = displayNodeLabel(def);
    }

    // Color swatch for collapsed color constant
    const colorSwatchHex = isColorConstant
      ? `rgb(${nodeData.config.r || 128},${nodeData.config.g || 128},${nodeData.config.b || 128})`
      : undefined;

    // Color preview dot for nodes with unconnected color inline inputs
    let collapsedColorPreview: string | undefined;
    if (nodeData.nodeType === 'setCellLooks') {
      // Preview the dominant color: the cell color when it's painted (plain mode
      // or glyph mode with a background), otherwise the glyph color.
      const showsBg = !nodeData.config.useGlyph || nodeData.config.setBackground !== false;
      const ch = showsBg ? ['r', 'g', 'b'] : ['glyphR', 'glyphG', 'glyphB'];
      const conn = ch.some(id => connectedInputHandles.has(handleId({ id, kind: 'input', category: 'value' })));
      if (!conn) {
        const dflt = showsBg ? '0' : '255';
        const pr = parseInt(String(nodeData.config[`_port_${ch[0]}`] ?? dflt), 10) || 0;
        const pg = parseInt(String(nodeData.config[`_port_${ch[1]}`] ?? dflt), 10) || 0;
        const pb = parseInt(String(nodeData.config[`_port_${ch[2]}`] ?? dflt), 10) || 0;
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

        {/* Handles — CONNECTED ports fan out around the vertical centre with a
            tight spacing so the user can still tell which wire lands on which
            port without expanding the node; unconnected ports stay stacked at
            the centre (they're only drag targets). */}
        {(() => {
          const SPREAD = 11; // px between connected handles (tighter than expanded rows)
          const spreadTop = (i: number, n: number): string =>
            n <= 1 ? '50%' : `calc(50% + ${Math.round((i - (n - 1) / 2) * SPREAD)}px)`;
          const renderSide = (ports: PortDef[], kind: 'input' | 'output') => {
            const connectedPorts = ports.filter(p => connectedInputHandles.has(handleId(p)));
            const connIdx = new Map(connectedPorts.map((p, i) => [p.id, i]));
            return ports.map(port => {
              const ci = connIdx.get(port.id);
              return (
                <Handle
                  key={handleId(port)}
                  type={kind === 'input' ? 'target' : 'source'}
                  position={kind === 'input' ? Position.Left : Position.Right}
                  id={handleId(port)}
                  className={portHandleClass(port)}
                  style={{ top: ci !== undefined ? spreadTop(ci, connectedPorts.length) : '50%' }}
                  title={port.label}
                />
              );
            });
          };
          return (
            <>
              {renderSide(inputPorts, 'input')}
              {renderSide(outputPorts, 'output')}
            </>
          );
        })()}

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

  // Render a MAIN flow handle pinned to the vertical centre of the header. It
  // lives inside the (position:relative) header so `top: 50%` resolves to the
  // header's centre regardless of an optional user label / header height. Same
  // compatibility-highlight logic as the body port maps.
  const renderMainFlowHandle = (port: PortDef, kind: 'input' | 'output') => {
    const hid = handleId(port);
    const cf = connectingFrom;
    const isInput = kind === 'input';
    const directionMatch = cf ? (isInput ? cf.kind !== 'input' : cf.kind !== 'output') : false;
    const categoryMatch = cf ? port.category === cf.category && id !== cf.nodeId : false;
    const isCompatible = cf ? directionMatch && categoryMatch : null;
    const panelDragHighlight = !cf && compatibleHandles.has(handleKey(id, port.kind, port.category, port.id));
    const handleClass = [
      portHandleClass(port),
      cf && isCompatible ? styles.handleCompatible : '',
      cf && !isCompatible ? styles.handleIncompatible : '',
      panelDragHighlight ? styles.handleCompatible : '',
    ].filter(Boolean).join(' ');
    return (
      <>
        <Handle
          type={isInput ? 'target' : 'source'}
          position={isInput ? Position.Left : Position.Right}
          id={hid}
          className={handleClass}
          style={{ top: '50%' }}
          title={port.label}
        />
        {showPortLabels && (
          <div
            className={isInput ? styles.portLabelLeft : styles.portLabelRight}
            style={{ top: '50%' }}
          >
            {port.label}
          </div>
        )}
      </>
    );
  };

  return (
    <div
      ref={nodeRootRef}
      className={`${styles.node} ${isCompact ? styles.compactNode : ''}`}
      style={{
        borderColor: borderColorFor(def.color),
        minHeight: nodeMinHeight,
        ...(exprWidth != null ? { width: exprWidth } : null),
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {userLabel && (
        <div className={styles.userLabel}>{userLabel}</div>
      )}
      <div className={styles.header} title={def.description} style={{ background: def.color, color: textColorForBg(def.color), textShadow: isLightHeaderBg(def.color) ? 'none' : undefined }}>
        {mainFlowIn && renderMainFlowHandle(mainFlowIn, 'input')}
        {mainFlowOut && renderMainFlowHandle(mainFlowOut, 'output')}
        {linkCount >= 2 && (
          <span
            className={`${styles.linkBadge} nodrag`}
            title={`${linkCount} linked copies — click for options`}
            onMouseDown={stopDrag}
            onClick={e => { stopAll(e); setShowLinkMenu(v => !v); }}
          >
            {linkCount}
          </span>
        )}
        {displayNodeLabel(def)}
        {linkCount >= 2 && showLinkMenu && (
          <div className={`${styles.linkMenu} nodrag`} onMouseDown={stopDrag} onDoubleClick={stopAll}>
            <button
              type="button"
              className={styles.linkMenuItem}
              onClick={e => { stopAll(e); makeIndependent(); }}
            >
              Make Independent Copy
            </button>
          </div>
        )}
      </div>
      {configIssues.length > 0 && (
        <div className={styles.warningBadge} title={configIssues.join('\n')}>!</div>
      )}
      <div className={`${styles.body} nodrag`} onDoubleClick={stopAll}>
        {/* EXPLICIT CONTROLS — pick mode, classes B/C (and any class-A key whose
            widget is HIDDEN because the port is wired). Rendered from
            `eligibleControlKeys`' output, so it structurally cannot offer a
            parameter the resolver does not know about; a node with nothing
            eligible renders NO overlay (the enabled-control doctrine). Class-A
            keys whose widget IS on screen are outlined in place instead — see
            the input-port block below, which is the exact complement of this
            list. At the TOP of the body so the offer is where the eye lands. */}
        {pickOverlayRows.length > 0 && (
          <div className={styles.pickOverlay}>
            {pickOverlayRows.map(r => (
              <button
                key={r.configKey}
                className={`${styles.pickRow} nodrag`}
                onMouseDown={e => e.stopPropagation()}
                onClick={e => { e.stopPropagation(); bindPick(r.configKey, r.label); }}
                title={r.wired ? `${r.label} — wired inside the macro; the control will show that reason` : r.label}
              >
                <span className={styles.pickRowLabel}>{r.label}</span>
                {r.wired && <span className={styles.pickRowNote}>wired</span>}
              </button>
            ))}
          </div>
        )}

        {/* Node-specific config UI */}
        {nodeData.nodeType === 'getCellAttribute' && (
          <select
            className={styles.select}
            value={(nodeData.config.attributeId as string) || ''}
            onChange={e => updateConfig('attributeId', e.target.value)}
          >
            <option value="">Select...</option>
            {ownAttrList.map(a => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        )}


        {/* Generic Agent Platform — the agent gather / filter / write-many nodes
            target the AGENT attribute set (by id). Filter Agents adds an op. */}
        {(nodeData.nodeType === 'getAgentsAttribute'
          || nodeData.nodeType === 'filterAgents'
          || nodeData.nodeType === 'getAgentAttribute') && (
          <>
            <select
              className={styles.select}
              value={(nodeData.config.attributeId as string) || ''}
              onChange={e => updateConfig('attributeId', e.target.value)}
            >
              <option value="">Agent attribute...</option>
              {(model.agentAttributes ?? []).map(a => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
            {nodeData.nodeType === 'filterAgents' && (
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
          </>
        )}

        {/* Generic Agent Platform — Join Agents op. */}
        {nodeData.nodeType === 'joinAgents' && (
          <select
            className={styles.select}
            value={(nodeData.config.operation as string) || 'union'}
            onChange={e => updateConfig('operation', e.target.value)}
          >
            <option value="union">Union</option>
            <option value="intersection">Intersection</option>
          </select>
        )}

        {/* Get Agent Position — Absolute (raw position by id) vs Relative
            (torus-shortest vector from a Reference agent, default self). Relative
            reveals the `Reference` input via hiddenPorts. */}
        {nodeData.nodeType === 'getAgentPosition' && (
          <select
            className={styles.select}
            value={(nodeData.config.mode as string) || 'absolute'}
            onChange={e => updateConfig('mode', e.target.value)}
          >
            <option value="absolute">Absolute (position)</option>
            <option value="relative">Relative (from reference)</option>
          </select>
        )}

        {/* Get / Set Bond Attribute (Graph-Rewriting Automata, P2): per-EDGE state.
            Bond attributes are a THIRD id-space, so — like the field-bridge nodes —
            the attribute is picked HERE rather than in the Attributes panel's
            active-graph list. */}
        {(nodeData.nodeType === 'getBondAttribute' || nodeData.nodeType === 'setBondAttribute') && (
          <select
            className={styles.select}
            value={(nodeData.config.attributeId as string) || ''}
            onChange={e => updateConfig('attributeId', e.target.value)}
          >
            <option value="">Bond attribute...</option>
            {bondAttrsOf(model).map(a => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        )}

        {/* Divide Agent (Graph-Rewriting Automata, P5): the BOND PARTITION — which
            edges each daughter inherits — plus the daughter-daughter bond policy
            (decision D4). `tension` is the default geometric split; `alternate`
            needs no attribute; `byBondAttribute` reads a named bond attribute
            (a per-OPTION table for a tag, a threshold otherwise — bool pins 0.5,
            so false → A and true → B). */}
        {nodeData.nodeType === 'divideAgent' && (() => {
          const mode = (nodeData.config.partition as string) || 'tension';
          const partAttr = bondAttrsOf(model).find(a => a.id === nodeData.config.partitionAttributeId);
          return (
            <>
              <select
                className={styles.select}
                value={mode}
                onChange={e => updateConfig('partition', e.target.value)}
                title="How the mother's bonds are split between the two daughters"
              >
                <option value="tension">Bonds: by tension axis</option>
                <option value="alternate">Bonds: alternate A / B</option>
                <option value="byBondAttribute">Bonds: by bond attribute</option>
              </select>
              {mode === 'byBondAttribute' && (
                <select
                  className={styles.select}
                  value={(nodeData.config.partitionAttributeId as string) || ''}
                  onChange={e => updateConfig('partitionAttributeId', e.target.value)}
                >
                  <option value="">Bond attribute...</option>
                  {bondAttrsOf(model).map(a => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              )}
              {mode === 'byBondAttribute' && partAttr && partAttr.type === 'tag' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {(partAttr.tagOptions ?? []).map((opt, oi) => (
                    <label key={oi} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.62rem' }}>
                      <input
                        type="checkbox"
                        checked={!!nodeData.config[`partTag_${oi}`]}
                        onMouseDown={e => e.stopPropagation()}
                        onChange={e => updateConfig(`partTag_${oi}`, e.target.checked)}
                      />
                      <span>{opt}{nodeData.config[`partTag_${oi}`] ? ' → B' : ' → A'}</span>
                    </label>
                  ))}
                </div>
              )}
              {mode === 'byBondAttribute' && partAttr && (partAttr.type === 'integer' || partAttr.type === 'float') && (
                <InlineNumberInput
                  className={styles.numberInput}
                  value={String(nodeData.config.partitionThreshold ?? '0.5')}
                  onChange={(v: string) => updateConfig('partitionThreshold', v)}
                  onMouseDown={(e: React.MouseEvent) => e.stopPropagation()}
                  title="Threshold: value < t goes to daughter A, >= t to daughter B"
                />
              )}
              <select
                className={styles.select}
                value={(nodeData.config.daughterBond as string) || 'auto'}
                onChange={e => updateConfig('daughterBond', e.target.value)}
                title="Whether the two daughters are bonded to each other"
              >
                <option value="auto">A-B bond: when mother was bonded</option>
                <option value="always">A-B bond: always</option>
                <option value="never">A-B bond: never</option>
              </select>
              {/* D2 — what the daughter RADII conserve. HIDDEN in 2D: "conserve
                  r³" is meaningless on a disc, and both the spec resolver and the
                  engine coerce a stale `volume` back to `area` there, so the row
                  could not do anything (the enabled-control rule). */}
              {is3dModelLike(model) && (
                <select
                  className={styles.select}
                  value={(nodeData.config.conserve as string) || 'area'}
                  onChange={e => updateConfig('conserve', e.target.value)}
                  title="Daughter radii: conserve AREA (r_A² + r_B² = r², the default and the historical split) or VOLUME (r_A³ + r_B³ = r³). The area split loses ~29% of the volume at every symmetric 3D division."
                >
                  <option value="area">Conserve: area (πr²)</option>
                  <option value="volume">Conserve: volume (4/3·πr³)</option>
                </select>
              )}
            </>
          );
        })()}

        {/* Neighbour Census (Graph-Rewriting Automata): the tag/bool AGENT attribute
            whose state values become the output ports, plus the neighbour SOURCE
            (the bonded 1-ring, or a proximity radius). Changing the attribute
            re-derives the ports via buildCensusPorts. */}
        {nodeData.nodeType === 'neighbourCensus' && (
          <>
            <select
              className={styles.select}
              value={(nodeData.config.attributeId as string) || ''}
              onChange={e => updateConfig('attributeId', e.target.value)}
            >
              <option value="">Agent attribute (tag / binary)...</option>
              {censusAttributes(model).map(a => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
            <select
              className={styles.select}
              value={(nodeData.config.source as string) || 'bonded'}
              onChange={e => updateConfig('source', e.target.value)}
            >
              <option value="bonded">Bonded neighbours (1-ring)</option>
              <option value="nearby">Nearby agents (radius)</option>
            </select>
          </>
        )}

        {/* Field-bridge nodes (Bond-Graph Agents) reference a CELL attribute — the
            morphogen field. They live on the Agents graph, where the Attributes
            panel lists AGENT attributes, so the field attribute is picked HERE
            (all cell attributes; the validation badge guides granting Agent access
            when the chosen attr isn't yet accessible). Read Cells Under adds a
            reduce op; Affect Cells Under adds a write op. */}
        {(nodeData.nodeType === 'sampleField'
          || nodeData.nodeType === 'fieldGradient'
          || nodeData.nodeType === 'readCellsUnder'
          || nodeData.nodeType === 'affectCellsUnder'
          || nodeData.nodeType === 'secreteToField') && (
          <>
            <select
              className={styles.select}
              value={(nodeData.config.attributeId as string) || ''}
              onChange={e => updateConfig('attributeId', e.target.value)}
            >
              <option value="">Field (cell) attribute...</option>
              {cellAttrsOf(model).map(a => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
            {nodeData.nodeType === 'readCellsUnder' && (
              <select
                className={styles.select}
                value={(nodeData.config.reduce as string) || 'mean'}
                onChange={e => updateConfig('reduce', e.target.value)}
              >
                <option value="mean">Mean</option>
                <option value="sum">Sum</option>
                <option value="max">Max</option>
                <option value="min">Min</option>
              </select>
            )}
            {nodeData.nodeType === 'affectCellsUnder' && (
              <select
                className={styles.select}
                value={(nodeData.config.op as string) || 'add'}
                onChange={e => updateConfig('op', e.target.value)}
              >
                <option value="set">Set</option>
                <option value="add">Add</option>
                <option value="subtract">Subtract</option>
                <option value="max">Max</option>
                <option value="min">Min</option>
              </select>
            )}
          </>
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

        {nodeData.nodeType === 'getConstant' && (() => {
          const variegated = !!model.variegatedCells?.enabled;
          const palettes = model.variegatedCells?.facePalettes ?? [];
          const facePaletteId = (nodeData.config.facePaletteId as string) || palettes[0]?.id || '';
          const faceLabels = palettes.find(p => p.id === facePaletteId)?.labels ?? [];
          return (
            <>
              <select
                className={styles.select}
                value={(nodeData.config.constType as string) || 'integer'}
                onChange={e => {
                  // Reset constValue when switching to faceLabel so the picker
                  // starts on a valid option (the implicit 'none').
                  if (e.target.value === 'faceLabel') {
                    const newConfig = { ...nodeData.config, constType: 'faceLabel', constValue: 'none', facePaletteId: palettes[0]?.id ?? '' };
                    updateNodeData(id, { ...nodeData, config: newConfig });
                  } else {
                    updateConfig('constType', e.target.value);
                  }
                }}
              >
                <option value="bool">Binary</option>
                <option value="integer">Integer</option>
                <option value="float">Decimal</option>
                <option value="tag">Tag</option>
                <option value="orientation">Orientation</option>
                {variegated && <option value="faceLabel">Face Label</option>}
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
              ) : nodeData.config.constType === 'orientation' ? (
                <select
                  className={styles.select}
                  value={(nodeData.config.constValue as string) || '0'}
                  onChange={e => updateConfig('constValue', e.target.value)}
                >
                  <option value="0">N (0&deg;)</option>
                  <option value="1">E (90&deg;)</option>
                  <option value="2">S (180&deg;)</option>
                  <option value="3">W (270&deg;)</option>
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
                    {tagAttrScope
                      .filter(a => a.type === 'tag')
                      .map(a => (
                        <option key={a.id} value={a.id}>{a.name}</option>
                      ))}
                  </select>
                  {(() => {
                    const tagAttr = tagAttrScope.find(a => a.id === nodeData.config.tagAttributeId);
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
              ) : nodeData.config.constType === 'faceLabel' ? (
                <>
                  {palettes.length > 1 && (
                    <select
                      className={styles.select}
                      value={facePaletteId}
                      onChange={e => {
                        const newConfig = { ...nodeData.config, facePaletteId: e.target.value, constValue: 'none' };
                        updateNodeData(id, { ...nodeData, config: newConfig });
                      }}
                      title="Face palette this label belongs to"
                    >
                      {palettes.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  )}
                  <select
                    className={styles.select}
                    value={(nodeData.config.constValue as string) || 'none'}
                    onChange={e => updateConfig('constValue', e.target.value)}
                    title="Face label name. Emits the compile-time integer index (none=0; user labels start at 1)."
                  >
                    <option value="none">none (0)</option>
                    {faceLabels.map((lab, i) => (
                      <option key={i} value={lab}>{lab} ({i + 1})</option>
                    ))}
                  </select>
                </>
              ) : (
                <InlineNumberInput
                  className={styles.input}
                  value={(nodeData.config.constValue as string) || '0'}
                  onChange={v => updateConfig('constValue', v)}
                />
              )}
            </>
          );
        })()}

        {nodeData.nodeType === 'periodicStep' && (
          <>
            <label style={{ fontSize: '0.6rem', color: '#999' }}>Period (generations)</label>
            <InlineNumberInput
              className={styles.input}
              value={(nodeData.config.period as string) ?? '10'}
              onChange={v => updateConfig('period', v)}
            />
            <label style={{ fontSize: '0.6rem', color: '#999' }}>Phase (0…Period−1)</label>
            <InlineNumberInput
              className={styles.input}
              value={(nodeData.config.phase as string) ?? '0'}
              onChange={v => updateConfig('phase', v)}
            />
          </>
        )}

        {nodeData.nodeType === 'getAgentsInView' && (
          <>
            <label style={{ fontSize: '0.6rem', color: '#999' }}>Half-angle°</label>
            <InlineNumberInput
              className={styles.input}
              value={(nodeData.config.halfAngle as string) ?? '60'}
              onChange={v => updateConfig('halfAngle', v)}
            />
            <label style={{ fontSize: '0.6rem', color: '#999' }}>Heading</label>
            <select
              className={styles.select}
              value={(nodeData.config.headingSource as string) ?? 'velocity'}
              onChange={e => updateConfig('headingSource', e.target.value)}
            >
              <option value="velocity">Velocity</option>
              <option value="wired">Wired (X/Y/Z)</option>
              <option value="facing">Facing (vector attr)</option>
            </select>
            {nodeData.config.headingSource === 'facing' && (
              <>
                <label style={{ fontSize: '0.6rem', color: '#999' }}>Facing attr</label>
                <select
                  className={styles.select}
                  value={(nodeData.config.facingAttributeId as string) ?? ''}
                  onChange={e => updateConfig('facingAttributeId', e.target.value)}
                >
                  <option value="">Vector attribute…</option>
                  {(model.agentAttributes ?? []).filter(a => a.type === 'vector').map(a => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </>
            )}
            <VisionColorRow
              value={nodeData.config.visionColor as string | undefined}
              onChange={v => updateConfig('visionColor', v)}
            />
          </>
        )}

        {nodeData.nodeType === 'senseHemifield' && (
          <>
            <label style={{ fontSize: '0.6rem', color: '#999' }}>Half-angle°</label>
            <InlineNumberInput
              className={styles.input}
              value={(nodeData.config.halfAngle as string) ?? '90'}
              onChange={v => updateConfig('halfAngle', v)}
            />
            <label style={{ fontSize: '0.6rem', color: '#999' }}>Heading</label>
            <select
              className={styles.select}
              value={(nodeData.config.headingSource as string) ?? 'velocity'}
              onChange={e => updateConfig('headingSource', e.target.value)}
            >
              <option value="velocity">Velocity</option>
              <option value="wired">Wired (X/Y/Z)</option>
              <option value="facing">Facing (vector attr)</option>
            </select>
            {nodeData.config.headingSource === 'facing' && (
              <>
                <label style={{ fontSize: '0.6rem', color: '#999' }}>Facing attr</label>
                <select
                  className={styles.select}
                  value={(nodeData.config.facingAttributeId as string) ?? ''}
                  onChange={e => updateConfig('facingAttributeId', e.target.value)}
                >
                  <option value="">Vector attribute…</option>
                  {(model.agentAttributes ?? []).filter(a => a.type === 'vector').map(a => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </>
            )}
            <VisionColorRow
              value={nodeData.config.visionColor as string | undefined}
              onChange={v => updateConfig('visionColor', v)}
            />
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
          const cmpType = (nodeData.config.compareType as string) || 'numerical';
          const numeric = cmpType === 'numerical';
          const op = (nodeData.config.operation as string) || '==';
          const isBetween = numeric && (op === 'between' || op === 'notBetween');
          return (
            <>
              {/* Compare type: swaps the inline operand widgets. Non-numerical
                  types only support equality (==/!=). */}
              <select
                className={styles.select}
                value={cmpType}
                onChange={e => {
                  const next = e.target.value;
                  const dflt = next === 'bool' ? 'false' : '0';
                  const newConfig: typeof nodeData.config = {
                    ...nodeData.config,
                    compareType: next,
                    _port_x: dflt,
                    _port_y: dflt,
                    _port_y2: '0',
                  };
                  // Non-numerical types compare for equality only.
                  if (next !== 'numerical' && op !== '==' && op !== '!=') {
                    newConfig.operation = '==';
                  }
                  updateNodeData(id, { ...nodeData, config: newConfig });
                }}
                title="Type of the compared values"
              >
                <option value="numerical">Numerical</option>
                <option value="bool">Binary</option>
                <option value="tag">Tag</option>
                <option value="neighborIndex">Neighbor Index</option>
              </select>
              {/* Tag attribute picker (tag type only) — its options populate the
                  inline operand pickers, like Get Constant. */}
              {cmpType === 'tag' && (
                <select
                  className={styles.select}
                  value={(nodeData.config.tagAttributeId as string) || ''}
                  onChange={e => {
                    const newConfig = { ...nodeData.config, tagAttributeId: e.target.value, _port_x: '0', _port_y: '0' };
                    updateNodeData(id, { ...nodeData, config: newConfig });
                  }}
                >
                  <option value="">Tag attr...</option>
                  {tagAttrScope
                    .filter(a => a.type === 'tag')
                    .map(a => (
                      <option key={a.id} value={a.id}>{a.name}{a.isModelAttribute ? ' (model)' : ''}</option>
                    ))}
                </select>
              )}
              <select
                className={styles.select}
                value={op}
                onChange={e => updateConfig('operation', e.target.value)}
              >
                <option value="==">==</option>
                <option value="!=">!=</option>
                {numeric && (
                  <>
                    <option value=">">&gt;</option>
                    <option value="<">&lt;</option>
                    <option value=">=">&gt;=</option>
                    <option value="<=">&lt;=</option>
                    <option value="between">Between</option>
                    <option value="notBetween">Not Between</option>
                  </>
                )}
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

        {(nodeData.nodeType === 'setAttribute' || nodeData.nodeType === 'setCellAtPosition') && (
          <select
            className={styles.select}
            value={(nodeData.config.attributeId as string) || ''}
            onChange={e => updateConfig('attributeId', e.target.value)}
          >
            <option value="">Select...</option>
            {ownAttrList.map(a => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        )}

        {nodeData.nodeType === 'updateAttribute' && (() => {
          const selAttr = ownAttrList.find(a => a.id === nodeData.config.attributeId);
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
                  const attr = ownAttrList.find(a => a.id === e.target.value);
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
                {ownAttrList.map(a => (
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

        {nodeData.nodeType === 'setIndicator' && (
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

        {/* Get Indicator READS, so it can read any indicator whose value is a
            single number — standalone, a linked Total, or a scalar graph metric
            (nodes / edges / mean degree / …). Frequency-shaped and spatial ones
            are listed DISABLED with the reason rather than silently omitted:
            omitting them is what made this node look broken on agent/GRA models,
            whose indicators are all graph/linked. See model/indicatorValue.ts. */}
        {nodeData.nodeType === 'getIndicator' && (
          <select
            className={styles.select}
            value={(nodeData.config.indicatorId as string) || ''}
            onChange={e => updateConfig('indicatorId', e.target.value)}
          >
            <option value="">Select...</option>
            {(model.indicators || []).map(i => {
              const blocker = indicatorScalarBlocker(i);
              const kindTag = i.kind === 'standalone' ? '' : i.kind === 'graph' ? ' (graph)' : ' (linked)';
              return (
                <option key={i.id} value={i.id} disabled={blocker !== null} title={blocker ?? undefined}>
                  {i.name}{kindTag}{blocker ? ' — ' + blocker : ''}
                </option>
              );
            })}
          </select>
        )}

        {(nodeData.nodeType === 'getVariable'
          || nodeData.nodeType === 'setVariable'
          || nodeData.nodeType === 'setArrayElement') && (() => {
          // Filter by kind: SetVariable wants scalars, SetArrayElement wants
          // arrays, GetVariable accepts either.
          const wantArray = nodeData.nodeType === 'setArrayElement';
          const wantScalar = nodeData.nodeType === 'setVariable';
          // Generic Agent Platform: the Agents graph lists the agent variable set.
          const varList = getActiveGraphKind() === 'agents' ? (model.agentVariables || []) : (model.variables || []);
          const matching = varList.filter(v => {
            if (wantArray) return v.kind === 'array';
            if (wantScalar) return v.kind === 'scalar';
            return true;
          });
          return (
            <select
              className={styles.select}
              value={(nodeData.config.variableId as string) || ''}
              onChange={e => updateConfig('variableId', e.target.value)}
            >
              <option value="">Select variable...</option>
              {matching.map(v => (
                <option key={v.id} value={v.id}>
                  {v.name} ({v.kind === 'array' ? `${typeDisplayName(v.dataType)}[${v.length ?? '?'}]` : typeDisplayName(v.dataType)})
                </option>
              ))}
            </select>
          );
        })()}


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

        {nodeData.nodeType === 'setCellLooks' && (() => {
          const useGlyph = !!nodeData.config.useGlyph;
          const setBg = nodeData.config.setBackground !== false;
          const STARTER = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖', '○', '△', '★'];
          // Color picker for a 3-channel set (cell color r/g/b OR glyph color
          // glyphR/G/B). Hidden when all three channels are wired. One merged
          // updateNodeData so the three keys commit together (no stale config).
          const renderColorPicker = (ids: [string, string, string], dflt: string, title: string) => {
            const allConn = ids.every(pid => connectedInputHandles.has(handleId({ id: pid, kind: 'input', category: 'value' })));
            if (allConn) return null;
            const pr = parseInt(String(nodeData.config['_port_' + ids[0]] ?? dflt), 10) || 0;
            const pg = parseInt(String(nodeData.config['_port_' + ids[1]] ?? dflt), 10) || 0;
            const pb = parseInt(String(nodeData.config['_port_' + ids[2]] ?? dflt), 10) || 0;
            const hex = `#${Math.min(255, Math.max(0, pr)).toString(16).padStart(2, '0')}${Math.min(255, Math.max(0, pg)).toString(16).padStart(2, '0')}${Math.min(255, Math.max(0, pb)).toString(16).padStart(2, '0')}`;
            return (
              <input
                type="color"
                className={styles.input}
                style={{ height: 24, padding: 1, cursor: 'pointer' }}
                value={hex}
                onChange={e => {
                  const h = e.target.value;
                  updateNodeData(id, {
                    ...nodeData,
                    config: {
                      ...nodeData.config,
                      ['_port_' + ids[0]]: String(parseInt(h.slice(1, 3), 16)),
                      ['_port_' + ids[1]]: String(parseInt(h.slice(3, 5), 16)),
                      ['_port_' + ids[2]]: String(parseInt(h.slice(5, 7), 16)),
                    },
                  });
                }}
                onClick={e => e.stopPropagation()}
                title={title}
              />
            );
          };
          const checkbox = (key: string, label: string, checked: boolean, title: string) => (
            <label
              className="nodrag"
              style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, cursor: 'pointer', marginTop: 4 }}
              onMouseDown={e => e.stopPropagation()}
              onClick={e => e.stopPropagation()}
              title={title}
            >
              <input type="checkbox" checked={checked} onChange={e => updateConfig(key, e.target.checked)} />
              {label}
            </label>
          );
          // On the Agents graph this colours an AGENT for an agent viewer, so list
          // the agent mappings; on the Cells graph list the cell mappings. The
          // "Current Simulator Selected" sentinel works in both (writes whichever
          // viewer is active — for an agent OM pass that's the mapping it runs for).
          const looksMappings = getActiveGraphKind() === 'agents'
            ? (model.agentMappings ?? []) : model.mappings;
          return (
            <>
              <select
                className={styles.select}
                value={(nodeData.config.mappingId as string) || ''}
                onChange={e => updateConfig('mappingId', e.target.value)}
              >
                <option value="">Select Mapping...</option>
                <option value={CURRENT_VIEWER_SENTINEL}>Current Simulator Selected</option>
                {looksMappings
                  .filter(m => m.isAttributeToColor)
                  .map(m => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
              </select>
              {/* Glyphs are a render no-op for agents (discs/sprites carry no glyph
                  overlay), so the checkbox is hidden on the Agents graph — except
                  when a legacy config already has it ON, so it can be turned off. */}
              {(getActiveGraphKind() !== 'agents' || useGlyph)
                && checkbox('useGlyph', 'Use glyph', useGlyph, 'Overlay a Unicode glyph on the cell (drawn when zoomed in)')}
              {!useGlyph && renderColorPicker(['r', 'g', 'b'], '0', 'Cell color (overridden per-channel by connections)')}
              {useGlyph && (
                <>
                  {checkbox('setBackground', 'Set background color', setBg, 'Also paint a flat cell color behind the glyph — shown at every zoom level')}
                  {setBg && renderColorPicker(['r', 'g', 'b'], '0', 'Background color (overridden per-channel by connections)')}
                  {renderColorPicker(['glyphR', 'glyphG', 'glyphB'], '255', 'Glyph color (overridden per-channel by connections)')}
                  {!connectedInputHandles.has(handleId({ id: 'glyph', kind: 'input', category: 'value' })) && (() => {
                    // Quick-pick starter palette across TWO rows; clicking inserts
                    // the codepoint into _port_glyph. Hidden when Glyph is wired.
                    const renderGlyph = (g: string) => {
                      const cp = g.codePointAt(0) ?? 0;
                      return (
                        <button
                          key={g}
                          type="button"
                          onClick={() => updateConfig('_port_glyph', String(cp))}
                          style={{
                            width: 20, height: 20, padding: 0, lineHeight: '20px',
                            fontSize: 14, cursor: 'pointer',
                            background: 'transparent', border: '1px solid #555',
                            color: '#ddd', borderRadius: 2,
                          }}
                          title={`Insert ${g} (U+${cp.toString(16).toUpperCase().padStart(4, '0')})`}
                        >{g}</button>
                      );
                    };
                    const half = Math.ceil(STARTER.length / 2);
                    return (
                      <div
                        className="nodrag"
                        style={{ marginTop: 4 }}
                        onMouseDown={e => e.stopPropagation()}
                        onClick={e => e.stopPropagation()}
                        title="Quick-pick a glyph"
                      >
                        <div style={{ display: 'flex', gap: 2, justifyContent: 'center' }}>{STARTER.slice(0, half).map(renderGlyph)}</div>
                        <div style={{ display: 'flex', gap: 2, justifyContent: 'center', marginTop: 2 }}>{STARTER.slice(half).map(renderGlyph)}</div>
                      </div>
                    );
                  })()}
                  {checkbox('fallbackToGlyphColor', 'Glyph color when zoomed out', !!nodeData.config.fallbackToGlyphColor, 'When cells are too small to draw the glyph, paint each glyphed cell with its glyph color so the macro view stays meaningful')}
                </>
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

        {nodeData.nodeType === 'assertActiveViewer' && (
          <select
            className={styles.select}
            title="The IF ACTIVE branch runs only while this Attribute→Color mapping is the viewer selected in the simulator. DONE always runs."
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

        {nodeData.nodeType === 'agentOutputMapping' && (
          <select
            className={styles.select}
            value={(nodeData.config.mappingId as string) || ''}
            onChange={e => updateConfig('mappingId', e.target.value)}
          >
            <option value="">Select Agent View...</option>
            {(model.agentMappings ?? [])
              .filter(m => m.isAttributeToColor)
              .map(m => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
          </select>
        )}

        {/* The C->A half of `agentMappings` (isAttributeToColor === false) — the
            agent Paint brush's tabs. Direction-filtered so an input root can
            never be pointed at a view (and vice versa). */}
        {nodeData.nodeType === 'agentInputMapping' && (
          <select
            className={styles.select}
            value={(nodeData.config.mappingId as string) || ''}
            onChange={e => updateConfig('mappingId', e.target.value)}
          >
            <option value="">Select Agent Input Mapping...</option>
            {(model.agentMappings ?? [])
              .filter(m => !m.isAttributeToColor)
              .map(m => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
          </select>
        )}

        {nodeData.nodeType === 'setAgentSprite' && (() => {
          const setSprite = nodeData.config.setSprite !== false;
          const cbx = (key: string, label: string, checked: boolean, title: string) => (
            <label
              className="nodrag"
              style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, cursor: 'pointer', marginTop: 4 }}
              onMouseDown={e => e.stopPropagation()}
              onClick={e => e.stopPropagation()}
              title={title}
            >
              <input type="checkbox" checked={checked} onChange={e => updateConfig(key, e.target.checked)} />
              {label}
            </label>
          );
          return (
            <>
              {cbx('setSprite', 'Change sprite', setSprite, 'Switch which sprite this agent is drawn as')}
              {setSprite && (
                <select
                  className={styles.select}
                  value={(nodeData.config.spriteId as string) || ''}
                  onChange={e => updateConfig('spriteId', e.target.value)}
                  title="The sprite to draw (manage sprites in the Mappings panel → Sprites)"
                >
                  <option value="">Select Sprite...</option>
                  {(model.sprites ?? []).map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              )}
              {cbx('setFrame', 'Set frame', !!nodeData.config.setFrame, 'Jump to / reset the current frame (the Frame input)')}
              {cbx('setSpeed', 'Set speed', !!nodeData.config.setSpeed, 'Set playback speed in frames per step — negative = reverse, 0 = hold (the Speed input)')}
              {cbx('setRotation', 'Set rotation', !!nodeData.config.setRotation, 'Set the sprite facing — an angle, or a direction vector the art aligns to')}
              {nodeData.config.setRotation && (
                <select
                  className={styles.select}
                  value={(nodeData.config.rotationMode as string) || 'angle'}
                  onChange={e => updateConfig('rotationMode', e.target.value)}
                  title="Angle: the Rotation° input (0 = up, clockwise). Vector: the Dir X/Y inputs the art aligns to (atan2) — a static agent can look at a target."
                >
                  <option value="angle">by angle (°)</option>
                  <option value="vector">by direction vector</option>
                </select>
              )}
              {cbx('setScale', 'Set scale', !!nodeData.config.setScale, 'Set the sprite size multiplier per agent (the Scale input)')}
              {cbx('setAlpha', 'Set alpha', !!nodeData.config.setAlpha, 'Set the agent colour’s alpha byte (0–255, the Alpha input) — the sprite render multiplies by it, so this fades/hides the sprite. A colour pass that writes the agent colour afterwards overrides it.')}
            </>
          );
        })()}

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

        {/* ---------- Overseer node configs (experiment orchestration) ---------- */}
        {nodeData.nodeType === 'ovRandomizeTable' && (
          <select
            className={styles.select}
            value={(nodeData.config.tableId as string) || ''}
            onChange={e => updateConfig('tableId', e.target.value)}
          >
            <option value="">Select Lookup Table...</option>
            {model.attributes
              .filter(a => a.isModelAttribute && a.type === 'lookupTable')
              .map(a => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
          </select>
        )}
        {nodeData.nodeType === 'ovSetModelAttribute' && (
          <select
            className={styles.select}
            value={(nodeData.config.attributeId as string) || ''}
            onChange={e => updateConfig('attributeId', e.target.value)}
          >
            <option value="">Select model attribute...</option>
            {model.attributes
              .filter(a => a.isModelAttribute && a.type !== 'color' && a.type !== 'lookupTable' && a.type !== 'vector')
              .map(a => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
          </select>
        )}

        {nodeData.nodeType === 'ovReadIndicator' && (() => {
          const eligible = (model.indicators || []).filter(i =>
            !(i.kind === 'linked' && i.xAxis && i.xAxis !== 'generation'));
          const sel = eligible.find(i => i.id === nodeData.config.indicatorId);
          // GRA P6 — a frequency-shaped GRAPH metric (the degree histogram) takes
          // a category exactly like a linked-frequency indicator; its categories
          // ARE design-time known (degree 0..maxBonds), so offer them as a list.
          const graphCats = sel?.kind === 'graph'
            && isGraphFrequencyMetric((sel.graphMetric ?? 'nodeCount') as GraphMetric)
            ? degreeHistogramKeys(resolveMaxBonds(model.centerBased))
            : null;
          const isFreq = (sel?.kind === 'linked' && (sel.linkedAggregation ?? 'frequency') === 'frequency')
            || graphCats !== null;
          const srcAttr = sel?.kind === 'linked' && isFreq ? model.attributes.find(a => a.id === sel?.linkedAttributeId) : undefined;
          const knownCats = graphCats ?? (srcAttr?.type === 'bool' ? ['false', 'true']
            : srcAttr?.type === 'tag' ? (srcAttr.tagOptions ?? [])
            : null);
          return (
            <>
              <select
                className={styles.select}
                value={(nodeData.config.indicatorId as string) || ''}
                onChange={e => updateConfig('indicatorId', e.target.value)}
              >
                <option value="">Select indicator...</option>
                {eligible.map(i => (
                  <option key={i.id} value={i.id}>{i.name}</option>
                ))}
              </select>
              {isFreq && (knownCats ? (
                <select
                  className={styles.select}
                  value={(nodeData.config.category as string) || ''}
                  onChange={e => updateConfig('category', e.target.value)}
                  title="Which frequency category (count) to read."
                >
                  <option value="">Select category...</option>
                  {knownCats.map(c => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              ) : (
                <input
                  className={styles.input}
                  placeholder="Category (bucket key)..."
                  value={(nodeData.config.category as string) ?? ''}
                  onChange={e => updateConfig('category', e.target.value)}
                  onMouseDown={stopDrag}
                  onDoubleClick={stopAll}
                  title="Numeric frequency buckets are runtime-keyed — enter the bucket key to read."
                />
              ))}
            </>
          );
        })()}

        {nodeData.nodeType === 'ovCollectSpatial' && (() => {
          // The inverse filter of ovReadIndicator: SPATIAL indicators only.
          const eligible = (model.indicators || []).filter(i =>
            i.kind === 'linked' && i.xAxis && i.xAxis !== 'generation');
          const sel = eligible.find(i => i.id === nodeData.config.indicatorId);
          const isFreq = sel && (sel.linkedAggregation ?? 'frequency') === 'frequency';
          const srcAttr = isFreq ? model.attributes.find(a => a.id === sel?.linkedAttributeId) : undefined;
          const knownCats = srcAttr?.type === 'bool' ? ['false', 'true']
            : srcAttr?.type === 'tag'
              ? (sel?.trackedValues?.length ? sel.trackedValues : (srcAttr.tagOptions ?? []))
              : null;
          return (
            <>
              <select
                className={styles.select}
                value={(nodeData.config.indicatorId as string) || ''}
                onChange={e => updateConfig('indicatorId', e.target.value)}
                title="A spatial indicator (rows / columns / layers X-axis) — its whole per-position curve is captured."
              >
                <option value="">Select spatial indicator...</option>
                {eligible.map(i => (
                  <option key={i.id} value={i.id}>{i.name}</option>
                ))}
              </select>
              {isFreq && (knownCats ? (
                <select
                  className={styles.select}
                  value={(nodeData.config.category as string) || ''}
                  onChange={e => updateConfig('category', e.target.value)}
                  title="Which category's curve to capture (e.g. one solute of the chromatogram)."
                >
                  <option value="">Select category...</option>
                  {knownCats.map(c => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              ) : (
                <input
                  className={styles.input}
                  placeholder="Category (bucket key)..."
                  value={(nodeData.config.category as string) ?? ''}
                  onChange={e => updateConfig('category', e.target.value)}
                  onMouseDown={stopDrag}
                  onDoubleClick={stopAll}
                />
              ))}
              <input
                className={styles.input}
                placeholder="Series name..."
                value={(nodeData.config.series as string) ?? ''}
                onChange={e => updateConfig('series', e.target.value)}
                onMouseDown={stopDrag}
                onDoubleClick={stopAll}
                title="The spatial series this node appends one run-curve to."
              />
              <input
                className={styles.input}
                placeholder="Chart (group)..."
                value={(nodeData.config.chart as string) ?? ''}
                onChange={e => updateConfig('chart', e.target.value)}
                onMouseDown={stopDrag}
                onDoubleClick={stopAll}
                title="Series with the same Chart name overlay on one aggregate chart (blank = own chart named after the series)."
              />
            </>
          );
        })()}

        {nodeData.nodeType === 'ovLoadPreset' && (
          <select
            className={styles.select}
            value={(nodeData.config.presetId as string) || ''}
            onChange={e => updateConfig('presetId', e.target.value)}
          >
            <option value="">Select preset...</option>
            {(model.presets || []).map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        )}

        {(nodeData.nodeType === 'ovCollectSample'
          || nodeData.nodeType === 'ovClearSeries'
          || nodeData.nodeType === 'ovSeriesStat') && (
          <>
            <input
              className={styles.input}
              placeholder="Series name..."
              value={(nodeData.config.series as string) ?? ''}
              onChange={e => updateConfig('series', e.target.value)}
              onMouseDown={stopDrag}
              onDoubleClick={stopAll}
              title="The sample series this node targets (created on first sample)."
            />
            {nodeData.nodeType === 'ovCollectSample' && (
              <select
                className={styles.select}
                value={(nodeData.config.scope as string) || 'experiment'}
                onChange={e => updateConfig('scope', e.target.value)}
                title="experiment = accumulate across the whole experiment; run = cleared at each Reset Board."
              >
                <option value="experiment">Scope: experiment</option>
                <option value="run">Scope: run (clears on Reset)</option>
              </select>
            )}
            {nodeData.nodeType === 'ovSeriesStat' && (
              <select
                className={styles.select}
                value={(nodeData.config.op as string) || 'mean'}
                onChange={e => updateConfig('op', e.target.value)}
              >
                <option value="mean">Mean</option>
                <option value="std">Std (sample)</option>
                <option value="min">Min</option>
                <option value="max">Max</option>
                <option value="median">Median</option>
                <option value="sum">Sum</option>
                <option value="count">Count</option>
                <option value="ci95">95% CI half-width</option>
              </select>
            )}
          </>
        )}

        {nodeData.nodeType === 'ovSweepValues' && (
          <>
            <select
              className={styles.select}
              value={(nodeData.config.mode as string) || 'list'}
              onChange={e => updateConfig('mode', e.target.value)}
            >
              <option value="list">Explicit list</option>
              <option value="linspace">Evenly spaced (linspace)</option>
            </select>
            {(nodeData.config.mode || 'list') === 'list' ? (
              <input
                className={styles.input}
                placeholder="1, 2, 5, 10"
                value={(nodeData.config.list as string) ?? ''}
                onChange={e => updateConfig('list', e.target.value)}
                onMouseDown={stopDrag}
                onDoubleClick={stopAll}
                title="Comma-separated parameter values to sweep."
              />
            ) : (
              <>
                <InlineNumberInput
                  className={styles.input}
                  placeholder="from"
                  value={(nodeData.config.from as string) || '0'}
                  onChange={v => updateConfig('from', v)}
                />
                <InlineNumberInput
                  className={styles.input}
                  placeholder="to"
                  value={(nodeData.config.to as string) || '1'}
                  onChange={v => updateConfig('to', v)}
                />
                <InlineNumberInput
                  className={styles.input}
                  placeholder="steps"
                  value={(nodeData.config.steps as string) || '5'}
                  onChange={v => updateConfig('steps', v)}
                />
              </>
            )}
          </>
        )}

        {nodeData.nodeType === 'ovLog' && (
          <input
            className={styles.input}
            placeholder="value = {value} (gen {gen})"
            value={(nodeData.config.text as string) ?? ''}
            onChange={e => updateConfig('text', e.target.value)}
            onMouseDown={stopDrag}
            onDoubleClick={stopAll}
            title="Journal line. Placeholders: {value} = the wired Value input, {gen} = the current generation."
          />
        )}

        {nodeData.nodeType === 'ovStopExperiment' && (
          <input
            className={styles.input}
            placeholder="Stop message..."
            value={(nodeData.config.message as string) ?? ''}
            onChange={e => updateConfig('message', e.target.value)}
            onMouseDown={stopDrag}
            onDoubleClick={stopAll}
            title="Journal-logged when the experiment ends here."
          />
        )}

        {nodeData.nodeType === 'ovScreenshot' && (
          <input
            className={styles.input}
            placeholder="Label..."
            value={(nodeData.config.label as string) ?? ''}
            onChange={e => updateConfig('label', e.target.value)}
            onMouseDown={stopDrag}
            onDoubleClick={stopAll}
            title="Used in the download filename + the journal entry."
          />
        )}

        {nodeData.nodeType === 'getRandom' && (() => {
          // Min / Max / Mean / Std Dev / Norm / Angle / Span are PORTS now (they
          // carry their own inline widgets), so the body holds only the two
          // MODE selectors — the shape of the port set, not its values.
          const rType = (nodeData.config.randomType as string) || 'float';
          return (
            <>
              <select
                className={styles.select}
                value={rType}
                onChange={e => updateConfig('randomType', e.target.value)}
              >
                <option value="bool">Binary</option>
                <option value="integer">Integer</option>
                <option value="float">Decimal</option>
                <option value="orientation">Orientation</option>
                <option value="options">Options</option>
                <option value="vector">Vector</option>
                <option value="color">Color</option>
              </select>
              {rType === 'float' && (
                <select
                  className={styles.select}
                  title="Uniform: every value in [Min, Max) equally likely. Normal: a Gaussian bell around Mean (2 RNG draws). Exponential: waiting times with the given Mean (long tail)."
                  value={(nodeData.config.distribution as string) || 'uniform'}
                  onChange={e => updateConfig('distribution', e.target.value)}
                >
                  <option value="uniform">Uniform</option>
                  <option value="normal">Normal (Gaussian)</option>
                  <option value="exponential">Exponential</option>
                </select>
              )}
              {rType === 'vector' && (
                <select
                  className={styles.select}
                  title="Where the random direction is centred: a compass Angle° (0° = north / up, 90° = east) or a wired reference direction."
                  value={(nodeData.config.refSource as string) || 'angle'}
                  onChange={e => updateConfig('refSource', e.target.value)}
                >
                  <option value="angle">Around an angle</option>
                  <option value="vector">Around a direction</option>
                </select>
              )}
            </>
          );
        })()}

        {nodeData.nodeType === 'getColorConstant' && (() => {
          const r = parseInt(String(nodeData.config.r ?? '128'), 10) || 0;
          const g = parseInt(String(nodeData.config.g ?? '128'), 10) || 0;
          const b = parseInt(String(nodeData.config.b ?? '128'), 10) || 0;
          const rawA = nodeData.config.a;
          const a = rawA === undefined ? OPAQUE : (parseInt(String(rawA), 10) || 0);
          return (
            <>
              <ColorField
                value={rgbaToHex({ r, g, b, a })}
                onChange={(h) => {
                  const n = hexToRgba(h);
                  const cfg: NodeConfig = {
                    ...nodeData.config,
                    r: String(n.r), g: String(n.g), b: String(n.b),
                  };
                  // Drop the `a` key entirely when opaque, so the node keeps its
                  // pre-alpha config + 3-port shape + byte-identical emit.
                  if (n.a === OPAQUE) delete cfg.a; else cfg.a = String(n.a);
                  updateNodeData(id, { ...nodeData, config: cfg });
                }}
                style={{ height: 24, width: '100%' }}
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

        {nodeData.nodeType === 'categoricalColor' && (
          <CategoricalColorEditor id={id} nodeData={nodeData} />
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
            <option value="negate">Negate (&minus;x)</option>
            <option value="floor">Floor</option>
            <option value="ceil">Ceil</option>
            <option value="round">Round</option>
            <option value="max">Max</option>
            <option value="min">Min</option>
            <option value="mean">Mean</option>
            <option value="exp">Exp (eˣ)</option>
            <option value="log">Log (ln)</option>
            <option value="sin">Sin</option>
            <option value="cos">Cos</option>
            <option value="tan">Tan</option>
            <option value="tanh">Tanh</option>
          </select>
        )}

        {nodeData.nodeType === 'vectorOp' && (
          <select
            className={styles.select}
            value={(nodeData.config.op as string) || 'add'}
            onChange={e => updateConfig('op', e.target.value)}
          >
            <option value="add">Add (A + B)</option>
            <option value="subtract">Subtract (A − B)</option>
            <option value="scale">Scale (A × Scalar)</option>
            <option value="dot">Dot (A · B)</option>
            <option value="cross">Cross (A × B)</option>
            <option value="length">Length |A|</option>
            <option value="normalize">Normalize (Â)</option>
            <option value="distance">Distance |A − B|</option>
            <option value="negate">Negate (−A)</option>
            <option value="lerp">Lerp (A→B by T)</option>
            <option value="rotate2d">Rotate (A by Angle°, about Z)</option>
            {/* Rodrigues needs a real 3rd axis — a 2D model has no Z and no
                meaningful non-Z axis, so the option is only offered in 3D. A
                stale rotateAxis config in a 2D model still SELECTS (kept in the
                list) and carries a validation badge. */}
            {(is3dModelLike(model) || (nodeData.config.op as string) === 'rotateAxis') && (
              <option value="rotateAxis">Rotate Around Axis (3D)</option>
            )}
          </select>
        )}

        {nodeData.nodeType === 'applyForce' && (
          <label
            className="nodrag"
            style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, cursor: 'pointer', marginTop: 4 }}
            onMouseDown={e => e.stopPropagation()}
            onClick={e => e.stopPropagation()}
            title="Feed a single force vector (from Vector Op / Make Vector) instead of the X / Y / Z components."
          >
            <input
              type="checkbox"
              checked={!!nodeData.config.vectorInput}
              onChange={e => updateConfig('vectorInput', e.target.checked)}
            />
            Vector input
          </label>
        )}

        {/* The two free-text formula nodes share this whole editor — the same
            config keys, the collapsible inputs / editor, the rendered face and
            the width grip. Only the GRAMMAR differs, so the parser and the
            renderer are the only things branched on `isLogic`. */}
        {isExpression && (() => {
          const isLogic = nodeData.nodeType === 'logicalExpression';
          const visibleCount = clampVisibleCount(nodeData.config.visibleCount);
          const formula = (nodeData.config.expression as string) ?? '';
          const { map, errors: varErrors } = isLogic
            ? buildLogicVarMap(nodeData.config, visibleCount)
            : buildVarMap(nodeData.config, visibleCount);
          let parseErr: string | null = varErrors[0] ?? null;
          // The SAME AST the compile targets emit from also feeds the rendered
          // view below, so the picture can never disagree with what actually
          // runs.
          let ast: ExprAst | null = null;
          let logicAst: LogicAst | null = null;
          if (!parseErr && formula.trim()) {
            if (isLogic) {
              const res = parseLogicExpression(formula, map);
              if ('error' in res) parseErr = res.error;
              else logicAst = res.ast;
            } else {
              const res = parseExpression(formula, map);
              if ('error' in res) parseErr = res.error;
              else ast = res.ast;
            }
          }
          /** Is there a formula to SHOW? Drives the forced-open editor + the
           *  collapse toggle below, for whichever grammar this node speaks. */
          const hasAst = isLogic ? logicAst !== null : ast !== null;
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
          // Persisted textarea HEIGHT (px); absent ⇒ the default 3-row box.
          // The WIDTH is the node's (`_exprW`, the corner grip — see the
          // "user-resizable WIDTH" block above), so the textarea just fills it.
          const exprH = Number(nodeData.config._exprH) || 0;
          // Input-variable NAMES are set once and then read off the port labels,
          // so their editors (one text row per input + the port-count stepper)
          // are collapsed BY DEFAULT — they were the bulk of the node's height.
          // Absent key ⇒ collapsed, so every existing node opens compact; the
          // flag is `_`-prefixed and is neither `_port_*` nor `_varName_*`, so
          // accessorCSE's purity key drops it and the compiled output is
          // untouched (see accessorCSE.ts's config filter).
          const namesExpanded = nodeData.config._namesExpanded === true;
          const toggleNames = () => {
            const newConfig: NodeConfig = { ...nodeData.config };
            if (namesExpanded) delete newConfig._namesExpanded;
            else newConfig._namesExpanded = true;
            updateNodeData(id, { ...nodeData, config: newConfig });
          };
          // The rendered formula is the node's FACE; the text editor sits
          // below it, collapsed. With NO formula to show — empty text, or a
          // parse/name error (both leave `ast` null) — the editor is FORCED
          // open, so a virgin node never presents a blank face and an error is
          // never stranded away from the text that caused it. `_exprExpanded`
          // carries an explicit user choice (same compiler-invisible key
          // convention as `_namesExpanded`); `exprEditLatch` keeps it open for
          // the typing session that produced the formula.
          const exprEditOpen = !hasAst || exprEditLatch || nodeData.config._exprExpanded === true;
          const toggleExprEdit = () => {
            const newConfig: NodeConfig = { ...nodeData.config };
            if (exprEditOpen) {
              delete newConfig._exprExpanded;
              setExprEditLatch(false);
            } else {
              newConfig._exprExpanded = true;
              setExprEditLatch(true);
              exprWantFocusRef.current = true;
            }
            updateNodeData(id, { ...nodeData, config: newConfig });
          };
          const varSummary = Array.from({ length: visibleCount }, (_, i) => {
            const pid = VISIBLE_PORT_IDS[i]!;
            const raw = nodeData.config[`_varName_${pid}`];
            return (typeof raw === 'string' && raw.trim()) ? raw.trim() : pid;
          }).join(', ');
          return (
            <>
              {isLogic
                ? <LogicalFormula ast={logicAst} names={namesFromVarMap(map)} />
                : <ExpressionFormula ast={ast} names={namesFromVarMap(map)} />}
              {/* Only offered when there IS a formula to collapse to — with
                  none the editor is the only face, so a toggle would be a
                  control that cannot do anything. */}
              {hasAst && (
                <button
                  className={styles.select}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 4,
                    textAlign: 'left', cursor: 'pointer', overflow: 'hidden',
                  }}
                  onClick={toggleExprEdit}
                  title={exprEditOpen
                    ? 'Hide the expression text'
                    : 'Edit the expression text'}
                >
                  <span style={{ opacity: 0.6 }}>{exprEditOpen ? '▾' : '▸'}</span>
                  <span style={{ opacity: 0.6 }}>Edit expression</span>
                </button>
              )}
              {exprEditOpen && (
              <textarea
                ref={exprTextRef}
                className={styles.input}
                // WIDTH is the NODE's — set by the corner grip and stored in
                // `_exprW` — so the textarea simply fills it and resizes
                // VERTICALLY only (`_exprH`). Letting it resize horizontally too
                // would be a second, competing width: with `min-width: 100%` on a
                // content-sized node it used to drag the whole node wider, but
                // only while the editor happened to be open, so the formula (the
                // node's default face) had no way to be widened at all.
                style={{
                  fontFamily: 'monospace', resize: 'vertical', boxSizing: 'border-box',
                  width: '100%',
                  height: exprH > 0 ? exprH : undefined, minHeight: 44,
                }}
                rows={3}
                value={formula}
                placeholder={isLogic ? 'e.g. a AND NOT b OR c' : 'e.g. a + b*c - pow(d, 2)'}
                spellCheck={false}
                onChange={e => {
                  // Latch the editor open for this typing session (see the
                  // exprEditLatch declaration) — the first keystroke that
                  // parses would otherwise collapse the box mid-edit.
                  setExprEditLatch(true);
                  updateConfig('expression', e.target.value);
                }}
                onMouseDown={e => {
                  stopDrag(e);
                  exprResizeStartRef.current = { h: e.currentTarget.offsetHeight };
                }}
                onMouseUp={e => {
                  const start = exprResizeStartRef.current;
                  exprResizeStartRef.current = null;
                  if (!start) return;
                  const t = e.currentTarget;
                  // Only a deliberate resize drag changes the box height — persist it.
                  if (t.offsetHeight !== start.h) {
                    updateNodeData(id, { ...nodeData, config: {
                      ...nodeData.config, _exprH: t.offsetHeight,
                    } });
                  }
                }}
                onDoubleClick={stopAll}
              />
              )}
              {/* A parse error always shows WITH the text that caused it: an
                  error leaves `ast` null, which forces the editor open. */}
              {exprEditOpen && parseErr && (
                <div style={{ color: '#f44336', fontSize: '0.65rem' }}>{parseErr}</div>
              )}
              <button
                className={styles.select}
                style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  textAlign: 'left', cursor: 'pointer', overflow: 'hidden',
                }}
                onClick={toggleNames}
                title={namesExpanded
                  ? 'Hide the input variable names'
                  : 'Edit the input variable names / number of inputs'}
              >
                <span style={{ opacity: 0.6 }}>{namesExpanded ? '▾' : '▸'}</span>
                <span style={{ opacity: 0.6 }}>Inputs</span>
                <span
                  style={{
                    flex: 1, minWidth: 0, overflow: 'hidden',
                    textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    fontStyle: 'italic', opacity: 0.85,
                  }}
                >
                  {varSummary}
                </span>
              </button>
              {namesExpanded && Array.from({ length: visibleCount }, (_, i) => {
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
              {namesExpanded && (
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
              )}
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
            <option value="weightedRandom">Pick Weighted Random</option>
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
          const tagAttr = tagAttrScope.find(a => a.id === tagAttrId);
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
                  <option value="float">Decimal</option>
                  <option value="tag">Tag</option>
                  <option value="neighborIndex">Neighbor Index</option>
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
                  {tagAttrScope
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
                  {/* By Value + int/float: comparison op (NI cases are wired,
                      equality-only — no op dropdown, no inline widget) */}
                  {switchMode === 'value' && valType !== 'tag' && valType !== 'neighborIndex' && (
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

        {nodeData.nodeType === 'loop' && (
          // Count vs Range mode — swaps the Count port for From/To (hiddenPorts).
          <select
            className={styles.select}
            value={(nodeData.config.mode as string) || 'count'}
            onChange={e => updateConfig('mode', e.target.value)}
            title="Count: Index runs 0..N-1. Range: Index runs From..To (inclusive, ascending; From > To runs zero times)."
          >
            <option value="count">Count (Index 0..N-1)</option>
            <option value="range">Range (Index From..To)</option>
          </select>
        )}

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

        {(nodeData.nodeType === 'getFacingLabels'
          || nodeData.nodeType === 'getFacingOrientation'
          || nodeData.nodeType === 'setFacingOrientation') && (() => {
          // Variegated Cells: pick one cardinal/diagonal direction. Face
          // encounters are intrinsic to the grid (one step in one of 8 fixed
          // directions), so no neighborhood is needed — the compiler resolves
          // the chosen direction directly to a (dr, dc) offset.
          const DIRECTION_TAGS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
          return (
            <select
              className={styles.select}
              value={(nodeData.config.directionTag as string) || ''}
              onChange={e => updateConfig('directionTag', e.target.value)}
            >
              <option value="">Direction...</option>
              {DIRECTION_TAGS.map(d => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          );
        })()}

        {(nodeData.nodeType === 'lookupInteraction' || nodeData.nodeType === 'interactionTableMap') && (() => {
          // Pick one of the model's Lookup Table model attributes. For Table
          // Lookup, the row/col indices are wired via scalar input ports; for
          // Table Map, they're parallel int arrays. Indices come from face
          // labels (Get Facing Labels) or tag reads — depends on the table's
          // row/col key sources.
          const tables = model.attributes.filter(a => a.isModelAttribute && a.type === 'lookupTable');
          return (
            <select
              className={styles.select}
              value={(nodeData.config.tableId as string) || ''}
              onChange={e => updateConfig('tableId', e.target.value)}
            >
              <option value="">Lookup Table...</option>
              {tables.map(a => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          );
        })()}

        {nodeData.nodeType === 'getGridDimensions' && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.68rem', color: '#a0b0c0', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={!!nodeData.config.withCenter}
              onChange={e => updateConfig('withCenter', e.target.checked)}
              style={{ cursor: 'pointer' }}
            />
            Output center (⌊size/2⌋)
          </label>
        )}

        {nodeData.nodeType === 'getAllFacingLabels' && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.68rem', color: '#a0b0c0', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={!!nodeData.config.cardinalsOnly}
              onChange={e => updateConfig('cardinalsOnly', e.target.checked)}
              style={{ cursor: 'pointer' }}
            />
            Cardinals only (4 slots N/E/S/W)
          </label>
        )}

        {nodeData.nodeType === 'moveSelfToNeighbor' && (() => {
          const payloadCount = Math.max(1, Number(nodeData.config.payloadCount) || 1);
          const operation = (nodeData.config.operation as string) || 'copyTo';
          const nonReceiving = (nodeData.config.nonReceiving as string) || 'defaults';
          const includeOri = !!nodeData.config.includeOrientation;
          const cellAttrs = model.attributes.filter(a => !a.isModelAttribute);
          const addSlot = () => {
            const next = { ...nodeData.config, payloadCount: payloadCount + 1 };
            updateNodeData(id, { ...nodeData, config: next });
          };
          const removeSlot = (i: number) => {
            const next = { ...nodeData.config };
            for (let j = i; j < payloadCount - 1; j++) {
              const upper = next[`attr_${j + 1}`];
              if (upper === undefined) delete next[`attr_${j}`];
              else next[`attr_${j}`] = upper;
            }
            delete next[`attr_${payloadCount - 1}`];
            next.payloadCount = Math.max(1, payloadCount - 1);
            updateNodeData(id, { ...nodeData, config: next });
          };
          return (
            <>
              <select
                className={styles.select}
                value={operation}
                onChange={e => updateConfig('operation', e.target.value)}
                title="Direction of the transfer"
              >
                <option value="copyTo">Copy To neighbor</option>
                <option value="copyFrom">Copy From neighbor</option>
                <option value="swap">Swap with neighbor</option>
              </select>
              {operation !== 'swap' && (
                <select
                  className={styles.select}
                  value={nonReceiving}
                  onChange={e => updateConfig('nonReceiving', e.target.value)}
                  title="What to do with the cell that gives its values"
                >
                  <option value="defaults">Source → defaults</option>
                  <option value="untouched">Source untouched</option>
                </select>
              )}
              <div style={{ fontSize: '0.62rem', color: '#8a98a8', marginTop: 2 }}>Attributes to transfer:</div>
              {Array.from({ length: payloadCount }, (_, i) => (
                <div key={`slot-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <select
                    className={styles.select}
                    style={{ flex: 1 }}
                    value={(nodeData.config[`attr_${i}`] as string) || ''}
                    onChange={e => updateConfig(`attr_${i}`, e.target.value)}
                  >
                    <option value="">Attribute {i + 1}...</option>
                    {cellAttrs.map(a => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                  {payloadCount > 1 && (
                    <button
                      onMouseDown={e => e.stopPropagation()}
                      onClick={() => removeSlot(i)}
                      style={{ fontSize: '0.7rem', padding: '2px 6px', cursor: 'pointer' }}
                      title="Remove this payload slot"
                    >−</button>
                  )}
                </div>
              ))}
              <button
                onMouseDown={e => e.stopPropagation()}
                onClick={addSlot}
                style={{ fontSize: '0.7rem', padding: '2px 8px', cursor: 'pointer' }}
                title="Add another payload slot"
              >+ Slot</button>
              {/* Orientation only exists in Variegated Cells models — hide the
                  option otherwise (the compiler also ignores a stale `true`). */}
              {model.variegatedCells?.enabled && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.68rem', color: '#a0b0c0', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={includeOri}
                    onChange={e => updateConfig('includeOrientation', e.target.checked)}
                    style={{ cursor: 'pointer' }}
                  />
                  Include Orientation
                </label>
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

        {/* EXPLICIT CONTROLS — the CLOSED INSTANCE's interface (P3).
            Ungrouped rows first, then each group under its header, ordered by
            `groupSections` (= `orderByGroup`, the SAME call the boundary editor
            reorders `exposedInputs` with, so the two cannot disagree).

            An EMPTY interface renders NO section at all — no header, no gap
            (the enabled-control doctrine). Handles are absolutely-positioned
            siblings rendered AFTER this body div, at `PORT_TOP_BASE + i*spacing`
            from the NODE top, so adding rows changes the node's HEIGHT and moves
            NO handle (F6) — hence no `updateNodeInternals` here. A port GROUP
            reorder does need one, and gets it for free from the existing
            `portIdSignature` effect (macro ports ARE `exposedInputs`, in order). */}
        {nodeData.nodeType === 'macro' && controlSections.length > 0 && (
          <div className={styles.ctlSection}>
            <div className={styles.ctlSectionHeader}>
              <span>Parameters</span>
              {linkCount >= 2 && (
                <span
                  className={styles.ctlLinked}
                  title={`Shared with ${linkCount - 1} other linked instance${linkCount === 2 ? '' : 's'} — editing here changes all of them (Duplicate Independent to vary one)`}
                >
                  ⛓ {linkCount}
                </span>
              )}
            </div>
            {controlSections.map((sec, si) => (
              <Fragment key={sec.group?.id ?? `__ungrouped_${si}`}>
                {sec.group && <div className={styles.ifaceHeader}>{sec.group.name}</div>}
                {sec.rows.map(({ control, desc }) => (
                  <MacroControlRow
                    key={control.id}
                    desc={desc}
                    needsAttention={!!desc.block && CONTROL_BLOCK_NEEDS_ATTENTION.has(desc.block)}
                    onChange={next => setControlValue(control, next)}
                  />
                ))}
              </Fragment>
            ))}
          </div>
        )}

        {nodeData.nodeType === 'macro' && (
          <span style={{ fontSize: '0.6rem', color: '#8060c0', fontStyle: 'italic' }}>
            Double-click to edit
          </span>
        )}

        {/* Multi-attribute slots — extra attribute pickers on the five accessor
            nodes (Get/Set Attribute, Get Model Attribute, the by-id agent pair).
            Each extra slot adds a `value_${i}` port (get: output, set: input);
            removal takes the LAST slot (Sequence's rule) so a wired lower slot
            can never silently re-pair with a different attribute. Compiles via
            the shared expansion into single-slot primitives (multiAttrExpand.ts). */}
        {MULTI_ATTR_TYPES.has(nodeData.nodeType) && (() => {
          const extraCount = multiAttrExtraCount(nodeData.config);
          // The slot dropdown mirrors the node's PRIMARY dropdown per type.
          const slotList = nodeData.nodeType === 'getModelAttribute'
            ? model.attributes.filter(a => a.isModelAttribute)
            : nodeData.nodeType === 'getAgentAttribute'
              ? (model.agentAttributes ?? [])
              : ownAttrList;
          const addSlot = () => {
            updateNodeData(id, { ...nodeData, config: { ...nodeData.config, extraCount: extraCount + 1 } });
          };
          const removeLast = () => {
            if (extraCount === 0) return;
            const last = extraCount + 1;
            const next: NodeConfig = { ...nodeData.config, extraCount: extraCount - 1 };
            delete next[`attr_${last}`];
            delete next[`_port_value_${last}`];
            updateNodeData(id, { ...nodeData, config: next });
          };
          return (
            <>
              {Array.from({ length: extraCount }, (_, k) => {
                const i = k + 2;
                return (
                  <select
                    key={`slot-${i}`}
                    className={styles.select}
                    value={(nodeData.config[`attr_${i}`] as string) || ''}
                    onChange={e => updateConfig(`attr_${i}`, e.target.value)}
                    title={`Attribute slot ${i}`}
                  >
                    <option value="">Attribute {i}...</option>
                    {slotList.map(a => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                );
              })}
              <div style={{ display: 'flex', gap: 4 }}>
                <button
                  onMouseDown={e => e.stopPropagation()}
                  onClick={addSlot}
                  style={{ fontSize: '0.7rem', padding: '2px 8px', cursor: 'pointer', flex: 1 }}
                  title="Add another attribute slot (adds a port)"
                >+ Attribute</button>
                <button
                  onMouseDown={e => e.stopPropagation()}
                  onClick={removeLast}
                  style={{ fontSize: '0.7rem', padding: '2px 8px', cursor: extraCount === 0 ? 'not-allowed' : 'pointer', opacity: extraCount === 0 ? 0.4 : 1 }}
                  disabled={extraCount === 0}
                  title="Remove the last attribute slot"
                >−</button>
              </div>
            </>
          );
        })()}

        {(isMacroInput || isMacroOutput) && macroDefForBoundary && (() => {
          const ports = isMacroInput
            ? macroDefForBoundary.exposedInputs
            : macroDefForBoundary.exposedOutputs;
          // EXPLICIT CONTROLS: the group select appears only once the def HAS a
          // group — otherwise it is a control that can do nothing (the
          // enabled-control doctrine). Groups are managed on the MacroInput node
          // (below) but serve BOTH port lists.
          const hasGroups = groupsOf.length > 0;
          const armed = controlPick?.defId === macroDefIdForBoundary;
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
                  {hasGroups && (
                    <select
                      className={styles.select}
                      style={{ width: 62 }}
                      value={p.groupId ?? ''}
                      onChange={e => setPortGroup(p.portId, e.target.value)}
                      title="Interface group — assigning a port to a group reorders the handles to match"
                    >
                      <option value="">(none)</option>
                      {groupsOf.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                    </select>
                  )}
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

              {/* EXPLICIT PARAMETERS + GROUPS live on the MacroInput node (the
                  "interface in" node); groups serve BOTH port lists. */}
              {isMacroInput && (
                <>
                  <div className={styles.ifaceHeader}>Explicit Parameters</div>
                  {controlsOf.map(c => {
                    const desc = describeControlTarget(model, macroDefIdForBoundary, c);
                    const rebinding = armed && controlPick?.controlId === c.id;
                    return (
                      <div key={c.id}>
                        <div style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
                          <input
                            className={styles.input}
                            style={{ flex: 1 }}
                            value={c.name}
                            onChange={e => renameControl(c.id, e.target.value)}
                            title="Control name — what the closed instance shows"
                          />
                          {hasGroups && (
                            <select
                              className={styles.select}
                              style={{ width: 62 }}
                              value={c.groupId ?? ''}
                              onChange={e => setControlGroup(c.id, e.target.value)}
                              title="Interface group"
                            >
                              <option value="">(none)</option>
                              {groupsOf.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                            </select>
                          )}
                          <button
                            className="nodrag"
                            style={{
                              background: 'none', border: 'none',
                              color: rebinding ? 'var(--color-accent)' : 'var(--color-text-tertiary)',
                              cursor: 'pointer', fontSize: '0.7rem', padding: '0 2px',
                            }}
                            onClick={() => (rebinding ? setControlPick(null) : startPick(c.id))}
                            title={rebinding ? 'Cancel — click again, or press Esc' : 'Re-bind: click another parameter on any node in this macro'}
                          >
                            {rebinding ? '…' : '✎'}
                          </button>
                          <button
                            style={{
                              background: 'none', border: 'none', color: '#f44336',
                              cursor: 'pointer', fontSize: '0.7rem', padding: '0 2px',
                            }}
                            onClick={() => removeControl(c.id)}
                            title="Remove control"
                          >
                            x
                          </button>
                        </div>
                        <div
                          className={styles.ifaceSub}
                          style={desc.block ? { color: 'var(--color-danger, #f44336)' } : undefined}
                          title={desc.text}
                        >
                          {desc.text}
                        </div>
                      </div>
                    );
                  })}
                  <button
                    className={styles.select}
                    style={{
                      cursor: 'pointer', textAlign: 'center',
                      ...(armed && controlPick?.controlId === 'new'
                        ? { borderColor: 'var(--color-accent)', color: 'var(--color-accent)' }
                        : {}),
                    }}
                    onClick={() => (armed && controlPick?.controlId === 'new' ? setControlPick(null) : startPick('new'))}
                    title="Click, then click any eligible parameter on a node in this macro"
                  >
                    {armed && controlPick?.controlId === 'new' ? 'Pick a parameter… (Esc)' : '+ Explicit Parameter'}
                  </button>

                  <div className={styles.ifaceHeader}>Groups</div>
                  {groupsOf.map(g => (
                    <div key={g.id} style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
                      <input
                        className={styles.input}
                        style={{ flex: 1 }}
                        value={g.name}
                        onChange={e => renameGroup(g.id, e.target.value)}
                        title="Group name — a section header on the closed instance"
                      />
                      <button
                        style={{
                          background: 'none', border: 'none', color: '#f44336',
                          cursor: 'pointer', fontSize: '0.7rem', padding: '0 2px',
                        }}
                        onClick={() => removeGroup(g.id)}
                        title="Remove group (its ports and controls become ungrouped — nothing is deleted)"
                      >
                        x
                      </button>
                    </div>
                  ))}
                  <button
                    className={styles.select}
                    style={{ cursor: 'pointer', textAlign: 'center' }}
                    onClick={addGroup}
                  >
                    + Group
                  </button>
                </>
              )}
            </>
          );
        })()}

      </div>

      {/* Input handles (left side) + external inline widgets + external labels.
          The main flow input is rendered in the header (see renderMainFlowHandle). */}
      {bodyInputPorts.map((port, i) => {
        const portDef = allInputPortDefs.get(port.id) ?? port;
        const hid = handleId(port);
        const isConnected = connectedInputHandles.has(hid);
        const topPx = PORT_TOP_BASE + i * portSpacing;

        // Determine the effective widget type + its tag options. THE ONE
        // resolution lives in explicitControls.ts and is DUALLY CONSUMED — here,
        // and by an Explicit Control bound to this same `_port_*` key, so the
        // widget the instance renders can never drift from the widget the node
        // renders (the buildCensusPorts / buildInputParamPorts discipline).
        // It covers, in this order: the declared `inlineWidget`; the
        // setAttribute-family `value` swap by the picked attribute's TYPE; the
        // VECTOR suppression; the multi-attr slot's tag OPTIONS; and Compare's
        // operand swap by `compareType`.
        const inlineW = inlineWidgetFor(nodeData.nodeType, nodeData.config, portDef, model);
        const effectiveWidget = inlineW.kind;
        const inlineTagOptions = inlineW.tagOptions ?? [];

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
            {showWidget && (() => {
              // EXPLICIT CONTROLS — pick mode outlines the REAL widget in place
              // (deviation V6) and makes it INERT: the pointer-down capture kills
              // focus / the native select popup, and the click capture BINDS.
              // Binding on the completed CLICK (not the press) keeps a stray
              // press-and-drag from committing a binding.
              const pickable = pickInPlaceKeys.has(configKey);
              return (
              // `title` names the port: with the global port-label toggle OFF
              // (the default) an inline widget is otherwise an unlabelled box, so
              // hovering is the only way to learn what it sets (the reported
              // "where is the Radius input?" on the FOV sensing nodes).
              <div
                className={`${styles.inlineWidgetWrapper} nodrag${pickable ? ` ${styles.pickable}` : ''}`}
                title={pickable ? `Bind “${port.label}” as an explicit parameter` : port.label}
                style={{ top: `${topPx}px` }}
                onDoubleClick={stopAll}
                {...(pickable ? {
                  onPointerDownCapture: (e: React.PointerEvent) => { e.preventDefault(); e.stopPropagation(); },
                  onMouseDownCapture: (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); },
                  onClickCapture: (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); bindPick(configKey, port.label); },
                } : {})}
              >
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
                    options={inlineTagOptions}
                    onChange={next => updateConfig(configKey, next)}
                    onClick={e => e.stopPropagation()}
                    onMouseDown={stopDrag}
                  />
                ) : effectiveWidget === 'glyph' ? (
                  <InlineGlyphInput
                    className={styles.inlineWidget}
                    value={val}
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
              );
            })()}
            {showPortLabels && !showWidget && (
              <div className={styles.portLabelLeft} style={{ top: `${topPx}px` }}>
                {port.label}
              </div>
            )}
          </div>
        );
      })}

      {/* Output handles (right side) + external labels.
          The main flow output is rendered in the header (see renderMainFlowHandle). */}
      {bodyOutputPorts.map((port, i) => {
        const hid = handleId(port);
        const topPx = PORT_TOP_BASE + i * portSpacing;
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

      {/* Expression node: WIDTH grip, bottom-right corner of the node.
          A direct child of the root (which is `position: relative`) rather than
          of `.body`, so it sits on the node's own corner and shows in EVERY body
          state — including the default one, where the editor is collapsed and
          the formula is the only thing on show.
          `nodrag` is MANDATORY: `.body` carries it but this is outside `.body`,
          and without it React Flow's drag swallows the pointer and the gesture
          moves the node instead of resizing it. */}
      {isExpression && (
        <div
          className="nodrag"
          style={{
            position: 'absolute', right: 1, bottom: 1, width: 14, height: 14,
            cursor: 'ew-resize', opacity: exprDragW != null ? 0.9 : 0.4,
            touchAction: 'none',
          }}
          title={'Drag to widen the node so the whole formula fits\nDouble-click to fit the contents again'}
          onPointerDown={onExprGripDown}
          onPointerMove={onExprGripMove}
          onPointerUp={onExprGripUp}
          onPointerCancel={onExprGripUp}
          onDoubleClick={onExprGripDoubleClick}
        >
          {/* Two diagonal ticks — the conventional corner-grip mark. */}
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path
              d="M13 5 L5 13 M13 9.5 L9.5 13"
              stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none"
              opacity="0.75"
            />
          </svg>
        </div>
      )}
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
