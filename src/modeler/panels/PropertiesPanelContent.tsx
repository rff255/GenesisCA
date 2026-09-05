import { useEffect, useMemo, useState } from 'react';
import { useModel } from '../../model/ModelContext';
import type { PanelContentProps } from '../ModelerDetailContext';
import { modelerUiState } from '../modelerUiState';
import { SubTabs, PROPERTIES_TABS, type PropertiesTab } from './propertiesWidgets';
import { PropertiesSetupTab } from './PropertiesSetupTab';
import { PropertiesExecutionTab } from './PropertiesExecutionTab';
import { PropertiesAgentsTab } from './PropertiesAgentsTab';
import { PropertiesDiagnosticsTab } from './PropertiesDiagnosticsTab';
import styles from './PanelContent.module.css';

/**
 * The Properties panel — a thin shell: a sub-tab strip + routing. The bodies
 * live in PropertiesSetupTab / PropertiesExecutionTab / PropertiesAgentsTab /
 * PropertiesDiagnosticsTab; the shared primitives in propertiesWidgets.tsx.
 * See docs/PLAN_PROPERTIES_PANEL_REFACTOR.md.
 *
 * Properties is NOT master-detail any more — Indicators (and End Conditions)
 * moved to their own left-bar tab (IndicatorsPanelContent). The shell still
 * accepts `mode` so ModelerView's panel table stays uniform.
 *
 * The active sub-tab lives in `modelerUiState.propertiesTab` (the panel is
 * rebuilt on every mount — a Simulator round-trip, closing and reopening the
 * panel — so plain useState would forget it). The Agents sub-tab exists only
 * while the Bond-Graph Agents layer is on; if the layer turns off while it is
 * showing, the shell falls back to Setup (where the layer switch lives).
 */
export function PropertiesPanelContent({ mode = 'list' }: PanelContentProps = {}) {
  const { model } = useModel();
  const agentsOn = !!model.topologyMode?.agents;
  const tabs = useMemo(() => PROPERTIES_TABS.filter(t => t !== 'agents' || agentsOn), [agentsOn]);
  const [tab, setTabState] = useState<PropertiesTab>(() => modelerUiState.propertiesTab);
  const setTab = (t: PropertiesTab) => { modelerUiState.propertiesTab = t; setTabState(t); };
  useEffect(() => {
    if (!agentsOn && tab === 'agents') setTab('setup');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentsOn, tab]);
  if (mode === 'detail') return null;
  const shown: PropertiesTab = !agentsOn && tab === 'agents' ? 'setup' : tab;
  return (
    <div className={styles.fieldGroup}>
      <SubTabs value={shown} tabs={tabs} onChange={setTab} />
      {shown === 'setup' && <PropertiesSetupTab onOpenAgentsTab={() => setTab('agents')} />}
      {shown === 'execution' && <PropertiesExecutionTab />}
      {shown === 'agents' && <PropertiesAgentsTab />}
      {shown === 'diagnostics' && <PropertiesDiagnosticsTab />}
    </div>
  );
}
