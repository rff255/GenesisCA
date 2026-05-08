/** Schema version of `.gcaproj` and `.gcastate` files.
 *
 *  v1 → v2 (Wave A.6): NeighborIndex runtime representation changed from
 *  slot-index (`0..nbrSize-1`) to packed `(dr, dc)` i32. Cell/model attributes
 *  with `type === 'neighborIndex'` need their default/boundary/cell-array
 *  values translated using the source neighborhood (via
 *  `Attribute.neighborhoodHintId`). When the hint is absent, values are left
 *  as-is and a console warning is emitted — the user can re-pick a default
 *  via the editor's clickable grid. */
export const SCHEMA_VERSION = 2;
