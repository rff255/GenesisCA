/**
 * C4 (P1) — runtime migration: give every loaded model an EXPLICIT
 * `properties.engine`, derived from the legacy `useWebGPU` / `useWasm` flags.
 *
 * THE RULE: **a legacy file never becomes `'auto'`.** It gets the explicit
 * equivalent of what it already does, so its behaviour — and every byte the
 * compilers emit for it — is unchanged. `'auto'` appears only on models created
 * after this phase (EMPTY_MODEL) or when the user picks it.
 *
 *   useWebGPU → 'webgpu'   (WebGPU wins when a hand-edited file sets both, which
 *                           mirrors the worker's existing mutual-exclusion net)
 *   useWasm   → 'wasm'
 *   neither   → 'js'
 *
 * `centerBased.agentTarget` is deliberately LEFT ALONE: absent already resolves
 * to `'js'` via `agentTargetOf`, and flipping absent → `'auto'` would silently
 * change which engine an existing agent model runs on.
 *
 * Idempotent — a model that already carries `engine` is returned unchanged (same
 * object reference), so re-running it (LOAD_MODEL + the dev harness) is free.
 *
 * NOT wired into `macroImport`: a `.gcamacro` carries a `MacroDef`, which has no
 * `properties` and no `centerBased`, so there is nothing to migrate there.
 */

import type { CAModel, EngineChoice, ModelProperties } from './types';

/** The engine a set of legacy flags is asking for. Mirrors C1's
 *  `gridRequestedEngine` and the worker's safety net (WebGPU wins if both). */
export function engineFromLegacyFlags(props: Pick<ModelProperties, 'useWasm' | 'useWebGPU'>): EngineChoice {
  if (props.useWebGPU) return 'webgpu';
  if (props.useWasm) return 'wasm';
  return 'js';
}

/** Seed `properties.engine` on a loaded model when the file predates the field.
 *  Returns the SAME model object when nothing changed. */
export function migrateEngineField(model: CAModel): CAModel {
  const e = model.properties?.engine;
  if (e === 'auto' || e === 'js' || e === 'wasm' || e === 'webgpu') return model;
  return {
    ...model,
    properties: { ...model.properties, engine: engineFromLegacyFlags(model.properties) },
  };
}
