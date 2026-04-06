import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ReactFlowProvider,
} from '@xyflow/react';
import type { Connection, Edge, Node, NodeTypes, ReactFlowInstance, SelectionMode } from '@xyflow/react';
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

function GraphEditorInner() {
  const { model, setGraph, addMacro, updateMacro, removeMacro } = useModel();
  const [nodes, setNodes, onNodesChange] = useNodesState(toRFNodes(model.graphNodes));
  const [edges, setEdges, onEdgesChange] = useEdgesState(toRFEdges(model.graphEdges));
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [currentScope, setCurrentScope] = useState<string[]>(['root']);
  const rfInstance = useRef<ReactFlowInstance | null>(null);
  const { deleteElements, getNodes } = useReactFlow();

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
  }, [currentScope]);

  // --- Connection handler ---
  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges(eds => {
        const isValueInput = connection.targetHandle?.includes('_value_');
        let filtered = eds;
        if (isValueInput) {
          filtered = eds.filter(
            e => !(e.target === connection.target && e.targetHandle === connection.targetHandle),
          );
        }
        return addEdge(
          {
            ...connection,
            style: { stroke: '#4cc9f0', strokeWidth: 2 },
            animated: connection.sourceHandle?.includes('flow') ?? false,
          },
          filtered,
        );
      });
      scheduleSync();
    },
    [setEdges, scheduleSync],
  );

  const handleNodesChange = useCallback(
    (changes: Parameters<typeof onNodesChange>[0]) => {
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
    if (nodeIds.length > 1) {
      if (!window.confirm(`Delete ${nodeIds.length} selected elements?`)) {
        setContextMenu(null);
        return;
      }
    }
    deleteElements({ nodes: nodeIds.map(id => ({ id })) });
    scheduleSync();
    setContextMenu(null);
  }, [contextMenu, deleteElements, scheduleSync]);

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
    const groupNode = nodes.find(n => n.id === groupId);
    if (!groupNode) return;

    setNodes(nds => {
      // Convert child positions back to absolute
      const updated = nds
        .filter(n => n.id !== groupId)
        .map(n => {
          if (n.parentId === groupId) {
            return {
              ...n,
              parentId: undefined,
              position: {
                x: n.position.x + groupNode.position.x,
                y: n.position.y + groupNode.position.y,
              },
            };
          }
          return n;
        });
      return updated;
    });
    scheduleSync();
    setContextMenu(null);
  }, [contextMenu, nodes, setNodes, scheduleSync]);

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

    // Build exposed ports with internal mapping info
    const exposedInputs: MacroPort[] = externalInputEdges.map((e, i) => {
      const parsed = parseHandleId(e.targetHandle ?? '');
      return {
        portId: `in_${i}`,
        label: `Input ${i + 1}`,
        dataType: 'any',
        category: (parsed?.category || 'value') as 'value' | 'flow',
        internalNodeId: e.target,
        internalPortId: parsed?.portId || '',
      };
    });
    const exposedOutputs: MacroPort[] = externalOutputEdges.map((e, i) => {
      const parsed = parseHandleId(e.sourceHandle ?? '');
      return {
        portId: `out_${i}`,
        label: `Output ${i + 1}`,
        dataType: 'any',
        category: (parsed?.category || 'value') as 'value' | 'flow',
        internalNodeId: e.source,
        internalPortId: parsed?.portId || '',
      };
    });

    addMacro({
      id: macroId, name,
      nodes: toGraphNodes(selectedNodes),
      edges: toGraphEdges(internalEdges),
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

  // Double-click macro to enter
  const onNodeDoubleClick = useCallback((_event: React.MouseEvent, node: Node) => {
    const nodeData = node.data as Record<string, unknown>;
    if (nodeData.nodeType === 'macro') {
      const macroDefId = (nodeData.config as Record<string, unknown>)?.macroDefId as string;
      if (macroDefId) setCurrentScope(prev => [...prev, macroDefId]);
    }
  }, []);

  const navigateToScope = useCallback((index: number) => {
    setCurrentScope(prev => prev.slice(0, index + 1));
  }, []);

  // Undo Macro — restore subgraph inline
  const undoMacro = useCallback(() => {
    if (!contextMenu || contextMenu.target.type !== 'node' || !contextMenu.target.isMacro) return;
    const macroNodeId = contextMenu.target.nodeId;
    const macroNode = nodes.find(n => n.id === macroNodeId);
    if (!macroNode) { setContextMenu(null); return; }

    const nodeData = macroNode.data as Record<string, unknown>;
    const macroDefId = (nodeData.config as Record<string, unknown>)?.macroDefId as string;
    const macroDef = (model.macroDefs || []).find(m => m.id === macroDefId);
    if (!macroDef) { setContextMenu(null); return; }

    // Restore subgraph nodes at macro node's position
    const offsetX = macroNode.position.x;
    const offsetY = macroNode.position.y;
    const restoredRFNodes: Node[] = macroDef.nodes.map(n => ({
      id: n.id,
      type: n.type === 'groupNode' ? 'groupNode' : n.type === 'commentNode' ? 'commentNode' : 'caNode',
      position: { x: n.position.x + offsetX, y: n.position.y + offsetY },
      data: n.data,
    }));
    const restoredRFEdges: Edge[] = macroDef.edges.map(e => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle,
      targetHandle: e.targetHandle,
      style: { stroke: '#4cc9f0', strokeWidth: 2 },
      animated: e.sourceHandle.includes('flow'),
    }));

    // Reconnect external edges back to internal nodes
    const edgesToMacro = edges.filter(e => e.target === macroNodeId);
    const edgesFromMacro = edges.filter(e => e.source === macroNodeId);

    const reconnectedInputEdges: Edge[] = edgesToMacro.map(e => {
      const parsed = parseHandleId(e.targetHandle ?? '');
      const portId = parsed?.portId || '';
      const exposedPort = macroDef.exposedInputs.find(p => p.portId === portId);
      if (!exposedPort) return null;
      return {
        ...e,
        id: `restored_${e.id}`,
        target: exposedPort.internalNodeId,
        targetHandle: handleId({ id: exposedPort.internalPortId, kind: 'input', category: exposedPort.category }),
      };
    }).filter(Boolean) as Edge[];

    const reconnectedOutputEdges: Edge[] = edgesFromMacro.map(e => {
      const parsed = parseHandleId(e.sourceHandle ?? '');
      const portId = parsed?.portId || '';
      const exposedPort = macroDef.exposedOutputs.find(p => p.portId === portId);
      if (!exposedPort) return null;
      return {
        ...e,
        id: `restored_${e.id}`,
        source: exposedPort.internalNodeId,
        sourceHandle: handleId({ id: exposedPort.internalPortId, kind: 'output', category: exposedPort.category }),
      };
    }).filter(Boolean) as Edge[];

    // Remove macro node and its edges, add restored subgraph
    setNodes(nds => [...nds.filter(n => n.id !== macroNodeId), ...restoredRFNodes]);
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
  }, [contextMenu, nodes, edges, model.macroDefs, removeMacro, setNodes, setEdges, scheduleSync]);

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
        onInit={instance => { rfInstance.current = instance; }}
        onPaneContextMenu={onPaneContextMenu}
        onNodeContextMenu={onNodeContextMenu}
        onNodeDoubleClick={onNodeDoubleClick}
        nodeTypes={nodeTypes}
        fitView
        deleteKeyCode={['Delete', 'Backspace']}
        snapToGrid
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
        <Background color="#1a2538" gap={20} />
        <Controls showInteractive={false} />
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
          {/* PANE: Add Node */}
          {contextMenu.target.type === 'pane' && (
            <>
              <div className={styles.contextTitle}>Add Node</div>
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
              <div className={styles.contextCategory}>other</div>
              <button className={styles.contextItem} onClick={e => { e.stopPropagation(); addCommentNode(); }}>
                Add Comment
              </button>
            </>
          )}

          {/* SINGLE NODE */}
          {contextMenu.target.type === 'node' && !contextMenu.target.isGroup && (
            <>
              <div className={styles.contextTitle}>Node</div>
              <button className={styles.contextItem} onClick={e => { e.stopPropagation(); renameNode(); }}>Rename</button>
              <button className={styles.contextItem} onClick={e => { e.stopPropagation(); duplicateNode(); }}>Duplicate</button>
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
              <button className={styles.contextItem} onClick={e => { e.stopPropagation(); dismissGroup(); }}>Dismiss Group</button>
              <button className={styles.contextItem} style={{ color: '#e05050' }} onClick={e => { e.stopPropagation(); deleteSelection(); }}>Delete</button>
            </>
          )}

          {/* SELECTION */}
          {contextMenu.target.type === 'selection' && (
            <>
              <div className={styles.contextTitle}>Selection ({contextMenu.target.nodeIds.length})</div>
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
