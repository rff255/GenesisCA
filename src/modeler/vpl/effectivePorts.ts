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

import type { PortDef, NodeTypeDef } from './types';
import { getNodeDef } from './nodes/registry';
import { clampVisibleCount } from './compiler/expression/parser';

export interface EffectivePorts {
  inputs: PortDef[];
  outputs: PortDef[];
}

export function getEffectivePorts(
  nodeType: string,
  config: Record<string, unknown> | undefined,
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
  }

  // Sequence: dynamic then_N flow outputs
  if (nodeType === 'sequence') {
    const extraCount = Number(cfg.extraCount) || 0;
    for (let i = 2; i < 2 + extraCount; i++) {
      outputs.push({ id: `then_${i}`, label: `Then ${i + 1}`, kind: 'output', category: 'flow' });
    }
  }

  // Expression: show only `visibleCount` of the 8 input ports, with the
  // user-chosen variable names as labels. UI-only — every port still lives in
  // def.ports, so the compilers resolve them all.
  if (nodeType === 'expression') {
    const visibleCount = clampVisibleCount(cfg.visibleCount);
    inputs = inputs.slice(0, visibleCount).map(p => {
      const nm = cfg[`_varName_${p.id}`];
      return (typeof nm === 'string' && nm.trim()) ? { ...p, label: nm.trim() } : p;
    });
  }

  // GetModelAttribute: r/g/b vs value depending on isColorAttr
  if (nodeType === 'getModelAttribute') {
    const isColor = !!cfg.isColorAttr;
    outputs = outputs.filter(p => isColor ? (p.id === 'r' || p.id === 'g' || p.id === 'b') : p.id === 'value');
  }

  // LogicOperator NOT: hide port B
  if (nodeType === 'logicOperator' && cfg.operation === 'NOT') {
    inputs = inputs.filter(p => p.id !== 'b');
  }

  // UpdateAttribute unary ops: hide value port
  if (nodeType === 'updateAttribute') {
    const op = cfg.operation as string;
    if (op === 'toggle' || op === 'next' || op === 'previous') {
      inputs = inputs.filter(p => p.id !== 'value');
    }
  }

  // GetRandom: probability port only for bool; options + fallback only for options mode
  if (nodeType === 'getRandom') {
    const t = cfg.randomType as string;
    if (t !== 'bool') inputs = inputs.filter(p => p.id !== 'probability');
    if (t !== 'options') inputs = inputs.filter(p => p.id !== 'options' && p.id !== 'fallback');
  }

  // Statement (Compare): y2 only for between ops
  if (nodeType === 'statement') {
    const op = cfg.operation as string;
    if (op !== 'between' && op !== 'notBetween') {
      inputs = inputs.filter(p => p.id !== 'y2');
    }
  }

  // MoveSelfToNeighbor: orientation port only when transferOrientation,
  // dynamic per-slot payload ports derived from payloadCount.
  if (nodeType === 'moveSelfToNeighbor') {
    if (!cfg.transferOrientation) {
      inputs = inputs.filter(p => p.id !== 'orientation');
    }
    const payloadCount = Math.max(1, Number(cfg.payloadCount) || 1);
    for (let i = 0; i < payloadCount; i++) {
      const attrId = cfg[`attr_${i}`];
      const labelSuffix = typeof attrId === 'string' && attrId ? ` (${attrId})` : '';
      inputs.push({
        id: `payload_${i}`,
        label: `Payload ${i + 1}${labelSuffix}`,
        kind: 'input',
        category: 'value',
        dataType: 'any',
        inlineWidget: 'number',
        defaultValue: '0',
      });
    }
  }

  // GroupCounting: compareHigh only for between ops
  if (nodeType === 'groupCounting') {
    const op = cfg.operation as string;
    if (op !== 'between' && op !== 'notBetween') {
      inputs = inputs.filter(p => p.id !== 'compareHigh');
    }
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
