import { useCallback, useEffect, useRef, useState } from 'react';
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
} from '@xyflow/react';
import type { Connection, Edge, Node, NodeTypes, ReactFlowInstance, SelectionMode, IsValidConnection, OnConnectStart } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { CaNode } from './CaNode';
import { CommentNodeComponent } from './CommentNodeComponent';
import { GroupNodeComponent } from './GroupNodeComponent';
import { useModel } from '../../model/ModelContext';
import { getNodeDefsByCategory, getNodeDef } from './nodes/registry';
import { parseHandleId, handleId } from './types';
import type { GraphNode, GraphEdge } from '../../model/types';
import type { MacroPort } from '../../model/types';
import styles from './GraphEditor.module.css';

const nodeTypes: NodeTypes = {
  caNode: CaNode,
  commentNode: CommentNodeComponent,
  groupNode: GroupNodeComponent,
};

// ---------------------------------------------------------------------------
// Clipboard for copy/paste (module-level, persists across re-renders)
// ---------------------------------------------------------------------------

let clipboard: { nodes: GraphNode[]; edges: GraphEdge[] } | null = null;

import { setIsConnecting, setConnectingFrom, setShowPortLabels } from './graphState';

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
// Conversion helpers
// ---------------------------------------------------------------------------

function toRFNodes(graphNodes: GraphNode[]): Node[] {
  return graphNodes.map(n => {
    const rfNode: Node = {
      id: n.id,
      type: n.type === 'groupNode' ? 'groupNode' : n.type === 'commentNode' ? 'commentNode' : 'caNode',
      position: n.position,
      data: n.data,
    };
    const d = n.data as Record<string, unknown>;
    if (d.parentId) rfNode.parentId = d.parentId as string;
    if (n.type === 'groupNode') {
      rfNode.style = { width: (d.width as number) || 300, height: (d.height as number) || 200 };
      rfNode.zIndex = -1;
      rfNode.dragHandle = '[data-drag-handle]';
    }
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
    style: { stroke: '#4cc9f0', strokeWidth: 2 },
    animated: e.sourceHandle.includes('flow'),
  }));
}

function toGraphNodes(rfNodes: Node[]): GraphNode[] {
  return rfNodes.map(n => ({
    id: n.id,
    type: n.type ?? 'caNode',
    position: n.position,
    data: {
      ...(n.data as GraphNode['data']),
      ...(n.parentId ? { parentId: n.parentId } : {}),
      ...(n.type === 'groupNode' && n.style ? { width: (n.style as Record<string, number>).width, height: (n.style as Record<string, number>).height } : {}),
    },
  }));
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
    | { type: 'selection'; nodeIds: string[] };
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function GraphEditorInner() {
  const { model, modelVersion, setGraph, addMacro, updateMacro, removeMacro } = useModel();
  const [nodes, setNodes, onNodesChange] = useNodesState(toRFNodes(model.graphNodes));
  const [edges, setEdges, onEdgesChange] = useEdgesState(toRFEdges(model.graphEdges));
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [currentScope, setCurrentScope] = useState<string[]>(['root']);
  const [showGrid, setShowGrid] = useState(true);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [portLabelsVisible, setPortLabelsVisible] = useState(true);
  const rfInstance = useRef<ReactFlowInstance | null>(null);
  const { deleteElements, getNodes, updateNodeData } = useReactFlow();

  // Ref for paste position (flow coords of last right-click or viewport center for Ctrl+V)
  const pasteFlowPos = useRef<{ x: number; y: number } | null>(null);

  // Refs for debounced sync
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  useEffect(() => { edgesRef.current = edges; }, [edges]);

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

  // Switch displayed graph when scope changes
  useEffect(() => {
    const scopeId = currentScope[currentScope.length - 1];
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
    // Fit view after scope change
    setTimeout(() => rfInstance.current?.fitView(), 50);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentScope, modelVersion]);

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

      // Prevent connecting to an already-connected value input
      if (tgtParsed.category === 'value') {
        const currentEdges = edgesRef.current;
        const alreadyConnected = currentEdges.some(
          e => e.target === connection.target && e.targetHandle === connection.targetHandle,
        );
        if (alreadyConnected) return false;
      }

      // Cycle detection: BFS from target to see if it can reach source
      const currentEdges = edgesRef.current;
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
      setEdges(eds => addEdge(
        {
          ...connection,
          style: { stroke: '#4cc9f0', strokeWidth: 2 },
          animated: connection.sourceHandle?.includes('flow') ?? false,
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
      onNodesChange(changes);

      // Auto-resize groups to always cover all children (all 4 sides)
      const hasPositionEnd = changes.some(
        c => c.type === 'position' && 'dragging' in c && !c.dragging,
      );
      if (hasPositionEnd) {
        setNodes(nds => {
          const groups = nds.filter(n => n.type === 'groupNode');
          if (groups.length === 0) return nds;
          let changed = false;
          const nodeW = 200; // approximate node width
          const nodeH = 100; // approximate node height
          const pad = 30;
          const topPad = 40; // extra for group header

          const updated = nds.map(n => {
            if (n.type !== 'groupNode') return n;
            const children = nds.filter(c => c.parentId === n.id);
            if (children.length === 0) return n;

            // Bounding box of children in parent-relative coords
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const c of children) {
              minX = Math.min(minX, c.position.x);
              minY = Math.min(minY, c.position.y);
              maxX = Math.max(maxX, c.position.x + nodeW);
              maxY = Math.max(maxY, c.position.y + nodeH);
            }

            // If any child is outside the group bounds, adjust
            const needsLeft = minX < pad;
            const needsTop = minY < topPad;
            const curStyle = n.style as Record<string, number> | undefined;
            const curW = curStyle?.width || 300;
            const curH = curStyle?.height || 200;
            const needsRight = maxX + pad > curW;
            const needsBottom = maxY + pad > curH;

            if (!needsLeft && !needsTop && !needsRight && !needsBottom) return n;
            changed = true;

            // Shift amount for left/top expansion
            const shiftX = needsLeft ? pad - minX : 0;
            const shiftY = needsTop ? topPad - minY : 0;

            const newW = Math.max(curW, maxX + pad) + shiftX;
            const newH = Math.max(curH, maxY + pad) + shiftY;

            return {
              ...n,
              // Move group origin to accommodate left/top spill
              position: {
                x: n.position.x - shiftX,
                y: n.position.y - shiftY,
              },
              style: { ...n.style, width: newW, height: newH },
            };
          });

          // Also shift children's positions if group moved
          if (changed) {
            return updated.map(n => {
              if (!n.parentId) return n;
              const parentBefore = nds.find(p => p.id === n.parentId);
              const parentAfter = updated.find(p => p.id === n.parentId);
              if (!parentBefore || !parentAfter) return n;
              const dx = parentBefore.position.x - parentAfter.position.x;
              const dy = parentBefore.position.y - parentAfter.position.y;
              if (dx === 0 && dy === 0) return n;
              return { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } };
            });
          }
          return nds;
        });
      }

      const needsSync = changes.some(
        c => c.type === 'remove' ||
             (c.type === 'position' && 'dragging' in c && !c.dragging) ||
             c.type === 'dimensions',
      );
      if (needsSync) scheduleSync();
    },
    [onNodesChange, setNodes, scheduleSync],
  );

  const handleEdgesChange = useCallback(
    (changes: Parameters<typeof onEdgesChange>[0]) => {
      onEdgesChange(changes);
      if (changes.some(c => c.type === 'remove')) scheduleSync();
    },
    [onEdgesChange, scheduleSync],
  );

  // --- Unified context menu ---
  const openContextMenu = useCallback(
    (event: MouseEvent | React.MouseEvent, nodeId?: string) => {
      event.preventDefault();
      const bounds = (event.target as HTMLElement).closest('.react-flow')?.getBoundingClientRect();
      const rf = rfInstance.current;
      if (!bounds || !rf) return;
      const position = rf.screenToFlowPosition({ x: event.clientX, y: event.clientY });

      const selectedNodes = getNodes().filter(n => n.selected);

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
    [getNodes],
  );

  const onPaneContextMenu = useCallback(
    (event: MouseEvent | React.MouseEvent) => openContextMenu(event),
    [openContextMenu],
  );

  const onNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: Node) => {
      event.stopPropagation();
      openContextMenu(event, node.id);
    },
    [openContextMenu],
  );

  // --- Context menu actions ---

  const addNode = useCallback(
    (nodeType: string) => {
      if (!contextMenu) return;
      const def = getNodeDef(nodeType);
      if (!def) return;
      setNodes(nds => {
        const id = generateNodeId(nds);
        const newNode: Node = {
          id,
          type: 'caNode',
          position: { x: contextMenu.flowX, y: contextMenu.flowY },
          data: { nodeType: def.type, config: { ...def.defaultConfig } },
        };
        return [...nds, newNode];
      });
      scheduleSync();
      setContextMenu(null);
    },
    [contextMenu, setNodes, scheduleSync],
  );

  const duplicateNode = useCallback(() => {
    if (!contextMenu || contextMenu.target.type !== 'node') return;
    const targetNodeId = contextMenu.target.type === 'node' ? contextMenu.target.nodeId : '';
    const sourceNode = nodes.find(n => n.id === targetNodeId);
    if (!sourceNode) return;
    setNodes(nds => {
      const id = generateNodeId(nds);
      return [...nds, {
        id,
        type: sourceNode.type,
        position: { x: sourceNode.position.x + 30, y: sourceNode.position.y + 30 },
        data: JSON.parse(JSON.stringify(sourceNode.data)),
      }];
    });
    scheduleSync();
    setContextMenu(null);
  }, [contextMenu, nodes, setNodes, scheduleSync]);

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
    if (nodeIds.length > 1) {
      if (!window.confirm(`Delete ${nodeIds.length} selected elements?`)) {
        setContextMenu(null);
        return;
      }
    }
    deleteElements({ nodes: nodeIds.map(id => ({ id })) });
    scheduleSync();
    setContextMenu(null);
  }, [contextMenu, nodes, deleteElements, scheduleSync]);

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

    // Compute clipboard bounding-box center (top-level nodes only)
    const topLevel = clipboard.nodes.filter(n => {
      const d = n.data as Record<string, unknown>;
      return !d.parentId;
    });
    let cx = 0, cy = 0;
    if (topLevel.length > 0) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of topLevel) {
        minX = Math.min(minX, n.position.x);
        minY = Math.min(minY, n.position.y);
        maxX = Math.max(maxX, n.position.x + 200);
        maxY = Math.max(maxY, n.position.y + 100);
      }
      cx = (minX + maxX) / 2;
      cy = (minY + maxY) / 2;
    }

    // Determine paste target position
    let target: { x: number; y: number };
    if (pasteFlowPos.current) {
      target = pasteFlowPos.current;
      pasteFlowPos.current = null;
    } else {
      // Ctrl+V: use viewport center
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

    const pastedRFNodes: Node[] = clipboard.nodes.map(n => {
      const clonedData = JSON.parse(JSON.stringify(n.data)) as Record<string, unknown>;
      const oldParentId = clonedData.parentId as string | undefined;
      const newParentId = oldParentId ? idMap.get(oldParentId) : undefined;
      if (newParentId) {
        clonedData.parentId = newParentId;
      } else {
        delete clonedData.parentId;
      }
      return {
        id: idMap.get(n.id)!,
        type: n.type === 'groupNode' ? 'groupNode' : n.type === 'commentNode' ? 'commentNode' : 'caNode',
        position: newParentId
          ? { x: n.position.x, y: n.position.y }
          : { x: n.position.x + offsetX, y: n.position.y + offsetY },
        data: clonedData,
        selected: true,
        ...(newParentId ? { parentId: newParentId } : {}),
        ...(n.type === 'groupNode' ? { style: { width: (clonedData.width as number) || 300, height: (clonedData.height as number) || 200 }, zIndex: -1, dragHandle: '[data-drag-handle]' } : {}),
      };
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
        style: { stroke: '#4cc9f0', strokeWidth: 2 },
        animated: e.sourceHandle.includes('flow'),
      }));

    // Sort so group nodes come before their children (React Flow requires parent first)
    pastedRFNodes.sort((a, b) => {
      if (a.type === 'groupNode' && b.parentId === a.id) return -1;
      if (b.type === 'groupNode' && a.parentId === b.id) return 1;
      return 0;
    });

    // Deselect existing, add pasted
    setNodes(nds => [...nds.map(n => ({ ...n, selected: false })), ...pastedRFNodes]);
    setEdges(eds => [...eds, ...pastedRFEdges]);
    scheduleSync();
  }, [nodes, setNodes, setEdges, scheduleSync]);

  const duplicateSelection = useCallback(() => {
    const selected = nodes.filter(n => n.selected);
    if (selected.length === 0) return;
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

    const dupeNodes: Node[] = srcNodes.map(n => {
      const clonedData = JSON.parse(JSON.stringify(n.data)) as Record<string, unknown>;
      const oldParentId = clonedData.parentId as string | undefined;
      const newParentId = oldParentId ? idMap.get(oldParentId) : undefined;
      if (newParentId) { clonedData.parentId = newParentId; } else { delete clonedData.parentId; }
      return {
        id: idMap.get(n.id)!,
        type: n.type === 'groupNode' ? 'groupNode' : n.type === 'commentNode' ? 'commentNode' : 'caNode',
        position: newParentId
          ? { x: n.position.x, y: n.position.y }
          : { x: n.position.x + 30, y: n.position.y + 30 },
        data: clonedData,
        selected: true,
        ...(newParentId ? { parentId: newParentId } : {}),
        ...(n.type === 'groupNode' ? { style: { width: (clonedData.width as number) || 300, height: (clonedData.height as number) || 200 }, zIndex: -1, dragHandle: '[data-drag-handle]' } : {}),
      };
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
        style: { stroke: '#4cc9f0', strokeWidth: 2 },
        animated: e.sourceHandle.includes('flow'),
      }));

    dupeNodes.sort((a, b) => {
      if (a.type === 'groupNode' && b.parentId === a.id) return -1;
      if (b.type === 'groupNode' && a.parentId === b.id) return 1;
      return 0;
    });

    setNodes(nds => [...nds.map(n => ({ ...n, selected: false })), ...dupeNodes]);
    setEdges(eds => [...eds, ...dupeEdges]);
    scheduleSync();
  }, [nodes, edges, setNodes, setEdges, scheduleSync]);

  const handleCut = useCallback(() => {
    handleCopy();
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
      if (mod && e.key === 'c') { handleCopy(); e.preventDefault(); }
      if (mod && e.key === 'v') { handlePaste(); e.preventDefault(); }
      if (mod && e.key === 'x') { handleCut(); e.preventDefault(); }
      if (mod && e.key === 'd') { duplicateSelection(); e.preventDefault(); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [handleCopy, handlePaste, handleCut, duplicateSelection]);

  const renameNode = useCallback(() => {
    if (!contextMenu || contextMenu.target.type !== 'node') return;
    const nodeId = contextMenu.target.nodeId;
    const name = window.prompt('Node name:', '');
    if (name === null) { setContextMenu(null); return; }
    setNodes(nds => nds.map(n =>
      n.id === nodeId ? { ...n, data: { ...n.data, label: name || undefined } } : n,
    ));
    scheduleSync();
    setContextMenu(null);
  }, [contextMenu, setNodes, scheduleSync]);

  const addCommentNode = useCallback(() => {
    if (!contextMenu) return;
    setNodes(nds => {
      const id = generateNodeId(nds);
      return [...nds, {
        id,
        type: 'commentNode',
        position: { x: contextMenu.flowX, y: contextMenu.flowY - 40 },
        data: { text: 'Comment' },
      }];
    });
    scheduleSync();
    setContextMenu(null);
  }, [contextMenu, setNodes, scheduleSync]);

  // --- Group actions ---

  const createGroup = useCallback(() => {
    if (!contextMenu || contextMenu.target.type !== 'selection') return;
    const name = window.prompt('Group name:', 'Group');
    if (!name) { setContextMenu(null); return; }
    const selectedIds = new Set(contextMenu.target.nodeIds);
    const selectedNodes = nodes.filter(n => selectedIds.has(n.id));
    if (selectedNodes.length < 2) return;

    // Compute bounding box
    const pad = 40;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of selectedNodes) {
      minX = Math.min(minX, n.position.x);
      minY = Math.min(minY, n.position.y);
      maxX = Math.max(maxX, n.position.x + 200); // approximate node width
      maxY = Math.max(maxY, n.position.y + 100); // approximate node height
    }

    setNodes(nds => {
      const groupId = generateNodeId(nds);
      const groupNode: Node = {
        id: groupId,
        type: 'groupNode',
        position: { x: minX - pad, y: minY - pad - 20 },
        data: { label: name, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 + 20, nodeType: 'group', config: {} },
        style: { width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 + 20 },
        zIndex: -1,
        dragHandle: '[data-drag-handle]',
      };
      // Reparent selected nodes
      const updated = nds.map(n => {
        if (selectedIds.has(n.id)) {
          return {
            ...n,
            parentId: groupId,
            position: {
              x: n.position.x - (minX - pad),
              y: n.position.y - (minY - pad - 20),
            },
          };
        }
        return n;
      });
      return [groupNode, ...updated];
    });
    scheduleSync();
    setContextMenu(null);
  }, [contextMenu, nodes, setNodes, scheduleSync]);

  const dismissGroup = useCallback(() => {
    if (!contextMenu || contextMenu.target.type !== 'node' || !contextMenu.target.isGroup) return;
    const groupId = contextMenu.target.nodeId;
    // Use getNodes() for fresh positions (avoids stale closure after auto-resize)
    const freshNodes = getNodes();
    const groupNode = freshNodes.find(n => n.id === groupId);
    if (!groupNode) return;

    setNodes(nds => {
      // Convert child positions back to absolute, select ungrouped children
      // Use fresh child positions from getNodes() for accuracy
      const freshMap = new Map(freshNodes.map(n => [n.id, n]));
      const updated = nds
        .filter(n => n.id !== groupId)
        .map(n => {
          if (n.parentId === groupId) {
            const fresh = freshMap.get(n.id);
            const childPos = fresh?.position ?? n.position;
            return {
              ...n,
              parentId: undefined,
              selected: true,
              position: {
                x: childPos.x + groupNode.position.x,
                y: childPos.y + groupNode.position.y,
              },
            };
          }
          return { ...n, selected: false };
        });
      return updated;
    });
    scheduleSync();
    setContextMenu(null);
  }, [contextMenu, getNodes, setNodes, scheduleSync]);

  // --- Macro actions ---

  const createMacroFromSelection = useCallback(() => {
    if (!contextMenu || contextMenu.target.type !== 'selection') return;
    const selectedIds = new Set(contextMenu.target.nodeIds);
    const selectedNodes = nodes.filter(n => selectedIds.has(n.id) && n.type !== 'commentNode' && n.type !== 'groupNode');
    if (selectedNodes.length < 2) {
      alert('Select at least 2 nodes to create a macro.');
      setContextMenu(null);
      return;
    }
    const name = window.prompt('Macro name:', 'New Macro');
    if (!name) { setContextMenu(null); return; }

    const internalEdges = edges.filter(e => selectedIds.has(e.source) && selectedIds.has(e.target));
    const externalInputEdges = edges.filter(e => !selectedIds.has(e.source) && selectedIds.has(e.target));
    const externalOutputEdges = edges.filter(e => selectedIds.has(e.source) && !selectedIds.has(e.target));

    const macroId = `macro_${Date.now().toString(36)}`;

    // Compute bounding box of selected nodes for MacroInput/MacroOutput positioning
    const selXs = selectedNodes.map(n => n.position.x);
    const selYs = selectedNodes.map(n => n.position.y);
    const minX = Math.min(...selXs);
    const maxX = Math.max(...selXs);
    const midY = (Math.min(...selYs) + Math.max(...selYs)) / 2;

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

    // MacroInput/MacroOutput boundary nodes
    const macroInputGraphNode: GraphNode = {
      id: macroInputNodeId,
      type: 'caNode',
      position: { x: minX - 250, y: midY },
      data: { nodeType: 'macroInput', config: { macroDefId: macroId } },
    };
    const macroOutputGraphNode: GraphNode = {
      id: macroOutputNodeId,
      type: 'caNode',
      position: { x: maxX + 100, y: midY },
      data: { nodeType: 'macroOutput', config: { macroDefId: macroId } },
    };

    addMacro({
      id: macroId, name,
      nodes: [...toGraphNodes(selectedNodes), macroInputGraphNode, macroOutputGraphNode],
      edges: [...toGraphEdges(internalEdges), ...bridgingInputEdges, ...bridgingOutputEdges],
      exposedInputs, exposedOutputs,
    });

    const avgX = selectedNodes.reduce((s, n) => s + n.position.x, 0) / selectedNodes.length;
    const avgY = selectedNodes.reduce((s, n) => s + n.position.y, 0) / selectedNodes.length;

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
        style: { stroke: '#4cc9f0', strokeWidth: 2 },
        animated: exposedInputs[i]!.category === 'flow',
      })),
      ...externalOutputEdges.map((e, i) => ({
        id: `${macroNodeId}_eout_${i}`,
        source: macroNodeId,
        sourceHandle: handleId({ id: `out_${i}`, kind: 'output', category: exposedOutputs[i]!.category }),
        target: e.target,
        targetHandle: e.targetHandle,
        style: { stroke: '#4cc9f0', strokeWidth: 2 },
        animated: exposedOutputs[i]!.category === 'flow',
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
  }, [contextMenu, nodes, edges, addMacro, setNodes, setEdges, scheduleSync]);

  // Track whether a connection is being dragged (for hover-to-uncollapse)
  const isConnecting = useRef(false);
  const onConnectStart: OnConnectStart = useCallback((_event, params) => {
    isConnecting.current = true;
    setIsConnecting(true);
    if (params.handleId) {
      const parsed = parseHandleId(params.handleId);
      if (parsed && params.nodeId) {
        setConnectingFrom({ category: parsed.category, nodeId: params.nodeId });
      }
    }
  }, []);
  const onConnectEnd = useCallback(() => {
    isConnecting.current = false;
    setIsConnecting(false);
    setConnectingFrom(null);
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

    // Restore subgraph nodes at macro node's position (excluding boundary nodes)
    const offsetX = macroNode.position.x;
    const offsetY = macroNode.position.y;
    const restoredRFNodes: Node[] = macroDef.nodes
      .filter(n => !boundaryNodeIds.has(n.id))
      .map(n => ({
        id: n.id,
        type: n.type === 'groupNode' ? 'groupNode' : n.type === 'commentNode' ? 'commentNode' : 'caNode',
        position: { x: n.position.x + offsetX, y: n.position.y + offsetY },
        data: n.data,
        selected: true,
      }));

    // Restore only internal edges (exclude bridging edges touching boundary nodes)
    const restoredRFEdges: Edge[] = macroDef.edges
      .filter(e => !boundaryNodeIds.has(e.source) && !boundaryNodeIds.has(e.target))
      .map(e => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle,
        targetHandle: e.targetHandle,
        style: { stroke: '#4cc9f0', strokeWidth: 2 },
        animated: e.sourceHandle.includes('flow'),
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

    // Remove macro definition
    removeMacro(macroDefId);
    scheduleSync();
    setContextMenu(null);
  }, [contextMenu, getNodes, edges, model.macroDefs, removeMacro, setNodes, setEdges, scheduleSync]);

  // Sync on node data changes
  const onNodeDataChange = useCallback(() => {
    scheduleSync();
  }, [scheduleSync]);

  const categories = getNodeDefsByCategory();

  return (
    <div className={styles.editor} onClick={() => setContextMenu(null)} onChangeCapture={onNodeDataChange}>
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
        onPaneContextMenu={onPaneContextMenu}
        onNodeContextMenu={onNodeContextMenu}
        onNodeDoubleClick={onNodeDoubleClick}
        onEdgeDoubleClick={(_event, edge) => { setEdges(eds => eds.filter(e => e.id !== edge.id)); scheduleSync(); }}
        nodeTypes={nodeTypes}
        fitView
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
        {showGrid && <Background color="#1a2538" gap={20} variant={BackgroundVariant.Lines} />}
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
            onClick={() => setShowGrid(v => !v)}
            title="Toggle grid"
          >
            #
          </button>
          <button
            className={`${styles.toggleButton} ${snapEnabled ? styles.toggleActive : ''}`}
            onClick={() => setSnapEnabled(v => !v)}
            title="Toggle snap to grid"
          >
            &loz;
          </button>
        </div>
        <MiniMap
          nodeColor={n => n.type === 'groupNode' ? 'rgba(45,64,89,0.5)' : '#2d4059'}
          maskColor="rgba(0, 0, 0, 0.7)"
          style={{ background: '#0d1117' }}
        />
      </ReactFlow>

      {/* Unified context menu */}
      {contextMenu && (
        <div
          className={styles.contextMenu}
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {/* PANE context menu */}
          {contextMenu.target.type === 'pane' && (
            <>
              {clipboard && clipboard.nodes.length > 0 && (
                <button className={styles.contextItem} onClick={e => { e.stopPropagation(); handlePaste(); setContextMenu(null); }}>Paste</button>
              )}
              <button className={styles.contextItem} onClick={e => { e.stopPropagation(); addCommentNode(); }}>
                Add Comment
              </button>
              <hr style={{ border: 'none', borderTop: '1px solid #2d4059', margin: '4px 0' }} />
              <div className={styles.contextSubmenuTrigger}>
                <button className={styles.contextItem}>
                  Add Node
                  <span style={{ marginLeft: 'auto', fontSize: '0.6rem', color: '#6080a0' }}>&rsaquo;</span>
                </button>
                <div className={styles.contextSubmenu}>
                  {Array.from(categories.entries()).map(([cat, defs]) => (
                    <div key={cat}>
                      <div className={styles.contextCategory}>{cat}</div>
                      {defs.map(def => (
                        <button
                          key={def.type}
                          className={styles.contextItem}
                          onClick={e => { e.stopPropagation(); addNode(def.type); }}
                        >
                          <span className={styles.contextDot} style={{ background: def.color }} />
                          {def.label}
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* SINGLE NODE */}
          {contextMenu.target.type === 'node' && !contextMenu.target.isGroup && (
            <>
              <div className={styles.contextTitle}>Node</div>
              <button className={styles.contextItem} onClick={e => { e.stopPropagation(); renameNode(); }}>Rename</button>
              <button className={styles.contextItem} onClick={e => { e.stopPropagation(); duplicateNode(); }}>Duplicate</button>
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
              <button className={styles.contextItem} onClick={e => { e.stopPropagation(); dismissGroup(); }}>Undo Group</button>
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
              <hr style={{ border: 'none', borderTop: '1px solid #2d4059', margin: '4px 0' }} />
              <button className={styles.contextItem} onClick={e => { e.stopPropagation(); createMacroFromSelection(); }}>Create Macro</button>
              <button className={styles.contextItem} onClick={e => { e.stopPropagation(); createGroup(); }}>Create Group</button>
              <button className={styles.contextItem} style={{ color: '#e05050' }} onClick={e => { e.stopPropagation(); deleteSelection(); }}>
                Delete Selection
              </button>
            </>
          )}
        </div>
      )}
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
