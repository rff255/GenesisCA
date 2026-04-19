import { SCHEMA_VERSION } from './schema';
import type { CAModel, SimulationState, SerializedTypedArray } from './types';

export function serializeModel(model: CAModel): string {
  return JSON.stringify(model, null, 2);
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
      try {
        const model = JSON.parse(reader.result as string) as CAModel;
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
        model.schemaVersion = SCHEMA_VERSION;
        resolve(model);
      } catch {
        reject(new Error('Failed to parse file. Is it valid JSON?'));
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
): SimulationState {
  const wantGrid = include.grid !== false;
  const wantControls = include.controls !== false;
  const serialized: SimulationState = {};
  if (wantGrid) {
    serialized.generation = workerState.generation;
    serialized.width = workerState.width;
    serialized.height = workerState.height;
    serialized.attributes = {};
    serialized.indicators = workerState.indicators;
    serialized.linkedAccumulators = workerState.linkedAccumulators;
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
): SimulationState {
  const out: SimulationState = { modelAttrs: { ...workerState.modelAttrs } };
  if (opts.includeGrid) {
    out.generation = workerState.generation;
    out.width = workerState.width;
    out.height = workerState.height;
    out.attributes = {};
    out.indicators = { ...workerState.indicators };
    out.linkedAccumulators = JSON.parse(JSON.stringify(workerState.linkedAccumulators));
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
