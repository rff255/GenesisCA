import type { CAModel, GraphNode } from '../../../model/types';
import { getNodeDef } from '../nodes/registry';
import { CURRENT_VIEWER_SENTINEL } from '../nodes/SetCellLooksNode';

/**
 * Dangling model references — the compile-time half of the amber badge.
 *
 * A graph can legitimately carry configs that name a model element this model
 * does NOT have: the cross-tab clipboard and macro import both paste rules from
 * another model, and `detectMissingConfig` badges those nodes in the Modeler so
 * the user can re-point them. That state must reach the Simulator as a NAMED
 * compile error, not as code that silently reads an undeclared identifier — the
 * JS reference compiler used to emit `_undef` / `nSz_<missing>` and only fail at
 * RUN time inside the worker ("nSz_new_neighborhood_… is not defined"), with no
 * banner at all on the JS engine. The WASM and WebGPU compilers already reported
 * these by name; this brings the JS compiler into line.
 *
 * SCOPE — only an id that is NON-EMPTY and resolves to NOTHING is reported. An
 * unset id (`''` / `undefined`) is the "still building this node" state, which
 * has always compiled (and is badged separately), so it is deliberately left
 * alone: turning it into a compile error would break half-built models that run
 * today.
 *
 * The membership test is a UNION over every id space a key can legally name
 * (cell + model + agent + bond attributes for `attributeId`, cell + agent
 * mappings for `mappingId`, …). Which of those a given node type may use is
 * `nodeValidation`'s job; here a union keeps the check conservative — it can
 * only fire on an id no part of the model defines.
 */

/** Config keys that hold the id of a model element, and the id space(s) each may name. */
type IdSpace = 'attribute' | 'neighborhood' | 'mapping' | 'indicator' | 'variable' | 'sprite';

const KEY_SPACE: Record<string, IdSpace> = {
  attributeId: 'attribute',
  tagAttributeId: 'attribute',
  tableId: 'attribute',
  partitionAttributeId: 'attribute',
  valueTagAttributeId: 'attribute',
  neighborhoodId: 'neighborhood',
  neighborhoodHintId: 'neighborhood',
  mappingId: 'mapping',
  indicatorId: 'indicator',
  variableId: 'variable',
  spriteId: 'sprite',
};

/** `attr_0`, `attr_1`, … — moveSelfToNeighbor's payload slots (and the
 *  multi-attribute slots, when the check runs before that expansion). */
const SLOT_ATTR_KEY = /^attr_\d+$/;

function idSets(model: CAModel): Record<IdSpace, Set<string>> {
  const attribute = new Set<string>();
  for (const a of model.attributes ?? []) attribute.add(a.id);
  for (const a of model.agentAttributes ?? []) attribute.add(a.id);
  for (const a of model.bondAttributes ?? []) attribute.add(a.id);
  const mapping = new Set<string>([CURRENT_VIEWER_SENTINEL]);
  for (const m of model.mappings ?? []) mapping.add(m.id);
  for (const m of model.agentMappings ?? []) mapping.add(m.id);
  const variable = new Set<string>();
  for (const v of model.variables ?? []) variable.add(v.id);
  for (const v of model.agentVariables ?? []) variable.add(v.id);
  return {
    attribute,
    neighborhood: new Set((model.neighborhoods ?? []).map(n => n.id)),
    mapping,
    indicator: new Set((model.indicators ?? []).map(i => i.id)),
    variable,
    sprite: new Set((model.sprites ?? []).map(s => s.id)),
  };
}

const SPACE_LABEL: Record<IdSpace, string> = {
  attribute: 'attribute',
  neighborhood: 'neighborhood',
  mapping: 'mapping',
  indicator: 'indicator',
  variable: 'local variable',
  sprite: 'sprite',
};

/**
 * @returns a human-readable error naming each offending node + reference, or
 *          `undefined` when every non-empty reference resolves.
 */
export function detectDanglingRefs(nodes: GraphNode[], model: CAModel): string | undefined {
  const sets = idSets(model);
  const issues: string[] = [];
  for (const n of nodes) {
    const cfg = (n.data as { config?: Record<string, unknown> } | undefined)?.config;
    if (!cfg) continue;
    const label = (n.data as { label?: string }).label
      ?? getNodeDef(n.data.nodeType)?.label ?? n.data.nodeType;
    for (const [key, raw] of Object.entries(cfg)) {
      if (typeof raw !== 'string' || raw === '') continue;
      const space = KEY_SPACE[key] ?? (SLOT_ATTR_KEY.test(key) ? 'attribute' : undefined);
      if (!space) continue;
      if (sets[space].has(raw)) continue;
      issues.push(`"${label}" references a missing ${SPACE_LABEL[space]} (${raw})`);
      if (issues.length >= 8) break;
    }
    if (issues.length >= 8) break;
  }
  if (issues.length === 0) return undefined;
  return `This graph references model elements this model does not have — re-point the flagged nodes in the Modeler (they carry an amber warning badge):\n${issues.map(s => `• ${s}`).join('\n')}`;
}
