import type { CSSProperties } from 'react';
import type { CAModel, CenterBasedConfig, AgentCapabilities, CollisionMode, BondsMode, MotionMode } from '../../model/types';
import {
  AGENT_PRESETS, AGENT_PRESET_META, AGENT_CAPABILITY_ROWS, HIDDEN_CAP_ROWS_V1,
  resolveAgentProfile, matchAgentPreset, applyCapabilityEdit, estimateAgentFootprint,
  capabilityClosureDrivers, capabilityRowLabel,
  type AgentPresetKey, type BoolCapKey,
} from '../../model/agentCapabilities';
import { cbNum, chargeStrengthOf, chargeMaxDistOf, CHARGE_MAX_DIST_REST_MULTIPLE, layoutIterationsOf, MAX_LAYOUT_ITERATIONS, chargeRangeOf, chargeThetaOf, MIN_CHARGE_THETA, MAX_CHARGE_THETA } from '../../model/centerBased';
import { NumberField } from '../vpl/widgets/InlineWidgets';

/** Model Properties → "Agent Capabilities" section. The preset picker + the
 *  progressive-disclosure capability toggles + the live per-agent footprint
 *  readout. Drives `centerBased.agentCapabilities`; editor-surface only in v1
 *  (palette / Behaviour-Step ports / Edit-panel rows filter to what's on). */
export function AgentCapabilitiesSection({
  model, updateCenterBased,
}: {
  model: CAModel;
  updateCenterBased: (changes: Partial<CenterBasedConfig>) => void;
}) {
  const profile = resolveAgentProfile(model);
  const activePreset = matchAgentPreset(profile);
  const footprint = estimateAgentFootprint(profile, model);
  const set = (next: AgentCapabilities) => updateCenterBased({ agentCapabilities: next });
  const edit = <K extends keyof AgentCapabilities>(key: K, value: AgentCapabilities[K]) =>
    set(applyCapabilityEdit(profile, key, value));

  const selStyle: CSSProperties = { fontSize: '0.66rem', background: 'var(--color-bg-panel, #1a1a1a)', color: '#ddd', border: '1px solid var(--color-widget-border, #444)', borderRadius: 4, padding: '1px 4px' };

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
        style={{ color: 'var(--color-accent)', fontSize: '0.6rem' }}
        title={`Turned on automatically because ${d.map(capabilityRowLabel).join(' / ')} require${d.length === 1 ? 's' : ''} it. Turning ${d.length === 1 ? 'that' : 'those'} off releases it.`}
      > (required by {d.map(capabilityRowLabel).join(', ')})</span>
    );
  };

  const presetDesc = activePreset === 'custom'
    ? 'A custom mix — edit any toggle and the picker stays on Custom.'
    : (AGENT_PRESET_META.find(m => m.key === activePreset)?.description ?? '');

  const chip = (key: AgentPresetKey | 'custom', label: string, onClick?: () => void) => (
    <button
      key={key}
      onClick={onClick}
      disabled={key === 'custom'}
      style={{
        fontSize: '0.66rem', padding: '3px 8px', borderRadius: 999,
        cursor: key === 'custom' ? 'default' : 'pointer',
        border: `1px solid ${activePreset === key ? 'var(--color-accent)' : 'var(--color-widget-border, #444)'}`,
        background: activePreset === key ? 'var(--color-accent-soft, rgba(232,161,58,0.15))' : 'transparent',
        color: activePreset === key ? 'var(--color-accent)' : '#ccc',
        opacity: key === 'custom' && activePreset !== 'custom' ? 0.4 : 1,
      }}
    >{label}</button>
  );

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: '0.6rem', color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '2px 0 4px' }}>Agent Capabilities</div>
      {/* Preset picker */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 4 }}>
        {AGENT_PRESET_META.map(m => chip(m.key, m.label, () => set({ ...AGENT_PRESETS[m.key] })))}
        {chip('custom', 'Custom')}
      </div>
      <span style={{ color: '#888', fontSize: '0.62rem', display: 'block', marginBottom: 8 }}>{presetDesc}</span>

      {/* Motion — a segmented control (revealed for every agent model). */}
      <div style={{ fontSize: '0.6rem', color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '4px 0 4px' }}>Motion{requiredBy('motion')}</div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
        {(['static', 'velocity', 'force'] as MotionMode[]).map(mode => (
          <button
            key={mode}
            onClick={() => edit('motion', mode)}
            style={{
              flex: 1, fontSize: '0.66rem', padding: '3px 4px', borderRadius: 4, cursor: 'pointer',
              textTransform: 'capitalize',
              border: `1px solid ${profile.motion === mode ? 'var(--color-accent)' : 'var(--color-widget-border, #444)'}`,
              background: profile.motion === mode ? 'var(--color-accent-soft, rgba(232,161,58,0.15))' : 'transparent',
              color: profile.motion === mode ? 'var(--color-accent)' : '#ccc',
            }}
          >{mode}</button>
        ))}
      </div>
      <span style={{ color: '#888', fontSize: '0.6rem', display: 'block', marginBottom: 8 }}>
        Which motion nodes are offered: Static = position setters only · Velocity = + Set Velocity · Force = + Apply Force.
        <em style={{ color: '#777' }}> v1: this gates the palette + Behaviour-Step ports; the engine always integrates velocity into position (a dedicated Static/Velocity integrator is a later phase).</em>
      </span>

      {/* Capability rows — mode selects (Collision / Bonds) render a dropdown;
          the rest are boolean checkboxes. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {AGENT_CAPABILITY_ROWS.filter(row => !HIDDEN_CAP_ROWS_V1.has(row.key)).map(row => {
          const k = row.key;
          const hint = <span style={{ color: '#888', fontSize: '0.6rem', display: 'block' }}>{row.description}{row.requires && <em style={{ color: '#777' }}> · requires {row.requires}</em>}</span>;
          if (k === 'collision') {
            return (
              <div key={k}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontSize: '0.72rem', color: '#ddd' }}>{row.label}{requiredBy(k)}</span>
                  <select value={profile.collision} onChange={e => edit('collision', e.target.value as CollisionMode)} style={selStyle}>
                    <option value="off">Off</option><option value="soft">Soft-sphere (force)</option><option value="positional">Positional (hard)</option>
                  </select>
                </div>{hint}
                {profile.collision === 'positional' && (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 4, paddingLeft: 12 }}>
                    <span style={{ fontSize: '0.66rem', color: '#aaa' }} title="Jacobi projection sweeps per step — more = tighter no-overlap packing">Positional iterations</span>
                    <NumberField
                      value={cbNum(model.centerBased, 'positionalIterations')}
                      onNumber={n => updateCenterBased({ positionalIterations: n })}
                      min={1} max={16} integer step={1}
                      style={{ background: 'var(--color-bg-panel, #1a1a1a)', color: '#ddd', border: '1px solid var(--color-widget-border, #444)', borderRadius: 4, width: 64, fontSize: '0.66rem' }}
                    />
                  </div>
                )}
              </div>
            );
          }
          if (k === 'bonds') {
            return (
              <div key={k}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontSize: '0.72rem', color: '#ddd' }}>{row.label}{requiredBy(k)}</span>
                  <select value={profile.bonds} onChange={e => {
                    const v = e.target.value as BondsMode;
                    const next = applyCapabilityEdit(profile, 'bonds', v);
                    // Bonds below Physics can't auto-bond (auto-bond forms physics
                    // springs), so clear the legacy autoBond checkbox to keep the two
                    // controls consistent AND let the memory gate (resolveMaxBonds)
                    // actually drop the store.
                    updateCenterBased(v === 'physics' ? { agentCapabilities: next } : { agentCapabilities: next, autoBond: false });
                  }} style={selStyle}>
                    <option value="off">Off</option><option value="data">Data (edges)</option><option value="physics">Physics (springs)</option>
                  </select>
                </div>{hint}
              </div>
            );
          }
          if (k === 'charge') {
            // Long-range charge — a 2-state capability, so a checkbox like every
            // other boolean row (Collision/Bonds only use selects because they are
            // 3-state). Its two tuning knobs are revealed only when it is on.
            const on = profile.charge === 'on';
            return (
              <div key={k}>
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 6, cursor: 'pointer' }}>
                  <input type="checkbox" checked={on} onChange={e => edit('charge', e.target.checked ? 'on' : 'off')} style={{ marginTop: 2 }} />
                  <span>
                    <span style={{ fontSize: '0.72rem', color: '#ddd' }}>{row.label}{requiredBy(k)}</span>
                    <br /><span style={{ color: '#888', fontSize: '0.6rem' }}>{row.description}{row.requires && <em style={{ color: '#777' }}> · requires {row.requires}</em>}</span>
                  </span>
                </label>
                {on && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4, paddingLeft: 12 }}>
                    {/* C10 / P11a — WHICH charge law runs. Cutoff is the L1 pair
                        force truncated at `chargeMaxDist`; Global drops the cutoff
                        and sums EVERY pair through a deterministic Barnes–Hut
                        octree. A different LAW, not a speed-up — the trajectory
                        differs, and the file records the choice. */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                      <span style={{ fontSize: '0.66rem', color: '#aaa' }} title="How far the charge reaches. Cutoff = a finite-range pair force evaluated in the neighbour stencil. Global = every pair interacts, summed with a Barnes-Hut tree (still fully deterministic on the CPU engines).">Charge range</span>
                      <select
                        value={chargeRangeOf(model.centerBased)}
                        onChange={e => updateCenterBased({ chargeRange: e.target.value === 'global' ? 'global' : 'cutoff' })}
                        style={{ ...selStyle, width: 132 }}
                      >
                        <option value="cutoff">Cutoff (hash)</option>
                        <option value="global">Global (Barnes-Hut)</option>
                      </select>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                      <span style={{ fontSize: '0.66rem', color: '#aaa' }} title="k in f = k·(1/(1+d²) − 1/(1+cutoff²))·(pⱼ − pᵢ). NEGATIVE = repulsive (the layout-opening case).">Charge strength</span>
                      <NumberField
                        value={chargeStrengthOf(model.centerBased)}
                        onNumber={n => updateCenterBased({ chargeStrength: n })}
                        step={0.5}
                        style={{ background: 'var(--color-bg-panel, #1a1a1a)', color: '#ddd', border: '1px solid var(--color-widget-border, #444)', borderRadius: 4, width: 64, fontSize: '0.66rem' }}
                      />
                    </div>
                    {/* The cutoff means NOTHING under Global, so it is hidden
                        rather than shown inert (the `hiddenPorts` doctrine); theta
                        takes its place. */}
                    {chargeRangeOf(model.centerBased) === 'cutoff' ? (
                      <>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                          <span style={{ fontSize: '0.66rem', color: '#aaa' }} title="Cutoff distance in world units. Also widens the spatial-hash bin edge so the neighbour stencil actually covers it.">Charge cutoff</span>
                          <NumberField
                            value={chargeMaxDistOf(model.centerBased)}
                            onNumber={n => updateCenterBased({ chargeMaxDist: n })}
                            onClear={() => updateCenterBased({ chargeMaxDist: undefined })}
                            min={0} step={1}
                            style={{ background: 'var(--color-bg-panel, #1a1a1a)', color: '#ddd', border: '1px solid var(--color-widget-border, #444)', borderRadius: 4, width: 64, fontSize: '0.66rem' }}
                          />
                        </div>
                        <span style={{ color: '#777', fontSize: '0.6rem' }}>
                          Cutoff defaults to {CHARGE_MAX_DIST_REST_MULTIPLE}× the bond rest length ({(CHARGE_MAX_DIST_REST_MULTIPLE * cbNum(model.centerBased, 'bondRestLength')).toFixed(1)}) — clear the field to restore it.
                          A much larger cutoff inflates the layout and costs more per step (in 3D the stencil is a VOLUME, so keep it tight) — if a growing graph outruns it, Global is the answer, not a bigger number.
                        </span>
                      </>
                    ) : (
                      <>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                          <span style={{ fontSize: '0.66rem', color: '#aaa' }} title="Barnes-Hut opening angle. A group of agents is collapsed to one centre-of-mass body when extent² < θ²·d². Smaller = more exact and slower.">Accuracy θ</span>
                          <NumberField
                            value={chargeThetaOf(model.centerBased)}
                            onNumber={n => updateCenterBased({ chargeTheta: n })}
                            onClear={() => updateCenterBased({ chargeTheta: undefined })}
                            min={MIN_CHARGE_THETA} max={MAX_CHARGE_THETA} step={0.1}
                            style={{ background: 'var(--color-bg-panel, #1a1a1a)', color: '#ddd', border: '1px solid var(--color-widget-border, #444)', borderRadius: 4, width: 64, fontSize: '0.66rem' }}
                          />
                        </div>
                        <span style={{ color: '#777', fontSize: '0.6rem' }}>
                          Every pair interacts; distant groups are approximated by their centre of mass. Unlike a cutoff this does not
                          stop working as the graph grows. Approximate is not the same as random — the CPU engines are bit-reproducible,
                          so a fixed seed still replays exactly. θ is part of the force law your file records.
                          GPU residency is off while Global is on (the tree is rebuilt on the CPU each generation).
                        </span>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          }
          const bk = k as BoolCapKey;
          return (
            <label key={k} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={!!profile[bk]} onChange={e => edit(bk, e.target.checked)} style={{ marginTop: 2 }} />
              <span>
                <span style={{ fontSize: '0.72rem', color: '#ddd' }}>{row.label}{requiredBy(bk)}</span>
                <br /><span style={{ color: '#888', fontSize: '0.6rem' }}>{row.description}{row.requires && <em style={{ color: '#777' }}> · requires {row.requires}</em>}</span>
              </span>
            </label>
          );
        })}
      </div>

      {/* Solver relaxation — an ENGINE knob, not a capability and not a graph node:
          how many times the force integrator runs per generation. Sits outside the
          capability list on purpose (nothing gates it, and it changes no semantics —
          only how far the layout settles between rewrites). */}
      <div style={{ fontSize: '0.6rem', color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '10px 0 4px' }}>Solver</div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontSize: '0.72rem', color: '#ddd' }} title="Force-pass runs per generation. Purely numerical relaxation — age, growth and the structural phase (bond form/break/rewire, division, death) still advance exactly ONCE per generation.">Layout iterations</span>
        <NumberField
          value={layoutIterationsOf(model.centerBased)}
          onNumber={n => updateCenterBased({ layoutIterations: n })}
          min={1} max={MAX_LAYOUT_ITERATIONS} integer step={1}
          style={{ background: 'var(--color-bg-panel, #1a1a1a)', color: '#ddd', border: '1px solid var(--color-widget-border, #444)', borderRadius: 4, width: 64, fontSize: '0.66rem' }}
        />
      </div>
      <span style={{ color: '#888', fontSize: '0.6rem', display: 'block', marginTop: 2 }}>
        How many times the force integrator runs per generation (1 = one pass, the default). Raising it lets a
        growing structure settle further per rewrite without inflating the generation counter — the rule's own
        cadence (&ldquo;rewrite every Nth generation&rdquo;) belongs in the graph instead, as a Periodic Step.
      </span>

      {/* Footprint readout — the cost of generality, bound to the profile. */}
      <div style={{ marginTop: 10, padding: '6px 8px', borderRadius: 4, background: 'var(--color-overlay-row, rgba(255,255,255,0.03))', border: '1px solid var(--color-border-muted, #2a2a2a)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span style={{ fontSize: '0.66rem', color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Per-agent footprint</span>
          <span style={{ fontSize: '0.82rem', color: 'var(--color-accent)', fontWeight: 600 }}>≈ {footprint.bytesPerAgent} B</span>
        </div>
        <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 1 }}>
          {footprint.groups.map((g, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.6rem', color: g.core ? '#999' : '#bbb' }}>
              <span>{g.label}</span><span>{g.bytes} B</span>
            </div>
          ))}
        </div>
        <span style={{ color: '#777', fontSize: '0.58rem', display: 'block', marginTop: 4, fontStyle: 'italic' }}>
          v1 estimate — the engine still allocates the full struct; profile-driven allocation lands in a later phase.
        </span>
      </div>
    </div>
  );
}
