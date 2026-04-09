import type { GraphNode, GraphEdge } from '../../model/types';

interface Snapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const MAX_HISTORY = 50;

let undoStack: Snapshot[] = [];
let redoStack: Snapshot[] = [];

function deepCopy(nodes: GraphNode[], edges: GraphEdge[]): Snapshot {
  return JSON.parse(JSON.stringify({ nodes, edges })) as Snapshot;
}

export function pushSnapshot(nodes: GraphNode[], edges: GraphEdge[]): void {
  undoStack.push(deepCopy(nodes, edges));
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack = [];
}

export function undo(): Snapshot | null {
  if (undoStack.length === 0) return null;
  return undoStack.pop()!;
}

export function redo(): Snapshot | null {
  if (redoStack.length === 0) return null;
  return redoStack.pop()!;
}

export function pushToRedo(nodes: GraphNode[], edges: GraphEdge[]): void {
  redoStack.push(deepCopy(nodes, edges));
}

export function pushToUndo(nodes: GraphNode[], edges: GraphEdge[]): void {
  undoStack.push(deepCopy(nodes, edges));
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
}

export function clearHistory(): void {
  undoStack = [];
  redoStack = [];
}
