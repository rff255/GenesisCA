import type { NodeTypeDef } from '../types';
import { StepNode } from './StepNode';
import { InitEventNode } from './InitEventNode';
import { GridInitEventNode } from './GridInitEventNode';
import { SetCellAtPositionNode } from './SetCellAtPositionNode';
import { BehaviourStepNode } from './BehaviourStepNode';
import { GetSelfPositionNode } from './GetSelfPositionNode';
import { GetSelfHandleNode } from './GetSelfHandleNode';
import { GetRadiusNode } from './GetRadiusNode';
import { GetAgeNode } from './GetAgeNode';
import { GetBondDegreeNode } from './GetBondDegreeNode';
import { GetCurvatureNode } from './GetCurvatureNode';
import { NeighbourDensityNode } from './NeighbourDensityNode';
import { SetTargetRadiusNode } from './SetTargetRadiusNode';
import { FormBondNode } from './FormBondNode';
import { BreakBondNode } from './BreakBondNode';
import { RewireBondNode } from './RewireBondNode';
import { FormBondBetweenNode } from './FormBondBetweenNode';
import { ForEachBondNode } from './ForEachBondNode';
import { DivideAgentNode } from './DivideAgentNode';
import { KillAgentNode } from './KillAgentNode';
import { DivisionEventNode } from './DivisionEventNode';
import { AgentOutputMappingNode } from './AgentOutputMappingNode';
import { SampleFieldNode } from './SampleFieldNode';
import { FieldGradientNode } from './FieldGradientNode';
import { ReadCellsUnderNode } from './ReadCellsUnderNode';
import { AffectCellsUnderNode } from './AffectCellsUnderNode';
import { SecreteToFieldNode } from './SecreteToFieldNode';
import { GetNearbyAgentsNode } from './GetNearbyAgentsNode';
import { GetAgentsInViewNode } from './GetAgentsInViewNode';
import { SenseHemifieldNode } from './SenseHemifieldNode';
import { GetBondedAgentsNode } from './GetBondedAgentsNode';
import { NeighbourCensusNode } from './NeighbourCensusNode';
import { AgentInitNode } from './AgentInitNode';
import { CreateAgentNode } from './CreateAgentNode';
import { AddAgentToWorldNode } from './AddAgentToWorldNode';
import { SetAgentPositionNode } from './SetAgentPositionNode';
import { SetAgentRadiusNode } from './SetAgentRadiusNode';
import { FilterAgentsNode } from './FilterAgentsNode';
import { JoinAgentsNode } from './JoinAgentsNode';
import { PickRandomAgentNode } from './PickRandomAgentNode';
import { PickNRandomAgentsNode } from './PickNRandomAgentsNode';
import { GetAgentsAttributeNode } from './GetAgentsAttributeNode';
import { SetAgentsAttributeNode } from './SetAgentsAttributeNode';
import { SetVelocityNode } from './SetVelocityNode';
import { GetAgentPositionNode } from './GetAgentPositionNode';
import { GetAgentOffsetNode } from './GetAgentOffsetNode';
import { GetAgentAttributeNode } from './GetAgentAttributeNode';
import { GetBondAttributeNode } from './GetBondAttributeNode';
import { GetAgentRadiusNode } from './GetAgentRadiusNode';
import { GetVelocityNode } from './GetVelocityNode';
import { ApplyForceNode } from './ApplyForceNode';
import { ApplyForceToAgentNode } from './ApplyForceToAgentNode';
import { ApplyForceToAgentsNode } from './ApplyForceToAgentsNode';
import { SetAgentAttributeNode } from './SetAgentAttributeNode';
import { SetBondAttributeNode } from './SetBondAttributeNode';
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
import { GetCellPositionNode } from './GetCellPositionNode';
import { GetGridDimensionsNode } from './GetGridDimensionsNode';
import { GetNeighborsAttributeNode } from './GetNeighborsAttributeNode';
import { GetConstantNode } from './GetConstantNode';
import { GetModelAttributeNode } from './GetModelAttributeNode';
import { GetRandomNode } from './GetRandomNode';
import { GetColorConstantNode } from './GetColorConstantNode';
import { ArithmeticOperatorNode } from './ArithmeticOperatorNode';
import { MakeVectorNode } from './MakeVectorNode';
import { BreakVectorNode } from './BreakVectorNode';
import { VectorOpNode } from './VectorOpNode';
import { MakeColorNode } from './MakeColorNode';
import { BreakColorNode } from './BreakColorNode';
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
import { SetCellLooksNode } from './SetCellLooksNode';
import { SetAgentSpriteNode } from './SetAgentSpriteNode';
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
import { CategoricalColorNode } from './CategoricalColorNode';
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
import { ExperimentNode } from './ExperimentNode';
import { OvResetBoardNode } from './OvResetBoardNode';
import { OvRunGenerationsNode } from './OvRunGenerationsNode';
import { OvRunUntilStopNode } from './OvRunUntilStopNode';
import { OvSetSeedNode } from './OvSetSeedNode';
import { OvSetModelAttributeNode } from './OvSetModelAttributeNode';
import { OvRandomizeTableNode } from './OvRandomizeTableNode';
import { OvLoadPresetNode } from './OvLoadPresetNode';
import { OvReadIndicatorNode } from './OvReadIndicatorNode';
import { OvGetGenerationNode } from './OvGetGenerationNode';
import { OvCollectSampleNode } from './OvCollectSampleNode';
import { OvCollectSpatialNode } from './OvCollectSpatialNode';
import { OvClearSeriesNode } from './OvClearSeriesNode';
import { OvSeriesStatNode } from './OvSeriesStatNode';
import { OvSweepValuesNode } from './OvSweepValuesNode';
import { OvLogNode } from './OvLogNode';
import { OvStopExperimentNode } from './OvStopExperimentNode';
import { OvScreenshotNode } from './OvScreenshotNode';
import { OvStartRecordingNode, OvStopRecordingNode } from './OvRecordingNode';

const ALL_NODES: NodeTypeDef[] = [
  // Event (entry points)
  StepNode,
  InitEventNode,
  // Grid Init Event — the global, once-per-Reset counterpart to the per-cell
  // Init Event (free-form seeding: loop + Set Cell (at Position)).
  GridInitEventNode,
  InputColorNode,
  OutputMappingNode,
  StopEventNode,
  // Overseer — experiment orchestration (gated by requirements.overseer;
  // visible ONLY on the Overseer sub-tab of a model with the Overseer enabled).
  ExperimentNode,
  OvResetBoardNode,
  OvRunGenerationsNode,
  OvRunUntilStopNode,
  OvSetSeedNode,
  OvSetModelAttributeNode,
  OvRandomizeTableNode,
  OvLoadPresetNode,
  OvReadIndicatorNode,
  OvGetGenerationNode,
  OvCollectSampleNode,
  OvCollectSpatialNode,
  OvClearSeriesNode,
  OvSeriesStatNode,
  OvSweepValuesNode,
  OvLogNode,
  OvStopExperimentNode,
  OvScreenshotNode,
  OvStartRecordingNode,
  OvStopRecordingNode,
  // Bond-Graph Agents — agent rule-graph event roots + read/request nodes
  // (gated by requirements.bondGraph; visible only on the Agents sub-tab).
  BehaviourStepNode,
  DivisionEventNode,
  // Agent Output Mapping (A→C) — the agent analogue of OutputMapping; roots a
  // per-agent colour/exhibition pass (Standalone or the synthesized Linked one).
  AgentOutputMappingNode,
  // Generic Agent Platform — the once-per-reset Agent Init Event + the two-phase
  // graph-authored spawn (Create → set by id → Add).
  AgentInitNode,
  CreateAgentNode,
  AddAgentToWorldNode,
  SetAgentPositionNode,
  SetAgentRadiusNode,
  GetSelfPositionNode,
  GetSelfHandleNode,
  GetRadiusNode,
  GetAgeNode,
  GetBondDegreeNode,
  GetCurvatureNode,
  NeighbourDensityNode,
  SetTargetRadiusNode,
  // Agent neighbour access + graph-authored forces (boids / flocking / signalling)
  GetNearbyAgentsNode,
  GetAgentsInViewNode,
  SenseHemifieldNode,
  GetBondedAgentsNode,
  // Graph-Rewriting Automata: the neighbour-state multiset. Lowered to the
  // gather + Count Matching chain before compile (censusExpand.ts).
  NeighbourCensusNode,
  GetAgentPositionNode,
  GetAgentOffsetNode,
  GetAgentAttributeNode,
  // Graph-Rewriting Automata (P2): per-EDGE user state.
  GetBondAttributeNode,
  GetAgentRadiusNode,
  GetVelocityNode,
  ApplyForceNode,
  ApplyForceToAgentNode,
  ApplyForceToAgentsNode,
  SetVelocityNode,
  SetAgentAttributeNode,
  SetBondAttributeNode,
  // Generic Agent Platform — agent-equivalent array / set ops (nearby + bonded
  // sources → filter / join / pick / gather / set-many).
  FilterAgentsNode,
  JoinAgentsNode,
  PickRandomAgentNode,
  PickNRandomAgentsNode,
  GetAgentsAttributeNode,
  SetAgentsAttributeNode,
  FormBondNode,
  BreakBondNode,
  RewireBondNode,
  FormBondBetweenNode,
  ForEachBondNode,
  DivideAgentNode,
  KillAgentNode,
  // Closed feedback — the agent↔grid field bridge (the cell CA is the field).
  SampleFieldNode,
  FieldGradientNode,
  ReadCellsUnderNode,
  AffectCellsUnderNode,
  SecreteToFieldNode,
  // Flow
  ConditionalNode,
  SequenceNode,
  LoopNode,
  ForEachInArrayNode,
  SwitchNode,
  // Data
  GetCellAttributeNode,
  GetCellPositionNode,
  GetGridDimensionsNode,
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
  MakeVectorNode,
  BreakVectorNode,
  VectorOpNode,
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
  SetAttributeNode,
  // Set Cell (at Position) — absolute-position cell write; the Grid Init Event's
  // seeding primitive (JS-only emit; runs once in the worker on every target).
  SetCellAtPositionNode,
  UpdateAttributeNode,
  SetVariableNode,
  SetArrayElementNode,
  SetNeighborhoodAttributeNode,
  SetNeighborAttributeByIndexNode,
  MarkCellUpdatedNode,
  SetOrientationNode,
  SetFacingOrientationNode,
  SetNeighborOrientationByIndexNode,
  MoveSelfToNeighborNode,
  // Color
  SetCellLooksNode,
  SetAgentSpriteNode,
  GetColorConstantNode,
  ColorScaleNode,
  CategoricalColorNode,
  MakeColorNode,
  BreakColorNode,
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
