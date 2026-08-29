import { ColorField } from './ColorField';
import { hexToRgba, rgbaToHex, OPAQUE } from '../../../model/colorHex';
import type { CategoricalEntry } from '../nodes/CategoricalColorNode';

/**
 * Reusable palette editor: one colour swatch per index entry (entry `i` ==
 * index `i`), a swatch for the out-of-range default, a delete per row and an
 * "Add Color" button. Pure — it reads `entries` / `fallback` and emits the
 * WHOLE next palette through `onChange`.
 *
 * Extracted VERBATIM out of CaNode's `CategoricalColorEditor` so the in-node
 * editor and the Explicit-Controls FACET control render the SAME component
 * (the `GradientStopsEditor` precedent, and the same dual-consumption rule the
 * whole feature rests on — one widget, so behaviour cannot drift).
 *
 * It knows nothing about node config: the CALLER pairs it with the node's own
 * `readCategoricalEntries` / `writeCategoricalPalette`, which is what keeps the
 * Option-A alpha gate in ONE place.
 */
export function CategoricalPaletteEditor({ entries, fallback, onChange, buttonClassName }: {
  entries: CategoricalEntry[];
  fallback: CategoricalEntry;
  onChange: (entries: CategoricalEntry[], fallback: CategoricalEntry) => void;
  /** the host's own button class — CaNode passes `styles.select`, so the in-node
   *  editor keeps the exact look it had before the extraction. */
  buttonClassName?: string;
}) {
  const stopDrag = (e: React.MouseEvent) => { if (e.button === 0) e.stopPropagation(); };
  const swatch = (val: CategoricalEntry, set: (c: CategoricalEntry) => void) => (
    <ColorField
      value={rgbaToHex(val)}
      onChange={(h) => {
        const n = hexToRgba(h);
        // Write `a` only when non-opaque, so an opaque entry keeps no alpha key
        // and the compiler stays on its pre-alpha path.
        set(n.a === OPAQUE ? { r: n.r, g: n.g, b: n.b } : { r: n.r, g: n.g, b: n.b, a: n.a });
      }}
      style={{ height: 24, flex: 1 }}
    />
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }} onMouseDown={stopDrag}>
      {entries.map((e, i) => (
        <div key={i} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <span style={{ width: 28, fontSize: '0.7rem', opacity: 0.8 }}>#{i}</span>
          {swatch(e, c => onChange(entries.map((x, j) => (j === i ? c : x)), fallback))}
          <button onClick={() => onChange(entries.filter((_, j) => j !== i), fallback)}
            style={{ background: 'none', border: 'none', color: '#f44336', cursor: 'pointer', fontSize: '0.7rem', padding: '0 2px' }}
            title="Delete this color">x</button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <span style={{ width: 28, fontSize: '0.7rem', opacity: 0.6 }}>else</span>
        {swatch(fallback, c => onChange(entries, c))}
      </div>
      <button
        className={buttonClassName}
        style={buttonClassName
          ? { cursor: 'pointer', textAlign: 'center' }
          : {
            width: '100%', background: '#1a2530', color: '#cfd8dc',
            border: '1px solid #2a3a4a', borderRadius: 3, fontSize: '0.7rem', padding: '2px 4px',
            cursor: 'pointer', textAlign: 'center',
          }}
        onClick={() => onChange([...entries, fallback], fallback)}>
        + Add Color
      </button>
    </div>
  );
}
