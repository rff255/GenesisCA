import { SCHEMA_VERSION } from './schema';
import type { CAModel } from './types';

/** Fully empty model — used when user clicks "New" */
export const EMPTY_MODEL: CAModel = {
  schemaVersion: SCHEMA_VERSION,
  properties: {
    name: 'Untitled Model',
    author: '',
    modelAuthor: '',
    description: '',
    topology: '2d-grid',
    boundaryTreatment: 'torus',
    updateMode: 'synchronous',
    asyncScheme: 'random-order',
    gridWidth: 100,
    gridHeight: 100,
    gridDepth: 1,
    maxIterations: 1000,
    tags: [],
    // C4 (P1): new models declare an INTENT, not an engine — Auto picks the
    // fastest engine the model can use and re-picks as the model is edited.
    engine: 'auto',
    // The legacy MIRROR of `engine` (see ModelProperties). A static default has
    // to pick something; WASM is the always-runnable one, and the real value is
    // baked by `withResolvedEngine` at every consumption point + at save time.
    useWasm: true,
    dimension: '2d',
  },
  attributes: [],
  neighborhoods: [],
  mappings: [],
  indicators: [],
  graphNodes: [],
  graphEdges: [],
  agentGraphNodes: [],
  agentGraphEdges: [],
  macroDefs: [],
  topologyMode: { gridCells: true, agents: false },
};

/** Legacy alias of EMPTY_MODEL, kept for backwards compatibility. */
export const DEFAULT_MODEL: CAModel = EMPTY_MODEL;
