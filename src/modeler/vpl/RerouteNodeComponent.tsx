import { memo, useSyncExternalStore } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import { connectingFrom, subscribeConnectingFrom } from './graphState';
import { handleId } from './types';
import type { PortCategory } from './types';
import caStyles from './CaNode.module.css';
import styles from './RerouteNodeComponent.module.css';

/** Stable snapshot getter — `connectingFrom` is null or a fresh object set once
 *  per drag, so identity equality is the right re-render semantics. */
function getConnectingFromSnapshot() {
  return connectingFrom;
}

/**
 * A reroute relay — a tiny movable dot placed on a wire (Blender / Unreal
 * blueprint style) so users can bend connections and fan one output out to many
 * consumers without long crossing wires. It relays an OUTPUT port's reference,
 * so it has one input handle (left) and one output handle (right), both fixed to
 * the relayed wire's category (value / flow). It carries no config and emits no
 * code — the compiler collapses it out (`A → R → B` ≡ `A → B`), see
 * rerouteCollapse.ts.
 *
 * Created and repositioned via the press-and-hold gesture in GraphEditor; the
 * node is `draggable: false`, so React Flow's native drag is suppressed.
 */
function RerouteNodeInner({ id, data, selected }: NodeProps) {
  const d = data as Record<string, unknown>;
  const category: PortCategory = (d.portCategory as string) === 'flow' ? 'flow' : 'value';
  const dataType = d.dataType as string | undefined;
  // Optional user label (context-menu Rename → data.label, round-trips like any
  // node data) — rendered above the dot so reroutes can be organized by name.
  const label = typeof d.label === 'string' ? d.label.trim() : '';

  const cf = useSyncExternalStore(subscribeConnectingFrom, getConnectingFromSnapshot, getConnectingFromSnapshot);

  // The input (target) handle accepts a drag that STARTED on an output of the
  // same category (and not this same reroute). The output (source) handle
  // accepts a drag that started on an input. Mirrors CaNode's port highlighting.
  const inCompatible = cf ? cf.kind !== 'input' && cf.category === category && cf.nodeId !== id : null;
  const outCompatible = cf ? cf.kind === 'input' && cf.category === category && cf.nodeId !== id : null;

  const baseHandle =
    category === 'flow'
      ? caStyles.handleFlow
      : dataType === 'neighborIndex'
        ? caStyles.handleNeighborIndex
        : caStyles.handleValue;

  const inClass = [
    baseHandle,
    cf && inCompatible ? caStyles.handleCompatible : '',
    cf && !inCompatible ? caStyles.handleIncompatible : '',
  ].filter(Boolean).join(' ');
  const outClass = [
    baseHandle,
    cf && outCompatible ? caStyles.handleCompatible : '',
    cf && !outCompatible ? caStyles.handleIncompatible : '',
  ].filter(Boolean).join(' ');

  const fill =
    category === 'flow' ? '#4caf50' : dataType === 'neighborIndex' ? '#ffb300' : '#4cc9f0';
  const stroke =
    category === 'flow' ? '#1b5e20' : dataType === 'neighborIndex' ? '#ff6f00' : '#0d47a1';

  return (
    <div
      className={`${styles.reroute} ${selected ? styles.selected : ''}`}
      style={{ background: fill, borderColor: stroke }}
      title={label ? `${label} — reroute (${category})` : `Reroute (${category})`}
    >
      {label && <div className={styles.label}>{label}</div>}
      <Handle
        type="target"
        position={Position.Left}
        id={handleId({ kind: 'input', category, id: 'in' })}
        className={inClass}
      />
      <Handle
        type="source"
        position={Position.Right}
        id={handleId({ kind: 'output', category, id: 'out' })}
        className={outClass}
      />
    </div>
  );
}

export const RerouteNodeComponent = memo(RerouteNodeInner);
