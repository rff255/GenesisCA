import type { CAModel } from '../../model/types';
import { compileAndBuild } from '../../modeler/vpl/compiler/compile';

type CellState = Record<string, unknown>;
type ViewerColors = Record<string, { r: number; g: number; b: number }>;
type StepFn = (
  cell: CellState,
  neighbors: Record<string, CellState[]>,
  modelAttrs: CellState,
) => { state: CellState; viewers: ViewerColors };

export interface SimState {
  generation: number;
  width: number;
  height: number;
  /** Flat array of cell states: grid[row * width + col] */
  grid: CellState[];
  /** Flat array of per-cell viewer colors: colors[row * width + col] */
  colors: Array<ViewerColors>;
  /** Currently selected viewer for display */
  activeViewer: string;
}

export class SimEngine {
  private model: CAModel;
  private stepFn: StepFn | null = null;
  compiledCode = '';
  compileError = '';
  state: SimState;

  constructor(model: CAModel) {
    this.model = model;
    this.state = this.createInitialState();
    this.compile();
  }

  private createInitialState(): SimState {
    const { gridWidth: width, gridHeight: height } = this.model.properties;
    const grid: CellState[] = [];
    const colors: ViewerColors[] = [];

    for (let i = 0; i < width * height; i++) {
      const cell: CellState = {};
      for (const attr of this.model.attributes) {
        if (attr.isModelAttribute) continue;
        switch (attr.type) {
          case 'bool':
            cell[attr.id] = attr.defaultValue === 'true';
            break;
          case 'integer':
            cell[attr.id] = parseInt(attr.defaultValue, 10) || 0;
            break;
          case 'float':
            cell[attr.id] = parseFloat(attr.defaultValue) || 0;
            break;
          default:
            cell[attr.id] = attr.defaultValue;
        }
      }
      grid.push(cell);
      colors.push({});
    }

    // Default viewer is the first attribute-to-color mapping
    const firstViewer = this.model.mappings.find(m => m.isAttributeToColor);

    return {
      generation: 0,
      width,
      height,
      grid,
      colors,
      activeViewer: firstViewer?.id ?? '',
    };
  }

  compile(): void {
    const result = compileAndBuild(this.model.graphNodes, this.model.graphEdges);
    this.stepFn = result.fn;
    this.compiledCode = result.code;
    this.compileError = result.error ?? '';
  }

  /** Get neighbor cells for a given cell position */
  private getNeighbors(row: number, col: number): Record<string, CellState[]> {
    const { width, height, grid } = this.state;
    const boundary = this.model.properties.boundaryTreatment;
    const result: Record<string, CellState[]> = {};

    for (const nbr of this.model.neighborhoods) {
      const neighbors: CellState[] = [];
      for (const [dr, dc] of nbr.coords) {
        let r = row + dr;
        let c = col + dc;

        if (boundary === 'torus') {
          r = ((r % height) + height) % height;
          c = ((c % width) + width) % width;
        } else {
          // Constant boundary — out of bounds gets default values
          if (r < 0 || r >= height || c < 0 || c >= width) {
            const defaultCell: CellState = {};
            for (const attr of this.model.attributes) {
              if (!attr.isModelAttribute) {
                defaultCell[attr.id] = attr.type === 'bool' ? false : 0;
              }
            }
            neighbors.push(defaultCell);
            continue;
          }
        }

        neighbors.push(grid[r * width + c]!);
      }
      result[nbr.id] = neighbors;
    }
    return result;
  }

  /** Build model attributes object */
  private getModelAttrs(): CellState {
    const attrs: CellState = {};
    for (const attr of this.model.attributes) {
      if (!attr.isModelAttribute) continue;
      switch (attr.type) {
        case 'bool':
          attrs[attr.id] = attr.defaultValue === 'true';
          break;
        case 'integer':
          attrs[attr.id] = parseInt(attr.defaultValue, 10) || 0;
          break;
        case 'float':
          attrs[attr.id] = parseFloat(attr.defaultValue) || 0;
          break;
        default:
          attrs[attr.id] = attr.defaultValue;
      }
    }
    return attrs;
  }

  /** Advance one generation */
  step(): boolean {
    if (!this.stepFn) return false;

    const { width, height, grid } = this.state;
    const modelAttrs = this.getModelAttrs();
    const newGrid: CellState[] = new Array(width * height);
    const newColors: ViewerColors[] = new Array(width * height);

    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const idx = row * width + col;
        const cell = grid[idx]!;
        const neighbors = this.getNeighbors(row, col);
        const result = this.stepFn(cell, neighbors, modelAttrs);
        newGrid[idx] = result.state;
        newColors[idx] = result.viewers;
      }
    }

    this.state = {
      ...this.state,
      generation: this.state.generation + 1,
      grid: newGrid,
      colors: newColors,
    };
    return true;
  }

  /** Randomize grid (for testing — sets bool attributes randomly) */
  randomize(): void {
    const { width, height } = this.state;
    const grid: CellState[] = [];
    for (let i = 0; i < width * height; i++) {
      const cell: CellState = {};
      for (const attr of this.model.attributes) {
        if (attr.isModelAttribute) continue;
        if (attr.type === 'bool') {
          cell[attr.id] = Math.random() > 0.7;
        } else if (attr.type === 'integer') {
          cell[attr.id] = Math.floor(Math.random() * 10);
        } else if (attr.type === 'float') {
          cell[attr.id] = Math.random();
        } else {
          cell[attr.id] = attr.defaultValue;
        }
      }
      grid.push(cell);
    }
    this.state = { ...this.state, generation: 0, grid, colors: new Array(width * height).fill({}) };
  }

  /** Reset to default initial state */
  reset(): void {
    this.state = this.createInitialState();
  }

  /** Update the model and recompile */
  updateModel(model: CAModel): void {
    this.model = model;
    this.compile();
  }
}
