import { memo, useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { useModel } from '../model/ModelContext';
import { hexToRgba, rgbaToHex, OPAQUE } from '../model/colorHex';
import { ColorField } from '../modeler/vpl/widgets/ColorField';
import { compileGraph, compileAgentGraph } from '../modeler/vpl/compiler/compile';
import { expandVectorAttributes, encodeAttrSets, decodeVectorFromValues } from '../modeler/vpl/compiler/vectorAttr';
import { hasGlyphsInModel } from '../modeler/vpl/compiler/glyphsUsage';
import { CURRENT_VIEWER_SENTINEL } from '../modeler/vpl/nodes/SetCellLooksNode';
import { compileGraphWasm } from '../modeler/vpl/compiler/wasm/compile';
import { computeLayoutFromModel, buildViewerIds } from '../modeler/vpl/compiler/wasm/layout';
import { unpackNI, unpackNI3, INVALID_NI } from '../modeler/vpl/compiler/niCodec';
import { resolveKeyLabels, resolveValueTagOptions, buildLookupTablePayload, isMultiAxisTable, resolveAxes, randomFillTableData } from '../modeler/vpl/compiler/variegation';
import { NeighborIndexValuePicker } from '../modeler/panels/NeighborIndexDefaultEditor';
import { LookupTableEditor } from '../modeler/panels/LookupTableEditor';
import { compileGraphWebGPU } from '../modeler/vpl/compiler/webgpu/compile';
import { createSimWorker } from './createSimWorker';
import { Gl3DRenderer, panCamera, cameraBasis, sceneCameraMatrices, lightWorldDirFor, computeLightMVP, DEFAULT_LIGHT3D, DEFAULT_METABALLS3D, metaballAutoThreshold, DEFAULT_AUTOZOOM3D, defaultCamera3d, MIN_CAM_DIST, MAX_CAM_DIST } from './render/gl3d';
import type { SpriteAtlasInput, Light3D, Metaballs3D, AutoZoom3D } from './render/gl3d';
import type { VoxelRenderView } from './engine/webgpuRuntime';
import { LightBallWidget } from './LightBallWidget';
import { agentTargetOf, resolveMaxBonds } from '../model/centerBased';
import { bondAttrsOf } from '../model/attributeScope';
import { compileAgentGraphWasmForModel, isAgentGraphWasmSupported, buildAgentLayoutExtras } from '../modeler/vpl/compiler/agentWasm/compile';
import { bondReqSlotsForModel } from '../modeler/vpl/compiler/bondRequestQueue';
import type { DividePartitionSpec } from '../modeler/vpl/compiler/dividePartition';
import type { AgentLayoutExtras } from './engine/agentEngine';
import { compileAgentGraphWebGPUForModel, isAgentGraphWebGPUSupported } from '../modeler/vpl/compiler/agentWebgpu/compile';
import { computeAgentWebGPULayout, type AgentWebGPULayout } from '../modeler/vpl/compiler/agentWebgpu/layout';
import { emitAgentForcePassWGSL } from '../modeler/vpl/compiler/agentWebgpu/forcePass';
import type { AgentRenderSnapshot } from './engine/agentEngine';
import type { AgentRenderView, AgentRenderView3D } from './engine/agentWebgpuRuntime';
import { SpriteRegistry } from './spriteRegistry';
import { ImageMappingDialog, type ImageMappingConfig } from './ImageMappingDialog';
import { CsvImportDialog, type CsvImportResult } from './CsvImportDialog';
import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import {
  encodeFramesToWebM, isWebMSupported, snapRecordWidth,
  RECORD_MAX, RECORD_MAX_3D, DEFAULT_RECORD_QUALITY, type RecordQuality,
} from './recording/webmEncoder';
import { WebMStreamEncoder } from './recording/webmStreamEncoder';
import { getGlyphTile } from './recording/glyphAtlas';
import { IndicatorDisplay } from './IndicatorDisplay';
import { ExperimentsPanel } from './ExperimentsPanel';
import { compileOverseerGraph } from '../modeler/vpl/compiler/overseer/compile';
import { OverseerRuntime } from './engine/overseerRuntime';
import { BrushColorPopover } from './BrushColorPopover';
import { ManualBrushPanel } from './ManualBrushPanel';
import { ClipIntervalSlider } from './ClipIntervalSlider';
import { NumberField } from '../modeler/vpl/widgets/InlineWidgets';
import { designTimeSeriesKeys, mergeChartSettings, historyWindow, INDICATOR_HISTORY_DEFAULT_CAP, INDICATOR_HISTORY_HARD_CAP } from './indicatorChartSettings';
import { InspectCellPopover, InspectHoverLink, type InspectPopoverState } from './InspectCellPopover';
import { InspectAgentPopover, type AgentPopoverState } from './InspectAgentPopover';
import { PresetSaveDialog } from './PresetSaveDialog';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { serializeSimState, serializePreset, downloadStateFile, readStateFile, downloadPresetFile, readPresetFile, saveBinaryFile, base64ToArrayBuffer, deserializeTypedArray, migrateSimulationStateV1toV2, deserializeAgentState } from '../model/fileOperations';
import type { Attribute, CAModel, IndicatorChartSettings, Preset, SimulationState } from '../model/types';
import { decodeAttrValue } from '../model/attrValueEncoding';
import { cbNum } from '../model/centerBased';
import { resolveAgentProfile } from '../model/agentCapabilities';
import { useListReorder } from '../modeler/panels/useListReorder';
import styles from './SimulatorView.module.css';

const SIM_SETTINGS_KEY = 'genesisca_sim_settings';

function loadSimSettings(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(SIM_SETTINGS_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return {};
}

/** Validate a persisted 3D lighting config (genesisca_sim_settings.light3d) —
 *  every field range-clamped, anything malformed falls back to the default
 *  (which reproduces the historical hardcoded shade exactly). */
function sanitizeLight3d(raw: unknown): Light3D {
  const d = DEFAULT_LIGHT3D;
  if (!raw || typeof raw !== 'object') return { ...d };
  const r = raw as Partial<Light3D>;
  const num = (v: unknown, dv: number, lo: number, hi: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dv;
  return {
    mode: r.mode === 'camera' ? 'camera' : 'world',
    bx: num(r.bx, d.bx, -1, 1),
    by: num(r.by, d.by, -1, 1),
    wx: num(r.wx, d.wx, -1, 1),
    wy: num(r.wy, d.wy, -1, 1),
    wz: num(r.wz, d.wz, -1, 1),
    ambient: num(r.ambient, d.ambient, 0, 1),
    diffuse: num(r.diffuse, d.diffuse, 0, 1.5),
    specular: num(r.specular, d.specular, 0, 1),
    shadows: typeof r.shadows === 'boolean' ? r.shadows : d.shadows,
    shadowStrength: num(r.shadowStrength, d.shadowStrength, 0, 1),
    ao: typeof r.ao === 'boolean' ? r.ao : d.ao,
    aoStrength: num(r.aoStrength, d.aoStrength, 0, 1),
  };
}

/** Validate a persisted agent-metaballs config (genesisca_sim_settings.agentMetaballs)
 *  — every field range-clamped, anything malformed falls back to the default (off). */
function sanitizeAgentMetaballs(raw: unknown): Metaballs3D {
  const d = DEFAULT_METABALLS3D;
  if (!raw || typeof raw !== 'object') return { ...d };
  const r = raw as Partial<Metaballs3D>;
  const num = (v: unknown, dv: number, lo: number, hi: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dv;
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled,
    influence: num(r.influence, d.influence, 1, 3),
    threshold: num(r.threshold, d.threshold, 0.02, 0.9),
    resolution: r.resolution === 1 || r.resolution === 4 ? r.resolution : 2,
  };
}

/** A1 direct-agent-render "Glow" graphics option (genesisca_sim_settings.agentGlow).
 *  Renders ONLY on the WebGPU direct-render path (additive radial falloff per
 *  agent); the CPU overlay ignores it. Persisted as a simulator setting. */
interface AgentGlow { on: boolean; size: number; intensity: number; steepness: number }
const DEFAULT_AGENT_GLOW: AgentGlow = { on: false, size: 8, intensity: 0.6, steepness: 2 };
function sanitizeAgentGlow(raw: unknown): AgentGlow {
  const d = DEFAULT_AGENT_GLOW;
  if (!raw || typeof raw !== 'object') return { ...d };
  const r = raw as Partial<AgentGlow>;
  const num = (v: unknown, dv: number, lo: number, hi: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dv;
  return {
    on: typeof r.on === 'boolean' ? r.on : d.on,
    size: num(r.size, d.size, 0, 64),
    intensity: num(r.intensity, d.intensity, 0, 4),
    steepness: num(r.steepness, d.steepness, 0.1, 8),
  };
}

/** The 2D metaball ("gooey") SVG filter — blur + a steep alpha threshold applied
 *  to the agent discs, so nearby agents visually fuse (the classic goo trick; an
 *  APPROXIMATION of the 3D implicit surface, view-resolution based). Injected
 *  once, module-singleton; drawAgentsOverlay updates the blur radius + threshold
 *  per frame and references it via ctx.filter = 'url(#…)'. */
const GOO_FILTER_ID = 'genesisca-agent-goo';
let gooFilterEls: { blur: SVGFEGaussianBlurElement; matrix: SVGFEColorMatrixElement; fade: SVGFEColorMatrixElement } | null = null;
/** Build the fade (alpha-scale) stage — a SECOND feColorMatrix AFTER the
 *  threshold matrix. It carries the blob's mean-agent-alpha translucency,
 *  because `ctx.globalAlpha` is silently IGNORED by Chromium when the draw is
 *  routed through an SVG `url(#…)` filter (measured: a 0.5-globalAlpha draw
 *  through this filter composites fully opaque, while a builtin-filter or
 *  unfiltered draw honours it). Primitive results clamp to [0,1] BETWEEN
 *  stages, so threshold-then-scale caps the blob's alpha at exactly the mean. */
function makeGooFade(NS: string): SVGFEColorMatrixElement {
  const fade = document.createElementNS(NS, 'feColorMatrix') as SVGFEColorMatrixElement;
  fade.setAttribute('type', 'matrix');
  fade.setAttribute('values', '1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0');
  return fade;
}
function ensureGooFilter(): NonNullable<typeof gooFilterEls> {
  if (gooFilterEls) return gooFilterEls;
  const NS = 'http://www.w3.org/2000/svg';
  // Adopt an already-injected filter (a re-evaluated module — e.g. Vite HMR —
  // must not append a DUPLICATE id: url(#…) resolves the FIRST match, so the
  // duplicate's params would never reach the canvas). An adopted filter from an
  // older build may lack the fade stage — append it then.
  const existing = document.getElementById(GOO_FILTER_ID);  // the <filter> element itself
  if (existing) {
    const matrices = existing.querySelectorAll('feColorMatrix');
    let fade = matrices[1] as SVGFEColorMatrixElement | undefined;
    if (!fade) {
      fade = makeGooFade(NS);
      existing.appendChild(fade);
    }
    gooFilterEls = {
      blur: existing.querySelector('feGaussianBlur') as SVGFEGaussianBlurElement,
      matrix: matrices[0] as SVGFEColorMatrixElement,
      fade,
    };
    return gooFilterEls;
  }
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.position = 'absolute';
  const filter = document.createElementNS(NS, 'filter');
  filter.setAttribute('id', GOO_FILTER_ID);
  filter.setAttribute('x', '-20%'); filter.setAttribute('y', '-20%');
  filter.setAttribute('width', '140%'); filter.setAttribute('height', '140%');
  filter.setAttribute('color-interpolation-filters', 'sRGB');
  const blur = document.createElementNS(NS, 'feGaussianBlur');
  blur.setAttribute('in', 'SourceGraphic');
  blur.setAttribute('stdDeviation', '4');
  const matrix = document.createElementNS(NS, 'feColorMatrix');
  matrix.setAttribute('type', 'matrix');
  matrix.setAttribute('values', '1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -9.5');
  const fade = makeGooFade(NS);
  filter.appendChild(blur);
  filter.appendChild(matrix);
  filter.appendChild(fade);
  const defs = document.createElementNS(NS, 'defs');
  defs.appendChild(filter);
  svg.appendChild(defs);
  document.body.appendChild(svg);
  gooFilterEls = { blur, matrix, fade };
  return gooFilterEls;
}

/** Max frames held while the streaming encoder's async codec probe resolves.
 *  Small on purpose — this is a hand-off buffer, not a recording buffer. */
const WEBM_STREAM_PENDING_MAX = 8;

/** Force every pixel of a captured recording frame to full opacity (alpha=255),
 *  in place. Both the 2D display canvas (agents-only, cleared to transparent
 *  black) and the 3D WebGL buffer (transparent GL clear when no background is
 *  set) leave alpha=0 where there is no content; the RGB there already equals
 *  the straight-alpha composite over black (both use SRC_ALPHA blending / a
 *  0,0,0,0 clear), so opacifying keeps the visible look while removing the
 *  transparency that made GIF frame-disposal accumulate stale imagery (moving
 *  agents / orbiting the 3D camera left permanent trails). A set environment
 *  background is already baked opaque, so this is a no-op there. */
function forceFrameOpaque(data: Uint8ClampedArray): void {
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
}

/** A binary choice is a two-state SEGMENT, never a dropdown — the rule that came
 *  out of the capture-controls reorganisation (a full <select> for an either/or
 *  was the most wasteful control on the transport bar). Used by the capture
 *  popover; `disabled` greys the whole segment IN PLACE (never unmounted) so the
 *  popover's geometry is stable and the reason can be stated beneath it. */
function captureSegment<T extends string>(
  options: ReadonlyArray<{ label: string; value: T; disabled?: boolean }>,
  value: T,
  onPick: (v: T) => void,
  disabled: boolean,
) {
  return (
    <span className={styles.captureSeg}>
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          className={`${styles.captureSegBtn} ${value === o.value ? styles.captureSegBtnOn : ''}`}
          disabled={disabled || o.disabled}
          onClick={() => onPick(o.value)}
        >{o.label}</button>
      ))}
    </span>
  );
}

/** M1 (audit) — the direct-agent-render gate terms that a SOFT recompile can flip.
 *  Everything ELSE in the gate (topology, dimension, agent target, decoupling,
 *  OffscreenCanvas, bonds) already forces a FULL reinit when it changes, so those
 *  can safely be evaluated once in initWorkerWithDimensions. These two cannot:
 *  `sprites` and `agentMappings` are not in `needsFullInit`, so the gate went
 *  stale — a sprite added mid-session kept direct render on (the GPU pass draws
 *  discs only and drawAgentsOverlay is skipped ⇒ sprites never drawn), and an
 *  agent OM the GPU can't compile kept it presenting behaviour/default colours
 *  instead of the CPU OM colours. ONE helper so the init gate and the
 *  soft-recompile refresh can't drift. */
function agentRenderModelTermsOk(
  sprites: unknown[] | undefined,
  agentMappings: unknown[] | undefined,
  agentTarget: string,
  omGpuSupported: boolean | undefined,
): boolean {
  return (sprites?.length ?? 0) === 0
    && (agentTarget !== 'webgpu' || (agentMappings?.length ?? 0) === 0 || !!omGpuSupported);
}

// --- Brush shapes ---
// The brush stamp is no longer always a rectangle: circle (filled disc by
// radius), ring (annulus: radius ± width/2), and line (two clicks on the
// board define a segment of the given thickness) join the classic rect.
type BrushShape = 'rect' | 'circle' | 'ring' | 'line';

/** Cell offsets (dr, dc) a single brush stamp covers, relative to the cursor
 *  cell. Rect reproduces the historical W×H loops exactly (off-centre bias on
 *  even sizes preserved). Circle = euclidean disc d ≤ radius + 0.49; ring =
 *  band |d − radius| ≤ width/2 (width 1 → the classic 1-cell discrete circle).
 *  Line has no static stamp — its cells come from lineStampCells. */
function brushShapeOffsets(
  shape: BrushShape, bw: number, bh: number, radius: number, ringWidth: number,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (shape === 'circle' || shape === 'ring') {
    const r = Math.max(0, radius);
    const halfBand = Math.max(1, ringWidth) / 2;
    const lo = shape === 'circle' ? -1 : r - halfBand;
    const hi = shape === 'circle' ? r + 0.49 : r + halfBand;
    const span = Math.ceil(hi);
    for (let dr = -span; dr <= span; dr++) {
      for (let dc = -span; dc <= span; dc++) {
        const d = Math.hypot(dr, dc);
        if (d >= lo && d <= hi) out.push([dr, dc]);
      }
    }
    return out;
  }
  if (shape === 'line') {
    // Stamp preview while no anchor is placed: a width-sized dot.
    const w = Math.max(1, radius); // caller passes line width via `radius`
    const half = w / 2;
    const span = Math.ceil(half);
    for (let dr = -span; dr <= span; dr++) {
      for (let dc = -span; dc <= span; dc++) {
        if (Math.hypot(dr, dc) <= Math.max(0.49, half - 0.01)) out.push([dr, dc]);
      }
    }
    return out;
  }
  // rect — identical coverage to the historical double loop.
  const halfW = Math.floor((bw - 1) / 2);
  const halfH = Math.floor((bh - 1) / 2);
  for (let dr = -halfH; dr <= halfH + ((bh - 1) % 2); dr++) {
    for (let dc = -halfW; dc <= halfW + ((bw - 1) % 2); dc++) {
      out.push([dr, dc]);
    }
  }
  return out;
}

/** 3D ("extrapolated") brush-stamp offsets — `(dRow, dCol, dLayer)` for a
 *  VOLUMETRIC brush: Circle → solid sphere, Ring → spherical shell, Rect → a box
 *  (the row size also drives the layer extent). The 3rd value offsets the plane's
 *  FIXED axis (mapped by mapStampToPlane), so a flat disc becomes a ball etc. */
function brushShapeOffsets3d(
  shape: BrushShape, bw: number, bh: number, radius: number, ringWidth: number, boxDepth: number,
): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  if (shape === 'circle' || shape === 'ring') {
    const r = Math.max(0, radius);
    const halfBand = Math.max(1, ringWidth) / 2;
    const lo = shape === 'circle' ? -1 : r - halfBand;
    const hi = shape === 'circle' ? r + 0.49 : r + halfBand;
    const span = Math.ceil(hi);
    for (let dl = -span; dl <= span; dl++)
      for (let dr = -span; dr <= span; dr++)
        for (let dc = -span; dc <= span; dc++) {
          const d = Math.hypot(dr, dc, dl);
          if (d >= lo && d <= hi) out.push([dr, dc, dl]);
        }
    return out;
  }
  if (shape === 'line') {
    // Volumetric preview dot = a small ball of the line's width.
    const half = Math.max(0.5, Math.max(1, radius) / 2);
    const span = Math.ceil(half);
    for (let dl = -span; dl <= span; dl++)
      for (let dr = -span; dr <= span; dr++)
        for (let dc = -span; dc <= span; dc++)
          if (Math.hypot(dr, dc, dl) <= Math.max(0.49, half - 0.01)) out.push([dr, dc, dl]);
    return out;
  }
  // rect → box: bw (col) × bh (row) × boxDepth (layer); off-centre bias mirrors the 2D rect.
  const halfW = Math.floor((bw - 1) / 2), halfH = Math.floor((bh - 1) / 2), halfD = Math.floor((boxDepth - 1) / 2);
  for (let dl = -halfD; dl <= halfD + ((boxDepth - 1) % 2); dl++)
    for (let dr = -halfH; dr <= halfH + ((bh - 1) % 2); dr++)
      for (let dc = -halfW; dc <= halfW + ((bw - 1) % 2); dc++)
        out.push([dr, dc, dl]);
  return out;
}

/** Cells covered by a thick segment between two cell centres (capsule test:
 *  point-to-segment distance ≤ width/2, so width 1 ≈ a 1-cell line). Returned
 *  unwrapped — callers wrap modulo grid in infinity mode. */
function lineStampCells(
  a: { row: number; col: number }, b: { row: number; col: number }, width: number,
): Array<{ row: number; col: number }> {
  const w = Math.max(1, width);
  const half = Math.max(0.5, w / 2);
  const span = Math.ceil(half);
  const minR = Math.min(a.row, b.row) - span, maxR = Math.max(a.row, b.row) + span;
  const minC = Math.min(a.col, b.col) - span, maxC = Math.max(a.col, b.col) + span;
  const vr = b.row - a.row, vc = b.col - a.col;
  const lenSq = vr * vr + vc * vc;
  const out: Array<{ row: number; col: number }> = [];
  for (let row = minR; row <= maxR; row++) {
    for (let col = minC; col <= maxC; col++) {
      let d: number;
      if (lenSq === 0) {
        d = Math.hypot(row - a.row, col - a.col);
      } else {
        const t = Math.max(0, Math.min(1, ((row - a.row) * vr + (col - a.col) * vc) / lenSq));
        d = Math.hypot(row - (a.row + t * vr), col - (a.col + t * vc));
      }
      if (d <= half) out.push({ row, col });
    }
  }
  return out;
}

/** Silhouette edges of a set of cells — every cell edge bordering a non-member
 *  cell, in CELL coordinate units ([x0,y0,x1,y1] with x=col, y=row; a cell's
 *  box spans (col..col+1, row..row+1)). Scaled + translated at draw time. */
function cellSilhouetteEdges(cells: Array<[number, number]>): Array<[number, number, number, number]> {
  const set = new Set(cells.map(([r, c]) => r * 131072 + c));
  const has = (r: number, c: number) => set.has(r * 131072 + c);
  const edges: Array<[number, number, number, number]> = [];
  for (const [r, c] of cells) {
    if (!has(r - 1, c)) edges.push([c, r, c + 1, r]);
    if (!has(r + 1, c)) edges.push([c, r + 1, c + 1, r + 1]);
    if (!has(r, c - 1)) edges.push([c, r, c, r + 1]);
    if (!has(r, c + 1)) edges.push([c + 1, r, c + 1, r + 1]);
  }
  return edges;
}

// --- Manual Brush ---
// Sentinel mapping ID for the runtime-only "Manual" tab in the brush mapping
// strip. Doesn't collide with real mapping IDs (which are nanoid-like).
export const MANUAL_BRUSH_MAPPING_ID = '__manual__';

/** Stable empty footprint array (avoids a new [] per frame when 3D hover is off). */
const EMPTY_HOVER_CELLS: ReadonlyArray<{ layer: number; row: number; col: number }> = [];
const EMPTY_AGENT_RINGS: ReadonlyArray<{ x: number; y: number; z: number; radius: number }> = [];

/** The agent-brush modes, in cycle order (Alt+scroll steps through them). Shared
 *  by the mode-button row and the wheel-cycle handlers so they can't drift. */
const AGENT_BRUSH_MODES: ReadonlyArray<'add' | 'remove' | 'move' | 'edit' | 'glue' | 'cut' | 'bond'> =
  ['add', 'remove', 'move', 'edit', 'glue', 'cut', 'bond'];

/** Build a bounded wireframe OUTLINE of a 3D brush footprint at a plane cell, as
 *  cell-space line segments (a flat Float32Array of [col,row,layer, col,row,layer …]
 *  endpoint pairs; the renderer maps each to world space + colours it amber). The
 *  geometry is a few circles / a box regardless of brush size — so a huge
 *  volumetric brush can't blow up memory the way a per-cell cube cursor would.
 *  Free axes A (bw/halfW) and B (bh/halfH) + fixed axis N per the plane:
 *    z → A=col,  B=row,   N=layer
 *    y → A=col,  B=layer, N=row
 *    x → A=row,  B=layer, N=col   (matches mapStampToPlane / agentProj3d) */
function buildBrushOutline3dSegs(o: {
  axis: 'x' | 'y' | 'z';
  cx: number; cy: number; cz: number;              // centre col,row,layer
  shape: 'rect' | 'circle' | 'ring' | 'line';
  halfW: number; halfH: number;                    // rect half-extents (free1, free2)
  radius: number; ringW: number; lineW: number;    // circle / ring / line params
  fixedHalf: number;                               // volumetric half-depth along N (0 = flat)
  anchor: { col: number; row: number; layer: number } | null;  // line-tool staging
}): Float32Array | null {
  const A: [number, number, number] = o.axis === 'x' ? [0, 1, 0] : [1, 0, 0];
  const B: [number, number, number] = o.axis === 'z' ? [0, 1, 0] : [0, 0, 1];
  const N: [number, number, number] = o.axis === 'z' ? [0, 0, 1] : o.axis === 'y' ? [0, 1, 0] : [1, 0, 0];
  const seg: number[] = [];
  const P = (a: number, b: number, n: number): [number, number, number] => [
    o.cx + a * A[0] + b * B[0] + n * N[0],
    o.cy + a * A[1] + b * B[1] + n * N[1],
    o.cz + a * A[2] + b * B[2] + n * N[2],
  ];
  const line = (p: [number, number, number], q: [number, number, number]) => seg.push(p[0], p[1], p[2], q[0], q[1], q[2]);
  const NSEG = 36;
  // A circle parametrised by θ→[a,b,n] offsets around the centre.
  const arc = (f: (t: number) => [number, number, number]) => {
    let prev: [number, number, number] | null = null;
    for (let k = 0; k <= NSEG; k++) {
      const t = (k / NSEG) * Math.PI * 2;
      const p = P(...f(t));
      if (prev) line(prev, p);
      prev = p;
    }
  };
  const circleAB = (R: number, n: number) => arc(t => [R * Math.cos(t), R * Math.sin(t), n]);
  const rectAt = (hw: number, hh: number, n: number) => {
    line(P(-hw, -hh, n), P(hw, -hh, n)); line(P(hw, -hh, n), P(hw, hh, n));
    line(P(hw, hh, n), P(-hw, hh, n)); line(P(-hw, hh, n), P(-hw, -hh, n));
  };
  if (o.shape === 'line') {
    if (o.anchor) line([o.anchor.col, o.anchor.row, o.anchor.layer], [o.cx, o.cy, o.cz]);
    circleAB(Math.max(0.5, o.lineW / 2), 0);
  } else if (o.shape === 'rect') {
    const hw = Math.max(0.5, o.halfW), hh = Math.max(0.5, o.halfH);
    if (o.fixedHalf > 0) {
      const fh = o.fixedHalf;
      rectAt(hw, hh, -fh); rectAt(hw, hh, fh);
      line(P(-hw, -hh, -fh), P(-hw, -hh, fh)); line(P(hw, -hh, -fh), P(hw, -hh, fh));
      line(P(hw, hh, -fh), P(hw, hh, fh)); line(P(-hw, hh, -fh), P(-hw, hh, fh));
    } else rectAt(hw, hh, 0);
  } else {
    const R = Math.max(0.5, o.radius);
    // Draw a circle of `rad` on the plane, plus (when volumetric) the two great
    // circles through the fixed axis → a sphere. A ring stacks two spheres
    // (outer + inner) → a spherical shell, matching the painted footprint.
    const sphere = (rad: number) => {
      circleAB(rad, 0);
      if (o.fixedHalf > 0) {
        arc(t => [rad * Math.cos(t), 0, rad * Math.sin(t)]);
        arc(t => [0, rad * Math.cos(t), rad * Math.sin(t)]);
      }
    };
    if (o.shape === 'ring') {
      sphere(R + o.ringW / 2);
      sphere(Math.max(0.25, R - o.ringW / 2));
    } else {
      sphere(R);
    }
  }
  return seg.length ? new Float32Array(seg) : null;
}

export interface ManualBrushAttrEntry {
  enabled: boolean;
  /** Canonical string encoding, identical to Attribute.defaultValue. */
  value: string;
}
export type ManualBrushModelState = Record<string /* attrId */, ManualBrushAttrEntry>;

/** Bond-Graph Agents — the `getAgentState` inspector response (on-demand, NOT
 *  a per-frame snapshot field). `live: false` for a dead/out-of-range id. */
export interface AgentStateResponse {
  type: 'agentState';
  id: number;
  live: boolean;
  x?: number; y?: number; z?: number; vx?: number; vy?: number; vz?: number;
  radius?: number; lineage?: number; age?: number;
  bondDegree?: number; density?: number;
  attrs?: Record<string, number>;
  bonds?: number[];
  /** P2 — per-EDGE user state, PARALLEL to `bonds`. Absent with no bond attrs. */
  bondAttrs?: Array<Record<string, number>>;
}

const MANUAL_BRUSH_KEY_PREFIX = 'genesisca_manual_brush_v1:';
function manualBrushStorageKey(modelName: string): string {
  // Models don't have a stable id field, so we key on the user-visible name.
  // Renaming a model resets brush state (acceptable UX wart — values are
  // re-derived from each attribute's defaultValue with all rows enabled).
  return MANUAL_BRUSH_KEY_PREFIX + (modelName.trim() || '__unnamed__');
}
function loadManualBrush(modelName: string): ManualBrushModelState | null {
  try {
    const raw = localStorage.getItem(manualBrushStorageKey(modelName));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as ManualBrushModelState;
  } catch { /* ignore */ }
  return null;
}
function saveManualBrush(modelName: string, state: ManualBrushModelState): void {
  try {
    localStorage.setItem(manualBrushStorageKey(modelName), JSON.stringify(state));
  } catch { /* localStorage full */ }
}

// Bond-Graph Agents — seed-config attribute values are per-model (attr ids are
// model-specific), so they get their own localStorage key, separate from the
// global genesisca_sim_settings (which holds the radius/density/spacing/type).
const AGENT_SEED_KEY_PREFIX = 'genesisca_agent_seed_v1:';
function agentSeedStorageKey(modelName: string): string {
  return AGENT_SEED_KEY_PREFIX + (modelName.trim() || '__unnamed__');
}
function loadAgentSeed(modelName: string): ManualBrushModelState | null {
  try {
    const raw = localStorage.getItem(agentSeedStorageKey(modelName));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as ManualBrushModelState;
  } catch { /* ignore */ }
  return null;
}
function saveAgentSeed(modelName: string, state: ManualBrushModelState): void {
  try {
    localStorage.setItem(agentSeedStorageKey(modelName), JSON.stringify(state));
  } catch { /* localStorage full */ }
}

// Agent Edit brush — which agent properties (attributes + geometry) to overwrite
// and to what value. Separate per-model localStorage entry (like the seed config).
const AGENT_EDIT_KEY_PREFIX = 'genesisca_agent_edit_v1:';
function agentEditStorageKey(modelName: string): string {
  return AGENT_EDIT_KEY_PREFIX + (modelName.trim() || '__unnamed__');
}
function loadAgentEdit(modelName: string): ManualBrushModelState | null {
  try {
    const raw = localStorage.getItem(agentEditStorageKey(modelName));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as ManualBrushModelState;
  } catch { /* ignore */ }
  return null;
}
function saveAgentEdit(modelName: string, state: ManualBrushModelState): void {
  try {
    localStorage.setItem(agentEditStorageKey(modelName), JSON.stringify(state));
  } catch { /* localStorage full */ }
}
// Synthetic "attribute" ids for the Edit brush's geometry rows (radius / velocity
// / position). They render as float widgets in ManualBrushPanel and route to the
// paintAgents `geom` payload (not `sets`) at flush time.
const GEOM_RADIUS = '__geom_radius__', GEOM_VX = '__geom_vx__', GEOM_VY = '__geom_vy__', GEOM_VZ = '__geom_vz__';
const GEOM_X = '__geom_x__', GEOM_Y = '__geom_y__', GEOM_Z = '__geom_z__';
const AGENT_GEOM_ATTR_SPECS: Array<{ id: string; name: string }> = [
  { id: GEOM_RADIUS, name: 'Radius' },
  { id: GEOM_VX, name: 'Velocity X' }, { id: GEOM_VY, name: 'Velocity Y' }, { id: GEOM_VZ, name: 'Velocity Z' },
  { id: GEOM_X, name: 'Position X' }, { id: GEOM_Y, name: 'Position Y' }, { id: GEOM_Z, name: 'Position Z' },
];

// "Include central cell" is a schema-level flag that is compiled away before
// simulation: a neighborhood with the flag set gets [0,0] appended to its
// effective `coords`, so the worker + all three compilers (which iterate
// `coords` / read `coords.length`) treat the cell itself as a member with no
// code changes of their own. This MUST be applied as the first transform at
// every point the model is handed to the compile/sim pipeline — applying it
// per-site risks the worker's neighbor tables and the compiled `nSz_<nbr>`
// desyncing. Returns the same model reference when no neighborhood uses it.
function withEffectiveNeighborhoods(model: CAModel): CAModel {
  if (!model.neighborhoods.some(n => n.includeCentralCell)) return model;
  return {
    ...model,
    neighborhoods: model.neighborhoods.map(n => {
      if (!n.includeCentralCell) return n;
      // 3D Grid CA: a 3D neighbourhood carries coords3d as the source of truth
      // and a same-length 2D `coords` projection. The central cell must be
      // appended to BOTH so the stride invariant (coords.length ===
      // coords3d.length) holds. Guard against an already-listed centre.
      if (n.coords3d) {
        if (n.coords3d.some(([dr, dc, dl]) => dr === 0 && dc === 0 && dl === 0)) return n;
        return {
          ...n,
          coords: [...n.coords, [0, 0] as [number, number]],
          coords3d: [...n.coords3d, [0, 0, 0] as [number, number, number]],
        };
      }
      // Guard against a hand-edited file that already lists [0,0] — never
      // double-count the central cell.
      if (n.coords.some(([r, c]) => r === 0 && c === 0)) return n;
      return { ...n, coords: [...n.coords, [0, 0] as [number, number]] };
    }),
  };
}

// Build the runtime model-attribute value map from each model attribute's
// declared default. Shared by worker init and the "Reset to Default" button.
function computeDefaultModelAttrs(attributes: Attribute[]): Record<string, number> {
  const mAttrs: Record<string, number> = {};
  for (const a of attributes) {
    if (!a.isModelAttribute) continue;
    switch (a.type) {
      case 'bool': mAttrs[a.id] = a.defaultValue === 'true' ? 1 : 0; break;
      case 'integer': mAttrs[a.id] = parseInt(a.defaultValue, 10) || 0; break;
      case 'float': mAttrs[a.id] = parseFloat(a.defaultValue) || 0; break;
      case 'neighborIndex': {
        // Stored value is the packed (dr, dc) i32 (see NeighborIndexDefaultEditor).
        // INVALID_NI on a model attribute is meaningless at runtime — normalize to 0.
        const n = parseInt(a.defaultValue, 10);
        mAttrs[a.id] = (Number.isFinite(n) && n !== INVALID_NI) ? (n | 0) : 0;
        break;
      }
      case 'color': {
        // #rrggbb (alpha absent → 255) or #rrggbbaa. Slot names must match
        // `modelAttrSlotKeys` — the layout-lockstep invariant.
        const c = hexToRgba(a.defaultValue || '#808080');
        mAttrs[a.id + '_r'] = c.r;
        mAttrs[a.id + '_g'] = c.g;
        mAttrs[a.id + '_b'] = c.b;
        mAttrs[a.id + '_a'] = c.a;
        break;
      }
      case 'lookupTable':
        // Lives in `interactionTables` worker payload (separate from the
        // scalar `modelAttrs` record). Don't allocate a slot here.
        break;
      default: mAttrs[a.id] = 0;
    }
  }
  return mAttrs;
}

/** Compare two attribute lists for STRUCTURAL changes only — the kind of changes
 *  that affect worker init (buffer layout, indicator ids, sub-attribute parent
 *  checks, variegated face-pattern lookup size, sentinel-cell defaults). Returns
 *  true when the only differences are in live-tunable fields that the running
 *  worker can absorb without a reinit:
 *    - name / description / hasBounds / min / max / symmetric: pure UI fields,
 *      never read by the worker.
 *    - tableValues: interaction-table data, pushed via updateInteractionTable.
 *      Lives outside the cell-attr / model-attr layout.
 *  The existing reference-equality check `prev.attributes === model.attributes`
 *  forced a reinit on EVERY updateAttribute (the reducer always rebuilds the
 *  array). That wiped the grid whenever a preset, Reset-to-Default, or in-panel
 *  interaction-table edit fired — even though none of those touch buffer layout.
 *  This structural compare keeps the existing "reinit on shape change" semantic
 *  while letting live-tunable updates flow through without disturbing the grid. */
/** Serialize an Attribute to the worker's AttrDef shape (init + recompile). Shared
 *  by the cell-attribute and agent-attribute payloads so they never diverge.
 *  `agentAccess` rides cell attributes (drives the worker's fieldSpecs). */
function toAttrDefMsg(a: Attribute) {
  return {
    id: a.id, type: a.type,
    isModelAttribute: a.isModelAttribute, defaultValue: a.defaultValue,
    boundaryValue: a.boundaryValue,
    tagOptions: a.tagOptions,
    parentAttributeId: a.parentAttributeId,
    parentValues: a.parentValues,
    undefinedValue: a.undefinedValue,
    agentAccess: a.agentAccess,
  };
}

function attrsStructurallyEqual(prev: Attribute[], curr: Attribute[]): boolean {
  if (prev === curr) return true;
  if (prev.length !== curr.length) return false;
  for (let i = 0; i < prev.length; i++) {
    const a = prev[i]!, b = curr[i]!;
    if (a === b) continue;
    if (a.id !== b.id) return false;
    if (a.type !== b.type) return false;
    if (a.isModelAttribute !== b.isModelAttribute) return false;
    if (a.defaultValue !== b.defaultValue) return false;
    // A `vector` attr's dims drive its component count (2 vs 3 float buffers) — a
    // change re-lays out the SoA, so it needs a full reinit. defaultValue usually
    // changes alongside (the dropdown resets it), but guard the dims directly so a
    // hand-edited file / independent-dims edit can't desync compiler vs worker.
    if ((a.vectorDims ?? 2) !== (b.vectorDims ?? 2)) return false;
    if (a.boundaryValue !== b.boundaryValue) return false;
    // Generic Agent Platform: the agent field-access permission drives fieldSpecs
    // (which cell attrs are threaded as `_field_` into the agent loop) — a change
    // alters the agent loop signature, so it needs a full worker reinit.
    if ((a.agentAccess ?? 'none') !== (b.agentAccess ?? 'none')) return false;
    if (a.parentAttributeId !== b.parentAttributeId) return false;
    if (a.undefinedValue !== b.undefinedValue) return false;
    if (a.neighborhoodHintId !== b.neighborhoodHintId) return false;
    // tagOptions order matters (face-pattern lookup keys + node-config tag indices)
    const at = a.tagOptions, bt = b.tagOptions;
    const al = at?.length ?? 0, bl = bt?.length ?? 0;
    if (al !== bl) return false;
    for (let j = 0; j < al; j++) if (at![j] !== bt![j]) return false;
    // parentValues order matters (sub-attribute parent-check)
    const ap = a.parentValues, bp = b.parentValues;
    const apl = ap?.length ?? 0, bpl = bp?.length ?? 0;
    if (apl !== bpl) return false;
    for (let j = 0; j < apl; j++) if (ap![j] !== bp![j]) return false;
    // facePatternAssignments: compare as a key→value map
    const fpaA = a.facePatternAssignments ?? {};
    const fpaB = b.facePatternAssignments ?? {};
    const fpaKeys = new Set([...Object.keys(fpaA), ...Object.keys(fpaB)]);
    for (const k of fpaKeys) if (fpaA[k] !== fpaB[k]) return false;
    // Lookup Table key sources: changing which palette / tag attribute an axis
    // uses changes the table's dimensions → memory layout → requires full reinit.
    if (JSON.stringify(a.rowKeySource) !== JSON.stringify(b.rowKeySource)) return false;
    if (JSON.stringify(a.colKeySource) !== JSON.stringify(b.colKeySource)) return false;
  }
  return true;
}

/** Layout-affecting signature of the variegation config: the source attribute
 *  (drives facePatternLookup size) + each palette's label COUNT (drives the
 *  dimensions of any facePalette-keyed Lookup Table). A change here resizes
 *  wasmMemory regions, so it must force a full worker reinit rather than a soft
 *  recompile (which would leave stale-sized table views and crash on set()). */
function variegatedLayoutKey(model: CAModel): string {
  const v = model.variegatedCells;
  if (!v?.enabled) return 'off';
  const palettes = (v.facePalettes ?? []).map(p => `${p.id}:${p.labels.length}`).join(',');
  return `${v.sourceAttributeId}|${palettes}`;
}

// Tiny chevron icons used by the viewer / transport bar collapse toggles. Inline
// SVG (not Unicode glyphs) so the up and down variants are pixel-identical —
// fonts can't be relied on to render ⌃ and ⌄ at the same width.
const ChevronUpIcon = () => (
  <svg width="10" height="6" viewBox="0 0 10 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
    <polyline points="1,5 5,1 9,5" />
  </svg>
);
const ChevronDownIcon = () => (
  <svg width="10" height="6" viewBox="0 0 10 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
    <polyline points="1,1 5,5 9,1" />
  </svg>
);

// ── Hover-coords chip mini-store ────────────────────────────────────────────
// The hovered-cell / brush-footprint readout changes on every cell crossing.
// As React STATE it re-rendered the whole (huge) SimulatorView per crossing,
// which measurably competed with the simulation's step→draw pipeline while
// playing (part of the "moving the brush cursor slows the sim" bug). A
// module-level external store + a tiny memoized subscriber keeps the chip live
// while the parent never re-renders for it (the graphState pub/sub pattern).
type HoverCellInfo = { col: number; row: number; x0: number; y0: number; x1: number; y1: number } | null;
let hoverCellInfoVal: HoverCellInfo = null;
const hoverCellInfoListeners = new Set<() => void>();
function publishHoverCellInfo(v: HoverCellInfo): void {
  const p = hoverCellInfoVal;
  if (p === v || (p !== null && v !== null && p.col === v.col && p.row === v.row
    && p.x0 === v.x0 && p.y0 === v.y0 && p.x1 === v.x1 && p.y1 === v.y1)) return;
  hoverCellInfoVal = v;
  for (const l of hoverCellInfoListeners) l();
}
const subscribeHoverCellInfo = (l: () => void): (() => void) => {
  hoverCellInfoListeners.add(l);
  return () => { hoverCellInfoListeners.delete(l); };
};
const getHoverCellInfoSnap = (): HoverCellInfo => hoverCellInfoVal;

/** Width of the per-preset "…" actions menu (px) — must match `.presetMenu`
 *  in SimulatorView.module.css; used to right-align it on its trigger. */
const PRESET_MENU_W = 232;
/** Approximate height of the same menu (5 items + padding) — only used to
 *  decide whether to drop it below or above its trigger. */
const PRESET_MENU_H = 152;
const HoverCoordsChip = memo(function HoverCoordsChip() {
  const info = useSyncExternalStore(subscribeHoverCellInfo, getHoverCellInfoSnap);
  if (!info) return null;
  return (info.x0 === info.x1 && info.y0 === info.y1)
    ? <span title="Hovered cell">Cell ({info.col}, {info.row})</span>
    : <span title="Brush footprint at the hovered cell">Cells ({info.x0},{info.y0}) {'→'} ({info.x1},{info.y1})</span>;
});

/**
 *  `hideInstructionsPill` — the standalone-simulation VIEWER shell
 *  ([src/viewer/ViewerApp.tsx]) renders its OWN top-left "ⓘ Info" button
 *  (anchored just right of the settings ear) whose About panel ALREADY shows
 *  the model's instructions, so the pill would both collide with it and be
 *  redundant there. The main app leaves it undefined (pill shown).
 */
export function SimulatorView({ visible = true, hideInstructionsPill = false }: { visible?: boolean; hideInstructionsPill?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { model, modelVersion, updateIndicator, setSimulationState, addPreset, duplicatePreset, deletePreset, updatePreset, reorderPresets, updateProperties, updateAttribute } = useModel();
  const presetReorder = useListReorder(model.presets || [], reorderPresets);
  const workerRef = useRef<Worker | null>(null);
  const pendingStep = useRef(false);

  const saved = useRef(loadSimSettings());

  const [generation, setGeneration] = useState(0);
  // Generation is throttled into React state (~10 Hz) but kept up-to-date in
  // a ref every step. Synchronous readers (filename in screenshot/save-state
  // downloads, end-condition evaluation, etc.) read the ref so they see the
  // exact current value; only the visible "Gen X" + indicator panel re-render
  // tick at the throttled rate. Removes the per-step React reconcile that
  // was the second-largest per-frame cost behind the canvas-width reset.
  const generationRef = useRef(0);
  const lastGenSetTime = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [targetFps, setTargetFps] = useState((saved.current.targetFps as number) ?? 30);
  const [unlimitedFps, setUnlimitedFps] = useState((saved.current.unlimitedFps as boolean) ?? false);
  const [gensPerFrame, setGensPerFrame] = useState((saved.current.gensPerFrame as number) ?? 1);
  const [unlimitedGens, setUnlimitedGens] = useState((saved.current.unlimitedGens as boolean) ?? false);
  const [compileError, setCompileError] = useState('');
  const [activeViewer, setActiveViewer] = useState((saved.current.activeViewer as string) ?? '');
  // Agent Output Mappings: the active AGENT viewer (an agent mapping id),
  // independent of the cell `activeViewer`. Empty when the model has no agent
  // mappings. Drives the agent colour pass (the two-layer viewer selection).
  const [activeAgentViewer, setActiveAgentViewer] = useState((saved.current.activeAgentViewer as string) ?? '');
  const activeAgentViewerRef = useRef(activeAgentViewer); activeAgentViewerRef.current = activeAgentViewer;
  const [showCode, setShowCode] = useState(false);
  const [compiledCode, setCompiledCode] = useState('');
  const [actualFps, setActualFps] = useState(0);
  const [actualGps, setActualGps] = useState(0);
  const [brushColor, setBrushColor] = useState((saved.current.brushColor as string) ?? '#4cc9f0');
  const [brushW, setBrushW] = useState((saved.current.brushW as number) ?? 1);
  const [brushH, setBrushH] = useState((saved.current.brushH as number) ?? 1);
  // Brush shape + per-shape parameters. The size row in the panel adapts:
  // rect = W/H, circle = radius, ring = radius + width, line = width (+ the
  // line tool takes two clicks on the board to place the segment).
  const [brushShape, setBrushShape] = useState<BrushShape>(
    (['rect', 'circle', 'ring', 'line'] as const).includes(saved.current.brushShape as BrushShape)
      ? (saved.current.brushShape as BrushShape) : 'rect',
  );
  const [brushRadius, setBrushRadius] = useState((saved.current.brushRadius as number) ?? 3);
  const [brushRingWidth, setBrushRingWidth] = useState((saved.current.brushRingWidth as number) ?? 1);
  const [brushLineWidth, setBrushLineWidth] = useState((saved.current.brushLineWidth as number) ?? 1);
  // 3D Grid CA: when true, the brush shape is VOLUMETRIC (sphere/box/shell)
  // instead of a flat footprint on the interaction plane ("Extrapolate plane").
  const [brush3dVolume, setBrush3dVolume] = useState<boolean>(!!saved.current.brush3dVolume);
  // 3D: draw agents in FRONT of the CA-grid voxels (the historical behaviour —
  // the grid usually surrounds the agents and would hide them completely). OFF =
  // normal depth occlusion between the two layers (useful for sparse grids).
  // Helper overlays (axes/grid/bounds/brush plane) keep normal depth either way.
  const [agentsFront3d, setAgentsFront3d] = useState<boolean>(saved.current.agentsFront3d !== false);
  // 3D lighting (light ball + ambient/diffuse/specular + camera/world anchor)
  // and the cell-gaps toggle — declared HERE (before the settings-persist
  // effect below) with the rest of the persisted view options; the 3D-only
  // helpers that consume them live with the other 3D control state further down.
  const [light3d, setLight3d] = useState<Light3D>(() => sanitizeLight3d(saved.current.light3d));
  // Gaps between adjacent 3D cells — the 3D analogue of the 2D gridlines
  // toggle. ON (default) = the historical 0.92 cube scale; OFF = flush cubes.
  // Default OFF (flush cubes): the seamless-solid look, and the mode where the
  // renderer's buried-cell culling engages (gaps expose interiors through the
  // cracks, so gaps-ON renders the full alive set). An explicitly saved true
  // (the user turned gaps on) is respected.
  const [cellGaps3d, setCellGaps3d] = useState<boolean>(saved.current.cellGaps3d === true);
  // Agent METABALLS (2D + 3D): render the agents as a fused implicit surface
  // instead of discrete circles / spheres. 3D = a baked density field raymarched
  // in gl3d; 2D = an approximate gooey filter (blur + alpha threshold). One
  // shared, persisted preference for both views (declared HERE, before the
  // settings-persist effect, like light3d — see its comment).
  const [agentMetaballs, setAgentMetaballs] = useState<Metaballs3D>(() => sanitizeAgentMetaballs(saved.current.agentMetaballs));
  // A1 direct-agent-render Glow option (WebGPU direct path only). Declared HERE,
  // before the settings-persist effect (like agentMetaballs).
  const [agentGlow, setAgentGlow] = useState<AgentGlow>(() => sanitizeAgentGlow(saved.current.agentGlow));
  const agentGlowRef = useRef<AgentGlow>(agentGlow); agentGlowRef.current = agentGlow;
  // 3D Grid CA: depth (number of layers) of the VOLUMETRIC box brush — independent
  // of the row size (H), so a box can be e.g. wide+tall+shallow.
  const [brushBoxDepth, setBrushBoxDepth] = useState<number>((saved.current.brushBoxDepth as number) ?? 3);
  const [brushMapping, setBrushMapping] = useState((saved.current.brushMapping as string) ?? '');
  // User-dragged height (px) of the right panel's brush section. null = auto
  // (shrink to content, the default). Set via the splitter between the Input
  // Mapping and Indicators sections; double-click resets to auto.
  const [brushSectionH, setBrushSectionH] = useState<number | null>(
    typeof saved.current.brushSectionH === 'number' ? saved.current.brushSectionH : null,
  );
  const brushSectionRef = useRef<HTMLDivElement>(null);
  // Manual Brush — per-model state: which cell attrs are being set, and to
  // what value. Persisted per-model name in localStorage (see helpers above).
  // The merge effect below seeds defaults whenever the attribute list changes.
  const [manualBrush, setManualBrush] = useState<ManualBrushModelState>({});
  const manualBrushRef = useRef<ManualBrushModelState>({});
  useEffect(() => { manualBrushRef.current = manualBrush; }, [manualBrush]);
  // Bond-Graph Agents — seed-config per-attribute initial values (same shape +
  // merge discipline as Manual Brush; per-model persisted). Unchecked rows seed
  // the engine default; the enabled ones become the seedAgents `sets` payload.
  const [agentSeedAttrs, setAgentSeedAttrs] = useState<ManualBrushModelState>({});
  const agentSeedAttrsRef = useRef<ManualBrushModelState>({});
  useEffect(() => { agentSeedAttrsRef.current = agentSeedAttrs; }, [agentSeedAttrs]);
  // Edit brush — which agent properties (attributes + geometry) to overwrite, and
  // the single-scope target agent (highlighted; -1 = none). The panel prefills
  // from the picked agent's live state (getAgentState + decode).
  const [agentEditAttrs, setAgentEditAttrs] = useState<ManualBrushModelState>({});
  const agentEditAttrsRef = useRef<ManualBrushModelState>({});
  useEffect(() => { agentEditAttrsRef.current = agentEditAttrs; }, [agentEditAttrs]);
  const [editTargetId, setEditTargetId] = useState<number>(-1);
  const editTargetIdRef = useRef<number>(-1); editTargetIdRef.current = editTargetId;
  const editPrefillIdRef = useRef<number>(-1);
  const [showBrushCursor, setShowBrushCursor] = useState((saved.current.showBrushCursor as boolean) ?? true);
  const [showGridlines, setShowGridlines] = useState((saved.current.showGridlines as boolean) ?? false);
  // 2D axes indicator (origin + row/col growth arrows, the 2D sibling of the
  // 3D Axes toggle). Declared ABOVE the settings-persist effect (TDZ trap).
  const [show2dAxes, setShow2dAxes] = useState((saved.current.show2dAxes as boolean) ?? false);
  // Inspect mode — toolbar toggle making plain LMB inspect (see inspectModeRef).
  const [inspectMode, setInspectMode] = useState(false);
  // Infinity canvas: when the model uses torus boundary, the grid tiles into the
  // viewport so the user can pan endlessly across the wrap seams. Settings flag
  // persists across sessions, but the boundary-treatment guard below forces it
  // off whenever the active model isn't torus.
  const [infinityCanvas, setInfinityCanvas] = useState((saved.current.infinityCanvas as boolean) ?? false);
  // Per-cell glyph overlay: minimum cell pixel size below which glyphs are
  // hidden. Glyphs are unreadable at small cell sizes and the per-cell
  // drawImage loop is wasted work — gate it at the configured threshold.
  // Held in a ref (no UI control yet) — tunable via the persisted
  // `genesisca_sim_settings.glyphMinPx` localStorage key.
  const glyphMinPxRef = useRef<number>(
    (typeof saved.current.glyphMinPx === 'number' && saved.current.glyphMinPx > 0)
      ? (saved.current.glyphMinPx as number)
      : 6,
  );

  // Indicator values from worker
  // Indicator values stored in ref (not state) to avoid extra re-renders on every step.
  // The component already re-renders from setGeneration, so ref values are read during that render.
  // Scalar (standalone/linked-total) → number; linked-frequency → Record<cat,number>;
  // spatial (xAxis rows/columns) → Record<seriesKey, number[]> (per-position-bin
  // series). IndicatorDisplay branches on the indicator's xAxis to render.
  const sieActiveRef = useRef<number | null>(null);
  // --- Compile-target chip (stats overlay) ---------------------------------
  // Which target each layer RESOLVES to, from the model (the same resolution
  // the compile paths use). Memoised — the agent gates flatten the agent graph,
  // too costly to re-run on every stepped re-render. The WebGPU grid target is
  // additionally tracked live via useWebGPUStatus (ready:false ⇒ the worker
  // fell back / errored) so the chip stays honest about silent demotions.
  const compileTargetInfo = useMemo(() => {
    const gridCellsOn = model.topologyMode?.gridCells !== false;
    const grid = model.properties.useWebGPU ? 'WebGPU' : model.properties.useWasm ? 'WASM' : 'JS';
    const agents = model.topologyMode?.agents
      ? agentTargetOf(model.centerBased, isAgentGraphWasmSupported(model), isAgentGraphWebGPUSupported(model))
      : null;
    return { gridCellsOn, grid, agents };
  }, [model]);
  // 'pending' until the worker acks; 'failed' when useWebGPUStatus reports
  // ready:false while WebGPU is the selected grid target (device/init failure —
  // the worker falls back to JS where it can, or surfaces an error).
  const gridWebgpuStatusRef = useRef<'pending' | 'ready' | 'failed'>('pending');
  // FOV sensing nodes (Get Agents In View / Sense Hemifield) in the agent graph
  // (top-level + macro internals) — feeds the vision-cone display. halfAngle /
  // headingSource come from config; the radius is the inline widget value when
  // the port is UNWIRED, else the neighbourQueryRadius fallback (a wired radius
  // isn't knowable at render time). `tint` is the node's optional DISPLAY-ONLY
  // `visionColor` (#rrggbb) as an "r,g,b" string; null ⇒ the automatic palette.
  const visionCones = useMemo(() => {
    if (!model.topologyMode?.agents) return [];
    const out: Array<{ halfAngleDeg: number; radius: number; tint: string | null }> = [];
    const fallbackR = cbNum(model.centerBased, 'neighbourQueryRadius');
    const scan = (
      nodes: typeof model.agentGraphNodes,
      edges: typeof model.agentGraphEdges,
    ) => {
      for (const n of nodes ?? []) {
        const d = n.data as { nodeType?: string; config?: Record<string, unknown> } | undefined;
        const t = d?.nodeType;
        if (t !== 'getAgentsInView' && t !== 'senseHemifield') continue;
        const cfg = d?.config ?? {};
        let deg = Number(cfg.halfAngle ?? (t === 'senseHemifield' ? 90 : 60));
        if (!Number.isFinite(deg)) deg = t === 'senseHemifield' ? 90 : 60;
        const radiusWired = (edges ?? []).some(e => e.target === n.id && e.targetHandle === 'input_value_radius');
        const inlineR = Number(cfg._port_radius ?? 5);
        const r = radiusWired ? fallbackR : (Number.isFinite(inlineR) && inlineR > 0 ? inlineR : 5);
        const vc = cfg.visionColor;
        const tint = typeof vc === 'string' && /^#[0-9a-fA-F]{6}$/.test(vc)
          ? (() => { const c = hexToRgba(vc); return `${c.r},${c.g},${c.b}`; })()
          : null;
        out.push({ halfAngleDeg: Math.max(0, deg), radius: Math.max(0.1, r), tint });
      }
    };
    scan(model.agentGraphNodes, model.agentGraphEdges);
    for (const m of model.macroDefs ?? []) scan(m.nodes, m.edges);
    return out;
  }, [model]);
  const visionConesRef = useRef(visionCones);
  visionConesRef.current = visionCones;
  // --- Author-written "Simulator Instructions" popover ---------------------
  // Shown behind a small "ⓘ Instructions" pill (top-left of the canvas) when
  // model.properties.instructions is non-empty. Session-only UI state; closes
  // on model load (the text may no longer apply), outside pointerdown, or Esc.
  const [showInstructions, setShowInstructions] = useState(false);
  const instructionsText = (model.properties.instructions ?? '').trim();
  const instructionsRef2 = useRef<HTMLDivElement | null>(null);
  useEffect(() => { setShowInstructions(false); }, [model.properties.name]);
  useEffect(() => {
    if (!showInstructions) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as globalThis.Node;
      if (instructionsRef2.current && !instructionsRef2.current.contains(t)) setShowInstructions(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setShowInstructions(false); }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [showInstructions]);

  // --- Canvas-overlay POPOVERS (FPS / Gens-per-Frame sliders, capture settings)
  // The inline sliders were replaced by compact readout buttons that open a
  // small popover; ONE popover at a time (hence the single state + the single
  // wrapper ref, assigned to whichever is currently open). Session-only UI
  // state (the VALUES keep their existing persistence). Dismissed by a
  // capture-phase outside pointerdown (the context-menu pattern) or Escape.
  const [overlayPopup, setOverlayPopup] = useState<'fps' | 'gpf' | 'capture' | null>(null);
  const overlayPopupWrapRef = useRef<HTMLDivElement | null>(null);
  // Bottom-band collision refs — declared up here because draw() (defined well
  // above the effect that owns the logic) is the guaranteed re-check trigger.
  // See the "Bottom-band collision" effect for what they do.
  const canvasAreaRef = useRef<HTMLDivElement | null>(null);
  const transportRowRef = useRef<HTMLDivElement | null>(null);
  const bottomRightStackRef = useRef<HTMLDivElement | null>(null);
  /** draw() calls this when the canvas container's width changed — the one
   *  trigger guaranteed to fire on every real layout change. */
  const measureCaptureCollisionRef = useRef<(() => void) | null>(null);
  const captureCollisionWidthRef = useRef(0);

  useEffect(() => {
    if (!overlayPopup) return;
    const onDown = (e: PointerEvent) => {
      if (overlayPopupWrapRef.current && !overlayPopupWrapRef.current.contains(e.target as globalThis.Node)) {
        setOverlayPopup(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Capture-phase + stopPropagation so Esc closes the popover instead of
        // firing the simulator's Esc=reset shortcut (the shortcuts-overlay rule).
        e.stopPropagation();
        setOverlayPopup(null);
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [overlayPopup]);
  const indicatorValuesRef = useRef<Record<string, number | Record<string, number> | Record<string, number[]>>>({});
  // For scalar indicators: number[] of samples over time.
  // For linked-frequency indicators: Record<category, number[]> so each category
  // gets its own time series (drives multi-line / stacked-area charts).
  const indicatorHistoryRef = useRef<Record<string, number[] | Record<string, number[]>>>({});
  const chartExpandedRef = useRef<Set<string>>(new Set());
  // Per-indicator viz mode for frequency indicators. Default = 'bars' when absent.
  type VizMode = 'bars' | 'multiline' | 'stacked';
  const [indicatorVizModes, setIndicatorVizModes] = useState<Record<string, VizMode>>(() => {
    try {
      const raw = localStorage.getItem(SIM_SETTINGS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.indicatorVizModes && typeof parsed.indicatorVizModes === 'object') {
          return parsed.indicatorVizModes as Record<string, VizMode>;
        }
      }
    } catch { /* fall through */ }
    return {};
  });
  // Per-indicator set of legend categories the user has dimmed in the Lines/Stack
  // charts (runtime display-only, NOT saved into .gcaproj — distinct from the
  // model-level `trackedValues`). Stored in localStorage as Record<id, string[]>.
  const [indicatorHiddenCategories, setIndicatorHiddenCategories] = useState<Record<string, Set<string>>>(() => {
    try {
      const raw = localStorage.getItem(SIM_SETTINGS_KEY);
      if (raw) {
        const stored = JSON.parse(raw).indicatorHiddenCategories;
        if (stored && typeof stored === 'object') {
          const out: Record<string, Set<string>> = {};
          for (const [id, cats] of Object.entries(stored)) {
            if (Array.isArray(cats)) out[id] = new Set(cats as string[]);
          }
          return out;
        }
      }
    } catch { /* fall through */ }
    return {};
  });
  // Per-indicator chart-settings OVERRIDES (gear popover) — a field-level layer
  // over each Indicator.chartSettings model default. Persisted in sim settings
  // AND serialized into SimulationState under "Simulator controls".
  const [indicatorChartOverrides, setIndicatorChartOverrides] = useState<Record<string, IndicatorChartSettings>>(() => {
    try {
      const raw = localStorage.getItem(SIM_SETTINGS_KEY);
      if (raw) {
        const stored = JSON.parse(raw).indicatorChartOverrides;
        if (stored && typeof stored === 'object') return stored as Record<string, IndicatorChartSettings>;
      }
    } catch { /* fall through */ }
    return {};
  });

  // Bond-Graph Agents — brush sizing (world units). Radius drives the seed/kill
  // disc; density = agents per unit² in the seeded cluster; spacing = the
  // drag-stream step; type = the seed Type. Persisted in genesisca_sim_settings.
  // (Declared before the persist effect that serialises them.)
  const [agentBrushRadius, setAgentBrushRadius] = useState<number>((saved.current.agentBrushRadius as number) ?? 8);
  const [agentSeedDensity, setAgentSeedDensity] = useState<number>((saved.current.agentSeedDensity as number) ?? 0.05);
  const [agentSeedSpacing, setAgentSeedSpacing] = useState<number>((saved.current.agentSeedSpacing as number) ?? 6);
  // Agent brush SHAPE + per-shape params (mirror the CA-grid brush): rect W/H,
  // circle radius (agentBrushRadius above), ring radius + width, line width. The
  // agent world is continuous, so these are world-unit footprints tested
  // geometrically (not the cell stamps the CA-grid brush uses).
  const [agentBrushShape, setAgentBrushShape] = useState<BrushShape>(
    (['rect', 'circle', 'ring', 'line'] as const).includes(saved.current.agentBrushShape as BrushShape)
      ? (saved.current.agentBrushShape as BrushShape) : 'circle',
  );
  const [agentBrushW, setAgentBrushW] = useState<number>((saved.current.agentBrushW as number) ?? 10);
  const [agentBrushH, setAgentBrushH] = useState<number>((saved.current.agentBrushH as number) ?? 10);
  const [agentBrushRingWidth, setAgentBrushRingWidth] = useState<number>((saved.current.agentBrushRingWidth as number) ?? 3);
  const [agentBrushLineWidth, setAgentBrushLineWidth] = useState<number>((saved.current.agentBrushLineWidth as number) ?? 3);
  // Scope is DERIVED from the brush SIZE (no manual toggle): a zero-size footprint
  // acts on exactly ONE agent (add-one / remove-nearest / move-one / edit-clicked),
  // a sized footprint acts on ALL agents inside it. circle/ring → radius 0 = single;
  // rect → 1×1 = single; line is inherently a drawn segment (always Area — the
  // move+line single-agent case is a separate paint override). A small badge next to
  // the size input shows the current Single/Area state.
  const agentBrushScope: 'single' | 'area' =
    agentBrushShape === 'rect' ? (agentBrushW > 1 || agentBrushH > 1 ? 'area' : 'single')
    : agentBrushShape === 'line' ? 'area'
    : (agentBrushRadius > 0 ? 'area' : 'single');
  // The Single/Area indicator shown on the size row (replaces the old toggle). Only
  // one size row renders at a time, so this element appears once in the tree.
  const scopeBadge = (
    <span
      title={agentBrushScope === 'single'
        ? 'Zero size → acts on exactly ONE agent (nearest to the cursor). Increase the size for an Area brush.'
        : 'Sized footprint → acts on ALL agents inside it. Set the size to 0 for a Single-agent brush.'}
      style={{
        marginLeft: 'auto', padding: '1px 8px', borderRadius: 999, fontSize: '0.56rem',
        fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em',
        background: agentBrushScope === 'area' ? 'var(--color-accent-soft)' : 'var(--color-widget-border)',
        color: agentBrushScope === 'area' ? 'var(--color-accent)' : 'var(--color-text-muted)',
      }}
    >{agentBrushScope}</span>
  );
  // Layer toggles (req 1 + 7): independently SHOW (render) and SIMULATE (run the
  // step) the CA grid + the agents. Show toggles are render-only (2D + 3D);
  // Simulate toggles gate runStep / runAgentStep in the worker (setSimLayers).
  // Persisted; refs for the draw() / worker hot paths. Default true → no change.
  const [showCaGrid, setShowCaGrid] = useState<boolean>((saved.current.showCaGrid as boolean) ?? true);
  const [showAgents, setShowAgents] = useState<boolean>((saved.current.showAgents as boolean) ?? true);
  // Render the agent BOND lines (2D + 3D). Display-only — the bond springs keep
  // simulating. The Layers row only shows for models whose Bonds capability isn't
  // Off (resolveMaxBonds > 0), matching where bonds can exist at all.
  const [showBonds, setShowBonds] = useState<boolean>((saved.current.showBonds as boolean) ?? true);
  const [simulateCells, setSimulateCells] = useState<boolean>((saved.current.simulateCells as boolean) ?? true);
  const [simulateAgents, setSimulateAgents] = useState<boolean>((saved.current.simulateAgents as boolean) ?? true);
  const showCaGridRef = useRef(showCaGrid); showCaGridRef.current = showCaGrid;
  const showAgentsRef = useRef(showAgents); showAgentsRef.current = showAgents;
  const showBondsRef = useRef(showBonds); showBondsRef.current = showBonds;
  const simulateCellsRef = useRef(simulateCells); simulateCellsRef.current = simulateCells;
  const simulateAgentsRef = useRef(simulateAgents); simulateAgentsRef.current = simulateAgents;
  // Brush TARGET — does the LMB brush affect the CA grid or the agents? (Only
  // meaningful for an agent model; the toggle lives in the Agents panel.) Replaces
  // the old "Paint Field" agent-brush mode: 'grid' = the cell brush (Input Mapping
  // above) paints cells; 'agents' = the agent brush (seed/kill/move/…) acts on
  // agents. Persisted; a ref drives the pointer/cursor hot paths.
  const [brushTarget, setBrushTarget] = useState<'grid' | 'agents'>((saved.current.brushTarget as 'grid' | 'agents') ?? 'agents');
  const brushTargetRef = useRef(brushTarget); brushTargetRef.current = brushTarget;
  // 2D environment background — the fill behind the agents when the CA grid layer
  // is hidden (an agents-only view within the W×H world). `enabled` off = the
  // canvas stays transparent (page shows through). Persisted; a ref (hex or null)
  // drives the draw() hot path.
  const [bg2d, setBg2d] = useState<{ enabled: boolean; color: string }>(
    (saved.current.bg2d && typeof saved.current.bg2d === 'object')
      ? (saved.current.bg2d as { enabled: boolean; color: string })
      : { enabled: false, color: '#0c0d10' },
  );
  const bg2dRef = useRef<string | null>(null);
  useEffect(() => { bg2dRef.current = bg2d.enabled ? bg2d.color : null; }, [bg2d]);
  // Agent disc outlines (the dark contour stroke on circles with rad >= 2px;
  // in 3D a silhouette rim on the sphere impostors) — optional so dense
  // populations render as clean solid dots. Default OFF; an explicitly saved ON
  // is respected. Persisted; a ref drives the draw() hot path.
  const [agentOutlines, setAgentOutlines] = useState<boolean>(saved.current.agentOutlines === true);
  const agentOutlinesRef = useRef(agentOutlines); agentOutlinesRef.current = agentOutlines;
  // Hemifield / vision-cone display (the FOV sensing nodes — Get Agents In
  // View / Sense Hemifield): draw each node's cone for the INSPECTED agent or
  // ALL agents. Off default; persisted (declared ABOVE the persist effect —
  // the TDZ trap). A ref drives the draw() hot path; the UI-sync driver gains
  // a want-term while not Off (the cones read the agent snapshot, which
  // free-running direct-render models don't ship).
  const [showVision, setShowVision] = useState<'off' | 'inspected' | 'all'>(
    saved.current.showVision === 'all' ? 'all' : saved.current.showVision === 'inspected' ? 'inspected' : 'off',
  );
  const showVisionRef = useRef(showVision); showVisionRef.current = showVision;
  // PR3 — agent inspector: a single on-demand popover (one at a time).
  // Agent inspectors — the agent-layer twin of the cell inspect popovers:
  // MULTIPLE pinned popovers (draggable, each closable, with Close all) plus one
  // TRANSIENT sweep popover that opens on press and follows the drag. A release
  // that never re-targeted a different agent PINS the sweep; a sweep across
  // other agents discards it (the cell inspector's !moved rule). Both the 2D and
  // the 3D pick paths feed the same state, so the feature is dimension- and
  // compile-target-agnostic (the data comes from the `getAgentState` message,
  // which the worker answers identically on JS/WASM/WebGPU).
  const [agentPopovers, setAgentPopovers] = useState<AgentPopoverState[]>([]);
  const [agentSweepPopover, setAgentSweepPopover] = useState<AgentPopoverState | null>(null);
  const [focusedAgentPopoverId, setFocusedAgentPopoverId] = useState<number | null>(null);
  // Latest worker state per inspected agent id (+ a version bump to re-render).
  const agentStatesRef = useRef<Map<number, AgentStateResponse>>(new Map());
  const [, bumpAgentStateVersion] = useState(0);

  // FOLLOW MODE — the camera tracks ONE inspected agent (2D and 3D). Armed from
  // the ◎ toggle in a PINNED inspector's header, so follow can never be active
  // with zero popovers open; that means the existing agent UI-sync want-term
  // (`agentInspectIds.length > 0`) already keeps render snapshots flowing for
  // free-running direct-render models — follow needs no want-term of its own.
  // Not persisted (a camera behaviour, like auto-orbit / auto-zoom).
  //
  // The ref LEADS the state (the same rule openAgentInspector documents): the
  // pointer handlers that CANCEL follow on a manual pan/orbit run inside a
  // gesture, long before any re-render.
  const [followAgentId, setFollowAgentIdState] = useState<number | null>(null);
  const followAgentIdRef = useRef<number | null>(null);
  // Controller state (see the FOLLOW MODE effect): the camera's own velocity, the
  // EMA-filtered agent velocity, and the previous agent position the raw velocity
  // is derived from. Refs (not effect locals) so the DEV hook can observe them.
  const followCamVRef = useRef<[number, number, number]>([0, 0, 0]);
  const followAgentVRef = useRef<[number, number, number]>([0, 0, 0]);
  const followPrevPosRef = useRef<[number, number, number] | null>(null);
  const setFollowAgent = useCallback((id: number | null) => {
    if (followAgentIdRef.current === id) return;
    followAgentIdRef.current = id;
    // A different agent (or none) means the controller's history is meaningless.
    followCamVRef.current = [0, 0, 0];
    followAgentVRef.current = [0, 0, 0];
    followPrevPosRef.current = null;
    setFollowAgentIdState(id);
  }, []);
  /** A manual camera gesture (2D pan / autoscroll, 3D orbit / pan, Reset view)
   *  cancels follow — least surprise: the user just took the wheel. ZOOM does
   *  NOT cancel (zooming while following is the point). */
  const cancelFollow = useCallback(() => setFollowAgent(null), [setFollowAgent]);
  // Ref mirror so the 3D pointer effect (a big, deliberately stable dep array)
  // can cancel without being re-registered.
  const cancelFollowRef = useRef(cancelFollow);
  cancelFollowRef.current = cancelFollow;

  // GIF / WebM recording state
  const [recording, setRecording] = useState(false);
  const recordingRef = useRef(false);
  const recordedFrames = useRef<ImageData[]>([]);
  // Dedicated CPU-backed scratch canvas for capturing recording frames. Capturing
  // via getImageData DIRECTLY on a LIVE canvas — the visible display canvas (agent
  // overlay path) OR the srcCanvas blit source (non-agent fallback) — de-optimizes
  // that canvas out of GPU acceleration (the willReadFrequently penalty), so its
  // drawing stays ~6x slower even AFTER recording stops (measured). Instead we
  // drawImage the live canvas onto this scratch (a texture READ that does NOT
  // de-optimize the source) and getImageData the scratch (cheap on a
  // willReadFrequently canvas). The agent path also downscales to bound memory (the
  // display canvas is window-sized; dozens of full-res frames thrash GC). The
  // primary non-agent path avoids the scratch entirely — it builds the frame from
  // the worker's colors buffer (colorsRef), reading no canvas at all. Reused across
  // frames; resized only when the target size changes.
  const recordScratchRef = useRef<HTMLCanvasElement | null>(null);
  const [recordFrameCount, setRecordFrameCount] = useState(0);
  // The displayed counter is throttled (~5 Hz); the captured-frames count is
  // tracked exactly via the ref. setState every step caused a SimulatorView
  // re-render per captured frame and slowed down the recording itself.
  const recordCountRef = useRef(0);
  const lastRecordCountSet = useRef(0);
  // WebM is the default; falls back to GIF in browsers without WebCodecs.
  const webmAvailable = isWebMSupported();
  type RecordFormat = 'gif' | 'webm';
  const [recordFormat, setRecordFormat] = useState<RecordFormat>(() => {
    const saved2 = saved.current.recordFormat as RecordFormat | undefined;
    if (saved2 === 'gif') return 'gif';
    return webmAvailable ? 'webm' : 'gif';
  });
  // Capture scope: "simulation" crops the recording to the drawn world rectangle
  // (no letterbox margins — the area of interest); "view" records the whole
  // display canvas exactly as shown (with margins / pan / zoom). Applies uniformly
  // to every model type + compile target (2D grid, grid+agents, agents-only, 3D).
  type RecordScope = 'view' | 'simulation';
  const [recordScope, setRecordScope] = useState<RecordScope>(() =>
    (saved.current.recordScope as RecordScope | undefined) === 'view' ? 'view' : 'simulation');
  const recordScopeRef = useRef<RecordScope>(recordScope);
  useEffect(() => { recordScopeRef.current = recordScope; }, [recordScope]);
  // Screenshot shares the same scope dilemma as recording — "simulation" crops to
  // the drawn world rectangle, "view" is the whole canvas as shown. Separate
  // preference from the recording scope (persisted independently).
  const [screenshotScope, setScreenshotScope] = useState<RecordScope>(() =>
    (saved.current.screenshotScope as RecordScope | undefined) === 'view' ? 'view' : 'simulation');
  const screenshotScopeRef = useRef<RecordScope>(screenshotScope);
  useEffect(() => { screenshotScopeRef.current = screenshotScope; }, [screenshotScope]);
  // "current view" scope: the OUTPUT dims are locked at the first captured frame (the
  // encoder needs a constant frame size) so a panel resize mid-record can't change them.
  // The "simulation" scope uses renderSimulationFrame (deterministic grid-aspect dims),
  // so it needs no lock.
  const recordCropRef = useRef<{ outW: number; outH: number } | null>(null);
  // Dimension lock for the recording, shared by BOTH the streaming and the
  // buffered path. Previously the guard was `recordedFrames.current[0]`, which
  // is empty while streaming — so the lock has to live in its own ref.
  const recordDimsRef = useRef<{ w: number; h: number } | null>(null);
  // ── Streaming WebM (encode-as-you-go) ───────────────────────────────────────
  // Instead of retaining every captured frame as raw RGBA (2.9-33 MB EACH, OOM
  // after ~1 min of 2D / <15 s of 3D at HiDPI — see
  // docs/INVESTIGATION_STREAMING_RECORDING.md), a WebM recording feeds each frame
  // to the VideoEncoder as it is captured and only the COMPRESSED bytes
  // accumulate. GIF still buffers raw frames (gifenc needs the pixels to build a
  // palette per frame), and any failure to bring the streaming encoder up falls
  // back to the historical buffered path.
  const recordStreamModeRef = useRef(false);
  const webmStreamRef = useRef<WebMStreamEncoder | null>(null);
  const webmStreamStateRef = useRef<'idle' | 'creating' | 'ready' | 'failed'>('idle');
  // Frames captured while `WebMStreamEncoder.create` (an async isConfigSupported
  // probe) is in flight — typically 1-3. Bounded: past the cap we drop rather
  // than reintroduce unbounded raw buffering through the back door.
  const webmStreamPendingRef = useRef<ImageData[]>([]);
  const recordDroppedRef = useRef(0);
  const [recordDroppedCount, setRecordDroppedCount] = useState(0);
  /** How long the LOSSLESS step throttle may wait on the encoder before deciding
   *  it is wedged rather than merely slow, degrading to dropping and saying so.
   *  An order of magnitude past the worst measured per-frame encode (~800 ms on
   *  dense content), so it can only fire on a genuine stall — never on
   *  legitimate backpressure, which is what the mode exists to absorb. */
  const LOSSLESS_STALL_MS = 8000;
  const [encodingWebM, setEncodingWebM] = useState(false);
  useEffect(() => { recordingRef.current = recording; }, [recording]);

  // ── Recording quality (keyframe cadence) ────────────────────────────────────
  // 'standard' = a keyframe every 30 frames: MEASURED 3.5x smaller and 1.8x
  // faster to encode than all-intra, so the simulation also runs closer to full
  // speed while recording. 'archival' = the historical all-intra, where every
  // frame decodes independently (frame-by-frame analysis, scrub-exact, and no
  // interframe prediction bleeding across previously-stable CA regions).
  const [recordQuality, setRecordQuality] = useState<RecordQuality>(() =>
    (saved.current.recordQuality as RecordQuality | undefined) === 'archival' ? 'archival' : DEFAULT_RECORD_QUALITY);
  const recordQualityRef = useRef<RecordQuality>(recordQuality);
  useEffect(() => { recordQualityRef.current = recordQuality; }, [recordQuality]);

  // ── Overload policy: what gives when the encoder cannot keep up ──────────────
  // 'drop' (default, the historical behaviour) — the encoder refuses a frame and
  // the simulation keeps its speed; skips are counted next to REC.
  // 'lossless' — every captured frame is encoded and the STEP PIPELINE is held
  // back until the encoder drains, so the run gets slower and the video loses
  // nothing. `draw()` is synchronous and cannot await the encoder, which is
  // exactly why the throttle lives in the (already asynchronous) step chain.
  type RecordOverload = 'drop' | 'lossless';
  const [recordOverload, setRecordOverload] = useState<RecordOverload>(() =>
    (saved.current.recordOverload as RecordOverload | undefined) === 'lossless' ? 'lossless' : 'drop');
  const recordOverloadRef = useRef<RecordOverload>(recordOverload);
  useEffect(() => { recordOverloadRef.current = recordOverload; }, [recordOverload]);
  /** The policy in force for THIS run — locked at Start (like format/scope/quality)
   *  and the only thing the throttle and the capture site consult. Degrades to
   *  'drop' if the encoder ever stalls past LOSSLESS_STALL_MS. */
  const recordOverloadActiveRef = useRef<RecordOverload>('drop');
  /** When the step loop began waiting on the encoder (null = not waiting). */
  const losslessWaitStartRef = useRef<number | null>(null);
  /** True while the step loop is being held back — surfaced in the REC readout
   *  so a deliberately slowed simulation never reads as a hang. */
  const [recordThrottled, setRecordThrottled] = useState(false);
  const recordThrottledRef = useRef(false);
  const setRecordThrottledIfChanged = (v: boolean) => {
    if (recordThrottledRef.current === v) return;
    recordThrottledRef.current = v;
    setRecordThrottled(v);
  };

  /** Dispose of one finished capture frame: hand it to the streaming WebM
   *  encoder when one is (or can be) live, else retain it the historical way.
   *  Reads only refs, so it is safe to call from the worker message handler.
   *  Every exit path accounts for the frame exactly once (encoded / dropped /
   *  buffered) so the transport counters stay honest. */
  const acceptRecordedFrame = (frame: ImageData) => {
    if (recordStreamModeRef.current) {
      // LOSSLESS: submit unconditionally. The step pipeline is what waits (see
      // the rAF tick in the `stepped` handler), so the encoder queue is still
      // bounded — the frame is simply never the thing that gets sacrificed.
      const force = recordOverloadActiveRef.current === 'lossless';
      const enc = webmStreamRef.current;
      if (enc) {
        if (enc.addFrame(frame, force)) recordCountRef.current += 1;
        else recordDroppedRef.current += 1;
        return;
      }
      if (webmStreamStateRef.current === 'creating') {
        // The async codec probe is still in flight (typically 1-3 frames' worth).
        if (webmStreamPendingRef.current.length < WEBM_STREAM_PENDING_MAX) webmStreamPendingRef.current.push(frame);
        else recordDroppedRef.current += 1;
        return;
      }
      if (webmStreamStateRef.current === 'idle') {
        // First frame: its dimensions are what the encoder must be configured
        // for, so the encoder can only be built now. fps is LOCKED here (the
        // encoder needs it at configure time); previously it was read at Stop,
        // which silently retimed the whole file if the slider moved mid-record.
        webmStreamStateRef.current = 'creating';
        webmStreamPendingRef.current = [frame];
        WebMStreamEncoder.create(
          frame.width, frame.height, targetFpsRef.current || 30, recordQualityRef.current,
        ).then(enc => {
          if (!recordingRef.current || !recordStreamModeRef.current) { enc.cancel(); return; }
          webmStreamRef.current = enc;
          webmStreamStateRef.current = 'ready';
          for (const f of webmStreamPendingRef.current) {
            if (enc.addFrame(f, force)) recordCountRef.current += 1;
            else recordDroppedRef.current += 1;
          }
          webmStreamPendingRef.current = [];
        }).catch(err => {
          // No usable VP9 configuration (e.g. an uncapped 3D buffer above the
          // encoder's max dimensions). Degrade to the historical buffered path
          // rather than losing the recording.
          console.warn('[recording] streaming WebM unavailable, buffering frames instead', err);
          webmStreamStateRef.current = 'failed';
          recordStreamModeRef.current = false;
          for (const f of webmStreamPendingRef.current) { recordedFrames.current.push(f); recordCountRef.current += 1; }
          webmStreamPendingRef.current = [];
        });
        return;
      }
      // 'failed' — fall through to the buffered path below.
    }
    recordedFrames.current.push(frame);
    recordCountRef.current += 1;
  };

  // Persist simulator settings
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(SIM_SETTINGS_KEY, JSON.stringify({
          targetFps, unlimitedFps, gensPerFrame, unlimitedGens,
          activeViewer, brushColor, brushW, brushH, brushMapping, showBrushCursor, showGridlines, show2dAxes,
          brushShape, brushRadius, brushRingWidth, brushLineWidth, brush3dVolume, brushBoxDepth,
          infinityCanvas, indicatorVizModes, recordFormat, recordScope, recordQuality, recordOverload, screenshotScope, brushSectionH, agentsFront3d,
          light3d, cellGaps3d, agentMetaballs, agentGlow,
          agentBrushRadius, agentSeedDensity, agentSeedSpacing,
          agentBrushShape, agentBrushW, agentBrushH, agentBrushRingWidth, agentBrushLineWidth,
          showCaGrid, showAgents, showBonds, simulateCells, simulateAgents, brushTarget, bg2d, agentOutlines, showVision,
          indicatorHiddenCategories: Object.fromEntries(
            Object.entries(indicatorHiddenCategories)
              .filter(([, s]) => s.size > 0)
              .map(([id, s]) => [id, [...s]]),
          ),
          indicatorChartOverrides,
          glyphMinPx: glyphMinPxRef.current,
        }));
      } catch { /* localStorage full */ }
    }, 300);
    return () => clearTimeout(timer);
  }, [targetFps, unlimitedFps, gensPerFrame, unlimitedGens, activeViewer, brushColor, brushW, brushH, brushMapping, showBrushCursor, showGridlines, show2dAxes, brushShape, brushRadius, brushRingWidth, brushLineWidth, brush3dVolume, brushBoxDepth, infinityCanvas, indicatorVizModes, recordFormat, recordScope, recordQuality, recordOverload, screenshotScope, brushSectionH, agentsFront3d, light3d, cellGaps3d, agentMetaballs, agentGlow, agentBrushRadius, agentSeedDensity, agentSeedSpacing, agentBrushShape, agentBrushW, agentBrushH, agentBrushRingWidth, agentBrushLineWidth, showCaGrid, showAgents, showBonds, simulateCells, simulateAgents, brushTarget, bg2d, agentOutlines, showVision, indicatorHiddenCategories, indicatorChartOverrides]);

  // Manual Brush — signature-keyed merge effect. Re-derives `manualBrush`
  // whenever the cell attribute set (id+type) changes. Surviving attrs carry
  // their stored entry; new attrs seed `{enabled: true, value: defaultValue}`;
  // type-changed attrs reset to defaults. The signature key (not the model
  // object identity) means live name/description edits in the Modeler don't
  // wipe brush state mid-edit.
  const cellAttrSig = useMemo(
    () => model.attributes.filter(a => !a.isModelAttribute).map(a => a.id + ':' + a.type).join('|'),
    [model.attributes],
  );
  // AGENT attribute signature — the seed-config panel edits model.agentAttributes
  // (a separate id-space), so its merge effect must key off THIS, not cellAttrSig.
  const agentAttrSig = useMemo(
    () => (model.agentAttributes ?? []).map(a => a.id + ':' + a.type).join('|'),
    [model.agentAttributes],
  );

  // Stable design-time series order per indicator — charts key their palette
  // indices off this so Track Categories filtering never recolors survivors.
  const indicatorCategoryOrders = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const ind of model.indicators || []) out[ind.id] = designTimeSeriesKeys(ind, model);
    return out;
  }, [model]);
  const manualBrushModelKey = model.properties.name;
  useEffect(() => {
    const stored = loadManualBrush(manualBrushModelKey) ?? {};
    const cellAttrs = model.attributes.filter(a => !a.isModelAttribute);
    const next: ManualBrushModelState = {};
    for (const a of cellAttrs) {
      const prev = stored[a.id];
      // Defensive: skip attribute types we have no widget for (cell attrs are
      // bool/integer/float/tag/neighborIndex today — color/interactionTable are
      // model-only).
      if (a.type === 'color' || a.type === 'lookupTable') continue;
      next[a.id] = prev
        ? { enabled: !!prev.enabled, value: typeof prev.value === 'string' ? prev.value : (a.defaultValue ?? '') }
        : { enabled: true, value: a.defaultValue ?? '' };
    }
    setManualBrush(next);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manualBrushModelKey, cellAttrSig]);

  // Manual Brush — debounced persistence (per-model, separate localStorage entry).
  useEffect(() => {
    const t = setTimeout(() => saveManualBrush(manualBrushModelKey, manualBrush), 300);
    return () => clearTimeout(t);
  }, [manualBrushModelKey, manualBrush]);

  // Agent seed config — same signature-keyed merge + persistence as Manual
  // Brush. Default `enabled: false` so seeding uses the engine attribute
  // defaults unless the user explicitly opts a row in.
  useEffect(() => {
    const stored = loadAgentSeed(manualBrushModelKey) ?? {};
    // AGENT attributes (the seed panel edits model.agentAttributes) — iterating
    // the CELL list here discarded every persisted agent-keyed entry on mount
    // (seed config never survived a reload) and wiped in-session edits whenever
    // a cell attribute changed.
    const agentAttrs = model.agentAttributes ?? [];
    const next: ManualBrushModelState = {};
    for (const a of agentAttrs) {
      if (a.type === 'color' || a.type === 'lookupTable') continue;
      const prev = stored[a.id];
      next[a.id] = prev
        ? { enabled: !!prev.enabled, value: typeof prev.value === 'string' ? prev.value : (a.defaultValue ?? '') }
        : { enabled: false, value: a.defaultValue ?? '' };
    }
    setAgentSeedAttrs(next);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manualBrushModelKey, agentAttrSig]);
  useEffect(() => {
    const t = setTimeout(() => saveAgentSeed(manualBrushModelKey, agentSeedAttrs), 300);
    return () => clearTimeout(t);
  }, [manualBrushModelKey, agentSeedAttrs]);

  // Agent Edit brush — same signature-keyed merge + persistence as the seed config,
  // over the agent attributes PLUS the synthetic geometry rows (radius / velocity /
  // position). All rows default disabled (opt-in overwrite).
  useEffect(() => {
    const stored = loadAgentEdit(manualBrushModelKey) ?? {};
    const dr = cbNum(model.centerBased, 'defaultRadius');
    const next: ManualBrushModelState = {};
    for (const a of (model.agentAttributes ?? [])) {
      if (a.type === 'color' || a.type === 'lookupTable') continue;
      const prev = stored[a.id];
      next[a.id] = prev
        ? { enabled: !!prev.enabled, value: typeof prev.value === 'string' ? prev.value : (a.defaultValue ?? '') }
        : { enabled: false, value: a.defaultValue ?? '' };
    }
    for (const g of AGENT_GEOM_ATTR_SPECS) {
      const def = g.id === GEOM_RADIUS ? String(dr) : '0';
      const prev = stored[g.id];
      next[g.id] = prev
        ? { enabled: !!prev.enabled, value: typeof prev.value === 'string' ? prev.value : def }
        : { enabled: false, value: def };
    }
    setAgentEditAttrs(next);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manualBrushModelKey, agentAttrSig]);
  useEffect(() => {
    const t = setTimeout(() => saveAgentEdit(manualBrushModelKey, agentEditAttrs), 300);
    return () => clearTimeout(t);
  }, [manualBrushModelKey, agentEditAttrs]);

  // Agent inspector — low-Hz live refresh while any popover is open (re-request
  // getAgentState at ~3 Hz, NOT per-stepped, so multiple-popover round-trips
  // don't compound — per §3 gotcha #7). One interval for ALL open ids (pinned +
  // the transient sweep); the dispatch routes each response into the id-keyed
  // agentStatesRef via onAgentStateRef.
  const agentInspectIds = useMemo(() => {
    const ids = agentPopovers.map(p => p.id);
    const s = agentSweepPopover?.id;
    return s != null && !ids.includes(s) ? [...ids, s] : ids;
  }, [agentPopovers, agentSweepPopover]);
  const agentInspectIdsRef = useRef<number[]>([]);
  agentInspectIdsRef.current = agentInspectIds;
  useEffect(() => {
    if (agentInspectIds.length === 0) return;
    const poll = setInterval(() => {
      for (const id of agentInspectIds) workerRef.current?.postMessage({ type: 'getAgentState', id });
    }, 333);
    return () => clearInterval(poll);
  }, [agentInspectIds]);
  // Drop cached state for agents whose popover just closed.
  useEffect(() => {
    const live = new Set(agentInspectIds);
    for (const k of Array.from(agentStatesRef.current.keys())) {
      if (!live.has(k)) agentStatesRef.current.delete(k);
    }
  }, [agentInspectIds]);
  // FOLLOW MODE ends with its popover: closing it (× / Close all / Esc / the
  // model-load close-all) drops the id from the PINNED list, so follow stops.
  // Keyed on agentPopovers, not agentInspectIds — the transient sweep never owns
  // a follow (its inspector renders no toggle).
  useEffect(() => {
    const id = followAgentIdRef.current;
    if (id != null && !agentPopovers.some(p => p.id === id)) setFollowAgent(null);
  }, [agentPopovers, setFollowAgent]);

  const cycleIndicatorVizMode = useCallback((id: string) => {
    setIndicatorVizModes(prev => {
      const cur = prev[id] ?? 'bars';
      const next: VizMode = cur === 'bars' ? 'multiline' : cur === 'multiline' ? 'stacked' : 'bars';
      return { ...prev, [id]: next };
    });
  }, []);

  // Direct set (the spatial chart's Lines ⇄ Bars toggle — a 2-state flip).
  const setIndicatorVizMode = useCallback((id: string, mode: VizMode) => {
    setIndicatorVizModes(prev => ({ ...prev, [id]: mode }));
  }, []);

  const toggleIndicatorCategory = useCallback((id: string, category: string) => {
    setIndicatorHiddenCategories(prev => {
      const next = { ...prev };
      const set = new Set(next[id] ?? []);
      if (set.has(category)) set.delete(category); else set.add(category);
      if (set.size === 0) delete next[id]; else next[id] = set;
      return next;
    });
  }, []);

  const changeIndicatorChartOverrides = useCallback((id: string, next: IndicatorChartSettings | null) => {
    setIndicatorChartOverrides(prev => {
      const out = { ...prev };
      if (next === null) delete out[id]; else out[id] = next;
      return out;
    });
  }, []);

  // Clear an indicator's accumulated time-series chart history so the user can
  // start monitoring afresh. History lives in a ref (no auto re-render), so bump
  // a dummy state to repaint the display with the now-empty history.
  const [, bumpIndicatorRender] = useReducer((x: number) => x + 1, 0);
  const clearIndicatorHistory = useCallback((id: string) => {
    delete indicatorHistoryRef.current[id];
    bumpIndicatorRender();
  }, []);

  // Adaptive stored-history cap: grows to the largest configured chart window so
  // a window larger than the default 500 truly shows that many generations
  // (bounded by INDICATOR_HISTORY_HARD_CAP). Recomputed when the indicator set or
  // the simulator overrides change.
  const indicatorHistoryCapRef = useRef(INDICATOR_HISTORY_DEFAULT_CAP);
  useEffect(() => {
    let cap = INDICATOR_HISTORY_DEFAULT_CAP;
    for (const ind of model.indicators || []) {
      const w = historyWindow(mergeChartSettings(ind.chartSettings, indicatorChartOverrides[ind.id]));
      if (w !== undefined && w > cap) cap = Math.min(w, INDICATOR_HISTORY_HARD_CAP);
    }
    indicatorHistoryCapRef.current = cap;
  }, [model.indicators, indicatorChartOverrides]);

  // F3: Runtime model attribute values
  const [runtimeModelAttrs, setRuntimeModelAttrs] = useState<Record<string, number>>({});
  // Render-phase mirror so non-React consumers (the OverseerRuntime) can
  // snapshot the live values without a stale closure.
  const runtimeModelAttrsLatest = useRef(runtimeModelAttrs);
  runtimeModelAttrsLatest.current = runtimeModelAttrs;

  // ------------------------------------------------------------------
  // Overseer (experiment orchestration). Everything here is gated on
  // model.overseerConfig?.enabled — with the feature off, no panel renders, no
  // graph compiles, and the runtime is never created.
  // ------------------------------------------------------------------
  const overseerEnabled = !!model.overseerConfig?.enabled;
  const overseerCompiled = useMemo(() => {
    if (!overseerEnabled) return { driverCode: null as string | null, error: null as string | null };
    return compileOverseerGraph(model.overseerGraphNodes ?? [], model.overseerGraphEdges ?? [], model);
  }, [model, overseerEnabled]);
  const overseerRuntimeRef = useRef<OverseerRuntime | null>(null);
  const [overseerRunning, setOverseerRunning] = useState(false);
  const overseerRunningRef = useRef(false);
  const [overseerVersion, bumpOverseerVersion] = useReducer((v: number) => v + 1, 0);

  /** Abort a running experiment (no-op otherwise). Called on Abort, any worker
   *  reinit / recompile / model change, and unmount — the runtime journals the
   *  reason and the driver returns within one batch. */
  const abortExperiment = useCallback((reason?: string) => {
    if (overseerRunningRef.current) overseerRuntimeRef.current?.abort(reason);
  }, []);

  const handleRunExperiment = () => {
    if (overseerRunningRef.current || !overseerCompiled.driverCode || !workerRef.current) return;
    setPlaying(false);
    const rt = new OverseerRuntime({
      getWorker: () => workerRef.current,
      getActiveViewer: () => activeViewerRef.current,
      evalEndConditions: (gen, ind) => evalEndConditions(gen, ind),
      setModelAttr: (attrId, value) => handleModelAttrChange(attrId, value),
      randomizeTable: (tableId, seed, density) => {
        const attr = model.attributes.find(a => a.id === tableId && a.isModelAttribute && a.type === 'lookupTable');
        if (!attr) return;
        // Value policy mirrors the editor's Randomize: tag → uniform over the
        // stored [tableRoll.min, len−1] option indices (min absent ⇒ 1),
        // integer → uniform over [tableRoll.min ?? 1, tableRoll.max] (the
        // attribute's stored range), bool → 1, float → uniform over the stored
        // [tableRoll.rangeMin, rangeMax) range (absent ⇒ the historical (0,1)).
        const valueType = attr.valueType ?? 'float';
        const valueCount = valueType === 'tag'
          ? Math.max(1, resolveValueTagOptions(attr, model).length - 1)
          : valueType === 'integer' ? Math.floor(attr.tableRoll?.max ?? 1)
          : 1;
        const floatRange = valueType === 'float'
          ? { rangeMin: attr.tableRoll?.rangeMin, rangeMax: attr.tableRoll?.rangeMax }
          : (valueType === 'integer' || valueType === 'tag')
            ? { intMin: attr.tableRoll?.min }
            : {};
        if (isMultiAxisTable(attr)) {
          const r = resolveAxes(attr, model);
          const data = randomFillTableData(r.total, seed, density, { valueType, valueCount, ...floatRange });
          // Runtime-only (like a slider): post to the worker, do NOT updateAttribute.
          workerRef.current?.postMessage({
            type: 'updateLookupTable', attrId: tableId,
            rowLabels: [], colLabels: [], values: {}, dims: r.dims, data,
          });
        } else {
          const rowLabels = resolveKeyLabels(attr.rowKeySource, model);
          const colLabels = resolveKeyLabels(attr.colKeySource, model);
          const flat = randomFillTableData(rowLabels.length * colLabels.length, seed, density, { valueType, valueCount, ...floatRange });
          const values: Record<string, Record<string, number>> = {};
          rowLabels.forEach((rl, i) => {
            const row: Record<string, number> = {};
            colLabels.forEach((cl, j) => { const v = flat[i * colLabels.length + j]!; if (v !== 0) row[cl] = v; });
            values[rl] = row;
          });
          workerRef.current?.postMessage({ type: 'updateLookupTable', attrId: tableId, rowLabels, colLabels, values });
        }
      },
      loadPresetLive: (presetId: string) => {
        const p = (model.presets ?? []).find(x => x.id === presetId);
        if (!p) return 'not-found' as const;
        // Structural predicate — mirrors handleLoadPreset / applySimulationState:
        // a preset that changes dims/boundary forces a worker reinit, which is
        // not supported mid-experiment (v1) — the runtime journals + skips it.
        const s = p.state;
        const hasGrid = s.width != null && s.height != null && s.attributes != null && s.colors != null;
        // Mirrors applySimulationState: grid-less presets never adapt dims/boundary.
        const boundaryChanged = hasGrid && !!s.boundaryTreatment && s.boundaryTreatment !== model.properties.boundaryTreatment;
        const sD = s.gridDepth ?? s.depth ?? 1;
        const dimsFromState = !hasGrid ? null
          : s.gridWidth != null && s.gridHeight != null
            ? { w: s.gridWidth, h: s.gridHeight, d: sD }
            : { w: s.width!, h: s.height!, d: sD };
        const dimsChanged = dimsFromState != null
          && (dimsFromState.w !== gridWidth.current || dimsFromState.h !== gridHeight.current || dimsFromState.d !== gridDepth.current);
        if (boundaryChanged || dimsChanged) return 'needs-reinit' as const;
        applySimulationState(p.state, { adaptDims: true });
        return 'ok' as const;
      },
      screenshot: () => handleScreenshot(),
      startRecording: () => startRecording(),
      stopRecording: () => stopRecording(),
      modelAttrsSnapshot: () => ({ ...runtimeModelAttrsLatest.current }),
      seedPolicy: model.overseerConfig?.seedPolicy ?? 'none',
      baseSeed: model.overseerConfig?.baseSeed ?? 12345,
      onUpdate: () => bumpOverseerVersion(),
      onFinished: () => {
        overseerRunningRef.current = false;
        setOverseerRunning(false);
        bumpOverseerVersion();
      },
    });
    overseerRuntimeRef.current = rt;
    overseerRunningRef.current = true;
    setOverseerRunning(true);
    bumpOverseerVersion();
    rt.start(overseerCompiled.driverCode);
  };

  // F3b: Interaction-table defaults snapshot — captured the first time we see
  // a given `modelVersion` (= a fresh LOAD_MODEL / NEW_MODEL). Used by Reset
  // to Default to restore the table values to whatever was last loaded (live
  // edits via the simulator's per-cell editor mutate `model.attributes` via
  // updateAttribute, so a plain re-read of `model.attributes` wouldn't be
  // "default" anymore). Per-cell edits don't bump modelVersion (only
  // load/new do), so the snapshot survives table edits within a session.
  const interactionTableDefaultsRef = useRef<Record<string, { tableValues?: Record<string, Record<string, number>>; tableData?: number[] }>>({});
  const lastSnapshottedVersionRef = useRef<number>(-1);

  // F5: Simulator dimension overrides
  const [simWidth, setSimWidth] = useState(100);
  const [simHeight, setSimHeight] = useState(100);
  const [simDepth, setSimDepth] = useState(1);  // 3D Grid CA: resize-panel depth

  // F6: Image import pending state
  const pendingImageImport = useRef<Uint8ClampedArray | null>(null);
  const pendingImageMapping = useRef<string>('');
  const imageInputRef = useRef<HTMLInputElement>(null);
  // "Mapping Cells" dialog — the loaded source image being mapped (null = closed).
  const [imageMapImg, setImageMapImg] = useState<HTMLImageElement | null>(null);
  // Resize-mode + manual mapping: paint these masked cells after the worker
  // reinitialises to the new grid dims (mirrors pendingImageImport).
  const pendingManualImport = useRef<{ cells: Array<{ row: number; col: number }>; sets: Array<{ attrId: string; value: number }> } | null>(null);
  // "Import CSV" dialog — the loaded file's raw text (null = closed).
  const [csvImport, setCsvImport] = useState<{ text: string; name: string } | null>(null);
  const csvInputRef = useRef<HTMLInputElement>(null);
  // Grid CSV import with "Resize": apply the value block once the worker has
  // reinitialised to the new dims (mirrors pendingImageImport / pendingManualImport).
  const pendingGridValuesImport = useRef<{ attrId: string; width: number; height: number; layer: number; values: Float64Array } | null>(null);

  // Save/Load state refs
  const pendingStateSave = useRef<((state: Record<string, unknown>) => void) | null>(null);
  const stateFileInputRef = useRef<HTMLInputElement>(null);
  const pendingSimStateRestore = useRef<SimulationState | null>(null);

  // Preset-save dialog
  const [presetDialogOpen, setPresetDialogOpen] = useState(false);
  const [presetOverwriteTarget, setPresetOverwriteTarget] = useState<Preset | null>(null);
  // Per-action confirmation modals — delete / overwrite. Carry the target preset
  // so the deferred onConfirm doesn't need to recapture it through a closure.
  const [presetToDelete, setPresetToDelete] = useState<Preset | null>(null);
  const [presetToOverwrite, setPresetToOverwrite] = useState<Preset | null>(null);
  // Rename dialog target — reuses PresetSaveDialog in its metadata-only
  // (hideGridOption) mode; confirming dispatches updatePreset({name, description})
  // WITHOUT touching the preset's embedded state.
  const [presetToRename, setPresetToRename] = useState<Preset | null>(null);
  // Per-row "…" actions menu (Overwrite / Rename / Duplicate / Export / Delete).
  // One open at a time; `x`/`y` are viewport coords measured from the trigger
  // (the menu renders position:fixed so the scrolling panel can't clip it).
  const [presetMenu, setPresetMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const presetMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!presetMenu) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as globalThis.Node;
      if (presetMenuRef.current && !presetMenuRef.current.contains(t)) setPresetMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setPresetMenu(null); }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [presetMenu]);

  // Clipboard for Ctrl+C / Ctrl+V / Ctrl+X (cell-attribute region copy). The
  // region is always read as a rectangle (the brush footprint's bounding box),
  // but `mask` (the brush SHAPE within that box) restricts which cells paste
  // writes — so a circle/ring brush copies & pastes its shape, not a square.
  // `hotR`/`hotC` = the cursor's position within the box, so paste re-centres
  // on the cursor exactly the way copy did. Absent mask/hot = full rectangle.
  const clipboardRef = useRef<{
    w: number;
    h: number;
    attributes: Record<string, { type: string; buffer: ArrayBuffer }>;
    mask?: Uint8Array;
    hotR?: number;
    hotC?: number;
  } | null>(null);
  // Mask + hotspot captured at copy/cut time, attached to the clipboard when
  // the worker's regionData (rectangular read) comes back.
  const pendingCopyMeta = useRef<{ mask: Uint8Array; hotR: number; hotC: number } | null>(null);
  // If set, the next regionData response should also fire a clearRegion for the
  // source (Ctrl+X). Carries the same shape mask so the cut removes only the shape.
  const pendingCutRect = useRef<{ row: number; col: number; w: number; h: number; mask?: Uint8Array } | null>(null);

  // Colors buffer + grid dimensions
  const colorsRef = useRef<Uint8ClampedArray | null>(null);
  // Per-cell glyph overlay buffers (worker ships them only when the model uses
  // Set Cell Looks in glyph mode AND any cell has a non-zero glyph). null
  // otherwise — the overlay path short-circuits in that case.
  const glyphCodesRef = useRef<Uint32Array | null>(null);
  const glyphColorsRef = useRef<Uint32Array | null>(null);
  const gridWidth = useRef(0);
  const gridHeight = useRef(0);
  // 3D Grid CA: layer count, kept in lockstep with gridWidth/gridHeight at every
  // assignment site. 1 → 2D.
  const gridDepth = useRef(1);
  // 3D Grid CA: WebGL2 voxel renderer state. `is3D` drives the render path; the
  // GL renderer + camera/clip/alpha are read via refs (draw() is useCallback([])).
  const is3D = (model.properties.dimension ?? '2d') === '3d';
  const is3dRef = useRef(is3D);
  is3dRef.current = is3D;
  // Edit brush panel rows = the agent attributes (widget-capable) + the synthetic
  // geometry rows (Radius / Velocity / Position; Z rows only in 3D). Cast as
  // Attribute so ManualBrushPanel renders each as a type-appropriate widget.
  const agentEditPanelAttrs = useMemo<Attribute[]>(() => {
    const dr = cbNum(model.centerBased, 'defaultRadius');
    // Agent Capability Profiles: filter the synthetic geometry rows to the enabled
    // capabilities — Radius only with Body, Velocity only with a moving Motion mode
    // (Position is always shown). Position/velocity/radius are always ALLOCATED in
    // v1, so this is a UI-clarity filter (matches the palette / port gating).
    const prof = model.topologyMode?.agents ? resolveAgentProfile(model) : null;
    const showRadius = !prof || prof.body;
    const showVel = !prof || prof.motion !== 'static';
    const geom = AGENT_GEOM_ATTR_SPECS
      .filter(g => is3D || (g.id !== GEOM_VZ && g.id !== GEOM_Z))
      .filter(g => {
        if (g.id === GEOM_RADIUS) return showRadius;
        if (g.id === GEOM_VX || g.id === GEOM_VY || g.id === GEOM_VZ) return showVel;
        return true; // position rows always
      })
      .map(g => ({ id: g.id, name: g.name, type: 'float', description: '', defaultValue: g.id === GEOM_RADIUS ? String(dr) : '0' } as Attribute));
    return [
      ...(model.agentAttributes ?? []).filter(a => a.type !== 'color' && a.type !== 'lookupTable'),
      ...geom,
    ];
    // agentGraphNodes/macroDefs are deps because resolveAgentProfile falls back to
    // inferAgentProfile (which scans them) when the profile isn't explicit — keeps
    // this in lockstep with the sibling `agentCapProfile` memo.
  }, [model.agentAttributes, model.centerBased, model.topologyMode, model.agentGraphNodes, model.macroDefs, is3D]);
  // Resolved Agent Capability Profile (null for non-agent models) — used to gate
  // the inspector-popover geometry rows to the enabled capabilities.
  const agentCapProfile = useMemo(
    () => (model.topologyMode?.agents ? resolveAgentProfile(model) : null),
    [model.topologyMode, model.centerBased, model.agentGraphNodes, model.macroDefs],
  );
  // Bond-Graph Agents: the live agent render snapshot (from the worker `stepped`
  // message), the per-render flag, and the seed/brush configuration. The agent
  // world is the grid coordinate frame (1:1), so agent (x,y) map to screen with
  // the same transform the cell blit uses.
  const isAgentModel = !!model.topologyMode?.agents;
  const isAgentModelRef = useRef(isAgentModel);
  isAgentModelRef.current = isAgentModel;
  // Whether the CA-grid layer exists at all (topology). A non-agent model always
  // has the grid; an agent model may be agents-only (gridCells off) → no CA grid.
  const gridCellsOn = model.topologyMode?.gridCells !== false;
  const gridCellsOnRef = useRef(gridCellsOn);
  gridCellsOnRef.current = gridCellsOn;
  // Agents-only model (no CA grid) → the brush can only act on agents; force the
  // target off any stale/persisted 'grid' so the (hidden) Brush-affects toggle
  // can't leave it pointing at a non-existent layer.
  useEffect(() => {
    if (isAgentModel && !gridCellsOn && brushTarget === 'grid') setBrushTarget('agents');
  }, [isAgentModel, gridCellsOn, brushTarget]);
  const agentsRef = useRef<AgentRenderSnapshot | null>(null);
  // --- Agent sprites (render side) ---
  // The decoded-frame registry (keyed by sprite id) + the ordered slot→{id,scale,
  // loop} meta so the per-agent 1-based slot maps to a sprite. PLAYBACK is driven
  // by the agent's logic (Set Agent Sprite sets sprite/frame/speed; the engine
  // advances the frame per step) — there is NO simulator transport here. The
  // render just reads the per-agent frame from the snapshot.
  const spriteRegistryRef = useRef<SpriteRegistry | null>(null);
  const spriteMetaRef = useRef<Array<{ id: string; scale: number; loop: boolean; defaultDirection: number; orientToVelocity: boolean; rotationOffset: number }>>([]);
  // 3D sprites: the gl3d sprite ATLAS is (re)built lazily in the 3D draw path (the
  // only place the renderer exists) whenever this flag is set — by a sprite-set
  // change, a decode completing (registry onReady), or a fresh renderer. The 2D
  // path draws sprites straight from the registry (no atlas) — this is 3D-only.
  const spriteAtlasDirtyRef = useRef(true);
  // Agent brush: the LMB action on the canvas for an agent model (only active
  // when brushTarget === 'agents'). Add/Remove/Move/Edit honour the Single/Area
  // scope + the shape footprint; Glue/Cut stage a first agent then bond/unbond to
  // the second; Bond auto-bonds near agents under the brush.
  type AgentBrushMode = 'add' | 'remove' | 'move' | 'edit' | 'glue' | 'cut' | 'bond';
  const [agentBrushMode, setAgentBrushMode] = useState<AgentBrushMode>('add');
  const agentBrushModeRef = useRef<AgentBrushMode>('add');
  agentBrushModeRef.current = agentBrushMode;
  const agentGlueAnchorRef = useRef<number>(-1);
  const agentBrushRadiusRef = useRef(agentBrushRadius); agentBrushRadiusRef.current = agentBrushRadius;
  const agentSeedDensityRef = useRef(agentSeedDensity); agentSeedDensityRef.current = agentSeedDensity;
  const agentSeedSpacingRef = useRef(agentSeedSpacing); agentSeedSpacingRef.current = agentSeedSpacing;
  const agentBrushShapeRef = useRef(agentBrushShape); agentBrushShapeRef.current = agentBrushShape;
  const agentBrushWRef = useRef(agentBrushW); agentBrushWRef.current = agentBrushW;
  const agentBrushHRef = useRef(agentBrushH); agentBrushHRef.current = agentBrushH;
  const agentBrushRingWidthRef = useRef(agentBrushRingWidth); agentBrushRingWidthRef.current = agentBrushRingWidth;
  const agentBrushLineWidthRef = useRef(agentBrushLineWidth); agentBrushLineWidthRef.current = agentBrushLineWidth;
  const agentBrushScopeRef = useRef(agentBrushScope); agentBrushScopeRef.current = agentBrushScope;
  // Line tool (Add/Remove/Edit, Area scope): first click stages a world anchor
  // (no action); the second acts on the capsule between the two. null = none.
  const agentLineAnchorRef = useRef<{ x: number; y: number } | null>(null);
  // Rigid group move (Move, Area scope): the agents grabbed at pointer-down + the
  // world point they were grabbed at, so the drag translates them all by one delta.
  // sz/downZ carry the 3D layer (0 in 2D).
  const agentGroupMoveRef = useRef<{ members: Array<{ id: number; sx: number; sy: number; sz: number }>; downX: number; downY: number; downZ: number } | null>(null);
  // 3D Line tool for the agent brush (Add/Remove/Edit, Area): staged plane anchor.
  const agentLine3dAnchorRef = useRef<{ layer: number; row: number; col: number } | null>(null);
  // The agent ids currently under an AREA footprint that WILL be affected (Remove/
  // Move/Edit — NOT Add, which only adds). Drawn as highlight rings so the user
  // sees exactly which agents the stroke touches. Empty when not applicable.
  const agentAreaHoverIdsRef = useRef<number[]>([]);
  const [agentSeedConfigOpen, setAgentSeedConfigOpen] = useState(false);
  // Live cursor world position (for the agent brush ring) + the hovered agent
  // id (change-detected so we don't full-redraw on every raw mousemove).
  const agentCursorWorldRef = useRef<{ x: number; y: number } | null>(null);
  const agentHoverIdRef = useRef<number>(-1);
  // Agent clipboard (Ctrl+C/V/X with the AGENT brush target, 2D): per-agent
  // world-offset-from-the-copy-anchor + radius/velocity/attribute values. Copy
  // is a two-step round-trip — collect the footprint ids from the snapshot,
  // batch-read their FRESH spec via the `readAgents` worker message (which
  // joins the one-shot staleness readers, so free-mode copies are never
  // stale) — the reply lands in the `agentsRead` handler below. Cut kills the
  // copied ids once the read confirms.
  const agentClipboardRef = useRef<Array<{ dx: number; dy: number; radius: number; vx: number; vy: number; attrs: Record<string, number> }> | null>(null);
  const pendingAgentCopyRef = useRef<{ anchor: { x: number; y: number }; cut: boolean; ids: number[] } | null>(null);
  // PR4 — Move brush: the agent currently being dragged (-1 = none) + its
  // pre-drag position (for the RMB-cancel revert). Own rAF token (C-B4).
  const draggingAgentRef = useRef<number>(-1);
  const draggingAgentStartRef = useRef<{ x: number; y: number } | null>(null);
  const pendingMovesRef = useRef<Array<{ id: number; x: number; y: number; z?: number }> | null>(null);
  const pendingMoveRaf = useRef<number | null>(null);
  // PR4 — Bond-paint: the set of pairs queued from the current stroke (dedup'd).
  const pendingBondPairs = useRef<Set<string>>(new Set());
  // The TRANSIENT sweep popover, mirrored for the pointer handlers (which are
  // registered once per effect run and must read the live value).
  // NB assigned SYNCHRONOUSLY by openAgentInspector / clear / commit (a fast
  // click's mousedown+mouseup land in one frame, before any re-render), so the
  // ref leads the state rather than mirroring it here.
  const agentSweepPopoverRef = useRef<AgentPopoverState | null>(null);
  // Reassigned each render; the message dispatch calls it when an `agentState`
  // response arrives. Declared as a ref so the dispatch closure stays stable.
  const onAgentStateRef = useRef<(r: AgentStateResponse) => void>(() => {});
  onAgentStateRef.current = (r: AgentStateResponse) => {
    // Cache by id for whichever popovers are open (pinned or the sweep).
    if (agentInspectIdsRef.current.includes(r.id)) {
      agentStatesRef.current.set(r.id, r);
      bumpAgentStateVersion(v => v + 1);
    }
    // Edit brush (Single scope): prefill the panel VALUES from the picked agent's
    // live state (keeping the user's per-row enabled toggles). Geometry rows read
    // radius/velocity/position straight; attribute rows decode by type.
    if (r.live && editPrefillIdRef.current === r.id) {
      editPrefillIdRef.current = -1;
      setAgentEditAttrs(prev => {
        const next = { ...prev };
        const put = (id: string, v: number | undefined, attr?: Attribute) => {
          if (v === undefined) return;
          const cur = next[id] ?? { enabled: false, value: '' };
          next[id] = { enabled: cur.enabled, value: attr ? decodeAttrValue(attr, v) : String(v) };
        };
        for (const attr of (model.agentAttributes ?? [])) {
          if (attr.type === 'vector') {
            // A vector agent attr is published as its scalar components (`<id>_vx`…);
            // recombine into the "x,y[,z]" string the vector brush widget edits.
            const cur = next[attr.id] ?? { enabled: false, value: '' };
            next[attr.id] = { enabled: cur.enabled, value: decodeVectorFromValues(attr, r.attrs ?? null) };
          } else {
            put(attr.id, r.attrs?.[attr.id], attr);
          }
        }
        put(GEOM_RADIUS, r.radius); put(GEOM_VX, r.vx); put(GEOM_VY, r.vy); put(GEOM_VZ, r.vz);
        put(GEOM_X, r.x); put(GEOM_Y, r.y); put(GEOM_Z, r.z);
        return next;
      });
    }
  };
  const glCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const gl3dRef = useRef<import('./render/gl3d').Gl3DRenderer | null>(null);
  // Z-up Blender-style orbit camera. Default 3/4 view looking down onto the XY plane.
  const cam3dRef = useRef<import('./render/gl3d').Camera3D>(defaultCamera3d());
  const clip3dRef = useRef<import('./render/gl3d').ClipPlane3D>({ enabled: false, axis: 'z', lo: 0, hi: 0 });
  const alpha3dRef = useRef(false);
  const agentsFront3dRef = useRef(true);
  // 3D scene lighting + the cell-gaps toggle, mirrored into the renderer each
  // draw (both persisted in genesisca_sim_settings). Cell gaps default OFF
  // (flush cubes — the buried-cell-culling mode); the sync effect overwrites
  // from the persisted state on mount, this initial just avoids a first-frame
  // mismatch with the state default.
  const light3dRef = useRef<Light3D>({ ...DEFAULT_LIGHT3D });
  const cellGaps3dRef = useRef(false);
  const agentMetaballsRef = useRef<Metaballs3D>({ ...DEFAULT_METABALLS3D });
  // 2D metaballs — the offscreen scratch the agent discs draw into before the
  // gooey-filtered blit (reused across frames; never getImageData'd).
  const gooScratchRef = useRef<HTMLCanvasElement | null>(null);
  // voxels/agents are driven from showCaGrid/showAgents below (the render-layer
  // toggles); the panel only edits axes/grid/bounds/gizmo. draw() overrides the two.
  const viz3dRef = useRef<import('./render/gl3d').Viz3D>({ axes: false, grid: false, bounds: true, gizmo: true, voxels: true, agents: true, bonds: true });
  // Interaction plane: LMB-brush ray-traces onto this slicing plane.
  const plane3dRef = useRef<{ axis: 'x' | 'y' | 'z'; pos: number }>({ axis: 'z', pos: 0 });
  const plane3dEnabledRef = useRef(false);
  // Auto-orbit (rAF loop increments yaw).
  const orbit3dRef = useRef<{ on: boolean; speed: number }>({ on: false, speed: 0.4 });
  // Auto-zoom — the dolly sibling of auto-orbit: the SAME rAF loop dollies the camera
  // distance in ONE direction (see the loop below), clamped at the distance limits.
  const zoom3dRef = useRef<AutoZoom3D>({ ...DEFAULT_AUTOZOOM3D });
  // 3D pick → inspector. Set below `commitInspectPopover` (which is declared
  // later in the component); the pointer effect calls it via this ref.
  const openInspect3dRef = useRef<((idx: number, x: number, y: number) => void) | null>(null);
  // 3D paint: set below flushPaintBatch; the pointer effect calls it on LMB-drag
  // with the picked plane cell. It stamps the current brush shape onto the plane.
  const paint3dRef = useRef<((layer: number, row: number, col: number) => void) | null>(null);
  // Last plane cell painted in the current 3D stroke — drives Bresenham
  // interpolation so a fast drag doesn't leave gaps between stamps. Reset on
  // pointer-down / -up (and implicitly when the plane changes mid-stroke).
  const last3dHitRef = useRef<{ layer: number; row: number; col: number } | null>(null);
  // Hovered brush-plane cell (change-detection) + the full brush FOOTPRINT it
  // expands to (the cells the renderer outlines as the cube cursor).
  const hover3dRef = useRef<{ layer: number; row: number; col: number } | null>(null);
  // Phase C: pointer over the 3D gl canvas (set on enter/leave). Drives the agent-
  // brush frame-mode flip so the gl3d pick FBO (which reads the snapshot) works —
  // the 3D analogue of the 2D `agentCursorWorldRef != null` UI-sync condition.
  const glPointerOverRef = useRef(false);
  // A pointer gesture (press → release) is in progress on the 3D gl canvas, and
  // whether Shift is held while hovering it. Both pin the grid's frame mode: they
  // are the states in which a colour-id `pick()` (inspect) can fire, and that pick
  // reads gl3d's CPU instance buffer, which only frame mode refreshes. PASSIVE
  // hover deliberately does NOT pin — see updateGridUiSync.
  const glGestureActiveRef = useRef(false);
  const glShiftDownRef = useRef(false);
  const hoverCells3dRef = useRef<ReadonlyArray<{ layer: number; row: number; col: number }>>([]);
  // 3D Line tool: first click stages a plane-cell anchor (no paint); the second
  // click draws the capsule line between them. null = no staged anchor.
  const line3dAnchorRef = useRef<{ layer: number; row: number; col: number } | null>(null);
  // 3D inspect highlight — the cell whose inspect popover is being hovered (the
  // 2D connector line doesn't track 3D projection, so 3D highlights the cell
  // instead). Empty = none.
  const inspectHighlight3dRef = useRef<ReadonlyArray<{ layer: number; row: number; col: number }>>([]);
  // 3D canvas background colour fed to the renderer ([r,g,b,a] 0..1, null = transparent).
  const bg3dRef = useRef<[number, number, number, number] | null>(null);
  // 3D perf: the colors buffer last uploaded to the voxel renderer. The worker
  // hands a FRESH buffer on every `stepped`, so identity changes iff colours
  // changed — camera-only redraws (orbit/pan/auto-orbit/hover) reuse the GPU
  // instance buffer and skip the O(total) scan+upload. Reset (null) whenever the
  // renderer is recreated or the colours buffer is cleared, to force a re-upload.
  const lastUploadedColors3dRef = useRef<Uint8ClampedArray | null>(null);
  // 3D agents (PR5): the render snapshot last uploaded to the sphere pipeline.
  // The worker posts a FRESH snapshot object each `stepped` (the .slice gives new
  // buffers), so identity changes iff agent positions/colours changed — a
  // camera-only redraw reuses the GPU instance buffer. Reset on renderer recreate.
  const lastUploadedAgentSnapRef = useRef<AgentRenderSnapshot | null>(null);
  // 3D agent hover/inspect highlight rings (the sphere analog of
  // hoverCells3dRef/inspectHighlight3dRef for voxels). Empty = none.
  const hoverAgents3dRef = useRef<ReadonlyArray<{ x: number; y: number; z: number; radius: number }>>([]);
  // NB there is no inspectAgents3dRef — the 3D inspect RINGS are derived inside
  // draw() from the open popovers + the live snapshot, so they track the agent.
  // 3D control UI state (mirrored into the refs the renderer reads).
  // Clip INTERVAL [lo, hi] (world coords) — two cuts, the slab between them visible.
  const [clip3d, setClip3d] = useState<{ enabled: boolean; axis: 'x' | 'y' | 'z' | 'camera'; lo: number; hi: number }>(
    { enabled: false, axis: 'z', lo: 0, hi: 0 },
  );
  const [alpha3d, setAlpha3d] = useState(false);
  const [viz3d, setViz3d] = useState<import('./render/gl3d').Viz3D>({ axes: false, grid: false, bounds: true, gizmo: true, voxels: true, agents: true, bonds: true });
  const [plane3d, setPlane3d] = useState<{ enabled: boolean; axis: 'x' | 'y' | 'z'; pos: number }>({ enabled: false, axis: 'z', pos: 0 });
  const [orbit3d, setOrbit3d] = useState<{ on: boolean; speed: number }>({ on: false, speed: 0.4 });
  // Auto-zoom (session state, like auto-orbit — a camera animation that resumed
  // itself on every load would surprise, so neither is persisted).
  const [zoom3d, setZoom3d] = useState<AutoZoom3D>({ ...DEFAULT_AUTOZOOM3D });
  // 3D canvas background. `enabled` false = transparent (page shows through);
  // when enabled, `color` (hex) fills the canvas opaquely.
  const [bg3d, setBg3d] = useState<{ enabled: boolean; color: string }>({ enabled: false, color: '#0c0d10' });
  const [controls3dOpen, setControls3dOpen] = useState(true);

  /** Light-ball drag: store the ball position; in world mode ALSO convert it
   *  through the CURRENT camera basis so the light lands where the user aimed
   *  it "as seen from here", then stays fixed in the scene. */
  const applyLightBall = useCallback((bx: number, by: number) => {
    setLight3d(l => {
      const next: Light3D = { ...l, bx, by };
      if (l.mode === 'world') {
        const bz = Math.sqrt(Math.max(0, 1 - bx * bx - by * by));
        const basis = cameraBasis(cam3dRef.current);
        // basis.dir = target→eye = toward the viewer (the ball's implied +z).
        const x = basis.right[0] * bx + basis.up[0] * by + basis.dir[0] * bz;
        const y = basis.right[1] * bx + basis.up[1] * by + basis.dir[1] * bz;
        const z = basis.right[2] * bx + basis.up[2] * by + basis.dir[2] * bz;
        const n = Math.hypot(x, y, z) || 1;
        next.wx = x / n; next.wy = y / n; next.wz = z / n;
      }
      return next;
    });
  }, []);

  /** Switch the light anchor. camera→world freezes the current view-relative
   *  light into world coords (no visual jump at the moment of switching). */
  const setLightMode = useCallback((mode: 'camera' | 'world') => {
    setLight3d(l => {
      if (l.mode === mode) return l;
      if (mode === 'world') {
        const bz = Math.sqrt(Math.max(0, 1 - l.bx * l.bx - l.by * l.by));
        const basis = cameraBasis(cam3dRef.current);
        const x = basis.right[0] * l.bx + basis.up[0] * l.by + basis.dir[0] * bz;
        const y = basis.right[1] * l.bx + basis.up[1] * l.by + basis.dir[1] * bz;
        const z = basis.right[2] * l.bx + basis.up[2] * l.by + basis.dir[2] * bz;
        const n = Math.hypot(x, y, z) || 1;
        return { ...l, mode, wx: x / n, wy: y / n, wz: z / n };
      }
      return { ...l, mode };
    });
  }, []);
  // Which viewers want the zoomed-out glyph-color fallback (Set Cell Looks with
  // useGlyph + fallbackToGlyphColor). `all` = a node used the Current-Selected
  // sentinel (applies to every viewer). Scanned from the model below.
  const glyphFallbackRef = useRef<{ all: boolean; ids: Set<string> }>({ all: false, ids: new Set() });
  // Scratch canvas for the zoomed-out fallback blit (colors with glyphed cells
  // recolored to their glyph color). Built lazily, sized to the grid.
  const fallbackCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Zoom/Pan state (refs to avoid re-renders on every mouse move)
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const isPanning = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });
  const cursorGrid = useRef<{ row: number; col: number } | null>(null);
  // The hovered cell / brush-footprint chip lives in the module-level
  // HoverCoordsChip external store (see publishHoverCellInfo above) so per-cell
  // crossings never re-render this component.
  // ── Cursor overlay layer ──────────────────────────────────────────────────
  // The brush cursor + agent-brush highlights draw on TWO dedicated overlay
  // canvases ABOVE the scene canvas: `cursorNeg` carries the white silhouettes
  // and is composited with CSS mix-blend-mode: difference (the negative-cursor
  // trick, now done by the compositor instead of reading scene pixels), and
  // `cursorHl` carries the coloured highlight rings with normal blending.
  // Moving the cursor redraws ONLY these layers — never the scene canvas — so
  // brush movement costs nothing on the play pipeline and the cursor stays
  // fluid even when the simulation renders at 1 fps (the reported bug).
  const cursorNegCanvasRef = useRef<HTMLCanvasElement>(null);
  const cursorHlCanvasRef = useRef<HTMLCanvasElement>(null);
  /** The scene transform draw() last rendered with — the cursor layer renders
   *  from this stash (pan/zoom/step redraws refresh it, then re-sync the layer). */
  const viewXformRef = useRef<{
    parentW: number; parentH: number; w: number; h: number; scale: number;
    scaledW: number; scaledH: number; ox: number; oy: number; infinity: boolean;
    txMin: number; txMax: number; tyMin: number; tyMax: number;
  } | null>(null);
  /** Scratch canvases for the "simulation"-scope capture (recording + screenshot).
   *  simGridTmpRef holds the W×H colours buffer; simCaptureRef is the reused output
   *  offscreen for recording. Never displayed → getImageData on them is safe. */
  const simGridTmpRef = useRef<HTMLCanvasElement | null>(null);
  const simCaptureRef = useRef<HTMLCanvasElement | null>(null);
  /** Render the WHOLE grid/world at a fit framing (zoom/pan-INDEPENDENT) into an
   *  offscreen — the "simulation" capture scope. Composited on the main thread from
   *  data that's always available while recording: the colours buffer (grid) + the
   *  agent snapshot (circles + bonds). So it works on every compile target incl. WebGPU
   *  direct render / composite (which otherwise only expose the current-view framing).
   *  Output is grid-aspect (W:H) → no letterbox margins by construction. Reads only refs.
   *  NB agent SPRITES / METABALLS / GLOW are drawn as plain circles here — use the
   *  "current view" scope for a WYSIWYG capture of those. Reuses `target` if given. */
  const renderSimulationFrame = useCallback((maxSize: number, target?: HTMLCanvasElement, snapWidth = false): HTMLCanvasElement | null => {
    if (is3dRef.current) return null;
    const w = gridWidth.current, h = gridHeight.current;
    if (!w || !h) return null;
    let scale = maxSize / Math.max(w, h);
    // Recording only (`snapWidth`): lower the width into the VP9 profile-1 fast
    // residue class so the file keeps 4:4:4 chroma — see snapRecordWidth. The
    // height comes from the SAME scale, so the aspect ratio is exact. Screenshots
    // pass false and keep their requested size.
    if (snapWidth) {
      const wantW = Math.max(1, Math.round(w * scale));
      const snapW = snapRecordWidth(wantW);
      if (snapW !== wantW) scale = snapW / w;
    }
    const outW = Math.max(1, Math.round(w * scale)), outH = Math.max(1, Math.round(h * scale));
    const off = target ?? document.createElement('canvas');
    if (off.width !== outW) off.width = outW;
    if (off.height !== outH) off.height = outH;
    const ctx = off.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, outW, outH);
    const showGrid = gridCellsOnRef.current && (!isAgentModelRef.current || showCaGridRef.current);
    const colors = colorsRef.current;
    if (showGrid && colors && colors.length >= w * h * 4) {
      let tmp = simGridTmpRef.current;
      if (!tmp) { tmp = document.createElement('canvas'); simGridTmpRef.current = tmp; }
      if (tmp.width !== w) tmp.width = w;
      if (tmp.height !== h) tmp.height = h;
      const tctx = tmp.getContext('2d');
      if (tctx) {
        tctx.putImageData(new ImageData(new Uint8ClampedArray(new Uint8ClampedArray(colors.buffer, colors.byteOffset, w * h * 4)), w, h), 0, 0);
        ctx.drawImage(tmp, 0, 0, outW, outH);
      }
    } else if (isAgentModelRef.current && !showGrid && bg2dRef.current) {
      ctx.fillStyle = bg2dRef.current;
      ctx.fillRect(0, 0, outW, outH);
    }
    // Agent layer (circles + bonds) at the fit transform (ox = oy = 0, one world tile).
    if (isAgentModelRef.current && showAgentsRef.current) {
      const snap = agentsRef.current;
      if (snap && snap.highWater > 0) {
        const { x: ax, y: ay, radius: ar, alive: aal, colors: acol, highWater: hw, bonds } = snap;
        if (showBondsRef.current && bonds && bonds.length > 0) {
          const torus = boundaryTreatmentRef.current === 'torus';
          ctx.beginPath();
          for (let b = 0; b < bonds.length; b += 2) {
            const i = bonds[b]!, j = bonds[b + 1]!;
            let jx = ax[j]!, jy = ay[j]!;
            if (torus) {
              if (jx - ax[i]! > w / 2) jx -= w; else if (jx - ax[i]! < -w / 2) jx += w;
              if (jy - ay[i]! > h / 2) jy -= h; else if (jy - ay[i]! < -h / 2) jy += h;
            }
            ctx.moveTo(ax[i]! * scale, ay[i]! * scale);
            ctx.lineTo(jx * scale, jy * scale);
          }
          ctx.strokeStyle = 'rgba(230, 230, 245, 0.55)';
          ctx.lineWidth = Math.max(1, scale * 0.18);
          ctx.stroke();
        }
        const outlines = agentOutlinesRef.current;
        for (let i = 0; i < hw; i++) {
          if (!aal[i]) continue;
          const c = i * 4;
          const cx = ax[i]! * scale, cy = ay[i]! * scale, rad = Math.max(1.2, ar[i]! * scale);
          ctx.beginPath();
          ctx.arc(cx, cy, rad, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${acol[c]},${acol[c + 1]},${acol[c + 2]},${(acol[c + 3] ?? 255) / 255})`;
          ctx.fill();
          if (outlines && rad >= 2) {
            ctx.lineWidth = Math.min(1.5, rad * 0.25);
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
            ctx.stroke();
          }
        }
      }
    }
    return off;
  }, []);
  /** Idle hover tracking (cursor cell + chip + agent hover scans) is coalesced
   *  to ONE rAF per frame — a 125–1000 Hz mouse must not run O(agents) scans or
   *  React updates per raw event (the cursor-slows-the-sim bug). */
  const hoverWorkRaf = useRef<number | null>(null);
  const lastHoverClient = useRef({ x: 0, y: 0, buttons: 0 });
  const lastPaintGrid = useRef<{ row: number; col: number } | null>(null);
  // Paint coalescing: instead of posting a paint message per mouse-move event
  // (~50-200/sec on a fast brush drag), collect cells in a buffer and flush
  // once per requestAnimationFrame. Each flush is a single round-trip through
  // the worker → GPU pipeline. The mouse-up handler force-flushes so the last
  // partial batch isn't lost. Different mappingIds within one batch are
  // flushed eagerly (rare in practice — only when the user changes brush
  // mid-drag, which already breaks the Bresenham line at lastPaintGrid reset).
  const pendingPaintCells = useRef<Array<{ row: number; col: number; layer?: number; r: number; g: number; b: number }>>([]);
  const pendingPaintMapping = useRef<string | null>(null);
  const pendingPaintViewer = useRef<string>('');
  const pendingPaintRaf = useRef<number | null>(null);
  // Bond-Graph Agents — drag-to-seed coalescing. A SEPARATE buffer + rAF token
  // from the paint batcher (C-B4): flushPaintBatch posts paint/paintManual, and
  // a shared cancelAnimationFrame token would clobber the other. `pendingSeedSets`
  // carries the encoded attr values (PR3 seed config) for the batch.
  const pendingSeedPoints = useRef<Array<{ x: number; y: number; type?: number }>>([]);
  const pendingSeedSets = useRef<Array<{ attrId: string; value: number }> | null>(null);
  const pendingSeedRaf = useRef<number | null>(null);
  // True only while a seed/kill agent-brush drag started on the canvas (mirrors
  // canvasBrushActive for the cell brush). Cleared on overlay-bail AND pointer-up.
  const canvasAgentBrushActive = useRef(false);
  // Last cursor world point of the current seed drag (for the spacing throttle).
  const lastSeedWorldRef = useRef<{ x: number; y: number } | null>(null);

  // FPS + Gens/s tracking
  const fpsFrames = useRef(0);
  const fpsLastTime = useRef(performance.now());
  const gpsGens = useRef(0);
  const lastGenForGps = useRef(0);

  // 1:1 pixel source canvas (reused across draws)
  const srcCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // P7 — when true, srcCanvasRef has had its 2D context transferred to the
  // worker via OffscreenCanvas. The worker writes WebGPU output directly to
  // it, so draw() must skip the putImageData step and only do the
  // zoom/pan drawImage. Reset when the worker is reinitialised.
  const directRenderActiveRef = useRef<boolean>(false);
  // True between worker init and the first useWebGPUStatus { ready: true }
  // message: signals that we still owe the worker a canvas transfer once it
  // confirms WebGPU is up. We defer the transfer (rather than doing it
  // optimistically at init time) so the JS-fallback period during async
  // device acquisition can still draw via putImageData on a regular 2D
  // canvas. Set in initWorkerWithDimensions; cleared in the
  // useWebGPUStatus handler after the canvas is sent.
  const pendingCanvasAttach = useRef<boolean>(false);
  // Holds the about-to-be-direct-render canvas between the moment we send
  // attachCanvas to the worker and the moment the worker confirms direct
  // render is live (second useWebGPUStatus { ready: true, directRender: true }).
  // Until that ack arrives we keep srcCanvasRef pointing at the regular 2D
  // canvas (which has the latest JS-fallback putImageData content) so draw()
  // doesn't flash blank. If the ack never arrives (worker rejected attach,
  // or the runtime was destroyed before processing it), the placeholder
  // canvas stays orphaned and we stay on the JS-fallback path.
  const pendingDirectRenderCanvas = useRef<HTMLCanvasElement | null>(null);
  // True between sending a soft `recompile` message under WebGPU direct render
  // and receiving the worker's post-rebuild `useWebGPUStatus { ready: true,
  // directRender: true }`. Used to trigger a fresh canvas re-attach so we
  // sidestep an issue where reusing the salvaged OffscreenCanvas across a
  // device swap leaves it in a broken state (no subsequent present produces
  // visible output, even play / viewer switches don't recover). Full Recompile
  // works because it creates a fresh canvas via Phase 1 — this flag opts the
  // soft recompile path into the same fresh-canvas treatment, but without
  // tearing down the worker (so model attribute sliders + grid state survive).
  const recompilePendingCanvasRefresh = useRef<boolean>(false);

  // --- A1 direct AGENT render (agents-only, 2D, WebGPU) ---
  // Active once the worker acks agentRenderStatus{active:true}: the worker renders
  // agents straight from the GPU SoA into a transferred OffscreenCanvas and the
  // main thread blits it 1:1 (no drawAgentsOverlay). Mirrors the grid seam.
  const agentDirectRenderActiveRef = useRef<boolean>(false);
  // The gate result (general model properties) — read by the agentRuntimeReady
  // handler to decide whether to (re)attach the agent canvas.
  const agentRenderEligibleRef = useRef<boolean>(false);
  // M1 (audit): the two gate terms that a SOFT recompile can flip — no sprites, and
  // (WebGPU target) either no agent Output Mappings or an OM the GPU compiled. The
  // full gate is only evaluated in initWorkerWithDimensions, so without this the
  // terms went stale: adding a sprite kept direct render on (sprites never drawn,
  // since the GPU pass draws discs and drawAgentsOverlay is skipped), and adding a
  // GPU-unsupported OM kept it presenting behaviour/default colours instead of the
  // CPU OM colours. Refreshed in the soft-recompile path; consumed by
  // maybeAttachAgentCanvas (same shape as the metaballs suppression).
  const agentRenderModelTermsOkRef = useRef<boolean>(true);
  // E2: this model wants the single-canvas COMPOSITE (2D grid+agents, WebGPU grid,
  // WebGPU agents) — the transferred canvas is WORLD-sized (grid dims) and the
  // worker composites the grid layer + the agent discs into it in one encoder.
  // The main thread blits the world-sized composite scaled+tiled (the grid
  // direct-render blit), NOT 1:1. False → the display-sized standard agent render.
  const agentCompositeEligibleRef = useRef<boolean>(false);
  // Set from the agentRenderStatus ack: the worker actually enabled the composite.
  const agentCompositeActiveRef = useRef<boolean>(false);
  // We owe the worker a canvas attach on the next agentRuntimeReady.
  const pendingAgentCanvasAttach = useRef<boolean>(false);
  // The placeholder canvas whose control was transferred to the worker (becomes
  // the 1:1 blit source once active). Display-pixel sized (fixed at transfer).
  const agentRenderCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // The fresh canvas awaiting the agentRenderStatus ack.
  const pendingAgentRenderCanvas = useRef<HTMLCanvasElement | null>(null);
  // Whether the pending attach requested the E2 composite (world-sized canvas).
  const pendingAgentCompositeRef = useRef<boolean>(false);
  // The display pixel size the agent render canvas was attached at (a parent
  // resize past this needs a fresh re-attach — transferred canvas dims are fixed).
  const agentRenderCanvasDimsRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  // Live-agent count from the stepped message (snapshot present → snap.liveCount,
  // free mode → the agentLiveCount scalar). Drives the stats chip.
  const agentLiveCountRef = useRef<number>(0);
  // Last UI-sync value posted (avoid redundant messages). Bound by the SAME
  // UI-SYNC MIRROR INVARIANT as gridUiSyncPostedRef (see its doc comment):
  // only ever assigned from a value the worker was told / acked, or the module
  // default of a brand-new worker — never assumed after a re-attach.
  const agentUiSyncPostedRef = useRef<boolean>(true);
  // rAF coalescing token for setAgentCamera.
  const agentCameraRafRef = useRef<number>(0);
  // Last posted camera key (skip redundant setAgentCamera posts).
  const lastAgentCameraKeyRef = useRef<string>('');
  // UI-sync debounce-OFF timer (so a brush stroke doesn't thrash the readback).
  const agentUiSyncTimerRef = useRef<number>(0);
  // Phase C — 3D free-mode direct render: unlike the 2D path (a DETACHED canvas
  // the main thread blits onto the 2D display canvas), the 3D worker canvas is a
  // VISIBLE DOM sibling UNDER the gl3d canvas, composited by the browser (no blit).
  // We imperatively manage a fresh `<canvas>` inside this stable layer on each
  // attach (fresh element handles transfer-once + resize + recompile); gl3d renders
  // ONLY the overlays over a transparent clear on top. `agentSphere3DActiveRef` is
  // true while the worker composites the sphere canvas (free mode); flipping it OFF
  // (frame mode) hides the sphere canvas + lets gl3d render the full snapshot.
  const agentSphereLayerRef = useRef<HTMLDivElement | null>(null);
  const agentSphereCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const agentSphere3DActiveRef = useRef<boolean>(false);

  // L1 — worker-side WGSL VOXEL render (3D CA grids on the WebGPU target). Same
  // seam as Phase C's sphere layer: a stable layer div under the gl3d canvas into
  // which we imperatively append a fresh transferred `<canvas>` per attach, while
  // gl3d renders ONLY the interaction overlays over a transparent clear. In FREE
  // mode (grid UI-sync off) nothing crosses the wire — no colours readback, no
  // postMessage, no main-thread uploadColors rescan. FRAME mode (interaction /
  // recording / pause / shadows / AO / alpha blend) hides the voxel canvas and
  // gl3d renders everything from `colorsRef`, exactly as before L1.
  const voxelLayerRef = useRef<HTMLDivElement | null>(null);
  const voxelCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const pendingVoxelCanvas = useRef<HTMLCanvasElement | null>(null);
  /** The model-level gate (see the model effect) — general properties only. */
  const voxelRenderEligibleRef = useRef<boolean>(false);
  /** True once the worker acked `voxelRenderStatus { active: true }`. */
  const voxelRenderActiveRef = useRef<boolean>(false);
  const voxelCanvasDimsRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  /** Mirrors the worker's `gridUiSync`.
   *
   *  UI-SYNC MIRROR INVARIANT (applies equally to `agentUiSyncPostedRef`):
   *  this ref may ONLY be assigned from a value the worker has actually been
   *  TOLD (a `setGridUiSync` we post in the same statement), a value the worker
   *  has ACKED (`uiSync` on the attach ack), or the documented module default of
   *  a BRAND-NEW worker created in the same tick. NEVER from an ASSUMPTION.
   *
   *  The bug this rule exists to prevent: the worker's `gridUiSync` is a MODULE
   *  flag that SURVIVES a re-attach (a display resize re-attaches the voxel
   *  canvas on the SAME worker), so the ack handler's old hardcoded "= true,
   *  the worker default is ON" stranded the mirror ON while the worker sat
   *  OFF. The driver's `if (!gridUiSyncPostedRef.current)` guard then
   *  suppressed EVERY later ON post, so pause / 3D inspect / shadows / AO /
   *  alpha blend / recording all silently stopped working for the rest of the
   *  session (no colours frame ever crossed the wire again). Because the stuck
   *  value is ON, no OFF transition can resync it either — it is permanent. */
  const gridUiSyncPostedRef = useRef<boolean>(true);
  const gridUiSyncTimerRef = useRef<number>(0);
  /** Set when UI-sync is posted ON; cleared by the first `stepped` that carries
   *  colours. Frame mode waits for it so a flip can't render a colours buffer
   *  captured thousands of generations ago (the Phase C no-blank-frame rule). */
  const gridFrameAwaitingColorsRef = useRef<boolean>(false);
  const gridCameraRafRef = useRef<number>(0);
  const lastGridCameraKeyRef = useRef<string>('');
  /** True while the voxel canvas is the visible grid (gl3d in overlays-only mode). */
  const voxel3DActiveRef = useRef<boolean>(false);
  /** Persistent scratch canvases for capture3dPixels (never displayed). */
  const capture3dScratchRef = useRef<HTMLCanvasElement | null>(null);
  const capture3dOverlayRef = useRef<HTMLCanvasElement | null>(null);
  /** Persistent scratch canvases for downscaleCapture (never displayed). */
  const downscaleSrcRef = useRef<HTMLCanvasElement | null>(null);
  const downscaleDstRef = useRef<HTMLCanvasElement | null>(null);

  /** Downscale a captured pixel block so its long edge is at most `maxSize`.
   *
   *  Used by the 3D recording path, whose source is the whole WebGL drawing
   *  buffer (`cssW*dpr x cssH*dpr`, uncapped). Returns the input untouched when
   *  it already fits, so a small viewport pays nothing.
   *
   *  Both scratch canvases are NEVER DISPLAYED, which is what makes the
   *  `getImageData` here safe: doing that on a LIVE canvas de-optimises it out
   *  of GPU acceleration permanently (~6x slower drawing, outliving the
   *  recording). Same discipline as the 2D `recordScratchRef` path. */
  const downscaleCapture = useCallback((
    px: { data: Uint8ClampedArray; width: number; height: number },
    maxSize: number,
  ): { data: Uint8ClampedArray; width: number; height: number } => {
    const long = Math.max(px.width, px.height);
    if (long <= maxSize || long === 0) return px;
    const s = maxSize / long;
    const outW = Math.max(1, Math.round(px.width * s));
    const outH = Math.max(1, Math.round(px.height * s));
    let src = downscaleSrcRef.current;
    if (!src) { src = document.createElement('canvas'); downscaleSrcRef.current = src; }
    if (src.width !== px.width || src.height !== px.height) { src.width = px.width; src.height = px.height; }
    const sctx = src.getContext('2d');
    if (!sctx) return px;
    sctx.putImageData(new ImageData(px.data, px.width, px.height), 0, 0);
    let dst = downscaleDstRef.current;
    if (!dst) { dst = document.createElement('canvas'); downscaleDstRef.current = dst; }
    if (dst.width !== outW || dst.height !== outH) { dst.width = outW; dst.height = outH; }
    const dctx = dst.getContext('2d', { willReadFrequently: true });
    if (!dctx) return px;
    dctx.imageSmoothingEnabled = true;
    dctx.clearRect(0, 0, outW, outH);
    dctx.drawImage(src, 0, 0, px.width, px.height, 0, 0, outW, outH);
    const out = dctx.getImageData(0, 0, outW, outH);
    return { data: out.data, width: outW, height: outH };
  }, []);

  // Build full code display from all compiled functions
  const buildFullCode = useCallback((result: ReturnType<typeof compileGraph>) => {
    const parts: string[] = [];
    if (result.stepCode) {
      parts.push('// === Step Function ===\n' + result.stepCode);
    }
    if (result.initCode) {
      parts.push('// === Init Event (per-cell, runs once on Reset) ===\n' + result.initCode);
    }
    if (result.gridInitCode) {
      parts.push('// === Grid Init Event (global, runs once on Reset) ===\n' + result.gridInitCode);
    }
    for (const ic of result.inputColorCodes) {
      const m = model.mappings.find(mp => mp.id === ic.mappingId);
      parts.push(`// === Input Mapping: ${m?.name || ic.mappingId} ===\n${ic.code}`);
    }
    for (const om of result.outputMappingCodes) {
      const m = model.mappings.find(mp => mp.id === om.mappingId);
      parts.push(`// === Output Mapping: ${m?.name || om.mappingId} ===\n${om.code}`);
    }
    return parts.join('\n\n');
  }, [model.mappings]);

  // Compile graph (deps include indicator watched state since it affects compiled code).
  // Always returns the JS CompileResult — it's the universal fallback for the worker
  // and the Show Code source when JS is the selected target. The Show Code panel
  // displays whichever artefact matches the currently-selected compile target:
  //   - JS selected      → readable JS source from buildFullCode
  //   - WebGPU selected  → WGSL shader source (an extra compile pass; only when active)
  //   - WASM selected    → placeholder string (binary, not human-readable)
  const compileModel = useCallback(() => {
    const m = withEffectiveNeighborhoods(model);
    const result = compileGraph(m.graphNodes, m.graphEdges, m);
    // Agents-only model (Grid Cells disabled): there is no cell graph, so the cell
    // compiler's "No nodes / No Step node" error is EXPECTED — suppress it (the
    // worker skips the cell step via gridCells). Agent compile errors still surface
    // via the worker `error` message.
    const gridOn = model.topologyMode?.gridCells !== false;
    if (model.properties.useWebGPU) {
      try {
        const wgpu = compileGraphWebGPU(m.graphNodes, m.graphEdges, m);
        setCompiledCode(wgpu.shaderCode || '(no shader emitted)');
        setCompileError(gridOn ? (wgpu.error || result.error || '') : '');
      } catch (e) {
        setCompiledCode('');
        setCompileError(gridOn ? String((e as Error)?.message || e) : '');
      }
    } else if (model.properties.useWasm) {
      setCompiledCode(
        '/* WebAssembly target selected.\n' +
        ' * The compiled module is a binary WASM blob — not human-readable.\n' +
        ' * Switch to "Debug / Reference (JS)" in Model Properties to inspect generated code.\n' +
        ' */'
      );
      setCompileError(gridOn ? (result.error ?? '') : '');
    } else {
      setCompiledCode(buildFullCode(result));
      setCompileError(gridOn ? (result.error ?? '') : '');
    }
    return result;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.graphNodes, model.graphEdges, model.neighborhoods, model.indicators, model.properties.useWasm, model.properties.useWebGPU, model.topologyMode?.gridCells, buildFullCode]);

  // Bond-Graph Agents: compile the agent rule graph (the second graph). JS-only
  // (Decision D-TARGET). PR-A2 returns a placeholder (agents seed + render but
  // don't behave); PR-A3 wires the real compileAgentGraph over
  // model.agentGraphNodes (the behaviourStep loop + value-outs + force hooks).
  const compileAgentModel = useCallback((stopIdxBase = 0, dimsModel?: CAModel): { behaviourCode?: string; initCode?: string; divisionCode?: string; outputMappingCodes?: Array<{ mappingId: string; code: string }>; stopMessages: string[]; dividePartitions?: DividePartitionSpec[]; colorViewer: string; error?: string; agentTarget: 'js' | 'wasm' | 'webgpu'; agentWasmBytes?: Uint8Array; agentWasmViewerGuardIds?: string[]; agentLayoutExtras?: AgentLayoutExtras; agentWasmLayoutSig?: { maxHashBins: number; totalBytes: number }; agentResidencyClean?: boolean; agentWebgpuBehaviourShader?: string; agentWebgpuForceShader?: string; agentWebgpuMaxAgents?: number; agentWebgpuMaxHashBins?: number; agentWebgpuLayout?: AgentWebGPULayout; agentRenderLayout?: AgentWebGPULayout; agentWebgpuUsesI32Write?: boolean; agentWebgpuUsage?: { usesBondStore?: boolean; usesBondStoreWrite?: boolean; usesIndicators?: boolean; usesAux?: boolean; usesSpawn?: boolean; usesStop?: boolean; usesForceScatter?: boolean; usesGeneration?: boolean }; agentWebgpuOmShaders?: Array<{ mappingId: string; code: string; usesBondStore: boolean; usesBondStoreWrite?: boolean; usesIndicators: boolean; usesAux: boolean; usesGeneration?: boolean }>; agentWebgpuOmSupported?: boolean } => {
    // A simulator Resize / image-import overrides the live grid dims WITHOUT
    // touching model state, and the agent WASM/WebGPU compilers bake dims-derived
    // layout regions (the spatial-hash reserve, fieldTotal). Compiling from the
    // raw model desyncs those baked layouts from the live worker dims — the
    // WebGPU "spatial hash exceeds the reserve → runs on JS" demotion after a
    // resize, and (worse) a WASM store↔module offset mismatch. So the caller
    // passes the SAME dims-overridden model the grid compilers get.
    const m = dimsModel ?? model;
    if (!m.topologyMode?.agents) return { colorViewer: '', agentTarget: 'js', stopMessages: [] };
    // The default AGENT viewer = the first agent A→C mapping (drives the agent
    // colour pass). Empty when the model has no agent mappings (agents are then
    // coloured by the behaviour's Set Cell Looks).
    const firstAgentViewer = (m.agentMappings ?? []).find(mp => mp.isAttributeToColor);
    const colorViewer = firstAgentViewer?.id ?? '';
    // FIX 4: offset the agent stop indices by the cell graph's stop count so the
    // shared worker stopMessages array `[...cell, ...agent]` aligns 1-based.
    const ag = compileAgentGraph(m.agentGraphNodes || [], m.agentGraphEdges || [], m, stopIdxBase);
    if (ag.error) {
      // Surface alongside the cells compile error (Show Code / status). A bare
      // behaviourStep with no flow is fine (empty behaviourCode, no error).
      // eslint-disable-next-line no-console
      console.warn('[agents] compile:', ag.error);
    }
    // PR6b-1 — resolve the agent compile target. The WASM agent loop exists for
    // the supported node subset (the architecture skeleton); the gate clamps to
    // JS otherwise. When 'wasm', compile the agent module here (we have the
    // model) and ship the bytes to the worker — mirroring how lattice
    // `wasmStepBytes` are sent. The JS behaviourCode is ALWAYS sent too (the
    // worker keeps it as the fallback + for Show Code).
    let agentTarget = agentTargetOf(m.centerBased, isAgentGraphWasmSupported(m), isAgentGraphWebGPUSupported(m));
    let agentWasmBytes: Uint8Array | undefined;
    let agentWebgpuBehaviourShader: string | undefined;
    let agentWebgpuForceShader: string | undefined;
    let agentWebgpuMaxAgents: number | undefined;
    let agentWebgpuMaxHashBins: number | undefined;
    let agentWebgpuLayout: AgentWebGPULayout | undefined;
    // A2: the render-only GPU agent layout for a CPU (JS/WASM) target. The worker
    // builds a render-only surface from it (device + the three render buffers) to
    // move the ~10 ms Canvas2D agent draw onto the GPU. maxAgents matches the store
    // (both from cfg.maxAgents); x/y/radius are the static leading SoA fields, so a
    // minimal layout (no hash / field / attrs; gridDepth 1 — A2 render is 2D-only)
    // gives the same bases the render pipeline reads. Only used if the render gate
    // holds main-side (agentRenderEligibleRef); harmless otherwise.
    let agentRenderLayout: AgentWebGPULayout | undefined;
    let agentWebgpuUsesI32Write: boolean | undefined;
    let agentWebgpuUsage: { usesBondStore?: boolean; usesBondStoreWrite?: boolean; usesIndicators?: boolean; usesAux?: boolean; usesSpawn?: boolean; usesStop?: boolean; usesForceScatter?: boolean; usesGeneration?: boolean } | undefined;
    // A1.5 — the per-mapping GPU Agent Output-Mapping colour-pass shaders + whether
    // the whole OM graph compiled (relaxes the WebGPU-target render gate below).
    let agentWebgpuOmShaders: Array<{ mappingId: string; code: string; usesBondStore: boolean; usesBondStoreWrite?: boolean; usesIndicators: boolean; usesAux: boolean; usesGeneration?: boolean }> | undefined;
    let agentWebgpuOmSupported = false;
    let agentLayoutExtras: AgentLayoutExtras | undefined;
    let agentWasmViewerGuardIds: string[] | undefined;
    let agentWasmLayoutSig: { maxHashBins: number; totalBytes: number } | undefined;
    let agentResidencyClean = false;   // PR7c — behaviour-scoped, from the GPU compiler's flags
    if (agentTarget === 'wasm') {
      try {
        const r = compileAgentGraphWasmForModel(m);
        if (r.error || r.bytes.length === 0) {
          // eslint-disable-next-line no-console
          console.warn('[agents] WASM compile fell back to JS:', r.error);
          agentTarget = 'js';
        } else {
          agentWasmBytes = r.bytes;
          agentWasmViewerGuardIds = r.viewerGuardIds;
          // The FULL-COVERAGE layout extras (model attrs / indicators / lookup tables
          // / cell fields / array scratch) — the worker builds the SAME-offset store
          // layout with these (the baked-offset lockstep) + copies the external
          // regions in/out around the WASM call.
          agentLayoutExtras = { ...buildAgentLayoutExtras(m), syncAttrs: m.centerBased?.agentUpdateMode === 'sync' };
          // Layout-lockstep signature: the worker asserts its store layout matches
          // the module's baked layout BEFORE instantiating. A mismatch (any future
          // dims/extras desync) would put the hash / scratch / lookup-table / field
          // regions at DIFFERENT offsets in the store vs the module — silent
          // wrong-offset reads/writes, the baked-offset corruption class.
          agentWasmLayoutSig = { maxHashBins: r.layout.maxHashBins, totalBytes: r.layout.totalBytes };
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[agents] WASM compile threw, falling back to JS:', e);
        agentTarget = 'js';
      }
    } else if (agentTarget === 'webgpu') {
      // PR7 G3-runtime: compile the behaviour shader (the GPU agent loop) + the
      // standalone force-pass shader here (we have the model), and ship both WGSL
      // strings + the GPU agent layout dims to the worker, which builds the
      // dedicated agent WebGPU runtime + dispatches both passes per step. The JS
      // behaviourCode above stays as the fallback (any device/compile failure
      // demotes to JS in the worker).
      try {
        const r = compileAgentGraphWebGPUForModel(m);
        if (r.error || !r.shaderCode) {
          // eslint-disable-next-line no-console
          console.warn('[agents] WebGPU compile fell back to JS:', r.error);
          agentTarget = 'js';
        } else {
          agentWebgpuBehaviourShader = r.shaderCode;
          // The force shader reads the cross-agent force-scatter buffer only when the
          // behaviour graph uses Apply Force To Agent (r.usesForceScatter).
          agentWebgpuForceShader = emitAgentForcePassWGSL(r.layout, r.usesForceScatter);
          agentWebgpuMaxAgents = r.layout.maxAgents;
          agentWebgpuMaxHashBins = r.layout.maxHashBins;
          // Ship the FULL layout (it carries the universal-node region bases —
          // auxF32 / indicators / bondStore / the 3D z fields) so the worker binds
          // + uploads against the EXACT layout the shader compiled to (no recompute
          // mismatch). + the i32-write flag (setAgentType → read_write agentI32).
          agentWebgpuLayout = r.layout;
          agentWebgpuUsesI32Write = r.usesI32Write;
          agentWebgpuUsage = { usesBondStore: r.usesBondStore, usesBondStoreWrite: r.usesBondStoreWrite, usesIndicators: r.usesIndicators, usesAux: r.usesAux, usesSpawn: r.usesSpawn, usesStop: r.usesStop, usesForceScatter: r.usesForceScatter, usesGeneration: r.usesGeneration };
          // A1.5 — the GPU OM colour passes (empty for a no-mapping model). The
          // supported flag lets an OM-coloured WebGPU model engage direct render
          // (the resident batch dispatches the OM pass writing agentColors).
          agentWebgpuOmShaders = (r.omShaders ?? []).map(o => ({ mappingId: o.mappingId, code: o.code, usesBondStore: o.usesBondStore, usesBondStoreWrite: o.usesBondStoreWrite, usesIndicators: o.usesIndicators, usesAux: o.usesAux, usesGeneration: o.usesGeneration }));
          agentWebgpuOmSupported = r.omSupported ?? false;
          // PR7c: residency-clean = the BEHAVIOUR emits no structural-request /
          // radius writes (compiler-scoped — an init-event spawn doesn't block).
          agentResidencyClean = !r.usesStructural && !r.usesRadiusWrite;
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[agents] WebGPU compile threw, falling back to JS:', e);
        agentTarget = 'js';
      }
    }
    // A2: for a CPU (js/wasm) target, ship a minimal render-only GPU agent layout
    // so the worker can build a render-only surface (the direct-render fast path
    // for CPU-simulated agents). Not needed on webgpu (the full runtime renders).
    if (agentTarget !== 'webgpu') {
      // Phase C: a 3D model's render-only surface needs the real depth so the
      // layout carries a `z` field base (the sphere pass reads it). 2D → depth 1.
      const renderDepth = (m.properties.dimension === '3d') ? Math.max(1, Math.floor((m.properties.gridDepth as number) ?? 1)) : 1;
      agentRenderLayout = computeAgentWebGPULayout(
        Math.max(1, Math.floor((m.centerBased?.maxAgents as number) ?? 2000)), 0, undefined, [], { gridDepth: renderDepth },
      );
    }
    return { behaviourCode: ag.behaviourCode || undefined, initCode: ag.initCode || undefined, divisionCode: ag.divisionCode || undefined, outputMappingCodes: ag.outputMappingCodes && ag.outputMappingCodes.length ? ag.outputMappingCodes : undefined, stopMessages: ag.stopMessages, dividePartitions: ag.dividePartitions, colorViewer, error: ag.error || undefined, agentTarget, agentWasmBytes, agentWasmViewerGuardIds, agentLayoutExtras, agentWasmLayoutSig, agentResidencyClean, agentWebgpuBehaviourShader, agentWebgpuForceShader, agentWebgpuMaxAgents, agentWebgpuMaxHashBins, agentWebgpuLayout, agentRenderLayout, agentWebgpuUsesI32Write, agentWebgpuUsage, agentWebgpuOmShaders, agentWebgpuOmSupported };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.agentGraphNodes, model.agentGraphEdges, model.topologyMode?.agents, model.attributes, model.agentAttributes, model.mappings, model.centerBased]);

  // PR5 (C-D1) — does the agent graph touch the cell field? Scan the agent
  // graph for any of the five field nodes (sampleField / fieldGradient /
  // readCellsUnder / affectCellsUnder / secreteToField). The worker uses this
  // to decide whether a WebGPU-grid step needs the per-generation field
  // CPU↔GPU bridge: a no-field model never reads/writes `readAttrs` from the
  // agent loop, so it skips the readback/upload entirely.
  const agentUsesField = useCallback((): boolean => {
    if (!model.topologyMode?.agents) return false;
    const FIELD_NODE_TYPES = new Set(['sampleField', 'fieldGradient', 'readCellsUnder', 'affectCellsUnder', 'secreteToField']);
    // The agent compiler flattens macros up front (expandMacros), so a field node
    // placed INSIDE a macro instance still emits field reads/writes. Scan macro
    // bodies recursively too — otherwise the WebGPU-grid field bridge (the
    // readback/upload around runAgentStep) is skipped and SampleField reads stale
    // / deposits are discarded. `seen` guards against macro recursion.
    const macroDefs = model.macroDefs || [];
    const seen = new Set<string>();
    const scan = (nodes?: typeof model.agentGraphNodes): boolean => {
      for (const n of nodes || []) {
        const t = n.data?.nodeType as string;
        if (FIELD_NODE_TYPES.has(t)) return true;
        if (t === 'macro') {
          const defId = (n.data?.config as Record<string, unknown> | undefined)?.macroDefId as string | undefined;
          if (defId && !seen.has(defId)) {
            seen.add(defId);
            const def = macroDefs.find(d => d.id === defId);
            if (def && scan(def.nodes as typeof model.agentGraphNodes)) return true;
          }
        }
      }
      return false;
    };
    return scan(model.agentGraphNodes);
  }, [model.agentGraphNodes, model.topologyMode?.agents, model.macroDefs]);

  // P1 (the dead density scan): does ANY reachable agent node consume the
  // per-agent density? `neighbourDensity` reads it directly; `divideAgent`'s
  // degenerate-axis fallback reads it in the engine. When false AND engine
  // physics is off, the worker's force pass skips its whole neighbour scan
  // (~70% of a custom-force model's force-pass cost). Same macro-aware scan
  // as agentUsesField (the agent compilers flatten macros up front).
  const agentUsesDensity = useCallback((): boolean => {
    if (!model.topologyMode?.agents) return false;
    const DENSITY_NODE_TYPES = new Set(['neighbourDensity', 'divideAgent']);
    const macroDefs = model.macroDefs || [];
    const seen = new Set<string>();
    const scan = (nodes?: typeof model.agentGraphNodes): boolean => {
      for (const n of nodes || []) {
        const t = n.data?.nodeType as string;
        if (DENSITY_NODE_TYPES.has(t)) return true;
        if (t === 'macro') {
          const defId = (n.data?.config as Record<string, unknown> | undefined)?.macroDefId as string | undefined;
          if (defId && !seen.has(defId)) {
            seen.add(defId);
            const def = macroDefs.find(d => d.id === defId);
            if (def && scan(def.nodes as typeof model.agentGraphNodes)) return true;
          }
        }
      }
      return false;
    };
    return scan(model.agentGraphNodes);
  }, [model.agentGraphNodes, model.topologyMode?.agents, model.macroDefs]);

  // Does ANY rule graph read a COMPUTED (graph / linked) indicator via Get
  // Indicator? Those values are produced once per rendered frame; when a rule
  // consumes one the worker refreshes it once per GENERATION instead, so the
  // number a rule sees can't silently depend on the gens/frame throughput
  // setting. False ⇒ the historical per-batch schedule, zero added cost.
  // Scans BOTH graphs (Get Indicator is universal) and is macro-aware, exactly
  // like agentUsesField / agentUsesDensity.
  const rulesReadComputedIndicator = useCallback((): boolean => {
    const computed = new Set(
      (model.indicators || []).filter(i => i.kind !== 'standalone').map(i => i.id),
    );
    if (computed.size === 0) return false;
    const macroDefs = model.macroDefs || [];
    const seen = new Set<string>();
    const scan = (nodes?: typeof model.graphNodes): boolean => {
      for (const n of nodes || []) {
        const t = n.data?.nodeType as string;
        const cfg = n.data?.config as Record<string, unknown> | undefined;
        if (t === 'getIndicator' && computed.has(cfg?.indicatorId as string)) return true;
        if (t === 'macro') {
          const defId = cfg?.macroDefId as string | undefined;
          if (defId && !seen.has(defId)) {
            seen.add(defId);
            const def = macroDefs.find(d => d.id === defId);
            if (def && scan(def.nodes as typeof model.graphNodes)) return true;
          }
        }
      }
      return false;
    };
    return scan(model.graphNodes) || scan(model.agentGraphNodes as typeof model.graphNodes);
  }, [model.indicators, model.graphNodes, model.agentGraphNodes, model.macroDefs]);

  // Draw using ImageData + zoom/pan transform
  /** Render the CURSOR LAYER — the cell-brush silhouette, the agent-brush
   *  footprint/scan-ring silhouettes (white, on the `cursorNeg` canvas whose CSS
   *  mix-blend-mode: difference produces the negative-cursor look), and the
   *  coloured agent highlight rings (on the `cursorHl` canvas). Extracted OUT of
   *  the scene draw(): cursor movement redraws only these two small layers, so
   *  it can never compete with the play pipeline, and the cursor stays fluid at
   *  display rate even when the simulation steps at 1 fps. Reads the transform
   *  draw() stashed in viewXformRef (scene renders re-call this to stay glued). */
  const drawCursorLayer = useCallback(() => {
    const neg = cursorNegCanvasRef.current;
    const hl = cursorHlCanvasRef.current;
    if (!neg || !hl) return;
    const negCtx = neg.getContext('2d');
    const hlCtx = hl.getContext('2d');
    if (!negCtx || !hlCtx) return;
    const xf = viewXformRef.current;
    const pw = xf?.parentW ?? neg.width, ph = xf?.parentH ?? neg.height;
    if (neg.width !== pw) neg.width = pw;
    if (neg.height !== ph) neg.height = ph;
    if (hl.width !== pw) hl.width = pw;
    if (hl.height !== ph) hl.height = ph;
    negCtx.clearRect(0, 0, pw, ph);
    hlCtx.clearRect(0, 0, pw, ph);
    if (!xf || is3dRef.current) return; // 3D draws its cursor in the GL scene
    const { parentW, parentH, w, h, scale, scaledW, scaledH, ox, oy, infinity, txMin, txMax, tyMin, tyMax } = xf;

    // ── Cell brush cursor — the exact cell-silhouette of the current stamp
    // (rect / circle / ring / line preview), white on the difference layer so
    // it shows as the NEGATIVE of whatever is behind it. One copy per visible
    // tile in infinity mode. Hidden when the brush targets agents.
    const cursor = cursorGrid.current;
    if (cursor && showBrushCursorRef.current && (!isAgentModelRef.current || brushTargetRef.current === 'grid')) {
      const lineAnchor = brushShapeRef.current === 'line' ? lineAnchorRef.current : null;
      let edges: Array<[number, number, number, number]>;
      let baseRow: number, baseCol: number;
      let extentMinDc = 0, extentMaxDc = 0, extentMinDr = 0, extentMaxDr = 0;
      if (lineAnchor) {
        // Two-click line preview: anchor → cursor, torus-folded in infinity so
        // the preview matches what paintLine will commit across a seam.
        let previewEnd = cursor;
        if (infinity && w > 0 && h > 0) {
          let dR = cursor.row - lineAnchor.row;
          let dC = cursor.col - lineAnchor.col;
          if (dR > h / 2) dR -= h; else if (dR < -h / 2) dR += h;
          if (dC > w / 2) dC -= w; else if (dC < -w / 2) dC += w;
          previewEnd = { row: lineAnchor.row + dR, col: lineAnchor.col + dC };
        }
        const cells = lineStampCells(lineAnchor, previewEnd, brushLineWidthRef.current)
          .map(c => [c.row, c.col] as [number, number]);
        edges = cellSilhouetteEdges(cells);
        baseRow = 0; baseCol = 0;
        for (const c of cells) {
          if (c[0] < extentMinDr) extentMinDr = c[0];
          if (c[0] > extentMaxDr) extentMaxDr = c[0];
          if (c[1] < extentMinDc) extentMinDc = c[1];
          if (c[1] > extentMaxDc) extentMaxDc = c[1];
        }
      } else {
        const offsets = currentStampOffsets();
        edges = currentStampEdges();
        baseRow = cursor.row; baseCol = cursor.col;
        for (const o of offsets) {
          if (o[0] < extentMinDr) extentMinDr = o[0];
          if (o[0] > extentMaxDr) extentMaxDr = o[0];
          if (o[1] < extentMinDc) extentMinDc = o[1];
          if (o[1] > extentMaxDc) extentMaxDc = o[1];
        }
      }
      const path = new Path2D();
      for (const [ex0, ey0, ex1, ey1] of edges) {
        path.moveTo(ox + (baseCol + ex0) * scale, oy + (baseRow + ey0) * scale);
        path.lineTo(ox + (baseCol + ex1) * scale, oy + (baseRow + ey1) * scale);
      }
      negCtx.strokeStyle = '#ffffff';
      negCtx.lineWidth = 1.5;
      if (infinity) {
        const stampW = extentMaxDc - extentMinDc + 1;
        const stampH = extentMaxDr - extentMinDr + 1;
        const spanX = Math.max(1, Math.ceil(stampW / w));
        const spanY = Math.max(1, Math.ceil(stampH / h));
        const bx = ox + (baseCol + extentMinDc) * scale;
        const by = oy + (baseRow + extentMinDr) * scale;
        for (let ty = tyMin - spanY; ty <= tyMax + spanY; ty++) {
          for (let tx = txMin - spanX; tx <= txMax + spanX; tx++) {
            const rx = bx + tx * scaledW;
            const ry = by + ty * scaledH;
            if (rx + stampW * scale < 0 || rx > parentW || ry + stampH * scale < 0 || ry > parentH) continue;
            negCtx.save();
            negCtx.translate(tx * scaledW, ty * scaledH);
            negCtx.stroke(path);
            negCtx.restore();
          }
        }
      } else {
        negCtx.stroke(path);
      }
    }

    // ── Agent brush cursor + highlights ──
    if (!isAgentModelRef.current) return;
    const snap = agentsRef.current;
    const hw = snap?.highWater ?? 0;
    const ax = snap?.x, ay = snap?.y, ar = snap?.radius, aal = snap?.alive;
    const cursorW = agentCursorWorldRef.current;
    const mode = agentBrushModeRef.current;
    const aShape = agentBrushShapeRef.current;
    const aScope = (mode === 'move' && aShape === 'line') ? 'single' : agentBrushScopeRef.current;
    const showAgentCursor = brushTargetRef.current === 'agents' && showBrushCursorRef.current;
    // Hovered-agent highlight (Remove = warm/red, else accent).
    const hover = agentHoverIdRef.current;
    if (showAgentCursor && snap && hover >= 0 && hover < hw && aal![hover]) {
      const cx = ox + ax![hover]! * scale, cy = oy + ay![hover]! * scale;
      const rad = Math.max(2, ar![hover]! * scale) + 2;
      hlCtx.beginPath(); hlCtx.arc(cx, cy, rad, 0, Math.PI * 2);
      hlCtx.strokeStyle = mode === 'remove' ? 'rgba(240, 90, 90, 0.95)' : 'rgba(76, 201, 240, 0.95)';
      hlCtx.lineWidth = 2; hlCtx.stroke();
    }
    // Edit target highlight (the single-scope agent picked for editing).
    const editTgt = editTargetIdRef.current;
    if (snap && brushTargetRef.current === 'agents' && mode === 'edit' && aScope === 'single' && editTgt >= 0 && editTgt < hw && aal![editTgt]) {
      const cx = ox + ax![editTgt]! * scale, cy = oy + ay![editTgt]! * scale;
      const rad = Math.max(2, ar![editTgt]! * scale) + 4;
      hlCtx.beginPath(); hlCtx.arc(cx, cy, rad, 0, Math.PI * 2);
      hlCtx.strokeStyle = 'rgba(171, 123, 255, 0.95)'; hlCtx.lineWidth = 2; hlCtx.setLineDash([3, 3]); hlCtx.stroke(); hlCtx.setLineDash([]);
    }
    // Inspected-agent rings (2D) — one per OPEN agent inspector (pinned + the
    // transient sweep), derived per draw from the LIVE snapshot exactly like
    // the 3D pushRing loop, so they track moving agents without touching the
    // popover. Deliberately NOT gated on the brush target or the Show-brush-
    // cursor toggle: an inspector is open regardless of brush state (the 3D
    // rings are equally ungated). The FOLLOWED agent gets a double ring in the
    // accent colour so Follow mode is visible at a glance; other inspected
    // agents get a soft-white ring (matching the 3D white inspect ring, and
    // distinct from the cyan hover / dashed purple edit rings). Primary tile
    // only, like the hover/edit rings.
    if (snap) {
      const followId = followAgentIdRef.current;
      for (const id of agentInspectIdsRef.current) {
        if (id < 0 || id >= hw || !aal![id]) continue;
        const cx = ox + ax![id]! * scale, cy = oy + ay![id]! * scale;
        const rad = Math.max(2, ar![id]! * scale) + 3;
        hlCtx.beginPath(); hlCtx.arc(cx, cy, rad, 0, Math.PI * 2);
        if (id === followId) {
          hlCtx.strokeStyle = 'rgba(232, 161, 58, 0.95)';
          hlCtx.lineWidth = 2; hlCtx.stroke();
          hlCtx.beginPath(); hlCtx.arc(cx, cy, rad + 4, 0, Math.PI * 2);
          hlCtx.strokeStyle = 'rgba(232, 161, 58, 0.5)';
          hlCtx.lineWidth = 1.5; hlCtx.stroke();
        } else {
          hlCtx.strokeStyle = 'rgba(240, 240, 245, 0.9)';
          hlCtx.lineWidth = 2; hlCtx.stroke();
        }
      }
    }
    // Area-affected agents — every agent the current footprint would touch
    // (Remove/Move/Edit, Area scope; Bond's scan disc), colour-coded per mode.
    if (showAgentCursor && snap && ((aScope === 'area' && (mode === 'remove' || mode === 'move' || mode === 'edit')) || mode === 'bond') && agentAreaHoverIdsRef.current.length) {
      const rgb = mode === 'remove' ? '240, 90, 90' : mode === 'edit' ? '171, 123, 255' : mode === 'bond' ? '38, 198, 218' : '76, 201, 240';
      hlCtx.save();
      hlCtx.strokeStyle = `rgba(${rgb}, 0.95)`;
      hlCtx.fillStyle = `rgba(${rgb}, 0.22)`;
      hlCtx.lineWidth = 1.5;
      for (const id of agentAreaHoverIdsRef.current) {
        if (id < 0 || id >= hw || !aal![id]) continue;
        const cx = ox + ax![id]! * scale, cy = oy + ay![id]! * scale;
        const rad = Math.max(2, ar![id]! * scale) + 2;
        hlCtx.beginPath(); hlCtx.arc(cx, cy, rad, 0, Math.PI * 2); hlCtx.fill(); hlCtx.stroke();
      }
      hlCtx.restore();
    }
    // Area footprint cursor — the shape outline at the cursor (negative layer).
    const footprintMode = mode === 'add' || mode === 'remove' || mode === 'edit' || mode === 'move';
    if (showAgentCursor && cursorW && aScope === 'area' && footprintMode) {
      const R = agentBrushRadiusRef.current, ringW = Math.max(1, agentBrushRingWidthRef.current);
      const hWd = agentBrushWRef.current / 2, hHt = agentBrushHRef.current / 2;
      const lineAnchor = agentLineAnchorRef.current;
      const drawShape = (tileOx: number, tileOy: number) => {
        const cx = tileOx + cursorW.x * scale, cy = tileOy + cursorW.y * scale;
        if (aShape === 'rect') {
          negCtx.strokeRect(cx - hWd * scale, cy - hHt * scale, hWd * 2 * scale, hHt * 2 * scale);
        } else if (aShape === 'line') {
          if (lineAnchor) {
            const ax0 = tileOx + lineAnchor.x * scale, ay0 = tileOy + lineAnchor.y * scale;
            negCtx.save(); negCtx.lineCap = 'round'; negCtx.lineWidth = Math.max(1, agentBrushLineWidthRef.current * scale);
            negCtx.beginPath(); negCtx.moveTo(ax0, ay0); negCtx.lineTo(cx, cy); negCtx.stroke(); negCtx.restore();
          } else {
            const rr = Math.max(1, agentBrushLineWidthRef.current / 2) * scale;
            negCtx.beginPath(); negCtx.arc(cx, cy, rr, 0, Math.PI * 2); negCtx.stroke();
          }
        } else if (aShape === 'ring') {
          negCtx.beginPath(); negCtx.arc(cx, cy, Math.max(0, R + ringW / 2) * scale, 0, Math.PI * 2); negCtx.stroke();
          negCtx.beginPath(); negCtx.arc(cx, cy, Math.max(0, R - ringW / 2) * scale, 0, Math.PI * 2); negCtx.stroke();
        } else if (R > 0) { // circle
          negCtx.beginPath(); negCtx.arc(cx, cy, R * scale, 0, Math.PI * 2); negCtx.stroke();
        }
      };
      negCtx.save();
      negCtx.strokeStyle = '#ffffff';
      negCtx.lineWidth = 1.5;
      negCtx.setLineDash(mode === 'remove' ? [5, 4] : []);
      if (infinity) {
        for (let ty = tyMin; ty <= tyMax; ty++) for (let tx = txMin; tx <= txMax; tx++) drawShape(ox + tx * scaledW, oy + ty * scaledH);
      } else { drawShape(ox, oy); }
      negCtx.setLineDash([]);
      negCtx.restore();
    }
    // Bond scan-radius cursor — a dashed circle of the scan radius (negative layer).
    if (showAgentCursor && mode === 'bond' && cursorW && agentBrushRadiusRef.current > 0) {
      const rr = agentBrushRadiusRef.current * scale;
      negCtx.save();
      negCtx.strokeStyle = '#ffffff';
      negCtx.lineWidth = 1.5;
      negCtx.setLineDash([2, 3]);
      const drawRing = (tileOx: number, tileOy: number) => {
        const cx = tileOx + cursorW.x * scale, cy = tileOy + cursorW.y * scale;
        if (cx + rr < 0 || cx - rr > parentW || cy + rr < 0 || cy - rr > parentH) return;
        negCtx.beginPath(); negCtx.arc(cx, cy, rr, 0, Math.PI * 2); negCtx.stroke();
      };
      if (infinity) {
        for (let ty = tyMin; ty <= tyMax; ty++) for (let tx = txMin; tx <= txMax; tx++) drawRing(ox + tx * scaledW, oy + ty * scaledH);
      } else { drawRing(ox, oy); }
      negCtx.setLineDash([]);
      negCtx.restore();
    }
    // Glue/Cut staged-anchor ring + a dashed line to the cursor (highlight layer).
    const anchor = agentGlueAnchorRef.current;
    if (snap && anchor >= 0 && anchor < hw && aal![anchor]) {
      const cx = ox + ax![anchor]! * scale, cy = oy + ay![anchor]! * scale;
      const rad = Math.max(2, ar![anchor]! * scale) + 3;
      if (cursorW) {
        hlCtx.beginPath(); hlCtx.moveTo(cx, cy);
        hlCtx.lineTo(ox + cursorW.x * scale, oy + cursorW.y * scale);
        hlCtx.strokeStyle = 'rgba(232, 161, 58, 0.6)'; hlCtx.lineWidth = 1.5; hlCtx.setLineDash([4, 3]); hlCtx.stroke(); hlCtx.setLineDash([]);
      }
      hlCtx.beginPath(); hlCtx.arc(cx, cy, rad, 0, Math.PI * 2);
      hlCtx.strokeStyle = 'rgba(232, 161, 58, 0.95)'; hlCtx.lineWidth = 2; hlCtx.setLineDash([4, 3]); hlCtx.stroke(); hlCtx.setLineDash([]);
    }
  }, []);

  // A1 — compute the agent RenderView (camera + tiling + graphics) from the SAME
  // draw math as the 2D blit. highWater is patched worker-side (free mode ships
  // no snapshot, so the main thread can't know it) — send 0 here.
  // Phase C: the 3D sphere-pass uniform — MVP (from the SAME sceneCameraMatrices
  // gl3d uses, so projection can't disagree) + camera basis + world light + uHalf +
  // bg. The MAIN thread computes it so the two renderers stay in lockstep.
  const computeAgentRenderView3D = useCallback((): AgentRenderView3D | null => {
    const glc = glCanvasRef.current;
    const w = gridWidth.current, h = gridHeight.current, d = gridDepth.current;
    if (!glc || !w || !h) return null;
    const cssW = glc.clientWidth || glc.parentElement?.clientWidth || 500;
    const cssH = glc.clientHeight || glc.parentElement?.clientHeight || 500;
    const cam = cam3dRef.current;
    const m = sceneCameraMatrices(cam, cssW / (cssH || 1), w, h, d);
    const light = light3dRef.current;
    const L = lightWorldDirFor(light, m.dir, m.right, m.up);
    let bgR = 0, bgG = 0, bgB = 0, bgA = 0;
    const bg = bg3dRef.current;   // [r,g,b,a] (0..1) | null (transparent → page shows)
    if (bg) { bgR = bg[0]!; bgG = bg[1]!; bgB = bg[2]!; bgA = bg[3]!; }
    return {
      mode: '3d',
      mvp: Array.from(m.mvp),
      halfX: (w - 1) / 2, halfY: (h - 1) / 2, halfZ: (d - 1) / 2,
      camRightX: m.right[0], camRightY: m.right[1], camRightZ: m.right[2],
      camUpX: m.up[0], camUpY: m.up[1], camUpZ: m.up[2],
      camForwardX: m.forward[0], camForwardY: m.forward[1], camForwardZ: m.forward[2],
      lightX: L[0], lightY: L[1], lightZ: L[2],
      ambient: light.ambient, diffuse: light.diffuse, specular: light.specular,
      outlineOn: agentOutlinesRef.current ? 1 : 0,
      bgR, bgG, bgB, bgA,
    };
  }, []);

  const computeAgentRenderView = useCallback((): AgentRenderView | AgentRenderView3D | null => {
    if (is3dRef.current) return computeAgentRenderView3D();
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const w = gridWidth.current, h = gridHeight.current;
    if (!w || !h) return null;
    const parentW = canvas.parentElement?.clientWidth ?? 500;
    const parentH = canvas.parentElement?.clientHeight ?? 500;
    const zoom = zoomRef.current, pan = panRef.current;
    const baseScale = Math.min(parentW / w, parentH / h);
    const scale = baseScale * zoom;
    const scaledW = w * scale, scaledH = h * scale;
    const ox = (parentW - scaledW) / 2 + pan.x;
    const oy = (parentH - scaledH) / 2 + pan.y;
    const infinity = infinityCanvasRef.current && boundaryTreatmentRef.current === 'torus';
    let startX = 0, startY = 0, copiesX = 1, copiesY = 1;
    if (infinity && scaledW > 0 && scaledH > 0) {
      const txMin = Math.floor(-ox / scaledW);
      const txMax = Math.floor((parentW - ox) / scaledW);
      const tyMin = Math.floor(-oy / scaledH);
      const tyMax = Math.floor((parentH - oy) / scaledH);
      const tileCount = (txMax - txMin + 1) * (tyMax - tyMin + 1);
      if (tileCount <= 256) { startX = txMin; startY = tyMin; copiesX = txMax - txMin + 1; copiesY = tyMax - tyMin + 1; }
    }
    const glow = agentGlowRef.current;
    let bgR = 0, bgG = 0, bgB = 0, bgA = 0;
    // D: when the CA grid LAYER shows (decoupled grid+agents), the grid IS the
    // background — the agent canvas must clear TRANSPARENT so the grid blitted
    // below shows through, even when bg2d is set. Mirrors the showGrid2d bg-fill
    // suppression in draw(). bg2d applies only when the grid layer is hidden
    // (agents-only, or "Show CA grid" off).
    const showGrid2d = gridCellsOnRef.current && (!isAgentModelRef.current || showCaGridRef.current);
    if (!showGrid2d && bg2dRef.current) { const c = hexToRgba(bg2dRef.current); bgR = c.r / 255; bgG = c.g / 255; bgB = c.b / 255; bgA = 1; }
    const view: AgentRenderView = {
      highWater: 0,
      scalePx: scale, oxPx: ox, oyPx: oy, canvasW: parentW, canvasH: parentH,
      worldW: w, worldH: h,
      copiesX, copiesY, startX, startY,
      outlineOn: agentOutlinesRef.current ? 1 : 0,
      glowOn: glow.on ? 1 : 0, glowSize: glow.size, glowIntensity: glow.intensity, glowSteepness: glow.steepness,
      bgR, bgG, bgB, bgA,
    };
    // E2 DISPLAY-res composite: the canvas is display-sized and the worker draws the
    // grid layer (its FS inverts THIS camera → cell → colorsBuf, NEAREST) then the
    // agent discs (this same camera) — so agents render at DISPLAY resolution (crisp
    // at any zoom). The composite only ADDS the per-layer Show flags + the torus
    // (grid-plane wrap) flag; the camera/tiling/bg above are shared with A1. When the
    // grid layer is hidden the bg2d fill (bgA above) becomes the composite backdrop.
    if (agentCompositeActiveRef.current) {
      view.showGrid = showGrid2d;
      view.showAgents = !!showAgentsRef.current;
      view.torus = infinity;
    }
    return view;
  }, []);

  // Post the agent camera to the worker, rAF-coalesced + deduped (skip when the
  // view is unchanged — a plain step doesn't move the camera, and setAgentCamera
  // triggers a present, so a per-frame post would double the render cost).
  const postAgentCamera = useCallback(() => {
    if (!agentDirectRenderActiveRef.current || !workerRef.current) return;
    if (agentCameraRafRef.current) return;
    agentCameraRafRef.current = requestAnimationFrame(() => {
      agentCameraRafRef.current = 0;
      const view = computeAgentRenderView();
      if (!view || !workerRef.current || !agentDirectRenderActiveRef.current) return;
      const v3 = view as AgentRenderView3D, v2 = view as AgentRenderView;
      const key = v3.mode === '3d'
        ? '3d|' + v3.mvp.join(',') + `|${v3.camForwardX}|${v3.lightX}|${v3.lightY}|${v3.lightZ}|${v3.ambient}|${v3.diffuse}|${v3.specular}|${v3.outlineOn}|${v3.bgR}|${v3.bgG}|${v3.bgB}|${v3.bgA}|${v3.halfX}|${v3.halfY}|${v3.halfZ}`
        : `${v2.scalePx}|${v2.oxPx}|${v2.oyPx}|${v2.canvasW}|${v2.canvasH}|${v2.startX}|${v2.startY}|${v2.copiesX}|${v2.copiesY}|${v2.outlineOn}|${v2.glowOn}|${v2.glowSize}|${v2.glowIntensity}|${v2.glowSteepness}|${v2.bgR}|${v2.bgG}|${v2.bgB}|${v2.bgA}|${v2.showGrid ? 1 : 0}|${v2.showAgents ? 1 : 0}`;
      if (key === lastAgentCameraKeyRef.current) return;
      lastAgentCameraKeyRef.current = key;
      workerRef.current.postMessage({ type: 'setAgentCamera', view });
      // Re-blit AFTER the worker's camera-triggered present lands (double-rAF —
      // the grid's compositor-lag trick). Without this the FIRST valid present
      // after attach is never blitted: at load the ack-time draw() blits the
      // attach present (made with a null camera → zero uniform → black), the
      // camera post then presents the real frame into the placeholder, and no
      // draw follows until the next stepped/interaction — the reported
      // "black on load until Play or a mouse move".
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (agentDirectRenderActiveRef.current) drawRef.current();
      }));
    });
  }, [computeAgentRenderView]);

  // A1 UI-sync driver: while ON the worker reads GPU agent state back each frame
  // and ships the render snapshot (features that need CPU state); while OFF the
  // resident batch free-runs. ON iff a feature is (or may be) reading agent
  // state: paused, recording, a pinned/sweep inspector, an edit target, the agent
  // brush armed + hovering, or a CPU-only visual (metaballs) suppressing direct
  // render. Debounced OFF by ~300 ms so brush strokes don't thrash.
  const updateAgentUiSync = useCallback(() => {
    if (!agentDirectRenderActiveRef.current || !workerRef.current) return;
    const want =
      !playingRef.current
      || recordingRef.current
      || agentInspectIdsRef.current.length > 0
      || sweepActiveRef.current
      || editTargetIdRef.current >= 0
      || agentMetaballsRef.current.enabled
      // Vision-cone display reads the agent snapshot every frame.
      || showVisionRef.current !== 'off'
      || (brushTargetRef.current === 'agents' && agentCursorWorldRef.current != null)
      // Phase C: 3D agent brush armed + pointer over the gl canvas → frame mode so
      // the gl3d pick FBO (reads the snapshot) resolves agents.
      || (is3dRef.current && brushTargetRef.current === 'agents' && glPointerOverRef.current);
    const w = workerRef.current;
    if (want) {
      if (agentUiSyncTimerRef.current) { clearTimeout(agentUiSyncTimerRef.current); agentUiSyncTimerRef.current = 0; }
      if (!agentUiSyncPostedRef.current) { agentUiSyncPostedRef.current = true; w.postMessage({ type: 'setAgentUiSync', on: true }); }
    } else if (agentUiSyncPostedRef.current && !agentUiSyncTimerRef.current) {
      agentUiSyncTimerRef.current = window.setTimeout(() => {
        agentUiSyncTimerRef.current = 0;
        if (agentUiSyncPostedRef.current) { agentUiSyncPostedRef.current = false; workerRef.current?.postMessage({ type: 'setAgentUiSync', on: false }); }
      }, 300);
    }
  }, []);

  // (Re)attach the agent render canvas: transfer a display-sized OffscreenCanvas
  // and ask the worker to set up direct render. Safe to call whenever the agent
  // WebGPU runtime is up (initial attach on agentRuntimeReady; re-attach on a
  // display resize or a CPU-visual toggle change). No-op unless eligible + idle.
  // `reattach = true` = a display-resize re-attach while the render is STILL
  // active: the caller keeps showing the old (still worker-presented) canvas
  // until the ack commits the fresh one — never a stale-CPU fallback gap.
  const maybeAttachAgentCanvas = useCallback((reattach = false) => {
    if (!agentRenderEligibleRef.current || agentMetaballsRef.current.enabled) return;
    // M1 (audit): the gate's MODEL-dependent terms (sprites / an agent OM whose
    // graph the GPU can't compile) can change on a SOFT recompile, which never
    // re-runs the full gate — the soft-recompile path refreshes this ref, and it
    // suppresses the attach exactly like the metaballs check above.
    if (!agentRenderModelTermsOkRef.current) return;
    // Phase C: 3D alpha-blend needs back-to-front sorting (gl3d's job), so a 3D
    // alpha-blend-on model stays on the CPU/frame path — don't attach.
    if (is3dRef.current && alpha3dRef.current) return;
    if ((agentDirectRenderActiveRef.current && !reattach) || pendingAgentRenderCanvas.current) return;
    const worker = workerRef.current, canvas = canvasRef.current;
    if (!worker || !canvas) return;
    if (is3dRef.current) {
      // Phase C: append a FRESH DOM canvas into the sphere layer (UNDER the gl
      // canvas), transfer its control to the worker, and let the browser composite
      // it (no blit). A fresh element each attach handles transfer-once + resize +
      // recompile. Buffer resolution = CSS px × dpr (matches gl overlays' crispness);
      // the MVP aspect is CSS px, resolution-independent.
      const layer = agentSphereLayerRef.current;
      if (!layer) return;
      const cssW = Math.max(1, layer.clientWidth || canvas.parentElement?.clientWidth || 500);
      const cssH = Math.max(1, layer.clientHeight || canvas.parentElement?.clientHeight || 500);
      const dpr = window.devicePixelRatio || 1;
      const bw = Math.max(1, Math.round(cssW * dpr)), bh = Math.max(1, Math.round(cssH * dpr));
      try {
        // The PRIOR sphere canvas (if any) STAYS in the DOM and keeps
        // compositing the worker's presents until the ack COMMITS the fresh one
        // (which removes it) — a resize re-attach must never show a stale/blank
        // gap. Dead-canvas paths (runtime rebuild) remove it explicitly in the
        // agentRuntimeReady handler.
        const fresh = document.createElement('canvas');
        fresh.width = bw; fresh.height = bh;
        fresh.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:none';
        layer.appendChild(fresh);
        const offscreen = (fresh as HTMLCanvasElement & { transferControlToOffscreen: () => OffscreenCanvas }).transferControlToOffscreen();
        pendingAgentRenderCanvas.current = fresh;
        agentRenderCanvasDimsRef.current = { w: cssW, h: cssH };
        worker.postMessage({ type: 'attachAgentCanvas', canvas: offscreen, width: bw, height: bh }, [offscreen]);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[agents] 3D sphere canvas transfer failed; staying on CPU overlay:', e);
        pendingAgentRenderCanvas.current = null;
      }
      return;
    }
    // E2 DISPLAY-res composite: the transferred canvas is DISPLAY-sized (same as the
    // A1 render) — the worker draws the grid layer (its FS inverts the camera to
    // sample colorsBuf) AND the agent discs through the SAME display-res camera into
    // it, so agents are crisp discs at any zoom and the main thread blits the canvas
    // 1:1. A display resize needs a fresh re-attach (transferred canvas dims are
    // fixed), exactly like the standard A1 render.
    const composite = !!agentCompositeEligibleRef.current;
    const dispW = Math.max(1, canvas.parentElement?.clientWidth ?? canvas.clientWidth ?? 500);
    const dispH = Math.max(1, canvas.parentElement?.clientHeight ?? canvas.clientHeight ?? 500);
    const cw = dispW;
    const ch = dispH;
    try {
      const fresh = document.createElement('canvas');
      fresh.width = cw; fresh.height = ch;
      const offscreen = (fresh as HTMLCanvasElement & { transferControlToOffscreen: () => OffscreenCanvas }).transferControlToOffscreen();
      pendingAgentRenderCanvas.current = fresh;
      pendingAgentCompositeRef.current = composite;
      agentRenderCanvasDimsRef.current = { w: dispW, h: dispH };
      worker.postMessage({ type: 'attachAgentCanvas', canvas: offscreen, width: cw, height: ch, composite }, [offscreen]);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[agents] OffscreenCanvas transfer failed; staying on CPU overlay:', e);
      pendingAgentRenderCanvas.current = null;
    }
  }, []);

  // L1 — the voxel-render camera/lighting/clip uniform. Computed on the MAIN
  // thread from the SAME sceneCameraMatrices + lightWorldDirFor helpers gl3d
  // itself uses, so the WGSL cubes and the gl3d overlays can never disagree on
  // projection or lighting. Every field mirrors a gl3d uniform (see its VS/FS).
  const computeVoxelRenderView = useCallback((): VoxelRenderView | null => {
    const glc = glCanvasRef.current;
    const w = gridWidth.current, h = gridHeight.current, d = gridDepth.current;
    if (!glc || !w || !h) return null;
    const cssW = glc.clientWidth || glc.parentElement?.clientWidth || 500;
    const cssH = glc.clientHeight || glc.parentElement?.clientHeight || 500;
    const m = sceneCameraMatrices(cam3dRef.current, cssW / (cssH || 1), w, h, d);
    const light = light3dRef.current;
    const L = lightWorldDirFor(light, m.dir, m.right, m.up);
    const clip = clip3dRef.current;
    const axisN = clip.axis === 'x' ? 0 : clip.axis === 'y' ? 1 : clip.axis === 'z' ? 2 : 3;
    // gl3d's setCellGaps: ON = the historical 0.92 cube, OFF = flush (1.001).
    const cubeScale = cellGaps3dRef.current ? 0.92 : 1.001;
    let bgR = 0, bgG = 0, bgB = 0, bgA = 0;
    const bg = bg3dRef.current;
    if (bg) { bgR = bg[0]!; bgG = bg[1]!; bgB = bg[2]!; bgA = bg[3]!; }
    // Cast-shadow light matrix + scale-relative bias (only when shadows are on;
    // computeLightMVP is the SHARED helper gl3d's own shadow pass delegates to).
    let shadowStrength = 0, shadowBias = 0;
    let lightMVP: number[] = [];
    if (light.shadows) {
      const lm = computeLightMVP(w, h, d, L);
      lightMVP = Array.from(lm.lightMVP);
      shadowStrength = light.shadowStrength;
      // Mirror gl3d: uShadowBias = min(0.02, max(0.0002, 0.9/depthRange)).
      shadowBias = Math.min(0.02, Math.max(0.0002, 0.9 / (lm.depthRange || 1)));
    }
    return {
      mvp: Array.from(m.mvp),
      halfX: (w - 1) / 2, halfY: (h - 1) / 2, halfZ: (d - 1) / 2,
      lightX: L[0], lightY: L[1], lightZ: L[2],
      viewX: m.dir[0], viewY: m.dir[1], viewZ: m.dir[2],
      clipFwdX: m.forward[0], clipFwdY: m.forward[1], clipFwdZ: m.forward[2],
      ambient: light.ambient, diffuse: light.diffuse, specular: light.specular,
      cubeScale,
      clipLo: clip.lo, clipHi: clip.hi,
      clipEnabled: clip.enabled ? 1 : 0,
      clipAxis: axisN,
      bgR, bgG, bgB, bgA,
      // gl3d's buriedCullEligible(): flush cubes + opaque + no open clip.
      cullBuried: (!alpha3dRef.current && !clip.enabled && cubeScale >= 1) ? 1 : 0,
      // Occupancy AO: 0 when off ⇒ the cube shader folds no darkening (byte-
      // behaviour-identical to no AO). gl3d gates the same on light.ao.
      aoStrength: light.ao ? light.aoStrength : 0,
      // Cast shadows: the shared computeLightMVP (GL convention) + the scale-
      // relative bias, exactly mirroring gl3d. 0 strength ⇒ the shader short-
      // circuits + the worker skips the depth pass ⇒ byte-identical to no shadows.
      shadowStrength,
      shadowBias,
      lightMVP,
    };
  }, []);

  // Post the voxel camera to the worker, rAF-coalesced + deduped (a plain step
  // doesn't move the camera, and setGridCamera triggers a present, so a per-frame
  // post would double the render cost).
  const postGridCamera = useCallback(() => {
    if (!voxelRenderActiveRef.current || !workerRef.current) return;
    if (gridCameraRafRef.current) return;
    gridCameraRafRef.current = requestAnimationFrame(() => {
      gridCameraRafRef.current = 0;
      const view = computeVoxelRenderView();
      if (!view || !workerRef.current || !voxelRenderActiveRef.current) return;
      const key = view.mvp.join(',')
        + `|${view.lightX}|${view.lightY}|${view.lightZ}|${view.ambient}|${view.diffuse}|${view.specular}`
        + `|${view.clipEnabled}|${view.clipAxis}|${view.clipLo}|${view.clipHi}|${view.cubeScale}`
        + `|${view.bgR}|${view.bgG}|${view.bgB}|${view.bgA}|${view.cullBuried}`
        + `|${view.halfX}|${view.halfY}|${view.halfZ}|${view.viewX}|${view.viewY}|${view.viewZ}`
        + `|${view.aoStrength}|${view.shadowStrength}|${view.shadowBias}|${view.lightMVP.join(',')}`;
      if (key === lastGridCameraKeyRef.current) return;
      lastGridCameraKeyRef.current = key;
      workerRef.current.postMessage({ type: 'setGridCamera', view });
    });
  }, [computeVoxelRenderView]);

  // L1 — thread the scene-wireframe toggles (bounds/grid/axes) to the worker's
  // voxel renderer, which now draws them depth-tested against the cubes (so they
  // occlude in free mode). gl3d stops drawing those three in its overlaysOnly
  // path; the gizmo / brush plane / hover / axis labels stay in gl3d (on top).
  const postGridViz = useCallback(() => {
    if (!voxelRenderActiveRef.current || !workerRef.current) return;
    const v = viz3dRef.current;
    workerRef.current.postMessage({ type: 'setGridViz', axes: v.axes, grid: v.grid, bounds: v.bounds });
  }, []);

  // L1 UI-sync driver (the grid sibling of updateAgentUiSync). ON = the worker
  // reads colours back each frame and ships them, so gl3d renders the full frame
  // (and its colour-id pick FBO resolves). ON iff a feature is — or may be —
  // reading the CPU colours: recording, an inspect popover pinned/sweeping,
  // a POINTER GESTURE that can pick, OR alpha blend is enabled (the only remaining
  // frame-mode-only visual — the WGSL pass does not back-to-front sort; occupancy
  // AO [Phase 1] and cast shadows [Phase 2] now run free-mode). Debounced OFF ~300 ms.
  //
  // NB the pointer term is deliberately NARROW. Pinning on bare `glPointerOverRef`
  // (the shipped L1 driver) meant simply RESTING the cursor over the canvas held
  // the readback path for as long as it sat there, so a user watching their model
  // run saw no speedup at all — reported as "same performance while my cursor is on
  // the canvas". Nothing about passive hovering needs CPU state: the brush cursor
  // and the brush itself are pure `pickOnPlane` ray math, and a paint refreshes +
  // re-presents through the worker's own mutation tail. The one thing that DOES
  // need it is gl3d's colour-id `pick()` (3D inspect), which reads the CPU instance
  // buffer only frame mode refreshes — so pin for the states in which a pick can
  // fire: an in-progress PICKING gesture (press→release; a camera orbit/pan/zoom
  // or a brush stroke is NOT one — see onDown), the Inspect toggle armed while
  // hovering, or Shift held while hovering (the Shift+LMB inspect gesture, whose
  // pick happens on the RELEASE — pressing the modifier first gives the flip its
  // frame). The AGENT driver's hover term is already this narrow (it ANDs an armed
  // agent brush) and is intentionally left untouched.
  const updateGridUiSync = useCallback(() => {
    if (!voxelRenderActiveRef.current || !workerRef.current) return;
    // NB `!playing` is deliberately NOT a term. Pausing needs no CPU colours by
    // itself — the worker-presented canvas is already showing the current frame
    // and keeps tracking the camera — but flipping costs a full colour readback
    // (108 MB at 300³) plus the main thread's O(total) uploadColors rescan, which
    // is the visible hitch on every pause and, worse, on every stop-condition
    // halt (the user hits it without having asked for anything). Everything a
    // paused user can do that genuinely reads CPU colours has its OWN term below
    // — inspect (a pinned popover / sweep / a picking gesture / Inspect armed /
    // Shift held), recording, and the frame-mode-only visuals — so the cost is
    // now paid at the moment it buys something instead of on every halt.
    const want =
      recordingRef.current
      || inspectCellIdxsRef.current.length > 0
      || sweepActiveRef.current
      || glGestureActiveRef.current
      || (glPointerOverRef.current && (inspectModeRef.current || glShiftDownRef.current))
      || alpha3dRef.current;
    const w = workerRef.current;
    if (want) {
      if (gridUiSyncTimerRef.current) { clearTimeout(gridUiSyncTimerRef.current); gridUiSyncTimerRef.current = 0; }
      if (!gridUiSyncPostedRef.current) {
        gridUiSyncPostedRef.current = true;
        gridFrameAwaitingColorsRef.current = true;
        w.postMessage({ type: 'setGridUiSync', on: true });
      }
    } else if (gridUiSyncPostedRef.current && !gridUiSyncTimerRef.current) {
      gridUiSyncTimerRef.current = window.setTimeout(() => {
        gridUiSyncTimerRef.current = 0;
        if (gridUiSyncPostedRef.current) {
          gridUiSyncPostedRef.current = false;
          workerRef.current?.postMessage({ type: 'setGridUiSync', on: false });
        }
      }, 300);
    }
  }, []);

  // A direct-render ATTACH FAILED (the ack came back inactive), so the display
  // falls back to the CPU paths — whose data free mode deliberately let go stale.
  // Force the sync ON so the worker ships fresh snapshots / colours (the OFF→ON
  // handlers ship one immediately, even paused). The normal drivers early-return
  // while the render is inactive, so this one-shot ON sticks — a permanent CPU
  // fallback stays LIVE instead of frozen on an ancient frame. Mirrors are only
  // assigned in the same statement as the post (the UI-sync mirror invariant).
  const forceAgentUiSyncOn = useCallback(() => {
    const w = workerRef.current;
    if (!w) return;
    if (agentUiSyncTimerRef.current) { clearTimeout(agentUiSyncTimerRef.current); agentUiSyncTimerRef.current = 0; }
    if (!agentUiSyncPostedRef.current) { agentUiSyncPostedRef.current = true; w.postMessage({ type: 'setAgentUiSync', on: true }); }
  }, []);
  const forceGridUiSyncOn = useCallback(() => {
    const w = workerRef.current;
    if (!w) return;
    if (gridUiSyncTimerRef.current) { clearTimeout(gridUiSyncTimerRef.current); gridUiSyncTimerRef.current = 0; }
    if (!gridUiSyncPostedRef.current) {
      gridUiSyncPostedRef.current = true;
      gridFrameAwaitingColorsRef.current = true;
      w.postMessage({ type: 'setGridUiSync', on: true });
    }
  }, []);

  // (Re)attach the voxel render canvas: append a FRESH DOM canvas into the voxel
  // layer (UNDER the gl canvas), transfer its control, and ask the worker to build
  // the pipelines. A fresh element each attach handles transfer-once + resize +
  // runtime rebuild. No-op unless eligible + idle.
  // `reattach = true` = a display-resize re-attach while the render is STILL
  // active (see maybeAttachAgentCanvas — same keep-the-old-canvas contract).
  const maybeAttachVoxelCanvas = useCallback((reattach = false) => {
    if (!voxelRenderEligibleRef.current) return;
    if ((voxelRenderActiveRef.current && !reattach) || pendingVoxelCanvas.current) return;
    const worker = workerRef.current, layer = voxelLayerRef.current;
    if (!worker || !layer) return;
    const glc = glCanvasRef.current;
    const cssW = Math.max(1, layer.clientWidth || glc?.parentElement?.clientWidth || 500);
    const cssH = Math.max(1, layer.clientHeight || glc?.parentElement?.clientHeight || 500);
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.max(1, Math.round(cssW * dpr)), bh = Math.max(1, Math.round(cssH * dpr));
    try {
      // The PRIOR voxel canvas (if any) STAYS in the DOM and keeps compositing
      // the worker's presents until the ack COMMITS the fresh one (which removes
      // it) — a resize re-attach must never show a stale/blank gap.
      const fresh = document.createElement('canvas');
      fresh.width = bw; fresh.height = bh;
      fresh.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:none';
      layer.appendChild(fresh);
      const offscreen = (fresh as HTMLCanvasElement & { transferControlToOffscreen: () => OffscreenCanvas }).transferControlToOffscreen();
      pendingVoxelCanvas.current = fresh;
      voxelCanvasDimsRef.current = { w: cssW, h: cssH };
      worker.postMessage({ type: 'attachVoxelCanvas', canvas: offscreen, width: bw, height: bh }, [offscreen]);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[webgpu] voxel canvas transfer failed; staying on the readback path:', e);
      pendingVoxelCanvas.current = null;
    }
  }, []);

  // L1 — capture the 3D scene as ImageData for screenshot / recording. In FRAME
  // mode gl3d holds everything, so this is the historical readPixels. In FREE mode
  // the volume lives in the worker's voxel canvas UNDERNEATH gl3d's overlays-only
  // output, so the capture must COMPOSITE the two — otherwise a screenshot taken
  // mid-run would be overlays over nothing. (A transferred canvas is still a valid
  // CanvasImageSource — the 2D direct-render blit relies on the same property.)
  const capture3dPixels = useCallback((): { data: Uint8ClampedArray; width: number; height: number } | null => {
    const r = gl3dRef.current;
    if (!r) return null;
    const px = r.readPixels();
    const vc = voxel3DActiveRef.current ? voxelCanvasRef.current : null;
    if (!vc) return px;
    let scratch = capture3dScratchRef.current;
    if (!scratch) { scratch = document.createElement('canvas'); capture3dScratchRef.current = scratch; }
    if (scratch.width !== px.width || scratch.height !== px.height) { scratch.width = px.width; scratch.height = px.height; }
    // A CPU-backed scratch: getImageData on a LIVE canvas de-optimises it
    // permanently (the recording-slowdown lesson) — this one is never displayed.
    const sctx = scratch.getContext('2d', { willReadFrequently: true });
    if (!sctx) return px;
    sctx.clearRect(0, 0, px.width, px.height);
    sctx.drawImage(vc, 0, 0, px.width, px.height);
    // putImageData REPLACES (no compositing), so route the overlay pixels through
    // an intermediate canvas and drawImage them so their alpha blends.
    let ov = capture3dOverlayRef.current;
    if (!ov) { ov = document.createElement('canvas'); capture3dOverlayRef.current = ov; }
    if (ov.width !== px.width || ov.height !== px.height) { ov.width = px.width; ov.height = px.height; }
    const octx = ov.getContext('2d');
    if (!octx) return px;
    octx.putImageData(new ImageData(px.data, px.width, px.height), 0, 0);
    sctx.drawImage(ov, 0, 0);
    return { data: sctx.getImageData(0, 0, px.width, px.height).data, width: px.width, height: px.height };
  }, []);

  const draw = useCallback(() => {
    // Bottom-band collision re-check (capture cluster vs the CENTRED transport
    // bar). The container's width is what moves the bar's centre relative to the
    // right-anchored cluster, and draw() already runs on every layout change
    // (panel resize / collapse, window resize, tab switch), so this is the one
    // trigger that is guaranteed to fire — the ResizeObserver in the effect is
    // belt-and-braces. `clientWidth` on an already-laid-out element is cheap and
    // the actual rect measurement only runs when the width really changed.
    const capW = canvasAreaRef.current?.clientWidth ?? 0;
    if (capW && capW !== captureCollisionWidthRef.current) {
      captureCollisionWidthRef.current = capW;
      measureCaptureCollisionRef.current?.();
    }

    // 3D Grid CA: render the voxel volume via WebGL2 instead of the 2D blit.
    // Everything is read via refs (this callback has empty deps + ~20 call sites).
    if (is3dRef.current && gl3dRef.current) {
      const r = gl3dRef.current;
      const glc = glCanvasRef.current;
      const colors3d = colorsRef.current;
      const w3 = gridWidth.current, h3 = gridHeight.current, d3 = gridDepth.current;
      // NB: colors3d may legitimately be null forever in an agents-only model
      // (the worker never ships a colors buffer when the CA grid is off) —
      // agents/bonds/overlays must still render, so don't early-return on it.
      if (!glc || !w3 || !h3) return;
      const cssW = glc.clientWidth || glc.parentElement?.clientWidth || 500;
      const cssH = glc.clientHeight || glc.parentElement?.clientHeight || 500;
      // Phase C — 3D agent free-mode direct render. When the worker composites the
      // WGSL sphere impostors into the sibling canvas UNDER this one (free mode),
      // gl3d renders ONLY the overlays (transparent clear). Frame mode (UI-sync ON:
      // interaction / recording / pause) hides the sphere canvas + does the full
      // render from the snapshot, exactly as today.
      let agent3dActive = isAgentModelRef.current && agentDirectRenderActiveRef.current && !!agentSphereCanvasRef.current;
      if (agent3dActive) {
        const dims = agentRenderCanvasDimsRef.current;
        // Re-attach only on a REAL size change (an occluded pane measures 0×0 — the
        // A1/A2 storm guard). A fresh transferred canvas is needed (dims are fixed).
        if ((dims.w !== cssW || dims.h !== cssH) && cssW >= 2 && cssH >= 2) {
          // Re-attach WITHOUT falling back — the OLD sphere canvas is CSS-
          // stretched (width/height 100%) and keeps compositing the worker's
          // presents until the ack commits the fresh one. Flipping to the gl3d
          // snapshot path here rendered an ANCIENT snapshot (free mode) — the
          // reported frozen-frame-on-panel-resize.
          maybeAttachAgentCanvas(true);
        }
      }
      // FRAME mode (gl3d full render from the snapshot) requires a snapshot IN HAND
      // — arming a feature posts UI-sync ON but the snapshot arrives ~1 frame later,
      // so keep showing the spheres (FREE) until agentsRef is populated. This makes
      // the flip seamless (no blank frame) and also handles UI-sync flipping OFF
      // (agentsRef goes stale / uiSync false → back to spheres). The worker keeps the
      // sphere canvas fresh even while hidden (the resident batch presents in both
      // modes), so flipping visibility back is instant.
      const agent3dFrame = agent3dActive && agentUiSyncPostedRef.current && agentsRef.current != null;
      const agent3dFree = agent3dActive && !agent3dFrame;
      // L1 — the CA-grid analogue: when the worker's WGSL voxel pass owns the
      // display (free mode) gl3d renders overlays only and we skip uploadColors
      // entirely. FRAME mode requires a colours buffer IN HAND (and one that
      // arrived AFTER the flip — see gridFrameAwaitingColorsRef), so the flip is
      // seamless and can never show a colours snapshot from thousands of
      // generations ago. Mutually exclusive with the agent path (the L1 gate
      // excludes agent models), so the two never fight over overlays-only.
      let voxelActive = voxelRenderActiveRef.current && !!voxelCanvasRef.current;
      if (voxelActive) {
        const dims = voxelCanvasDimsRef.current;
        // Re-attach only on a REAL size change (an occluded pane measures 0×0 —
        // the A1/A2 attach-storm guard). The transferred canvas has fixed dims.
        if ((dims.w !== cssW || dims.h !== cssH) && cssW >= 2 && cssH >= 2) {
          // Re-attach WITHOUT falling back — the OLD voxel canvas is CSS-
          // stretched and keeps compositing the worker's presents until the ack
          // commits the fresh one. Flipping to the gl3d colours path here
          // rendered ANCIENT colours (free mode ships none) — the reported
          // frozen-frame-on-panel-resize (Accretor-class models).
          maybeAttachVoxelCanvas(true);
        }
      }
      const voxelFrame = voxelActive
        && gridUiSyncPostedRef.current && !gridFrameAwaitingColorsRef.current && colors3d != null;
      const voxelFree = voxelActive && !voxelFrame;
      // wireframesExternal = voxelFree ONLY: the worker's voxel renderer draws
      // the bounds/grid/axes itself (depth-tested); the agent-sphere free mode
      // has no worker line pass, so gl3d must keep drawing them on top.
      r.setOverlaysOnly(agent3dFree || voxelFree, voxelFree);
      { const sc = agentSphereCanvasRef.current; if (sc) sc.style.display = agent3dFree ? 'block' : 'none'; }
      { const vc = voxelCanvasRef.current; if (vc) vc.style.display = voxelFree ? 'block' : 'none'; }
      agentSphere3DActiveRef.current = agent3dFree;
      voxel3DActiveRef.current = voxelFree;
      // Keep the worker's voxel camera synced (rAF-coalesced + deduped) whenever
      // the voxel canvas exists, so a flip back to free shows the current view.
      if (voxelActive) postGridCamera();
      // Keep the worker's sphere camera synced (rAF-coalesced + deduped) whenever the
      // sphere canvas exists, so a flip back to free shows the current viewpoint.
      if (agent3dActive) postAgentCamera();
      r.resize(cssW, cssH, window.devicePixelRatio || 1);
      r.setGrid(w3, h3, d3);
      r.setAlphaBlend(alpha3dRef.current);
      r.setAgentsInFront(agentsFront3dRef.current);
      r.setClipPlane(clip3dRef.current);
      // Render-layer toggles (req 7): voxels/agents come from the show refs, not
      // the panel's viz3d (which only edits axes/grid/bounds/gizmo). Gating the
      // DRAW (in render()), not the upload below, keeps the GPU buffers current.
      // Forced visible for a non-agent model (the toggles are global but only
      // editable on an agent model — else a stale `false` would blank the grid).
      // Agents render ONLY for an agent model (topologyMode.agents). Using
      // `!isAgentModelRef.current || …` (draw for non-agent models too) let stale
      // agent instances from a PREVIOUSLY-loaded agent model keep rendering after
      // loading a non-agent model (the gl3d agent buffer is only refreshed inside
      // the `if (isAgentModelRef.current)` block below). Gate on the agent flag.
      r.setViz({ ...viz3dRef.current, voxels: !isAgentModelRef.current || showCaGridRef.current, agents: isAgentModelRef.current && showAgentsRef.current, bonds: showBondsRef.current });
      r.setBrushPlane(plane3dEnabledRef.current ? { axis: plane3dRef.current.axis, pos: plane3dRef.current.pos } : null);
      r.setHoverCells(plane3dEnabledRef.current ? hoverCells3dRef.current : EMPTY_HOVER_CELLS);
      r.setInspectCells(inspectHighlight3dRef.current);
      // Brush footprint OUTLINE cursor — a bounded analytic wireframe on the
      // interaction plane, for the grid brush AND the agent brush. Shown only when
      // the plane is on, the cursor toggle is on, and a plane cell is hovered.
      {
        const hc = hover3dRef.current;
        if (hc && plane3dEnabledRef.current && showBrushCursorRef.current) {
          const isAgentBrush = isAgentModelRef.current && brushTargetRef.current === 'agents';
          const vol = brush3dVolumeRef.current;
          let shp: 'rect' | 'circle' | 'ring' | 'line';
          let bw: number, bh: number, rad: number, rw: number, lw: number, fixedHalf = 0;
          let anchor: { col: number; row: number; layer: number } | null;
          if (isAgentBrush) {
            const m = agentBrushModeRef.current;
            shp = agentBrushShapeRef.current;
            bw = agentBrushWRef.current; bh = agentBrushHRef.current;
            rad = agentBrushRadiusRef.current; rw = Math.max(1, agentBrushRingWidthRef.current); lw = agentBrushLineWidthRef.current;
            anchor = agentLine3dAnchorRef.current;
            if (m === 'bond') { shp = 'circle'; }                                // scan-radius ring
            else if (m === 'glue' || m === 'cut') { shp = 'circle'; rad = 1; anchor = null; }  // small cursor dot
            // The 3D agent footprint is ALWAYS a volumetric solid (sphere/box through
            // the depth — see agentsInShape3dAt / agentSeedInShape3dAt), NOT gated on
            // the CA-grid-only "Volumetric Brush" toggle. So the outline is always
            // volumetric, matching the agents the stroke will actually affect.
            else if (shp === 'circle' || shp === 'ring') fixedHalf = Math.max(0.5, rad);
            else if (shp === 'rect') fixedHalf = Math.max(bw, bh) / 2;
          } else {
            shp = brushShapeRef.current;
            bw = brushWRef.current; bh = brushHRef.current;
            rad = brushRadiusRef.current; rw = Math.max(1, brushRingWidthRef.current); lw = brushLineWidthRef.current;
            anchor = line3dAnchorRef.current;
            if (vol) { if (shp === 'circle' || shp === 'ring') fixedHalf = Math.max(0.5, rad); else if (shp === 'rect') fixedHalf = brushBoxDepthRef.current / 2; }
          }
          r.setBrushOutline(buildBrushOutline3dSegs({
            axis: plane3dRef.current.axis, cx: hc.col, cy: hc.row, cz: hc.layer,
            shape: shp, halfW: bw / 2, halfH: bh / 2, radius: rad, ringW: rw, lineW: lw, fixedHalf, anchor,
          }));
        } else r.setBrushOutline(null);
      }
      r.setBackgroundColor(bg3dRef.current);
      r.setLight(light3dRef.current);
      r.setCellGaps(cellGaps3dRef.current);
      r.setMetaballs(agentMetaballsRef.current);
      r.setCamera(cam3dRef.current, r.canvasWidth / (r.canvasHeight || 1));
      // 3D perf: only re-scan + re-upload the (potentially millions of) cells when
      // the colours actually changed (a new buffer from a `stepped` message).
      // Camera-only redraws reuse the existing GPU instance buffer.
      // L1: in free mode the GPU owns the volume — skip the O(total) CPU rescan
      // + instance upload entirely (at 300³ that alone was ~220 ms/frame).
      if (voxelFree) {
        // Nothing to do: the worker presented the frame into the voxel canvas.
      } else if (colors3d) {
        if (colors3d !== lastUploadedColors3dRef.current) {
          r.uploadColors(colors3d, w3 * h3 * d3);
          lastUploadedColors3dRef.current = colors3d;
        }
      } else {
        // No colours buffer — drop any stale voxel instances instead of drawing
        // the previous grid forever. Keyed on the RENDERER's live instance count,
        // NOT on lastUploadedColors3dRef: a model-load reinit clears BOTH refs
        // (colorsRef + lastUploaded) before the new worker's first message, so a
        // ref-keyed guard never fired and an agents-only model loaded after a
        // voxel model kept rendering the previous model's grid (the reported
        // cross-model state leak: Life3D's voxels under Morphogenesis's agents).
        // clearVoxels also drops the renderer's stashed colours source so a
        // later buried-cull eligibility flip (clip/blend/gaps toggle) can't
        // resurrect the stale grid from it.
        if (r.instanceCount > 0) r.clearVoxels();
        lastUploadedColors3dRef.current = null;
      }
      // Bond-Graph Agents (PR5): overlay the agent spheres + bonds via the
      // instanced sphere-impostor pipeline. Only re-compact the SoA when the
      // snapshot identity changed (a new `stepped` buffer); camera-only frames
      // reuse the GPU instance buffer. highWater===0 → 0 instances directly.
      if (isAgentModelRef.current) {
        const snap = agentsRef.current;
        r.setAgentAlphaBlend(alpha3dRef.current);
        r.setAgentOutlines(agentOutlinesRef.current);
        // (Re)build the sprite atlas when the sprite set / decoded frames changed
        // (registry onReady / sprite-set edit / fresh renderer). Must precede
        // uploadAgents (which reads the atlas slot meta) and force a re-upload so
        // the sprite buffer reflects the new atlas even without a new snapshot.
        if (spriteAtlasDirtyRef.current) {
          const reg = spriteRegistryRef.current, metas = spriteMetaRef.current;
          const atlas: SpriteAtlasInput[] = [];
          if (reg) {
            for (let si = 0; si < metas.length; si++) {
              const m = metas[si]!;
              const dec = reg.get(m.id);
              if (dec && dec.frames.length > 0) {
                atlas.push({ slot: si + 1, frames: dec.frames, loop: m.loop, defaultDirection: m.defaultDirection, rotationOffset: m.rotationOffset, orientToVelocity: m.orientToVelocity, scale: m.scale });
              }
            }
          }
          r.setSpriteAtlas(atlas);
          spriteAtlasDirtyRef.current = false;
          lastUploadedAgentSnapRef.current = null; // force re-upload with the new atlas
        }
        if (!snap || snap.highWater === 0) {
          r.clearAgents(); // spheres AND bond lines (a bare instanceCount=0 leaves stale bonds)
          lastUploadedAgentSnapRef.current = snap ?? null;
        } else if (snap !== lastUploadedAgentSnapRef.current) {
          r.uploadAgents(snap, boundaryTreatmentRef.current === 'torus');
          lastUploadedAgentSnapRef.current = snap;
        }
        r.setHoverAgents(hoverAgents3dRef.current);
        // White highlight rings — DERIVED FROM THE LIVE SNAPSHOT EVERY FRAME,
        // never cached. A cached ring array froze each ring at the position the
        // agent had when its popover opened, so the ring only caught up when
        // something happened to re-run the (now deleted) sync helper. Deriving
        // here makes draw() the ONE writer, so there is nothing to keep in step.
        // Cost is O(open popovers) — a handful of ids per frame.
        const rings: Array<{ x: number; y: number; z: number; radius: number }> = [];
        if (snap) {
          const hasZ = snap.z.length > 0;
          const pushRing = (id: number) => {
            if (id < 0 || id >= snap.highWater || !snap.alive[id]) return;
            for (const rr of rings) if (rr.x === snap.x[id] && rr.y === snap.y[id] && rr.radius === snap.radius[id]) return;
            rings.push({ x: snap.x[id]!, y: snap.y[id]!, z: hasZ ? snap.z[id]! : 0, radius: snap.radius[id]! });
          };
          // Every open agent inspector (pinned + the transient sweep).
          for (const id of agentInspectIdsRef.current) pushRing(id);
          // The single-scope Edit target, under EXACTLY the condition its 2D
          // dashed highlight and its vision cone use (see drawCursorLayer), so
          // the ring appears/disappears with them instead of lingering after a
          // brush-mode switch.
          if (brushTargetRef.current === 'agents' && agentBrushModeRef.current === 'edit'
              && agentBrushScopeRef.current === 'single') pushRing(editTargetIdRef.current);
          // A staged Glue/Cut anchor keeps its persistent ring.
          pushRing(agentGlueAnchorRef.current);
        }
        r.setInspectAgents(rings);
      } else if (r.agentInstanceCount !== 0 || r.hasAgentGeometry) {
        // Non-agent model: drop any agent spheres AND bond lines left over from a
        // previously loaded agent model so they don't linger in the volume (the
        // gl3d agent buffer is only refreshed by the branch above).
        r.clearAgents();
        lastUploadedAgentSnapRef.current = null;
      }
      r.render();
      fpsFrames.current++;
      return;
    }
    const canvas = canvasRef.current;
    const colors = colorsRef.current;
    const w = gridWidth.current;
    const h = gridHeight.current;
    if (!canvas || !w || !h) return;
    // P7 direct render: srcCanvas is populated by the worker via WebGPU, so
    // we don't need a CPU `colors` buffer to draw. Without direct render, a
    // missing colors buffer means we have nothing to display yet — EXCEPT for
    // an agent model, where the worker may never ship colors at all (CA grid
    // off) and the agents overlay must still draw.
    if (!colors && !directRenderActiveRef.current && !isAgentModelRef.current) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Canvas fills available space. Setting canvas.width / .height resets the
    // backing store — one of the slowest browser operations and the dominant
    // per-frame cost on the play hot path. Only re-assign when dimensions
    // ACTUALLY changed (parent resize, panel collapse, etc).
    const parentW = canvas.parentElement?.clientWidth ?? 500;
    const parentH = canvas.parentElement?.clientHeight ?? 500;
    if (canvas.width !== parentW) canvas.width = parentW;
    if (canvas.height !== parentH) canvas.height = parentH;

    // Build 1:1 pixel source from RGBA buffer.
    // P7 direct render: when the canvas was transferred to the worker, the
    // OffscreenCanvas already holds the latest GPU-rendered frame — skip
    // putImageData (and DON'T recreate, since transferControlToOffscreen has
    // moved ownership of the 2D context).
    if (directRenderActiveRef.current && srcCanvasRef.current) {
      // canvas dimensions are fixed at transfer time; nothing to do here.
    } else if (colors && colors.length >= w * h * 4) {
      if (!srcCanvasRef.current || srcCanvasRef.current.width !== w || srcCanvasRef.current.height !== h) {
        srcCanvasRef.current = document.createElement('canvas');
        srcCanvasRef.current.width = w;
        srcCanvasRef.current.height = h;
      }
      const srcCtx = srcCanvasRef.current.getContext('2d')!;
      const imageData = new ImageData(
        new Uint8ClampedArray(colors.buffer, colors.byteOffset, w * h * 4),
        w, h,
      );
      srcCtx.putImageData(imageData, 0, 0);
    }

    // Clear and apply zoom/pan
    ctx.clearRect(0, 0, parentW, parentH);
    ctx.imageSmoothingEnabled = false;

    const zoom = zoomRef.current;
    const pan = panRef.current;

    // Default scale: fit grid in canvas
    const baseScale = Math.min(parentW / w, parentH / h);
    const scale = baseScale * zoom;
    const scaledW = w * scale;
    const scaledH = h * scale;

    // Center the grid + apply pan offset
    const ox = (parentW - scaledW) / 2 + pan.x;
    const oy = (parentH - scaledH) / 2 + pan.y;

    // Infinity canvas: tile the grid bitmap across the viewport. Only engaged when
    // the toggle is on AND the model uses torus boundary — otherwise we'd render a
    // tiled image that lies about the simulation physics.
    const infinity = infinityCanvasRef.current && boundaryTreatmentRef.current === 'torus';

    // Soft cap: at extreme zoom-out (cells << 1px) the tile count explodes. Beyond
    // ~256 visible tiles we draw only the centre tile to keep per-frame cost bounded.
    let txMin = 0, txMax = 0, tyMin = 0, tyMax = 0;
    if (infinity && scaledW > 0 && scaledH > 0) {
      txMin = Math.floor(-ox / scaledW);
      txMax = Math.floor((parentW - ox) / scaledW);
      tyMin = Math.floor(-oy / scaledH);
      tyMax = Math.floor((parentH - oy) / scaledH);
      const tileCount = (txMax - txMin + 1) * (tyMax - tyMin + 1);
      if (tileCount > 256) {
        txMin = txMax = tyMin = tyMax = 0;
      }
    }

    // Stash the scene transform for the cursor overlay layer (drawn on its own
    // canvases — see drawCursorLayer). Every scene render refreshes it, so the
    // layer is always consistent with the last-drawn pan/zoom/tiling.
    viewXformRef.current = { parentW, parentH, w, h, scale, scaledW, scaledH, ox, oy, infinity, txMin, txMax, tyMin, tyMax };

    // Per-cell glyph overlay. Drawn AFTER the colour blit (so glyphs sit on
    // top of cell colours) but BEFORE gridlines and brush cursor (so those
    // remain crisp on top of glyphs). Skipped entirely when no glyph data
    // arrived for this frame OR cells are too small to read (<6px default;
    // configurable via genesisca_sim_settings.glyphMinPx).
    const drawGlyphOverlay = () => {
      const codes = glyphCodesRef.current;
      const cols = glyphColorsRef.current;
      if (!codes || !cols) return;
      const minPx = glyphMinPxRef.current;
      if (scale < minPx) return;
      const tileSize = Math.max(2, Math.round(scale));
      // Visible cell range. We compute once per (tile origin) for the infinity
      // path; for the non-infinity path tx=ty=0 only.
      const drawForTile = (tileOx: number, tileOy: number) => {
        const colMin = Math.max(0, Math.floor((0 - tileOx) / scale));
        const colMax = Math.min(w - 1, Math.ceil((parentW - tileOx) / scale));
        const rowMin = Math.max(0, Math.floor((0 - tileOy) / scale));
        const rowMax = Math.min(h - 1, Math.ceil((parentH - tileOy) / scale));
        if (colMin > colMax || rowMin > rowMax) return;
        for (let row = rowMin; row <= rowMax; row++) {
          const rowBase = row * w;
          const screenY = Math.round(tileOy + row * scale);
          for (let col = colMin; col <= colMax; col++) {
            const i = rowBase + col;
            const cp = codes[i]!;
            if (cp === 0) continue;
            const packed = cols[i]!;
            const r = packed & 0xff;
            const g = (packed >> 8) & 0xff;
            const b = (packed >> 16) & 0xff;
            const tile = getGlyphTile(cp, r, g, b, tileSize);
            const screenX = Math.round(tileOx + col * scale);
            ctx.drawImage(tile, screenX, screenY, tileSize, tileSize);
          }
        }
      };
      if (infinity) {
        for (let ty = tyMin; ty <= tyMax; ty++) {
          for (let tx = txMin; tx <= txMax; tx++) {
            drawForTile(ox + tx * scaledW, oy + ty * scaledH);
          }
        }
      } else {
        drawForTile(ox, oy);
      }
    };

    // Bond-Graph Agents — overlay the live agents as filled circles on top of
    // the grid. Agent (x,y) are in CELL units (the agent world is the grid
    // frame 1:1), so they share the cell→screen transform: cx = ox + x*scale.
    // Radius scales with the cell pixel size. Drawn over the colour blit; tiled
    // in infinity mode like the grid.
    const drawAgentsOverlay = () => {
      if (!isAgentModelRef.current) return;
      const snap = agentsRef.current;
      if (!snap || snap.highWater === 0) return;
      const { x: ax, y: ay, radius: ar, alive: aal, colors: acol, highWater: hw, bonds, vx: avx, vy: avy } = snap;
      // Bond layer — drawn UNDER the agent circles (one batched stroke path).
      if (showBondsRef.current && bonds && bonds.length > 0) {
        const torusB = boundaryTreatmentRef.current === 'torus';
        const drawBonds = (tileOx: number, tileOy: number) => {
          ctx.beginPath();
          for (let b = 0; b < bonds.length; b += 2) {
            const i = bonds[b]!, j = bonds[b + 1]!;
            // Draw j relative to i along the torus-shortest path so a seam-
            // crossing bond is a short segment, not a long line across the grid.
            let jx = ax[j]!, jy = ay[j]!;
            if (torusB && w > 0 && h > 0) {
              if (jx - ax[i]! > w / 2) jx -= w; else if (jx - ax[i]! < -w / 2) jx += w;
              if (jy - ay[i]! > h / 2) jy -= h; else if (jy - ay[i]! < -h / 2) jy += h;
            }
            ctx.moveTo(tileOx + ax[i]! * scale, tileOy + ay[i]! * scale);
            ctx.lineTo(tileOx + jx * scale, tileOy + jy * scale);
          }
          ctx.strokeStyle = 'rgba(230, 230, 245, 0.55)';
          ctx.lineWidth = Math.max(1, scale * 0.18);
          ctx.stroke();
        };
        if (infinity) {
          for (let ty = tyMin; ty <= tyMax; ty++) for (let tx = txMin; tx <= txMax; tx++) drawBonds(ox + tx * scaledW, oy + ty * scaledH);
        } else { drawBonds(ox, oy); }
      }
      // Sprites (optional exhibition layer): when the active agent OM pass wrote a
      // per-agent sprite slot, draw the sprite's current frame instead of a circle.
      // spriteIds is length-0 for non-sprite models (then everyone draws a circle).
      const sids = snap.spriteIds, sfr = snap.spriteFrames;
      // Per-agent facing angle + size override (Set Agent Sprite). Length-0 on
      // older snapshots / non-sprite models → treated as absent (default 0).
      const srot = snap.spriteRotations, sscl = snap.spriteScales;
      const spriteMeta = spriteMetaRef.current;
      const reg = spriteRegistryRef.current;
      const spritesActive = !!reg && spriteMeta.length > 0 && sids.length === hw;
      // Agent metaballs (2D): draw the NON-sprite agents as solid discs into an
      // offscreen scratch, blit it through the gooey SVG filter (blur + a steep
      // alpha threshold) so nearby agents FUSE — a view-space approximation of
      // the 3D implicit surface — then draw sprite-agents on top. Falls back to
      // plain circles when ctx.filter is unsupported. The scratch is drawn-to
      // only (never getImageData'd — no willReadFrequently de-opt).
      const mbCfg = agentMetaballsRef.current;
      let gooCtx: CanvasRenderingContext2D | null = null;
      if (mbCfg.enabled && typeof ctx.filter === 'string') {
        let sc = gooScratchRef.current;
        if (!sc) { sc = document.createElement('canvas'); gooScratchRef.current = sc; }
        if (sc.width !== parentW) sc.width = parentW;
        if (sc.height !== parentH) sc.height = parentH;
        gooCtx = sc.getContext('2d');
        gooCtx?.clearRect(0, 0, parentW, parentH);
      }
      // pass 'all' = the classic path (circles + sprites straight to ctx);
      // 'goo' = circles only, into the goo scratch; 'sprites' = sprites only.
      const stamp = (tileOx: number, tileOy: number, pass: 'all' | 'goo' | 'sprites') => {
        for (let i = 0; i < hw; i++) {
          if (!aal[i]) continue;
          const cx = tileOx + ax[i]! * scale;
          const cy = tileOy + ay[i]! * scale;
          const rad = Math.max(1.2, ar[i]! * scale);
          if (cx + rad < 0 || cx - rad > parentW || cy + rad < 0 || cy - rad > parentH) continue;
          const c = i * 4;
          // --- sprite branch ---
          if (spritesActive) {
            const slot = sids[i]!; // 1-based index into model.sprites (0 = none)
            const meta = slot > 0 ? spriteMeta[slot - 1] : undefined;
            const dec = meta ? reg!.get(meta.id) : undefined;
            if (dec && dec.frames.length > 0) {
              if (pass === 'goo') continue; // sprite-agents are excluded from the goo field
              const fc = dec.frames.length;
              // The per-agent frame is persistent + engine-advanced (Set Agent
              // Sprite drove the speed). Floor + wrap (loop) or clamp (once).
              const raw = Math.floor(sfr[i]!);
              const frame = fc <= 1 ? 0
                : meta!.loop ? (((raw % fc) + fc) % fc)
                : (raw < 0 ? 0 : raw >= fc ? fc - 1 : raw);
              const bmp = dec.frames[frame]!;
              // Per-agent size override (Set Agent Sprite → Set scale) wins over
              // the sprite asset's default scale; 0 = use the default.
              const perAgentScale = sscl.length === hw && sscl[i]! > 0 ? sscl[i]! : (meta!.scale || 1);
              const target = rad * 2 * perAgentScale;
              const aspect = bmp.width / Math.max(1, bmp.height);
              let dw = target, dh = target;
              if (aspect >= 1) dh = target / aspect; else dw = target * aspect;
              // Facing angle (compass degrees, 0 = up, clockwise): the agent's
              // velocity heading when orientToVelocity is on AND it's moving,
              // otherwise the per-agent rotation the node set (default 0 = up).
              // Aligned to the art's default direction + a fixed offset. ctx.rotate
              // is clockwise in screen coords (y down).
              let facingDeg = srot.length === hw ? srot[i]! : 0;
              if (meta!.orientToVelocity) {
                const vX = avx[i]!, vY = avy[i]!;
                if (vX * vX + vY * vY > 1e-9) facingDeg = Math.atan2(vX, -vY) * 180 / Math.PI;
              }
              const rotDeg = (facingDeg - meta!.defaultDirection) + meta!.rotationOffset;
              ctx.globalAlpha = (acol[c + 3] ?? 255) / 255;
              if (rotDeg !== 0) {
                ctx.save();
                ctx.translate(cx, cy);
                ctx.rotate(rotDeg * Math.PI / 180);
                ctx.drawImage(bmp, -dw / 2, -dh / 2, dw, dh);
                ctx.restore();
              } else {
                ctx.drawImage(bmp, cx - dw / 2, cy - dh / 2, dw, dh);
              }
              ctx.globalAlpha = 1;
              continue; // sprite replaces the circle
            }
            // slot set but not yet decoded (or deleted) → fall through to the circle
          }
          if (pass === 'sprites') continue;  // circles already drawn in the goo pass
          const tc = pass === 'goo' ? gooCtx! : ctx;
          tc.beginPath();
          tc.arc(cx, cy, rad, 0, Math.PI * 2);
          tc.fillStyle = `rgba(${acol[c]},${acol[c + 1]},${acol[c + 2]},${acol[c + 3]! / 255})`;
          tc.fill();
          if (pass !== 'goo' && rad >= 2 && agentOutlinesRef.current) {  // no outline inside the goo field
            // Constant contour width (was rad * 0.14, which grew with the agent):
            // capped by a fraction of the radius so tiny discs aren't all outline.
            tc.lineWidth = Math.min(1.5, rad * 0.25);
            tc.strokeStyle = 'rgba(0,0,0,0.40)';
            tc.stroke();
          }
        }
      };
      const forTiles = (pass: 'all' | 'goo' | 'sprites') => {
        if (infinity) {
          for (let ty = tyMin; ty <= tyMax; ty++)
            for (let tx = txMin; tx <= txMax; tx++)
              stamp(ox + tx * scaledW, oy + ty * scaledH, pass);
        } else {
          stamp(ox, oy, pass);
        }
      };
      // Batched fast path for the plain-circles case ('all' pass, no sprites, no
      // goo scratch, every agent fully opaque): the per-agent beginPath+arc+fill+
      // stroke above costs 4 canvas state changes per dot — at Particle-Life-scale
      // populations (5-10k small dots) that rivals the sim step. Group agents by
      // (packed RGB, radius rounded to 0.1px) and draw each group as ONE path:
      // one beginPath, one arc per agent, ONE fill (+ ONE stroke when rad >= 2).
      // Opaque same-colour overlaps composite pixel-identically batched or not;
      // TRANSLUCENT discs do NOT (a batched union composites once where per-disc
      // draws stack), so any alpha < 255 bails to the per-agent loop. Returns
      // null when ineligible (translucent agent found).
      const buildOpaqueGroups = (): Map<number, number[]> | null => {
        const groups = new Map<number, number[]>();
        for (let i = 0; i < hw; i++) {
          if (!aal[i]) continue;
          const c = i * 4;
          if (acol[c + 3] !== 255) return null; // translucency → slow path
          const rad = Math.max(1.2, ar[i]! * scale);
          const radKey = Math.min(99999, Math.round(rad * 10));
          const key = ((acol[c]! << 16) | (acol[c + 1]! << 8) | acol[c + 2]!) * 100000 + radKey;
          let arr = groups.get(key);
          if (!arr) { arr = []; groups.set(key, arr); }
          arr.push(i);
        }
        return groups;
      };
      // P2 point-splat: below this projected radius a filled SQUARE is visually
      // a dot, and rect() subpaths skip arc tessellation entirely — the arc walk
      // was the dominant cost of the batched path at Particle-Life populations
      // (measured ~25 ms/frame at 50k discs). Kept strictly below the ≥2px
      // outline-stroke threshold so splat groups never stroke squares.
      const SPLAT_MAX_RAD = 2;
      const stampBatchedTile = (tileOx: number, tileOy: number, groups: Map<number, number[]>) => {
        for (const [key, idxs] of groups) {
          const packed = Math.floor(key / 100000);
          const groupRad = (key % 100000) / 10;
          const splat = groupRad < SPLAT_MAX_RAD;
          ctx.beginPath();
          let any = false;
          for (let k = 0; k < idxs.length; k++) {
            const i = idxs[k]!;
            const cx = tileOx + ax[i]! * scale;
            const cy = tileOy + ay[i]! * scale;
            const rad = Math.max(1.2, ar[i]! * scale);
            if (cx + rad < 0 || cx - rad > parentW || cy + rad < 0 || cy - rad > parentH) continue;
            if (splat) {
              ctx.rect(cx - rad, cy - rad, rad * 2, rad * 2);
            } else {
              ctx.moveTo(cx + rad, cy); // break the subpath — else arc() draws a chord from the previous arc's end
              ctx.arc(cx, cy, rad, 0, Math.PI * 2);
            }
            any = true;
          }
          if (!any) continue;
          ctx.fillStyle = `rgb(${(packed >> 16) & 0xff},${(packed >> 8) & 0xff},${packed & 0xff})`;
          ctx.fill();
          if (groupRad >= 2 && agentOutlinesRef.current) {
            ctx.lineWidth = Math.min(1.5, groupRad * 0.25);
            ctx.strokeStyle = 'rgba(0,0,0,0.40)';
            ctx.stroke();
          }
        }
      };
      if (gooCtx) {
        forTiles('goo');
        // Fusion range: the blur σ scales with the mean agent pixel radius ×
        // (influence − 1); the alpha threshold is centred at 0.5 (which keeps a
        // LONE agent at roughly its drawn size — the 2D analogue of the 3D auto
        // threshold) and shifts with the user's threshold relative to that auto
        // value, so both knobs mirror the 3D semantics (approximately).
        let radSum = 0, radN = 0, alphaSum = 0;
        for (let i = 0; i < hw; i++) if (aal[i]) { radSum += ar[i]!; radN++; alphaSum += (acol[i * 4 + 3] ?? 255); }
        const avgRadPx = radN > 0 ? Math.max(1.2, (radSum / radN) * scale) : 4;
        // Mean agent alpha → the blob's translucency. The goo filter's threshold
        // matrix re-hardens the per-disc alpha toward 0/1 (that's what makes
        // discs FUSE), so per-agent alpha dies inside the filter — the fused
        // blob is re-composited at the population's mean alpha instead (the 2D
        // analogue of the 3D blob's density-weighted mean; always on, like the
        // plain 2D discs — no toggle in 2D).
        const meanAlpha = radN > 0 ? alphaSum / (radN * 255) : 1;
        const sigma = Math.max(0.6, (mbCfg.influence - 1) * avgRadPx * 0.85);
        // An isolated blurred disc's PEAK alpha decays as σ grows (the blur
        // redistributes its mass), so a fixed alpha threshold would make lone
        // agents vanish at high influence. Anchor the threshold to that peak —
        // the 2D analogue of the 3D auto-threshold: at the auto value a lone
        // agent stays ≈ its own size at ANY influence, while clusters (whose
        // blurred alphas SUM past the anchor in the gaps) fuse.
        const peak = 1 - Math.exp(-(avgRadPx * avgRadPx) / (2 * sigma * sigma));
        const anchor = 0.5 * peak;
        const tSvg = Math.min(0.92, Math.max(0.03, anchor + (mbCfg.threshold - metaballAutoThreshold(mbCfg.influence)) * 0.55 * peak));
        const S = Math.min(60, Math.max(14, 8 / Math.max(0.02, anchor)));  // slope (edge sharpness) — steeper for small anchors
        const goo = ensureGooFilter();
        goo.blur.setAttribute('stdDeviation', sigma.toFixed(2));
        goo.matrix.setAttribute('values', `1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 ${S.toFixed(1)} ${(0.5 - S * tSvg).toFixed(3)}`);
        // The mean-alpha translucency rides the filter's FADE stage — NOT
        // ctx.globalAlpha, which Chromium silently ignores on a drawImage routed
        // through an SVG url(#…) filter (measured; see makeGooFade).
        goo.fade.setAttribute('values', `1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 ${meanAlpha.toFixed(4)} 0`);
        ctx.save();
        ctx.filter = `url(#${GOO_FILTER_ID})`;
        ctx.drawImage(gooScratchRef.current!, 0, 0);
        ctx.restore();
        if (spritesActive) forTiles('sprites');
      } else {
        const groups = spritesActive ? null : buildOpaqueGroups();
        if (groups) {
          if (infinity) {
            for (let ty = tyMin; ty <= tyMax; ty++)
              for (let tx = txMin; tx <= txMax; tx++)
                stampBatchedTile(ox + tx * scaledW, oy + ty * scaledH, groups);
          } else {
            stampBatchedTile(ox, oy, groups);
          }
        } else {
          forTiles('all');
        }
      }
      // The agent-brush cursor + highlight visuals (hover/edit/area rings, the
      // footprint + bond-ring silhouettes, the glue anchor) moved to the cursor
      // overlay layer — see drawCursorLayer. The scene pass draws only agents+bonds.
    };

    // Zoomed-out glyph-color fallback: when cells are too small to draw glyphs
    // AND the active viewer's Set Cell Looks asked for it, blit a bitmap where
    // each glyphed cell is painted with its glyph color — so the macro view
    // shows the glyph distribution instead of going blank. One composited blit
    // (cheaper than per-cell fills for dense glyph models); the per-tile glyph
    // overlay below stays skipped at this zoom.
    // E2 DISPLAY-res single-canvas composite: the DISPLAY-sized agent canvas already
    // carries the grid layer (its FS inverts the camera → cell → colorsBuf, NEAREST)
    // AND the agent discs, BOTH through the display-res camera — so agents render as
    // crisp discs at any zoom (the fix for the world-res "blob of cells"). Blit it
    // 1:1 (like the A1 direct render); skip the separate grid srcCanvas blit / glyph
    // overlay / CPU bg fill / drawAgentsOverlay below.
    let agentComposite = agentCompositeActiveRef.current && !!agentRenderCanvasRef.current;
    let blitSource = srcCanvasRef.current;
    if (!agentComposite && !directRenderActiveRef.current && colors && colors.length >= w * h * 4 && srcCanvasRef.current) {
      const codes = glyphCodesRef.current;
      const gcols = glyphColorsRef.current;
      const fb = glyphFallbackRef.current;
      const wantFallback = scale < glyphMinPxRef.current && !!codes && !!gcols
        && (fb.all || fb.ids.has(activeViewerRef.current));
      if (wantFallback) {
        if (!fallbackCanvasRef.current || fallbackCanvasRef.current.width !== w || fallbackCanvasRef.current.height !== h) {
          fallbackCanvasRef.current = document.createElement('canvas');
          fallbackCanvasRef.current.width = w;
          fallbackCanvasRef.current.height = h;
        }
        const fbCtx = fallbackCanvasRef.current.getContext('2d')!;
        const buf = new Uint8ClampedArray(colors.buffer, colors.byteOffset, w * h * 4).slice();
        for (let i = 0; i < w * h; i++) {
          if (codes![i] === 0) continue;
          const packed = gcols![i]!;
          const o = i * 4;
          buf[o] = packed & 0xff;
          buf[o + 1] = (packed >> 8) & 0xff;
          buf[o + 2] = (packed >> 16) & 0xff;
          buf[o + 3] = 255;
        }
        fbCtx.putImageData(new ImageData(buf, w, h), 0, 0);
        blitSource = fallbackCanvasRef.current;
      }
    }

    // Render-layer toggle (req 7): when the CA grid is hidden, skip the colour
    // blit (+ glyphs + gridlines below), leaving the cleared canvas so the agents
    // draw on a blank background. Forced visible for a non-agent model (the toggle
    // is global but only editable on an agent model).
    // The CA-grid layer renders only when it EXISTS (topology) AND is shown. An
    // agents-only model (gridCells off) never draws the grid, so the environment
    // background applies without the user unchecking "Show".
    const showGrid2d = gridCellsOnRef.current && (!isAgentModelRef.current || showCaGridRef.current);
    if (agentComposite) {
      // Blit the DISPLAY-sized composite 1:1 (it carries grid+agents through the
      // display-res camera + the bg backdrop when the grid layer is hidden). A
      // display resize needs a fresh re-attach (transferred canvas dims are fixed);
      // a degenerate parent (occluded pane) keeps the current canvas. Gridlines +
      // brush cursor overlay on top below.
      const dims = agentRenderCanvasDimsRef.current;
      if ((dims.w !== parentW || dims.h !== parentH) && parentW >= 2 && parentH >= 2) {
        // Re-attach WITHOUT falling back — keep blitting the OLD (still worker-
        // presented) composite until the ack commits the fresh one. Dropping to
        // the CPU paths here showed a frozen outdated grid+agents frame for the
        // whole handshake (free mode ships neither colours nor snapshots).
        maybeAttachAgentCanvas(true);
      }
      ctx.drawImage(agentRenderCanvasRef.current!, 0, 0);
      postAgentCamera();
    } else if (showGrid2d && blitSource) {
      if (infinity) {
        // Snap each tile's left/top edges to integer pixels and derive width/height
        // from the difference with the NEXT tile's left/top. This guarantees that
        // tile (tx)'s right edge == tile (tx+1)'s left edge to the pixel — otherwise
        // sub-pixel destination positions at non-integer scaledW leave faint seams
        // (a half-pixel gap or overlap) at every tile boundary.
        for (let ty = tyMin; ty <= tyMax; ty++) {
          const yTop = Math.round(oy + ty * scaledH);
          const yBot = Math.round(oy + (ty + 1) * scaledH);
          for (let tx = txMin; tx <= txMax; tx++) {
            const xLeft = Math.round(ox + tx * scaledW);
            const xRight = Math.round(ox + (tx + 1) * scaledW);
            ctx.drawImage(blitSource, xLeft, yTop, xRight - xLeft, yBot - yTop);
          }
        }
      } else {
        ctx.drawImage(blitSource, ox, oy, scaledW, scaledH);
      }
    }

    // Glyph overlay (after colour blit, before gridlines + cursor). Skipped for
    // the composite (glyph data isn't shipped; the grid layer is GPU-composited).
    if (showGrid2d && !agentComposite) drawGlyphOverlay();

    // Draw gridlines when zoomed in enough (cells >= 4px)
    if (showGrid2d && showGridlinesRef.current && scale >= 4) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      const xtMin = infinity ? txMin : 0;
      const xtMax = infinity ? txMax : 0;
      const ytMin = infinity ? tyMin : 0;
      const ytMax = infinity ? tyMax : 0;
      for (let ty = ytMin; ty <= ytMax; ty++) {
        for (let tx = xtMin; tx <= xtMax; tx++) {
          const tileOx = ox + tx * scaledW;
          const tileOy = oy + ty * scaledH;
          const tileTop = Math.max(0, tileOy);
          const tileBot = Math.min(parentH, tileOy + scaledH);
          const tileLeft = Math.max(0, tileOx);
          const tileRight = Math.min(parentW, tileOx + scaledW);
          for (let col = 0; col <= w; col++) {
            const x = tileOx + col * scale;
            if (x >= 0 && x <= parentW) {
              ctx.moveTo(x, tileTop);
              ctx.lineTo(x, tileBot);
            }
          }
          for (let row = 0; row <= h; row++) {
            const y = tileOy + row * scale;
            if (y >= 0 && y <= parentH) {
              ctx.moveTo(tileLeft, y);
              ctx.lineTo(tileRight, y);
            }
          }
        }
      }
      ctx.stroke();
    }

    // Environment background — when the CA grid layer is hidden (agents-only view),
    // the canvas is cleared/transparent; fill the W×H world rect with the user's
    // chosen colour so agents sit on a solid backdrop instead of the page showing
    // through. Tiled in infinity (matches the grid blit). No-op when the grid shows
    // (its colours ARE the background) or when disabled (bg2dRef null).
    // A1 direct AGENT render: the worker rendered the agents (+ background clear)
    // straight into the transferred OffscreenCanvas — blit it 1:1 and skip the
    // CPU bg fill + drawAgentsOverlay. Camera lives in the worker uniform.
    // A transferred canvas has FIXED dims — a display resize needs a fresh
    // re-attach; keep the worker camera synced otherwise.
    let agentDirect = !agentComposite && agentDirectRenderActiveRef.current && agentRenderCanvasRef.current;
    if (agentComposite) {
      // The DISPLAY-res composite blit + resize-reattach + camera sync all happened
      // at the grid-blit position above — nothing more to do here.
    } else if (agentDirect) {
      const dims = agentRenderCanvasDimsRef.current;
      // Re-attach ONLY on a REAL size change: an occluded/hidden pane measures
      // the parent at 0×0 while the attach clamps to ≥1px, so comparing raw
      // parent dims re-attached EVERY draw (a device/transfer churn storm —
      // hundreds/sec while stepping hidden, e.g. an Overseer run in a hidden
      // tab). A degenerate parent keeps the current canvas; the first visible
      // draw sees the true size and does one clean re-attach.
      if ((dims.w !== parentW || dims.h !== parentH) && parentW >= 2 && parentH >= 2) {
        // Re-attach WITHOUT falling back: the OLD canvas keeps receiving the
        // worker's presents until the fresh one is committed by the ack, so we
        // keep blitting it (slightly mis-sized) instead of dropping to the CPU
        // overlay — whose snapshot is ANCIENT in free mode (UI-sync off), which
        // showed a frozen outdated frame for the whole handshake (the reported
        // panel-resize freeze on Particle Life-class models).
        maybeAttachAgentCanvas(true);
      }
      postAgentCamera();
    }
    if (agentComposite) {
      // The composite already carries the grid layer + agents + the bg backdrop
      // (worker clear when the grid is hidden) — nothing more to draw here.
    } else if (agentDirect && showAgentsRef.current && !showGrid2d && bg2dRef.current) {
      // (bg is drawn by the render shader's clear — nothing to do here)
      // …but ONLY while we actually blit that canvas: the blit below is gated on
      // showAgents, so with agents hidden the shader's clear never reaches the
      // display and the backdrop would vanish entirely (audit L1). Requiring
      // showAgents here falls through to the CPU bg fill in that case.
    } else if (!showGrid2d && bg2dRef.current) {
      ctx.save();
      ctx.fillStyle = bg2dRef.current;
      if (infinity) {
        for (let ty = tyMin; ty <= tyMax; ty++) {
          const yTop = Math.round(oy + ty * scaledH), yBot = Math.round(oy + (ty + 1) * scaledH);
          for (let tx = txMin; tx <= txMax; tx++) {
            const xLeft = Math.round(ox + tx * scaledW), xRight = Math.round(ox + (tx + 1) * scaledW);
            ctx.fillRect(xLeft, yTop, xRight - xLeft, yBot - yTop);
          }
        }
      } else { ctx.fillRect(ox, oy, scaledW, scaledH); }
      ctx.restore();
    }

    // Bond-Graph Agents — draw the agent circles on top of the grid + gridlines,
    // below the brush cursor. Render-layer toggle (req 7): skip when agents hidden.
    // Composite: agents are already in the world-sized blit above (skip both the
    // 1:1 blit AND the CPU overlay).
    if (agentComposite) {
      // agents drawn by the composite blit above
    } else if (agentDirect) {
      if (showAgentsRef.current) ctx.drawImage(agentRenderCanvasRef.current!, 0, 0);
    } else if (showAgentsRef.current) {
      drawAgentsOverlay();
    }

    // Hemifield / vision-cone display — the FOV sensing nodes' cones as
    // translucent wedges (apex at the agent, bisector along its VELOCITY
    // heading, ± halfAngle, arc radius = the node's sensing radius). Zero
    // heading or halfAngle ≥ 180° → the full sensing circle (the nodes'
    // omnidirectional rule). Scope: the inspected/edited/hovered agent, or all
    // (capped). Reads the agent SNAPSHOT — the UI-sync driver keeps snapshots
    // flowing while this isn't Off. Primary tile only; one tint per FOV node.
    if (!is3dRef.current && showVisionRef.current !== 'off' && isAgentModelRef.current) {
      const cones = visionConesRef.current;
      const snap = agentsRef.current;
      if (cones.length > 0 && snap && snap.highWater > 0) {
        const TINTS = ['80,200,255', '255,180,80', '180,255,120', '255,120,200', '200,160,255'];
        let ids: number[];
        if (showVisionRef.current === 'inspected') {
          const set = new Set<number>();
          // Open inspectors (pinned + the transient sweep) — independent of the
          // brush mode, like the inspector itself.
          for (const id of agentInspectIdsRef.current) if (id >= 0) set.add(id);
          // The EDIT target only counts while the Edit brush is actually active
          // — exactly the condition its dashed highlight uses (see
          // drawCursorLayer), so the cone and the highlight appear/disappear
          // together instead of the cone lingering after a mode switch.
          if (editTargetIdRef.current >= 0
              && brushTargetRef.current === 'agents'
              && agentBrushModeRef.current === 'edit'
              && agentBrushScopeRef.current === 'single') {
            set.add(editTargetIdRef.current);
          }
          if (agentHoverIdRef.current >= 0) set.add(agentHoverIdRef.current);
          ids = [...set];
        } else {
          ids = [];
          const CAP = 1500; // sanity cap for the All scope
          for (let i = 0; i < snap.highWater && ids.length < CAP; i++) if (snap.alive[i]) ids.push(i);
        }
        if (ids.length > 0) {
          ctx.save();
          cones.forEach((cone, ci) => {
            // The node's own visionColor wins over the automatic palette slot.
            const tint = cone.tint ?? TINTS[ci % TINTS.length]!;
            ctx.fillStyle = `rgba(${tint}, 0.10)`;
            ctx.strokeStyle = `rgba(${tint}, 0.45)`;
            ctx.lineWidth = 1;
            const half = (Math.min(cone.halfAngleDeg, 180) * Math.PI) / 180;
            const omniAngle = cone.halfAngleDeg >= 180;
            for (const id of ids) {
              if (id >= snap.highWater || !snap.alive[id]) continue;
              const sx2 = ox + snap.x[id]! * scale, sy2 = oy + snap.y[id]! * scale;
              const rr = cone.radius * scale;
              const vx2 = snap.vx?.[id] ?? 0, vy2 = snap.vy?.[id] ?? 0;
              const omni = omniAngle || (vx2 * vx2 + vy2 * vy2) < 1e-12;
              ctx.beginPath();
              let bisector: number | null = null;
              if (omni) {
                ctx.arc(sx2, sy2, rr, 0, Math.PI * 2);
              } else {
                const a = Math.atan2(vy2, vx2); // world +y = screen-down, so screen-space directly
                bisector = a;
                ctx.moveTo(sx2, sy2);
                ctx.arc(sx2, sy2, rr, a - half, a + half);
                ctx.closePath();
              }
              ctx.fill();
              ctx.stroke();
              // Faint DOTTED centre line along the heading — the cone's midline,
              // so the LEFT and RIGHT halves of the field (what Sense Hemifield
              // counts) are readable at a glance. Skipped for an omnidirectional
              // cone, which has no left/right split.
              if (bisector !== null) {
                ctx.save();
                ctx.setLineDash([3, 3]);
                ctx.strokeStyle = `rgba(${tint}, 0.55)`;
                ctx.beginPath();
                ctx.moveTo(sx2, sy2);
                ctx.lineTo(sx2 + Math.cos(bisector) * rr, sy2 + Math.sin(bisector) * rr);
                ctx.stroke();
                ctx.restore();
              }
            }
          });
          ctx.restore();
        }
      }
    }

    // 2D axes indicator — marks the grid ORIGIN (cell 0,0) and the growth
    // directions, matching the 3D convention: columns = red toward +X (right),
    // rows = green toward screen-down. Each axis spans the FULL grid edge with
    // an arrowhead at the far end and a `C (n)` / `R (n)` label carrying the
    // dimension count. Drawn AFTER the agent layer so nothing covers it, on the
    // PRIMARY tile only (infinity mode included) — a coordinate legend, not a
    // lattice overlay. Labels get a dark halo so they read on any content.
    if (show2dAxesRef.current && !is3dRef.current) {
      ctx.save();
      ctx.font = 'bold 11px sans-serif';
      const halo = (text: string, x: number, y: number, color: string) => {
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
        ctx.strokeText(text, x, y);
        ctx.fillStyle = color;
        ctx.fillText(text, x, y);
      };
      const drawAxis = (dx: number, dy: number, len: number, color: string, label: string) => {
        const x2 = ox + dx * len, y2 = oy + dy * len;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(ox, oy);
        ctx.lineTo(x2, y2);
        // Two-pronged arrowhead (the 3D renderOverlays style).
        const ah = 7;
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - dx * ah - dy * ah * 0.6, y2 - dy * ah + dx * ah * 0.6);
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - dx * ah + dy * ah * 0.6, y2 - dy * ah - dx * ah * 0.6);
        ctx.stroke();
        // Label anchored just INSIDE the arrow tip (stays on-screen when the
        // grid fills the view): column axis → left of the tip, below the top
        // edge; row axis → right of the tip, above the bottom end.
        const tw = ctx.measureText(label).width;
        if (dx) halo(label, x2 - tw - 10, y2 + 15, color);
        else halo(label, x2 + 8, y2 - 8, color);
      };
      drawAxis(1, 0, scaledW, '#e05050', `C (${w})`);  // +columns → right, full grid width
      drawAxis(0, 1, scaledH, '#50c050', `R (${h})`);  // +rows → down, full grid height
      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.beginPath();
      ctx.arc(ox, oy, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Brush cursor: drawn on the dedicated cursor overlay layer (drawCursorLayer)
    // — the scene canvas no longer carries it, so cursor movement never forces a
    // scene redraw. Re-sync the layer now that the transform stash is fresh.
    drawCursorLayer();

    // Middle-click autoscroll indicator: small unfilled ring + centre dot at the
    // anchor, plus a faint direction line to the cursor. Kept low-contrast so it
    // doesn't compete with the cell content visually.
    const aoOrigin = autoscrollOriginRef.current;
    const aoCursor = autoscrollCursorRef.current;
    if (aoOrigin) {
      ctx.save();
      if (aoCursor) {
        const dx = aoCursor.x - aoOrigin.x;
        const dy = aoCursor.y - aoOrigin.y;
        const dist = Math.hypot(dx, dy);
        if (dist > 12) {
          ctx.strokeStyle = 'rgba(220, 230, 245, 0.18)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(aoOrigin.x, aoOrigin.y);
          ctx.lineTo(aoCursor.x, aoCursor.y);
          ctx.stroke();
        }
      }
      ctx.strokeStyle = 'rgba(220, 230, 245, 0.35)';
      ctx.fillStyle = 'rgba(220, 230, 245, 0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(aoOrigin.x, aoOrigin.y, 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(aoOrigin.x, aoOrigin.y, 1.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    fpsFrames.current++;
  }, []);

  // Latest draw() for callbacks/rAF that outlive a single render (sprite registry
  // onReady + the sprite playback rAF).
  const drawRef = useRef(draw);
  drawRef.current = draw;

  // --- Agent sprites: registry reconcile (main-thread render) ---
  // Decode new/changed sprites + drop removed ones whenever `model.sprites`
  // changes, and refresh the slot→{id,scale,loop} meta. PLAYBACK is logic-driven
  // (the engine advances each agent's frame per simulation step from the speed the
  // Set Agent Sprite node set), so there is NO simulator transport — the render
  // reads the per-agent frame straight from the snapshot. Decoding is async
  // (ImageDecoder); onReady redraws so a freshly-imported sprite appears.
  useEffect(() => {
    const sprites = model.sprites ?? [];
    spriteMetaRef.current = sprites.map(s => ({ id: s.id, scale: s.scale ?? 1, loop: s.loop !== false, defaultDirection: s.defaultDirection ?? 0, orientToVelocity: !!s.orientToVelocity, rotationOffset: s.rotationOffset ?? 0 }));
    spriteAtlasDirtyRef.current = true; // sprite set changed → rebuild the 3D atlas
    if (sprites.length === 0) {
      spriteRegistryRef.current?.dispose();
      spriteRegistryRef.current = null;
      return;
    }
    if (!spriteRegistryRef.current) {
      // A decode completing marks the 3D atlas dirty (a new frame set) + redraws.
      spriteRegistryRef.current = new SpriteRegistry(() => { spriteAtlasDirtyRef.current = true; drawRef.current(); });
    }
    spriteRegistryRef.current.sync(sprites);
  }, [model.sprites]);

  // Dispose the registry (free decoded ImageBitmaps) on unmount.
  useEffect(() => () => { spriteRegistryRef.current?.dispose(); spriteRegistryRef.current = null; }, []);

  // Track playing state in ref so worker message handler can access it
  const playingRef = useRef(false);
  const gensPerFrameRef = useRef(1);
  const targetFpsRef = useRef(30);
  const lastStepSentTime = useRef(0);
  const lastDrawTime = useRef(0);
  // P4 — replaced setTimeout with rAF for steadier pacing aligned to vsync.
  // setTimeout coalescing made high-FPS playback irregular ("stutter") because
  // the browser drifts timers under load. rAF resolves at the display's
  // refresh boundary, so the play loop ticks at predictable intervals.
  const nextStepRaf = useRef<number | null>(null);
  const unlimitedFpsRef = useRef(false);
  const unlimitedGensRef = useRef(false);
  const endConditionsRef = useRef(model.properties.endConditions);
  useEffect(() => { playingRef.current = playing; }, [playing]);
  // Cursor-follow redraws are rAF-coalesced (≤1 per frame regardless of the mouse
  // polling rate — a high-Hz mouse otherwise fires a full draw() per pointermove)
  // AND skipped while playing: the step→draw pipeline already redraws at the sim
  // FPS and the cursor overlay reads the live cursor refs, so idle cursor movement
  // no longer steals main-thread time from a running simulation (the FPS-halving
  // the user reported). Active gestures (pan / paint / resize) still draw eagerly.
  const cursorDrawRaf = useRef<number | null>(null);
  // Cursor-only redraw — paints the dedicated overlay layers (never the scene),
  // so it is safe (and cheap) at display rate even while playing: the cursor
  // stays fluid at 60 fps when the simulation itself renders at 1 fps.
  const scheduleCursorDraw = useCallback(() => {
    if (cursorDrawRaf.current != null) return;
    cursorDrawRaf.current = requestAnimationFrame(() => { cursorDrawRaf.current = null; drawCursorLayer(); });
  }, [drawCursorLayer]);
  useEffect(() => { gensPerFrameRef.current = unlimitedGens ? 100 : gensPerFrame; }, [gensPerFrame, unlimitedGens]);
  useEffect(() => { targetFpsRef.current = unlimitedFps ? 999999 : targetFps; }, [targetFps, unlimitedFps]);
  useEffect(() => { unlimitedFpsRef.current = unlimitedFps; }, [unlimitedFps]);
  useEffect(() => { unlimitedGensRef.current = unlimitedGens; }, [unlimitedGens]);
  useEffect(() => { endConditionsRef.current = model.properties.endConditions; }, [model.properties.endConditions]);

  // End-condition evaluation: returns a non-empty reason string when the
  // simulation should auto-pause. Evaluated after each `stepped` message.
  const [endConditionNotice, setEndConditionNotice] = useState<string | null>(null);
  const endNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bond-Graph Agents — transient toast for engine notices the worker posts
  // (e.g. `agentOverflow` when a cluster/drag seed hits maxAgents). Distinct
  // from endConditionNotice: it does NOT pause the simulation; it auto-dismisses.
  const [agentNotice, setAgentNotice] = useState<string | null>(null);
  const agentNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showAgentNotice = useCallback((message: string) => {
    setAgentNotice(message);
    if (agentNoticeTimer.current) clearTimeout(agentNoticeTimer.current);
    agentNoticeTimer.current = setTimeout(() => setAgentNotice(null), 3500);
  }, []);
  const evalEndConditions = useCallback((gen: number, indicatorValues: Record<string, number | Record<string, number> | Record<string, number[]>>): string | null => {
    const ec = endConditionsRef.current;
    if (!ec || !ec.enabled) return null;
    if (typeof ec.maxGenerations === 'number' && ec.maxGenerations > 0 && gen >= ec.maxGenerations) {
      return `Max generations reached (${ec.maxGenerations})`;
    }
    for (const cond of ec.indicatorConditions || []) {
      const raw = indicatorValues[cond.indicatorId];
      const ind = (model.indicators || []).find(i => i.id === cond.indicatorId);
      if (!ind) continue;

      // Resolve the numeric left-hand-side of the comparison, depending on
      // whether this is a scalar indicator or a linked-frequency map.
      let lhs: number | null = null;
      let labelSuffix = '';
      if (typeof raw === 'number') {
        lhs = raw;
      } else if (raw && typeof raw === 'object') {
        // Linked-frequency value. Float-binned frequencies are disabled in the
        // UI (no stable category key at design time) — skip them here as a
        // safety net so a stale saved condition can't unexpectedly fire.
        const cellAttr = (model.attributes || []).find(a => a.id === ind.linkedAttributeId);
        if (cellAttr?.type === 'float') continue;
        const category = cond.category;
        if (category === undefined || category === '') continue;
        lhs = (raw as Record<string, number>)[category] ?? 0;
        labelSuffix = ` [${category}]`;
      }
      if (lhs === null) continue;

      const target = ind.dataType === 'bool' && cond.category === undefined
        ? (cond.value === 'true' || cond.value === '1' ? 1 : 0)
        : Number(cond.value);
      if (!Number.isFinite(target)) continue;

      let match = false;
      switch (cond.op) {
        case '==': match = lhs === target; break;
        case '!=': match = lhs !== target; break;
        case '>':  match = lhs >  target; break;
        case '<':  match = lhs <  target; break;
        case '>=': match = lhs >= target; break;
        case '<=': match = lhs <= target; break;
      }
      if (match) {
        const name = ind.name || cond.indicatorId;
        return `${name}${labelSuffix} ${cond.op} ${cond.value}`;
      }
    }
    return null;
  }, [model.indicators, model.attributes]);

  const sendNextStep = useCallback(() => {
    // Overseer: the experiment owns the step cadence — the play pipeline must
    // never interleave its own batches with the runtime's reqId'd ones.
    if (overseerRunningRef.current) return;
    if (!playingRef.current || pendingStep.current) return;
    pendingStep.current = true;
    lastStepSentTime.current = performance.now();
    workerRef.current?.postMessage({
      type: 'step',
      count: gensPerFrameRef.current,
      activeViewer: activeViewerRef.current,
      skipColorPass: unlimitedGensRef.current,
    });
  }, []);

  // Handle messages from worker
  const onWorkerMessageRef = useRef<(e: MessageEvent) => void>(() => {});
  onWorkerMessageRef.current = (e: MessageEvent) => {
    const msg = e.data;
    if (msg.type === 'inspectCellsData') {
      // Worker batched attribute readout + per-cell RGB for all subscribed
      // inspect cells. Per-cell colors are bundled here (instead of relying
      // on colorsRef) so the popover swatch works uniformly across JS / WASM
      // / WebGPU direct render — under direct render the full colors buffer
      // is never sent to the main thread.
      inspectDataRef.current.clear();
      inspectColorsRef.current.clear();
      inspectOrientationsRef.current.clear();
      const data = msg.data as Record<string, Record<string, number>>;
      for (const k of Object.keys(data)) inspectDataRef.current.set(Number(k), data[k]!);
      const colors = msg.colors as Record<string, { r: number; g: number; b: number }> | undefined;
      if (colors) {
        for (const k of Object.keys(colors)) inspectColorsRef.current.set(Number(k), colors[k]!);
      }
      const orientations = msg.orientations as Record<string, number> | undefined;
      if (orientations) {
        for (const k of Object.keys(orientations)) inspectOrientationsRef.current.set(Number(k), orientations[k]!);
      }
      bumpInspectVersion(v => v + 1);
      return;
    }
    if (msg.type === 'stepped') {
      // `colors` may be ABSENT: WebGPU direct render skips it, and agents-only
      // models ship the (static) buffer only when it changed — keep the last one.
      if (msg.colors !== undefined) {
        colorsRef.current = msg.colors as Uint8ClampedArray;
        // L1: a colours buffer that arrived AFTER the UI-sync ON post is what
        // makes frame mode safe to enter (it reflects the current generation).
        gridFrameAwaitingColorsRef.current = false;
      }
      // Bond-Graph Agents: stash the latest agent render snapshot (positions /
      // radius / alive / colours) for drawAgents + nearest-agent picking. Sent
      // every frame for an agent model; absent for a lattice-only model.
      if (msg.agents !== undefined) agentsRef.current = msg.agents as AgentRenderSnapshot | null;
      // A1: live-agent count for the stats chip — from the snapshot when present,
      // else the free-mode scalar (the worker renders the frame GPU-side).
      if (msg.agents !== undefined && (msg.agents as AgentRenderSnapshot | null)) agentLiveCountRef.current = (msg.agents as AgentRenderSnapshot).liveCount;
      else if (typeof msg.agentLiveCount === 'number') agentLiveCountRef.current = msg.agentLiveCount as number;
      // A1: re-evaluate whether a feature needs live CPU agent state (hover while
      // playing is the common transition the per-frame call catches).
      if (agentDirectRenderActiveRef.current) updateAgentUiSync();
      // L1: same per-frame re-evaluation for the grid (hover-while-playing is the
      // common transition a per-frame call catches).
      if (voxelRenderActiveRef.current) updateGridUiSync();
      // "Skip Isolated Empty Cells" observability: the worker's live active-cell
      // count (-1 = configured on but NOT engaged → the full loop is running;
      // undefined = feature off). Rendered in the stats overlay; re-renders ride
      // the existing per-stepped setGeneration.
      sieActiveRef.current = (msg.sieActive as number | undefined) ?? null;
      // Glyph overlay buffers — undefined when the model has no setCellGlyph
      // OR when every cell's glyph code is 0 this frame. Clearing to null in
      // the latter case lets the overlay skip the loop entirely (no need to
      // iterate visible cells just to find all zeros).
      const gc = msg.glyphCodes as Uint32Array | undefined;
      const gcol = msg.glyphColors as Uint32Array | undefined;
      glyphCodesRef.current = gc ?? null;
      glyphColorsRef.current = gcol ?? null;
      if (msg.indicators) {
        indicatorValuesRef.current = msg.indicators;
        // Collect history for indicators with expanded charts. Scalars → number[];
        // frequency maps → Record<category, number[]> so multi-line / stacked-area
        // charts can draw one series per category.
        const expanded = chartExpandedRef.current;
        if (expanded.size > 0) {
          const hist = indicatorHistoryRef.current;
          for (const id of expanded) {
            const v = msg.indicators[id];
            if (typeof v === 'number') {
              let arr = hist[id];
              if (!arr || !Array.isArray(arr)) { arr = []; hist[id] = arr; }
              (arr as number[]).push(v);
              if ((arr as number[]).length > indicatorHistoryCapRef.current) (arr as number[]).shift();
            } else if (v && typeof v === 'object') {
              // Spatial indicators send Record<seriesKey, number[]> (per-position
              // bin) — a live snapshot, NOT a time-history. Skip history
              // collection entirely; IndicatorSpatialChart reads the current
              // value directly from indicatorValuesRef. Detect structurally by an
              // array-valued entry (generation-axis frequency maps are number-valued).
              if (Array.isArray(Object.values(v)[0])) continue;
              let perCat = hist[id];
              if (!perCat || Array.isArray(perCat)) { perCat = {}; hist[id] = perCat; }
              for (const [cat, count] of Object.entries(v as Record<string, number>)) {
                let series = (perCat as Record<string, number[]>)[cat];
                if (!series) { series = []; (perCat as Record<string, number[]>)[cat] = series; }
                series.push(count);
                if (series.length > indicatorHistoryCapRef.current) series.shift();
              }
            }
          }
        }
      }
      const gen = msg.generation as number;
      gpsGens.current += gen - lastGenForGps.current;
      lastGenForGps.current = gen;

      pendingStep.current = false;

      // End-condition check: pause and surface a notice when a configured rule
      // matches. Only evaluated while playing to avoid re-pausing on each
      // manual step after the condition is already met.
      if (playingRef.current) {
        const reason = evalEndConditions(gen, indicatorValuesRef.current);
        if (reason) {
          playingRef.current = false;
          setPlaying(false);
          setEndConditionNotice(reason);
          if (endNoticeTimer.current) clearTimeout(endNoticeTimer.current);
          endNoticeTimer.current = setTimeout(() => setEndConditionNotice(null), 4000);
        }
      }

      // Update metrics (runs on every result, even without drawing)
      const now = performance.now();
      if (now - fpsLastTime.current >= 1000) {
        setActualFps(fpsFrames.current);
        setActualGps(gpsGens.current);
        fpsFrames.current = 0;
        gpsGens.current = 0;
        fpsLastTime.current = now;
      }

      generationRef.current = gen;
      if (unlimitedGensRef.current && playingRef.current) {
        // Unlimited gens: skip drawing, update generation counter periodically
        if (now - lastDrawTime.current >= 500) {
          lastDrawTime.current = now;
          setGeneration(gen);
          lastGenSetTime.current = now;
          // L1: the worker-presented voxel canvas keeps updating on its own (the
          // browser composites it), but WHICH canvas is visible — and whether gl3d
          // renders overlays-only — is decided in draw(), which this fast path
          // otherwise never runs, so the free/frame flip would never happen and the
          // user would watch a frozen gl3d frame. In free mode draw() is cheap (the
          // GPU owns the volume, so the O(total) uploadColors rescan is skipped), so
          // run it at the same 2 Hz cadence as the counter. Every other model keeps
          // the historical skip-drawing-entirely-for-throughput behaviour.
          if (voxelRenderActiveRef.current) draw();
        }
        sendNextStep();
      } else {
        // Normal: throttle the React state update to ~10 Hz so the indicator
        // panel + transport-bar gen counter don't reconcile every step. Ref
        // is always current; visible UI ticks at a human-readable rate.
        if (now - lastGenSetTime.current >= 100) {
          setGeneration(gen);
          lastGenSetTime.current = now;
        }
        draw();
        // Under WebGPU direct render, drawImage(srcCanvas) reads the
        // OffscreenCanvas placeholder's *last-composited* frame. The worker
        // has just dispatched the present pass and posted stepped, but the
        // browser's compositor may not have picked up that frame yet — so
        // the immediate draw above can blit the *previous* frame. Schedule
        // a follow-up draw on the next animation frame: by then the
        // compositor has run, drawImage reads the new frame, and the user
        // sees the actual result of paint / paste / clear / reset / etc.
        // Without this, one-shot mutations under direct render leave the
        // canvas showing stale post-Play state until the next user action.
        // Cost is negligible (one extra drawImage at vsync rate).
        if (directRenderActiveRef.current || agentDirectRenderActiveRef.current) {
          requestAnimationFrame(() => draw());
        }

        // ── Recording frame capture (unified across ALL model types + targets) ──
        // ONE path captures the DISPLAY surface the user actually sees, then applies
        // the chosen SCOPE:
        //   • "simulation" — crop to the drawn world rectangle (the W×H grid mapped
        //     through the current transform), so the empty letterbox margins between
        //     the side panels are removed. This is the area of interest.
        //   • "view"       — the whole display canvas exactly as shown (with margins,
        //     pan, zoom, gridlines, axes — WYSIWYG).
        // 2D reads canvasRef, the FINAL composited surface for every 2D path (JS/WASM
        // grid, WebGPU direct render, E2 composite, CPU-overlay agents, agent direct
        // render) — so grid + agents + background are all captured uniformly. It reads
        // via a CPU-backed scratch: drawImage (a texture READ that does NOT de-optimize
        // the source) then getImageData the willReadFrequently scratch — NEVER
        // getImageData on the live display canvas (that de-optimizes it out of GPU
        // acceleration, a persistent ~6x slowdown outliving the recording). 3D reads
        // the WebGL2 buffer (no letterbox → both scopes are the full frame). The crop +
        // output size are LOCKED on the first captured frame (recordCropRef) so
        // mid-record pan/zoom/panel-resize can't change frame dims (the dimension guard
        // would drop them) — the recording keeps a stable framing throughout.
        if (recordingRef.current) {
          // Dimension lock (recordDimsRef, set on the first accepted frame) —
          // NOT recordedFrames.current[0], which stays empty while streaming.
          const expected = recordDimsRef.current;
          let frame: ImageData | null = null;

          if (is3dRef.current && gl3dRef.current) {
            // 3D: the scene fills the viewport (no letterbox) — both scopes capture
            // the full GL display buffer, DOWNSCALED to RECORD_MAX_3D on the long
            // edge. Uncapped, readPixels returns cssW*dpr x cssH*dpr — measured
            // 23 MB/frame at DPR 2 and 33 MB at 4K, the largest per-frame cost in
            // the codebase (2D has been capped all along). Screenshots are NOT
            // capped — they keep full display resolution.
            const px = capture3dPixels() ?? gl3dRef.current.readPixels();
            const scaled = downscaleCapture(px, RECORD_MAX_3D);
            if (!expected || (scaled.width === expected.w && scaled.height === expected.h)) {
              forceFrameOpaque(scaled.data);
              frame = new ImageData(scaled.data, scaled.width, scaled.height);
            }
          } else if (recordScopeRef.current === 'simulation') {
            // "simulation": the WHOLE grid/world at a fit framing, INDEPENDENT of the
            // current zoom/pan — so it captures the entire simulation no matter how far
            // you've zoomed in to inspect a part. Rendered on the main thread from data
            // (colours buffer for the grid + the agent snapshot), reusing a persistent
            // offscreen (RECORD_MAX-bounded). getImageData on a never-displayed canvas
            // is safe (no willReadFrequently de-opt).
            const off = renderSimulationFrame(RECORD_MAX, simCaptureRef.current ?? undefined, true);
            if (off) {
              simCaptureRef.current = off;
              frame = off.getContext('2d')!.getImageData(0, 0, off.width, off.height);
              forceFrameOpaque(frame.data);
            }
          } else if (canvasRef.current && canvasRef.current.width > 0 && canvasRef.current.height > 0) {
            // "current view": the display canvas exactly as shown (zoom / pan / margins).
            // Lock only the OUTPUT dims on the first frame (a panel resize mustn't change
            // frame size mid-record); the source is always the full canvas.
            const dc = canvasRef.current;
            let crop = recordCropRef.current;
            if (!crop) {
              // Fit to RECORD_MAX, then SNAP the width into the VP9 profile-1
              // fast residue class so the recording keeps 4:4:4 chroma (see
              // snapRecordWidth). The height is derived from the SAME scale, so
              // the aspect ratio is preserved exactly.
              let s = Math.min(1, RECORD_MAX / Math.max(dc.width, dc.height));
              const wantW = Math.max(1, Math.round(dc.width * s));
              const snapW = snapRecordWidth(wantW);
              if (snapW !== wantW && dc.width > 0) s = snapW / dc.width;
              crop = { outW: Math.max(1, snapW), outH: Math.max(1, Math.round(dc.height * s)) };
              recordCropRef.current = crop;
            }
            let rc = recordScratchRef.current;
            if (!rc) { rc = document.createElement('canvas'); recordScratchRef.current = rc; }
            if (rc.width !== crop.outW || rc.height !== crop.outH) { rc.width = crop.outW; rc.height = crop.outH; }
            const rctx = rc.getContext('2d', { willReadFrequently: true });
            if (rctx) {
              rctx.imageSmoothingEnabled = crop.outW !== dc.width || crop.outH !== dc.height;
              rctx.clearRect(0, 0, crop.outW, crop.outH);
              rctx.drawImage(dc, 0, 0, dc.width, dc.height, 0, 0, crop.outW, crop.outH);
              frame = rctx.getImageData(0, 0, crop.outW, crop.outH);
              // Opacify: the 2D canvas is cleared transparent, so margins / translucent
              // cells would otherwise leave GIF frame-disposal trails / let the page show
              // through. RGB is kept (composite over the dark canvas), matching the screen.
              forceFrameOpaque(frame.data);
            }
          }

          if (frame && (!expected || (frame.width === expected.w && frame.height === expected.h))) {
            if (!expected) recordDimsRef.current = { w: frame.width, h: frame.height };
            acceptRecordedFrame(frame);
          }
          // Throttle the visible counter to ~5 Hz so we don't re-render the
          // SimulatorView on every captured frame.
          if ((recordCountRef.current > 0 || recordDroppedRef.current > 0) && now - lastRecordCountSet.current >= 200) {
            setRecordFrameCount(recordCountRef.current);
            setRecordDroppedCount(recordDroppedRef.current);
            lastRecordCountSet.current = now;
          }
        }

        // Schedule next step to maintain targetFps rate. Uses rAF so the
        // dispatch lands on a vsync boundary; if the target rate is below
        // the display's refresh, we wait additional rAFs until elapsed time
        // matches `msPerFrame`. At unlimited FPS, fires on every rAF.
        if (playingRef.current) {
          const msPerFrame = 1000 / targetFpsRef.current;
          if (nextStepRaf.current != null) cancelAnimationFrame(nextStepRaf.current);
          const tick = () => {
            nextStepRaf.current = null;
            if (!playingRef.current) return;
            // ── LOSSLESS overload policy ("never skip frames") ────────────────
            // draw() is synchronous and cannot await the encoder — which is why
            // the DROP policy exists at all. So "slow the simulation instead"
            // lives HERE, in the one part of the loop that is already
            // asynchronous: hold the next step batch until the encoder has room.
            // A frame is captured exactly once per issued step, and a step is
            // only issued when the queue is below the cap, so the queue stays
            // bounded by CAP+1 — no unbounded (invisible) GPU-memory queue, and
            // no frame ever refused.
            if (recordingRef.current && recordOverloadActiveRef.current === 'lossless') {
              const enc = webmStreamRef.current;
              // Also hold while the async codec probe is still in flight: frames
              // captured meanwhile go to the bounded pending array, and past its
              // cap they would be DROPPED — which lossless mode promises not to
              // do. A probe FAILURE clears recordStreamModeRef, so this can't
              // latch on (and the stall timeout below covers a hung probe).
              const creating = !enc && recordStreamModeRef.current
                && webmStreamStateRef.current === 'creating';
              if (enc ? !enc.readyForNextFrame() : creating) {
                const now2 = performance.now();
                if (losslessWaitStartRef.current == null) losslessWaitStartRef.current = now2;
                if (now2 - losslessWaitStartRef.current < LOSSLESS_STALL_MS) {
                  setRecordThrottledIfChanged(true);
                  nextStepRaf.current = requestAnimationFrame(tick);
                  return;
                }
                // An order of magnitude past the worst measured per-frame encode:
                // the encoder is wedged, not merely slow. Degrade to dropping for
                // the rest of the run rather than freezing the simulation, and
                // say so once. Deliberately one-way, so it cannot flap.
                recordOverloadActiveRef.current = 'drop';
                showAgentNotice('Encoder stalled — recording switched to skipping frames');
              }
              losslessWaitStartRef.current = null;
              setRecordThrottledIfChanged(false);
            }
            const elapsed = performance.now() - lastStepSentTime.current;
            if (elapsed >= msPerFrame - 0.5) {
              sendNextStep();
            } else {
              nextStepRaf.current = requestAnimationFrame(tick);
            }
          };
          nextStepRaf.current = requestAnimationFrame(tick);
        }
      }
    } else if (msg.type === 'stopEvent') {
      // Compiled Stop Event node fired in the worker. Pause and surface the
      // user's message via the same blue notice used for end conditions.
      // During an Overseer experiment the runtime consumes the stop (Run Until
      // Stop semantics) and journals it — suppress the notice/pause here.
      if (overseerRunningRef.current) return;
      playingRef.current = false;
      setPlaying(false);
      setEndConditionNotice(String(msg.message ?? 'Stop condition reached'));
      if (endNoticeTimer.current) clearTimeout(endNoticeTimer.current);
      endNoticeTimer.current = setTimeout(() => setEndConditionNotice(null), 4000);
    } else if (msg.type === 'agentOverflow') {
      // Bond-Graph Agents: the worker hit maxAgents/maxBonds during seed or
      // division. Surface it as a transient toast (does NOT pause). Without
      // this branch the worker's overflow posts were silently dropped.
      showAgentNotice(String(msg.message ?? 'Agent capacity reached'));
    } else if (msg.type === 'agentState') {
      // Bond-Graph Agents: response to a `getAgentState {id}` inspector request.
      onAgentStateRef.current(msg as unknown as AgentStateResponse);
    } else if (msg.type === 'agentsRead') {
      // Agent clipboard COPY reply: stash relative-to-anchor specs; a cut then
      // kills the source ids (only once the read has safely captured them).
      const pend = pendingAgentCopyRef.current;
      pendingAgentCopyRef.current = null;
      const agents = (msg.agents ?? []) as Array<{ x: number; y: number; radius: number; vx: number; vy: number; attrs: Record<string, number> }>;
      if (pend && agents.length > 0) {
        agentClipboardRef.current = agents.map(a => ({
          dx: a.x - pend.anchor.x, dy: a.y - pend.anchor.y,
          radius: a.radius, vx: a.vx, vy: a.vy, attrs: a.attrs,
        }));
        if (pend.cut) {
          workerRef.current?.postMessage({ type: 'killAgents', ids: pend.ids, activeViewer: activeViewerRef.current });
        }
      }
    } else if (msg.type === 'error') {
      setCompileError(msg.message as string);
      pendingStep.current = false;
    } else if (msg.type === 'ready') {
      pendingStep.current = false;
    } else if (msg.type === 'state') {
      if (pendingStateSave.current) {
        pendingStateSave.current(msg);
        pendingStateSave.current = null;
      }
    } else if (msg.type === 'regionData') {
      // Worker responded to a readRegion request — stash in the clipboard (copied by slice()
      // so subsequent pastes can reuse the same data).
      const attrs: Record<string, { type: string; buffer: ArrayBuffer }> = {};
      for (const [id, entry] of Object.entries(msg.attributes as Record<string, { type: string; buffer: ArrayBuffer }>)) {
        const copy = (entry.buffer as ArrayBuffer).slice(0);
        attrs[id] = { type: entry.type, buffer: copy };
      }
      const meta = pendingCopyMeta.current;
      pendingCopyMeta.current = null;
      clipboardRef.current = {
        w: msg.w as number, h: msg.h as number, attributes: attrs,
        mask: meta?.mask, hotR: meta?.hotR, hotC: meta?.hotC,
      };
      // If this was a Ctrl+X, now clear the source — masked so a circle/ring
      // cut removes only its shape, matching the masked copy.
      if (pendingCutRect.current) {
        const rect = pendingCutRect.current;
        pendingCutRect.current = null;
        workerRef.current?.postMessage({
          type: 'clearRegion',
          row: rect.row, col: rect.col, w: rect.w, h: rect.h,
          mask: rect.mask ? rect.mask.buffer.slice(0) : undefined,
          activeViewer: activeViewerRef.current,
        });
      }
    }

    // F6: If there's a pending image import and we just got the first stepped (init done), send it
    if (msg.type === 'stepped' && pendingImageImport.current) {
      const pixels = pendingImageImport.current;
      pendingImageImport.current = null;
      workerRef.current?.postMessage(
        {
          type: 'importImage',
          pixels,
          mappingId: pendingImageMapping.current,
          activeViewer: activeViewerRef.current,
        },
        { transfer: [pixels.buffer] },
      );
    }
    // Mapping Cells (resize + manual input mapping): paint the masked cells once
    // the worker has reinitialised to the new grid dimensions.
    if (msg.type === 'stepped' && pendingManualImport.current) {
      const pm = pendingManualImport.current;
      pendingManualImport.current = null;
      if (pm.sets.length > 0 && pm.cells.length > 0) {
        workerRef.current?.postMessage({ type: 'paintManual', cells: pm.cells, sets: pm.sets, activeViewer: activeViewerRef.current });
      }
    }
    // CSV grid import (resize mode): write the value block once the worker has
    // reinitialised to the CSV's dimensions.
    if (msg.type === 'stepped' && pendingGridValuesImport.current) {
      const gv = pendingGridValuesImport.current;
      pendingGridValuesImport.current = null;
      workerRef.current?.postMessage(
        { type: 'importGridValues', attrId: gv.attrId, width: gv.width, height: gv.height, layer: gv.layer, values: gv.values, activeViewer: activeViewerRef.current },
        { transfer: [gv.values.buffer] },
      );
    }

    // One-shot colors snapshot — used by handleScreenshot under direct render
    // (where the placeholder srcCanvas can't be read on the main thread).
    if (msg.type === 'colorsSnapshot') {
      const cb = screenshotPendingRef.current;
      if (cb && msg.tag === 'screenshot') {
        screenshotPendingRef.current = null;
        cb({ w: msg.w as number, h: msg.h as number, colors: msg.colors as Uint8ClampedArray | undefined });
      }
      return;
    }

    // Restore simulation state from loaded .gcaproj (after worker init completes)
    if (msg.type === 'stepped' && pendingSimStateRestore.current) {
      const state = pendingSimStateRestore.current;
      pendingSimStateRestore.current = null;
      applySimulationState(state);
    }

    // P7 deferred attach: a two-phase handshake with the worker so we never
    // claim direct render before it's actually live.
    //
    //   Phase 1 — useWebGPUStatus { ready: true, directRender: false }:
    //     Worker has its WebGPU runtime up but no canvas yet. We allocate a
    //     fresh canvas, transferControlToOffscreen, and ship it via
    //     attachCanvas. We do NOT swap srcCanvasRef yet — keep the existing
    //     regular 2D canvas (with its JS-fallback putImageData content) so
    //     draw() doesn't flash blank during the GPU's first present.
    //
    //   Phase 2 — useWebGPUStatus { ready: true, directRender: true }:
    //     Worker has wired the canvas in setupDirectRender and dispatched the
    //     first present. NOW we swap srcCanvasRef to the transferred canvas
    //     and flip directRenderActiveRef. Subsequent draw() reads GPU output.
    //
    // If Phase 2 never arrives (attachCanvas rejected, runtime destroyed in
    // a race), the transferred canvas stays orphaned in pendingDirectRenderCanvas
    // and we stay permanently on JS-fallback — graceful degradation.
    if (msg.type === 'useWebGPUStatus') {
      // Compile-target chip honesty: ready:false while WebGPU is enabled means
      // the grid runtime failed to come up (falls back / errors).
      gridWebgpuStatusRef.current = msg.enabled ? (msg.ready ? 'ready' : 'failed') : 'pending';
      if (msg.ready && msg.directRender && pendingDirectRenderCanvas.current) {
        // Phase 2 ack — commit the swap.
        srcCanvasRef.current = pendingDirectRenderCanvas.current;
        pendingDirectRenderCanvas.current = null;
        directRenderActiveRef.current = true;
      } else if (msg.ready && msg.directRender && recompilePendingCanvasRefresh.current) {
        // Post-soft-recompile fresh-canvas swap. Allocate a NEW srcCanvas
        // placeholder, transferControlToOffscreen, and send attachCanvas to
        // the worker. Worker discards the salvaged-but-broken OffscreenCanvas
        // and runs setupDirectRender against the fresh one. The Phase 2
        // branch above commits the swap when the worker's reply lands. Grid
        // state and model attribute sliders survive because the worker isn't
        // torn down. The OFFSCREEN-RENDER FALSE branch never runs here —
        // the recompile path always lands in direct render when the user has
        // useWebGPU on.
        recompilePendingCanvasRefresh.current = false;
        try {
          const fresh = document.createElement('canvas');
          fresh.width = gridWidth.current;
          fresh.height = gridHeight.current;
          const offscreen = (fresh as HTMLCanvasElement & {
            transferControlToOffscreen: () => OffscreenCanvas;
          }).transferControlToOffscreen();
          pendingDirectRenderCanvas.current = fresh;
          workerRef.current?.postMessage(
            { type: 'attachCanvas', canvas: offscreen, width: fresh.width, height: fresh.height },
            [offscreen],
          );
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('[webgpu] post-recompile canvas refresh failed; staying with stale canvas:', e);
        }
      } else if (msg.ready && pendingCanvasAttach.current) {
        // Phase 1 ack — send attachCanvas, stash the fresh canvas, but DON'T
        // swap srcCanvasRef or set directRenderActiveRef yet.
        pendingCanvasAttach.current = false;
        try {
          const fresh = document.createElement('canvas');
          fresh.width = gridWidth.current;
          fresh.height = gridHeight.current;
          const offscreen = (fresh as HTMLCanvasElement & {
            transferControlToOffscreen: () => OffscreenCanvas;
          }).transferControlToOffscreen();
          workerRef.current?.postMessage(
            { type: 'attachCanvas', canvas: offscreen, width: fresh.width, height: fresh.height },
            [offscreen],
          );
          pendingDirectRenderCanvas.current = fresh;
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('[webgpu] deferred OffscreenCanvas transfer failed; staying on readback path:', e);
          directRenderActiveRef.current = false;
          pendingDirectRenderCanvas.current = null;
        }
      } else if (msg.ready === false) {
        // Worker reports WebGPU is off (init failure or explicit downgrade).
        // Drop any pending direct-render canvas so we don't apply it later.
        directRenderActiveRef.current = false;
        pendingDirectRenderCanvas.current = null;
      }
      // L1 — voxel attach. The worker reports its LIVE `voxelRender` state, so a
      // (re)built runtime (which loses its render pipelines) is detected without
      // a second message: ready + eligible + the worker says it's off ⇒ attach.
      if (msg.ready) {
        if (!msg.voxelRender) {
          voxelRenderActiveRef.current = false;
          if (voxelRenderEligibleRef.current) maybeAttachVoxelCanvas();
        }
      } else if (msg.ready === false) {
        // WebGPU died — the worker falls back and ships colours again. Drop the
        // (now dead) voxel canvases so a frozen frame can't linger in the DOM.
        voxelRenderActiveRef.current = false;
        pendingVoxelCanvas.current = null;
        const oldV = voxelCanvasRef.current;
        if (oldV?.parentElement) oldV.parentElement.removeChild(oldV);
        voxelCanvasRef.current = null;
      }
    }
    if (msg.type === 'voxelRenderStatus') {
      if (msg.active && pendingVoxelCanvas.current) {
        // Commit: the OLD canvas (kept live through a resize re-attach) leaves
        // the DOM now that the fresh one takes over.
        {
          const old = voxelCanvasRef.current;
          if (old && old !== pendingVoxelCanvas.current && old.parentElement) old.parentElement.removeChild(old);
        }
        voxelCanvasRef.current = pendingVoxelCanvas.current;
        pendingVoxelCanvas.current = null;
        voxelRenderActiveRef.current = true;
        // Send the initial camera + draw so the canvas shows the current frame
        // (the attach-time present used a zero uniform — the Phase C black-at-load
        // lesson: the first present after attach must never be the only one).
        const view = computeVoxelRenderView();
        if (view && workerRef.current) {
          lastGridCameraKeyRef.current = '';
          workerRef.current.postMessage({ type: 'setGridCamera', view });
        }
        postGridViz();  // apply the current bounds/grid/axes toggles to the worker
        // MIRROR THE WORKER'S ACTUAL FLAG (the UI-sync mirror invariant — see
        // gridUiSyncPostedRef). A display resize re-attaches on the SAME worker,
        // whose `gridUiSync` survives; assuming ON here stranded the mirror and
        // permanently suppressed every later ON post. `uiSync` is absent only on
        // a pre-fix / failure ack, where ON was the historical assumption.
        // Also drop any pending OFF debounce so a timer armed for the previous
        // attach can't fire against the freshly-mirrored state.
        if (gridUiSyncTimerRef.current) { clearTimeout(gridUiSyncTimerRef.current); gridUiSyncTimerRef.current = 0; }
        gridUiSyncPostedRef.current = (msg.uiSync as boolean | undefined) !== false;
        updateGridUiSync();
        draw();
      } else {
        // Attach failed — stay on the colours-readback + gl3d path. Drop BOTH
        // the pending canvas AND any old one a resize re-attach kept alive, and
        // force the grid sync ON so the fallback renders LIVE colours (free
        // mode's stale colorsRef otherwise froze the display).
        voxelRenderActiveRef.current = false;
        const p = pendingVoxelCanvas.current;
        if (p?.parentElement) p.parentElement.removeChild(p);
        pendingVoxelCanvas.current = null;
        const oldV = voxelCanvasRef.current;
        if (oldV?.parentElement) oldV.parentElement.removeChild(oldV);
        voxelCanvasRef.current = null;
        forceGridUiSyncOn();
      }
    }
    // A1 direct AGENT render — the runtime-ready trigger + the attach ack.
    if (msg.type === 'agentRuntimeReady') {
      // The agent WebGPU runtime is (re)built (init / recompile / target flip) —
      // its render pipeline is gone, so reset our state and re-attach the canvas
      // if the model is eligible. Most gate terms (target / topology / dimension /
      // bonds) force a FULL reinit when they change; the two that do NOT
      // (sprites, agentMappings) are refreshed into agentRenderModelTermsOkRef by
      // the soft-recompile path and re-checked inside maybeAttachAgentCanvas
      // (audit M1) — so this single re-attach point stays correct.
      agentDirectRenderActiveRef.current = false;
      agentRenderCanvasRef.current = null;
      // Phase C: drop the 3D sphere DOM canvas (a runtime rebuild dropped its
      // render pipeline). maybeAttachAgentCanvas appends a fresh one.
      { const sc = agentSphereCanvasRef.current; if (sc?.parentElement) sc.parentElement.removeChild(sc); agentSphereCanvasRef.current = null; }
      pendingAgentRenderCanvas.current = null;
      if (agentRenderEligibleRef.current) maybeAttachAgentCanvas();
    } else if (msg.type === 'agentRenderStatus') {
      if (msg.active && pendingAgentRenderCanvas.current) {
        // Commit the swap. 2D: the placeholder becomes the 1:1 blit source.
        // 3D: the appended DOM sphere canvas (composited by the browser) — the
        // OLD one (kept live through a resize re-attach) leaves the DOM now.
        if (is3dRef.current) {
          const old = agentSphereCanvasRef.current;
          if (old && old !== pendingAgentRenderCanvas.current && old.parentElement) old.parentElement.removeChild(old);
          agentSphereCanvasRef.current = pendingAgentRenderCanvas.current;
        } else agentRenderCanvasRef.current = pendingAgentRenderCanvas.current;
        pendingAgentRenderCanvas.current = null;
        pendingAgentCanvasAttach.current = false;
        agentDirectRenderActiveRef.current = true;
        // E2: the worker echoes whether it actually enabled the composite. Only
        // treat the canvas as a composite when BOTH we requested it AND the worker
        // confirmed (shared device present). If the worker refused (no shared
        // device), the DISPLAY-sized canvas is STILL a valid disc-render surface —
        // just treat it as a plain A1 direct render (no re-attach needed; the canvas
        // is display-sized in both cases now).
        agentCompositeActiveRef.current = !!pendingAgentCompositeRef.current && !!msg.composite;
        if (pendingAgentCompositeRef.current && !msg.composite) agentCompositeEligibleRef.current = false;
        pendingAgentCompositeRef.current = false;
        // Send the initial camera + draw so the canvas shows the current frame.
        const view = computeAgentRenderView();
        if (view && workerRef.current) { lastAgentCameraKeyRef.current = ''; workerRef.current.postMessage({ type: 'setAgentCamera', view }); }
        // MIRROR THE WORKER'S ACTUAL FLAG (the UI-sync mirror invariant). A
        // display resize / metaballs-off re-attaches on the SAME worker, whose
        // `agentUiSync` survives — assuming ON here would strand the mirror and
        // permanently suppress every later ON post (pause / inspect / recording).
        if (agentUiSyncTimerRef.current) { clearTimeout(agentUiSyncTimerRef.current); agentUiSyncTimerRef.current = 0; }
        agentUiSyncPostedRef.current = (msg.uiSync as boolean | undefined) !== false;
        updateAgentUiSync();
        draw();
      } else {
        // Attach failed — stay on the CPU overlay path. Drop BOTH the pending
        // canvas AND any old one a resize re-attach kept alive, and force the
        // agent sync ON so the fallback draws LIVE snapshots (free mode's stale
        // agentsRef otherwise froze the display on an ancient frame).
        agentDirectRenderActiveRef.current = false;
        agentCompositeActiveRef.current = false;
        const p = pendingAgentRenderCanvas.current;
        if (p?.parentElement) p.parentElement.removeChild(p);
        pendingAgentRenderCanvas.current = null;
        agentRenderCanvasRef.current = null;
        const oldS = agentSphereCanvasRef.current;
        if (oldS?.parentElement) oldS.parentElement.removeChild(oldS);
        agentSphereCanvasRef.current = null;
        forceAgentUiSyncOn();
      }
    }
  };

  // Reusable worker initializer (used by structural effect and dimension/image apply)
  const initWorkerWithDimensions = useCallback((w: number, h: number, dOverride?: number) => {
    // Overseer: a worker reinit replaces the worker the runtime is attached to.
    if (overseerRunningRef.current) overseerRuntimeRef.current?.abort('worker reinit');
    // If a recording is in progress, abandon it before tearing down the
    // worker. Otherwise the captured frames (sized to the OUTGOING worker's
    // grid) would mix with future captures (sized to the INCOMING worker's
    // grid), and the GIF builder would encode the mixed buffer at the first
    // frame's dimensions — silently producing a broken / wrong-sized GIF
    // that only partially reflects what the user saw.
    if (recordingRef.current) {
      recordingRef.current = false;
      setRecording(false);
      // Releases the streaming encoder too — abandoning one without cancel()
      // would leak a hardware encoder session.
      resetRecordingState();
      // Tell the worker to stop including colors in stepped messages.
      workerRef.current?.postMessage({ type: 'setRecording', enabled: false });
    }
    workerRef.current?.terminate();
    // Clear stale buffers from the OUTGOING worker. Without this, `draw()`
    // can fire in the gap between `gridWidth.current = w` (below) and the
    // first stepped message from the new worker, and try to build a
    // `new Uint8ClampedArray(colors.buffer, 0, w*h*4)` view sized for the
    // NEW grid over the PREVIOUS worker's smaller colors buffer — throwing
    // "Invalid typed array length" and tearing down React. Same risk
    // applies to inspect-cell maps (a stale entry keyed by a no-longer-
    // -valid cellIdx). srcCanvas is rebuilt on the next draw when needed.
    colorsRef.current = null;
    lastUploadedColors3dRef.current = null;  // colours cleared → force a re-upload after reinit
    lastUploadedAgentSnapRef.current = null; // agents cleared → force a re-upload after reinit
    // L1: the outgoing worker owned the voxel pipelines + the transferred canvas.
    // Drop our state (the fresh worker re-attaches on its first useWebGPUStatus)
    // and remove the stale DOM canvas so it can't linger over the new frame.
    voxelRenderActiveRef.current = false;
    pendingVoxelCanvas.current = null;
    // A BRAND-NEW worker (created a few lines below) starts at the module
    // default ON — the one assumption the mirror invariant allows. Drop any
    // pending OFF debounce armed against the OUTGOING worker.
    if (gridUiSyncTimerRef.current) { clearTimeout(gridUiSyncTimerRef.current); gridUiSyncTimerRef.current = 0; }
    gridUiSyncPostedRef.current = true;
    gridFrameAwaitingColorsRef.current = false;
    lastGridCameraKeyRef.current = '';
    { const vc = voxelCanvasRef.current; if (vc?.parentElement) vc.parentElement.removeChild(vc); voxelCanvasRef.current = null; }
    glyphCodesRef.current = null;
    glyphColorsRef.current = null;
    inspectDataRef.current.clear();
    inspectColorsRef.current.clear();
    inspectOrientationsRef.current.clear();
    srcCanvasRef.current = null;
    const result = compileModel();
    const firstViewer = model.mappings.find(m => m.isAttributeToColor);
    const viewer = firstViewer?.id ?? '';
    setActiveViewer(viewer);
    const firstInput = model.mappings.find(m => !m.isAttributeToColor);
    // Fall back to the always-available Manual Brush when the model has no
    // color-input mappings, so the brush is immediately usable on empty
    // models or models that only define output mappings.
    setBrushMapping(firstInput?.id ?? MANUAL_BRUSH_MAPPING_ID);
    // Suppress the cell "No nodes / No Step" error for an agents-only model (no grid).
    if (result.error && model.topologyMode?.gridCells !== false) setCompileError(result.error);

    // Only reset pan/zoom when the grid dimensions actually change. This
    // function ALSO fires on structural reinit at the same dims (e.g. the
    // user edits an attribute or mapping while pan/zoom-focused on a region)
    // — resetting in that case throws the user back to a fresh view every
    // edit, breaking the back-and-forth tweak workflow.
    // 3D Grid CA: derive the layer count. `dOverride` (from the simulator resize
    // panel) wins; otherwise from the model (dimension 3d ? gridDepth : 1) so the
    // renderer + getState/save agree.
    const d3 = dOverride != null
      ? Math.max(1, dOverride)
      : (model.properties.dimension === '3d' ? Math.max(1, model.properties.gridDepth ?? 1) : 1);
    const dimsChanged = gridWidth.current !== w || gridHeight.current !== h || gridDepth.current !== d3;
    gridWidth.current = w;
    gridHeight.current = h;
    gridDepth.current = d3;
    setSimWidth(w);
    setSimHeight(h);
    setSimDepth(d3);
    if (dimsChanged) {
      zoomRef.current = 1;
      panRef.current = { x: 0, y: 0 };
    }

    // Initialize runtime model attrs from defaults
    setRuntimeModelAttrs(computeDefaultModelAttrs(model.attributes));

    // Snapshot interaction-table defaults the first time we see this
    // modelVersion (= a fresh LOAD_MODEL / NEW_MODEL — modelVersion bumps in
    // ModelContext.tsx only for those two actions, not for per-attribute
    // edits). The simulator's per-cell table editor mutates `model.attributes`
    // directly via updateAttribute, so we need a snapshot taken BEFORE any of
    // those edits to recover the as-loaded values on Reset to Default.
    if (lastSnapshottedVersionRef.current !== modelVersion) {
      lastSnapshottedVersionRef.current = modelVersion;
      const snap: Record<string, { tableValues?: Record<string, Record<string, number>>; tableData?: number[] }> = {};
      for (const a of model.attributes) {
        if (a.type !== 'lookupTable') continue;
        if (isMultiAxisTable(a) && a.tableData) {
          snap[a.id] = { tableData: [...a.tableData] };
        } else if (a.tableValues) {
          snap[a.id] = { tableValues: JSON.parse(JSON.stringify(a.tableValues)) };
        }
      }
      interactionTableDefaultsRef.current = snap;
    }

    const worker = createSimWorker();
    worker.onmessage = (e) => onWorkerMessageRef.current(e);
    // Resize / image-import override grid dimensions WITHOUT updating the
    // model state, so we have to feed the compilers a model with the new
    // dimensions baked in. WASM happens to be tolerant (it takes `total` as
    // a runtime function arg), but WebGPU bakes `total` into the WGSL bounds
    // check — without this override the shader rejects half the cells after a
    // resize-to-larger and the simulator looks half-frozen.
    const effModel = withEffectiveNeighborhoods(model);
    // 3D Grid CA: the resize panel can also override depth (d3 above). Bake
    // gridDepth + dimension into the compiler model too so WebGPU's baked `total`
    // and the 3D decode match (WASM takes total at runtime, but the codec/decode
    // still keys off dimension/gridDepth).
    const modelDepth = model.properties.dimension === '3d' ? Math.max(1, model.properties.gridDepth ?? 1) : 1;
    let dimsModel = (model.properties.gridWidth === w && model.properties.gridHeight === h && modelDepth === d3)
      ? effModel
      : { ...effModel, properties: { ...effModel.properties, gridWidth: w, gridHeight: h, gridDepth: d3, dimension: d3 > 1 ? '3d' as const : effModel.properties.dimension } };
    // Bond-Graph Agents target policy (PR5 — independent targets): the GRID
    // target (useWasm/useWebGPU) now flows through UNMODIFIED for agent models.
    // The agent ENGINE/driver still runs on JS (agentTargetOf clamps to 'js'
    // until Phase F), but the grid CA can be JS / WASM / WebGPU. For a WebGPU
    // grid + JS agents, the worker's WebGPU step branch interleaves runAgentStep
    // and (for field models) bridges attrs CPU↔GPU per generation. The old
    // `useWebGPU = false` force-disable hack is GONE — the bridge replaces it.
    // Viewer→int mapping is target-agnostic — the worker needs it for
    // uploadActiveViewer regardless of which compile target is active. WGSL
    // SetColorViewer-in-step writes are guarded on `control.activeViewer ==
    // <int>`; without this map populated, the upload defaults to -1, no guards
    // fire, and no-OM viewers (e.g. MNCA's "Case Colored") never write colors.
    const viewerIds = buildViewerIds(dimsModel);
    // Generic Agent Platform: compile the agent rule graph — AFTER dimsModel is
    // built, and FROM dimsModel, so a simulator Resize reaches the agent
    // compilers too. The agent WASM/WebGPU layouts bake dims-derived regions
    // (the spatial-hash reserve, fieldTotal); compiling from the raw model
    // desynced them from the live worker dims — the WebGPU "spatial hash
    // exceeds the reserve → runs on JS" demotion after a resize, and a WASM
    // store↔module offset mismatch. Offset the agent stop indices by the cell
    // graph's stop-message count (shared _stopFlag + messages).
    const agentResult = compileAgentModel(result.stopMessages.length, dimsModel);
    // Surface the AGENT graph's compile error too (it was console.warn-only —
    // "agents never move and nothing says why" was the observable symptom, e.g.
    // "No Behaviour Step node in the agent graph.").
    if (agentResult.error) {
      setCompileError(prev => (prev ? `${prev}\n[agents] ${agentResult.error}` : `[agents] ${agentResult.error}`));
    }
    // Wave 2: compile WASM only when the user has selected the WASM target.
    // Mirrors the WebGPU gating below — saves a compile pass per model change
    // when WASM isn't active, and avoids surfacing WASM-only errors when the
    // user is on JS or WebGPU.
    const wasmResult = (() => {
      if (!dimsModel.properties.useWasm) {
        return { bytes: new Uint8Array(), minMemoryPages: 1, error: '', viewerIds, exports: [] };
      }
      try {
        const layout = computeLayoutFromModel(dimsModel);
        return compileGraphWasm(dimsModel.graphNodes, dimsModel.graphEdges, dimsModel, layout, viewerIds);
      } catch (e) {
        return { bytes: new Uint8Array(), minMemoryPages: 1, error: String((e as Error)?.message || e), viewerIds, exports: [] };
      }
    })();
    // Wave 3: compile WebGPU shader alongside JS/WASM. Same fallback pattern:
    // any error and the worker stays on JS — useWebGPU only flips on once the
    // worker successfully acquires a device and the shader module compiles.
    const webgpuResult = (() => {
      // Skip the WebGPU compile when the user hasn't selected the WebGPU target.
      // Otherwise, async-only nodes etc. produce a shader error that the worker
      // would surface as a popup even though the model is running on JS/WASM.
      if (!dimsModel.properties.useWebGPU) {
        return { shaderCode: '', entryPoints: { step: 'step', outputMappings: [] as Array<{ mappingId: string; entry: string }> }, layout: null as never, error: '' };
      }
      try {
        return compileGraphWebGPU(dimsModel.graphNodes, dimsModel.graphEdges, dimsModel);
      } catch (e) {
        return { shaderCode: '', entryPoints: { step: 'step', outputMappings: [] as Array<{ mappingId: string; entry: string }> }, layout: null as never, error: String((e as Error)?.message || e) };
      }
    })();
    // P7 direct render: under WebGPU we eventually transfer srcCanvas's
    // control to an OffscreenCanvas so the worker's WebGPU runtime can write
    // straight to it via the present compute pipeline. We DEFER that transfer
    // until the worker confirms via useWebGPUStatus that the runtime is up —
    // until then srcCanvas stays a regular 2D canvas so the JS-fallback
    // colors path (which the worker uses while async device init is in
    // flight) can still putImageData onto it. Without this deferral, every
    // worker init had a 50-500ms window where the user saw a frozen blank
    // grid even while the worker was correctly evolving CPU state.
    directRenderActiveRef.current = false;
    pendingCanvasAttach.current = false;
    pendingDirectRenderCanvas.current = null;
    // Drop any prior srcCanvas reference — if the previous worker init went
    // through the direct-render path, srcCanvasRef holds a transferred canvas
    // whose 2D context is permanently unavailable. Re-using it here would
    // make all later getImageData / drawImage calls fail silently (visible
    // symptom: GIF recording captures zero frames after a WebGPU→JS toggle).
    {
      const fresh = document.createElement('canvas');
      fresh.width = w; fresh.height = h;
      srcCanvasRef.current = fresh;
    }
    const offscreenSupported = typeof HTMLCanvasElement !== 'undefined'
      && typeof (HTMLCanvasElement.prototype as { transferControlToOffscreen?: unknown }).transferControlToOffscreen === 'function';
    // Mark that we want to attach a canvas once the worker reports ready.
    // The actual transferControlToOffscreen + postMessage('attachCanvas')
    // happens in the useWebGPUStatus handler.
    // 3D Grid CA: do NOT attach the canvas in 3D — WebGPU direct-render writes to
    // the OffscreenCanvas and skips the CPU colors readback, but the WebGL2 voxel
    // renderer needs that colors buffer. Skipping the attach keeps WebGPU on the
    // readback path (colors shipped via `stepped`), so WebGPU COMPUTE still runs
    // and the GL renderer draws from colorsRef.
    //
    // Bond-Graph Agents (PR5, C-D2): same gate, same reason — an agent model on
    // a WebGPU grid MUST stay on the colors-READBACK render path. The agent
    // overlay (drawAgentsOverlay) is a main-thread composite on top of the cell
    // colors blit, and WebGPU *direct* render writes straight to the
    // OffscreenCanvas, skipping the per-step colors readback the overlay needs.
    // Costs a modest per-step colors readback for agent+WebGPU models — accepted.
    const agentModel = !!model.topologyMode?.agents;
    if (dimsModel.properties.useWebGPU && !webgpuResult.error && offscreenSupported && !is3D && !agentModel) {
      pendingCanvasAttach.current = true;
    }
    // L1 — worker-side WGSL VOXEL render gate (GENERAL model properties only).
    // A 3D volume on the WebGPU target renders from the GPU inside the worker: no
    // per-frame colours readback, no colours postMessage, no main-thread
    // uploadColors rescan. Terms:
    //   is3D (a real volume: dimension '3d' AND gridDepth > 1 — see d3 above)
    //   + the resolved GRID target is WebGPU
    //   + OffscreenCanvas support
    //   + NOT an agent model — the agent sphere pass already owns a layered canvas
    //     (Phase C) and compositing voxels with spheres in ONE depth buffer is a
    //     separate follow-up, so 3D grid+agents keeps today's path
    //   + no glyphs — the glyph overlay is a main-thread pass over the per-cell
    //     glyph buffers (and is already badge-rejected in 3D)
    // Cast shadows, occupancy AO and alpha blend are NOT attach terms: they are
    // frame-mode features (the WGSL pass doesn't replicate them), enforced by the
    // UI-sync driver — enabling any of them keeps UI-sync permanently ON, which
    // hides the voxel canvas and makes gl3d render the frame exactly as today.
    const voxelRenderEligible =
      is3D
      && !!dimsModel.properties.useWebGPU && !webgpuResult.error
      && offscreenSupported
      && !agentModel
      && !hasGlyphsInModel(model);
    voxelRenderEligibleRef.current = voxelRenderEligible;
    voxelRenderActiveRef.current = false;
    pendingVoxelCanvas.current = null;
    // Same tick as the fresh `createSimWorker()` above → module default ON.
    if (gridUiSyncTimerRef.current) { clearTimeout(gridUiSyncTimerRef.current); gridUiSyncTimerRef.current = 0; }
    gridUiSyncPostedRef.current = true;   // worker default is ON
    gridFrameAwaitingColorsRef.current = false;
    lastGridCameraKeyRef.current = '';
    // Direct AGENT render gate (all GENERAL model properties). The WORKER renders
    // agents into the OffscreenCanvas; the main thread blits 1:1.
    //   A1: a WebGPU-target model renders from the resident GPU SoA.
    //   A2: a CPU (JS / WASM) target — the worker uploads the CPU store's positions/
    //       colours each frame into a render-only surface and presents (the CPU keeps
    //       simulating; only the DRAW moves to the GPU). The CPU present ALWAYS uploads
    //       `s.colors` = CPU-computed colours INCLUDING Agent Output Mappings
    //       (runAgentColorPass writes them), so OM models ARE render-eligible on a CPU
    //       target. The OM exclusion is KEPT for the WebGPU target: a resident WebGPU
    //       batch presents the GPU `agentColors` the behaviour wrote (NOT the CPU OM
    //       `s.colors`), so a WebGPU+OM model must stay on the CPU overlay until A1.5
    //       compiles the OM into a GPU colour pass.
    // Shared exclusions: field-decoupled + 2D + OffscreenCanvas + no CPU-only
    // visual (sprites / metaballs). The worker demotes to the CPU overlay if the
    // device build fails (WebGPU unavailable on a CPU target).
    // Phase D: the agents-only proxy (`gridCells === false`) is replaced by the
    // true term — field DECOUPLING. A grid+agents model whose agent layer never
    // touches a cell field is two independent sims sharing a viewport: the agent
    // layer direct-renders above the grid's own render (2D composite). The
    // predicate mirrors the worker's `agentResidentEligible`: no field node
    // reachable (agentUsesField) AND no cell attr grants agent access. 3D
    // grid+agents keeps the CPU path in D (voxels-vs-spheres depth compositing
    // across two canvases is Phase E) — hence the `&& !is3D` on the decoupled arm;
    // 3D agents-only is still eligible via `gridCells === false`.
    const agentDecoupled =
      !agentUsesField()
      && (model.attributes ?? []).every(a => !a.agentAccess || a.agentAccess === 'none');
    const agentRenderEligible =
      agentModel && (model.topologyMode?.gridCells === false || (agentDecoupled && !is3D))
      && offscreenSupported
      && !agentMetaballsRef.current.enabled
      // No sprites (a CPU-only visual the GPU disc pass can't draw), and — on the
      // WebGPU target — either no agent Output Mappings or an OM graph that
      // compiled to GPU colour passes (A1.5: they write agentColors GPU-side, so
      // the resident batch presents the correct OM colours; an unsupported OM keeps
      // the CPU overlay). Both terms are re-evaluated on a soft recompile — see
      // agentRenderModelTermsOk / agentRenderModelTermsOkRef (audit M1).
      && agentRenderModelTermsOk(model.sprites, model.agentMappings, agentResult.agentTarget, agentResult.agentWebgpuOmSupported)
      // NO BOND LINES (audit H1 — BOTH dimensions, not just 3D). The GPU pass draws
      // discs (2D) / sphere impostors (3D) only, and under direct render draw()
      // skips drawAgentsOverlay() entirely — which is the SOLE bond renderer. A
      // bonded model would silently lose its bond lines (and the showBonds Layers
      // toggle would become a no-op), which is the defining visual of a tissue
      // model. Emitting bond lines in the GPU pass is a real render feature (a line
      // pipeline + the bond pair buffer), not a wiring repair — recorded as a
      // follow-up; until then a bonded model keeps the CPU overlay.
      && resolveMaxBonds(model.centerBased) === 0
      // Phase C: 3D adds — alpha-blend OFF (translucent spheres need back-to-front
      // sorting = gl3d's job; opaque impostors here). 2D is unaffected.
      && (!is3D || !alpha3dRef.current);
    // E2 — DISPLAY-res single-canvas composite gate. A 2D grid+agents model with a
    // WebGPU GRID + a WebGPU AGENT target composites the grid layer + the agent discs
    // into ONE DISPLAY-sized canvas in one encoder: the grid layer is a fullscreen
    // triangle whose FS INVERTS the camera (display pixel → world coord → cell →
    // grid colorsBuf, NEAREST = crisp CA-block cells), and the agent discs render
    // through the SAME display-res camera as the A1 render — so agents stay crisp
    // discs at any zoom (the fix for the world-res "blob of cells" the first E2 was
    // disabled for). This removes the grid's per-gen colors readback (sendColors
    // ships no `colors` when agentCompositeActive) and the two-canvas composite.
    // Covers BOTH decoupled (D, e.g. GoL+Boids) and field-coupled (E1b, e.g.
    // Chemotaxis) grid+agents — the composite only READS colorsBuf for display; the
    // E1b GPU field bridge is orthogonal and untouched. Requires the WebGPU agent
    // runtime (so the render surface exists) on the SAME shared device (E1) as the
    // grid — asserted worker-side; a CPU agent target keeps the D two-canvas / A2
    // path. The model terms (sprites / OM) + metaballs are the same exclusions as
    // the A1 render. The 3D voxel+sphere composite stays out of scope.
    const agentComposite =
      agentModel && model.topologyMode?.gridCells !== false && !is3D
      && !!dimsModel.properties.useWebGPU && !webgpuResult.error
      && agentResult.agentTarget === 'webgpu'
      && offscreenSupported
      && agentRenderModelTermsOk(model.sprites, model.agentMappings, agentResult.agentTarget, agentResult.agentWebgpuOmSupported)
      && !agentMetaballsRef.current.enabled;
    // The union drives the attach machinery (a field-coupled composite model is
    // NOT agentRenderEligible — agentDecoupled is false — but IS composite-eligible).
    agentRenderEligibleRef.current = agentRenderEligible || agentComposite;
    // M1: seed the live-term ref from the SAME helper the gate above used, so a
    // later re-attach (display resize / metaballs off) re-checks the same terms.
    agentRenderModelTermsOkRef.current =
      agentRenderModelTermsOk(model.sprites, model.agentMappings, agentResult.agentTarget, agentResult.agentWebgpuOmSupported);
    agentCompositeEligibleRef.current = agentComposite;
    agentCompositeActiveRef.current = false;
    agentDirectRenderActiveRef.current = false;
    pendingAgentRenderCanvas.current = null;
    pendingAgentCanvasAttach.current = agentRenderEligible || agentComposite;
    // Same tick as the fresh `createSimWorker()` above → module default ON.
    if (agentUiSyncTimerRef.current) { clearTimeout(agentUiSyncTimerRef.current); agentUiSyncTimerRef.current = 0; }
    agentUiSyncPostedRef.current = true;   // worker default is ON
    // 3D Grid CA: effective layer count = d3 computed above (honours a resize-
    // panel dOverride; otherwise the model's depth, only when dimension==='3d' so
    // the worker's `depth` stays in lockstep with the compilers' `is3d`).
    const d = d3;
    const initMsg: Record<string, unknown> = {
      type: 'init',
      width: w,
      height: h,
      depth: d,
      // Expand `vector` cell attributes into their scalar-float components so the
      // worker SoA + computeMemoryLayout match the compiler's component reads/writes
      // (ABI-mirror; the WASM layout expands identically). No-op when none.
      attributes: expandVectorAttributes(model.attributes).map(toAttrDefMsg),
      // Generic Agent Platform: the AGENT attribute set (separate id-space).
      agentAttributes: expandVectorAttributes(model.agentAttributes ?? []).map(toAttrDefMsg),
      // Graph-Rewriting Automata (P2): the BOND attribute set (per-EDGE state).
      // `bondAttrsOf` applies the Bonds-off + allowed-type filters HERE, so the
      // worker's store specs are the same ordered list the compiler's ABI block +
      // memory layout derive from (the baked-offset lockstep). NOT vector-expanded:
      // `vector` is outside the allowed bond-attribute type set (decision D1).
      bondAttributes: bondAttrsOf(model).map(toAttrDefMsg),
      neighborhoods: effModel.neighborhoods.map(n => ({ id: n.id, coords: n.coords, coords3d: n.coords3d })),
      boundaryTreatment: model.properties.boundaryTreatment,
      updateMode: model.properties.updateMode || 'synchronous',
      asyncScheme: model.properties.asyncScheme || 'random-order',
      stepCode: result.stepCode,
      initCode: result.initCode,
      gridInitCode: result.gridInitCode,
      // "Skip Isolated Empty Cells" (docs/PLAN_LARGE_GRID_PERF.md) — the worker
      // resolves the active-set spec from it. Absent/off → full loop.
      skipIsolatedEmpty: dimsModel.properties.skipIsolatedEmpty,
      inputColorCodes: result.inputColorCodes,
      outputMappingCodes: result.outputMappingCodes,
      // FIX 4: cell + agent stop messages share one array (the agent indices were
      // offset by the cell count at compile time).
      stopMessages: [...result.stopMessages, ...agentResult.stopMessages],
      activeViewer: viewer,
      // Variegated Cells: orientation buffer + face-pattern lookup + the
      // interaction-table payload. The worker only allocates these when
      // variegatedCells.enabled is true; absent / disabled = no extra state.
      variegated: model.variegatedCells?.enabled ? {
        sourceAttributeId: model.variegatedCells.sourceAttributeId,
        facePalettes: model.variegatedCells.facePalettes,
        facePatterns: model.variegatedCells.facePatterns,
        facePatternAssignments: ((): Record<string, string> => {
          const src = model.attributes.find(a => a.id === model.variegatedCells!.sourceAttributeId);
          return src?.facePatternAssignments || {};
        })(),
      } : undefined,
      // Lookup tables — sent whenever the model has any (independent of
      // variegation; tag×tag tables need no faces). Legacy tables ship
      // labels + sparse values; multi-axis tables ship dims + dense data
      // (ONE shared builder — buildLookupTablePayload — so the shape can't
      // drift from the worker's normalizer / the compilers' layouts).
      interactionTables: model.attributes
        .filter(a => a.isModelAttribute && a.type === 'lookupTable')
        .map(a => buildLookupTablePayload(a, model)),
      indicators: (model.indicators || []).map(i => ({
        id: i.id, kind: i.kind, dataType: i.dataType,
        defaultValue: i.defaultValue, accumulationMode: i.accumulationMode,
        tagOptions: i.tagOptions,
        linkedAttributeId: i.linkedAttributeId,
        linkedAggregation: i.linkedAggregation,
        binCount: i.binCount,
        xAxis: i.xAxis, spatialBinMode: i.spatialBinMode,
        spatialBinCount: i.spatialBinCount, spatialBinSize: i.spatialBinSize,
        trackedValues: i.trackedValues,
        graphMetric: i.graphMetric,
        watched: i.watched,
      })),
      wasmStepBytes: wasmResult.error ? undefined : wasmResult.bytes,
      wasmStepError: wasmResult.error,
      wasmExports: wasmResult.exports,
      viewerIds: wasmResult.viewerIds,
      useWasm: !!dimsModel.properties.useWasm,
      webgpuShaderCode: webgpuResult.error ? undefined : webgpuResult.shaderCode,
      webgpuShaderError: webgpuResult.error,
      webgpuEntryPoints: webgpuResult.error ? undefined : webgpuResult.entryPoints,
      webgpuLayout: webgpuResult.error ? undefined : webgpuResult.layout,
      useWebGPU: !!dimsModel.properties.useWebGPU,
      webgpuStopCheckInterval: Math.max(1, Math.floor(model.properties.webgpuStopCheckInterval ?? 1)),
      // Glyph overlay regions are only allocated when the graph actually uses
      // setCellGlyph. Worker reads this BEFORE initGrid so layout reserves the
      // matching memory (and the views are non-null).
      hasGlyphs: hasGlyphsInModel(model),
      // Bond-Graph Agents: allocate the agent engine when the model has the
      // Agents topology. The agent world is the grid coordinate frame (1:1), so
      // agents are additive on top of the always-present grid. The compiled
      // agent behaviour/init code is attached by the agent compile path (A3).
      agents: !!model.topologyMode?.agents,
      // When the CA-grid topology is OFF (an agents-only model), skip the cell
      // step + the neighbour-index tables entirely — no grid is simulated, so the
      // worker pays nothing for the (possibly large) lattice. Absent → true (every
      // existing grid model). Mutually with `agents` it can't be all-false (reducer).
      gridCells: model.topologyMode?.gridCells !== false,
      centerBased: model.centerBased,
      agentBehaviourCode: agentResult.behaviourCode,
      agentInitCode: agentResult.initCode,
      agentDivisionCode: agentResult.divisionCode,
      agentColorViewer: activeAgentViewerRef.current || agentResult.colorViewer,
      agentOutputMappingCodes: agentResult.outputMappingCodes,
      agentHasSprites: (model.sprites?.length ?? 0) > 0,
      // P4 - the structural-request QUEUE stride the compiled agent code bakes.
      // Shipped on every target so the store's array shapes and the emitters'
      // baked stride are ONE number (bondReqSlotsForModel is the single source).
      agentBondReqSlots: bondReqSlotsForModel(model),
      agentDividePartitions: agentResult.dividePartitions,
      // PR5 (C-D1): whether the agent graph reads/writes the cell field. Drives
      // the WebGPU-grid field bridge (a no-field model does 0 per-step
      // readbacks). Cheap boolean — leave the JS/WASM grid path untouched.
      agentUsesField: agentUsesField(),
      agentUsesDensity: agentUsesDensity(),
      rulesReadComputedIndicator: rulesReadComputedIndicator(),
      agentResidencyClean: agentResult.agentResidencyClean,
      // PR6b-1: the resolved agent compile target + the compiled WASM agent loop
      // bytes (only when 'wasm'). The worker backs the AgentStore on a
      // WebAssembly.Memory + runs the WASM behaviour fn instead of the JS one;
      // the JS behaviourCode above stays as the fallback.
      agentTarget: agentResult.agentTarget,
      agentWasmBytes: agentResult.agentWasmBytes,
      agentWasmViewerGuardIds: agentResult.agentWasmViewerGuardIds,
      agentLayoutExtras: agentResult.agentLayoutExtras,
      agentWasmLayoutSig: agentResult.agentWasmLayoutSig,
      // PR7 G3-runtime: when the agent target resolves to 'webgpu', ship the two
      // compiled WGSL shaders + the GPU agent layout dims. The worker builds a
      // dedicated agent WebGPU runtime (its own device) + dispatches both passes
      // per step; any failure demotes to the JS behaviour fn.
      agentWebgpuBehaviourShader: agentResult.agentWebgpuBehaviourShader,
      agentWebgpuForceShader: agentResult.agentWebgpuForceShader,
      agentWebgpuMaxAgents: agentResult.agentWebgpuMaxAgents,
      agentWebgpuMaxHashBins: agentResult.agentWebgpuMaxHashBins,
      agentWebgpuLayout: agentResult.agentWebgpuLayout,
      agentRenderLayout: agentResult.agentRenderLayout,
      agentWebgpuUsesI32Write: agentResult.agentWebgpuUsesI32Write,
      agentWebgpuUsage: agentResult.agentWebgpuUsage,
      agentWebgpuOmShaders: agentResult.agentWebgpuOmShaders,
    };
    // Canvas transfer is deferred to the useWebGPUStatus handler — see
    // pendingCanvasAttach above. The init message never carries webgpuCanvas
    // anymore; the worker's startWebGPUInit runs without a canvas, falls
    // through to the readback path until attachCanvas arrives.
    worker.postMessage(initMsg);
    workerRef.current = worker;
    // Re-publish the runtime layer-freeze toggles to the fresh worker (a reinit
    // resets the worker's defaults to true; the live effect below doesn't re-fire
    // on a worker swap). Forced true for a non-agent model (the toggles are global
    // but only editable on an agent model). Cheap; default true → no-op.
    const effSimCells = !isAgentModelRef.current || simulateCellsRef.current;
    const effSimAgents = !isAgentModelRef.current || simulateAgentsRef.current;
    if (!effSimCells || !effSimAgents) {
      worker.postMessage({ type: 'setSimLayers', simulateCells: effSimCells, simulateAgents: effSimAgents });
    }
    // Same discipline: a fresh worker defaults to NOT shipping velocity, so
    // re-publish the vision display's need for it (the live effect above
    // doesn't re-fire on a worker swap).
    if (showVisionRef.current !== 'off') {
      worker.postMessage({ type: 'setAgentSnapshotVelocity', on: true });
    }
    // Re-publish any open inspect-popup subscriptions to the fresh worker so
    // values keep streaming after a recompile / hard re-init.
    if (inspectCellIdxsRef.current.length > 0) {
      worker.postMessage({ type: 'setInspectCells', cellIdxs: inspectCellIdxsRef.current });
    }
    if (import.meta.env?.DEV) (window as unknown as { __simWorker?: Worker }).__simWorker = worker;
    generationRef.current = 0;
    lastGenSetTime.current = 0;
    setGeneration(0);
    setPlaying(false);
    indicatorValuesRef.current = {};
    indicatorHistoryRef.current = {};
    // NOTE: don't reset chartExpandedRef here. IndicatorDisplay populates it
    // during its render (via a ref-compare notification pattern tied to the
    // indicator id list), and that render happens BEFORE this useEffect runs.
    // Resetting it here wipes those entries, which means the FIRST few stepped
    // messages arrive with an empty expanded set and never populate history —
    // causing scalar sparklines to stay blank until a manual collapse/expand
    // remounts IndicatorSparkline. IndicatorDisplay's own indicator-id-change
    // detection handles the "new model" case by re-notifying as needed; stale
    // entries for removed indicators are harmless (the collection loop skips
    // ids whose value is missing from the incoming message).
    pendingStep.current = false;
    lastGenForGps.current = 0;
    gpsGens.current = 0;

    // Queue simulation state restoration if present in loaded model — but
    // only when the embedded snapshot still matches the current model's
    // structural settings. A grid resize OR a boundary-treatment change
    // invalidates the snapshot (cells were laid out for the old shape), so
    // we drop it rather than re-applying it. Otherwise the auto-restore
    // would re-trigger applySimulationState's "adapt model to state" branch
    // and silently revert the user's just-made boundary toggle to whatever
    // was active when the snapshot was saved.
    //
    // NOTE: Don't clobber an already-pending restore. `applySimulationState`
    // may have queued a preset's state BEFORE triggering this reinit (by
    // dispatching updateProperties). Overwriting with `model.simulationState`
    // here would drop the preset's modelAttrs, requiring a second click to
    // restore them.
    if (model.simulationState && !pendingSimStateRestore.current) {
      const s = model.simulationState;
      // 3D Grid CA: include DEPTH in the match (a snapshot is laid out for a
      // specific W×H×D). Without this a gridDepth edit slips through as
      // "compatible", the stale snapshot is re-armed, and applySimulationState's
      // adapt branch reverted the depth — the dimension-reset loop in 3D.
      const sDepth = s.gridDepth ?? s.depth ?? 1;
      const dimsMatch = (s.width == null && s.height == null)
        ? sDepth === d3
        : (s.width === w && s.height === h && sDepth === d3);
      // Stored states from before boundary was tracked have no
      // `boundaryTreatment` field — treat as compatible (don't pre-emptively
      // drop them). Newer snapshots are stamped on save.
      const boundaryMatch = !s.boundaryTreatment
        || s.boundaryTreatment === model.properties.boundaryTreatment;
      if (dimsMatch && boundaryMatch) {
        pendingSimStateRestore.current = model.simulationState;
      } else {
        pendingSimStateRestore.current = null;
        setSimulationState(undefined);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, compileModel]);

  // Terminate worker on unmount only (not on re-renders)
  useEffect(() => {
    return () => {
      overseerRuntimeRef.current?.abort('simulator unmounted');
      // Release an in-flight streaming recording — the VideoEncoder holds a
      // hardware session that would otherwise outlive the component.
      webmStreamRef.current?.cancel();
      webmStreamRef.current = null;
      webmStreamPendingRef.current = [];
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  // Listen for project-save events to auto-capture simulation state.
  // `detail.include` is { grid?: boolean; controls?: boolean } — FileMenu's dialog fills it in.
  // If neither is included we still resolve immediately and clear simulationState.
  useEffect(() => {
    const captureState = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { resolve?: (state?: SimulationState | null) => void; include?: { grid?: boolean; controls?: boolean } }
        | undefined;
      const resolve = detail?.resolve;
      const include = detail?.include ?? { grid: true, controls: true };
      const wantGrid = include.grid !== false;
      const wantControls = include.controls !== false;

      if (!wantGrid && !wantControls) {
        // Nothing to capture — clear any stale embedded state from the model
        // and tell the caller "use no state" (null, distinct from undefined
        // which means "use whatever's already on the model").
        setSimulationState(undefined);
        resolve?.(null);
        return;
      }
      if (!workerRef.current) { resolve?.(null); return; }

      if (!wantGrid) {
        // Controls only: no need to round-trip through the worker. The current
        // model-attribute values live in `runtimeModelAttrs` (mirrors the
        // worker's cachedModelAttrs); pass them through so a controls-only save
        // doesn't silently zero out the user's tuned parameters.
        const state = serializeSimState(
          {
            generation: 0,
            width: gridWidth.current,
            height: gridHeight.current,
            // Record the real depth so a 3D controls-only save serializes
            // gridDepth correctly — without it serializeSimState defaults
            // gridDepth to 1 and the reload drop-guard discards the embedded
            // controls on a 3D model (dimension mismatch).
            depth: gridDepth.current,
            attributes: {},
            modelAttrs: { ...runtimeModelAttrs }, indicators: {}, linkedAccumulators: {},
            colors: new ArrayBuffer(0),
          },
          { activeViewer, brushColor, brushW, brushH, brushShape, brushRadius, brushRingWidth, brushLineWidth, brushMapping, targetFps, unlimitedFps, gensPerFrame, unlimitedGens, indicatorChartOverrides },
          { grid: false, controls: true },
          { boundaryTreatment: model.properties.boundaryTreatment },
        );
        setSimulationState(state);
        resolve?.(state);
        return;
      }

      // If a previous capture is still pending (worker hasn't replied yet),
      // resolve the prior promise rather than letting it hang. The replacement
      // capture will still finish via the new pendingStateSave callback.
      if (pendingStateSave.current) {
        // Drop the prior callback silently — its caller will see captured=null
        // via its own 5s timeout, but we keep the worker round-trip available
        // for the new request rather than racing two state messages.
        pendingStateSave.current = null;
      }
      pendingStateSave.current = (workerState) => {
        const state = serializeSimState(
          workerState as Parameters<typeof serializeSimState>[0],
          { activeViewer, activeAgentViewer: activeAgentViewerRef.current || undefined, brushColor, brushW, brushH, brushShape, brushRadius, brushRingWidth, brushLineWidth, brushMapping, targetFps, unlimitedFps, gensPerFrame, unlimitedGens, indicatorChartOverrides },
          { grid: wantGrid, controls: wantControls },
          { boundaryTreatment: model.properties.boundaryTreatment },
        );
        setSimulationState(state);
        // Pass the freshly-captured state back through the event so callers
        // (FileMenu.doSave) can serialise it directly without depending on
        // React having flushed the setSimulationState dispatch.
        resolve?.(state);
      };
      workerRef.current.postMessage({ type: 'getState' });
    };
    window.addEventListener('genesis-capture-sim-state', captureState);
    return () => window.removeEventListener('genesis-capture-sim-state', captureState);
  }, [activeViewer, brushColor, brushW, brushH, brushShape, brushRadius, brushRingWidth, brushLineWidth, brushMapping, targetFps, unlimitedFps, gensPerFrame, unlimitedGens, setSimulationState, runtimeModelAttrs, model.properties.boundaryTreatment]);

  // Smart init vs recompile: compare previous model to decide.
  // Full reinit for structural changes (grid size, attributes, neighborhoods, mappings, update mode).
  // Soft recompile for graph or indicator watch changes (preserves grid state).
  const prevModelRef = useRef<typeof model | null>(null);
  useEffect(() => {
    const prev = prevModelRef.current;
    prevModelRef.current = model;

    // Overseer: any model change while an experiment runs invalidates the
    // program (the driver was compiled from the old model; a reinit/recompile
    // changes the worker under its feet) — abort cleanly with a journal note.
    if (prev && overseerRunningRef.current) abortExperiment('model changed');

    const needsFullInit = !prev || !workerRef.current
      || prev.properties.gridWidth !== model.properties.gridWidth
      || prev.properties.gridHeight !== model.properties.gridHeight
      // 3D Grid CA (B2): depth/dimension change the lattice size (total = W*H*D)
      // and the baked WASM/WebGPU `total` literal — a soft recompile would keep
      // the stale W*H buffers, so force a full reinit.
      || (prev.properties.gridDepth ?? 1) !== (model.properties.gridDepth ?? 1)
      || (prev.properties.dimension ?? '2d') !== (model.properties.dimension ?? '2d')
      || prev.properties.boundaryTreatment !== model.properties.boundaryTreatment
      || prev.properties.updateMode !== model.properties.updateMode
      || prev.properties.asyncScheme !== model.properties.asyncScheme
      || prev.properties.useWasm !== model.properties.useWasm
      || prev.properties.useWebGPU !== model.properties.useWebGPU
      || !attrsStructurallyEqual(prev.attributes, model.attributes)
      || variegatedLayoutKey(prev) !== variegatedLayoutKey(model)
      || prev.neighborhoods !== model.neighborhoods
      || prev.mappings !== model.mappings
      // Glyph regions are allocated at init time; changing whether the model
      // uses setCellGlyph requires re-laying out wasmMemory.
      || hasGlyphsInModel(prev) !== hasGlyphsInModel(model)
      // Bond-Graph Agents: toggling the Agents topology allocates / frees the
      // agent engine; changing the SoA ceilings (maxAgents / maxBonds) resizes
      // its arrays — both need a full reinit (a soft recompile keeps the stale
      // store). Live force/bond params (handled via recompile / updateModelAttrs)
      // do NOT force a reinit.
      || !!prev.topologyMode?.agents !== !!model.topologyMode?.agents
      // Toggling the CA-grid topology changes whether the worker builds the
      // neighbour tables + runs the cell step — a structural reinit.
      || (prev.topologyMode?.gridCells !== false) !== (model.topologyMode?.gridCells !== false)
      || (prev.centerBased?.maxAgents ?? 0) !== (model.centerBased?.maxAgents ?? 0)
      // Compare the PROFILE-AWARE effective bond stride (STEP 3): the Bonds
      // capability drops maxBonds to 0 WITHOUT changing `centerBased.maxBonds`, so
      // toggling Bonds off must still force a full reinit — otherwise a soft
      // recompile rebuilds the WASM agent module with the new (0) bond layout while
      // the wasmBacked store keeps its old baked offsets → memory desync. Comparing
      // `resolveMaxBonds` subsumes the old raw-maxBonds check (it captures both the
      // config ceiling change AND the capability toggle).
      || resolveMaxBonds(prev.centerBased) !== resolveMaxBonds(model.centerBased)
      // P4: the STRUCTURAL REQUEST QUEUE stride IS the shape of the request arrays
      // (and of the baked WASM / WGSL offsets), so a depth change — or ADDING the
      // first Form / Break / Rewire Bond node to the graph, which flips the stride
      // from the byte-identical 1 to D+1 — needs a full reinit, not a soft
      // recompile (which would leave the store allocated against the old stride).
      // `bondReqSlotsForModel` subsumes both (it is the one number every side bakes).
      || bondReqSlotsForModel(prev) !== bondReqSlotsForModel(model)
      // PR5: the Agent Compile Target is independent of the grid target. Changing
      // it switches the agent driver's memory residency (Phase F: JS↔WASM↔WebGPU),
      // so it needs a full reinit, not a soft recompile (mirrors useWasm/useWebGPU).
      || (prev.centerBased?.agentTarget ?? 'js') !== (model.centerBased?.agentTarget ?? 'js')
      // The Agent Update Mode (sync/async — independent of the grid's updateMode)
      // changes the attribute-buffer allocation (double- vs single-buffered) in
      // createAgentStore, so it needs a full reinit too.
      || (prev.centerBased?.agentUpdateMode ?? 'async') !== (model.centerBased?.agentUpdateMode ?? 'async')
      // Generic Agent Platform: the AGENT attribute set drives the agent SoA +
      // the baked agent-WASM memory offsets — adding/removing/retyping one resizes
      // the store, so it needs a full reinit (a soft recompile keeps the stale SoA).
      || !attrsStructurallyEqual(prev.agentAttributes ?? [], model.agentAttributes ?? [])
      // Graph-Rewriting Automata (P2): the BOND attribute set drives the RAGGED
      // bond regions in the agent memory layout AND the `_bondAttr_<id>` ABI block.
      // Adding / removing / RETYPING / REORDERING one changes both, so it needs a
      // full reinit — a soft recompile would re-bake the module against a layout
      // the live memory doesn't have (the baked-offset corruption class). Order
      // matters (the regions are appended in list order), and `attrsStructurallyEqual`
      // is index-wise, so a reorder is caught.
      || !attrsStructurallyEqual(prev.bondAttributes ?? [], model.bondAttributes ?? [])
      // Indicators are reserved exactly 8 bytes each in the baked wasmMemory
      // layout (no headroom), with rngState / order / scratch immediately after.
      // A soft recompile re-bakes the WASM module against the NEW indicator count
      // but reuses the OLD-sized wasmMemory → the cachedIndicators view would
      // overrun into rngState/order and the new module's baked offsets desync. So
      // a change in the indicator COUNT forces a full reinit (rebuilds the layout
      // + memory); same-count edits still ride the soft recompile + updateIndicators.
      || (prev.indicators?.length ?? 0) !== (model.indicators?.length ?? 0)
      // "Skip Isolated Empty Cells": the config drives the baked wasmMemory
      // layout (the active-list region + the compact nbr tables) AND the step
      // fn's signature — ANY change forces a full reinit so the module, memory,
      // and worker active-set can never desync (a soft recompile would re-bake
      // the module against a layout the live memory doesn't have).
      || JSON.stringify(prev.properties.skipIsolatedEmpty ?? null) !== JSON.stringify(model.properties.skipIsolatedEmpty ?? null);

    if (needsFullInit) {
      workerRef.current?.terminate();
      workerRef.current = null;
      // Drop the previous model's agent render snapshot so it doesn't linger in
      // the view during the reinit gap (the new worker's first `stepped` will
      // repopulate it for an agent model; a non-agent model leaves it null so no
      // agents draw). Fixes stale agents from a previously-loaded model — seen
      // in 3D (the gl3d agent buffer) but reset here for the 2D overlay too.
      agentsRef.current = null;
      lastUploadedAgentSnapRef.current = null;
      // When a freshly loaded model embeds a simulationState whose grid dims
      // differ from properties.gridWidth/Height (typical after an F5 Resize
      // before save — properties stay at the original size, the snapshot has
      // the resized size), initialise the worker at the SNAPSHOT's dims. This
      // avoids the dim-mismatch drop in initWorkerWithDimensions that would
      // otherwise scrub the snapshot and show a default grid. We can tell it's
      // a "fresh" snapshot (vs a stale one left over from a properties-only
      // edit) by comparing object identity to the previous model — load sets
      // a new simulationState reference; properties-edit leaves it alone.
      const snapJustChanged = !prev
        || (model.simulationState && model.simulationState !== prev.simulationState);
      const snapW = snapJustChanged
        ? (model.simulationState?.gridWidth ?? model.simulationState?.width ?? model.properties.gridWidth)
        : model.properties.gridWidth;
      const snapH = snapJustChanged
        ? (model.simulationState?.gridHeight ?? model.simulationState?.height ?? model.properties.gridHeight)
        : model.properties.gridHeight;
      initWorkerWithDimensions(snapW, snapH);
    } else {
      // Graph or indicator watch change only → soft recompile (preserves grid)
      // The Resize button updates `gridWidth.current` / `gridHeight.current` but
      // intentionally does NOT update model.properties (so the model isn't
      // marked dirty for a temporary experiment). Mirror the dimsModel pattern
      // from the full-reinit branch so the recompile sees the actual current
      // dims — otherwise WebGPU bakes the OLD `total` into its bounds check
      // and only the first N rows of the resized grid get computed (the
      // "top stripe" symptom). JS / WASM are tolerant (total is a runtime
      // arg there); only WebGPU exhibits the bug.
      const curW = gridWidth.current;
      const curH = gridHeight.current;
      // 3D Grid CA: also carry the live DEPTH. A simulator-panel depth-resize
      // sets gridDepth.current WITHOUT touching model.properties.gridDepth, so on
      // a soft recompile the model's depth is stale — WebGPU would bake
      // total = W*H*staleDepth and freeze every layer past it. Mirror the
      // full-reinit dimsModel (W/H + gridDepth + dimension).
      const curD = gridDepth.current;
      const modelDepth = model.properties.dimension === '3d' ? Math.max(1, model.properties.gridDepth ?? 1) : 1;
      const effModel = withEffectiveNeighborhoods(model);
      let dimsModel = (model.properties.gridWidth === curW && model.properties.gridHeight === curH && modelDepth === curD)
        ? effModel
        : { ...effModel, properties: { ...effModel.properties, gridWidth: curW, gridHeight: curH, gridDepth: curD, dimension: curD > 1 ? '3d' as const : effModel.properties.dimension } };
      // Bond-Graph Agents (PR5 — independent targets): the grid target flows
      // through unmodified for agent models too. The old `useWebGPU = false`
      // force-disable hack is GONE — the worker's WebGPU step branch bridges the
      // field CPU↔GPU per generation. See the init-path comment for rationale.
      const result = compileGraph(dimsModel.graphNodes, dimsModel.graphEdges, dimsModel);
      // Bond-Graph Agents: recompile the agent graph too (graph-only edit path).
      // dimsModel carries the LIVE dims (a resize sets gridWidth/Height/Depth
      // refs without touching model state) — the agent WASM/WebGPU layouts bake
      // dims-derived regions, so they must see the same override the grid
      // compilers get (the resize hash-reserve/offset-desync fix).
      const agentResult = compileAgentModel(result.stopMessages.length, dimsModel);
      // Show Code follows the selected target — same dispatch as compileModel().
      // Agents-only model → suppress the expected cell "No nodes / No Step" error.
      const gridOn = dimsModel.topologyMode?.gridCells !== false;
      if (dimsModel.properties.useWebGPU) {
        try {
          const wgpu = compileGraphWebGPU(dimsModel.graphNodes, dimsModel.graphEdges, dimsModel);
          setCompiledCode(wgpu.shaderCode || '(no shader emitted)');
          setCompileError(gridOn ? (wgpu.error || result.error || '') : '');
        } catch (e) {
          setCompiledCode('');
          setCompileError(gridOn ? String((e as Error)?.message || e) : '');
        }
      } else if (dimsModel.properties.useWasm) {
        setCompiledCode(
          '/* WebAssembly target selected.\n' +
          ' * The compiled module is a binary WASM blob — not human-readable.\n' +
          ' * Switch to "Debug / Reference (JS)" in Model Properties to inspect generated code.\n' +
          ' */'
        );
        setCompileError(gridOn ? (result.error ?? '') : '');
      } else {
        setCompiledCode(buildFullCode(result));
        setCompileError(gridOn ? (result.error ?? '') : '');
      }
      // Surface the AGENT graph's compile error too (mirrors the init path).
      if (agentResult.error) {
        setCompileError(prev => (prev ? `${prev}\n[agents] ${agentResult.error}` : `[agents] ${agentResult.error}`));
      }
      // Build viewerIds unconditionally — see init path above for rationale.
      const viewerIds = buildViewerIds(dimsModel);
      const wasmResult = (() => {
        if (!dimsModel.properties.useWasm) {
          return { bytes: new Uint8Array(), minMemoryPages: 1, error: '', viewerIds, exports: [] };
        }
        try {
          const layout = computeLayoutFromModel(dimsModel);
          return compileGraphWasm(dimsModel.graphNodes, dimsModel.graphEdges, dimsModel, layout, viewerIds);
        } catch (e) {
          return { bytes: new Uint8Array(), minMemoryPages: 1, error: String((e as Error)?.message || e), viewerIds, exports: [] };
        }
      })();
      const webgpuResult = (() => {
        if (!dimsModel.properties.useWebGPU) {
          return { shaderCode: '', entryPoints: { step: 'step', outputMappings: [] as Array<{ mappingId: string; entry: string }> }, layout: null as never, error: '' };
        }
        try {
          return compileGraphWebGPU(dimsModel.graphNodes, dimsModel.graphEdges, dimsModel);
        } catch (e) {
          return { shaderCode: '', entryPoints: { step: 'step', outputMappings: [] as Array<{ mappingId: string; entry: string }> }, layout: null as never, error: String((e as Error)?.message || e) };
        }
      })();
      // Under WebGPU direct render, a soft recompile rebuilds the GPU device
      // and reconfigures the salvaged OffscreenCanvas — but in practice the
      // canvas can land in a broken state where no subsequent present produces
      // visible output (manual Recompile fixes it because it allocates a fresh
      // canvas via Phase 1/2). Set a flag so the useWebGPUStatus handler does
      // the same fresh-canvas swap automatically when the rebuild lands —
      // no worker teardown, model attribute sliders + grid state survive.
      if (dimsModel.properties.useWebGPU && !webgpuResult.error && directRenderActiveRef.current) {
        recompilePendingCanvasRefresh.current = true;
      }
      workerRef.current?.postMessage({
        type: 'recompile',
        stepCode: result.stepCode,
        initCode: result.initCode,
        gridInitCode: result.gridInitCode,
        skipIsolatedEmpty: dimsModel.properties.skipIsolatedEmpty,
        inputColorCodes: result.inputColorCodes,
        outputMappingCodes: result.outputMappingCodes || [],
        variegated: model.variegatedCells?.enabled ? {
          sourceAttributeId: model.variegatedCells.sourceAttributeId,
          facePalettes: model.variegatedCells.facePalettes,
          facePatterns: model.variegatedCells.facePatterns,
          facePatternAssignments: ((): Record<string, string> => {
            const src = model.attributes.find(a => a.id === model.variegatedCells!.sourceAttributeId);
            return src?.facePatternAssignments || {};
          })(),
        } : undefined,
        interactionTables: model.attributes
          .filter(a => a.isModelAttribute && a.type === 'lookupTable')
          .map(a => buildLookupTablePayload(a, model)),
        stopMessages: [...result.stopMessages, ...agentResult.stopMessages],
        updateMode: model.properties.updateMode,
        asyncScheme: model.properties.asyncScheme,
        wasmStepBytes: wasmResult.error ? undefined : wasmResult.bytes,
        wasmStepError: wasmResult.error,
        wasmExports: wasmResult.exports,
        viewerIds: wasmResult.viewerIds,
        webgpuShaderCode: webgpuResult.error ? undefined : webgpuResult.shaderCode,
        webgpuShaderError: webgpuResult.error,
        webgpuEntryPoints: webgpuResult.error ? undefined : webgpuResult.entryPoints,
        webgpuLayout: webgpuResult.error ? undefined : webgpuResult.layout,
        webgpuStopCheckInterval: Math.max(1, Math.floor(model.properties.webgpuStopCheckInterval ?? 1)),
        // Bond-Graph Agents: ship the recompiled agent behaviour + the live
        // center-based config so the worker re-clamps Δt and re-binds behaviourFn.
        agentBehaviourCode: agentResult.behaviourCode,
        agentInitCode: agentResult.initCode,
        agentDivisionCode: agentResult.divisionCode,
        agentColorViewer: activeAgentViewerRef.current || agentResult.colorViewer,
        agentOutputMappingCodes: agentResult.outputMappingCodes,
        agentHasSprites: (model.sprites?.length ?? 0) > 0,
      // P4 - the structural-request QUEUE stride the compiled agent code bakes.
      // Shipped on every target so the store's array shapes and the emitters'
      // baked stride are ONE number (bondReqSlotsForModel is the single source).
      agentBondReqSlots: bondReqSlotsForModel(model),
      agentDividePartitions: agentResult.dividePartitions,
        centerBased: model.centerBased,
        // PR5 (C-D1): re-detect on a graph-only edit (field nodes added/removed).
        agentUsesField: agentUsesField(),
        agentUsesDensity: agentUsesDensity(),
      rulesReadComputedIndicator: rulesReadComputedIndicator(),
        agentResidencyClean: agentResult.agentResidencyClean,
        // PR6b-1: re-resolve the agent target + ship the WASM bytes on recompile.
        agentTarget: agentResult.agentTarget,
        agentWasmBytes: agentResult.agentWasmBytes,
        agentWasmViewerGuardIds: agentResult.agentWasmViewerGuardIds,
        // The layout extras MUST ride every recompile: the worker re-derives its
        // pending extras from each message, and a live target flip to 'wasm'
        // (backingChanged → initAgents) would otherwise rebuild the store WITHOUT
        // the extras the module was compiled against — the baked-offset
        // layout-mismatch corruption class.
        agentLayoutExtras: agentResult.agentLayoutExtras,
        agentWasmLayoutSig: agentResult.agentWasmLayoutSig,
        // PR7 G3-runtime: re-ship the WebGPU agent shaders + FULL layout + usage
        // flags on recompile (same lockstep argument as agentLayoutExtras).
        agentWebgpuBehaviourShader: agentResult.agentWebgpuBehaviourShader,
        agentWebgpuForceShader: agentResult.agentWebgpuForceShader,
        agentWebgpuMaxAgents: agentResult.agentWebgpuMaxAgents,
        agentWebgpuMaxHashBins: agentResult.agentWebgpuMaxHashBins,
        agentWebgpuLayout: agentResult.agentWebgpuLayout,
        // A2 render-only layout MUST ride every recompile too (found while
        // verifying M1): the worker does `pendingAgentRenderLayout = rc
        // .agentRenderLayout ?? null`, so omitting it NULLED the layout on every
        // soft recompile — after which buildAgentWebGPUIfNeeded stops posting
        // agentRuntimeReady for a CPU target and the attach handler bails with
        // active:false, i.e. a JS/WASM-target agent model lost direct render
        // permanently on the first graph edit.
        agentRenderLayout: agentResult.agentRenderLayout,
        agentWebgpuUsesI32Write: agentResult.agentWebgpuUsesI32Write,
        agentWebgpuUsage: agentResult.agentWebgpuUsage,
        agentWebgpuOmShaders: agentResult.agentWebgpuOmShaders,
      });
      // M1 (audit): re-evaluate the direct-render gate's MODEL-dependent terms.
      // `sprites` / `agentMappings` are deliberately NOT in needsFullInit (a full
      // reinit would reset the grid + re-seed the agent population), so the gate —
      // computed once in initWorkerWithDimensions — went stale on a soft recompile.
      // Detach / re-attach exactly like the metaballs suppression effect: no worker
      // teardown, the live population survives.
      {
        const ok = agentRenderModelTermsOk(model.sprites, model.agentMappings, agentResult.agentTarget, agentResult.agentWebgpuOmSupported);
        if (ok !== agentRenderModelTermsOkRef.current) {
          agentRenderModelTermsOkRef.current = ok;
          if (!ok) {
            // Fall back to the CPU overlay: stop blitting the worker's canvas (the
            // worker keeps presenting into an orphan canvas, same as metaballs).
            if (agentDirectRenderActiveRef.current) { agentDirectRenderActiveRef.current = false; agentRenderCanvasRef.current = null; }
          }
          // Do NOT attach here when the terms go back to OK: this recompile also
          // rebuilds the agent runtime, and the `agentRuntimeReady` that follows
          // drops any in-flight attach and re-attaches itself (now gated on the
          // ref we just refreshed). Posting one here too produced TWO attaches
          // whose SECOND ack found no pending canvas and took the "attach failed"
          // branch — turning direct render back off.
          draw();
        }
      }
      // If user has the model toggle on, ensure useWasm is set (recompile doesn't carry useWasm by default).
      // PR5: the grid target now flows through for agent models too (the
      // force-JS hack is gone), so these reflect dimsModel's real flags.
      workerRef.current?.postMessage({
        type: 'setUseWasm',
        enabled: !!dimsModel.properties.useWasm && !wasmResult.error,
      });
      workerRef.current?.postMessage({
        type: 'setUseWebGPU',
        enabled: !!dimsModel.properties.useWebGPU && !webgpuResult.error,
      });
      // Sync indicator definitions when they change (not included in recompile message)
      if (prev && prev.indicators !== model.indicators) {
        workerRef.current?.postMessage({
          type: 'updateIndicators',
          indicators: (model.indicators || []).map(i => ({
            id: i.id, kind: i.kind, dataType: i.dataType,
            defaultValue: i.defaultValue, accumulationMode: i.accumulationMode,
            tagOptions: i.tagOptions,
            linkedAttributeId: i.linkedAttributeId,
            linkedAggregation: i.linkedAggregation,
            binCount: i.binCount,
            xAxis: i.xAxis, spatialBinMode: i.spatialBinMode,
            spatialBinCount: i.spatialBinCount, spatialBinSize: i.spatialBinSize,
            trackedValues: i.trackedValues,
            graphMetric: i.graphMetric,
            watched: i.watched,
          })),
          attributes: expandVectorAttributes(model.attributes).map(a => ({
            id: a.id, type: a.type,
            isModelAttribute: a.isModelAttribute, defaultValue: a.defaultValue,
            tagOptions: a.tagOptions,
          })),
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, compileModel]);

  // Resize handler
  useEffect(() => {
    window.addEventListener('resize', draw);
    return () => window.removeEventListener('resize', draw);
  }, [draw]);

  // 3D Grid CA: create / dispose the WebGL2 voxel renderer when entering / leaving
  // a 3D model. The renderer binds to the sibling GL canvas; draw() routes to it
  // via is3dRef. A fresh render is kicked once it's ready.
  useEffect(() => {
    if (!is3D) {
      if (gl3dRef.current) { gl3dRef.current.dispose(); gl3dRef.current = null; }
      return;
    }
    const glc = glCanvasRef.current;
    if (!glc) return;
    try {
      gl3dRef.current = new Gl3DRenderer(glc);
      gl3dRef.current.setGrid(gridWidth.current, gridHeight.current, gridDepth.current);
      lastUploadedColors3dRef.current = null;  // fresh renderer → force the next upload
      lastUploadedAgentSnapRef.current = null; // fresh renderer → re-upload agents too
      spriteAtlasDirtyRef.current = true;      // fresh renderer → rebuild the sprite atlas
      draw();
    } catch (e) {
      console.error('[gl3d] init failed', e);
      gl3dRef.current = null;
    }
    return () => { if (gl3dRef.current) { gl3dRef.current.dispose(); gl3dRef.current = null; } };
  }, [is3D, draw]);

  // Bond-Graph Agents (PR5, 3D) — map a renderer pick INSTANCE index back to the
  // engine SLOT id. uploadAgents compacts ALIVE agents ascending (skip !alive),
  // and the sphere pick encodes gl_InstanceID+1, so the inst-th compacted agent
  // is the inst-th alive slot in ascending order. Returns -1 if out of range.
  const instanceToSlot = useCallback((snap: AgentRenderSnapshot, inst: number): number => {
    if (inst < 0) return -1;
    let n = 0;
    for (let i = 0; i < snap.highWater; i++) {
      if (!snap.alive[i]) continue;
      if (n === inst) return i;
      n++;
    }
    return -1;
  }, []);

  // Bond-Graph Agents (PR5, 3D) — seed points around a plane cell, with a per-
  // point z. Flat mode lays a Vogel disc IN the brush plane (the picked cell's
  // fixed-axis coordinate is the constant 3rd axis); volumetric mode lays a 3D
  // ball. Returns continuous {x,y,z} world positions, torus-wrapped / bounds-
  // clipped per the model boundary. Mirrors agentSeedPoints' 2D disc.
  const agentSeedPoints3d = useCallback((center: { x: number; y: number; z: number }, radius: number, density: number, ball: boolean): Array<{ x: number; y: number; z: number }> => {
    const W = gridWidth.current, H = gridHeight.current, Dd = gridDepth.current;
    if (W <= 0 || H <= 0) return [];
    const torus = boundaryTreatmentRef.current === 'torus';
    const r = Math.max(0, radius);
    const axis = plane3dRef.current.axis;
    const pts: Array<{ x: number; y: number; z: number }> = [];
    const wrapClip = (p: { x: number; y: number; z: number }): { x: number; y: number; z: number } | null => {
      let { x, y, z } = p;
      if (torus) {
        x = ((x % W) + W) % W; y = ((y % H) + H) % H; if (Dd > 0) z = ((z % Dd) + Dd) % Dd;
      } else if (x < 0 || x >= W || y < 0 || y >= H || z < 0 || z >= Dd) return null;
      return { x, y, z };
    };
    if (ball) {
      // 3D ball: N ≈ density·(4/3)πr³ via a Fibonacci-sphere shell scan at jittered
      // radii (cheap, even-ish), clipped to the sphere.
      const n = Math.max(1, Math.round(density * (4 / 3) * Math.PI * r * r * r));
      const golden = Math.PI * (3 - Math.sqrt(5));
      for (let i = 0; i < n; i++) {
        const rr = n === 1 ? 0 : r * Math.cbrt((i + 0.5) / n);
        const yk = 1 - (2 * (i + 0.5)) / n;          // [-1,1]
        const rad = Math.sqrt(Math.max(0, 1 - yk * yk));
        const a = i * golden;
        const wp = wrapClip({ x: center.x + rr * rad * Math.cos(a), y: center.y + rr * yk, z: center.z + rr * rad * Math.sin(a) });
        if (wp) pts.push(wp);
      }
      return pts;
    }
    // Flat disc IN the plane: the Vogel disc lives in the two FREE axes; the plane's
    // FIXED axis is held at the picked cell's coordinate.
    const n = Math.max(1, Math.round(density * Math.PI * r * r));
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) {
      const rr = n === 1 ? 0 : r * Math.sqrt((i + 0.5) / n);
      const a = i * golden;
      const u = rr * Math.cos(a), v = rr * Math.sin(a);
      // z-plane → free (y,x); y-plane → free (z,x); x-plane → free (z,y).
      const cand = axis === 'z' ? { x: center.x + v, y: center.y + u, z: center.z }
        : axis === 'y' ? { x: center.x + v, y: center.y, z: center.z + u }
        : { x: center.x, y: center.y + v, z: center.z + u };
      const wp = wrapClip(cand);
      if (wp) pts.push(wp);
    }
    return pts;
  }, []);

  // 3D Grid CA: GL-canvas pointer handlers, Blender-flavoured.
  //   • MMB-drag OR Alt+LMB-drag           → orbit (Z-up)
  //   • Shift+MMB OR Shift+Alt+LMB drag    → pan (screen-space, tracks the view)
  //   • wheel                              → dolly zoom
  //   • Ctrl+LMB click                     → inspect the picked cell
  //   • plain LMB drag/click               → brush onto the interaction plane
  //   (LMB free for brushing is why orbit is on MMB / Alt+LMB, like Blender.)
  useEffect(() => {
    if (!is3D) return;
    const glc = glCanvasRef.current;
    if (!glc) return;
    let active: 'orbit' | 'pan' | 'brush' | 'inspect' | 'inspectAgent' | 'resize' | 'agentSeed' | 'agentKill' | 'agentMove' | 'agentGroupMove' | 'agentEdit' | 'agentBond' | null = null;
    let lastX = 0, lastY = 0, downX = 0, downY = 0, moved = false;
    // AGENT sweep (active === 'inspectAgent'): the agent picked at press + whether
    // the drag ever re-targeted a DIFFERENT agent — the discard rule is
    // agent-change-based (like the 2D agent sweep), so wiggling within one
    // agent's silhouette still pins on release.
    let agentSweepStartId = -1, agentSweepMoved = false;
    // PR5 3D agent move: the agent picked at drag-start (-1 = none).
    let agentDragId = -1;
    // Ctrl+LMB-drag brush resize (mirrors the 2D canvas): captured at drag start.
    const resizeStart = { x: 0, y: 0, agent: false, w: 0, h: 0, radius: 0, ringW: 0, lineW: 0 };
    const maxDim = () => Math.max(gridWidth.current, gridHeight.current, gridDepth.current, 1);
    type Cell = { layer: number; row: number; col: number };
    const pickCell = (clientX: number, clientY: number): Cell | null => {
      const r = gl3dRef.current; const pl = plane3dRef.current;
      if (!r || !plane3dEnabledRef.current) return null;
      const rect = glc.getBoundingClientRect();
      return r.pickOnPlane(clientX - rect.left, clientY - rect.top, rect.width, rect.height, pl.axis, pl.pos);
    };
    const brushAt = (clientX: number, clientY: number) => {
      const hit = pickCell(clientX, clientY);
      if (hit) paint3dRef.current?.(hit.layer, hit.row, hit.col);
    };
    // Capsule-line footprint on the plane (anchor→end), reusing the 2D
    // lineStampCells in the plane's free-axis coords, then mapped to 3D cells.
    const lineFootprint = (anchor: Cell, end: Cell, width: number): Cell[] => {
      const axis = plane3dRef.current.axis, pos = plane3dRef.current.pos;
      const aF: [number, number] = axis === 'z' ? [anchor.row, anchor.col] : axis === 'y' ? [anchor.layer, anchor.col] : [anchor.layer, anchor.row];
      const eF: [number, number] = axis === 'z' ? [end.row, end.col] : axis === 'y' ? [end.layer, end.col] : [end.layer, end.row];
      const cells = lineStampCells({ row: aF[0], col: aF[1] }, { row: eF[0], col: eF[1] }, width);
      const center: Cell = axis === 'z' ? { layer: pos, row: 0, col: 0 } : axis === 'y' ? { layer: 0, row: pos, col: 0 } : { layer: 0, row: 0, col: pos };
      // "Extrapolate plane": extrude the capsule along the FIXED axis (into depth)
      // by ±⌊width/2⌋ so the line becomes a 3D tube instead of a flat ribbon.
      if (brush3dVolumeRef.current) {
        const half = Math.floor(width / 2);
        const off: Array<[number, number, number]> = [];
        for (const c of cells) for (let dl = -half; dl <= half; dl++) off.push([c.row, c.col, dl]);
        return mapStampToPlane(center, off);
      }
      return mapStampToPlane(center, cells.map(c => [c.row, c.col] as [number, number]));
    };
    const paintLine3d = (anchor: Cell, end: Cell) => {
      const { r, g, b } = hexToRgb(brushColorRef.current);
      pendingPaintMapping.current = brushMappingRef.current;
      pendingPaintViewer.current = activeViewerRef.current;
      for (const c of lineFootprint(anchor, end, brushLineWidthRef.current)) {
        pendingPaintCells.current.push({ row: c.row, col: c.col, layer: c.layer, r, g, b });
      }
      flushPaintBatch();
    };
    const sameCell = (a: Cell | null, b: Cell | null): boolean =>
      a === b || (!!a && !!b && a.layer === b.layer && a.row === b.row && a.col === b.col);
    // Track the hovered brush-plane cell — the CENTRE of the brush OUTLINE cursor
    // (built analytically in draw(), for both the grid brush and the agent brush).
    // The per-cell footprint set is deliberately NOT built: a large volumetric
    // brush would build (and re-upload) millions of cell cubes per frame and OOM;
    // the outline is bounded geometry regardless of brush size. Returns true when
    // the cell changed (caller redraws only then — a full GL re-render per raw
    // pointermove is wasteful on large volumes). A staged Line always recomputes
    // so its preview grows with the cursor.
    const updateHover = (clientX: number, clientY: number): boolean => {
      const hit = pickCell(clientX, clientY);
      const lineStaging = (brushShapeRef.current === 'line' && !!line3dAnchorRef.current)
        || (agentBrushShapeRef.current === 'line' && !!agentLine3dAnchorRef.current);
      const changed = lineStaging || !sameCell(hit, hover3dRef.current);
      hover3dRef.current = hit;
      hoverCells3dRef.current = EMPTY_HOVER_CELLS;
      return changed;
    };
    // ---- Bond-Graph Agents (PR5): the 3D agent brush + inspect. ----
    // Resolve the agent slot under the cursor via the renderer's sphere pick FBO
    // (instance index → slot). null if no agent hit. Refreshes the camera +
    // snapshot before the pick (RR-G9 — the pick reads the live GPU state).
    const pickAgent3d = (clientX: number, clientY: number): number => {
      const r = gl3dRef.current, snap = agentsRef.current;
      if (!r || !snap || snap.highWater === 0) return -1;
      draw();  // ensure the renderer's instance buffer + camera are current
      const rect = glc.getBoundingClientRect();
      const inst = r.pickAgent(clientX - rect.left, clientY - rect.top, rect.width, rect.height);
      return instanceToSlot(snap, inst);
    };
    // Scope-aware Add on the plane: Single = one agent at the plane cell; Area =
    // the shape footprint (agentSeedInShape3dAt: ball / box / shell / disc).
    const addAgents3d = (clientX: number, clientY: number, scope: 'single' | 'area') => {
      const hit = pickCell(clientX, clientY);
      if (!hit) return;
      const pts = scope === 'single' ? [{ x: hit.col, y: hit.row, z: hit.layer }] : agentSeedInShape3dAt(hit);
      if (pts.length) seedAgentsAt(pts, agentSeedSetsRef.current());
    };
    // Scope-aware Remove: Single = nearest picked agent; Area = the volumetric shape.
    const removeAgents3d = (clientX: number, clientY: number, scope: 'single' | 'area') => {
      const worker = workerRef.current; if (!worker) return;
      if (scope === 'single') { const id = pickAgent3d(clientX, clientY); if (id >= 0) worker.postMessage({ type: 'killAgents', ids: [id], activeViewer: activeViewerRef.current }); return; }
      const hit = pickCell(clientX, clientY); if (!hit) return;
      const ids = agentsInShape3dAt(hit); if (ids.length) worker.postMessage({ type: 'killAgents', ids, activeViewer: activeViewerRef.current });
    };
    // Area Edit: stamp the checked Edit-panel rows onto all agents in the footprint.
    const editAgents3d = (clientX: number, clientY: number) => {
      const hit = pickCell(clientX, clientY); if (!hit) return;
      applyAgentEditToIds(agentsInShape3dAt(hit));
    };
    // Update the hovered-agent highlight ring (kill/glue/cut/move modes). Returns
    // true when the highlighted set changed (so the caller redraws on-change only,
    // never per raw move — the pick is an FBO round-trip + GPU sync, RR-G8).
    const updateAgentHover = (clientX: number, clientY: number): boolean => {
      const snap = agentsRef.current;
      const mode = agentBrushModeRef.current;
      const aShape = agentBrushShapeRef.current;
      const aScope = (mode === 'move' && aShape === 'line') ? 'single' : agentBrushScopeRef.current;
      const want = brushTargetRef.current === 'agents' && (mode === 'remove' || mode === 'glue' || mode === 'cut' || mode === 'move' || mode === 'edit' || mode === 'bond');
      if (!want || !snap) {
        if (hoverAgents3dRef.current.length === 0) return false;
        hoverAgents3dRef.current = EMPTY_AGENT_RINGS; return true;
      }
      const hasZ = snap.z.length > 0;
      // Bond: highlight every agent inside the scan ball on the plane (the pairs
      // that could get bonded), mirroring the 2D bond hover.
      if (mode === 'bond') {
        const hit = pickCell(clientX, clientY);
        const ids = hit ? agentsInRadius3dAt(hit, agentBrushRadiusRef.current) : [];
        const rings = ids.map(id => ({ x: snap.x[id]!, y: snap.y[id]!, z: hasZ ? snap.z[id]! : 0, radius: snap.radius[id]! }));
        const prev = hoverAgents3dRef.current;
        if (prev.length === rings.length && prev.every((p, i) => p.x === rings[i]!.x && p.y === rings[i]!.y && p.z === rings[i]!.z)) return false;
        hoverAgents3dRef.current = rings.length ? rings : EMPTY_AGENT_RINGS;
        return true;
      }
      // Area (Remove/Move/Edit): highlight ALL agents under the footprint (the ones
      // the stroke will touch), not just the single hovered one.
      if (aScope === 'area' && (mode === 'remove' || mode === 'move' || mode === 'edit')) {
        const hit = pickCell(clientX, clientY);
        const ids = hit ? agentsInShape3dAt(hit) : [];
        const rings = ids.map(id => ({ x: snap.x[id]!, y: snap.y[id]!, z: hasZ ? snap.z[id]! : 0, radius: snap.radius[id]! }));
        const prev = hoverAgents3dRef.current;
        if (prev.length === rings.length && prev.every((p, i) => p.x === rings[i]!.x && p.y === rings[i]!.y && p.z === rings[i]!.z)) return false;
        hoverAgents3dRef.current = rings.length ? rings : EMPTY_AGENT_RINGS;
        return true;
      }
      const id = pickAgent3d(clientX, clientY);
      const prev = hoverAgents3dRef.current;
      if (id < 0) { if (prev.length === 0) return false; hoverAgents3dRef.current = EMPTY_AGENT_RINGS; return true; }
      const ring = { x: snap.x[id]!, y: snap.y[id]!, z: hasZ ? snap.z[id]! : 0, radius: snap.radius[id]! };
      if (prev.length === 1 && prev[0]!.x === ring.x && prev[0]!.y === ring.y && prev[0]!.z === ring.z) return false;
      hoverAgents3dRef.current = [ring];
      return true;
    };
    // 3D sweep inspect: while Shift+LMB is held and dragged, a SINGLE transient
    // popover (sweepInspector) shows the front-most voxel under the cursor — its
    // data refreshes as you sweep, and the cell is highlighted in the volume —
    // without pinning a popover per cell (mirrors the 2D sweep inspector). The
    // popover stays anchored at the press point (no 2D connector line in 3D); the
    // highlight tracks the cursor. Picks the rendered voxel via the colour-id
    // `pick()` (what the user sees), not the interaction plane.
    const sweepPick3d = (clientX: number, clientY: number, isDown: boolean): void => {
      const r = gl3dRef.current;
      if (!r) return;
      const rect = glc.getBoundingClientRect();
      const idx = r.pick(clientX - rect.left, clientY - rect.top, rect.width, rect.height);
      if (idx < 0) return;  // cursor not over a voxel — keep showing the last cell
      const W = gridWidth.current, WH = W * gridHeight.current;
      const layer = Math.floor(idx / WH), rem = idx - layer * WH, row = Math.floor(rem / W), col = rem - row * W;
      const prev = sweepInspectorRef.current;
      if (!prev || prev.cellIdx !== idx) {
        // Anchor x/y at the press point (isDown) and keep it as the cursor sweeps.
        const x = isDown || !prev ? clientX : prev.x;
        const y = isDown || !prev ? clientY : prev.y;
        const next: InspectPopoverState = { cellIdx: idx, row, col, x, y };
        sweepInspectorRef.current = next;
        setSweepInspector(next);
      }
      inspectHighlight3dRef.current = [{ layer, row, col }];
    };
    // Snap the camera so the clicked axis tip points INTO the screen (look ALONG
    // it). The gizmo labels C/R/D sit on +col(+X) / +row(-Y) / +depth(-Z), so
    // clicking D (the -Z tip) gives the TOP / 2D-matching view (look straight
    // down -Z). dir = target→eye = -tipV, where the clicked stub is tipV =
    // sign·unit(axis). For depth, pitch = ±π/2 EXACTLY — the renderer's pole-up
    // override then rolls the camera so row stays pointing down (top) / up
    // (bottom). yaw is kept for the depth POVs (dir is ±Z regardless of yaw).
    const setPov = (axis: 'x' | 'y' | 'z', sign: 1 | -1) => {
      const cam = cam3dRef.current;
      if (axis === 'x') { cam.yaw = sign > 0 ? Math.PI : 0; cam.pitch = 0; }
      else if (axis === 'y') { cam.yaw = sign > 0 ? -Math.PI / 2 : Math.PI / 2; cam.pitch = 0; }
      else { cam.pitch = sign > 0 ? -Math.PI / 2 : Math.PI / 2; }  // +Z tip→bottom, -Z(D)→top
      draw();
    };
    const onDown = (e: PointerEvent) => {
      if ((e.target as HTMLElement)?.closest?.('[data-sim-overlay]')) return;
      // L1: pin the grid's frame mode for this gesture ONLY when the gesture can
      // PICK — gl3d's colour-id pick() (3D cell inspect) resolves against the CPU
      // instance buffer that only frame mode refreshes, and the pick fires on the
      // RELEASE, so the pin must start at the press to give the flip its frame.
      // A CAMERA gesture (orbit / pan / Ctrl-resize / brush) needs NO CPU state:
      // the brush is pure pickOnPlane ray math and a paint re-presents through the
      // worker's own mutation tail, while the camera is re-presented GPU-side from
      // setGridCamera. Pinning those was the bug — manual orbiting dropped to the
      // readback path (stutter) and froze the display on a stale frame that no
      // longer tracked the camera until colours arrived, while AUTO-orbit/zoom,
      // which never set this flag, stayed smooth. Determinable from the event
      // alone, so it is still set before every early return below; cleared in onUp
      // (a window listener, so it always fires). Passive hover does not pin either
      // — see updateGridUiSync.
      glGestureActiveRef.current =
        e.button === 0 && !e.ctrlKey && !e.metaKey && !e.altKey
        && (e.shiftKey || inspectModeRef.current);
      glShiftDownRef.current = e.shiftKey;
      if (voxelRenderActiveRef.current) updateGridUiSync();
      // Move keyboard focus off any text field so the transport shortcuts
      // (Enter/Space/Esc) work after clicking the canvas — the canvas isn't
      // focusable and the e.preventDefault() below would otherwise leave focus on
      // the last-edited input, where the shortcut handler bails.
      const ae = document.activeElement as HTMLElement | null;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT')) ae.blur();
      // Clicking the corner gizmo snaps to that POV (highest priority — no drag).
      // Plain LMB only: a modifier means the user wants resize (Ctrl/Cmd), inspect
      // (Shift), or orbit (Alt), which must work even when the press lands on the
      // tiny gizmo region — so don't let the gizmo swallow a modified gesture.
      if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && gl3dRef.current) {
        const rect = glc.getBoundingClientRect();
        const g = gl3dRef.current.gizmoHitTest(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height);
        if (g) { setPov(g.axis, g.sign); active = null; e.preventDefault(); return; }
      }
      moved = false;
      lastX = downX = e.clientX; lastY = downY = e.clientY;
      const orbitBtn = e.button === 1 || (e.button === 0 && e.altKey);
      if (orbitBtn) {
        active = e.shiftKey ? 'pan' : 'orbit';
        // ORBIT does NOT cancel follow: it only changes yaw/pitch AROUND the
        // follow target, which is orthogonal to what the follow controller
        // writes (the target itself) — so the user can look at a followed agent
        // from any angle while tracking continues. Only a TRANSLATION (pan)
        // takes the wheel, same as the 2D RMB pan. See FOLLOW MODE.
        if (active === 'pan') cancelFollowRef.current();
      }
      else if (e.button === 2) {
        // RMB cancels a staged Line anchor / Glue-Cut anchor (grid or agent);
        // otherwise it pans.
        if (line3dAnchorRef.current || agentLine3dAnchorRef.current) { line3dAnchorRef.current = null; agentLine3dAnchorRef.current = null; active = null; updateHover(e.clientX, e.clientY); draw(); }
        else if (agentGlueAnchorRef.current >= 0) { agentGlueAnchorRef.current = -1; active = null; draw(); }
        else { active = 'pan'; cancelFollowRef.current(); }
      }
      else if (e.button === 0 && (e.ctrlKey || e.metaKey)) {
        // Ctrl/Cmd+LMB drag → resize the active brush shape (like the 2D canvas).
        // Targets the AGENT shape when the brush affects agents, else the CA grid.
        const rzAgent = isAgentModelRef.current && brushTargetRef.current === 'agents';
        active = 'resize';
        resizeStart.agent = rzAgent;
        resizeStart.x = e.clientX; resizeStart.y = e.clientY;
        resizeStart.w = rzAgent ? agentBrushWRef.current : brushWRef.current;
        resizeStart.h = rzAgent ? agentBrushHRef.current : brushHRef.current;
        resizeStart.radius = rzAgent ? agentBrushRadiusRef.current : brushRadiusRef.current;
        resizeStart.ringW = rzAgent ? agentBrushRingWidthRef.current : brushRingWidthRef.current;
        resizeStart.lineW = rzAgent ? agentBrushLineWidthRef.current : brushLineWidthRef.current;
      }
      else if (e.button === 0 && (e.shiftKey || inspectModeRef.current)) {
        // Shift+LMB (or the toolbar Inspect toggle) → inspect. In an agent model,
        // pick the AGENT first; if none is hit, fall through to the cell-plane
        // sweep inspect (the grid below).
        if (isAgentModelRef.current) {
          const id = pickAgent3d(e.clientX, e.clientY);
          if (id >= 0) {
            // AGENT sweep: the popover opens immediately (it doubles as the
            // transient) and the drag re-targets it to whichever agent is under
            // the cursor. Release without a drag keeps it pinned; release after
            // a drag discards (mirrors the cell sweep's !moved rule).
            active = 'inspectAgent';
            agentSweepStartId = id; agentSweepMoved = false;
            openAgentInspector(id, e.clientX, e.clientY);
            draw();   // the ring is derived from the open popovers inside draw()
            glc.setPointerCapture?.(e.pointerId); e.preventDefault(); return;
          }
        }
        active = 'inspect'; sweepPick3d(e.clientX, e.clientY, true); draw();
      } // Shift+LMB → sweep inspect (drag) / pin (click)
      else if (e.button === 0 && isAgentModelRef.current && brushTargetRef.current === 'agents') {
        // Plain LMB, brush targets agents. Add/Remove/Move/Edit honour the Single/
        // Area scope + the shape (volumetric footprint on the plane); Glue/Cut click
        // two agents (pickAgent3d) to bond/unbond, Bond drag-scans the plane ball.
        // (brushTarget==='grid' paints cells.)
        const mode = agentBrushModeRef.current;
        const aShape = agentBrushShapeRef.current;
        const aScope: 'single' | 'area' = (mode === 'move' && aShape === 'line') ? 'single' : agentBrushScopeRef.current;
        const worker = workerRef.current;
        if (aShape === 'line' && aScope === 'area' && (mode === 'add' || mode === 'remove' || mode === 'edit')) {
          // Two-click 3D capsule region on the plane.
          const hit = pickCell(e.clientX, e.clientY);
          if (hit) {
            if (!agentLine3dAnchorRef.current) { agentLine3dAnchorRef.current = hit; updateHover(e.clientX, e.clientY); draw(); }
            else {
              const a = agentLine3dAnchorRef.current; agentLine3dAnchorRef.current = null;
              if (mode === 'add') seedAgentsAt(agentSeedInLine3d(a, hit), agentSeedSetsRef.current());
              else if (mode === 'remove') { const ids = agentLineMembers3d(a, hit); if (ids.length && worker) worker.postMessage({ type: 'killAgents', ids, activeViewer: activeViewerRef.current }); }
              else applyAgentEditToIds(agentLineMembers3d(a, hit));
              draw();
            }
          }
          active = null;
        } else if (mode === 'remove') { active = 'agentKill'; removeAgents3d(e.clientX, e.clientY, aScope); }
        else if (mode === 'add') { active = 'agentSeed'; addAgents3d(e.clientX, e.clientY, aScope); }
        else if (mode === 'edit') {
          if (aScope === 'single') {
            const id = pickAgent3d(e.clientX, e.clientY);
            if (id >= 0) {
              editTargetIdRef.current = id; setEditTargetId(id); editPrefillIdRef.current = id;
              worker?.postMessage({ type: 'getAgentState', id });
              draw();   // the Edit-target ring is derived inside draw()
            }
            active = null;
          } else { active = 'agentEdit'; editAgents3d(e.clientX, e.clientY); }
        } else if (mode === 'move') {
          if (aScope === 'area') {
            const hit = pickCell(e.clientX, e.clientY);
            const snap = agentsRef.current;
            if (hit && snap) {
              const ids = agentsInShape3dAt(hit); const hasZ = snap.z.length > 0;
              if (ids.length) { agentGroupMoveRef.current = { members: ids.map(id => ({ id, sx: snap.x[id]!, sy: snap.y[id]!, sz: hasZ ? snap.z[id]! : 0 })), downX: hit.col, downY: hit.row, downZ: hit.layer }; active = 'agentGroupMove'; }
              else active = null;
            } else active = null;
          } else {
            const id = pickAgent3d(e.clientX, e.clientY);
            if (id >= 0) { active = 'agentMove'; agentDragId = id; } else active = null;
          }
        } else if (mode === 'glue' || mode === 'cut') {
          // Click two agents to bond / unbond them (plane-independent — picks the
          // rendered sphere, so it works with or without the brush plane). The
          // staged first agent gets a persistent white ring (derived in draw()
          // from agentGlueAnchorRef, so a mode switch clears it for free).
          active = null;
          const id = pickAgent3d(e.clientX, e.clientY);
          if (id < 0) agentGlueAnchorRef.current = -1;
          else if (agentGlueAnchorRef.current < 0) agentGlueAnchorRef.current = id;
          else {
            if (agentGlueAnchorRef.current !== id && worker) worker.postMessage({ type: mode === 'glue' ? 'formBond' : 'breakBond', a: agentGlueAnchorRef.current, b: id, activeViewer: activeViewerRef.current });
            agentGlueAnchorRef.current = -1;
          }
          draw();
        } else if (mode === 'bond') {
          // Bond-paint: scan the plane ball for near pairs on the drag, flush on up.
          pendingBondPairs.current.clear();
          const hit = pickCell(e.clientX, e.clientY);
          if (hit) { scanBondPairs3d(hit); active = 'agentBond'; } else active = null;
        } else { active = 'agentSeed'; addAgents3d(e.clientX, e.clientY, aScope); } // (unreached — all modes handled)
      }
      else if (e.button === 0 && brushShapeRef.current === 'line') {
        // Line tool: two clicks. First stages a plane-cell anchor (no paint); the
        // second draws the capsule line between them. No drag-paint in this mode.
        active = null;
        const hit = pickCell(e.clientX, e.clientY);
        if (hit) {
          if (!line3dAnchorRef.current) line3dAnchorRef.current = hit;
          else { paintLine3d(line3dAnchorRef.current, hit); line3dAnchorRef.current = null; }
          updateHover(e.clientX, e.clientY); draw();
        }
      }
      else if (e.button === 0) { active = 'brush'; last3dHitRef.current = null; brushAt(e.clientX, e.clientY); }
      else active = null;
      glc.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    };
    // rAF throttle state for the idle hovered-agent pick (see onMove).
    let agentHoverPending: { x: number; y: number } | null = null;
    let agentHoverRaf = 0;
    // Idle footprint-cursor hover — rAF-coalesced like the agent pick above:
    // raw pointermove fires far above frame rate, and each hover update is a
    // plane pick + footprint recompute + (on cell change) a full GL re-render,
    // which measurably competed with the sim while playing.
    let hover3dPending: { x: number; y: number } | null = null;
    let hover3dRaf = 0;
    const onMove = (e: PointerEvent) => {
      // Track drag distance BEFORE the inspect-armed early-return, so onUp can
      // discard a Shift+LMB that turned into a drag (mirrors the 2D sweep
      // inspector's `!moved` discard) instead of pinning a popover at release.
      if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 3) moved = true;
      if (!active || active === 'inspect') {
        // The listener is on `window` (drags must keep tracking off-canvas) —
        // but IDLE moves over side panels / the transport bar must not drive
        // phantom hover cursors or pick passes. Clear any lingering hover once
        // and bail when the pointer is outside the GL canvas rect.
        if (!active) {
          const rect = glc.getBoundingClientRect();
          const inside = e.clientX >= rect.left && e.clientX < rect.right
            && e.clientY >= rect.top && e.clientY < rect.bottom;
          if (!inside) {
            let cleared = false;
            if (hoverCells3dRef.current.length > 0) { hoverCells3dRef.current = []; cleared = true; }
            if (hoverAgents3dRef.current.length > 0) { hoverAgents3dRef.current = EMPTY_AGENT_RINGS; cleared = true; }
            if (cleared) draw();
            return;
          }
        }
        // Inspect-armed drag → sweep the front voxel under the cursor (a
        // deliberate drag — stays synchronous).
        if (active === 'inspect') {
          updateHover(e.clientX, e.clientY);
          sweepPick3d(e.clientX, e.clientY, false);
          draw();
          return;
        }
        // Idle: update the footprint cursor — rAF-coalesced (redraw on change),
        // so raw pointermove can't out-run the frame rate with per-move plane
        // picks + footprint recomputes + GL renders.
        hover3dPending = { x: e.clientX, y: e.clientY };
        if (hover3dRaf === 0) {
          hover3dRaf = requestAnimationFrame(() => {
            hover3dRaf = 0;
            const p = hover3dPending;
            if (p && updateHover(p.x, p.y)) draw();
          });
        }
        // Agent model: also update the hovered-agent ring (kill/glue/cut/move) —
        // rAF-throttled: the sphere pick is a full render + FBO pass + a
        // synchronous readPixels GPU stall, and raw pointermove fires far above
        // frame rate (RR-G8/D4).
        if (!active && isAgentModelRef.current) {
          agentHoverPending = { x: e.clientX, y: e.clientY };
          if (agentHoverRaf === 0) {
            agentHoverRaf = requestAnimationFrame(() => {
              agentHoverRaf = 0;
              const p = agentHoverPending;
              if (p && updateAgentHover(p.x, p.y)) draw();
            });
          }
        }
        return;
      }
      if (active === 'inspectAgent') {
        // Agent sweep: re-target the (already open) inspector to the agent under
        // the cursor, keeping the popover anchored at the press point. Empty
        // space keeps the last inspected agent showing.
        const id = pickAgent3d(e.clientX, e.clientY);
        if (id >= 0) {
          if (id !== agentSweepStartId) agentSweepMoved = true;
          if (id !== agentSweepPopoverRef.current?.id) {
            openAgentInspector(id, downX, downY);
            draw();   // the ring follows the re-targeted popover inside draw()
          }
        }
        return;
      }
      if (active === 'resize') {
        // dx grows the primary size; dy (up) grows the secondary. Mirrors the 2D
        // canvas's Ctrl-drag resize, then the hover footprint follows on redraw.
        const totDx = e.clientX - resizeStart.x, totDy = e.clientY - resizeStart.y;
        const maxW = (gridWidth.current || simWidth) * 2, maxH = (gridHeight.current || simHeight) * 2;
        const rzA = resizeStart.agent;
        const shape = rzA ? agentBrushShapeRef.current : brushShapeRef.current;
        const setRadius = rzA ? setAgentBrushRadius : setBrushRadius;
        const setRingW = rzA ? setAgentBrushRingWidth : setBrushRingWidth;
        const setLineW = rzA ? setAgentBrushLineWidth : setBrushLineWidth;
        const setW = rzA ? setAgentBrushW : setBrushW;
        const setH = rzA ? setAgentBrushH : setBrushH;
        if (shape === 'circle') setRadius(Math.max(0, Math.min(maxW, resizeStart.radius + Math.round(totDx / 5))));
        else if (shape === 'ring') {
          setRadius(Math.max(0, Math.min(maxW, resizeStart.radius + Math.round(totDx / 5))));
          setRingW(Math.max(1, Math.min(maxH, resizeStart.ringW - Math.round(totDy / 5))));
        } else if (shape === 'line') setLineW(Math.max(1, Math.min(maxW, resizeStart.lineW + Math.round(totDx / 5))));
        else {
          setW(Math.max(1, Math.min(maxW, resizeStart.w + Math.round(totDx / 5))));
          setH(Math.max(1, Math.min(maxH, resizeStart.h - Math.round(totDy / 5))));
        }
        updateHover(e.clientX, e.clientY);  // footprint cursor reflects the new size
        draw();
        return;
      }
      // Agent brush drags: seed / kill along the drag, or drag-move the picked
      // agent on the brush plane (plane-constrained — pickCell gives x/y/z).
      if (active === 'agentSeed') { if (agentBrushScopeRef.current === 'area' && agentBrushShapeRef.current !== 'line') addAgents3d(e.clientX, e.clientY, 'area'); updateHover(e.clientX, e.clientY); draw(); return; }
      if (active === 'agentKill') { removeAgents3d(e.clientX, e.clientY, agentBrushScopeRef.current); updateHover(e.clientX, e.clientY); updateAgentHover(e.clientX, e.clientY); draw(); return; }
      if (active === 'agentEdit') { editAgents3d(e.clientX, e.clientY); updateHover(e.clientX, e.clientY); draw(); return; }
      if (active === 'agentBond') { const hit = pickCell(e.clientX, e.clientY); if (hit) scanBondPairs3d(hit); updateHover(e.clientX, e.clientY); updateAgentHover(e.clientX, e.clientY); draw(); return; }
      if (active === 'agentGroupMove') {
        const g = agentGroupMoveRef.current, hit = pickCell(e.clientX, e.clientY);
        if (g && hit) {
          const ddx = hit.col - g.downX, ddy = hit.row - g.downY, ddz = hit.layer - g.downZ;
          workerRef.current?.postMessage({ type: 'moveAgents', moves: g.members.map(mm => ({ id: mm.id, x: mm.sx + ddx, y: mm.sy + ddy, z: mm.sz + ddz })), torus: boundaryTreatmentRef.current === 'torus', activeViewer: activeViewerRef.current });
        }
        draw(); return;
      }
      if (active === 'agentMove') {
        const hit = pickCell(e.clientX, e.clientY);
        if (hit && agentDragId >= 0) {
          workerRef.current?.postMessage({ type: 'moveAgents', moves: [{ id: agentDragId, x: hit.col, y: hit.row, z: hit.layer }], torus: boundaryTreatmentRef.current === 'torus', activeViewer: activeViewerRef.current });
          // Track the dragged agent with the hover ring at the new plane position
          // (the snapshot's real position arrives on the next stepped frame).
          const snap = agentsRef.current;
          hoverAgents3dRef.current = [{ x: hit.col, y: hit.row, z: hit.layer, radius: snap?.radius[agentDragId] ?? 1 }];
        }
        draw(); return;
      }
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      const cam = cam3dRef.current;
      if (active === 'orbit') {
        cam.yaw -= dx * 0.01;
        cam.pitch = Math.max(-1.5, Math.min(1.5, cam.pitch + dy * 0.01));
      } else if (active === 'pan') {
        const scale = cam.dist * maxDim() / (glc.clientHeight || 500);
        panCamera(cam, dx, dy, scale);
      } else if (active === 'brush') {
        brushAt(e.clientX, e.clientY);
        updateHover(e.clientX, e.clientY);  // cursor follows the brush
      }
      draw();
    };
    const onEnter = () => {
      // Phase C: pointer entered the 3D canvas — if the agent brush is armed, flip
      // to frame mode (gl3d full render + snapshot) so picks work.
      if (!glPointerOverRef.current) { glPointerOverRef.current = true; if (agentDirectRenderActiveRef.current) updateAgentUiSync(); if (voxelRenderActiveRef.current) updateGridUiSync(); }
    };
    const onLeave = () => {
      if (glPointerOverRef.current) { glPointerOverRef.current = false; if (agentDirectRenderActiveRef.current) updateAgentUiSync(); if (voxelRenderActiveRef.current) updateGridUiSync(); }
      if (hover3dRef.current || hoverCells3dRef.current.length || hoverAgents3dRef.current.length) {
        hover3dRef.current = null; hoverCells3dRef.current = EMPTY_HOVER_CELLS; hoverAgents3dRef.current = EMPTY_AGENT_RINGS; draw();
      }
    };
    const onUp = (e: PointerEvent) => {
      glc.releasePointerCapture?.(e.pointerId);
      if (active === 'inspect') {
        // End of a sweep: discard the transient popover + its highlight. A no-drag
        // release PINS the cell (single persistent inspect popover); a drag just
        // discards (mirrors the 2D sweep inspector's `!moved` rule).
        if (sweepInspectorRef.current) { sweepInspectorRef.current = null; setSweepInspector(null); }
        inspectHighlight3dRef.current = [];
        if (!moved && gl3dRef.current) {
          const rect = glc.getBoundingClientRect();
          const idx = gl3dRef.current.pick(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height);
          if (idx >= 0) openInspect3dRef.current?.(idx, e.clientX, e.clientY);
        }
        draw();
      }
      if (active === 'inspectAgent') {
        // Agent sweep release: a release that never re-targeted a different
        // agent keeps the popover pinned (it opened on press); a sweep across
        // other agents discards it + the highlight ring.
        if (agentSweepMoved) clearAgentSweep(); else commitAgentSweep();
        agentSweepStartId = -1; agentSweepMoved = false;
        draw();
      }
      // Commit the final coalesced stamp synchronously (the rAF may not have
      // fired yet on a quick click-release), mirroring the 2D mouse-up path.
      if (active === 'brush') flushPaintBatch();
      // Agent move: clear the drag state. The rings need no restore — draw()
      // derives them from the open popovers + the live snapshot every frame.
      if (active === 'agentMove') { agentDragId = -1; draw(); }
      if (active === 'agentGroupMove') { agentGroupMoveRef.current = null; }
      if (active === 'agentBond') { flushBondBatch(); draw(); }
      active = null;
      last3dHitRef.current = null;
      // L1: the gesture is over — release the frame-mode pin (debounced OFF).
      if (glGestureActiveRef.current) {
        glGestureActiveRef.current = false;
        if (voxelRenderActiveRef.current) updateGridUiSync();
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // Alt+wheel cycles the agent brush mode (add → remove → move → …) when the
      // brush targets agents — a fast keyboard-free way to switch actions.
      if (e.altKey && isAgentModelRef.current && brushTargetRef.current === 'agents') {
        e.stopPropagation();
        const modes = AGENT_BRUSH_MODES, i = modes.indexOf(agentBrushModeRef.current);
        setAgentBrushMode(modes[(((i < 0 ? 0 : i) + (e.deltaY > 0 ? 1 : -1)) + modes.length) % modes.length]!);
        agentGlueAnchorRef.current = -1; agentLineAnchorRef.current = null; agentLine3dAnchorRef.current = null;
        draw();
        return;
      }
      // Ctrl/Cmd+wheel is reserved for cycling Input Mappings (handled by the
      // parent container's handleWheel) — return WITHOUT stopPropagation so the
      // event still bubbles there; don't ALSO zoom the camera. Plain wheel = zoom,
      // and we stopPropagation so it doesn't bubble to the (inert in 3D) 2D-zoom
      // handler and trigger a redundant draw().
      if (e.ctrlKey || e.metaKey) return;
      e.stopPropagation();
      const cam = cam3dRef.current;
      // A wheel zoom composes with a running auto-zoom for free — the dolly SCALES the
      // current distance each frame rather than setting it, so it just carries on from
      // wherever the user lands.
      cam.dist = Math.max(MIN_CAM_DIST, Math.min(MAX_CAM_DIST, cam.dist * (e.deltaY > 0 ? 1.1 : 0.9)));
      draw();
    };
    const onCtx = (e: MouseEvent) => e.preventDefault();  // RMB shouldn't pop the page menu
    // L1: track Shift so HOLDING it over the canvas pre-warms frame mode — the
    // Shift+LMB inspect pick fires on the RELEASE, so pressing the modifier first
    // gives the flip (and the worker's immediate one-colours-frame reply) a head
    // start. Only matters while the pointer is over the canvas (see the driver).
    const onShiftKey = (e: KeyboardEvent) => {
      if (e.shiftKey === glShiftDownRef.current) return;
      glShiftDownRef.current = e.shiftKey;
      if (glPointerOverRef.current && voxelRenderActiveRef.current) updateGridUiSync();
    };
    window.addEventListener('keydown', onShiftKey);
    window.addEventListener('keyup', onShiftKey);
    glc.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    glc.addEventListener('wheel', onWheel, { passive: false });
    glc.addEventListener('contextmenu', onCtx);
    glc.addEventListener('pointerleave', onLeave);
    glc.addEventListener('pointerenter', onEnter);
    return () => {
      if (agentHoverRaf !== 0) cancelAnimationFrame(agentHoverRaf);
      if (hover3dRaf !== 0) cancelAnimationFrame(hover3dRaf);
      glc.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      glc.removeEventListener('wheel', onWheel);
      glc.removeEventListener('contextmenu', onCtx);
      glc.removeEventListener('pointerleave', onLeave);
      glc.removeEventListener('pointerenter', onEnter);
      window.removeEventListener('keydown', onShiftKey);
      window.removeEventListener('keyup', onShiftKey);
      // Unmounting mid-gesture (or with Shift held) must not leave the frame-mode
      // pin latched on — it would silently hold the readback path forever.
      glGestureActiveRef.current = false;
      glShiftDownRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [is3D, draw]);

  // 3D Grid CA: DEV hooks for headless verification (synthetic pointer events
  // don't drive canvas drags — mirror window.__simWorker).
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const W = window as unknown as Record<string, unknown>;
    W.__sim3dCamera = cam3dRef.current;
    W.__sim3dClip = clip3dRef.current;
    W.__sim3dRedraw = () => draw();
    W.__sim3dPick = (px: number, py: number) => {
      const glc = glCanvasRef.current;
      if (!gl3dRef.current || !glc) return -2;
      return gl3dRef.current.pick(px, py, glc.clientWidth || 1, glc.clientHeight || 1);
    };
    W.__sim3dRenderer = () => gl3dRef.current;
    W.__buildBrushOutline3dSegs = buildBrushOutline3dSegs;  // DEV: unit-test the outline geometry
    // Drive the plane-brush stamp directly (synthetic pointer drags can't reach
    // pickOnPlane). Pass a plane cell (layer,row,col); set reset=true to start a
    // fresh stroke (clears the interpolation anchor).
    W.__sim3dPaint = (layer: number, row: number, col: number, reset?: boolean) => {
      if (reset) last3dHitRef.current = null;
      paint3dRef.current?.(layer, row, col);
    };
    // Bond-Graph Agents (PR5): the renderer's visible agent instance count, and a
    // headless agent pick (CSS px → engine slot id via instanceToSlot).
    W.__sim3dAgentCount = () => gl3dRef.current?.agentInstanceCount ?? -1;
    W.__sim3dPickAgent = (px: number, py: number) => {
      const glc = glCanvasRef.current, snap = agentsRef.current;
      if (!gl3dRef.current || !glc || !snap) return -2;
      draw();
      const inst = gl3dRef.current.pickAgent(px, py, glc.clientWidth || 1, glc.clientHeight || 1);
      return instanceToSlot(snap, inst);
    };
    // Direct-agent-render gate state (DEV/verification only). The render layer has
    // no automated harness (parity-agent-* cover the compilers/engine), so the gate
    // matrix + attach lifecycle can only be checked in-browser — this exposes the
    // decision so a probe doesn't have to infer it from pixels in an occluded pane.
    W.__agentRenderState = () => ({
      eligible: agentRenderEligibleRef.current,
      modelTermsOk: agentRenderModelTermsOkRef.current,
      directActive: agentDirectRenderActiveRef.current,
      compositeActive: agentCompositeActiveRef.current,
      metaballs: agentMetaballsRef.current.enabled,
    });
    // FOLLOW MODE state (DEV/verification only, same rationale as
    // __agentRenderState): the camera the tracker writes lives in refs, so a
    // probe would otherwise have to infer "did the camera move?" from pixels —
    // impossible in an occluded pane. Read-only; arming still goes through the
    // real ◎ button in the inspector header.
    W.__simFollowState = () => ({
      id: followAgentIdRef.current,
      pan: { ...panRef.current },
      zoom: zoomRef.current,
      target3d: [...cam3dRef.current.target],
      dist3d: cam3dRef.current.dist,
      // Controller state: the camera's own velocity and the EMA-filtered agent
      // velocity that feeds the look-ahead (world units/s in the frame the
      // active dimension works in).
      camV: [...followCamVRef.current],
      agentV: [...followAgentVRef.current],
    });
  }, [is3D, draw, instanceToSlot]);

  // 3D Grid CA: mirror the control state into the renderer refs + redraw.
  useEffect(() => { clip3dRef.current = clip3d; draw(); }, [clip3d, draw]);
  useEffect(() => {
    alpha3dRef.current = alpha3d;
    // Phase C: 3D alpha-blend needs back-to-front sorting (gl3d's job). Turning it
    // ON detaches the sphere direct render → gl3d full render (frame path); OFF
    // re-attaches when eligible + the runtime is up (mirrors the metaballs effect).
    if (is3dRef.current) {
      if (alpha3d) {
        if (agentDirectRenderActiveRef.current) {
          agentDirectRenderActiveRef.current = false;
          const sc = agentSphereCanvasRef.current;
          if (sc) sc.style.display = 'none';
          if (workerRef.current) workerRef.current.postMessage({ type: 'setAgentUiSync', on: true });
          agentUiSyncPostedRef.current = true;
        }
      } else if (agentRenderEligibleRef.current) {
        maybeAttachAgentCanvas();
      }
    }
    draw();
  }, [alpha3d, draw, maybeAttachAgentCanvas]);
  useEffect(() => { agentsFront3dRef.current = agentsFront3d; draw(); }, [agentsFront3d, draw]);
  // The occupancy AO is BAKED into the voxel buffer at upload time, so toggling
  // AO on/off must force a re-upload (colours are unchanged, so draw()'s
  // identity check would otherwise skip uploadColors and the AO never appears /
  // clears). Strength changes are a shader uniform → just a redraw.
  const prevAoRef = useRef(light3d.ao);
  useEffect(() => {
    light3dRef.current = light3d;
    if (light3d.ao !== prevAoRef.current) { prevAoRef.current = light3d.ao; lastUploadedColors3dRef.current = null; }
    draw();
  }, [light3d, draw]);
  useEffect(() => { cellGaps3dRef.current = cellGaps3d; draw(); }, [cellGaps3d, draw]);
  // Metaballs: no snapshot invalidation needed — the renderer bakes its field
  // lazily from its own cached agent instance data (setMetaballs marks it dirty
  // on an enabled/influence/resolution change; threshold is a pure uniform).
  useEffect(() => { agentMetaballsRef.current = agentMetaballs; draw(); }, [agentMetaballs, draw]);
  useEffect(() => {
    viz3dRef.current = viz3d;
    // Free-mode voxel render draws bounds/grid/axes itself — thread the toggles.
    if (voxelRenderActiveRef.current) postGridViz();
    draw();
  }, [viz3d, draw, postGridViz]);
  useEffect(() => {
    plane3dRef.current = { axis: plane3d.axis, pos: plane3d.pos };
    plane3dEnabledRef.current = plane3d.enabled;
    line3dAnchorRef.current = null;  // a staged Line anchor is meaningless on a moved plane
    draw();
  }, [plane3d, draw]);
  useEffect(() => { orbit3dRef.current = orbit3d; }, [orbit3d]);
  useEffect(() => { zoom3dRef.current = zoom3d; }, [zoom3d]);
  useEffect(() => {
    if (bg3d.enabled) {
      const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(bg3d.color.trim());
      bg3dRef.current = m
        ? [parseInt(m[1]!, 16) / 255, parseInt(m[2]!, 16) / 255, parseInt(m[3]!, 16) / 255, 1]
        : [0, 0, 0, 1];
    } else {
      bg3dRef.current = null;  // transparent
    }
    draw();
  }, [bg3d, draw]);

  // Layer SHOW toggles (req 7): repaint when render-layer visibility changes. The
  // refs (showCaGridRef/showAgentsRef) are updated at declaration; draw() reads them
  // (3D voxels/agents via viz override; 2D blit/overlay gating).
  useEffect(() => { draw(); }, [showCaGrid, showAgents, showBonds, draw]);
  // Layer SIMULATE toggles (req 1): publish the freeze flags to the worker on
  // change (a worker reinit re-publishes via initWorkerWithDimensions). The toggles
  // are GLOBAL settings but only editable on an agent model's Layers panel — so for
  // a NON-agent model they're forced true (`!isAgentModel || flag`), or a stale
  // `false` from a prior agent model would silently freeze the grid with no UI to
  // recover. Default true → no-op.
  useEffect(() => {
    workerRef.current?.postMessage({ type: 'setSimLayers', simulateCells: !isAgentModel || simulateCells, simulateAgents: !isAgentModel || simulateAgents });
  }, [simulateCells, simulateAgents, isAgentModel]);
  // Vision cones need a per-agent HEADING, and the render snapshot ships vx/vy
  // only for sprite models (P2 slim) — so ask the worker to include velocity
  // while the display is on. Without this every agent reads a zero heading and
  // the cones render as full circles (the omnidirectional rule). Re-published
  // on a worker reinit by initWorkerWithDimensions (the setSimLayers pattern).
  useEffect(() => {
    workerRef.current?.postMessage({ type: 'setAgentSnapshotVelocity', on: showVision !== 'off' });
  }, [showVision]);
  // Clip / brush-plane re-clamp on a simulator resize (req 2): when the live grid
  // dims shrink, pull lo/hi/pos back into the new world extent so a stale handle
  // can't point outside the volume (the slider maxes already track the live dims).
  useEffect(() => {
    const W = gridWidth.current || simWidth, H = gridHeight.current || simHeight, D = is3D ? (gridDepth.current || simDepth) : 1;
    const ext = (ax: 'x' | 'y' | 'z' | 'camera') => ax === 'x' ? (W - 1) / 2 + 0.5 : ax === 'y' ? (H - 1) / 2 + 0.5 : ax === 'z' ? (D - 1) / 2 + 0.5 : Math.max(W, H, D) / 2 + 1;
    setClip3d(c => {
      const e = ext(c.axis);
      const lo = Math.max(-e, Math.min(e, c.lo)), hi = Math.max(-e, Math.min(e, c.hi));
      return (lo === c.lo && hi === c.hi) ? c : { ...c, lo, hi };
    });
    setPlane3d(p => {
      const max = p.axis === 'x' ? W - 1 : p.axis === 'y' ? H - 1 : D - 1;
      const pos = Math.max(0, Math.min(max, p.pos));
      return pos === p.pos ? p : { ...p, pos };
    });
  }, [simWidth, simHeight, simDepth, is3D]);

  // 3D Grid CA: the camera-animation loop — auto-orbit (spins yaw) and auto-zoom
  // (dollies `dist` one way, clamped at the distance limits so it stops instead of
  // zooming forever). ONE rAF for both: two independent loops would each call draw()
  // every frame and double the redraw rate when both are on. Reads the params through
  // refs so a slider drag doesn't restart the loop; the effect only re-runs when
  // either is toggled. `last` resets to 0 while hidden so the first frame back can't
  // apply a huge dt (a tab-away would otherwise fling the camera).
  //
  // The dolly is MULTIPLICATIVE (`*= exp(speed*dt)`) so it reads as a constant-rate
  // zoom at every distance; a manual wheel-zoom mid-flight just composes with it
  // (the loop scales whatever distance the camera is at — it never overrides it).
  useEffect(() => {
    if (!is3D || (!orbit3d.on && !zoom3d.on)) return;
    let raf = 0; let last = 0;
    const tick = (ts: number) => {
      if (!visibleRef.current) { last = 0; raf = requestAnimationFrame(tick); return; }
      const dt = last ? Math.min(0.1, (ts - last) / 1000) : 0; last = ts;
      const cam = cam3dRef.current;
      if (orbit3dRef.current.on) cam.yaw += orbit3dRef.current.speed * dt;
      const z = zoom3dRef.current;
      if (z.on && z.speed !== 0) {
        cam.dist = Math.max(MIN_CAM_DIST, Math.min(MAX_CAM_DIST, cam.dist * Math.exp(z.speed * dt)));
      }
      draw();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [is3D, orbit3d.on, zoom3d.on, draw]);

  // ── FOLLOW MODE — the camera tracks the followed agent (2D pan / 3D target) ──
  //
  // ONE rAF loop for both dimensions (the auto-orbit pattern above: params read
  // through refs so nothing restarts it; `last` resets while hidden so a
  // tab-away can't apply a huge dt and fling the camera). It only ever writes
  // the SAME camera state a manual pan writes — 2D `panRef`, 3D `cam.target` —
  // then calls draw(), so every downstream consumer (the direct-render camera
  // message, the cursor overlay, the composite render) follows for free.
  //
  // THE CONTROLLER — the standard game-camera composition: a small REST LATCH,
  // a CRITICALLY DAMPED SPRING, and a FILTERED VELOCITY FEEDFORWARD.
  // Rationale + measurements: docs/INVESTIGATION_FOLLOW_CAMERA.md.
  //
  //   • The spring is what makes it acceleration-based: the camera carries a
  //     VELOCITY state and is accelerated toward the target, so it picks up
  //     smoothly and (being critically damped) never overshoots.
  //   • The feedforward is what makes it CATCH UP. A spring tracking a target
  //     moving at a constant speed settles at a lag of exactly 2v/ω, so aiming
  //     at `agent + (2/ω)·v_agent` cancels that lag by construction — zero
  //     steady-state error, nothing to tune. (The previous law — a first-order
  //     ease toward the DEADZONE EDGE — had a structural offset of
  //     `v/k + dz·AIM`; measured in-browser at 78.4 px against a 78.75 px
  //     deadzone, i.e. the followed agent permanently rode the boundary, and
  //     at low speed it saw-toothed between 44 and 79 px as it latched and
  //     re-engaged. Both are gone: the same run now measures under a pixel.)
  //   • The agent's velocity is DERIVED from successive render-snapshot
  //     positions, never from the engine's vx/vy: that needs no worker plumbing
  //     and, crucially, it works for models that move agents with Set Agent
  //     Position and leave vx/vy at zero (Ant Necrophoresis) — and the slim
  //     render snapshot omits vx/vy entirely unless something asks for it.
  //   • The raw sample is speed-clamped to ONE WORLD EXTENT PER SECOND. A
  //     teleport implies ~60 worlds/s and would fling the camera far past the
  //     agent (measured: 144 px of overshoot without the clamp, 0.0 px with).
  //     No real agent approaches that speed, so the clamp never clips genuine
  //     motion.
  //   • The DEADZONE IS NOW ONLY A REST LATCH. It no longer shrinks the error
  //     (aiming at its edge is exactly what parked the camera on the boundary);
  //     it just decides when the controller may stop writing. It gates on the
  //     position error AND the camera velocity AND the filtered agent velocity,
  //     so it cannot fire mid-flight and cannot stall a genuine slow follow —
  //     and since the spring drives both to zero, it latches in finite time
  //     (measured 1.5 s), which is what keeps a parked agent at ZERO writes and
  //     ZERO draws. High-frequency jitter is absorbed by the spring's own
  //     second-order roll-off instead of by a large allowance.
  const FOLLOW_OMEGA = 6;               // rad/s — critically damped; ~0.33 s smooth time
  const FOLLOW_VEL_TAU = 0.35;          // s — EMA time constant on the derived agent velocity
  const FOLLOW_REST_FRAC_2D = 0.03;     // rest radius, of min(canvas w, h), in screen px
  const FOLLOW_REST_V_PX_2D = 1.5;      // ...and the "at rest" speed, in screen px/s
  const FOLLOW_REST_FRAC_3D = 0.02;     // rest radius, of the largest grid dimension
  const FOLLOW_REST_VIEW_3D = 0.04;     // ...but never more than this share of the eye distance
  const FOLLOW_REST_V_3D = 0.002;       // "at rest" speed, of the largest grid dimension, per second
  useEffect(() => {
    if (followAgentId == null) return;
    let raf = 0; let last = 0;
    followCamVRef.current = [0, 0, 0];
    followAgentVRef.current = [0, 0, 0];
    followPrevPosRef.current = null;
    /** Fold a torus delta to the SHORTEST way round (so an agent crossing the
     *  seam never makes the camera fly the long way across the world). */
    const fold = (d: number, period: number) => {
      if (period <= 0) return d;
      const h = period / 2;
      return d > h ? d - period * Math.round(d / period)
        : d < -h ? d - period * Math.round(d / period) : d;
    };
    const tick = (ts: number) => {
      raf = requestAnimationFrame(tick);
      if (!visibleRef.current) { last = 0; return; }
      const dt = last ? Math.min(0.1, (ts - last) / 1000) : 0; last = ts;
      if (dt <= 0) return;
      const id = followAgentIdRef.current;
      const snap = agentsRef.current;
      if (id == null) return;
      // The agent died (or the population shrank past it): stop following, but
      // leave the popover open — it shows its own "Agent no longer exists".
      if (!snap || id < 0 || id >= snap.highWater || !snap.alive[id]) {
        if (snap) setFollowAgent(null);
        return;
      }
      const torus = boundaryTreatmentRef.current === 'torus';
      const ax = snap.x[id]!, ay = snap.y[id]!;
      const W = gridWidth.current, H = gridHeight.current;
      const D = gridDepth.current;
      const camV = followCamVRef.current, fv = followAgentVRef.current;
      // Per-frame controller factors. `expf` is the exact critically damped
      // decay e^(−ω·dt) in Unity SmoothDamp's rational form — unconditionally
      // stable, which matters because dt is only clamped, never fixed.
      const wt = FOLLOW_OMEGA * dt;
      const expf = 1 / (1 + wt + 0.48 * wt * wt + 0.235 * wt * wt * wt);
      const alpha = 1 - Math.exp(-dt / FOLLOW_VEL_TAU);
      const leadT = 2 / FOLLOW_OMEGA;   // the exact ramp-lag cancellation

      /** EMA-track the agent's velocity from successive snapshot positions, in
       *  whichever frame the caller works in. Spike-clamped to one world extent
       *  per second so a teleport can't inject a huge feedforward. */
      const trackVelocity = (px: number, py: number, pz: number, tx: number, ty: number, tz: number) => {
        const prev = followPrevPosRef.current;
        if (prev) {
          let rx = fold(px - prev[0], tx) / dt;
          let ry = fold(py - prev[1], ty) / dt;
          let rz = fold(pz - prev[2], tz) / dt;
          const sp = Math.hypot(rx, ry, rz);
          const maxSp = Math.max(W, H, D, 1);
          if (sp > maxSp) { const s = maxSp / sp; rx *= s; ry *= s; rz *= s; }
          fv[0] += alpha * (rx - fv[0]);
          fv[1] += alpha * (ry - fv[1]);
          fv[2] += alpha * (rz - fv[2]);
        }
        followPrevPosRef.current = [px, py, pz];
      };
      /** One critically damped spring step on one axis; returns the camera
       *  DELTA (everything stays a delta, so the torus fold applies unchanged
       *  and no absolute position is ever compared across a seam). */
      const advance = (err: number, i: number) => {
        const change = -(err + leadT * fv[i]!);
        const temp = (camV[i]! + FOLLOW_OMEGA * change) * dt;
        camV[i] = (camV[i]! - FOLLOW_OMEGA * temp) * expf;
        return (change + temp) * expf - change;
      };
      const atRest = (dist: number, rest: number, vEps: number) =>
        dist <= rest && Math.hypot(camV[0]!, camV[1]!, camV[2]!) <= vEps
        && Math.hypot(fv[0]!, fv[1]!, fv[2]!) <= vEps;

      if (is3dRef.current) {
        const r = gl3dRef.current;
        if (!r) return;
        const md = Math.max(W, H, D, 1);
        const hx = (W - 1) / 2, hy = (H - 1) / 2, hz = (D - 1) / 2;
        const az = snap.z.length > 0 ? snap.z[id]! : 0;
        // gl3d's Z-up remap: col→+X, row→−Y, layer→−Z (see uploadAgents).
        const wx = ax - hx, wy = hy - ay, wz = hz - az;
        trackVelocity(wx, wy, wz, torus ? W : 0, torus ? H : 0, torus ? D : 0);
        const cam = cam3dRef.current;
        let dx = wx - cam.target[0], dy = wy - cam.target[1], dz2 = wz - cam.target[2];
        if (torus) { dx = fold(dx, W); dy = fold(dy, H); dz2 = fold(dz2, D); }
        // World-space rest radius, tightened when zoomed in so a close-up still
        // tracks (cam.dist is a MULTIPLE of the largest grid dimension).
        const rest = Math.min(FOLLOW_REST_FRAC_3D * md, FOLLOW_REST_VIEW_3D * cam.dist * md);
        if (atRest(Math.hypot(dx, dy, dz2), rest, FOLLOW_REST_V_3D * md)) {
          camV[0] = camV[1] = camV[2] = 0;
          return;                                     // settled — no write, no draw
        }
        cam.target[0] += advance(dx, 0);
        cam.target[1] += advance(dy, 1);
        cam.target[2] += advance(dz2, 2);
        if (torus) {
          // No tiling in 3D — the volume is drawn once, so keep the target
          // inside it or the followed agent leaves the frame after a wrap.
          cam.target[0] = fold(cam.target[0], W);
          cam.target[1] = fold(cam.target[1], H);
          cam.target[2] = fold(cam.target[2], D);
        }
        draw();
        return;
      }

      // 2D — work in WORLD (cell) units, then convert back to pan pixels, so the
      // torus fold is a plain modulo and zoom cancels out of the geometry.
      const canvas = canvasRef.current;
      const parent = canvas?.parentElement;
      if (!parent || W === 0 || H === 0) return;
      const rect = parent.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const scale = Math.min(rect.width / W, rect.height / H) * zoomRef.current;
      if (!(scale > 0)) return;
      const pan = panRef.current;
      // The world point currently at the screen centre (inverse of the draw
      // transform `ox = (parentW - W*scale)/2 + pan.x`).
      const camX = W / 2 - pan.x / scale;
      const camY = H / 2 - pan.y / scale;
      trackVelocity(ax, ay, 0, torus ? W : 0, torus ? H : 0, 0);
      let dx = ax - camX, dy = ay - camY;
      if (torus) { dx = fold(dx, W); dy = fold(dy, H); }
      // The rest radius and the "at rest" speed are defined in SCREEN px (so
      // they mean the same thing at any zoom) and converted to world units.
      const rest = FOLLOW_REST_FRAC_2D * Math.min(rect.width, rect.height) / scale;
      if (atRest(Math.hypot(dx, dy), rest, FOLLOW_REST_V_PX_2D / scale)) {
        camV[0] = camV[1] = camV[2] = 0;
        return;                                       // settled — no write, no draw
      }
      let nx = camX + advance(dx, 0), ny = camY + advance(dy, 1);
      // Infinity mode TILES the torus, so a camera that walks off the world edge
      // still shows the right thing — leave the pan continuous (no jump). Without
      // tiling the single drawn copy would scroll away from the agent, so wrap the
      // camera back into the world (the background jumps by one world width, which
      // mirrors the agent's own teleport).
      if (torus && !(infinityCanvasRef.current)) {
        nx = ((nx % W) + W) % W;
        ny = ((ny % H) + H) % H;
      }
      panRef.current = { x: (W / 2 - nx) * scale, y: (H / 2 - ny) * scale };
      draw();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [followAgentId, draw, setFollowAgent]);

  // Pause simulation when leaving tab, redraw when coming back
  useEffect(() => {
    if (visible) {
      requestAnimationFrame(() => draw());
      // Under WebGPU direct render, the OffscreenCanvas can land in an
      // unpresented state if a soft recompile happened while the simulator
      // was hidden (startWebGPUInit unconfigures + reconfigures the canvas
      // context with the new device — the next compositor frame may show
      // blank). Ask the worker to re-dispatch the present so the canvas has
      // fresh content the moment the user returns to the tab.
      if (directRenderActiveRef.current && workerRef.current) {
        workerRef.current.postMessage({ type: 'refreshDisplay' });
      }
      // L1: same for the voxel canvas (re-present + re-send camera).
      if (voxelRenderActiveRef.current && workerRef.current) {
        const gv = computeVoxelRenderView();
        if (gv) { lastGridCameraKeyRef.current = ''; workerRef.current.postMessage({ type: 'setGridCamera', view: gv }); }
        workerRef.current.postMessage({ type: 'refreshGridDisplay' });
      }
      // A1: same for the agent direct-render canvas (re-present + re-send camera).
      if (agentDirectRenderActiveRef.current && workerRef.current) {
        const view = computeAgentRenderView();
        if (view) { lastAgentCameraKeyRef.current = ''; workerRef.current.postMessage({ type: 'setAgentCamera', view }); }
        workerRef.current.postMessage({ type: 'refreshAgentDisplay' });
      }
    } else if (playing) {
      setPlaying(false);
    }
  }, [visible, draw, playing, computeAgentRenderView, computeVoxelRenderView]);

  // Brush refs (so event handlers don't need to re-register)
  const brushColorRef = useRef('#4cc9f0');
  const brushWRef = useRef(1);
  const brushHRef = useRef(1);
  const brushShapeRef = useRef<BrushShape>('rect');
  const brushRadiusRef = useRef(3);
  const brushRingWidthRef = useRef(1);
  const brushLineWidthRef = useRef(1);
  const brush3dVolumeRef = useRef(false);
  const brushBoxDepthRef = useRef(3);
  /** First click of the two-click Line tool (grid coords); null = not staged. */
  const lineAnchorRef = useRef<{ row: number; col: number } | null>(null);
  const activeViewerRef = useRef('');
  const brushMappingRef = useRef('');
  useEffect(() => { brushColorRef.current = brushColor; }, [brushColor]);
  useEffect(() => { brushWRef.current = brushW; }, [brushW]);
  useEffect(() => { brushHRef.current = brushH; }, [brushH]);
  useEffect(() => { brushShapeRef.current = brushShape; }, [brushShape]);
  useEffect(() => { brushRadiusRef.current = brushRadius; }, [brushRadius]);
  useEffect(() => { brushRingWidthRef.current = brushRingWidth; }, [brushRingWidth]);
  useEffect(() => { brushLineWidthRef.current = brushLineWidth; }, [brushLineWidth]);
  useEffect(() => { brush3dVolumeRef.current = brush3dVolume; }, [brush3dVolume]);
  useEffect(() => { brushBoxDepthRef.current = brushBoxDepth; }, [brushBoxDepth]);
  // Recompute which viewers want the zoomed-out glyph-color fallback whenever
  // the graph changes (Set Cell Looks nodes with useGlyph + fallbackToGlyphColor).
  useEffect(() => {
    let all = false;
    const ids = new Set<string>();
    const scan = (nodes: typeof model.graphNodes) => {
      for (const n of nodes) {
        const c = n.data?.config as Record<string, unknown> | undefined;
        if (n.data?.nodeType === 'setCellLooks' && c?.useGlyph && c?.fallbackToGlyphColor) {
          const mid = String(c.mappingId ?? '');
          if (mid === CURRENT_VIEWER_SENTINEL) all = true;
          else if (mid) ids.add(mid);
        }
      }
    };
    scan(model.graphNodes);
    for (const d of model.macroDefs || []) scan(d.nodes);
    glyphFallbackRef.current = { all, ids };
  }, [model.graphNodes, model.macroDefs]);
  // Leaving the Line tool (or switching brush tab) drops a staged first click.
  useEffect(() => { if (brushShape !== 'line') { lineAnchorRef.current = null; line3dAnchorRef.current = null; } }, [brushShape]);
  useEffect(() => { lineAnchorRef.current = null; line3dAnchorRef.current = null; }, [brushMapping]);
  useEffect(() => { activeViewerRef.current = activeViewer; }, [activeViewer]);
  // Default / repair the active AGENT viewer to a valid agent mapping (the first
  // A→C agent mapping) when the agent-mapping set changes.
  useEffect(() => {
    const ags = (model.agentMappings ?? []).filter(m => m.isAttributeToColor);
    if (ags.length === 0) { if (activeAgentViewer) setActiveAgentViewer(''); return; }
    if (!ags.some(m => m.id === activeAgentViewer)) setActiveAgentViewer(ags[0]!.id);
  }, [model.agentMappings, activeAgentViewer]);
  // When the user switches output-mapping tabs (e.g. while paused), fire one color pass so the
  // grid reflects the new mapping immediately instead of waiting for the next step/paint/reset.
  // Ref guard skips the initial mount — otherwise we'd fire before the worker has a step fn.
  const viewerInitDoneRef = useRef(false);
  useEffect(() => {
    if (!viewerInitDoneRef.current) {
      viewerInitDoneRef.current = true;
      return;
    }
    if (!workerRef.current) return;
    // Carry BOTH viewers so switching either the cell or the agent view recolours
    // immediately (the worker recolours agents from activeAgentViewer in sendColors).
    workerRef.current.postMessage({ type: 'colorPass', activeViewer, activeAgentViewer });
  }, [activeViewer, activeAgentViewer]);
  const showBrushCursorRef = useRef(true);
  useEffect(() => { showBrushCursorRef.current = showBrushCursor; draw(); }, [showBrushCursor, draw]);
  // Redraw when the environment background changes (the ref is updated in its own
  // effect above; this one repaints so the change shows immediately even when paused).
  useEffect(() => { draw(); }, [bg2d, agentOutlines, showVision, draw]);
  // A1 Glow option — redraw so the agent RenderView camera picks up the change.
  useEffect(() => { draw(); }, [agentGlow, draw]);
  // A1: re-evaluate UI-sync on state-signal changes (pause / recording / inspector
  // / edit target / metaballs suppression). Hover-during-play is handled per-frame.
  useEffect(() => { updateAgentUiSync(); }, [playing, recording, agentInspectIds, editTargetId, agentMetaballs.enabled, updateAgentUiSync]);
  // L1: the GRID sibling — re-evaluate the voxel UI-sync on every state signal that
  // needs the CPU colours mirror. `alpha3d` is the ONLY remaining FRAME-MODE-ONLY
  // visual (the WGSL pass does not back-to-front sort): turning it on pins UI-sync
  // ON, which hides the voxel canvas and hands the frame back to gl3d exactly as
  // before L1; turning it off releases free mode again. Occupancy AO (Phase 1) and
  // cast shadows (Phase 2) run free-mode so they are NOT want terms — their
  // re-present rides the light3d effect's draw() → postGridCamera. Hover-during-play
  // is per-frame.
  useEffect(() => {
    updateGridUiSync();
  }, [playing, recording, alpha3d, updateGridUiSync]);
  // A1: a CPU-only visual (metaballs) needs the CPU overlay path — detach direct
  // render when it turns on, re-attach when it turns off (if eligible + runtime up).
  useEffect(() => {
    if (agentMetaballs.enabled) {
      if (agentDirectRenderActiveRef.current) { agentDirectRenderActiveRef.current = false; agentRenderCanvasRef.current = null; }
    } else {
      maybeAttachAgentCanvas();
    }
    draw();
  }, [agentMetaballs.enabled, draw, maybeAttachAgentCanvas]);
  const showGridlinesRef = useRef(false);
  useEffect(() => { showGridlinesRef.current = showGridlines; }, [showGridlines]);
  const show2dAxesRef = useRef(false);
  // Sync + redraw: the onClick's own draw() runs BEFORE this effect updates the
  // ref (stale for that call) — the post-sync draw here makes the toggle land
  // immediately even while paused.
  useEffect(() => { show2dAxesRef.current = show2dAxes; draw(); }, [show2dAxes, draw]);
  // Inspect mode (toolbar toggle): plain LMB inspects cells/agents — the
  // keyboard-free equivalent of Shift+LMB (both 2D and 3D read the ref in
  // their pointer handlers). Session-only, never persisted.
  const inspectModeRef = useRef(false);
  useEffect(() => { inspectModeRef.current = inspectMode; }, [inspectMode]);
  // Middle-click autoscroll — origin/cursor are canvas-local pixel coords.
  // When origin is non-null we're in autoscroll mode; the rAF loop pans by a
  // velocity proportional to (cursor - origin) and the draw() function paints
  // a small compass indicator at the origin.
  const autoscrollOriginRef = useRef<{ x: number; y: number } | null>(null);
  const autoscrollCursorRef = useRef<{ x: number; y: number } | null>(null);
  const autoscrollRafRef = useRef<number | null>(null);
  const infinityCanvasRef = useRef(false);
  useEffect(() => { infinityCanvasRef.current = infinityCanvas; draw(); }, [infinityCanvas, draw]);
  // Boundary-treatment ref so the memoized draw/screenToGrid/brushCellsAt callbacks
  // (empty-deps useCallbacks) can read the live value.
  const boundaryTreatmentRef = useRef<'torus' | 'constant'>(model.properties.boundaryTreatment);
  useEffect(() => {
    boundaryTreatmentRef.current = model.properties.boundaryTreatment;
    draw();
  }, [model.properties.boundaryTreatment, draw]);
  // Live formDistance (bond-brush contact multiplier) so the 3D bond scan — a
  // useCallback captured once by the empty-deps 3D pointer effect — reads the
  // current value instead of the one baked at 3D-switch time.
  const formDistanceRef = useRef(1);
  formDistanceRef.current = cbNum(model.centerBased, 'formDistance');
  // When the model leaves torus, infinity canvas no longer makes physical sense
  // (it would lie about the grid wrapping). Force the toggle off.
  useEffect(() => {
    if (model.properties.boundaryTreatment !== 'torus' && infinityCanvas) {
      setInfinityCanvas(false);
    }
  }, [model.properties.boundaryTreatment, infinityCanvas]);
  useEffect(() => { brushMappingRef.current = brushMapping; }, [brushMapping]);
  // Mappings ref lets mouse/keyboard handlers see the latest model.mappings without re-registering.
  const mappingsRef = useRef(model.mappings);
  useEffect(() => { mappingsRef.current = model.mappings; }, [model.mappings]);
  // Cell attributes ref — flushPaintBatch needs the attribute types to encode
  // Manual Brush values into typed-array numerics. Keeping a ref avoids
  // re-registering the paint callback on every model edit.
  const cellAttrsRef = useRef<Attribute[]>(model.attributes.filter(a => !a.isModelAttribute));
  useEffect(() => { cellAttrsRef.current = model.attributes.filter(a => !a.isModelAttribute); }, [model.attributes]);
  // In-page color popover shown on Modifier+RMB (null = closed).
  // We render our own popover at the cursor because the native <input type="color">
  // picker opens as an OS-managed window anchored to the input's DOM position, which
  // never matches the cursor. The popover's "Full picker" row opens the native picker
  // for users who want the full gradient UI.
  const [colorPopover, setColorPopover] = useState<{ x: number; y: number } | null>(null);

  // Inspect-cell popups (Shift+LMB). Each popup tracks one cell. Multiple
  // popups can coexist; z-order is the array order (later items render on top).
  // inspectDataRef holds the latest worker-supplied attribute values keyed by
  // cellIdx; bumping inspectDataVersion forces a re-render of all popovers.
  const [inspectPopovers, setInspectPopovers] = useState<InspectPopoverState[]>([]);
  const [hoveredInspectIdx, setHoveredInspectIdx] = useState<number | null>(null);
  // 3D: highlight the inspected cell whose popover the user is hovering (the 2D
  // connector line is hidden in 3D — it can't track the projection).
  useEffect(() => {
    if (is3D && hoveredInspectIdx != null) {
      const w = gridWidth.current, wh = w * gridHeight.current;
      const layer = Math.floor(hoveredInspectIdx / wh);
      const rem = hoveredInspectIdx - layer * wh;
      const row = Math.floor(rem / w);
      inspectHighlight3dRef.current = [{ layer, row, col: rem - row * w }];
    } else {
      inspectHighlight3dRef.current = [];
    }
    if (is3D) draw();
  }, [hoveredInspectIdx, is3D, draw]);
  // Agent inspect rings (2D + 3D): draw() / drawCursorLayer derive them from
  // the open popovers + the LIVE snapshot every frame (see the 3D agent branch
  // and the 2D cursor-layer inspect block), so this effect only has to force a
  // repaint when the popover set (or the followed agent) changes — the ring
  // must appear / disappear / restyle immediately even while the sim is paused.
  useEffect(() => {
    draw();
  }, [agentPopovers, agentSweepPopover, followAgentId, is3D, draw]);
  const [pulseInspectIdx, setPulseInspectIdx] = useState<number | null>(null);
  const [focusedInspectIdx, setFocusedInspectIdx] = useState<number | null>(null);
  const inspectDataRef = useRef<Map<number, Record<string, number>>>(new Map());
  const inspectColorsRef = useRef<Map<number, { r: number; g: number; b: number }>>(new Map());
  // Variegated cells only: per-cell orientation (0..3). Worker omits the field
  // entirely when variegation is disabled, so the popover only shows the
  // orientation row when the map has an entry for the cell.
  const inspectOrientationsRef = useRef<Map<number, number>>(new Map());
  const [, bumpInspectVersion] = useState(0);
  const popoverRectsRef = useRef<Map<number, DOMRect>>(new Map());
  const pulseTimerRef = useRef<number | null>(null);
  // Shift+LMB sweep: hold-and-drag a single transient inspector across cells
  // instead of pinning one popover per click. On release, if the cursor never
  // left the start cell we COMMIT (fall through to the existing pin path); if
  // it moved we DISCARD. The ref mirrors state so the mouse handlers (registered
  // once per useEffect run) read the live value without closure staleness.
  const [sweepInspector, setSweepInspector] = useState<InspectPopoverState | null>(null);
  const sweepInspectorRef = useRef<InspectPopoverState | null>(null);
  const sweepActiveRef = useRef(false);
  // Bond-Graph Agents — the 2D AGENT sweep (drag re-targets the open agent
  // inspector; see the mousedown/mousemove/mouseup agent-sweep branches).
  const agentSweepActiveRef = useRef(false);
  const agentSweepMovedRef = useRef(false);
  const agentSweepStartIdRef = useRef(-1);
  const agentSweepAnchorRef = useRef<{ x: number; y: number } | null>(null);
  const sweepStartCellRef = useRef<number | null>(null);
  const sweepMovedRef = useRef(false);
  const sweepRectRef = useRef<DOMRect | null>(null);
  // Mirror the popover cell ids in a ref so worker-init code (running outside
  // React's render cycle) can re-publish the subscription without staleness.
  const inspectCellIdxsRef = useRef<number[]>([]);
  useEffect(() => {
    const pinnedIds = inspectPopovers.map(p => p.cellIdx);
    const sweepIdx = sweepInspector?.cellIdx;
    const ids = sweepIdx != null && !pinnedIds.includes(sweepIdx)
      ? [...pinnedIds, sweepIdx]
      : pinnedIds;
    inspectCellIdxsRef.current = ids;
    // Drop stale rect entries so the hover overlay doesn't anchor to a
    // popover that was just closed.
    const live = new Set(ids);
    for (const k of Array.from(popoverRectsRef.current.keys())) {
      if (!live.has(k)) popoverRectsRef.current.delete(k);
    }
    for (const k of Array.from(inspectDataRef.current.keys())) {
      if (!live.has(k)) inspectDataRef.current.delete(k);
    }
    for (const k of Array.from(inspectColorsRef.current.keys())) {
      if (!live.has(k)) inspectColorsRef.current.delete(k);
    }
    for (const k of Array.from(inspectOrientationsRef.current.keys())) {
      if (!live.has(k)) inspectOrientationsRef.current.delete(k);
    }
    workerRef.current?.postMessage({ type: 'setInspectCells', cellIdxs: ids });
    // L1: an open inspect popover needs the CPU colours mirror (its RGB swatch +
    // the gl3d frame render), so it pins the grid UI-sync ON.
    updateGridUiSync();
  }, [inspectPopovers, sweepInspector?.cellIdx, updateGridUiSync]);
  // Auto-close popovers whose cell is out of bounds after a grid resize.
  useEffect(() => {
    const w = model.properties.gridWidth;
    const h = model.properties.gridHeight;
    setInspectPopovers(prev => {
      const next = prev.filter(p => p.row < h && p.col < w);
      return next.length === prev.length ? prev : next;
    });
    setSweepInspector(prev => {
      if (!prev) return prev;
      if (prev.row >= h || prev.col >= w) {
        sweepActiveRef.current = false;
        sweepStartCellRef.current = null;
        sweepMovedRef.current = false;
        sweepInspectorRef.current = null;
        return null;
      }
      return prev;
    });
  }, [model.properties.gridWidth, model.properties.gridHeight]);

  // Close EVERY inspect dialog when a different model is loaded (or New'd).
  // A cell popover keys on a flat cell index of the OLD grid and an agent
  // popover on a slot id of the OLD population, so both are meaningless the
  // moment the model is swapped — leaving them open showed stale/garbage rows.
  //
  // THE SEAM: `modelVersion` (ModelState) is bumped by EXACTLY two reducer
  // actions — LOAD_MODEL and NEW_MODEL — so it means "a different model now"
  // by construction and covers every call site for free (File > Load, a
  // Library card, drag-and-drop, the PWA file handler, File > New, and a
  // re-load of the SAME file). Deliberately NOT keyed on
  // `model.properties.name` (a different file with the same name would not
  // close), nor on `loadedFileName` (New nulls it; re-loading the same file
  // leaves it equal), nor on a window CustomEvent (several load call sites —
  // missing one silently regresses). A model EDIT never bumps it, so a soft
  // recompile / attribute tweak correctly leaves popovers alone, and a
  // simulator Resize keeps its existing out-of-bounds-only auto-close above.
  useEffect(() => {
    // Cell inspectors (pinned + the transient sweep) and their gesture state.
    setInspectPopovers([]);
    setSweepInspector(null);
    sweepInspectorRef.current = null;
    sweepActiveRef.current = false;
    sweepStartCellRef.current = null;
    sweepMovedRef.current = false;
    sweepRectRef.current = null;
    setHoveredInspectIdx(null);
    setFocusedInspectIdx(null);
    setPulseInspectIdx(null);
    if (pulseTimerRef.current != null) { window.clearTimeout(pulseTimerRef.current); pulseTimerRef.current = null; }
    inspectDataRef.current.clear();
    inspectColorsRef.current.clear();
    inspectOrientationsRef.current.clear();
    popoverRectsRef.current.clear();
    inspectHighlight3dRef.current = [];
    // Agent inspectors — the ref LEADS the state (a fast click reads it before
    // any re-render; see openAgentInspector), so it must be cleared here too.
    setAgentPopovers([]);
    setAgentSweepPopover(null);
    agentSweepPopoverRef.current = null;
    setFocusedAgentPopoverId(null);
    agentStatesRef.current.clear();
    // FOLLOW MODE holds an id into the OLD population — clear it here too (the
    // popover-gone effect would also catch it, but the ref LEADS the state, so
    // the tracker must not see a stale id for even one frame).
    followAgentIdRef.current = null;
    setFollowAgentIdState(null);
    agentSweepActiveRef.current = false;
    agentSweepMovedRef.current = false;
    agentSweepStartIdRef.current = -1;
    agentSweepAnchorRef.current = null;
    // Transient visuals that also hold an id into the OLD population: a staged
    // Glue/Cut anchor and the single-scope Edit target (its dashed highlight +
    // prefill would otherwise point at an arbitrary agent of the new model).
    // The 3D inspect rings need no clearing — draw() derives them from the
    // popovers cleared just above.
    agentGlueAnchorRef.current = -1;
    editTargetIdRef.current = -1;
    setEditTargetId(-1);
    editPrefillIdRef.current = -1;
    draw();
  }, [modelVersion, draw]);

  // Pin (or re-focus) an inspector popover at the given cell. Shared by the
  // Shift+LMB click path (mouseup-after-no-movement on a sweep) and any
  // future commit point.
  const commitInspectPopover = useCallback((idx: number, row: number, col: number, x: number, y: number) => {
    setInspectPopovers(prev => {
      const existingIdx = prev.findIndex(p => p.cellIdx === idx);
      if (existingIdx >= 0) {
        const next = [...prev];
        const [moved] = next.splice(existingIdx, 1);
        next.push(moved!);
        setPulseInspectIdx(idx);
        if (pulseTimerRef.current != null) window.clearTimeout(pulseTimerRef.current);
        pulseTimerRef.current = window.setTimeout(() => {
          setPulseInspectIdx(curr => (curr === idx ? null : curr));
          pulseTimerRef.current = null;
        }, 500);
        setFocusedInspectIdx(idx);
        return next;
      }
      return [...prev, { cellIdx: idx, row, col, x, y }];
    });
    setFocusedInspectIdx(idx);
  }, []);

  // 3D Grid CA: open the inspector for a picked flat cell index. Decodes the
  // index → (row, col) within its layer for the label; the popover fetches cell
  // data by cellIdx (the worker's inspectCells keys on the flat index).
  openInspect3dRef.current = (idx: number, x: number, y: number) => {
    const w = gridWidth.current, wh = w * gridHeight.current;
    const layer = Math.floor(idx / wh);
    const rem = idx - layer * wh;
    const row = Math.floor(rem / w);
    const col = rem - row * w;
    commitInspectPopover(idx, row, col, x, y);
  };

  /** Convert screen coords to grid cell coords. In infinity mode, wraps via
   *  modulo so painting / hovering across tile seams hits the correct cell. */
  const screenToGrid = useCallback((clientX: number, clientY: number): { row: number; col: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.parentElement!.getBoundingClientRect();
    const w = gridWidth.current;
    const h = gridHeight.current;
    const parentW = rect.width;
    const parentH = rect.height;
    const baseScale = Math.min(parentW / w, parentH / h);
    const scale = baseScale * zoomRef.current;
    const ox = (parentW - w * scale) / 2 + panRef.current.x;
    const oy = (parentH - h * scale) / 2 + panRef.current.y;
    let col = Math.floor((clientX - rect.left - ox) / scale);
    let row = Math.floor((clientY - rect.top - oy) / scale);
    const infinity = infinityCanvasRef.current && boundaryTreatmentRef.current === 'torus';
    if (infinity) {
      col = ((col % w) + w) % w;
      row = ((row % h) + h) % h;
      return { row, col };
    }
    if (col < 0 || col >= w || row < 0 || row >= h) return null;
    return { row, col };
  }, []);

  /** Inverse of screenToGrid: cell (row, col) → top-left viewport coords and
   *  cell pixel size. Used by the inspect-cell hover overlay to anchor a
   *  contour around the inspected cell. Returns null if the canvas is not
   *  yet mounted or the grid is empty. */
  const gridToScreen = useCallback((row: number, col: number): { x: number; y: number; cellSize: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.parentElement!.getBoundingClientRect();
    const w = gridWidth.current;
    const h = gridHeight.current;
    if (w === 0 || h === 0) return null;
    const baseScale = Math.min(rect.width / w, rect.height / h);
    const scale = baseScale * zoomRef.current;
    const ox = (rect.width - w * scale) / 2 + panRef.current.x;
    const oy = (rect.height - h * scale) / 2 + panRef.current.y;
    return { x: rect.left + ox + col * scale, y: rect.top + oy + row * scale, cellSize: scale };
  }, []);

  // Bond-Graph Agents — continuous-position (fractional cell = world) coordinate
  // of a screen point, for seeding + nearest-agent picking. Unlike screenToGrid
  // it does NOT floor (agents live between cells). Torus-wraps in infinity mode.
  const screenToWorld = useCallback((clientX: number, clientY: number): { x: number; y: number; scale: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.parentElement!.getBoundingClientRect();
    const w = gridWidth.current, h = gridHeight.current;
    if (w === 0 || h === 0) return null;
    const baseScale = Math.min(rect.width / w, rect.height / h);
    const scale = baseScale * zoomRef.current;
    const ox = (rect.width - w * scale) / 2 + panRef.current.x;
    const oy = (rect.height - h * scale) / 2 + panRef.current.y;
    let x = (clientX - rect.left - ox) / scale;
    let y = (clientY - rect.top - oy) / scale;
    const infinity = infinityCanvasRef.current && boundaryTreatmentRef.current === 'torus';
    if (infinity) { x = ((x % w) + w) % w; y = ((y % h) + h) % h; return { x, y, scale }; }
    // Outside the environment with infinity OFF: no action (mirrors screenToGrid).
    // Without this the agent brush wrapped-modulo-applied to a cell inside the world
    // and drew a cursor while the pointer was in the letterbox margin.
    if (x < 0 || x >= w || y < 0 || y >= h) return null;
    return { x, y, scale };
  }, []);

  // Nearest LIVE agent under a screen point (within its radius). Returns its id
  // or -1. O(highWater) scan — fine at the v1 agent counts (PR-A3 could swap in
  // the force driver's spatial hash for very large populations).
  const pickAgentAt = useCallback((clientX: number, clientY: number): number => {
    const snap = agentsRef.current;
    if (!snap || snap.highWater === 0) return -1;
    const wpt = screenToWorld(clientX, clientY);
    if (!wpt) return -1;
    let best = -1, bestD2 = Infinity;
    const W = gridWidth.current, H = gridHeight.current;
    const torus = boundaryTreatmentRef.current === 'torus';
    // Widen the hit test to a minimum pickable WORLD radius (~4 screen px) so
    // tiny agents stay clickable (inspect/glue/cut) — "nearest within max radius".
    const minPickWorld = 4 / Math.max(0.0001, wpt.scale);
    for (let i = 0; i < snap.highWater; i++) {
      if (!snap.alive[i]) continue;
      let dx = snap.x[i]! - wpt.x, dy = snap.y[i]! - wpt.y;
      if (torus && W > 0 && H > 0) {
        if (dx > W / 2) dx -= W; else if (dx < -W / 2) dx += W;
        if (dy > H / 2) dy -= H; else if (dy < -H / 2) dy += H;
      }
      const d2 = dx * dx + dy * dy;
      const pickR = Math.max(snap.radius[i]!, minPickWorld);
      if (d2 <= pickR * pickR && d2 < bestD2) { bestD2 = d2; best = i; }
    }
    return best;
  }, [screenToWorld]);

  // Post a seed-agents message for a list of world positions. Optional `sets`
  // carries the encoded per-attribute initial values from the seed-config panel
  // (PR3); the worker applies them to each new agent after the engine seed.
  const seedAgentsAt = useCallback((pts: Array<{ x: number; y: number; z?: number; type?: number }>, sets?: Array<{ attrId: string; value: number }>) => {
    const worker = workerRef.current;
    if (!worker || !isAgentModelRef.current || pts.length === 0) return;
    worker.postMessage({ type: 'seedAgents', agents: pts, sets: sets && sets.length > 0 ? sets : undefined, activeViewer: activeViewerRef.current });
  }, []);

  // Bond-Graph Agents — sample N jittered cluster points in a disc of `radius`
  // around `center` (world units), via a sunflower (Vogel) spiral so they don't
  // stack. N = density · π · r² (≥1 inside the disc). Boundary-correct (C-B7):
  // the agent world IS the grid 1:1, so when the model is a torus we wrap each
  // point with ((v%n)+n)%n; for a bounded model we clamp into [0, n) (so a click
  // near the edge still seeds a partial disc rather than spilling out of bounds).
  // NOT brushShapeOffsets — that returns integer CELL offsets; agents need
  // continuous jittered positions.
  const agentSeedPoints = useCallback((center: { x: number; y: number }, radius: number, density: number): Array<{ x: number; y: number }> => {
    const W = gridWidth.current, H = gridHeight.current;
    if (W <= 0 || H <= 0) return [];
    const torus = boundaryTreatmentRef.current === 'torus';
    const r = Math.max(0, radius);
    const n = Math.max(1, Math.round(density * Math.PI * r * r));
    const pts: Array<{ x: number; y: number }> = [];
    const golden = Math.PI * (3 - Math.sqrt(5)); // ~2.39996 rad
    for (let i = 0; i < n; i++) {
      // Sunflower spiral: evenly-distributed radii (sqrt) + golden-angle rotation.
      const rr = n === 1 ? 0 : r * Math.sqrt((i + 0.5) / n);
      const a = i * golden;
      let x = center.x + rr * Math.cos(a);
      let y = center.y + rr * Math.sin(a);
      if (torus) {
        x = ((x % W) + W) % W;
        y = ((y % H) + H) % H;
      } else {
        // Drop points that fall outside the bounded world (a partial disc near
        // an edge), rather than clamping them into a degenerate edge stack.
        if (x < 0 || x >= W || y < 0 || y >= H) continue;
      }
      pts.push({ x, y });
    }
    return pts;
  }, []);

  // Encode the currently-enabled seed-config attributes into the `sets` payload
  // (mirrors flushPaintBatch's Manual Brush branch). Empty when nothing enabled.
  const agentSeedSetsRef = useRef<() => Array<{ attrId: string; value: number }>>(() => []);
  agentSeedSetsRef.current = () => {
    const brush = agentSeedAttrsRef.current;
    const sets: Array<{ attrId: string; value: number }> = [];
    // The seed-config panel edits the AGENT attribute set (a separate id-space from
    // the cell attributes — see the ManualBrushPanel above), so the `sets` MUST be
    // keyed by agent attr ids. Iterating cellAttrsRef here looked up the wrong ids
    // and silently produced no sets (the seeded agents kept their defaults).
    for (const attr of (model.agentAttributes ?? [])) {
      const entry = brush[attr.id];
      if (!entry || !entry.enabled) continue;
      sets.push(...encodeAttrSets(attr, entry.value));
    }
    return sets;
  };

  // Flush whatever seed points have accumulated since the last frame as ONE
  // seedAgents message. Own buffer + token (C-B4); cancel-on-flush so only one
  // rAF is in flight. Called on the rAF boundary by the drag handler and
  // synchronously on pointer-up.
  const flushSeedBatch = useCallback(() => {
    if (pendingSeedRaf.current != null) {
      cancelAnimationFrame(pendingSeedRaf.current);
      pendingSeedRaf.current = null;
    }
    const pts = pendingSeedPoints.current;
    if (pts.length === 0) return;
    pendingSeedPoints.current = [];
    const sets = pendingSeedSets.current ?? undefined;
    pendingSeedSets.current = null;
    seedAgentsAt(pts, sets);
  }, [seedAgentsAt]);

  // Bond-Graph Agents — open the on-demand agent inspector for a picked id and
  // fire the first getAgentState request. The low-Hz poll (effect below) keeps
  // it fresh while pinned.
  const openAgentInspector = useCallback((id: number, clientX: number, clientY: number) => {
    if (id < 0) return;
    // Opens the TRANSIENT sweep popover (a release without re-targeting pins it
    // — commitAgentSweep below). Re-requesting on every re-target keeps the
    // body fresh while the drag moves across agents.
    // The ref is set SYNCHRONOUSLY, not just mirrored at render: a fast click
    // fires mousedown+mouseup within one frame, so commitAgentSweep would read
    // a not-yet-rendered null and silently pin nothing.
    const p = { id, x: clientX, y: clientY };
    agentSweepPopoverRef.current = p;
    setAgentSweepPopover(p);
    workerRef.current?.postMessage({ type: 'getAgentState', id });
  }, []);
  /** Pin the transient sweep popover (release without re-targeting). Offsets a
   *  repeat-pin of the SAME agent so a second popover can't hide the first. */
  const commitAgentSweep = useCallback(() => {
    const sweep = agentSweepPopoverRef.current;   // synchronous — see openAgentInspector
    agentSweepPopoverRef.current = null;
    setAgentSweepPopover(null);
    if (!sweep) return;
    setAgentPopovers(prev => {
      if (prev.some(p => p.id === sweep.id)) return prev;   // already pinned
      return [...prev, sweep];
    });
    setFocusedAgentPopoverId(sweep.id);
  }, []);
  const clearAgentSweep = useCallback(() => { agentSweepPopoverRef.current = null; setAgentSweepPopover(null); }, []);
  const closeAgentPopover = useCallback((id: number) => {
    setAgentPopovers(prev => prev.filter(p => p.id !== id));
    setFocusedAgentPopoverId(f => (f === id ? null : f));
  }, []);
  const closeAllAgentPopovers = useCallback(() => {
    setAgentPopovers([]);
    setAgentSweepPopover(null);
    setFocusedAgentPopoverId(null);
  }, []);

  // Bond-Graph Agents — kill every live agent within the brush radius of a
  // screen point (torus-aware distance). No new worker message: collect the ids
  // from the current render snapshot and post the existing killAgents. Radius 0
  // falls back to the single-nearest pick (pickAgentAt).
  const killAgentsInRadius = useCallback((clientX: number, clientY: number) => {
    const worker = workerRef.current;
    if (!worker || !isAgentModelRef.current) return;
    const radius = agentBrushRadiusRef.current;
    if (radius <= 0) {
      const id = pickAgentAt(clientX, clientY);
      if (id >= 0) worker.postMessage({ type: 'killAgents', ids: [id], activeViewer: activeViewerRef.current });
      return;
    }
    const snap = agentsRef.current;
    if (!snap || snap.highWater === 0) return;
    const wpt = screenToWorld(clientX, clientY);
    if (!wpt) return;
    const W = gridWidth.current, H = gridHeight.current;
    const torus = boundaryTreatmentRef.current === 'torus';
    const r2 = radius * radius;
    const ids: number[] = [];
    for (let i = 0; i < snap.highWater; i++) {
      if (!snap.alive[i]) continue;
      let dx = snap.x[i]! - wpt.x, dy = snap.y[i]! - wpt.y;
      if (torus && W > 0 && H > 0) {
        if (dx > W / 2) dx -= W; else if (dx < -W / 2) dx += W;
        if (dy > H / 2) dy -= H; else if (dy < -H / 2) dy += H;
      }
      if (dx * dx + dy * dy <= r2) ids.push(i);
    }
    if (ids.length > 0) worker.postMessage({ type: 'killAgents', ids, activeViewer: activeViewerRef.current });
  }, [pickAgentAt, screenToWorld]);

  // PR4 — Move brush: flush the latest dragged-agent position as a moveAgents
  // message (own rAF token, C-B4).
  const flushMoveBatch = useCallback(() => {
    if (pendingMoveRaf.current != null) { cancelAnimationFrame(pendingMoveRaf.current); pendingMoveRaf.current = null; }
    const moves = pendingMovesRef.current;
    if (!moves || moves.length === 0) return;
    pendingMovesRef.current = null;
    workerRef.current?.postMessage({ type: 'moveAgents', moves, torus: boundaryTreatmentRef.current === 'torus', activeViewer: activeViewerRef.current });
  }, []);

  // PR4 — Bond-paint: scan the agents within the brush radius of a screen point
  // and queue every adjacent pair within formDistance·contact that isn't already
  // bonded (the engine's auto-bond threshold). Pairs are dedup'd in a Set keyed
  // by the ordered id pair; flushed on pointer-up.
  const scanBondPairsAt = useCallback((clientX: number, clientY: number) => {
    const snap = agentsRef.current;
    if (!snap || snap.highWater === 0) return;
    const wpt = screenToWorld(clientX, clientY);
    if (!wpt) return;
    const W = gridWidth.current, H = gridHeight.current;
    const torus = boundaryTreatmentRef.current === 'torus';
    const cb = model.centerBased;
    const fMul = cbNum(cb, 'formDistance');
    const brushR = agentBrushRadiusRef.current;
    // Existing bonds from the render snapshot (skip re-queueing them).
    const bonded = new Set<string>();
    const bonds = snap.bonds;
    if (bonds) for (let b = 0; b < bonds.length; b += 2) {
      const i = bonds[b]!, j = bonds[b + 1]!;
      bonded.add(i < j ? `${i}:${j}` : `${j}:${i}`);
    }
    const torusDist2 = (i: number, j: number): number => {
      let dx = snap.x[i]! - snap.x[j]!, dy = snap.y[i]! - snap.y[j]!;
      if (torus && W > 0 && H > 0) {
        if (dx > W / 2) dx -= W; else if (dx < -W / 2) dx += W;
        if (dy > H / 2) dy -= H; else if (dy < -H / 2) dy += H;
      }
      return dx * dx + dy * dy;
    };
    // Collect agents under the brush, then queue near pairs among them.
    const under: number[] = [];
    for (let i = 0; i < snap.highWater; i++) {
      if (!snap.alive[i]) continue;
      let dx = snap.x[i]! - wpt.x, dy = snap.y[i]! - wpt.y;
      if (torus && W > 0 && H > 0) {
        if (dx > W / 2) dx -= W; else if (dx < -W / 2) dx += W;
        if (dy > H / 2) dy -= H; else if (dy < -H / 2) dy += H;
      }
      if (dx * dx + dy * dy <= brushR * brushR) under.push(i);
    }
    for (let a = 0; a < under.length; a++) {
      for (let b = a + 1; b < under.length; b++) {
        const i = under[a]!, j = under[b]!;
        const key = i < j ? `${i}:${j}` : `${j}:${i}`;
        if (bonded.has(key) || pendingBondPairs.current.has(key)) continue;
        // Per-pair contact distance = sum of the two radii (mirrors the engine's
        // auto-bond: form within formDistance × contact).
        const thr = fMul * (snap.radius[i]! + snap.radius[j]!);
        if (torusDist2(i, j) <= thr * thr) pendingBondPairs.current.add(key);
      }
    }
  }, [screenToWorld, model.centerBased]);

  const flushBondBatch = useCallback(() => {
    const pairs: Array<[number, number]> = [];
    for (const key of pendingBondPairs.current) {
      const [a, b] = key.split(':').map(Number);
      pairs.push([a!, b!]);
    }
    pendingBondPairs.current.clear();
    if (pairs.length > 0) workerRef.current?.postMessage({ type: 'formBondBatch', pairs, activeViewer: activeViewerRef.current });
  }, []);

  // ------- Agent brush shapes (Add / Remove / Move / Edit footprint) -------
  // The agent world is continuous, so the shape is a world-unit footprint tested
  // GEOMETRICALLY (not the cell stamp the CA-grid brush uses). Same four shapes:
  // rect (W×H, centred), circle (radius), ring (radius ± width/2), line (a
  // two-click capsule of a given width). All torus-aware.
  /** Torus-shortest offset from a footprint centre (cx,cy) to an agent — matches
   *  the engine's wrap so a footprint straddling the seam still catches agents. */
  const agentDelta = useCallback((ax: number, ay: number, cx: number, cy: number): [number, number] => {
    const W = gridWidth.current, H = gridHeight.current;
    let dx = ax - cx, dy = ay - cy;
    if (boundaryTreatmentRef.current === 'torus' && W > 0 && H > 0) {
      if (dx > W / 2) dx -= W; else if (dx < -W / 2) dx += W;
      if (dy > H / 2) dy -= H; else if (dy < -H / 2) dy += H;
    }
    return [dx, dy];
  }, []);
  /** Current agent-shape metrics (bbox half-extents + area for density seeding). */
  const agentShapeMetrics = useCallback(() => {
    const shape = agentBrushShapeRef.current;
    const radius = Math.max(0, agentBrushRadiusRef.current);
    const ringW = Math.max(1, agentBrushRingWidthRef.current);
    const halfW = agentBrushWRef.current / 2, halfH = agentBrushHRef.current / 2;
    let boundW: number, boundH: number, area: number;
    if (shape === 'rect') { boundW = halfW; boundH = halfH; area = agentBrushWRef.current * agentBrushHRef.current; }
    else if (shape === 'ring') { const rout = radius + ringW / 2, rin = Math.max(0, radius - ringW / 2); boundW = boundH = rout; area = Math.PI * (rout * rout - rin * rin); }
    else { boundW = boundH = radius; area = Math.PI * radius * radius; } // circle
    return { shape, radius, ringW, halfW, halfH, boundW, boundH, area };
  }, []);
  type AgentShapeMetrics = ReturnType<typeof agentShapeMetrics>;
  /** Is the offset (dx,dy) from the footprint centre inside the shape? */
  const shapeContains = (m: AgentShapeMetrics, dx: number, dy: number): boolean => {
    if (m.shape === 'rect') return Math.abs(dx) <= m.halfW && Math.abs(dy) <= m.halfH;
    const d = Math.hypot(dx, dy);
    if (m.shape === 'ring') return Math.abs(d - m.radius) <= m.ringW / 2;
    return d <= m.radius; // circle
  };
  /** Live agent ids whose centre falls inside the shape footprint at (cx,cy). */
  const agentsInShapeAt = useCallback((cx: number, cy: number): number[] => {
    const snap = agentsRef.current;
    if (!snap || snap.highWater === 0) return [];
    const m = agentShapeMetrics();
    const ids: number[] = [];
    for (let i = 0; i < snap.highWater; i++) {
      if (!snap.alive[i]) continue;
      const [dx, dy] = agentDelta(snap.x[i]!, snap.y[i]!, cx, cy);
      if (shapeContains(m, dx, dy)) ids.push(i);
    }
    return ids;
  }, [agentShapeMetrics, agentDelta]);
  /** Live agent ids within a plain radius disc of (cx,cy) — the Bond brush's scan
   *  region (Bond ignores the shape; its radius = how far apart two agents can be
   *  and still get auto-bonded). Torus-aware. */
  const agentsInRadiusAt = useCallback((cx: number, cy: number, radius: number): number[] => {
    const snap = agentsRef.current;
    if (!snap || snap.highWater === 0 || radius <= 0) return [];
    const r2 = radius * radius;
    const ids: number[] = [];
    for (let i = 0; i < snap.highWater; i++) {
      if (!snap.alive[i]) continue;
      const [dx, dy] = agentDelta(snap.x[i]!, snap.y[i]!, cx, cy);
      if (dx * dx + dy * dy <= r2) ids.push(i);
    }
    return ids;
  }, [agentDelta]);
  /** Seed points scattered across the shape footprint (density · area). Circle
   *  keeps the even sunflower; rect/ring rejection-sample the bbox. Torus-wrap /
   *  bounded-clip each point. */
  const agentSeedInShape = useCallback((cx: number, cy: number): Array<{ x: number; y: number }> => {
    if (agentBrushShapeRef.current === 'circle') return agentSeedPoints({ x: cx, y: cy }, agentBrushRadiusRef.current, agentSeedDensityRef.current);
    const m = agentShapeMetrics();
    const W = gridWidth.current, H = gridHeight.current;
    const torus = boundaryTreatmentRef.current === 'torus';
    const n = Math.max(1, Math.round(agentSeedDensityRef.current * m.area));
    const pts: Array<{ x: number; y: number }> = [];
    let tries = 0; const maxTries = n * 30 + 50;
    while (pts.length < n && tries++ < maxTries) {
      const dx = (Math.random() * 2 - 1) * m.boundW;
      const dy = (Math.random() * 2 - 1) * m.boundH;
      if (!shapeContains(m, dx, dy)) continue;
      let x = cx + dx, y = cy + dy;
      if (torus && W > 0 && H > 0) { x = ((x % W) + W) % W; y = ((y % H) + H) % H; }
      else if (x < 0 || x >= W || y < 0 || y >= H) continue;
      pts.push({ x, y });
    }
    return pts;
  }, [agentShapeMetrics, agentSeedPoints]);
  /** Line footprint (Add/Remove/Edit, Area): live agent ids within width/2 of the
   *  capsule between two world points (agent folded to the anchor's frame). */
  const agentLineMembers = useCallback((a: { x: number; y: number }, b: { x: number; y: number }): number[] => {
    const snap = agentsRef.current;
    if (!snap || snap.highWater === 0) return [];
    const half = Math.max(0.5, agentBrushLineWidthRef.current / 2);
    const vx = b.x - a.x, vy = b.y - a.y, lenSq = vx * vx + vy * vy;
    const ids: number[] = [];
    for (let i = 0; i < snap.highWater; i++) {
      if (!snap.alive[i]) continue;
      const [dx, dy] = agentDelta(snap.x[i]!, snap.y[i]!, a.x, a.y);
      let d: number;
      if (lenSq === 0) d = Math.hypot(dx, dy);
      else { const t = Math.max(0, Math.min(1, (dx * vx + dy * vy) / lenSq)); d = Math.hypot(dx - t * vx, dy - t * vy); }
      if (d <= half) ids.push(i);
    }
    return ids;
  }, [agentDelta]);
  /** Line footprint (Add, Area): seed points scattered along the capsule. */
  const agentSeedInLine = useCallback((a: { x: number; y: number }, b: { x: number; y: number }): Array<{ x: number; y: number }> => {
    const W = gridWidth.current, H = gridHeight.current, torus = boundaryTreatmentRef.current === 'torus';
    const width = Math.max(1, agentBrushLineWidthRef.current);
    const vx = b.x - a.x, vy = b.y - a.y, len = Math.hypot(vx, vy);
    const n = Math.max(1, Math.round(agentSeedDensityRef.current * (len + 1) * width));
    const half = width / 2, nx = len > 0 ? -vy / len : 0, ny = len > 0 ? vx / len : 0;
    const pts: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < n; i++) {
      const t = Math.random(), p = Math.random() * width - half;
      let x = a.x + vx * t + nx * p, y = a.y + vy * t + ny * p;
      if (torus && W > 0 && H > 0) { x = ((x % W) + W) % W; y = ((y % H) + H) % H; }
      else if (x < 0 || x >= W || y < 0 || y >= H) continue;
      pts.push({ x, y });
    }
    return pts;
  }, []);
  // Build the paintAgents `sets` (attributes) + `geom` (radius / velocity /
  // position) payload from the Edit panel's currently-enabled rows.
  const buildAgentEdit = useCallback((): { sets: Array<{ attrId: string; value: number }>; geom?: { radius?: number; vx?: number; vy?: number; vz?: number; x?: number; y?: number; z?: number } } => {
    const st = agentEditAttrsRef.current;
    const sets: Array<{ attrId: string; value: number }> = [];
    for (const attr of (model.agentAttributes ?? [])) {
      const e = st[attr.id];
      if (e?.enabled) sets.push(...encodeAttrSets(attr, e.value));
    }
    const geom: { radius?: number; vx?: number; vy?: number; vz?: number; x?: number; y?: number; z?: number } = {};
    const num = (id: string): number | undefined => { const e = st[id]; if (!e?.enabled) return undefined; const n = parseFloat(e.value); return Number.isFinite(n) ? n : undefined; };
    const radius = num(GEOM_RADIUS); if (radius !== undefined) geom.radius = radius;
    const vx = num(GEOM_VX); if (vx !== undefined) geom.vx = vx;
    const vy = num(GEOM_VY); if (vy !== undefined) geom.vy = vy;
    const vz = num(GEOM_VZ); if (vz !== undefined) geom.vz = vz;
    const gx = num(GEOM_X); if (gx !== undefined) geom.x = gx;
    const gy = num(GEOM_Y); if (gy !== undefined) geom.y = gy;
    const gz = num(GEOM_Z); if (gz !== undefined) geom.z = gz;
    return { sets, geom: Object.keys(geom).length > 0 ? geom : undefined };
  }, [model.agentAttributes]);
  // Overwrite the chosen properties on the given agent ids (the Edit brush).
  const applyAgentEditToIds = useCallback((ids: number[]) => {
    if (ids.length === 0) return;
    const { sets, geom } = buildAgentEdit();
    if (sets.length === 0 && !geom) return;
    workerRef.current?.postMessage({ type: 'paintAgents', ids, sets, geom, torus: boundaryTreatmentRef.current === 'torus', activeViewer: activeViewerRef.current });
  }, [buildAgentEdit]);

  // ------- 3D agent brush footprint (volumetric membership + seeding) -------
  // Agents float in continuous 3D, so an Area footprint is a SOLID region around
  // the plane-pick cell: circle→sphere, ring→spherical shell, rect→box, line→3D
  // capsule (the "flat vs volumetric" toggle only affects Add placement).
  type Cell3 = { layer: number; row: number; col: number };
  /** Project agent (col=x,row=y,layer=z) into the plane's [freeU, freeV, fixedW]
   *  frame relative to `hit`, torus-folded. */
  const agentProj3d = useCallback((ax: number, ay: number, az: number, hit: Cell3): [number, number, number] => {
    const W = gridWidth.current, H = gridHeight.current, D = gridDepth.current, torus = boundaryTreatmentRef.current === 'torus';
    let dx = ax - hit.col, dy = ay - hit.row, dz = az - hit.layer;
    if (torus) {
      if (dx > W / 2) dx -= W; else if (dx < -W / 2) dx += W;
      if (dy > H / 2) dy -= H; else if (dy < -H / 2) dy += H;
      if (D > 1) { if (dz > D / 2) dz -= D; else if (dz < -D / 2) dz += D; }
    }
    const axis = plane3dRef.current.axis;
    if (axis === 'z') return [dx, dy, dz];   // free col,row  · fixed layer
    if (axis === 'y') return [dx, dz, dy];   // free col,layer · fixed row
    return [dy, dz, dx];                      // x: free row,layer · fixed col
  }, []);
  /** Live agent ids inside the volumetric shape around a plane-pick cell. */
  const agentsInShape3dAt = useCallback((hit: Cell3): number[] => {
    const snap = agentsRef.current;
    if (!snap || snap.highWater === 0) return [];
    const m = agentShapeMetrics();
    const hasZ = snap.z.length > 0;
    const hd = Math.max(m.halfW, m.halfH);
    const ids: number[] = [];
    for (let i = 0; i < snap.highWater; i++) {
      if (!snap.alive[i]) continue;
      const [u, v, w] = agentProj3d(snap.x[i]!, snap.y[i]!, hasZ ? snap.z[i]! : 0, hit);
      let inside: boolean;
      if (m.shape === 'rect') inside = Math.abs(u) <= m.halfW && Math.abs(v) <= m.halfH && Math.abs(w) <= hd;
      else { const d = Math.hypot(u, v, w); inside = m.shape === 'ring' ? Math.abs(d - m.radius) <= m.ringW / 2 : d <= m.radius; }
      if (inside) ids.push(i);
    }
    return ids;
  }, [agentShapeMetrics, agentProj3d]);
  /** Live agent ids within a 3D ball of `radius` around a plane-pick cell — the
   *  Bond brush's scan region (3D sibling of agentsInRadiusAt). Torus-aware via
   *  agentProj3d's shortest-offset fold. */
  const agentsInRadius3dAt = useCallback((hit: Cell3, radius: number): number[] => {
    const snap = agentsRef.current;
    if (!snap || snap.highWater === 0 || radius <= 0) return [];
    const hasZ = snap.z.length > 0, r2 = radius * radius, ids: number[] = [];
    for (let i = 0; i < snap.highWater; i++) {
      if (!snap.alive[i]) continue;
      const [u, v, w] = agentProj3d(snap.x[i]!, snap.y[i]!, hasZ ? snap.z[i]! : 0, hit);
      if (u * u + v * v + w * w <= r2) ids.push(i);
    }
    return ids;
  }, [agentProj3d]);
  /** 3D Bond-brush scan: queue every not-yet-bonded pair of agents within the
   *  scan ball that is close enough to touch (formDistance × summed radii) — the
   *  3D sibling of scanBondPairsAt. Torus-aware; feeds the same pendingBondPairs +
   *  formBondBatch flush. */
  const scanBondPairs3d = useCallback((hit: Cell3) => {
    const snap = agentsRef.current;
    if (!snap || snap.highWater === 0) return;
    const W = gridWidth.current, H = gridHeight.current, D = gridDepth.current;
    const torus = boundaryTreatmentRef.current === 'torus';
    const hasZ = snap.z.length > 0;
    const fMul = formDistanceRef.current;
    const brushR = agentBrushRadiusRef.current;
    const bonded = new Set<string>();
    const bonds = snap.bonds;
    if (bonds) for (let b = 0; b < bonds.length; b += 2) { const i = bonds[b]!, j = bonds[b + 1]!; bonded.add(i < j ? `${i}:${j}` : `${j}:${i}`); }
    const dist2 = (i: number, j: number): number => {
      let dx = snap.x[i]! - snap.x[j]!, dy = snap.y[i]! - snap.y[j]!, dz = (hasZ ? snap.z[i]! : 0) - (hasZ ? snap.z[j]! : 0);
      if (torus) { if (dx > W / 2) dx -= W; else if (dx < -W / 2) dx += W; if (dy > H / 2) dy -= H; else if (dy < -H / 2) dy += H; if (D > 1) { if (dz > D / 2) dz -= D; else if (dz < -D / 2) dz += D; } }
      return dx * dx + dy * dy + dz * dz;
    };
    const under = agentsInRadius3dAt(hit, brushR);
    for (let a = 0; a < under.length; a++) {
      for (let b = a + 1; b < under.length; b++) {
        const i = under[a]!, j = under[b]!, key = i < j ? `${i}:${j}` : `${j}:${i}`;
        if (bonded.has(key) || pendingBondPairs.current.has(key)) continue;
        const thr = fMul * (snap.radius[i]! + snap.radius[j]!);
        if (dist2(i, j) <= thr * thr) pendingBondPairs.current.add(key);
      }
    }
  }, [agentsInRadius3dAt]);
  /** Seed points scattered in the 3D shape around a plane-pick cell. Circle reuses
   *  agentSeedPoints3d (ball / flat disc). Others rejection-sample the plane frame;
   *  the "volumetric" toggle extrudes along the fixed axis (else w=0 → on the plane). */
  const agentSeedInShape3dAt = useCallback((hit: Cell3): Array<{ x: number; y: number; z: number }> => {
    const shape = agentBrushShapeRef.current;
    // The 3D agent brush is ALWAYS a volumetric solid (ball/box/shell through the
    // depth), matching agentsInShape3dAt and the outline cursor — NOT the CA-grid-only
    // "Volumetric Brush" toggle. So Add seeds the same solid the outline previews.
    if (shape === 'circle') return agentSeedPoints3d({ x: hit.col, y: hit.row, z: hit.layer }, agentBrushRadiusRef.current, agentSeedDensityRef.current, true);
    const m = agentShapeMetrics();
    const W = gridWidth.current, H = gridHeight.current, D = gridDepth.current, torus = boundaryTreatmentRef.current === 'torus';
    const axis = plane3dRef.current.axis;
    const hd = Math.max(m.halfW, m.halfH);
    const vol = (m.shape === 'rect' ? (m.halfW * 2) * (m.halfH * 2) : m.area) * (hd * 2 + 1);
    const n = Math.max(1, Math.round(agentSeedDensityRef.current * vol));
    const toWorld = (u: number, v: number, w: number): Cell3 =>
      axis === 'z' ? { col: hit.col + u, row: hit.row + v, layer: hit.layer + w }
        : axis === 'y' ? { col: hit.col + u, row: hit.row + w, layer: hit.layer + v }
          : { col: hit.col + w, row: hit.row + u, layer: hit.layer + v };
    const pts: Array<{ x: number; y: number; z: number }> = [];
    let tries = 0; const maxTries = n * 30 + 50;
    while (pts.length < n && tries++ < maxTries) {
      const u = (Math.random() * 2 - 1) * m.boundW, v = (Math.random() * 2 - 1) * m.boundH, w = (Math.random() * 2 - 1) * hd;
      let inside: boolean;
      if (m.shape === 'rect') inside = Math.abs(u) <= m.halfW && Math.abs(v) <= m.halfH;
      else { const d = Math.hypot(u, v, w); inside = m.shape === 'ring' ? Math.abs(d - m.radius) <= m.ringW / 2 : d <= m.radius; }
      if (!inside) continue;
      let { col, row, layer } = toWorld(u, v, w);
      if (torus) { col = ((col % W) + W) % W; row = ((row % H) + H) % H; if (D > 0) layer = ((layer % D) + D) % D; }
      else if (col < 0 || col >= W || row < 0 || row >= H || layer < 0 || layer >= D) continue;
      pts.push({ x: col, y: row, z: layer });
    }
    return pts;
  }, [agentShapeMetrics, agentSeedPoints3d]);
  /** 3D line capsule: live agent ids within width/2 of the segment a→b (world). */
  const agentLineMembers3d = useCallback((a: Cell3, b: Cell3): number[] => {
    const snap = agentsRef.current;
    if (!snap || snap.highWater === 0) return [];
    const hasZ = snap.z.length > 0;
    const W = gridWidth.current, H = gridHeight.current, D = gridDepth.current, torus = boundaryTreatmentRef.current === 'torus';
    const half = Math.max(0.5, agentBrushLineWidthRef.current / 2);
    const vx = b.col - a.col, vy = b.row - a.row, vz = b.layer - a.layer, lenSq = vx * vx + vy * vy + vz * vz;
    const ids: number[] = [];
    for (let i = 0; i < snap.highWater; i++) {
      if (!snap.alive[i]) continue;
      let ox = snap.x[i]! - a.col, oy = snap.y[i]! - a.row, oz = (hasZ ? snap.z[i]! : 0) - a.layer;
      if (torus) { if (ox > W / 2) ox -= W; else if (ox < -W / 2) ox += W; if (oy > H / 2) oy -= H; else if (oy < -H / 2) oy += H; if (D > 1) { if (oz > D / 2) oz -= D; else if (oz < -D / 2) oz += D; } }
      let d: number;
      if (lenSq === 0) d = Math.hypot(ox, oy, oz);
      else { const t = Math.max(0, Math.min(1, (ox * vx + oy * vy + oz * vz) / lenSq)); d = Math.hypot(ox - t * vx, oy - t * vy, oz - t * vz); }
      if (d <= half) ids.push(i);
    }
    return ids;
  }, []);
  /** 3D line capsule: seed points scattered along the segment a→b. */
  const agentSeedInLine3d = useCallback((a: Cell3, b: Cell3): Array<{ x: number; y: number; z: number }> => {
    const W = gridWidth.current, H = gridHeight.current, D = gridDepth.current, torus = boundaryTreatmentRef.current === 'torus';
    const width = Math.max(1, agentBrushLineWidthRef.current), half = width / 2;
    const vx = b.col - a.col, vy = b.row - a.row, vz = b.layer - a.layer, len = Math.hypot(vx, vy, vz);
    const n = Math.max(1, Math.round(agentSeedDensityRef.current * (len + 1) * width));
    const pts: Array<{ x: number; y: number; z: number }> = [];
    for (let i = 0; i < n; i++) {
      const t = Math.random();
      // random offset within a ball of radius `half` (perpendicular jitter, cheap)
      const ox = (Math.random() * 2 - 1) * half, oy = (Math.random() * 2 - 1) * half, oz = (Math.random() * 2 - 1) * half;
      let col = a.col + vx * t + ox, row = a.row + vy * t + oy, layer = a.layer + vz * t + oz;
      if (torus) { col = ((col % W) + W) % W; row = ((row % H) + H) % H; if (D > 0) layer = ((layer % D) + D) % D; }
      else if (col < 0 || col >= W || row < 0 || row >= H || layer < 0 || layer >= D) continue;
      pts.push({ x: col, y: row, z: layer });
    }
    return pts;
  }, []);

  /** Parse hex color to RGB */
  const hexToRgb = (hex: string) => {
    const n = parseInt(hex.replace('#', ''), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  };

  /** Current brush stamp offsets, cached by the shape/params signature so the
   *  per-mousemove / per-frame consumers don't recompute the disc each call. */
  const stampCacheRef = useRef<{
    key: string;
    offsets: Array<[number, number]>;
    edges?: Array<[number, number, number, number]>;
  } | null>(null);
  const currentStampOffsets = useCallback((): Array<[number, number]> => {
    const shape = brushShapeRef.current;
    const bw = brushWRef.current;
    const bh = brushHRef.current;
    const radius = shape === 'line' ? brushLineWidthRef.current : brushRadiusRef.current;
    const ringW = brushRingWidthRef.current;
    const key = `${shape}|${bw}|${bh}|${radius}|${ringW}`;
    if (stampCacheRef.current?.key !== key) {
      stampCacheRef.current = { key, offsets: brushShapeOffsets(shape, bw, bh, radius, ringW) };
    }
    return stampCacheRef.current.offsets;
  }, []);
  /** 3D Grid CA: the stamp offsets the 3D brush uses. Flat footprint (2-tuples,
   *  dl=0 → on the plane) unless "Extrapolate plane" is on, where it's the
   *  VOLUMETRIC shape (3-tuples). Cached by shape/param key. */
  const stamp3dCacheRef = useRef<{ key: string; offsets: Array<[number, number, number]> } | null>(null);
  const currentStampOffsets3d = useCallback((): ReadonlyArray<readonly number[]> => {
    if (!brush3dVolumeRef.current) return currentStampOffsets();
    const shape = brushShapeRef.current, bw = brushWRef.current, bh = brushHRef.current;
    const radius = shape === 'line' ? brushLineWidthRef.current : brushRadiusRef.current;
    const ringW = brushRingWidthRef.current, boxD = brushBoxDepthRef.current;
    const key = `v|${shape}|${bw}|${bh}|${radius}|${ringW}|${boxD}`;
    if (stamp3dCacheRef.current?.key !== key) {
      stamp3dCacheRef.current = { key, offsets: brushShapeOffsets3d(shape, bw, bh, radius, ringW, boxD) };
    }
    return stamp3dCacheRef.current.offsets;
  }, [currentStampOffsets]);
  /** Cursor-silhouette edges for the current stamp (computed lazily, cached
   *  alongside the offsets — both invalidate on the same param key). */
  const currentStampEdges = useCallback((): Array<[number, number, number, number]> => {
    const offsets = currentStampOffsets();
    const entry = stampCacheRef.current!;
    if (!entry.edges) entry.edges = cellSilhouetteEdges(offsets);
    return entry.edges;
  }, [currentStampOffsets]);

  /** Collect brush-stamp cells around a grid center (no message sent). In
   *  infinity mode, individual cell coords are wrapped modulo grid size so the
   *  worker's paint handler (which drops out-of-bounds row/col) doesn't
   *  silently lose the cells of a stamp that straddles a tile seam. */
  const brushCellsAt = useCallback((row: number, col: number, r: number, g: number, b: number) => {
    const cells: Array<{ row: number; col: number; r: number; g: number; b: number }> = [];
    const infinity = infinityCanvasRef.current && boundaryTreatmentRef.current === 'torus';
    const gw = gridWidth.current;
    const gh = gridHeight.current;
    for (const [dr, dc] of currentStampOffsets()) {
      let cellRow = row + dr;
      let cellCol = col + dc;
      if (infinity && gw > 0 && gh > 0) {
        cellRow = ((cellRow % gh) + gh) % gh;
        cellCol = ((cellCol % gw) + gw) % gw;
      }
      cells.push({ row: cellRow, col: cellCol, r, g, b });
    }
    return cells;
  }, [currentStampOffsets]);

  /** Flush whatever paint cells have accumulated since the last frame. Called
   *  on the rAF boundary by the coalescer below, and synchronously by mouse-up
   *  / unmount paths so the final brush stroke isn't dropped. */
  const flushPaintBatch = useCallback(() => {
    if (pendingPaintRaf.current != null) {
      cancelAnimationFrame(pendingPaintRaf.current);
      pendingPaintRaf.current = null;
    }
    const cells = pendingPaintCells.current;
    const mappingId = pendingPaintMapping.current;
    const viewer = pendingPaintViewer.current;
    if (cells.length === 0 || mappingId == null) return;
    pendingPaintCells.current = [];
    pendingPaintMapping.current = null;
    if (mappingId === MANUAL_BRUSH_MAPPING_ID) {
      // Snapshot the brush state AT FLUSH TIME so mid-drag widget edits land
      // on the second half of the stroke (matches the mid-drag-tab-switch
      // semantics that already exist for the color mapping case).
      const brush = manualBrushRef.current;
      const sets: Array<{ attrId: string; value: number }> = [];
      for (const attr of cellAttrsRef.current) {
        const entry = brush[attr.id];
        if (!entry || !entry.enabled) continue;
        sets.push(...encodeAttrSets(attr, entry.value));
      }
      if (sets.length === 0) return; // nothing enabled — a no-op stroke
      // Carry `layer` (3D Grid CA) so a 3D manual paint hits the right voxel.
      const trimmedCells = cells.map(c => ({ row: c.row, col: c.col, layer: c.layer }));
      workerRef.current?.postMessage({ type: 'paintManual', cells: trimmedCells, sets, activeViewer: viewer });
      return;
    }
    workerRef.current?.postMessage({ type: 'paint', cells, mappingId, activeViewer: viewer });
  }, []);

  // 3D Grid CA: map 2D brush-stamp offsets (dRow,dCol) onto the current brush
  // plane's two FREE grid axes around a centre cell (whose fixed-axis coord is the
  // plane position), torus-wrapping the free axes. The SINGLE source of truth for
  // both the paint stamp (paint3dRef) and the hover-footprint cursor / line
  // preview — so what you see highlighted is exactly what gets painted.
  //   z-plane (layer fixed) → dRow→row, dCol→col (identical to 2D)
  //   y-plane (row fixed)   → dRow→layer, dCol→col
  //   x-plane (col fixed)   → dRow→layer, dCol→row
  const mapStampToPlane = useCallback(
    (center: { layer: number; row: number; col: number }, offsets: ReadonlyArray<readonly number[]>) => {
      const W = gridWidth.current, H = gridHeight.current, Dd = gridDepth.current;
      const axis = plane3dRef.current.axis;
      const torus = boundaryTreatmentRef.current === 'torus';
      const wrap = (v: number, n: number): number => (torus && n > 0 ? ((v % n) + n) % n : v);
      const out: Array<{ layer: number; row: number; col: number }> = [];
      for (const off of offsets) {
        // `dl` (3rd offset, 0 in flat mode) offsets the plane's FIXED axis → a
        // VOLUMETRIC ("extrapolated") brush. dl=0 reproduces the flat footprint.
        const dr = off[0]!, dc = off[1]!, dl = off.length > 2 ? off[2]! : 0;
        if (axis === 'z') out.push({ layer: wrap(center.layer + dl, Dd), row: wrap(center.row + dr, H), col: wrap(center.col + dc, W) });
        else if (axis === 'y') out.push({ layer: wrap(center.layer + dr, Dd), row: wrap(center.row + dl, H), col: wrap(center.col + dc, W) });
        else out.push({ layer: wrap(center.layer + dr, Dd), row: wrap(center.row + dc, H), col: wrap(center.col + dl, W) });
      }
      return out;
    }, []);

  // 3D Grid CA: stamp the current brush shape onto the interaction plane around
  // the picked cell, exactly like the 2D brush stamps around the cursor. The
  // 2D stamp offsets `(dRow, dCol)` map onto the plane's two FREE grid axes (the
  // two that aren't the plane's fixed axis), so a Circle/Ring/Rect footprint
  // lies flat in the slice. A drag interpolates (Bresenham across the two free
  // axes) between successive picks so fast strokes don't leave gaps. Torus
  // models wrap the free axes; bounded models rely on the worker's inBounds3d
  // clip. Mirrors brushCellsAt + paintAt's Bresenham, lifted to 3 axes.
  paint3dRef.current = (hitLayer: number, hitRow: number, hitCol: number) => {
    const axis = plane3dRef.current.axis;
    const { r, g, b } = hexToRgb(brushColorRef.current);
    const offsets = currentStampOffsets3d();
    // mapStampToPlane maps each offset onto the plane's free axes (+ torus wrap).
    // In volumetric ("Extrapolate plane") mode the offsets carry a 3rd `dl` that
    // mapStampToPlane applies to the FIXED axis, so the shape grows into depth.
    const stampAt = (L: number, R: number, C: number): void => {
      for (const c of mapStampToPlane({ layer: L, row: R, col: C }, offsets)) {
        pendingPaintCells.current.push({ row: c.row, col: c.col, layer: c.layer, r, g, b });
      }
    };

    pendingPaintMapping.current = brushMappingRef.current;
    pendingPaintViewer.current = activeViewerRef.current;

    // Free-axis coords of this pick (f1 ← dRow axis, f2 ← dCol axis).
    //   z → (row, col)   y → (layer, col)   x → (layer, row)
    const curF1 = axis === 'z' ? hitRow : hitLayer;
    const curF2 = axis === 'x' ? hitRow : hitCol;
    const toCell = (f1: number, f2: number): [number, number, number] =>
      axis === 'z' ? [plane3dRef.current.pos, f1, f2]
      : axis === 'y' ? [f1, plane3dRef.current.pos, f2]
      : [f1, f2, plane3dRef.current.pos];

    const prev = last3dHitRef.current;
    const prevF: { f1: number; f2: number } | null = prev
      ? (axis === 'z' ? { f1: prev.row, f2: prev.col }
        : axis === 'y' ? { f1: prev.layer, f2: prev.col }
        : { f1: prev.layer, f2: prev.row })
      : null;

    if (prevF && (prevF.f1 !== curF1 || prevF.f2 !== curF2)) {
      // Bresenham across the two free axes; stamp at every intermediate cell.
      let f1 = prevF.f1, f2 = prevF.f2;
      const dAbs1 = Math.abs(curF1 - f1), dAbs2 = Math.abs(curF2 - f2);
      const s1 = curF1 >= f1 ? 1 : -1, s2 = curF2 >= f2 ? 1 : -1;
      let err = dAbs1 - dAbs2;
      // Skip the starting cell (already stamped on the previous call); include the end.
      for (;;) {
        const e2 = 2 * err;
        if (e2 > -dAbs2) { err -= dAbs2; f1 += s1; }
        if (e2 < dAbs1) { err += dAbs1; f2 += s2; }
        const [L, R, C] = toCell(f1, f2);
        stampAt(L, R, C);
        if (f1 === curF1 && f2 === curF2) break;
      }
    } else {
      const [L, R, C] = toCell(curF1, curF2);
      stampAt(L, R, C);
    }

    last3dHitRef.current = { layer: hitLayer, row: hitRow, col: hitCol };
    // Coalesce to one worker round-trip per frame (matches the 2D paintAt path):
    // pointermove fires far faster than the frame rate, and each stamp can be
    // hundreds of cells, so flushing synchronously per move floods the worker.
    // onUp forces a final synchronous flush so the last partial stroke lands.
    if (pendingPaintRaf.current == null) {
      pendingPaintRaf.current = requestAnimationFrame(flushPaintBatch);
    }
  };

  /** Paint with Bresenham interpolation from last painted position to current.
   *  In infinity (torus tiling) mode, the line walks the SHORTER wrap path: the
   *  signed delta is folded into [-range/2, range/2] so dragging across a seam
   *  paints a few cells via the wrap, not a long line across the bounded grid. */
  const paintAt = useCallback((clientX: number, clientY: number) => {
    const center = screenToGrid(clientX, clientY);
    if (!center) return;
    const { r, g, b } = hexToRgb(brushColorRef.current);
    let allCells: Array<{ row: number; col: number; r: number; g: number; b: number }> = [];
    const prev = lastPaintGrid.current;
    if (prev && (prev.row !== center.row || prev.col !== center.col)) {
      const gw = gridWidth.current;
      const gh = gridHeight.current;
      const infinity = infinityCanvasRef.current && boundaryTreatmentRef.current === 'torus';
      let r0 = prev.row, c0 = prev.col;
      // Signed delta in cells. Without wrapping, a drag across the seam (e.g.
      // col 98 -> col 1) would compute a -97 delta and paint the long way; the
      // torus-shortest fold below collapses that to +3.
      let signedDR = center.row - r0;
      let signedDC = center.col - c0;
      if (infinity) {
        if (signedDR > gh / 2) signedDR -= gh;
        else if (signedDR < -gh / 2) signedDR += gh;
        if (signedDC > gw / 2) signedDC -= gw;
        else if (signedDC < -gw / 2) signedDC += gw;
      }
      const dr = Math.abs(signedDR), dc = Math.abs(signedDC);
      const sr = signedDR >= 0 ? 1 : -1, sc = signedDC >= 0 ? 1 : -1;
      let err = dc - dr;
      let stepsR = dr, stepsC = dc;
      // Bresenham — walks until both axis step counts are exhausted. Mod each
      // emitted (r0, c0) to grid range in infinity mode so the cells we push are
      // the wrapped cells the worker expects.
      while (stepsR > 0 || stepsC > 0) {
        const e2 = 2 * err;
        if (e2 > -dr && stepsC > 0) { err -= dr; c0 += sc; stepsC--; }
        if (e2 < dc && stepsR > 0) { err += dc; r0 += sr; stepsR--; }
        let cellR = r0, cellC = c0;
        if (infinity) {
          cellR = ((cellR % gh) + gh) % gh;
          cellC = ((cellC % gw) + gw) % gw;
        }
        allCells = allCells.concat(brushCellsAt(cellR, cellC, r, g, b));
      }
    } else {
      allCells = brushCellsAt(center.row, center.col, r, g, b);
    }
    lastPaintGrid.current = center;
    if (allCells.length === 0) return;
    const curMapping = brushMappingRef.current;
    const curViewer = activeViewerRef.current;
    // If the user changed brush mapping or active viewer mid-drag (rare), the
    // pending batch belongs to the previous target — flush before enqueuing the
    // new cells so they don't get sent to the wrong handler.
    if (
      pendingPaintMapping.current !== null &&
      (pendingPaintMapping.current !== curMapping || pendingPaintViewer.current !== curViewer)
    ) {
      flushPaintBatch();
    }
    pendingPaintMapping.current = curMapping;
    pendingPaintViewer.current = curViewer;
    for (let i = 0; i < allCells.length; i++) pendingPaintCells.current.push(allCells[i]!);
    if (pendingPaintRaf.current == null) {
      pendingPaintRaf.current = requestAnimationFrame(flushPaintBatch);
    }
  }, [screenToGrid, brushCellsAt, flushPaintBatch]);

  /** Commit a Line-tool stroke: cells of a brushLineWidth-thick segment from
   *  `from` to `to` (torus-shortest path in infinity mode), painted in one
   *  batch through the same pending-paint pipeline as drag strokes (so the
   *  Manual Brush branch and mapping/viewer bookkeeping apply unchanged). */
  const paintLine = useCallback((from: { row: number; col: number }, to: { row: number; col: number }) => {
    const { r, g, b } = hexToRgb(brushColorRef.current);
    const infinity = infinityCanvasRef.current && boundaryTreatmentRef.current === 'torus';
    const gw = gridWidth.current;
    const gh = gridHeight.current;
    let end = to;
    if (infinity && gw > 0 && gh > 0) {
      // Fold the delta to the torus-shortest path (mirrors paintAt's drag fold).
      let dR = to.row - from.row;
      let dC = to.col - from.col;
      if (dR > gh / 2) dR -= gh; else if (dR < -gh / 2) dR += gh;
      if (dC > gw / 2) dC -= gw; else if (dC < -gw / 2) dC += gw;
      end = { row: from.row + dR, col: from.col + dC };
    }
    const raw = lineStampCells(from, end, brushLineWidthRef.current);
    const cells = raw.map(c => {
      let { row, col } = c;
      if (infinity && gw > 0 && gh > 0) {
        row = ((row % gh) + gh) % gh;
        col = ((col % gw) + gw) % gw;
      }
      return { row, col, r, g, b };
    });
    if (cells.length === 0) return;
    const curMapping = brushMappingRef.current;
    const curViewer = activeViewerRef.current;
    if (
      pendingPaintMapping.current !== null &&
      (pendingPaintMapping.current !== curMapping || pendingPaintViewer.current !== curViewer)
    ) {
      flushPaintBatch();
    }
    pendingPaintMapping.current = curMapping;
    pendingPaintViewer.current = curViewer;
    for (let i = 0; i < cells.length; i++) pendingPaintCells.current.push(cells[i]!);
    flushPaintBatch();
  }, [flushPaintBatch]);

  // Zoom/Pan/Brush event handlers
  useEffect(() => {
    const container = canvasRef.current?.parentElement;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest('[data-sim-overlay]')) return;
      e.preventDefault();
      // Alt+wheel cycles the agent brush mode (add → remove → move → …) when the
      // brush targets agents — a fast keyboard-free way to switch actions.
      if (e.altKey && isAgentModelRef.current && brushTargetRef.current === 'agents') {
        const modes = AGENT_BRUSH_MODES, i = modes.indexOf(agentBrushModeRef.current);
        setAgentBrushMode(modes[(((i < 0 ? 0 : i) + (e.deltaY > 0 ? 1 : -1)) + modes.length) % modes.length]!);
        agentGlueAnchorRef.current = -1; agentLineAnchorRef.current = null; agentLine3dAnchorRef.current = null;
        draw();
        return;
      }
      // Ctrl+wheel = cycle through Input Mappings (for quick brush behavior switching)
      // Manual Brush participates in the cycle as the rightmost entry, so it's
      // always reachable even when the model has zero color-input mappings.
      if (e.ctrlKey) {
        const inputs = [
          ...mappingsRef.current.filter(m => !m.isAttributeToColor).map(m => m.id),
          MANUAL_BRUSH_MAPPING_ID,
        ];
        if (inputs.length === 0) return;
        const curIdx = inputs.findIndex(id => id === brushMappingRef.current);
        const base = curIdx < 0 ? 0 : curIdx;
        const nextIdx = (base + (e.deltaY > 0 ? 1 : -1) + inputs.length) % inputs.length;
        setBrushMapping(inputs[nextIdx]!);
        return;
      }
      const zoomFactor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const oldZoom = zoomRef.current;
      const newZoom = Math.max(0.1, Math.min(50, oldZoom * zoomFactor));
      const rect = container.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      panRef.current = {
        x: panRef.current.x - (mx - cx - panRef.current.x) * (newZoom / oldZoom - 1),
        y: panRef.current.y - (my - cy - panRef.current.y) * (newZoom / oldZoom - 1),
      };
      zoomRef.current = newZoom;
      draw();
    };

    const isResizingBrush = { active: false, agent: false, startX: 0, startY: 0, startW: 0, startH: 0, startRadius: 0, startRingW: 0, startLineW: 0 };
    let canvasBrushActive = false; // true only when LMB started on canvas, not overlay

    // Middle-click autoscroll: rAF loop pans by (cursor - origin) each frame.
    // Speed scales with distance; below the deadzone the pointer is treated as
    // resting (no pan). Stops on any non-middle-button click, second middle
    // click, Escape, or unmount.
    const AUTOSCROLL_DEADZONE = 12;
    const AUTOSCROLL_DAMP = 12;
    const tickAutoscroll = () => {
      autoscrollRafRef.current = null;
      const origin = autoscrollOriginRef.current;
      const cur = autoscrollCursorRef.current;
      if (!origin) return;
      if (cur) {
        const dx = cur.x - origin.x;
        const dy = cur.y - origin.y;
        const dist = Math.hypot(dx, dy);
        if (dist > AUTOSCROLL_DEADZONE) {
          const speed = (dist - AUTOSCROLL_DEADZONE) / AUTOSCROLL_DAMP;
          const factor = speed / dist;
          panRef.current = {
            x: panRef.current.x - dx * factor,
            y: panRef.current.y - dy * factor,
          };
        }
      }
      draw();
      autoscrollRafRef.current = requestAnimationFrame(tickAutoscroll);
    };
    const stopAutoscroll = () => {
      if (autoscrollOriginRef.current == null) return;
      autoscrollOriginRef.current = null;
      autoscrollCursorRef.current = null;
      if (autoscrollRafRef.current != null) {
        cancelAnimationFrame(autoscrollRafRef.current);
        autoscrollRafRef.current = null;
      }
      container.style.cursor = '';
      draw();
    };
    const startAutoscroll = (clientX: number, clientY: number) => {
      const rect = container.getBoundingClientRect();
      const cx = clientX - rect.left;
      const cy = clientY - rect.top;
      cancelFollow();  // middle-click autoscroll is a manual pan — see FOLLOW MODE
      autoscrollOriginRef.current = { x: cx, y: cy };
      autoscrollCursorRef.current = { x: cx, y: cy };
      container.style.cursor = 'all-scroll';
      if (autoscrollRafRef.current == null) {
        autoscrollRafRef.current = requestAnimationFrame(tickAutoscroll);
      }
    };

    const handleMouseDown = (e: MouseEvent) => {
      // Ignore events from overlay controls (transport bar, viewer bar, etc.)
      const target = e.target as HTMLElement;
      if (target.closest('[data-sim-overlay]')) { canvasBrushActive = false; canvasAgentBrushActive.current = false; return; }

      // Clicking the main canvas area returns keyboard focus to the document so the
      // transport shortcuts (Enter=play/pause, Space=step, Esc=reset, …) work after
      // the user interacts with a right-panel widget. GENERAL BY DESIGN — it blurs
      // WHATEVER form control is focused (NumberField / checkbox / colour / select),
      // so any Agent-Brush / Layers / Background widget we add later is covered with
      // no extra wiring. (The cell-paint path used to rely on the browser's natural
      // blur-on-mousedown, but the agent-brush path e.preventDefault()s — which
      // suppresses that blur — so this explicit blur is required; mirrors the 3D
      // gl-canvas onDown.) Do NOT preventDefault here (that would re-suppress it).
      const focused = document.activeElement as HTMLElement | null;
      if (focused && (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA' || focused.tagName === 'SELECT' || focused.isContentEditable)) focused.blur();

      // Middle-click toggles autoscroll mode. Any other button while autoscroll
      // is active just exits and consumes the click — matches browser autoscroll
      // semantics (Firefox / Chromium).
      if (e.button === 1) {
        e.preventDefault();
        if (autoscrollOriginRef.current) stopAutoscroll();
        else startAutoscroll(e.clientX, e.clientY);
        return;
      }
      if (autoscrollOriginRef.current) {
        e.preventDefault();
        stopAutoscroll();
        return;
      }

      if (e.button === 0 && (e.shiftKey || inspectModeRef.current) && !e.ctrlKey && !e.altKey && !e.metaKey) {
        // Shift+LMB (or the toolbar Inspect toggle) = start a cell-inspector
        // sweep. A plain click (release on
        // the same cell as press, no drag) commits via mouseup → pins a popover
        // (today's behavior). Dragging to a different cell recycles a single
        // transient popover and discards it on release — quick-peek across a
        // region without accumulating popovers.
        e.preventDefault();
        // Bond-Graph Agents — Shift+LMB over an agent opens the AGENT inspector
        // (claimed INSIDE this branch, before the cell sweep — C-B2). Falls
        // through to the cell sweep when no agent is under the cursor.
        if (isAgentModelRef.current) {
          const aid = pickAgentAt(e.clientX, e.clientY);
          if (aid >= 0) {
            // AGENT sweep: open immediately (the popover doubles as the drag's
            // transient) and arm the sweep — the drag re-targets it, release
            // without a drag keeps it pinned, release after a drag discards
            // (mirrors the cell sweep's !moved rule).
            openAgentInspector(aid, e.clientX, e.clientY);
            agentSweepActiveRef.current = true;
            agentSweepMovedRef.current = false;
            agentSweepStartIdRef.current = aid;
            agentSweepAnchorRef.current = { x: e.clientX, y: e.clientY };
            return;
          }
        }
        const cell = screenToGrid(e.clientX, e.clientY);
        // Guard against the brief window where the canvas hasn't been laid out
        // (parent rect 0×0 → scale 0 → NaN row/col). `!cell` only catches the
        // out-of-bounds null return — a finite check is needed for the rest.
        if (!cell || !Number.isFinite(cell.row) || !Number.isFinite(cell.col)) return;
        const w = gridWidth.current;
        if (w <= 0) return;
        const idx = cell.row * w + cell.col;
        const inspector: InspectPopoverState = { cellIdx: idx, row: cell.row, col: cell.col, x: e.clientX, y: e.clientY };
        sweepActiveRef.current = true;
        sweepStartCellRef.current = idx;
        sweepMovedRef.current = false;
        sweepInspectorRef.current = inspector;
        setSweepInspector(inspector);
        return;
      }

      // Bond-Graph Agents — the agent brush. Plain LMB on the canvas performs the
      // selected mode when the brush targets agents; brushTarget==='grid' falls
      // through to the normal cell brush. Shift+LMB inspects, Ctrl+LMB resizes
      // (checked below), so the agent brush takes a plain, unmodified left click.
      if (e.button === 0 && !e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey
          && isAgentModelRef.current && brushTargetRef.current === 'agents') {
        e.preventDefault();
        const worker = workerRef.current;
        const mode = agentBrushModeRef.current;
        const shape = agentBrushShapeRef.current;
        // Line + Move can't express a rigid drag → single-agent move regardless.
        const scope = (mode === 'move' && shape === 'line') ? 'single' : agentBrushScopeRef.current;
        // LINE shape (Area scope) is a two-click region tool for Add/Remove/Edit:
        // first click stages the anchor (no action), second acts on the capsule.
        if (shape === 'line' && scope === 'area' && (mode === 'add' || mode === 'remove' || mode === 'edit')) {
          const wpt = screenToWorld(e.clientX, e.clientY);
          if (!wpt) return;
          if (!agentLineAnchorRef.current) { agentLineAnchorRef.current = { x: wpt.x, y: wpt.y }; draw(); return; }
          const a = agentLineAnchorRef.current; agentLineAnchorRef.current = null;
          const b = { x: wpt.x, y: wpt.y };
          if (mode === 'add') seedAgentsAt(agentSeedInLine(a, b), agentSeedSetsRef.current());
          else if (mode === 'remove') { const ids = agentLineMembers(a, b); if (ids.length && worker) worker.postMessage({ type: 'killAgents', ids, activeViewer: activeViewerRef.current }); }
          else if (mode === 'edit') applyAgentEditToIds(agentLineMembers(a, b));
          draw();
          return;
        }
        if (mode === 'add') {
          const wpt = screenToWorld(e.clientX, e.clientY);
          if (wpt) {
            const pts = scope === 'single' ? [{ x: wpt.x, y: wpt.y }] : agentSeedInShape(wpt.x, wpt.y);
            // Enqueue into the drag buffer (so a click that becomes a drag keeps
            // accumulating into the same batch) and arm the rAF flush.
            pendingSeedSets.current = agentSeedSetsRef.current();
            for (const p of pts) pendingSeedPoints.current.push(p);
            if (pendingSeedRaf.current == null) pendingSeedRaf.current = requestAnimationFrame(flushSeedBatch);
            canvasAgentBrushActive.current = true;
            lastSeedWorldRef.current = { x: wpt.x, y: wpt.y };
          }
        } else if (mode === 'remove') {
          if (scope === 'single') { const id = pickAgentAt(e.clientX, e.clientY); if (id >= 0 && worker) worker.postMessage({ type: 'killAgents', ids: [id], activeViewer: activeViewerRef.current }); }
          else { const wpt = screenToWorld(e.clientX, e.clientY); if (wpt) { const ids = agentsInShapeAt(wpt.x, wpt.y); if (ids.length && worker) worker.postMessage({ type: 'killAgents', ids, activeViewer: activeViewerRef.current }); } }
          canvasAgentBrushActive.current = true;
        } else if (mode === 'edit') {
          if (scope === 'single') {
            // Pick the target agent, prefill the Edit panel from its live state
            // (getAgentState → decode); the Apply button then writes to it.
            const id = pickAgentAt(e.clientX, e.clientY);
            if (id >= 0) { editTargetIdRef.current = id; setEditTargetId(id); editPrefillIdRef.current = id; worker?.postMessage({ type: 'getAgentState', id }); draw(); }
          } else {
            const wpt = screenToWorld(e.clientX, e.clientY);
            if (wpt) applyAgentEditToIds(agentsInShapeAt(wpt.x, wpt.y));
            canvasAgentBrushActive.current = true;
          }
        } else if (mode === 'glue' || mode === 'cut') {
          const id = pickAgentAt(e.clientX, e.clientY);
          if (id < 0) { agentGlueAnchorRef.current = -1; draw(); return; }
          if (agentGlueAnchorRef.current < 0) {
            agentGlueAnchorRef.current = id; // stage the first agent
          } else if (agentGlueAnchorRef.current !== id && worker) {
            worker.postMessage({ type: mode === 'glue' ? 'formBond' : 'breakBond', a: agentGlueAnchorRef.current, b: id, activeViewer: activeViewerRef.current });
            agentGlueAnchorRef.current = -1;
          }
          draw();
        } else if (mode === 'move') {
          if (scope === 'area') {
            // Rigid group drag: grab every agent in the footprint + the grab point,
            // so the drag translates them all by one delta.
            const wpt = screenToWorld(e.clientX, e.clientY);
            const snap = agentsRef.current;
            if (wpt && snap) {
              const ids = agentsInShapeAt(wpt.x, wpt.y);
              if (ids.length) {
                agentGroupMoveRef.current = { members: ids.map(id => ({ id, sx: snap.x[id]!, sy: snap.y[id]!, sz: 0 })), downX: wpt.x, downY: wpt.y, downZ: 0 };
                canvasAgentBrushActive.current = true;
              }
            }
          } else {
            // Pick one agent to drag; snapshot its pre-drag pos for the RMB revert.
            const id = pickAgentAt(e.clientX, e.clientY);
            if (id >= 0) {
              const snap = agentsRef.current;
              draggingAgentRef.current = id;
              draggingAgentStartRef.current = snap ? { x: snap.x[id]!, y: snap.y[id]! } : null;
              canvasAgentBrushActive.current = true;
            }
          }
        } else if (mode === 'bond') {
          // Bond-paint: start a stroke; pairs are scanned + queued on drag, flushed
          // on pointer-up.
          pendingBondPairs.current.clear();
          canvasAgentBrushActive.current = true;
          scanBondPairsAt(e.clientX, e.clientY);
        }
        return;
      }
      // RMB / Escape cancels a staged glue/cut or line anchor OR a Move drag (revert).
      if (isAgentModelRef.current && (e.button === 2)) {
        if (agentGroupMoveRef.current) {
          if (pendingMoveRaf.current != null) { cancelAnimationFrame(pendingMoveRaf.current); pendingMoveRaf.current = null; }
          pendingMovesRef.current = null;
          const g = agentGroupMoveRef.current; agentGroupMoveRef.current = null;
          workerRef.current?.postMessage({ type: 'moveAgents', moves: g.members.map(mm => ({ id: mm.id, x: mm.sx, y: mm.sy })), torus: boundaryTreatmentRef.current === 'torus', activeViewer: activeViewerRef.current });
          canvasAgentBrushActive.current = false;
          e.preventDefault();
        } else if (draggingAgentRef.current >= 0) {
          if (pendingMoveRaf.current != null) { cancelAnimationFrame(pendingMoveRaf.current); pendingMoveRaf.current = null; }
          pendingMovesRef.current = null;
          const id = draggingAgentRef.current, start = draggingAgentStartRef.current;
          if (start) workerRef.current?.postMessage({ type: 'moveAgents', moves: [{ id, x: start.x, y: start.y }], torus: boundaryTreatmentRef.current === 'torus', activeViewer: activeViewerRef.current });
          draggingAgentRef.current = -1; draggingAgentStartRef.current = null;
          canvasAgentBrushActive.current = false;
          e.preventDefault();
        } else if (agentLineAnchorRef.current) {
          agentLineAnchorRef.current = null; draw(); e.preventDefault();
        } else if (agentGlueAnchorRef.current >= 0) {
          agentGlueAnchorRef.current = -1; draw();
        }
      }

      if (e.button === 0 && e.ctrlKey) {
        // Ctrl+LMB = resize brush. Targets the AGENT shape when the brush affects
        // agents (else it silently resized the hidden CA-grid brush), the CA-grid
        // shape otherwise. Same per-shape math, different source/target refs.
        e.preventDefault();
        const rzAgent = isAgentModelRef.current && brushTargetRef.current === 'agents';
        isResizingBrush.active = true;
        isResizingBrush.agent = rzAgent;
        isResizingBrush.startX = e.clientX;
        isResizingBrush.startY = e.clientY;
        isResizingBrush.startW = rzAgent ? agentBrushWRef.current : brushWRef.current;
        isResizingBrush.startH = rzAgent ? agentBrushHRef.current : brushHRef.current;
        isResizingBrush.startRadius = rzAgent ? agentBrushRadiusRef.current : brushRadiusRef.current;
        isResizingBrush.startRingW = rzAgent ? agentBrushRingWidthRef.current : brushRingWidthRef.current;
        isResizingBrush.startLineW = rzAgent ? agentBrushLineWidthRef.current : brushLineWidthRef.current;
        container.style.cursor = 'nwse-resize';
      } else if (e.button === 0 && brushShapeRef.current === 'line') {
        // Line tool: two clicks define the segment. First click stages the
        // anchor (no paint); second click commits the whole line in one batch.
        // No drag-painting in this mode.
        const cell = screenToGrid(e.clientX, e.clientY);
        if (!cell || !Number.isFinite(cell.row) || !Number.isFinite(cell.col)) return;
        if (!lineAnchorRef.current) {
          lineAnchorRef.current = cell;
        } else {
          paintLine(lineAnchorRef.current, cell);
          lineAnchorRef.current = null;
        }
        draw();
      } else if (e.button === 0) {
        // LMB = brush — set initial paint position for Bresenham interpolation
        canvasBrushActive = true;
        lastPaintGrid.current = null; // first paint call sets it
        paintAt(e.clientX, e.clientY);
      } else if (e.button === 2 && lineAnchorRef.current) {
        // RMB with a staged Line anchor = cancel the line (consumes the press —
        // mirrors the neighborhood editor's right-click staging cancel).
        e.preventDefault();
        lineAnchorRef.current = null;
        draw();
      } else if (e.button === 2 && (e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) && brushMappingRef.current !== MANUAL_BRUSH_MAPPING_ID) {
        // Modifier+RMB = open the in-page brush color popover at the cursor.
        // Any modifier is accepted (Ctrl, Shift, Alt, Meta) because plain Ctrl+RMB
        // gets swallowed on some Windows/Chrome combos (observed on ABNT2/Brazilian
        // layouts where AltGr=Ctrl+Alt works but Ctrl alone does not). Shift+RMB,
        // Alt+RMB, Ctrl+Shift+RMB all work too. Suppressed when Manual Brush is
        // active — Manual has no color picker, so falling through to RMB pan is
        // the natural behaviour.
        e.preventDefault();
        setColorPopover({ x: e.clientX, y: e.clientY });
      } else if (e.button === 2) {
        // RMB = pan
        e.preventDefault();
        isPanning.current = true;
        cancelFollow();  // the user took the wheel — see FOLLOW MODE
        lastMouse.current = { x: e.clientX, y: e.clientY };
        container.style.cursor = 'grabbing';
      }
    };

    // Idle hover tracking (cursor cell + hover-coords chip + agent hover /
    // area-highlight scans) — COALESCED to at most one run per animation frame.
    // A 125–1000 Hz mouse used to run O(agents) scans + a React state update
    // per RAW event, competing with the step→draw pipeline while playing (the
    // "moving the brush cursor slows the simulation" bug). The raw mousemove
    // handler now only records the pointer + runs the active-drag actions.
    const processHoverWork = () => {
      hoverWorkRaf.current = null;
      const { x: hx, y: hy, buttons } = lastHoverClient.current;
      // The brush cursor + chip stop tracking once the pointer leaves the canvas
      // area (in infinity mode screenToGrid WRAPS off-canvas coords instead of
      // returning null). Active drags legitimately continue off-canvas.
      if (!isPanning.current && !(buttons & 1) && !isResizingBrush.active) {
        const rect = container.getBoundingClientRect();
        const overCanvas = hx >= rect.left && hx < rect.right
          && hy >= rect.top && hy < rect.bottom;
        if (!overCanvas) {
          let changed = cursorGrid.current !== null;
          if (cursorGrid.current !== null) { cursorGrid.current = null; publishHoverCellInfo(null); }
          if (agentCursorWorldRef.current !== null) { agentCursorWorldRef.current = null; changed = true; }
          if (agentHoverIdRef.current !== -1) { agentHoverIdRef.current = -1; changed = true; }
          if (agentAreaHoverIdsRef.current.length) { agentAreaHoverIdsRef.current = []; changed = true; }
          if (changed) drawCursorLayer();
          return;
        }
      }
      // Cursor cell + the hover-coords chip (external store — the chip updates
      // without re-rendering this component).
      const gridPos = screenToGrid(hx, hy);
      cursorGrid.current = gridPos;
      if (gridPos) {
        let minDr = 0, maxDr = 0, minDc = 0, maxDc = 0;
        for (const [dr, dc] of currentStampOffsets()) {
          if (dr < minDr) minDr = dr;
          if (dr > maxDr) maxDr = dr;
          if (dc < minDc) minDc = dc;
          if (dc > maxDc) maxDc = dc;
        }
        publishHoverCellInfo({
          col: gridPos.col, row: gridPos.row,
          x0: gridPos.col + minDc, y0: gridPos.row + minDr,
          x1: gridPos.col + maxDc, y1: gridPos.row + maxDr,
        });
      } else {
        publishHoverCellInfo(null);
      }
      // Bond-Graph Agents — cursor world point, area-affected highlight and the
      // hovered-agent pick (O(agents) scans — safe at ≤1/frame here).
      if (isAgentModelRef.current && brushTargetRef.current === 'agents') {
        const mode = agentBrushModeRef.current;
        const shape = agentBrushShapeRef.current;
        const scope = (mode === 'move' && shape === 'line') ? 'single' : agentBrushScopeRef.current;
        const dragging = canvasAgentBrushActive.current && (buttons & 1) !== 0;
        const wpt = screenToWorld(hx, hy);
        agentCursorWorldRef.current = wpt ? { x: wpt.x, y: wpt.y } : null;
        // Area-affected highlight — the agents the stroke WILL touch (Remove/Move/
        // Edit; NOT Add, which only spawns new agents). During a group-move drag
        // it's the grabbed group; otherwise the agents under the footprint.
        if (scope === 'area' && (mode === 'remove' || mode === 'move' || mode === 'edit')) {
          agentAreaHoverIdsRef.current = (mode === 'move' && agentGroupMoveRef.current)
            ? agentGroupMoveRef.current.members.map(m => m.id)
            : (wpt ? agentsInShapeAt(wpt.x, wpt.y) : []);
        } else if (mode === 'bond') {
          // Bond scans a plain radius disc (not the shape) for near pairs.
          agentAreaHoverIdsRef.current = wpt ? agentsInRadiusAt(wpt.x, wpt.y, agentBrushRadiusRef.current) : [];
        } else if (agentAreaHoverIdsRef.current.length) {
          agentAreaHoverIdsRef.current = [];
        }
        const wantHover = mode === 'glue' || mode === 'cut'
          || (scope === 'single' && (mode === 'remove' || mode === 'move' || mode === 'edit'));
        if (!dragging) agentHoverIdRef.current = wantHover ? pickAgentAt(hx, hy) : -1;
      }
      // Cursor-layer-only redraw — never touches the scene canvas.
      drawCursorLayer();
    };
    const scheduleHoverWork = () => {
      if (hoverWorkRaf.current != null) return;
      hoverWorkRaf.current = requestAnimationFrame(processHoverWork);
    };

    const handleMouseMove = (e: MouseEvent) => {
      // 3D: the 2D screenToGrid mapping is meaningless (it reads the inert 2D
      // zoom/pan over the hidden 2D canvas but "succeeds" because both canvases
      // share the container) — driving cursorGrid / the hover-coords chip from
      // it showed garbage cell coordinates and armed 2D-only interactions. The
      // 3D pointer effect owns all hover state there.
      if (is3dRef.current) {
        if (cursorGrid.current !== null) {
          cursorGrid.current = null;
          publishHoverCellInfo(null);
        }
        return;
      }
      // Autoscroll active: just track cursor + redraw to update the indicator's
      // direction line. The actual pan happens in tickAutoscroll's rAF loop so
      // we keep moving even when the cursor sits still.
      if (autoscrollOriginRef.current) {
        const rect = container.getBoundingClientRect();
        autoscrollCursorRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        return;
      }

      // Record the pointer + coalesce ALL idle hover work to one rAF per frame.
      lastHoverClient.current.x = e.clientX;
      lastHoverClient.current.y = e.clientY;
      lastHoverClient.current.buttons = e.buttons;
      scheduleHoverWork();

      // Agent-brush DRAG actions (LMB held) — these stay raw (each already
      // batches its worker round-trips via its own rAF flusher).
      if (isAgentModelRef.current && brushTargetRef.current === 'agents') {
        const mode = agentBrushModeRef.current;
        const shape = agentBrushShapeRef.current;
        const scope = (mode === 'move' && shape === 'line') ? 'single' : agentBrushScopeRef.current;
        const dragging = canvasAgentBrushActive.current && (e.buttons & 1);
        // Drags while the agent brush is active (LMB held).
        if (dragging) {
          const worker = workerRef.current;
          if (mode === 'remove') {
            if (scope === 'single') { const id = pickAgentAt(e.clientX, e.clientY); if (id >= 0 && worker) worker.postMessage({ type: 'killAgents', ids: [id], activeViewer: activeViewerRef.current }); }
            else { const wpt = screenToWorld(e.clientX, e.clientY); if (wpt) { const ids = agentsInShapeAt(wpt.x, wpt.y); if (ids.length && worker) worker.postMessage({ type: 'killAgents', ids, activeViewer: activeViewerRef.current }); } }
          } else if (mode === 'edit' && scope === 'area') {
            const wpt = screenToWorld(e.clientX, e.clientY);
            if (wpt) applyAgentEditToIds(agentsInShapeAt(wpt.x, wpt.y));
          } else if (mode === 'move' && scope === 'area' && agentGroupMoveRef.current) {
            const wpt = screenToWorld(e.clientX, e.clientY);
            const g = agentGroupMoveRef.current;
            if (wpt) {
              const W = gridWidth.current, H = gridHeight.current, torus = boundaryTreatmentRef.current === 'torus';
              let ddx = wpt.x - g.downX, ddy = wpt.y - g.downY;
              if (torus && W > 0 && H > 0) { if (ddx > W / 2) ddx -= W; else if (ddx < -W / 2) ddx += W; if (ddy > H / 2) ddy -= H; else if (ddy < -H / 2) ddy += H; }
              pendingMovesRef.current = g.members.map(mm => ({ id: mm.id, x: mm.sx + ddx, y: mm.sy + ddy }));
              if (pendingMoveRaf.current == null) pendingMoveRaf.current = requestAnimationFrame(flushMoveBatch);
            }
          } else if (mode === 'move' && draggingAgentRef.current >= 0) {
            const wpt = screenToWorld(e.clientX, e.clientY);
            if (wpt) {
              pendingMovesRef.current = [{ id: draggingAgentRef.current, x: wpt.x, y: wpt.y }];
              if (pendingMoveRaf.current == null) pendingMoveRaf.current = requestAnimationFrame(flushMoveBatch);
            }
          } else if (mode === 'bond') {
            scanBondPairsAt(e.clientX, e.clientY);
          } else if (mode === 'add' && scope === 'area' && shape !== 'line') {
            const wpt = screenToWorld(e.clientX, e.clientY);
            const last = lastSeedWorldRef.current;
            if (wpt && last) {
              const W = gridWidth.current, H = gridHeight.current;
              const torus = boundaryTreatmentRef.current === 'torus';
              let dx = wpt.x - last.x, dy = wpt.y - last.y;
              if (torus && W > 0 && H > 0) {
                if (dx > W / 2) dx -= W; else if (dx < -W / 2) dx += W;
                if (dy > H / 2) dy -= H; else if (dy < -H / 2) dy += H;
              }
              const dist = Math.hypot(dx, dy);
              const spacing = Math.max(0.5, agentSeedSpacingRef.current);
              if (dist >= spacing) {
                const steps = Math.floor(dist / spacing);
                let lastX = last.x, lastY = last.y;
                for (let s = 1; s <= steps; s++) {
                  const t = (s * spacing) / dist;
                  let cx = last.x + dx * t, cy = last.y + dy * t;
                  if (torus && W > 0 && H > 0) { cx = ((cx % W) + W) % W; cy = ((cy % H) + H) % H; }
                  for (const p of agentSeedInShape(cx, cy)) pendingSeedPoints.current.push(p);
                  lastX = cx; lastY = cy;
                }
                pendingSeedSets.current = agentSeedSetsRef.current();
                lastSeedWorldRef.current = { x: lastX, y: lastY };
                if (pendingSeedRaf.current == null) pendingSeedRaf.current = requestAnimationFrame(flushSeedBatch);
              }
            }
          }
        }
      }

      // Bond-Graph Agents — AGENT sweep drag: re-target the (already open) agent
      // inspector to whichever agent is under the cursor, keeping the popover
      // anchored at the press point. Works for Shift+LMB AND the toolbar Inspect
      // toggle; empty space keeps the last inspected agent showing. Releasing
      // Shift mid-drag cancels (unless inspect mode holds the gesture).
      if (agentSweepActiveRef.current) {
        if (!e.shiftKey && !inspectModeRef.current) {
          agentSweepActiveRef.current = false;
          agentSweepMovedRef.current = false;
          agentSweepAnchorRef.current = null;
          clearAgentSweep();
          return;
        }
        const aid = pickAgentAt(e.clientX, e.clientY);
        if (aid >= 0) {
          if (aid !== agentSweepStartIdRef.current) agentSweepMovedRef.current = true;
          if (aid !== agentSweepPopoverRef.current?.id) {
            const a = agentSweepAnchorRef.current;
            openAgentInspector(aid, a?.x ?? e.clientX, a?.y ?? e.clientY);
          }
        }
        return;
      }

      // Shift+LMB sweep (or the toolbar Inspect toggle): update the transient
      // inspector to follow the cursor cell, and detect movement off the start
      // cell (= sweep, not click). Releasing Shift mid-drag cancels the sweep
      // entirely — unless inspect mode is what armed the gesture.
      if (sweepActiveRef.current) {
        if (!e.shiftKey && !inspectModeRef.current) {
          sweepActiveRef.current = false;
          sweepStartCellRef.current = null;
          sweepMovedRef.current = false;
          sweepInspectorRef.current = null;
          setSweepInspector(null);
          return;
        }
        // (The idle hover pipeline is rAF-coalesced, so compute this drag's own
        // cell — the sweep must track the cursor synchronously.)
        const sweepPos = screenToGrid(e.clientX, e.clientY);
        if (sweepPos && Number.isFinite(sweepPos.row) && Number.isFinite(sweepPos.col)) {
          const w = gridWidth.current;
          if (w > 0) {
            const idx = sweepPos.row * w + sweepPos.col;
            if (idx !== sweepStartCellRef.current) sweepMovedRef.current = true;
            const prior = sweepInspectorRef.current;
            if (prior && prior.cellIdx !== idx) {
              const next = { ...prior, cellIdx: idx, row: sweepPos.row, col: sweepPos.col };
              sweepInspectorRef.current = next;
              setSweepInspector(next);
            }
          }
        }
        return;
      }

      // Ctrl+LMB drag = resize brush. Adapts to the active shape: rect drags
      // W (x-axis) / H (y-axis); circle drags radius; ring drags radius
      // (x-axis) / band width (y-axis); line drags thickness.
      if (isResizingBrush.active) {
        const dx = e.clientX - isResizingBrush.startX;
        const dy = e.clientY - isResizingBrush.startY;
        const maxW = (gridWidth.current || simWidth) * 2;
        const maxH = (gridHeight.current || simHeight) * 2;
        const rz = isResizingBrush;
        const shape = rz.agent ? agentBrushShapeRef.current : brushShapeRef.current;
        const setRadius = rz.agent ? setAgentBrushRadius : setBrushRadius;
        const setRingW = rz.agent ? setAgentBrushRingWidth : setBrushRingWidth;
        const setLineW = rz.agent ? setAgentBrushLineWidth : setBrushLineWidth;
        const setW = rz.agent ? setAgentBrushW : setBrushW;
        const setH = rz.agent ? setAgentBrushH : setBrushH;
        if (shape === 'circle') {
          setRadius(Math.max(0, Math.min(maxW, rz.startRadius + Math.round(dx / 5))));
        } else if (shape === 'ring') {
          setRadius(Math.max(0, Math.min(maxW, rz.startRadius + Math.round(dx / 5))));
          setRingW(Math.max(1, Math.min(maxH, rz.startRingW - Math.round(dy / 5))));
        } else if (shape === 'line') {
          setLineW(Math.max(1, Math.min(maxW, rz.startLineW + Math.round(dx / 5))));
        } else {
          setW(Math.max(1, Math.min(maxW, rz.startW + Math.round(dx / 5))));
          setH(Math.max(1, Math.min(maxH, rz.startH - Math.round(dy / 5))));
        }
        draw();
        return;
      }
      if (e.buttons & 1 && canvasBrushActive) {
        // LMB held = brush drag (only if mousedown was on canvas, not overlay)
        if (!e.ctrlKey) paintAt(e.clientX, e.clientY);
        return;
      }
      if (!isPanning.current) return;
      const dx = e.clientX - lastMouse.current.x;
      const dy = e.clientY - lastMouse.current.y;
      lastMouse.current = { x: e.clientX, y: e.clientY };
      panRef.current = {
        x: panRef.current.x + dx,
        y: panRef.current.y + dy,
      };
      draw();
    };

    const handleMouseUp = () => {
      // End of an AGENT sweep: no-drag release keeps the popover pinned (it
      // opened on press); a drag across other agents discards it.
      if (agentSweepActiveRef.current) {
        const movedAgents = agentSweepMovedRef.current;
        agentSweepActiveRef.current = false;
        agentSweepMovedRef.current = false;
        agentSweepStartIdRef.current = -1;
        agentSweepAnchorRef.current = null;
        if (movedAgents) clearAgentSweep(); else commitAgentSweep();
        return;
      }
      // End of a Shift+LMB sweep: if the cursor never left the start cell,
      // commit (pin the popover — today's Shift+LMB click behavior). If it
      // moved, discard the transient. Runs before the brush-stroke cleanup
      // because sweep is mutually exclusive with paint/pan.
      if (sweepActiveRef.current) {
        const inspector = sweepInspectorRef.current;
        const moved = sweepMovedRef.current;
        sweepActiveRef.current = false;
        sweepStartCellRef.current = null;
        sweepMovedRef.current = false;
        sweepInspectorRef.current = null;
        setSweepInspector(null);
        if (!moved && inspector) {
          commitInspectPopover(inspector.cellIdx, inspector.row, inspector.col, inspector.x, inspector.y);
        }
        return;
      }
      // Bond-Graph Agents — end of a seed/kill agent-brush drag: flush the last
      // partial seed batch synchronously and clear the active flag (S1 — a drag
      // that started on canvas and ends anywhere must not leave it stuck).
      if (canvasAgentBrushActive.current) {
        canvasAgentBrushActive.current = false;
        lastSeedWorldRef.current = null;
        flushSeedBatch();
        flushMoveBatch();
        flushBondBatch();
        if (draggingAgentRef.current >= 0) { draggingAgentRef.current = -1; draggingAgentStartRef.current = null; }
        agentGroupMoveRef.current = null;
      }
      isPanning.current = false;
      isResizingBrush.active = false;
      canvasBrushActive = false;
      lastPaintGrid.current = null;
      // End-of-stroke: flush whatever paint cells were buffered for the next
      // rAF. Otherwise the trailing few cells of a fast brush stroke get held
      // until the next paint event (which might never come if the user lifts
      // the mouse and waits) — visible as a "missing tail" on quick clicks.
      flushPaintBatch();
      container.style.cursor = '';
    };

    // Suppress browser context menu on canvas area
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };

    const handleMouseLeave = () => {
      cursorGrid.current = null;
      publishHoverCellInfo(null);
      // Clear the agent-brush cursor/highlight state so nothing lingers off-canvas.
      agentCursorWorldRef.current = null;
      agentHoverIdRef.current = -1;
      if (agentAreaHoverIdsRef.current.length) agentAreaHoverIdsRef.current = [];
      drawCursorLayer();
    };

    // Escape exits autoscroll. We attach at window level because the focus might
    // be on any overlay control while autoscroll is active.
    const handleKeyDownAutoscroll = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && autoscrollOriginRef.current) {
        stopAutoscroll();
      }
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    container.addEventListener('mousedown', handleMouseDown);
    container.addEventListener('contextmenu', handleContextMenu);
    container.addEventListener('mouseleave', handleMouseLeave);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('keydown', handleKeyDownAutoscroll);

    return () => {
      container.removeEventListener('wheel', handleWheel);
      container.removeEventListener('mousedown', handleMouseDown);
      container.removeEventListener('contextmenu', handleContextMenu);
      container.removeEventListener('mouseleave', handleMouseLeave);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('keydown', handleKeyDownAutoscroll);
      // Stop autoscroll loop on unmount to avoid leaking the rAF cycle.
      if (autoscrollRafRef.current != null) {
        cancelAnimationFrame(autoscrollRafRef.current);
        autoscrollRafRef.current = null;
      }
      autoscrollOriginRef.current = null;
      autoscrollCursorRef.current = null;
      if (cursorDrawRaf.current != null) { cancelAnimationFrame(cursorDrawRaf.current); cursorDrawRaf.current = null; }
      if (hoverWorkRaf.current != null) { cancelAnimationFrame(hoverWorkRaf.current); hoverWorkRaf.current = null; }
    };
  }, [draw, scheduleCursorDraw, paintAt, paintLine, screenToGrid, flushPaintBatch, commitInspectPopover, screenToWorld, pickAgentAt, seedAgentsAt, agentSeedPoints, flushSeedBatch, killAgentsInRadius, openAgentInspector, flushMoveBatch, scanBondPairsAt, flushBondBatch, agentsInShapeAt, agentsInRadiusAt, agentSeedInShape, agentSeedInLine, agentLineMembers, applyAgentEditToIds, cancelFollow]);

  // Play: kick-start the step pipeline (worker message handler chains subsequent steps)
  useEffect(() => {
    if (playing) {
      sendNextStep();
    } else {
      // Stop: cancel any pending rAF
      if (nextStepRaf.current != null) { cancelAnimationFrame(nextStepRaf.current); nextStepRaf.current = null; }
      // A pause taken while the lossless throttle was holding would otherwise
      // leave the "waiting for encoder" indicator latched on — the tick that
      // clears it never runs again. (The encoder drains harmlessly while paused;
      // no frames are captured.)
      losslessWaitStartRef.current = null;
      setRecordThrottledIfChanged(false);
    }
  }, [playing, sendNextStep]);


  const handleStep = () => {
    if (overseerRunningRef.current) return;  // the experiment owns the transport
    if (playing) { setPlaying(false); return; }
    if (pendingStep.current) return;
    pendingStep.current = true;
    workerRef.current?.postMessage({ type: 'step', count: 1, activeViewer });
  };

  const handleReset = () => {
    if (overseerRunningRef.current) return;  // the experiment owns the transport
    // An explicit Reset is AUTHORITATIVE: reseed from the model's Init Events. Drop
    // any deferred embedded-snapshot restore that a prior Save-with-grid armed and
    // a paused reinit left pending — otherwise the worker reseeds cleanly, then the
    // next Play's first `stepped` fires applySimulationState and clobbers the fresh
    // state with the saved snapshot (cells AND agents), so "Reset" silently
    // restores a stale/edited board instead of the model's initial configuration.
    pendingSimStateRestore.current = null;
    setPlaying(false);
    pendingStep.current = true;
    workerRef.current?.postMessage({ type: 'reset', activeViewer });
  };

  const handleRecompile = () => {
    abortExperiment('manual recompile');
    setPlaying(false);
    workerRef.current?.terminate();
    workerRef.current = null;
    initWorkerWithDimensions(model.properties.gridWidth, model.properties.gridHeight);
  };

  /** Release the streaming encoder and clear every recording buffer/counter.
   *  Called from start (fresh slate), stop, and every abort site. */
  const resetRecordingState = () => {
    webmStreamRef.current?.cancel();
    webmStreamRef.current = null;
    webmStreamStateRef.current = 'idle';
    webmStreamPendingRef.current = [];
    recordStreamModeRef.current = false;
    recordedFrames.current = [];
    recordCountRef.current = 0;
    recordDroppedRef.current = 0;
    lastRecordCountSet.current = 0;
    recordCropRef.current = null;
    recordDimsRef.current = null;
    recordOverloadActiveRef.current = 'drop';
    losslessWaitStartRef.current = null;
    setRecordThrottledIfChanged(false);
    setRecordFrameCount(0);
    setRecordDroppedCount(0);
  };

  const startRecording = () => {
    resetRecordingState();
    // The format / scope / quality / overload selects are only rendered while
    // NOT recording, so all four are effectively locked for the run — which is
    // what lets us commit to a streaming WebM encoder (and to a single overload
    // policy) here. GIF keeps the buffered path (gifenc needs the raw pixels of
    // every frame to build its per-frame palette), and has no encoder to be
    // behind, so the overload policy is WebM-only.
    recordStreamModeRef.current = recordFormat === 'webm' && webmAvailable;
    recordOverloadActiveRef.current = recordStreamModeRef.current ? recordOverloadRef.current : 'drop';
    setRecording(true);
    // Tell the worker to include the colors buffer in stepped messages so we
    // can capture frames under WebGPU direct render (where srcCanvas's 2D
    // context is unavailable on the main thread). No-op on JS / WASM paths
    // — those already send colors every frame.
    workerRef.current?.postMessage({ type: 'setRecording', enabled: true });
  };

  const stopRecording = async () => {
    // Clear the ref synchronously — setRecording is async, and a `stepped`
    // landing in between must not feed a stream encoder we are about to finish.
    recordingRef.current = false;
    setRecording(false);
    workerRef.current?.postMessage({ type: 'setRecording', enabled: false });
    const fname = model.properties.name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '') || 'genesis';

    // ── Streaming WebM: everything is already encoded; Stop is just a flush. ──
    if (recordStreamModeRef.current) {
      const enc = webmStreamRef.current;
      const pending = webmStreamPendingRef.current;
      webmStreamRef.current = null;
      webmStreamPendingRef.current = [];
      webmStreamStateRef.current = 'idle';
      recordStreamModeRef.current = false;
      const force = recordOverloadActiveRef.current === 'lossless';
      if (enc) {
        for (const f of pending) { if (enc.addFrame(f, force)) recordCountRef.current += 1; else recordDroppedRef.current += 1; }
        setEncodingWebM(true);
        try {
          const blob = await enc.finish();
          await saveRecording(blob, `${fname}_recording.webm`);
        } catch (err) {
          console.error('WebM encode failed', err);
          alert(`WebM encode failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          setEncodingWebM(false);
        }
      } else if (pending.length > 0) {
        // Stopped before the async codec probe resolved — encode the handful of
        // held frames through the buffered path so a very short recording still
        // produces a file.
        setEncodingWebM(true);
        try {
          const blob = await encodeFramesToWebM(pending, targetFpsRef.current || 30, recordQualityRef.current);
          await saveRecording(blob, `${fname}_recording.webm`);
        } catch (err) {
          console.error('WebM encode failed', err);
          alert(`WebM encode failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          setEncodingWebM(false);
        }
      }
      resetRecordingState();
      return;
    }

    // ── Buffered path (GIF, or WebM after a streaming-setup failure) ──────────
    const frames = recordedFrames.current;
    if (frames.length === 0) { resetRecordingState(); return; }
    const fps = targetFpsRef.current || 30;

    // Use the format selected at the moment recording stops. WebM falls back
    // to GIF if the browser doesn't support WebCodecs (defensive — the UI
    // already greys out the WebM option in that case).
    const format: RecordFormat = recordFormat === 'webm' && !isWebMSupported() ? 'gif' : recordFormat;

    if (format === 'webm') {
      setEncodingWebM(true);
      try {
        const blob = await encodeFramesToWebM(frames, fps, recordQualityRef.current);
        await saveRecording(blob, `${fname}_recording.webm`);
      } catch (err) {
        console.error('WebM encode failed', err);
        alert(`WebM encode failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setEncodingWebM(false);
      }
    } else {
      const fw = frames[0]!.width;
      const fh = frames[0]!.height;
      // Downscale large grids to max 512px (GIF only — WebM keeps native size).
      const maxDim = 512;
      let outW = fw, outH = fh;
      if (fw > maxDim || fh > maxDim) {
        const s = maxDim / Math.max(fw, fh);
        outW = Math.round(fw * s);
        outH = Math.round(fh * s);
      }
      const gif = GIFEncoder();
      const delay = Math.round(1000 / fps);
      const needsScale = outW !== fw || outH !== fh;
      let scaleCanvas: HTMLCanvasElement | null = null;
      let scaleCtx: CanvasRenderingContext2D | null = null;
      let srcCanvas: HTMLCanvasElement | null = null;
      let srcCtx: CanvasRenderingContext2D | null = null;
      if (needsScale) {
        scaleCanvas = document.createElement('canvas');
        scaleCanvas.width = outW; scaleCanvas.height = outH;
        scaleCtx = scaleCanvas.getContext('2d')!;
        scaleCtx.imageSmoothingEnabled = false;
        srcCanvas = document.createElement('canvas');
        srcCanvas.width = fw; srcCanvas.height = fh;
        srcCtx = srcCanvas.getContext('2d')!;
      }
      for (const frame of frames) {
        let rgba: Uint8ClampedArray;
        if (needsScale && scaleCtx && scaleCanvas && srcCtx && srcCanvas) {
          srcCtx.putImageData(frame, 0, 0);
          scaleCtx.drawImage(srcCanvas, 0, 0, outW, outH);
          rgba = scaleCtx.getImageData(0, 0, outW, outH).data;
        } else {
          rgba = frame.data;
        }
        const palette = quantize(rgba, 256);
        const indexed = applyPalette(rgba, palette);
        gif.writeFrame(indexed, outW, outH, { palette, delay });
      }
      gif.finish();
      const blob = new Blob([gif.bytes()], { type: 'image/gif' });
      await saveRecording(blob, `${fname}_recording.gif`);
    }
    resetRecordingState();
  };

  /** Write a finished recording/screenshot blob to disk. Routes through
   *  `saveBinaryFile`, which is a plain blob download on the web but a real
   *  native Save As in the Tauri shell — WebView2 silently drops `<a download>`,
   *  so a bare anchor here would write NOTHING in the desktop build.
   *  CANCELLED and FAILED are kept apart: only the caller knows whether the
   *  bytes are recoverable, and reporting a write failure as "cancelled" would
   *  be a lie. A failure is always toasted here; a cancel never is. */
  const saveBlobFile = async (blob: Blob, filename: string): Promise<'saved' | 'cancelled' | 'failed'> => {
    try {
      return (await saveBinaryFile(blob, filename)) ? 'saved' : 'cancelled';
    } catch (err) {
      console.error('Save failed', err);
      showAgentNotice(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
      return 'failed';
    }
  };

  /** Fire-and-forget save (screenshots): cancelling loses nothing and the shot
   *  is trivially retaken, so only a real failure says anything. */
  const triggerDownload = (blob: Blob, filename: string): void => {
    void saveBlobFile(blob, filename);
  };

  /** Stop-and-Save tail: the encoder is already finished, so if the user
   *  cancels Save As the bytes are GONE. Say so rather than resetting silently. */
  const saveRecording = async (blob: Blob, filename: string): Promise<void> => {
    if (await saveBlobFile(blob, filename) === 'cancelled') {
      showAgentNotice('Recording discarded — save was cancelled');
    }
  };


  const handleCopyCode = () => {
    navigator.clipboard.writeText(compiledCode).catch(() => {});
  };

  const handleResetView = () => {
    cancelFollow();  // an explicit camera reset takes the wheel back — see FOLLOW MODE
    zoomRef.current = 1;
    panRef.current = { x: 0, y: 0 };
    draw();
  };

  // Simulator keyboard shortcuts (Space=step, Enter=play/pause, Esc=reset,
  // Ctrl+C/V/X=copy/paste/cut cell-attribute region under the brush)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (document.activeElement as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'v' || e.key === 'x')) {
        // 3D: cell copy/paste is 2D-only for now — cursorGrid comes from the
        // inert 2D fit-mapping there and readRegion/writeRegion are layer-0-only,
        // so proceeding would silently corrupt layer-0 cells far from the brush
        // plane the user is looking at. (A layer-aware region copy anchored on
        // the brush plane is the follow-up.)
        if (is3dRef.current) return;
        // AGENT clipboard (2D, agent brush target): copy/cut the agents under
        // the brush footprint (fresh spec via readAgents), paste at the cursor
        // with the copied world offsets (per-agent attrs/velocity via the
        // pasteAgents worker message). Falls back to the nearest picked agent
        // when the footprint catches none (the Single-scope case).
        if (isAgentModelRef.current && brushTargetRef.current === 'agents') {
          const wpt = agentCursorWorldRef.current;
          if (!wpt) return;
          e.preventDefault();
          if (e.key === 'c' || e.key === 'x') {
            let ids = agentsInShapeAt(wpt.x, wpt.y);
            if (ids.length === 0 && agentHoverIdRef.current >= 0) ids = [agentHoverIdRef.current];
            if (ids.length === 0) return;
            pendingAgentCopyRef.current = { anchor: { x: wpt.x, y: wpt.y }, cut: e.key === 'x', ids };
            workerRef.current?.postMessage({ type: 'readAgents', ids });
          } else {
            const clip = agentClipboardRef.current;
            if (!clip || clip.length === 0) return;
            workerRef.current?.postMessage({
              type: 'pasteAgents',
              agents: clip.map(a => ({
                x: wpt.x + a.dx, y: wpt.y + a.dy,
                radius: a.radius, vx: a.vx, vy: a.vy,
                sets: Object.entries(a.attrs).map(([attrId, value]) => ({ attrId, value })),
              })),
              torus: boundaryTreatmentRef.current === 'torus',
              activeViewer: activeViewerRef.current,
            });
          }
          return;
        }
        const cur = cursorGrid.current;
        if (!cur) return;
        if (e.key === 'c' || e.key === 'x') {
          e.preventDefault();
          // Copy the cells the BRUSH FOOTPRINT covers (rect/circle/ring → that
          // shape; line at a single cursor point → its width-dot). Read the
          // footprint's bounding-box rectangle, but carry a shape mask so paste
          // writes only the shape. hotR/hotC = cursor offset within the box.
          const offsets = currentStampOffsets();
          let minDr = 0, maxDr = 0, minDc = 0, maxDc = 0;
          for (const [dr, dc] of offsets) {
            if (dr < minDr) minDr = dr; if (dr > maxDr) maxDr = dr;
            if (dc < minDc) minDc = dc; if (dc > maxDc) maxDc = dc;
          }
          const w = maxDc - minDc + 1, h = maxDr - minDr + 1;
          const mask = new Uint8Array(w * h);
          for (const [dr, dc] of offsets) mask[(dr - minDr) * w + (dc - minDc)] = 1;
          const anchorRow = cur.row + minDr, anchorCol = cur.col + minDc;
          pendingCopyMeta.current = { mask, hotR: -minDr, hotC: -minDc };
          if (e.key === 'x') pendingCutRect.current = { row: anchorRow, col: anchorCol, w, h, mask };
          workerRef.current?.postMessage({ type: 'readRegion', row: anchorRow, col: anchorCol, w, h });
        } else if (e.key === 'v') {
          const clip = clipboardRef.current;
          if (!clip) return;
          e.preventDefault();
          // Re-centre the clipboard's box on the cursor the same way copy did
          // (fall back to box-centre for pre-mask clipboard data). Re-slice
          // buffers + mask so the clipboard stays reusable for further pastes.
          const hotR = clip.hotR ?? Math.floor((clip.h - 1) / 2);
          const hotC = clip.hotC ?? Math.floor((clip.w - 1) / 2);
          const attrs: Record<string, { type: string; buffer: ArrayBuffer }> = {};
          for (const [id, entry] of Object.entries(clip.attributes)) {
            attrs[id] = { type: entry.type, buffer: entry.buffer.slice(0) };
          }
          workerRef.current?.postMessage({
            type: 'writeRegion',
            row: cur.row - hotR, col: cur.col - hotC, w: clip.w, h: clip.h,
            attributes: attrs,
            mask: clip.mask ? clip.mask.buffer.slice(0) : undefined,
            activeViewer: activeViewerRef.current,
          });
        }
        return;
      }
      if (e.key === ' ') { e.preventDefault(); handleStep(); }
      else if (e.key === 'Enter') { e.preventDefault(); setPlaying(p => !p); }
      else if (e.key === 'Escape' && (lineAnchorRef.current || line3dAnchorRef.current)) {
        // A staged Line-tool anchor (2D or 3D) consumes Escape (cancel the line)
        // so the user doesn't accidentally reset the whole simulation.
        e.preventDefault();
        lineAnchorRef.current = null;
        line3dAnchorRef.current = null;
        draw();
      }
      else if (e.key === 'Escape' || e.key === 'Backspace') { e.preventDefault(); handleReset(); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  });

  // F3: Update model attribute at runtime
  const handleModelAttrChange = (attrId: string, value: number) => {
    setRuntimeModelAttrs(prev => ({ ...prev, [attrId]: value }));
    workerRef.current?.postMessage({ type: 'updateModelAttrs', attrs: { [attrId]: value } });
  };

  // Variegated Cells: interaction-table model attrs are live-tuneable like
  // any other model attr but their payload is the full nested map (not a
  // single number). We persist via updateAttribute (marks the model dirty
  // because changing the table changes the model spec, same as editing it in
  // the modeler) AND post an updateInteractionTable message to the worker so
  // the simulator sees the new values immediately.
  const handleInteractionTableEdit = (
    attrId: string,
    tableValues: Record<string, Record<string, number>> | undefined,
    symmetric: boolean | undefined,
    tableData?: number[],
    tableRoll?: { seed: number; density: number; max?: number; rangeMin?: number; rangeMax?: number },
  ) => {
    const changes: Partial<Attribute> = {};
    if (tableValues !== undefined) changes.tableValues = tableValues;
    if (symmetric !== undefined) changes.symmetric = symmetric;
    if (tableData !== undefined) changes.tableData = tableData;
    if (tableRoll !== undefined) changes.tableRoll = tableRoll;
    updateAttribute(attrId, changes);
    const a = model.attributes.find(x => x.id === attrId);
    if (tableData !== undefined && a && isMultiAxisTable(a)) {
      // Multi-axis: ship dims + the NEW dense data (the payload builder reads
      // the pre-dispatch attr, so pass the fresh data explicitly).
      const p = buildLookupTablePayload(a, model);
      workerRef.current?.postMessage({
        type: 'updateLookupTable', attrId,
        rowLabels: [], colLabels: [], values: {},
        dims: p.dims, data: tableData,
      });
    } else if (tableValues !== undefined) {
      workerRef.current?.postMessage({
        type: 'updateLookupTable',
        attrId,
        rowLabels: resolveKeyLabels(a?.rowKeySource, model),
        colLabels: resolveKeyLabels(a?.colKeySource, model),
        values: tableValues,
      });
    }
  };

  // Reset every model attribute back to its declared default value.
  // Scalar attrs come from `computeDefaultModelAttrs`. Interaction tables
  // restore from the snapshot captured at model-load time (see
  // `interactionTableDefaultsRef`) — both via `updateAttribute` (so a
  // subsequent .gcaproj save captures the restored values) AND via the worker
  // `updateInteractionTable` message (so the running simulation sees the
  // restored values immediately).
  const handleResetModelAttrs = () => {
    const defaults = computeDefaultModelAttrs(model.attributes);
    setRuntimeModelAttrs(defaults);
    workerRef.current?.postMessage({ type: 'updateModelAttrs', attrs: defaults });
    const tableDefaults = interactionTableDefaultsRef.current;
    for (const a of model.attributes) {
      if (a.type !== 'lookupTable') continue;
      const def = tableDefaults[a.id];
      if (!def) continue;
      // Deep clone — keep the snapshot intact so subsequent resets still work
      // after future edits.
      if (def.tableData && isMultiAxisTable(a)) {
        const restored = [...def.tableData];
        updateAttribute(a.id, { tableData: restored });
        const p = buildLookupTablePayload(a, model);
        workerRef.current?.postMessage({
          type: 'updateLookupTable', attrId: a.id,
          rowLabels: [], colLabels: [], values: {},
          dims: p.dims, data: restored,
        });
      } else if (def.tableValues) {
        const restored = JSON.parse(JSON.stringify(def.tableValues));
        updateAttribute(a.id, { tableValues: restored });
        workerRef.current?.postMessage({
          type: 'updateLookupTable',
          attrId: a.id,
          rowLabels: resolveKeyLabels(a.rowKeySource, model),
          colLabels: resolveKeyLabels(a.colKeySource, model),
          values: restored,
        });
      }
    }
  };

  // F4: Screenshot export — 1:1 pixel-perfect from source canvas (no scaling).
  // Under WebGPU direct render the placeholder srcCanvas's 2D context is gone
  // (transferred to the worker), so toBlob/getImageData all fail. Ask the
  // worker for a fresh colors snapshot, paint it onto an offscreen 2D canvas,
  // then toBlob from there. Falls through to direct toBlob in JS/WASM modes.
  const screenshotPendingRef = useRef<((data: { w: number; h: number; colors?: Uint8ClampedArray }) => void) | null>(null);
  const handleScreenshot = () => {
    // Via saveBinaryFile (native Save As in the Tauri shell, blob download on
    // the web). Cancelling is silent — nothing was lost and a screenshot is
    // trivially retaken; a real write FAILURE is surfaced.
    const downloadBlob = (blob: Blob) => {
      const name = model.properties.name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '') || 'genesis';
      void triggerDownload(blob, `${name}_gen${generationRef.current}.png`);
    };
    // Mirrors the recording capture: one path for the DISPLAY the user sees, with the
    // chosen scope — "simulation" crops to the drawn world rectangle (no letterbox
    // margins), "view" is the whole canvas as shown.
    // 3D Grid CA: screenshot the WebGL2 display buffer (display resolution — a volume
    // has no grid-res analogue, and no letterbox so both scopes are the full frame).
    // preserveDrawingBuffer is on; re-render first so the buffer is current.
    if (is3dRef.current && gl3dRef.current) {
      draw();
      const px = capture3dPixels() ?? gl3dRef.current.readPixels();
      const off = document.createElement('canvas');
      off.width = px.width; off.height = px.height;
      const ctx = off.getContext('2d');
      if (!ctx) return;
      ctx.putImageData(new ImageData(px.data, px.width, px.height), 0, 0);
      off.toBlob(blob => { if (blob) downloadBlob(blob); }, 'image/png');
      return;
    }
    // "simulation": the WHOLE grid/world at a fit framing, independent of the current
    // zoom/pan (renders from the colours buffer + agent snapshot — see
    // renderSimulationFrame). A fresh offscreen (one-shot; toBlob is async).
    if (screenshotScopeRef.current === 'simulation') {
      const w = gridWidth.current || 1, h = gridHeight.current || 1;
      const off = renderSimulationFrame(Math.min(2048, Math.max(720, Math.max(w, h))));
      if (off) off.toBlob(blob => { if (blob) downloadBlob(blob); }, 'image/png');
      return;
    }
    // "current view": the display canvas exactly as shown (zoom / pan / margins).
    // draw() first so it's current, then copy it onto a throwaway offscreen (drawImage
    // = texture read; never getImageData the live display canvas — that de-optimizes it).
    draw();
    const dc = canvasRef.current;
    if (!dc || dc.width <= 0 || dc.height <= 0) return;
    const off = document.createElement('canvas');
    off.width = dc.width; off.height = dc.height;
    const octx = off.getContext('2d');
    if (!octx) return;
    octx.drawImage(dc, 0, 0);
    off.toBlob(blob => { if (blob) downloadBlob(blob); }, 'image/png');
  };

  // Save simulation state
  const handleSaveState = () => {
    if (!workerRef.current) return;
    pendingStateSave.current = (workerState) => {
      const state = serializeSimState(
        workerState as Parameters<typeof serializeSimState>[0],
        {
          activeViewer,
          activeAgentViewer: activeAgentViewerRef.current || undefined,
          brushColor,
          brushW,
          brushH,
          brushShape,
          brushRadius,
          brushRingWidth,
          brushLineWidth,
          brushMapping,
          targetFps,
          unlimitedFps,
          gensPerFrame,
          unlimitedGens,
          indicatorChartOverrides,
        },
        { grid: true, controls: true },
        { boundaryTreatment: model.properties.boundaryTreatment },
      );
      // Also store in model context so next .gcaproj save includes it
      setSimulationState(state);
      const name = model.properties.name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '') || 'genesis';
      void downloadStateFile(state, `${name}_gen${generationRef.current}.gcastate`);
    };
    workerRef.current.postMessage({ type: 'getState' });
  };

  // Load simulation state from .gcastate file
  const handleLoadState = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    try {
      const state = await readStateFile(file);
      applySimulationState(state, { adaptDims: true });  // explicit file load — its dims are authoritative
    } catch (err) {
      setCompileError(String(err));
    }
  };

  // Snapshot the current interaction-table values keyed by attribute id, deep-
  // cloned so a later mutation of model.attributes doesn't leak back into the
  // saved preset payload. Returns undefined when no interaction-table attrs
  // exist (serializePreset skips the field entirely in that case).
  const snapshotInteractionTables = (): Record<string, Record<string, Record<string, number>>> | undefined => {
    const out: Record<string, Record<string, Record<string, number>>> = {};
    let any = false;
    for (const a of model.attributes) {
      if (a.type !== 'lookupTable' || !a.tableValues || isMultiAxisTable(a)) continue;
      out[a.id] = JSON.parse(JSON.stringify(a.tableValues));
      any = true;
    }
    return any ? out : undefined;
  };

  // The axes-mode sibling: multi-axis tables snapshot their dense tableData
  // (presets carry it under SimulationState.lookupTableData).
  const snapshotLookupTableData = (): Record<string, number[]> | undefined => {
    const out: Record<string, number[]> = {};
    let any = false;
    for (const a of model.attributes) {
      if (a.type !== 'lookupTable' || !isMultiAxisTable(a) || !a.tableData) continue;
      out[a.id] = [...a.tableData];
      any = true;
    }
    return any ? out : undefined;
  };

  // Save current state as a named preset (captures modelAttrs always, grid optionally)
  const handleCreatePreset = (name: string, description: string, includeGrid: boolean) => {
    if (!workerRef.current) return;
    pendingStateSave.current = (workerState) => {
      const state = serializePreset(
        workerState as Parameters<typeof serializePreset>[0],
        { includeGrid },
        {
          boundaryTreatment: model.properties.boundaryTreatment,
          interactionTables: snapshotInteractionTables(),
          lookupTableData: snapshotLookupTableData(),
        },
      );
      const id = 'preset_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const preset: Preset = { id, name, state, createdAt: Date.now() };
      if (description.trim()) preset.description = description.trim();
      addPreset(preset);
    };
    workerRef.current.postMessage({ type: 'getState' });
  };

  const handleLoadPreset = (p: Preset) => {
    // Only pause if the preset forces a structural worker reinit (grid
    // dimensions or boundary treatment change) — that genuinely restarts the
    // engine. Parameter-only / matching-dims presets apply live, so loading
    // them while playing must NOT interrupt the running simulation. Predicate
    // mirrors applySimulationState's boundaryChanged/dimsChanged check.
    const s = p.state;
    const hasGrid = s.width != null && s.height != null && s.attributes != null && s.colors != null;
    // Mirrors applySimulationState: a grid-less (parameter-only) preset never
    // adapts dims/boundary, so it never forces a reinit → never pauses.
    const boundaryChanged = hasGrid && !!s.boundaryTreatment && s.boundaryTreatment !== model.properties.boundaryTreatment;
    const sD = s.gridDepth ?? s.depth ?? 1;
    const dimsFromState = !hasGrid ? null
      : s.gridWidth != null && s.gridHeight != null
        ? { w: s.gridWidth, h: s.gridHeight, d: sD }
        : { w: s.width!, h: s.height!, d: sD };
    const dimsChanged = dimsFromState != null
      && (dimsFromState.w !== gridWidth.current || dimsFromState.h !== gridHeight.current || dimsFromState.d !== gridDepth.current);
    if ((boundaryChanged || dimsChanged) && playing) setPlaying(false);
    applySimulationState(p.state, { adaptDims: true });  // explicit preset load — a WITH-GRID preset's dims are authoritative
  };

  const handleDeletePreset = (p: Preset) => {
    setPresetToDelete(p);
  };

  // --- Preset export / import (.gcapreset) ---------------------------------
  // One named preset (its embedded SimulationState + metadata) as a standalone
  // JSON file, transportable between projects. Import appends via addPreset
  // with a FRESH id; the embedded state travels verbatim, so the documented
  // preset load semantics (grid-carrying = dims-authoritative, parameter-only
  // = grid-less) are exactly what the exporting project had.
  const presetFileInputRef = useRef<HTMLInputElement>(null);
  const handleExportPreset = (p: Preset) => {
    const safe = (p.name || 'preset').replace(/[^\w\-. ]+/g, '_').trim() || 'preset';
    void downloadPresetFile(p, `${safe}.gcapreset`);
  };
  const handleImportPresetFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-importing the same file
    if (!file) return;
    try {
      const preset = await readPresetFile(file);
      addPreset(preset);
    } catch (err) {
      setCompileError(`Preset import failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Overwrite preset: same pipeline as create, but dispatches updatePreset instead of addPreset.
  const handleOverwritePreset = (p: Preset) => {
    setPresetToOverwrite(p);
  };

  const doOverwritePreset = (target: Preset, name: string, description: string, includeGrid: boolean) => {
    if (!workerRef.current) return;
    pendingStateSave.current = (workerState) => {
      const state = serializePreset(
        workerState as Parameters<typeof serializePreset>[0],
        { includeGrid },
        {
          boundaryTreatment: model.properties.boundaryTreatment,
          interactionTables: snapshotInteractionTables(),
          lookupTableData: snapshotLookupTableData(),
        },
      );
      const patch: Partial<Omit<Preset, 'id'>> = { name, state };
      patch.description = description.trim() || undefined;
      updatePreset(target.id, patch);
    };
    workerRef.current.postMessage({ type: 'getState' });
  };

  const applySimulationState = useCallback((state: SimulationState, opts?: { adaptDims?: boolean }) => {
    if (!workerRef.current) return;
    // adaptDims: may this restore CHANGE the model's grid dims / boundary to match
    // the snapshot? True only for AUTHORITATIVE loads (a .gcastate file or a preset
    // the user explicitly opened — there the saved dims are what the user wants).
    // The embedded auto-restore (pendingSimStateRestore, fired after a structural
    // reinit) passes false: the model is the source of truth there, so a snapshot
    // whose dims no longer match was invalidated by a user edit and must be DROPPED,
    // never used to revert the edit. (Reverting was the dimension-reset loop.)
    const adaptDims = opts?.adaptDims ?? false;

    // Wave A.6: standalone .gcastate files saved by pre-A.6 builds carry no
    // schemaVersion and may hold slot-index NI cell-attr arrays. Migrate
    // in place using the current model's neighborhoodHintIds. Embedded
    // simulationState inside .gcaproj files was already migrated by
    // readModelFile, but presets / direct state loads come through here.
    if ((state.schemaVersion ?? 1) < 2 && state.attributes) {
      migrateSimulationStateV1toV2(state, model);
    }

    const hasGrid = state.width != null && state.height != null && state.attributes != null && state.colors != null;
    const hasControls = state.brushColor != null || state.targetFps != null || state.activeViewer != null;

    // If the saved state has a different boundary treatment or different grid dimensions
    // than the current model, apply those through the normal model-update path. The
    // existing useEffect on [model] detects structural changes and triggers a full
    // worker reinit; the pending-restore mechanism then applies the grid/control
    // state after the new worker finishes its first step.
    // A state with NO embedded grid (a parameter-only preset / a controls-only
    // save) must never resize the grid or flip the boundary — it has no board
    // to restore, and adapting would clobber the live dims AND the model's
    // default dims (via updateProperties) with whatever the worker happened to
    // be at when the preset was saved (the reported "parameter preset changes
    // the grid and then the default" bug). The gridWidth/gridHeight/
    // boundaryTreatment such states carry are save-time metadata only.
    const boundaryChanged = hasGrid && state.boundaryTreatment && state.boundaryTreatment !== model.properties.boundaryTreatment;
    // 3D Grid CA: carry depth (gridDepth ?? depth ?? 1) so a depth change adapts
    // the model + triggers the structural reinit.
    const stateDepth = state.gridDepth ?? state.depth ?? 1;
    const dimsFromState = !hasGrid ? null
      : state.gridWidth != null && state.gridHeight != null
        ? { w: state.gridWidth, h: state.gridHeight, d: stateDepth }
        : { w: state.width!, h: state.height!, d: stateDepth };
    const dimsChanged = dimsFromState != null
      && (dimsFromState.w !== gridWidth.current || dimsFromState.h !== gridHeight.current || dimsFromState.d !== gridDepth.current);
    if (boundaryChanged || dimsChanged) {
      if (!adaptDims) {
        // Embedded auto-restore of a snapshot that no longer matches the model's
        // grid → the user edited the dimensions / boundary after load. Drop the
        // stale snapshot (the model wins) instead of reverting the edit. Clearing
        // it from the model stops it re-arming on every subsequent structural edit.
        pendingSimStateRestore.current = null;
        if (model.simulationState) setSimulationState(undefined);
        return;
      }
      pendingSimStateRestore.current = state;
      const changes: Partial<import('../model/types').ModelProperties> = {};
      if (boundaryChanged) changes.boundaryTreatment = state.boundaryTreatment!;
      if (dimsChanged) {
        changes.gridWidth = dimsFromState!.w;
        changes.gridHeight = dimsFromState!.h;
        changes.gridDepth = dimsFromState!.d;
        // A depth>1 state implies a 3D model; flip the current model to 3D so the
        // engine actually allocates the volume (.gcastate carries no `dimension`).
        if (dimsFromState!.d > 1) changes.dimension = '3d';
      }
      updateProperties(changes);
      return;
    }

    // Restore UI controls (independent of grid)
    if (hasControls) {
      if (state.activeViewer != null) setActiveViewer(state.activeViewer);
      if (state.activeAgentViewer != null) setActiveAgentViewer(state.activeAgentViewer);
      if (state.brushColor != null) setBrushColor(state.brushColor);
      if (state.brushW != null) setBrushW(state.brushW);
      if (state.brushH != null) setBrushH(state.brushH);
      if (state.brushShape != null) setBrushShape(state.brushShape);
      if (state.brushRadius != null) setBrushRadius(state.brushRadius);
      if (state.brushRingWidth != null) setBrushRingWidth(state.brushRingWidth);
      if (state.brushLineWidth != null) setBrushLineWidth(state.brushLineWidth);
      if (state.brushMapping != null) setBrushMapping(state.brushMapping);
      if (state.targetFps != null) setTargetFps(state.targetFps);
      if (state.unlimitedFps != null) setUnlimitedFps(state.unlimitedFps);
      if (state.gensPerFrame != null) setGensPerFrame(state.gensPerFrame);
      if (state.unlimitedGens != null) setUnlimitedGens(state.unlimitedGens);
      // Per-indicator chart-settings overrides (gear popover). Replace
      // wholesale — the saved snapshot is the complete override layer.
      if (state.indicatorChartOverrides != null) setIndicatorChartOverrides(state.indicatorChartOverrides);
    }

    // Restore model-attribute values independently — presets may carry these
    // without any UI controls, so gating on hasControls would silently skip them.
    if (state.modelAttrs) {
      setRuntimeModelAttrs(prev => ({ ...prev, ...state.modelAttrs }));
      workerRef.current?.postMessage({ type: 'updateModelAttrs', attrs: state.modelAttrs });
    }

    // Restore interaction-table model attributes. Presets (e.g. parameter sets
    // for chemistry models like Amphiphile) typically vary a dozen+ float values
    // across several tables; storing them by id->row->col->float keeps the
    // preset payload compact and human-readable. Apply to BOTH the worker
    // (immediate effect on the running simulation) AND the model state via
    // updateAttribute (so a subsequent .gcaproj save captures the preset values
    // and the Properties panel reflects them). UPDATE_ATTRIBUTE does NOT bump
    // modelVersion, so the interaction-table snapshot used by Reset-to-Default
    // stays pointed at the model's ORIGINAL defaults — letting the user always
    // get back to the model's shipped baseline after experimenting.
    if (state.interactionTables) {
      for (const [attrId, values] of Object.entries(state.interactionTables)) {
        const cloned = JSON.parse(JSON.stringify(values));
        updateAttribute(attrId, { tableValues: cloned });
        const a = model.attributes.find(x => x.id === attrId);
        workerRef.current?.postMessage({
          type: 'updateLookupTable',
          attrId,
          rowLabels: resolveKeyLabels(a?.rowKeySource, model),
          colLabels: resolveKeyLabels(a?.colKeySource, model),
          values: cloned,
        });
      }
    }

    // Restore MULTI-AXIS lookup tables (the axes-mode sibling — dense flat
    // tableData per attribute). Same dual-apply: model state + the worker.
    if (state.lookupTableData) {
      for (const [attrId, data] of Object.entries(state.lookupTableData)) {
        const a = model.attributes.find(x => x.id === attrId);
        if (!a || !isMultiAxisTable(a) || !Array.isArray(data)) continue;
        const cloned = [...data];
        updateAttribute(attrId, { tableData: cloned });
        const p = buildLookupTablePayload(a, model);
        workerRef.current?.postMessage({
          type: 'updateLookupTable', attrId,
          rowLabels: [], colLabels: [], values: {},
          dims: p.dims, data: cloned,
        });
      }
    }

    // Restore grid state if present
    if (!hasGrid) return;

    // Validate dimensions match the current grid (incl. depth for 3D).
    const sDepth = state.depth ?? state.gridDepth ?? 1;
    if (state.width !== gridWidth.current || state.height !== gridHeight.current || sDepth !== gridDepth.current) {
      // Show the 3rd dim only when either side is a volume.
      const show3 = sDepth > 1 || gridDepth.current > 1;
      const fmt = (w: number | undefined, h: number | undefined, d: number) => show3 ? `${w}\u00D7${h}\u00D7${d}` : `${w}\u00D7${h}`;
      setCompileError(
        `State dimensions (${fmt(state.width, state.height, sDepth)}) do not match current grid (${fmt(gridWidth.current, gridHeight.current, gridDepth.current)}). Resize the grid first or load a matching state file.`,
      );
      return;
    }

    // Reset generation counter — saved states restore the grid configuration,
    // not the simulation history. Users building a starting configuration
    // shouldn't inherit the generation count they spent getting there.
    generationRef.current = 0;
    lastGenSetTime.current = 0;
    setGeneration(0);
    indicatorValuesRef.current = {};
    indicatorHistoryRef.current = {};

    // Convert serialized attributes back to ArrayBuffers for worker
    const attrBuffers: Record<string, { type: string; buffer: ArrayBuffer }> = {};
    // 3D Grid CA: attr buffers were serialized at length W*H*D — deserialize at
    // the same length or a 3D grid loads truncated to its first layer.
    const total = state.width! * state.height! * (state.depth ?? state.gridDepth ?? 1);
    for (const [id, entry] of Object.entries(state.attributes!)) {
      // Backward-compat: files saved before `neighborIndex: 'int32'` was added
      // to ATTR_TYPE_MAP in fileOperations.ts wrote NI cell-attr buffers with
      // type='float64' even though the bytes were really int32. Fix the label
      // on the way in so deserializeTypedArray reads the buffer as Int32Array
      // (correct byte interpretation) instead of Float64Array (which would
      // slice 4N bytes into N/2 float64 elements of garbage and corrupt every
      // NI cell value silently). Detected by the model declaring the attr as
      // neighborIndex while the serialized type is float64.
      const modelAttr = model.attributes.find(a => a.id === id);
      if (modelAttr?.type === 'neighborIndex' && entry.type === 'float64') {
        entry.type = 'int32';
      }
      const arr = deserializeTypedArray(entry, total);
      const typeMap: Record<string, string> = { uint8: 'bool', int32: 'integer', float64: 'float' };
      attrBuffers[id] = { type: typeMap[entry.type] || 'float', buffer: arr.buffer };
    }

    const colorsBuffer = base64ToArrayBuffer(state.colors!);
    // NOTE: `generation`, `indicators`, `linkedAccumulators` are intentionally
    // NOT forwarded — the worker resets them to defaults in its loadState
    // handler so the user gets a clean run starting from the loaded grid state.
    const loadMsg: Record<string, unknown> = {
      type: 'loadState',
      width: state.width,
      height: state.height,
      attributes: attrBuffers,
      modelAttrs: state.modelAttrs || {},
      colors: colorsBuffer,
      activeViewer: state.activeViewer ?? activeViewerRef.current,
    };

    if (state.orderArray) {
      loadMsg.orderArray = base64ToArrayBuffer(state.orderArray);
    }

    // Bond-Graph Agents: restore the saved agent population. The worker's
    // loadState validates the bond stride + capacity LOUDLY; when the state has
    // NO agent payload (pre-agents save / non-agent model) the worker re-seeds
    // the agent layer to its starting configuration instead of keeping the
    // pre-load run's population.
    if (state.agents) {
      loadMsg.agents = deserializeAgentState(state.agents);
    }

    workerRef.current.postMessage(loadMsg);
  }, [model.properties.boundaryTreatment, model.simulationState, updateProperties, setSimulationState]);

  // F5: Apply dimension override
  const handleApplyDimensions = () => {
    const w = Math.max(1, simWidth);
    const h = Math.max(1, simHeight);
    // 3D Grid CA: also resize depth (the panel shows a Depth field in 3D).
    initWorkerWithDimensions(w, h, is3D ? Math.max(1, simDepth) : undefined);
  };

  // F6: Import image as starting point
  const openImageForMapping = (img: HTMLImageElement) => {
    if (is3dRef.current) {
      // 3D: keep the classic 1px=1cell resize import (the Mapping Cells dialog is
      // a 2D feature; the worker's per-cell importImage is 2D-linear).
      const tmpCanvas = document.createElement('canvas');
      tmpCanvas.width = img.width; tmpCanvas.height = img.height;
      const ctx = tmpCanvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const pixels = new Uint8ClampedArray(ctx.getImageData(0, 0, img.width, img.height).data);
      pendingImageImport.current = pixels;
      pendingImageMapping.current = brushMappingRef.current;
      initWorkerWithDimensions(img.width, img.height);
      return;
    }
    setImageMapImg(img); // 2D: open the Mapping Cells dialog
  };
  const handleImageImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    const img = new Image();
    img.onload = () => openImageForMapping(img);
    img.src = URL.createObjectURL(file);
  };

  // Apply the "Mapping Cells" dialog result. Four combinations of
  // (resize | center) × (colour mapping | manual input mapping).
  const applyImageMapping = (cfg: ImageMappingConfig) => {
    setImageMapImg(null);
    const { cols, rows, pixels, mask, mode, useManual, mappingId, manualState } = cfg;
    if (cols < 1 || rows < 1) return;
    const buildSets = () => {
      const sets: Array<{ attrId: string; value: number }> = [];
      for (const attr of cellAttrsRef.current) {
        const entry = manualState[attr.id];
        if (entry?.enabled) sets.push(...encodeAttrSets(attr, entry.value));
      }
      return sets;
    };
    const maskCells = (offRow: number, offCol: number) => {
      const cells: Array<{ row: number; col: number }> = [];
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        if (mask[r * cols + c]) cells.push({ row: offRow + r, col: offCol + c });
      }
      return cells;
    };
    if (mode === 'resize') {
      if (useManual) {
        pendingManualImport.current = { cells: maskCells(0, 0), sets: buildSets() };
      } else {
        pendingImageImport.current = pixels;
        pendingImageMapping.current = mappingId;
      }
      initWorkerWithDimensions(cols, rows);
    } else {
      // Paste centered — keep the grid, write the region in its centre.
      const offRow = Math.floor((gridHeight.current - rows) / 2);
      const offCol = Math.floor((gridWidth.current - cols) / 2);
      if (useManual) {
        const sets = buildSets();
        if (sets.length > 0) workerRef.current?.postMessage({ type: 'paintManual', cells: maskCells(offRow, offCol), sets, activeViewer: activeViewerRef.current });
      } else {
        workerRef.current?.postMessage({ type: 'importImage', pixels, mappingId, region: { row: offRow, col: offCol, w: cols, h: rows }, activeViewer: activeViewerRef.current }, { transfer: [pixels.buffer] });
      }
    }
  };

  // --- CSV import ----------------------------------------------------------
  // One dialog, two flavours (docs/PLAN_CSV_IMPORT.md):
  //   Agents — a CSV row is an agent → per-agent `pasteAgents` specs (the SAME
  //     worker seam the agent clipboard uses, so it is compile-target-agnostic:
  //     it allocates through the engine primitives and sits in
  //     AGENT_GPU_DEFER_TYPES). "Replace" clears first via `clearAgents`.
  //   Grid  — the CSV IS the board (a line is a grid ROW, a field a COLUMN) →
  //     `importGridValues` into ONE cell attribute; "Resize" reinitialises the
  //     worker first and applies on the next `stepped` (the image-import pattern).
  const openCsvFile = (file: File) => {
    void (async () => {
      try {
        const text = await file.text();
        setCsvImport({ text, name: file.name });
      } catch (err) {
        setCompileError(`CSV import failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  };
  const openCsvFileRef = useRef(openCsvFile);
  openCsvFileRef.current = openCsvFile;
  const handleCsvInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    openCsvFile(file);
  };
  const applyCsvImport = (r: CsvImportResult) => {
    setCsvImport(null);
    const w = workerRef.current;
    if (!w) return;
    if (r.target === 'agents') {
      if (r.agents.length === 0) return;
      if (r.replace) w.postMessage({ type: 'clearAgents', activeViewer: activeViewerRef.current });
      w.postMessage({
        type: 'pasteAgents',
        agents: r.agents,
        torus: boundaryTreatmentRef.current === 'torus',
        activeViewer: activeViewerRef.current,
      });
      return;
    }
    if (r.resize) {
      pendingGridValuesImport.current = { attrId: r.attrId, width: r.width, height: r.height, layer: r.layer, values: r.values };
      initWorkerWithDimensions(r.width, r.height, is3dRef.current ? Math.max(1, gridDepth.current || simDepth) : undefined);
    } else {
      w.postMessage(
        { type: 'importGridValues', attrId: r.attrId, width: r.width, height: r.height, layer: r.layer, values: r.values, activeViewer: activeViewerRef.current },
        { transfer: [r.values.buffer] },
      );
    }
  };

  // Ctrl+V a clipboard image onto the simulator → open the Mapping Cells dialog
  // (same as the Open Image button). Latest-ref so the listener stays cheap.
  const openImageForMappingRef = useRef(openImageForMapping);
  openImageForMappingRef.current = openImageForMapping;
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (!visibleRef.current) return;
      // Don't hijack a paste into a focused form control (matches the cell Ctrl+V
      // keydown guard); let the field paste normally.
      const ae = document.activeElement as HTMLElement | null;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.isContentEditable)) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        const it = items[i]!;
        if (it.type.startsWith('image/')) {
          const file = it.getAsFile();
          if (file) {
            e.preventDefault();
            const img = new Image();
            img.onload = () => openImageForMappingRef.current(img);
            img.src = URL.createObjectURL(file);
            return;
          }
        }
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  // Drag-and-drop plumbing (App.tsx owns the window drop targets and routes by
  // extension): consume the dropped-file CustomEvents. Latest-refs so the
  // once-registered listeners never act on stale closures.
  //  - genesis-load-state-file  → the transport-bar Load State path (adaptDims).
  //  - genesis-open-image-file  → the Map Image to Cells dialog (the Ctrl+V seam).
  //  - genesis-import-preset-file → readPresetFile + addPreset (feature parity
  //    with the Presets block's Import button).
  const applySimulationStateRef2 = useRef<(s: SimulationState, o?: { adaptDims?: boolean }) => void>(() => {});
  applySimulationStateRef2.current = applySimulationState;
  const addPresetRef = useRef(addPreset);
  addPresetRef.current = addPreset;
  useEffect(() => {
    const onStateFile = (e: Event) => {
      const file = (e as CustomEvent).detail?.file as File | undefined;
      if (!file) return;
      void (async () => {
        try {
          const state = await readStateFile(file);
          applySimulationStateRef2.current(state, { adaptDims: true });
        } catch (err) {
          setCompileError(String(err));
        }
      })();
    };
    const onImageFile = (e: Event) => {
      const file = (e as CustomEvent).detail?.file as File | undefined;
      if (!file) return;
      const img = new Image();
      img.onload = () => openImageForMappingRef.current(img);
      img.src = URL.createObjectURL(file);
    };
    const onPresetFile = (e: Event) => {
      const file = (e as CustomEvent).detail?.file as File | undefined;
      if (!file) return;
      void (async () => {
        try {
          addPresetRef.current(await readPresetFile(file));
        } catch (err) {
          setCompileError(`Preset import failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    };
    const onCsvFile = (e: Event) => {
      const file = (e as CustomEvent).detail?.file as File | undefined;
      if (file) openCsvFileRef.current(file);
    };
    window.addEventListener('genesis-load-state-file', onStateFile);
    window.addEventListener('genesis-open-image-file', onImageFile);
    window.addEventListener('genesis-import-preset-file', onPresetFile);
    window.addEventListener('genesis-open-csv-file', onCsvFile);
    return () => {
      window.removeEventListener('genesis-load-state-file', onStateFile);
      window.removeEventListener('genesis-open-image-file', onImageFile);
      window.removeEventListener('genesis-import-preset-file', onPresetFile);
      window.removeEventListener('genesis-open-csv-file', onCsvFile);
    };
  }, []);

  const [leftPanelOpen, setLeftPanelOpen] = useState(true);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  // Which tab the shared right panel shows. 'controls' = the sim controls
  // (brush + layers + indicators); 'experiments' = the Overseer Experiments
  // view. The tab strip is only shown when the Overseer feature is enabled;
  // otherwise the panel is the controls view (as before).
  const [rightPanelTab, setRightPanelTab] = useState<'controls' | 'experiments'>('controls');
  // If the Overseer feature is turned off, fall back to the controls tab so a
  // stale 'experiments' selection can't strand the panel on a hidden view.
  useEffect(() => { if (!overseerEnabled) setRightPanelTab('controls'); }, [overseerEnabled]);
  const [topBarOpen, setTopBarOpen] = useState(true);
  const [bottomBarOpen, setBottomBarOpen] = useState(true);
  // --- Bottom-band collision: lift the capture stack over the transport bar ---
  // The bar and the bottom-right stack share one baseline (they read as one row
  // of chrome), but the bar is CENTRED + content-sized while the stack is
  // right-anchored, so they meet once the canvas gets narrow. MEASURED on an
  // agent model: they touch at a canvas width of 843 px (= barW + 2·(8 px inset
  // + clusterW)) — a 1263 px window with both side panels open, i.e. an ordinary
  // laptop, NOT an absurd width. So it is handled, but CONDITIONALLY: no
  // permanent gap under the cluster, and no magic number — the lift is the
  // measured bar height, applied only while the two actually overlap.
  //
  // The predicate is HORIZONTAL only, so it is stable once lifted (moving the
  // stack up cannot change its left/right edges) — no oscillation.
  const [captureStackLift, setCaptureStackLift] = useState(0);
  useEffect(() => {
    const measure = () => {
      const stack = bottomRightStackRef.current;
      const row = transportRowRef.current;
      if (!stack) return;
      // No bar (collapsed) → nothing to clear.
      if (!row || row.offsetParent === null) { setCaptureStackLift(0); return; }
      const s = stack.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      if (s.width === 0 || r.width === 0) return; // hidden tab — keep the last value
      const overlaps = r.right > s.left && s.right > r.left;
      // 4px = the stack's own inter-element gap, reused as the bar clearance.
      setCaptureStackLift(overlaps ? Math.round(r.height) + 4 : 0);
    };
    // A ResizeObserver can fire on a layout that has not fully settled (a
    // viewport resize observed mid-reflow measured the OLD bar position and
    // left the lift stuck on), so every trigger ALSO re-checks on the next
    // frame. rAF-coalesced, so a resize drag costs one extra measure per frame.
    let raf = 0;
    const measureSoon = () => {
      measure();
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; measure(); });
    };
    measureSoon();
    measureCaptureCollisionRef.current = measureSoon;
    // Observe BOTH sizes (label / collapse changes) AND the container (a panel
    // resize moves the centred bar without changing anyone's size).
    const ro = new ResizeObserver(measureSoon);
    if (canvasAreaRef.current) ro.observe(canvasAreaRef.current);
    if (transportRowRef.current) ro.observe(transportRowRef.current);
    if (bottomRightStackRef.current) ro.observe(bottomRightStackRef.current);
    window.addEventListener('resize', measureSoon);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measureSoon);
      if (measureCaptureCollisionRef.current === measureSoon) measureCaptureCollisionRef.current = null;
      if (raf) cancelAnimationFrame(raf);
    };
    // bottomBarOpen remounts the row, so the observer must re-bind to the new node.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bottomBarOpen, visible]);

  const leftPanelRef = useRef<HTMLDivElement>(null);
  const rightPanelRef = useRef<HTMLDivElement>(null);
  // Remembers panel + bar state before entering F-fullscreen so the toggle
  // restores the user's previous layout (instead of always opening everything).
  const prePanelStateRef = useRef<{ left: boolean; right: boolean; top: boolean; bottom: boolean } | null>(null);

  // Canvas fullscreen = toggle all four bars at once. Shared by the F key and
  // the navbar fullscreen button (via the `genesis-toggle-canvas-fullscreen`
  // event) so both do the same in-app maximize (not a browser-only F11). Gated
  // on visibility (SimulatorView is always-mounted) and no-active-text-field.
  const visibleRef = useRef(visible);
  useEffect(() => { visibleRef.current = visible; }, [visible]);
  const toggleCanvasFullscreen = useCallback(() => {
    const anyOpen = leftPanelOpen || rightPanelOpen || topBarOpen || bottomBarOpen;
    if (anyOpen) {
      prePanelStateRef.current = { left: leftPanelOpen, right: rightPanelOpen, top: topBarOpen, bottom: bottomBarOpen };
      setLeftPanelOpen(false);
      setRightPanelOpen(false);
      setTopBarOpen(false);
      setBottomBarOpen(false);
    } else {
      const prev = prePanelStateRef.current;
      setLeftPanelOpen(prev ? prev.left : true);
      setRightPanelOpen(prev ? prev.right : true);
      setTopBarOpen(prev ? prev.top : true);
      setBottomBarOpen(prev ? prev.bottom : true);
    }
  }, [leftPanelOpen, rightPanelOpen, topBarOpen, bottomBarOpen]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!visibleRef.current) return;
      if (e.key !== 'f' && e.key !== 'F') return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const ae = document.activeElement as HTMLElement | null;
      const tag = ae?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (ae?.isContentEditable ?? false)) return;
      e.preventDefault();
      toggleCanvasFullscreen();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [toggleCanvasFullscreen]);
  useEffect(() => {
    const onEvt = () => { if (visibleRef.current) toggleCanvasFullscreen(); };
    window.addEventListener('genesis-toggle-canvas-fullscreen', onEvt);
    return () => window.removeEventListener('genesis-toggle-canvas-fullscreen', onEvt);
  }, [toggleCanvasFullscreen]);

  const modelAttrs = model.attributes.filter(a => a.isModelAttribute);
  const attrToColorMappings = model.mappings.filter(m => m.isAttributeToColor);
  // Agent Output Mappings: the agent-layer A→C views (the two-layer viewer).
  const agentColorMappings = (model.agentMappings ?? []).filter(m => m.isAttributeToColor);
  const colorToAttrMappings = model.mappings.filter(m => !m.isAttributeToColor);

  return (
    <div className={styles.simulatorLayout}>
      {/* === Left Panel (collapsible) === */}
      {leftPanelOpen && (
        <div className={styles.sidePanel} ref={leftPanelRef}>
          <div className={styles.panelHeader}>
            <span className={styles.panelTitle}>Settings</span>
          </div>
          <div
            className={styles.leftPanelResizeHandle}
            onMouseDown={e => {
              e.preventDefault();
              const panel = leftPanelRef.current;
              if (!panel) return;
              const startX = e.clientX;
              const startW = panel.offsetWidth;
              // Drag below this on release → snap closed. Mirrors the
              // common IDE "drag inward to collapse" gesture. The drag
              // visually clamps a bit lower (40px) so the user sees the
              // panel shrink before the snap fires.
              const COLLAPSE_THRESHOLD = 100;
              const DRAG_MIN = 40;
              let lastW = startW;
              const onMove = (ev: MouseEvent) => {
                lastW = Math.max(DRAG_MIN, startW + (ev.clientX - startX));
                panel.style.width = lastW + 'px';
                panel.style.minWidth = lastW + 'px';
              };
              const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                if (lastW < COLLAPSE_THRESHOLD) {
                  // Snap-close. The panel is unmounted next render, so
                  // any inline width/minWidth set during the drag goes
                  // with it — re-opening starts from the CSS default.
                  setLeftPanelOpen(false);
                }
              };
              document.addEventListener('mousemove', onMove);
              document.addEventListener('mouseup', onUp);
            }}
          />

          <div className={styles.panelBody}>
          <div className={styles.sectionTitle}>Actions</div>
          <button className={styles.controlButton} onClick={handleRecompile}>Recompile</button>

          <hr className={styles.divider} />
          <div className={styles.sectionTitle}>Grid Dimensions</div>
          <div className={styles.fieldRow}>
            <span className={styles.statLabel}>W</span>
            <NumberField className={styles.brushInput} style={{ flex: 1, width: 0, minWidth: 0 }} min={1} integer value={simWidth}
              onNumber={setSimWidth} />
            <span className={styles.statLabel}>H</span>
            <NumberField className={styles.brushInput} style={{ flex: 1, width: 0, minWidth: 0 }} min={1} integer value={simHeight}
              onNumber={setSimHeight} />
            {is3D && <>
              <span className={styles.statLabel} title="Layers (3D depth)">D</span>
              <NumberField className={styles.brushInput} style={{ flex: 1, width: 0, minWidth: 0 }} min={1} integer value={simDepth}
                onNumber={setSimDepth} />
            </>}
          </div>
          <button className={styles.controlButton} onClick={handleApplyDimensions}>Resize</button>
          <div className={styles.fieldRow} style={{ marginTop: 6 }}>
            <span className={styles.statLabel} style={{ flex: 1 }} title="How neighbors outside the grid are handled">Boundary</span>
            <select
              className={styles.brushInput}
              style={{ flex: 1, width: 0, minWidth: 0 }}
              value={model.properties.boundaryTreatment}
              onChange={e => updateProperties({ boundaryTreatment: e.target.value as 'torus' | 'constant' })}
            >
              <option value="torus">Torus (wrap)</option>
              <option value="constant">Constant</option>
            </select>
          </div>

          <hr className={styles.divider} />
          <div className={styles.sectionTitle}>Presets</div>
          {(model.presets || []).length === 0 && (
            <div style={{ fontSize: 11, color: '#888', padding: '4px 0 6px' }}>
              No presets yet. Tune the model attributes below and save a snapshot.
            </div>
          )}
          <div data-reorder-list>
          {(model.presets || []).map((p, i) => {
            const hasGrid = p.state.width != null;
            const presetsArr = model.presets || [];
            const isDragging = presetReorder.dragState?.id === p.id;
            const srcIdx = presetReorder.dragState ? presetsArr.findIndex(x => x.id === presetReorder.dragState!.id) : -1;
            const showBefore = presetReorder.dragState?.overIdx === i && srcIdx !== i && srcIdx !== i - 1;
            const showAfter = presetReorder.dragState?.overIdx === presetsArr.length && i === presetsArr.length - 1 && srcIdx !== i;
            return (
              <div key={p.id} data-reorder-row className={`${styles.fieldRow} ${isDragging ? styles.draggingRow : ''} ${showBefore ? styles.dropIndicatorBefore : ''} ${showAfter ? styles.dropIndicatorAfter : ''}`} title={p.description || (hasGrid ? `Includes grid (${p.state.width}\u00D7${p.state.height})` : 'Parameters only')}>
                <span className={styles.statLabel} style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.name}{hasGrid ? ' \u25C9' : ''}
                </span>
                <button className={styles.controlButton} style={{ padding: '2px 8px', flex: 'none' }} onClick={() => handleLoadPreset(p)}>Load</button>
                {/* The per-row actions (overwrite / rename / duplicate / export / delete)
                    live behind this "…" menu — five inline icon buttons crowded the row. */}
                <button
                  className={styles.controlButton}
                  style={{ padding: '2px 6px', flex: 'none' }}
                  data-sim-overlay
                  title="More preset actions"
                  onClick={e => {
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    // Drop below the trigger, flipping above when the (5-item)
                    // menu wouldn't fit under it.
                    const vh = window.innerHeight || 0;
                    const below = r.bottom + 4;
                    const y = vh > 0 && below + PRESET_MENU_H > vh - 8
                      ? Math.max(8, r.top - 4 - PRESET_MENU_H)
                      : below;
                    setPresetMenu(cur => cur?.id === p.id ? null : { id: p.id, x: r.right, y });
                  }}
                >&hellip;</button>
                <button className={styles.dragHandle} title="Drag to reorder" onPointerDown={presetReorder.startDrag(p.id)} onClick={e => e.stopPropagation()}>&#x22EE;&#x22EE;</button>
              </div>
            );
          })}
          </div>
          {/* The one open "…" preset menu. position:fixed (measured from the
              trigger) so the scrolling panel body can't clip it; dismissed by a
              capture-phase outside pointerdown or Escape (see the presetMenu effect). */}
          {presetMenu && (() => {
            const p = (model.presets || []).find(x => x.id === presetMenu.id);
            if (!p) return null;
            const close = () => setPresetMenu(null);
            const item = (label: string, title: string, onClick: () => void, danger = false) => (
              <button
                className={`${styles.presetMenuItem} ${danger ? styles.presetMenuItemDanger : ''}`}
                data-sim-overlay
                title={title}
                onClick={() => { close(); onClick(); }}
              >{label}</button>
            );
            return (
              <div
                ref={presetMenuRef}
                className={styles.presetMenu}
                data-sim-overlay
                style={{ left: Math.max(8, presetMenu.x - PRESET_MENU_W), top: presetMenu.y }}
              >
                {item('\u{1F4BE}  Overwrite with current state', 'Replace this preset with the current simulation state', () => handleOverwritePreset(p))}
                {item('✎  Rename…', 'Edit this preset’s name and description', () => setPresetToRename(p))}
                {item('⧉  Duplicate', 'Add a copy of this preset', () => duplicatePreset(p.id))}
                {item('⤓  Export (.gcapreset)', 'Download this preset as a .gcapreset file', () => handleExportPreset(p))}
                {item('✕  Delete', 'Remove this preset from the model', () => handleDeletePreset(p), true)}
              </div>
            );
          })()}
          <button className={styles.controlButton} onClick={() => setPresetDialogOpen(true)}>
            + Save Current as Preset&hellip;
          </button>
          <button className={styles.controlButton} title="Import a preset from a .gcapreset file (added to this model's presets)"
            onClick={() => presetFileInputRef.current?.click()}>
            Import Preset&hellip;
          </button>
          <input ref={presetFileInputRef} type="file" accept=".gcapreset,.json" style={{ display: 'none' }} onChange={handleImportPresetFile} />

          {modelAttrs.length > 0 && (
            <>
              <hr className={styles.divider} />
              <div className={styles.sectionTitle}>Model Attributes</div>
              <button className={styles.controlButton} onClick={handleResetModelAttrs}>
                Reset to Default
              </button>
              {modelAttrs.map(a => (
                <div key={a.id} className={styles.fieldRow}>
                  <span className={styles.statLabel} style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={a.description || a.name}>{a.name}</span>
                  {a.type === 'bool' ? (
                    <input type="checkbox" checked={(runtimeModelAttrs[a.id] ?? 0) === 1}
                      onChange={e => handleModelAttrChange(a.id, e.target.checked ? 1 : 0)} />
                  ) : a.type === 'integer' ? (
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center', flex: 2, minWidth: 0 }}>
                      {a.hasBounds && a.min != null && a.max != null && (
                        <input type="range" min={a.min} max={a.max} step={1}
                          value={runtimeModelAttrs[a.id] ?? 0}
                          onChange={e => handleModelAttrChange(a.id, Math.round(Number(e.target.value)))}
                          style={{ flex: 1, minWidth: 0, width: '100%' }} />
                      )}
                      <NumberField className={styles.brushInput} integer
                        min={a.hasBounds && a.min != null ? a.min : undefined}
                        max={a.hasBounds && a.max != null ? a.max : undefined}
                        value={runtimeModelAttrs[a.id] ?? 0}
                        onNumber={n => handleModelAttrChange(a.id, n)} />
                    </div>
                  ) : a.type === 'float' ? (
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center', flex: 2, minWidth: 0 }}>
                      {a.hasBounds && a.min != null && a.max != null && (
                        <input type="range" min={a.min} max={a.max} step={(a.max - a.min) / 100}
                          value={runtimeModelAttrs[a.id] ?? 0}
                          onChange={e => handleModelAttrChange(a.id, Number(e.target.value))}
                          style={{ flex: 1, minWidth: 0, width: '100%' }} />
                      )}
                      <NumberField className={styles.brushInput}
                        min={a.hasBounds && a.min != null ? a.min : undefined}
                        max={a.hasBounds && a.max != null ? a.max : undefined}
                        value={runtimeModelAttrs[a.id] ?? 0}
                        onNumber={n => handleModelAttrChange(a.id, n)} />
                    </div>
                  ) : a.type === 'tag' ? (
                    <select className={styles.brushInput} style={{ width: 'auto' }}
                      value={runtimeModelAttrs[a.id] ?? 0}
                      onChange={e => handleModelAttrChange(a.id, Number(e.target.value))}>
                      {(a.tagOptions || []).map((t, i) => (
                        <option key={i} value={i}>{t}</option>
                      ))}
                      {(!a.tagOptions || a.tagOptions.length === 0) && <option value={0}>(no tags)</option>}
                    </select>
                  ) : a.type === 'color' ? (
                    // Live-tunable colour: the four runtime slots (id_r/_g/_b/_a)
                    // are the SAME keys `modelAttrSlotKeys` reserves, so a write
                    // here lands where the compiled code reads. `_a` defaults to
                    // opaque for a model saved before alpha existed.
                    <ColorField
                      value={rgbaToHex({
                        r: runtimeModelAttrs[a.id + '_r'] ?? 128,
                        g: runtimeModelAttrs[a.id + '_g'] ?? 128,
                        b: runtimeModelAttrs[a.id + '_b'] ?? 128,
                        a: runtimeModelAttrs[a.id + '_a'] ?? OPAQUE,
                      })}
                      onChange={hex => {
                        const c = hexToRgba(hex);
                        handleModelAttrChange(a.id + '_r', c.r);
                        handleModelAttrChange(a.id + '_g', c.g);
                        handleModelAttrChange(a.id + '_b', c.b);
                        handleModelAttrChange(a.id + '_a', c.a);
                      }}
                      style={{ width: 50, height: 24 }}
                    />
                  ) : a.type === 'neighborIndex' ? (
                    // NeighborIndex is stored on GPU/WASM as a packed (dr, dc) i32.
                    // Reuses the modeler's NeighborIndexValuePicker: when the
                    // attribute has a `neighborhoodHintId`, the picker shows a
                    // clickable grid (one cell per offset) so the user just picks
                    // a position; otherwise it falls back to dr/dc number inputs.
                    // The model-side `neighborhoodHintId` is read-only here (the
                    // simulator doesn't mutate model definitions); the user
                    // changes it in the Attributes panel of the modeler.
                    (() => {
                      const raw = runtimeModelAttrs[a.id] ?? 0;
                      const value = raw === INVALID_NI ? 0 : (raw | 0);
                      const is3d = model.properties.dimension === '3d' && (model.properties.gridDepth ?? 1) > 1;
                      const hint = a.neighborhoodHintId
                        ? (model.neighborhoods.find(n => n.id === a.neighborhoodHintId) ?? null)
                        : null;
                      const dec = is3d ? unpackNI3(value) : { ...unpackNI(value), dl: 0 };
                      return (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 2, minWidth: 0, alignItems: 'flex-end' }}>
                          <NeighborIndexValuePicker
                            value={value}
                            hint={hint}
                            is3d={is3d}
                            onChange={packed => handleModelAttrChange(a.id, packed)}
                            cellSize={18}
                          />
                          <span style={{ fontSize: 10, color: '#7a8a9a' }}>
                            (dr {dec.dr}, dc {dec.dc}{is3d ? `, dl ${(dec as { dl?: number }).dl ?? 0}` : ''})
                          </span>
                        </div>
                      );
                    })()
                  ) : a.type === 'lookupTable' ? (
                    // Lookup Tables are too wide for the single-row layout. The
                    // matrix editor renders below the label and dispatches an
                    // updateLookupTable worker message (live-tuned during sim).
                    <div style={{ flex: 2, minWidth: 0 }}>
                      {(() => {
                        const multi = isMultiAxisTable(a);
                        const rowLabels = multi ? [] : resolveKeyLabels(a.rowKeySource, model);
                        const colLabels = multi ? [] : resolveKeyLabels(a.colKeySource, model);
                        return multi || (rowLabels.length > 0 && colLabels.length > 0) ? (
                          <LookupTableEditor
                            attribute={a}
                            rowLabels={rowLabels}
                            colLabels={colLabels}
                            valueTagOptions={resolveValueTagOptions(a, model)}
                            axesResolved={multi ? resolveAxes(a, model) : undefined}
                            compact
                            onChange={changes => handleInteractionTableEdit(a.id, changes.tableValues, changes.symmetric, changes.tableData, changes.tableRoll)}
                          />
                        ) : (
                          <div style={{ color: '#888', fontSize: '0.62rem' }}>
                            Set this table's row and column key sources to populate it.
                          </div>
                        );
                      })()}
                    </div>
                  ) : (
                    <NumberField className={styles.brushInput}
                      value={runtimeModelAttrs[a.id] ?? 0}
                      onNumber={n => handleModelAttrChange(a.id, n)} />
                  )}
                </div>
              ))}
            </>
          )}

          {compileError && (
            <>
              <hr className={styles.divider} />
              <div className={styles.error}>{compileError}</div>
            </>
          )}

          <hr className={styles.divider} />
          <button className={styles.controlButton} onClick={() => setShowCode(!showCode)}>
            {showCode ? 'Hide' : 'Show'} Code
          </button>
          {showCode && (
            <div className={styles.codePanel}>
              <button className={styles.copyButton} onClick={handleCopyCode}>Copy</button>
              <pre className={styles.codeBlock}>{compiledCode || '(no compiled code)'}</pre>
            </div>
          )}
          </div>
        </div>
      )}

      {/* === Canvas Area === */}
      <div className={styles.canvasArea} ref={canvasAreaRef}>
        {compileError && (
          <div className={styles.errorBanner} data-sim-overlay>
            {compileError}
          </div>
        )}
        {/* Settings panel ear — sits at the canvas's left edge. We render it
            inside canvasArea (not inside .sidePanel, which has overflow:hidden
            and would clip a sticking-out ear) so it works in both states.
            Glyph + handler swap based on whether the panel is open. */}
        <button
          className={styles.panelExpandBtn}
          style={{ left: 0 }}
          onClick={() => setLeftPanelOpen(v => !v)}
          title={leftPanelOpen ? 'Close settings' : 'Open settings'}
          data-sim-overlay
        >{leftPanelOpen ? '‹' : '›'}</button>
        <canvas ref={canvasRef} className={styles.canvas} style={is3D ? { display: 'none' } : undefined} />
        {/* Phase C — 3D agent free-mode direct render: the worker composites the
            WGSL sphere impostors into a canvas we imperatively append here, UNDER
            the gl3d canvas (z-index 1 vs the gl canvas's 2). Empty until an eligible
            3D agents-only model attaches; hidden in 2D. pointer-events:none so the
            gl canvas (top) keeps orbit/pan/zoom/brush. */}
        <div ref={agentSphereLayerRef} style={{ position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'none', display: is3D ? undefined : 'none' }} />
        {/* L1 — 3D CA-grid free-mode voxel render: same seam, the worker draws the
            WGSL instanced cubes into a canvas we append here, UNDER the gl3d canvas.
            Mutually exclusive with the sphere layer above (the L1 gate excludes
            agent models), so the two never overlap. */}
        <div ref={voxelLayerRef} style={{ position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'none', display: is3D ? undefined : 'none' }} />
        {/* 3D Grid CA: WebGL2 voxel canvas, shown only for 3D models. Its own
            pointer handlers (orbit/zoom/pan + colour-id pick) are attached in a
            dedicated effect since draw() routes here via is3dRef. In 3D it is
            absolutely positioned (z-index 2) so it composites OVER the sphere
            layer (Phase C); the transparent clear in overlays-only mode lets the
            spheres show through. */}
        <canvas ref={glCanvasRef} className={styles.canvas} style={is3D ? { position: 'absolute', inset: 0, zIndex: 2 } : { display: 'none' }} />

        {/* Cursor overlay layer (2D) — two dedicated canvases above the scene:
            `cursorHl` = coloured highlight rings (normal blending), `cursorNeg` =
            white brush silhouettes composited with mix-blend-mode: difference
            (the negative-cursor trick, done by the compositor). Cursor movement
            redraws ONLY these, never the scene canvas — see drawCursorLayer. */}
        <canvas ref={cursorHlCanvasRef} className={styles.canvas}
          style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none', display: is3D ? 'none' : undefined }} />
        <canvas ref={cursorNegCanvasRef} className={styles.canvas}
          style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none', mixBlendMode: 'difference', display: is3D ? 'none' : undefined }} />

        {/* Bottom-right stack — the stats readout ABOVE the capture cluster, in
            ONE bottom-anchored flex column so the two can never overlap however
            many stat lines a model produces (agent models add several).
            `data-sim-overlay` on the wrapper covers every descendant, so a click
            anywhere in here can never fall through and paint the canvas. */}
        <div
          className={styles.bottomRightStack}
          ref={bottomRightStackRef}
          style={captureStackLift ? { bottom: `calc(var(--space-3) + ${captureStackLift}px)` } : undefined}
          data-sim-overlay
        >
        <div className={styles.statsOverlay}>
          <span>Gen {generation}</span>
          <span>{gridWidth.current || simWidth}&times;{gridHeight.current || simHeight}</span>
          <span>{actualFps} FPS</span>
          <span>{actualGps} g/s</span>
          {(compileTargetInfo.gridCellsOn || compileTargetInfo.agents) && (() => {
            const failed = compileTargetInfo.grid === 'WebGPU' && gridWebgpuStatusRef.current === 'failed';
            const parts: string[] = [];
            if (compileTargetInfo.gridCellsOn) parts.push(failed ? 'WebGPU✗' : compileTargetInfo.grid);
            if (compileTargetInfo.agents) {
              const a = compileTargetInfo.agents === 'webgpu' ? 'WebGPU' : compileTargetInfo.agents === 'wasm' ? 'WASM' : 'JS';
              parts.push(`agents ${a}`);
            }
            return (
              <span
                style={failed ? { color: '#e0a050' } : undefined}
                title={failed
                  ? 'The selected WebGPU grid target failed to initialise on this device — the simulation falls back to JavaScript where possible (see the error notice). Change the Compile Target in Properties → Execution.'
                  : 'Compile target(s) in use — selected in Properties → Execution. Unsupported features clamp to JavaScript automatically.'}
              >{'⚙'} {parts.join(' · ')}</span>
            );
          })()}
          {sieActiveRef.current !== null && (
            sieActiveRef.current >= 0 ? (
              <span title="Skip Isolated Empty Cells — cells processed per generation (active) out of the whole grid">
                {'◩'} {sieActiveRef.current.toLocaleString()} active
                {(() => { const t = (gridWidth.current || simWidth) * (gridHeight.current || simHeight) * (gridDepth.current || 1); return t > 0 ? ` (${((100 * sieActiveRef.current) / t).toFixed(1)}%)` : ''; })()}
              </span>
            ) : (
              <span style={{ color: '#e0a050' }} title="Skip Isolated Empty Cells is enabled but NOT engaged (unsupported combination or incomplete config) — the full grid is being processed.">
                {'◩'} skip-empty inactive
              </span>
            )
          )}
          <HoverCoordsChip />
          {recording && (
            <span style={{ color: '#e05050' }}>
              {'\u23FA'} REC {recordFrameCount}f
              {/* Dropped frames: the streaming encoder refuses a frame when its
                  queue is full (dense content encodes slower than it is captured).
                  Never silent \u2014 the counter is the only place the user can see it. */}
              {recordDroppedCount > 0 && <span style={{ color: '#e0a050' }}> {'\u00B7'} {recordDroppedCount} dropped</span>}
              {/* "Never skip" mode: the step pipeline is being held back so no
                  frame is lost. Says so explicitly \u2014 a deliberately slowed
                  simulation must never read as a hang. */}
              {recordThrottled && <span style={{ color: '#e8a13a' }}> {'\u23F3'} waiting for encoder</span>}
            </span>
          )}
          {isAgentModel && (agentsRef.current || agentDirectRenderActiveRef.current) && <span title="Live agents">{'\u25CF'} {agentDirectRenderActiveRef.current ? agentLiveCountRef.current : (agentsRef.current?.liveCount ?? 0)} agents</span>}
        </div>

        {/* \u2500\u2500 Capture cluster: screenshot + record + the settings chip \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
            Capture is OUTPUT, so it lives on the right edge with the readouts
            rather than inline with the transport bar's playback (time) controls.
            Only \uD83D\uDCF7 and \u23FA are pressed during a session; every configuration sits
            behind the chip's popover, so the bar never carries (or reflows) it. */}
        {(() => {
          // `recordFormat` can never be 'webm' without WebCodecs (the state
          // initialiser already falls back), but startRecording re-checks
          // defensively \u2014 mirror that here so the chip can never advertise a
          // format the recorder would not actually use.
          const effWebm = recordFormat === 'webm' && webmAvailable;
          const areaLabel = recordScope === 'simulation' ? 'sim' : 'view';
          const chipParts = [
            effWebm ? 'WebM' : 'GIF',
            // In 3D the scene fills the frame \u2014 there is no separate area to name.
            ...(is3D ? [] : [areaLabel]),
            // Quality is a WebM-only concept (GIF has no keyframe structure).
            ...(effWebm ? [recordQuality === 'archival' ? 'Arch' : 'Std'] : []),
          ];
          // Every setting is frozen from Start to Stop (the encoder requires it),
          // so while recording the chip is a read-only readout of what is running.
          const settingsLocked = recording || encodingWebM;
          return (
            <div className={styles.captureCluster}>
              <button
                className={styles.transportBtn}
                onClick={handleScreenshot}
                title={`Screenshot PNG${is3D ? '' : ` (${screenshotScope === 'simulation' ? 'simulation' : 'current view'})`} \u2014 settings in the chip to the right`}
              >{'\uD83D\uDCF7'}</button>
              {!recording ? (
                <button
                  className={styles.transportBtn}
                  onClick={startRecording}
                  disabled={encodingWebM}
                  title={encodingWebM ? 'Encoding WebM\u2026' : `Record ${effWebm ? 'WebM' : 'GIF'} (${!is3D && recordScope === 'simulation' ? 'simulation' : 'current view'}) \u2014 settings in the chip to the right`}
                  style={{ color: '#e05050' }}
                >{'\u23FA'}</button>
              ) : (
                <button
                  className={styles.transportBtn}
                  onClick={stopRecording}
                  title={`Stop & Save ${effWebm ? 'WebM' : 'GIF'} (${!is3D && recordScope === 'simulation' ? 'simulation' : 'current view'})${recordDroppedCount > 0 ? ` \u2014 ${recordDroppedCount} frame(s) skipped so far` : ''}${recordThrottled ? ' \u2014 the simulation is being held back while the encoder catches up' : ''}`}
                  style={{ color: '#e05050' }}
                >
                  {'\u23F9'} {recordFrameCount}
                  {recordDroppedCount > 0 && <span style={{ color: '#e0a050' }}>{' \u2212'}{recordDroppedCount}</span>}
                  {recordThrottled ? ' \u23F3' : ''}
                </button>
              )}

              {/* The chip = readout + popover trigger. Its OWN wrapper (like the
                  FPS/G-F readouts) so hovering \uD83D\uDCF7 / \u23FA does not pop the settings
                  open, and so the popover anchors to the chip itself. */}
              <div
                className={styles.captureChipWrap}
                ref={overlayPopup === 'capture' ? overlayPopupWrapRef : undefined}
                onPointerEnter={() => { if (!settingsLocked) setOverlayPopup('capture'); }}
                onPointerLeave={() => setOverlayPopup(p => (p === 'capture' ? null : p))}
              >
                <button
                  className={styles.captureChip}
                  disabled={settingsLocked}
                  onClick={() => setOverlayPopup(p => (p === 'capture' ? null : 'capture'))}
                  title={settingsLocked
                    ? 'Capture settings are locked for the whole run \u2014 the encoder needs the format, area and quality to hold from Start to Stop.'
                    : 'Capture settings (screenshot area, recording format / area / quality / overload) \u2014 hover or click'}
                >{chipParts.join(' \u00B7 ')} {'\u25BE'}</button>

                {overlayPopup === 'capture' && !settingsLocked && (
                  <div className={styles.capturePopover} data-sim-overlay>
                    <div className={styles.capturePopTitle}>Capture</div>

                    <div className={`${styles.captureRow} ${is3D ? styles.captureRowDisabled : ''}`}>
                      <span>Screenshot area</span>
                      {captureSegment(
                        [{ label: 'View', value: 'view' as RecordScope }, { label: 'Simulation', value: 'simulation' as RecordScope }],
                        is3D ? 'view' : screenshotScope,
                        setScreenshotScope,
                        is3D,
                      )}
                    </div>
                    {is3D && <div className={styles.captureWhy}>A 3D scene fills the frame \u2014 there is no separate simulation crop.</div>}

                    <div className={styles.captureSep} />

                    <div className={styles.captureRow}>
                      <span>Record format</span>
                      {captureSegment(
                        [{ label: 'WebM', value: 'webm' as RecordFormat, disabled: !webmAvailable }, { label: 'GIF', value: 'gif' as RecordFormat }],
                        effWebm ? 'webm' : 'gif',
                        setRecordFormat,
                        false,
                      )}
                    </div>
                    {!webmAvailable && <div className={styles.captureWhy}>WebM needs WebCodecs &mdash; not available in this browser. GIF is 256 colours, max 512 px, and keeps every frame in memory.</div>}

                    <div className={`${styles.captureRow} ${is3D ? styles.captureRowDisabled : ''}`}>
                      <span>Record area</span>
                      {captureSegment(
                        [{ label: 'View', value: 'view' as RecordScope }, { label: 'Simulation', value: 'simulation' as RecordScope }],
                        is3D ? 'view' : recordScope,
                        setRecordScope,
                        is3D,
                      )}
                    </div>
                    <div className={styles.captureWhy}>{is3D
                      ? 'A 3D scene fills the frame &mdash; there is no separate simulation crop.'
                      : 'Simulation: the whole grid / world framed to fit, independent of your zoom & pan. View: the display canvas exactly as shown.'}</div>

                    <div className={styles.captureSep} />

                    <div className={`${styles.captureRow} ${effWebm ? '' : styles.captureRowDisabled}`}>
                      <span>Quality</span>
                      {captureSegment(
                        [{ label: 'Standard', value: 'standard' as RecordQuality }, { label: 'Archival', value: 'archival' as RecordQuality }],
                        recordQuality,
                        setRecordQuality,
                        !effWebm,
                      )}
                    </div>
                    <div className={styles.captureWhyStack}>
                      <div className={`${styles.captureWhy} ${effWebm ? '' : styles.captureWhyHidden}`}>Standard: a keyframe every 30 frames &mdash; ~6&times; smaller and ~3&times; faster, so the run stays closer to full speed (scrubbing lands on 30-frame boundaries). Archival: every frame independently decodable, for frame-by-frame analysis.</div>
                      <div className={`${styles.captureWhy} ${effWebm ? styles.captureWhyHidden : ''}`}>GIF has no keyframe structure &mdash; WebM only.</div>
                    </div>

                    <div className={`${styles.captureRow} ${effWebm ? '' : styles.captureRowDisabled}`}>
                      <span>If the encoder lags</span>
                      {captureSegment(
                        [{ label: 'Skip frames', value: 'drop' as RecordOverload }, { label: 'Never skip', value: 'lossless' as RecordOverload }],
                        recordOverload,
                        setRecordOverload,
                        !effWebm,
                      )}
                    </div>
                    <div className={styles.captureWhyStack}>
                      <div className={`${styles.captureWhy} ${effWebm ? '' : styles.captureWhyHidden}`}>Skip frames: the simulation keeps full speed and the frames it could not encode are left out (counted next to REC). Never skip: every captured frame is encoded and the simulation is held back until the encoder catches up.</div>
                      <div className={`${styles.captureWhy} ${effWebm ? styles.captureWhyHidden : ''}`}>GIF buffers every frame; nothing can fall behind.</div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })()}
        </div>

        {/* Author-written usage instructions \u2014 pill + dismissible card (only when
            the model carries properties.instructions). display:contents wrapper
            so the outside-pointerdown dismissal treats pill+card as one region. */}
        {instructionsText && !hideInstructionsPill && (
          <div ref={instructionsRef2} style={{ display: 'contents' }}>
            <button
              className={styles.instructionsBtn}
              data-sim-overlay
              onClick={() => setShowInstructions(v => !v)}
              title="Usage instructions written by this model's author"
            >{'\u24D8'} Instructions</button>
            {showInstructions && (
              <div className={styles.instructionsPopover} data-sim-overlay>
                <div className={styles.instructionsHeader}>
                  <span>Instructions {'\u2014'} {model.properties.name || 'this model'}</span>
                  <button className={styles.instructionsClose} onClick={() => setShowInstructions(false)} title="Close (Esc)">&#x2715;</button>
                </div>
                <div className={styles.instructionsBody}>{instructionsText}</div>
              </div>
            )}
          </div>
        )}

        {/* Bond-Graph Agents brush + the Layers toggles now live DOCKED in the
            right side panel (req 4) \u2014 see the "Agents" rightPanelSection below. */}

        {/* Bond-Graph Agents \u2014 agent inspector popover (on-demand getAgentState). */}
        {/* Agent inspectors \u2014 several pinned popovers (draggable, closable, with
            Close all) plus the transient sweep one. Same interaction model as
            the cell inspect popovers; fed by both the 2D and 3D pick paths. */}
        {agentPopovers.map(p => (
          <InspectAgentPopover
            key={p.id}
            popover={p}
            state={agentStatesRef.current.get(p.id) ?? null}
            agentAttributes={model.agentAttributes ?? []}
            bondAttributes={model.bondAttributes ?? []}
            capProfile={agentCapProfile}
            focused={focusedAgentPopoverId === p.id}
            totalOpen={agentPopovers.length}
            following={followAgentId === p.id}
            onToggleFollow={() => setFollowAgent(followAgentIdRef.current === p.id ? null : p.id)}
            onClose={() => closeAgentPopover(p.id)}
            onCloseAll={closeAllAgentPopovers}
            onFocus={() => setFocusedAgentPopoverId(p.id)}
            onDragEnd={(x, y) => setAgentPopovers(prev => prev.map(pp => (pp.id === p.id ? { ...pp, x, y } : pp)))}
          />
        ))}
        {agentSweepPopover && !agentPopovers.some(p => p.id === agentSweepPopover.id) && (
          <InspectAgentPopover
            key={`sweep-${agentSweepPopover.id}`}
            popover={agentSweepPopover}
            state={agentStatesRef.current.get(agentSweepPopover.id) ?? null}
            agentAttributes={model.agentAttributes ?? []}
            bondAttributes={model.bondAttributes ?? []}
            capProfile={agentCapProfile}
            transient
            focused={false}
            totalOpen={agentPopovers.length + 1}
            onClose={clearAgentSweep}
            onCloseAll={closeAllAgentPopovers}
            onFocus={() => {}}
            onDragEnd={() => {}}
          />
        )}

        {/* Bond-Graph Agents \u2014 transient engine-notice toast (e.g. agentOverflow). */}
        {agentNotice && (
          <div
            data-sim-overlay
            style={{
              position: 'absolute', left: '50%', top: 54, transform: 'translateX(-50%)',
              background: 'rgba(232, 161, 58, 0.95)', color: '#0d1117',
              padding: '6px 14px', borderRadius: 6,
              fontSize: '0.78rem', fontWeight: 500,
              boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
              zIndex: 21, pointerEvents: 'none',
              display: 'flex', alignItems: 'center', gap: 8,
            }}
          >
            <span style={{ fontSize: '0.95rem' }}>{'\u26a0'}</span>
            <span>{agentNotice}</span>
          </div>
        )}

        {/* Top overlay: small attached ear (its own pill) + viewer bar pill,
            wrapped together so the ear reads as a separate widget adjacent to
            the bar, not as one of the bar's tabs. Chevrons are inline SVGs so
            the up/down pair is pixel-identical. */}
        {(attrToColorMappings.length > 0 || agentColorMappings.length > 0) && (
          <div className={styles.viewerBarRow} data-sim-overlay>
            <button
              className={styles.barAttachedEar}
              onClick={() => setTopBarOpen(v => !v)}
              title={topBarOpen ? 'Hide viewer bar' : 'Show viewer bar'}
            >{topBarOpen ? <ChevronUpIcon /> : <ChevronDownIcon />}</button>
            {topBarOpen && (
              <div className={styles.viewerBar} style={{ flexWrap: 'wrap' }}>
                {attrToColorMappings.length > 0 && (<>
                  {/* When both layers have views, label this row "Cells" \u2014 the
                      two-layer viewer selection. */}
                  <span className={styles.viewerBarLabel}>{agentColorMappings.length > 0 ? `Cells (A${'\u2192'}C):` : `Output Mapping (A${'\u2192'}C):`}</span>
                  {attrToColorMappings.map(m => (
                    <button
                      key={m.id}
                      className={`${styles.viewerTab} ${activeViewer === m.id ? styles.viewerTabActive : ''}`}
                      onClick={() => setActiveViewer(m.id)}
                      title={m.description || undefined}
                    >
                      {m.name}
                    </button>
                  ))}
                </>)}
                {agentColorMappings.length > 0 && (<>
                  <span className={styles.viewerBarLabel} style={{ marginLeft: attrToColorMappings.length > 0 ? 12 : 0 }}>Agents (A{'\u2192'}C):</span>
                  {agentColorMappings.map(m => (
                    <button
                      key={m.id}
                      className={`${styles.viewerTab} ${activeAgentViewer === m.id ? styles.viewerTabActive : ''}`}
                      onClick={() => setActiveAgentViewer(m.id)}
                      title={m.description || undefined}
                    >
                      {m.name}
                    </button>
                  ))}
                </>)}
              </div>
            )}
          </div>
        )}

        {/* End-condition pause notice (informational, not an error) */}
        {endConditionNotice && (
          <div
            data-sim-overlay
            style={{
              position: 'absolute', left: '50%', top: 54, transform: 'translateX(-50%)',
              background: 'rgba(76, 201, 240, 0.95)', color: '#0d1117',
              padding: '6px 14px', borderRadius: 6,
              fontSize: '0.78rem', fontWeight: 500,
              boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
              zIndex: 20, pointerEvents: 'none',
              display: 'flex', alignItems: 'center', gap: 8,
            }}
            title="Simulation paused by a user-defined stop condition"
          >
            <span style={{ fontSize: '0.95rem' }}>&#9432;</span>
            <span>Simulation paused by user-defined stop condition &mdash; {endConditionNotice}</span>
          </div>
        )}

        {/* Bottom overlay: attached ear pill + transport bar pill in a flex
            wrapper. Ear visually adjacent to (and separate from) the bar. */}
        <div className={styles.transportBarRow} ref={transportRowRef} data-sim-overlay>
          <button
            className={styles.barAttachedEar}
            onClick={() => setBottomBarOpen(v => !v)}
            title={bottomBarOpen ? 'Hide transport bar' : 'Show transport bar'}
          >{bottomBarOpen ? <ChevronDownIcon /> : <ChevronUpIcon />}</button>
          {bottomBarOpen && (<>
        <div className={styles.transportBar}>
          {/* Save/Load state */}
          <button className={styles.transportBtn} onClick={handleSaveState} title="Save State (.gcastate)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
              <polyline points="17 21 17 13 7 13 7 21"/>
              <polyline points="7 3 7 8 15 8"/>
            </svg>
          </button>
          <button className={styles.transportBtn} onClick={() => stateFileInputRef.current?.click()} title="Load State (.gcastate)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
          </button>
          <input ref={stateFileInputRef} type="file" accept=".gcastate" style={{ display: 'none' }} onChange={handleLoadState} />
          <div className={styles.transportDivider} />

          {/* Speed readouts \u2014 FPS and Gens/Frame sit TOGETHER: they are the same
              kind of setting (both open a vertical-slider popover) and used to be
              at opposite ends of the bar with the capture controls between them. */}
          <div
            className={styles.transportSpeed}
            ref={overlayPopup === 'fps' ? overlayPopupWrapRef : undefined}
            data-sim-overlay
            onPointerEnter={() => setOverlayPopup('fps')}
            onPointerLeave={() => setOverlayPopup(p => (p === 'fps' ? null : p))}
          >
            <button
              className={`${styles.transportBtn} ${overlayPopup === 'fps' ? styles.zoomBtnActive : ''}`}
              onClick={() => setOverlayPopup(p => (p === 'fps' ? null : 'fps'))}
              title="Display frame rate (frames per second) \u2014 hover or click to adjust"
            >FPS {unlimitedFps ? '\u221E' : targetFps}</button>
            {overlayPopup === 'fps' && (
              <div className={styles.speedPopup} data-sim-overlay>
                <span className={styles.speedPopupValue}>{unlimitedFps ? '\u221E' : targetFps}</span>
                <div className={styles.speedPopupSliderWrap}>
                  {/* Interacting with the slider while \u221E is on UNTICKS it \u2014 the
                      user grabbing the slider means "I want this value". */}
                  <input type="range" min={1} max={200} value={targetFps}
                    onChange={e => { setTargetFps(Number(e.target.value)); if (unlimitedFps) setUnlimitedFps(false); }} />
                </div>
                <label className={styles.transportCheck} title="Unlimited (render as fast as possible)">
                  <input type="checkbox" checked={unlimitedFps} onChange={e => setUnlimitedFps(e.target.checked)} />&infin;
                </label>
              </div>
            )}
          </div>

          {/* Gens/frame \u2014 compact readout, click for the popover. */}
          <div
            className={styles.transportSpeed}
            ref={overlayPopup === 'gpf' ? overlayPopupWrapRef : undefined}
            data-sim-overlay
            onPointerEnter={() => setOverlayPopup('gpf')}
            onPointerLeave={() => setOverlayPopup(p => (p === 'gpf' ? null : p))}
          >
            <button
              className={`${styles.transportBtn} ${overlayPopup === 'gpf' ? styles.zoomBtnActive : ''}`}
              onClick={() => setOverlayPopup(p => (p === 'gpf' ? null : 'gpf'))}
              title="Generations simulated per displayed frame \u2014 hover or click to adjust"
            >G/F {unlimitedGens ? '\u221E' : gensPerFrame}</button>
            {overlayPopup === 'gpf' && (
              <div className={styles.speedPopup} data-sim-overlay>
                <span className={styles.speedPopupValue}>{unlimitedGens ? '\u221E' : gensPerFrame}</span>
                <div className={styles.speedPopupSliderWrap}>
                  <input type="range" min={1} max={200} value={gensPerFrame}
                    onChange={e => { setGensPerFrame(Number(e.target.value)); if (unlimitedGens) setUnlimitedGens(false); }} />
                </div>
                <label className={styles.transportCheck} title="Unlimited (simulate without displaying)">
                  <input type="checkbox" checked={unlimitedGens} onChange={e => setUnlimitedGens(e.target.checked)} />&infin;
                </label>
              </div>
            )}
          </div>
          <div className={styles.transportDivider} />

          {/* Playback controls (center) */}
          <button className={styles.transportBtn} onClick={() => setPlaying(true)} disabled={playing} title="Play (Enter)">&#9654;</button>
          <button className={styles.transportBtn} onClick={() => setPlaying(false)} disabled={!playing} title="Pause (Enter)">&#9646;&#9646;</button>
          <button className={styles.transportBtn} onClick={handleStep} title="Step (Space)">&#9654;|</button>
          <button className={styles.transportBtn} onClick={handleReset} title="Reset (Esc)">&#9632;</button>
        </div>

        {playing && unlimitedGens && (
          <div className={styles.overlay}>
            Processing without displaying. Change Gens/Frame to see evolution.
          </div>
        )}
          </>)}
        </div>

        {/* Zoom controls (bottom-left, like modeler) */}
        <div className={styles.zoomControls} data-sim-overlay>
          <button className={styles.zoomBtn} onClick={() => { zoomRef.current = Math.min(50, zoomRef.current * 1.3); draw(); }} title="Zoom in">+</button>
          <button className={styles.zoomBtn} onClick={() => { zoomRef.current = Math.max(0.1, zoomRef.current / 1.3); draw(); }} title="Zoom out">&minus;</button>
          <button className={styles.zoomBtn} onClick={handleResetView} title="Fit view">&#x2922;</button>
          <button
            className={`${styles.zoomBtn} ${inspectMode ? styles.zoomBtnActive : ''}`}
            onClick={() => setInspectMode(v => !v)}
            title={inspectMode
              ? 'Inspect mode ON — click a cell/agent to inspect it (click again to turn off)'
              : 'Inspect cells/agents on click (equivalent to Shift+Click)'}
            aria-label="Toggle inspect mode"
          >&#x24D8;</button>
          <button
            className={`${styles.zoomBtn} ${showGridlines ? styles.zoomBtnActive : ''}`}
            onClick={() => { setShowGridlines(v => !v); draw(); }}
            title="Toggle gridlines"
          >#</button>
          {!is3D && (
            <button
              className={`${styles.zoomBtn} ${show2dAxes ? styles.zoomBtnActive : ''}`}
              onClick={() => { setShow2dAxes(v => !v); draw(); }}
              title="Toggle axes — marks the grid origin (cell 0,0) and the row/column growth directions (columns red → right, rows green → down)"
            >&#x22BE;</button>
          )}
          <button
            className={`${styles.zoomBtn} ${infinityCanvas ? styles.zoomBtnActive : ''}`}
            onClick={() => { setInfinityCanvas(v => !v); }}
            disabled={model.properties.boundaryTreatment !== 'torus'}
            title={
              model.properties.boundaryTreatment === 'torus'
                ? 'Infinity canvas (tile the grid across the viewport)'
                : 'Infinity canvas — only available with Torus boundary'
            }
            style={{ opacity: model.properties.boundaryTreatment === 'torus' ? 1 : 0.4 }}
          >&infin;</button>
          <button
            className={styles.zoomBtn}
            onClick={toggleCanvasFullscreen}
            title="Fullscreen canvas (F)"
            aria-label="Toggle canvas fullscreen"
          >&#x26F6;</button>
        </div>

        {/* 3D Grid CA: collapsible voxel-view controls. Shown only for 3D models. */}
        {is3D && (() => {
          // Live grid dims (req 2): the simulator Resize button updates the live
          // refs/state but NOT model.properties, so derive the slider maxes from the
          // live source (mirroring the brush-size fields), not the stale model props.
          const W = gridWidth.current || simWidth, H = gridHeight.current || simHeight, D = is3D ? (gridDepth.current || simDepth) : 1;
          const maxDim = Math.max(W, H, D);
          const clipExtFor = (ax: 'x' | 'y' | 'z' | 'camera') => ax === 'x' ? (W - 1) / 2 + 0.5
            : ax === 'y' ? (H - 1) / 2 + 0.5
            : ax === 'z' ? (D - 1) / 2 + 0.5
            : maxDim / 2 + 1;  // camera axis
          const clipExt = clipExtFor(clip3d.axis);
          const planeMax = plane3d.axis === 'x' ? W - 1 : plane3d.axis === 'y' ? H - 1 : D - 1;
          const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.66rem' };
          const grid2: CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 };
          const tbtn = (active: boolean) => `${styles.panelToggle} ${active ? styles.panelToggleActive : ''}`;
          const vizBtn = (key: keyof import('./render/gl3d').Viz3D, label: string, title: string) => (
            <button className={tbtn(viz3d[key])} title={title} onClick={() => setViz3d(v => ({ ...v, [key]: !v[key] }))}>{label}</button>
          );
          return (
            <div className={styles.zoomControls} data-sim-overlay style={{ bottom: 'auto', top: 12, right: 12, left: 'auto', flexDirection: 'column', alignItems: 'stretch', width: 196, gap: 6, padding: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}
                onClick={() => setControls3dOpen(o => !o)} title={controls3dOpen ? 'Collapse' : 'Expand'}>
                <span style={{ fontSize: '0.66rem', color: '#aaa', fontWeight: 600 }}>3D View</span>
                <span style={{ fontSize: '0.7rem', color: '#aaa' }}>{controls3dOpen ? '▾' : '▸'}</span>
              </div>
              {controls3dOpen && (<>
                <button className={styles.panelToggle} style={{ width: '100%' }}
                  onClick={() => {
                    // Restore the default view IN PLACE — replacing `cam3dRef.current`
                    // would strand every holder of the old object (the DEV
                    // `window.__sim3dCamera` hook among them).
                    cancelFollow();  // an explicit camera reset takes the wheel back — see FOLLOW MODE
                    const d = defaultCamera3d(), cam = cam3dRef.current;
                    cam.yaw = d.yaw; cam.pitch = d.pitch; cam.dist = d.dist; cam.target = d.target;
                    draw();
                  }}
                  title="Reset the orbit camera">Reset view</button>

                {/* Overlays — 2×2 grid so the labels never squash. */}
                <div style={grid2}>
                  {vizBtn('axes', 'Axes', 'Toggle the X/Y/Z axes (red/green/blue)')}
                  {vizBtn('grid', 'Grid', 'Toggle the X,Y floor grid')}
                  {vizBtn('bounds', 'Bounds', 'Toggle the grid bounding box')}
                  {vizBtn('gizmo', 'Gizmo', 'Toggle the corner orientation widget')}
                </div>

                {/* Auto-orbit — speed spans negative→positive so the camera can
                    spin either way (req 3); 0 = stopped. */}
                <label style={row} title="Slowly spin the camera around the volume (drag left of centre to reverse)">
                  <input type="checkbox" checked={orbit3d.on} onChange={e => setOrbit3d(o => ({ ...o, on: e.target.checked }))} />
                  Auto-orbit
                  {orbit3d.on && (
                    <input type="range" min={-2} max={2} step={0.05} value={orbit3d.speed} style={{ flex: 1 }}
                      title="Orbit speed (rad/s; negative = reverse)" onChange={e => setOrbit3d(o => ({ ...o, speed: Number(e.target.value) }))} />
                  )}
                </label>

                {/* Auto-zoom — the dolly sibling of auto-orbit, same shape: one slider
                    spanning negative→positive, so the camera pulls OUT or pushes IN at
                    the chosen rate; 0 = stopped. It stops at the distance limit rather
                    than zooming forever. Pair it with auto-orbit for an unattended
                    "start close, orbit and slowly pull out as the model grows" recording. */}
                <label style={row} title="Slowly dolly the camera out (right of centre) or in (left of centre); stops at the zoom limit">
                  <input type="checkbox" checked={zoom3d.on} onChange={e => setZoom3d(z => ({ ...z, on: e.target.checked }))} />
                  Auto-zoom
                  {zoom3d.on && (
                    <input type="range" min={-1} max={1} step={0.02} value={zoom3d.speed} style={{ flex: 1 }}
                      title="Zoom speed (negative = zoom in, positive = zoom out; 0 = stopped)"
                      onChange={e => setZoom3d(z => ({ ...z, speed: Number(e.target.value) }))} />
                  )}
                </label>

                {/* Clip interval (slab) — two cuts; the band [From, To] stays visible (req 6). */}
                <label style={row}>
                  <input type="checkbox" checked={clip3d.enabled}
                    onChange={e => setClip3d(c => e.target.checked
                      ? { ...c, enabled: true, lo: -clipExtFor(c.axis), hi: 0 }
                      : { ...c, enabled: false })} />
                  Clip interval (see inside)
                </label>
                {clip3d.enabled && (
                  <>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4 }}>
                      {(['x', 'y', 'z', 'camera'] as const).map(ax => (
                        <button key={ax} className={tbtn(clip3d.axis === ax)}
                          title={ax === 'camera' ? 'Cut along the camera view axis' : `Cut along ${ax.toUpperCase()}`}
                          onClick={() => setClip3d(c => ({ ...c, axis: ax, lo: -clipExtFor(ax), hi: 0 }))}>{ax === 'camera' ? 'View' : ax.toUpperCase()}</button>
                      ))}
                    </div>
                    <ClipIntervalSlider
                      lo={clip3d.lo} hi={clip3d.hi} min={-clipExt} max={clipExt} step={0.5}
                      onChange={(lo, hi) => setClip3d(c => ({ ...c, lo, hi }))} />
                  </>
                )}

                {/* Interaction plane (brush target) */}
                <label style={row} title="LMB-brush ray-traces onto this plane; pick a cell on its slice">
                  <input type="checkbox" checked={plane3d.enabled}
                    onChange={e => setPlane3d(p => ({ ...p, enabled: e.target.checked }))} />
                  Brush plane
                </label>
                {plane3d.enabled && (
                  <>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4 }}>
                      {(['x', 'y', 'z'] as const).map(ax => (
                        <button key={ax} className={tbtn(plane3d.axis === ax)}
                          onClick={() => setPlane3d(p => ({ ...p, axis: ax, pos: 0 }))}>{ax.toUpperCase()}</button>
                      ))}
                    </div>
                    <input type="range" min={0} max={planeMax} step={1} value={plane3d.pos}
                      onChange={e => setPlane3d(p => ({ ...p, pos: Number(e.target.value) }))}
                      style={{ width: '100%' }} title={`Plane at ${plane3d.axis}=${plane3d.pos}`} />
                  </>
                )}

                {/* Alpha blend */}
                <label style={row} title="Show semi-transparent colors (alpha < 255) for cells AND agents — off, everything visible renders opaque (alpha-0 cells stay hidden either way)">
                  <input type="checkbox" checked={alpha3d} onChange={e => setAlpha3d(e.target.checked)} />
                  Alpha blend
                </label>
                {/* Cell gaps — the 3D analogue of the 2D gridlines toggle. Off =
                    adjacent cells render flush (a seamless solid volume). Only
                    affects the CA-grid voxels, so it's hidden for an agents-only
                    model (no grid to render). */}
                {gridCellsOn && (
                  <label style={row} title="Leave a small gap between adjacent cells (like 2D gridlines). Uncheck to render cells flush against each other as one solid volume.">
                    <input type="checkbox" checked={cellGaps3d} onChange={e => setCellGaps3d(e.target.checked)} />
                    Cell gaps
                  </label>
                )}
                {/* Draw agents in front (agent models only) */}
                {isAgentModel && (
                  <label style={row} title="Draw agents over the CA-grid voxels regardless of depth (the grid usually surrounds them). Uncheck for normal depth occlusion between the two layers — useful when the grid field is sparse. Axes / grid / bounds / brush plane always occlude normally.">
                    <input type="checkbox" checked={agentsFront3d} onChange={e => setAgentsFront3d(e.target.checked)} />
                    Draw agents in front
                  </label>
                )}
                {/* Agent metaballs — render the agents as one fused implicit
                    surface (Blender-metaball semantics) instead of discrete
                    spheres. Each agent's own radius drives its field element. */}
                {isAgentModel && (<>
                  <label style={row} title="Render the agents as a fused implicit surface (metaballs): each agent contributes a field over Influence × its radius, and agents whose fields overlap merge into one organic blob — the natural look for tissues. Picking / brushing still target the underlying agents.">
                    <input type="checkbox" checked={agentMetaballs.enabled}
                      onChange={e => setAgentMetaballs(m => ({ ...m, enabled: e.target.checked }))} />
                    Metaballs
                  </label>
                  {agentMetaballs.enabled && (<>
                    <label style={row} title="Influence — how far each agent's field reaches, as a multiple of its radius. Higher = agents fuse from further apart (and a lone agent renders slightly fatter unless the threshold is re-derived).">
                      <span style={{ fontSize: '0.6rem', color: '#999', width: 44, flex: '0 0 auto' }}>Influence</span>
                      <input type="range" min={1} max={3} step={0.05} value={agentMetaballs.influence} style={{ flex: 1, minWidth: 0 }}
                        onChange={e => setAgentMetaballs(m => ({ ...m, influence: Number(e.target.value) }))} />
                    </label>
                    <label style={row} title="Threshold — the field isovalue the surface sits at. Lower = fatter / more fused; higher = thinner / more separated. At the auto value (⟲) a lone agent renders at exactly its own radius.">
                      <span style={{ fontSize: '0.6rem', color: '#999', width: 44, flex: '0 0 auto' }}>Threshold</span>
                      <input type="range" min={0.02} max={0.9} step={0.005} value={agentMetaballs.threshold} style={{ flex: 1, minWidth: 0 }}
                        onChange={e => setAgentMetaballs(m => ({ ...m, threshold: Number(e.target.value) }))} />
                      <button className={styles.panelToggle} title="Auto threshold — re-derive from Influence so a lone agent renders at exactly its own radius"
                        onClick={() => setAgentMetaballs(m => ({ ...m, threshold: metaballAutoThreshold(m.influence) }))}>⟲</button>
                    </label>
                    <div style={row} title="Field detail — density-field voxels per grid cell. Higher = a smoother surface, at more bake cost per step.">
                      <span style={{ fontSize: '0.6rem', color: '#999', width: 44, flex: '0 0 auto' }}>Detail</span>
                      {([1, 2, 4] as const).map(rv => (
                        <button key={rv} className={tbtn(agentMetaballs.resolution === rv)} style={{ flex: 1 }}
                          onClick={() => setAgentMetaballs(m => ({ ...m, resolution: rv }))}>{rv}×</button>
                      ))}
                    </div>
                  </>)}
                </>)}
                {/* Background colour */}
                <label style={row} title="Fill the 3D canvas with a solid colour (off = transparent)">
                  <input type="checkbox" checked={bg3d.enabled} onChange={e => setBg3d(b => ({ ...b, enabled: e.target.checked }))} />
                  Background
                  <input type="color" value={bg3d.color}
                    onChange={e => setBg3d({ enabled: true, color: e.target.value })}
                    style={{ width: 28, height: 18, marginLeft: 'auto', cursor: 'pointer', border: 'none', background: 'none', padding: 0, opacity: bg3d.enabled ? 1 : 0.5 }} />
                </label>

                {/* Lighting — light ball (direction) + ambient/diffuse/specular +
                    the camera/world anchor. Defaults = the historical shade. */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 2 }}>
                  <span style={{ fontSize: '0.66rem', color: '#aaa', fontWeight: 600 }}>Lighting</span>
                  <button className={styles.panelToggle} title="Reset lighting to the default"
                    onClick={() => setLight3d({ ...DEFAULT_LIGHT3D })}>Reset</button>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <div title="Drag the bright dot to aim the light (the light comes FROM the dot's direction)">
                    <LightBallWidget bx={light3d.bx} by={light3d.by} size={64} onChange={applyLightBall} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
                    <label style={row} title="Ambient fill — base brightness reaching every face">
                      <span style={{ fontSize: '0.6rem', color: '#999', width: 44, flex: '0 0 auto' }}>Ambient</span>
                      <input type="range" min={0} max={1} step={0.01} value={light3d.ambient} style={{ flex: 1, minWidth: 0 }}
                        onChange={e => setLight3d(l => ({ ...l, ambient: Number(e.target.value) }))} />
                    </label>
                    <label style={row} title="Directional light strength (shapes the volume)">
                      <span style={{ fontSize: '0.6rem', color: '#999', width: 44, flex: '0 0 auto' }}>Light</span>
                      <input type="range" min={0} max={1.5} step={0.01} value={light3d.diffuse} style={{ flex: 1, minWidth: 0 }}
                        onChange={e => setLight3d(l => ({ ...l, diffuse: Number(e.target.value) }))} />
                    </label>
                    <label style={row} title="Specular shine — a white highlight on faces angled toward the light">
                      <span style={{ fontSize: '0.6rem', color: '#999', width: 44, flex: '0 0 auto' }}>Shine</span>
                      <input type="range" min={0} max={1} step={0.01} value={light3d.specular} style={{ flex: 1, minWidth: 0 }}
                        onChange={e => setLight3d(l => ({ ...l, specular: Number(e.target.value) }))} />
                    </label>
                  </div>
                </div>
                <div style={grid2}>
                  <button className={tbtn(light3d.mode === 'camera')}
                    title="The light follows the camera — shading stays constant while orbiting (headlight style)"
                    onClick={() => setLightMode('camera')}>View</button>
                  <button className={tbtn(light3d.mode === 'world')}
                    title="The light is fixed in the scene — orbiting sweeps the lit side (sun style)"
                    onClick={() => setLightMode('world')}>World</button>
                </div>
                {/* Global lighting (opt-in): cast shadows + ambient occlusion —
                    cells/agents shade each other instead of each surface being lit
                    only by its own normal. */}
                <label style={{ ...row, gap: 4 }} title="Cast shadows — voxels and agents shadow each other (shadow-mapped). Slider = darkness.">
                  <input type="checkbox" checked={light3d.shadows} data-sim-overlay
                    onChange={e => setLight3d(l => ({ ...l, shadows: e.target.checked }))} />
                  <span style={{ fontSize: '0.6rem', color: '#999', width: 60, flex: '0 0 auto' }}>Shadows</span>
                  <input type="range" min={0} max={1} step={0.01} value={light3d.shadowStrength} disabled={!light3d.shadows}
                    style={{ flex: 1, minWidth: 0, opacity: light3d.shadows ? 1 : 0.4 }}
                    onChange={e => setLight3d(l => ({ ...l, shadowStrength: Number(e.target.value) }))} />
                </label>
                {/* Occlusion is VOXEL-occupancy AO (computed from cell face-
                    neighbours in uploadColors) — it does nothing for agents
                    (spheres get their inter-shading from cast shadows), so the
                    row is hidden for an agents-only model, like Cell gaps. */}
                {gridCellsOn && (
                  <label style={{ ...row, gap: 4 }} title="Ambient occlusion — crevices between filled cells darken so a packed volume reads as one solid form (CA-grid voxels only). Slider = strength.">
                    <input type="checkbox" checked={light3d.ao} data-sim-overlay
                      onChange={e => setLight3d(l => ({ ...l, ao: e.target.checked }))} />
                    <span style={{ fontSize: '0.6rem', color: '#999', width: 60, flex: '0 0 auto' }}>Occlusion</span>
                    <input type="range" min={0} max={1} step={0.01} value={light3d.aoStrength} disabled={!light3d.ao}
                      style={{ flex: 1, minWidth: 0, opacity: light3d.ao ? 1 : 0.4 }}
                      onChange={e => setLight3d(l => ({ ...l, aoStrength: Number(e.target.value) }))} />
                  </label>
                )}
              </>)}
            </div>
          );
        })()}

        {/* Right panel expand button */}
        {!rightPanelOpen && (
          <button className={styles.panelExpandBtnRight} data-sim-overlay
            onClick={() => setRightPanelOpen(true)} title="Open side panel">&lsaquo;</button>
        )}
      </div>

      {/* === Right Panel (single shared panel, resizable via left border drag) === */}
      {rightPanelOpen && (
        <div className={styles.rightPanel} ref={rightPanelRef}>
          {/* Collapse button outside panel (left edge tab) */}
          <button
            className={styles.rightPanelCollapseTab}
            onClick={() => setRightPanelOpen(false)}
            title="Close side panel"
          >&rsaquo;</button>

          {/* Drag handle on full left border */}
          <div
            className={styles.rightPanelResizeHandle}
            onMouseDown={e => {
              e.preventDefault();
              const panel = rightPanelRef.current;
              if (!panel) return;
              const startX = e.clientX;
              const startW = panel.offsetWidth;
              // Mirror of the left panel: drag-inward-to-collapse. Right
              // panel grows when the handle moves LEFT (delta inverted).
              const COLLAPSE_THRESHOLD = 100;
              const DRAG_MIN = 40;
              let lastW = startW;
              const onMove = (ev: MouseEvent) => {
                lastW = Math.max(DRAG_MIN, startW - (ev.clientX - startX));
                panel.style.width = lastW + 'px';
              };
              const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                if (lastW < COLLAPSE_THRESHOLD) setRightPanelOpen(false);
              };
              document.addEventListener('mousemove', onMove);
              document.addEventListener('mouseup', onUp);
            }}
          />

          {/* Panel tabs — switch the shared right panel between the sim Controls
              (brush + layers + indicators) and the Overseer Experiments view.
              Only shown when the Overseer feature is enabled; with it off the
              panel is just the controls (as before). Mirrors the modeler's
              per-panel tabs. */}
          {overseerEnabled && (
            <div className={styles.rightPanelTabs} data-sim-overlay>
              {([['controls', 'Controls'], ['experiments', 'Overseer Experiments']] as const).map(([id, label]) => (
                <button
                  key={id}
                  className={`${styles.rightPanelTab} ${rightPanelTab === id ? styles.rightPanelTabActive : ''}`}
                  onClick={() => setRightPanelTab(id)}
                  title={label}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

          {/* === Controls tab === */}
          {(!overseerEnabled || rightPanelTab === 'controls') && (<>
          {/* Common controls (agent models) — at the TOP of the panel, ABOVE the
              "Brush affects" switch, because they apply to BOTH targets. The Layers
              matrix governs rendering + simulation of the CA grid AND the agents;
              the switch then divides these shared controls from the target-specific
              brush details below (Input Mapping for CA Grid, Agent Brush for Agents). */}
          {isAgentModel && (
            <div style={{ padding: '8px 10px 2px', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {/* Layers — independently SHOW (render) and SIMULATE (run the step) the
                  CA grid + the agents. Shared by both brush targets. */}
              <div>
                <div style={{ fontSize: '0.6rem', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Layers</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr 1fr', gap: '4px 8px', alignItems: 'center', fontSize: '0.68rem' }}>
                  <span />
                  <span style={{ color: 'var(--color-text-muted)', textAlign: 'center', fontSize: '0.6rem' }}>Show</span>
                  <span style={{ color: 'var(--color-text-muted)', textAlign: 'center', fontSize: '0.6rem' }}>Simulate</span>
                  {/* CA grid row — only when the model actually has a grid (gridCells). */}
                  {gridCellsOn && (<>
                    <span>CA grid</span>
                    <span style={{ textAlign: 'center' }}><input type="checkbox" checked={showCaGrid} onChange={e => setShowCaGrid(e.target.checked)} title="Render the CA grid" /></span>
                    <span style={{ textAlign: 'center' }}><input type="checkbox" checked={simulateCells} onChange={e => setSimulateCells(e.target.checked)} title="Run the cell step (freeze the grid when off)" /></span>
                  </>)}
                  <span>Agents</span>
                  <span style={{ textAlign: 'center' }}><input type="checkbox" checked={showAgents} onChange={e => setShowAgents(e.target.checked)} title="Render the agents" /></span>
                  <span style={{ textAlign: 'center' }}><input type="checkbox" checked={simulateAgents} onChange={e => setSimulateAgents(e.target.checked)} title="Run the agent step (freeze agents — and their cell deposits — when off)" /></span>
                  {/* Bonds row — only for models whose Bonds capability isn't Off
                      (resolveMaxBonds > 0 — bonds can't exist otherwise). Show-only:
                      hiding the lines is a display choice, the springs keep running. */}
                  {resolveMaxBonds(model.centerBased) > 0 && (<>
                    <span style={{ paddingLeft: 12 }}>Bonds</span>
                    <span style={{ textAlign: 'center' }}><input type="checkbox" checked={showBonds} onChange={e => setShowBonds(e.target.checked)} title="Render the bond links between agents (display only — bond physics keeps simulating)" /></span>
                    <span />
                  </>)}
                </div>
              </div>
              {/* Brush affects — which layer the LMB brush targets. Only meaningful
                  when BOTH layers exist; for an agents-only model the brush always
                  acts on agents (an effect forces brushTarget='agents'), so hide it. */}
              {gridCellsOn && (
              <div>
                <div style={{ fontSize: '0.6rem', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Brush affects</div>
                <div style={{ display: 'flex', border: '1px solid var(--color-widget-border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
                  {(['grid', 'agents'] as const).map(t => (
                    <button key={t}
                      onClick={() => { setBrushTarget(t); agentGlueAnchorRef.current = -1; draw(); }}
                      title={t === 'grid' ? 'LMB paints the CA grid (the Input Mapping brush below)' : 'LMB acts on the agents (seed / kill / move / glue / cut / bond)'}
                      style={{ flex: 1, padding: '4px 8px', cursor: 'pointer', border: 'none', borderRight: t === 'grid' ? '1px solid var(--color-widget-border)' : 'none', background: brushTarget === t ? 'var(--color-accent-soft)' : 'transparent', color: brushTarget === t ? 'var(--color-accent)' : 'var(--color-text-muted)', fontWeight: 600, fontSize: '0.66rem' }}
                    >{t === 'grid' ? 'CA Grid' : 'Agents'}</button>
                  ))}
                </div>
              </div>
              )}
              {/* Environment background — the fill behind agents when the CA Grid
                  layer is hidden (an agents-only view). No effect while the grid is
                  shown (its colours are the background). 2D only — the 3D view has
                  its own background control in the 3D View panel. */}
              {!is3D && (
              <div>
                <div style={{ fontSize: '0.6rem', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Background</div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.66rem' }} title="Fill the environment behind the agents with this colour when the CA Grid layer is hidden.">
                  <input type="checkbox" checked={bg2d.enabled} onChange={e => setBg2d(b => ({ ...b, enabled: e.target.checked }))} />
                  <input type="color" value={bg2d.color} disabled={!bg2d.enabled}
                    onChange={e => setBg2d(b => ({ ...b, color: e.target.value }))}
                    style={{ width: 34, height: 20, padding: 0, border: 'none', background: 'none', opacity: bg2d.enabled ? 1 : 0.4, cursor: bg2d.enabled ? 'pointer' : 'default' }} />
                  <span style={{ color: 'var(--color-text-muted)' }}>Agents-only backdrop</span>
                </label>
              </div>
              )}
              {/* Agent disc outlines — 2D: the dark contour stroke around each
                  circle (drawn only when a disc is >= 2px); 3D: a matching dark
                  silhouette rim on the sphere impostors (SPHERE_FS uOutline).
                  Optional so dense populations can render as clean solid dots. */}
              <div>
                <div style={{ fontSize: '0.6rem', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Outlines</div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.66rem' }}
                  title="Draw a dark contour around each agent (2D discs at least 2px on screen; 3D spheres get a silhouette rim). Off = clean solid dots.">
                  <input type="checkbox" checked={agentOutlines} onChange={e => setAgentOutlines(e.target.checked)} />
                  <span style={{ color: 'var(--color-text-muted)' }}>Outline agents</span>
                </label>
              </div>
              {/* Hemifield / vision-cone display — draws the FOV sensing nodes'
                  cones (Get Agents In View / Sense Hemifield) on the 2D overlay,
                  for the inspected agent or all agents. Heading = the agent's
                  velocity (facing/wired heading sources are approximated by the
                  velocity heading — the snapshot doesn't carry them). */}
              {!is3D && visionCones.length > 0 && (
              <div>
                <div style={{ fontSize: '0.6rem', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Vision</div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.66rem' }}
                  title="Show the FOV sensing cones (Get Agents In View / Sense Hemifield) as translucent wedges. Inspected = the inspected/edited/hovered agent; All = every agent (capped at 1500). Heading uses the agent's velocity; a zero heading or a half-angle of 180 or more draws the full sensing circle. Facing/wired heading sources are approximated by the velocity heading; a wired Radius input falls back to the Neighbour Query Radius.">
                  <span style={{ color: 'var(--color-text-muted)', flex: '0 0 auto' }}>Show vision</span>
                  <select value={showVision} onChange={e => setShowVision(e.target.value as 'off' | 'inspected' | 'all')}
                    style={{ flex: 1, minWidth: 0, fontSize: '0.64rem' }}>
                    <option value="off">Off</option>
                    <option value="inspected">Inspected agent</option>
                    <option value="all">All agents</option>
                  </select>
                </label>
              </div>
              )}
              {/* A1 direct-render Glow — additive radial falloff per agent. Renders
                  ONLY on the WebGPU direct-render path (agents-only, 2D). */}
              {!is3D && (
              <div>
                <div style={{ fontSize: '0.6rem', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Glow</div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.66rem' }}
                  title="Render each agent as an additive radial glow (WebGPU direct render only — agents-only 2D models on the WebGPU agent target). The CPU overlay path ignores this.">
                  <input type="checkbox" checked={agentGlow.on}
                    onChange={e => setAgentGlow(g => ({ ...g, on: e.target.checked }))} />
                  <span style={{ color: 'var(--color-text-muted)' }}>Glow (WebGPU direct render)</span>
                </label>
                {agentGlow.on && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.66rem' }}
                      title="Glow size — the extra halo radius in pixels around each agent.">
                      <span style={{ fontSize: '0.6rem', color: 'var(--color-text-muted)', width: 48, flex: '0 0 auto' }}>Size</span>
                      <input type="range" min={0} max={40} step={1} value={agentGlow.size} style={{ flex: 1, minWidth: 0 }}
                        onChange={e => setAgentGlow(g => ({ ...g, size: Number(e.target.value) }))} />
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.66rem' }}
                      title="Glow intensity — brightness of the additive halo.">
                      <span style={{ fontSize: '0.6rem', color: 'var(--color-text-muted)', width: 48, flex: '0 0 auto' }}>Intensity</span>
                      <input type="range" min={0} max={3} step={0.05} value={agentGlow.intensity} style={{ flex: 1, minWidth: 0 }}
                        onChange={e => setAgentGlow(g => ({ ...g, intensity: Number(e.target.value) }))} />
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.66rem' }}
                      title="Glow falloff — higher = tighter core, lower = softer spread.">
                      <span style={{ fontSize: '0.6rem', color: 'var(--color-text-muted)', width: 48, flex: '0 0 auto' }}>Falloff</span>
                      <input type="range" min={0.3} max={6} step={0.1} value={agentGlow.steepness} style={{ flex: 1, minWidth: 0 }}
                        onChange={e => setAgentGlow(g => ({ ...g, steepness: Number(e.target.value) }))} />
                    </label>
                  </div>
                )}
              </div>
              )}
              {/* Agent metaballs (2D) — the same shared preference as the 3D View
                  panel's Metaballs block; in 2D it's an approximate gooey filter
                  (blur + alpha threshold) fusing the agent discs. */}
              {!is3D && (
              <div>
                <div style={{ fontSize: '0.6rem', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Metaballs</div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.66rem' }}
                  title="Render nearby agents fused into one organic blob (a gooey blur + threshold filter — an approximation of the 3D metaball surface). Sprite-agents stay crisp on top.">
                  <input type="checkbox" checked={agentMetaballs.enabled}
                    onChange={e => setAgentMetaballs(m => ({ ...m, enabled: e.target.checked }))} />
                  <span style={{ color: 'var(--color-text-muted)' }}>Fuse agents into blobs</span>
                </label>
                {agentMetaballs.enabled && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.66rem' }}
                      title="Influence — how far each agent's field reaches (× its radius). Higher = agents fuse from further apart.">
                      <span style={{ fontSize: '0.6rem', color: 'var(--color-text-muted)', width: 48, flex: '0 0 auto' }}>Influence</span>
                      <input type="range" min={1} max={3} step={0.05} value={agentMetaballs.influence} style={{ flex: 1, minWidth: 0 }}
                        onChange={e => setAgentMetaballs(m => ({ ...m, influence: Number(e.target.value) }))} />
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.66rem' }}
                      title="Threshold — higher = thinner / more separated, lower = fatter / more fused.">
                      <span style={{ fontSize: '0.6rem', color: 'var(--color-text-muted)', width: 48, flex: '0 0 auto' }}>Threshold</span>
                      <input type="range" min={0.02} max={0.9} step={0.005} value={agentMetaballs.threshold} style={{ flex: 1, minWidth: 0 }}
                        onChange={e => setAgentMetaballs(m => ({ ...m, threshold: Number(e.target.value) }))} />
                    </label>
                  </div>
                )}
              </div>
              )}
              {/* No sprite transport here — sprite playback (which sprite, frame,
                  speed) is driven by the agent's logic via the Set Agent Sprite
                  node, advanced by the engine each simulation step. */}
            </div>
          )}

          {/* Brush Section (top, shrinks to content; user-resizable when a splitter
              to the Indicators section below is available). Shown only when the
              brush targets the CA grid (or on a non-agent model). */}
          {(!isAgentModel || brushTarget === 'grid') && (
          <div
            ref={brushSectionRef}
            className={`${styles.rightPanelSection} ${styles.rightSectionBrush}`}
            style={brushSectionH != null && (model.indicators || []).length > 0
              ? { height: brushSectionH, flex: '0 0 auto' }
              : undefined}
          >
            <div className={styles.panelHeader}>
              <span className={styles.panelTitle}>Input Mapping (C{'\u2192'}A)</span>
            </div>
            <div className={styles.rightPanelSectionBody}>
            {/* Tab strip \u2014 always rendered: even when the model has zero color
                input mappings, the Manual tab still appears. */}
            <div className={styles.mappingTabs}>
              {colorToAttrMappings.map(m => (
                <button
                  key={m.id}
                  className={`${styles.mappingTab} ${brushMapping === m.id ? styles.mappingTabActive : ''}`}
                  onClick={() => setBrushMapping(m.id)}
                  title={m.description || undefined}
                >
                  {m.name}
                </button>
              ))}
              <button
                key={MANUAL_BRUSH_MAPPING_ID}
                className={`${styles.mappingTab} ${styles.mappingTabManual} ${brushMapping === MANUAL_BRUSH_MAPPING_ID ? styles.mappingTabActive : ''}`}
                onClick={() => setBrushMapping(MANUAL_BRUSH_MAPPING_ID)}
                title="Manual Brush \u2014 directly set chosen cell attributes on painted cells (always available)"
              >
                Manual
              </button>
            </div>
            {brushMapping === MANUAL_BRUSH_MAPPING_ID ? (
              <ManualBrushPanel
                cellAttributes={model.attributes.filter(a => !a.isModelAttribute)}
                neighborhoods={model.neighborhoods}
                state={manualBrush}
                onChange={setManualBrush}
                is3d={model.properties.dimension === '3d' && (model.properties.gridDepth ?? 1) > 1}
              />
            ) : (
              <div className={styles.fieldRow}>
                <span className={styles.statLabel}>Color</span>
                <input type="color" className={styles.colorPicker} value={brushColor}
                  onChange={e => setBrushColor(e.target.value)} />
                {(() => {
                  const { r, g, b } = hexToRgb(brushColor);
                  const setChannel = (which: 'r' | 'g' | 'b', val: number) => {
                    const c = { r, g, b, [which]: Math.max(0, Math.min(255, val | 0)) };
                    const hex = '#' + [c.r, c.g, c.b].map(v => v.toString(16).padStart(2, '0')).join('');
                    setBrushColor(hex);
                  };
                  return (
                    <>
                      <NumberField className={styles.brushInput} min={0} max={255} integer title="Red"
                        value={r} onNumber={n => setChannel('r', n)} />
                      <NumberField className={styles.brushInput} min={0} max={255} integer title="Green"
                        value={g} onNumber={n => setChannel('g', n)} />
                      <NumberField className={styles.brushInput} min={0} max={255} integer title="Blue"
                        value={b} onNumber={n => setChannel('b', n)} />
                    </>
                  );
                })()}
              </div>
            )}
            <div className={styles.fieldRow}>
              <span className={styles.statLabel}>Shape</span>
              {([
                ['rect', '▢', 'Rectangle brush'],
                ['circle', '●', 'Circle brush (filled disc)'],
                ['ring', '◌', 'Ring brush (annulus)'],
                ['line', '╱', 'Line — click two points on the board to draw a segment'],
              ] as Array<[BrushShape, string, string]>).map(([s, glyph, tip]) => (
                <button
                  key={s}
                  className={`${styles.brushShapeBtn} ${brushShape === s ? styles.brushShapeBtnActive : ''}`}
                  onClick={() => setBrushShape(s)}
                  title={tip}
                >
                  {glyph}
                </button>
              ))}
            </div>
            {brushShape === 'rect' && (
              <div className={styles.fieldRow}>
                <span className={styles.statLabel}>W</span>
                <NumberField className={styles.brushInput} min={1} max={(gridWidth.current || simWidth) * 2} integer value={brushW}
                  onNumber={setBrushW} />
                <span className={styles.statLabel}>H</span>
                <NumberField className={styles.brushInput} min={1} max={(gridHeight.current || simHeight) * 2} integer value={brushH}
                  onNumber={setBrushH} />
              </div>
            )}
            {brushShape === 'circle' && (
              <div className={styles.fieldRow}>
                <span className={styles.statLabel}>Radius</span>
                <NumberField className={styles.brushInput} min={0} max={(gridWidth.current || simWidth) * 2} integer value={brushRadius}
                  onNumber={setBrushRadius} />
              </div>
            )}
            {brushShape === 'ring' && (
              <div className={styles.fieldRow}>
                <span className={styles.statLabel}>Radius</span>
                <NumberField className={styles.brushInput} min={0} max={(gridWidth.current || simWidth) * 2} integer value={brushRadius}
                  onNumber={setBrushRadius} />
                <span className={styles.statLabel}>Width</span>
                <NumberField className={styles.brushInput} min={1} max={(gridWidth.current || simWidth) * 2} integer value={brushRingWidth}
                  onNumber={setBrushRingWidth} />
              </div>
            )}
            {brushShape === 'line' && (
              <div className={styles.fieldRow}>
                <span className={styles.statLabel}>Width</span>
                <NumberField className={styles.brushInput} min={1} max={(gridWidth.current || simWidth) * 2} integer value={brushLineWidth}
                  onNumber={setBrushLineWidth} />
                <span className={styles.brushShapeHint}>click 2 points</span>
              </div>
            )}
            {is3D && (
              <label className={styles.checkRow} title="When on, the brush shape becomes a 3D solid (sphere / shell / box / tube) that paints cells through the depth, not just a flat footprint on the interaction plane.">
                <input type="checkbox" checked={brush3dVolume} onChange={e => setBrush3dVolume(e.target.checked)} />
                Volumetric Brush
              </label>
            )}
            {is3D && brush3dVolume && brushShape === 'rect' && (
              <div className={styles.fieldRow}>
                <span className={styles.statLabel}>Depth</span>
                <NumberField className={styles.brushInput} min={1} max={(gridDepth.current || simDepth) * 2} integer value={brushBoxDepth}
                  onNumber={setBrushBoxDepth} />
                <span className={styles.brushShapeHint}>layers</span>
              </div>
            )}
            <hr className={styles.divider} />
            <button
              className={styles.controlButton}
              onClick={() => imageInputRef.current?.click()}
              title="Map an image onto the grid (the dialog offers a colour mapping or the manual brush)"
            >
              Open Image
            </button>
            <input ref={imageInputRef} type="file" accept=".png,.bmp,.jpg,.jpeg" style={{ display: 'none' }} onChange={handleImageImport} />
            <button
              className={styles.controlButton}
              onClick={() => csvInputRef.current?.click()}
              title="Import a CSV — the table IS the board (a line is a grid row, a field a grid column), written into one cell attribute"
            >
              Import CSV…
            </button>
            <label className={styles.checkRow}>
              <input type="checkbox" checked={showBrushCursor} onChange={e => setShowBrushCursor(e.target.checked)} />
              Show brush cursor
            </label>
            <div className={styles.hint}>
              {brushMapping === MANUAL_BRUSH_MAPPING_ID
                ? <>LMB paint {'\u00B7'} RMB pan {'\u00B7'} Ctrl+LMB drag resize {'\u00B7'} Ctrl+wheel cycle mapping {'\u00B7'} Shift+LMB inspect</>
                : <>LMB paint {'\u00B7'} RMB pan {'\u00B7'} Ctrl+LMB drag resize {'\u00B7'} Ctrl+wheel cycle mapping {'\u00B7'} Shift+RMB color {'\u00B7'} Shift+LMB inspect</>}
            </div>
            </div>
          </div>
          )}

          {/* Agent Brush section — the target-specific brush details when the brush
              targets agents (parallel to the Input Mapping section for the CA Grid
              target). The shared Layers matrix + the Brush-affects switch moved to
              the common controls at the TOP of the panel. */}
          {isAgentModel && brushTarget === 'agents' && (
            <div
              ref={brushSectionRef}
              className={`${styles.rightPanelSection} ${styles.rightSectionBrush}`}
              style={brushSectionH != null && (model.indicators || []).length > 0
                ? { height: brushSectionH, flex: '0 0 auto' }
                : (model.indicators || []).length > 0
                  // Agent-brush content is tall — cap it by default so it doesn't
                  // squeeze the indicators below (the splitter overrides this). The
                  // body scrolls within the cap.
                  ? { maxHeight: '55%', flex: '0 0 auto' }
                  : undefined}
            >
              <div className={styles.panelHeader}>
                <span className={styles.panelTitle}>Agent Brush</span>
              </div>
              <div className={styles.rightPanelSectionBody} style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: '0.66rem' }}>
                  {/* Shape + size — placed BEFORE the mode buttons. Scope (Single vs
                      Area) is DERIVED from the size and shown as a badge on the size
                      row (no toggle): a zero-size footprint acts on ONE agent, a sized
                      one on ALL agents inside it. Footprint modes only. */}
                  {(agentBrushMode === 'add' || agentBrushMode === 'remove' || agentBrushMode === 'move' || agentBrushMode === 'edit') && (<>
                    <div className={styles.fieldRow}>
                      <span className={styles.statLabel}>Shape</span>
                      {([
                        ['rect', '▢', 'Square / rectangle footprint'],
                        ['circle', '●', 'Circle footprint (filled disc)'],
                        ['ring', '◌', 'Ring footprint (annulus)'],
                        ['line', '╱', 'Line — two clicks define a capsule (Add / Remove / Edit, Area)'],
                      ] as Array<[BrushShape, string, string]>).map(([s, glyph, tip]) => (
                        <button key={s} className={`${styles.brushShapeBtn} ${agentBrushShape === s ? styles.brushShapeBtnActive : ''}`}
                          onClick={() => { setAgentBrushShape(s); agentLineAnchorRef.current = null; agentLine3dAnchorRef.current = null; draw(); }} title={tip}>{glyph}</button>
                      ))}
                    </div>
                    {agentBrushShape === 'rect' && (
                      <div className={styles.fieldRow}>
                        <span className={styles.statLabel}>W</span>
                        <NumberField className={styles.brushInput} min={1} max={(gridWidth.current || simWidth) * 2} integer value={agentBrushW} onNumber={setAgentBrushW} />
                        <span className={styles.statLabel}>H</span>
                        <NumberField className={styles.brushInput} min={1} max={(gridHeight.current || simHeight) * 2} integer value={agentBrushH} onNumber={setAgentBrushH} />
                        {scopeBadge}
                      </div>
                    )}
                    {agentBrushShape === 'circle' && (
                      <div className={styles.fieldRow}>
                        <span className={styles.statLabel}>Radius</span>
                        <NumberField className={styles.brushInput} min={0} max={(gridWidth.current || simWidth) * 2} integer value={agentBrushRadius} onNumber={setAgentBrushRadius} />
                        {scopeBadge}
                      </div>
                    )}
                    {agentBrushShape === 'ring' && (
                      <div className={styles.fieldRow}>
                        <span className={styles.statLabel}>Radius</span>
                        <NumberField className={styles.brushInput} min={0} max={(gridWidth.current || simWidth) * 2} integer value={agentBrushRadius} onNumber={setAgentBrushRadius} />
                        <span className={styles.statLabel}>Width</span>
                        <NumberField className={styles.brushInput} min={1} max={(gridWidth.current || simWidth) * 2} integer value={agentBrushRingWidth} onNumber={setAgentBrushRingWidth} />
                        {scopeBadge}
                      </div>
                    )}
                    {agentBrushShape === 'line' && (
                      <div className={styles.fieldRow}>
                        <span className={styles.statLabel}>Width</span>
                        <NumberField className={styles.brushInput} min={1} max={(gridWidth.current || simWidth) * 2} integer value={agentBrushLineWidth} onNumber={setAgentBrushLineWidth} />
                        <span className={styles.brushShapeHint}>{agentBrushMode === 'move' ? 'single-agent' : 'click 2 points'}</span>
                      </div>
                    )}
                  </>)}
                  {/* Mode row — the brush actions (labels via textTransform:capitalize). */}
                  <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                    {AGENT_BRUSH_MODES.map(m => (
                      <button
                        key={m}
                        onClick={() => { setAgentBrushMode(m); agentGlueAnchorRef.current = -1; agentLineAnchorRef.current = null; agentLine3dAnchorRef.current = null; draw(); }}
                        title={
                          m === 'add' ? 'Add agents — size 0: one at the cursor; sized: fill the shape footprint' :
                          m === 'remove' ? 'Remove agents — size 0: the nearest; sized: all in the footprint' :
                          m === 'move' ? 'Move — size 0: drag one agent; sized: rigid-drag a footprint of agents (RMB cancels)' :
                          m === 'edit' ? 'Edit agent properties — size 0: click an agent, adjust, Apply; sized: stamp onto all in the footprint' :
                          m === 'glue' ? 'Click two agents to bond them' :
                          m === 'cut' ? 'Click two bonded agents to unbond them' :
                          'Drag to bond agent pairs within the scan radius that are close enough to touch (needs Max Bonds ≥ 1 in Properties › Bond-Graph Agents)'
                        }
                        style={{
                          padding: '3px 8px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', textTransform: 'capitalize',
                          border: '1px solid ' + (agentBrushMode === m ? 'var(--color-accent)' : 'var(--color-widget-border)'),
                          background: agentBrushMode === m ? 'var(--color-accent-soft)' : 'transparent',
                          color: agentBrushMode === m ? 'var(--color-accent)' : 'var(--color-text-muted)',
                          fontWeight: 600, fontSize: '0.64rem',
                        }}
                      >{m}</button>
                    ))}
                  </div>
                  {/* Add: density + spacing (area scatter) + the initial-value config. */}
                  {agentBrushMode === 'add' && agentBrushScope === 'area' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span style={{ width: 54, color: 'var(--color-text-muted)' }}>Density</span>
                        <NumberField value={agentSeedDensity} onNumber={v => setAgentSeedDensity(Math.max(0, v))} min={0} step={0.01} />
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span style={{ width: 54, color: 'var(--color-text-muted)' }}>Spacing</span>
                        <NumberField value={agentSeedSpacing} onNumber={v => setAgentSeedSpacing(Math.max(0.5, v))} min={0.5} step={1} />
                      </label>
                    </div>
                  )}
                  {agentBrushMode === 'add' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <button
                        onClick={() => setAgentSeedConfigOpen(v => !v)}
                        style={{ alignSelf: 'flex-start', padding: '2px 6px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', border: '1px solid var(--color-widget-border)', background: 'transparent', color: 'var(--color-text-muted)', fontSize: '0.62rem' }}
                        title="Initial agent-attribute values for added agents"
                      >{agentSeedConfigOpen ? '▾' : '▸'} Add config</button>
                      {agentSeedConfigOpen && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <ManualBrushPanel
                            cellAttributes={(model.agentAttributes ?? []).filter(a => a.type !== 'color' && a.type !== 'lookupTable')}
                            neighborhoods={model.neighborhoods}
                            state={agentSeedAttrs}
                            onChange={setAgentSeedAttrs}
                            is3d={is3D}
                          />
                        </div>
                      )}
                    </div>
                  )}
                  {/* Bond: the auto-bond scan radius. */}
                  {agentBrushMode === 'bond' && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ width: 54, color: 'var(--color-text-muted)' }}>Radius</span>
                      <NumberField value={agentBrushRadius} onNumber={v => setAgentBrushRadius(v)} min={0} step={1} />
                    </label>
                  )}
                  {/* Edit: which properties to overwrite + Apply (single scope). */}
                  {agentBrushMode === 'edit' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <div style={{ fontSize: '0.62rem', color: 'var(--color-text-muted)' }}>
                        {agentBrushScope === 'single'
                          ? (editTargetId >= 0 ? `Editing agent #${editTargetId} — check the rows to overwrite, then Apply.` : 'Click an agent to load its values, then Apply.')
                          : 'Click / drag the footprint to stamp the checked rows onto agents.'}
                      </div>
                      {!Object.values(agentEditAttrs).some(e => e?.enabled) && (
                        <div style={{ fontSize: '0.62rem', color: 'var(--color-accent)' }}>
                          ⚠ Check a property below to choose what to overwrite.
                        </div>
                      )}
                      <ManualBrushPanel
                        cellAttributes={agentEditPanelAttrs}
                        neighborhoods={model.neighborhoods}
                        state={agentEditAttrs}
                        onChange={setAgentEditAttrs}
                        is3d={is3D}
                      />
                      {agentBrushScope === 'single' && (
                        <button
                          disabled={editTargetId < 0}
                          onClick={() => { if (editTargetIdRef.current >= 0) applyAgentEditToIds([editTargetIdRef.current]); }}
                          style={{ alignSelf: 'flex-start', padding: '3px 10px', borderRadius: 'var(--radius-sm)', cursor: editTargetId < 0 ? 'default' : 'pointer', border: '1px solid var(--color-accent)', background: editTargetId < 0 ? 'transparent' : 'var(--color-accent-soft)', color: editTargetId < 0 ? 'var(--color-text-muted)' : 'var(--color-accent)', opacity: editTargetId < 0 ? 0.5 : 1, fontWeight: 600, fontSize: '0.64rem' }}
                        >Apply to agent</button>
                      )}
                    </div>
                  )}
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.64rem', color: 'var(--color-text-muted)' }}>
                    <input type="checkbox" checked={showBrushCursor} onChange={e => setShowBrushCursor(e.target.checked)} />
                    Show brush cursor
                  </label>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    <button
                      onClick={() => csvInputRef.current?.click()}
                      title="Import agents from a CSV — one row per agent; columns map to position / velocity / radius / agent attributes"
                      style={{ padding: '3px 8px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', border: '1px solid var(--color-widget-border)', background: 'transparent', color: 'var(--color-text-muted)', fontSize: '0.62rem' }}
                    >Import CSV…</button>
                    <button
                      onClick={() => workerRef.current?.postMessage({ type: 'clearAgents', activeViewer: activeViewerRef.current })}
                      style={{ padding: '3px 8px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', border: '1px solid var(--color-widget-border)', background: 'transparent', color: 'var(--color-text-muted)', fontSize: '0.62rem' }}
                    >Clear all agents</button>
                  </div>
              </div>
            </div>
          )}

          {/* Splitter: drag to trade the ACTIVE brush section's height (Input
              Mapping for the CA grid, Agent Brush for agents — both carry
              brushSectionRef, and exactly one renders) for the indicators section
              below. Double-click resets to auto (shrink-to-content). */}
          {(model.indicators || []).length > 0 && (
            <div
              className={styles.rightSectionSplitter}
              title="Drag to resize the brush / indicators split — double-click to reset"
              onMouseDown={e => {
                e.preventDefault();
                const brushEl = brushSectionRef.current;
                const panel = rightPanelRef.current;
                if (!brushEl || !panel) return;
                const startY = e.clientY;
                const startH = brushEl.offsetHeight;
                // Clamp the cap to >= the 60px floor so on a very short panel the
                // min doesn't silently win over a sub-60 max (which would let the
                // brush section eat the whole panel).
                const maxH = Math.max(60, panel.offsetHeight - 140); // keep the indicators usable
                const onMove = (ev: MouseEvent) => {
                  setBrushSectionH(Math.max(60, Math.min(maxH, startH + (ev.clientY - startY))));
                };
                const onUp = () => {
                  document.removeEventListener('mousemove', onMove);
                  document.removeEventListener('mouseup', onUp);
                };
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
              }}
              onDoubleClick={() => setBrushSectionH(null)}
            />
          )}

          {/* Indicators Section (bottom, fills remaining space) */}
          {(model.indicators || []).length > 0 && (
            <div className={`${styles.rightPanelSection} ${styles.rightSectionIndicators}`}>
              <div className={styles.panelHeader}>
                <span className={styles.panelTitle}>Indicators</span>
              </div>
              <div className={styles.rightPanelSectionBody}>
              <IndicatorDisplay
                indicators={model.indicators || []}
                values={indicatorValuesRef.current}
                history={indicatorHistoryRef.current}
                generation={generation}
                gridWidth={gridWidth.current || simWidth}
                gridHeight={gridHeight.current || simHeight}
                gridDepth={gridDepth.current || 1}
                vizModes={indicatorVizModes}
                hiddenCategories={indicatorHiddenCategories}
                chartOverrides={indicatorChartOverrides}
                onToggleWatch={(id, watched) => updateIndicator(id, { watched })}
                onChartToggle={(id, expanded) => {
                  if (expanded) chartExpandedRef.current.add(id);
                  else chartExpandedRef.current.delete(id);
                }}
                onCycleVizMode={cycleIndicatorVizMode}
                onSetVizMode={setIndicatorVizMode}
                onToggleCategory={toggleIndicatorCategory}
                onChangeChartOverrides={changeIndicatorChartOverrides}
                onClearHistory={clearIndicatorHistory}
                categoryOrders={indicatorCategoryOrders}
              />
              </div>
            </div>
          )}
          </>)}

          {/* === Overseer Experiments tab === */}
          {overseerEnabled && rightPanelTab === 'experiments' && (
            <ExperimentsPanel
              runtime={overseerRuntimeRef.current}
              running={overseerRunning}
              version={overseerVersion}
              compileError={overseerCompiled.error}
              hasExperiment={!!overseerCompiled.driverCode}
              modelName={model.properties.name}
              spatialMeta={(indicatorId: string) => {
                // Axis metadata for the spatial aggregate charts (X labels).
                const ind = (model.indicators || []).find(i => i.id === indicatorId);
                if (!ind || !ind.xAxis || ind.xAxis === 'generation') return null;
                const axisLen = ind.xAxis === 'rows' ? (gridHeight.current || simHeight)
                  : ind.xAxis === 'columns' ? (gridWidth.current || simWidth)
                  : (gridDepth.current || 1);
                const binSize = (ind.spatialBinMode ?? 'slices') === 'absolute'
                  ? Math.max(1, ind.spatialBinSize ?? 1)
                  : Math.max(1, Math.ceil(axisLen / Math.max(2, Math.min(ind.spatialBinCount ?? 50, axisLen))));
                return {
                  axisName: ind.xAxis === 'rows' ? 'row' : ind.xAxis === 'columns' ? 'column' : 'layer',
                  binSize,
                };
              }}
              onRun={handleRunExperiment}
              onAbort={() => abortExperiment('user abort')}
            />
          )}
        </div>
      )}
      {colorPopover && (
        <BrushColorPopover
          x={colorPopover.x}
          y={colorPopover.y}
          color={brushColor}
          onChange={setBrushColor}
          onClose={() => setColorPopover(null)}
        />
      )}
      {inspectPopovers.map(p => (
        <InspectCellPopover
          key={p.cellIdx}
          popover={p}
          cellAttrs={model.attributes.filter(a => !a.isModelAttribute)}
          values={inspectDataRef.current.get(p.cellIdx) ?? null}
          color={inspectColorsRef.current.get(p.cellIdx) ?? null}
          orientation={inspectOrientationsRef.current.get(p.cellIdx) ?? null}
          is3d={model.properties.dimension === '3d' && (model.properties.gridDepth ?? 1) > 1}
          pulse={pulseInspectIdx === p.cellIdx}
          focused={focusedInspectIdx === p.cellIdx}
          totalOpen={inspectPopovers.length}
          onClose={() => {
            setInspectPopovers(prev => prev.filter(pp => pp.cellIdx !== p.cellIdx));
            setFocusedInspectIdx(curr => (curr === p.cellIdx ? null : curr));
            setHoveredInspectIdx(curr => (curr === p.cellIdx ? null : curr));
          }}
          onCloseAll={() => {
            setInspectPopovers([]);
            setFocusedInspectIdx(null);
            setHoveredInspectIdx(null);
          }}
          onFocus={() => {
            setFocusedInspectIdx(p.cellIdx);
            setInspectPopovers(prev => {
              const i = prev.findIndex(pp => pp.cellIdx === p.cellIdx);
              if (i < 0 || i === prev.length - 1) return prev;
              const next = [...prev];
              const [moved] = next.splice(i, 1);
              next.push(moved!);
              return next;
            });
          }}
          onDragEnd={(x, y) => {
            setInspectPopovers(prev => prev.map(pp => pp.cellIdx === p.cellIdx ? { ...pp, x, y } : pp));
          }}
          onHoverEnter={() => setHoveredInspectIdx(p.cellIdx)}
          onHoverLeave={() => setHoveredInspectIdx(curr => (curr === p.cellIdx ? null : curr))}
          onRectMeasure={(rect) => { popoverRectsRef.current.set(p.cellIdx, rect); }}
        />
      ))}
      {sweepInspector && (
        <InspectCellPopover
          key="sweep"
          popover={sweepInspector}
          cellAttrs={model.attributes.filter(a => !a.isModelAttribute)}
          values={inspectDataRef.current.get(sweepInspector.cellIdx) ?? null}
          color={inspectColorsRef.current.get(sweepInspector.cellIdx) ?? null}
          orientation={inspectOrientationsRef.current.get(sweepInspector.cellIdx) ?? null}
          is3d={model.properties.dimension === '3d' && (model.properties.gridDepth ?? 1) > 1}
          pulse={false}
          focused={false}
          totalOpen={inspectPopovers.length + 1}
          onClose={() => {}}
          onCloseAll={() => {}}
          onFocus={() => {}}
          onDragEnd={() => {}}
          onHoverEnter={() => {}}
          onHoverLeave={() => {}}
          onRectMeasure={(rect) => { sweepRectRef.current = rect; }}
        />
      )}
      {!is3D && hoveredInspectIdx != null && (() => {
        const p = inspectPopovers.find(pp => pp.cellIdx === hoveredInspectIdx);
        if (!p) return null;
        const cell = gridToScreen(p.row, p.col);
        if (!cell) return null;
        const popupRect = popoverRectsRef.current.get(p.cellIdx);
        return (
          <InspectHoverLink
            cellX={cell.x}
            cellY={cell.y}
            cellSize={cell.cellSize}
            popupRect={popupRect}
          />
        );
      })()}
      {!is3D && sweepInspector && (() => {
        // Always draw the link line + cell outline for the transient sweep
        // popover — it's the user's primary feedback for which cell is being
        // inspected as they drag the cursor around. (2D only — the 3D inspector
        // highlights the cell in the volume instead.)
        const cell = gridToScreen(sweepInspector.row, sweepInspector.col);
        if (!cell) return null;
        return (
          <InspectHoverLink
            cellX={cell.x}
            cellY={cell.y}
            cellSize={cell.cellSize}
            popupRect={sweepRectRef.current ?? undefined}
          />
        );
      })()}
      {presetDialogOpen && (
        <PresetSaveDialog
          onConfirm={(name, description, includeGrid) => {
            setPresetDialogOpen(false);
            handleCreatePreset(name, description, includeGrid);
          }}
          onCancel={() => setPresetDialogOpen(false)}
        />
      )}
      {imageMapImg && (
        <ImageMappingDialog
          img={imageMapImg}
          cellAttributes={model.attributes.filter(a => !a.isModelAttribute)}
          neighborhoods={model.neighborhoods}
          colorToAttrMappings={colorToAttrMappings}
          is3d={model.properties.dimension === '3d' && (model.properties.gridDepth ?? 1) > 1}
          gridWidth={gridWidth.current || simWidth}
          gridHeight={gridHeight.current || simHeight}
          initialUseManual={brushMapping === MANUAL_BRUSH_MAPPING_ID}
          onApply={applyImageMapping}
          onCancel={() => setImageMapImg(null)}
        />
      )}
      {/* One hidden CSV picker for BOTH brush panels (grid + agents). */}
      <input ref={csvInputRef} type="file" accept=".csv,.tsv,.txt,text/csv" style={{ display: 'none' }} onChange={handleCsvInput} />
      {csvImport && (
        <CsvImportDialog
          text={csvImport.text}
          fileName={csvImport.name}
          cellAttributes={model.attributes.filter(a => !a.isModelAttribute)}
          agentAttributes={model.agentAttributes ?? []}
          hasGrid={gridCellsOn}
          hasAgents={isAgentModel}
          is3d={is3D}
          world={{ w: gridWidth.current || simWidth, h: gridHeight.current || simHeight, d: gridDepth.current || simDepth }}
          maxAgents={Math.max(1, Math.floor(cbNum(model.centerBased, 'maxAgents')))}
          torus={model.properties.boundaryTreatment === 'torus'}
          onApply={applyCsvImport}
          onCancel={() => setCsvImport(null)}
        />
      )}
      {presetOverwriteTarget && (
        <PresetSaveDialog
          title={`Overwrite Preset "${presetOverwriteTarget.name}"`}
          confirmLabel="Overwrite"
          initialName={presetOverwriteTarget.name}
          initialDescription={presetOverwriteTarget.description ?? ''}
          onConfirm={(name, description, includeGrid) => {
            const target = presetOverwriteTarget;
            setPresetOverwriteTarget(null);
            doOverwritePreset(target, name, description, includeGrid);
          }}
          onCancel={() => setPresetOverwriteTarget(null)}
        />
      )}
      {presetToRename && (
        <PresetSaveDialog
          title={`Rename Preset "${presetToRename.name}"`}
          confirmLabel="Rename"
          initialName={presetToRename.name}
          initialDescription={presetToRename.description ?? ''}
          hideGridOption
          onConfirm={(name, description) => {
            const id = presetToRename.id;
            setPresetToRename(null);
            // Metadata only — the preset's embedded state is untouched.
            updatePreset(id, { name, description });
          }}
          onCancel={() => setPresetToRename(null)}
        />
      )}
      {presetToDelete && (
        <ConfirmDialog
          title="Delete preset?"
          message={`The preset "${presetToDelete.name}" will be removed from this model.`}
          confirmLabel="Delete"
          danger
          onConfirm={() => {
            const id = presetToDelete.id;
            setPresetToDelete(null);
            deletePreset(id);
          }}
          onCancel={() => setPresetToDelete(null)}
        />
      )}
      {presetToOverwrite && (
        <ConfirmDialog
          title="Overwrite preset?"
          message={`Replace "${presetToOverwrite.name}" with the current simulation state? The current data in this preset will be lost.`}
          confirmLabel="Overwrite"
          danger
          onConfirm={() => {
            const target = presetToOverwrite;
            setPresetToOverwrite(null);
            setPresetOverwriteTarget(target);
          }}
          onCancel={() => setPresetToOverwrite(null)}
        />
      )}
    </div>
  );
}
