import { useState } from 'react';
import { useModel } from '../../model/ModelContext';
import { NumberField } from '../vpl/widgets/InlineWidgets';
import {
  cbNum, resolveMaxBonds, effectiveAgentDt, BOND_REQUEST_DEPTH_MAX,
  layoutIterationsOf, MAX_LAYOUT_ITERATIONS,
} from '../../model/centerBased';
import type { CenterBasedNumericKey } from '../../model/centerBased';
import { resolveAgentProfile } from '../../model/agentCapabilities';
import { AgentCapabilitiesSection } from './AgentCapabilitiesSection';
import {
  Section, Segmented, Field, FieldRow, Hint, SubLabel, Advanced,
} from './propertiesWidgets';
import styles from './PanelContent.module.css';

/**
 * Properties › Agents — "how do agents behave?". Rendered only while the
 * Bond-Graph Agents layer is on (the shell hides the tab otherwise).
 *
 * The Capability profile comes first and OWNS every physics knob: collision
 * stiffness, adhesion, springs, auto-bond, growth and the neighbour query radius
 * are revealed under the capability row that makes them live (see
 * AgentCapabilitiesSection). What is left here is what applies to EVERY agent
 * model regardless of profile — the population and the integrator — plus the
 * numerical solver knobs under Advanced. The engine + update mode live in
 * Execution.
 *
 * The doctrine throughout: an enabled control must do something. A row the
 * current profile makes inert is greyed IN PLACE with the reason on its tooltip
 * (the control that revives it is one section up), never hidden.
 */
export function PropertiesAgentsTab() {
  const { model, updateCenterBased } = useModel();
  const cb = model.centerBased;
  const profile = resolveAgentProfile(model);
  const motion = profile.motion;
  const integrates = motion !== 'static';
  const forces = motion === 'force';
  // Seed Pattern = None ⇒ the Reset seeding is off entirely, so Seed Count has
  // nothing to act on. Absent ⇒ 'compact', matching the engine's default.
  const seedPattern = cb?.seedPattern ?? 'compact';
  const seedingOff = seedPattern === 'none';
  const [advOpen, setAdvOpen] = useState(false);
  const eff = effectiveAgentDt(cb);
  // The bond store the ENGINE allocates (the resolver every consumer reads) vs
  // the ceiling the user typed. They differ exactly when the Bonds capability is
  // Off: the store is then 0 whatever the field says, so the field is inert.
  const bondStore = resolveMaxBonds(cb);
  const bondsCapOn = profile.bonds !== 'off';
  const maxBondsInert = !bondsCapOn && cbNum(cb, 'maxBonds') > 0;

  const num = (k: CenterBasedNumericKey) => cbNum(cb, k);
  const NF = (k: CenterBasedNumericKey, opts?: { min?: number; max?: number; step?: number; integer?: boolean; disabled?: boolean }) => (
    <NumberField
      className={`${styles.numberInput} ${styles.numSmall}`}
      value={num(k)}
      min={opts?.min}
      max={opts?.max}
      step={opts?.step}
      integer={opts?.integer}
      disabled={opts?.disabled}
      onNumber={n => updateCenterBased({ [k]: n })}
    />
  );

  const staticReason = 'Motion is Static (Capability profile) — the engine never moves positions, so the integrator does not run. Only Set Agent Position moves an agent.';
  const velocityReason = 'Motion is Velocity (Capability profile) — the graph sets the velocity directly and the engine adds it to the position; momentum, Δt and drag apply only under Motion = Force.';
  const integratorMuted = !forces;
  const integratorReason = !integrates ? staticReason : velocityReason;

  return (
    <>
      <Section id="agents.profile" title="Capability profile">
        {/* The preset picker + capability toggles + each capability's OWN knobs.
            The editor surface (palette / Behaviour-Step ports / Edit-panel rows)
            filters to what is on. */}
        <AgentCapabilitiesSection model={model} updateCenterBased={updateCenterBased} />
      </Section>

      <Section id="agents.population" title="Population">
        <div className={styles.fieldGroup}>
          <SubLabel>Capacity</SubLabel>
          <FieldRow label="Max agents" title="Over-allocated ceiling; overflow rejects (never wraps). Changing it re-inits the engine.">
            {NF('maxAgents', { min: 1, integer: true })}
          </FieldRow>
          {/* The ceiling is inert while the Bonds capability is Off — the engine
              resolves the store to 0 whatever is typed here. The control that
              revives it is the Bonds row in the Capability profile above, so it
              is greyed in place with that reason, never hidden. */}
          <FieldRow
            label="Max bonds / agent"
            muted={maxBondsInert}
            title={maxBondsInert
              ? `The Bonds capability is Off (Capability profile), so no bond store is allocated — the engine resolves this to 0 whatever it says. Set Bonds to Data or Physics to use the ${cbNum(cb, 'maxBonds')} you typed.`
              : 'Per-agent bond capacity — the bond store is allocated maxAgents × this. 0 = no bonds at all (pure-force / charged-particle models; the store is then not allocated). Changing it re-inits the engine.'}
          >
            {NF('maxBonds', { min: 0, integer: true, disabled: maxBondsInert })}
          </FieldRow>
          {bondsCapOn && bondStore === 0 && (
            <Hint warn>Bonds are on but the ceiling is 0, so no bond store exists and nothing can bond — set Max bonds / agent to 1 or more.</Hint>
          )}
          <SubLabel>Seeding</SubLabel>
          <Field label="Seed pattern" title="How the Reset population is laid out. Compact = a centred packed blob (the tissue start). Scatter = uniformly random across the world (flocking / chemotaxis). None = no automatic seeding — spawn via the Agent Init Event or the Add brush; Reset leaves the world empty.">
            <Segmented
              ariaLabel="Seed pattern"
              value={seedPattern}
              onChange={v => updateCenterBased({ seedPattern: v as 'compact' | 'scatter' | 'none' })}
              options={[
                { value: 'compact', label: 'Compact', title: 'Centred packed blob — the morphogenesis / tissue start.' },
                { value: 'scatter', label: 'Scatter', title: 'Uniformly random across the world — dispersed flocking / chemotaxis populations.' },
                { value: 'none', label: 'None', title: 'No automatic seeding — spawn via the Agent Init Event or the Add brush. Reset leaves the world empty.' },
              ]}
            />
          </Field>
          {/* Seed Count is INERT under Seed Pattern = None, and the segment that
              makes it live is the adjacent control — so it is DISABLED IN PLACE
              with the reason in its tooltip, never hidden. */}
          <FieldRow
            label="Seed count"
            muted={seedingOff}
            title={seedingOff ? 'Seed pattern is None — no agents are laid down on Reset. Pick Compact or Scatter to use this count.' : 'Agents laid down on Reset (0 = seed via the brush).'}
          >
            {NF('seedCount', { min: 0, integer: true, disabled: seedingOff })}
          </FieldRow>
          <FieldRow label="Default radius" title="Radius of seeded agents — and of the Add brush and Create Agent.">
            {NF('defaultRadius', { min: 0.01, step: 0.1 })}
          </FieldRow>
        </div>
      </Section>

      <Section id="agents.motion" title="Motion">
        <div className={styles.fieldGroup}>
          {/* The integrator. Which of these rows the engine reads depends on the
              Motion capability: Force reads all of them, Velocity only the speed
              cap, Static none. Inert rows are greyed in place with the reason —
              the Motion segment that revives them is one section up. */}
          {!integrates && <Hint>Motion is Static — nothing below runs. Agents move only when the rule calls Set Agent Position.</Hint>}
          {integrates && !forces && <Hint>Motion is Velocity — the graph-set velocity is added to the position each step. Only the speed cap applies.</Hint>}
          <FieldRow
            label="Momentum (friction)"
            muted={integratorMuted}
            title={integratorMuted ? integratorReason : 'Velocity retained per step — THIS is the friction / damping control. Below 1 the velocity decays geometrically, so a constant force settles at the finite terminal speed (Δt/η)·F / (1 − momentum): 0 = fully overdamped (tissue), ~0.9 = flocking inertia, 0.999 (the cap) ≈ frictionless. Agents that accelerate forever mean momentum is too close to 1 — lower it.'}
          >
            {NF('momentum', { min: 0, max: 0.999, step: 0.05, disabled: integratorMuted })}
          </FieldRow>
          <FieldRow
            label="Max speed"
            muted={!integrates}
            title={!integrates ? staticReason : 'Per-step speed cap (0 = uncapped). Applies under Force and Velocity motion alike.'}
          >
            {NF('maxSpeed', { min: 0, step: 0.1, disabled: !integrates })}
          </FieldRow>
          <FieldRow
            label="Time step Δt"
            muted={integratorMuted}
            title={integratorMuted ? integratorReason : 'Integration step. Auto-clamped against the stability bound Δt ≤ 0.2 / (Repulsion μ + Bond λ) — the same helper the engine\'s clamp uses.'}
          >
            {NF('timeStep', { min: 0.001, step: 0.05, disabled: integratorMuted })}
          </FieldRow>
          {/* C1 (P4) — no silent resolution: when the stability bound actually
              REDUCES Δt, show the number the engine runs and why. Only meaningful
              under Force motion (the only mode that integrates Δt). */}
          {forces && (eff.clamped
            ? <Hint warn>→ effective Δt <b>{Number(eff.dt.toPrecision(4))}</b> — clamped from {eff.requested} for stability (μ_eff = {Number(eff.muEff.toPrecision(4))})</Hint>
            : <Hint>Stability bound {Number(eff.bound.toPrecision(4))} — not binding.</Hint>)}
          <FieldRow
            label="Drag η"
            muted={integratorMuted}
            title={integratorMuted ? integratorReason : 'Overdamped drag (scales force → velocity).'}
          >
            {NF('drag', { min: 0.01, step: 0.1, disabled: integratorMuted })}
          </FieldRow>
        </div>
      </Section>

      <Advanced open={advOpen} onToggle={() => setAdvOpen(o => !o)} title="Solver and queue knobs — numerical, never semantic">
        {/* Solver relaxation — an ENGINE knob, not a capability and not a graph
            node: how many times the force integrator runs per generation. Age,
            growth and the structural phase still advance exactly ONCE. */}
        <FieldRow
          label="Layout iterations"
          muted={!forces}
          title={!forces
            ? integratorReason
            : 'Force-pass runs per generation (1 = one pass, the default). Purely numerical relaxation: age, growth and the structural phase (bond form/break/rewire, division, death) still advance exactly ONCE per generation. A rule\'s own cadence belongs in the graph, as an Agent Periodic Step.'}
        >
          <NumberField
            className={`${styles.numberInput} ${styles.numSmall}`}
            value={layoutIterationsOf(cb)}
            onNumber={n => updateCenterBased({ layoutIterations: n })}
            min={1} max={MAX_LAYOUT_ITERATIONS} integer step={1}
            disabled={!forces}
          />
        </FieldRow>
        {/* GRA P4 — the per-agent structural-request QUEUE depth. Only
            meaningful once a bond store exists. */}
        {bondStore > 0 && (
          <FieldRow label="Bond requests / agent / step" title="How many Form / Break / Rewire Bond ops one agent may issue in ONE step — graph rewrites (triangle split, edge swap) need several at once. Ops past this are rejected whole with a notice. Changing it re-inits the engine.">
            {NF('bondRequestDepth', { min: 1, max: BOND_REQUEST_DEPTH_MAX, integer: true })}
          </FieldRow>
        )}
      </Advanced>
    </>
  );
}
