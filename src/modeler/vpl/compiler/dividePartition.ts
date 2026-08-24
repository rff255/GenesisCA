// Graph-Rewriting Automata (P5) — the DIVISION BOND PARTITION.
//
// WHY. `divideAgent` split a mother's bonds between its two daughters purely by
// GEOMETRY (`sign(dot(offset, m̂))`). A graph-rewriting rule is *defined* by which
// EDGES go to which daughter, so geometry is exactly the thing the user cannot
// say. This module is the ONE definition of the declarative alternative — the
// shape the node config encodes, the engine consumes, and the harness tests.
//
//   tension           the geometric tension-axis split. THE DEFAULT, and it must
//                     stay byte-identical: every shipped bonded model uses it.
//   alternate         bonds alternate A, B, A, B… in SLOT order. Deterministic,
//                     needs no attribute — the cheapest way to halve a hub.
//   byBondAttribute   a named BOND attribute (P2) selects the daughter:
//                       bool     false → A, true → B          (threshold 0.5)
//                       integer  value < threshold → A, ≥ → B
//                       float    value < threshold → A, ≥ → B
//                       tag      a per-OPTION A/B assignment (`tagB`), which is
//                                the shape the rule actually reads like:
//                                "give daughter A the apical bonds".
//
// TRANSPORT — how a per-NODE mode reaches the ENGINE (the §2.3 design question).
//
// `divideAgent` runs inside the engine's structural phase; the mode lives on a
// node's CONFIG, and a model may hold several Divide Agent nodes. The chosen
// shape reuses the `stopMessages` / `_stopIdx` precedent END TO END rather than
// adding a request LANE:
//
//   * the compiler collects one entry per DISTINCT partition spec into a table
//     and bakes the 1-based `_divideIdx` onto each node's config;
//   * all three agent targets emit `divideRequest[idx] = _divideIdx` — the SAME
//     cell that already carried the 0/1 flag, so there is NO new store field, NO
//     new ABI field and NO layout change on any target;
//   * the table travels to the worker in the init / recompile message (exactly
//     like `stopMessages`), and the structural phase looks the spec up by the
//     code it read back.
//
// This is deliberately NOT a new `divideMode` lane (the phase handoff's §2.3
// recommendation), for three measured reasons:
//   1. BYTE IDENTITY, the phase's most important gate. `divideAxis*`/`divideAsym`
//      sit in the MIDDLE of both the CPU (`AGENT_F64_FIELDS`) and GPU
//      (`AGENT_GPU_F32_FIELDS`) field lists, so an unconditional lane shifts every
//      later baked offset and diffs every agent model's WASM bytes + WGSL shader.
//      A usage gate could avoid that, but only by adding a second gate mechanism.
//      Riding the existing cell costs nothing: `1` is what the pre-P5 emitters
//      already wrote.
//   2. The spec is RICHER than a float. A tag partition is a per-option vector; a
//      threshold is a real number; the daughter-bond policy is a third value.
//      On WebGPU a lane is f32 (24-bit mantissa) — packing three fields into one
//      is exactly the fragile bit-packing the codebase avoids elsewhere.
//   3. Per-node fidelity is preserved either way, and the table dedupes, so two
//      instances of the same macro share one entry (macro expansion shares the
//      config OBJECT — see compile.ts's `_stopIdx` bake).
//
// The lane is still the right answer for a value that is genuinely PER-REQUEST
// (a wired axis); the partition is per-NODE and constant, which is why a table
// fits it better.

import type { CAModel, Attribute } from '../../../model/types';
import { bondAttrsOf } from '../../../model/attributeScope';
import { is3dModelLike } from './niCodec';

/** How a dividing agent's bonds are split between its two daughters. */
export type DividePartitionMode = 'tension' | 'alternate' | 'byBondAttribute';

/** What a division CONSERVES when it sizes the two daughters.
 *
 *  `area`   `rA = r·√f`, `rB = r·√(1−f)` ⇒ `rA² + rB² = r²`. THE DEFAULT, and
 *           the historical (pre-D2) behaviour in BOTH dimensions — so every
 *           existing model is untouched.
 *  `volume` `rA = r·∛f`, `rB = r·∛(1−f)` ⇒ `rA³ + rB³ = r³`. 3D ONLY.
 *
 *  Why the option exists: the area split was applied in 3D too, where it is not
 *  volume-conserving — at the default symmetric split each daughter is `r/√2`,
 *  so `VA + VB = 2·(1/√2)³·V ≈ 0.707·V` and **~29 % of the volume disappears at
 *  every symmetric 3D division**. The volume-conserving radius is `r·∛0.5 =
 *  0.7937·r`, ~12 % larger.
 *
 *  Why `volume` is 3D-only: "conserve r³" is physically meaningless on a disc.
 *  The CaNode row is hidden in a 2D model AND both the resolver below and the
 *  engine (`divideAgent`, on `D <= 1`) coerce to `'area'` — the standing rule
 *  that a hidden control needs its STATE handled, not just its markup, so a
 *  hand-edited 2D file cannot silently change behaviour. */
export type DivideConserveMode = 'area' | 'volume';

/** Decision D4 — when the daughter–daughter bond is added.
 *   `auto`   only when the mother WAS bonded (the pre-P5 behaviour, the default,
 *            so no shipped model changes: a free agent's daughters separate).
 *   `always` unconditionally — what a graph-rewriting rule nearly always wants,
 *            since it keeps the rewritten graph connected through the split.
 *   `never`  never — the "split this node in two" rewrite, whose daughters are
 *            deliberately NOT adjacent. */
export type DaughterBondPolicy = 'auto' | 'always' | 'never';

/** The declarative partition a Divide Agent node requests. Travels COMPLETE from
 *  the compiler to the worker (structured-clone-safe: plain scalars + a number
 *  array), so the engine never has to consult the model. */
export interface DividePartitionSpec {
  mode: DividePartitionMode;
  /** `byBondAttribute`: the bond attribute id. Empty / unresolvable ⇒ the engine
   *  falls back to `tension` (and `detectMissingConfig` badges the node — the
   *  partition is never silently wrong). */
  attributeId: string;
  /** `byBondAttribute` on bool / integer / float: `value < threshold` → daughter
   *  A, `≥` → daughter B. Bool pins 0.5 (false → A, true → B). */
  threshold: number;
  /** `byBondAttribute` on TAG: per-OPTION daughter, indexed by option index
   *  (1 = daughter B, 0 = daughter A). Empty ⇒ the threshold rule is used
   *  instead (which is what bool / integer / float take). */
  tagB: number[];
  /** Decision D4 — the daughter–daughter bond policy. */
  daughterBond: DaughterBondPolicy;
  /** D2 — what the daughter RADII conserve. Always `'area'` for a 2D model (the
   *  resolver coerces), so it rides the same table with no new lane, no ABI
   *  field and no emitter change on any of the three targets. */
  conserve: DivideConserveMode;
}

/** The pre-P5 behaviour, and what the engine uses when a code resolves to no
 *  table entry (a stale request, or a model compiled before the table existed). */
export const DEFAULT_DIVIDE_PARTITION: DividePartitionSpec = {
  mode: 'tension', attributeId: '', threshold: 0.5, tagB: [], daughterBond: 'auto',
  conserve: 'area',
};

/** The config keys a Divide Agent node uses for its partition. Listed once so the
 *  node def, the CaNode UI, the cascades and the validation cannot drift. */
export const DIVIDE_PARTITION_CONFIG_KEYS = {
  mode: 'partition',
  attributeId: 'partitionAttributeId',
  threshold: 'partitionThreshold',
  daughterBond: 'daughterBond',
  /** D2 — `'area'` (default / absent) or `'volume'` (3D only). */
  conserve: 'conserve',
  /** Per-tag-option daughter: `partTag_<optionIndex>` (truthy ⇒ daughter B). */
  tagPrefix: 'partTag_',
} as const;

/** Resolve the bond attribute a `byBondAttribute` partition names, honouring the
 *  SAME filters every other bond-attribute consumer applies (`bondAttrsOf`:
 *  Bonds-capability-off ⇒ none; only the four allowed types). Returns undefined
 *  when the attribute was deleted, is of an unusable type, or bonds are off. */
export function dividePartitionAttribute(
  config: Record<string, string | number | boolean | undefined>,
  model: CAModel,
): Attribute | undefined {
  const id = String(config[DIVIDE_PARTITION_CONFIG_KEYS.attributeId] ?? '');
  if (!id) return undefined;
  return bondAttrsOf(model).find(a => a.id === id);
}

/** Build the engine-facing spec from a Divide Agent node's config. An
 *  unresolvable `byBondAttribute` DEGRADES TO `tension` here (never a silent
 *  mis-partition) — `detectMissingConfig` badges the same condition so the user
 *  is told rather than surprised. */
export function dividePartitionFromConfig(
  config: Record<string, string | number | boolean | undefined>,
  model: CAModel,
): DividePartitionSpec {
  const K = DIVIDE_PARTITION_CONFIG_KEYS;
  const rawMode = String(config[K.mode] ?? 'tension');
  const daughterBondRaw = String(config[K.daughterBond] ?? 'auto');
  const daughterBond: DaughterBondPolicy =
    daughterBondRaw === 'always' || daughterBondRaw === 'never' ? daughterBondRaw : 'auto';
  // D2 — `volume` is 3D-only: coerce it here (the model IS available) so a 2D
  // model's spec, key and assigned code are IDENTICAL whatever the config says.
  // The engine coerces again on `D <= 1` (defence in depth — a spec can also
  // arrive from a restored/hand-edited message, where no model is at hand).
  const conserve: DivideConserveMode =
    String(config[K.conserve] ?? 'area') === 'volume' && is3dModelLike(model) ? 'volume' : 'area';

  if (rawMode === 'alternate') {
    return { mode: 'alternate', attributeId: '', threshold: 0.5, tagB: [], daughterBond, conserve };
  }
  if (rawMode === 'byBondAttribute') {
    const attr = dividePartitionAttribute(config, model);
    if (!attr) return { ...DEFAULT_DIVIDE_PARTITION, daughterBond, conserve };
    if (attr.type === 'tag') {
      const opts = attr.tagOptions ?? [];
      const tagB = opts.map((_, i) => (config[`${K.tagPrefix}${i}`] ? 1 : 0));
      return { mode: 'byBondAttribute', attributeId: attr.id, threshold: 0.5, tagB, daughterBond, conserve };
    }
    // bool pins the threshold (false → A, true → B); integer / float take the
    // configured one (0.5 by default, so 0 → A and 1+ → B reads naturally).
    const threshold = attr.type === 'bool' ? 0.5 : Number(config[K.threshold] ?? 0.5);
    return {
      mode: 'byBondAttribute', attributeId: attr.id,
      threshold: Number.isFinite(threshold) ? threshold : 0.5,
      tagB: [], daughterBond, conserve,
    };
  }
  return { ...DEFAULT_DIVIDE_PARTITION, daughterBond, conserve };
}

/** Canonical identity of a spec — the dedupe key for the per-model table. Two
 *  Divide Agent nodes requesting the same partition share one entry (which is
 *  also what makes two instances of one macro consistent, since expansion shares
 *  the config object).
 *
 *  ⚠ THE BYTE-IDENTITY MECHANISM (D2). `conserve` is appended as a SUFFIX, and
 *  ONLY for the non-default `'volume'` — so a spec that conserves area produces
 *  the EXACT key it produced before D2. The table is key-SORTED, so an unchanged
 *  key set ⇒ an unchanged sort order ⇒ an unchanged 1-based code ⇒ an unchanged
 *  `_divideIdx` ⇒ byte-identical emitted text / WASM bytes / WGSL on all three
 *  targets, for every existing model. (Appending `|area` to every key would ALSO
 *  preserve the order — no key can be a proper prefix of another, since all five
 *  fields are `|`-delimited and the last is one of three non-prefixing words —
 *  but leaving existing keys untouched is strictly stronger, and it makes the
 *  claim decidable by inspection rather than by that argument.)
 *
 *  No collision is possible either: a volume key ends in `|volume`, and an area
 *  key ends in its `daughterBond` word (auto / always / never), so an area key
 *  can never equal a volume one. */
export function dividePartitionKey(spec: DividePartitionSpec): string {
  const base = `${spec.mode}|${spec.attributeId}|${spec.threshold}|${spec.tagB.join(',')}|${spec.daughterBond}`;
  return spec.conserve === 'volume' ? `${base}|volume` : base;
}

/** THE TABLE — one entry per DISTINCT partition a model's agent graph requests,
 *  in a CANONICAL (key-sorted) order.
 *
 *  Derived from the MODEL — the top-level agent graph plus every macro
 *  definition's nodes — exactly like `bondReqSlotsForModel`, and for the same
 *  reason: it must give the SAME answer no matter which target asks, and macro
 *  instances expand to their internals at compile time. Two properties follow,
 *  and both matter:
 *
 *    ORDER-INDEPENDENT. A key SORT (not first-encounter order) means the table
 *    cannot depend on the node array's order or on which subset a particular
 *    target's flatten produced. The three agent compilers run in different orders
 *    in different harnesses; relying on "JS runs first" (the `_stopIdx`
 *    convention) would silently give WASM the wrong code when it doesn't.
 *
 *    IDEMPOTENT. Re-running the assignment over the same model rewrites the same
 *    numbers, so a second compile of the same graph is a no-op.
 *
 *  Over-counting (a macro def that is never instantiated) only makes the table
 *  longer — it never changes an assigned code, because the code is the sorted
 *  position of the node's OWN spec. */
export function dividePartitionTableForModel(model: CAModel): DividePartitionSpec[] {
  const byKey = new Map<string, DividePartitionSpec>();
  const scan = (nodes: ReadonlyArray<{ data: { nodeType: string; config: Record<string, string | number | boolean | undefined> } }> | undefined) => {
    for (const n of nodes ?? []) {
      if (n.data?.nodeType !== 'divideAgent') continue;
      const spec = dividePartitionFromConfig(n.data.config, model);
      const key = dividePartitionKey(spec);
      if (!byKey.has(key)) byKey.set(key, spec);
    }
  };
  scan(model.agentGraphNodes as never);
  for (const def of model.macroDefs ?? []) scan(def.nodes as never);
  return [...byKey.keys()].sort().map(k => byKey.get(k)!);
}

/** Bake the 1-based partition code onto every Divide Agent node in `nodes` and
 *  return the model's table. Called by ALL THREE agent front-ends (the emitters
 *  then read the baked `_divideIdx`, so they need no model access), and
 *  idempotent — whoever runs first, the numbers are the same. */
export function assignDividePartitionCodes(
  nodes: ReadonlyArray<{ data: { nodeType: string; config: Record<string, string | number | boolean | undefined> } }>,
  model: CAModel,
): DividePartitionSpec[] {
  const table = dividePartitionTableForModel(model);
  if (table.length === 0) return table;
  const codeOf = new Map(table.map((s, i) => [dividePartitionKey(s), i + 1] as const));
  for (const n of nodes) {
    if (n.data?.nodeType !== 'divideAgent') continue;
    const key = dividePartitionKey(dividePartitionFromConfig(n.data.config, model));
    n.data.config._divideIdx = codeOf.get(key) ?? 1;
  }
  return table;
}

/** The 1-based code a Divide Agent node's emit writes into `divideRequest`.
 *  `1` when un-baked, which is EXACTLY the pre-P5 literal — so a model compiled
 *  without the assignment (or with a single distinct spec, which is every shipped
 *  model) is byte-identical. */
export function dividePartitionCode(
  config: Record<string, string | number | boolean | undefined>,
): number {
  const n = Number(config._divideIdx ?? 1);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}
