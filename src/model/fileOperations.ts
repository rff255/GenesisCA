import { SCHEMA_VERSION } from './schema';
import type { CAModel, SimulationState, SerializedTypedArray, Attribute } from './types';
import { packNI } from '../modeler/vpl/compiler/niCodec';

/** Wave A.6: migrate v1 NeighborIndex attribute values (slot indices) to
 *  v2 packed (dr, dc) i32 using the attribute's neighborhood hint.
 *
 *  Legacy v1 stored a slot index (`0..nbrSize-1`) of a specific neighborhood.
 *  v2 stores packed `(dr << 16) | (dc & 0xFFFF)` — neighborhood-agnostic.
 *  When the hint is set we look up `coords[slotIndex]` and pack; otherwise
 *  we leave the value unchanged (a console warning fires) — the user will
 *  re-pick a default via the editor's clickable grid.
 *
 *  Returns true if the value was migrated, false if left unchanged. */
function migrateNiSlotToPacked(slotStr: string, attr: Attribute, model: CAModel): string {
  const slot = parseInt(slotStr, 10);
  if (!Number.isFinite(slot)) return slotStr;
  if (!attr.neighborhoodHintId) return slotStr;
  const nbr = model.neighborhoods.find(n => n.id === attr.neighborhoodHintId);
  if (!nbr) return slotStr;
  const coord = nbr.coords[slot];
  if (!coord) return slotStr;
  return String(packNI(coord[0]!, coord[1]!));
}

/** Walk every NI cell-attribute array in the embedded simulationState and
 *  translate each Int32 slot-index element to a packed (dr, dc) i32 using
 *  the attribute's hint neighborhood. Element-by-element decode of the
 *  base64-encoded buffer; re-encodes back to base64 in place. */
function migrateNiCellAttrArraysV1toV2(model: CAModel): void {
  const sim = model.simulationState;
  if (!sim?.attributes) return;
  for (const attr of model.attributes) {
    if (attr.type !== 'neighborIndex' || attr.isModelAttribute) continue;
    if (!attr.neighborhoodHintId) continue;
    const nbr = model.neighborhoods.find(n => n.id === attr.neighborhoodHintId);
    if (!nbr) continue;
    const entry = sim.attributes[attr.id];
    if (!entry || entry.type !== 'int32') continue;
    // Decode → translate → encode.
    const buf = base64ToArrayBuffer(entry.data);
    const arr = new Int32Array(buf);
    for (let i = 0; i < arr.length; i++) {
      const slot = arr[i]!;
      const coord = (slot >= 0 && slot < nbr.coords.length) ? nbr.coords[slot] : undefined;
      arr[i] = coord ? packNI(coord[0]!, coord[1]!) : 0;
    }
    entry.data = arrayBufferToBase64(arr.buffer);
  }
}

/** Walk model.attributes and migrate NI default/boundary values from
 *  v1 slot index to v2 packed (dr, dc). Mutates the attributes in place. */
function migrateNiAttributesV1toV2(model: CAModel): void {
  let warned = false;
  for (const attr of model.attributes) {
    if (attr.type !== 'neighborIndex') continue;
    if (!attr.neighborhoodHintId) {
      if (!warned) {
        console.warn(
          `[wave-a.6] NeighborIndex attribute "${attr.name}" has no `
          + `neighborhoodHintId — its default value (slot-index "${attr.defaultValue}") `
          + `cannot be migrated to packed (dr, dc) automatically. `
          + `Please re-pick the default via the editor.`,
        );
        warned = true;
      }
      continue;
    }
    attr.defaultValue = migrateNiSlotToPacked(attr.defaultValue, attr, model);
    if (attr.boundaryValue !== undefined && attr.boundaryValue.length > 0) {
      attr.boundaryValue = migrateNiSlotToPacked(attr.boundaryValue, attr, model);
    }
  }
}

/** Pretty-print JSON for .gcaproj files with targeted single-line inlining for
 *  structurally-small, high-volume arrays that make default 2-space pretty-print
 *  output unwieldy.
 *
 *  Inlined paths:
 *   - `coords` (neighborhood coords: Array<[number, number]>) — whole array on
 *     one line: `"coords": [[-1,-1], [-1,0], ...]`. A Moore neighborhood drops
 *     from ~24 lines to 1; dense MNCA neighborhoods from thousands to one each.
 *   - `graphEdges` and each macro's `edges` — one edge per line, each edge
 *     fully inlined on its own line instead of spanning 5-7 lines.
 *   - `graphNodes` and each macro's `nodes` — one node per line. Each node is
 *     {id, type, position, data:{nodeType, config:{...}}} which pretty-prints
 *     to 10-14 lines at indent=2; with many nodes this dominates the file.
 *     Lines do get long for nodes with dense configs (e.g. Switch with many
 *     cases), but the file stays valid JSON and diffs cleanly per-node.
 *
 *  Output is still valid JSON parseable by `JSON.parse` — only whitespace
 *  inside specific subtrees is compacted. `readModelFile` is unchanged. */
function stringifyCompact(value: unknown, indent = 2, level = 0, parentKey: string | null = null): string {
  const pad = ' '.repeat(indent * level);
  const childPad = ' '.repeat(indent * (level + 1));

  // Native JSON.stringify handles null, number, string, bool, and also returns
  // `undefined` (not the string) for `undefined` / functions / symbols. Our
  // object path below filters those out before recursing, so reaching this
  // branch with `undefined` would only happen on a top-level call — which
  // never happens for a CAModel. Safe to defer.
  if (value === null || typeof value !== 'object') return JSON.stringify(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (parentKey === 'coords') {
      return '[' + value.map(c => JSON.stringify(c)).join(', ') + ']';
    }
    if (
      parentKey === 'graphEdges' || parentKey === 'edges'
      || parentKey === 'graphNodes' || parentKey === 'nodes'
    ) {
      const items = value.map(v => JSON.stringify(v));
      return '[\n' + items.map(i => childPad + i).join(',\n') + '\n' + pad + ']';
    }
    // Arrays: replace undefined entries with null (matches native JSON.stringify
    // behaviour — they can't be omitted without changing array length).
    const items = value.map(v => v === undefined ? 'null' : stringifyCompact(v, indent, level + 1, null));
    return '[\n' + items.map(i => childPad + i).join(',\n') + '\n' + pad + ']';
  }

  // Objects: skip keys whose value is undefined (or a function/symbol). This
  // matches the behaviour of native `JSON.stringify(obj, null, 2)` — otherwise
  // we emit `"foo": undefined` which is not valid JSON and breaks round-trip.
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && typeof v !== 'function' && typeof v !== 'symbol');
  if (entries.length === 0) return '{}';
  const items = entries.map(([k, v]) =>
    childPad + JSON.stringify(k) + ': ' + stringifyCompact(v, indent, level + 1, k),
  );
  return '{\n' + items.join(',\n') + '\n' + pad + '}';
}

export function serializeModel(model: CAModel): string {
  return stringifyCompact(model);
}

export function modelFilename(model: CAModel): string {
  const base = model.properties.name
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
  return `${base || 'model'}.gcaproj`;
}

export function downloadJSON(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function readModelFile(file: File): Promise<CAModel> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const raw = reader.result as string;
      // Strip a UTF-8 BOM if an editor added one. Leaving it in front of `{`
      // makes JSON.parse throw "Unexpected token" at position 0 on files that
      // look identical to the eye.
      let text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
      let model: CAModel;
      try {
        model = JSON.parse(text) as CAModel;
      } catch (err) {
        // Recovery: older GenesisCA builds (pre-1.8.1) had a custom serializer
        // bug that emitted `"<key>": undefined` when a top-level field was
        // undefined. That's invalid JSON and blocks re-loading the file.
        // Strip those keys so the rest of the file parses.
        const msg0 = err instanceof Error ? err.message : String(err);
        if (/undefined/i.test(msg0)) {
          const cleaned = text
            // `"key": undefined,` → remove entirely
            .replace(/"[A-Za-z0-9_]+"\s*:\s*undefined\s*,?/g, '')
            // Clean up a trailing comma that might now precede `}` or `]`
            .replace(/,(\s*[}\]])/g, '$1');
          try {
            model = JSON.parse(cleaned) as CAModel;
            text = cleaned; // for any downstream diagnostics
          } catch (err2) {
            const msg = err2 instanceof Error ? err2.message : String(err2);
            const posMatch = msg.match(/position (\d+)/);
            let snippet = '';
            if (posMatch) {
              const pos = Number(posMatch[1]);
              const start = Math.max(0, pos - 40);
              const end = Math.min(cleaned.length, pos + 40);
              snippet = `\nNear: ...${cleaned.slice(start, end).replace(/\n/g, '\\n')}...`;
            }
            reject(new Error(`Failed to parse file: ${msg}${snippet}`));
            return;
          }
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          // Show the parser's position + a short window of file content around
          // it so the user can see exactly what tripped it.
          const posMatch = msg.match(/position (\d+)/);
          let snippet = '';
          if (posMatch) {
            const pos = Number(posMatch[1]);
            const start = Math.max(0, pos - 40);
            const end = Math.min(text.length, pos + 40);
            snippet = `\nNear: ...${text.slice(start, end).replace(/\n/g, '\\n')}...`;
          }
          reject(new Error(`Failed to parse file: ${msg}${snippet}`));
          return;
        }
      }
      if (!model.properties || !model.attributes) {
        reject(new Error('Invalid file: missing required model fields.'));
        return;
      }
      if (
        model.schemaVersion != null &&
        model.schemaVersion > SCHEMA_VERSION
      ) {
        reject(
          new Error(
            `File uses schema version ${model.schemaVersion}, but this app supports up to version ${SCHEMA_VERSION}. Please update GenesisCA.`,
          ),
        );
        return;
      }
      // Wave A.6: v1 → v2 migration translates slot-index NI default values
      // into packed (dr, dc) using each NI attribute's neighborhoodHintId.
      // Skipped silently when schemaVersion is already >= 2 or undefined for
      // very old files (which had no NI attrs).
      if (model.schemaVersion != null && model.schemaVersion < 2) {
        migrateNiAttributesV1toV2(model);
        // Embedded simulationState's NI cell-attr arrays also need translation
        // (per-element). The slot index N becomes the packed value coords[N].
        if (model.simulationState?.attributes) {
          migrateNiCellAttrArraysV1toV2(model);
        }
      }
      model.schemaVersion = SCHEMA_VERSION;
      resolve(model);
    };
    reader.onerror = () => reject(new Error('Failed to read file.'));
    reader.readAsText(file);
  });
}

// ---------------------------------------------------------------------------
// Simulation State (.gcastate) serialization
// ---------------------------------------------------------------------------

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export function deserializeTypedArray(
  entry: SerializedTypedArray,
  size: number,
): Float64Array | Int32Array | Uint8Array {
  const buffer = base64ToArrayBuffer(entry.data);
  switch (entry.type) {
    case 'uint8': return new Uint8Array(buffer).slice(0, size);
    case 'int32': return new Int32Array(buffer).slice(0, size);
    case 'float64': return new Float64Array(buffer).slice(0, size);
    default: return new Float64Array(buffer).slice(0, size);
  }
}

const ATTR_TYPE_MAP: Record<string, 'uint8' | 'int32' | 'float64'> = {
  bool: 'uint8', integer: 'int32', float: 'float64', tag: 'int32',
};

export function serializeSimState(
  workerState: {
    generation: number;
    width: number;
    height: number;
    attributes: Record<string, { type: string; buffer: ArrayBuffer }>;
    modelAttrs: Record<string, number>;
    indicators: Record<string, number>;
    linkedAccumulators: Record<string, number | Record<string, number>>;
    colors: ArrayBuffer;
    orderArray?: ArrayBuffer;
  },
  uiSettings: {
    activeViewer: string;
    brushColor: string;
    brushW: number;
    brushH: number;
    brushMapping: string;
    targetFps: number;
    unlimitedFps: boolean;
    gensPerFrame: number;
    unlimitedGens: boolean;
  },
  include: { grid?: boolean; controls?: boolean } = { grid: true, controls: true },
  modelStructure?: { boundaryTreatment?: import('./types').BoundaryTreatment },
): SimulationState {
  const wantGrid = include.grid !== false;
  const wantControls = include.controls !== false;
  const serialized: SimulationState = {};
  // Model structure (boundary + grid dims) is always useful context; save it whenever either side is wanted.
  if (modelStructure?.boundaryTreatment) serialized.boundaryTreatment = modelStructure.boundaryTreatment;
  serialized.gridWidth = workerState.width;
  serialized.gridHeight = workerState.height;
  if (wantGrid) {
    // Saved grid state is a starting configuration — NOT a run snapshot.
    // We deliberately skip `generation`, `indicators`, and `linkedAccumulators`
    // so a loaded state always begins from generation 0 with fresh indicator
    // values. The fields remain optional in the type for back-compat with
    // older files (loader ignores them).
    serialized.width = workerState.width;
    serialized.height = workerState.height;
    serialized.attributes = {};
    serialized.colors = arrayBufferToBase64(workerState.colors);
    for (const [id, entry] of Object.entries(workerState.attributes)) {
      serialized.attributes[id] = {
        type: ATTR_TYPE_MAP[entry.type] || 'float64',
        data: arrayBufferToBase64(entry.buffer),
      };
    }
    if (workerState.orderArray) {
      serialized.orderArray = arrayBufferToBase64(workerState.orderArray);
    }
  }
  if (wantControls) {
    serialized.modelAttrs = workerState.modelAttrs;
    serialized.activeViewer = uiSettings.activeViewer;
    serialized.brushColor = uiSettings.brushColor;
    serialized.brushW = uiSettings.brushW;
    serialized.brushH = uiSettings.brushH;
    serialized.brushMapping = uiSettings.brushMapping;
    serialized.targetFps = uiSettings.targetFps;
    serialized.unlimitedFps = uiSettings.unlimitedFps;
    serialized.gensPerFrame = uiSettings.gensPerFrame;
    serialized.unlimitedGens = uiSettings.unlimitedGens;
  }
  return serialized;
}

/** Serialize a preset snapshot. Always includes model-attribute values; includes
 *  grid state only when opts.includeGrid is true. UI controls (brush, viewer,
 *  FPS) are never captured — those are user preferences, not model setup. */
export function serializePreset(
  workerState: {
    generation: number;
    width: number;
    height: number;
    attributes: Record<string, { type: string; buffer: ArrayBuffer }>;
    modelAttrs: Record<string, number>;
    indicators: Record<string, number>;
    linkedAccumulators: Record<string, number | Record<string, number>>;
    colors: ArrayBuffer;
    orderArray?: ArrayBuffer;
  },
  opts: { includeGrid: boolean },
  modelStructure?: { boundaryTreatment?: import('./types').BoundaryTreatment },
): SimulationState {
  const out: SimulationState = { modelAttrs: { ...workerState.modelAttrs } };
  // Grid dimensions and boundary treatment are saved even for parameter-only presets so loading
  // one can restore the model structure, not just the scalar parameters.
  if (modelStructure?.boundaryTreatment) out.boundaryTreatment = modelStructure.boundaryTreatment;
  out.gridWidth = workerState.width;
  out.gridHeight = workerState.height;
  if (opts.includeGrid) {
    // Presets also store starting configurations — skip generation + indicators
    // for the same reason as serializeSimState above.
    out.width = workerState.width;
    out.height = workerState.height;
    out.attributes = {};
    out.colors = arrayBufferToBase64(workerState.colors);
    for (const [id, entry] of Object.entries(workerState.attributes)) {
      out.attributes[id] = {
        type: ATTR_TYPE_MAP[entry.type] || 'float64',
        data: arrayBufferToBase64(entry.buffer),
      };
    }
    if (workerState.orderArray) {
      out.orderArray = arrayBufferToBase64(workerState.orderArray);
    }
  }
  return out;
}

export function downloadStateFile(state: SimulationState, filename: string): void {
  const blob = new Blob([JSON.stringify(state)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function readStateFile(file: File): Promise<SimulationState> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const state = JSON.parse(reader.result as string) as SimulationState;
        if (!state.width || !state.height || !state.attributes) {
          reject(new Error('Invalid state file: missing required fields.'));
          return;
        }
        resolve(state);
      } catch {
        reject(new Error('Failed to parse state file. Is it valid JSON?'));
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file.'));
    reader.readAsText(file);
  });
}
