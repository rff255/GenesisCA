import type { CAModel } from '../../model/types';
import { compileAndBuild } from '../../modeler/vpl/compiler/compile';

type CellState = Record<string, unknown>;
type ViewerColors = Record<string, { r: number; g: number; b: number }>;
type StepFn = (
  cell: CellState,
  neighbors: Record<string, CellState[]>,
  modelAttrs: CellState,
  out: { state: CellState; viewers: ViewerColors },
) => { state: CellState; viewers: ViewerColors };

export interface SimState {
  generation: number;
  width: number;
  height: number;
  grid: CellState[];
  colors: Uint8ClampedArray; // RGBA flat buffer: 4 bytes per cell
  activeViewer: string;
}

export class SimEngine {
  private model: CAModel;
  private stepFn: StepFn | null = null;
  private cachedModelAttrs: CellState = {};
  private defaultCell: CellState = {};
  private gridA: CellState[] = [];
  private gridB: CellState[] = [];
  private useA = true;
  /** Reusable neighbor arrays per neighborhood */
  private neighborBuffers: Record<string, CellState[]> = {};
  /** Reusable output object per cell */
  private cellOut: { state: CellState; viewers: ViewerColors } = { state: {}, viewers: {} };

  compiledCode = '';
  compileError = '';
  state: SimState;

  constructor(model: CAModel) {
    this.model = model;
    this.buildCaches();
    this.state = this.createInitialState();
    this.compile();
  }

  private buildCaches(): void {
    // Default cell for boundary
    this.defaultCell = {};
    for (const attr of this.model.attributes) {
      if (attr.isModelAttribute) continue;
      this.defaultCell[attr.id] = attr.type === 'bool' ? false : 0;
    }

    // Model attributes (global, read-only during sim)
    this.cachedModelAttrs = {};
    for (const attr of this.model.attributes) {
      if (!attr.isModelAttribute) continue;
      switch (attr.type) {
        case 'bool':
          this.cachedModelAttrs[attr.id] = attr.defaultValue === 'true';
          break;
        case 'integer':
          this.cachedModelAttrs[attr.id] = parseInt(attr.defaultValue, 10) || 0;
          break;
        case 'float':
          this.cachedModelAttrs[attr.id] = parseFloat(attr.defaultValue) || 0;
          break;
        default:
          this.cachedModelAttrs[attr.id] = attr.defaultValue;
      }
    }

    // Pre-allocate neighbor buffers
    this.neighborBuffers = {};
    for (const nbr of this.model.neighborhoods) {
      this.neighborBuffers[nbr.id] = new Array<CellState>(nbr.coords.length);
    }
  }

  private createCell(): CellState {
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
    return cell;
  }

  private createInitialState(): SimState {
    const { gridWidth: width, gridHeight: height } = this.model.properties;
    const total = width * height;

    this.gridA = new Array<CellState>(total);
    this.gridB = new Array<CellState>(total);
    for (let i = 0; i < total; i++) {
      this.gridA[i] = this.createCell();
      this.gridB[i] = this.createCell();
    }
    this.useA = true;

    const firstViewer = this.model.mappings.find(m => m.isAttributeToColor);

    return {
      generation: 0,
      width,
      height,
      grid: this.gridA,
      colors: new Uint8ClampedArray(total * 4), // RGBA
      activeViewer: firstViewer?.id ?? '',
    };
  }

  compile(): void {
    const result = compileAndBuild(this.model.graphNodes, this.model.graphEdges);
    this.stepFn = result.fn as StepFn | null;
    this.compiledCode = result.code;
    this.compileError = result.error ?? '';
  }

  /** Fill neighbor buffers for a given cell position (mutates pre-allocated arrays) */
  private fillNeighbors(row: number, col: number): Record<string, CellState[]> {
    const { width, height, grid } = this.state;
    const boundary = this.model.properties.boundaryTreatment;

    for (const nbr of this.model.neighborhoods) {
      const buf = this.neighborBuffers[nbr.id]!;
      for (let i = 0; i < nbr.coords.length; i++) {
        const [dr, dc] = nbr.coords[i]!;
        let r = row + dr;
        let c = col + dc;

        if (r < 0 || r >= height || c < 0 || c >= width) {
          if (boundary === 'torus') {
            r = ((r % height) + height) % height;
            c = ((c % width) + width) % width;
          } else {
            buf[i] = this.defaultCell;
            continue;
          }
        }
        buf[i] = grid[r * width + c]!;
      }
    }
    return this.neighborBuffers;
  }

  /** Advance one generation */
  step(): boolean {
    if (!this.stepFn) return false;

    const { width, height, grid } = this.state;
    const nextGrid = this.useA ? this.gridB : this.gridA;
    const colors = this.state.colors;
    const activeViewer = this.state.activeViewer;
    const modelAttrs = this.cachedModelAttrs;
    const fn = this.stepFn;
    const out = this.cellOut;

    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const idx = row * width + col;
        const cell = grid[idx]!;
        const neighbors = this.fillNeighbors(row, col);

        out.state = nextGrid[idx]!;
        out.viewers = {};
        fn(cell, neighbors, modelAttrs, out);

        // Only update colors if SetColorViewer was called for the active viewer.
        // Otherwise preserve previous frame's colors (buffer persists across steps).
        const viewer = out.viewers[activeViewer];
        if (viewer) {
          const pxIdx = idx * 4;
          colors[pxIdx] = viewer.r;
          colors[pxIdx + 1] = viewer.g;
          colors[pxIdx + 2] = viewer.b;
          colors[pxIdx + 3] = 255;
        }
      }
    }

    this.useA = !this.useA;
    this.state = {
      ...this.state,
      generation: this.state.generation + 1,
      grid: nextGrid,
    };
    return true;
  }

  /** Randomize grid */
  randomize(): void {
    const { width, height } = this.state;
    const grid = this.state.grid;
    const colors = this.state.colors;

    for (let i = 0; i < width * height; i++) {
      const cell = grid[i]!;
      for (const attr of this.model.attributes) {
        if (attr.isModelAttribute) continue;
        if (attr.type === 'bool') {
          cell[attr.id] = Math.random() > 0.7;
        } else if (attr.type === 'integer') {
          cell[attr.id] = Math.floor(Math.random() * 10);
        } else if (attr.type === 'float') {
          cell[attr.id] = Math.random();
        }
      }
      // Set fallback colors
      const alive = Object.values(cell).some(v => v === true);
      const pxIdx = i * 4;
      colors[pxIdx] = alive ? 76 : 13;
      colors[pxIdx + 1] = alive ? 201 : 27;
      colors[pxIdx + 2] = alive ? 240 : 43;
      colors[pxIdx + 3] = 255;
    }

    this.state = { ...this.state, generation: 0 };
  }

  /** Reset to default initial state */
  reset(): void {
    const { width, height } = this.state;
    const grid = this.state.grid;
    for (let i = 0; i < width * height; i++) {
      const cell = grid[i]!;
      for (const attr of this.model.attributes) {
        if (attr.isModelAttribute) continue;
        switch (attr.type) {
          case 'bool': cell[attr.id] = attr.defaultValue === 'true'; break;
          case 'integer': cell[attr.id] = parseInt(attr.defaultValue, 10) || 0; break;
          case 'float': cell[attr.id] = parseFloat(attr.defaultValue) || 0; break;
          default: cell[attr.id] = attr.defaultValue;
        }
      }
    }
    this.state.colors.fill(0);
    this.state = { ...this.state, generation: 0 };
  }

  /** Update the model and recompile */
  updateModel(model: CAModel): void {
    this.model = model;
    this.buildCaches();
    this.compile();
  }
}
