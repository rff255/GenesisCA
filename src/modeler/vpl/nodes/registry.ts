import type { NodeTypeDef } from '../types';
import { StepNode } from './StepNode';
import { InitEventNode } from './InitEventNode';
import { GetOrientationNode } from './GetOrientationNode';
import { SetOrientationNode } from './SetOrientationNode';
import { GetFacingOrientationNode } from './GetFacingOrientationNode';
import { SetFacingOrientationNode } from './SetFacingOrientationNode';
import { GetNeighborOrientationByIndexNode } from './GetNeighborOrientationByIndexNode';
import { SetNeighborOrientationByIndexNode } from './SetNeighborOrientationByIndexNode';
import { GetFacingLabelsNode } from './GetFacingLabelsNode';
import { GetAllFacingLabelsNode } from './GetAllFacingLabelsNode';
import { LookupInteractionNode } from './LookupInteractionNode';
import { InteractionTableMapNode } from './InteractionTableMapNode';
import { GetCellAttributeNode } from './GetCellAttributeNode';
import { GetNeighborsAttributeNode } from './GetNeighborsAttributeNode';
import { GetConstantNode } from './GetConstantNode';
import { GetModelAttributeNode } from './GetModelAttributeNode';
import { GetRandomNode } from './GetRandomNode';
import { GetColorConstantNode } from './GetColorConstantNode';
import { ArithmeticOperatorNode } from './ArithmeticOperatorNode';
import { ExpressionNode } from './ExpressionNode';
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
import { SetCellGlyphNode } from './SetCellGlyphNode';
import { InputColorNode } from './InputColorNode';
import { MacroNode } from './MacroNode';
import { MacroInputNode } from './MacroInputNode';
import { MacroOutputNode } from './MacroOutputNode';
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
import { ValueSwitchNode } from './ValueSwitchNode';
import { ColorScaleNode } from './ColorScaleNode';
import { SwitchNode } from './SwitchNode';
import { AggregateNode } from './AggregateNode';
import { GetNeighborAttributeByTagNode } from './GetNeighborAttributeByTagNode';
import { GetNeighborIndexesByTagsNode } from './GetNeighborIndexesByTagsNode';
import { FilterNeighborsNode } from './FilterNeighborsNode';
import { JoinNeighborsNode } from './JoinNeighborsNode';
import { StopEventNode } from './StopEventNode';
import { NeighborIndexFromOffsetNode } from './NeighborIndexFromOffsetNode';
import { NeighborIndexFromTagNode } from './NeighborIndexFromTagNode';
import { PickRandomNeighborNode } from './PickRandomNeighborNode';
import { FlipNeighborIndexNode } from './FlipNeighborIndexNode';
import { BreakDownNeighborIndexNode } from './BreakDownNeighborIndexNode';
import { ForEachInArrayNode } from './ForEachInArrayNode';
import { GetAllNeighborIndexesNode } from './GetAllNeighborIndexesNode';
import { ArrayElementNode } from './ArrayElementNode';
import { ArrayLengthNode } from './ArrayLengthNode';
import { PickNRandomNeighborsNode } from './PickNRandomNeighborsNode';
import { MoveSelfToNeighborNode } from './MoveSelfToNeighborNode';
import { MarkCellUpdatedNode } from './MarkCellUpdatedNode';
import { GetVariableNode } from './GetVariableNode';
import { SetVariableNode } from './SetVariableNode';
import { SetArrayElementNode } from './SetArrayElementNode';

const ALL_NODES: NodeTypeDef[] = [
  // Event (entry points)
  StepNode,
  InitEventNode,
  InputColorNode,
  OutputMappingNode,
  StopEventNode,
  // Flow
  ConditionalNode,
  SequenceNode,
  LoopNode,
  ForEachInArrayNode,
  SwitchNode,
  // Data
  GetCellAttributeNode,
  GetModelAttributeNode,
  GetNeighborsAttributeNode,
  GetNeighborAttributeByIndexNode,
  GetNeighborAttributeByTagNode,
  GetNeighborIndexesByTagsNode,
  GetNeighborsAttrByIndexesNode,
  GetAllNeighborIndexesNode,
  NeighborIndexFromOffsetNode,
  NeighborIndexFromTagNode,
  FlipNeighborIndexNode,
  BreakDownNeighborIndexNode,
  ArrayElementNode,
  ArrayLengthNode,
  GetConstantNode,
  GetRandomNode,
  // Local Variables — per-cell scratch storage referenced by id.
  GetVariableNode,
  // Variegated Cells — visible only when the feature is enabled (palette
  // filter via `requirements.variegated`).
  GetOrientationNode,
  GetFacingOrientationNode,
  GetNeighborOrientationByIndexNode,
  GetFacingLabelsNode,
  GetAllFacingLabelsNode,
  LookupInteractionNode,
  InteractionTableMapNode,
  // Arithmetic & Logic
  ArithmeticOperatorNode,
  ExpressionNode,
  ProportionMapNode,
  InterpolationNode,
  StatementNode,
  LogicOperatorNode,
  ValueSwitchNode,
  // Aggregation
  GroupCountingNode,
  GroupStatementNode,
  GroupOperatorNode,
  AggregateNode,
  FilterNeighborsNode,
  JoinNeighborsNode,
  PickRandomNeighborNode,
  PickNRandomNeighborsNode,
  // Output
  SetVariableNode,
  SetArrayElementNode,
  SetAttributeNode,
  UpdateAttributeNode,
  SetNeighborhoodAttributeNode,
  SetNeighborAttributeByIndexNode,
  MarkCellUpdatedNode,
  SetOrientationNode,
  SetFacingOrientationNode,
  SetNeighborOrientationByIndexNode,
  MoveSelfToNeighborNode,
  // Color
  SetColorViewerNode,
  SetCellGlyphNode,
  GetColorConstantNode,
  ColorScaleNode,
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
const HIDDEN_FROM_MENU = new Set(['macro', 'macroInput', 'macroOutput']);

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
