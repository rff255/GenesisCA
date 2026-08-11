import type { CAModel, InputMappingParam } from '../model/types';
import {
  paramFallbackValue, paramTagOptions,
  type InputParamValues, type ResolvedInputParams,
} from '../model/inputMappingParams';
import { InlineBoolSelect, InlineNumberInput, InlineTagSelect } from '../modeler/vpl/widgets/InlineWidgets';
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
 * Used for the CELL brush and the AGENT Paint brush alike (constraint: cells and
 * agents must end up consistent).
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
      {resolved.params.map(({ param }) => (
        <div key={param.key} className={`${styles.manualBrushRow} ${styles.manualBrushRowDense}`}>
          <div className={styles.manualBrushLabel}>
            <div className={styles.manualBrushName} title={param.description || undefined}>{param.name || param.key}</div>
          </div>
          <div className={styles.manualBrushWidget}>
            <ParamWidget
              param={param}
              value={values[param.key] ?? paramFallbackValue(param)}
              onChange={v => setValue(param.key, v)}
              model={model}
            />
          </div>
        </div>
      ))}
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
      return <ColorField value={value || '#000000'} onChange={onChange} noAlpha title={param.name || param.key} />;
    case 'integer':
    case 'float':
    default:
      return (
        <InlineNumberInput
          value={value ?? ''}
          onChange={onChange}
          step={param.type === 'float' ? 'any' : 1}
        />
      );
  }
}
