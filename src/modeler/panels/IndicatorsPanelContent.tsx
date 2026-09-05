import { IndicatorsPanelSection } from './IndicatorsPanelSection';
import { EndConditionsSection } from './EndConditionsSection';
import { useDetailSelection, type PanelContentProps } from '../ModelerDetailContext';
import { Section } from './propertiesWidgets';
import styles from './PanelContent.module.css';

/**
 * The Indicators panel — a left-bar tab of its own (it used to be the fifth
 * section of Properties). Master-detail: the LIST renders here, the selected
 * indicator's editor in the shared second panel; its selection rides the
 * `'indicators'` detail slot as a bare id. End Conditions — the measurement
 * layer's stop rules — is its second section, under the list it references.
 */
export function IndicatorsPanelContent({ mode = 'list' }: PanelContentProps = {}) {
  const [selId, setSelId] = useDetailSelection('indicators');
  if (mode === 'detail') {
    return <IndicatorsPanelSection mode="detail" selectedId={selId} onSelect={setSelId} />;
  }
  return (
    <div className={styles.fieldGroup}>
      <IndicatorsPanelSection mode="list" selectedId={selId} onSelect={setSelId} />
      <Section id="indicators.end" title="End Conditions">
        <EndConditionsSection />
      </Section>
    </div>
  );
}
