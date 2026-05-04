import { useRef, useState } from 'react';
import { useModel } from '../../model/ModelContext';
import type {
  BoundaryTreatment, UpdateMode, AsyncScheme,
  EndConditions, EndConditionOp, IndicatorEndCondition,
} from '../../model/types';
import { IndicatorsPanelSection } from './IndicatorsPanelSection';
import { useListReorder } from './useListReorder';
import styles from './PanelContent.module.css';

function newCondId(): string {
  return `ec_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const THUMBNAIL_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';

export function PropertiesPanelContent() {
  const { model, updateProperties, reorderEndConditions } = useModel();
  const { properties } = model;
  const [tagInput, setTagInput] = useState('');
  const [thumbError, setThumbError] = useState('');
  const thumbInputRef = useRef<HTMLInputElement | null>(null);
  const ecReorder = useListReorder(
    properties.endConditions?.indicatorConditions || [],
    reorderEndConditions,
  );

  const handleThumbnailPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file) return;
    if (file.size > THUMBNAIL_MAX_BYTES) {
      setThumbError(`File is ${(file.size / 1024 / 1024).toFixed(2)} MB — the limit is 2 MB.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') return;
      setThumbError('');
      updateProperties({ thumbnail: result });
    };
    reader.onerror = () => setThumbError('Could not read the file.');
    reader.readAsDataURL(file);
  };

  const ec = properties.endConditions;
  const ecEnabled = !!ec?.enabled;
  const updateEndConditions = (changes: Partial<EndConditions>) => {
    updateProperties({
      endConditions: {
        enabled: ecEnabled,
        maxGenerations: ec?.maxGenerations,
        indicatorConditions: ec?.indicatorConditions,
        ...changes,
      },
    });
  };
  const addIndicatorCondition = () => {
    const firstIndicator = (model.indicators || [])[0];
    if (!firstIndicator) return;
    // For linked-frequency indicators, seed a sensible default category so the
    // condition is immediately valid (not every user knows they need one).
    let category: string | undefined;
    let value = firstIndicator.defaultValue ?? '0';
    if (firstIndicator.kind === 'linked' && firstIndicator.linkedAggregation === 'frequency') {
      const linkedAttr = (model.attributes || []).find(a => a.id === firstIndicator.linkedAttributeId);
      if (linkedAttr?.type === 'bool') category = 'true';
      else if (linkedAttr?.type === 'tag') category = linkedAttr.tagOptions?.[0] ?? '';
      else if (linkedAttr?.type === 'integer') category = '0';
      // float: leave undefined — UI disables the row
      value = '0'; // frequency count
    }
    const cond: IndicatorEndCondition = {
      id: newCondId(),
      indicatorId: firstIndicator.id,
      op: '==',
      value,
      ...(category !== undefined ? { category } : {}),
    };
    updateEndConditions({ indicatorConditions: [...(ec?.indicatorConditions || []), cond] });
  };
  const updateIndicatorCondition = (id: string, changes: Partial<IndicatorEndCondition>) => {
    updateEndConditions({
      indicatorConditions: (ec?.indicatorConditions || []).map(c =>
        c.id === id ? { ...c, ...changes } : c,
      ),
    });
  };
  const removeIndicatorCondition = (id: string) => {
    updateEndConditions({
      indicatorConditions: (ec?.indicatorConditions || []).filter(c => c.id !== id),
    });
  };

  const addTag = () => {
    const tag = tagInput.trim().toLowerCase();
    if (!tag || (properties.tags || []).includes(tag)) return;
    updateProperties({ tags: [...(properties.tags || []), tag] });
    setTagInput('');
  };

  const removeTag = (tag: string) => {
    updateProperties({ tags: (properties.tags || []).filter(t => t !== tag) });
  };

  return (
    <div className={styles.fieldGroup}>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Presentation</div>
        <div className={styles.fieldGroup}>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Name</label>
            <input
              className={styles.textInput}
              value={properties.name}
              onChange={e => updateProperties({ name: e.target.value })}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Rule Author</label>
            <input
              className={styles.textInput}
              value={properties.author}
              onChange={e => updateProperties({ author: e.target.value })}
              placeholder="Originator of the CA rule"
            />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>GenesisCA Project Author</label>
            <input
              className={styles.textInput}
              value={properties.modelAuthor}
              onChange={e => updateProperties({ modelAuthor: e.target.value })}
              placeholder="Who built this GenesisCA project"
            />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Description</label>
            <textarea
              className={styles.textArea}
              rows={4}
              value={properties.description}
              onChange={e => updateProperties({ description: e.target.value })}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Thumbnail</label>
            <input
              ref={thumbInputRef}
              type="file"
              accept={THUMBNAIL_ACCEPT}
              onChange={handleThumbnailPick}
              style={{ display: 'none' }}
            />
            {properties.thumbnail ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
                <img
                  src={properties.thumbnail}
                  alt="Model thumbnail"
                  style={{
                    maxWidth: 200, maxHeight: 200, borderRadius: 4,
                    border: '1px solid #2d4059', background: '#0d1117',
                  }}
                />
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    className={styles.addButton}
                    style={{ flex: 'none', padding: '4px 10px', fontSize: '0.7rem' }}
                    onClick={() => thumbInputRef.current?.click()}
                  >
                    Replace
                  </button>
                  <button
                    className={styles.deleteButton}
                    style={{ padding: '4px 10px', fontSize: '0.7rem' }}
                    onClick={() => { setThumbError(''); updateProperties({ thumbnail: undefined }); }}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ) : (
              <button
                className={styles.addButton}
                style={{ flex: 'none', alignSelf: 'flex-start', padding: '4px 10px', fontSize: '0.72rem' }}
                onClick={() => thumbInputRef.current?.click()}
              >
                Choose Image/GIF…
              </button>
            )}
            <span style={{ color: '#8090a0', fontSize: '0.62rem' }}>
              PNG, JPEG, GIF, or WebP — up to 2 MB. Shown on hover in the Models Library.
            </span>
            {thumbError && (
              <span style={{ color: '#e05050', fontSize: '0.65rem' }}>{thumbError}</span>
            )}
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Tags</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
              {(properties.tags || []).map(tag => (
                <span
                  key={tag}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 3,
                    padding: '1px 8px', background: 'rgba(76,201,240,0.12)',
                    border: '1px solid rgba(76,201,240,0.25)', borderRadius: 10,
                    fontSize: '0.68rem', color: '#4cc9f0',
                  }}
                >
                  {tag}
                  <button
                    onClick={() => removeTag(tag)}
                    style={{
                      background: 'none', border: 'none', color: '#f44336',
                      cursor: 'pointer', fontSize: '0.7rem', padding: 0, lineHeight: 1,
                    }}
                  >
                    x
                  </button>
                </span>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              <input
                className={styles.textInput}
                style={{ flex: 1 }}
                placeholder="Add tag..."
                value={tagInput}
                onChange={e => setTagInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
              />
              <button className={styles.addButton} style={{ padding: '2px 8px' }} onClick={addTag}>+</button>
            </div>
          </div>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Structure</div>
        <div className={styles.fieldGroup}>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Boundary Treatment</label>
            <select
              className={styles.selectInput}
              value={properties.boundaryTreatment}
              onChange={e =>
                updateProperties({
                  boundaryTreatment: e.target.value as BoundaryTreatment,
                })
              }
            >
              <option value="torus">Torus</option>
              <option value="constant">Constant</option>
            </select>
          </div>
          <div className={styles.fieldRow}>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Grid Width</label>
              <input
                className={styles.numberInput}
                type="number"
                value={properties.gridWidth}
                min={1}
                onChange={e =>
                  updateProperties({ gridWidth: Number(e.target.value) || 1 })
                }
              />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Grid Height</label>
              <input
                className={styles.numberInput}
                type="number"
                value={properties.gridHeight}
                min={1}
                onChange={e =>
                  updateProperties({ gridHeight: Number(e.target.value) || 1 })
                }
              />
            </div>
          </div>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Execution</div>
        <div className={styles.fieldGroup}>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Update Mode</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2 }}>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 6, cursor: properties.useWebGPU ? 'not-allowed' : 'pointer', fontSize: '0.72rem', opacity: properties.useWebGPU ? 0.55 : 1 }}>
                <input
                  type="radio"
                  name="updateMode"
                  value="synchronous"
                  checked={properties.updateMode !== 'asynchronous'}
                  onChange={() => updateProperties({ updateMode: 'synchronous' as UpdateMode })}
                  style={{ marginTop: 2 }}
                />
                <span>
                  <strong>Synchronous</strong>
                  <br />
                  <span style={{ color: '#888', fontSize: '0.66rem' }}>
                    All cells read from the previous generation and write to the next simultaneously. Classic CA behavior.
                  </span>
                </span>
              </label>
              <label
                style={{ display: 'flex', alignItems: 'flex-start', gap: 6, cursor: properties.useWebGPU ? 'not-allowed' : 'pointer', fontSize: '0.72rem', opacity: properties.useWebGPU ? 0.55 : 1 }}
                title={properties.useWebGPU ? 'WebGPU target requires synchronous update mode (cells run in parallel on the GPU).' : undefined}
              >
                <input
                  type="radio"
                  name="updateMode"
                  value="asynchronous"
                  checked={properties.updateMode === 'asynchronous'}
                  disabled={!!properties.useWebGPU}
                  onChange={() => updateProperties({ updateMode: 'asynchronous' as UpdateMode })}
                  style={{ marginTop: 2 }}
                />
                <span>
                  <strong>Asynchronous</strong>
                  <br />
                  <span style={{ color: '#888', fontSize: '0.66rem' }}>
                    Cells update one at a time using a single buffer. Each cell sees previous updates within the same generation. Enables number-conserving models.
                  </span>
                </span>
              </label>
            </div>
          </div>
          {properties.updateMode === 'asynchronous' && !properties.useWebGPU && (
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Asynchronous Update Scheme</label>
              <select
                className={styles.selectInput}
                value={properties.asyncScheme || 'random-order'}
                onChange={e =>
                  updateProperties({ asyncScheme: e.target.value as AsyncScheme })
                }
              >
                <option value="random-order">Random Order</option>
                <option value="random-independent">Random Independent</option>
                <option value="cyclic">Cyclic</option>
              </select>
              <span style={{ color: '#888', fontSize: '0.62rem', marginTop: 2, display: 'block' }}>
                {(properties.asyncScheme || 'random-order') === 'random-order' &&
                  'All cells update once per generation in random order (Fisher-Yates shuffle).'}
                {properties.asyncScheme === 'random-independent' &&
                  'N random cell picks with replacement per generation. Some cells may update 0 or 2+ times.'}
                {properties.asyncScheme === 'cyclic' &&
                  'A fixed random order decided at initialization, reused every generation. Fastest option.'}
              </span>
            </div>
          )}

          <div style={{ marginTop: 14, borderTop: '1px solid #333', paddingTop: 10 }}>
            <label className={styles.fieldLabel} style={{ marginBottom: 4 }}>Compile Target</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2 }}>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 6, cursor: 'pointer', fontSize: '0.72rem' }}>
                <input
                  type="radio"
                  name="compileTarget"
                  checked={!properties.useWasm && !properties.useWebGPU}
                  onChange={() => updateProperties({ useWasm: false, useWebGPU: false })}
                  style={{ marginTop: 2 }}
                />
                <span>
                  <strong>JavaScript (default)</strong>
                  <br />
                  <span style={{ color: '#888', fontSize: '0.66rem' }}>
                    Graph compiled to a JS function. Always available, supports every node type and both update modes.
                  </span>
                </span>
              </label>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 6, cursor: 'pointer', fontSize: '0.72rem' }}>
                <input
                  type="radio"
                  name="compileTarget"
                  checked={!!properties.useWasm && !properties.useWebGPU}
                  onChange={() => updateProperties({ useWasm: true, useWebGPU: false })}
                  style={{ marginTop: 2 }}
                />
                <span>
                  <strong>WebAssembly (experimental)</strong>
                  <br />
                  <span style={{ color: '#888', fontSize: '0.66rem' }}>
                    Hand-compiled WASM module — typically several times faster than JS on dense neighborhoods. Falls back to JS automatically for node types whose WASM emit is not yet implemented.
                  </span>
                </span>
              </label>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 6, cursor: 'pointer', fontSize: '0.72rem' }}>
                <input
                  type="radio"
                  name="compileTarget"
                  checked={!!properties.useWebGPU}
                  onChange={() => updateProperties({ useWebGPU: true, useWasm: false, updateMode: 'synchronous' })}
                  style={{ marginTop: 2 }}
                />
                <span>
                  <strong>WebGPU (experimental, sync only)</strong>
                  <br />
                  <span style={{ color: '#888', fontSize: '0.66rem' }}>
                    WGSL compute shaders on the GPU — designed for very large grids and math-heavy per-cell work. Requires synchronous update mode. Browser must support WebGPU (Chrome 127+, Firefox 141+, Safari 17.4+).
                  </span>
                </span>
              </label>
            </div>
            <span style={{ color: '#888', fontSize: '0.62rem', marginTop: 6, display: 'block' }}>
              Targets are mutually exclusive. Switching restarts the simulator (grid state is lost).
            </span>
            {/* B4B — WebGPU stop-check interval. Greyed unless WebGPU is selected. */}
            <div
              className={styles.field}
              style={{ marginTop: 10, opacity: properties.useWebGPU ? 1 : 0.45 }}
              title={
                properties.useWebGPU
                  ? 'Check stop events every N generations. Higher = faster on WebGPU but may overshoot a stop event by up to N-1 generations. JS / WASM ignore this.'
                  : 'WebGPU only — enable WebGPU above to use this setting.'
              }
            >
              <label className={styles.fieldLabel}>WebGPU stop-check interval</label>
              <input
                className={styles.numberInput}
                type="number"
                min={1}
                step={1}
                disabled={!properties.useWebGPU}
                value={properties.webgpuStopCheckInterval ?? 1}
                onChange={e => {
                  const n = parseInt(e.target.value, 10);
                  const k = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
                  updateProperties({ webgpuStopCheckInterval: k });
                }}
              />
              <span style={{ color: '#888', fontSize: '0.62rem', marginTop: 2, display: 'block' }}>
                1 = exact (default). Higher values amortize the per-step GPU stall but a stop event may surface up to K-1 generations late.
              </span>
            </div>
          </div>

          {/* End Conditions — optional, collapsible */}
          <div style={{ marginTop: 14, borderTop: '1px solid #333', paddingTop: 10 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={ecEnabled}
                onChange={e => updateEndConditions({ enabled: e.target.checked })}
              />
              <span style={{ fontSize: '0.78rem' }}>End Conditions</span>
            </label>
            <span style={{ color: '#888', fontSize: '0.62rem', marginTop: 2, display: 'block' }}>
              When enabled, the simulator auto-pauses once any of these conditions are met
              (max generations reached, or any indicator rule matches).
            </span>
            {ecEnabled && (
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Max Generations</label>
                  <input
                    className={styles.numberInput}
                    type="number"
                    min={0}
                    placeholder="(no limit)"
                    value={ec?.maxGenerations ?? ''}
                    onChange={e => updateEndConditions({
                      maxGenerations: e.target.value === '' ? undefined : Math.max(0, Math.round(Number(e.target.value) || 0)),
                    })}
                  />
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Indicator Conditions</label>
                  {(model.indicators || []).length === 0 && (
                    <span style={{ color: '#888', fontSize: '0.68rem', fontStyle: 'italic' }}>
                      Define at least one indicator to add conditions.
                    </span>
                  )}
                  <div data-reorder-list>
                  {(ec?.indicatorConditions || []).map((cond, condIdx, condArr) => {
                    const ind = (model.indicators || []).find(i => i.id === cond.indicatorId);
                    const isFreq = ind?.kind === 'linked' && ind?.linkedAggregation === 'frequency';
                    const linkedAttr = isFreq
                      ? (model.attributes || []).find(a => a.id === ind.linkedAttributeId)
                      : undefined;
                    const freqKind = isFreq ? linkedAttr?.type : undefined; // 'bool'|'tag'|'integer'|'float'
                    const floatFreqDisabled = freqKind === 'float';
                    const isDragging = ecReorder.dragState?.id === cond.id;
                    const srcIdx = ecReorder.dragState ? condArr.findIndex(c => c.id === ecReorder.dragState!.id) : -1;
                    const showBefore = ecReorder.dragState?.overIdx === condIdx && srcIdx !== condIdx && srcIdx !== condIdx - 1;
                    const showAfter = ecReorder.dragState?.overIdx === condArr.length && condIdx === condArr.length - 1 && srcIdx !== condIdx;
                    return (
                      <div
                        key={cond.id}
                        data-reorder-row
                        className={`${isDragging ? styles.draggingRow : ''} ${showBefore ? styles.dropIndicatorBefore : ''} ${showAfter ? styles.dropIndicatorAfter : ''}`}
                        style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}
                      >
                        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                          <select
                            className={styles.selectInput}
                            style={{ flex: 1.4 }}
                            value={cond.indicatorId}
                            onChange={e => {
                              // Clear category on indicator change — the old key may be meaningless for the new indicator.
                              updateIndicatorCondition(cond.id, { indicatorId: e.target.value, category: undefined });
                            }}
                          >
                            {(model.indicators || []).map(i => (
                              <option key={i.id} value={i.id}>{i.name}</option>
                            ))}
                          </select>
                          {/* Category widget (linked-frequency only) */}
                          {isFreq && freqKind === 'bool' && (
                            <select
                              className={styles.selectInput}
                              style={{ flex: 1 }}
                              value={cond.category ?? 'true'}
                              onChange={e => updateIndicatorCondition(cond.id, { category: e.target.value })}
                              title="Category to monitor (count of cells with this value)"
                            >
                              <option value="true">true</option>
                              <option value="false">false</option>
                            </select>
                          )}
                          {isFreq && freqKind === 'tag' && (
                            <select
                              className={styles.selectInput}
                              style={{ flex: 1 }}
                              value={cond.category ?? (linkedAttr?.tagOptions?.[0] ?? '')}
                              onChange={e => updateIndicatorCondition(cond.id, { category: e.target.value })}
                              title="Tag to monitor (count of cells with this tag)"
                            >
                              {(linkedAttr?.tagOptions || []).map((tag, i) => (
                                <option key={i} value={tag}>{tag}</option>
                              ))}
                            </select>
                          )}
                          {isFreq && freqKind === 'integer' && (
                            <input
                              className={styles.numberInput}
                              type="number"
                              step={1}
                              style={{ flex: 1 }}
                              placeholder="value"
                              value={cond.category ?? ''}
                              onChange={e => updateIndicatorCondition(cond.id, {
                                category: e.target.value === '' ? undefined : String(Math.round(Number(e.target.value) || 0)),
                              })}
                              title="Integer value to monitor (count of cells with this value)"
                            />
                          )}
                          <select
                            className={styles.selectInput}
                            style={{ width: 52 }}
                            value={cond.op}
                            disabled={floatFreqDisabled}
                            onChange={e => updateIndicatorCondition(cond.id, { op: e.target.value as EndConditionOp })}
                          >
                            <option value="==">==</option>
                            <option value="!=">!=</option>
                            <option value=">">&gt;</option>
                            <option value="<">&lt;</option>
                            <option value=">=">&ge;</option>
                            <option value="<=">&le;</option>
                          </select>
                          {/* Value widget: scalar branches when NOT a frequency indicator;
                              count (number) when frequency (except float-binned, which is disabled) */}
                          {!isFreq && ind?.dataType === 'bool' ? (
                            <select
                              className={styles.selectInput}
                              style={{ flex: 1 }}
                              value={cond.value === '1' || cond.value === 'true' ? 'true' : 'false'}
                              onChange={e => updateIndicatorCondition(cond.id, { value: e.target.value })}
                            >
                              <option value="false">false</option>
                              <option value="true">true</option>
                            </select>
                          ) : !isFreq && ind?.dataType === 'tag' ? (
                            <select
                              className={styles.selectInput}
                              style={{ flex: 1 }}
                              value={cond.value}
                              onChange={e => updateIndicatorCondition(cond.id, { value: e.target.value })}
                            >
                              {(ind.tagOptions || []).map((tag, i) => (
                                <option key={i} value={String(i)}>{tag}</option>
                              ))}
                            </select>
                          ) : (
                            <input
                              className={styles.numberInput}
                              type="number"
                              step={isFreq ? 1 : (ind?.dataType === 'integer' ? 1 : 'any')}
                              style={{ flex: 1 }}
                              value={cond.value}
                              disabled={floatFreqDisabled}
                              placeholder={isFreq ? 'count' : undefined}
                              onChange={e => updateIndicatorCondition(cond.id, { value: e.target.value })}
                            />
                          )}
                          <button
                            className={styles.dragHandle}
                            title="Drag to reorder"
                            onPointerDown={ecReorder.startDrag(cond.id)}
                            onClick={e => e.stopPropagation()}
                          >⋮⋮</button>
                          <button
                            className={styles.deleteButton}
                            style={{ padding: '2px 6px', fontSize: '0.7rem' }}
                            onClick={() => removeIndicatorCondition(cond.id)}
                            title="Remove condition"
                          >
                            &times;
                          </button>
                        </div>
                        {floatFreqDisabled && (
                          <span style={{ color: '#e0a050', fontSize: '0.62rem', fontStyle: 'italic', paddingLeft: 4 }}>
                            Float-binned frequency categories depend on runtime range. Change this indicator&apos;s aggregation to Total, or pick a different indicator.
                          </span>
                        )}
                      </div>
                    );
                  })}
                  </div>
                  <button
                    className={styles.addButton}
                    style={{ fontSize: '0.72rem', padding: '2px 8px', marginTop: 4 }}
                    disabled={(model.indicators || []).length === 0}
                    onClick={addIndicatorCondition}
                  >
                    + Add Indicator Condition
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <IndicatorsPanelSection />
    </div>
  );
}
