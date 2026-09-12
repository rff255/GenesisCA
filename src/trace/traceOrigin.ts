/** RULE TRACE (P3) — from a resolved origin to "what should light up HERE".
 *
 * `resolveTraceOrigin` (the COMPILER's half, `src/modeler/vpl/compiler/traceOrigin.ts`)
 * answers *which user node a lowered record stands for* — a node id plus, when
 * the node lives inside a macro, the instance path that reaches it. The graph
 * EDITOR shows exactly one scope at a time (the top-level graph, or the inside
 * of one macro instance), so a second question has to be answered before a class
 * can be toggled: **is this record visible in the scope the user is looking at,
 * and if so, on which node of THAT scope?**
 *
 * The rule is one line of set logic (the scope must be a PREFIX of the macro
 * path) with two outcomes:
 *
 * | scope            | origin macroPath | visible | lights                        |
 * |------------------|------------------|---------|-------------------------------|
 * | `[]` (root)      | `[]`             | yes     | the node itself               |
 * | `[]` (root)      | `[A]` / `[A,B]`  | yes     | `A` — the INSTANCE node       |
 * | `[A]`            | `[]`             | no      | (a top-level node is not in A)|
 * | `[A]`            | `[A]`            | yes     | the inner node itself         |
 * | `[A]`            | `[A,B]`          | yes     | `B` — the nested instance     |
 * | `[A]`            | `[C]`            | no      | (another instance)            |
 *
 * That is what makes "a macro instance lights when anything inside it ran" and
 * "entering the instance shows the inner path" ONE rule rather than two, and it
 * is why the SAME macro instanced twice keeps its two traces apart: the paths
 * differ in their first element.
 *
 * DOM-free and dependency-free (types only), so `scripts/test-rule-trace.mjs`
 * drives the shipped function rather than a transcription of it.
 */

import type { TraceOrigin } from '../modeler/vpl/compiler/traceOrigin';

export interface OriginInScope {
  /** Does this record belong to the scope the editor is showing? */
  visible: boolean;
  /** The node id to light IN THAT SCOPE — the record's own node when the scope
   *  is exactly its home, otherwise the macro-instance node that contains it.
   *  Empty string when `visible` is false. */
  nodeId: string;
}

const NOT_VISIBLE: OriginInScope = { visible: false, nodeId: '' };

/** Map one RESOLVED origin onto the editor's current macro scope.
 *
 *  `scope` is the open macro-instance path, outermost first (`[]` = the
 *  top-level graph) — the same shape `GraphEditor`'s scope stack carries. */
export function originInScope(resolved: TraceOrigin, scope: readonly string[]): OriginInScope {
  const path = resolved.macroPath ?? [];
  // The scope must be a PREFIX of the record's macro path, or the record lives
  // somewhere else entirely and nothing in this scope may claim it.
  if (path.length < scope.length) return NOT_VISIBLE;
  for (let i = 0; i < scope.length; i++) if (path[i] !== scope[i]) return NOT_VISIBLE;
  // Exactly at home ⇒ the record's own node. Deeper ⇒ the instance node that
  // carries it in this scope (one level down, never the whole remaining path).
  if (path.length === scope.length) return { visible: true, nodeId: resolved.nodeId };
  return { visible: true, nodeId: path[scope.length]! };
}
