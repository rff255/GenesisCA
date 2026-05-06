/**
 * Shared interpolation curve metadata used by ColorInterpolation and
 * ProportionMap. The same `value` strings are read by all three compile
 * targets (JS, WASM, WebGPU); keep the lists here in sync.
 *
 * Curve domain is `t ∈ [0, 1]`. Linear keeps un-clamped extrapolation so
 * older saved models behave bit-identically; every other method clamps t
 * to [0, 1] before applying the curve.
 */

export type InterpolationMethod =
  | 'linear'
  | 'smoothstep'
  | 'easeInQuad'
  | 'easeOutQuad'
  | 'exponential'
  | 'logarithmic';

export const INTERPOLATION_METHODS: { value: InterpolationMethod; label: string }[] = [
  { value: 'linear',       label: 'Linear' },
  { value: 'smoothstep',   label: 'Smoothstep' },
  { value: 'easeInQuad',   label: 'Ease-In Quadratic' },
  { value: 'easeOutQuad',  label: 'Ease-Out Quadratic' },
  { value: 'exponential',  label: 'Exponential' },
  { value: 'logarithmic',  label: 'Logarithmic' },
];

export const DEFAULT_INTERPOLATION_METHOD: InterpolationMethod = 'linear';

/** Short labels used in collapsed-node display. */
export const INTERPOLATION_SHORT_LABELS: Record<InterpolationMethod, string> = {
  linear: 'Linear',
  smoothstep: 'Smooth',
  easeInQuad: 'Ease-In',
  easeOutQuad: 'Ease-Out',
  exponential: 'Expo',
  logarithmic: 'Log',
};

/**
 * Emit JS that declares `_v{nodeId}_tf` holding the curved `t` value
 * (and any helper locals it needs). Caller then references `_v{nodeId}_tf`
 * directly. Variable names follow the `_v{id}_*` convention so macro
 * inlining's prefix-replace catches them.
 */
export function emitInterpolationCurveJS(
  nodeId: string,
  rawTExpr: string,
  method: InterpolationMethod | string,
): string {
  const tRaw = `_v${nodeId}_traw`;
  const tcl = `_v${nodeId}_tcl`;
  const tf = `_v${nodeId}_tf`;
  const head = `const ${tRaw} = (${rawTExpr});`;
  switch (method) {
    case 'smoothstep':
      return `${head} const ${tcl} = Math.max(0, Math.min(1, ${tRaw})); const ${tf} = ${tcl} * ${tcl} * (3 - 2 * ${tcl});`;
    case 'easeInQuad':
      return `${head} const ${tcl} = Math.max(0, Math.min(1, ${tRaw})); const ${tf} = ${tcl} * ${tcl};`;
    case 'easeOutQuad':
      return `${head} const ${tcl} = Math.max(0, Math.min(1, ${tRaw})); const ${tf} = 1 - (1 - ${tcl}) * (1 - ${tcl});`;
    case 'exponential':
      return `${head} const ${tcl} = Math.max(0, Math.min(1, ${tRaw})); const ${tf} = ${tcl} <= 0 ? 0 : Math.pow(2, 10 * (${tcl} - 1));`;
    case 'logarithmic':
      return `${head} const ${tcl} = Math.max(0, Math.min(1, ${tRaw})); const ${tf} = ${tcl} >= 1 ? 1 : 1 - Math.pow(2, -10 * ${tcl});`;
    case 'linear':
    default:
      return `${head} const ${tf} = ${tRaw};`;
  }
}

/** Variable name carrying the curved `t` after `emitInterpolationCurveJS`. */
export function curvedTVarName(nodeId: string): string {
  return `_v${nodeId}_tf`;
}
