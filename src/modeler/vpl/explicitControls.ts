/**
 * EXPLICIT CONTROLS — the ONE definition of what a macro author may promote to a
 * named control on the closed instance, what widget it renders as, what options
 * it offers, and WHERE its value is written.
 *
 * The structural bet of the feature (D1): a control is a **REMOTE CONTROL, not a
 * copy**. It stores `{ nodeId, configKey }` and reads/writes
 * `def.nodes[k].data.config[key]` live, so there is exactly ONE storage location
 * — "change either side, the other shows it" is true by construction and **no
 * compiler learns the feature exists**.
 *
 * Two consequences this module exists to enforce:
 *
 *  1. **The widget kind is DERIVED, never stored** (D2). `setAttribute`'s value
 *     widget flips bool↔tag↔number with the picked attribute and `statement`'s
 *     operands flip with `compareType`; a stored kind would show the wrong
 *     editor and write a wrong-typed value with no error anywhere.
 *  2. **DUAL CONSUMPTION** — the `buildCensusPorts` / `buildBondAttrPorts` /
 *     `buildInputParamPorts` / `applyLookupAxisPorts` discipline. `CaNode`
 *     CALLS `inlineWidgetFor` for its own inline port widgets, so the widget an
 *     instance control renders and the widget the node renders cannot drift.
 *
 * Dependency direction: this module imports `effectivePorts`, the registry,
 * `graphState` and `attributeScope`. **NOTHING under `compiler/` imports it** —
 * a control is metadata beside `nodes`/`edges` and never reaches an emitter.
 */

import type { PortDef, NodeConfig } from './types';
import { handleId } from './types';
import type { CAModel, MacroDef, MacroControl, ControlTarget, GraphNode, Attribute } from '../../model/types';
import { getNodeDef } from './nodes/registry';
import { getEffectivePorts } from './effectivePorts';
import { getActiveGraphKind, displayNodeLabel } from './graphState';
import { cellFieldAttrsOf } from '../../model/attributeScope';
import { vectorPortDims } from './compiler/vectorAttr';
import { MULTI_ATTR_SET_TYPES, resolveSlotAttr } from './compiler/multiAttrExpand';
import { INTERPOLATION_METHODS } from './nodes/interpolationMethods';
import { FORMULA_NODE_TYPES } from './compiler/expression/parser';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ControlWidgetKind =
  | 'number' | 'bool' | 'tag' | 'glyph'                    // class A (inline port widgets)
  | 'select' | 'checkbox' | 'text' | 'textarea' | 'color'  // class B (scalar config keys)
  | 'element';                                             // class C (model-element pickers, P4)

export type ControlClass = 'A' | 'B' | 'C';

export interface ControlOption { value: string; label: string }

/** ONE eligible parameter of ONE node — what pick mode offers. */
export interface ControlKeyDescriptor {
  configKey: string;
  /** the parameter's own label — the default control name and the pick-mode row text */
  label: string;
  kind: ControlWidgetKind;
  klass: ControlClass;
  options?: ReadonlyArray<ControlOption>;
  /** class A only: the port is WIRED inside the macro (D2) — offered, but the
   *  control will render disabled with that reason. */
  wired?: boolean;
}

/** The fully-resolved WRITE ADDRESS of a control. ⚠ `defId` may be a NESTED def
 *  when the control is chained (D4) — the write does NOT necessarily land in the
 *  def that owns the control. */
export interface ResolvedTarget { defId: string; nodeId: string; configKey: string }

export type ControlBlock =
  | 'orphan-node'      // the target node was deleted inside the macro
  | 'orphan-key'       // the key no longer exists on that node
  | 'orphan-control'   // the nested macro's control this points at was removed
  | 'orphan-def'       // the nested macro def itself is gone
  | 'cycle'            // circular chain (or the depth cap)
  | 'wired'            // the bound port is wired inside the macro
  | 'scope-open';      // the owning def is the currently-open scope (R7)

/** What the instance renders. `null` is NEVER returned — an unresolvable control
 *  comes back with `block` set so it can be shown DISABLED WITH ITS REASON
 *  (D8: report, never drop). */
export interface ControlDescriptor {
  kind: ControlWidgetKind;
  value: string;
  label: string;
  options?: ReadonlyArray<ControlOption>;
  resolved: ResolvedTarget | null;
  block?: ControlBlock;
  reason?: string;
}

/** The user-facing sentence for each block reason. ONE table so the resolver,
 *  the instance rendering and the harness cannot disagree. */
export const CONTROL_BLOCK_REASON: Readonly<Record<ControlBlock, string>> = {
  'orphan-node': 'its target node was deleted inside the macro',
  'orphan-key': 'the parameter it points at no longer exists',
  'orphan-control': "the macro's control this points at was removed",
  'orphan-def': 'the nested macro it points into no longer exists',
  'cycle': 'circular reference',
  'wired': 'wired inside the macro',
  'scope-open': 'the macro is open for editing — edit it there',
};

/** Mirrors `expandMacros`' depth-20 guard and `MAX_MACRO_DEPTH`. */
export const CONTROL_MAX_CHAIN_DEPTH = 20;

// ---------------------------------------------------------------------------
// Attribute scopes — the ONE derivation, shared with CaNode (R5)
// ---------------------------------------------------------------------------

/**
 * The active graph's OWN attributes — agent attributes on the Agents graph, cell
 * attributes on Cells. Drives Get/Set/Update Attribute pickers AND the adaptive
 * `value` inline widget. Nodes remount on graph swap, so reading the kind at
 * render time is correct.
 */
export function ownAttrListFor(model: CAModel): Attribute[] {
  return getActiveGraphKind() === 'agents'
    ? (model.agentAttributes ?? [])
    : model.attributes.filter(a => !a.isModelAttribute);
}

/**
 * Tag-attribute pickers (Get Constant / Compare / Switch tag mode) reference a
 * tag attribute purely for its OPTION NAMES. Scope = every attribute whose
 * discrete value the active graph can meaningfully read/compare — see the long
 * rationale at the original site in CaNode.
 */
export function tagAttrScopeFor(model: CAModel): Attribute[] {
  return getActiveGraphKind() === 'agents'
    ? [...(model.agentAttributes ?? []), ...cellFieldAttrsOf(model), ...model.attributes.filter(a => a.isModelAttribute)]
    : model.attributes;
}

// ---------------------------------------------------------------------------
// Class A — the ADAPTIVE inline-widget swap (lifted out of CaNode, called back)
// ---------------------------------------------------------------------------

export interface InlineWidgetResolution {
  /** `null` ⇒ this port renders NO inline widget in this configuration. */
  kind: 'number' | 'bool' | 'tag' | 'glyph' | null;
  /** the option list a `tag` widget renders (already resolved for the slot / the
   *  Compare operand / the node's own attribute). */
  tagOptions?: string[];
}

/**
 * THE inline-widget resolution for one input port of one node — the widget kind
 * plus, for a tag widget, its options.
 *
 * Extracted VERBATIM from CaNode's port-render block so BOTH consume it (R4/R5).
 * Covers, in the same order CaNode applied them:
 *   1. the declared `port.inlineWidget`;
 *   2. the setAttribute-family `value` swap by the picked attribute's TYPE
 *      (setAttribute / updateAttribute / setNeighborhoodAttribute /
 *      setNeighborAttributeByIndex / setCellAtPosition);
 *   3. the VECTOR suppression — a `value` port carrying a vector attr/var takes
 *      a composite wire, never an inline scalar;
 *   4. the multi-attr extra slot (`value_<N>`) tag OPTIONS (the slot's widget is
 *      already carried on the constructed port);
 *   5. Compare's operand swap by `compareType`.
 */
export function inlineWidgetFor(
  nodeType: string,
  config: NodeConfig,
  port: PortDef,
  model: CAModel,
): InlineWidgetResolution {
  let kind = port.inlineWidget as InlineWidgetResolution['kind'] | undefined;
  const ownAttrList = ownAttrListFor(model);
  const setAttrId = config.attributeId as string;
  const setAttr = setAttrId ? ownAttrList.find(a => a.id === setAttrId) : undefined;

  if (kind && (nodeType === 'setAttribute' || nodeType === 'updateAttribute' || nodeType === 'setNeighborhoodAttribute' || nodeType === 'setNeighborAttributeByIndex' || nodeType === 'setCellAtPosition') && port.id === 'value') {
    const attr = setAttr;
    if (!attr) kind = undefined;
    else if (attr.type === 'bool') kind = 'bool';
    else if (attr.type === 'integer' || attr.type === 'float') kind = 'number';
    else if (attr.type === 'tag') kind = 'tag';
    else kind = undefined;
  }

  // Any set node whose `value` port carries a VECTOR attr/var: no inline scalar
  // widget (the value is a composite wired from Make Vector). vectorPortDims is
  // null for every non-vector case, so calling it generically is precise.
  if (port.id === 'value' && vectorPortDims(nodeType, config, model)) kind = undefined;

  let slotTagOptions: string[] | undefined;
  if (MULTI_ATTR_SET_TYPES.has(nodeType) && kind === 'tag' && port.id !== 'value') {
    const slotM = /^value_(\d+)$/.exec(port.id);
    if (slotM) slotTagOptions = resolveSlotAttr(nodeType, model, config[`attr_${slotM[1]}`])?.tagOptions || [];
  }

  let statementTagOptions: string[] | undefined;
  if (nodeType === 'statement' && (port.id === 'x' || port.id === 'y')) {
    const cmpType = (config.compareType as string) || 'numerical';
    if (cmpType === 'bool') kind = 'bool';
    else if (cmpType === 'tag') {
      kind = 'tag';
      statementTagOptions = tagAttrScopeFor(model).find(a => a.id === config.tagAttributeId)?.tagOptions || [];
    } else if (cmpType === 'neighborIndex') kind = undefined;
    else kind = 'number';
  }

  if (!kind) return { kind: null };
  return { kind, tagOptions: statementTagOptions ?? slotTagOptions ?? (setAttr?.tagOptions || []) };
}

// ---------------------------------------------------------------------------
// D2b + D3 exclusions — ONE predicate, so a future key inherits the rule
// ---------------------------------------------------------------------------

/** Keys whose in-node widget is a COUNT STEPPER: they change which PORTS the
 *  node has, hence what `expandMacros` emits and which internal edges survive. */
const COUNT_STEPPER_KEYS = new Set(['extraCount', 'caseCount', 'visibleCount', 'payloadCount', 'axisCount', 'count']);

/** Display-only layout keys — never eligible, in any class. */
const DISPLAY_ONLY_KEYS = new Set(['_exprW', '_exprH', '_namesExpanded', '_exprExpanded']);

/**
 * TRUE for every key shape a control may NOT bind:
 *
 *  - `_port_bondAttr_*` / `partTag_*` (**D2b**) — the ONLY two key shapes any
 *    code path renames, deletes or permutes (`REMOVE_BOND_ATTRIBUTE`,
 *    `UPDATE_BOND_ATTRIBUTE`'s tagOptions permute, and `applyImportPlan` passes
 *    2 and 4). `_port_bondAttr_*` additionally EMBEDS a model-element id, which
 *    would make a bound control a fourth reference carrier
 *    `collectMacroReferences` does not scan.
 *  - the count steppers — **structural** (they change the port set).
 *  - `_varName_*` — multi-key AND structural (they relabel ports).
 *  - the multi-key families `stop_*` / `entry_*` / `default_*` — one control ↔
 *    one value does not hold.
 *  - the display-only layout keys.
 *
 * This is an ACTIVE FILTER for class A (whose key set is derived from
 * `getEffectivePorts`, which really does produce `_port_bondAttr_*`); for
 * classes B and C it is defence in depth, since those are allowlists.
 */
export function isExcludedControlKey(configKey: string): boolean {
  if (configKey.startsWith('_port_bondAttr_')) return true;
  if (configKey.startsWith('partTag_')) return true;
  if (configKey.startsWith('_varName_')) return true;
  if (/^stop_\d+_/.test(configKey)) return true;
  if (/^entry_\d+_/.test(configKey)) return true;
  if (/^default_(r|g|b|a)$/.test(configKey)) return true;
  if (COUNT_STEPPER_KEYS.has(configKey)) return true;
  if (DISPLAY_ONLY_KEYS.has(configKey)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Class B — the declarative (nodeType, key) → widget table
// ---------------------------------------------------------------------------

type OptionsResolver = ReadonlyArray<ControlOption> | ((config: NodeConfig, model: CAModel) => ReadonlyArray<ControlOption>);
type KindResolver = ControlWidgetKind | ((config: NodeConfig, model: CAModel) => ControlWidgetKind | null);

export interface ScalarKeySpec {
  label: string;
  /** a function ⇒ the kind is DERIVED (D2); `null` ⇒ not eligible in this config */
  kind: KindResolver;
  options?: OptionsResolver;
  /** what the instance shows when the key is absent from the config */
  defaultValue?: string;
}

const opt = (value: string, label: string): ControlOption => ({ value, label });

/** `==` / `!=` / `>` / `<` — the comparison ops, in the two spellings the two
 *  families of nodes store them in. */
const CMP_WORD_OPS: ControlOption[] = [
  opt('equals', '=='), opt('notEquals', '!='), opt('greater', '>'), opt('lesser', '<'),
  opt('greaterEqual', '>='), opt('lesserEqual', '<='),
];
const CMP_SYMBOL_OPS: ControlOption[] = [
  opt('==', '=='), opt('!=', '!='), opt('>', '>'), opt('<', '<'), opt('>=', '>='), opt('<=', '<='),
  opt('between', 'Between'), opt('notBetween', 'Not Between'),
];
const LOW_OPS: ControlOption[] = [opt('>=', '>='), opt('>', '>')];
const HIGH_OPS: ControlOption[] = [opt('<=', '<='), opt('<', '<')];
const HEADING_SOURCES: ControlOption[] = [
  opt('velocity', 'Velocity'), opt('wired', 'Wired (X/Y/Z)'), opt('facing', 'Facing (vector attr)'),
];
/** The `updateAttribute` / `updateIndicator` op set, keyed by the TARGET's data
 *  type — the reason those two `operation` keys resolve their options LIVE. */
const UPDATE_OPS_BY_TYPE: Record<string, ControlOption[]> = {
  bool: [opt('toggle', 'Toggle'), opt('or', 'OR'), opt('and', 'AND')],
  integer: [opt('increment', 'Increment (+)'), opt('decrement', 'Decrement (-)'), opt('max', 'Max'), opt('min', 'Min')],
  float: [opt('increment', 'Increment (+)'), opt('decrement', 'Decrement (-)'), opt('max', 'Max'), opt('min', 'Min')],
  tag: [opt('next', 'Next'), opt('previous', 'Previous')],
};

const num = (label: string, defaultValue = '0'): ScalarKeySpec => ({ label, kind: 'number', defaultValue });
const check = (label: string, defaultValue = 'false'): ScalarKeySpec => ({ label, kind: 'checkbox', defaultValue });
const sel = (label: string, options: OptionsResolver, defaultValue?: string): ScalarKeySpec => ({ label, kind: 'select', options, defaultValue });
const txt = (label: string): ScalarKeySpec => ({ label, kind: 'text', defaultValue: '' });

/**
 * The class-B allowlist: `(nodeType → configKey → spec)`.
 *
 * ⚠ **COUPLED-WRITE KEYS ARE DELIBERATELY ABSENT.** A control writes exactly ONE
 * key. A key whose in-node editor writes SEVERAL (`getConstant.constType` resets
 * `constValue`; `statement.compareType` resets the operands; every `*Id` picker
 * that re-seeds a dependent value) cannot be faithfully driven by a one-key
 * write — it would produce a state the in-node editor never produces, silently.
 * That is the same reasoning as D2b and D3's structural exclusion, applied to
 * the write shape instead of the key shape. Being an ALLOWLIST, the table
 * excludes them simply by not naming them.
 */
export const SCALAR_CONFIG_KEYS: ReadonlyMap<string, ReadonlyMap<string, ScalarKeySpec>> = new Map<string, Map<string, ScalarKeySpec>>([
  // --- enum selects -------------------------------------------------------
  ['filterAgents', new Map([['operation', sel('Operation', CMP_WORD_OPS, 'equals')]])],
  ['joinAgents', new Map([['operation', sel('Operation', [opt('union', 'Union'), opt('intersection', 'Intersection')], 'union')]])],
  ['filterNeighbors', new Map([['operation', sel('Operation', CMP_WORD_OPS, 'equals')]])],
  ['joinNeighbors', new Map([['operation', sel('Operation', [opt('intersection', 'Intersection (AND)'), opt('union', 'Union (OR)')], 'intersection')]])],
  ['getAgentPosition', new Map([['mode', sel('Mode', [opt('absolute', 'Absolute (position)'), opt('relative', 'Relative (from reference)')], 'absolute')]])],
  ['divideAgent', new Map<string, ScalarKeySpec>([
    ['partition', sel('Bond partition', [opt('tension', 'Bonds: by tension axis'), opt('alternate', 'Bonds: alternate A / B'), opt('byBondAttribute', 'Bonds: by bond attribute')], 'tension')],
    ['partitionThreshold', num('Partition threshold')],
    ['daughterBond', sel('Daughter bond', [opt('auto', 'A-B bond: when mother was bonded'), opt('always', 'A-B bond: always'), opt('never', 'A-B bond: never')], 'auto')],
    ['conserve', sel('Conserve', [opt('area', 'Conserve: area (πr²)'), opt('volume', 'Conserve: volume (4/3·πr³)')], 'area')],
  ])],
  ['neighbourCensus', new Map([['source', sel('Source', [opt('bonded', 'Bonded neighbours (1-ring)'), opt('nearby', 'Nearby agents (radius)')], 'bonded')]])],
  ['readCellsUnder', new Map([['reduce', sel('Reduce', [opt('mean', 'Mean'), opt('sum', 'Sum'), opt('max', 'Max'), opt('min', 'Min')], 'mean')]])],
  ['affectCellsUnder', new Map([['op', sel('Operation', [opt('set', 'Set'), opt('add', 'Add'), opt('subtract', 'Subtract'), opt('max', 'Max'), opt('min', 'Min')], 'set')]])],
  ['groupCounting', new Map<string, ScalarKeySpec>([
    ['operation', sel('Operation', [opt('equals', '=='), opt('notEquals', '!='), opt('greater', '>'), opt('lesser', '<'), opt('between', 'Between'), opt('notBetween', 'Not Between')], 'equals')],
    ['lowOp', sel('Low bound', LOW_OPS, '>=')],
    ['highOp', sel('High bound', HIGH_OPS, '<=')],
  ])],
  ['statement', new Map<string, ScalarKeySpec>([
    ['operation', sel('Operation', CMP_SYMBOL_OPS, '==')],
    ['lowOp', sel('Low bound', LOW_OPS, '>=')],
    ['highOp', sel('High bound', HIGH_OPS, '<=')],
  ])],
  ['logicOperator', new Map([['operation', sel('Operation', [opt('AND', 'AND'), opt('OR', 'OR'), opt('XOR', 'XOR'), opt('NOT', 'NOT')], 'AND')]])],
  ['groupStatement', new Map([['operation', sel('Operation', [
    opt('allIs', 'All Is'), opt('noneIs', 'None Is'), opt('hasA', 'Has A'), opt('allGreater', 'All Greater'),
    opt('allLesser', 'All Lesser'), opt('anyGreater', 'Any Greater'), opt('anyLesser', 'Any Lesser'),
  ], 'allIs')]])],
  ['groupOperator', new Map([['operation', sel('Operation', [
    opt('sum', 'Sum'), opt('mul', 'Multiply'), opt('max', 'Max'), opt('min', 'Min'), opt('mean', 'Mean'),
    opt('and', 'AND (all)'), opt('or', 'OR (any)'), opt('random', 'Pick Random'), opt('weightedRandom', 'Pick Weighted Random'),
  ], 'sum')]])],
  ['aggregate', new Map([['operation', sel('Operation', [
    opt('sum', 'Sum'), opt('product', 'Product'), opt('max', 'Max'), opt('min', 'Min'), opt('average', 'Average'),
    opt('median', 'Median'), opt('and', 'AND (all true)'), opt('or', 'OR (any true)'),
  ], 'sum')]])],
  ['arithmeticOperator', new Map([['operation', sel('Operation', [
    opt('+', '+ Add'), opt('-', '- Subtract'), opt('*', '* Multiply'), opt('/', '/ Divide'), opt('%', '% Modulo'),
    opt('sqrt', 'Sqrt'), opt('pow', 'Power'), opt('abs', 'Abs'), opt('negate', 'Negate (−x)'), opt('floor', 'Floor'),
    opt('ceil', 'Ceil'), opt('round', 'Round'), opt('max', 'Max'), opt('min', 'Min'), opt('mean', 'Mean'),
    opt('exp', 'Exp (eˣ)'), opt('log', 'Log (ln)'), opt('sin', 'Sin'), opt('cos', 'Cos'), opt('tan', 'Tan'), opt('tanh', 'Tanh'),
  ], '+')]])],
  ['vectorOp', new Map([['op', sel('Operation', [
    opt('add', 'Add (A + B)'), opt('subtract', 'Subtract (A − B)'), opt('scale', 'Scale (A × Scalar)'),
    opt('dot', 'Dot (A · B)'), opt('cross', 'Cross (A × B)'), opt('length', 'Length |A|'),
    opt('normalize', 'Normalize (Â)'), opt('distance', 'Distance |A − B|'), opt('negate', 'Negate (−A)'),
    opt('lerp', 'Lerp (A→B by T)'), opt('rotate2d', 'Rotate (A by Angle°, about Z)'), opt('rotateAxis', 'Rotate Around Axis (3D)'),
  ], 'add')]])],
  ['moveSelfToNeighbor', new Map<string, ScalarKeySpec>([
    ['operation', sel('Operation', [opt('copyTo', 'Copy To neighbor'), opt('copyFrom', 'Copy From neighbor'), opt('swap', 'Swap with neighbor')], 'copyTo')],
    ['nonReceiving', sel('Source cell', [opt('defaults', 'Source → defaults'), opt('untouched', 'Source untouched')], 'defaults')],
    ['includeOrientation', check('Include orientation')],
  ])],
  ['flipNeighborIndex', new Map([['mode', sel('Mode', [
    opt('horizontal', 'Flip horizontal (negate dCol)'), opt('vertical', 'Flip vertical (negate dRow)'), opt('both', 'Flip both (180° rotate)'),
  ], 'horizontal')]])],
  ['loop', new Map([['mode', sel('Mode', [opt('count', 'Count (Index 0..N-1)'), opt('range', 'Range (Index From..To)')], 'count')]])],
  ['getRandom', new Map<string, ScalarKeySpec>([
    ['randomType', sel('Type', [
      opt('bool', 'Binary'), opt('integer', 'Integer'), opt('float', 'Decimal'), opt('orientation', 'Orientation'),
      opt('options', 'Options'), opt('vector', 'Vector'), opt('color', 'Color'),
    ], 'float')],
    ['distribution', sel('Distribution', [opt('uniform', 'Uniform'), opt('normal', 'Normal (Gaussian)'), opt('exponential', 'Exponential')], 'uniform')],
    ['refSource', sel('Reference', [opt('angle', 'Around an angle'), opt('vector', 'Around a direction')], 'angle')],
  ])],
  ['setAgentSprite', new Map<string, ScalarKeySpec>([
    ['setSprite', { label: 'Change sprite', kind: 'checkbox', defaultValue: 'true' }],
    ['setFrame', check('Set frame')],
    ['setSpeed', check('Set speed')],
    ['setRotation', check('Set rotation')],
    ['setScale', check('Set scale')],
    ['setAlpha', check('Set alpha')],
    ['rotationMode', sel('Rotation mode', [opt('angle', 'by angle (°)'), opt('vector', 'by direction vector')], 'angle')],
  ])],
  ['switch', new Map([['firstMatchOnly', { label: 'First match only', kind: 'checkbox' as const, defaultValue: 'true' }]])],
  ['applyForce', new Map([['vectorInput', check('Vector input')]])],
  ['getGridDimensions', new Map([['withCenter', check('Output center')]])],
  ['getAllFacingLabels', new Map([['cardinalsOnly', check('Cardinals only')]])],
  ['periodicStep', new Map<string, ScalarKeySpec>([
    ['period', num('Period', '1')],
    ['phase', num('Phase')],
  ])],
  ['getAgentsInView', new Map<string, ScalarKeySpec>([
    ['halfAngle', num('Half-angle°', '60')],
    ['headingSource', sel('Heading', HEADING_SOURCES, 'velocity')],
    ['visionColor', { label: 'Cone colour', kind: 'color', defaultValue: '' }],
  ])],
  ['senseHemifield', new Map<string, ScalarKeySpec>([
    ['halfAngle', num('Half-angle°', '90')],
    ['headingSource', sel('Heading', HEADING_SOURCES, 'velocity')],
    ['visionColor', { label: 'Cone colour', kind: 'color', defaultValue: '' }],
  ])],
  ['stopEvent', new Map([['message', txt('Stop message')]])],
  ['ovLog', new Map([['text', txt('Message')]])],
  ['ovStopExperiment', new Map([['message', txt('Message')]])],
  ['ovScreenshot', new Map([['label', txt('Label')]])],
  ['ovCollectSample', new Map([['scope', sel('Scope', [opt('experiment', 'Scope: experiment'), opt('run', 'Scope: run (clears on Reset)')], 'experiment')]])],
  ['ovSeriesStat', new Map<string, ScalarKeySpec>([
    ['series', txt('Series')],
    ['op', sel('Statistic', [
      opt('mean', 'Mean'), opt('std', 'Std (sample)'), opt('min', 'Min'), opt('max', 'Max'),
      opt('median', 'Median'), opt('sum', 'Sum'), opt('count', 'Count'), opt('ci95', '95% CI half-width'),
    ], 'mean')],
  ])],
  ['ovCollectSpatial', new Map<string, ScalarKeySpec>([
    ['series', txt('Series')],
    ['chart', txt('Chart')],
  ])],
  ['ovSweepValues', new Map<string, ScalarKeySpec>([
    ['mode', sel('Mode', [opt('list', 'Explicit list'), opt('linspace', 'Evenly spaced (linspace)')], 'list')],
    ['list', txt('Values')],
    ['from', num('From')],
    ['to', num('To')],
    ['steps', num('Steps', '2')],
  ])],
  // --- adaptive: the options come from the TARGET's data type (D2) ---------
  ['updateAttribute', new Map([['operation', {
    label: 'Operation',
    kind: 'select' as const,
    options: (config: NodeConfig, model: CAModel) => {
      const dt = ownAttrListFor(model).find(a => a.id === config.attributeId)?.type || 'integer';
      return UPDATE_OPS_BY_TYPE[dt] ?? UPDATE_OPS_BY_TYPE.integer!;
    },
  }]])],
  ['updateIndicator', new Map([['operation', {
    label: 'Operation',
    kind: 'select' as const,
    options: (config: NodeConfig, model: CAModel) => {
      const dt = (model.indicators || []).find(i => i.id === config.indicatorId)?.dataType || 'integer';
      return UPDATE_OPS_BY_TYPE[dt] ?? UPDATE_OPS_BY_TYPE.integer!;
    },
  }]])],
  // `constValue`'s WIDGET follows `constType` — the class-B twin of the class-A
  // adaptive swap, and exactly why the kind may never be stored (D2 / R4).
  ['getConstant', new Map([['constValue', {
    label: 'Value',
    kind: (config: NodeConfig, model: CAModel): ControlWidgetKind | null => {
      const t = (config.constType as string) || 'integer';
      if (t === 'bool' || t === 'orientation' || t === 'faceLabel') return 'select';
      if (t === 'tag') {
        const opts = tagAttrScopeFor(model).find(a => a.id === config.tagAttributeId)?.tagOptions || [];
        return opts.length > 0 ? 'select' : null;   // CaNode renders nothing here
      }
      return 'number';
    },
    options: (config: NodeConfig, model: CAModel): ControlOption[] => {
      const t = (config.constType as string) || 'integer';
      if (t === 'bool') return [opt('true', 'true'), opt('false', 'false')];
      if (t === 'orientation') return [opt('0', 'N (0°)'), opt('1', 'E (90°)'), opt('2', 'S (180°)'), opt('3', 'W (270°)')];
      if (t === 'faceLabel') {
        const palettes = model.variegatedCells?.facePalettes ?? [];
        const pid = (config.facePaletteId as string) || palettes[0]?.id || '';
        const labels = palettes.find(p => p.id === pid)?.labels ?? [];
        return [opt('none', 'none (0)'), ...labels.map((lab, i) => opt(lab, `${lab} (${i + 1})`))];
      }
      if (t === 'tag') {
        const opts = tagAttrScopeFor(model).find(a => a.id === config.tagAttributeId)?.tagOptions || [];
        return opts.map((tag, i) => opt(String(i), tag));
      }
      return [];
    },
    defaultValue: '0',
  }]])],
]);

/** The interpolation-curve select, shared by Color Scale and Proportion Map. */
const INTERPOLATION_SPEC: ScalarKeySpec = {
  label: 'Curve',
  kind: 'select',
  options: INTERPOLATION_METHODS.map(m => opt(m.value, m.label)),
};

/** The free-text formula, shared by Expression and Logical Expression. */
const EXPRESSION_SPEC: ScalarKeySpec = { label: 'Formula', kind: 'textarea', defaultValue: '' };

/** Look a class-B key up, honouring the two SHARED specs whose node types are
 *  named by an exported set rather than by their own table row. */
function scalarSpecFor(nodeType: string, configKey: string): ScalarKeySpec | undefined {
  if (configKey === 'method' && (nodeType === 'colorScale' || nodeType === 'proportionMap')) return INTERPOLATION_SPEC;
  if (configKey === 'expression' && FORMULA_NODE_TYPES.has(nodeType)) return EXPRESSION_SPEC;
  return SCALAR_CONFIG_KEYS.get(nodeType)?.get(configKey);
}

/** Every class-B key a node type declares — the table row plus the two shared
 *  specs. Ordered so pick mode lists them the way the table is written. */
function scalarKeysFor(nodeType: string): string[] {
  const keys = [...(SCALAR_CONFIG_KEYS.get(nodeType)?.keys() ?? [])];
  if (nodeType === 'colorScale' || nodeType === 'proportionMap') keys.push('method');
  if (FORMULA_NODE_TYPES.has(nodeType)) keys.push('expression');
  return keys;
}

// ---------------------------------------------------------------------------
// Class C — model-element pickers (P4)
// ---------------------------------------------------------------------------

/**
 * The ~11 model-element id keys. P4 extracts the ~32 in-node list expressions
 * into `elementOptionsFor` and has CaNode CALL IT BACK, so the offered list can
 * never drift from the in-node picker's; until then class C is gated OFF by
 * default and `elementOptionsFor` returns `null`.
 */
export const CLASS_C_KEYS: ReadonlySet<string> = new Set([
  'attributeId', 'neighborhoodId', 'mappingId', 'indicatorId', 'variableId', 'spriteId',
  'tableId', 'tagAttributeId', 'facingAttributeId', 'partitionAttributeId', 'presetId',
]);

/**
 * The model-element option list for one (nodeType, configKey).
 *
 * ⚠ **P4 fills this in.** It returns `null` today, which is the "no list known"
 * answer every caller already handles; class C is correspondingly gated off by
 * `eligibleControlKeys`' default `classes`. The signature ships now so the
 * resolver's contract — and every call site — is frozen before P4 moves the ~32
 * JSX list expressions into it (V2's reasoning, applied to class C).
 */
export function elementOptionsFor(
  _nodeType: string,
  _configKey: string,
  _model: CAModel,
): ReadonlyArray<ControlOption> | null {
  return null;
}

// ---------------------------------------------------------------------------
// Eligibility — what pick mode offers
// ---------------------------------------------------------------------------

const DEFAULT_CLASSES: ReadonlySet<ControlClass> = new Set<ControlClass>(['A', 'B']);

/**
 * Every parameter of ONE node a control may bind, in render order: the inline
 * port widgets first (class A, in port order), then the scalar config keys
 * (class B), then the model-element pickers (class C — P4).
 *
 * `connectedHandles` is the set of TARGET handle ids wired on this node inside
 * the macro (built from `def.edges` exactly as `countMacroSubgraphIssues` does).
 * A wired port is still OFFERED — the control renders disabled with the reason
 * (D2), the *temporarily unavailable ⇒ grey it* arm of the enabled-control
 * doctrine — but it is flagged so pick mode can say so.
 */
export function eligibleControlKeys(
  nodeType: string,
  config: NodeConfig,
  model: CAModel,
  connectedHandles?: ReadonlySet<string>,
  classes: ReadonlySet<ControlClass> = DEFAULT_CLASSES,
): ControlKeyDescriptor[] {
  const def = getNodeDef(nodeType);
  if (!def) return [];
  const out: ControlKeyDescriptor[] = [];

  if (classes.has('A')) {
    const { inputs } = getEffectivePorts(nodeType, config, model);
    for (const port of inputs) {
      if (port.category !== 'value') continue;
      const configKey = `_port_${port.id}`;
      if (isExcludedControlKey(configKey)) continue;
      const w = inlineWidgetFor(nodeType, config, port, model);
      if (!w.kind) continue;
      const row: ControlKeyDescriptor = {
        configKey, label: port.label, kind: w.kind, klass: 'A',
      };
      if (w.kind === 'tag') row.options = (w.tagOptions ?? []).map((t, i) => opt(String(i), t));
      if (connectedHandles?.has(handleId(port))) row.wired = true;
      out.push(row);
    }
  }

  if (classes.has('B')) {
    for (const key of scalarKeysFor(nodeType)) {
      if (isExcludedControlKey(key)) continue;
      const spec = scalarSpecFor(nodeType, key);
      if (!spec) continue;
      const kind = typeof spec.kind === 'function' ? spec.kind(config, model) : spec.kind;
      if (!kind) continue;
      const row: ControlKeyDescriptor = { configKey: key, label: spec.label, kind, klass: 'B' };
      const options = typeof spec.options === 'function' ? spec.options(config, model) : spec.options;
      if (options) row.options = options;
      out.push(row);
    }
  }

  if (classes.has('C')) {
    // ⚠ P4: `defaultConfig` is a PLACEHOLDER key source — many `*Id` keys are
    // never declared there (a node type that leaves its picker unset simply has
    // no default). The extraction must decide the per-nodeType key set from the
    // ~32 JSX picker blocks it moves, exactly as `SCALAR_CONFIG_KEYS` does for
    // class B. Unreachable today: `elementOptionsFor` returns null.
    for (const key of Object.keys(def.defaultConfig)) {
      if (!CLASS_C_KEYS.has(key)) continue;
      if (isExcludedControlKey(key)) continue;
      const options = elementOptionsFor(nodeType, key, model);
      if (!options) continue;   // P4 fills the table; until then nothing is offered
      out.push({ configKey: key, label: key, kind: 'element', klass: 'C', options });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

const findDef = (macroDefs: readonly MacroDef[], defId: string): MacroDef | undefined =>
  macroDefs.find(d => d.id === defId);

/**
 * Walk a `ControlTarget` to its ultimate WRITE ADDRESS, following chained
 * (`kind: 'control'`) targets through nested macro instances until a `config`
 * target is reached (D4).
 *
 * ⚠ The returned `defId` may be a NESTED def — a chained write does NOT land in
 * the def that owns the control, which is exactly why `applyControlValue`
 * returns the def to dispatch rather than assuming it.
 *
 * Cycle-guarded by a `seen` set of `defId::controlId` PLUS a depth cap
 * mirroring the three guards that already exist (`expandMacros` 20,
 * `MAX_MACRO_DEPTH` 20, `isMacroAvailableOnGraph`'s `seen`).
 */
export function resolveTarget(
  macroDefs: readonly MacroDef[],
  defId: string,
  target: ControlTarget,
  seen: Set<string> = new Set(),
  depth = 0,
): { ok: true; at: ResolvedTarget } | { ok: false; block: ControlBlock } {
  if (depth > CONTROL_MAX_CHAIN_DEPTH) return { ok: false, block: 'cycle' };
  const def = findDef(macroDefs, defId);
  if (!def) return { ok: false, block: 'orphan-def' };
  const node = def.nodes.find(n => n.id === target.nodeId);
  if (!node) return { ok: false, block: 'orphan-node' };

  if (target.kind === 'config') return { ok: true, at: { defId, nodeId: node.id, configKey: target.configKey } };

  // Chained: the node must be a macro INSTANCE, and the def it points at must
  // still declare the named control.
  const innerId = node.data?.config?.macroDefId as string | undefined;
  if (node.data?.nodeType !== 'macro' || !innerId) return { ok: false, block: 'orphan-node' };
  const inner = findDef(macroDefs, innerId);
  if (!inner) return { ok: false, block: 'orphan-def' };
  const key = `${innerId}::${target.controlId}`;
  if (seen.has(key)) return { ok: false, block: 'cycle' };
  seen.add(key);
  const inner_ctl = (inner.controls ?? []).find(c => c.id === target.controlId);
  if (!inner_ctl) return { ok: false, block: 'orphan-control' };
  return resolveTarget(macroDefs, innerId, inner_ctl.target, seen, depth + 1);
}

/** Which target handles are wired on each node inside a def — the same build
 *  `countMacroSubgraphIssues` does (nodeValidation.ts L825-832). */
function connectedHandlesOf(def: MacroDef, nodeId: string): Set<string> {
  const out = new Set<string>();
  for (const e of def.edges) {
    if (e.target === nodeId && e.targetHandle) out.add(e.targetHandle);
  }
  return out;
}

/**
 * Everything the closed instance needs to render ONE control.
 *
 * NEVER returns null: an unresolvable control comes back with `block` + `reason`
 * so it renders DISABLED WITH ITS REASON (D8 — report, never drop). Auto-delete
 * is rejected outright: a node delete inside the macro is UNDOABLE, and Ctrl+Z
 * would restore the node but not a destroyed control, so one mis-click would
 * silently destroy the author's named interface.
 *
 * `openScopeIds` is the currently-open macro scope chain (R7): an instance-side
 * write against the def being edited would be clobbered by the next 100 ms
 * debounce tick, so such a control renders disabled instead.
 */
export function resolveControlDescriptor(
  model: CAModel,
  defId: string,
  control: MacroControl,
  openScopeIds?: readonly string[],
): ControlDescriptor {
  const macroDefs = model.macroDefs ?? [];
  const label = control.name;
  const blocked = (block: ControlBlock, resolved: ResolvedTarget | null = null): ControlDescriptor =>
    ({ kind: 'text', value: '', label, resolved, block, reason: CONTROL_BLOCK_REASON[block] });

  const res = resolveTarget(macroDefs, defId, control.target);
  if (!res.ok) return blocked(res.block);
  const at = res.at;

  const ownerDef = findDef(macroDefs, at.defId);
  if (!ownerDef) return blocked('orphan-def');
  const node = ownerDef.nodes.find(n => n.id === at.nodeId);
  if (!node) return blocked('orphan-node', at);
  const nodeType = node.data?.nodeType;
  if (!nodeType || !getNodeDef(nodeType)) return blocked('orphan-node', at);
  const config = (node.data.config ?? {}) as NodeConfig;

  if (isExcludedControlKey(at.configKey)) return blocked('orphan-key', at);

  const built = describeKey(nodeType, config, model, at.configKey, ownerDef, at.nodeId);
  if (!built) return blocked('orphan-key', at);

  // R7 — the def that OWNS the key is open for editing.
  if (openScopeIds && openScopeIds.includes(at.defId)) {
    return { ...built, label, resolved: at, block: 'scope-open', reason: CONTROL_BLOCK_REASON['scope-open'] };
  }
  if (built.wired) {
    return { ...built, label, resolved: at, block: 'wired', reason: CONTROL_BLOCK_REASON.wired };
  }
  return { kind: built.kind, value: built.value, label, options: built.options, resolved: at };
}

interface BuiltKey { kind: ControlWidgetKind; value: string; options?: ReadonlyArray<ControlOption>; wired?: boolean }

/** Resolve ONE (nodeType, configKey) to its live kind / value / options. The
 *  shared core of `resolveControlDescriptor`; `null` ⇒ the key is not a
 *  parameter this node has in its current configuration. */
function describeKey(
  nodeType: string,
  config: NodeConfig,
  model: CAModel,
  configKey: string,
  ownerDef: MacroDef,
  nodeId: string,
): BuiltKey | null {
  // --- class A ------------------------------------------------------------
  if (configKey.startsWith('_port_')) {
    const portId = configKey.slice('_port_'.length);
    const port = getEffectivePorts(nodeType, config, model).inputs.find(p => p.id === portId);
    if (!port || port.category !== 'value') return null;
    const w = inlineWidgetFor(nodeType, config, port, model);
    if (!w.kind) return null;
    const wired = connectedHandlesOf(ownerDef, nodeId).has(handleId(port));
    const value = (config[configKey] as string) ?? port.defaultValue ?? '';
    const out: BuiltKey = { kind: w.kind, value: String(value), wired };
    if (w.kind === 'tag') out.options = (w.tagOptions ?? []).map((t, i) => opt(String(i), t));
    return out;
  }

  // --- class B ------------------------------------------------------------
  const spec = scalarSpecFor(nodeType, configKey);
  if (spec) {
    const kind = typeof spec.kind === 'function' ? spec.kind(config, model) : spec.kind;
    if (!kind) return null;
    const options = typeof spec.options === 'function' ? spec.options(config, model) : spec.options;
    const raw = config[configKey];
    const value = raw === undefined ? (spec.defaultValue ?? '') : String(raw);
    return options ? { kind, value, options } : { kind, value };
  }

  // --- class C (P4) -------------------------------------------------------
  if (CLASS_C_KEYS.has(configKey)) {
    const options = elementOptionsFor(nodeType, configKey, model);
    if (!options) return null;
    return { kind: 'element', value: String(config[configKey] ?? ''), options };
  }

  return null;
}

/** The pick-mode subtitle for a bound target: `Node label · Parameter label`.
 *  Resolved from the SAME descriptor the instance renders, so the editor can
 *  never name a parameter the resolver does not know about. */
export function describeControlTarget(
  model: CAModel,
  defId: string,
  control: MacroControl,
): { text: string; block?: ControlBlock } {
  const macroDefs = model.macroDefs ?? [];
  const res = resolveTarget(macroDefs, defId, control.target);
  if (!res.ok) return { text: CONTROL_BLOCK_REASON[res.block], block: res.block };
  const ownerDef = findDef(macroDefs, res.at.defId);
  const node = ownerDef?.nodes.find(n => n.id === res.at.nodeId);
  const nodeType = node?.data?.nodeType;
  const def = nodeType ? getNodeDef(nodeType) : undefined;
  if (!def || !node) return { text: CONTROL_BLOCK_REASON['orphan-node'], block: 'orphan-node' };
  const built = describeKey(nodeType!, (node.data.config ?? {}) as NodeConfig, model, res.at.configKey, ownerDef!, res.at.nodeId);
  const keyLabel = built
    ? (eligibleControlKeys(nodeType!, (node.data.config ?? {}) as NodeConfig, model)
      .find(k => k.configKey === res.at.configKey)?.label ?? res.at.configKey)
    : res.at.configKey;
  return { text: `${displayNodeLabel(def)} · ${keyLabel}`, ...(built ? {} : { block: 'orphan-key' as const }) };
}

// ---------------------------------------------------------------------------
// The write path — ONE dispatch (D6)
// ---------------------------------------------------------------------------

/**
 * Build the ONE `updateMacro` a control edit dispatches.
 *
 * Returns the def that OWNS the key — which for a CHAINED control is a NESTED
 * def, not the one holding the control — together with its fully-patched node
 * array. The caller does exactly ONE dispatch; building the merged object first
 * is the documented "never call updateConfig twice in sequence" rule.
 *
 * Returns `null` when the control is BLOCKED (orphaned / circular / wired /
 * scope-open) — a disabled control's handler must be inert, and returning null
 * makes that structural rather than a UI convention.
 *
 * Every UNTOUCHED node keeps its object IDENTITY (only the target node is
 * rebuilt), so React's memoised nodes do not re-render for a sibling's edit.
 */
export function applyControlValue(
  model: CAModel,
  defId: string,
  control: MacroControl,
  value: string,
  openScopeIds?: readonly string[],
): { defId: string; nodes: GraphNode[] } | null {
  const desc = resolveControlDescriptor(model, defId, control, openScopeIds);
  if (desc.block || !desc.resolved) return null;
  const at = desc.resolved;
  const ownerDef = findDef(model.macroDefs ?? [], at.defId);
  if (!ownerDef) return null;
  let hit = false;
  const nodes = ownerDef.nodes.map(n => {
    if (n.id !== at.nodeId) return n;
    hit = true;
    return { ...n, data: { ...n.data, config: { ...n.data.config, [at.configKey]: value } } };
  });
  if (!hit) return null;
  return { defId: at.defId, nodes };
}
