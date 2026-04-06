import { useCallback, useRef, useState } from 'react';
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
import { getAllNodeDefs, getNodeDefsByCategory } from './nodes/registry';
import type { GraphNode, GraphEdge } from '../../model/types';
import styles from './GraphEditor.module.css';

const nodeTypes: NodeTypes = {
  caNode: CaNode,
};

let nodeIdCounter = 1;
function nextNodeId(): string {
  return `n${nodeIdCounter++}`;
}

/** Convert model graph nodes → React Flow nodes */
function toRFNodes(graphNodes: GraphNode[]): Node[] {
  return graphNodes.map(n => ({
    id: n.id,
    type: 'caNode',
    position: n.position,
    data: n.data,
  }));
}

/** Convert model graph edges → React Flow edges */
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

/** Convert React Flow nodes → model graph nodes */
function toGraphNodes(rfNodes: Node[]): GraphNode[] {
  return rfNodes.map(n => ({
    id: n.id,
    type: n.type ?? 'caNode',
    position: n.position,
    data: n.data as GraphNode['data'],
  }));
}

/** Convert React Flow edges → model graph edges */
function toGraphEdges(rfEdges: Edge[]): GraphEdge[] {
  return rfEdges.map(e => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle ?? '',
    targetHandle: e.targetHandle ?? '',
  }));
}

interface ContextMenuState {
  x: number;
  y: number;
  flowX: number;
  flowY: number;
}

function GraphEditorInner() {
  const { model, setGraph } = useModel();
  const [nodes, setNodes, onNodesChange] = useNodesState(toRFNodes(model.graphNodes));
  const [edges, setEdges, onEdgesChange] = useEdgesState(toRFEdges(model.graphEdges));
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const rfInstance = useRef<ReactFlowInstance | null>(null);

  // Sync to model context on changes
  const syncToModel = useCallback(
    (newNodes: Node[], newEdges: Edge[]) => {
      setGraph(toGraphNodes(newNodes), toGraphEdges(newEdges));
    },
    [setGraph],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges(eds => {
        const newEdges = addEdge(
          {
            ...connection,
            style: { stroke: '#4cc9f0', strokeWidth: 2 },
            animated: connection.sourceHandle?.includes('flow') ?? false,
          },
          eds,
        );
        // Defer sync so state has settled
        setTimeout(() => {
          setNodes(nds => {
            syncToModel(nds, newEdges);
            return nds;
          });
        }, 0);
        return newEdges;
      });
    },
    [setEdges, setNodes, syncToModel],
  );

  const onNodesChangeWrapped = useCallback(
    (changes: Parameters<typeof onNodesChange>[0]) => {
      onNodesChange(changes);
      // Sync after position changes (drag end)
      const hasDrag = changes.some(
        c => c.type === 'position' && !('dragging' in c && c.dragging),
      );
      const hasRemove = changes.some(c => c.type === 'remove');
      if (hasDrag || hasRemove) {
        setTimeout(() => {
          setNodes(nds => {
            setEdges(eds => {
              syncToModel(nds, eds);
              return eds;
            });
            return nds;
          });
        }, 0);
      }
    },
    [onNodesChange, setNodes, setEdges, syncToModel],
  );

  const onEdgesChangeWrapped = useCallback(
    (changes: Parameters<typeof onEdgesChange>[0]) => {
      onEdgesChange(changes);
      const hasRemove = changes.some(c => c.type === 'remove');
      if (hasRemove) {
        setTimeout(() => {
          setNodes(nds => {
            setEdges(eds => {
              syncToModel(nds, eds);
              return eds;
            });
            return nds;
          });
        }, 0);
      }
    },
    [onEdgesChange, setNodes, setEdges, syncToModel],
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
      const def = getAllNodeDefs().find(d => d.type === nodeType);
      if (!def) return;
      const id = nextNodeId();
      const newNode: Node = {
        id,
        type: 'caNode',
        position: { x: contextMenu.flowX, y: contextMenu.flowY },
        data: { nodeType: def.type, config: { ...def.defaultConfig } },
      };
      setNodes(nds => {
        const updated = [...nds, newNode];
        setEdges(eds => {
          syncToModel(updated, eds);
          return eds;
        });
        return updated;
      });
      setContextMenu(null);
    },
    [contextMenu, setNodes, setEdges, syncToModel],
  );

  // Also sync when node data changes (config edits inside nodes)
  const onNodeDataChange = useCallback(() => {
    setTimeout(() => {
      setNodes(nds => {
        setEdges(eds => {
          syncToModel(nds, eds);
          return eds;
        });
        return nds;
      });
    }, 50);
  }, [setNodes, setEdges, syncToModel]);

  const categories = getNodeDefsByCategory();

  return (
    <div className={styles.editor} onClick={() => setContextMenu(null)} onChangeCapture={onNodeDataChange}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChangeWrapped}
        onEdgesChange={onEdgesChangeWrapped}
        onConnect={onConnect}
        onInit={instance => { rfInstance.current = instance; }}
        onPaneContextMenu={onPaneContextMenu}
        nodeTypes={nodeTypes}
        fitView
        deleteKeyCode="Delete"
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
