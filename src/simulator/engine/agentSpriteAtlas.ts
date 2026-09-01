// ===========================================================================
// The 2D agent SPRITE ATLAS contract — the ONE definition shared by the atlas
// BUILDER (SimulatorView, main thread) and the atlas CONSUMER (the WebGPU agent
// render runtime, worker thread).
//
// It lives in its own dependency-free leaf for the same reason `sceneWireframe.ts`
// and `rasterResample.ts` do: the builder runs on the main thread and the consumer
// in the worker, and importing the runtime's VALUES from SimulatorView would pull
// the whole agent WebGPU module — every WGSL string in it — into the main bundle.
// Types alone would not drift-proof the two constants, and those two ARE the
// contract (a builder that packs 128 px tiles into a texture the consumer creates
// at some other size reads garbage).
// ===========================================================================

/** Atlas cell edge in px. Every frame is stored STRETCHED into a CELL x CELL layer
 *  (gl3d's `ATLAS_CELL`); the aspect-shaped billboard quad un-stretches it, so the
 *  two renderers agree on what a frame looks like. */
export const AGENT_SPRITE_ATLAS_CELL = 128;

/** Hard ceiling on total (sprite, frame) layers. WebGPU guarantees
 *  `maxTextureArrayLayers` 256, so the BUILDER truncates past this — on a
 *  whole-sprite boundary, since a half-uploaded frame set would animate wrongly —
 *  rather than letting texture creation fail in the worker. */
export const AGENT_SPRITE_MAX_LAYERS = 256;

/** One sprite slot's render meta, as the worker receives it (plain JSON). */
export interface AgentSpriteSlot {
  /** 1-based index into `model.sprites` — the per-agent `spriteIds` value. */
  slot: number;
  /** First atlas layer of this sprite's frames. */
  baseLayer: number;
  frameCount: number;
  /** Frame 0's width/height (gl3d takes the aspect from frame 0 for every frame). */
  aspect: number;
  loop: boolean;
  orientToVelocity: boolean;
  scale: number;
  /** `SpriteAsset.sizeMode === 'absolute'` — `scale` (and a per-agent Set Agent
   *  Sprite override) is the drawn size in WORLD UNITS, so the agent radius is not
   *  consulted. Absent/false = the historical diameter multiplier. */
  absoluteSize?: boolean;
  defaultDirection: number;
  rotationOffset: number;
}

/** The atlas payload the main thread ships (the bitmap is TRANSFERRED, and the
 *  worker CLOSES it — including on the paths where it installs nothing). */
export interface AgentSpriteAtlasPayload {
  /** A tile GRID of `cols` x ceil(layers/cols) cells of `cell` x `cell` px, or null
   *  to CLEAR the atlas (no sprite decoded / the sprites were deleted). */
  bitmap: ImageBitmap | null;
  cell: number;
  cols: number;
  layers: number;
  /** One entry per DECODED slot. An undecoded slot is simply absent — it still gets
   *  a zeroed meta record (see `slotCount`), which is the fallback-to-disc marker. */
  slots: AgentSpriteSlot[];
  /** `model.sprites.length` — sizes the meta buffer so EVERY slot id is indexable. */
  slotCount: number;
}
