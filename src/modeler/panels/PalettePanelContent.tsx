import { useEffect, useMemo, useState } from 'react';
import { useModel } from '../../model/ModelContext';
import { getNodeDefsByCategory } from '../vpl/nodes/registry';
import type { NodeTypeDef } from '../vpl/types';
import type { GraphNode } from '../../model/types';
import styles from './PalettePanelContent.module.css';

interface DefaultMacroEntry {
  key: string;
  name: string;
  description: string;
  file: string;
}

const CATEGORY_ORDER: NodeTypeDef['category'][] = [
  'event',
  'flow',
  'data',
  'logic',
  'aggregation',
  'output',
  'color',
];

const CATEGORY_LABELS: Record<NodeTypeDef['category'], string> = {
  event: 'Events',
  flow: 'Flow Control',
  data: 'Data',
  logic: 'Logic & Math',
  aggregation: 'Aggregation',
  output: 'Output',
  color: 'Color',
};

type PaletteDragPayload =
  | { kind: 'node'; nodeType: string }
  | { kind: 'macro-default'; macroKey: string; file: string }
  | { kind: 'macro-project'; macroDefId: string };

export const PALETTE_DRAG_MIME = 'application/genesisca-palette';

/** Serialize a drag payload on `dataTransfer` for the GraphEditor drop handler. */
function startDrag(e: React.DragEvent, payload: PaletteDragPayload): void {
  e.dataTransfer.setData(PALETTE_DRAG_MIME, JSON.stringify(payload));
  e.dataTransfer.effectAllowed = 'copy';
}

export function PalettePanelContent() {
  const { model } = useModel();
  const [search, setSearch] = useState('');
  const [defaultMacros, setDefaultMacros] = useState<DefaultMacroEntry[]>([]);
  const [sectionsCollapsed, setSectionsCollapsed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    const base = (import.meta.env.BASE_URL || '/');
    fetch(`${base}macros/index.json`)
      .then(r => (r.ok ? r.json() : []))
      .then(entries => {
        if (!cancelled && Array.isArray(entries)) setDefaultMacros(entries);
      })
      .catch(() => { /* no default macros — section will just be empty */ });
    return () => { cancelled = true; };
  }, []);

  const byCategory = useMemo(() => getNodeDefsByCategory(), []);

  const q = search.trim().toLowerCase();
  const matches = (hay: string | undefined): boolean => {
    if (!q) return true;
    return !!hay && hay.toLowerCase().includes(q);
  };
  const itemMatches = (name: string, description?: string) => matches(name) || matches(description);

  const toggleSection = (id: string) =>
    setSectionsCollapsed(prev => ({ ...prev, [id]: !prev[id] }));

  // Node sections by category
  const nodeSections = CATEGORY_ORDER.map(cat => {
    const defs = (byCategory.get(cat) || []).filter(d => itemMatches(d.label, d.description));
    return { cat, defs };
  }).filter(s => s.defs.length > 0);

  const defaultMacroMatches = defaultMacros.filter(m => itemMatches(m.name, m.description));

  // Only show Project Macros that are actually instantiated somewhere — either at the top level
  // or inside another macro's subgraph. Stale MacroDefs (left over after their last instance was
  // deleted) should not clutter the palette.
  const usedMacroIds = useMemo(() => {
    const ids = new Set<string>();
    const collect = (nodes: GraphNode[]) => {
      for (const n of nodes) {
        if (n.data?.nodeType !== 'macro') continue;
        const cfg = n.data.config as Record<string, unknown> | undefined;
        const id = cfg?.macroDefId;
        if (typeof id === 'string' && id.length > 0) ids.add(id);
      }
    };
    collect(model.graphNodes);
    for (const md of (model.macroDefs || [])) collect(md.nodes);
    return ids;
  }, [model.graphNodes, model.macroDefs]);

  const projectMacros = (model.macroDefs || [])
    .filter(m => usedMacroIds.has(m.id))
    .filter(m => itemMatches(m.name));

  const nothingFound =
    nodeSections.length === 0 && defaultMacroMatches.length === 0 && projectMacros.length === 0;

  return (
    <div className={styles.palette}>
      <input
        className={styles.search}
        type="text"
        placeholder="Search nodes & macros..."
        value={search}
        onChange={e => setSearch(e.target.value)}
      />
      <div className={styles.hint}>Drag onto the canvas to add.</div>
      <div className={styles.list}>
        {/* Nodes */}
        <div className={styles.section}>
          <button className={styles.sectionHeader} onClick={() => toggleSection('nodes')}>
            <span className={`${styles.sectionChevron} ${sectionsCollapsed['nodes'] ? styles.sectionChevronCollapsed : ''}`}>▼</span>
            Nodes
            <span className={styles.sectionCount}>{nodeSections.reduce((n, s) => n + s.defs.length, 0)}</span>
          </button>
          {!sectionsCollapsed['nodes'] && nodeSections.map(({ cat, defs }) => (
            <div key={cat}>
              <div className={styles.subSectionLabel}>{CATEGORY_LABELS[cat]}</div>
              {defs.map(def => (
                <div
                  key={def.type}
                  className={styles.item}
                  role="button"
                  tabIndex={0}
                  draggable
                  onDragStart={e => startDrag(e, { kind: 'node', nodeType: def.type })}
                  title={def.description || def.label}
                >
                  <span className={styles.itemDot} style={{ background: def.color }} />
                  <div className={styles.itemBody}>
                    <div className={styles.itemLabel}>{def.label}</div>
                    {def.description && (
                      <div className={styles.itemDescription}>{def.description}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ))}
          {nodeSections.length === 0 && <div className={styles.empty}>No nodes match</div>}
        </div>

        {/* Default Macros */}
        <div className={styles.section}>
          <button className={styles.sectionHeader} onClick={() => toggleSection('default-macros')}>
            <span className={`${styles.sectionChevron} ${sectionsCollapsed['default-macros'] ? styles.sectionChevronCollapsed : ''}`}>▼</span>
            Default Macros
            <span className={styles.sectionCount}>{defaultMacroMatches.length}</span>
          </button>
          {!sectionsCollapsed['default-macros'] && (
            <>
              {defaultMacroMatches.map(m => (
                <div
                  key={m.key}
                  className={styles.item}
                  role="button"
                  tabIndex={0}
                  draggable
                  onDragStart={e => startDrag(e, { kind: 'macro-default', macroKey: m.key, file: m.file })}
                  title={m.description || m.name}
                >
                  <span className={styles.itemDot} style={{ background: '#00897b' }} />
                  <div className={styles.itemBody}>
                    <div className={styles.itemLabel}>{m.name}</div>
                    {m.description && (
                      <div className={styles.itemDescription}>{m.description}</div>
                    )}
                  </div>
                </div>
              ))}
              {defaultMacroMatches.length === 0 && <div className={styles.empty}>No default macros{q ? ' match' : ''}</div>}
            </>
          )}
        </div>

        {/* Project Macros */}
        <div className={styles.section}>
          <button className={styles.sectionHeader} onClick={() => toggleSection('project-macros')}>
            <span className={`${styles.sectionChevron} ${sectionsCollapsed['project-macros'] ? styles.sectionChevronCollapsed : ''}`}>▼</span>
            Project Macros
            <span className={styles.sectionCount}>{projectMacros.length}</span>
          </button>
          {!sectionsCollapsed['project-macros'] && (
            <>
              {projectMacros.map(m => (
                <div
                  key={m.id}
                  className={styles.item}
                  role="button"
                  tabIndex={0}
                  draggable
                  onDragStart={e => startDrag(e, { kind: 'macro-project', macroDefId: m.id })}
                  title={m.name}
                >
                  <span className={styles.itemDot} style={{ background: '#00897b' }} />
                  <div className={styles.itemBody}>
                    <div className={styles.itemLabel}>{m.name}</div>
                  </div>
                </div>
              ))}
              {projectMacros.length === 0 && <div className={styles.empty}>No project macros{q ? ' match' : ''}</div>}
            </>
          )}
        </div>

        {nothingFound && q && <div className={styles.empty}>No results for "{search}"</div>}
      </div>
    </div>
  );
}
