/**
 * Linked Output Mappings — shared, target-agnostic pre-compile graph transform.
 *
 * For every Attribute→Color mapping marked `linked`, this synthesizes a small
 * **real** node subgraph that auto-generates the color pass:
 *
 *     getCellAttribute(attr) → colorScale | categoricalColor → setColorViewer(mapping)
 *
 * rooted at an `outputMapping` node. If the user ALSO placed an Output Mapping
 * event node for the same mapping, the auto pass is sequenced to run FIRST (via a
 * `Sequence` node: `first` = auto background, `then` = the user's original graph),
 * so the user's graph overrides whichever cells it touches. Both ends write the
 * same `colors` buffer; within one output-mapping function the LAST write wins.
 *
 * Because this emits ordinary nodes, all three compilers (JS / WASM / WebGPU)
 * reuse their existing, tested per-node emitters — there is no per-target color
 * math here.
 *
 * FRESHNESS: the synthesized subgraph is ephemeral — never serialized, rebuilt
 * from the CURRENT model on every compile. We resolve the attribute live by id,
 * branch on its live `type`, and (for tag) clamp the palette to the live
 * `tagOptions`, so a stale `Mapping.linked*` config can never emit a dangling
 * read. The ModelContext cascade is the first line of defense; these guards are
 * the second.
 */

import type { GraphNode, GraphEdge, CAModel, Attribute, Mapping, RGB, ColorStop } from '../../../model/types';
import { handleId } from '../types';
import { presetStops } from '../nodes/colorScalePresets';

const SYNTH_PREFIX = '__linkedOM_';

type Config = Record<string, string | number | boolean>;

export function injectLinkedOutputMappings(
  graphNodes: GraphNode[],
  graphEdges: GraphEdge[],
  model: CAModel,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const linked = (model.mappings ?? []).filter(
    m => m.isAttributeToColor && m.linked && m.linkedAttributeId,
  );
  if (linked.length === 0) return { nodes: graphNodes, edges: graphEdges }; // hot-path no-op

  const nodes = [...graphNodes];
  let edges = [...graphEdges];

  for (const m of linked) {
    // Resolve live by id; must be a CELL attribute (the color pass reads cell state).
    const attr = model.attributes.find(a => a.id === m.linkedAttributeId);
    if (!attr || attr.isModelAttribute) continue;

    const P = `${SYNTH_PREFIX}${m.id}_`;

    // 1. value chain: getCellAttribute → (colorScale | categoricalColor)
    const getAttrId = P + 'getattr';
    nodes.push(mkNode(getAttrId, 'getCellAttribute', { attributeId: attr.id }));

    const colorId = P + 'color';
    let colorInPort: string;
    if (attr.type === 'tag') {
      nodes.push(mkNode(colorId, 'categoricalColor', buildCategoricalConfig(m, attr)));
      colorInPort = 'index';
    } else {
      nodes.push(mkNode(colorId, 'colorScale', buildColorScaleConfig(m, attr)));
      colorInPort = 't';
    }
    edges.push(valEdge(P + 'e_av', getAttrId, 'value', colorId, colorInPort));

    // 2. terminal setColorViewer fed by r/g/b
    const scvId = P + 'scv';
    nodes.push(mkNode(scvId, 'setColorViewer', { mappingId: m.id }));
    edges.push(valEdge(P + 'e_r', colorId, 'r', scvId, 'r'));
    edges.push(valEdge(P + 'e_g', colorId, 'g', scvId, 'g'));
    edges.push(valEdge(P + 'e_b', colorId, 'b', scvId, 'b'));

    // 3. sequencing — attach to the FIRST user OutputMapping node for this id.
    const userRoot = nodes.find(
      n => n.data.nodeType === 'outputMapping' && n.data.config.mappingId === m.id,
    );
    const doSrc = handleId({ id: 'do', kind: 'output', category: 'flow' });

    if (!userRoot) {
      // No user node → synthesize the root and run only the auto pass.
      const rootId = P + 'root';
      nodes.push(mkNode(rootId, 'outputMapping', { mappingId: m.id }));
      edges.push(flowEdge(P + 'e_root', rootId, 'do', scvId, 'do'));
    } else {
      const userEdge = edges.find(e => e.source === userRoot.id && e.sourceHandle === doSrc);
      if (!userEdge) {
        // User node with no downstream → just run the auto pass after it.
        edges.push(flowEdge(P + 'e_root', userRoot.id, 'do', scvId, 'do'));
      } else {
        // Insert a Sequence: first = auto background, then = user's original graph.
        const seqId = P + 'seq';
        nodes.push(mkNode(seqId, 'sequence', { extraCount: 0 }));
        edges = edges.filter(e => e !== userEdge); // re-point immutably (no mutation)
        edges.push(flowEdge(P + 'e_seq_in', userRoot.id, 'do', seqId, 'do'));
        edges.push(flowEdge(P + 'e_seq_first', seqId, 'first', scvId, 'do'));
        edges.push({
          id: P + 'e_seq_then',
          source: seqId,
          target: userEdge.target,
          sourceHandle: handleId({ id: 'then', kind: 'output', category: 'flow' }),
          targetHandle: userEdge.targetHandle, // preserve the user's original target handle
        });
      }
    }
  }

  return { nodes, edges };
}

// --- synthetic node/edge builders -----------------------------------------

function mkNode(id: string, nodeType: string, config: Config): GraphNode {
  return { id, type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType, config } };
}

function valEdge(id: string, source: string, sPort: string, target: string, tPort: string): GraphEdge {
  return {
    id, source, target,
    sourceHandle: handleId({ id: sPort, kind: 'output', category: 'value' }),
    targetHandle: handleId({ id: tPort, kind: 'input', category: 'value' }),
  };
}

function flowEdge(id: string, source: string, sPort: string, target: string, tPort: string): GraphEdge {
  return {
    id, source, target,
    sourceHandle: handleId({ id: sPort, kind: 'output', category: 'flow' }),
    targetHandle: handleId({ id: tPort, kind: 'input', category: 'flow' }),
  };
}

// --- palette / config generation ------------------------------------------

/** ColorScale config for bool / float / integer. The stored stop positions are
 *  in [0,1]; here they are mapped onto the value domain ([0,1] for bool, the
 *  user min/max for float/integer) and the raw attribute value is fed as `t`. */
function buildColorScaleConfig(m: Mapping, attr: Attribute): Config {
  const stops = buildGradientStops(m, attr);
  const { min, max } = attr.type === 'bool' ? { min: 0, max: 1 } : gradientDomain(m, attr);
  const span = max - min;
  const config: Config = { method: (m.linkedColors?.method as string) || 'linear', stopCount: stops.length };
  stops.forEach((s, i) => {
    config[`stop_${i}_position`] = String(min + s.position * span);
    config[`stop_${i}_r`] = String(s.r | 0);
    config[`stop_${i}_g`] = String(s.g | 0);
    config[`stop_${i}_b`] = String(s.b | 0);
  });
  return config;
}

/** CategoricalColor config for tag — one entry per LIVE tag option. */
function buildCategoricalConfig(m: Mapping, attr: Attribute): Config {
  const colors = buildTagColors(m, attr);
  const config: Config = { count: colors.length, default_r: '128', default_g: '128', default_b: '128' };
  colors.forEach((c, i) => {
    config[`entry_${i}_r`] = String(c.r | 0);
    config[`entry_${i}_g`] = String(c.g | 0);
    config[`entry_${i}_b`] = String(c.b | 0);
  });
  return config;
}

/** Default gradient stops for a non-tag attribute type. Exported so the Mappings
 *  panel shows the same scale the compiler would generate before any override. */
export function defaultGradientStops(attrType: Attribute['type']): ColorStop[] {
  if (attrType === 'bool') {
    return [{ position: 0, r: 0, g: 0, b: 0 }, { position: 1, r: 255, g: 255, b: 255 }]; // false→black, true→white
  }
  if (attrType === 'integer') return presetStops('Rainbow');
  return presetStops('Viridis'); // float
}

function buildGradientStops(m: Mapping, attr: Attribute): ColorStop[] {
  const override = m.linkedColors?.gradient;
  if (override && override.length >= 2) {
    return attr.type === 'bool' ? [override[0]!, override[1]!] : override;
  }
  return defaultGradientStops(attr.type);
}

/** One color per current tag option; clamps to the LIVE tagOptions length so a
 *  stale override array (too long / too short) can't desync. */
function buildTagColors(m: Mapping, attr: Attribute): RGB[] {
  const n = attr.tagOptions?.length ?? 0;
  const override = m.linkedColors?.tag ?? [];
  const out: RGB[] = [];
  for (let i = 0; i < n; i++) out.push(override[i] ?? defaultTagColor(i, n));
  return out;
}

function gradientDomain(m: Mapping, attr: Attribute): { min: number; max: number } {
  const min = m.linkedMin ?? attr.min ?? 0;
  let max = m.linkedMax ?? attr.max ?? (attr.type === 'integer' ? 10 : 1);
  if (!(max > min)) max = min + 1; // avoid a degenerate zero-span ColorScale
  return { min, max };
}

// --- color helpers ---------------------------------------------------------

function hsvToRgb(h: number, s: number, v: number): RGB {
  const c = v * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0, g1 = 0, b1 = 0;
  if (hp < 1) { r1 = c; g1 = x; }
  else if (hp < 2) { r1 = x; g1 = c; }
  else if (hp < 3) { g1 = c; b1 = x; }
  else if (hp < 4) { g1 = x; b1 = c; }
  else if (hp < 5) { r1 = x; b1 = c; }
  else { r1 = c; b1 = x; }
  const mm = v - c;
  return {
    r: Math.round((r1 + mm) * 255),
    g: Math.round((g1 + mm) * 255),
    b: Math.round((b1 + mm) * 255),
  };
}

/** Distinct categorical color for option i of n (hue evenly spread on the wheel).
 *  Exported so ModelContext's tagOptions cascade fills new options with the same
 *  default the transform would generate. */
export function defaultTagColor(i: number, n: number): RGB {
  return hsvToRgb((i / Math.max(1, n)) * 360, 0.65, 0.95);
}
