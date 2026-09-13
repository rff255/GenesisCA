/**
 * nodeGeometry.ts — the ONE definition of a CaNode's handle geometry.
 *
 * WHY THIS FILE EXISTS. Two consumers now need to know where a port's handle
 * sits on a node: **CaNode itself**, which renders the handles, and the
 * **auto-layout** (`autoLayout.ts`), whose whole quality bar is "the exec pin of
 * B is on the same pixel row as the exec pin of A". If those two ever carry
 * their own copies of the numbers, the layout silently misaligns the next time
 * CaNode's header changes — the `buildExtraSlotPorts` / `applyLookupAxisPorts`
 * dual-consumption discipline, applied to geometry.
 *
 * So the constants live HERE and **CaNode imports them**; `scripts/verify-auto-layout.mjs`
 * section B pins both halves (the values, and that CaNode really consumes them).
 *
 * React Flow's handle CSS centres on `top`, so every number below is a handle
 * CENTRE measured from the node's TOP edge, directly usable as an offset.
 */

import type { CAModel } from '../../model/types';
import type { PortDef } from './types';
import { handleId } from './types';
import { getEffectivePorts } from './effectivePorts';

/** Height of the `.userLabel` strip a rename adds ABOVE the header
 *  (`var(--space-1)` padding ×2 + ~14 px line + 1 px border-bottom ≈ 21 px,
 *  measured). Body-port handles are positioned from the NODE's top, so the whole
 *  body shifts down by exactly this when a node is renamed. */
export const USER_LABEL_HEIGHT = 21;

/** First body-port row, measured from the top of an UNLABELLED node — i.e. just
 *  below the header strip. */
export const PORT_TOP_BASE_NO_LABEL = 30;

/** Row pitch for body ports. Uniform across ALL node types, so the Nth body port
 *  of any node lands on the same row grid. */
export const PORT_SPACING = 22;

/** The `.header`'s vertical centre, where the two MAIN flow pins are rendered
 *  (`style={{ top: '50%' }}` inside the `position: relative` header). Measured
 *  from the top of the header, so a renamed node adds `USER_LABEL_HEIGHT`. */
export const HEADER_CENTRE_Y = 15;

/** A COLLAPSED node fans its CONNECTED handles this far apart, around the node's
 *  vertical centre; unconnected ones stay at the centre. */
export const COLLAPSED_HANDLE_SPREAD = 11;

/** First body-port row for a node that may or may not carry a user label. */
export function portTopBase(hasUserLabel: boolean): number {
  return PORT_TOP_BASE_NO_LABEL + (hasUserLabel ? USER_LABEL_HEIGHT : 0);
}

// ---------------------------------------------------------------------------
// The port-offset map
// ---------------------------------------------------------------------------

export interface PortYOptions {
  /** The node carries a user rename (`data.label`), so the `.userLabel` strip
   *  pushes the body down. */
  label?: boolean;
  collapsed?: boolean;
  /** The node's rendered height — only the COLLAPSED fan needs it (it is
   *  centred on the node). Defaults to the `nodeSize` collapsed fallback. */
  height?: number;
  /** Handle ids that carry an edge. Only the collapsed fan consults it (the
   *  fan spreads the CONNECTED handles and leaves the rest at the centre). */
  connectedHandles?: ReadonlySet<string>;
}

/**
 * `handleId → y offset from the node's TOP` for every port of a node.
 *
 * Mirrors CaNode's own derivation:
 *   - the primary flow IN (the single flow-category input) and the primary flow
 *     OUT (`next`, else the first flow output — covering the event roots and
 *     Sequence's FIRST) are LIFTED into the header and sit at its centre;
 *   - everything else is a body row at `portTopBase + i * PORT_SPACING`, indexed
 *     over the port list MINUS the two lifted ports;
 *   - a COLLAPSED node lifts nothing and fans its connected handles instead.
 *
 * ⚠ The port list MUST come from `getEffectivePorts` (dynamic Switch / Sequence
 * ports, multi-attr slots, census outputs, Form Bond's bond inputs, input-mapping
 * channels, lookup axes, formula `visibleCount`, vector flips, `hiddenPorts`) —
 * `def.ports` alone gets the wrong row on a dozen node types.
 *
 * ⚠ As-built deviation from the plan: `getEffectivePorts` does NOT cover the
 * three MACRO node types (`macro` / `macroInput` / `macroOutput`) — CaNode
 * derives their ports inline from `MacroDef.exposedInputs/Outputs`, and
 * `MacroNode.ports` is literally `[]`. Those branches are mirrored here, or
 * every macro instance in the library would report an empty offset map and its
 * wires would never straighten.
 */
export function portYOffsets(
  nodeType: string,
  config: Record<string, unknown> | undefined,
  model: CAModel | undefined,
  opts: PortYOptions = {},
): Record<string, number> {
  const { inputs, outputs } = effectivePortsForGeometry(nodeType, config, model);
  const out: Record<string, number> = {};

  if (opts.collapsed) {
    const h = opts.height ?? 32;
    const connected = opts.connectedHandles;
    const side = (ports: PortDef[]) => {
      const conn = connected ? ports.filter(p => connected.has(handleId(p))) : [];
      const idx = new Map<string, number>(conn.map((p, i) => [p.id, i]));
      for (const p of ports) {
        const ci = idx.get(p.id);
        out[handleId(p)] = ci === undefined || conn.length <= 1
          ? h / 2
          : h / 2 + Math.round((ci - (conn.length - 1) / 2) * COLLAPSED_HANDLE_SPREAD);
      }
    };
    side(inputs);
    side(outputs);
    return out;
  }

  const labelH = opts.label ? USER_LABEL_HEIGHT : 0;
  const headerY = labelH + HEADER_CENTRE_Y;
  const base = portTopBase(!!opts.label);

  const mainFlowIn = inputs.find(p => p.category === 'flow') ?? null;
  const mainFlowOut =
    outputs.find(p => p.id === 'next')
    ?? outputs.find(p => p.category === 'flow')
    ?? null;
  const bodyIn = mainFlowIn ? inputs.filter(p => p !== mainFlowIn) : inputs;
  const bodyOut = mainFlowOut ? outputs.filter(p => p !== mainFlowOut) : outputs;

  if (mainFlowIn) out[handleId(mainFlowIn)] = headerY;
  if (mainFlowOut) out[handleId(mainFlowOut)] = headerY;
  bodyIn.forEach((p, i) => { out[handleId(p)] = base + i * PORT_SPACING; });
  bodyOut.forEach((p, i) => { out[handleId(p)] = base + i * PORT_SPACING; });
  return out;
}

/** `getEffectivePorts` + the three macro branches CaNode derives inline. */
function effectivePortsForGeometry(
  nodeType: string,
  config: Record<string, unknown> | undefined,
  model: CAModel | undefined,
): { inputs: PortDef[]; outputs: PortDef[] } {
  if (nodeType === 'macro' || nodeType === 'macroInput' || nodeType === 'macroOutput') {
    const macroDefId = (config?.macroDefId as string) ?? '';
    const def = (model?.macroDefs ?? []).find(m => m.id === macroDefId);
    if (!def) return { inputs: [], outputs: [] };
    const asPort = (p: { portId: string; label: string; category?: string; dataType?: string }, kind: 'input' | 'output'): PortDef => ({
      id: p.portId,
      label: p.label,
      kind,
      category: (p.category === 'flow' ? 'flow' : 'value'),
      dataType: (p.dataType || 'any') as PortDef['dataType'],
    });
    if (nodeType === 'macro') {
      return {
        inputs: def.exposedInputs.map(p => asPort(p, 'input')),
        outputs: def.exposedOutputs.map(p => asPort(p, 'output')),
      };
    }
    if (nodeType === 'macroInput') {
      // data flows INTO the subgraph, so the def's INPUTS are this node's outputs
      return { inputs: [], outputs: def.exposedInputs.map(p => asPort(p, 'output')) };
    }
    return { inputs: def.exposedOutputs.map(p => asPort(p, 'input')), outputs: [] };
  }
  return getEffectivePorts(nodeType, config, model);
}
