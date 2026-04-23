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
    maxIterations: 1000,
    tags: [],
  },
  attributes: [],
  neighborhoods: [],
  mappings: [],
  indicators: [],
  graphNodes: [],
  graphEdges: [],
  macroDefs: [],
};

/** Legacy alias of EMPTY_MODEL, kept for backwards compatibility. */
export const DEFAULT_MODEL: CAModel = EMPTY_MODEL;
