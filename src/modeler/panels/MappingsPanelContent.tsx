import { useEffect, useRef, useState } from 'react';
import { useDetailSelection, type PanelContentProps } from '../ModelerDetailContext';
import { useModel } from '../../model/ModelContext';
import { useListReorder } from './useListReorder';
import { MODEL_ELEMENT_DRAG_MIME } from '../vpl/modelElementDrag';
import type { ModelElementDragPayload } from '../vpl/modelElementDrag';
import { setCurrentModelElementDrag } from '../vpl/graphState';
import { defaultGradientStops, defaultTagColor } from '../vpl/compiler/linkedOutputMappings';
import { GradientStopsEditor, type GradStop } from '../vpl/widgets/GradientStopsEditor';
import { INTERPOLATION_METHODS } from '../vpl/nodes/interpolationMethods';
import type { Mapping, RGB, ColorStop, Attribute, CAModel, InputMappingParam, InputParamType } from '../../model/types';
import { inputBrushKindOf, inputParamsOf, materialiseInputParams, mintParamKey, paramFallbackValue, paramTagOptions } from '../../model/inputMappingParams';
import { is3dModelLike } from '../vpl/compiler/niCodec';
import { typeDisplayName } from '../../model/typeLabels';
import { InlineBoolSelect, InlineNumberInput, InlineTagSelect, NumberField } from '../vpl/widgets/InlineWidgets';
import styles from './PanelContent.module.css';
import { ColorField } from '../vpl/widgets/ColorField';
import { hexToRgba, rgbaToHex, isOpaque, OPAQUE } from '../../model/colorHex';

// (The local 6-digit-only rgbToHex/hexToRgb pair that used to live here is gone —
//  ColorSwatch now routes through the shared alpha-aware helpers in colorHex.ts.
//  See its note on why three divergent copies of this had to be collapsed.)

const SPRITE_MAX_BYTES = 4 * 1024 * 1024;
const SPRITE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';
const genSpriteId = () => 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => (typeof r.result === 'string' ? resolve(r.result) : reject(new Error('read')));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** Compact draggable compass dial for a sprite's default facing direction.
 *  Value is in compass degrees: 0 = up (12 o'clock), increasing clockwise. */
function CompassDial({ value, onChange }: { value: number; onChange: (deg: number) => void }) {
  const size = 46, cx = size / 2, cy = size / 2, rr = size / 2 - 5;
  const nx = cx + rr * Math.sin((value * Math.PI) / 180);
  const ny = cy - rr * Math.cos((value * Math.PI) / 180);
  const pick = (clientX: number, clientY: number, el: SVGSVGElement) => {
    const rect = el.getBoundingClientRect();
    const dx = clientX - (rect.left + cx), dy = clientY - (rect.top + cy);
    if (dx === 0 && dy === 0) return;
    const deg = Math.round(((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360);
    onChange(deg);
  };
  return (
    <svg
      width={size} height={size} style={{ cursor: 'grab', flex: '0 0 auto' }}
      onPointerDown={e => { (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId); pick(e.clientX, e.clientY, e.currentTarget); }}
      onPointerMove={e => { if (e.buttons & 1) pick(e.clientX, e.clientY, e.currentTarget); }}
    >
      <circle cx={cx} cy={cy} r={rr} fill="#0a0b0e" stroke="#33465e" strokeWidth={1} />
      <line x1={cx} y1={cy} x2={nx} y2={ny} stroke="#4cc9f0" strokeWidth={2} />
      <circle cx={nx} cy={ny} r={3} fill="#4cc9f0" />
      <circle cx={cx} cy={cy} r={1.6} fill="#7a8a9a" />
    </svg>
  );
}

/** Renders a sprite's (first) frame on a small canvas; clicking a pixel reports
 *  its colour. Lets the user pick the chroma-key background by clicking the image
 *  directly instead of the native colour picker (which covers the sprite). */
function SpriteBgPicker({ dataUrl, onPick }: { dataUrl: string; onPick: (hex: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      const cv = canvasRef.current; if (!cv) return;
      const s = Math.min(120 / img.naturalWidth, 120 / img.naturalHeight, 4) || 1;
      cv.width = Math.max(1, Math.round(img.naturalWidth * s));
      cv.height = Math.max(1, Math.round(img.naturalHeight * s));
      const ctx = cv.getContext('2d'); if (!ctx) return;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 0, 0, cv.width, cv.height);
      setReady(true);
    };
    img.src = dataUrl;
  }, [dataUrl]);
  const pick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const cv = canvasRef.current; if (!cv) return;
    const rect = cv.getBoundingClientRect();
    const px = Math.max(0, Math.min(cv.width - 1, Math.floor((e.clientX - rect.left) / rect.width * cv.width)));
    const py = Math.max(0, Math.min(cv.height - 1, Math.floor((e.clientY - rect.top) / rect.height * cv.height)));
    const ctx = cv.getContext('2d'); if (!ctx) return;
    const d = ctx.getImageData(px, py, 1, 1).data;
    onPick('#' + [d[0]!, d[1]!, d[2]!].map(x => x.toString(16).padStart(2, '0')).join(''));
  };
  return (
    <canvas
      ref={canvasRef}
      onClick={pick}
      title="Click a pixel to pick it as the background colour to remove"
      style={{ border: '1px solid #2a3a50', cursor: 'crosshair', imageRendering: 'pixelated', maxWidth: 120, display: ready ? 'block' : 'none', background: 'repeating-conic-gradient(#1a1c22 0% 25%, #24262e 0% 50%) 50% / 12px 12px' }}
    />
  );
}

/** The bool / tag palette swatch. RGB in, RGB out — the callers spread `...c`
 *  into their ColorStop / RGB, so alpha rides along with no change at the call
 *  sites. Emits `a` ONLY when non-opaque, so an opaque palette carries no alpha
 *  key at all and the compiler stays on its byte-identical pre-alpha path. */
function ColorSwatch({ value, onChange }: { value: RGB; onChange: (c: RGB) => void }) {
  return (
    <ColorField
      value={rgbaToHex(value)}
      onChange={(hex) => {
        const n = hexToRgba(hex);
        onChange(n.a === OPAQUE ? { r: n.r, g: n.g, b: n.b } : { r: n.r, g: n.g, b: n.b, a: n.a });
      }}
      style={{ width: 34, height: 22 }}
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
        // `a` must survive BOTH legs of this round-trip. Dropping it (as this
        // mapper used to) makes the picker look like it refuses any alpha but
        // 255: GradientStopsEditor sets the stop's `a`, this discards it, and
        // the next render reads back opaque. Written only when some stop is
        // non-opaque, so an untouched palette keeps its exact pre-alpha
        // `ColorStop`s and the linked-OM injector wires no alpha edge.
        const editorStops: GradStop[] = g.map(s => ({ p: s.position, r: s.r, g: s.g, b: s.b, a: s.a }));
        const onStops = (next: GradStop[]) => {
          const withA = next.some(s => !isOpaque(s));
          setGradient(next.map(s => (withA
            ? { position: s.p, r: s.r, g: s.g, b: s.b, a: s.a ?? OPAQUE }
            : { position: s.p, r: s.r, g: s.g, b: s.b })));
        };
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

/**
 * The inline option list of a `tag` parameter — a DRAFT/COMMIT text field.
 *
 * ⚠ WHY IT CANNOT BE A PLAIN CONTROLLED INPUT (the bug this exists to fix):
 * the stored shape is a string ARRAY, so a controlled `value` has to round-trip
 * `options.join(', ')` ⇄ `text.split(',').map(trim).filter(Boolean)`. That round
 * trip is LOSSY for exactly the character the user must type to add an option:
 * `"a,"` parses to `['a']` and renders back as `"a"`, so the comma is eaten on
 * the very next render and a second option can never be started. (The reported
 * symptom: "I can't write the comma after the first option — it only works if I
 * write both options together, then add a comma in between.")
 *
 * The fix is the repo's standard discipline (`CustomLabelInput`, `NumberField`):
 * the user edits a free-text DRAFT and the parse happens once, on blur/Enter.
 * The effect resyncs the draft when the parameter changes underneath (a retype,
 * an undo, selecting a different mapping).
 */
function TagOptionsInput({ options, onCommit }: {
  options: readonly string[];
  onCommit: (next: string[]) => void;
}) {
  const external = options.join(', ');
  const [draft, setDraft] = useState(external);
  // Resync ONLY when the committed text genuinely changed underneath, so a
  // mid-edit draft ("a,") is never clobbered by the parsed round trip ("a").
  const lastExternalRef = useRef(external);
  useEffect(() => {
    if (external !== lastExternalRef.current) { setDraft(external); lastExternalRef.current = external; }
  }, [external]);
  const commit = () => {
    const parsed = draft.split(',').map(s => s.trim()).filter(Boolean);
    lastExternalRef.current = parsed.join(', ');
    if (parsed.join(' ') !== options.join(' ')) onCommit(parsed);
    else setDraft(lastExternalRef.current);   // normalise spacing on commit
  };
  return (
    <input
      className={styles.textInput}
      value={draft}
      placeholder="option A, option B, …"
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') { commit(); (e.currentTarget as HTMLInputElement).blur(); } }}
      title="Comma-separated option names — applied when you leave the field or press Enter. The payload carries the option INDEX."
    />
  );
}

/** The DEFAULT-value widget for one parameter — the value its brush row starts
 *  at (and the constant an image import seeds for it). Type-adaptive, mirroring
 *  the simulator's own `ParamWidget` so the editor and the brush agree on what a
 *  value of this type looks like. */
function ParamDefaultWidget({ param, options, onChange }: {
  param: InputMappingParam;
  options: string[];
  onChange: (v: string) => void;
}) {
  const value = paramFallbackValue(param);
  switch (param.type) {
    case 'bool':
      return <InlineBoolSelect className={styles.textInput} style={{ width: 76 }} value={value} onChange={onChange} />;
    case 'tag':
      return <InlineTagSelect className={styles.textInput} style={{ width: 110 }} value={value} options={options} onChange={onChange} />;
    case 'color':
      return <ColorField value={value} onChange={onChange} noAlpha style={{ width: 34, height: 22 }} />;
    default:
      return (
        <InlineNumberInput
          className={styles.textInput}
          style={{ width: 64 }}
          value={value}
          onChange={onChange}
          step={param.type === 'float' ? 'any' : 1}
        />
      );
  }
}

/**
 * Parameterized Input Mappings — THE PARAMETER LIST EDITOR (Phase 2).
 *
 * A Color→Attribute mapping declares its own named parameters instead of the
 * hardcoded R/G/B; this is where they are declared. Used for the CELL C→A
 * mappings AND the AGENT ones — ONE component, so the two layers cannot drift
 * (the milestone's cells-and-agents-must-be-consistent constraint).
 *
 * ⚠ MATERIALISATION. A LEGACY mapping (`parameters` absent) is shown as the one
 * row the resolver mints — `Brush colour · Color`. The FIRST edit writes that
 * list back explicitly. That is safe ONLY because the legacy parameter's key is
 * RESERVED (`inputMappingParams.LEGACY_COLOR_PARAM_KEY`), so it re-resolves to
 * the SAME `r`/`g`/`b` ports: adding a second parameter cannot break the wires
 * already leaving the root. See that constant's note.
 *
 * ⚠ WHAT MOVES WIRES. `name` is free to change (ports are keyed by `key`).
 * Deleting a parameter, or retyping it across the colour/scalar boundary,
 * DESTROYS channels — `UPDATE_MAPPING`'s cascade then DROPS the edges that fed
 * on them (never repoints). The `key` itself is deliberately NOT editable: a key
 * change is exactly a delete + re-add, and offering it as a text field would
 * make every keystroke a wire-dropping event.
 */
function InputParamsEditor({ mapping, update, model }: {
  mapping: Mapping;
  update: (id: string, changes: Partial<Mapping>) => void;
  model: CAModel;
}) {
  const resolved = inputParamsOf(mapping);
  // The rows are ALWAYS the materialised list, so a legacy mapping shows its
  // implicit colour parameter and can be edited like any other.
  const params = materialiseInputParams(mapping);
  const commit = (next: InputMappingParam[]) => update(mapping.id, { parameters: next });
  const patchAt = (i: number, changes: Partial<InputMappingParam>) =>
    commit(params.map((p, j) => (j === i ? { ...p, ...changes } : p)));

  const reorder = useListReorder(
    params.map(p => ({ id: p.key })),
    order => {
      const byKey = new Map(params.map(p => [p.key, p]));
      commit(order.map(k => byKey.get(k)!).filter(Boolean));
    },
  );

  const tagAttrs = [
    ...model.attributes.filter(a => a.type === 'tag'),
    ...(model.agentAttributes ?? []).filter(a => a.type === 'tag'),
  ];

  const addParam = () => {
    const name = `Parameter ${params.length + 1}`;
    commit([...params, { key: mintParamKey(name, params.map(p => p.key)), name, type: 'float', defaultValue: '0' }]);
  };

  const hintStyle: React.CSSProperties = { color: '#888', fontSize: '0.66rem', display: 'block', marginTop: 3 };

  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel}>Parameters</label>
      <span style={{ ...hintStyle, marginTop: 0, marginBottom: 5 }}>
        What the brush hands this mapping&apos;s graph. Each becomes a value output on its
        event root and one widget in the simulator&apos;s brush panel — a <b>Color</b> parameter
        contributes three ports (R/G/B) and one picker.
      </span>
      {resolved.legacy && (
        <span style={{ ...hintStyle, marginTop: 0, marginBottom: 5, fontStyle: 'italic' }}>
          This mapping still uses the built-in brush colour. Editing here declares its
          parameters explicitly — the R/G/B ports and every wire out of them are preserved.
        </span>
      )}
      <div className={styles.list} data-reorder-list>
        {params.map((p, i) => {
          const isDragging = reorder.dragState?.id === p.key;
          const srcIdx = reorder.dragState ? params.findIndex(x => x.key === reorder.dragState!.id) : -1;
          const showBefore = reorder.dragState?.overIdx === i && srcIdx !== i && srcIdx !== i - 1;
          const showAfter = reorder.dragState?.overIdx === params.length && i === params.length - 1 && srcIdx !== i;
          const channels = resolved.params.find(rp => rp.param.key === p.key)?.channels ?? [];
          return (
            <div
              key={p.key}
              data-reorder-row
              className={`${styles.listItem} ${isDragging ? styles.draggingRow : ''} ${showBefore ? styles.dropIndicatorBefore : ''} ${showAfter ? styles.dropIndicatorAfter : ''}`}
              style={{ flexWrap: 'wrap', alignItems: 'flex-start', cursor: 'default' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, width: '100%' }}>
                <input
                  className={styles.textInput}
                  style={{ flex: 1, minWidth: 60 }}
                  value={p.name}
                  onChange={e => patchAt(i, { name: e.target.value })}
                  title="Display name — the port label and the brush row. Renaming moves no wire."
                />
                <select
                  className={styles.textInput}
                  style={{ width: 86, flex: '0 0 auto' }}
                  value={p.type}
                  onChange={e => {
                    const type = e.target.value as InputParamType;
                    // Reset the value + the type-specific config so a retype cannot
                    // leave e.g. a `#rrggbb` default on a float or stale tag options.
                    patchAt(i, {
                      type,
                      defaultValue: type === 'color' ? '#000000' : type === 'bool' ? 'false' : '0',
                      tagOptions: undefined, tagAttributeId: undefined, min: undefined, max: undefined,
                    });
                  }}
                  title="Retyping across the Color boundary changes the port COUNT — the removed ports' wires are dropped."
                >
                  {(['float', 'integer', 'bool', 'tag', 'color'] as InputParamType[]).map(t => (
                    <option key={t} value={t}>{typeDisplayName(t)}</option>
                  ))}
                </select>
                <button
                  className={styles.deleteButton}
                  style={{ padding: '2px 6px', flex: '0 0 auto' }}
                  title={`Delete "${p.name}" — any wires from its port${channels.length > 1 ? 's' : ''} (${channels.map(c => c.portId).join(', ')}) are dropped`}
                  onClick={() => commit(params.filter((_, j) => j !== i))}
                >×</button>
              </div>
              {/* Type-specific configuration + the per-parameter description — the
                  replacement for the three legacy channel textareas. */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, width: '100%', marginTop: 4 }}>
                {(p.type === 'integer' || p.type === 'float') && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ fontSize: '0.66rem', color: '#888', width: 52 }}>range</span>
                    <NumberField className={styles.textInput} style={{ width: 64 }} value={p.min ?? 0}
                      onNumber={n => patchAt(i, { min: n })} onClear={() => patchAt(i, { min: undefined })} title="Brush-widget minimum (optional; not clamped by the engine)" />
                    <NumberField className={styles.textInput} style={{ width: 64 }} value={p.max ?? 0}
                      onNumber={n => patchAt(i, { max: n })} onClear={() => patchAt(i, { max: undefined })} title="Brush-widget maximum (optional; not clamped by the engine)" />
                  </div>
                )}
                {p.type === 'tag' && (<>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ fontSize: '0.66rem', color: '#888', width: 52 }}>options</span>
                    <select
                      className={styles.textInput}
                      style={{ flex: 1 }}
                      value={p.tagAttributeId ?? ''}
                      // Swapping the option SOURCE re-bases every index, so the
                      // stored default is reset rather than left pointing at an
                      // option that may no longer exist.
                      onChange={e => patchAt(i, { tagAttributeId: e.target.value || undefined, defaultValue: '0' })}
                      title="Borrow the option list from a tag attribute (live), or list them inline below."
                    >
                      <option value="">Inline list…</option>
                      {tagAttrs.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  </div>
                  {!p.tagAttributeId && (<>
                    <TagOptionsInput
                      options={p.tagOptions ?? []}
                      onCommit={next => patchAt(i, { tagOptions: next })}
                    />
                    {/* THE SEMANTICS NOTE. A tag channel carries the option INDEX on
                        every target — that is the whole payload. An INLINE list is
                        ad-hoc: nothing else in the model knows those names, so a
                        graph-side Get Constant / Compare / Switch can only compare
                        the number. Binding a tag ATTRIBUTE instead gives the same
                        index NAMED everywhere, which is what the user almost always
                        wants; saying so here is what stops the inline list reading
                        as a broken tag type. */}
                    <span style={{ fontSize: '0.62rem', color: '#8a7a4a', lineHeight: 1.35 }}>
                      An inline list is <b>ad-hoc</b>: the channel carries the option <b>index</b>
                      {(p.tagOptions ?? []).length > 0 && <> ({(p.tagOptions ?? []).map((o, oi) => `${oi}=${o}`).join(', ')})</>},
                      and graph nodes can only compare it as a number. To use these names in
                      Get&nbsp;Constant / Compare / Switch, pick a <b>tag attribute</b> above instead.
                    </span>
                  </>)}
                </>)}
                {/* THE DEFAULT — every type, in one place. It is what the brush row
                    starts at before the user touches it (and what an image import
                    seeds a CONSTANT channel with), so a parameter that is usually
                    "1.0" or "alive" should say so rather than making every user
                    dial it in. Resolved through `paramFallbackValue`, the SAME
                    function the payload encoder falls back to, so the widget can
                    never disagree with what an untouched brush actually sends. */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ fontSize: '0.66rem', color: '#888', width: 52 }}>default</span>
                  <ParamDefaultWidget
                    param={p}
                    options={paramTagOptions(p, model)}
                    onChange={v => patchAt(i, { defaultValue: v })}
                  />
                </div>
                <textarea
                  className={styles.textArea}
                  rows={1}
                  value={p.description ?? ''}
                  placeholder="What this parameter means (shown on its brush row)"
                  onChange={e => patchAt(i, { description: e.target.value || undefined })}
                />
                <span style={{ fontSize: '0.62rem', color: '#7a8a9a' }}>
                  port{channels.length > 1 ? 's' : ''}: {channels.map(c => c.portId).join(', ') || '—'}
                </span>
              </div>
              <button className={styles.dragHandle} title="Drag to reorder (the port ORDER is the argument order — recompiles)"
                onPointerDown={reorder.startDrag(p.key)}
                onClick={e => e.stopPropagation()}>⋮⋮</button>
            </div>
          );
        })}
      </div>
      {params.length === 0 && (
        <span style={{ ...hintStyle, fontStyle: 'italic' }}>
          No parameters — painting runs this mapping&apos;s graph with no brush input.
        </span>
      )}
      <div className={styles.buttonRow}>
        <button className={styles.addButton} onClick={addParam}>+ Parameter</button>
      </div>
    </div>
  );
}

function handleMappingDragStart(mappingId: string, isAttributeToColor: boolean) {
  return dragStartFor(isAttributeToColor
    ? { kind: 'mapping-a2c', mappingId }
    : { kind: 'mapping-c2a', mappingId });
}

/** Agent views drag as their OWN payload kind — their id-space is
 *  `model.agentMappings`, and the related nodes are the agent root (+ the
 *  universal Set Cell Looks), not the lattice `outputMapping`. */
function handleAgentMappingDragStart(mappingId: string, isAttributeToColor: boolean) {
  return dragStartFor(isAttributeToColor
    ? { kind: 'agent-mapping', mappingId }
    : { kind: 'agent-mapping-c2a', mappingId });
}

/** Sprites drag as their own kind too — `model.sprites` is a third id-space and
 *  its single consumer is the agent-only Set Agent Sprite node. */
function handleSpriteDragStart(spriteId: string) {
  return dragStartFor({ kind: 'sprite', spriteId });
}

function dragStartFor(payload: ModelElementDragPayload) {
  return (e: React.DragEvent) => {
    e.dataTransfer.setData(MODEL_ELEMENT_DRAG_MIME, JSON.stringify(payload));
    e.dataTransfer.effectAllowed = 'copy';
    setCurrentModelElementDrag(payload);
  };
}

/** The agent half of the Mappings panel's SINGLE detail slot. A bare id is a
 *  CELL mapping; this prefix marks an AGENT view, so selecting one clears the
 *  other for free (one slot, one detail panel). Mirrors the Attributes panel's
 *  `attr:` / `var:` / `bond:` discrimination — and `ModelerView.selectedItemName`
 *  MUST resolve it or the detail panel never mounts. */
const AGENT_MAP_PREFIX = 'agentmap:';
/** The third id-space in that same slot: a Sprite Library asset. Same ⚠ — the
 *  prefix is resolved in `ModelerView.selectedItemName`. */
const SPRITE_PREFIX = 'sprite:';

function handleMappingDragEnd() {
  setCurrentModelElementDrag(null);
}

export function MappingsPanelContent({ mode = 'list' }: PanelContentProps = {}) {
  const { model, addMapping, duplicateMapping, removeMapping, updateMapping, reorderMappings, addAgentMapping, duplicateAgentMapping, removeAgentMapping, updateAgentMapping, reorderAgentMappings, addSprite, duplicateSprite, removeSprite, updateSprite, reorderSprites } = useModel();
  const [selectedId, setSelectedId] = useDetailSelection('mappings');
  // ONE slot, THREE id-spaces: `agentmap:<id>` = an agent view, `sprite:<id>` = a
  // Sprite Library asset, a bare id = a cell mapping. Exactly one resolves, so
  // the shared detail panel always shows the last-clicked row and picking in one
  // layer deselects the others.
  const selectedAgentId = selectedId?.startsWith(AGENT_MAP_PREFIX) ? selectedId.slice(AGENT_MAP_PREFIX.length) : null;
  const selectedSpriteId = selectedId?.startsWith(SPRITE_PREFIX) ? selectedId.slice(SPRITE_PREFIX.length) : null;
  const selectedCellId = selectedId && selectedAgentId === null && selectedSpriteId === null ? selectedId : null;
  const agentsOn = !!model.topologyMode?.agents;
  // The Attribute↔Color mappings below are the LATTICE CA's colour views. Hide
  // them entirely for an agents-only model (no grid). When a model has BOTH
  // topologies, prefix each layer with a group header so the two are clearly
  // separated ("CA Grid" vs "Agents").
  const gridCellsOn = model.topologyMode?.gridCells !== false;
  const showGroupHeaders = gridCellsOn && agentsOn;
  const agentMappings = model.agentMappings ?? [];
  // BOTH agent directions live in `agentMappings`, discriminated by
  // `isAttributeToColor` exactly like the cell list: A->C = a colour VIEW, C->A =
  // an INPUT mapping the agent Paint brush runs on each painted agent.
  const agentViews = agentMappings.filter(m => m.isAttributeToColor);
  const agentInputs = agentMappings.filter(m => !m.isAttributeToColor);
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

  // Import an ORDERED SEQUENCE of images as one animated sprite (frames[]).
  const sequenceInputRef = useRef<HTMLInputElement>(null);
  const handleSequencePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) return;
    const total = files.reduce((s, f) => s + f.size, 0);
    if (total > SPRITE_MAX_BYTES * 2) { window.alert(`Sequence is ${(total / 1048576).toFixed(1)} MB — too large. Use fewer / smaller frames.`); return; }
    try {
      // Files sort by name so frame_01, frame_02 … order correctly.
      files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      const frames = await Promise.all(files.map(readFileAsDataUrl));
      const baseName = (files[0]?.name.replace(/[-_ ]?\d+\.[^.]+$/, '').replace(/\.[^.]+$/, '')) || 'sequence';
      addSprite({ id: genSpriteId(), name: baseName, dataUrl: frames[0]!, mimeType: files[0]?.type || 'image/png', scale: 1, loop: true, frames });
    } catch { window.alert('Could not read one of the frame images.'); }
  };

  // Import a single SPRITE SHEET image (sliced into frames by cols/rows).
  const sheetInputRef = useRef<HTMLInputElement>(null);
  const handleSheetPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > SPRITE_MAX_BYTES) { window.alert(`Sheet "${file.name}" is ${(file.size / 1048576).toFixed(1)} MB — the limit is 4 MB.`); return; }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const baseName = file.name.replace(/\.[^.]+$/, '') || 'sheet';
      addSprite({ id: genSpriteId(), name: baseName, dataUrl, mimeType: file.type || 'image/png', scale: 1, loop: true, sheet: { cols: 4, rows: 4 } });
    } catch { window.alert('Could not read the sheet image.'); }
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

  // Independent reorder for the agent views (their order IS the simulator's
  // Agents viewer-tab order, same as the cell mappings' tabs).
  // Reordering ONE direction's rows sends only that subset; `reorderById` appends
  // the untouched entries after it, so relative order WITHIN each direction is
  // preserved (which is all any consumer reads — every one filters by direction).
  const agentReorder = useListReorder(agentViews, reorderAgentMappings);
  const agentInputReorder = useListReorder(agentInputs, reorderAgentMappings);
  // …and for the Sprite Library, whose order is what every sprite picker lists.
  const spriteReorder = useListReorder(sprites, reorderSprites);

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

  // Same for a newly added agent view (ADD_AGENT_MAPPING appends), so "+ Add
  // Agent View" opens its editor straight away — the cell mappings' behaviour.
  const prevAgentCount = useRef(agentMappings.length);
  useEffect(() => {
    if (agentMappings.length > prevAgentCount.current) {
      const newItem = agentMappings[agentMappings.length - 1];
      if (newItem) {
        setSelectedId(AGENT_MAP_PREFIX + newItem.id);
        setTimeout(() => {
          document.getElementById(`mapping-${newItem.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 50);
      }
    }
    prevAgentCount.current = agentMappings.length;
    // Keyed on the LENGTH, not the array: `model.agentMappings ?? []` mints a
    // fresh [] whenever the key is absent, which would re-run this every render.
  }, [agentMappings.length]);

  // Same for a newly IMPORTED / duplicated sprite (every add path appends), so
  // the new asset's editor opens straight away. Length-keyed for the same reason
  // as above — `model.sprites ?? []` is a fresh array on every render.
  const prevSpriteCount = useRef(sprites.length);
  useEffect(() => {
    if (sprites.length > prevSpriteCount.current) {
      const newItem = sprites[sprites.length - 1];
      if (newItem) {
        setSelectedId(SPRITE_PREFIX + newItem.id);
        setTimeout(() => {
          document.getElementById(`sprite-${newItem.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 50);
      }
    }
    prevSpriteCount.current = sprites.length;
  }, [sprites.length]);

  const selected = selectedCellId ? model.mappings.find(m => m.id === selectedCellId) : undefined;
  const selectedAgent = selectedAgentId ? agentMappings.find(m => m.id === selectedAgentId) : undefined;
  // The two agent sections SHARE one selection slot, so each section's
  // Duplicate / Delete must act only when the selection is one of ITS rows —
  // otherwise Delete under "Agent Input Mappings" would remove a selected A→C
  // VIEW (and vice versa). Grey the buttons out rather than let them misfire.
  const selectedAgentViewId = selectedAgent?.isAttributeToColor ? selectedAgentId : null;
  const selectedAgentInputId = selectedAgent && !selectedAgent.isAttributeToColor ? selectedAgentId : null;
  const selectedSprite = selectedSpriteId ? sprites.find(s => s.id === selectedSpriteId) : undefined;

  const handleDelete = () => {
    if (selectedCellId) {
      removeMapping(selectedCellId);
      setSelectedId(null);
    }
  };

  // Deleting the selected agent view must clear the shared slot too, or the
  // detail panel would keep an id that no longer resolves.
  const handleDeleteAgent = () => {
    if (selectedAgentId) {
      removeAgentMapping(selectedAgentId);
      setSelectedId(null);
    }
  };

  // Same for the sprite half of the slot. REMOVE_SPRITE also cascades
  // `clearDeletedId('spriteId')` over the Set Agent Sprite nodes.
  const handleDeleteSprite = () => {
    if (selectedSpriteId) {
      removeSprite(selectedSpriteId);
      setSelectedId(null);
    }
  };

  return (
    <>
      {mode !== 'detail' && (<>
      {gridCellsOn && (<>
      {showGroupHeaders && <div className={styles.groupTitle}>CA Grid</div>}
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
                className={`${styles.listItem} ${selectedCellId === m.id ? styles.listItemSelected : ''} ${isDragging ? styles.draggingRow : ''} ${showBefore ? styles.dropIndicatorBefore : ''} ${showAfter ? styles.dropIndicatorAfter : ''}`}
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
          <button className={styles.addButton} onClick={() => selectedCellId && duplicateMapping(selectedCellId)} disabled={!selectedCellId}>
            Duplicate
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
                className={`${styles.listItem} ${selectedCellId === m.id ? styles.listItemSelected : ''} ${isDragging ? styles.draggingRow : ''} ${showBefore ? styles.dropIndicatorBefore : ''} ${showAfter ? styles.dropIndicatorAfter : ''}`}
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
          <button className={styles.addButton} onClick={() => selectedCellId && duplicateMapping(selectedCellId)} disabled={!selectedCellId}>
            Duplicate
          </button>
          <button className={styles.deleteButton} onClick={handleDelete}>
            Delete
          </button>
        </div>
      </div>
      </>)}

      {showGroupHeaders && <div className={styles.groupTitle}>Agents</div>}

      {/* Agent Output Mappings — the agent-layer A→C views (the two-layer viewer).
          MASTER-DETAIL, exactly like the CA-grid mappings above: the list lives
          here and the selected view's editor opens in the shared second panel.
          Rows are draggable to the canvas (Agents graph) to spawn the Agent
          Output Mapping root / Set Cell Looks already pointed at the view. */}
      {agentsOn && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Agent Output Mappings (A&rarr;C)</div>
          <span style={{ color: '#888', fontSize: '0.66rem', display: 'block', margin: '0 0 6px' }}>
            Each is a colour view of the agents, picking an agent attribute → colour.
            Switch between them in the simulator&apos;s viewer bar (Agents row).
          </span>
          {agentViews.length === 0 && (
            <span style={{ color: '#888', fontSize: '0.68rem', fontStyle: 'italic' }}>No agent views yet.</span>
          )}
          <div className={styles.list} data-reorder-list>
            {agentViews.map((m, i) => {
              const isDragging = agentReorder.dragState?.id === m.id;
              const srcIdx = agentReorder.dragState ? agentViews.findIndex(x => x.id === agentReorder.dragState!.id) : -1;
              const showBefore = agentReorder.dragState?.overIdx === i && srcIdx !== i && srcIdx !== i - 1;
              const showAfter = agentReorder.dragState?.overIdx === agentViews.length && i === agentViews.length - 1 && srcIdx !== i;
              return (
                <div
                  key={m.id}
                  id={`mapping-${m.id}`}
                  data-reorder-row
                  className={`${styles.listItem} ${selectedAgentId === m.id ? styles.listItemSelected : ''} ${isDragging ? styles.draggingRow : ''} ${showBefore ? styles.dropIndicatorBefore : ''} ${showAfter ? styles.dropIndicatorAfter : ''}`}
                  onClick={() => setSelectedId(AGENT_MAP_PREFIX + m.id)}
                  draggable
                  onDragStart={handleAgentMappingDragStart(m.id, true)}
                  onDragEnd={handleMappingDragEnd}
                  title={`Drag to the Agents canvas to add a node that uses '${m.name}'`}
                >
                  <span className={styles.listItemName}>{m.name}</span>
                  <span className={styles.listItemBadge}>A&rarr;C</span>
                  <button className={styles.dragHandle} title="Drag to reorder"
                    onPointerDown={agentReorder.startDrag(m.id)}
                    onClick={e => e.stopPropagation()}>⋮⋮</button>
                </div>
              );
            })}
          </div>
          <div className={styles.buttonRow}>
            <button
              className={styles.addButton}
              onClick={() => addAgentMapping(true)}
              title={agentAttrs.length === 0 ? 'No agent attributes yet — the new view is seeded Standalone (build it on the Agents graph).' : undefined}
            >
              + Add Agent View
            </button>
            <button className={styles.addButton} onClick={() => selectedAgentViewId && duplicateAgentMapping(selectedAgentViewId)} disabled={!selectedAgentViewId}>
              Duplicate
            </button>
            <button className={styles.deleteButton} onClick={handleDeleteAgent} disabled={!selectedAgentViewId}>
              Delete
            </button>
          </div>
        </div>
      )}

      {/* Agent INPUT Mappings — the agent-layer C→A half of `agentMappings`, the
          mirror image of the section above and the agent twin of the CA grid's
          Color→Attribute mappings. Each is a STANDALONE graph (there is no palette
          to auto-generate — the graph IS the mapping) rooted at an Agent Input
          Mapping node, run once per agent the simulator's agent Paint brush
          touches. Same master-detail + drag-to-canvas as every other list. */}
      {agentsOn && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Agent Input Mappings (C&rarr;A)</div>
          <span style={{ color: '#888', fontSize: '0.66rem', display: 'block', margin: '0 0 6px' }}>
            Each is a graph that runs on every agent you paint with the simulator&apos;s
            agent brush (Paint mode) — the brush values arrive on the root&apos;s parameter outputs.
          </span>
          {agentInputs.length === 0 && (
            <span style={{ color: '#888', fontSize: '0.68rem', fontStyle: 'italic' }}>No agent input mappings yet.</span>
          )}
          <div className={styles.list} data-reorder-list>
            {agentInputs.map((m, i) => {
              const isDragging = agentInputReorder.dragState?.id === m.id;
              const srcIdx = agentInputReorder.dragState ? agentInputs.findIndex(x => x.id === agentInputReorder.dragState!.id) : -1;
              const showBefore = agentInputReorder.dragState?.overIdx === i && srcIdx !== i && srcIdx !== i - 1;
              const showAfter = agentInputReorder.dragState?.overIdx === agentInputs.length && i === agentInputs.length - 1 && srcIdx !== i;
              return (
                <div
                  key={m.id}
                  id={`mapping-${m.id}`}
                  data-reorder-row
                  className={`${styles.listItem} ${selectedAgentId === m.id ? styles.listItemSelected : ''} ${isDragging ? styles.draggingRow : ''} ${showBefore ? styles.dropIndicatorBefore : ''} ${showAfter ? styles.dropIndicatorAfter : ''}`}
                  onClick={() => setSelectedId(AGENT_MAP_PREFIX + m.id)}
                  draggable
                  onDragStart={handleAgentMappingDragStart(m.id, false)}
                  onDragEnd={handleMappingDragEnd}
                  title={`Drag to the Agents canvas to add an Agent Input Mapping root for '${m.name}'`}
                >
                  <span className={styles.listItemName}>{m.name}</span>
                  <span className={styles.listItemBadge}>C&rarr;A</span>
                  <button className={styles.dragHandle} title="Drag to reorder"
                    onPointerDown={agentInputReorder.startDrag(m.id)}
                    onClick={e => e.stopPropagation()}>⋮⋮</button>
                </div>
              );
            })}
          </div>
          <div className={styles.buttonRow}>
            <button className={styles.addButton} onClick={() => addAgentMapping(false)}>
              + Add Agent Input
            </button>
            <button className={styles.addButton} onClick={() => selectedAgentInputId && duplicateAgentMapping(selectedAgentInputId)} disabled={!selectedAgentInputId}>
              Duplicate
            </button>
            <button className={styles.deleteButton} onClick={handleDeleteAgent} disabled={!selectedAgentInputId}>
              Delete
            </button>
          </div>
        </div>
      )}

      {/* Sprite Library — imported images / animated GIFs used as the optional
          agent exhibition layer (Set Agent Sprite node in an Agent Output Mapping
          graph). Agents-only. Each sprite travels inside the .gcaproj as a data URL.
          MASTER-DETAIL like the mappings above: the list (thumbnail + name +
          reorder handle) lives here, the selected asset's editor opens in the
          shared second panel, and a row drags onto the Agents canvas to spawn a
          Set Agent Sprite already pointed at it. */}
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
          <div className={styles.list} data-reorder-list>
            {sprites.map((s, i) => {
              const isDragging = spriteReorder.dragState?.id === s.id;
              const srcIdx = spriteReorder.dragState ? sprites.findIndex(x => x.id === spriteReorder.dragState!.id) : -1;
              const showBefore = spriteReorder.dragState?.overIdx === i && srcIdx !== i && srcIdx !== i - 1;
              const showAfter = spriteReorder.dragState?.overIdx === sprites.length && i === sprites.length - 1 && srcIdx !== i;
              const frameCount = s.frames?.length ?? (s.sheet ? (s.sheet.count ?? s.sheet.cols * s.sheet.rows) : 0);
              return (
                <div
                  key={s.id}
                  id={`sprite-${s.id}`}
                  data-reorder-row
                  className={`${styles.listItem} ${selectedSpriteId === s.id ? styles.listItemSelected : ''} ${isDragging ? styles.draggingRow : ''} ${showBefore ? styles.dropIndicatorBefore : ''} ${showAfter ? styles.dropIndicatorAfter : ''}`}
                  onClick={() => setSelectedId(SPRITE_PREFIX + s.id)}
                  draggable
                  onDragStart={handleSpriteDragStart(s.id)}
                  onDragEnd={handleMappingDragEnd}
                  title={`Drag to the Agents canvas to add a Set Agent Sprite using '${s.name}'`}
                >
                  {/* The thumbnail IS the row's identity — a sprite is a picture. */}
                  <img
                    src={s.dataUrl}
                    alt=""
                    style={{ width: 24, height: 24, objectFit: 'contain', background: '#0a0b0e', borderRadius: 3, imageRendering: 'pixelated', flex: '0 0 auto', pointerEvents: 'none' }}
                  />
                  <span className={styles.listItemName}>{s.name}</span>
                  {frameCount > 1 && <span className={styles.listItemBadge}>{frameCount}f</span>}
                  <button className={styles.dragHandle} title="Drag to reorder"
                    onPointerDown={spriteReorder.startDrag(s.id)}
                    onClick={e => e.stopPropagation()}>⋮⋮</button>
                </div>
              );
            })}
          </div>
          <input ref={spriteInputRef} type="file" accept={SPRITE_ACCEPT} style={{ display: 'none' }} onChange={handleSpritePick} />
          <input ref={sequenceInputRef} type="file" accept={SPRITE_ACCEPT} multiple style={{ display: 'none' }} onChange={handleSequencePick} />
          <input ref={sheetInputRef} type="file" accept={SPRITE_ACCEPT} style={{ display: 'none' }} onChange={handleSheetPick} />
          <div className={styles.buttonRow} style={{ flexWrap: 'wrap' }}>
            <button className={styles.addButton} onClick={() => spriteInputRef.current?.click()} title="A single image or an animated GIF/WebP">
              + Image / GIF
            </button>
            <button className={styles.addButton} onClick={() => sequenceInputRef.current?.click()} title="Several images → one animated sprite (frames in filename order)">
              + Frame sequence
            </button>
            <button className={styles.addButton} onClick={() => sheetInputRef.current?.click()} title="One grid image sliced into frames (RPGMaker-style sprite sheet)">
              + Sprite sheet
            </button>
            <button className={styles.addButton} onClick={() => selectedSpriteId && duplicateSprite(selectedSpriteId)} disabled={!selectedSpriteId}>
              Duplicate
            </button>
            <button className={styles.deleteButton} onClick={handleDeleteSprite}>
              Delete
            </button>
          </div>
        </div>
      )}

      </>)}

      {/* Agent-view editor — the agent half of the SHARED detail panel. Same
          fields the cell A→C editor offers (name / description / colour pass /
          linked palette), over the AGENT attribute set. The per-channel R/G/B
          description boxes are deliberately absent: they document a hand-built
          cell colour pass and nothing reads them for an agent view. */}
      {mode === 'detail' && selectedAgent && (
        <div className={styles.detailEditor}>
          <div className={styles.detailTitle}>Edit: {selectedAgent.name}</div>
          <div className={styles.fieldGroup}>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Name</label>
              <input
                className={styles.textInput}
                value={selectedAgent.name}
                onChange={e => updateAgentMapping(selectedAgent.id, { name: e.target.value })}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Description</label>
              <textarea
                className={styles.textArea}
                rows={2}
                value={selectedAgent.description}
                onChange={e => updateAgentMapping(selectedAgent.id, { description: e.target.value })}
              />
              <span style={{ color: '#888', fontSize: '0.66rem', marginTop: 3, display: 'block' }}>
                {selectedAgent.isAttributeToColor
                  ? "Shown as the tooltip on this view's tab in the simulator's Agents viewer row."
                  : "Shown as the tooltip on this mapping's tab in the simulator's agent Paint brush."}
              </span>
            </div>
            {/* A C->A INPUT mapping is ALWAYS a standalone graph — there is no
                palette to auto-generate from an attribute, so the Color-pass
                selector + the linked palette editor are hidden rather than shown
                inert (the "an enabled control must do something" rule). */}
            {!selectedAgent.isAttributeToColor && (<>
              {/* BRUSH KIND — what painting with this mapping DOES. It reshapes
                  the root (a spawner gains Brush X/Y/[Z]/Radius outs and loses
                  its `self`), so it belongs above the parameter list. Absent ⇒
                  Editor, the historical behaviour. */}
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Brush kind</label>
                <div style={{ display: 'flex', gap: 4 }}>
                  {(['editor', 'spawner'] as const).map(k => (
                    <button
                      key={k}
                      className={styles.textInput}
                      style={{
                        flex: 1, cursor: 'pointer', textTransform: 'capitalize',
                        ...(inputBrushKindOf(selectedAgent) === k
                          ? { borderColor: 'var(--color-accent)', color: 'var(--color-accent)' }
                          : {}),
                      }}
                      onClick={() => updateAgentMapping(selectedAgent.id, { brushKind: k })}
                      title={k === 'editor'
                        ? 'Runs once per agent the brush covers, with that agent as self — edit the agents you touch (and, if you like, spawn around them or remove them).'
                        : 'Runs ONCE per brush application with no self: the graph receives the brush position + radius and creates the agents itself.'}
                    >{k}</button>
                  ))}
                </div>
              </div>
              <span style={{ color: '#888', fontSize: '0.66rem', display: 'block' }}>
                {inputBrushKindOf(selectedAgent) === 'spawner' ? (<>
                  Build this mapping on the Agents graph: an <strong>Agent Input Mapping (C&rarr;A)</strong> root
                  whose <strong>Brush X / Y{is3dModelLike(model) ? ' / Z' : ''} / Radius</strong> outs carry
                  where the user clicked, then Create Agent &rarr; set-by-handle &rarr; Add Agent To World
                  on the DO chain (loop to place several). It runs ONCE per click / drag step, so it has no
                  <em> self</em> — per-agent reads like Get Self Position are invalid here.
                </>) : (<>
                  Build this mapping on the Agents graph: an <strong>Agent Input Mapping (C&rarr;A)</strong> root
                  whose value outputs carry the parameters below, then Set Attribute / Set Agent Radius / … on the DO chain.
                  Select it in the simulator&apos;s agent brush (Paint mode) and paint agents with it.
                </>)}
              </span>
              {/* The SAME editor the cell C→A mappings use — one component, so the
                  two layers cannot drift (cells and agents must be consistent). */}
              <InputParamsEditor mapping={selectedAgent} update={updateAgentMapping} model={model} />
            </>)}
            {selectedAgent.isAttributeToColor && (<>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Color pass</label>
              <select
                className={styles.textInput}
                value={selectedAgent.linked === false ? 'standalone' : 'linked'}
                onChange={e => updateAgentMapping(selectedAgent.id, { linked: e.target.value === 'linked' })}
              >
                <option value="standalone">Standalone</option>
                <option value="linked">Linked</option>
              </select>
              <span style={{ color: '#888', fontSize: '0.66rem', marginTop: 3, display: 'block' }}>
                {selectedAgent.linked === false
                  ? 'You build this view by hand on the Agents graph (Agent Output Mapping → … → Set Cell Looks / Set Agent Sprite).'
                  : 'Auto-generates the colour from a chosen agent attribute. If you also add an Agent Output Mapping node for this view, the auto pass runs first as a background and your graph overrides it (special colours, sprites).'}
              </span>
            </div>
            {selectedAgent.linked !== false && (
              <LinkedOutputEditor selected={{ ...selectedAgent, linked: true }} attrs={agentAttrs} update={updateAgentMapping} />
            )}
            </>)}
          </div>
        </div>
      )}

      {/* Sprite editor — the third occupant of the SHARED detail panel. Every
          per-asset control the inline stack used to carry (name, size, loop, the
          sheet-slicing grid, rotation, chroma key), with a bigger preview. */}
      {mode === 'detail' && selectedSprite && (() => {
        const s = selectedSprite;
        return (
          <div className={styles.detailEditor}>
            <div className={styles.detailTitle}>Edit: {s.name}</div>
            <div className={styles.fieldGroup}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <img
                  src={s.dataUrl}
                  alt={s.name}
                  style={{ width: 48, height: 48, objectFit: 'contain', background: '#0a0b0e', borderRadius: 4, imageRendering: 'pixelated', flex: '0 0 auto' }}
                />
                <div className={styles.field} style={{ flex: 1, marginBottom: 0 }}>
                  <label className={styles.fieldLabel}>Name</label>
                  <input
                    className={styles.textInput}
                    value={s.name}
                    onChange={e => updateSprite(s.id, { name: e.target.value })}
                  />
                </div>
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
              {/* Sprite sheet slicing params (only for a sheet-sourced sprite). */}
              {s.sheet && (
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Sheet grid (cols × rows, frames)</label>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                    <NumberField className={styles.textInput} style={{ width: 52 }} integer min={1} value={s.sheet.cols}
                      onNumber={n => updateSprite(s.id, { sheet: { ...s.sheet!, cols: Math.max(1, Math.round(n)) } })} title="Columns" />
                    <span style={{ color: '#7a8a9a' }}>×</span>
                    <NumberField className={styles.textInput} style={{ width: 52 }} integer min={1} value={s.sheet.rows}
                      onNumber={n => updateSprite(s.id, { sheet: { ...s.sheet!, rows: Math.max(1, Math.round(n)) } })} title="Rows" />
                    <NumberField className={styles.textInput} style={{ width: 60 }} integer min={1} value={s.sheet.count ?? s.sheet.cols * s.sheet.rows}
                      onNumber={n => updateSprite(s.id, { sheet: { ...s.sheet!, count: Math.max(1, Math.round(n)) } })} title="Frame count (row-major)" />
                  </div>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center', marginTop: 3 }} title="Pixel margin to the first cell and spacing between cells">
                    <span style={{ color: '#7a8a9a', fontSize: '0.62rem' }}>margin</span>
                    <NumberField className={styles.textInput} style={{ width: 44 }} integer min={0} value={s.sheet.marginX ?? 0}
                      onNumber={n => updateSprite(s.id, { sheet: { ...s.sheet!, marginX: Math.max(0, Math.round(n)) } })} title="Margin X" />
                    <NumberField className={styles.textInput} style={{ width: 44 }} integer min={0} value={s.sheet.marginY ?? 0}
                      onNumber={n => updateSprite(s.id, { sheet: { ...s.sheet!, marginY: Math.max(0, Math.round(n)) } })} title="Margin Y" />
                    <span style={{ color: '#7a8a9a', fontSize: '0.62rem' }}>gap</span>
                    <NumberField className={styles.textInput} style={{ width: 44 }} integer min={0} value={s.sheet.spacingX ?? 0}
                      onNumber={n => updateSprite(s.id, { sheet: { ...s.sheet!, spacingX: Math.max(0, Math.round(n)) } })} title="Spacing X" />
                    <NumberField className={styles.textInput} style={{ width: 44 }} integer min={0} value={s.sheet.spacingY ?? 0}
                      onNumber={n => updateSprite(s.id, { sheet: { ...s.sheet!, spacingY: Math.max(0, Math.round(n)) } })} title="Spacing Y" />
                  </div>
                </div>
              )}
              {/* Rotation — default facing (clock), orient-to-velocity, fixed offset. */}
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Rotation</label>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <CompassDial value={s.defaultDirection ?? 0} onChange={deg => updateSprite(s.id, { defaultDirection: deg })} />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: 1 }}>
                    <span style={{ color: '#7a8a9a', fontSize: '0.62rem' }}>Art faces: {s.defaultDirection ?? 0}° (0 = up)</span>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, cursor: 'pointer' }}
                      title="Auto-rotate each agent's sprite to point along its velocity (heading), aligning the art's default direction.">
                      <input type="checkbox" checked={!!s.orientToVelocity}
                        onChange={e => updateSprite(s.id, { orientToVelocity: e.target.checked })} />
                      Orient to velocity
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12 }} title="Extra fixed rotation (degrees, clockwise)">
                      <span style={{ color: '#7a8a9a' }}>Offset °</span>
                      <NumberField className={styles.textInput} style={{ width: 60 }} value={s.rotationOffset ?? 0}
                        onNumber={n => updateSprite(s.id, { rotationOffset: n })} onClear={() => updateSprite(s.id, { rotationOffset: 0 })} />
                    </label>
                  </div>
                </div>
              </div>
              {/* Chroma key — remove a background colour (magenta / green screen). */}
              <div className={styles.field}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}
                  title="Make pixels matching a background colour transparent (for traditional sprites on a solid magenta/green background).">
                  <input type="checkbox" checked={s.removeBgColor !== undefined}
                    onChange={e => updateSprite(s.id, e.target.checked ? { removeBgColor: '#ff00ff', removeBgTolerance: s.removeBgTolerance ?? 24 } : { removeBgColor: undefined })} />
                  Remove background color
                </label>
                {s.removeBgColor !== undefined && (
                  <div style={{ marginTop: 3 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <input type="color" value={/^#[0-9a-f]{6}$/i.test(s.removeBgColor) ? s.removeBgColor : '#ff00ff'}
                        style={{ width: 32, height: 20, padding: 0, border: '1px solid #2a3a50', borderRadius: 3, background: 'none', cursor: 'pointer' }}
                        onChange={e => updateSprite(s.id, { removeBgColor: e.target.value })} title="Background colour to remove" />
                      <span style={{ color: '#7a8a9a', fontSize: '0.62rem' }}>tolerance</span>
                      <NumberField className={styles.textInput} style={{ width: 56 }} integer min={0} max={255} value={s.removeBgTolerance ?? 24}
                        onNumber={n => updateSprite(s.id, { removeBgTolerance: Math.max(0, Math.min(255, Math.round(n))) })} title="Per-channel tolerance (0–255)" />
                    </div>
                    {/* Click the image directly to pick the background colour (the native
                        colour picker otherwise covers the sprite). Uses the original
                        image, so magenta/green shows even after keying. */}
                    <div style={{ marginTop: 4, fontSize: '0.6rem', color: '#7a8a9a' }}>or click the image to pick it:</div>
                    <SpriteBgPicker dataUrl={(s.frames && s.frames[0]) || s.dataUrl} onPick={hex => updateSprite(s.id, { removeBgColor: hex })} />
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}

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
            {/* C→A: the mapping's declared PARAMETERS replace the three fixed
                channel textareas below — those documented a HARDCODED encoding
                the user then had to re-implement in the graph. Each parameter
                carries its own description, which is strictly more expressive.
                The textareas stay for A→C, where documenting the three channels
                of an OUTPUT colour is still a real thing to do. */}
            {!selected.isAttributeToColor && (
              <InputParamsEditor mapping={selected} update={updateMapping} model={model} />
            )}
            {selected.isAttributeToColor && (<>
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
            </>)}
          </div>
        </div>
      )}
    </>
  );
}
