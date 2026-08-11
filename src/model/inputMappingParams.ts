/**
 * Parameterized Input Mappings — THE RESOLVER (the single source of truth).
 *
 * An Input Mapping (C→A) is the graph that runs when the user paints. Its
 * interface to the outside world used to be three hardcoded integer outputs —
 * `r`, `g`, `b` — fed by a colour picker. A mapping may now declare its OWN
 * named parameter list (`Mapping.parameters`); each parameter becomes value
 * output ports on the mapping's event root and one widget in the brush panel.
 *
 * ┌─ THE LOAD-BEARING ABSTRACTION ────────────────────────────────────────────┐
 * │ A parameter has N CHANNELS. `color` → 3; every other type → 1.            │
 * │ The PORT list, the ABI argument list, and the paint `values` payload are  │
 * │ ALL the flat channel list, in declared order.                            │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ THE GOVERNING SAFETY PRINCIPLE ──────────────────────────────────────────┐
 * │ `parameters` ABSENT ⇒ the LEGACY colour mapping ⇒ byte-identical emit on  │
 * │ every surface. The legacy resolution mints exactly one `color` parameter  │
 * │ whose channel PORT ids are `r`/`g`/`b` and whose JS ABI names are         │
 * │ `_r`/`_g`/`_b` (and, on WASM, param indices 1/2/3 as **i32**).            │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * ⚠ THE SHARP EDGE: `undefined` ≠ `[]`.
 *   `parameters: undefined` means LEGACY COLOUR.
 *   `parameters: []`        means EXPLICITLY NO PARAMETERS (a stamp that ignores
 *                           the brush entirely — a legitimate thing to author).
 *   Any `mapping.parameters?.length ? … : legacy` test silently mis-classifies
 *   `[]` as legacy. The distinction is therefore made in EXACTLY ONE PLACE —
 *   `inputParamsOf` below — and NOTHING ELSE may read `mapping.parameters`
 *   directly (except the reducer and the parameter editor). This is the
 *   `resolveMaxBonds` / `resolveAxes` / `agentAbiShapeOf` discipline.
 */

import type { CAModel, InputMappingParam, InputParamType, Mapping } from './types';
import type { PortDef } from '../modeler/vpl/types';
import { encodeAttrValue } from './attrValueEncoding';
import { hexToRgba, rgbaToHex } from './colorHex';

/** The key of the synthesised legacy parameter. Never written to a file. */
export const LEGACY_COLOR_PARAM_KEY = 'color';

/** Channel suffixes of a `color` parameter, in payload order. */
export const COLOR_CHANNEL_SUFFIXES = ['r', 'g', 'b'] as const;

/** ONE resolved channel = one port, one ABI argument, one `values[]` slot. */
export interface ResolvedChannel {
  /** `key` of the owning parameter. */
  paramKey: string;
  /** Port id AND edge-handle suffix (`output_value_<portId>`).
   *  Legacy: `'r' | 'g' | 'b'`. */
  portId: string;
  /** JS ABI identifier. Legacy: `'_r' | '_g' | '_b'`. */
  argName: string;
  /** Port label (e.g. `Energy`, `Tint R`). */
  label: string;
  /** The PORT's declared data type. */
  dataType: 'integer' | 'float' | 'bool';
  /** Index of this channel WITHIN its parameter (0 for a scalar; 0/1/2 for colour). */
  channelIdx: number;
}

export interface ResolvedParam {
  param: InputMappingParam;
  channels: ResolvedChannel[];
}

export interface ResolvedInputParams {
  /** TRUE only when `mapping.parameters` was ABSENT. Drives every
   *  byte-identity branch downstream. */
  legacy: boolean;
  params: ResolvedParam[];
  /** The FLAT channel list — ports, the ABI and the values payload all iterate THIS. */
  channels: ResolvedChannel[];
}

/** How many `values[]` slots a parameter of this type occupies. */
export function paramChannelCount(type: InputParamType): number {
  return type === 'color' ? 3 : 1;
}

/** The PORT data type a parameter's channels carry. A colour channel is an
 *  0..255 integer; a tag channel is its option index. */
function channelDataType(type: InputParamType): 'integer' | 'float' | 'bool' {
  switch (type) {
    case 'float': return 'float';
    case 'bool': return 'bool';
    default: return 'integer';   // integer | tag | color
  }
}

/** Sanitise a parameter key into the `[A-Za-z0-9_]` space port ids + ABI
 *  identifiers live in. The editor enforces this on entry; the resolver
 *  re-applies it defensively so a hand-edited file can never mint an
 *  identifier the emitters would choke on. */
export function sanitiseParamKey(key: string): string {
  const s = (key || '').replace(/[^A-Za-z0-9_]/g, '_');
  return s === '' ? '_' : s;
}

/** The legacy resolution: ONE `color` parameter, channels `r`/`g`/`b`, ABI
 *  names `_r`/`_g`/`_b` — i.e. exactly what every model emitted before
 *  parameters existed. */
const LEGACY_PARAM: InputMappingParam = {
  key: LEGACY_COLOR_PARAM_KEY,
  name: 'Brush colour',
  type: 'color',
  defaultValue: '#4cc9f0',
};

function legacyResolved(): ResolvedInputParams {
  const channels: ResolvedChannel[] = COLOR_CHANNEL_SUFFIXES.map((suffix, i) => ({
    paramKey: LEGACY_COLOR_PARAM_KEY,
    portId: suffix,                       // 'r' | 'g' | 'b'  — the historical handle ids
    argName: `_${suffix}`,                // '_r' | '_g' | '_b' — the historical JS ABI
    label: suffix.toUpperCase(),          // 'R' | 'G' | 'B'
    dataType: 'integer',
    channelIdx: i,
  }));
  return { legacy: true, params: [{ param: LEGACY_PARAM, channels }], channels };
}

/** Frozen so a consumer cannot mutate the shared legacy resolution. Rebuilt per
 *  call would be wasteful (this runs per port render); the arrays are treated
 *  as read-only by every consumer. */
const LEGACY_RESOLVED = legacyResolved();

/**
 * THE RESOLVER. Absent `parameters` ⇒ the legacy colour parameter (three
 * channels named exactly `r`/`g`/`b`); an EMPTY array ⇒ zero channels.
 *
 * Port ids are de-duplicated defensively: a `color` parameter keyed `tint`
 * mints `tint_r`, which a sibling scalar keyed literally `tint_r` would
 * collide with. A collision would make two channels share one port id and one
 * ABI name — the silent-wrong-variable class — so later duplicates get a
 * numeric suffix.
 */
export function inputParamsOf(mapping: Mapping | undefined | null): ResolvedInputParams {
  const declared = mapping?.parameters;
  if (!declared) return LEGACY_RESOLVED;

  const used = new Set<string>();
  const uniquePortId = (base: string): string => {
    let id = base;
    let n = 2;
    while (used.has(id)) id = `${base}_${n++}`;
    used.add(id);
    return id;
  };

  const params: ResolvedParam[] = [];
  const channels: ResolvedChannel[] = [];
  for (const p of declared) {
    const key = sanitiseParamKey(p.key);
    const dataType = channelDataType(p.type);
    const own: ResolvedChannel[] = [];
    if (p.type === 'color') {
      COLOR_CHANNEL_SUFFIXES.forEach((suffix, i) => {
        const portId = uniquePortId(`${key}_${suffix}`);
        own.push({
          paramKey: p.key, portId, argName: `_p_${portId}`,
          label: `${p.name || key} ${suffix.toUpperCase()}`,
          dataType, channelIdx: i,
        });
      });
    } else {
      const portId = uniquePortId(key);
      own.push({
        paramKey: p.key, portId, argName: `_p_${portId}`,
        label: p.name || key, dataType, channelIdx: 0,
      });
    }
    params.push({ param: p, channels: own });
    channels.push(...own);
  }
  return { legacy: false, params, channels };
}

/** Resolve the C→A mapping an input-mapping ROOT node points at. `inputColor`
 *  reads `model.mappings`; `agentInputMapping` reads `model.agentMappings`.
 *  Returns undefined for an unset / unknown id ⇒ the caller resolves LEGACY,
 *  which is also the right answer for a freshly-dropped root. */
export function inputMappingForNode(
  nodeType: string,
  config: Record<string, unknown> | undefined,
  model?: Pick<CAModel, 'mappings' | 'agentMappings'> | null,
): Mapping | undefined {
  if (!model) return undefined;
  const id = (config?.mappingId as string) || '';
  if (!id) return undefined;
  const list = nodeType === 'agentInputMapping' ? model.agentMappings : model.mappings;
  return (list ?? []).find(m => m.id === id);
}

/** Resolve the channel list for an input-mapping ROOT node (the shape its ports
 *  and its compiled signature take). */
export function inputParamsForNode(
  nodeType: string,
  config: Record<string, unknown> | undefined,
  model?: Pick<CAModel, 'mappings' | 'agentMappings'> | null,
): ResolvedInputParams {
  return inputParamsOf(inputMappingForNode(nodeType, config, model));
}

/** True for the two input-mapping event roots. */
export function isInputMappingRoot(nodeType: string): boolean {
  return nodeType === 'inputColor' || nodeType === 'agentInputMapping';
}

/**
 * The DYNAMIC value-output ports of an input-mapping root — one per resolved
 * channel. Consumed by BOTH `CaNode`'s render path AND
 * `effectivePorts.getEffectivePorts` (the `buildExtraSlotPorts` /
 * `buildCensusPorts` dual-consumption discipline: if those two drift,
 * drag-and-drop offers ports the canvas never renders).
 *
 * With no model (the panel-drag compatibility check for a not-yet-spawned node)
 * this returns the LEGACY r/g/b shape — which is also the right answer, since a
 * freshly-dropped root carries `mappingId: ''`.
 */
export function buildInputParamPorts(
  nodeType: string,
  config: Record<string, unknown> | undefined,
  model?: Pick<CAModel, 'mappings' | 'agentMappings'> | null,
): { inputs: PortDef[]; outputs: PortDef[] } {
  if (!isInputMappingRoot(nodeType)) return { inputs: [], outputs: [] };
  const resolved = inputParamsForNode(nodeType, config, model);
  return {
    inputs: [],
    outputs: resolved.channels.map(c => ({
      id: c.portId, label: c.label,
      kind: 'output' as const, category: 'value' as const, dataType: c.dataType,
    })),
  };
}

// ---------------------------------------------------------------------------
// Values — the brush payload
// ---------------------------------------------------------------------------

/** Per-mapping brush state: one canonical STRING per PARAMETER (`key` →
 *  value), in the same encoding `Attribute.defaultValue` uses. A `color`
 *  parameter stores one `#rrggbb` and is split into its three channels at
 *  encode time, so the panel can render ONE `ColorField` for it. */
export type InputParamValues = Record<string, string>;

/** The type's own fallback when a parameter declares no `defaultValue`. */
export function paramFallbackValue(param: InputMappingParam): string {
  if (param.defaultValue !== undefined && param.defaultValue !== '') return param.defaultValue;
  switch (param.type) {
    case 'bool': return 'false';
    case 'color': return '#000000';
    default: return '0';
  }
}

/** Encode ONE channel of a parameter into the number the ABI carries.
 *  Scalars reuse `encodeAttrValue` verbatim (the type names are identical), so
 *  the brush widgets and the payload cannot disagree. */
export function encodeParamValue(param: InputMappingParam, channelIdx: number, raw?: string): number {
  const v = raw !== undefined && raw !== '' ? raw : paramFallbackValue(param);
  if (param.type === 'color') {
    const c = hexToRgba(v, { r: 0, g: 0, b: 0, a: 255 });
    return channelIdx === 0 ? c.r : channelIdx === 1 ? c.g : c.b;
  }
  return encodeAttrValue({ type: param.type, defaultValue: paramFallbackValue(param) }, v);
}

/** Inverse of `encodeParamValue` over a whole parameter (all its channels) —
 *  numbers back to the canonical string the widgets edit. */
export function decodeParamValue(param: InputMappingParam, values: number[]): string {
  if (param.type === 'color') {
    return rgbaToHex({ r: values[0] ?? 0, g: values[1] ?? 0, b: values[2] ?? 0 });
  }
  const n = values[0] ?? 0;
  switch (param.type) {
    case 'bool': return n ? 'true' : 'false';
    case 'float': return String(n);
    default: return String(Math.round(n));
  }
}

/** Build the flat `values[]` paint payload from per-parameter brush strings.
 *  A missing entry falls back to the parameter's `defaultValue`, then to the
 *  type's own fallback — so a payload is ALWAYS the full channel count. */
export function encodeChannelValues(
  resolved: ResolvedInputParams,
  values: InputParamValues | undefined,
): number[] {
  const out: number[] = [];
  for (const rp of resolved.params) {
    const raw = values?.[rp.param.key];
    for (const ch of rp.channels) out.push(encodeParamValue(rp.param, ch.channelIdx, raw));
  }
  return out;
}

/** The payload a brush sends before the user touches anything. */
export function channelDefaults(resolved: ResolvedInputParams): number[] {
  return encodeChannelValues(resolved, undefined);
}

/** Resolve a `tag` parameter's option list: a live tag ATTRIBUTE (cell/model
 *  first, then agent — the `findTagAttrById` precedent) takes precedence over
 *  the inline `tagOptions`. */
export function paramTagOptions(
  param: InputMappingParam,
  model?: Pick<CAModel, 'attributes' | 'agentAttributes'> | null,
): string[] {
  if (param.tagAttributeId && model) {
    const attr = (model.attributes ?? []).find(a => a.id === param.tagAttributeId)
      ?? (model.agentAttributes ?? []).find(a => a.id === param.tagAttributeId);
    if (attr?.tagOptions?.length) return [...attr.tagOptions];
  }
  return param.tagOptions ? [...param.tagOptions] : [];
}
