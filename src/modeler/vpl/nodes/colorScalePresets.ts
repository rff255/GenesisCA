/**
 * Named color-scale palette presets shared by the Color Scale node and the
 * Linked Output Mapping editor. A preset is just a list of stops (position in
 * [0,1] + RGB); applying one replaces the current stops. Keep these in sync
 * across both consumers — they read from this single source.
 */

export interface PresetStop { position: number; r: number; g: number; b: number; }
export interface ColorScalePreset { name: string; stops: PresetStop[]; }

const S = (position: number, r: number, g: number, b: number): PresetStop => ({ position, r, g, b });

export const COLOR_SCALE_PRESETS: ColorScalePreset[] = [
  { name: 'Grayscale', stops: [S(0, 0, 0, 0), S(1, 255, 255, 255)] },
  { name: 'Viridis', stops: [S(0, 68, 1, 84), S(0.25, 59, 82, 139), S(0.5, 33, 144, 141), S(0.75, 93, 201, 99), S(1, 253, 231, 37)] },
  { name: 'Magma', stops: [S(0, 0, 0, 4), S(0.25, 81, 18, 124), S(0.5, 183, 55, 121), S(0.75, 252, 137, 97), S(1, 252, 253, 191)] },
  { name: 'Plasma', stops: [S(0, 13, 8, 135), S(0.25, 126, 3, 168), S(0.5, 204, 71, 120), S(0.75, 248, 149, 64), S(1, 240, 249, 33)] },
  { name: 'Inferno', stops: [S(0, 0, 0, 4), S(0.25, 87, 16, 110), S(0.5, 188, 55, 84), S(0.75, 249, 142, 9), S(1, 252, 255, 164)] },
  { name: 'Rainbow', stops: [S(0, 255, 0, 0), S(0.2, 255, 255, 0), S(0.4, 0, 255, 0), S(0.6, 0, 255, 255), S(0.8, 0, 0, 255), S(1, 255, 0, 255)] },
  { name: 'Heat', stops: [S(0, 0, 0, 0), S(0.4, 128, 0, 0), S(0.6, 255, 0, 0), S(0.8, 255, 255, 0), S(1, 255, 255, 255)] },
  { name: 'Cool → Warm', stops: [S(0, 59, 76, 192), S(0.5, 221, 221, 221), S(1, 180, 4, 38)] },
  { name: 'Cividis', stops: [S(0, 0, 32, 76), S(0.5, 124, 123, 120), S(1, 255, 233, 69)] },
];

/** Return a fresh copy of a preset's stops by name (falls back to Grayscale). */
export function presetStops(name: string): PresetStop[] {
  const p = COLOR_SCALE_PRESETS.find(x => x.name === name) ?? COLOR_SCALE_PRESETS[0]!;
  return p.stops.map(s => ({ ...s }));
}
