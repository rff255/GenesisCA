import type { CAModel, InputMappingParam } from '../model/types';
import {
  paramFallbackValue, paramTagOptions,
  type InputParamValues, type ResolvedInputParams,
} from '../model/inputMappingParams';
import { InlineBoolSelect, InlineNumberInput, InlineTagSelect, NumberField } from '../modeler/vpl/widgets/InlineWidgets';
import { ColorField } from '../modeler/vpl/widgets/ColorField';
import styles from './SimulatorView.module.css';

interface InputParamsPanelProps {
  /** The mapping's RESOLVED parameters (always via `inputParamsOf`). */
  resolved: ResolvedInputParams;
  /** Current per-parameter brush values (`key` → canonical string). */
  values: InputParamValues;
  onChange: (next: InputParamValues) => void;
  /** For resolving a `tag` parameter's `tagAttributeId` against live attributes. */
  model: Pick<CAModel, 'attributes' | 'agentAttributes'>;
}

/**
 * The brush panel for a PARAMETERIZED Input Mapping (C→A) — the sibling of
 * `ManualBrushPanel`, and the reason "abolish the assumption that input mappings
 * have r,g,b" is visible to the user: one type-adaptive widget per DECLARED
 * parameter instead of a colour the graph has to decode.
 *
 * Two deliberate differences from the Manual Brush, which the two panels'
 * opposite semantics require:
 *   · NO per-row checkbox. A parameter is an ARGUMENT — it is always passed.
 *     (Manual writes attributes directly, so skipping a row is meaningful there.)
 *   · A `color` parameter is ONE `ColorField` even though it occupies THREE
 *     channels in the payload — the channel split is an engine detail.
 *
 * Used for the CELL brush and the AGENT User-defined brush alike (constraint:
 * cells and agents must end up consistent).
 *
 * ⚠ THE ROW GEOMETRY MUST NOT DEPEND ON THE VALUE — see the `.paramRow` block in
 * SimulatorView.module.css for the three rules and the feedback loop they fixed.
 * The one this file owns: the reset SLOT is always rendered, only the BUTTON
 * inside it is conditional.
 */
export function InputParamsPanel({ resolved, values, onChange, model }: InputParamsPanelProps) {
  const setValue = (key: string, value: string): void => onChange({ ...values, [key]: value });

  if (resolved.params.length === 0) {
    return (
      <div className={styles.manualBrushEmpty}>
        This mapping declares no parameters — painting runs its graph with no brush input.
      </div>
    );
  }

  return (
    <div className={styles.manualBrushPanel}>
      {resolved.params.map(({ param }) => {
        // The DEFAULT is the seed: an untouched parameter shows (and paints) the
        // value the mapping declares. `paramFallbackValue` is the SAME resolution
        // `encodeChannelValues` falls back to, so the widget can never show one
        // number while the payload carries another.
        const dflt = paramFallbackValue(param);
        const current = values[param.key] ?? dflt;
        return (
          <div key={param.key} className={styles.paramRow}>
            <div className={styles.paramLabel} title={param.description || param.name || param.key}>
              {param.name || param.key}
            </div>
            <div className={styles.paramWidget}>
              <ParamWidget
                param={param}
                value={current}
                onChange={v => setValue(param.key, v)}
                model={model}
              />
              {/* The SLOT is unconditional (fixed width) so the button appearing
                  cannot resize the slider beside it mid-drag; only the BUTTON is
                  conditional, so it is never an enabled control that does
                  nothing (the standing rule). */}
              <div className={styles.paramResetSlot}>
                {current !== dflt && (
                  <button
                    className={styles.paramResetBtn}
                    title={`Reset to the declared default (${dflt})`}
                    onClick={() => setValue(param.key, dflt)}
                  >⟳</button>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ParamWidget({ param, value, onChange, model }: {
  param: InputMappingParam;
  value: string;
  onChange: (v: string) => void;
  model: Pick<CAModel, 'attributes' | 'agentAttributes'>;
}) {
  switch (param.type) {
    case 'bool':
      return <InlineBoolSelect value={value || 'false'} onChange={onChange} />;
    case 'tag':
      return <InlineTagSelect value={value || '0'} options={paramTagOptions(param, model)} onChange={onChange} />;
    case 'color':
      // ONE swatch for the parameter's three channels. `noAlpha` — a brush
      // parameter carries R/G/B; there is no fourth channel in the payload.
      return (
        <ColorField
          value={value || '#000000'} onChange={onChange} noAlpha
          title={param.name || param.key}
          style={{ flex: '1 1 auto' }}
        />
      );
    case 'integer':
    case 'float':
    default: {
      // BOUNDED ⇒ a range slider alongside the number field — the Model Attribute
      // bounds pattern (`hasBounds && min != null && max != null`), reused here so
      // a brush parameter with a declared range feels like every other bounded
      // control in the simulator. The number field keeps the same min/max, so a
      // typed value is clamped on commit exactly as the slider constrains a drag.
      const bounded = param.min != null && param.max != null && param.max > param.min;
      const isInt = param.type === 'integer';
      if (!bounded) {
        // No slider ⇒ the field is the whole cell. `.paramWidget > input[type=text]`
        // sizes it (elastic, min 0), so it still cannot be pushed by its digits.
        return (
          <InlineNumberInput
            value={value ?? ''}
            onChange={onChange}
            step={isInt ? 1 : 'any'}
          />
        );
      }
      const min = param.min!, max = param.max!;
      const n = Number(value);
      const cur = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
      // Slider + field as SIBLINGS of the reset slot, not nested in a wrapper:
      // one flex context means the field's FIXED width and the slider's
      // elasticity are decided against the row, not against a sub-box whose own
      // width would then have to be pinned too.
      return (
        <>
          <input
            type="range"
            className={styles.paramSlider}
            min={min} max={max}
            step={isInt ? 1 : (max - min) / 100}
            value={cur}
            title={`${min} – ${max}`}
            onChange={e => {
              const v = Number(e.target.value);
              onChange(String(isInt ? Math.round(v) : v));
            }}
          />
          <NumberField
            className={styles.paramNumber}
            integer={isInt}
            min={min} max={max}
            value={cur}
            onNumber={v => onChange(String(v))}
          />
        </>
      );
    }
  }
}
