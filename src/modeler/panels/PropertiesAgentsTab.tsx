import { useState } from 'react';
import { useModel } from '../../model/ModelContext';
import { NumberField } from '../vpl/widgets/InlineWidgets';
import {
  cbNum, usesBondingPhysics, resolveMaxBonds, effectiveAgentDt, BOND_REQUEST_DEPTH_MAX,
  CENTER_BASED_DEFAULTS, layoutIterationsOf, MAX_LAYOUT_ITERATIONS,
} from '../../model/centerBased';
import type { CenterBasedNumericKey } from '../../model/centerBased';
import { resolveAgentProfile, applyCapabilityEdit } from '../../model/agentCapabilities';
import { AgentCapabilitiesSection } from './AgentCapabilitiesSection';
import {
  Section, ToggleCard, Segmented, Field, FieldRow, Hint, SubLabel, CheckRow, Advanced,
} from './propertiesWidgets';
import styles from './PanelContent.module.css';

/**
 * Properties › Agents — "how do agents behave?". Rendered only while the
 * Bond-Graph Agents layer is on (the shell hides the tab otherwise). The
 * capability profile comes first so the user chooses their paradigm before
 * tuning numbers; the engine + update mode live in Execution.
 */
export function PropertiesAgentsTab() {
  const { model, updateCenterBased } = useModel();
  const cb = model.centerBased;
  // "Use bonding physics" master toggle: when off, the engine applies NO built-in
  // forces (soft-sphere / springs / growth / auto-bond) and the Forces + Bonds rows
  // are hidden — agents move only by the graph's Apply Force / Set Velocity.
  const bonding = usesBondingPhysics(cb);
  // Seed Pattern = None ⇒ the Reset seeding is off entirely, so Seed Count has
  // nothing to act on. Absent ⇒ 'compact', matching the engine's default.
  const seedPattern = cb?.seedPattern ?? 'compact';
  const seedingOff = seedPattern === 'none';
  const [advOpen, setAdvOpen] = useState(false);
  const eff = effectiveAgentDt(cb);

  const num = (k: CenterBasedNumericKey) => cbNum(cb, k);
  const NF = (k: CenterBasedNumericKey, opts?: { min?: number; max?: number; step?: number; integer?: boolean }) => (
    <NumberField
      className={`${styles.numberInput} ${styles.numSmall}`}
      value={num(k)}
      min={opts?.min}
      max={opts?.max}
      step={opts?.step}
      integer={opts?.integer}
      onNumber={n => updateCenterBased({ [k]: n })}
    />
  );

  return (
    <>
      <Section id="agents.profile" title="Capability profile">
        {/* The preset picker + capability toggles. The editor surface (palette /
            Behaviour-Step ports / Edit-panel rows) filters to what is on. */}
        <AgentCapabilitiesSection model={model} updateCenterBased={updateCenterBased} />
      </Section>

      <Section id="agents.population" title="Population">
        <div className={styles.fieldGroup}>
          <SubLabel>Capacity</SubLabel>
          <FieldRow label="Max agents" title="Over-allocated ceiling; overflow rejects (never wraps). Changing it re-inits the engine.">
            {NF('maxAgents', { min: 1, integer: true })}
          </FieldRow>
          <FieldRow label="Max bonds / agent" title="0 = no bonds (pure-force / charged-particle models); the bond store is then not allocated. Changing it re-inits the engine.">
            {NF('maxBonds', { min: 0, integer: true })}
          </FieldRow>
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
            <NumberField
              className={`${styles.numberInput} ${styles.numSmall}`}
              value={num('seedCount')} min={0} integer
              disabled={seedingOff}
              onNumber={n => updateCenterBased({ seedCount: n })}
            />
          </FieldRow>
          <FieldRow label="Default radius" title="Radius of seeded agents — and of the Add brush and Create Agent.">
            {NF('defaultRadius', { min: 0.01, step: 0.1 })}
          </FieldRow>
        </div>
      </Section>

      <Section id="agents.motion" title="Motion">
        <div className={styles.fieldGroup}>
          {/* The velocity integrator; relevant to EVERY agent model (a custom-force
              boids model lives entirely here), so always shown. */}
          <FieldRow label="Momentum (friction)" title="Velocity retained per step — THIS is the friction / damping control. Below 1 the velocity decays geometrically, so a constant force settles at the finite terminal speed (Δt/η)·F / (1 − momentum): 0 = fully overdamped (tissue), ~0.9 = flocking inertia, 0.999 (the cap) ≈ frictionless. Agents that accelerate forever mean momentum is too close to 1 — lower it.">
            {NF('momentum', { min: 0, max: 0.999, step: 0.05 })}
          </FieldRow>
          <FieldRow label="Max speed" title="Per-step speed cap (0 = uncapped).">
            {NF('maxSpeed', { min: 0, step: 0.1 })}
          </FieldRow>
          <FieldRow label="Neighbour query radius" title="The Get Nearby Agents radius the spatial-hash bin is sized to cover. A query above it silently under-counts.">
            {NF('neighbourQueryRadius', { min: 1, step: 0.5 })}
          </FieldRow>
          <FieldRow label="Time step Δt" title="Integration step. Auto-clamped against the stability bound Δt ≤ 0.2 / (Repulsion μ + Bond λ) — the same helper the engine's clamp uses.">
            {NF('timeStep', { min: 0.001, step: 0.05 })}
          </FieldRow>
          {/* C1 (P4) — no silent resolution: when the stability bound actually
              REDUCES Δt, show the number the engine runs and why. */}
          {eff.clamped
            ? <Hint warn>→ effective Δt <b>{Number(eff.dt.toPrecision(4))}</b> — clamped from {eff.requested} for stability (μ_eff = {Number(eff.muEff.toPrecision(4))})</Hint>
            : <Hint>Stability bound {Number(eff.bound.toPrecision(4))} — not binding.</Hint>}
          <FieldRow label="Drag η" title="Overdamped drag (scales force → velocity).">
            {NF('drag', { min: 0.01, step: 0.1 })}
          </FieldRow>
        </div>
      </Section>

      <Section id="agents.bonding" title="Bonding physics">
        {/* Use bonding physics master toggle. OFF = no engine forces (agents move
            only by graph forces); the Forces + Bonds rows appear only when ON. */}
        <ToggleCard
          title="Use bonding physics"
          on={bonding}
          onChange={on => {
            // Enabling bonding with no bond capacity is a foot-gun (nothing can
            // bond). Bump maxBonds to the engine default when turning it on and
            // the store is still empty.
            const bumpBonds = on && (cb?.maxBonds ?? 0) <= 0;
            updateCenterBased(bumpBonds ? { useBondingPhysics: on, maxBonds: CENTER_BASED_DEFAULTS.maxBonds } : { useBondingPhysics: on });
          }}
          line="Engine soft-sphere repulsion / adhesion, bond springs, growth and auto-bond. Off: agents move only by graph-authored Apply Force / Set Velocity."
        >
          <SubLabel>Forces</SubLabel>
          <FieldRow label="Repulsion μ" title="Volume-exclusion stiffness (soft-sphere).">{NF('repulsionStiffness', { min: 0, step: 0.1 })}</FieldRow>
          <FieldRow label="Adhesion μ" title="Free-agent stickiness (0 = cohesion via bonds only).">{NF('adhesionStiffness', { min: 0, step: 0.1 })}</FieldRow>
          <FieldRow label="Interaction range" title="× contact distance — the pair-force cutoff. A multiplier, not a distance.">{NF('interactionRange', { min: 1, step: 0.1 })}</FieldRow>
          <FieldRow label="Growth rate" title="Radius units per step toward the target radius.">{NF('growthRate', { min: 0, step: 0.01 })}</FieldRow>
          <SubLabel>Bonds</SubLabel>
          <CheckRow
            checked={!!cb?.autoBond}
            onChange={on => {
              // Auto-bond FORMS bonds, so reconcile the Agent Capability profile —
              // turning it on sets Bonds = Physics so the profile isn't left 'off'
              // (which drops the bond store and would SILENTLY disable auto-bonding).
              updateCenterBased(on
                ? { autoBond: true, agentCapabilities: applyCapabilityEdit(resolveAgentProfile(model), 'bonds', 'physics') }
                : { autoBond: false });
            }}
            label="Auto-bond by distance"
            title="Bond agents within the form distance; break past the break distance (hysteresis). The simplest path to a glued cluster."
          />
          <FieldRow label="Bond stiffness λ" title="Spring stiffness — the spring force is λ(l − L).">{NF('bondStiffness', { min: 0, step: 0.1 })}</FieldRow>
          <FieldRow label="Bond rest length" title="Spring rest length L for new bonds.">{NF('bondRestLength', { min: 0, step: 0.1 })}</FieldRow>
          <FieldRow label="Form distance" title="× contact — auto-bond within this.">{NF('formDistance', { min: 1, step: 0.05 })}</FieldRow>
          <FieldRow label="Break distance" title="× contact — auto-bond breaks past this (> form: hysteresis).">{NF('breakDistance', { min: 1, step: 0.05 })}</FieldRow>
        </ToggleCard>
      </Section>

      <Advanced open={advOpen} onToggle={() => setAdvOpen(o => !o)} title="Solver and queue knobs — numerical, never semantic">
        {/* Solver relaxation — an ENGINE knob, not a capability and not a graph
            node: how many times the force integrator runs per generation. Age,
            growth and the structural phase still advance exactly ONCE. */}
        <FieldRow label="Layout iterations" title="Force-pass runs per generation (1 = one pass, the default). Purely numerical relaxation: age, growth and the structural phase (bond form/break/rewire, division, death) still advance exactly ONCE per generation. A rule's own cadence belongs in the graph, as an Agent Periodic Step.">
          <NumberField
            className={`${styles.numberInput} ${styles.numSmall}`}
            value={layoutIterationsOf(cb)}
            onNumber={n => updateCenterBased({ layoutIterations: n })}
            min={1} max={MAX_LAYOUT_ITERATIONS} integer step={1}
          />
        </FieldRow>
        {/* GRA P4 — the per-agent structural-request QUEUE depth. Only
            meaningful once bonds exist. */}
        {resolveMaxBonds(cb) > 0 && (
          <FieldRow label="Bond requests / agent / step" title="How many Form / Break / Rewire Bond ops one agent may issue in ONE step — graph rewrites (triangle split, edge swap) need several at once. Ops past this are rejected whole with a notice. Changing it re-inits the engine.">
            {NF('bondRequestDepth', { min: 1, max: BOND_REQUEST_DEPTH_MAX, integer: true })}
          </FieldRow>
        )}
      </Advanced>
    </>
  );
}
