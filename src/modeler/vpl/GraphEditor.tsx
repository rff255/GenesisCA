import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  addEdge,
  useNodesState,
  useEdgesState,
  ReactFlowProvider,
} from '@xyflow/react';
import type { Connection, Edge, Node, NodeTypes, ReactFlowInstance } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { CaNode } from './CaNode';
import { useModel } from '../../model/ModelContext';
import { getNodeDefsByCategory } from './nodes/registry';
import { getNodeDef } from './nodes/registry';
import type { GraphNode, GraphEdge } from '../../model/types';
import styles from './GraphEditor.module.css';

const nodeTypes: NodeTypes = {
  caNode: CaNode,
};

// ---------------------------------------------------------------------------
// ID generation — reads existing IDs to avoid collisions
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
  return graphNodes.map(n => ({
    id: n.id,
    type: 'caNode',
    position: n.position,
    data: n.data,
  }));
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
    data: n.data as GraphNode['data'],
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
// Context menu state
// ---------------------------------------------------------------------------

interface ContextMenuState {
  x: number;
  y: number;
  flowX: number;
  flowY: number;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

function GraphEditorInner() {
  const { model, setGraph } = useModel();
  const [nodes, setNodes, onNodesChange] = useNodesState(toRFNodes(model.graphNodes));
  const [edges, setEdges, onEdgesChange] = useEdgesState(toRFEdges(model.graphEdges));
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const rfInstance = useRef<ReactFlowInstance | null>(null);

  // Refs to track latest state for debounced sync
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep refs in sync with state
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  useEffect(() => { edgesRef.current = edges; }, [edges]);

  // Single debounced sync — waits for all React Flow changes to settle
  const scheduleSync = useCallback(() => {
    if (syncTimer.current) clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => {
      setGraph(toGraphNodes(nodesRef.current), toGraphEdges(edgesRef.current));
    }, 100);
  }, [setGraph]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => { if (syncTimer.current) clearTimeout(syncTimer.current); };
  }, []);

  // --- Event handlers ---

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges(eds => {
        // Value inputs accept only one connection — remove existing
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
      // Sync on meaningful changes (not just selection)
      const needsSync = changes.some(
        c => c.type === 'remove' ||
             (c.type === 'position' && 'dragging' in c && !c.dragging),
      );
      if (needsSync) scheduleSync();
    },
    [onNodesChange, scheduleSync],
  );

  const handleEdgesChange = useCallback(
    (changes: Parameters<typeof onEdgesChange>[0]) => {
      onEdgesChange(changes);
      if (changes.some(c => c.type === 'remove')) scheduleSync();
    },
    [onEdgesChange, scheduleSync],
  );

  // Right-click → context menu
  const onPaneContextMenu = useCallback(
    (event: MouseEvent | React.MouseEvent) => {
      event.preventDefault();
      const bounds = (event.target as HTMLElement).closest('.react-flow')?.getBoundingClientRect();
      const rf = rfInstance.current;
      if (!bounds || !rf) return;
      const position = rf.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      setContextMenu({
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
        flowX: position.x,
        flowY: position.y,
      });
    },
    [],
  );

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

  // Sync when node config changes (dropdown selections inside nodes)
  const onNodeDataChange = useCallback(() => {
    scheduleSync();
  }, [scheduleSync]);

  const categories = getNodeDefsByCategory();

  return (
    <div className={styles.editor} onClick={() => setContextMenu(null)} onChangeCapture={onNodeDataChange}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={onConnect}
        onInit={instance => { rfInstance.current = instance; }}
        onPaneContextMenu={onPaneContextMenu}
        nodeTypes={nodeTypes}
        fitView
        deleteKeyCode={['Delete', 'Backspace']}
        defaultEdgeOptions={{
          style: { stroke: '#4cc9f0', strokeWidth: 2 },
          interactionWidth: 15,
        }}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#1a2538" gap={20} />
        <Controls showInteractive={false} />
      </ReactFlow>

      {contextMenu && (
        <div
          className={styles.contextMenu}
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
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
