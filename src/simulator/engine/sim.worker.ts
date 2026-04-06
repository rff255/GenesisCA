/**
 * Web Worker for GenesisCA simulation.
 * Uses Structure of Arrays (SoA) for grid state — one typed array per attribute.
 * Pre-computes neighbor index tables for zero-cost boundary handling.
 */

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

interface StepMsg { type: 'step'; count: number; activeViewer: string }
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
let total = 0;
let cellAttrs: AttrDef[] = [];
let neighborhoods: NeighborhoodDef[] = [];
let boundaryTreatment = 'torus';
let generation = 0;

// SoA: one typed array per attribute, double-buffered (A = read, B = write)
let attrsA: Record<string, ArrayLike<number> & { [i: number]: number; length: number }> = {};
let attrsB: Record<string, ArrayLike<number> & { [i: number]: number; length: number }> = {};
let readAttrs = attrsA;
let writeAttrs = attrsB;

// Pre-computed neighbor indices: nbrIndices[nbrId][cellIdx * nbrSize + n] = neighbor flat index
let nbrIndices: Record<string, Int32Array> = {};

let colors: Uint8ClampedArray = new Uint8ClampedArray(0);
let stepFn: Function | null = null;
let inputColorFns: Array<{ mappingId: string; fn: Function }> = [];

// Cached model attributes
let cachedModelAttrs: Record<string, unknown> = {};

// ---------------------------------------------------------------------------
// Typed array creation by attribute type
// ---------------------------------------------------------------------------

function createTypedArray(type: string, size: number): Float64Array | Int32Array | Uint8Array {
  switch (type) {
    case 'bool': return new Uint8Array(size);
    case 'integer': return new Int32Array(size);
    case 'float': return new Float64Array(size);
    default: return new Float64Array(size);
  }
}

function defaultValue(attr: AttrDef): number {
  switch (attr.type) {
    case 'bool': return attr.defaultValue === 'true' ? 1 : 0;
    case 'integer': return parseInt(attr.defaultValue, 10) || 0;
    case 'float': return parseFloat(attr.defaultValue) || 0;
    default: return 0;
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function initGrid(): void {
  total = width * height;
  attrsA = {};
  attrsB = {};

  for (const attr of cellAttrs) {
    const arrA = createTypedArray(attr.type, total);
    const arrB = createTypedArray(attr.type, total);
    const dv = defaultValue(attr);
    if (dv !== 0) { arrA.fill(dv); arrB.fill(dv); }
    attrsA[attr.id] = arrA;
    attrsB[attr.id] = arrB;
  }

  readAttrs = attrsA;
  writeAttrs = attrsB;
  colors = new Uint8ClampedArray(total * 4);
  generation = 0;
}

function buildNeighborIndices(): void {
  nbrIndices = {};
  for (const nbr of neighborhoods) {
    const nbrSize = nbr.coords.length;
    const indices = new Int32Array(total * nbrSize);

    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const cellIdx = row * width + col;
        for (let n = 0; n < nbrSize; n++) {
          const [dr, dc] = nbr.coords[n]!;
          let nRow = row + dr;
          let nCol = col + dc;

          if (nRow < 0 || nRow >= height || nCol < 0 || nCol >= width) {
            if (boundaryTreatment === 'torus') {
              nRow = ((nRow % height) + height) % height;
              nCol = ((nCol % width) + width) % width;
            } else {
              // Constant: point to cell 0 (will be filled with defaults)
              // We use a sentinel approach: index -1 means "use default"
              // But typed arrays can't store -1, so we use total as sentinel
              indices[cellIdx * nbrSize + n] = total; // sentinel
              continue;
            }
          }

          indices[cellIdx * nbrSize + n] = nRow * width + nCol;
        }
      }
    }

    nbrIndices[nbr.id] = indices;
  }

  // For constant boundary: ensure read attrs have a sentinel cell at index `total`
  // We extend each array by 1 with the default value
  if (boundaryTreatment !== 'torus') {
    for (const attr of cellAttrs) {
      const oldA = attrsA[attr.id]!;
      const oldB = attrsB[attr.id]!;
      const newA = createTypedArray(attr.type, total + 1);
      const newB = createTypedArray(attr.type, total + 1);
      (newA as Uint8Array).set(oldA as Uint8Array);
      (newB as Uint8Array).set(oldB as Uint8Array);
      newA[total] = defaultValue(attr);
      newB[total] = defaultValue(attr);
      attrsA[attr.id] = newA;
      attrsB[attr.id] = newB;
    }
    readAttrs = attrsA;
    writeAttrs = attrsB;
  }
}


// ---------------------------------------------------------------------------
// Step
// ---------------------------------------------------------------------------

/** Build the static args array (everything shared across all cells). idx is set per-cell. */
function buildStaticArgs(): unknown[] {
  const args: unknown[] = [0]; // idx placeholder at [0]
  for (const attr of cellAttrs) args.push(readAttrs[attr.id]);
  for (const attr of cellAttrs) args.push(writeAttrs[attr.id]);
  for (const nbr of neighborhoods) {
    args.push(nbrIndices[nbr.id]);       // full Int32Array
    args.push(nbr.coords.length);        // neighborhood size
  }
  args.push(cachedModelAttrs, colors, activeViewer);
  return args;
}

let activeViewer = '';

function runStep(): void {
  const fn = stepFn!;
  const args = buildStaticArgs();

  for (let idx = 0; idx < total; idx++) {
    args[0] = idx;
    fn(...args);
  }

  // Swap buffers
  const tmp = readAttrs;
  readAttrs = writeAttrs;
  writeAttrs = tmp;
  // Update args references for next step (buffers swapped)
  generation++;
}

function writeDefaultColors(): void {
  // Fallback coloring: first bool attr determines color
  const firstBool = cellAttrs.find(a => a.type === 'bool');
  if (!firstBool) {
    colors.fill(0);
    for (let i = 3; i < colors.length; i += 4) colors[i] = 255;
    return;
  }
  const arr = readAttrs[firstBool.id]!;
  for (let i = 0; i < total; i++) {
    const px = i * 4;
    if (arr[i]) {
      colors[px] = 76; colors[px + 1] = 201; colors[px + 2] = 240;
    } else {
      colors[px] = 13; colors[px + 1] = 27; colors[px + 2] = 43;
    }
    colors[px + 3] = 255;
  }
}

function randomizeGrid(): void {
  for (const attr of cellAttrs) {
    const arr = readAttrs[attr.id]!;
    for (let i = 0; i < total; i++) {
      if (attr.type === 'bool') arr[i] = Math.random() > 0.7 ? 1 : 0;
      else if (attr.type === 'integer') arr[i] = Math.floor(Math.random() * 10);
      else if (attr.type === 'float') arr[i] = Math.random();
    }
    // Copy to write buffer too
    const wArr = writeAttrs[attr.id]!;
    (wArr as Uint8Array).set(arr as Uint8Array);
  }
  generation = 0;
  writeDefaultColors();
}

function resetGrid(): void {
  for (const attr of cellAttrs) {
    const dv = defaultValue(attr);
    const arr = readAttrs[attr.id]!;
    const wArr = writeAttrs[attr.id]!;
    for (let i = 0; i < total; i++) { arr[i] = dv; wArr[i] = dv; }
  }
  generation = 0;
  writeDefaultColors();
}

function compileFns(stepCode: string, icCodes: Array<{ mappingId: string; code: string }>): void {
  try {
    // eslint-disable-next-line no-eval
    stepFn = stepCode ? (eval(stepCode) as Function) : null;
  } catch { stepFn = null; }
  inputColorFns = [];
  for (const ic of icCodes) {
    try {
      // eslint-disable-next-line no-eval
      inputColorFns.push({ mappingId: ic.mappingId, fn: eval(ic.code) as Function });
    } catch { /* skip */ }
  }
}

function sendColors(): void {
  const copy = new Uint8ClampedArray(colors);
  self.postMessage(
    { type: 'stepped', generation, colors: copy },
    { transfer: [copy.buffer] },
  );
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
      cellAttrs = msg.attributes.filter(a => !a.isModelAttribute);
      neighborhoods = msg.neighborhoods;
      boundaryTreatment = msg.boundaryTreatment;

      // Cache model attributes
      cachedModelAttrs = {};
      for (const attr of msg.attributes) {
        if (!attr.isModelAttribute) continue;
        cachedModelAttrs[attr.id] = defaultValue(attr);
      }

      activeViewer = msg.activeViewer;
      initGrid();
      buildNeighborIndices();
      compileFns(msg.stepCode, msg.inputColorCodes);
      writeDefaultColors();
      sendColors();
      break;
    }

    case 'step': {
      if (!stepFn) {
        self.postMessage({ type: 'error', message: 'No compiled step function.' });
        return;
      }
      activeViewer = msg.activeViewer;
      for (let i = 0; i < msg.count; i++) runStep();
      sendColors();
      break;
    }

    case 'paint': {
      activeViewer = msg.activeViewer;
      const icEntry = msg.mappingId
        ? inputColorFns.find(f => f.mappingId === msg.mappingId)
        : inputColorFns[0];

      for (const c of msg.cells) {
        if (c.row < 0 || c.row >= height || c.col < 0 || c.col >= width) continue;
        const idx = c.row * width + c.col;

        if (icEntry?.fn) {
          // InputColor writes to writeAttrs (via w_<attr>[idx])
          // We need to also update readAttrs so the next step sees the change
          const args = buildStaticArgs();
          args[0] = idx;
          icEntry.fn(c.r, c.g, c.b, ...args);
          // Copy written values back to read buffer so step() sees them
          for (const attr of cellAttrs) {
            readAttrs[attr.id]![idx] = writeAttrs[attr.id]![idx]!;
          }
        } else {
          // Fallback: set first bool attribute in BOTH buffers
          const firstBool = cellAttrs.find(a => a.type === 'bool');
          if (firstBool) {
            readAttrs[firstBool.id]![idx] = 1;
            writeAttrs[firstBool.id]![idx] = 1;
          }
        }
      }

      // Run one step so color viewers update the display
      if (stepFn) {
        runStep();
      } else {
        writeDefaultColors();
      }
      sendColors();
      break;
    }

    case 'randomize': {
      randomizeGrid();
      sendColors();
      break;
    }

    case 'reset': {
      resetGrid();
      sendColors();
      break;
    }

    case 'recompile': {
      compileFns(msg.stepCode, msg.inputColorCodes);
      self.postMessage({ type: 'ready' });
      break;
    }
  }
};
