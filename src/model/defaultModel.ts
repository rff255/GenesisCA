import { SCHEMA_VERSION } from './schema';
import type { CAModel } from './types';

export const DEFAULT_MODEL: CAModel = {
  schemaVersion: SCHEMA_VERSION,
  properties: {
    name: 'Game of Life',
    author: 'John Conway',
    goal: 'Classic cellular automaton demonstrating emergent behavior',
    description:
      'A zero-player game where evolution is determined by the initial state. Each cell is either alive or dead, and its next state depends on the number of alive neighbors.',
    topology: '2d-grid',
    boundaryTreatment: 'torus',
    gridWidth: 100,
    gridHeight: 100,
    maxIterations: 1000,
  },
  attributes: [
    {
      id: 'alive',
      name: 'alive',
      type: 'bool',
      description: 'Whether the cell is alive or dead',
      isModelAttribute: false,
      defaultValue: 'false',
    },
    {
      id: 'age',
      name: 'age',
      type: 'integer',
      description: 'How many generations the cell has been alive',
      isModelAttribute: false,
      defaultValue: '0',
    },
  ],
  neighborhoods: [
    {
      id: 'moore',
      name: 'Moore',
      description: 'All 8 surrounding cells',
      coords: [
        [-1, -1], [-1, 0], [-1, 1],
        [0, -1],           [0, 1],
        [1, -1],  [1, 0],  [1, 1],
      ],
    },
  ],
  mappings: [
    {
      id: 'default-viz',
      name: 'Default Visualization',
      description: 'Maps alive state to cell color',
      isAttributeToColor: true,
      redDescription: 'alive ? 76 : 13',
      greenDescription: 'alive ? 201 : 27',
      blueDescription: 'alive ? 240 : 43',
    },
    {
      id: 'paint',
      name: 'Paint Interaction',
      description: 'Allows painting alive cells on the grid',
      isAttributeToColor: false,
      redDescription: 'ignored',
      greenDescription: 'ignored',
      blueDescription: 'brightness > 128 → alive = true',
    },
  ],
  graphNodes: [],
  graphEdges: [],
};
