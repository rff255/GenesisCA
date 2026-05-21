/**
 * Runtime migration: legacy single-palette Interaction Tables → the generalized
 * Lookup Table model.
 *
 * Two legacy shapes are upgraded (model-level, applied in LOAD_MODEL):
 *   1. Attribute `type: 'interactionTable'` → `type: 'lookupTable'`.
 *   2. `variegatedCells.faceLabels: string[]` (the single global palette) →
 *      `variegatedCells.facePalettes: [{ id, name:'Faces', labels }]`, and every
 *      `FacePattern` gets `paletteId` pointing at that one palette.
 *
 * Each migrated lookupTable attribute that lacks `rowKeySource`/`colKeySource`
 * is defaulted to `{ kind:'facePalette', paletteId: <the migrated palette> }`
 * on BOTH axes — a square table keyed by the face palette, exactly reproducing
 * the legacy behavior. Attribute `tableValues` keep their string keys verbatim
 * (face-label names + the literal `"none"`), so no value remap is needed.
 *
 * Idempotent: a model that already has `facePalettes` (and `lookupTable` attrs
 * with sources) is returned unchanged.
 */

import type {
  CAModel,
  FaceLabelPalette,
  FacePattern,
  LookupKeySource,
  VariegatedCellsConfig,
} from './types';

/** Stable id for the palette synthesized from a legacy `faceLabels` array.
 *  Fixed (not random) so re-running the migration is a no-op and existing
 *  `paletteId` references stay valid. User-created palettes use random ids. */
const MIGRATED_PALETTE_ID = 'palette_faces';

/** Legacy view of the variegation config (pre-rename it had `faceLabels`). */
type LegacyVariegated = VariegatedCellsConfig & { faceLabels?: string[] };

export function migrateLookupTables(model: CAModel): CAModel {
  let changed = false;

  // 1. variegatedCells.faceLabels → facePalettes[0]; stamp paletteId on patterns.
  let variegatedCells = model.variegatedCells;
  let primaryPaletteId = '';
  if (variegatedCells) {
    const vc = variegatedCells as LegacyVariegated;
    if (!vc.facePalettes) {
      const labels = Array.isArray(vc.faceLabels) ? vc.faceLabels : [];
      const palette: FaceLabelPalette = { id: MIGRATED_PALETTE_ID, name: 'Faces', labels };
      const facePatterns: FacePattern[] = (vc.facePatterns ?? []).map(p =>
        p.paletteId ? p : { ...p, paletteId: MIGRATED_PALETTE_ID },
      );
      variegatedCells = {
        enabled: vc.enabled,
        sourceAttributeId: vc.sourceAttributeId,
        facePalettes: [palette],
        facePatterns,
      };
      primaryPaletteId = MIGRATED_PALETTE_ID;
      changed = true;
    } else {
      primaryPaletteId = vc.facePalettes[0]?.id ?? '';
    }
  }

  // 2. Attribute type rename + default key sources (square, face-palette).
  const attributes = model.attributes.map(a => {
    const isLegacyType = (a.type as string) === 'interactionTable';
    if (!isLegacyType && a.type !== 'lookupTable') return a;
    if (!isLegacyType && a.rowKeySource && a.colKeySource) return a; // already migrated
    const next = { ...a };
    if (isLegacyType) next.type = 'lookupTable';
    if (primaryPaletteId) {
      const src: LookupKeySource = { kind: 'facePalette', paletteId: primaryPaletteId };
      if (!next.rowKeySource) next.rowKeySource = src;
      if (!next.colKeySource) next.colKeySource = { ...src };
    }
    changed = true;
    return next;
  });

  if (!changed) return model;
  return { ...model, attributes, variegatedCells };
}
