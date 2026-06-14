import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ReactFlowProvider,
  useStoreApi,
  useStore,
} from '@xyflow/react';
import { getNodesInside } from '@xyflow/system';
import type { Connection, Edge, Node, NodeTypes, ReactFlowInstance, SelectionMode, IsValidConnection, OnConnectStart, OnConnectEnd, FinalConnectionState } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { CaNode } from './CaNode';
import { CommentNodeComponent } from './CommentNodeComponent';
import { GroupNodeComponent } from './GroupNodeComponent';
import { RerouteNodeComponent } from './RerouteNodeComponent';
import { useModel } from '../../model/ModelContext';
import { getNodeDef, getAllNodeDefs } from './nodes/registry';
import { parseHandleId, handleId } from './types';
import type { PortDef, NodeTypeDef } from './types';
import { MODEL_ELEMENT_DRAG_MIME, RELATED_NODES, payloadElementId, relatedEntriesForPayload, computeCompatibleHandlesForDrag, findNearestCompatibleHandle } from './modelElementDrag';
import type { ModelElementDragPayload } from './modelElementDrag';
import { getEffectivePorts } from './effectivePorts';
import type { GraphNode, GraphEdge } from '../../model/types';
import type { MacroPort } from '../../model/types';
import { computeAlignmentSnap, sameGuides } from './alignmentSnap';
import type { AlignGuides, AlignTarget } from './alignmentSnap';
import { useThemeTokens } from '../../styles/useThemeTokens';
import styles from './GraphEditor.module.css';

/** Canvas colors that React-Flow takes as JS props (Background grid, MiniMap)
 *  — read via useThemeTokens so they recolor when the theme changes. Stable
 *  identity so the hook's memo doesn't re-subscribe every render. */
const CANVAS_TOKENS = [
  '--color-canvas-grid',
  '--color-minimap-bg',
  '--color-minimap-node',
  '--color-minimap-node-group',
  '--color-minimap-mask',
] as const;

const nodeTypes: NodeTypes = {
  caNode: CaNode,
  commentNode: CommentNodeComponent,
  groupNode: GroupNodeComponent,
  rerouteNode: RerouteNodeComponent,
};

// ---------------------------------------------------------------------------
// Clipboard for copy/paste (module-level, persists across re-renders)
// ---------------------------------------------------------------------------

let clipboard: { nodes: GraphNode[]; edges: GraphEdge[] } | null = null;

import { setIsConnecting, setConnectingFrom, setShowPortLabels, showPortLabelsGlobal, showGridGlobal, setShowGrid as setShowGridGlobal, snapEnabledGlobal, setSnapEnabled as setSnapEnabledGlobal, setConnectedHandlesFromEdges, setConnectionHazards, getSavedGraphViewport, setSavedGraphViewport, savedCurrentScope, setSavedCurrentScope, subscribeCurrentModelElementDrag, setCompatibleHandlesForDrag, clearCompatibleHandlesForDrag, setCurrentModelElementDrag, compatibleHandlesForDrag, currentModelElementDrag, setQuickAddApi } from './graphState';
import type { QuickAddPayload } from './graphState';
import { detectEdgeHazard, isNodeAvailable } from './nodes/nodeValidation';
import { pushSnapshot, undo, redo, pushToRedo, pushToUndo, clearHistory } from './graphHistory';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { NameInputDialog } from '../../components/NameInputDialog';

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

function generateNodeId(existingNodes: Node[]): string {
  const existingIds = new Set(existingNodes.map(n => n.id));
  let id = `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  while (existingIds.has(id)) {
    id = `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  }
  return id;
}

// ---------------------------------------------------------------------------
// Connection-drop helpers (drag a link onto empty canvas → Add Node menu
// filtered to nodes compatible with the originating port + auto-connect)
// ---------------------------------------------------------------------------

interface ConnectionOrigin {
  nodeId: string;
  portId: string;
  kind: 'input' | 'output';
  category: 'flow' | 'value';
  dataType?: string;
  isArray?: boolean;
  /** Dual-mode relay port (valueSwitch) — see PortDef.arrayCapable. */
  arrayCapable?: boolean;
}

/** Resolve the static or dynamic port info on the source side of a connection
 *  drag. Covers the dynamic ports the editor actually creates (switch case_N /
 *  case_N_cond / case_N_val, sequence then_N, getModelAttribute r/g/b). */
function getOriginPortInfo(
  node: Node,
  portId: string,
): { category: 'flow' | 'value'; dataType?: string; isArray?: boolean; arrayCapable?: boolean } | null {
  const nd = node.data as { nodeType?: string; config?: Record<string, unknown> } | undefined;
  const t = nd?.nodeType;
  if (!t) return null;
  if (t === 'reroute') {
    // Reroutes aren't registry nodes; their port shape lives in node.data.
    const rd = node.data as Record<string, unknown>;
    return { category: rd.portCategory === 'flow' ? 'flow' : 'value', dataType: rd.dataType as string | undefined };
  }
  const def = getNodeDef(t);
  if (def) {
    const staticPort = def.ports.find(p => p.id === portId);
    if (staticPort) {
      return { category: staticPort.category, dataType: staticPort.dataType, isArray: staticPort.isArray, arrayCapable: staticPort.arrayCapable };
    }
  }
  if (t === 'switch') {
    if (/^case_\d+_cond$/.test(portId)) return { category: 'value', dataType: 'bool' };
    if (/^case_\d+_val$/.test(portId)) return { category: 'value', dataType: 'any' };
    if (/^case_\d+$/.test(portId)) return { category: 'flow' };
  }
  if (t === 'sequence' && /^then_\d+$/.test(portId)) return { category: 'flow' };
  if (t === 'getModelAttribute' && (portId === 'r' || portId === 'g' || portId === 'b')) {
    return { category: 'value', dataType: 'integer' };
  }
  return null;
}

function portsCompatible(
  srcCategory: 'flow' | 'value',
  srcKind: 'input' | 'output',
  srcType: string | undefined,
  srcIsArray: boolean | undefined,
  srcArrayCapable: boolean | undefined,
  dstPort: PortDef,
): boolean {
  if (dstPort.category !== srcCategory) return false;
  if (dstPort.kind === srcKind) return false;
  if (srcCategory === 'flow') return true;
  // Reject only array-source → scalar-target. Scalar → array is fine — the
  // compilers wrap a single scalar as `[src]` and multiple scalars wired to
  // the same isArray port as `[s1, s2, ...]` via `inputToSources`
  // (compile.ts:904-916). Without this asymmetry, the panel-drag compatible
  // sources menu for Aggregate-style isArray inputs (Aggregate.values,
  // GetRandom.options) would hide every scalar producer, even though
  // isValidConnection permits the connection at wire-time.
  const sourceIsArray = srcKind === 'output' ? !!srcIsArray : !!dstPort.isArray;
  const targetIsArray = srcKind === 'input' ? !!srcIsArray : !!dstPort.isArray;
  // Dual-mode relay (valueSwitch, `arrayCapable` ports): a scalar-typed port
  // that may also carry an array. Treat the TARGET side as array-capable so an
  // array source into it isn't rejected — covers both drag directions
  // (dragging an array output onto Value Switch's If/Else, and dragging from
  // Value Switch's If/Else to find an array source). Wiring + relay are already
  // handled by isValidConnection + the compilers; this is discovery only.
  const targetArrayCapable = srcKind === 'input' ? !!srcArrayCapable : !!dstPort.arrayCapable;
  if (sourceIsArray && !targetIsArray && !targetArrayCapable) return false;
  const a = srcType ?? 'any';
  const b = dstPort.dataType ?? 'any';
  return a === 'any' || b === 'any' || a === b;
}

/** Build the list of node-type candidates for a model-element drop. When
 *  `snap` is present, each candidate must also have a port compatible with the
 *  snap target so auto-connect can succeed. Shared between the drop handler
 *  (which auto-creates when the list collapses to one entry) and the menu
 *  render (which categorises and shows the list to the user). */
/** One selectable row in the connection-drop menu's searchable list. */
type DropMenuItem =
  | { key: string; label: string; kind: 'reroute' }
  | { key: string; label: string; kind: 'node'; def: NodeTypeDef };

interface ResolvedDropCandidate {
  entry: typeof RELATED_NODES[ModelElementDragPayload['kind']][number];
  def: NodeTypeDef;
  /** Resolved port on the to-be-created node that will receive the auto-connect.
   *  Present only when `snap` was provided to resolveDropCandidates. */
  matchPort?: PortDef;
}

function resolveDropCandidates(
  payload: ModelElementDragPayload,
  snap: ConnectionOrigin | undefined,
): ResolvedDropCandidate[] {
  const entries = relatedEntriesForPayload(payload);
  const resolved: ResolvedDropCandidate[] = [];
  for (const entry of entries) {
    const def = getNodeDef(entry.nodeType);
    if (!def) continue;
    if (snap) {
      const newCfg: Record<string, unknown> = {
        ...def.defaultConfig,
        ...(entry.extraConfig ?? {}),
        [entry.configKey]: payloadElementId(payload),
      };
      if (payload.kind === 'model-attribute') newCfg.isColorAttr = payload.isColor;
      const eff = getEffectivePorts(def.type, newCfg);
      const candidates = [...eff.inputs, ...eff.outputs];
      const compatible = candidates.find(p =>
        portsCompatible(snap.category, snap.kind, snap.dataType, snap.isArray, snap.arrayCapable, p));
      if (!compatible) continue;
      resolved.push({ entry, def, matchPort: compatible });
    } else {
      resolved.push({ entry, def });
    }
  }
  return resolved;
}

// --- Snap-to-port placement ---
// Visual constants for the heuristic placement: the new node's connecting port
// should sit a small gap from the target port and align vertically. The RAF
// refinement step measures actual DOM positions after layout and applies a
// precise correction — these constants only need to be close enough that the
// initial position isn't disorienting.
const SNAP_GAP_FLOW = 30;       // horizontal flow-coord gap between ports
const SNAP_NEW_NODE_WIDTH = 200; // estimated new CaNode width
const SNAP_HEADER_Y = 36;        // estimated y of the first port relative to node top
const SNAP_PORT_ROW_Y = 24;      // estimated per-row port spacing

/** Estimate the per-axis offset (in node-local pixels) of the new node's
 *  matchPort relative to the new node's top-left corner. Used by the initial
 *  snap placement BEFORE the new node has rendered + been measured. The RAF
 *  refinement step replaces this estimate with the real measurement. */
function estimateNewNodePortY(def: NodeTypeDef, matchPort: PortDef): number {
  // Group ports by side: inputs (kind === 'input') are on the LEFT, outputs
  // (kind === 'output') on the RIGHT. Index within the same side gives the
  // vertical row, roughly. Excludes the flow-input "do" port which renders
  // attached to the header in many node templates — for the estimate we just
  // count it as row 0 like other ports; the RAF step corrects any drift.
  const sameSide = def.ports.filter(p => p.kind === matchPort.kind);
  const idx = sameSide.findIndex(p => p.id === matchPort.id);
  return SNAP_HEADER_Y + Math.max(0, idx) * SNAP_PORT_ROW_Y;
}

/** Compute the FLOW-coord position where the new node should spawn so that
 *  its `matchPort` aligns with the snap target's port (with a small gap on
 *  the correct side). `targetPortScreenPos` is the live DOM bounding-rect
 *  centre of the target port; the screenToFlow helper converts to flow coords. */
function computeSnapPosition(
  snap: ConnectionOrigin,
  targetPortScreenPos: { x: number; y: number } | null,
  newDef: NodeTypeDef,
  matchPort: PortDef,
  screenToFlow: (p: { x: number; y: number }) => { x: number; y: number },
  fallback: { x: number; y: number },
): { x: number; y: number } {
  if (!targetPortScreenPos) return fallback;
  // Convert the screen-space target port centre to flow coords. Then offset
  // by the new node's expected port-on-node position in flow units. (At
  // typical zoom levels the px↔flow ratio is 1, but if the user is zoomed
  // the heuristic gap will be slightly off — RAF refinement corrects.)
  const targetFlow = screenToFlow(targetPortScreenPos);
  const newPortYInNode = estimateNewNodePortY(newDef, matchPort);
  // Target is INPUT → new node sits to the LEFT, its output port at right edge.
  // Target is OUTPUT → new node sits to the RIGHT, its input port at left edge.
  if (snap.kind === 'input') {
    return {
      x: targetFlow.x - SNAP_GAP_FLOW - SNAP_NEW_NODE_WIDTH,
      y: targetFlow.y - newPortYInNode,
    };
  }
  return {
    x: targetFlow.x + SNAP_GAP_FLOW,
    y: targetFlow.y - newPortYInNode,
  };
}

/** Look up a port's screen-space bounding rect via React Flow's DOM
 *  conventions. Returns the centre of the rect, or null if the handle isn't
 *  in the DOM yet. Mirrors `findNearestCompatibleHandle`'s query. */
function getPortScreenCentre(
  nodeId: string,
  portId: string,
  kind: 'input' | 'output',
  category: 'flow' | 'value',
): { x: number; y: number } | null {
  const nodeEl = document.querySelector(`[data-id="${nodeId}"]`);
  if (!nodeEl) return null;
  const handleId = `${kind}_${category}_${portId}`;
  const handleEl = nodeEl.querySelector(`[data-handleid="${handleId}"]`) as HTMLElement | null;
  if (!handleEl) return null;
  const r = handleEl.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** Does the node definition have at least one static port compatible with the
 *  connection origin? Used for menu inclusion. Dynamic-only ports aren't a
 *  selection criterion — a node still appears if its static port set has a
 *  match (Switch passes via its `default`/`check`/`value` static ports). */
function nodeHasCompatiblePort(def: NodeTypeDef, origin: ConnectionOrigin): boolean {
  return def.ports.some(p =>
    portsCompatible(origin.category, origin.kind, origin.dataType, origin.isArray, origin.arrayCapable, p),
  );
}

/** Pick the best compatible port on the new node for auto-connect. Prefers
 *  exact dataType match, then `'any'` matches; isArray must always match.
 *  When `resolvedConfig` is provided, uses effective ports (handles config-
 *  dependent ports like GetModelAttribute's r/g/b vs value). */
function pickCompatiblePort(
  def: NodeTypeDef,
  origin: ConnectionOrigin,
  resolvedConfig?: Record<string, unknown>,
): PortDef | null {
  let candidates: PortDef[];
  if (resolvedConfig) {
    const eff = getEffectivePorts(def.type, resolvedConfig);
    candidates = [...eff.inputs, ...eff.outputs].filter(p =>
      portsCompatible(origin.category, origin.kind, origin.dataType, origin.isArray, origin.arrayCapable, p),
    );
  } else {
    candidates = def.ports.filter(p =>
      portsCompatible(origin.category, origin.kind, origin.dataType, origin.isArray, origin.arrayCapable, p),
    );
  }
  if (candidates.length === 0) return null;
  if (origin.category === 'flow') return candidates[0] ?? null;
  const exact = candidates.find(p => p.dataType === origin.dataType);
  if (exact) return exact;
  return candidates[0] ?? null;
}

const HIDDEN_FROM_DROP_MENU = new Set(['macro', 'macroInput', 'macroOutput']);

/** Screen-space radius for snapping a panel-drag drop onto a nearby canvas
 *  port. Matches xyflow's default `connectionRadius` so the snap distance is
 *  consistent with how the user already perceives "near a port" when
 *  connecting links. */
const PANEL_DRAG_SNAP_RADIUS_PX = 20;

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

function toRFNodes(graphNodes: GraphNode[]): Node[] {
  // Defensive parentId scrub: groups are free-floating area markers, not
  // parents. The LOAD_MODEL migration normally handles this, but if any
  // legacy `data.parentId` slips through (e.g., from a state set BEFORE
  // the migration ran), strip it here too. Position is already absolute
  // post-migration; this is purely a data-hygiene step.
  return graphNodes.map(n => {
    const d = n.data as Record<string, unknown>;
    const cleanData = ('parentId' in d)
      ? (() => { const c = { ...d }; delete c.parentId; return c as GraphNode['data']; })()
      : n.data;
    const rfNode: Node = {
      id: n.id,
      type: n.type === 'groupNode' ? 'groupNode' : n.type === 'commentNode' ? 'commentNode' : n.type === 'rerouteNode' ? 'rerouteNode' : 'caNode',
      position: n.position,
      data: cleanData,
    };
    if (n.type === 'groupNode') {
      rfNode.style = { width: (d.width as number) || 300, height: (d.height as number) || 200 };
      rfNode.zIndex = -1;
      // dragHandle restricts node-drag initiation to the group's header strip.
      // LMB-down on the body falls through to a capture-phase handler in
      // GraphEditor that either selects the group (no movement) or
      // re-dispatches to the pane for box-select (movement past threshold) —
      // so users can box-select inner nodes without grabbing the group.
      rfNode.dragHandle = '[data-drag-handle="true"]';
    } else if (n.type === 'commentNode') {
      rfNode.style = { width: (d.width as number) || 200, height: (d.height as number) || 80 };
    }
    // Reroutes are normal draggable nodes — they move individually AND as part of
    // a multi-selection. The press-and-hold gesture (below) is only for CREATING
    // a reroute on a wire, not for moving an existing one.
    return rfNode;
  });
}

function toRFEdges(graphEdges: GraphEdge[]): Edge[] {
  return graphEdges.map(e => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle,
    targetHandle: e.targetHandle,
    style: { stroke: e.sourceHandle.includes('flow') ? '#66bb6a' : '#4cc9f0', strokeWidth: 2 },
  }));
}

function toGraphNodes(rfNodes: Node[]): GraphNode[] {
  return rfNodes.map(n => {
    const nAny = n as { width?: number; height?: number; measured?: { width?: number; height?: number } };
    const rawStyle = n.style as Record<string, number> | undefined;
    // NodeResizer updates n.measured / n.width, NOT n.style — so read those first, fall back to style.
    const mW = nAny.measured?.width ?? nAny.width ?? rawStyle?.width;
    const mH = nAny.measured?.height ?? nAny.height ?? rawStyle?.height;
    const needsSize = n.type === 'groupNode' || n.type === 'commentNode';
    return {
      id: n.id,
      type: n.type ?? 'caNode',
      position: n.position,
      data: {
        ...(n.data as GraphNode['data']),
        ...(needsSize && mW != null ? { width: mW } : {}),
        ...(needsSize && mH != null ? { height: mH } : {}),
      },
    };
  });
}

function toGraphEdges(rfEdges: Edge[]): GraphEdge[] {
  return rfEdges.map(e => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle ?? '',
    targetHandle: e.targetHandle ?? '',
  }));
}

/** Approximate rendered dimensions for a node. Used by the group-drag intercept
 *  to decide which nodes are inside a group's rectangle at drag-start. Mirrors
 *  the fallbacks used elsewhere (NODE_W/H, collapsedH, groupNode/commentNode
 *  style). */
function nodeSize(n: Node): { w: number; h: number } {
  const nAny = n as { width?: number; height?: number; measured?: { width?: number; height?: number } };
  const style = n.style as Record<string, number> | undefined;
  const data = n.data as Record<string, unknown> | undefined;
  const isCollapsed = !!data?.isCollapsed;
  const w = nAny.measured?.width
    ?? nAny.width
    ?? (n.type === 'groupNode' || n.type === 'commentNode' ? (style?.width ?? 200) : n.type === 'rerouteNode' ? 16 : 200);
  const h = nAny.measured?.height
    ?? nAny.height
    ?? (n.type === 'groupNode'
      ? (style?.height ?? 200)
      : n.type === 'commentNode'
        ? (style?.height ?? 80)
        : n.type === 'rerouteNode' ? 16
        : isCollapsed ? 32 : 100);
  return { w, h };
}

function nodeCenter(n: Node): { x: number; y: number } {
  const { w, h } = nodeSize(n);
  return { x: n.position.x + w / 2, y: n.position.y + h / 2 };
}

// ---------------------------------------------------------------------------
// Ctrl-drag alignment guides (PowerPoint-style). While Ctrl/Cmd is held during
// a node drag, the moving node(s) snap so their left/center/right edges and
// top/center/bottom edges line up with nearby nodes, and dashed guide lines
// surface the match. Snap distance is a screen-pixel threshold (converted to
// flow units via the live zoom) so it feels constant at any zoom.
// ---------------------------------------------------------------------------

const ALIGN_SNAP_PX = 6;

/** SVG overlay drawing the active alignment guides. Subscribes to the live
 *  viewport transform so it isolates pan/zoom re-renders to itself (rather than
 *  re-rendering the whole GraphEditor). Flow → container-pixel mapping mirrors
 *  React Flow's own viewport transform (`flow * zoom + translate`). */
function AlignmentGuidesOverlay({ guides }: { guides: AlignGuides | null }) {
  const transform = useStore(s => s.transform);
  if (!guides) return null;
  const [tx, ty, zoom] = transform;
  const X = (fx: number) => fx * zoom + tx;
  const Y = (fy: number) => fy * zoom + ty;
  return (
    <svg
      aria-hidden="true"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 4, overflow: 'visible' }}
    >
      {guides.vx && (
        <line
          x1={X(guides.vx.x)} y1={Y(guides.vx.y0)} x2={X(guides.vx.x)} y2={Y(guides.vx.y1)}
          stroke="var(--color-accent)" strokeWidth={1} strokeDasharray="4 3"
        />
      )}
      {guides.hy && (
        <line
          x1={X(guides.hy.x0)} y1={Y(guides.hy.y)} x2={X(guides.hy.x1)} y2={Y(guides.hy.y)}
          stroke="var(--color-accent)" strokeWidth={1} strokeDasharray="4 3"
        />
      )}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Context menu types
// ---------------------------------------------------------------------------

interface ContextMenuState {
  x: number;
  y: number;
  flowX: number;
  flowY: number;
  target:
    | { type: 'pane' }
    | { type: 'node'; nodeId: string; nodeType: string; isMacro: boolean; isGroup: boolean }
    | { type: 'selection'; nodeIds: string[] }
    | { type: 'connection-drop'; origin: ConnectionOrigin }
    | { type: 'model-element-drop'; element: ModelElementDragPayload; snapToPort?: ConnectionOrigin };
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function GraphEditorInner() {
  const { model, modelVersion, setGraph, addMacro, importMacro, updateMacro, removeMacro } = useModel();
  const [nodes, setNodes, onNodesChange] = useNodesState(toRFNodes(model.graphNodes));
  const [edges, setEdges, onEdgesChange] = useEdgesState(toRFEdges(model.graphEdges));
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  // Pending bulk-delete waiting for user confirmation. We close the context
  // menu first (UX), then surface a custom ConfirmDialog instead of blocking
  // the page with the browser's native `confirm`. onConfirm performs the
  // real deletion using the captured node-id list.
  const [pendingMultiDelete, setPendingMultiDelete] = useState<string[] | null>(null);

  // In-app name-entry dialog (replaces native window.prompt). A handler opens it
  // via promptName(...) and awaits the entered name; null means cancelled.
  const [namePrompt, setNamePrompt] = useState<
    | null
    | {
        title: string;
        fieldLabel?: string;
        initialValue: string;
        placeholder?: string;
        confirmLabel?: string;
        allowEmpty: boolean;
        x: number;
        y: number;
        resolve: (value: string | null) => void;
      }
  >(null);

  const promptName = useCallback(
    (opts: {
      title: string;
      fieldLabel?: string;
      initialValue: string;
      placeholder?: string;
      confirmLabel?: string;
      allowEmpty?: boolean;
      x: number;
      y: number;
    }) =>
      new Promise<string | null>(resolve => {
        setNamePrompt({ ...opts, allowEmpty: opts.allowEmpty ?? false, resolve });
      }),
    [],
  );
  // Seed from the module-level saved scope so a Modeler → Simulator → Modeler
  // round-trip leaves the user inside the macro they were editing (instead of
  // resetting back to root). Defaults to ['root'] on first-ever mount.
  const [currentScope, setCurrentScope] = useState<string[]>(() => savedCurrentScope.slice());
  // Seed from the persisted module globals so the toggles survive modeler
  // remounts (tab switches) AND page reloads (graphState write-through).
  const [showGrid, setShowGrid] = useState(showGridGlobal);
  const [snapEnabled, setSnapEnabled] = useState(snapEnabledGlobal);
  const [portLabelsVisible, setPortLabelsVisible] = useState(showPortLabelsGlobal);
  // Theme-reactive canvas colors (Background grid + MiniMap). Defaults match
  // the Blender values so they're correct even before the tokens resolve.
  const [
    gridColor = '#1a2538',
    minimapBg = '#0d1117',
    minimapNode = '#2d4059',
    minimapNodeGroup = 'rgba(45, 64, 89, 0.5)',
    minimapMask = 'rgba(0, 0, 0, 0.70)',
  ] = useThemeTokens(CANVAS_TOKENS);
  const rfInstance = useRef<ReactFlowInstance | null>(null);
  // Wrapper around <ReactFlow/> — used by the RMB-pass-through-edges effect
  // below to delegate right-button pointerdowns from edges to the pane.
  const editorWrapperRef = useRef<HTMLDivElement>(null);


  const contextMenuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const { deleteElements, getNodes, updateNodeData } = useReactFlow();
  const rfStore = useStoreApi();

  // Ref for paste position (flow coords of last right-click or viewport center for Ctrl+V)
  const pasteFlowPos = useRef<{ x: number; y: number } | null>(null);
  // Live cursor in flow coords — populated by mousemove on the pane, used as fallback paste anchor for Ctrl+V
  const lastFlowMousePos = useRef<{ x: number; y: number } | null>(null);
  // Last cursor SCREEN position over the pane — used to place the Spacebar
  // quick-add menu at the cursor (flow pos alone can't position the popup).
  const lastClientMousePos = useRef<{ x: number; y: number } | null>(null);

  // Refs for debounced sync
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  useEffect(() => { edgesRef.current = edges; }, [edges]);

  // Group drag state: captured on onNodeDragStart, applied per-tick inside
  // handleNodesChange. Membership is frozen at drag-start so dragging a group
  // translates exactly the set of nodes that were inside its rectangle when
  // the drag began — moving over other nodes mid-drag doesn't capture them.
  const groupDragRef = useRef<{
    groupId: string;
    startPos: { x: number; y: number };
    snapAccum: { x: number; y: number };
    members: Array<{ id: string; startX: number; startY: number }>;
  } | null>(null);

  // Ctrl-held alignment snapping. `ctrlHeldRef` tracks the modifier during a
  // drag (the mouse-move events React Flow hands us don't carry modifier
  // state, so we read it from a document-level key listener). `alignGuides`
  // drives the dashed overlay; `alignGuidesRef` mirrors it so the per-tick
  // `handleNodesChange` can diff without a stale-closure read.
  const ctrlHeldRef = useRef(false);
  const [alignGuides, setAlignGuides] = useState<AlignGuides | null>(null);
  const alignGuidesRef = useRef<AlignGuides | null>(null);
  const clearAlignGuides = useCallback(() => {
    if (alignGuidesRef.current) {
      alignGuidesRef.current = null;
      setAlignGuides(null);
    }
  }, []);

  // Track Ctrl/Cmd during drags (and clear guides the moment it's released or
  // the window loses focus). Capture phase + window scope so it sees the key
  // regardless of focus target. ctrlKey/metaKey covers Windows/Linux + Mac.
  useEffect(() => {
    const sync = (e: KeyboardEvent) => {
      const held = e.ctrlKey || e.metaKey;
      ctrlHeldRef.current = held;
      if (!held) clearAlignGuides();
    };
    const reset = () => { ctrlHeldRef.current = false; clearAlignGuides(); };
    // Safety net: a drag that aborts without a `dragging:false` tick or an
    // onNodeDragStop (node deleted mid-drag, multitouch cancel) would otherwise
    // leave guides on screen until the next Ctrl release. Any pointer release
    // clears them (a no-op when none are showing).
    const onUp = () => clearAlignGuides();
    window.addEventListener('keydown', sync, true);
    window.addEventListener('keyup', sync, true);
    window.addEventListener('blur', reset);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
    return () => {
      window.removeEventListener('keydown', sync, true);
      window.removeEventListener('keyup', sync, true);
      window.removeEventListener('blur', reset);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
    };
  }, [clearAlignGuides]);

  // Snapshot of the currently selected node ids, captured on RMB mousedown in
  // the capture phase BEFORE React Flow's internal handlers can collapse a
  // multi-selection. Read by onNodeContextMenu / openContextMenu to keep the
  // "Selection (N)" context menu and outline consistent.
  const preSelectionRef = useRef<string[]>([]);

  // Box-select modifier state. Plain LMB-drag on the pane runs React Flow's
  // default "replace selection with intersected nodes" behavior. When the
  // user starts the drag with Shift or Ctrl held, `handleNodesChange`
  // intercepts the per-tick select changes so the final selection is
  // pre ∪ box (Shift = add) or pre \ box (Ctrl = remove). Captured on the
  // capture-phase pointerdown listener so React Flow's own handlers can't
  // observe the modifier and steer behavior themselves.
  const boxSelectModeRef = useRef<'replace' | 'add' | 'remove'>('replace');
  const boxSelectActiveRef = useRef(false);
  const preBoxSelectionRef = useRef<Set<string>>(new Set());

  // True while LMB is held after pressing on the pane (a potential box-select
  // drag). Used by `handleEdgesChange` to drop edge `select` changes so the
  // box-select doesn't auto-highlight edges connected to the boxed nodes —
  // an edge has two endpoints, so "is the edge selected when only one end is"
  // has no good answer. Box-select is nodes-only; edges respond only to
  // direct edge interactions (click, double-click).
  const paneBoxDragRef = useRef(false);
  // Set true when a box-select was initiated INSIDE a group's body (our
  // capture-phase handler re-dispatches the pointerdown to the pane).
  // handleNodesChange uses this to strip groupNode selects from the box —
  // user clearly intended to box-select inner nodes, not the surrounding
  // group(s). A box-select that starts on the empty pane keeps the default
  // behaviour: groups intersecting the rect are selected normally.
  const boxFromGroupRef = useRef(false);
  // Client-coord bounds of an in-progress native pane box-select. Lets
  // handleNodesChange re-verify each box-(de)selected node's real on-screen
  // rect against the box and drop "phantom" selects that React Flow's
  // getNodesInside force-includes for nodes whose handle bounds aren't measured
  // yet (forceInitialRender) — e.g. nodes re-created by a model sync after a
  // group drag, which a position-only change never re-measures.
  const paneBoxRectRef = useRef<{ x1: number; y1: number; x2: number; y2: number } | null>(null);

  // Perf: maintain a graph-level map of connected input handles per node so each CaNode can
  // subscribe once via useSyncExternalStore instead of scanning all edges on every store event.
  // useLayoutEffect runs before paint so CaNodes reading the map never observe a stale frame.
  // We also recompute connection-kind hazards (e.g. list-position int wired into a NeighborIndex
  // port) here, hence the [nodes, edges] deps — recomputing on drag is wasted work but the
  // diff-aware setConnectionHazards skips downstream re-renders when the hazard map is unchanged.
  useLayoutEffect(() => {
    setConnectedHandlesFromEdges(edges);

    const nodeById = new Map<string, typeof nodes[number]>();
    for (const n of nodes) nodeById.set(n.id, n);
    const hazards = new Map<string, readonly string[]>();
    for (const e of edges) {
      if (!e.source || !e.target) continue;
      const srcNode = nodeById.get(e.source);
      const tgtNode = nodeById.get(e.target);
      if (!srcNode || !tgtNode) continue;
      const srcType = (srcNode.data as Record<string, unknown> | undefined)?.nodeType as string | undefined;
      const tgtType = (tgtNode.data as Record<string, unknown> | undefined)?.nodeType as string | undefined;
      if (!srcType || !tgtType) continue;
      const srcParsed = parseHandleId(e.sourceHandle ?? '');
      const tgtParsed = parseHandleId(e.targetHandle ?? '');
      if (!srcParsed || !tgtParsed) continue;
      const hazard = detectEdgeHazard(srcType, srcParsed.portId, tgtType, tgtParsed.portId);
      if (hazard) {
        const list = (hazards.get(e.target) ?? []) as string[];
        list.push(hazard);
        hazards.set(e.target, list);
      }
    }
    setConnectionHazards(hazards);
  }, [edges, nodes]);

  const currentScopeRef = useRef(currentScope);
  useEffect(() => { currentScopeRef.current = currentScope; }, [currentScope]);

  const scheduleSync = useCallback(() => {
    if (syncTimer.current) clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => {
      const scopeId = currentScopeRef.current[currentScopeRef.current.length - 1];
      const gn = toGraphNodes(nodesRef.current);
      const ge = toGraphEdges(edgesRef.current);
      if (!scopeId || scopeId === 'root') {
        setGraph(gn, ge);
      } else {
        updateMacro(scopeId, { nodes: gn, edges: ge });
      }
    }, 100);
  }, [setGraph, updateMacro]);

  useEffect(() => {
    return () => { if (syncTimer.current) clearTimeout(syncTimer.current); };
  }, []);

  // --- Undo / Redo ---
  const lastSnapshotTime = useRef(0);

  const pushCurrentSnapshot = useCallback(() => {
    pushSnapshot(toGraphNodes(nodesRef.current), toGraphEdges(edgesRef.current));
    lastSnapshotTime.current = Date.now();
  }, []);

  /** Push snapshot only if enough time has passed (for debounced config changes) */
  const pushDebouncedSnapshot = useCallback(() => {
    if (Date.now() - lastSnapshotTime.current > 300) {
      pushCurrentSnapshot();
    }
  }, [pushCurrentSnapshot]);

  const handleUndo = useCallback(() => {
    const snapshot = undo();
    if (!snapshot) return;
    pushToRedo(toGraphNodes(nodesRef.current), toGraphEdges(edgesRef.current));
    setNodes(toRFNodes(snapshot.nodes));
    setEdges(toRFEdges(snapshot.edges));
    scheduleSync();
  }, [setNodes, setEdges, scheduleSync]);

  const handleRedo = useCallback(() => {
    const snapshot = redo();
    if (!snapshot) return;
    pushToUndo(toGraphNodes(nodesRef.current), toGraphEdges(edgesRef.current));
    setNodes(toRFNodes(snapshot.nodes));
    setEdges(toRFEdges(snapshot.edges));
    scheduleSync();
  }, [setNodes, setEdges, scheduleSync]);

  // RMB on edges AND groupNode bodies should pan the canvas (same as RMB on
  // the empty pane), not be swallowed by React Flow's node/edge handlers.
  // Group bodies have `pointer-events: auto` so they catch LMB clicks (needed
  // for selection because children render as siblings, not DOM-nested), which
  // would otherwise let an RMB-drag started over a group fall into RF's node
  // drag/context-menu path. We catch right-button pointerdowns in capture
  // phase, stop propagation so React Flow's listeners don't claim the
  // gesture, then re-dispatch the event from .react-flow__pane so d3-zoom's
  // pan-on-drag starts as if the user had pressed on empty canvas. LMB is
  // untouched — edges remain selectable / double-click-deletable, groups
  // remain selectable / resizable.
  useEffect(() => {
    const wrapper = editorWrapperRef.current;
    if (!wrapper) return;
    const handler = (e: PointerEvent) => {
      if (e.button !== 2) return;
      const target = e.target as Element | null;
      if (!target) return;
      const onEdge = !!target.closest('.react-flow__edge');
      const onGroup = !!target.closest('.react-flow__node-groupNode');
      if (!onEdge && !onGroup) return;
      e.stopPropagation();
      const pane = wrapper.querySelector('.react-flow__pane') as HTMLElement | null;
      if (!pane) return;
      // d3-zoom listens for pointerdown + mousedown; fire both for safety.
      pane.dispatchEvent(new PointerEvent('pointerdown', {
        pointerId: e.pointerId,
        pointerType: e.pointerType,
        button: e.button,
        buttons: e.buttons,
        clientX: e.clientX,
        clientY: e.clientY,
        bubbles: true,
        cancelable: true,
      }));
      pane.dispatchEvent(new MouseEvent('mousedown', {
        button: e.button,
        buttons: e.buttons,
        clientX: e.clientX,
        clientY: e.clientY,
        bubbles: true,
        cancelable: true,
        view: window,
      }));
    };
    wrapper.addEventListener('pointerdown', handler, true);
    return () => wrapper.removeEventListener('pointerdown', handler, true);
  }, []);

  // Dismiss the context menu on ANY pointer-press outside it. The menu only
  // closed on a synthesized `click`, which never fires when the user instead
  // starts a box-select (LMB drag) or pan (RMB drag) — so it lingered. A
  // capture-phase pointerdown on document closes it the moment a press lands
  // anywhere outside the menu, without preventDefault/stopPropagation so the
  // press still starts the drag/selection normally. The inside-menu guard
  // lets a menu item's own onClick run before the menu unmounts.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!contextMenuRef.current) return;
      if (contextMenuRef.current.contains(e.target as globalThis.Node)) return;
      setContextMenu(null);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, []);

  // LMB on a group's body (not the header drag-handle, not a resize handle,
  // not an interactive widget): users expect to box-select inner nodes, not
  // grab the group. We capture LMB pointerdown on the group body and stash
  // start position. On first pointermove past a small threshold, we drive
  // React Flow's box-select state directly through its Zustand store
  // (bypassing synthetic event delegation, which doesn't reliably transfer
  // pointer capture). On pointerup without movement, the gesture was a click
  // — we select the group ourselves (with Ctrl/Meta = toggle, Shift = add,
  // plain = replace). Header drags still move the group via React Flow's
  // normal dragHandle plumbing.
  useEffect(() => {
    const wrapper = editorWrapperRef.current;
    if (!wrapper) return;
    let drag: {
      groupId: string;
      startX: number;
      startY: number;
      pointerId: number;
      shiftKey: boolean;
      ctrlKey: boolean;
      metaKey: boolean;
      handled: boolean;
      paneBounds: DOMRect | null;
      // Snapshot of node ids that were selected at gesture start. Needed for
      // modifier-aware box-select (Shift adds to it, Ctrl/Meta subtracts).
      preSelectedIds: Set<string>;
      // What this gesture has currently applied to the selection state.
      // Diff target for incremental change generation.
      appliedIds: Set<string>;
    } | null = null;

    // Compute the rect (pane-local coords), find intersecting non-group
    // nodes, compose the desired final selection per modifier mode, then
    // push the diff against `drag.appliedIds` through RF's store. Mirrors
    // the body of Pane.onPointerMove in @xyflow/react but reads coords from
    // our own document-level pointermove so we don't need pointer capture.
    const updateBoxSelect = (clientX: number, clientY: number) => {
      if (!drag?.paneBounds) return;
      const bounds = drag.paneBounds;
      const startXLocal = drag.startX - bounds.left;
      const startYLocal = drag.startY - bounds.top;
      const xLocal = clientX - bounds.left;
      const yLocal = clientY - bounds.top;
      const rect = {
        startX: startXLocal,
        startY: startYLocal,
        x: Math.min(xLocal, startXLocal),
        y: Math.min(yLocal, startYLocal),
        width: Math.abs(xLocal - startXLocal),
        height: Math.abs(yLocal - startYLocal),
      };
      const state = rfStore.getState();
      // getNodesInside force-includes any node whose handles aren't measured yet
      // (`forceInitialRender = !node.internals.handleBounds`), IGNORING the rect.
      // That's common right after loading a library model with many (often
      // collapsed) nodes — and made box-selecting inside a group grab the WHOLE
      // graph. Re-verify each candidate's ACTUAL on-screen rect against the drag
      // rectangle (both in client coords, straight from the DOM) so the box only
      // selects nodes it truly intersects.
      const dLeft = Math.min(drag.startX, clientX);
      const dTop = Math.min(drag.startY, clientY);
      const dRight = Math.max(drag.startX, clientX);
      const dBottom = Math.max(drag.startY, clientY);
      const boxIds = new Set(
        getNodesInside(state.nodeLookup, rect, state.transform, true, true)
          .filter(n => n.type !== 'groupNode')
          .filter(n => {
            const el = wrapper.querySelector(`.react-flow__node[data-id="${CSS.escape(n.id)}"]`);
            if (!el) return false;
            const r = el.getBoundingClientRect();
            return !(r.right < dLeft || r.left > dRight || r.bottom < dTop || r.top > dBottom);
          })
          .map(n => n.id),
      );

      // Compose the desired final selection per modifier mode.
      let desired: Set<string>;
      if (drag.shiftKey) {
        // Shift: add boxed nodes to the pre-existing selection.
        desired = new Set(drag.preSelectedIds);
        for (const id of boxIds) desired.add(id);
      } else if (drag.ctrlKey || drag.metaKey) {
        // Ctrl/Meta: subtract boxed nodes from the pre-existing selection.
        desired = new Set(drag.preSelectedIds);
        for (const id of boxIds) desired.delete(id);
      } else {
        // Plain: replace selection with just the boxed nodes.
        desired = boxIds;
      }

      const current = drag.appliedIds;
      const changes: Array<{ id: string; type: 'select'; selected: boolean }> = [];
      for (const id of desired) if (!current.has(id)) changes.push({ id, type: 'select', selected: true });
      for (const id of current) if (!desired.has(id)) changes.push({ id, type: 'select', selected: false });
      drag.appliedIds = desired;
      rfStore.setState({ userSelectionRect: rect, userSelectionActive: true });
      if (changes.length > 0) state.triggerNodeChanges(changes);
    };

    const onMove = (e: PointerEvent) => {
      if (!drag) return;
      if (!drag.handled) {
        const dx = e.clientX - drag.startX;
        const dy = e.clientY - drag.startY;
        if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
        drag.handled = true;
        const pane = wrapper.querySelector('.react-flow__pane') as HTMLElement | null;
        drag.paneBounds = pane?.getBoundingClientRect() ?? null;
        // Plain mode wipes the pre-existing selection so the box replaces
        // it. Shift/Ctrl/Meta preserve it — preSelectedIds is the source of
        // truth for those modes (see updateBoxSelect's `desired` calc).
        if (!drag.shiftKey && !drag.ctrlKey && !drag.metaKey) {
          rfStore.getState().resetSelectedElements();
          drag.appliedIds = new Set();
        }
      }
      // Stop the event before it reaches React's root listener / Pane's
      // synthetic onPointerMove. With userSelectionActive=true in the store,
      // Pane.onPointerMove would otherwise run its own getSelectionChanges
      // pass with `mutateItem=true`, mutating internalNode.selected directly
      // on the groupNode even though our filter strips the user-prop change
      // — leaving the group invisibly "selected" so multi-node drag picks it
      // up. We own this gesture; nothing else should see its pointermoves.
      e.stopPropagation();
      updateBoxSelect(e.clientX, e.clientY);
    };

    const onUp = (e: PointerEvent) => {
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('pointerup', onUp, true);
      boxFromGroupRef.current = false;
      if (!drag) return;
      const d = drag;
      drag = null;
      if (d.handled) {
        // Same reason as onMove: prevent Pane.onPointerUp from running its
        // own getSelectionChanges(...mutateItem=true) finalize pass that
        // would re-mutate internalNode.selected on the group.
        e.stopPropagation();
        // Finalize box-select: clear transient state. Selection changes were
        // pushed incrementally during onMove.
        rfStore.setState({ userSelectionRect: null, userSelectionActive: false });
        return;
      }
      // Click without movement → select the group with modifier semantics.
      const { groupId, shiftKey, ctrlKey, metaKey } = d;
      setNodes(nds => nds.map(n => {
        if (n.id === groupId) {
          if (ctrlKey || metaKey) return { ...n, selected: !n.selected };
          return n.selected ? n : { ...n, selected: true };
        }
        if (shiftKey || ctrlKey || metaKey) return n;
        return n.selected ? { ...n, selected: false } : n;
      }));
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const target = e.target as Element | null;
      if (!target) return;
      const groupEl = target.closest('.react-flow__node-groupNode') as HTMLElement | null;
      if (!groupEl) return;
      // Header (drag handle) → let React Flow start a normal node drag.
      if (target.closest('[data-drag-handle="true"]')) return;
      // Resize handles → let NodeResizer handle.
      if (target.closest('.react-flow__resize-control')) return;
      // Interactive widgets opt out via the standard `nodrag` class. (We do
      // NOT check `.nopan` — RF adds it to every node wrapper by default, so
      // checking it would always early-return.)
      if (target.closest('.nodrag')) return;
      e.stopPropagation();
      // Activate the box-from-group filter immediately so handleNodesChange
      // strips any group `select: true` change during the entire gesture —
      // some RF/d3-drag path can otherwise select the group on pointerdown
      // even with dragHandle restricting drag-start to the header.
      boxFromGroupRef.current = true;
      // Snapshot current selection so Shift / Ctrl / Meta can compose
      // against it (read from the RF store's internal lookup so we see the
      // freshest state, not the user-prop nodes which may lag a render).
      const preSelectedIds = new Set<string>();
      for (const [id, n] of rfStore.getState().nodeLookup) {
        if (n.selected) preSelectedIds.add(id);
      }
      drag = {
        groupId: groupEl.getAttribute('data-id') || '',
        startX: e.clientX,
        startY: e.clientY,
        pointerId: e.pointerId,
        shiftKey: e.shiftKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        handled: false,
        paneBounds: null,
        preSelectedIds,
        appliedIds: new Set(preSelectedIds),
      };
      document.addEventListener('pointermove', onMove, true);
      document.addEventListener('pointerup', onUp, true);
    };

    // IMPORTANT: this listener lives on `document`, not on the editor
    // wrapper. With Shift held, React Flow's `Pane.onPointerDownCapture`
    // (a synthetic listener that fires from React's root delegation at
    // <div id="root">) treats Shift as the selectionKey and intercepts the
    // pointerdown — it calls setPointerCapture on the pane and starts a
    // native RF box-select that includes the group via getSelectionChanges
    // with mutateItem=true. An editor-wrapper listener is deeper than the
    // React root in capture-phase order, so it fires too late. document is
    // above the React root, so our listener fires first and the
    // stopPropagation prevents React's root delegation from ever seeing the
    // event.
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('pointerup', onUp, true);
    };
  }, [setNodes, rfStore]);

  // Switch displayed graph when scope changes
  useEffect(() => {
    const scopeId = currentScope[currentScope.length - 1] ?? 'root';
    if (!scopeId || scopeId === 'root') {
      setNodes(toRFNodes(model.graphNodes));
      setEdges(toRFEdges(model.graphEdges));
    } else {
      const macroDef = (model.macroDefs || []).find(m => m.id === scopeId);
      if (macroDef) {
        setNodes(toRFNodes(macroDef.nodes));
        setEdges(toRFEdges(macroDef.edges));
      }
    }
    // Persist the scope so a Modeler ↔ Simulator round-trip lands the user
    // back in the same scope they were editing. If we have a saved viewport
    // for the scope we're switching INTO, restore it; otherwise auto-fit.
    // Using setViewport (not setting `defaultViewport`) because the component
    // is already mounted — `defaultViewport` is initial-render only.
    setSavedCurrentScope(currentScope);
    clearHistory();
    setTimeout(() => {
      const saved = getSavedGraphViewport(scopeId);
      if (saved) rfInstance.current?.setViewport(saved);
      else rfInstance.current?.fitView();
    }, 50);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentScope, modelVersion]);

  // Capture-phase mousedown on the viewport: snapshot the current multi-node
  // selection BEFORE React Flow's internal handlers run, so onNodeContextMenu
  // can decide whether to show the "Selection (N)" menu even when RF has
  // already collapsed the selection by the time `contextmenu` fires.
  // (mousedown precedes contextmenu in the DOM event order.)
  //
  // The same listener also detects modifier-held LMB-drags that start on the
  // pane and primes `boxSelectActiveRef` / `boxSelectModeRef` so that the
  // intercept inside `handleNodesChange` can convert React Flow's default
  // "replace" box-select into "add" (Shift) or "remove" (Ctrl/Meta).
  useEffect(() => {
    const el = document.querySelector('.react-flow') as HTMLElement | null;
    if (!el) return;
    // Live pointer position (client coords) tracked ONLY while a pane
    // box-select is in progress (the listener is added in downHandler and
    // removed in upHandler — there is NO always-on pointermove listener).
    // handleNodesChange reads it to test real DOM intersection. Capture phase
    // → runs before RF's synthetic onPointerMove that generates the box-select
    // changes, so the rect is current when those land.
    const moveHandler = (e: PointerEvent) => {
      const r = paneBoxRectRef.current;
      if (r) { r.x2 = e.clientX; r.y2 = e.clientY; }
    };
    const downHandler = (e: PointerEvent) => {
      // RMB: snapshot selection for the context-menu preservation fix.
      if (e.button === 2) {
        preSelectionRef.current = nodesRef.current
          .filter(n => n.selected)
          .map(n => n.id);
        return;
      }
      // LMB on the pane: detect modifier for box-select add/remove.
      if (e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      // Box-select only starts when the LMB-down lands on the pane itself
      // (not a node, edge, or any inner element). React Flow's own
      // selection-on-drag uses the same test.
      if (!target || !target.classList.contains('react-flow__pane')) {
        boxSelectActiveRef.current = false;
        boxSelectModeRef.current = 'replace';
        paneBoxDragRef.current = false;
        paneBoxRectRef.current = null;
        return;
      }
      paneBoxDragRef.current = true;
      paneBoxRectRef.current = { x1: e.clientX, y1: e.clientY, x2: e.clientX, y2: e.clientY };
      // Track the pointer ONLY for this gesture (removed in upHandler).
      document.addEventListener('pointermove', moveHandler, true);
      if (e.shiftKey) {
        boxSelectModeRef.current = 'add';
        boxSelectActiveRef.current = true;
      } else if (e.ctrlKey || e.metaKey) {
        boxSelectModeRef.current = 'remove';
        boxSelectActiveRef.current = true;
      } else {
        boxSelectModeRef.current = 'replace';
        boxSelectActiveRef.current = false;
      }
      if (boxSelectActiveRef.current) {
        preBoxSelectionRef.current = new Set(
          nodesRef.current.filter(n => n.selected).map(n => n.id),
        );
      }
    };
    const upHandler = () => {
      boxSelectActiveRef.current = false;
      paneBoxDragRef.current = false;
      paneBoxRectRef.current = null;
      document.removeEventListener('pointermove', moveHandler, true);
    };
    el.addEventListener('pointerdown', downHandler, true);
    // Listen on document so we catch releases outside the React Flow element.
    document.addEventListener('pointerup', upHandler, true);
    return () => {
      el.removeEventListener('pointerdown', downHandler, true);
      document.removeEventListener('pointermove', moveHandler, true);
      document.removeEventListener('pointerup', upHandler, true);
    };
  }, []);

  // (Removed: one-shot parentId scrub effect.) Even when it returned `nds`
  // unchanged, the setNodes call invalidated React Flow's internal
  // handleBounds for every node — which caused box-select to inadvertently
  // include any not-yet-remeasured node (including legitimate non-targets)
  // via `forceInitialRender = !handleBounds`. LOAD_MODEL migration + the
  // data.parentId strip in toRFNodes already handle fresh loads; legacy
  // HMR state can be recovered by a page reload.

  // --- Connection validation ---
  const isValidConnection = useCallback(
    (connection: Connection) => {
      // Prevent self-connections
      if (connection.source === connection.target) return false;

      // Parse handle categories
      const srcParsed = parseHandleId(connection.sourceHandle ?? '');
      const tgtParsed = parseHandleId(connection.targetHandle ?? '');
      if (!srcParsed || !tgtParsed) return false;

      // Prevent flow↔value cross-category connections
      if (srcParsed.category !== tgtParsed.category) return false;

      const currentEdges = edgesRef.current;

      // A reroute relays exactly ONE output, so its single input accepts at most
      // one incoming wire — for BOTH value and flow (flow inputs are otherwise
      // multi-occupancy, but a reroute is not a merge point: extra incoming wires
      // would be silently dropped at compile time). Reject a second incoming.
      const tgtNode = nodesRef.current.find(n => n.id === connection.target);
      if ((tgtNode?.data as Record<string, unknown> | undefined)?.nodeType === 'reroute') {
        const occupied = currentEdges.some(
          e => e.target === connection.target && e.targetHandle === connection.targetHandle,
        );
        if (occupied) return false;
      }

      // Prevent connecting to an already-connected value input (unless port is isArray).
      // Also enforce NeighborIndex type compatibility: a NI port may only connect to
      // another NI port or to an `any`-typed port. This is the only data-type rule
      // currently enforced by the connection validator (other types remain unchecked
      // for back-compat); it exists to prevent the silent list-position vs coord-idx
      // hazards that previously surfaced as wrong-cell lookups at runtime.
      if (tgtParsed.category === 'value') {
        const targetNode = nodesRef.current.find(n => n.id === connection.target);
        const targetNodeType = (targetNode?.data as Record<string, unknown> | undefined)?.nodeType as string | undefined;
        const targetDef = targetNodeType ? getNodeDef(targetNodeType) : undefined;
        const targetPort = targetDef?.ports.find(p => p.id === tgtParsed.portId);
        const isArrayPort = targetPort?.isArray;
        if (!isArrayPort) {
          const alreadyConnected = currentEdges.some(
            e => e.target === connection.target && e.targetHandle === connection.targetHandle,
          );
          if (alreadyConnected) return false;
        }

        // NeighborIndex compatibility check
        const sourceNode = nodesRef.current.find(n => n.id === connection.source);
        const sourceNodeType = (sourceNode?.data as Record<string, unknown> | undefined)?.nodeType as string | undefined;
        const sourceDef = sourceNodeType ? getNodeDef(sourceNodeType) : undefined;
        const sourcePort = sourceDef?.ports.find(p => p.id === srcParsed.portId);
        const tgtIsNI = targetPort?.dataType === 'neighborIndex';
        const srcIsNI = sourcePort?.dataType === 'neighborIndex';
        if (tgtIsNI && sourcePort && sourcePort.dataType !== 'neighborIndex' && sourcePort.dataType !== 'any') {
          return false;
        }
        if (srcIsNI && targetPort && targetPort.dataType !== 'neighborIndex' && targetPort.dataType !== 'any') {
          return false;
        }
      }

      // Prevent duplicate connections (same source+target+handles)
      const hasDuplicate = currentEdges.some(
        e => e.source === connection.source && e.sourceHandle === connection.sourceHandle
          && e.target === connection.target && e.targetHandle === connection.targetHandle,
      );
      if (hasDuplicate) return false;

      // Cycle detection: BFS from target to see if it can reach source
      const visited = new Set<string>();
      const queue = [connection.target!];
      while (queue.length > 0) {
        const nodeId = queue.shift()!;
        if (nodeId === connection.source) return false; // cycle!
        if (visited.has(nodeId)) continue;
        visited.add(nodeId);
        for (const e of currentEdges) {
          if (e.source === nodeId && !visited.has(e.target)) {
            queue.push(e.target);
          }
        }
      }

      return true;
    },
    [],
  );

  // --- Connection handler (no stealing — isValidConnection handles all checks) ---
  const onConnect = useCallback(
    (connection: Connection) => {
      pushCurrentSnapshot();
      setEdges(eds => addEdge(
        {
          ...connection,
          style: { stroke: (connection.sourceHandle?.includes('flow') ? '#66bb6a' : '#4cc9f0'), strokeWidth: 2 },
        },
        eds,
      ));
      scheduleSync();
    },
    [setEdges, scheduleSync],
  );

  const handleNodesChange = useCallback(
    (changes: Parameters<typeof onNodesChange>[0]) => {
      // Block deletion of MacroInput/MacroOutput boundary nodes inside macro scope
      if (currentScopeRef.current.length > 1) {
        changes = changes.filter(c => {
          if (c.type === 'remove') {
            const node = nodesRef.current.find(n => n.id === c.id);
            const nt = (node?.data as Record<string, unknown> | undefined)?.nodeType;
            return nt !== 'macroInput' && nt !== 'macroOutput';
          }
          return true;
        });
      }

      // When the user starts a gesture INSIDE a group body, strip any group
      // SELECT-true changes — they're acting on inner content, not the
      // group. Deselects pass through so resetSelectedElements at threshold
      // crossing can clear any prior group selection. Box-selects started on
      // the empty pane keep RF's default behaviour (groups intersecting the
      // rect are selected normally).
      if (boxFromGroupRef.current) {
        changes = changes.filter(c => {
          if (c.type !== 'select' || !c.selected) return true;
          const node = nodesRef.current.find(n => n.id === c.id);
          return node?.type !== 'groupNode';
        });
      }

      // Native pane box-select: getNodesInside force-includes nodes whose
      // handle bounds aren't measured (forceInitialRender), IGNORING the rect —
      // so e.g. nodes re-created by the model sync after a group drag (a
      // position-only change never re-measures them) get spuriously selected by
      // an unrelated empty-canvas box-select. Re-verify each box-selected node's
      // real on-screen rect against the box and FLIP phantom select-TRUEs to
      // select-FALSE. We flip rather than drop because RF's
      // getSelectionChanges(mutateItem=true) already pre-mutated the internal
      // lookup; emitting a real select:false overrides it with a fresh ref (see
      // the modifier-intercept CRITICAL note below). Mirrors the in-group path.
      const boxRect = paneBoxRectRef.current;
      if (boxRect && paneBoxDragRef.current && changes.some(c => c.type === 'select' && c.selected)) {
        const wrapper = editorWrapperRef.current;
        if (wrapper) {
          const left = Math.min(boxRect.x1, boxRect.x2);
          const right = Math.max(boxRect.x1, boxRect.x2);
          const top = Math.min(boxRect.y1, boxRect.y2);
          const bottom = Math.max(boxRect.y1, boxRect.y2);
          changes = changes.map(c => {
            if (c.type !== 'select' || !c.selected) return c;
            const el = wrapper.querySelector(`.react-flow__node[data-id="${CSS.escape(c.id)}"]`);
            const r = el?.getBoundingClientRect();
            const hit = !!r && !(r.right < left || r.left > right || r.bottom < top || r.top > bottom);
            return hit ? c : { ...c, selected: false };
          });
        }
      }

      // Box-select modifier intercept. When the user started the LMB-drag on
      // the pane with Shift or Ctrl/Meta held, React Flow's default behavior
      // ("replace selection with intersected") is rewritten to:
      //   - Shift → pre ∪ box  (add intersected to existing selection)
      //   - Ctrl  → pre \ box  (remove intersected from existing selection)
      // The intercept runs on every per-tick batch of select changes so the
      // visible selection during the drag already reflects the modifier (no
      // flicker of the pre-existing selection during the drag).
      //
      // CRITICAL: React Flow's `getSelectionChanges(..., mutateItem=true)`
      // mutates the internal `nodeLookup` BEFORE these changes are dispatched
      // — every node RF emits a change for has its `internalNode.selected`
      // pre-mutated. If we drop or override one of those changes without
      // emitting a NEW select change for the same id, `applyNodeChanges`
      // won't create a new user-node reference for that id, and the next
      // `adoptUserNodes` pass will preserve the corrupted (mutated) internal
      // entry via its `checkEquality` shortcut. The visible state (from the
      // user-prop nodes) and the lookup (used by node drag, NodesSelection,
      // arrow-key move, etc.) drift apart, and only the most recently
      // touched nodes actually move on a subsequent drag. So we ALWAYS
      // emit a fresh select change for every id RF touched, with our
      // desired final value — guarantees a new ref → forced rebuild.
      if (boxSelectActiveRef.current && changes.some(c => c.type === 'select')) {
        const mode = boxSelectModeRef.current;
        const preSelected = preBoxSelectionRef.current;
        // boxSet = nodes RF wants selected after this tick's changes apply.
        // Compute by starting from the pre-tick state (nodesRef, which is
        // still on the previous render's data) and overlaying the changes.
        const boxSet = new Set<string>();
        for (const n of nodesRef.current) if (n.selected) boxSet.add(n.id);
        const touchedIds = new Set<string>();
        for (const c of changes) {
          if (c.type !== 'select') continue;
          touchedIds.add(c.id);
          if (c.selected) boxSet.add(c.id);
          else boxSet.delete(c.id);
        }
        // Desired final selection per mode.
        const finalSet = new Set<string>();
        if (mode === 'add') {
          preSelected.forEach(id => finalSet.add(id));
          boxSet.forEach(id => finalSet.add(id));
        } else if (mode === 'remove') {
          preSelected.forEach(id => { if (!boxSet.has(id)) finalSet.add(id); });
        }
        const nonSelect = changes.filter(c => c.type !== 'select');
        const newSelect: typeof changes = [];
        // (1) For every id RF touched, emit a select with our desired value
        //     even if it matches RF's value or the previous state — see the
        //     CRITICAL comment above. The new ref guarantees a clean rebuild.
        touchedIds.forEach(id => {
          newSelect.push({ type: 'select', id, selected: finalSet.has(id) });
        });
        // (2) For ids RF did NOT touch but where our desired state differs
        //     from the pre-tick state, emit our own select change. RF didn't
        //     mutate the lookup for these, so a normal diff is sufficient.
        for (const n of nodesRef.current) {
          if (touchedIds.has(n.id)) continue;
          const desired = finalSet.has(n.id);
          if (!!n.selected !== desired) {
            newSelect.push({ type: 'select', id: n.id, selected: desired });
          }
        }
        changes = [...nonSelect, ...newSelect];
      }

      // Ctrl-held alignment snap (PowerPoint-style). Runs BEFORE the group-drag
      // intercept so a snapped group position propagates to its members, and
      // overrides the 20px grid snap on whichever axis it engages. Anchors on
      // the UNION bbox of the moving node(s), so dragging a multi-selection
      // aligns the selection's outer edges/centers to nearby static nodes.
      if (ctrlHeldRef.current) {
        type PosChange = { type: 'position'; id: string; position: { x: number; y: number }; dragging?: boolean };
        const posChanges = changes.filter(
          c => c.type === 'position' && (c as PosChange).position,
        ) as PosChange[];
        const isDrag = posChanges.some(c => c.dragging === true);
        const isDragEnd = posChanges.some(c => c.dragging === false);
        if (posChanges.length > 0 && (isDrag || isDragEnd)) {
          const movingIds = new Set(posChanges.map(c => c.id));
          // Union bbox of the moving node(s) at their NEW (already-grid-snapped) positions.
          let uMinX = Infinity, uMinY = Infinity, uMaxX = -Infinity, uMaxY = -Infinity;
          for (const c of posChanges) {
            const n = nodesRef.current.find(nn => nn.id === c.id);
            const { w, h } = n ? nodeSize(n) : { w: 200, h: 100 };
            if (c.position.x < uMinX) uMinX = c.position.x;
            if (c.position.y < uMinY) uMinY = c.position.y;
            if (c.position.x + w > uMaxX) uMaxX = c.position.x + w;
            if (c.position.y + h > uMaxY) uMaxY = c.position.y + h;
          }
          if (uMinX !== Infinity) {
            const zoom = rfInstance.current?.getViewport().zoom ?? 1;
            const thr = ALIGN_SNAP_PX / Math.max(zoom, 0.05); // screen px → flow units
            // During a group drag the members translate WITH the group but
            // aren't in this tick's `movingIds` yet (the group-drag intercept
            // injects their changes below). Exclude them so the group can't
            // snap its edges to a child that's moving along with it.
            const groupMemberIds = groupDragRef.current
              ? new Set(groupDragRef.current.members.map(m => m.id))
              : null;
            const targets: AlignTarget[] = [];
            for (const n of nodesRef.current) {
              if (movingIds.has(n.id) || n.type === 'rerouteNode' || groupMemberIds?.has(n.id)) continue;
              const { w, h } = nodeSize(n);
              targets.push({ x: n.position.x, y: n.position.y, w, h });
            }
            const { dx, dy, guides } = computeAlignmentSnap(
              { minX: uMinX, minY: uMinY, maxX: uMaxX, maxY: uMaxY },
              targets,
              thr,
            );
            if (dx !== 0 || dy !== 0) {
              changes = changes.map(c =>
                c.type === 'position' && (c as PosChange).position && movingIds.has(c.id)
                  ? { ...c, position: { x: (c as PosChange).position.x + dx, y: (c as PosChange).position.y + dy } }
                  : c,
              ) as typeof changes;
            }
            if (isDrag && !sameGuides(alignGuidesRef.current, guides)) {
              alignGuidesRef.current = guides;
              setAlignGuides(guides);
            }
          }
        }
        if (isDragEnd) clearAlignGuides();
      }

      // Group drag intercept: when a group is being dragged, translate every
      // node whose center was inside the group's rect at drag-start by the
      // same per-tick delta. Membership is frozen for the drag duration so
      // nodes outside the rect at drag-start don't get sucked in mid-drag.
      const dragState = groupDragRef.current;
      if (dragState) {
        const groupChange = changes.find(
          c => c.type === 'position' && c.id === dragState.groupId && c.position,
        ) as { type: 'position'; id: string; position: { x: number; y: number } } | undefined;
        if (groupChange) {
          // Compute total delta from drag-start, NOT per-tick delta. nodesRef is
          // updated by a useEffect that fires after re-render, so during fast
          // pointer-move bursts it lags behind by one tick. Using
          // `member.start + totalDelta` (instead of `nodesRef.position + dx`)
          // makes each tick self-correcting against a stable reference and
          // keeps inner nodes locked to the group regardless of render timing.
          let totalDx = groupChange.position.x - dragState.startPos.x;
          let totalDy = groupChange.position.y - dragState.startPos.y;
          // Skip grid rounding while Ctrl alignment is engaged — the group's
          // position change was already alignment-snapped above, and members
          // must follow that exact (off-grid) delta.
          if (snapEnabled && !ctrlHeldRef.current) {
            totalDx = Math.round(totalDx / 20) * 20;
            totalDy = Math.round(totalDy / 20) * 20;
          }
          if (totalDx !== dragState.snapAccum.x || totalDy !== dragState.snapAccum.y) {
            dragState.snapAccum = { x: totalDx, y: totalDy };
            const alreadyMoving = new Set<string>();
            for (const c of changes) {
              if (c.type === 'position' && c.position) alreadyMoving.add(c.id);
            }
            const extra = dragState.members
              .filter(m => !alreadyMoving.has(m.id))
              .map(m => ({
                type: 'position' as const,
                id: m.id,
                position: { x: m.startX + totalDx, y: m.startY + totalDy },
                dragging: true,
              }));
            if (extra.length > 0) changes = [...changes, ...extra];
          }
        }
      }

      // Push undo snapshot for significant changes (before applying)
      const hasPositionEndChange = changes.some(
        c => c.type === 'position' && 'dragging' in c && !c.dragging,
      );
      const hasRemove = changes.some(c => c.type === 'remove');
      if (hasPositionEndChange || hasRemove) {
        pushCurrentSnapshot();
      }

      onNodesChange(changes);

      const needsSync = changes.some(
        c => c.type === 'remove' ||
             (c.type === 'position' && 'dragging' in c && !c.dragging) ||
             c.type === 'dimensions' ||
             c.type === 'replace',
      );
      if (needsSync) scheduleSync();
    },
    [onNodesChange, scheduleSync, snapEnabled, clearAlignGuides],
  );

  const handleEdgesChange = useCallback(
    (changes: Parameters<typeof onEdgesChange>[0]) => {
      // Box-select is nodes-only. During a pane-initiated LMB drag, React
      // Flow's box-select pointermove also generates select changes for every
      // edge connected to a boxed node (see @xyflow/react: it iterates the
      // connectionLookup and unions edges into `selectedEdgeIds`). The
      // semantics are awkward — an edge has two endpoints and there's no
      // sensible answer to "is the edge selected when only one end is" — so
      // we drop edge select changes for the duration of the pane drag.
      // Direct edge interactions (click, double-click) are unaffected because
      // their pointerdown lands on the edge, not the pane.
      if (paneBoxDragRef.current) {
        changes = changes.filter(c => c.type !== 'select');
      }
      if (changes.some(c => c.type === 'remove')) pushCurrentSnapshot();
      onEdgesChange(changes);
      if (changes.some(c => c.type === 'remove')) scheduleSync();
    },
    [onEdgesChange, scheduleSync, pushCurrentSnapshot],
  );

  // Group drag: snapshot contained nodes at drag-start so the handleNodesChange
  // intercept can translate them in lock-step with the group. Membership is
  // frozen for the drag duration — nodes whose center wasn't inside the rect
  // at drag-start won't be picked up mid-drag.
  const onNodeDragStart = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (node.type !== 'groupNode') return;
      const { w, h } = nodeSize(node);
      const rect = {
        x1: node.position.x,
        y1: node.position.y,
        x2: node.position.x + w,
        y2: node.position.y + h,
      };
      const members: Array<{ id: string; startX: number; startY: number }> = [];
      for (const n of nodesRef.current) {
        if (n.id === node.id) continue;
        // Include nested group nodes too: a smaller group whose center sits
        // inside this group's rect should translate with it. Its own children
        // are collected independently (their centers are inside this rect as
        // well), so arbitrarily-deep nesting moves in lock-step without
        // recursion. Membership stays purely geometric — groups have no
        // parentId — matching how caNodes are already gathered.
        const c = nodeCenter(n);
        if (c.x > rect.x1 && c.x < rect.x2 && c.y > rect.y1 && c.y < rect.y2) {
          members.push({ id: n.id, startX: n.position.x, startY: n.position.y });
        }
      }
      groupDragRef.current = {
        groupId: node.id,
        startPos: { x: node.position.x, y: node.position.y },
        snapAccum: { x: 0, y: 0 },
        members,
      };
      // Snapshot covers both group AND contained nodes so undo restores
      // everything in one step.
      pushCurrentSnapshot();
    },
    [],
  );

  const onNodeDragStop = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (groupDragRef.current?.groupId === node.id) {
        groupDragRef.current = null;
      }
      clearAlignGuides();
    },
    [clearAlignGuides],
  );

  // --- Unified context menu ---
  // Compute the "logical" selection at menu-open time. The capture-phase
  // mousedown listener (see effect above) has already stashed the pre-RMB
  // selection into preSelectionRef BEFORE React Flow had a chance to collapse
  // it. Prefer that ref when it indicates a multi-selection containing the
  // right-clicked node; otherwise fall back to React Flow's live state.
  const resolveSelectionForMenu = useCallback(
    (rfSelected: Node[], nodeId: string | undefined): Node[] => {
      const pre = preSelectionRef.current;
      if (pre.length >= 2) {
        // RMB happened on or near a multi-selection. If a specific node was
        // clicked, only honour the snapshot when that node was part of it —
        // RMB on a node outside the selection should still target that node.
        if (!nodeId || pre.includes(nodeId)) {
          const map = new Map(nodesRef.current.map(n => [n.id, n]));
          const resolved = pre.map(id => map.get(id)).filter((n): n is Node => !!n);
          if (resolved.length >= 2) return resolved;
        }
      }
      return rfSelected;
    },
    [],
  );

  const openContextMenu = useCallback(
    (event: MouseEvent | React.MouseEvent, nodeId?: string) => {
      event.preventDefault();
      const bounds = (event.target as HTMLElement).closest('.react-flow')?.getBoundingClientRect();
      const rf = rfInstance.current;
      if (!bounds || !rf) return;
      const position = rf.screenToFlowPosition({ x: event.clientX, y: event.clientY });

      const selectedNodes = resolveSelectionForMenu(
        getNodes().filter(n => n.selected),
        nodeId,
      );

      let target: ContextMenuState['target'];

      if (nodeId) {
        // Right-clicked on a specific node
        if (selectedNodes.length >= 2 && selectedNodes.some(n => n.id === nodeId)) {
          // Node is part of a multi-selection
          target = { type: 'selection', nodeIds: selectedNodes.map(n => n.id) };
        } else {
          const node = getNodes().find(n => n.id === nodeId);
          const nodeData = node?.data as Record<string, unknown> | undefined;
          target = {
            type: 'node',
            nodeId,
            nodeType: (nodeData?.nodeType as string) || node?.type || '',
            isMacro: (nodeData?.nodeType as string) === 'macro',
            isGroup: node?.type === 'groupNode',
          };
        }
      } else if (selectedNodes.length >= 2) {
        // Right-clicked on pane with multi-selection active
        target = { type: 'selection', nodeIds: selectedNodes.map(n => n.id) };
      } else {
        target = { type: 'pane' };
      }

      pasteFlowPos.current = { x: position.x, y: position.y };
      setContextMenu({
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
        flowX: position.x,
        flowY: position.y,
        target,
      });
    },
    [getNodes, resolveSelectionForMenu],
  );

  const onPaneContextMenu = useCallback(
    (event: MouseEvent | React.MouseEvent) => openContextMenu(event),
    [openContextMenu],
  );

  const onNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: Node) => {
      event.stopPropagation();
      // Group nodes: RMB on the header strip opens the group menu; RMB anywhere
      // in the body opens the regular pane menu (Add Node / Comment / Group /
      // Macro / Paste …) so the user can build the graph while working inside a
      // group. The header is the only `[data-drag-handle]` within the group DOM.
      if (
        node.type === 'groupNode' &&
        !(event.target as HTMLElement).closest('[data-drag-handle="true"]')
      ) {
        openContextMenu(event);
        return;
      }
      // If React Flow's internal mousedown collapsed the multi-selection by
      // the time contextmenu fires, re-assert it from preSelectionRef so the
      // outline redraws on every previously-selected node and the menu uses
      // the same logical target. The preSelectionRef snapshot was taken in
      // the capture-phase mousedown listener BEFORE RF could modify state.
      const pre = preSelectionRef.current;
      if (pre.length >= 2 && pre.includes(node.id)) {
        const keep = new Set(pre);
        setNodes(nds => nds.map(n => (keep.has(n.id)
          ? (n.selected ? n : { ...n, selected: true })
          : (n.selected ? { ...n, selected: false } : n))));
      }
      openContextMenu(event, node.id);
    },
    [openContextMenu, setNodes],
  );

  // --- Clamp context menu to viewport bounds + submenu direction ---
  useLayoutEffect(() => {
    if (!contextMenu || !contextMenuRef.current) { setMenuPos(null); return; }
    const el = contextMenuRef.current;
    const parent = el.parentElement;
    if (!parent) return;
    const pw = parent.clientWidth;
    const ph = parent.clientHeight;
    const mw = el.offsetWidth;
    const mh = el.offsetHeight;
    let x = contextMenu.x;
    let y = contextMenu.y;
    if (x + mw > pw) x = Math.max(0, pw - mw - 4);
    if (y + mh > ph) y = Math.max(0, ph - mh - 4);
    // Signal submenu to flip direction if main menu is near edge
    const submenuWidth = 190; // min-width + border
    if (x + mw + submenuWidth > pw) {
      el.setAttribute('data-submenu-left', '');
    } else {
      el.removeAttribute('data-submenu-left');
    }
    if (y + 400 > ph) { // 400 = submenu max-height
      el.setAttribute('data-submenu-up', '');
    } else {
      el.removeAttribute('data-submenu-up');
    }
    setMenuPos({ x, y });
  }, [contextMenu]);

  // --- Context menu actions ---

  /** Core helper: insert a new node of `nodeType` at the given flow position.
   *  Config overrides are merged with the node type's defaultConfig.
   *  Optional `label` is shown above the header (matches the userLabel pattern used by
   *  Create-Macro-from-Selection). Returns the new node id, or null if blocked
   *  (e.g., Step singleton). Callers that only care about success/failure can
   *  treat any truthy return as success.
   *  Shared between the "Add Node" context menu and palette drag-drop. */
  const addNodeAtPosition = useCallback(
    (
      nodeType: string,
      position: { x: number; y: number },
      configOverrides?: Record<string, string | number | boolean>,
      label?: string,
    ): string | null => {
      const def = getNodeDef(nodeType);
      if (!def) return null;
      // Singleton: only one Step node allowed
      if (nodeType === 'step') {
        const hasStep = nodesRef.current.some(
          n => (n.data as Record<string, unknown>)?.nodeType === 'step',
        );
        if (hasStep) return null;
      }
      // Singleton: only one Init Event node allowed (mirrors Step semantics).
      if (nodeType === 'initEvent') {
        const hasInit = nodesRef.current.some(
          n => (n.data as Record<string, unknown>)?.nodeType === 'initEvent',
        );
        if (hasInit) return null;
      }
      pushCurrentSnapshot();
      const newId = generateNodeId(nodesRef.current);
      // Seed _port_<id> with each inline-widget port's defaultValue so the
      // collapsed-node title renders the correct default from t=0 (instead of
      // the hardcoded '0' fallback in CaNode.tsx). Compiler's getInlineValue
      // already falls back to port.defaultValue, so this is display-only —
      // but it also makes .gcaproj files self-contained.
      const seededConfig: Record<string, string | number | boolean> = { ...def.defaultConfig };
      for (const port of def.ports) {
        if (port.inlineWidget && port.defaultValue !== undefined) {
          const key = `_port_${port.id}`;
          if (seededConfig[key] === undefined) seededConfig[key] = port.defaultValue;
        }
      }
      const data: Record<string, unknown> = {
        nodeType: def.type,
        config: { ...seededConfig, ...(configOverrides || {}) },
      };
      if (label) data.label = label;
      const newNode: Node = {
        id: newId,
        type: 'caNode',
        position,
        data,
      };
      setNodes(nds => [...nds, newNode]);
      scheduleSync();
      return newId;
    },
    [setNodes, scheduleSync],
  );

  /** Create a node / macro instance from a palette payload at a flow position.
   *  Shared by the palette drag-drop path (onPaletteDrop) and the Spacebar
   *  quick-add path (registered as the quickAddApi in graphState). */
  const spawnPalettePayload = useCallback(
    (payload: QuickAddPayload, pos: { x: number; y: number }) => {
      if (payload.kind === 'node' && typeof payload.nodeType === 'string') {
        addNodeAtPosition(payload.nodeType, pos);
      } else if (payload.kind === 'macro-project' && typeof payload.macroDefId === 'string') {
        const def = (model.macroDefs || []).find(m => m.id === payload.macroDefId);
        addNodeAtPosition('macro', pos, { macroDefId: payload.macroDefId }, def?.name);
      } else if (payload.kind === 'macro-default' && typeof payload.file === 'string') {
        // Default macros ship as static .gcamacro files — fetch, then import a
        // fresh-id clone into the model before instancing.
        const base = (import.meta.env.BASE_URL || '/');
        const file = payload.file;
        fetch(`${base}macros/${file}`)
          .then(r => (r.ok ? r.json() : null))
          .then(parsed => {
            if (!parsed?.macroDef) return;
            const newId = importMacro(parsed.macroDef);
            addNodeAtPosition('macro', pos, { macroDefId: newId }, parsed.macroDef.name);
          })
          .catch(() => { /* swallow — network/parse failure */ });
      }
    },
    [addNodeAtPosition, importMacro, model.macroDefs],
  );

  // Register the Spacebar quick-add API (consumed by ModelerView + Palette).
  useEffect(() => {
    setQuickAddApi({
      getCursorFlowPos: () => {
        if (lastFlowMousePos.current) return lastFlowMousePos.current;
        const rect = editorWrapperRef.current?.getBoundingClientRect();
        const centre = rect
          ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
          : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
        return rfInstance.current?.screenToFlowPosition(centre) ?? { x: 0, y: 0 };
      },
      addFromPalette: (payload, pos) => spawnPalettePayload(payload, pos),
      // Spacebar: open the unified quick-add menu (options + focused search +
      // node list) at the cursor — same menu as a blank-canvas right-click.
      openQuickAddMenu: () => {
        const rf = rfInstance.current;
        const bounds = editorWrapperRef.current?.getBoundingClientRect();
        if (!rf || !bounds) return;
        const client = lastClientMousePos.current ?? {
          x: bounds.left + bounds.width / 2,
          y: bounds.top + bounds.height / 2,
        };
        const flow = rf.screenToFlowPosition(client);
        setContextMenu({
          x: client.x - bounds.left,
          y: client.y - bounds.top,
          flowX: flow.x,
          flowY: flow.y,
          target: { type: 'pane' },
        });
      },
    });
    return () => setQuickAddApi(null);
  }, [spawnPalettePayload]);

  /** Create a new node AND an edge connecting it to the connection-drop origin.
   *  Used by the connection-drop context menu (drag a link onto empty canvas →
   *  pick a node → spawn + auto-wire). */
  const addNodeAndConnect = useCallback(
    (
      nodeType: string,
      position: { x: number; y: number },
      origin: ConnectionOrigin,
      configOverrides?: Record<string, string | number | boolean>,
    ): string | null => {
      const def = getNodeDef(nodeType);
      if (!def) return null;
      if (nodeType === 'step') {
        const hasStep = nodesRef.current.some(
          n => (n.data as Record<string, unknown>)?.nodeType === 'step',
        );
        if (hasStep) return null;
      }
      if (nodeType === 'initEvent') {
        const hasInit = nodesRef.current.some(
          n => (n.data as Record<string, unknown>)?.nodeType === 'initEvent',
        );
        if (hasInit) return null;
      }
      // Resolved config drives effective ports for nodes whose port set depends
      // on config (e.g., GetModelAttribute r/g/b vs value via isColorAttr).
      const resolvedCfg: Record<string, unknown> = { ...def.defaultConfig, ...(configOverrides ?? {}) };
      // A node can be offered as compatible because SOME configuration exposes a
      // matching port (e.g. Get Random's Options input only exists in 'options'
      // mode) while its DEFAULT config hides it. Don't silently refuse the click
      // in that case — add the node unwired and let the user configure it.
      const targetPort = pickCompatiblePort(def, origin, resolvedCfg);
      pushCurrentSnapshot();
      const newId = generateNodeId(nodesRef.current);
      const seededConfig: Record<string, string | number | boolean> = { ...def.defaultConfig };
      for (const port of def.ports) {
        if (port.inlineWidget && port.defaultValue !== undefined) {
          const key = `_port_${port.id}`;
          if (seededConfig[key] === undefined) seededConfig[key] = port.defaultValue;
        }
      }
      const data: Record<string, unknown> = {
        nodeType: def.type,
        config: { ...seededConfig, ...(configOverrides || {}) },
      };
      const newNode: Node = { id: newId, type: 'caNode', position, data };
      setNodes(nds => [...nds, newNode]);

      if (!targetPort) {
        // No port compatible under the default config — node added without a wire.
        scheduleSync();
        return newId;
      }

      // Build the edge. origin.kind tells us which side the drag started from:
      // - kind === 'output': origin is the SOURCE, new node's port is the TARGET (input).
      // - kind === 'input':  new node's port is the SOURCE (output), origin is the TARGET.
      const sourceNodeId = origin.kind === 'output' ? origin.nodeId : newId;
      const targetNodeId = origin.kind === 'output' ? newId : origin.nodeId;
      const sourcePortId = origin.kind === 'output' ? origin.portId : targetPort.id;
      const targetPortId = origin.kind === 'output' ? targetPort.id : origin.portId;
      const sourceHandle = handleId({ id: sourcePortId, kind: 'output', category: origin.category });
      const targetHandle = handleId({ id: targetPortId, kind: 'input', category: origin.category });
      const edgeId = `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
      const newEdge: Edge = {
        id: edgeId,
        source: sourceNodeId,
        target: targetNodeId,
        sourceHandle,
        targetHandle,
        style: { stroke: origin.category === 'flow' ? '#66bb6a' : '#4cc9f0', strokeWidth: 2 },
      };
      // When the drag started FROM a single-connection value input that already
      // holds a wire, the new node's output must REPLACE it — a non-array value
      // input accepts only one connection (the limit isValidConnection enforces
      // for direct drops). This path bypasses isValidConnection (it builds the
      // edge directly), so strip any existing wire into the same target handle
      // first; otherwise the recommended-nodes menu silently double-connects.
      const replacingSingleInput =
        origin.kind === 'input' && origin.category === 'value' && !origin.isArray;
      setEdges(eds => addEdge(
        newEdge,
        replacingSingleInput
          ? eds.filter(e => !(e.target === targetNodeId && e.targetHandle === targetHandle))
          : eds,
      ));
      scheduleSync();
      return newId;
    },
    [setNodes, setEdges, scheduleSync],
  );

  // --- Reroute relay points -------------------------------------------------
  // A reroute is an editor-only dot on a wire (collapsed away at compile time,
  // see rerouteCollapse.ts). It always relays an OUTPUT, so it has one input
  // (the relayed wire) and any number of outputs. Built typed from the wire it
  // sits on; it's a normal draggable node (moves alone and within a multi-
  // selection). The press-and-hold gesture only CREATES one on a wire.

  const edgeStrokeFor = (category: 'flow' | 'value') =>
    category === 'flow' ? '#66bb6a' : '#4cc9f0';

  /** Move a reroute node to a flow-space position (used during the hold-drag). */
  const moveRerouteTo = useCallback((id: string, pos: { x: number; y: number }) => {
    setNodes(nds => nds.map(n => (n.id === id ? { ...n, position: { x: pos.x, y: pos.y } } : n)));
  }, [setNodes]);

  /** Build a fresh reroute RF node typed for the given wire category. */
  const makeRerouteNode = useCallback(
    (category: 'flow' | 'value', dataType: string | undefined, pos: { x: number; y: number }): Node => ({
      id: generateNodeId(nodesRef.current),
      type: 'rerouteNode',
      position: { x: pos.x, y: pos.y },
      data: { nodeType: 'reroute', portCategory: category, ...(dataType ? { dataType } : {}), config: {} },
      selected: true,
    }),
    [],
  );

  /** Split an existing edge by inserting a reroute at `pos`. Returns the new
   *  reroute id (for the hold-drag to grab), or null if the edge is gone. The
   *  reroute relays the edge's source output, so chains form naturally when the
   *  split edge's source is itself a reroute. */
  const insertRerouteOnEdge = useCallback(
    (edgeId: string, pos: { x: number; y: number }): string | null => {
      const edge = edgesRef.current.find(e => e.id === edgeId);
      if (!edge || !edge.sourceHandle || !edge.targetHandle) return null;
      const sh = parseHandleId(edge.sourceHandle);
      if (!sh) return null;
      const category = sh.category;
      const srcNode = nodesRef.current.find(n => n.id === edge.source);
      const dataType = srcNode ? getOriginPortInfo(srcNode, sh.portId)?.dataType : undefined;
      const reroute = makeRerouteNode(category, dataType, pos);
      const ts = Date.now().toString(36);
      const rnd = () => Math.random().toString(36).slice(2, 5);
      const inEdge: Edge = {
        id: `e_${ts}_ri_${rnd()}`,
        source: edge.source,
        target: reroute.id,
        sourceHandle: edge.sourceHandle,
        targetHandle: handleId({ id: 'in', kind: 'input', category }),
        style: { stroke: edgeStrokeFor(category), strokeWidth: 2 },
      };
      const outEdge: Edge = {
        id: `e_${ts}_ro_${rnd()}`,
        source: reroute.id,
        target: edge.target,
        sourceHandle: handleId({ id: 'out', kind: 'output', category }),
        targetHandle: edge.targetHandle,
        style: { stroke: edgeStrokeFor(category), strokeWidth: 2 },
      };
      // A freshly created reroute becomes the SOLE selection: deselect every
      // other node (and edge) so the reposition drag that immediately follows the
      // press-and-hold moves ONLY the reroute — not whatever the user happened to
      // have selected before starting the gesture (which pressing on a wire does
      // not otherwise clear).
      setNodes(nds => [...nds.map(n => (n.selected ? { ...n, selected: false } : n)), reroute]);
      setEdges(eds => [
        ...eds.filter(e => e.id !== edgeId).map(e => (e.selected ? { ...e, selected: false } : e)),
        inEdge,
        outEdge,
      ]);
      return reroute.id;
    },
    [makeRerouteNode, setNodes, setEdges],
  );

  /** Create a reroute from a connection-drop origin (drag a wire off an OUTPUT
   *  port, release on empty canvas, pick "Reroute"). Wires origin.out → R.in;
   *  the user continues wiring from R.out. */
  const addRerouteAndConnect = useCallback(
    (origin: ConnectionOrigin, pos: { x: number; y: number }) => {
      if (origin.kind !== 'output') return; // reroutes relay outputs only
      pushCurrentSnapshot();
      const category = origin.category;
      const reroute = makeRerouteNode(category, origin.dataType, pos);
      const newEdge: Edge = {
        id: `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
        source: origin.nodeId,
        target: reroute.id,
        sourceHandle: handleId({ id: origin.portId, kind: 'output', category }),
        targetHandle: handleId({ id: 'in', kind: 'input', category }),
        style: { stroke: edgeStrokeFor(category), strokeWidth: 2 },
      };
      // Freshly created reroute is the sole selection (see insertRerouteOnEdge).
      setNodes(nds => [...nds.map(n => (n.selected ? { ...n, selected: false } : n)), reroute]);
      setEdges(eds => addEdge(newEdge, eds));
      scheduleSync();
    },
    [makeRerouteNode, pushCurrentSnapshot, scheduleSync, setNodes, setEdges],
  );

  // Press-and-hold gesture to CREATE a reroute on a wire: LMB-press on a wire and
  // hold ~0.55s to drop a reroute that then follows the cursor until release
  // (splitting the wire). A quick click / drag below the hold threshold is left
  // untouched, so wire double-click-delete, edge selection, and RMB-pan all keep
  // working. Repositioning an EXISTING reroute is just a normal node drag (the
  // node is draggable), so it also moves as part of a multi-selection — the
  // gesture deliberately only targets edges, never reroute nodes. Mirrors the
  // capture-phase pattern of the RMB-through-edges handler above.
  useEffect(() => {
    const wrapper = editorWrapperRef.current;
    if (!wrapper) return;
    const HOLD_MS = 550;
    const MOVE_TOL = 6; // px; movement beyond this before the hold fires cancels

    type Gesture = {
      phase: 'holding' | 'dragging';
      edgeId: string;           // the wire being split
      rerouteId: string | null; // the reroute created once the hold fires
      startX: number; startY: number;
      timer: number;
    };
    let g: Gesture | null = null;

    const toFlow = (cx: number, cy: number) => rfInstance.current?.screenToFlowPosition({ x: cx, y: cy }) ?? null;

    function teardownListeners() {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
    }
    function cancel() {
      if (g) window.clearTimeout(g.timer);
      g = null;
      teardownListeners();
    }
    function fire(cx: number, cy: number) {
      if (!g) return;
      const flow = toFlow(cx, cy);
      if (!flow) { cancel(); return; }
      pushCurrentSnapshot(); // so undo restores the un-split wire
      const newId = insertRerouteOnEdge(g.edgeId, flow);
      if (!newId) { cancel(); return; }
      g.rerouteId = newId;
      g.phase = 'dragging';
      moveRerouteTo(newId, flow);
    }
    function onMove(e: PointerEvent) {
      if (!g) return;
      if (g.phase === 'holding') {
        const dx = e.clientX - g.startX, dy = e.clientY - g.startY;
        if (dx * dx + dy * dy > MOVE_TOL * MOVE_TOL) cancel();
        return;
      }
      // dragging — isolate from React Flow and move the reroute
      e.preventDefault();
      e.stopPropagation();
      const flow = toFlow(e.clientX, e.clientY);
      if (flow && g.rerouteId) moveRerouteTo(g.rerouteId, flow);
    }
    function onUp(e: PointerEvent) {
      if (!g) return;
      if (g.phase === 'dragging') {
        e.preventDefault();
        e.stopPropagation();
        scheduleSync();
      }
      cancel();
    }
    function onDown(e: PointerEvent) {
      if (e.button !== 0 || g) return; // LMB only; ignore re-entrancy
      const target = e.target as Element | null;
      if (!target) return;
      // Only wires trigger create-on-hold. Existing reroutes use normal node drag,
      // so we never intercept them here (that's what lets a selection carry them).
      const edgeEl = target.closest('.react-flow__edge');
      if (!edgeEl) return;
      const edgeId = edgeEl.getAttribute('data-id');
      if (!edgeId) return;
      g = {
        phase: 'holding',
        edgeId,
        rerouteId: null,
        startX: e.clientX,
        startY: e.clientY,
        timer: window.setTimeout(() => fire(e.clientX, e.clientY), HOLD_MS),
      };
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('pointercancel', onUp, true);
      // No stopPropagation here: let React Flow handle selection during the hold.
    }
    wrapper.addEventListener('pointerdown', onDown, true);
    return () => { wrapper.removeEventListener('pointerdown', onDown, true); cancel(); };
  }, [pushCurrentSnapshot, scheduleSync, moveRerouteTo, insertRerouteOnEdge]);

  /** After a snap-to-port node has been added, schedule a one-shot
   *  `requestAnimationFrame` that measures the actual port positions in the
   *  DOM (the heuristic estimate may have been a few px off vertically or
   *  horizontally, e.g. when the new node has unusual port layout / non-
   *  standard width) and applies a precise correction to the node's position.
   *  Visually this typically arrives within one frame of the spawn so the
   *  user sees an aligned wire from the start. */
  const scheduleSnapRefinement = useCallback(
    (newNodeId: string, snap: ConnectionOrigin, matchPort: PortDef) => {
      requestAnimationFrame(() => {
        const targetScreen = getPortScreenCentre(snap.nodeId, snap.portId, snap.kind, snap.category);
        const newPortScreen = getPortScreenCentre(
          newNodeId,
          matchPort.id,
          matchPort.kind,
          matchPort.category,
        );
        if (!targetScreen || !newPortScreen) return;
        const screenToFlow = (p: { x: number; y: number }) =>
          rfInstance.current?.screenToFlowPosition(p) ?? p;
        // Desired SCREEN position of the new node's port: a small gap from
        // the target port on the correct side, same vertical y.
        const gapScreen = SNAP_GAP_FLOW; // ~px at zoom=1; close enough at other zooms
        const desiredX = snap.kind === 'input'
          ? targetScreen.x - gapScreen
          : targetScreen.x + gapScreen;
        const desiredY = targetScreen.y;
        // Convert both the desired-port-position and the actual-port-position
        // to flow coords, take the delta, and apply it to the node's current
        // flow position. This avoids having to know the node's top-left
        // relative to its measured rect (which depends on RF transforms).
        const desiredFlow = screenToFlow({ x: desiredX, y: desiredY });
        const actualFlow = screenToFlow(newPortScreen);
        const dx = desiredFlow.x - actualFlow.x;
        const dy = desiredFlow.y - actualFlow.y;
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
        setNodes(nds => nds.map(n =>
          n.id === newNodeId
            ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } }
            : n,
        ));
        scheduleSync();
      });
    },
    [setNodes, scheduleSync],
  );

  // --- Palette drag-drop handlers ---

  const onPaletteDragOver = useCallback((e: React.DragEvent) => {
    const types = e.dataTransfer.types;
    if (!types.includes('application/genesisca-palette') && !types.includes(MODEL_ELEMENT_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const onPaletteDrop = useCallback((e: React.DragEvent) => {
    // Model element drag (Attributes/Neighborhoods/Mappings/Indicators panels)
    // takes priority — opens a categorized context menu of related nodes.
    const elemRaw = e.dataTransfer.getData(MODEL_ELEMENT_DRAG_MIME);
    if (elemRaw) {
      e.preventDefault();
      let payload: ModelElementDragPayload | null = null;
      try { payload = JSON.parse(elemRaw) as ModelElementDragPayload; } catch { /* swallow */ }
      if (!payload) {
        setCurrentModelElementDrag(null);
        return;
      }
      const flowPos = rfInstance.current?.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      if (!flowPos) {
        setCurrentModelElementDrag(null);
        return;
      }
      const bounds = (e.currentTarget as HTMLElement).getBoundingClientRect();
      pasteFlowPos.current = { x: flowPos.x, y: flowPos.y };
      // Snap-to-port: if the drop landed within the snap radius of any
      // currently-highlighted handle, capture it so the menu can filter to
      // nodes that can auto-connect there.
      const snapTarget = findNearestCompatibleHandle(
        compatibleHandlesForDrag,
        e.clientX, e.clientY,
        PANEL_DRAG_SNAP_RADIUS_PX,
      );
      let snapToPort: ConnectionOrigin | undefined;
      if (snapTarget) {
        // Resolve dataType + isArray by looking up the live node's effective ports.
        const node = nodesRef.current.find(n => n.id === snapTarget.nodeId);
        const nd = node?.data as { nodeType?: string; config?: Record<string, unknown> } | undefined;
        if (nd?.nodeType) {
          const eff = getEffectivePorts(nd.nodeType, nd.config ?? {});
          const port = [...eff.inputs, ...eff.outputs].find(p => p.id === snapTarget.portId && p.kind === snapTarget.kind && p.category === snapTarget.category);
          if (port) {
            snapToPort = {
              nodeId: snapTarget.nodeId,
              portId: snapTarget.portId,
              kind: snapTarget.kind,
              category: snapTarget.category,
              dataType: port.dataType,
              isArray: port.isArray,
              arrayCapable: port.arrayCapable,
            };
          }
        }
      }

      // Pre-compute the resolved-candidate list. If snap is present and only
      // one related-node candidate would survive the compatibility filter,
      // skip the menu entirely and create the node directly — the menu would
      // just be a single-button click anyway.
      const resolved = resolveDropCandidates(payload, snapToPort);
      if (snapToPort && resolved.length === 1) {
        const { entry, def, matchPort } = resolved[0]!;
        const cfg: Record<string, string | number | boolean> = {
          [entry.configKey]: payloadElementId(payload),
          ...(entry.extraConfig ?? {}),
        };
        if (payload.kind === 'model-attribute') cfg.isColorAttr = payload.isColor;
        const screenToFlow = (p: { x: number; y: number }) =>
          rfInstance.current?.screenToFlowPosition(p) ?? p;
        const targetScreen = getPortScreenCentre(
          snapToPort.nodeId, snapToPort.portId, snapToPort.kind, snapToPort.category,
        );
        const pos = matchPort
          ? computeSnapPosition(snapToPort, targetScreen, def, matchPort, screenToFlow, flowPos)
          : flowPos;
        const newId = addNodeAndConnect(def.type, pos, snapToPort, cfg);
        if (newId && matchPort) {
          scheduleSnapRefinement(newId, snapToPort, matchPort);
        }
        setCurrentModelElementDrag(null);
        return;
      }

      setContextMenu({
        x: e.clientX - bounds.left,
        y: e.clientY - bounds.top,
        flowX: flowPos.x,
        flowY: flowPos.y,
        target: { type: 'model-element-drop', element: payload, snapToPort },
      });
      // Clear the highlight state — the drop is done.
      setCurrentModelElementDrag(null);
      return;
    }

    const raw = e.dataTransfer.getData('application/genesisca-palette');
    if (!raw) return;
    e.preventDefault();
    let payload: { kind: string; [k: string]: unknown };
    try { payload = JSON.parse(raw); } catch { return; }

    const pos = rfInstance.current?.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    if (!pos) return;

    spawnPalettePayload(payload as QuickAddPayload, pos);
  }, [addNodeAtPosition, addNodeAndConnect, scheduleSnapRefinement, spawnPalettePayload]);

  // --- Macro export / import ---

  /** Export the macro referenced by the right-clicked macro node as a .gcamacro file. */
  const exportMacro = useCallback(() => {
    if (!contextMenu || contextMenu.target.type !== 'node' || !contextMenu.target.isMacro) return;
    const node = nodesRef.current.find(n => n.id === (contextMenu.target as { nodeId: string }).nodeId);
    const cfg = (node?.data as { config?: Record<string, unknown> } | undefined)?.config;
    const macroDefId = cfg?.macroDefId as string | undefined;
    const def = (model.macroDefs || []).find(m => m.id === macroDefId);
    if (!def) { setContextMenu(null); return; }

    const payload = {
      schemaVersion: 1,
      name: def.name,
      description: '',
      macroDef: def,
    };
    const safeName = def.name.trim().replace(/[^a-z0-9-_ ]+/gi, '').replace(/\s+/g, '-').toLowerCase() || 'macro';
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeName}.gcamacro`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setContextMenu(null);
  }, [contextMenu, model.macroDefs]);

  /** Hidden file input that the "Import Macro..." menu item triggers. */
  const importMacroInputRef = useRef<HTMLInputElement>(null);
  const pendingImportPos = useRef<{ x: number; y: number } | null>(null);

  const triggerImportMacro = useCallback(() => {
    if (!contextMenu) return;
    pendingImportPos.current = { x: contextMenu.flowX, y: contextMenu.flowY };
    setContextMenu(null);
    // Defer click so the context menu state finishes resetting first
    setTimeout(() => importMacroInputRef.current?.click(), 0);
  }, [contextMenu]);

  const handleMacroFileSelected = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const finalPos = pendingImportPos.current ?? { x: 0, y: 0 };
    pendingImportPos.current = null;
    file.text().then(text => {
      let parsed: { macroDef?: unknown };
      try { parsed = JSON.parse(text); } catch { alert('Invalid .gcamacro file: not valid JSON'); return; }
      if (!parsed?.macroDef || typeof parsed.macroDef !== 'object') {
        alert('Invalid .gcamacro file: missing or invalid macroDef field');
        return;
      }
      const macroDef = parsed.macroDef as Parameters<typeof importMacro>[0];
      const newId = importMacro(macroDef);
      addNodeAtPosition('macro', finalPos, { macroDefId: newId }, macroDef.name);
    });
  }, [importMacro, addNodeAtPosition]);

  const duplicateNode = useCallback((linked = false) => {
    if (!contextMenu || contextMenu.target.type !== 'node') return;
    const targetNodeId = contextMenu.target.type === 'node' ? contextMenu.target.nodeId : '';
    const sourceNode = nodes.find(n => n.id === targetNodeId);
    if (!sourceNode) return;
    // Singleton: don't duplicate Step nodes
    const srcType = (sourceNode.data as Record<string, unknown>)?.nodeType;
    if (srcType === 'step') { setContextMenu(null); return; }
    pushCurrentSnapshot();

    // Macro instances: plain Duplicate (linked === false) clones the MacroDef
    // with fresh IDs so the copy is INDEPENDENT — editing one no longer affects
    // the other, and Undo Macro on one can't remove a def the other relies on.
    // "Duplicate Linked" (linked === true) keeps the same macroDefId, producing
    // a mirror copy: editing one's internals updates all linked instances.
    // (undoMacro ref-counts before removing a def, so shared defs are safe.)
    let clonedMacroDefId: string | undefined;
    if (srcType === 'macro' && !linked) {
      const srcConfig = (sourceNode.data as Record<string, unknown>).config as Record<string, unknown> | undefined;
      const srcMacroDefId = srcConfig?.macroDefId as string | undefined;
      const srcDef = srcMacroDefId
        ? (model.macroDefs || []).find(m => m.id === srcMacroDefId)
        : undefined;
      if (srcDef) {
        clonedMacroDefId = importMacro(srcDef);
      }
    }

    setNodes(nds => {
      const id = generateNodeId(nds);
      const dupData = JSON.parse(JSON.stringify(sourceNode.data)) as Record<string, unknown>;
      if (clonedMacroDefId) {
        const cfg = (dupData.config as Record<string, unknown> | undefined) ?? {};
        dupData.config = { ...cfg, macroDefId: clonedMacroDefId };
      }
      const newNode: Node = {
        id,
        type: sourceNode.type,
        position: { x: sourceNode.position.x + 30, y: sourceNode.position.y + 30 },
        data: dupData,
      };
      if (sourceNode.type === 'groupNode') {
        const d = sourceNode.data as Record<string, unknown>;
        newNode.style = { width: (d.width as number) || 300, height: (d.height as number) || 200 };
        newNode.zIndex = -1;
        newNode.dragHandle = '[data-drag-handle="true"]';
      }
      return [...nds, newNode];
    });
    scheduleSync();
    setContextMenu(null);
  }, [contextMenu, nodes, setNodes, scheduleSync, importMacro, model.macroDefs]);

  // Perform the deletion of a known node-id list. Extracted from
  // `deleteSelection` so the ConfirmDialog's onConfirm can call it without
  // re-deriving the IDs from a possibly-cleared context menu.
  const performDeleteNodes = useCallback((nodeIds: string[]) => {
    if (nodeIds.length === 0) return;
    pushCurrentSnapshot();
    deleteElements({ nodes: nodeIds.map(id => ({ id })) });
    scheduleSync();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deleteElements, scheduleSync]);

  const deleteSelection = useCallback(() => {
    if (!contextMenu) return;
    let nodeIds: string[] = [];
    if (contextMenu.target.type === 'selection') {
      nodeIds = contextMenu.target.nodeIds;
    } else if (contextMenu.target.type === 'node') {
      nodeIds = [contextMenu.target.nodeId];
    }
    // Filter out undeletable MacroInput/MacroOutput boundary nodes
    nodeIds = nodeIds.filter(nid => {
      const node = nodes.find(n => n.id === nid);
      const nt = (node?.data as Record<string, unknown> | undefined)?.nodeType;
      return nt !== 'macroInput' && nt !== 'macroOutput';
    });
    if (nodeIds.length === 0) { setContextMenu(null); return; }
    setContextMenu(null);
    if (nodeIds.length > 1) {
      setPendingMultiDelete(nodeIds);
      return;
    }
    performDeleteNodes(nodeIds);
  }, [contextMenu, nodes, performDeleteNodes]);

  // --- Copy / Paste / Cut ---

  const handleCopy = useCallback(() => {
    const selected = nodes.filter(n => n.selected);
    if (selected.length === 0) return;
    const selectedIds = new Set(selected.map(n => n.id));
    // Strip macroInput/macroOutput from clipboard (they are auto-generated)
    const copyNodes = toGraphNodes(
      selected.filter(n => {
        const nt = (n.data as Record<string, unknown>)?.nodeType;
        return nt !== 'macroInput' && nt !== 'macroOutput';
      }),
    );
    const copyEdges = toGraphEdges(
      edges.filter(e => selectedIds.has(e.source) && selectedIds.has(e.target)),
    );
    clipboard = { nodes: copyNodes, edges: copyEdges };
  }, [nodes, edges]);

  const handlePaste = useCallback(() => {
    if (!clipboard || clipboard.nodes.length === 0) return;
    // Singleton: filter out Step / Init Event nodes if one already exists in the graph
    const hasStepInGraph = nodesRef.current.some(
      n => (n.data as Record<string, unknown>)?.nodeType === 'step',
    );
    if (hasStepInGraph) {
      clipboard = {
        nodes: clipboard.nodes.filter(n => (n.data as Record<string, unknown>)?.nodeType !== 'step'),
        edges: clipboard.edges,
      };
      if (clipboard.nodes.length === 0) return;
    }
    const hasInitInGraph = nodesRef.current.some(
      n => (n.data as Record<string, unknown>)?.nodeType === 'initEvent',
    );
    if (hasInitInGraph) {
      clipboard = {
        nodes: clipboard.nodes.filter(n => (n.data as Record<string, unknown>)?.nodeType !== 'initEvent'),
        edges: clipboard.edges,
      };
      if (clipboard.nodes.length === 0) return;
    }
    pushCurrentSnapshot();

    // Compute clipboard top-left corner — paste anchors top-left at cursor
    let cx = 0, cy = 0;
    if (clipboard.nodes.length > 0) {
      let minX = Infinity, minY = Infinity;
      for (const n of clipboard.nodes) {
        minX = Math.min(minX, n.position.x);
        minY = Math.min(minY, n.position.y);
      }
      cx = minX;
      cy = minY;
    }

    // Determine paste target position — prefer right-click menu pos, then live cursor, then viewport center
    let target: { x: number; y: number };
    if (pasteFlowPos.current) {
      target = pasteFlowPos.current;
      pasteFlowPos.current = null;
    } else if (lastFlowMousePos.current) {
      target = lastFlowMousePos.current;
    } else {
      const rf = rfInstance.current;
      if (rf) {
        const bounds = document.querySelector('.react-flow')?.getBoundingClientRect();
        if (bounds) {
          target = rf.screenToFlowPosition({ x: bounds.width / 2, y: bounds.height / 2 });
        } else {
          target = { x: cx + 30, y: cy + 30 };
        }
      } else {
        target = { x: cx + 30, y: cy + 30 };
      }
    }
    const offsetX = target.x - cx;
    const offsetY = target.y - cy;

    // Build old → new ID mapping
    const idMap = new Map<string, string>();
    const existingIds = new Set(nodes.map(n => n.id));
    for (const n of clipboard.nodes) {
      let newId = `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
      while (existingIds.has(newId) || idMap.has(newId)) {
        newId = `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
      }
      idMap.set(n.id, newId);
      existingIds.add(newId);
    }

    // For every macro instance in the clipboard, clone its MacroDef so each
    // pasted copy gets its own independent definition. Multiple pastes of the
    // same source macro each get their own def too (one clone per pasted node).
    // Without this, Undo Macro on a pasted instance would remove the shared
    // def and silently break the original (and any other paste).
    const macroDefRemap = new Map<string, string>(); // oldDefId → newDefId per node
    for (const n of clipboard.nodes) {
      const nt = (n.data as Record<string, unknown>)?.nodeType;
      if (nt !== 'macro') continue;
      const cfg = (n.data as Record<string, unknown>).config as Record<string, unknown> | undefined;
      const oldDefId = cfg?.macroDefId as string | undefined;
      if (!oldDefId) continue;
      const srcDef = (model.macroDefs || []).find(m => m.id === oldDefId);
      if (!srcDef) continue;
      const newDefId = importMacro(srcDef);
      // Key by the per-node old id so multiple pasted copies of the same source
      // macro instance each get their own def (importMacro called once per node).
      macroDefRemap.set(n.id, newDefId);
    }

    const pastedRFNodes: Node[] = clipboard.nodes.map(n => {
      const clonedData = JSON.parse(JSON.stringify(n.data)) as Record<string, unknown>;
      delete clonedData.parentId; // legacy hygiene — groups no longer own children
      const newDefId = macroDefRemap.get(n.id);
      if (newDefId) {
        const cfg = (clonedData.config as Record<string, unknown> | undefined) ?? {};
        clonedData.config = { ...cfg, macroDefId: newDefId };
      }
      return {
        id: idMap.get(n.id)!,
        type: n.type === 'groupNode' ? 'groupNode' : n.type === 'commentNode' ? 'commentNode' : n.type === 'rerouteNode' ? 'rerouteNode' : 'caNode',
        position: { x: n.position.x + offsetX, y: n.position.y + offsetY },
        data: clonedData,
        selected: true,
        ...(n.type === 'groupNode' ? { style: { width: (clonedData.width as number) || 300, height: (clonedData.height as number) || 200 }, zIndex: -1, dragHandle: '[data-drag-handle="true"]' } : {}),      };
    });

    const pasteTs = Date.now().toString(36);
    const pastedRFEdges: Edge[] = clipboard.edges
      .filter(e => idMap.has(e.source) && idMap.has(e.target))
      .map((e, i) => ({
        id: `e_${pasteTs}_${i}_${Math.random().toString(36).slice(2, 5)}`,
        source: idMap.get(e.source)!,
        target: idMap.get(e.target)!,
        sourceHandle: e.sourceHandle,
        targetHandle: e.targetHandle,
        style: { stroke: e.sourceHandle.includes('flow') ? '#66bb6a' : '#4cc9f0', strokeWidth: 2 },
      }));

    // Deselect existing nodes AND edges; otherwise a follow-up delete of the pasted
    // selection would also nuke the still-selected original edges.
    setNodes(nds => [...nds.map(n => ({ ...n, selected: false })), ...pastedRFNodes]);
    setEdges(eds => [...eds.map(e => ({ ...e, selected: false })), ...pastedRFEdges]);
    scheduleSync();
  }, [nodes, setNodes, setEdges, scheduleSync, importMacro, model.macroDefs]);

  const duplicateSelection = useCallback(() => {
    const selected = nodes.filter(n => n.selected);
    if (selected.length === 0) return;
    pushCurrentSnapshot();
    const selectedIds = new Set(selected.map(n => n.id));
    const srcNodes = toGraphNodes(
      selected.filter(n => {
        const nt = (n.data as Record<string, unknown>)?.nodeType;
        return nt !== 'macroInput' && nt !== 'macroOutput';
      }),
    );
    const srcEdges = toGraphEdges(
      edges.filter(e => selectedIds.has(e.source) && selectedIds.has(e.target)),
    );
    if (srcNodes.length === 0) return;

    const idMap = new Map<string, string>();
    const existingIds = new Set(nodes.map(n => n.id));
    for (const n of srcNodes) {
      let newId = `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
      while (existingIds.has(newId) || idMap.has(newId)) {
        newId = `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
      }
      idMap.set(n.id, newId);
      existingIds.add(newId);
    }

    // Clone each macro instance's MacroDef so the duplicates don't share a def
    // with their originals (see handlePaste / duplicateNode for rationale).
    const macroDefRemap = new Map<string, string>();
    for (const n of srcNodes) {
      const nt = (n.data as Record<string, unknown>)?.nodeType;
      if (nt !== 'macro') continue;
      const cfg = (n.data as Record<string, unknown>).config as Record<string, unknown> | undefined;
      const oldDefId = cfg?.macroDefId as string | undefined;
      if (!oldDefId) continue;
      const srcDef = (model.macroDefs || []).find(m => m.id === oldDefId);
      if (!srcDef) continue;
      const newDefId = importMacro(srcDef);
      macroDefRemap.set(n.id, newDefId);
    }

    const dupeNodes: Node[] = srcNodes.map(n => {
      const clonedData = JSON.parse(JSON.stringify(n.data)) as Record<string, unknown>;
      delete clonedData.parentId; // legacy hygiene — groups no longer own children
      const newDefId = macroDefRemap.get(n.id);
      if (newDefId) {
        const cfg = (clonedData.config as Record<string, unknown> | undefined) ?? {};
        clonedData.config = { ...cfg, macroDefId: newDefId };
      }

      return {
        id: idMap.get(n.id)!,
        type: n.type === 'groupNode' ? 'groupNode' : n.type === 'commentNode' ? 'commentNode' : n.type === 'rerouteNode' ? 'rerouteNode' : 'caNode',
        position: { x: n.position.x + 30, y: n.position.y + 30 },
        data: clonedData,
        selected: true,
        ...(n.type === 'groupNode' ? { style: { width: (clonedData.width as number) || 300, height: (clonedData.height as number) || 200 }, zIndex: -1, dragHandle: '[data-drag-handle="true"]' } : {}),      };
    });

    const ts = Date.now().toString(36);
    const dupeEdges: Edge[] = srcEdges
      .filter(e => idMap.has(e.source) && idMap.has(e.target))
      .map((e, i) => ({
        id: `e_${ts}_${i}_${Math.random().toString(36).slice(2, 5)}`,
        source: idMap.get(e.source)!,
        target: idMap.get(e.target)!,
        sourceHandle: e.sourceHandle,
        targetHandle: e.targetHandle,
        style: { stroke: e.sourceHandle.includes('flow') ? '#66bb6a' : '#4cc9f0', strokeWidth: 2 },
      }));

    setNodes(nds => [...nds.map(n => ({ ...n, selected: false })), ...dupeNodes]);
    setEdges(eds => [...eds.map(e => ({ ...e, selected: false })), ...dupeEdges]);
    scheduleSync();
  }, [nodes, edges, setNodes, setEdges, scheduleSync, importMacro, model.macroDefs]);

  const handleCut = useCallback(() => {
    handleCopy();
    pushCurrentSnapshot();
    // Delete selected (but not macroInput/macroOutput)
    const selected = nodes.filter(n => n.selected);
    const deletableIds = selected
      .filter(n => {
        const nt = (n.data as Record<string, unknown>)?.nodeType;
        return nt !== 'macroInput' && nt !== 'macroOutput';
      })
      .map(n => n.id);
    if (deletableIds.length > 0) {
      deleteElements({ nodes: deletableIds.map(id => ({ id })) });
      scheduleSync();
    }
  }, [handleCopy, nodes, deleteElements, scheduleSync]);

  // Keyboard shortcuts for copy/paste
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Skip if user is typing in an input
      const tag = (document.activeElement as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === 'z' && !e.shiftKey) { handleUndo(); e.preventDefault(); return; }
      if (mod && e.key === 'z' && e.shiftKey) { handleRedo(); e.preventDefault(); return; }
      if (mod && e.key === 'y') { handleRedo(); e.preventDefault(); return; }
      if (mod && e.key === 'c') { handleCopy(); e.preventDefault(); }
      if (mod && e.key === 'v') { handlePaste(); e.preventDefault(); }
      if (mod && e.key === 'x') { handleCut(); e.preventDefault(); }
      if (mod && e.key === 'd') { duplicateSelection(); e.preventDefault(); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [handleCopy, handlePaste, handleCut, duplicateSelection, handleUndo, handleRedo]);

  const renameNode = useCallback(async () => {
    if (!contextMenu || contextMenu.target.type !== 'node') return;
    const nodeId = contextMenu.target.nodeId;
    const { x, y } = contextMenu;
    // Prefill with the node's current displayed name (custom label, else the
    // node type's default label) so the user can just edit/overtype.
    const node = nodes.find(n => n.id === nodeId);
    const data = (node?.data ?? {}) as Record<string, unknown>;
    const ntype = data.nodeType as string | undefined;
    const current = (data.label as string | undefined) ?? (ntype ? getNodeDef(ntype)?.label : undefined) ?? '';
    setContextMenu(null);
    // allowEmpty: clearing the field reverts to the default label (label || undefined).
    const name = await promptName({ title: 'Rename', fieldLabel: 'Name', initialValue: current, x, y, allowEmpty: true });
    if (name === null) return;
    pushCurrentSnapshot();
    setNodes(nds => nds.map(n =>
      n.id === nodeId ? { ...n, data: { ...n.data, label: name || undefined } } : n,
    ));
    scheduleSync();
  }, [contextMenu, nodes, setNodes, scheduleSync, promptName]);

  const addCommentNode = useCallback(() => {
    if (!contextMenu) return;
    pushCurrentSnapshot();
    setNodes(nds => {
      const id = generateNodeId(nds);
      return [...nds, {
        id,
        type: 'commentNode',
        position: { x: contextMenu.flowX, y: contextMenu.flowY - 40 },
        data: { text: 'Comment', autoEdit: true },
      }];
    });
    scheduleSync();
    setContextMenu(null);
  }, [contextMenu, setNodes, scheduleSync]);

  // --- Group actions ---
  // Groups are free-floating area markers — they don't own their children.
  // Creating a group just drops a rectangle around the selection's bbox; the
  // selected nodes stay where they are (no reparenting, no relative coords).
  // Dragging the group's header translates whichever nodes have their center
  // inside the rect AT DRAG-START (see onNodeDragStart). Deleting a group
  // only removes the rect — contained nodes stay put.

  // Shared helper: drop a groupNode rectangle into the graph at the given
  // flow-space `position`, sized to `width` × `height`. Returns the new
  // group's id. Used by both `createGroup` (around a selection's bbox) and
  // `createEmptyGroup` (free-standing rectangle at the cursor).
  const insertGroupNode = useCallback(
    (name: string, position: { x: number; y: number }, width: number, height: number): void => {
      pushCurrentSnapshot();
      setNodes(nds => {
        const groupId = generateNodeId(nds);
        const groupNode: Node = {
          id: groupId,
          type: 'groupNode',
          position,
          data: { label: name, width, height, nodeType: 'group', config: {} },
          style: { width, height },
          zIndex: -1,
          dragHandle: '[data-drag-handle="true"]',
        };
        // Insert BEFORE existing nodes so z-order (combined with zIndex: -1)
        // keeps the group visually behind any nodes that happen to overlap.
        return [groupNode, ...nds];
      });
      scheduleSync();
    },
    [setNodes, scheduleSync],
  );

  const createGroup = useCallback(async () => {
    if (!contextMenu || contextMenu.target.type !== 'selection') return;
    const { x, y } = contextMenu;
    const selectedIds = new Set(contextMenu.target.nodeIds);
    const selectedNodes = nodes.filter(n => selectedIds.has(n.id));
    setContextMenu(null);
    if (selectedNodes.length < 2) return;

    // Compute bounding box around the selected nodes using their actual
    // rendered dimensions where available.
    const pad = 40;
    const topPad = pad + 20;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of selectedNodes) {
      const { w, h } = nodeSize(n);
      minX = Math.min(minX, n.position.x);
      minY = Math.min(minY, n.position.y);
      maxX = Math.max(maxX, n.position.x + w);
      maxY = Math.max(maxY, n.position.y + h);
    }
    const name = await promptName({ title: 'Create Group', fieldLabel: 'Group name', initialValue: 'Group', x, y });
    if (!name) return;
    insertGroupNode(
      name,
      { x: minX - pad, y: minY - topPad },
      maxX - minX + pad * 2,
      maxY - minY + pad + topPad,
    );
  }, [contextMenu, nodes, insertGroupNode, promptName]);

  // Pane-menu "Add Group": drop an empty group rectangle at the cursor.
  // No selection required.
  const createEmptyGroup = useCallback(async () => {
    if (!contextMenu) return;
    const { x, y, flowX, flowY } = contextMenu;
    setContextMenu(null);
    const name = await promptName({ title: 'Add Group', fieldLabel: 'Group name', initialValue: 'Group', x, y });
    if (!name) return;
    const DEFAULT_W = 300;
    const DEFAULT_H = 200;
    insertGroupNode(
      name,
      { x: flowX - DEFAULT_W / 2, y: flowY - 20 },
      DEFAULT_W,
      DEFAULT_H,
    );
  }, [contextMenu, insertGroupNode, promptName]);

  // --- Align / Distribute (multi-selection only) ---
  // Node width/height approximation matches resizeGroupsToFit.
  const NODE_W = 200;
  const NODE_H = 100;

  type AlignMode = 'left' | 'centerH' | 'right' | 'top' | 'centerV' | 'bottom';

  const alignNodes = useCallback((mode: AlignMode) => {
    if (!contextMenu || contextMenu.target.type !== 'selection') return;
    const selectedIds = new Set(contextMenu.target.nodeIds);
    const sel = nodes.filter(n => selectedIds.has(n.id));
    if (sel.length < 2) { setContextMenu(null); return; }
    pushCurrentSnapshot();
    // Horizontal alignment uses x (left edge) or x + NODE_W/2 (center) or x + NODE_W (right).
    // Vertical alignment uses y / y + NODE_H/2 / y + NODE_H.
    let target = 0;
    if (mode === 'left')    target = Math.min(...sel.map(n => n.position.x));
    if (mode === 'right')   target = Math.max(...sel.map(n => n.position.x + NODE_W));
    if (mode === 'centerH') target = sel.reduce((s, n) => s + (n.position.x + NODE_W / 2), 0) / sel.length;
    if (mode === 'top')     target = Math.min(...sel.map(n => n.position.y));
    if (mode === 'bottom')  target = Math.max(...sel.map(n => n.position.y + NODE_H));
    if (mode === 'centerV') target = sel.reduce((s, n) => s + (n.position.y + NODE_H / 2), 0) / sel.length;

    setNodes(nds => nds.map(n => {
      if (!selectedIds.has(n.id)) return n;
      if (mode === 'left')    return { ...n, position: { ...n.position, x: target } };
      if (mode === 'right')   return { ...n, position: { ...n.position, x: target - NODE_W } };
      if (mode === 'centerH') return { ...n, position: { ...n.position, x: target - NODE_W / 2 } };
      if (mode === 'top')     return { ...n, position: { ...n.position, y: target } };
      if (mode === 'bottom')  return { ...n, position: { ...n.position, y: target - NODE_H } };
      if (mode === 'centerV') return { ...n, position: { ...n.position, y: target - NODE_H / 2 } };
      return n;
    }));
    scheduleSync();
    setContextMenu(null);
  }, [contextMenu, nodes, setNodes, scheduleSync]);

  const distributeNodes = useCallback((axis: 'h' | 'v') => {
    if (!contextMenu || contextMenu.target.type !== 'selection') return;
    const selectedIds = new Set(contextMenu.target.nodeIds);
    const sel = nodes.filter(n => selectedIds.has(n.id));
    if (sel.length < 3) { setContextMenu(null); return; }
    pushCurrentSnapshot();
    // Sort by axis position. Keep first (leftmost / topmost) and last (rightmost /
    // bottommost) fixed; distribute the inner nodes so the inter-node gap between
    // successive nodes' trailing/leading edges is equal.
    const key = axis === 'h' ? 'x' : 'y';
    const size = axis === 'h' ? NODE_W : NODE_H;
    const sorted = [...sel].sort((a, b) => a.position[key] - b.position[key]);
    const firstPos = sorted[0]!.position[key];
    const lastPos = sorted[sorted.length - 1]!.position[key];
    const totalSpan = (lastPos + size) - firstPos;
    const sumSizes = sorted.length * size;
    const gap = (totalSpan - sumSizes) / (sorted.length - 1);

    const newPosByIdx = new Map<string, number>();
    let cursor = firstPos;
    for (let i = 0; i < sorted.length; i++) {
      newPosByIdx.set(sorted[i]!.id, cursor);
      cursor += size + gap;
    }
    setNodes(nds => nds.map(n => {
      const np = newPosByIdx.get(n.id);
      if (np === undefined) return n;
      if (axis === 'h') return { ...n, position: { x: np, y: n.position.y } };
      return { ...n, position: { x: n.position.x, y: np } };
    }));
    scheduleSync();
    setContextMenu(null);
  }, [contextMenu, nodes, setNodes, scheduleSync]);

  // --- Macro actions ---

  const createMacroFromSelection = useCallback(async () => {
    if (!contextMenu || contextMenu.target.type !== 'selection') return;
    const { x, y } = contextMenu;
    const selectedIds = new Set(contextMenu.target.nodeIds);
    const selectedNodes = nodes.filter(n => selectedIds.has(n.id) && n.type !== 'commentNode' && n.type !== 'groupNode');
    if (selectedNodes.length < 2) {
      alert('Select at least 2 nodes to create a macro.');
      setContextMenu(null);
      return;
    }
    setContextMenu(null);
    const name = await promptName({ title: 'Create Macro', fieldLabel: 'Macro name', initialValue: 'New Macro', x, y });
    if (!name) return;
    pushCurrentSnapshot();

    const internalEdges = edges.filter(e => selectedIds.has(e.source) && selectedIds.has(e.target));
    const externalInputEdgesRaw = edges.filter(e => !selectedIds.has(e.source) && selectedIds.has(e.target));
    const externalOutputEdgesRaw = edges.filter(e => selectedIds.has(e.source) && !selectedIds.has(e.target));

    // --- Sort exposed-port order to match the vertical layout of the connected internal ports.
    // Without this the order is whatever the React Flow edges array happens to contain, which
    // produces apparently-arbitrary port orderings and unnecessary edge crossings on the new
    // MacroInput/MacroOutput boundary nodes.
    const portSortKey = (
      internalNodeId: string,
      handleStr: string,
      kind: 'input' | 'output',
    ): number => {
      const node = nodes.find(n => n.id === internalNodeId);
      if (!node) return 0;
      const parsed = parseHandleId(handleStr);
      const nodeData = node.data as Record<string, unknown>;
      const nodeType = nodeData?.nodeType as string;
      let portIdx = 0;
      if (parsed) {
        const def = getNodeDef(nodeType);
        if (def && def.ports.length > 0) {
          const ports = def.ports.filter(p => p.kind === kind);
          const idx = ports.findIndex(p => p.id === parsed.portId);
          if (idx >= 0) portIdx = idx;
        } else if (nodeType === 'macro') {
          // Dynamic-port nodes: look up the MacroDef's exposed-port order
          const cfg = nodeData.config as Record<string, unknown> | undefined;
          const macroDefId = cfg?.macroDefId as string | undefined;
          const md = (model.macroDefs || []).find(m => m.id === macroDefId);
          if (md) {
            const ports = kind === 'input' ? md.exposedInputs : md.exposedOutputs;
            const idx = ports.findIndex(p => p.portId === parsed.portId);
            if (idx >= 0) portIdx = idx;
          }
        }
      }
      // Node Y dominates; port index within the node breaks ties.
      return node.position.y * 1000 + portIdx;
    };

    const externalInputEdges = [...externalInputEdgesRaw].sort((a, b) =>
      portSortKey(a.target, a.targetHandle ?? '', 'input') -
      portSortKey(b.target, b.targetHandle ?? '', 'input'),
    );
    const externalOutputEdges = [...externalOutputEdgesRaw].sort((a, b) =>
      portSortKey(a.source, a.sourceHandle ?? '', 'output') -
      portSortKey(b.source, b.sourceHandle ?? '', 'output'),
    );

    const macroId = `macro_${Date.now().toString(36)}`;

    // Bounding box of the selection using FULL node extents (right/bottom edges
    // = position + measured width/height), not just the top-left corners. The
    // previous version used bare `position.x`, so `maxX + 100` for the
    // MacroOutput landed ON TOP of the rightmost node whenever that node was
    // wider than 100px (i.e. nearly always). We want MacroInput clear to the
    // LEFT of the whole selection and MacroOutput clear to the RIGHT.
    let bMinX = Infinity, bMinY = Infinity, bMaxX = -Infinity, bMaxY = -Infinity;
    for (const n of selectedNodes) {
      const { w, h } = nodeSize(n);
      bMinX = Math.min(bMinX, n.position.x);
      bMinY = Math.min(bMinY, n.position.y);
      bMaxX = Math.max(bMaxX, n.position.x + w);
      bMaxY = Math.max(bMaxY, n.position.y + h);
    }
    const midY = (bMinY + bMaxY) / 2;

    // Centroid of the selection. Internal node positions in the MacroDef are
    // stored RELATIVE to this centroid (subtracting avgX/avgY before saving),
    // and the MacroNode instance is placed AT (avgX, avgY) on the parent graph.
    // On Undo Macro, the offset is re-added so:
    //   (a) If undone immediately, nodes restore to their original positions.
    //   (b) If the macro instance was moved (or this is a duplicate), nodes
    //       expand around wherever the macro instance currently sits — not
    //       far off at the original creation coordinates.
    const avgX = selectedNodes.reduce((s, n) => s + n.position.x, 0) / selectedNodes.length;
    const avgY = selectedNodes.reduce((s, n) => s + n.position.y, 0) / selectedNodes.length;

    // Create MacroInput and MacroOutput boundary node IDs
    const macroInputNodeId = `mi_${macroId}`;
    const macroOutputNodeId = `mo_${macroId}`;

    // Build exposed ports — internalNodeId/PortId point to the boundary nodes
    const exposedInputs: MacroPort[] = externalInputEdges.map((e, i) => {
      const parsed = parseHandleId(e.targetHandle ?? '');
      return {
        portId: `in_${i}`,
        label: `Input ${i + 1}`,
        dataType: 'any',
        category: (parsed?.category || 'value') as 'value' | 'flow',
        internalNodeId: macroInputNodeId,
        internalPortId: `in_${i}`,
      };
    });
    const exposedOutputs: MacroPort[] = externalOutputEdges.map((e, i) => {
      const parsed = parseHandleId(e.sourceHandle ?? '');
      return {
        portId: `out_${i}`,
        label: `Output ${i + 1}`,
        dataType: 'any',
        category: (parsed?.category || 'value') as 'value' | 'flow',
        internalNodeId: macroOutputNodeId,
        internalPortId: `out_${i}`,
      };
    });

    // Build bridging edges: MacroInput outputs -> original internal targets
    const bridgingInputEdges: GraphEdge[] = externalInputEdges.map((e, i) => ({
      id: `bridge_in_${macroId}_${i}`,
      source: macroInputNodeId,
      sourceHandle: handleId({ id: `in_${i}`, kind: 'output', category: exposedInputs[i]!.category }),
      target: e.target,
      targetHandle: e.targetHandle ?? '',
    }));

    // Build bridging edges: original internal sources -> MacroOutput inputs
    const bridgingOutputEdges: GraphEdge[] = externalOutputEdges.map((e, i) => ({
      id: `bridge_out_${macroId}_${i}`,
      source: e.source,
      sourceHandle: e.sourceHandle ?? '',
      target: macroOutputNodeId,
      targetHandle: handleId({ id: `out_${i}`, kind: 'input', category: exposedOutputs[i]!.category }),
    }));

    // MacroInput/MacroOutput boundary nodes — positions also stored relative
    // to the centroid so navigating into the macro view doesn't dump them at
    // arbitrary far-off coordinates. The boundary nodes aren't rendered yet, so
    // estimate their size to clear the selection: MacroInput's RIGHT edge sits a
    // gap to the left of the selection's left edge; MacroOutput's LEFT edge sits
    // a gap to the right of the selection's right edge. Both are vertically
    // centred on the selection.
    const BOUNDARY_GAP = 120;     // clear horizontal gap from the selection
    const EST_BOUNDARY_W = 200;   // typical boundary-node width (not yet measured)
    // Boundary-node height grows with its exposed ports (~22px per port row +
    // header/padding), so estimate per side for accurate vertical centring.
    const estBoundaryH = (portCount: number) => 46 + Math.max(1, portCount) * 22;
    const macroInputGraphNode: GraphNode = {
      id: macroInputNodeId,
      type: 'caNode',
      position: {
        x: (bMinX - BOUNDARY_GAP - EST_BOUNDARY_W) - avgX,
        y: (midY - estBoundaryH(exposedInputs.length) / 2) - avgY,
      },
      data: { nodeType: 'macroInput', config: { macroDefId: macroId } },
    };
    const macroOutputGraphNode: GraphNode = {
      id: macroOutputNodeId,
      type: 'caNode',
      position: {
        x: (bMaxX + BOUNDARY_GAP) - avgX,
        y: (midY - estBoundaryH(exposedOutputs.length) / 2) - avgY,
      },
      data: { nodeType: 'macroOutput', config: { macroDefId: macroId } },
    };

    // Internal nodes are stored relative to the centroid so Undo Macro can
    // expand them around the current macro instance position (see the avgX/avgY
    // comment above for why).
    const internalGraphNodes = toGraphNodes(selectedNodes).map(n => ({
      ...n,
      position: { x: n.position.x - avgX, y: n.position.y - avgY },
    }));

    addMacro({
      id: macroId, name,
      nodes: [...internalGraphNodes, macroInputGraphNode, macroOutputGraphNode],
      edges: [...toGraphEdges(internalEdges), ...bridgingInputEdges, ...bridgingOutputEdges],
      exposedInputs, exposedOutputs,
    });

    // Generate macro node ID before updating nodes
    const macroNodeId = generateNodeId(nodes.filter(n => !selectedIds.has(n.id)));

    // Reconnect external edges to the new MacroNode's exposed ports
    const reconnectedEdges: Edge[] = [
      ...externalInputEdges.map((e, i) => ({
        id: `${macroNodeId}_ein_${i}`,
        source: e.source,
        sourceHandle: e.sourceHandle,
        target: macroNodeId,
        targetHandle: handleId({ id: `in_${i}`, kind: 'input', category: exposedInputs[i]!.category }),
        style: { stroke: exposedInputs[i]!.category === 'flow' ? '#66bb6a' : '#4cc9f0', strokeWidth: 2 },
      })),
      ...externalOutputEdges.map((e, i) => ({
        id: `${macroNodeId}_eout_${i}`,
        source: macroNodeId,
        sourceHandle: handleId({ id: `out_${i}`, kind: 'output', category: exposedOutputs[i]!.category }),
        target: e.target,
        targetHandle: e.targetHandle,
        style: { stroke: exposedOutputs[i]!.category === 'flow' ? '#66bb6a' : '#4cc9f0', strokeWidth: 2 },
      })),
    ];

    setNodes(nds => {
      const remaining = nds.filter(n => !selectedIds.has(n.id));
      return [...remaining, {
        id: macroNodeId,
        type: 'caNode',
        position: { x: avgX, y: avgY },
        data: { nodeType: 'macro', config: { macroDefId: macroId }, label: name },
      }];
    });
    setEdges(eds => {
      const remaining = eds.filter(e => !selectedIds.has(e.source) && !selectedIds.has(e.target));
      return [...remaining, ...reconnectedEdges];
    });
    scheduleSync();
    setContextMenu(null);
  }, [contextMenu, nodes, edges, addMacro, setNodes, setEdges, scheduleSync, promptName]);

  // Track whether a connection is being dragged (for hover-to-uncollapse)
  const isConnecting = useRef(false);
  // Snapshot of the origin port at connect-start. Used by onConnectEnd's
  // pane-drop branch (popups the filtered Add Node menu + auto-connect) since
  // `connectingFrom` is cleared the moment onConnectEnd fires.
  const connectionOriginRef = useRef<ConnectionOrigin | null>(null);
  // Set in onConnectEnd when the connection-drop menu is just opened, so the
  // editor's outer `onClick={() => setContextMenu(null)}` (which fires on the
  // same LMB-up via the synthesized click event) doesn't immediately close it.
  const suppressNextEditorClickRef = useRef(false);

  // --- Connection-drop menu search (quick-add style): drag a wire onto empty
  // canvas → the compatible-nodes menu opens with a focused search box; type
  // to filter, ↑/↓ to move the always-present selection, Enter adds + wires.
  const [dropMenuSearch, setDropMenuSearch] = useState('');
  const [dropMenuSelIdx, setDropMenuSelIdx] = useState(0);
  const dropSearchRef = useRef<HTMLInputElement>(null);

  const dropMenuItems = useMemo<DropMenuItem[]>(() => {
    // Shared by the connection-drop menu AND the pane quick-add menu (Spacebar /
    // right-click on blank canvas). The only differences: the pane menu has no
    // wire origin, so it offers no Reroute and applies no port-compatibility
    // filter — it lists every node available to the model.
    const targetType = contextMenu?.target.type;
    if (targetType !== 'connection-drop' && targetType !== 'pane') return [];
    const origin = contextMenu?.target.type === 'connection-drop' ? contextMenu.target.origin : null;
    const q = dropMenuSearch.trim().toLowerCase();
    const textMatch = (label: string, desc?: string): boolean =>
      !q || label.toLowerCase().includes(q) || (desc ?? '').toLowerCase().includes(q);
    const items: DropMenuItem[] = [];
    if (origin && origin.kind === 'output' && textMatch('Reroute', 'relay')) {
      items.push({ key: '__reroute', label: 'Reroute', kind: 'reroute' });
    }
    // Same availability + singleton filter the Add-Node menu always used, plus
    // the text filter; the compatibility filter applies only with a wire origin.
    const hasStep = nodesRef.current.some(n => (n.data as Record<string, unknown>)?.nodeType === 'step');
    const hasInit = nodesRef.current.some(n => (n.data as Record<string, unknown>)?.nodeType === 'initEvent');
    const matches = getAllNodeDefs().filter(d => {
      if (HIDDEN_FROM_DROP_MENU.has(d.type)) return false;
      if (d.type === 'step' && hasStep) return false;
      if (d.type === 'initEvent' && hasInit) return false;
      if (!isNodeAvailable(d, model)) return false;
      if (origin && !nodeHasCompatiblePort(d, origin)) return false;
      return textMatch(d.label, d.description);
    });
    // Preserve the menu's visual order: registry order, grouped by category.
    const grouped = new Map<string, NodeTypeDef[]>();
    for (const d of matches) {
      const list = grouped.get(d.category) ?? [];
      list.push(d);
      grouped.set(d.category, list);
    }
    for (const [, defs] of grouped) {
      for (const d of defs) items.push({ key: d.type, label: d.label, kind: 'node', def: d });
    }
    return items;
  }, [contextMenu, model, dropMenuSearch]);

  const dropItemsRef = useRef(dropMenuItems);
  dropItemsRef.current = dropMenuItems;

  // Reset + focus when the menu (re)opens. The 50ms delay matters: the menu's
  // first frame renders visibility:hidden for viewport clamping, and focusing
  // a hidden element silently no-ops (same gotcha as NameInputDialog).
  useEffect(() => {
    setDropMenuSearch('');
    setDropMenuSelIdx(0);
    const t = contextMenu?.target.type;
    if (t === 'connection-drop' || t === 'pane') {
      const timer = setTimeout(() => dropSearchRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [contextMenu]);

  // On every filter change, re-anchor the selection to the best LABEL match —
  // first label-prefix, else first label-substring, else item 0. Mirrors the
  // Palette quick-add (description matches would otherwise win by list order).
  useEffect(() => {
    const q = dropMenuSearch.trim().toLowerCase();
    const items = dropItemsRef.current;
    let idx = 0;
    if (q) {
      let substr = -1;
      let prefix = -1;
      for (let i = 0; i < items.length; i++) {
        const label = items[i]!.label.toLowerCase();
        if (label.startsWith(q)) { prefix = i; break; }
        if (substr < 0 && label.includes(q)) substr = i;
      }
      idx = prefix >= 0 ? prefix : substr >= 0 ? substr : 0;
    }
    setDropMenuSelIdx(idx);
  }, [dropMenuSearch]);

  // Keep the keyboard selection visible while arrowing through a long menu.
  useEffect(() => {
    const t = contextMenu?.target.type;
    if (t !== 'connection-drop' && t !== 'pane') return;
    const key = dropItemsRef.current[dropMenuSelIdx]?.key;
    if (!key) return;
    contextMenuRef.current?.querySelector(`[data-drop-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [dropMenuSelIdx, contextMenu]);

  const commitDropMenuItem = useCallback((item: DropMenuItem) => {
    if (!contextMenu) return;
    const pos = { x: contextMenu.flowX, y: contextMenu.flowY };
    if (contextMenu.target.type === 'connection-drop') {
      const origin = contextMenu.target.origin;
      if (item.kind === 'reroute') addRerouteAndConnect(origin, pos);
      else addNodeAndConnect(item.def.type, pos, origin);
    } else if (contextMenu.target.type === 'pane') {
      // Pane quick-add (Spacebar / right-click): plain node creation, no wiring.
      if (item.kind === 'node') addNodeAtPosition(item.def.type, pos);
    }
    setContextMenu(null);
  }, [contextMenu, addRerouteAndConnect, addNodeAndConnect, addNodeAtPosition]);

  // DEV-only test hook: React Flow's connection drag ignores synthetic pointer
  // events (same limitation as box-select / ctrl-click — see CLAUDE.md), so
  // browser-eval tests open the connection-drop menu through this instead.
  // Same precedent as SimulatorView's window.__simWorker.
  useEffect(() => {
    if (!import.meta.env.DEV) return undefined;
    (window as unknown as Record<string, unknown>).__openConnectionDropMenu =
      (origin: ConnectionOrigin, x: number, y: number) => {
        const rf = rfInstance.current;
        const flowPos = rf ? rf.screenToFlowPosition({ x, y }) : { x: 0, y: 0 };
        const bounds = editorWrapperRef.current?.getBoundingClientRect();
        setContextMenu({
          x: x - (bounds?.left ?? 0),
          y: y - (bounds?.top ?? 0),
          flowX: flowPos.x,
          flowY: flowPos.y,
          target: { type: 'connection-drop', origin },
        });
      };
    return () => { delete (window as unknown as Record<string, unknown>).__openConnectionDropMenu; };
  }, []);

  // DEV-only test hook: box-select multi-selection can't be driven by synthetic
  // events either (same limitation), so browser-eval tests open the selection
  // context menu (the one carrying "Create Macro from Selection") through this.
  useEffect(() => {
    if (!import.meta.env.DEV) return undefined;
    (window as unknown as Record<string, unknown>).__openSelectionMenu =
      (nodeIds: string[], x: number, y: number) => {
        const rf = rfInstance.current;
        const flowPos = rf ? rf.screenToFlowPosition({ x, y }) : { x: 0, y: 0 };
        const bounds = editorWrapperRef.current?.getBoundingClientRect();
        setContextMenu({
          x: x - (bounds?.left ?? 0),
          y: y - (bounds?.top ?? 0),
          flowX: flowPos.x,
          flowY: flowPos.y,
          target: { type: 'selection', nodeIds },
        });
      };
    return () => { delete (window as unknown as Record<string, unknown>).__openSelectionMenu; };
  }, []);

  const onConnectStart: OnConnectStart = useCallback((_event, params) => {
    isConnecting.current = true;
    setIsConnecting(true);
    connectionOriginRef.current = null;
    if (params.handleId && params.nodeId) {
      const parsed = parseHandleId(params.handleId);
      if (parsed) {
        const srcNode = nodesRef.current.find(n => n.id === params.nodeId);
        const info = srcNode ? getOriginPortInfo(srcNode, parsed.portId) : null;
        const origin: ConnectionOrigin = {
          nodeId: params.nodeId,
          portId: parsed.portId,
          kind: parsed.kind,
          category: parsed.category,
          dataType: info?.dataType,
          isArray: info?.isArray,
          arrayCapable: info?.arrayCapable,
        };
        connectionOriginRef.current = origin;
        setConnectingFrom({
          category: origin.category,
          kind: origin.kind,
          dataType: origin.dataType,
          isArray: origin.isArray,
          nodeId: origin.nodeId,
          portId: origin.portId,
        });
      }
    }
  }, []);
  const onConnectEnd: OnConnectEnd = useCallback((event, connectionState: FinalConnectionState) => {
    isConnecting.current = false;
    setIsConnecting(false);
    const origin = connectionOriginRef.current;
    connectionOriginRef.current = null;
    setConnectingFrom(null);
    if (!origin) return;
    // Skip ONLY when the release landed on a port (valid or invalid). For any
    // non-port release — empty pane, node body, controls, minimap overlay,
    // background — pop the compatible-nodes menu so the user gets the same
    // affordance regardless of where they let go inside the canvas.
    if (connectionState.toHandle) return;
    const me = event as MouseEvent;
    const clientX = typeof me.clientX === 'number'
      ? me.clientX
      : ((event as TouchEvent).changedTouches?.[0]?.clientX ?? 0);
    const clientY = typeof me.clientY === 'number'
      ? me.clientY
      : ((event as TouchEvent).changedTouches?.[0]?.clientY ?? 0);
    const rf = rfInstance.current;
    if (!rf) return;
    // Resolve the React Flow root for menu positioning. If the release happened
    // outside the canvas entirely (dragged into a sidebar), silently bail.
    const target = event.target as Element | null;
    const rfRoot = (target?.closest('.react-flow') as HTMLElement | null)
      ?? (document.querySelector('.react-flow') as HTMLElement | null);
    if (!rfRoot) return;
    const bounds = rfRoot.getBoundingClientRect();
    // If the release was outside the canvas bounds, also bail.
    if (clientX < bounds.left || clientX > bounds.right || clientY < bounds.top || clientY > bounds.bottom) return;
    const flowPos = rf.screenToFlowPosition({ x: clientX, y: clientY });
    pasteFlowPos.current = { x: flowPos.x, y: flowPos.y };
    setContextMenu({
      x: clientX - bounds.left,
      y: clientY - bounds.top,
      flowX: flowPos.x,
      flowY: flowPos.y,
      target: { type: 'connection-drop', origin },
    });
    // The same LMB-up that fired onConnectEnd will, a tick later, also fire a
    // synthesized `click` on the editor wrapper — which otherwise calls
    // `setContextMenu(null)` and closes the menu we just opened. Skip exactly
    // one click. (The RMB-during-LMB-drag case works without this because RMB
    // doesn't generate a click event.)
    suppressNextEditorClickRef.current = true;
  }, []);

  // Double-click: enter macro or toggle collapse
  const onNodeDoubleClick = useCallback((_event: React.MouseEvent, node: Node) => {
    const nodeData = node.data as Record<string, unknown>;
    if (nodeData.nodeType === 'macro') {
      const macroDefId = (nodeData.config as Record<string, unknown>)?.macroDefId as string;
      if (macroDefId) setCurrentScope(prev => [...prev, macroDefId]);
    } else if (node.type === 'caNode') {
      updateNodeData(node.id, { ...node.data, isCollapsed: !nodeData.isCollapsed });
      scheduleSync();
    }
  }, [updateNodeData, scheduleSync]);

  const navigateToScope = useCallback((index: number) => {
    setCurrentScope(prev => prev.slice(0, index + 1));
  }, []);

  // Undo Macro — restore subgraph inline
  const undoMacro = useCallback(() => {
    if (!contextMenu || contextMenu.target.type !== 'node' || !contextMenu.target.isMacro) return;
    pushCurrentSnapshot();
    const macroNodeId = contextMenu.target.nodeId;
    // Use getNodes() for fresh positions (avoids stale closure)
    const freshNodes = getNodes();
    const macroNode = freshNodes.find(n => n.id === macroNodeId);
    if (!macroNode) { setContextMenu(null); return; }

    const nodeData = macroNode.data as Record<string, unknown>;
    const macroDefId = (nodeData.config as Record<string, unknown>)?.macroDefId as string;
    const macroDef = (model.macroDefs || []).find(m => m.id === macroDefId);
    if (!macroDef) { setContextMenu(null); return; }

    // Identify boundary nodes
    const boundaryNodeIds = new Set(
      macroDef.nodes
        .filter(n => {
          const nt = (n.data as Record<string, unknown>).nodeType;
          return nt === 'macroInput' || nt === 'macroOutput';
        })
        .map(n => n.id),
    );

    // Restore subgraph nodes centered on the macro node (excluding boundary
    // nodes). Internal positions can't be assumed relative to (0,0): that only
    // holds for macros built via Create-from-Selection. Macros created by
    // import (.gcamacro) or palette drop carry absolute coords, so naively
    // adding macroNode.position flung them far away. Instead, align the
    // internal cluster's bounding-box center to the macro node's center —
    // origin-independent, so the dissolved nodes land where the macro was.
    const internalNodes = macroDef.nodes.filter(n => !boundaryNodeIds.has(n.id));
    let offsetX = macroNode.position.x;
    let offsetY = macroNode.position.y;
    if (internalNodes.length > 0) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of internalNodes) {
        const d = n.data as Record<string, unknown> | undefined;
        const w = typeof d?.width === 'number' ? (d.width as number) : 200;
        const h = typeof d?.height === 'number'
          ? (d.height as number)
          : (d?.isCollapsed ? 32 : 100);
        minX = Math.min(minX, n.position.x);
        minY = Math.min(minY, n.position.y);
        maxX = Math.max(maxX, n.position.x + w);
        maxY = Math.max(maxY, n.position.y + h);
      }
      const clusterCx = (minX + maxX) / 2;
      const clusterCy = (minY + maxY) / 2;
      const { w: mw, h: mh } = nodeSize(macroNode);
      offsetX = (macroNode.position.x + mw / 2) - clusterCx;
      offsetY = (macroNode.position.y + mh / 2) - clusterCy;
    }
    const restoredRFNodes: Node[] = macroDef.nodes
      .filter(n => !boundaryNodeIds.has(n.id))
      .map(n => ({
        id: n.id,
        type: n.type === 'groupNode' ? 'groupNode' : n.type === 'commentNode' ? 'commentNode' : n.type === 'rerouteNode' ? 'rerouteNode' : 'caNode',
        position: { x: n.position.x + offsetX, y: n.position.y + offsetY },
        data: n.data,
        selected: true,
        ...(n.type === 'groupNode' ? { dragHandle: '[data-drag-handle="true"]' } : {}),      }));

    // Restore only internal edges (exclude bridging edges touching boundary nodes)
    const restoredRFEdges: Edge[] = macroDef.edges
      .filter(e => !boundaryNodeIds.has(e.source) && !boundaryNodeIds.has(e.target))
      .map(e => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle,
        targetHandle: e.targetHandle,
        style: { stroke: e.sourceHandle.includes('flow') ? '#66bb6a' : '#4cc9f0', strokeWidth: 2 },
      }));

    // Reconnect external edges: trace through boundary nodes to find actual internal targets.
    // For inputs: MacroNode input port -> MacroInput output port -> bridging edge -> actual internal node
    // For outputs: actual internal node -> bridging edge -> MacroOutput input port -> MacroNode output port
    const edgesToMacro = edges.filter(e => e.target === macroNodeId);
    const edgesFromMacro = edges.filter(e => e.source === macroNodeId);

    const reconnectedInputEdges: Edge[] = edgesToMacro.map(e => {
      const parsed = parseHandleId(e.targetHandle ?? '');
      const portId = parsed?.portId || '';
      const exposedPort = macroDef.exposedInputs.find(p => p.portId === portId);
      if (!exposedPort) return null;
      // Trace: find the bridging edge from the MacroInput port to the actual internal node
      const bridgeHandle = handleId({ id: exposedPort.portId, kind: 'output', category: exposedPort.category });
      const bridgingEdge = macroDef.edges.find(
        be => be.source === exposedPort.internalNodeId && be.sourceHandle === bridgeHandle,
      );
      if (bridgingEdge) {
        return {
          ...e,
          id: `restored_${e.id}`,
          target: bridgingEdge.target,
          targetHandle: bridgingEdge.targetHandle,
        };
      }
      return null;
    }).filter(Boolean) as Edge[];

    const reconnectedOutputEdges: Edge[] = edgesFromMacro.map(e => {
      const parsed = parseHandleId(e.sourceHandle ?? '');
      const portId = parsed?.portId || '';
      const exposedPort = macroDef.exposedOutputs.find(p => p.portId === portId);
      if (!exposedPort) return null;
      // Trace: find the bridging edge from actual internal node to the MacroOutput port
      const bridgeHandle = handleId({ id: exposedPort.portId, kind: 'input', category: exposedPort.category });
      const bridgingEdge = macroDef.edges.find(
        be => be.target === exposedPort.internalNodeId && be.targetHandle === bridgeHandle,
      );
      if (bridgingEdge) {
        return {
          ...e,
          id: `restored_${e.id}`,
          source: bridgingEdge.source,
          sourceHandle: bridgingEdge.sourceHandle,
        };
      }
      return null;
    }).filter(Boolean) as Edge[];

    // Remove macro node and its edges, add restored subgraph (select restored, deselect others)
    setNodes(nds => [
      ...nds.filter(n => n.id !== macroNodeId).map(n => ({ ...n, selected: false })),
      ...restoredRFNodes,
    ]);
    setEdges(eds => [
      ...eds.filter(e => e.source !== macroNodeId && e.target !== macroNodeId),
      ...restoredRFEdges,
      ...reconnectedInputEdges,
      ...reconnectedOutputEdges,
    ]);

    // Remove macro definition — but only if no OTHER macro instance still
    // references it. Duplicating a macro now clones its def (so each instance
    // has its own), but older saved files or hand-edited JSON could still
    // share a def across multiple instances. Keeping the def alive when there
    // are remaining references prevents Undo Macro on one from silently
    // breaking the others.
    const otherInstanceExists =
      freshNodes.some(n =>
        n.id !== macroNodeId
        && (n.data as Record<string, unknown>)?.nodeType === 'macro'
        && ((n.data as Record<string, unknown>).config as Record<string, unknown> | undefined)?.macroDefId === macroDefId,
      )
      || (model.macroDefs || []).some(other =>
        other.id !== macroDefId
        && other.nodes.some(n =>
          (n.data as Record<string, unknown>)?.nodeType === 'macro'
          && ((n.data as Record<string, unknown>).config as Record<string, unknown> | undefined)?.macroDefId === macroDefId,
        ),
      );
    if (!otherInstanceExists) {
      removeMacro(macroDefId);
    }
    scheduleSync();
    setContextMenu(null);
  }, [contextMenu, getNodes, edges, model.macroDefs, removeMacro, setNodes, setEdges, scheduleSync]);

  // Sync on node data changes (config edits via inline widgets)
  const onNodeDataChange = useCallback(() => {
    pushDebouncedSnapshot();
    scheduleSync();
  }, [scheduleSync, pushDebouncedSnapshot]);

  // Panel-drag highlight: when the user starts dragging a side-panel item,
  // light up every existing canvas port that a to-be-spawned related node
  // could connect to. CaNode reads `compatibleHandlesForDrag` and applies the
  // existing `handleCompatible` glow. Recomputed whenever the drag payload
  // OR the nodes/edges list changes mid-drag (rare but cheap to handle).
  useEffect(() => {
    const recompute = () => {
      const payload = currentModelElementDrag as ModelElementDragPayload | null;
      if (!payload) { clearCompatibleHandlesForDrag(); return; }
      // Build the occupied-inputs set so we don't suggest snapping to a
      // value-input that already has an edge.
      const occupied = new Set<string>();
      for (const e of edgesRef.current) {
        if (!e.targetHandle) continue;
        const parsed = parseHandleId(e.targetHandle);
        if (parsed && parsed.kind === 'input' && parsed.category === 'value') {
          occupied.add(`${e.target}|${parsed.portId}`);
        }
      }
      const compatible = computeCompatibleHandlesForDrag(payload, nodesRef.current, occupied);
      setCompatibleHandlesForDrag(compatible);
    };
    const unsub = subscribeCurrentModelElementDrag(recompute);
    recompute();
    return () => { unsub(); clearCompatibleHandlesForDrag(); };
  }, []);

  // Shared search + keyboard-navigable node list, rendered by BOTH the
  // connection-drop menu and the pane quick-add menu (Spacebar / right-click on
  // blank canvas). `dropMenuItems` already encodes the right filter per target
  // (compatible nodes for connection-drop; every available node for pane).
  const renderQuickAddSearch = (placeholder: string, emptyText: string) => {
    const origin = contextMenu?.target.type === 'connection-drop' ? contextMenu.target.origin : null;
    const effIdx = dropMenuItems.length > 0 ? Math.min(dropMenuSelIdx, dropMenuItems.length - 1) : -1;
    // Flat keyboard-selectable rows with category headers interleaved (the flat
    // index drives ↑/↓).
    const rows: React.ReactNode[] = [];
    let lastCat: string | null = null;
    dropMenuItems.forEach((item, i) => {
      if (item.kind === 'node' && item.def.category !== lastCat) {
        lastCat = item.def.category;
        rows.push(<div key={`cat-${lastCat}`} className={styles.contextCategory}>{lastCat}</div>);
      }
      rows.push(
        <button
          key={item.key}
          data-drop-key={item.key}
          className={`${styles.contextItem} ${i === effIdx ? styles.contextItemSelected : ''}`}
          title={item.kind === 'node'
            ? item.def.description
            : 'Insert a reroute relay that carries this output to a new spot (drag from it to fan out)'}
          onMouseMove={() => { if (i !== effIdx) setDropMenuSelIdx(i); }}
          onClick={e => { e.stopPropagation(); commitDropMenuItem(item); }}
        >
          <span
            className={styles.contextDot}
            style={{ background: item.kind === 'node' ? item.def.color : (origin?.category === 'flow' ? '#4caf50' : '#4cc9f0') }}
          />
          {item.label}
        </button>,
      );
    });
    return (
      <>
        <input
          ref={dropSearchRef}
          className={styles.contextSearch}
          type="text"
          placeholder={placeholder}
          value={dropMenuSearch}
          onChange={e => setDropMenuSearch(e.target.value)}
          onClick={e => e.stopPropagation()}
          onKeyDown={e => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const len = dropMenuItems.length;
              if (len === 0) return;
              const cur = Math.min(dropMenuSelIdx, len - 1);
              setDropMenuSelIdx(e.key === 'ArrowDown' ? (cur + 1) % len : (cur - 1 + len) % len);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              const item = effIdx >= 0 ? dropMenuItems[effIdx] : undefined;
              if (item) commitDropMenuItem(item);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setContextMenu(null);
            }
          }}
        />
        {dropMenuItems.length === 0 && (
          <div style={{ padding: '6px 10px', fontSize: '0.7rem', color: '#8090a0', fontStyle: 'italic' }}>
            {emptyText}
          </div>
        )}
        <div className={styles.dropList}>{rows}</div>
      </>
    );
  };

  return (
    <div
      ref={editorWrapperRef}
      className={styles.editor}
      onClick={() => {
        if (suppressNextEditorClickRef.current) {
          suppressNextEditorClickRef.current = false;
          return;
        }
        setContextMenu(null);
      }}
      onChangeCapture={onNodeDataChange}
      onDragOver={onPaletteDragOver}
      onDrop={onPaletteDrop}
    >
      {/* Hidden file input triggered by the "Import Macro..." menu item */}
      <input
        ref={importMacroInputRef}
        type="file"
        accept=".gcamacro,application/json"
        style={{ display: 'none' }}
        onChange={handleMacroFileSelected}
      />
      {currentScope.length > 1 && (
        <div className={styles.breadcrumb}>
          {currentScope.map((scopeId, i) => {
            const label = scopeId === 'root'
              ? 'Root'
              : (model.macroDefs || []).find(m => m.id === scopeId)?.name || scopeId;
            return (
              <span key={i}>
                {i > 0 && <span className={styles.breadcrumbSep}>&rsaquo;</span>}
                <button
                  className={`${styles.breadcrumbItem} ${i === currentScope.length - 1 ? styles.breadcrumbActive : ''}`}
                  onClick={() => navigateToScope(i)}
                >
                  {label}
                </button>
              </span>
            );
          })}
        </div>
      )}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={onConnect}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        isValidConnection={isValidConnection as IsValidConnection}
        onInit={instance => { rfInstance.current = instance; }}
        onMouseMove={(e: React.MouseEvent) => {
          const rf = rfInstance.current;
          if (!rf) return;
          lastClientMousePos.current = { x: e.clientX, y: e.clientY };
          lastFlowMousePos.current = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
        }}
        onMove={(_e, viewport) => {
          // Key the saved viewport by the scope the user is CURRENTLY in,
          // so root vs each macro keep independent pan/zoom.
          const scopeId = currentScope[currentScope.length - 1] ?? 'root';
          setSavedGraphViewport(scopeId, viewport);
        }}
        onPaneContextMenu={onPaneContextMenu}
        onNodeContextMenu={onNodeContextMenu}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        onNodeDoubleClick={onNodeDoubleClick}
        onEdgeDoubleClick={(_event, edge) => { setEdges(eds => eds.filter(e => e.id !== edge.id)); scheduleSync(); }}
        nodeTypes={nodeTypes}
        // Restore the user's last pan/zoom across ModelerView unmounts (tab
        // switches). Look up by the scope the editor is mounting into — root
        // vs each macro have independent saved viewports. Only auto-fit when
        // there's no saved viewport for the current scope (first session
        // render OR after a model load that wiped saved viewports).
        {...((() => {
          const scopeId = currentScope[currentScope.length - 1] ?? 'root';
          const saved = getSavedGraphViewport(scopeId);
          return saved ? { defaultViewport: saved } : { fitView: true };
        })())}
        deleteKeyCode={['Delete', 'Backspace']}
        snapToGrid={snapEnabled}
        snapGrid={[20, 20]}
        panOnDrag={[2]}
        selectionOnDrag
        selectionMode={'partial' as SelectionMode}
        multiSelectionKeyCode="Control"
        defaultEdgeOptions={{
          style: { stroke: '#4cc9f0', strokeWidth: 2 },
          interactionWidth: 15,
        }}
        proOptions={{ hideAttribution: true }}
      >
        {showGrid && <Background color={gridColor} gap={20} variant={BackgroundVariant.Lines} />}
        <AlignmentGuidesOverlay guides={alignGuides} />
        <Controls showInteractive={false} />
        {/* Canvas toggle buttons */}
        <div className={styles.canvasToggles}>
          <button
            className={`${styles.toggleButton} ${portLabelsVisible ? styles.toggleActive : ''}`}
            onClick={() => { setPortLabelsVisible(v => !v); setShowPortLabels(!portLabelsVisible); }}
            title="Toggle port labels"
          >
            Aa
          </button>
          <button
            className={`${styles.toggleButton} ${showGrid ? styles.toggleActive : ''}`}
            onClick={() => { setShowGrid(v => !v); setShowGridGlobal(!showGrid); }}
            title="Toggle grid"
          >
            #
          </button>
          <button
            className={`${styles.toggleButton} ${snapEnabled ? styles.toggleActive : ''}`}
            onClick={() => { setSnapEnabled(v => !v); setSnapEnabledGlobal(!snapEnabled); }}
            title="Toggle snap to grid"
          >
            &loz;
          </button>
        </div>
        <MiniMap
          nodeColor={n => n.type === 'groupNode' ? minimapNodeGroup : minimapNode}
          maskColor={minimapMask}
          style={{ background: minimapBg }}
          pannable
          zoomable
          onClick={(_e, position) => {
            // Jump the viewport to the clicked spot; keep current zoom.
            rfInstance.current?.setCenter(position.x, position.y, { duration: 200 });
          }}
        />
      </ReactFlow>

      {/* Unified context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className={styles.contextMenu}
          style={{
            left: (menuPos ?? contextMenu).x,
            top: (menuPos ?? contextMenu).y,
            visibility: menuPos ? 'visible' : 'hidden',
          }}
        >
          {/* CONNECTION-DROP context menu (drag link to empty canvas → compatible nodes) */}
          {contextMenu.target.type === 'connection-drop' && (() => {
            const origin = contextMenu.target.origin;
            const titleText = origin.category === 'flow'
              ? `Flow ${origin.kind === 'output' ? 'output' : 'input'} → compatible node`
              : `${origin.dataType ?? 'value'} ${origin.kind === 'output' ? 'output' : 'input'} → compatible node`;
            return (
              <>
                <div className={styles.contextTitle}>{titleText}</div>
                {renderQuickAddSearch('Search… (Enter adds + wires)', `No compatible nodes${dropMenuSearch ? ' match' : ''}`)}
              </>
            );
          })()}

          {/* MODEL-ELEMENT-DROP context menu (drag attribute/neighborhood/etc. from side panel) */}
          {contextMenu.target.type === 'model-element-drop' && (() => {
            const payload = contextMenu.target.element;
            const snap = contextMenu.target.snapToPort;
            // Shared helper: same filter used by `onPaletteDrop` to decide
            // whether to skip the menu (single-option short-circuit).
            const resolved = resolveDropCandidates(payload, snap);
            // Group by category
            const grouped = new Map<string, ResolvedDropCandidate[]>();
            for (const r of resolved) {
              const list = grouped.get(r.def.category) ?? [];
              list.push(r);
              grouped.set(r.def.category, list);
            }
            const elemId = payloadElementId(payload);
            const titleByKind: Record<ModelElementDragPayload['kind'], string> = {
              'cell-attribute': 'Cell attribute',
              'model-attribute': 'Model attribute',
              'neighborhood': 'Neighborhood',
              'mapping-a2c': 'Output mapping (A→C)',
              'mapping-c2a': 'Input mapping (C→A)',
              'indicator': 'Indicator',
              'variable': 'Local variable',
            };
            const baseTitle = titleByKind[payload.kind];
            let title = baseTitle;
            if (snap) {
              const snapNode = nodesRef.current.find(n => n.id === snap.nodeId);
              const snapData = snapNode?.data as { nodeType?: string; config?: Record<string, unknown> } | undefined;
              const snapDef = snapData?.nodeType ? getNodeDef(snapData.nodeType) : null;
              const snapPortLabel = snapDef?.ports.find(p => p.id === snap.portId)?.label ?? snap.portId;
              title = `${baseTitle} → ${snapDef?.label ?? 'node'}.${snapPortLabel}`;
            }
            return (
              <>
                <div className={styles.contextTitle}>{title}</div>
                {resolved.length === 0 && (
                  <div style={{ padding: '6px 10px', fontSize: '0.7rem', color: '#8090a0', fontStyle: 'italic' }}>
                    {snap ? 'No related node can connect there' : 'No related nodes'}
                  </div>
                )}
                {Array.from(grouped.entries()).map(([cat, items]) => (
                  <div key={cat}>
                    <div className={styles.contextCategory}>{cat}</div>
                    {items.map(({ entry, def, matchPort }) => (
                      <button
                        key={def.type}
                        className={styles.contextItem}
                        title={def.description}
                        onClick={e => {
                          e.stopPropagation();
                          const cfg: Record<string, string | number | boolean> = {
                            [entry.configKey]: elemId,
                            ...(entry.extraConfig ?? {}),
                          };
                          if (payload.kind === 'model-attribute') cfg.isColorAttr = payload.isColor;
                          if (snap) {
                            // Auto-connect path: snap-aligned spawn + wire.
                            const screenToFlow = (p: { x: number; y: number }) =>
                              rfInstance.current?.screenToFlowPosition(p) ?? p;
                            const targetScreen = getPortScreenCentre(
                              snap.nodeId, snap.portId, snap.kind, snap.category,
                            );
                            const flowFallback = { x: contextMenu.flowX, y: contextMenu.flowY };
                            const pos = matchPort
                              ? computeSnapPosition(snap, targetScreen, def, matchPort, screenToFlow, flowFallback)
                              : flowFallback;
                            const newId = addNodeAndConnect(def.type, pos, snap, cfg);
                            if (newId && matchPort) {
                              scheduleSnapRefinement(newId, snap, matchPort);
                            }
                          } else {
                            addNodeAtPosition(def.type, { x: contextMenu.flowX, y: contextMenu.flowY }, cfg);
                          }
                          setContextMenu(null);
                        }}
                      >
                        <span className={styles.contextDot} style={{ background: def.color }} />
                        {def.label}
                      </button>
                    ))}
                  </div>
                ))}
              </>
            );
          })()}

          {/* PANE context menu */}
          {contextMenu.target.type === 'pane' && (
            <>
              {clipboard && clipboard.nodes.length > 0 && (
                <button className={styles.contextItem} onClick={e => { e.stopPropagation(); handlePaste(); setContextMenu(null); }}>Paste</button>
              )}
              <button className={styles.contextItem} onClick={e => { e.stopPropagation(); addCommentNode(); }}>
                Add Comment
              </button>
              <button className={styles.contextItem} onClick={e => { e.stopPropagation(); createEmptyGroup(); }}>
                Add Group
              </button>
              <button
                className={styles.contextItem}
                title="Load a macro from a .gcamacro file and add it at this position"
                onClick={e => { e.stopPropagation(); triggerImportMacro(); }}
              >
                Import Macro&hellip;
              </button>
              <hr style={{ border: 'none', borderTop: '1px solid var(--color-border)', margin: '4px 0' }} />
              {renderQuickAddSearch('Search nodes… (Enter adds)', `No nodes${dropMenuSearch ? ' match' : ''}`)}
            </>
          )}

          {/* SINGLE NODE */}
          {contextMenu.target.type === 'node' && !contextMenu.target.isGroup && (
            <>
              <div className={styles.contextTitle}>Node</div>
              <button className={styles.contextItem} onClick={e => { e.stopPropagation(); renameNode(); }}>Rename</button>
              {contextMenu.target.isMacro ? (
                <div className={styles.contextSubmenuTrigger}>
                  <button className={styles.contextItem}>
                    Duplicate
                    <span style={{ marginLeft: 'auto', fontSize: '0.6rem', color: '#6080a0' }}>&rsaquo;</span>
                  </button>
                  <div className={styles.contextSubmenu}>
                    <button className={styles.contextItem} onClick={e => { e.stopPropagation(); duplicateNode(false); }}>Duplicate Independent</button>
                    <button className={styles.contextItem} onClick={e => { e.stopPropagation(); duplicateNode(true); }}>Duplicate Linked</button>
                  </div>
                </div>
              ) : (
                <button className={styles.contextItem} onClick={e => { e.stopPropagation(); duplicateNode(); }}>Duplicate</button>
              )}
              <button className={styles.contextItem} onClick={e => {
                e.stopPropagation();
                // Select this node then copy
                const nid = (contextMenu.target as { nodeId: string }).nodeId;
                setNodes(nds => nds.map(n => ({ ...n, selected: n.id === nid })));
                setTimeout(() => { handleCopy(); setContextMenu(null); }, 0);
              }}>Copy</button>
              <button className={styles.contextItem} onClick={e => {
                e.stopPropagation();
                const nid = (contextMenu.target as { nodeId: string }).nodeId;
                setNodes(nds => nds.map(n => ({ ...n, selected: n.id === nid })));
                setTimeout(() => { handleCut(); setContextMenu(null); }, 0);
              }}>Cut</button>
              <button className={styles.contextItem} onClick={e => { e.stopPropagation(); addCommentNode(); }}>Add Comment</button>
              {contextMenu.target.isMacro && (
                <>
                  <button className={styles.contextItem} onClick={e => { e.stopPropagation();
                    const nd = nodes.find(n => n.id === (contextMenu.target as { nodeId: string }).nodeId)?.data as Record<string, unknown>;
                    const mId = (nd?.config as Record<string, unknown>)?.macroDefId as string;
                    if (mId) setCurrentScope(prev => [...prev, mId]);
                    setContextMenu(null);
                  }}>Enter Macro</button>
                  <button className={styles.contextItem} onClick={e => { e.stopPropagation(); exportMacro(); }}>Export Macro&hellip;</button>
                  <button className={styles.contextItem} onClick={e => { e.stopPropagation(); undoMacro(); }}>Undo Macro</button>
                </>
              )}
              <button className={styles.contextItem} style={{ color: '#e05050' }} onClick={e => { e.stopPropagation(); deleteSelection(); }}>Delete</button>
            </>
          )}

          {/* GROUP NODE */}
          {contextMenu.target.type === 'node' && contextMenu.target.isGroup && (
            <>
              <div className={styles.contextTitle}>Group</div>
              <button className={styles.contextItem} onClick={e => { e.stopPropagation(); renameNode(); }}>Rename</button>
              <button className={styles.contextItem} style={{ color: '#e05050' }} onClick={e => { e.stopPropagation(); deleteSelection(); }}>Delete</button>
            </>
          )}

          {/* SELECTION */}
          {contextMenu.target.type === 'selection' && (
            <>
              <div className={styles.contextTitle}>Selection ({contextMenu.target.nodeIds.length})</div>
              <button className={styles.contextItem} onClick={e => { e.stopPropagation(); duplicateSelection(); setContextMenu(null); }}>Duplicate</button>
              <button className={styles.contextItem} onClick={e => { e.stopPropagation(); handleCopy(); setContextMenu(null); }}>Copy</button>
              <button className={styles.contextItem} onClick={e => { e.stopPropagation(); handleCut(); setContextMenu(null); }}>Cut</button>
              <button className={styles.contextItem} onClick={e => { e.stopPropagation(); handlePaste(); setContextMenu(null); }}>Paste</button>
              <hr style={{ border: 'none', borderTop: '1px solid var(--color-border)', margin: '4px 0' }} />
              <button className={styles.contextItem} onClick={e => { e.stopPropagation(); createMacroFromSelection(); }}>Create Macro</button>
              <button className={styles.contextItem} onClick={e => { e.stopPropagation(); createGroup(); }}>Create Group</button>
              <hr style={{ border: 'none', borderTop: '1px solid var(--color-border)', margin: '4px 0' }} />
              <div className={styles.contextSubmenuTrigger}>
                <button className={styles.contextItem}>
                  Align
                  <span style={{ marginLeft: 'auto', fontSize: '0.6rem', color: '#6080a0' }}>&rsaquo;</span>
                </button>
                <div className={styles.contextSubmenu}>
                  <div className={styles.contextCategory}>Horizontally</div>
                  <button className={styles.contextItem} onClick={e => { e.stopPropagation(); alignNodes('left'); }}>Left</button>
                  <button className={styles.contextItem} onClick={e => { e.stopPropagation(); alignNodes('centerH'); }}>Center</button>
                  <button className={styles.contextItem} onClick={e => { e.stopPropagation(); alignNodes('right'); }}>Right</button>
                  <div className={styles.contextCategory}>Vertically</div>
                  <button className={styles.contextItem} onClick={e => { e.stopPropagation(); alignNodes('top'); }}>Top</button>
                  <button className={styles.contextItem} onClick={e => { e.stopPropagation(); alignNodes('centerV'); }}>Center</button>
                  <button className={styles.contextItem} onClick={e => { e.stopPropagation(); alignNodes('bottom'); }}>Bottom</button>
                </div>
              </div>
              <div className={styles.contextSubmenuTrigger}>
                <button className={styles.contextItem}>
                  Distribute
                  <span style={{ marginLeft: 'auto', fontSize: '0.6rem', color: '#6080a0' }}>&rsaquo;</span>
                </button>
                <div className={styles.contextSubmenu}>
                  <button className={styles.contextItem} onClick={e => { e.stopPropagation(); distributeNodes('h'); }}>Horizontally</button>
                  <button className={styles.contextItem} onClick={e => { e.stopPropagation(); distributeNodes('v'); }}>Vertically</button>
                </div>
              </div>
              <hr style={{ border: 'none', borderTop: '1px solid var(--color-border)', margin: '4px 0' }} />
              <button className={styles.contextItem} style={{ color: '#e05050' }} onClick={e => { e.stopPropagation(); deleteSelection(); }}>
                Delete Selection
              </button>
            </>
          )}
        </div>
      )}
      {pendingMultiDelete && (
        <ConfirmDialog
          title={`Delete ${pendingMultiDelete.length} elements?`}
          message="The selected nodes and their connections will be removed from the graph."
          confirmLabel="Delete"
          danger
          onConfirm={() => {
            const ids = pendingMultiDelete;
            setPendingMultiDelete(null);
            performDeleteNodes(ids);
          }}
          onCancel={() => setPendingMultiDelete(null)}
        />
      )}
      {namePrompt && (() => {
        // namePrompt.x/y come from contextMenu, which stores coords relative to
        // the .react-flow element. The dialog is position:fixed, so add the
        // wrapper's viewport offset to anchor it at the true click point.
        const rfRect = document.querySelector('.react-flow')?.getBoundingClientRect();
        return (
          <NameInputDialog
            title={namePrompt.title}
            fieldLabel={namePrompt.fieldLabel}
            initialValue={namePrompt.initialValue}
            placeholder={namePrompt.placeholder}
            confirmLabel={namePrompt.confirmLabel}
            allowEmpty={namePrompt.allowEmpty}
            anchorX={namePrompt.x + (rfRect?.left ?? 0)}
            anchorY={namePrompt.y + (rfRect?.top ?? 0)}
            onConfirm={v => { namePrompt.resolve(v); setNamePrompt(null); }}
            onCancel={() => { namePrompt.resolve(null); setNamePrompt(null); }}
          />
        );
      })()}
    </div>
  );
}

export function GraphEditor() {
  return (
    <ReactFlowProvider>
      <GraphEditorInner />
    </ReactFlowProvider>
  );
}
