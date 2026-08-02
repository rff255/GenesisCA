/**
 * C5 (P10) — runtime migration: give every loaded model an EXPLICIT
 * `properties.reproducibility`.
 *
 * THE RULE: **`'statistical'` iff the model's RESOLVED agent engine is WebGPU**;
 * everything else `'exact'` (the default, and what every CPU model already
 * delivers). A model already running its agents on the GPU has been living with
 * per-agent-RNG variance all along — the migration RECORDS that rather than
 * changing it.
 *
 * It reads the answer `resolveEngines` produced instead of re-deriving which
 * engine the agents land on, so the inference cannot drift from the resolution
 * (the same single-source discipline as C1/C4).
 *
 * COHERENCE: this can never change which engine an existing file runs on. C4's
 * migration deliberately never produces `'auto'`, so every shipped file carries
 * an EXPLICIT engine on both layers and takes the explicit branch of
 * `resolveEngines` — which the contract does not touch. The contract only ever
 * changes what `Auto` picks. `scripts/test-engine-resolve.mjs` asserts this
 * model by model, both layers.
 *
 * Idempotent (a model that already carries the field is returned by reference)
 * and stable: the inference reads the RESOLVED engine, which for an explicit
 * target is the gate's answer and therefore contract-independent — so running it
 * on its own output produces the same contract.
 *
 * Runs AFTER `migrateEngineField`, whose `engine` field the resolution reads.
 *
 * NOT wired into `macroImport`: a `.gcamacro` carries a `MacroDef`, which has no
 * `properties`, so there is nothing to migrate there.
 */

import type { CAModel } from './types';
import { resolveEngines } from './engineResolution';
import { inferContract } from './reproducibility';

/** Seed `properties.reproducibility` when the file predates the field.
 *  Returns the SAME model object when nothing changed. */
export function migrateReproducibilityField(model: CAModel): CAModel {
  const c = model.properties?.reproducibility;
  if (c === 'exact' || c === 'statistical') return model;
  const resolvedAgents = resolveEngines(model).agents?.resolved ?? null;
  return {
    ...model,
    properties: { ...model.properties, reproducibility: inferContract(resolvedAgents) },
  };
}
