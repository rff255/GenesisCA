import type { GraphNode, GraphEdge, MacroDef } from '../../model/types';
import type { ActiveGraphKind } from './graphState';

/**
 * The node-graph clipboard, shared BETWEEN BROWSER TABS.
 *
 * Copy/cut writes two places: the module-level in-memory clipboard (the
 * historical same-tab path, unchanged) AND a serialized payload in
 * localStorage, which every same-origin tab can read. So a selection copied in
 * a tab holding model A pastes into a tab holding model B, without the
 * save-a-macro / import-a-macro round trip.
 *
 * Freshness rule: both copies carry the SAME `at` stamp at write time, and
 * paste takes whichever is newer. The in-memory copy therefore always wins for
 * a same-tab flow (identical stamp, memory checked first on a tie), and a
 * copy performed in another tab afterwards wins because its stamp is later.
 *
 * A payload also BUNDLES every MacroDef the copied macro instances reference
 * (transitively, so a macro nested inside a macro travels too) — the defs live
 * in the source model, which the pasting tab has no access to.
 */

export const GRAPH_CLIPBOARD_KEY = 'genesisca_graph_clipboard_v1';

/** Skip the localStorage write past this size — the ~5 MB quota is shared with
 *  every other genesisca_* key, and a giant selection must not evict them. The
 *  in-memory clipboard still holds it, so same-tab paste is unaffected. */
const MAX_STORED_CHARS = 2_000_000;

export interface GraphClipboardPayload {
  v: 1;
  /** Write time — the freshness comparator between memory and storage. */
  at: number;
  kind: ActiveGraphKind;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** MacroDefs referenced (transitively) by the copied macro instances. Only
   *  consulted when the def id is absent from the pasting model. */
  macroDefs?: MacroDef[];
}

export type ClipboardSource = 'memory' | 'storage';

let memory: GraphClipboardPayload | null = null;

// Parse cache — the pane context menu re-reads the clipboard on every render
// while it is open, and a 2 MB payload should not be re-parsed each time.
let cachedRaw: string | null = null;
let cachedParsed: GraphClipboardPayload | null = null;

function macroDefIdOf(n: GraphNode): string | undefined {
  if (n.data?.nodeType !== 'macro') return undefined;
  const cfg = n.data.config as Record<string, unknown> | undefined;
  const id = cfg?.macroDefId;
  return typeof id === 'string' && id ? id : undefined;
}

/**
 * Every MacroDef the given nodes reference, plus the defs THOSE defs reference,
 * transitively (a macro instance can live inside another macro's subgraph).
 * Returns [] when the selection holds no macro instances — the common case.
 */
export function collectMacroDefBundle(nodes: GraphNode[], allDefs: MacroDef[]): MacroDef[] {
  if (allDefs.length === 0) return [];
  const byId = new Map(allDefs.map(d => [d.id, d]));
  const out: MacroDef[] = [];
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const n of nodes) {
    const id = macroDefIdOf(n);
    if (id) queue.push(id);
  }
  // Depth is bounded by the def count (`seen` guards cycles), so a pathological
  // self-nesting def cannot loop forever.
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const def = byId.get(id);
    if (!def) continue;
    out.push(def);
    for (const n of def.nodes) {
      const nested = macroDefIdOf(n);
      if (nested && !seen.has(nested)) queue.push(nested);
    }
  }
  return out;
}

/** The def ids referenced from INSIDE the bundled defs — these are shared by
 *  every instance a paste creates (one clone per paste), unlike the top-level
 *  defs, which get an independent clone per pasted node. */
export function nestedMacroDefIds(bundle: MacroDef[]): Set<string> {
  const ids = new Set<string>();
  for (const def of bundle) {
    for (const n of def.nodes) {
      const nested = macroDefIdOf(n);
      if (nested) ids.add(nested);
    }
  }
  return ids;
}

/** Retarget the macro instances inside a def at their freshly-imported defs.
 *  Returns the same reference when nothing changed. */
export function remapNestedMacroRefs(def: MacroDef, remap: Map<string, string>): MacroDef {
  let changed = false;
  const nodes = def.nodes.map(n => {
    const old = macroDefIdOf(n);
    if (!old) return n;
    const next = remap.get(old);
    if (!next || next === old) return n;
    changed = true;
    const cfg = (n.data.config ?? {}) as Record<string, unknown>;
    return { ...n, data: { ...n.data, config: { ...cfg, macroDefId: next } } } as GraphNode;
  });
  return changed ? { ...def, nodes } : def;
}

function isKind(k: unknown): k is ActiveGraphKind {
  return k === 'cells' || k === 'agents' || k === 'overseer';
}

/** Defensive shape check — a foreign / older / truncated localStorage entry is
 *  ignored rather than allowed to throw anywhere near a render. */
function validate(raw: unknown): GraphClipboardPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (p.v !== 1) return null;
  if (typeof p.at !== 'number' || !Number.isFinite(p.at)) return null;
  if (!isKind(p.kind)) return null;
  if (!Array.isArray(p.nodes) || !Array.isArray(p.edges)) return null;
  for (const n of p.nodes) {
    if (!n || typeof n !== 'object') return null;
    const gn = n as Record<string, unknown>;
    if (typeof gn.id !== 'string' || !gn.position || typeof gn.position !== 'object') return null;
  }
  const defs = p.macroDefs;
  if (defs !== undefined && !Array.isArray(defs)) return null;
  return {
    v: 1,
    at: p.at,
    kind: p.kind,
    nodes: p.nodes as GraphNode[],
    edges: p.edges as GraphEdge[],
    macroDefs: (defs as MacroDef[] | undefined)?.filter(d => d && typeof (d as MacroDef).id === 'string' && Array.isArray((d as MacroDef).nodes)),
  };
}

function readStored(): GraphClipboardPayload | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(GRAPH_CLIPBOARD_KEY);
  } catch {
    return null; // storage disabled (private mode / blocked cookies)
  }
  if (!raw) {
    cachedRaw = null;
    cachedParsed = null;
    return null;
  }
  if (raw === cachedRaw) return cachedParsed;
  cachedRaw = raw;
  try {
    cachedParsed = validate(JSON.parse(raw));
  } catch {
    cachedParsed = null; // corrupt entry — fall back to the in-memory clipboard
  }
  return cachedParsed;
}

/** Copy/cut: stamp the payload and publish it to both transports. */
export function writeGraphClipboard(payload: Omit<GraphClipboardPayload, 'v' | 'at'>): void {
  const stamped: GraphClipboardPayload = { v: 1, at: Date.now(), ...payload };
  memory = stamped;
  let json: string;
  try {
    json = JSON.stringify(stamped);
  } catch {
    return; // non-serializable node data — same-tab paste still works
  }
  try {
    if (json.length > MAX_STORED_CHARS) {
      // Too big to share. Drop any older entry so another tab never pastes a
      // stale selection believing it is this copy.
      localStorage.removeItem(GRAPH_CLIPBOARD_KEY);
      cachedRaw = null;
      cachedParsed = null;
      console.warn(
        `[clipboard] selection too large to share between tabs (${(json.length / 1e6).toFixed(1)} MB) — copied within this tab only`,
      );
      return;
    }
    localStorage.setItem(GRAPH_CLIPBOARD_KEY, json);
    cachedRaw = json;
    cachedParsed = stamped;
  } catch {
    // Quota / disabled storage — the in-memory clipboard is authoritative.
  }
}

/** The clipboard a paste should use: the fresher of the in-memory copy (this
 *  tab) and the shared localStorage copy (any tab). */
export function readGraphClipboard(): { payload: GraphClipboardPayload; source: ClipboardSource } | null {
  const stored = readStored();
  if (memory && (!stored || stored.at <= memory.at)) return { payload: memory, source: 'memory' };
  if (stored) return { payload: stored, source: 'storage' };
  return null;
}

/** Write back the singleton-filtered node list when the paste consumed the
 *  in-memory clipboard (preserves the historical same-tab behaviour). */
export function setMemoryClipboardNodes(nodes: GraphNode[]): void {
  if (memory) memory = { ...memory, nodes };
}
