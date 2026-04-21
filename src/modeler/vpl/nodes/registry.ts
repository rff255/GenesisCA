import type { NodeTypeDef } from '../types';
import { StepNode } from './StepNode';
import { GetCellAttributeNode } from './GetCellAttributeNode';
import { GetNeighborsAttributeNode } from './GetNeighborsAttributeNode';
import { GetConstantNode } from './GetConstantNode';
import { GetModelAttributeNode } from './GetModelAttributeNode';
import { GetRandomNode } from './GetRandomNode';
import { GetColorConstantNode } from './GetColorConstantNode';
import { ArithmeticOperatorNode } from './ArithmeticOperatorNode';
import { GroupCountingNode } from './GroupCountingNode';
import { GroupStatementNode } from './GroupStatementNode';
import { GroupOperatorNode } from './GroupOperatorNode';
import { StatementNode } from './StatementNode';
import { LogicOperatorNode } from './LogicOperatorNode';
import { ConditionalNode } from './ConditionalNode';
import { SequenceNode } from './SequenceNode';
import { LoopNode } from './LoopNode';
import { SetAttributeNode } from './SetAttributeNode';
import { UpdateAttributeNode } from './UpdateAttributeNode';
import { SetColorViewerNode } from './SetColorViewerNode';
import { InputColorNode } from './InputColorNode';
import { MacroNode } from './MacroNode';
import { MacroInputNode } from './MacroInputNode';
import { MacroOutputNode } from './MacroOutputNode';
import { TagConstantNode } from './TagConstantNode';
import { SetNeighborhoodAttributeNode } from './SetNeighborhoodAttributeNode';
import { GetNeighborAttributeByIndexNode } from './GetNeighborAttributeByIndexNode';
import { SetNeighborAttributeByIndexNode } from './SetNeighborAttributeByIndexNode';
import { OutputMappingNode } from './OutputMappingNode';
import { GetNeighborsAttrByIndexesNode } from './GetNeighborsAttrByIndexesNode';
import { GetIndicatorNode } from './GetIndicatorNode';
import { SetIndicatorNode } from './SetIndicatorNode';
import { UpdateIndicatorNode } from './UpdateIndicatorNode';
import { ProportionMapNode } from './ProportionMapNode';
import { InterpolationNode } from './InterpolationNode';
import { ColorInterpolationNode } from './ColorInterpolationNode';
import { SwitchNode } from './SwitchNode';
import { AggregateNode } from './AggregateNode';
import { GetNeighborAttributeByTagNode } from './GetNeighborAttributeByTagNode';
import { GetNeighborIndexesByTagsNode } from './GetNeighborIndexesByTagsNode';
import { FilterNeighborsNode } from './FilterNeighborsNode';
import { JoinNeighborsNode } from './JoinNeighborsNode';
import { StopEventNode } from './StopEventNode';

const ALL_NODES: NodeTypeDef[] = [
  // Event (entry points)
  StepNode,
  InputColorNode,
  OutputMappingNode,
  StopEventNode,
  // Flow
  ConditionalNode,
  SequenceNode,
  LoopNode,
  SwitchNode,
  // Data
  GetCellAttributeNode,
  GetModelAttributeNode,
  GetNeighborsAttributeNode,
  GetNeighborAttributeByIndexNode,
  GetNeighborAttributeByTagNode,
  GetNeighborIndexesByTagsNode,
  GetNeighborsAttrByIndexesNode,
  GetConstantNode,
  GetRandomNode,
  TagConstantNode,
  // Arithmetic & Logic
  ArithmeticOperatorNode,
  ProportionMapNode,
  InterpolationNode,
  StatementNode,
  LogicOperatorNode,
  // Aggregation
  GroupCountingNode,
  GroupStatementNode,
  GroupOperatorNode,
  AggregateNode,
  FilterNeighborsNode,
  JoinNeighborsNode,
  // Output
  SetAttributeNode,
  UpdateAttributeNode,
  SetNeighborhoodAttributeNode,
  SetNeighborAttributeByIndexNode,
  // Color
  SetColorViewerNode,
  GetColorConstantNode,
  ColorInterpolationNode,
  // Indicators
  GetIndicatorNode,
  SetIndicatorNode,
  UpdateIndicatorNode,
  // Macro
  MacroNode,
  MacroInputNode,
  MacroOutputNode,
];

const registry = new Map<string, NodeTypeDef>();
for (const def of ALL_NODES) {
  registry.set(def.type, def);
}

export function getNodeDef(type: string): NodeTypeDef | undefined {
  return registry.get(type);
}

export function getAllNodeDefs(): NodeTypeDef[] {
  return ALL_NODES;
}

/** Node types hidden from the "Add Node" menu (created programmatically) */
const HIDDEN_FROM_MENU = new Set(['macro', 'macroInput', 'macroOutput', 'tagConstant']);

/** Grouped by category for the "Add Node" menu */
export function getNodeDefsByCategory(): Map<string, NodeTypeDef[]> {
  const grouped = new Map<string, NodeTypeDef[]>();
  for (const def of ALL_NODES) {
    if (HIDDEN_FROM_MENU.has(def.type)) continue;
    const list = grouped.get(def.category) ?? [];
    list.push(def);
    grouped.set(def.category, list);
  }
  return grouped;
}
