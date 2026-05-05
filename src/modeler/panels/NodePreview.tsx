/**
 * NodePreview — a passive mini visual of a node, used in the palette's
 * "Visual" mode. Decoupled from React Flow (no <Handle>, no useReactFlow);
 * just a div with a colored header and port stubs so the user can see what
 * they're about to drag onto the canvas.
 */

import type { NodeTypeDef, PortDef } from '../vpl/types';
import type { MacroDef } from '../../model/types';
import styles from './PalettePanelContent.module.css';

/** Mirrors CaNode.tsx's textColorForBg: dark text on light backgrounds (e.g.
 *  the white event-node headers — Generation Step, Input/Output Mapping —
 *  whose label was previously white-on-white and unreadable). */
function textColorForBg(bgHex: string): string {
  const hex = bgHex.replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#1e2a3a' : '#ffffff';
}

interface PortRow {
  label: string;
  category: 'value' | 'flow';
  isArray?: boolean;
}

function portsFromDef(def: NodeTypeDef): { inputs: PortRow[]; outputs: PortRow[] } {
  const inputs: PortRow[] = [];
  const outputs: PortRow[] = [];
  for (const p of def.ports as PortDef[]) {
    const row: PortRow = { label: p.label, category: p.category, isArray: p.isArray };
    if (p.kind === 'input') inputs.push(row);
    else outputs.push(row);
  }
  return { inputs, outputs };
}

function portsFromMacroDef(macroDef: MacroDef): { inputs: PortRow[]; outputs: PortRow[] } {
  return {
    inputs: macroDef.exposedInputs.map(p => ({ label: p.label, category: p.category })),
    outputs: macroDef.exposedOutputs.map(p => ({ label: p.label, category: p.category })),
  };
}

interface PreviewProps {
  label: string;
  color: string;
  inputs: PortRow[];
  outputs: PortRow[];
  subtitle?: string;
  description?: string;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
}

function PreviewCard(props: PreviewProps) {
  const { label, color, inputs, outputs, subtitle, description } = props;
  const maxRows = Math.max(inputs.length, outputs.length, 1);
  return (
    <div
      className={styles.previewCard}
      role="button"
      tabIndex={0}
      draggable={props.draggable !== false}
      onDragStart={props.onDragStart}
      title={description || label}
    >
      <div className={styles.previewHeader} style={{ background: color, color: textColorForBg(color) }}>
        <span className={styles.previewLabel}>{label}</span>
        {subtitle && <span className={styles.previewSubtitle}>{subtitle}</span>}
      </div>
      <div className={styles.previewBody}>
        <div className={styles.previewPortCol}>
          {Array.from({ length: maxRows }).map((_, i) => {
            const p = inputs[i];
            if (!p) return <div key={`i${i}`} className={styles.previewPortSpacer} />;
            const dotClass = p.category === 'flow' ? styles.previewDotFlow : styles.previewDotValue;
            return (
              <div key={`i${i}`} className={styles.previewPortRow}>
                <span className={`${styles.previewDot} ${dotClass}`} />
                <span className={styles.previewPortLabel}>{p.label}{p.isArray ? '[]' : ''}</span>
              </div>
            );
          })}
        </div>
        <div className={`${styles.previewPortCol} ${styles.previewPortColRight}`}>
          {Array.from({ length: maxRows }).map((_, i) => {
            const p = outputs[i];
            if (!p) return <div key={`o${i}`} className={styles.previewPortSpacer} />;
            const dotClass = p.category === 'flow' ? styles.previewDotFlow : styles.previewDotValue;
            return (
              <div key={`o${i}`} className={`${styles.previewPortRow} ${styles.previewPortRowRight}`}>
                <span className={styles.previewPortLabel}>{p.label}{p.isArray ? '[]' : ''}</span>
                <span className={`${styles.previewDot} ${dotClass}`} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

interface NodePreviewProps {
  def: NodeTypeDef;
  onDragStart: (e: React.DragEvent) => void;
}

export function NodePreview({ def, onDragStart }: NodePreviewProps) {
  const { inputs, outputs } = portsFromDef(def);
  return (
    <PreviewCard
      label={def.label}
      color={def.color}
      inputs={inputs}
      outputs={outputs}
      description={def.description}
      onDragStart={onDragStart}
    />
  );
}

interface MacroPreviewProps {
  name: string;
  description?: string;
  macroDef?: MacroDef; // if known, render real ports; otherwise show generic macro
  onDragStart: (e: React.DragEvent) => void;
}

const MACRO_COLOR = '#7b1fa2';

export function MacroPreview({ name, description, macroDef, onDragStart }: MacroPreviewProps) {
  const ports = macroDef
    ? portsFromMacroDef(macroDef)
    : { inputs: [], outputs: [] };
  return (
    <PreviewCard
      label={name}
      color={MACRO_COLOR}
      inputs={ports.inputs}
      outputs={ports.outputs}
      subtitle="Macro"
      description={description || name}
      onDragStart={onDragStart}
    />
  );
}
