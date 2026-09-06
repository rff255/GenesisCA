import type { CSSProperties } from 'react';
import type { CAModel, CenterBasedConfig, AgentCapabilities, CollisionMode, BondsMode, MotionMode } from '../../model/types';
import {
  AGENT_PRESETS, AGENT_PRESET_META, AGENT_CAPABILITY_ROWS, HIDDEN_CAP_ROWS_V1,
  resolveAgentProfile, matchAgentPreset, applyCapabilityEdit,
  capabilityClosureDrivers, capabilityRowLabel,
  type AgentPresetKey, type BoolCapKey,
} from '../../model/agentCapabilities';
import {
  cbNum, usesBondingPhysics, CENTER_BASED_DEFAULTS,
  chargeStrengthOf, chargeMaxDistOf, CHARGE_MAX_DIST_REST_MULTIPLE, chargeRangeOf, chargeThetaOf,
  MIN_CHARGE_THETA, MAX_CHARGE_THETA,
  type CenterBasedNumericKey,
} from '../../model/centerBased';
import { NumberField } from '../vpl/widgets/InlineWidgets';
import { Segmented, FieldRow, Hint, SubLabel, CheckRow, SubBlock } from './propertiesWidgets';
import styles from './PanelContent.module.css';

/**
 * Properties › Agents › Capability profile — the preset picker + one row per
 * capability, and EACH ROW OWNS ITS TUNING KNOBS. The engine reads collision
 * from the profile (`usesSoftCollision`), springs from Bonds = Physics
 * (`usesEngineSprings`), growth from the Growth capability
 * (`usesEngineGrowth`), auto-bond from springs + `cfg.autoBond` — so the
 * stiffness / rest length / growth rate / auto-bond distances are revealed
 * under the capability that makes them live, never behind a separate toggle
 * (a hidden knob that is LIVE is the same defect as a visible knob that is
 * inert). The ONE legacy flag that still drives the engine on its own is
 * `useBondingPhysics`, which today governs only ADHESION (μ_A) — it renders as
 * the Adhesion row, next to Collision, and says so.
 */
export function AgentCapabilitiesSection({
  model, updateCenterBased,
}: {
  model: CAModel;
  updateCenterBased: (changes: Partial<CenterBasedConfig>) => void;
}) {
  const cb = model.centerBased;
  const profile = resolveAgentProfile(model);
  const activePreset = matchAgentPreset(profile);
  const set = (next: AgentCapabilities) => updateCenterBased({ agentCapabilities: next });
  const edit = <K extends keyof AgentCapabilities>(key: K, value: AgentCapabilities[K]) =>
    set(applyCapabilityEdit(profile, key, value));
  const forceMode = profile.motion === 'force';
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

  // C1 (P4 — no silent resolution): which capabilities were auto-enabled BY the
  // closure, and by what. DERIVED from `computeCapabilityClosure` itself (probe
  // each enabled capability in isolation and see what it forces), so this can
  // never go stale against the real dependency rules.
  const drivers = capabilityClosureDrivers(profile);
  const requiredBy = (key: keyof AgentCapabilities) => {
    const d = drivers[key];
    if (!d || d.length === 0) return null;
    return (
      <span
        style={{ color: 'var(--color-accent)', fontSize: 'var(--font-3xs)' }}
        title={`Turned on automatically because ${d.map(capabilityRowLabel).join(' / ')} require${d.length === 1 ? 's' : ''} it. Turning ${d.length === 1 ? 'that' : 'those'} off releases it.`}
      > (required by {d.map(capabilityRowLabel).join(', ')})</span>
    );
  };
  const rowTitle = (row: { description: string; requires?: string }) =>
    row.description + (row.requires ? ` Requires ${row.requires}.` : '');

  const presetDesc = activePreset === 'custom'
    ? 'A custom mix — edit any toggle and the picker stays on Custom.'
    : (AGENT_PRESET_META.find(m => m.key === activePreset)?.description ?? '');

  const chipStyle = (key: AgentPresetKey | 'custom'): CSSProperties => ({
    fontSize: 'var(--font-2xs)', padding: '3px 8px', borderRadius: 999,
    cursor: key === 'custom' ? 'default' : 'pointer',
    border: `1px solid ${activePreset === key ? 'var(--color-accent)' : 'var(--color-widget-border)'}`,
    background: activePreset === key ? 'var(--color-accent-soft)' : 'transparent',
    color: activePreset === key ? 'var(--color-accent)' : 'var(--color-text-secondary)',
    opacity: key === 'custom' && activePreset !== 'custom' ? 0.4 : 1,
  });

  const selStyle: CSSProperties = { flex: '0 0 auto', maxWidth: 150 };
  const softOn = profile.collision === 'soft';
  const adhesionOn = usesBondingPhysics(cb);
  const chargeOn = profile.charge === 'on';
  const rangeRow = (
    <FieldRow label="Interaction range" title="× contact distance — the pair-force cutoff for repulsion and adhesion. A multiplier, not a distance.">
      {NF('interactionRange', { min: 1, step: 0.1 })}
    </FieldRow>
  );

  return (
    <div className={styles.fieldGroup}>
      <div>
        <SubLabel>Preset</SubLabel>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          {AGENT_PRESET_META.map(m => (
            <button key={m.key} type="button" style={chipStyle(m.key)} title={m.description} onClick={() => set({ ...AGENT_PRESETS[m.key] })}>{m.label}</button>
          ))}
          <button type="button" style={chipStyle('custom')} disabled title="Any toggle edit that stops matching a preset lands here.">Custom</button>
        </div>
        <Hint>{presetDesc}</Hint>
      </div>

      {/* Motion — the integrator. Static skips the force pass AND the position
          commit (Set Agent Position is the only mover); Velocity adds the
          graph-set velocity to the position with no engine force; Force
          accumulates forces into velocity (C9 / STEP 6 shipped all three). */}
      <div>
        <SubLabel>Motion{requiredBy('motion')}</SubLabel>
        <Segmented<MotionMode>
          ariaLabel="Motion mode"
          value={profile.motion}
          onChange={mode => edit('motion', mode)}
          options={[
            { value: 'static', label: 'Static', title: 'The engine never moves positions — only Set Agent Position does. No forces, no velocity integration.' },
            { value: 'velocity', label: 'Velocity', title: 'The graph sets a velocity (Set Velocity) and the engine adds it to the position each step. No engine forces — momentum, Δt and drag do not apply.' },
            { value: 'force', label: 'Force', title: 'Forces accumulate into velocity: Apply Force plus the engine’s own (collision, adhesion, springs, charge), integrated with momentum, Δt and drag.' },
          ]}
        />
        <Hint>
          {profile.motion === 'static'
            ? 'Nothing moves on its own — the rule places agents with Set Agent Position.'
            : profile.motion === 'velocity'
              ? 'The graph-set velocity is added to the position each step; no engine forces.'
              : 'Apply Force + the engine forces integrate into velocity (see the Motion section below).'}
        </Hint>
      </div>

      <div className={styles.fieldGroup}>
        <SubLabel>Capabilities</SubLabel>
        {AGENT_CAPABILITY_ROWS.filter(row => !HIDDEN_CAP_ROWS_V1.has(row.key) && row.key !== 'autoBond').map(row => {
          const k = row.key;
          const label = <>{row.label}{requiredBy(k)}</>;

          if (k === 'collision') {
            return (
              <div key={k}>
                <FieldRow label={row.label} title={rowTitle(row)}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    {requiredBy(k)}
                    <select className={styles.selectInput} style={selStyle} value={profile.collision} onChange={e => edit('collision', e.target.value as CollisionMode)}>
                      <option value="off">Off</option>
                      <option value="soft">Soft-sphere (force)</option>
                      <option value="positional">Positional (hard)</option>
                    </select>
                  </span>
                </FieldRow>
                {softOn && (
                  <SubBlock>
                    <FieldRow label="Repulsion μ" title="Volume-exclusion stiffness of the soft-sphere force.">{NF('repulsionStiffness', { min: 0, step: 0.1 })}</FieldRow>
                    {rangeRow}
                  </SubBlock>
                )}
                {profile.collision === 'positional' && (
                  <SubBlock>
                    <FieldRow label="Positional iterations" title="Jacobi projection sweeps per step — more = tighter no-overlap packing.">
                      {NF('positionalIterations', { min: 1, max: 16, integer: true, step: 1 })}
                    </FieldRow>
                  </SubBlock>
                )}
                {/* Adhesion — the ONE thing the legacy `useBondingPhysics` flag still
                    governs on its own (no capability covers it yet). An engine
                    force, so it needs Motion = Force. */}
                <div style={{ marginTop: 'var(--space-3)' }}>
                  <CheckRow
                    checked={adhesionOn}
                    onChange={on => updateCenterBased({ useBondingPhysics: on })}
                    label="Adhesion"
                    disabled={!forceMode}
                    title={forceMode
                      ? 'Free-agent stickiness: a short-range attraction between touching agents that are NOT bonded (the μ_A term of the soft-sphere law, between contact distance and Interaction range × contact). No capability governs adhesion yet — this is the legacy “Use bonding physics” flag, which today controls only this.'
                      : 'Adhesion is an engine force — set Motion to Force to use it.'}
                  />
                  {adhesionOn && forceMode && (
                    <SubBlock>
                      <FieldRow label="Adhesion μ" title="Free-agent stickiness (0 = cohesion via bonds only).">{NF('adhesionStiffness', { min: 0, step: 0.1 })}</FieldRow>
                      {!softOn && rangeRow}
                    </SubBlock>
                  )}
                </div>
              </div>
            );
          }

          if (k === 'bonds') {
            return (
              <div key={k}>
                <FieldRow label={row.label} title={rowTitle(row)}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    {requiredBy(k)}
                    <select className={styles.selectInput} style={selStyle} value={profile.bonds} onChange={e => {
                      const v = e.target.value as BondsMode;
                      const next = applyCapabilityEdit(profile, 'bonds', v);
                      // Below Physics the engine cannot auto-bond (auto-bond forms
                      // SPRING bonds), so clear the config flag with the profile's —
                      // it also lets `resolveMaxBonds` actually drop the store. Turning
                      // bonds ON with a 0 ceiling would allocate no store (nothing
                      // could ever bond), so bump it to the engine default then.
                      const bump = v !== 'off' && (cb?.maxBonds ?? 0) <= 0 ? { maxBonds: CENTER_BASED_DEFAULTS.maxBonds } : {};
                      updateCenterBased(v === 'physics' ? { agentCapabilities: next, ...bump } : { agentCapabilities: next, autoBond: false, ...bump });
                    }}>
                      <option value="off">Off</option>
                      <option value="data">Data (edges)</option>
                      <option value="physics">Physics (springs)</option>
                    </select>
                  </span>
                </FieldRow>
                {profile.bonds === 'data' && <Hint>Edges only — no spring force. Form / Break Bond, For Each Bond and the bond attributes all work.</Hint>}
                {profile.bonds === 'physics' && (
                  <SubBlock>
                    <FieldRow label="Bond stiffness λ" title="Spring stiffness — the spring force is λ(l − L).">{NF('bondStiffness', { min: 0, step: 0.1 })}</FieldRow>
                    <FieldRow label="Bond rest length" title="Spring rest length L for new bonds.">{NF('bondRestLength', { min: 0, step: 0.1 })}</FieldRow>
                    {/* The engine reads `cfg.autoBond` (with springs on); the profile's
                        `autoBond` is the closure's mirror of it. ONE checkbox writes
                        BOTH so they cannot drift — the profile row alone used to leave
                        the engine flag untouched. Shown as the engine's truth. */}
                    <CheckRow
                      checked={!!cb?.autoBond}
                      onChange={on => updateCenterBased({ autoBond: on, agentCapabilities: applyCapabilityEdit(profile, 'autoBond', on) })}
                      label="Auto-bond by distance"
                      title="The engine bonds agents within the form distance and breaks bonds past the break distance (hysteresis) — the simplest path to a glued cluster, no Form Bond node needed."
                    />
                    {!!cb?.autoBond && (
                      <SubBlock>
                        <FieldRow label="Form distance" title="× contact distance — auto-bond within this.">{NF('formDistance', { min: 1, step: 0.05 })}</FieldRow>
                        <FieldRow label="Break distance" title="× contact distance — auto-bond breaks past this (> form: hysteresis).">{NF('breakDistance', { min: 1, step: 0.05 })}</FieldRow>
                      </SubBlock>
                    )}
                  </SubBlock>
                )}
              </div>
            );
          }

          if (k === 'charge') {
            // Long-range charge — a 2-state capability, so a checkbox like every
            // other boolean row. Its knobs are revealed only when it is on.
            const range = chargeRangeOf(cb);
            return (
              <div key={k}>
                <CheckRow checked={chargeOn} onChange={on => edit('charge', on ? 'on' : 'off')} label={row.label} title={rowTitle(row)} />
                {chargeOn && (
                  <SubBlock>
                    {/* C10 / P11a — WHICH charge law runs. Cutoff is the L1 pair
                        force truncated at `chargeMaxDist`; Global drops the cutoff
                        and sums EVERY pair through a deterministic Barnes–Hut
                        octree. A different LAW, not a speed-up — the trajectory
                        differs, and the file records the choice. */}
                    <FieldRow label="Charge range" title="How far the charge reaches. Cutoff = a finite-range pair force evaluated in the neighbour stencil. Global = every pair interacts, summed with a Barnes–Hut tree (still fully deterministic on the CPU engines).">
                      <select className={styles.selectInput} style={selStyle} value={range} onChange={e => updateCenterBased({ chargeRange: e.target.value === 'global' ? 'global' : 'cutoff' })}>
                        <option value="cutoff">Cutoff (hash)</option>
                        <option value="global">Global (Barnes–Hut)</option>
                      </select>
                    </FieldRow>
                    <FieldRow label="Charge strength" title="k in f = k·(1/(1+d²) − 1/(1+cutoff²))·(pⱼ − pᵢ). NEGATIVE = repulsive (the layout-opening case).">
                      <NumberField className={`${styles.numberInput} ${styles.numSmall}`} value={chargeStrengthOf(cb)} onNumber={n => updateCenterBased({ chargeStrength: n })} step={0.5} />
                    </FieldRow>
                    {range === 'cutoff' ? (
                      <>
                        <FieldRow label="Charge cutoff" title={`Cutoff distance in world units; also widens the spatial-hash bin edge so the neighbour stencil covers it. Defaults to ${CHARGE_MAX_DIST_REST_MULTIPLE}× the bond rest length (${(CHARGE_MAX_DIST_REST_MULTIPLE * num('bondRestLength')).toFixed(1)}) — clear the field to restore it. A much larger cutoff inflates the layout and costs more per step (in 3D the stencil is a VOLUME, so keep it tight); if a growing graph outruns it, Global is the answer, not a bigger number.`}>
                          <NumberField className={`${styles.numberInput} ${styles.numSmall}`} value={chargeMaxDistOf(cb)} onNumber={n => updateCenterBased({ chargeMaxDist: n })} onClear={() => updateCenterBased({ chargeMaxDist: undefined })} min={0} step={1} />
                        </FieldRow>
                        <Hint>Finite reach. A graph that outgrows the cutoff needs Global, not a bigger number.</Hint>
                      </>
                    ) : (
                      <>
                        <FieldRow label="Accuracy θ" title="Barnes–Hut opening angle. A group of agents is collapsed to one centre-of-mass body when extent² < θ²·d². Smaller = more exact and slower. Approximate is not random — the CPU engines stay bit-reproducible, so a fixed seed replays exactly; θ is part of the force law your file records.">
                          <NumberField className={`${styles.numberInput} ${styles.numSmall}`} value={chargeThetaOf(cb)} onNumber={n => updateCenterBased({ chargeTheta: n })} onClear={() => updateCenterBased({ chargeTheta: undefined })} min={MIN_CHARGE_THETA} max={MAX_CHARGE_THETA} step={0.1} />
                        </FieldRow>
                        <Hint>Every pair interacts (distant groups by centre of mass). GPU residency is off while Global is on — the tree is rebuilt on the CPU each generation.</Hint>
                      </>
                    )}
                  </SubBlock>
                )}
              </div>
            );
          }

          if (k === 'growth') {
            return (
              <div key={k}>
                <CheckRow checked={!!profile.growth} onChange={on => edit('growth', on)} label={label} title={rowTitle(row)} />
                {profile.growth && (
                  <SubBlock>
                    <FieldRow label="Growth rate" title="Radius units per step toward the target radius (Set Target Radius).">{NF('growthRate', { min: 0, step: 0.01 })}</FieldRow>
                  </SubBlock>
                )}
              </div>
            );
          }

          if (k === 'sensing') {
            return (
              <div key={k}>
                <CheckRow checked={!!profile.sensing} onChange={on => edit('sensing', on)} label={label} title={rowTitle(row)} />
                {profile.sensing && (
                  <SubBlock>
                    <FieldRow label="Neighbour query radius" title="The largest Get Nearby Agents / Get Agents In View radius the spatial-hash bin is sized to cover. A query above it silently under-counts.">
                      {NF('neighbourQueryRadius', { min: 1, step: 0.5 })}
                    </FieldRow>
                  </SubBlock>
                )}
              </div>
            );
          }

          const bk = k as BoolCapKey;
          return (
            <CheckRow key={k} checked={!!profile[bk]} onChange={on => edit(bk, on)} label={label} title={rowTitle(row)} />
          );
        })}
      </div>
    </div>
  );
}
