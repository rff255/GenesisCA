import { useEffect, useMemo, useRef, useState } from 'react';
import { useModel } from '../../model/ModelContext';
import { getNodeDefsByCategory } from '../vpl/nodes/registry';
import { isNodeAvailable } from '../vpl/nodes/nodeValidation';
import type { NodeTypeDef } from '../vpl/types';
import type { GraphNode } from '../../model/types';
import { NodePreview, MacroPreview } from './NodePreview';
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

const SPLIT_LS_KEY = 'genesisca_palette_split';
const VIEW_LS_KEY = 'genesisca_palette_view';

/** Serialize a drag payload on `dataTransfer` for the GraphEditor drop handler. */
function startDrag(e: React.DragEvent, payload: PaletteDragPayload): void {
  e.dataTransfer.setData(PALETTE_DRAG_MIME, JSON.stringify(payload));
  e.dataTransfer.effectAllowed = 'copy';
}

function readSplitRatio(): number {
  const raw = localStorage.getItem(SPLIT_LS_KEY);
  if (!raw) return 0.62;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0.1 || n > 0.9) return 0.62;
  return n;
}

function readViewMode(): 'list' | 'visual' {
  return localStorage.getItem(VIEW_LS_KEY) === 'visual' ? 'visual' : 'list';
}

export function PalettePanelContent() {
  const { model } = useModel();
  const [search, setSearch] = useState('');
  const [defaultMacros, setDefaultMacros] = useState<DefaultMacroEntry[]>([]);
  const [splitRatio, setSplitRatio] = useState<number>(() => readSplitRatio());
  const [viewMode, setViewMode] = useState<'list' | 'visual'>(() => readViewMode());
  const containerRef = useRef<HTMLDivElement | null>(null);
  const splitDrag = useRef<{ startY: number; startRatio: number; height: number } | null>(null);
  const [draggingSplit, setDraggingSplit] = useState(false);

  // Persist split + view state.
  useEffect(() => {
    localStorage.setItem(SPLIT_LS_KEY, String(splitRatio));
  }, [splitRatio]);
  useEffect(() => {
    localStorage.setItem(VIEW_LS_KEY, viewMode);
  }, [viewMode]);

  // Document-level mousemove/mouseup for splitter drag.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = splitDrag.current;
      if (!drag) return;
      const delta = e.clientY - drag.startY;
      const newRatio = drag.startRatio + delta / drag.height;
      const clamped = Math.max(0.15, Math.min(0.85, newRatio));
      setSplitRatio(clamped);
    };
    const onUp = () => {
      if (splitDrag.current) {
        splitDrag.current = null;
        setDraggingSplit(false);
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const onSplitterMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    splitDrag.current = {
      startY: e.clientY,
      startRatio: splitRatio,
      height: Math.max(rect.height, 100),
    };
    setDraggingSplit(true);
    e.preventDefault();
  };

  // Fetch default macros once.
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

  // Node sections by category — hide nodes whose capability requirements
  // (requirements.async / requirements.variegated) the current model doesn't
  // satisfy, so users don't drag in nodes that won't work.
  const nodeSections = CATEGORY_ORDER.map(cat => {
    const defs = (byCategory.get(cat) || [])
      .filter(d => isNodeAvailable(d, model))
      .filter(d => itemMatches(d.label, d.description));
    return { cat, defs };
  }).filter(s => s.defs.length > 0);
  const totalNodeMatches = nodeSections.reduce((n, s) => n + s.defs.length, 0);

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

  const totalMacroMatches = defaultMacroMatches.length + projectMacros.length;
  const nothingFound = totalNodeMatches === 0 && totalMacroMatches === 0;

  const topFlex = splitRatio;
  const bottomFlex = 1 - splitRatio;

  // ─── Renderers ──────────────────────────────────────────────────────────

  const renderNodeItem = (def: NodeTypeDef) => {
    const onDragStart = (e: React.DragEvent) => startDrag(e, { kind: 'node', nodeType: def.type });
    if (viewMode === 'visual') {
      return (
        <NodePreview key={def.type} def={def} onDragStart={onDragStart} />
      );
    }
    return (
      <div
        key={def.type}
        className={styles.item}
        role="button"
        tabIndex={0}
        draggable
        onDragStart={onDragStart}
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
    );
  };

  const renderDefaultMacroItem = (m: DefaultMacroEntry) => {
    const onDragStart = (e: React.DragEvent) =>
      startDrag(e, { kind: 'macro-default', macroKey: m.key, file: m.file });
    if (viewMode === 'visual') {
      return (
        <MacroPreview key={m.key} name={m.name} description={m.description} onDragStart={onDragStart} />
      );
    }
    return (
      <div
        key={m.key}
        className={styles.item}
        role="button"
        tabIndex={0}
        draggable
        onDragStart={onDragStart}
        title={m.description || m.name}
      >
        <span className={styles.itemDot} style={{ background: '#00897b' }} />
        <div className={styles.itemBody}>
          <div className={styles.itemLabel}>{m.name}</div>
          {m.description && <div className={styles.itemDescription}>{m.description}</div>}
        </div>
      </div>
    );
  };

  const renderProjectMacroItem = (m: { id: string; name: string }) => {
    const macroDef = (model.macroDefs || []).find(d => d.id === m.id);
    const onDragStart = (e: React.DragEvent) =>
      startDrag(e, { kind: 'macro-project', macroDefId: m.id });
    if (viewMode === 'visual') {
      return (
        <MacroPreview key={m.id} name={m.name} macroDef={macroDef} onDragStart={onDragStart} />
      );
    }
    return (
      <div
        key={m.id}
        className={styles.item}
        role="button"
        tabIndex={0}
        draggable
        onDragStart={onDragStart}
        title={m.name}
      >
        <span className={styles.itemDot} style={{ background: '#00897b' }} />
        <div className={styles.itemBody}>
          <div className={styles.itemLabel}>{m.name}</div>
        </div>
      </div>
    );
  };

  return (
    <div className={styles.palette}>
      <input
        className={styles.search}
        type="text"
        placeholder="Search nodes & macros..."
        value={search}
        onChange={e => setSearch(e.target.value)}
      />
      <div className={styles.headerRow}>
        <div className={styles.hint}>Drag onto the canvas to add.</div>
        <div className={styles.viewToggle} role="group" aria-label="Palette view mode">
          <button
            type="button"
            className={`${styles.viewToggleButton} ${viewMode === 'list' ? styles.viewToggleButtonActive : ''}`}
            onClick={() => setViewMode('list')}
            title="List view (compact)"
          >List</button>
          <button
            type="button"
            className={`${styles.viewToggleButton} ${viewMode === 'visual' ? styles.viewToggleButtonActive : ''}`}
            onClick={() => setViewMode('visual')}
            title="Visual view (mini node previews)"
          >Visual</button>
        </div>
      </div>

      <div className={styles.splitContainer} ref={containerRef}>
        {/* Top — Nodes */}
        <div
          className={styles.scrollSection}
          style={{ flex: `${topFlex} 1 0` }}
        >
          <div className={styles.scrollSectionHeader}>
            <span>Nodes</span>
            <span className={styles.sectionCount}>{totalNodeMatches}</span>
          </div>
          {viewMode === 'visual' ? (
            <>
              {nodeSections.map(({ cat, defs }) => (
                <div key={cat}>
                  <div className={styles.subSectionLabel}>{CATEGORY_LABELS[cat]}</div>
                  <div className={styles.previewGrid}>{defs.map(renderNodeItem)}</div>
                </div>
              ))}
              {nodeSections.length === 0 && <div className={styles.empty}>No nodes match</div>}
            </>
          ) : (
            <>
              {nodeSections.map(({ cat, defs }) => (
                <div key={cat}>
                  <div className={styles.subSectionLabel}>{CATEGORY_LABELS[cat]}</div>
                  {defs.map(renderNodeItem)}
                </div>
              ))}
              {nodeSections.length === 0 && <div className={styles.empty}>No nodes match</div>}
            </>
          )}
        </div>

        {/* Splitter */}
        <div
          className={`${styles.splitter} ${draggingSplit ? styles.splitterDragging : ''}`}
          onMouseDown={onSplitterMouseDown}
          role="separator"
          aria-orientation="horizontal"
          title="Drag to resize"
        />

        {/* Bottom — Macros (default + project) */}
        <div
          className={styles.scrollSection}
          style={{ flex: `${bottomFlex} 1 0` }}
        >
          <div className={styles.scrollSectionHeader}>
            <span>Macros</span>
            <span className={styles.sectionCount}>{totalMacroMatches}</span>
          </div>
          <div className={styles.subSectionLabel}>Default Macros</div>
          {viewMode === 'visual' ? (
            <div className={styles.previewGrid}>
              {defaultMacroMatches.map(renderDefaultMacroItem)}
            </div>
          ) : (
            defaultMacroMatches.map(renderDefaultMacroItem)
          )}
          {defaultMacroMatches.length === 0 && (
            <div className={styles.empty}>No default macros{q ? ' match' : ''}</div>
          )}

          <div className={styles.subSectionLabel}>Project Macros</div>
          {viewMode === 'visual' ? (
            <div className={styles.previewGrid}>
              {projectMacros.map(renderProjectMacroItem)}
            </div>
          ) : (
            projectMacros.map(renderProjectMacroItem)
          )}
          {projectMacros.length === 0 && (
            <div className={styles.empty}>No project macros{q ? ' match' : ''}</div>
          )}

          {nothingFound && q && <div className={styles.empty}>No results for "{search}"</div>}
        </div>
      </div>
    </div>
  );
}
