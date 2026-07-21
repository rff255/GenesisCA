/** Named square-matrix generators for float Lookup Tables — ports of the
 *  Sandbox Science Particle Life `rulesGenerator.ts` catalogue, adapted to the
 *  house seeded xorshift32 (13/17/5) so every fill is reproducible from a seed.
 *  Deterministic patterns ignore the seed; the two random ones consume it.
 *
 *  All generators return a FLAT row-major n×n array (the dense layout the
 *  LookupTableEditor converts to `tableValues` / `tableData`). Values are the
 *  rules-matrix semantics (∈ [−1, 1]); the random ones honour [lo, hi). */

function makeRng(seed: number): () => number {
  let rs = (seed >>> 0) || 0x12345678;
  return () => {
    rs = (rs ^ (rs << 13)) >>> 0;
    rs = (rs ^ (rs >>> 17)) >>> 0;
    rs = (rs ^ (rs << 5)) >>> 0;
    return rs / 4294967296;
  };
}

export interface MatrixGeneratorDef {
  id: string;
  name: string;
  /** Consumes the seed (re-roll changes the output). */
  random?: boolean;
  gen: (n: number, seed: number, lo: number, hi: number) => number[];
}

const flat = (n: number, f: (i: number, j: number) => number): number[] => {
  const m = new Array<number>(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) m[i * n + j] = f(i, j);
  return m;
};

export const MATRIX_GENERATORS: MatrixGeneratorDef[] = [
  {
    id: 'uniform', name: 'Uniform random', random: true,
    gen: (n, seed, lo, hi) => { const r = makeRng(seed); return flat(n, () => r() * (hi - lo) + lo); },
  },
  {
    id: 'symmetric', name: 'Symmetric random', random: true,
    gen: (n, seed, lo, hi) => {
      const r = makeRng(seed);
      const m = flat(n, () => r() * (hi - lo) + lo);
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) m[j * n + i] = m[i * n + j]!;
      return m;
    },
  },
  {
    id: 'snake', name: 'Snake',
    gen: n => flat(n, (i, j) => (j === i ? 1 : j === (i + 1) % n ? 0.2 : 0)),
  },
  {
    id: 'rps', name: 'Rock–Paper–Scissors',
    gen: n => flat(n, (i, j) => (j === i ? -0.1 : j === (i + 1) % n ? 0.9 : j === (i + n - 1) % n ? -0.7 : 0)),
  },
  {
    id: 'chains', name: 'Chains',
    gen: n => flat(n, (i, j) => (j === i ? 1 : j === (i + 1) % n || j === (i + n - 1) % n ? 0.2 : -1)),
  },
  {
    id: 'bipartite', name: 'Bipartite',
    gen: n => flat(n, (i, j) => (j === i ? 0.2 : (i % 2) === (j % 2) ? 0.8 : -0.8)),
  },
  {
    id: 'hubSpokes', name: 'Hub & Spokes',
    gen: n => flat(n, (i, j) => (i === j ? 0 : i === 0 ? 1.0 : j === 0 ? 0.6 : 0)),
  },
  {
    id: 'shells', name: 'Concentric shells',
    gen: n => flat(n, (i, j) => (j === i ? 0.9 : j === (i + 1) % n ? 0.3 : -0.6)),
  },
  {
    id: 'swirl', name: 'Anti-symmetric swirl',
    gen: n => {
      const m = flat(n, () => 0);
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const v = ((j - i + n) % n) <= n / 2 ? 0.7 : -0.7;
          m[i * n + j] = v; m[j * n + i] = -v;
        }
        m[i * n + i] = -0.05;
      }
      return m;
    },
  },
  {
    id: 'dimers', name: 'Dimers & chains',
    gen: n => flat(n, (i, j) => (j === i ? 0 : j === (i ^ 1) && (i ^ 1) < n ? 1.0 : -0.9)),
  },
  {
    id: 'triads', name: 'Triad flocks',
    gen: n => flat(n, (i, j) => (i === j ? 0.1 : Math.floor(i / 3) === Math.floor(j / 3) ? 0.9 : -0.7)),
  },
];

export function generateMatrix(id: string, n: number, seed: number, lo: number, hi: number): number[] | null {
  const def = MATRIX_GENERATORS.find(g => g.id === id);
  return def ? def.gen(n, seed, lo, hi) : null;
}

/** Seeded ±noise mutation: each entry gets uniform(−amp, +amp) added, clamped
 *  to [lo, hi]. The exploration primitive ("perturb and watch"). */
export function mutateMatrix(m: readonly number[], seed: number, amp: number, lo: number, hi: number): number[] {
  const r = makeRng(seed);
  return m.map(v => Math.min(hi, Math.max(lo, v + (r() * 2 - 1) * amp)));
}
