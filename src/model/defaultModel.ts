import { SCHEMA_VERSION } from './schema';
import type { CAModel } from './types';

/** Fully empty model — used when user clicks "New" */
export const EMPTY_MODEL: CAModel = {
  schemaVersion: SCHEMA_VERSION,
  properties: {
    name: 'Untitled Model',
    author: '',
    goal: '',
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

/**
 * Legacy DEFAULT_MODEL kept for backwards compatibility.
 * On first launch the app now loads Game of Life from public/models/ instead.
 */
export const DEFAULT_MODEL: CAModel = EMPTY_MODEL;
