import { SCHEMA_VERSION } from './schema';
import type { CAModel, SimulationState, SerializedTypedArray, Attribute, Preset } from './types';
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
      || parentKey === 'agentGraphEdges' || parentKey === 'agentGraphNodes'
      || parentKey === 'overseerGraphEdges' || parentKey === 'overseerGraphNodes'
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

/** True when running inside the Tauri native shell (WebView2 on Windows). */
function inTauriShell(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Native Save As. Returns the chosen absolute path, or null if cancelled. */
async function nativeSavePath(filename: string): Promise<string | null> {
  const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.') + 1) : '';
  const { save } = await import('@tauri-apps/plugin-dialog');
  const path = await save({
    defaultPath: filename,
    filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : [],
  });
  return path ?? null;
}

/** The browser / PWA download path: an anchor click on an object URL. */
function browserDownload(blob: Blob, filename: string): true {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return true;
}

/**
 * Save text to a file. In the native (Tauri) shell, open a real OS "Save As"
 * dialog and write via the host `save_text_file` command — the browser
 * blob-download path below is silently dropped by WebView2, so the file never
 * gets created. In the browser / installed PWA, fall back to the blob download.
 * Returns true if a file was written, false if the user cancelled the native
 * Save As dialog.
 *
 * EVERY download in the app must go through this or `saveBinaryFile` — a bare
 * `<a download>` writes nothing at all in the desktop build, silently.
 */
export async function saveTextFile(content: string, filename: string, mime: string): Promise<boolean> {
  if (inTauriShell()) {
    const path = await nativeSavePath(filename);
    if (!path) return false; // user cancelled the Save As dialog
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('save_text_file', { path, contents: content });
    return true;
  }
  return browserDownload(new Blob([content], { type: mime }), filename);
}

/** Header carrying the save-session token on each `save_binary_chunk` invoke.
 *  Must match SAVE_TOKEN_HEADER in src-tauri/src/lib.rs. */
const SAVE_TOKEN_HEADER = 'x-genesis-save-token';

/** Bytes per native IPC chunk. Bounds peak memory on BOTH sides (the JS slice
 *  and the Rust `Vec<u8>`), so file size is limited by DISK, not by RAM or by
 *  any single-message IPC ceiling — a multi-hundred-MB recording streams
 *  through in 8 MiB pieces. Larger = fewer round trips but a bigger transient. */
const NATIVE_CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * Save BINARY data to a file — the exact sibling of `saveTextFile`, and the
 * only correct way to write a recording (.webm/.gif), a screenshot (.png), or
 * any other non-text artefact.
 *
 * Native (Tauri): a real OS Save As dialog, then a chunked stream through
 * `save_binary_begin` / `save_binary_chunk` / `save_binary_end`. Each chunk
 * travels as the invoke RAW BODY (a `Uint8Array`), never as a JSON number
 * array — the latter inflates ~4x and would make a large recording pathological.
 * A failure mid-stream aborts the session, deleting the partial file.
 *
 * Browser / PWA: the historical blob download, byte-for-byte unchanged.
 *
 * Returns true if a file was written, false if the user cancelled Save As.
 * THROWS on a real write failure so callers can tell "cancelled" (nothing
 * written, by choice) apart from "failed" (something went wrong).
 */
export async function saveBinaryFile(
  data: Blob | ArrayBuffer | Uint8Array,
  filename: string,
  mime = 'application/octet-stream',
): Promise<boolean> {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type: mime });
  if (!inTauriShell()) return browserDownload(blob, filename);

  const path = await nativeSavePath(filename);
  if (!path) return false; // user cancelled the Save As dialog
  const { invoke } = await import('@tauri-apps/api/core');
  const token = await invoke<number>('save_binary_begin', { path });
  try {
    // Slice the Blob per chunk rather than materialising the whole thing with
    // one `arrayBuffer()` — a 1 GB recording must never need 1 GB of JS heap.
    for (let off = 0; off < blob.size; off += NATIVE_CHUNK_BYTES) {
      const end = Math.min(off + NATIVE_CHUNK_BYTES, blob.size);
      const chunk = new Uint8Array(await blob.slice(off, end).arrayBuffer());
      await invoke('save_binary_chunk', chunk, {
        headers: { [SAVE_TOKEN_HEADER]: String(token) },
      });
    }
    await invoke('save_binary_end', { token });
    return true;
  } catch (err) {
    // Never leave a truncated file behind pretending to be a recording.
    await invoke('save_binary_abort', { token }).catch(() => {});
    throw err;
  }
}

export function downloadJSON(content: string, filename: string): Promise<boolean> {
  return saveTextFile(content, filename, 'application/json');
}

/** Download a standalone presentation `.html` (Tauri Save As / browser blob). */
export function downloadHTML(content: string, filename: string): Promise<boolean> {
  return saveTextFile(content, filename, 'text/html');
}

/**
 * Extract the embedded model JSON from an exported presentation `.html`.
 * The template carries the model in `<script id="genesis-model"
 * type="application/json">…</script>` (see the Presentation Export feature).
 * Returns the raw JSON text, or null if the input isn't a GenesisCA
 * presentation file. Kept dependency-free (a regex, not a DOM parse) so it
 * works the same in the worker/build contexts.
 */
export function extractEmbeddedModel(html: string): string | null {
  const m = html.match(
    /<script[^>]*id=["']genesis-model["'][^>]*>([\s\S]*?)<\/script>/i,
  );
  if (!m || m[1] == null) return null;
  const inner = m[1].trim();
  if (!inner || inner === EMBEDDED_MODEL_PLACEHOLDER) return null;
  return inner;
}

/** The sentinel the viewer template ships with before a model is injected. */
export const EMBEDDED_MODEL_PLACEHOLDER = '__GENESIS_MODEL_JSON__';

/**
 * Parse + normalize a model from its raw JSON/`.gcaproj` text: BOM strip,
 * legacy `"key": undefined` recovery, required-field + schema-version
 * validation, and the v1→v2 NeighborIndex migration. Shared by
 * `readModelFile` (file loads) and the viewer entry (embedded model in an
 * exported `.html`). Throws on invalid input.
 */
export function parseModelJSON(raw: string): CAModel {
  // Strip a UTF-8 BOM if an editor added one. Leaving it in front of `{`
  // makes JSON.parse throw "Unexpected token" at position 0 on files that
  // look identical to the eye.
  let text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
  let model: CAModel;
  {
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
            throw new Error(`Failed to parse file: ${msg}${snippet}`);
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
          throw new Error(`Failed to parse file: ${msg}${snippet}`);
        }
      }
    }
    if (!model.properties || !model.attributes) {
      throw new Error('Invalid file: missing required model fields.');
    }
    if (
      model.schemaVersion != null &&
      model.schemaVersion > SCHEMA_VERSION
    ) {
      throw new Error(
        `File uses schema version ${model.schemaVersion}, but this app supports up to version ${SCHEMA_VERSION}. Please update GenesisCA.`,
      );
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
    return model;
}

/**
 * Read a model from a picked file. Accepts a `.gcaproj` (JSON) OR an exported
 * presentation `.html` (the embedded model is extracted first) — so dropping a
 * shared standalone `.html` back into GenesisCA recovers the editable model.
 */
export function readModelFile(file: File): Promise<CAModel> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const raw = reader.result as string;
        const looksHtml =
          /\.html?$/i.test(file.name) ||
          /^\s*<(?:!doctype|html)/i.test(raw) ||
          raw.includes('id="genesis-model"') ||
          raw.includes("id='genesis-model'");
        let text = raw;
        if (looksHtml) {
          const embedded = extractEmbeddedModel(raw);
          if (!embedded) {
            throw new Error(
              'This HTML file has no embedded GenesisCA model (not a Presentation Export?).',
            );
          }
          text = embedded;
        }
        resolve(parseModelJSON(text));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
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

// Maps each cell-attribute runtime type to the typed-array kind we store on
// disk. MUST cover every type that `createTypedArray` in sim.worker.ts knows
// about (bool/integer/float/tag/neighborIndex). A missing entry silently falls
// through to 'float64' inside serializeSimState/serializePreset, which mis-
// labels an int32 buffer as float64 — on reload deserializeTypedArray reads
// it back as Float64Array, slicing 4N bytes into N/2 elements of garbage, and
// the cell data round-trips into the worker as junk. NeighborIndex was the
// first such regression; if you add another cell-attr runtime type, register
// it here AT THE SAME TIME or saves will be silently broken.
const ATTR_TYPE_MAP: Record<string, 'uint8' | 'int32' | 'float64'> = {
  bool: 'uint8', integer: 'int32', float: 'float64', tag: 'int32',
  neighborIndex: 'int32',
};

/** Bond-Graph Agents — base64-encode the worker's AgentStatePayload (a numbers +
 *  ArrayBuffers bag) into the schema's SerializedAgentState. Field-name-generic:
 *  every ArrayBuffer property lands in `buffers` under its payload name, so new
 *  engine fields (velocity, sprites, z, …) round-trip without a schema change. */
export function serializeAgentState(payload: Record<string, unknown>): import('./types').SerializedAgentState {
  const buffers: Record<string, string> = {};
  const attrs: Record<string, { kind: string; data: string }> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (v instanceof ArrayBuffer) buffers[k] = arrayBufferToBase64(v);
  }
  const pAttrs = payload.attrs as Record<string, { kind: string; buffer: ArrayBuffer }> | undefined;
  if (pAttrs) {
    for (const [id, e] of Object.entries(pAttrs)) attrs[id] = { kind: e.kind, data: arrayBufferToBase64(e.buffer) };
  }
  return {
    highWater: Number(payload.highWater) || 0,
    liveCount: Number(payload.liveCount) || 0,
    freeTop: Number(payload.freeTop) || 0,
    maxBonds: Number(payload.maxBonds) || 0,
    buffers,
    attrs,
  };
}

/** Decode a SerializedAgentState back into the ArrayBuffer-bag shape the worker's
 *  `loadState` handler feeds to `deserializeAgentStore` (which validates the
 *  maxBonds stride + capacity LOUDLY). */
export function deserializeAgentState(s: import('./types').SerializedAgentState): Record<string, unknown> {
  const out: Record<string, unknown> = {
    highWater: s.highWater, liveCount: s.liveCount, freeTop: s.freeTop, maxBonds: s.maxBonds,
  };
  for (const [k, b64] of Object.entries(s.buffers ?? {})) out[k] = base64ToArrayBuffer(b64);
  const attrs: Record<string, { kind: string; buffer: ArrayBuffer }> = {};
  for (const [id, e] of Object.entries(s.attrs ?? {})) attrs[id] = { kind: e.kind, buffer: base64ToArrayBuffer(e.data) };
  out.attrs = attrs;
  return out;
}

export function serializeSimState(
  workerState: {
    generation: number;
    width: number;
    height: number;
    /** 3D Grid CA: layer count. Absent → 1. */
    depth?: number;
    attributes: Record<string, { type: string; buffer: ArrayBuffer }>;
    modelAttrs: Record<string, number>;
    indicators: Record<string, number>;
    linkedAccumulators: Record<string, number | Record<string, number>>;
    colors: ArrayBuffer;
    orderArray?: ArrayBuffer;
    /** Bond-Graph Agents: the worker's AgentStatePayload (present for agent models). */
    agents?: Record<string, unknown>;
  },
  uiSettings: {
    activeViewer: string;
    /** The active AGENT viewer (two-layer viewer bar). */
    activeAgentViewer?: string;
    brushColor: string;
    brushW: number;
    brushH: number;
    brushShape?: string;
    brushRadius?: number;
    brushRingWidth?: number;
    brushLineWidth?: number;
    brushMapping: string;
    targetFps: number;
    unlimitedFps: boolean;
    gensPerFrame: number;
    unlimitedGens: boolean;
    indicatorChartOverrides?: Record<string, import('./types').IndicatorChartSettings>;
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
  serialized.gridDepth = workerState.depth ?? 1;   // 3D Grid CA
  if (wantGrid) {
    // Saved grid state is a starting configuration — NOT a run snapshot.
    // We deliberately skip `generation`, `indicators`, and `linkedAccumulators`
    // so a loaded state always begins from generation 0 with fresh indicator
    // values. The fields remain optional in the type for back-compat with
    // older files (loader ignores them).
    serialized.width = workerState.width;
    serialized.height = workerState.height;
    serialized.depth = workerState.depth ?? 1;   // 3D Grid CA
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
    // Bond-Graph Agents: the agent population rides the grid block (it IS grid
    // state — "the board" of an agent model). Previously silently dropped: a
    // hand-seeded agent configuration vanished on save/load.
    if (workerState.agents) {
      serialized.agents = serializeAgentState(workerState.agents);
    }
  }
  if (wantControls) {
    serialized.modelAttrs = workerState.modelAttrs;
    serialized.activeViewer = uiSettings.activeViewer;
    if (uiSettings.activeAgentViewer !== undefined) serialized.activeAgentViewer = uiSettings.activeAgentViewer;
    serialized.brushColor = uiSettings.brushColor;
    serialized.brushW = uiSettings.brushW;
    serialized.brushH = uiSettings.brushH;
    if (uiSettings.brushShape !== undefined) serialized.brushShape = uiSettings.brushShape as SimulationState['brushShape'];
    if (uiSettings.brushRadius !== undefined) serialized.brushRadius = uiSettings.brushRadius;
    if (uiSettings.brushRingWidth !== undefined) serialized.brushRingWidth = uiSettings.brushRingWidth;
    if (uiSettings.brushLineWidth !== undefined) serialized.brushLineWidth = uiSettings.brushLineWidth;
    serialized.brushMapping = uiSettings.brushMapping;
    serialized.targetFps = uiSettings.targetFps;
    serialized.unlimitedFps = uiSettings.unlimitedFps;
    serialized.gensPerFrame = uiSettings.gensPerFrame;
    serialized.unlimitedGens = uiSettings.unlimitedGens;
    if (uiSettings.indicatorChartOverrides && Object.keys(uiSettings.indicatorChartOverrides).length > 0) {
      serialized.indicatorChartOverrides = uiSettings.indicatorChartOverrides;
    }
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
    depth?: number;   // 3D Grid CA
    attributes: Record<string, { type: string; buffer: ArrayBuffer }>;
    modelAttrs: Record<string, number>;
    indicators: Record<string, number>;
    linkedAccumulators: Record<string, number | Record<string, number>>;
    colors: ArrayBuffer;
    orderArray?: ArrayBuffer;
  },
  opts: { includeGrid: boolean },
  modelStructure?: {
    boundaryTreatment?: import('./types').BoundaryTreatment;
    /** Current interaction-table values keyed by attribute id. Snapshotted at
     *  save time so the preset captures whatever the user had tweaked in the
     *  simulator, not just the model's defaults. Caller is responsible for the
     *  deep clone — we just store the reference into the SimulationState. */
    interactionTables?: Record<string, Record<string, Record<string, number>>>;
    /** MULTI-AXIS lookup tables: attribute id → the dense row-major tableData
     *  flat array (the axes-mode sibling of `interactionTables`). */
    lookupTableData?: Record<string, number[]>;
  },
): SimulationState {
  const out: SimulationState = { schemaVersion: SCHEMA_VERSION, modelAttrs: { ...workerState.modelAttrs } };
  // Grid dimensions and boundary treatment are saved even for parameter-only presets so loading
  // one can restore the model structure, not just the scalar parameters.
  if (modelStructure?.boundaryTreatment) out.boundaryTreatment = modelStructure.boundaryTreatment;
  out.gridWidth = workerState.width;
  out.gridHeight = workerState.height;
  out.gridDepth = workerState.depth ?? 1;   // 3D Grid CA
  if (modelStructure?.interactionTables && Object.keys(modelStructure.interactionTables).length > 0) {
    out.interactionTables = modelStructure.interactionTables;
  }
  if (modelStructure?.lookupTableData && Object.keys(modelStructure.lookupTableData).length > 0) {
    out.lookupTableData = modelStructure.lookupTableData;
  }
  if (opts.includeGrid) {
    // Presets also store starting configurations — skip generation + indicators
    // for the same reason as serializeSimState above.
    out.width = workerState.width;
    out.height = workerState.height;
    out.depth = workerState.depth ?? 1;   // 3D Grid CA
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

export function downloadStateFile(state: SimulationState, filename: string): Promise<boolean> {
  return saveTextFile(JSON.stringify(state), filename, 'application/json');
}

/** Standalone preset file (`.gcapreset`): ONE named Preset — an embedded
 *  `SimulationState` + metadata — transportable between projects. The preset
 *  object travels VERBATIM (the embedded state keeps its exact composition: a
 *  grid-carrying preset stays dims-authoritative on load, a parameter-only one
 *  stays grid-less — the documented preset semantics are untouched); only the
 *  id is regenerated on import so it can never collide with an existing one. */
export interface PresetFile {
  schemaVersion: 1;
  name: string;
  description?: string;
  preset: Preset;
}

export function downloadPresetFile(preset: Preset, filename: string): Promise<boolean> {
  const file: PresetFile = {
    schemaVersion: 1,
    name: preset.name,
    ...(preset.description ? { description: preset.description } : {}),
    preset,
  };
  return saveTextFile(JSON.stringify(file), filename, 'application/json');
}

/** Read a `.gcapreset` (also accepts a bare Preset object for hand-made files).
 *  Returns a preset with a FRESH id (never reuse the file's — imports must not
 *  collide with existing presets) and the same depth normalization
 *  `readStateFile` applies to its embedded state. */
export function readPresetFile(file: File): Promise<Preset> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const raw = JSON.parse(reader.result as string) as Partial<PresetFile> & Partial<Preset>;
        const p = (raw.preset ?? raw) as Partial<Preset>;
        if (!p || typeof p !== 'object' || !p.state || typeof p.state !== 'object') {
          reject(new Error('Invalid preset file: missing the embedded state.'));
          return;
        }
        const state = p.state as SimulationState;
        if (state.depth === undefined) state.depth = 1;
        if (state.gridDepth === undefined) state.gridDepth = state.depth;
        const name = (typeof p.name === 'string' && p.name.trim())
          || (typeof raw.name === 'string' && raw.name.trim())
          || 'Imported preset';
        const description = typeof p.description === 'string' && p.description.trim()
          ? p.description.trim()
          : typeof raw.description === 'string' && raw.description.trim() ? raw.description.trim() : undefined;
        resolve({
          id: 'preset_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
          name,
          ...(description ? { description } : {}),
          state,
          createdAt: typeof p.createdAt === 'number' ? p.createdAt : Date.now(),
        });
      } catch {
        reject(new Error('Failed to parse preset file. Is it valid JSON?'));
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file.'));
    reader.readAsText(file);
  });
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
        // 3D Grid CA: older files have no depth → a 2D (depth-1) snapshot.
        if (state.depth === undefined) state.depth = 1;
        if (state.gridDepth === undefined) state.gridDepth = state.depth;
        resolve(state);
      } catch {
        reject(new Error('Failed to parse state file. Is it valid JSON?'));
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file.'));
    reader.readAsText(file);
  });
}
