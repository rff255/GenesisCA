/**
 * Web Worker for GenesisCA simulation.
 * Owns the grid state — main thread only receives RGBA color buffers.
 */

type CellState = Record<string, unknown>;
type ViewerColors = Record<string, { r: number; g: number; b: number }>;
type StepFn = (
  cell: CellState,
  neighbors: Record<string, CellState[]>,
  modelAttrs: CellState,
  out: { state: CellState; viewers: ViewerColors },
) => { state: CellState; viewers: ViewerColors };

interface AttrDef {
  id: string;
  type: string;
  isModelAttribute: boolean;
  defaultValue: string;
}

interface NeighborhoodDef {
  id: string;
  coords: Array<[number, number]>;
}

type InputColorFn = (
  r: number, g: number, b: number,
  cell: CellState, modelAttrs: CellState,
  out: { state: CellState; viewers: ViewerColors },
) => { state: CellState; viewers: ViewerColors };

interface InitMsg {
  type: 'init';
  width: number;
  height: number;
  attributes: AttrDef[];
  neighborhoods: NeighborhoodDef[];
  boundaryTreatment: string;
  stepCode: string;
  inputColorCodes: Array<{ mappingId: string; code: string }>;
  activeViewer: string;
}

interface StepMsg {
  type: 'step';
  count: number;
  activeViewer: string;
}

interface PaintMsg {
  type: 'paint';
  cells: Array<{ row: number; col: number; r: number; g: number; b: number }>;
  mappingId: string;
  activeViewer: string;
}

interface RandomizeMsg { type: 'randomize'; activeViewer: string }
interface ResetMsg { type: 'reset'; activeViewer: string }
interface RecompileMsg { type: 'recompile'; stepCode: string; inputColorCodes: Array<{ mappingId: string; code: string }> }

type WorkerMsg = InitMsg | StepMsg | PaintMsg | RandomizeMsg | ResetMsg | RecompileMsg;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let width = 0;
let height = 0;
let attributes: AttrDef[] = [];
let neighborhoods: NeighborhoodDef[] = [];
let boundaryTreatment = 'torus';
let generation = 0;

let gridA: CellState[] = [];
let gridB: CellState[] = [];
let currentGrid: CellState[] = [];
let useA = true;

let colors: Uint8ClampedArray = new Uint8ClampedArray(0);
let stepFn: StepFn | null = null;
let inputColorFns: Array<{ mappingId: string; fn: InputColorFn }> = [];

let defaultCell: CellState = {};
let cachedModelAttrs: CellState = {};
let neighborBuffers: Record<string, CellState[]> = {};
const cellOut: { state: CellState; viewers: ViewerColors } = { state: {}, viewers: {} };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildCaches(): void {
  defaultCell = {};
  cachedModelAttrs = {};
  for (const attr of attributes) {
    if (attr.isModelAttribute) {
      switch (attr.type) {
        case 'bool': cachedModelAttrs[attr.id] = attr.defaultValue === 'true'; break;
        case 'integer': cachedModelAttrs[attr.id] = parseInt(attr.defaultValue, 10) || 0; break;
        case 'float': cachedModelAttrs[attr.id] = parseFloat(attr.defaultValue) || 0; break;
        default: cachedModelAttrs[attr.id] = attr.defaultValue;
      }
    } else {
      defaultCell[attr.id] = attr.type === 'bool' ? false : 0;
    }
  }
  neighborBuffers = {};
  for (const nbr of neighborhoods) {
    neighborBuffers[nbr.id] = new Array<CellState>(nbr.coords.length);
  }
}

function createCell(): CellState {
  const cell: CellState = {};
  for (const attr of attributes) {
    if (attr.isModelAttribute) continue;
    switch (attr.type) {
      case 'bool': cell[attr.id] = attr.defaultValue === 'true'; break;
      case 'integer': cell[attr.id] = parseInt(attr.defaultValue, 10) || 0; break;
      case 'float': cell[attr.id] = parseFloat(attr.defaultValue) || 0; break;
      default: cell[attr.id] = attr.defaultValue;
    }
  }
  return cell;
}

function initGrid(): void {
  const total = width * height;
  gridA = new Array<CellState>(total);
  gridB = new Array<CellState>(total);
  for (let i = 0; i < total; i++) {
    gridA[i] = createCell();
    gridB[i] = createCell();
  }
  useA = true;
  currentGrid = gridA;
  colors = new Uint8ClampedArray(total * 4);
  generation = 0;
}

function fillNeighbors(row: number, col: number): Record<string, CellState[]> {
  for (const nbr of neighborhoods) {
    const buf = neighborBuffers[nbr.id]!;
    for (let i = 0; i < nbr.coords.length; i++) {
      const [dr, dc] = nbr.coords[i]!;
      let r = row + dr;
      let c = col + dc;
      if (r < 0 || r >= height || c < 0 || c >= width) {
        if (boundaryTreatment === 'torus') {
          r = ((r % height) + height) % height;
          c = ((c % width) + width) % width;
        } else {
          buf[i] = defaultCell;
          continue;
        }
      }
      buf[i] = currentGrid[r * width + c]!;
    }
  }
  return neighborBuffers;
}

function runStep(activeViewer: string): void {
  const nextGrid = useA ? gridB : gridA;
  const fn = stepFn!;
  const ma = cachedModelAttrs;
  const out = cellOut;

  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const idx = row * width + col;
      const cell = currentGrid[idx]!;
      const neighbors = fillNeighbors(row, col);

      out.state = nextGrid[idx]!;
      out.viewers = {};
      fn(cell, neighbors, ma, out);

      // Only update colors for the active viewer if SetColorViewer was called.
      // Otherwise preserve the previous frame's colors (colors buffer persists).
      const viewer = out.viewers[activeViewer];
      if (viewer) {
        const px = idx * 4;
        colors[px] = viewer.r;
        colors[px + 1] = viewer.g;
        colors[px + 2] = viewer.b;
        colors[px + 3] = 255;
      }
    }
  }

  useA = !useA;
  currentGrid = nextGrid;
  generation++;
}

function writeColors(activeViewer: string): void {
  // Write RGBA from current grid state (without stepping)
  for (let i = 0; i < width * height; i++) {
    const cell = currentGrid[i]!;
    let alive = false;
    for (const k in cell) { if (cell[k] === true) { alive = true; break; } }
    const px = i * 4;
    colors[px] = alive ? 76 : 13;
    colors[px + 1] = alive ? 201 : 27;
    colors[px + 2] = alive ? 240 : 43;
    colors[px + 3] = 255;
  }
  void activeViewer;
}

function randomizeGrid(activeViewer: string): void {
  for (let i = 0; i < width * height; i++) {
    const cell = currentGrid[i]!;
    for (const attr of attributes) {
      if (attr.isModelAttribute) continue;
      if (attr.type === 'bool') cell[attr.id] = Math.random() > 0.7;
      else if (attr.type === 'integer') cell[attr.id] = Math.floor(Math.random() * 10);
      else if (attr.type === 'float') cell[attr.id] = Math.random();
    }
  }
  generation = 0;
  writeColors(activeViewer);
}

function resetGrid(activeViewer: string): void {
  for (let i = 0; i < width * height; i++) {
    const cell = currentGrid[i]!;
    for (const attr of attributes) {
      if (attr.isModelAttribute) continue;
      switch (attr.type) {
        case 'bool': cell[attr.id] = attr.defaultValue === 'true'; break;
        case 'integer': cell[attr.id] = parseInt(attr.defaultValue, 10) || 0; break;
        case 'float': cell[attr.id] = parseFloat(attr.defaultValue) || 0; break;
        default: cell[attr.id] = attr.defaultValue;
      }
    }
  }
  generation = 0;
  writeColors(activeViewer);
}

function compileFns(stepCode: string, icCodes: Array<{ mappingId: string; code: string }>): void {
  try {
    // eslint-disable-next-line no-eval
    stepFn = stepCode ? (eval(stepCode) as StepFn) : null;
  } catch {
    stepFn = null;
  }
  inputColorFns = [];
  for (const ic of icCodes) {
    try {
      // eslint-disable-next-line no-eval
      const fn = eval(ic.code) as InputColorFn;
      inputColorFns.push({ mappingId: ic.mappingId, fn });
    } catch { /* skip invalid */ }
  }
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

self.onmessage = (e: MessageEvent<WorkerMsg>) => {
  const msg = e.data;

  switch (msg.type) {
    case 'init': {
      width = msg.width;
      height = msg.height;
      attributes = msg.attributes;
      neighborhoods = msg.neighborhoods;
      boundaryTreatment = msg.boundaryTreatment;
      buildCaches();
      initGrid();
      compileFns(msg.stepCode, msg.inputColorCodes);
      writeColors(msg.activeViewer);
      const copy = new Uint8ClampedArray(colors);
      self.postMessage(
        { type: 'stepped', generation, colors: copy },
        { transfer: [copy.buffer] },
      );
      break;
    }

    case 'step': {
      if (!stepFn) {
        self.postMessage({ type: 'error', message: 'No compiled step function.' });
        return;
      }
      for (let i = 0; i < msg.count; i++) {
        runStep(msg.activeViewer);
      }
      const copy = new Uint8ClampedArray(colors);
      self.postMessage(
        { type: 'stepped', generation, colors: copy },
        { transfer: [copy.buffer] },
      );
      break;
    }

    case 'randomize': {
      randomizeGrid(msg.activeViewer);
      const copy = new Uint8ClampedArray(colors);
      self.postMessage(
        { type: 'stepped', generation, colors: copy },
        { transfer: [copy.buffer] },
      );
      break;
    }

    case 'reset': {
      resetGrid(msg.activeViewer);
      const copy = new Uint8ClampedArray(colors);
      self.postMessage(
        { type: 'stepped', generation, colors: copy },
        { transfer: [copy.buffer] },
      );
      break;
    }

    case 'paint': {
      // Find InputColor function matching the requested mapping
      const icEntry = msg.mappingId
        ? inputColorFns.find(f => f.mappingId === msg.mappingId)
        : inputColorFns[0];
      const icFn = icEntry?.fn;

      const ma = cachedModelAttrs;
      const out = cellOut;

      for (const c of msg.cells) {
        if (c.row < 0 || c.row >= height || c.col < 0 || c.col >= width) continue;
        const idx = c.row * width + c.col;

        if (icFn) {
          // Use InputColor graph function to set cell attributes from color
          out.state = currentGrid[idx]!;
          out.viewers = {};
          icFn(c.r, c.g, c.b, currentGrid[idx]!, ma, out);
        } else {
          // Fallback: set first bool attribute to true
          const cell = currentGrid[idx]!;
          for (const attr of attributes) {
            if (!attr.isModelAttribute && attr.type === 'bool') {
              cell[attr.id] = true;
              break;
            }
          }
        }
      }

      // Run one Step so SetColorViewer in the main graph updates the display
      if (stepFn) {
        runStep(msg.activeViewer);
      } else {
        // No step function — just paint the brush color directly
        for (const c of msg.cells) {
          if (c.row < 0 || c.row >= height || c.col < 0 || c.col >= width) continue;
          const idx = c.row * width + c.col;
          const px = idx * 4;
          colors[px] = c.r;
          colors[px + 1] = c.g;
          colors[px + 2] = c.b;
          colors[px + 3] = 255;
        }
      }

      const copy = new Uint8ClampedArray(colors);
      self.postMessage(
        { type: 'stepped', generation, colors: copy },
        { transfer: [copy.buffer] },
      );
      break;
    }

    case 'recompile': {
      compileFns(msg.stepCode, msg.inputColorCodes);
      self.postMessage({ type: 'ready' });
      break;
    }
  }
};
