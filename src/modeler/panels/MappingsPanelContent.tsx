import { useEffect, useRef } from 'react';
import { useDetailSelection, type PanelContentProps } from '../ModelerDetailContext';
import { useModel } from '../../model/ModelContext';
import { useListReorder } from './useListReorder';
import { MODEL_ELEMENT_DRAG_MIME } from '../vpl/modelElementDrag';
import type { ModelElementDragPayload } from '../vpl/modelElementDrag';
import { setCurrentModelElementDrag } from '../vpl/graphState';
import { defaultGradientStops, defaultTagColor } from '../vpl/compiler/linkedOutputMappings';
import { GradientStopsEditor, type GradStop } from '../vpl/widgets/GradientStopsEditor';
import { INTERPOLATION_METHODS } from '../vpl/nodes/interpolationMethods';
import type { Mapping, RGB, ColorStop, Attribute } from '../../model/types';
import { typeDisplayName } from '../../model/typeLabels';
import { NumberField } from '../vpl/widgets/InlineWidgets';
import styles from './PanelContent.module.css';

function rgbToHex(c: RGB): string {
  const h = (n: number) => Math.max(0, Math.min(255, n | 0)).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}
function hexToRgb(hex: string): RGB {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return { r: 0, g: 0, b: 0 };
  return { r: parseInt(m[1]!, 16), g: parseInt(m[2]!, 16), b: parseInt(m[3]!, 16) };
}

const SPRITE_MAX_BYTES = 4 * 1024 * 1024;
const SPRITE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';
const genSpriteId = () => 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

function ColorSwatch({ value, onChange }: { value: RGB; onChange: (c: RGB) => void }) {
  return (
    <input
      type="color"
      value={rgbToHex(value)}
      onChange={e => onChange(hexToRgb(e.target.value))}
      style={{ width: 34, height: 22, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
    />
  );
}

/** Linked-mode editor for an Attribute→Color mapping: attribute picker plus
 *  per-type palette controls (color pickers + min/max). */
function LinkedOutputEditor({ selected, attrs, update }: { selected: Mapping; attrs?: Attribute[]; update?: (id: string, changes: Partial<Mapping>) => void }) {
  const { model, updateMapping: cellUpdate } = useModel();
  // Defaults to the CELL attributes + updateMapping; the AGENT mappings pass the
  // agent attribute set + updateAgentMapping so the SAME editor serves both layers.
  const cellAttrs = attrs ?? model.attributes.filter(a => !a.isModelAttribute);
  const updateMapping = update ?? cellUpdate;
  const attr = cellAttrs.find(a => a.id === selected.linkedAttributeId);

  const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 };
  const lblStyle: React.CSSProperties = { fontSize: 12 };

  const setGradient = (next: ColorStop[]) =>
    updateMapping(selected.id, { linkedColors: { ...selected.linkedColors, gradient: next } });

  const handleAttrChange = (id: string) => {
    const a = cellAttrs.find(x => x.id === id);
    const changes: Partial<Mapping> = { linkedAttributeId: id, linkedColors: undefined };
    if (a && (a.type === 'float' || a.type === 'integer')) {
      changes.linkedMin = a.min ?? 0;
      changes.linkedMax = a.max ?? (a.type === 'integer' ? 10 : 1);
    } else {
      changes.linkedMin = undefined;
      changes.linkedMax = undefined;
    }
    updateMapping(selected.id, changes);
  };

  return (
    <>
      <div className={styles.field}>
        <label className={styles.fieldLabel}>Linked attribute</label>
        <select
          className={styles.textInput}
          value={selected.linkedAttributeId ?? ''}
          onChange={e => handleAttrChange(e.target.value)}
        >
          <option value="">Select attribute…</option>
          {cellAttrs.map(a => (
            <option key={a.id} value={a.id}>{a.name} ({typeDisplayName(a.type)})</option>
          ))}
        </select>
      </div>

      {attr && attr.type === 'bool' && (() => {
        const g = selected.linkedColors?.gradient ?? defaultGradientStops('bool');
        const c0: ColorStop = g[0] ?? { position: 0, r: 0, g: 0, b: 0 };
        const c1: ColorStop = g[1] ?? { position: 1, r: 255, g: 255, b: 255 };
        return (
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Colors</label>
            <div style={rowStyle}>
              <ColorSwatch value={c0} onChange={c => setGradient([{ position: 0, ...c }, c1])} />
              <span style={lblStyle}>False</span>
            </div>
            <div style={rowStyle}>
              <ColorSwatch value={c1} onChange={c => setGradient([c0, { position: 1, ...c }])} />
              <span style={lblStyle}>True</span>
            </div>
          </div>
        );
      })()}

      {attr && (attr.type === 'float' || attr.type === 'integer') && (() => {
        const g = selected.linkedColors?.gradient ?? defaultGradientStops(attr.type);
        const editorStops: GradStop[] = g.map(s => ({ p: s.position, r: s.r, g: s.g, b: s.b }));
        const onStops = (next: GradStop[]) =>
          setGradient(next.map(s => ({ position: s.p, r: s.r, g: s.g, b: s.b })));
        const min = selected.linkedMin ?? attr.min ?? 0;
        const max = selected.linkedMax ?? attr.max ?? (attr.type === 'integer' ? 10 : 1);
        return (
          <>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Range (maps to the scale&apos;s 0 → 1)</label>
              <div style={rowStyle}>
                <NumberField className={styles.textInput}
                  style={{ width: 80 }} value={min}
                  onNumber={n => updateMapping(selected.id, { linkedMin: n })} />
                <span style={lblStyle}>min</span>
                <NumberField className={styles.textInput}
                  style={{ width: 80 }} value={max}
                  onNumber={n => updateMapping(selected.id, { linkedMax: n })} />
                <span style={lblStyle}>max</span>
              </div>
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Color scale</label>
              <GradientStopsEditor stops={editorStops} onChange={onStops} />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Curve</label>
              <select
                className={styles.textInput}
                value={(selected.linkedColors?.method as string) || 'linear'}
                onChange={e => updateMapping(selected.id, { linkedColors: { ...selected.linkedColors, method: e.target.value } })}
              >
                {INTERPOLATION_METHODS.map(m => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>
          </>
        );
      })()}

      {attr && attr.type === 'tag' && (() => {
        const opts = attr.tagOptions ?? [];
        const colorAt = (i: number) => selected.linkedColors?.tag?.[i] ?? defaultTagColor(i, opts.length);
        const setTagAt = (i: number, c: RGB) => {
          const arr = opts.map((_, j) => (j === i ? c : colorAt(j)));
          updateMapping(selected.id, { linkedColors: { ...selected.linkedColors, tag: arr } });
        };
        return (
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Tag colors</label>
            {opts.map((opt, i) => (
              <div key={i} style={rowStyle}>
                <ColorSwatch value={colorAt(i)} onChange={c => setTagAt(i, c)} />
                <span style={lblStyle}>{opt}</span>
              </div>
            ))}
            {opts.length === 0 && <span style={lblStyle}>This tag attribute has no options.</span>}
          </div>
        );
      })()}
    </>
  );
}

function handleMappingDragStart(mappingId: string, isAttributeToColor: boolean) {
  return (e: React.DragEvent) => {
    const payload: ModelElementDragPayload = isAttributeToColor
      ? { kind: 'mapping-a2c', mappingId }
      : { kind: 'mapping-c2a', mappingId };
    e.dataTransfer.setData(MODEL_ELEMENT_DRAG_MIME, JSON.stringify(payload));
    e.dataTransfer.effectAllowed = 'copy';
    setCurrentModelElementDrag(payload);
  };
}

function handleMappingDragEnd() {
  setCurrentModelElementDrag(null);
}

export function MappingsPanelContent({ mode = 'list' }: PanelContentProps = {}) {
  const { model, addMapping, removeMapping, updateMapping, reorderMappings, addAgentMapping, removeAgentMapping, updateAgentMapping, addSprite, removeSprite, updateSprite } = useModel();
  const [selectedId, setSelectedId] = useDetailSelection('mappings');
  const agentsOn = !!model.topologyMode?.agents;
  const agentMappings = model.agentMappings ?? [];
  const agentAttrs = (model.agentAttributes ?? []).filter(a => a.type !== 'color' && a.type !== 'lookupTable');
  const sprites = model.sprites ?? [];
  const spriteInputRef = useRef<HTMLInputElement>(null);
  const handleSpritePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file) return;
    if (file.size > SPRITE_MAX_BYTES) {
      window.alert(`Sprite "${file.name}" is ${(file.size / 1048576).toFixed(1)} MB — the limit is 4 MB. Use a smaller image / GIF.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      if (typeof dataUrl !== 'string') return;
      const baseName = file.name.replace(/\.[^.]+$/, '') || 'sprite';
      addSprite({ id: genSpriteId(), name: baseName, dataUrl, mimeType: file.type || 'image/png', scale: 1, loop: true });
    };
    reader.readAsDataURL(file);
  };

  const attrToColor = model.mappings.filter(m => m.isAttributeToColor);
  const colorToAttr = model.mappings.filter(m => !m.isAttributeToColor);

  // Independent reorder within each group — the other group is appended in its existing order.
  const acReorder = useListReorder(attrToColor, newOrder => {
    const map = new Map(attrToColor.map(m => [m.id, m]));
    reorderMappings([...newOrder.map(id => map.get(id)!).filter(Boolean), ...colorToAttr].map(m => m.id));
  });
  const caReorder = useListReorder(colorToAttr, newOrder => {
    const map = new Map(colorToAttr.map(m => [m.id, m]));
    reorderMappings([...attrToColor, ...newOrder.map(id => map.get(id)!).filter(Boolean)].map(m => m.id));
  });

  // Auto-select & scroll to newly added mappings
  const prevCount = useRef(model.mappings.length);
  useEffect(() => {
    if (model.mappings.length > prevCount.current) {
      const newItem = model.mappings[model.mappings.length - 1];
      if (newItem) {
        setSelectedId(newItem.id);
        setTimeout(() => {
          document.getElementById(`mapping-${newItem.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 50);
      }
    }
    prevCount.current = model.mappings.length;
  }, [model.mappings]);
  const selected = model.mappings.find(m => m.id === selectedId);

  const handleDelete = () => {
    if (selectedId) {
      removeMapping(selectedId);
      setSelectedId(null);
    }
  };

  return (
    <>
      {mode !== 'detail' && (<>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>
          Attribute &rarr; Color (Output)
        </div>
        <div className={styles.list} data-reorder-list>
          {attrToColor.map((m, i) => {
            const isDragging = acReorder.dragState?.id === m.id;
            const srcIdx = acReorder.dragState ? attrToColor.findIndex(x => x.id === acReorder.dragState!.id) : -1;
            const showBefore = acReorder.dragState?.overIdx === i && srcIdx !== i && srcIdx !== i - 1;
            const showAfter = acReorder.dragState?.overIdx === attrToColor.length && i === attrToColor.length - 1 && srcIdx !== i;
            return (
              <div
                key={m.id}
                id={`mapping-${m.id}`}
                data-reorder-row
                className={`${styles.listItem} ${selectedId === m.id ? styles.listItemSelected : ''} ${isDragging ? styles.draggingRow : ''} ${showBefore ? styles.dropIndicatorBefore : ''} ${showAfter ? styles.dropIndicatorAfter : ''}`}
                onClick={() => setSelectedId(m.id)}
                draggable
                onDragStart={handleMappingDragStart(m.id, true)}
                onDragEnd={handleMappingDragEnd}
                title={`Drag to canvas to add a node that uses '${m.name}'`}
              >
                <span className={styles.listItemName}>{m.name}</span>
                <span className={styles.listItemBadge}>A&rarr;C</span>
                <button className={styles.dragHandle} title="Drag to reorder"
                  onPointerDown={acReorder.startDrag(m.id)}
                  onClick={e => e.stopPropagation()}>⋮⋮</button>
              </div>
            );
          })}
        </div>
        <div className={styles.buttonRow}>
          <button
            className={styles.addButton}
            onClick={() => addMapping(true)}
          >
            + Add A&rarr;C Mapping
          </button>
          <button className={styles.deleteButton} onClick={handleDelete}>
            Delete
          </button>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>
          Color &rarr; Attribute (Input)
        </div>
        <div className={styles.list} data-reorder-list>
          {colorToAttr.map((m, i) => {
            const isDragging = caReorder.dragState?.id === m.id;
            const srcIdx = caReorder.dragState ? colorToAttr.findIndex(x => x.id === caReorder.dragState!.id) : -1;
            const showBefore = caReorder.dragState?.overIdx === i && srcIdx !== i && srcIdx !== i - 1;
            const showAfter = caReorder.dragState?.overIdx === colorToAttr.length && i === colorToAttr.length - 1 && srcIdx !== i;
            return (
              <div
                key={m.id}
                id={`mapping-${m.id}`}
                data-reorder-row
                className={`${styles.listItem} ${selectedId === m.id ? styles.listItemSelected : ''} ${isDragging ? styles.draggingRow : ''} ${showBefore ? styles.dropIndicatorBefore : ''} ${showAfter ? styles.dropIndicatorAfter : ''}`}
                onClick={() => setSelectedId(m.id)}
                draggable
                onDragStart={handleMappingDragStart(m.id, false)}
                onDragEnd={handleMappingDragEnd}
                title={`Drag to canvas to add a node that uses '${m.name}'`}
              >
                <span className={styles.listItemName}>{m.name}</span>
                <span className={styles.listItemBadge}>C&rarr;A</span>
                <button className={styles.dragHandle} title="Drag to reorder"
                  onPointerDown={caReorder.startDrag(m.id)}
                  onClick={e => e.stopPropagation()}>⋮⋮</button>
              </div>
            );
          })}
        </div>
        <div className={styles.buttonRow}>
          <button
            className={styles.addButton}
            onClick={() => addMapping(false)}
          >
            + Add C&rarr;A Mapping
          </button>
          <button className={styles.deleteButton} onClick={handleDelete}>
            Delete
          </button>
        </div>
      </div>

      {/* Agent Output Mappings — the agent-layer A→C views (the two-layer viewer).
          Inline-edited (pick an agent attribute → colour) so the user defines an
          agent VIEW instead of hand-wiring Set Cell Looks in the Behaviour Step. */}
      {agentsOn && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Agent Output Mappings (A&rarr;C)</div>
          <span style={{ color: '#888', fontSize: '0.66rem', display: 'block', margin: '0 0 6px' }}>
            Each is a colour view of the agents, picking an agent attribute → colour.
            Switch between them in the simulator&apos;s viewer bar (Agents row).
          </span>
          {agentMappings.length === 0 && (
            <span style={{ color: '#888', fontSize: '0.68rem', fontStyle: 'italic' }}>No agent views yet.</span>
          )}
          {agentMappings.map(m => (
            <div key={m.id} id={`mapping-${m.id}`} className={styles.fieldGroup} style={{ borderTop: '1px solid #333', paddingTop: 8, marginTop: 6 }}>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Name</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    className={styles.textInput}
                    style={{ flex: 1 }}
                    value={m.name}
                    onChange={e => updateAgentMapping(m.id, { name: e.target.value })}
                  />
                  <button
                    className={styles.deleteButton}
                    style={{ padding: '2px 8px' }}
                    onClick={() => removeAgentMapping(m.id)}
                    title="Remove agent view"
                  >&times;</button>
                </div>
              </div>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Description</label>
                <textarea
                  className={styles.textArea}
                  rows={2}
                  value={m.description}
                  onChange={e => updateAgentMapping(m.id, { description: e.target.value })}
                />
              </div>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Color pass</label>
                <select
                  className={styles.textInput}
                  value={m.linked === false ? 'standalone' : 'linked'}
                  onChange={e => updateAgentMapping(m.id, { linked: e.target.value === 'linked' })}
                >
                  <option value="standalone">Standalone</option>
                  <option value="linked">Linked</option>
                </select>
                <span style={{ color: '#888', fontSize: '0.66rem', marginTop: 3, display: 'block' }}>
                  {m.linked === false
                    ? 'You build this view by hand on the Agents graph (Agent Output Mapping → … → Set Cell Looks / Set Agent Sprite).'
                    : 'Auto-generates the colour from a chosen agent attribute. If you also add an Agent Output Mapping node for this view, the auto pass runs first as a background and your graph overrides it (special colours, sprites).'}
                </span>
              </div>
              {m.linked !== false && (
                <LinkedOutputEditor selected={{ ...m, linked: true }} attrs={agentAttrs} update={updateAgentMapping} />
              )}
            </div>
          ))}
          <div className={styles.buttonRow}>
            <button
              className={styles.addButton}
              onClick={() => addAgentMapping()}
              title={agentAttrs.length === 0 ? 'No agent attributes yet — the new view is seeded Standalone (build it on the Agents graph).' : undefined}
            >
              + Add Agent View
            </button>
          </div>
        </div>
      )}

      {/* Sprite Library — imported images / animated GIFs used as the optional
          agent exhibition layer (Set Agent Sprite node in an Agent Output Mapping
          graph). Agents-only. Each sprite travels inside the .gcaproj as a data URL. */}
      {agentsOn && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Sprites</div>
          <span style={{ color: '#888', fontSize: '0.66rem', display: 'block', margin: '0 0 6px' }}>
            Images / animated GIFs an agent can be drawn as (via the <b>Set Agent Sprite</b> node in an
            Agent Output Mapping graph). Playback (which sprite, frame, speed) is driven by the agent&apos;s
            logic through that node — not a manual transport.
          </span>
          {sprites.length === 0 && (
            <span style={{ color: '#888', fontSize: '0.68rem', fontStyle: 'italic' }}>No sprites yet.</span>
          )}
          {sprites.map(s => (
            <div key={s.id} className={styles.fieldGroup} style={{ borderTop: '1px solid #333', paddingTop: 8, marginTop: 6 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <img
                  src={s.dataUrl}
                  alt={s.name}
                  style={{ width: 40, height: 40, objectFit: 'contain', background: '#0a0b0e', borderRadius: 4, imageRendering: 'pixelated', flex: '0 0 auto' }}
                />
                <input
                  className={styles.textInput}
                  style={{ flex: 1 }}
                  value={s.name}
                  onChange={e => updateSprite(s.id, { name: e.target.value })}
                />
                <button
                  className={styles.deleteButton}
                  style={{ padding: '2px 8px' }}
                  onClick={() => removeSprite(s.id)}
                  title="Remove sprite"
                >&times;</button>
              </div>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Size × (relative to agent diameter)</label>
                <NumberField className={styles.textInput} style={{ width: 80 }} value={s.scale ?? 1} step={0.1} min={0.1}
                  onNumber={n => updateSprite(s.id, { scale: n })} />
              </div>
              <label
                style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', marginTop: 4 }}
                title="When the playback frame runs past the last frame: Loop wraps to the start; unticked holds on the last frame (play once)."
              >
                <input type="checkbox" checked={s.loop !== false}
                  onChange={e => updateSprite(s.id, { loop: e.target.checked })} />
                Loop frames
              </label>
            </div>
          ))}
          <input
            ref={spriteInputRef}
            type="file"
            accept={SPRITE_ACCEPT}
            style={{ display: 'none' }}
            onChange={handleSpritePick}
          />
          <div className={styles.buttonRow}>
            <button className={styles.addButton} onClick={() => spriteInputRef.current?.click()}>
              + Import image / GIF
            </button>
          </div>
        </div>
      )}

      </>)}

      {mode === 'detail' && selected && (
        <div className={styles.detailEditor}>
          <div className={styles.detailTitle}>Edit: {selected.name}</div>
          <div className={styles.fieldGroup}>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Name</label>
              <input
                className={styles.textInput}
                value={selected.name}
                onChange={e =>
                  updateMapping(selected.id, { name: e.target.value })
                }
              />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Description</label>
              <textarea
                className={styles.textArea}
                rows={2}
                value={selected.description}
                onChange={e =>
                  updateMapping(selected.id, { description: e.target.value })
                }
              />
            </div>
            {selected.isAttributeToColor && (
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Color pass</label>
                <select
                  className={styles.textInput}
                  value={selected.linked ? 'linked' : 'standalone'}
                  onChange={e => updateMapping(selected.id, { linked: e.target.value === 'linked' })}
                >
                  <option value="standalone">Standalone</option>
                  <option value="linked">Linked</option>
                </select>
                <span style={{ color: '#888', fontSize: '0.66rem', marginTop: 3, display: 'block' }}>
                  {selected.linked
                    ? 'Auto-generates the color pass from a chosen attribute. If you also add an Output Mapping node for this mapping, the auto pass runs first as a background and your graph overrides the cells it paints.'
                    : 'You build the color pass by hand in the graph (Output Mapping → … → Set Cell Looks).'}
                </span>
              </div>
            )}
            {selected.isAttributeToColor && selected.linked && (
              <LinkedOutputEditor selected={selected} />
            )}
            <div className={styles.field}>
              <span
                className={`${styles.colorLabel} ${styles.colorLabelRed}`}
              >
                Red Channel
              </span>
              <textarea
                className={styles.textArea}
                rows={2}
                value={selected.redDescription}
                onChange={e =>
                  updateMapping(selected.id, {
                    redDescription: e.target.value,
                  })
                }
              />
            </div>
            <div className={styles.field}>
              <span
                className={`${styles.colorLabel} ${styles.colorLabelGreen}`}
              >
                Green Channel
              </span>
              <textarea
                className={styles.textArea}
                rows={2}
                value={selected.greenDescription}
                onChange={e =>
                  updateMapping(selected.id, {
                    greenDescription: e.target.value,
                  })
                }
              />
            </div>
            <div className={styles.field}>
              <span
                className={`${styles.colorLabel} ${styles.colorLabelBlue}`}
              >
                Blue Channel
              </span>
              <textarea
                className={styles.textArea}
                rows={2}
                value={selected.blueDescription}
                onChange={e =>
                  updateMapping(selected.id, {
                    blueDescription: e.target.value,
                  })
                }
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
