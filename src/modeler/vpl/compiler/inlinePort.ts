/**
 * Shared inline-widget port helpers used by all three compile targets
 * (JS / WASM / WebGPU). When a value port has an inline widget and is not
 * connected to any upstream node, its value lives in `config[_port_<portId>]`.
 * These helpers extract and coerce that value uniformly across targets.
 */

import type { PortDef } from '../types';

/**
 * Get the inline widget value for an unconnected port.
 * Returns the literal string if the port has an inline widget and a value is
 * set in config, otherwise the port's defaultValue (or undefined). Bool widgets
 * normalise to '1' / '0' so downstream emitters can use the result as a number.
 */
export function getInlineValue(port: PortDef, config: Record<string, string | number | boolean>): string | undefined {
  if (!port.inlineWidget) return undefined;
  const configKey = `_port_${port.id}`;
  const val = config[configKey];
  if (val === undefined || val === '') return port.defaultValue;
  const s = String(val);
  if (port.inlineWidget === 'bool') return s === 'true' ? '1' : '0';
  return s;
}

/**
 * Parse an inline-widget string into a numeric value. Handles the same coercions
 * the JS compiler gets for free by emitting raw expressions: 'true' / 'false'
 * become 1 / 0 (the SetAttribute number widget can carry these strings if the
 * underlying attribute is bool), numeric strings parse via parseFloat, anything
 * else falls back. Used by the WASM and WebGPU compilers, which materialise
 * inline values into typed constants rather than embedding them as JS exprs.
 */
export function parseInlineNum(raw: string | undefined, fallback: number = 0): number {
  if (raw === undefined) return fallback;
  if (raw === 'true') return 1;
  if (raw === 'false') return 0;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}
