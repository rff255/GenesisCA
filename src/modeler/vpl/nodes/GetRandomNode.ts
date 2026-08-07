import type { NodeTypeDef } from '../types';

/**
 * Shared Get Random constants + resolvers, imported by ALL SIX RNG-bearing emit
 * surfaces (JS cell, WASM cell, WebGPU cell, agentWasm, agentWebgpu, Overseer)
 * so the mode/distribution vocabulary and the draw COUNT can never drift.
 *
 * ── DRAW COUNTS (the cross-target stream contract) ───────────────────────────
 *   bool / integer / orientation / options / vector      1 draw
 *   float · uniform                                      1 draw
 *   float · normal (Box-Muller)                          2 draws
 *   float · exponential                                  1 draw
 * Every distribution is FIXED-COUNT — no rejection loops — so the shared
 * xorshift32 stream (JS/WASM) and the per-cell/per-agent PCG (WebGPU) advance
 * the same number of times on every target.
 *
 * ── COMPASS CONVENTION (vector mode) ─────────────────────────────────────────
 * Degrees clockwise from NORTH, matching the sprite heading convention
 * (`atan2(dx, -dy)`): 0° = north = up = -y, 90° = east = +x, 180° = south = +y.
 * A unit heading is therefore `(sin θ, -cos θ)`.
 */
export const RANDOM_DEG2RAD = 0.017453292519943295; // Math.PI / 180
export const RANDOM_TAU = 6.283185307179586;        // Math.PI * 2
/** Divisor guard for the vector-mode reference normalise — keeps a zero-length
 *  direction from producing NaN (0 * 1e30 === 0), so the north fallback select
 *  is the ONLY branch needed. Mirrored verbatim on every target. */
export const RANDOM_LEN_EPS = 1e-30;

/** How many times a given (mode, distribution) advances the RNG stream. */
export function randomDrawCount(randomType: string, distribution: string): number {
  return randomType === 'float' && distribution === 'normal' ? 2 : 1;
}

/** The distribution actually in force. Only the DECIMAL mode is parameterised —
 *  integer stays uniform (a discrete Gaussian is a separate feature), and the
 *  other modes have no numeric range at all. Absent ⇒ 'uniform' ⇒ the historical
 *  emit, byte for byte. */
export function randomDistribution(config: Record<string, unknown> | undefined, randomType: string): string {
  if (randomType !== 'float') return 'uniform';
  const d = config?.['distribution'];
  return d === 'normal' || d === 'exponential' ? d : 'uniform';
}

/** Vector mode's reference-direction source: a compass ANGLE (default) or a
 *  wired VECTOR the span is centred on. */
export function randomRefSource(config: Record<string, unknown> | undefined): 'angle' | 'vector' {
  return config?.['refSource'] === 'vector' ? 'vector' : 'angle';
}

export const GetRandomNode: NodeTypeDef = {
  type: 'getRandom',
  label: 'Get Random',
  description: 'Random value: binary (1 with probability P, else 0), integer in [Min, Max], decimal (uniform in [Min, Max), normal with Mean/Std Dev, or exponential with Mean), orientation (uniform 0..3 = N/E/S/W), one option uniformly picked from the wired Options array (Fallback if empty), or a random VECTOR of length Norm whose direction is uniform within Span° of a reference (a compass angle — 0° = north/up, 90° = east — or a wired direction).',
  category: 'data',
  color: '#b71c1c',
  ports: [
    { id: 'probability', label: 'P', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0.5' },
    // Min / Max are PORTS (not config) so a rule can drive the interval from a
    // model attribute, an expression, a neighbour read — anything.
    { id: 'min', label: 'Min', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
    { id: 'max', label: 'Max', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '1' },
    // Shared by normal (centre) and exponential (scale = 1/λ). Exponential takes
    // a MEAN rather than a rate so there is no divide — and therefore no
    // divide-by-zero guard to keep in step across six emitters.
    { id: 'mean', label: 'Mean', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
    { id: 'stddev', label: 'Std Dev', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '1' },
    { id: 'options', label: 'Options', kind: 'input', category: 'value', dataType: 'any', isArray: true },
    { id: 'fallback', label: 'Fallback', kind: 'input', category: 'value', dataType: 'any', inlineWidget: 'number', defaultValue: '0' },
    // -- vector mode --
    { id: 'norm', label: 'Norm', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '1' },
    { id: 'angle', label: 'Angle°', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
    { id: 'dirX', label: 'Dir X', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
    { id: 'dirY', label: 'Dir Y', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '-1' },
    { id: 'span', label: 'Span°', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '360' },
    { id: 'value', label: 'Value', kind: 'output', category: 'value', dataType: 'any' },
    // Vector mode is MULTI-OUTPUT: the two scalar components plus the composite
    // `vector` port (lowered by expandComposites to these very components, so a
    // composite wire costs no extra draw — it resolves to the SAME node).
    { id: 'x', label: 'X', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'y', label: 'Y', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'vector', label: 'Vector', kind: 'output', category: 'value', dataType: 'vector' },
  ],
  // No `min`/`max` here any more — they are PORTS, so their values live in
  // `_port_min` / `_port_max` (seeded from the port defaultValue when absent).
  // `distribution` / `refSource` likewise default through their resolvers, so an
  // absent key is exactly the historical behaviour.
  defaultConfig: { randomType: 'float' },
  // Every port that carries no meaning under the current mode/distribution is
  // hidden (the declarative NodeTypeDef.hiddenPorts hook — CaNode and
  // effectivePorts both apply it, so the rule lives here once).
  hiddenPorts: (config) => {
    const t = (config.randomType as string) || 'float';
    const dist = randomDistribution(config as Record<string, unknown>, t);
    const ref = randomRefSource(config as Record<string, unknown>);
    const hidden: string[] = [];
    if (t !== 'bool') hidden.push('probability');
    if (t !== 'options') hidden.push('options', 'fallback');
    // Min/Max: integer always, decimal only while uniform.
    if (!(t === 'integer' || (t === 'float' && dist === 'uniform'))) hidden.push('min', 'max');
    if (!(t === 'float' && (dist === 'normal' || dist === 'exponential'))) hidden.push('mean');
    if (!(t === 'float' && dist === 'normal')) hidden.push('stddev');
    if (t !== 'vector') {
      hidden.push('norm', 'angle', 'dirX', 'dirY', 'span', 'x', 'y', 'vector');
    } else {
      hidden.push('value');
      if (ref === 'vector') hidden.push('angle'); else hidden.push('dirX', 'dirY');
    }
    return hidden;
  },
  compile: (nodeId, config, inputVars) => {
    const type = (config.randomType as string) || 'float';
    const dist = randomDistribution(config as unknown as Record<string, unknown>, type);
    const min = inputVars.min ?? '0';
    const max = inputVars.max ?? '1';
    // Inlined xorshift32 (Marsaglia constants 13/17/5, period 2^32 - 1).
    // _rs is a uint32 declared once per compiled function; the >>> 0 normalises
    // after << overflow so the final divide by 2^32 lands in [0, 1).
    const advance = '_rs = (_rs ^ (_rs << 13)) >>> 0;'
      + ' _rs = (_rs ^ (_rs >>> 17)) >>> 0;'
      + ' _rs = (_rs ^ (_rs << 5)) >>> 0;';
    if (type === 'bool') {
      const prob = inputVars.probability ?? '0.5';
      return `${advance} const _v${nodeId} = (_rs / 4294967296) < ${prob} ? 1 : 0;\n`;
    } else if (type === 'integer') {
      return `${advance} const _v${nodeId} = Math.floor((_rs / 4294967296) * (${max} - ${min} + 1)) + ${min};\n`;
    } else if (type === 'orientation') {
      // Orientation: uniform pick from 0..3 (N/E/S/W). No min/max widgets —
      // the domain is fixed. Matches the integer path's truncation pattern.
      return `${advance} const _v${nodeId} = Math.floor((_rs / 4294967296) * 4) & 3;\n`;
    } else if (type === 'options') {
      // inputVars.options resolves via inputToSources in compile.ts: '[v1,v2,...]'
      // for multi-source, the array varName for a single array source, or
      // '[srcName]' for a single scalar source. Fallback is the value returned
      // when the array is empty (only reachable for variable-length sources
      // like filterNeighbors); always visible in the UI so users explicitly
      // choose their domain sentinel.
      const arrExpr = inputVars.options ?? '[]';
      const fallback = inputVars.fallback ?? '0';
      return `${advance} const _optArr${nodeId} = ${arrExpr}; const _v${nodeId} = _optArr${nodeId}.length === 0 ? (${fallback}) : _optArr${nodeId}[Math.floor((_rs / 4294967296) * _optArr${nodeId}.length)];\n`;
    } else if (type === 'vector') {
      // ONE draw → an angular offset uniform in ±Span°/2 around the reference
      // direction, applied as a screen-clockwise ROTATION of the reference unit
      // vector. Rotating (rather than adding to a computed reference ANGLE) is
      // what keeps the vector-reference path free of atan2 — which the cell WASM
      // module does not import.
      const norm = inputVars.norm ?? '1';
      const span = inputVars.span ?? '360';
      const ref = randomRefSource(config as unknown as Record<string, unknown>);
      const P = `_gr${nodeId}`;
      let head = `${advance} const ${P}u = _rs / 4294967296;`
        + ` const ${P}p = (${P}u - 0.5) * (${span}) * ${RANDOM_DEG2RAD};`
        + ` const ${P}c = Math.cos(${P}p); const ${P}s = Math.sin(${P}p);`;
      if (ref === 'vector') {
        const dx = inputVars.dirX ?? '0';
        const dy = inputVars.dirY ?? '-1';
        head += ` const ${P}dx = (${dx}); const ${P}dy = (${dy});`
          + ` const ${P}l = Math.sqrt(${P}dx * ${P}dx + ${P}dy * ${P}dy);`
          + ` const ${P}i = 1 / Math.max(${P}l, ${RANDOM_LEN_EPS});`
          + ` const ${P}fx = ${P}dx * ${P}i; const ${P}fy = ${P}l > 0 ? ${P}dy * ${P}i : -1;`;
      } else {
        const ang = inputVars.angle ?? '0';
        head += ` const ${P}a = (${ang}) * ${RANDOM_DEG2RAD};`
          + ` const ${P}fx = Math.sin(${P}a); const ${P}fy = -Math.cos(${P}a);`;
      }
      // `_value` aliases X so a STALE edge left over from the previous mode
      // (the `value` port is hidden here) resolves instead of throwing a
      // ReferenceError inside the worker. The other targets get this for free —
      // their multi-output caches map the default port onto the same ref.
      return `${head} const _v${nodeId}_x = (${norm}) * (${P}fx * ${P}c - ${P}fy * ${P}s);`
        + ` const _v${nodeId}_y = (${norm}) * (${P}fx * ${P}s + ${P}fy * ${P}c);`
        + ` const _v${nodeId}_value = _v${nodeId}_x;\n`;
    } else if (dist === 'normal') {
      // Box-Muller — EXACTLY two draws, never a rejection loop, so the stream
      // advance count is static on every target. `1 - u` keeps the log argument
      // in (0, 1] (u is [0, 1)), so ln can never see 0 → -Infinity.
      const mean = inputVars.mean ?? '0';
      const sd = inputVars.stddev ?? '1';
      const P = `_gr${nodeId}`;
      return `${advance} const ${P}u = _rs / 4294967296; ${advance} const ${P}w = _rs / 4294967296;`
        + ` const ${P}z = Math.sqrt(-2 * Math.log(1 - ${P}u)) * Math.cos(${RANDOM_TAU} * ${P}w);`
        + ` const _v${nodeId} = (${mean}) + (${sd}) * ${P}z;\n`;
    } else if (dist === 'exponential') {
      // Inverse-CDF, ONE draw: -ln(1-u) is Exponential(1); scaling by the Mean
      // gives Exponential(1/Mean). A Mean of 0 degenerates to a constant 0.
      const mean = inputVars.mean ?? '0';
      const P = `_gr${nodeId}`;
      return `${advance} const ${P}u = _rs / 4294967296;`
        + ` const _v${nodeId} = (${mean}) * -Math.log(1 - ${P}u);\n`;
    } else {
      return `${advance} const _v${nodeId} = (_rs / 4294967296) * (${max} - ${min}) + ${min};\n`;
    }
  },
};
