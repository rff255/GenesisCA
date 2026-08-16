/**
 * Compute the effective port list for a node given its current config.
 *
 * Most nodes' ports are static (from `def.ports`). A handful of node types
 * derive extra ports — or hide ports — from config keys at render time. This
 * helper centralizes that logic for any consumer that needs to reason about
 * what ports a node *actually* has right now, without poking React Flow's
 * rendered DOM.
 *
 * The compatibility check used by the panel-drag highlight (and the
 * snap-to-port menu filter) is the primary consumer. CaNode.tsx renders ports
 * with its own inline logic; intentionally not refactoring that path to avoid
 * a risky rewrite — they MUST stay in sync, so this file mirrors CaNode's
 * branches. If you add a node type whose ports vary by config, add a branch
 * here too.
 */

import type { PortDef, NodeTypeDef, NodeConfig } from './types';
import type { CAModel } from '../../model/types';
import { getNodeDef } from './nodes/registry';
import { clampVisibleCount, FORMULA_NODE_TYPES } from './compiler/expression/parser';
import { vectorPortDims } from './compiler/vectorAttr';
import { MULTI_ATTR_TYPES, buildExtraSlotPorts } from './compiler/multiAttrExpand';
import { buildCensusPorts } from './compiler/censusExpand';
import { buildBondAttrPorts } from './bondAttrPorts';
import { applyLookupAxisPorts } from './nodes/LookupInteractionNode';
import { buildInputParamPorts, isInputMappingRoot } from '../../model/inputMappingParams';
import { getActiveGraphKind } from './graphState';

export interface EffectivePorts {
  inputs: PortDef[];
  outputs: PortDef[];
}

export function getEffectivePorts(
  nodeType: string,
  config: Record<string, unknown> | undefined,
  model?: CAModel,
): EffectivePorts {
  const def = getNodeDef(nodeType);
  if (!def) return { inputs: [], outputs: [] };
  const cfg = config ?? {};
  let inputs = def.ports.filter(p => p.kind === 'input');
  let outputs = def.ports.filter(p => p.kind === 'output');

  // Switch: dynamic case ports
  if (nodeType === 'switch') {
    const mode = (cfg.mode as string) || 'conditions';
    const valType = (cfg.valueType as string) || 'integer';
    const caseCount = Number(cfg.caseCount) || 0;
    if (mode === 'conditions') {
      inputs = inputs.filter(p => p.id !== 'value');
      for (let i = 0; i < caseCount; i++) {
        inputs.push({
          id: `case_${i}_cond`, label: `Case ${i}`,
          kind: 'input', category: 'value', dataType: 'bool', inlineWidget: 'bool', defaultValue: 'false',
        });
        outputs.push({ id: `case_${i}`, label: `Case ${i}`, kind: 'output', category: 'flow' });
      }
    } else {
      if (valType === 'tag') {
        inputs = inputs.map(p => p.id === 'value'
          ? { ...p, inlineWidget: 'tag' as const, dataType: 'any' as const }
          : p);
        for (let i = 0; i < caseCount; i++) {
          outputs.push({ id: `case_${i}`, label: `Case ${i}`, kind: 'output', category: 'flow' });
        }
      } else {
        for (let i = 0; i < caseCount; i++) {
          inputs.push({
            id: `case_${i}_val`, label: `Case ${i}`,
            kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '0',
          });
          outputs.push({ id: `case_${i}`, label: `Case ${i}`, kind: 'output', category: 'flow' });
        }
      }
    }
    // Keep the DONE pass-through at the top of the outputs (mirrors CaNode).
    outputs = [...outputs.filter(p => p.id === 'next'), ...outputs.filter(p => p.id !== 'next')];
  }

  // Sequence: dynamic then_N flow outputs
  if (nodeType === 'sequence') {
    const extraCount = Number(cfg.extraCount) || 0;
    for (let i = 2; i < 2 + extraCount; i++) {
      outputs.push({ id: `then_${i}`, label: `Then ${i + 1}`, kind: 'output', category: 'flow' });
    }
  }

  // Multi-attribute slots: extra `value_${i}` ports on the five accessor nodes
  // (get: outputs, set: inputs with type-adaptive inline widgets). Built by the
  // shared helper so this file + CaNode can't drift. See multiAttrExpand.ts.
  if (MULTI_ATTR_TYPES.has(nodeType)) {
    const extra = buildExtraSlotPorts(nodeType, cfg, model);
    inputs = [...inputs, ...extra.inputs];
    outputs = [...outputs, ...extra.outputs];
  }

  // Neighbour Census: one integer output per state value of the chosen tag/bool
  // agent attribute, labelled with the option name, BEFORE the static Total.
  // Built by the shared helper so this file + CaNode can't drift (the
  // buildExtraSlotPorts dual-consumption pattern). See censusExpand.ts.
  if (nodeType === 'neighbourCensus') {
    const extra = buildCensusPorts(nodeType, cfg, model);
    outputs = [...extra.outputs, ...outputs];
  }

  // Form Bond: one initial-value input per BOND attribute (P2), labelled with the
  // attribute name + a type-adaptive inline widget. Same shared-builder rule.
  if (nodeType === 'formBond') {
    const extra = buildBondAttrPorts(nodeType, model);
    inputs = [...inputs, ...extra.inputs];
  }

  // Input Mapping roots (cell `inputColor` / `agentInputMapping`): one value
  // output per resolved CHANNEL of the referenced mapping's declared
  // `parameters`. No declared parameters ⇒ the legacy colour parameter ⇒ the
  // historical R/G/B ports. Same shared builder as CaNode
  // (buildInputParamPorts — the buildExtraSlotPorts dual-consumption pattern).
  if (isInputMappingRoot(nodeType)) {
    const extra = buildInputParamPorts(nodeType, cfg, model);
    outputs = [...outputs, ...extra.outputs];
  }

  // Table Lookup: shape the index inputs per the referenced table — legacy
  // 2-axis keeps Row/Col (axis_* dropped); a MULTI-AXIS table shows one input
  // per axis, labeled with the axis names. ONE shared shaper with CaNode
  // (applyLookupAxisPorts — the buildExtraSlotPorts dual-consumption pattern).
  if (nodeType === 'lookupInteraction') {
    inputs = applyLookupAxisPorts(inputs, cfg, model);
  }

  // Expression / Logical Expression: show only `visibleCount` of the 8 input
  // ports, with the user-chosen variable names as labels. UI-only — every port
  // still lives in def.ports, so the compilers resolve them all.
  if (FORMULA_NODE_TYPES.has(nodeType)) {
    const visibleCount = clampVisibleCount(cfg.visibleCount);
    inputs = inputs.slice(0, visibleCount).map(p => {
      const nm = cfg[`_varName_${p.id}`];
      return (typeof nm === 'string' && nm.trim()) ? { ...p, label: nm.trim() } : p;
    });
  }

  // Unified vector attribute / variable: any node whose `value` port carries a
  // vector attr/var (own Get/Set, the neighbour reads, the by-id agent read/write,
  // the neighbour writes, Get/Set Variable) gets a `vector` VALUE port when the
  // picked attr/var is a vector (they lower to Make/Break Vector before compile). The
  // inline widget on the set nodes is dropped (a vector can't be an inline number).
  // vectorPortDims returns null for every other node type, so calling it generically
  // is precise. Shared with isValidConnection + CaNode so editor + validator + render
  // agree. See vectorAttr.ts.
  if (model && vectorPortDims(nodeType, cfg, model)) {
    inputs = inputs.map(p => (p.id === 'value' ? { ...p, dataType: 'vector' as const, inlineWidget: undefined } : p));
    outputs = outputs.map(p => (p.id === 'value' ? { ...p, dataType: 'vector' as const } : p));
  }

  // Mode-dependent static-port hiding lives DECLARATIVELY on each node def
  // (def.hiddenPorts(config) → ids to drop) so the rule exists once instead of
  // being duplicated here and in CaNode. Covers GetModelAttribute (r/g/b vs
  // value), LogicOperator NOT, UpdateAttribute / Update Indicator unary ops,
  // GetRandom (probability/options/fallback by random type), Compare / Count
  // Matching between-bounds, Group Reduce Position, Math unary Y, etc. Applied
  // AFTER the dynamic add/transform logic above (switch/sequence/expression),
  // which those nodes keep inline because they ADD ports rather than remove.
  // `getActiveGraphKind()` is threaded so a UNIVERSAL node can drop a port that
  // only means something on one rule graph (setAttribute's optional `agentId`).
  const hidden = def.hiddenPorts?.(cfg as NodeConfig, model, getActiveGraphKind());
  if (hidden && hidden.length > 0) {
    const drop = new Set(hidden);
    inputs = inputs.filter(p => !drop.has(p.id));
    outputs = outputs.filter(p => !drop.has(p.id));
  }

  return { inputs, outputs };
}

/** Build effective ports for a NEW node about to be spawned with the given
 *  resolved config (defaultConfig + configOverrides merged). Convenience for
 *  the panel-drag compatibility check, which doesn't have an actual node
 *  instance to consult. */
export function getEffectivePortsForType(
  def: NodeTypeDef,
  resolvedConfig: Record<string, unknown>,
): EffectivePorts {
  return getEffectivePorts(def.type, resolvedConfig);
}
