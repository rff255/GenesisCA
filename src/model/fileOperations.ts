import { SCHEMA_VERSION } from './schema';
import type { CAModel, SimulationState, SerializedTypedArray, Attribute } from './types';
import { packNI, INVALID_NI } from '../modeler/vpl/compiler/niCodec';

/** Wave A.6: migrate one v1 NeighborIndex value (slot-index string) to a
 *  v2 packed (dr, dc) i32 string using the attribute's neighborhood hint.
 *
 *  Legacy v1 stored a slot index (`0..nbrSize-1`) into a specific
 *  neighborhood. v2 stores `(dr << 16) | (dc & 0xFFFF)` — neighborhood-
 *  agnostic. We look up `coords[slotIndex]` on the hint and pack.
 *
 *  Failure modes (each returns INVALID_NI as a loud sentinel and lets the
 *  caller emit a per-attribute warning):
 *    - Empty / non-finite slot string  → INVALID_NI
 *    - Hint missing or dangling        → INVALID_NI
 *    - Slot index out of range         → INVALID_NI
 *
 *  Using INVALID_NI rather than the raw slot string ensures v2 readers see
 *  an explicit "no neighbor" sentinel instead of silently re-interpreting
 *  the slot integer as a packed offset. Consumers (editor, runtime) treat
 *  INVALID_NI as "unset" and the user can re-pick via the editor. */
function migrateNiSlotToPacked(slotStr: string, attr: Attribute, model: CAModel): { value: string; reason?: string } {
  const slot = parseInt(slotStr, 10);
  if (!Number.isFinite(slot)) {
    return { value: String(INVALID_NI), reason: `slot value "${slotStr}" is not a finite integer` };
  }
  if (!attr.neighborhoodHintId) {
    return { value: String(INVALID_NI), reason: 'no neighborhoodHintId set' };
  }
  const nbr = model.neighborhoods.find(n => n.id === attr.neighborhoodHintId);
  if (!nbr) {
    return { value: String(INVALID_NI), reason: `neighborhoodHintId "${attr.neighborhoodHintId}" references a deleted neighborhood` };
  }
  const coord = nbr.coords[slot];
  if (!coord) {
    return { value: String(INVALID_NI), reason: `slot index ${slot} is out of range for neighborhood "${nbr.name}" (${nbr.coords.length} coords)` };
  }
  return { value: String(packNI(coord[0]!, coord[1]!)) };
}

/** Walk every NI cell-attribute array in the embedded simulationState and
 *  translate each Int32 slot-index element to a packed (dr, dc) i32 using
 *  the attribute's hint neighborhood. Out-of-range slots and missing-hint
 *  attrs both map to INVALID_NI (a loud sentinel rather than silent self-
 *  reference). Element-by-element decode/re-encode of the base64 buffer. */
function migrateNiCellAttrArraysV1toV2(state: { attributes?: Record<string, SerializedTypedArray> } | undefined, model: CAModel): void {
  const attrs = state?.attributes;
  if (!attrs) return;
  for (const attr of model.attributes) {
    if (attr.type !== 'neighborIndex' || attr.isModelAttribute) continue;
    const entry = attrs[attr.id];
    if (!entry || entry.type !== 'int32') continue;
    const nbr = attr.neighborhoodHintId
      ? model.neighborhoods.find(n => n.id === attr.neighborhoodHintId)
      : undefined;
    const buf = base64ToArrayBuffer(entry.data);
    const arr = new Int32Array(buf);
    if (!nbr) {
      // No hint or dangling hint — we can't translate slot indices. Fill with
      // INVALID_NI so the v2 reader sees a clear "unset" sentinel rather than
      // silently mis-reading slot integers as packed offsets.
      console.warn(
        `[wave-a.6] NeighborIndex cell attribute "${attr.name}": `
        + (attr.neighborhoodHintId
          ? `neighborhoodHintId "${attr.neighborhoodHintId}" references a deleted neighborhood; `
          : `no neighborhoodHintId set; `)
        + `${arr.length} cell entries cannot be migrated and have been set to INVALID_NI. `
        + `Reload the saved state after re-picking a hint or rebuilding the grid.`,
      );
      arr.fill(INVALID_NI);
    } else {
      let bad = 0;
      for (let i = 0; i < arr.length; i++) {
        const slot = arr[i]!;
        const coord = (slot >= 0 && slot < nbr.coords.length) ? nbr.coords[slot] : undefined;
        if (coord) {
          arr[i] = packNI(coord[0]!, coord[1]!);
        } else {
          arr[i] = INVALID_NI;
          bad++;
        }
      }
      if (bad > 0) {
        console.warn(
          `[wave-a.6] NeighborIndex cell attribute "${attr.name}": `
          + `${bad}/${arr.length} cell entries had out-of-range slot indices `
          + `(neighborhood "${nbr.name}" has ${nbr.coords.length} coords) and were set to INVALID_NI.`,
        );
      }
    }
    entry.data = arrayBufferToBase64(arr.buffer);
  }
}

/** Walk model.attributes and migrate NI default/boundary values from
 *  v1 slot index to v2 packed (dr, dc). Mutates the attributes in place.
 *  Each problematic attribute emits its own console warning so the user
 *  can address them all in one pass instead of round-tripping fixes. */
function migrateNiAttributesV1toV2(model: CAModel): void {
  for (const attr of model.attributes) {
    if (attr.type !== 'neighborIndex') continue;
    const dv = migrateNiSlotToPacked(attr.defaultValue, attr, model);
    if (dv.reason) {
      console.warn(
        `[wave-a.6] NeighborIndex attribute "${attr.name}" defaultValue `
        + `"${attr.defaultValue}" could not be migrated (${dv.reason}); `
        + `set to INVALID_NI. Re-pick via the editor.`,
      );
    }
    attr.defaultValue = dv.value;
    if (attr.boundaryValue !== undefined && attr.boundaryValue.length > 0) {
      const bv = migrateNiSlotToPacked(attr.boundaryValue, attr, model);
      if (bv.reason) {
        console.warn(
          `[wave-a.6] NeighborIndex attribute "${attr.name}" boundaryValue `
          + `"${attr.boundaryValue}" could not be migrated (${bv.reason}); `
          + `set to INVALID_NI. Re-pick via the editor.`,
        );
      }
      attr.boundaryValue = bv.value;
    }
  }
}

/** Standalone .gcastate v1→v2 migration. Models that loaded the state never
 *  knew it was a v1 file (state files have no schemaVersion field pre-A.6),
 *  so the loader has to be told explicitly. Called by `applySimulationState`
 *  in SimulatorView when a state with `schemaVersion < 2` (or absent) is
 *  loaded into a v2 model that has NI cell attributes. */
export function migrateSimulationStateV1toV2(state: SimulationState, model: CAModel): void {
  migrateNiCellAttrArraysV1toV2(state, model);
  state.schemaVersion = SCHEMA_VERSION;
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
      // Treat absent schemaVersion as v1 — earlier builds didn't always stamp
      // the version, so a hand-edited or pre-versioning file might lack it
      // even though it has NI attrs. Running migration on a model without NI
      // attrs is a no-op (loop iterates zero times), so this is safe.
      if ((model.schemaVersion ?? 1) < 2) {
        migrateNiAttributesV1toV2(model);
        // Embedded simulationState's NI cell-attr arrays also need translation
        // (per-element). The slot index N becomes the packed value coords[N].
        if (model.simulationState?.attributes) {
          migrateNiCellAttrArraysV1toV2(model.simulationState, model);
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
  const serialized: SimulationState = { schemaVersion: SCHEMA_VERSION };
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
  const out: SimulationState = { schemaVersion: SCHEMA_VERSION, modelAttrs: { ...workerState.modelAttrs } };
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
