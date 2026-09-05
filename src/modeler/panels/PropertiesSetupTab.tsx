import { useModel } from '../../model/ModelContext';
import type { BoundaryTreatment } from '../../model/types';
import { NumberField } from '../vpl/widgets/InlineWidgets';
import {
  Section, ToggleCard, Segmented, Field, FieldRow, Hint, LinkButton, openModelerPanel,
} from './propertiesWidgets';
import styles from './PanelContent.module.css';

/** The NEUTRAL georeference — cell (0,0)'s lower-left corner at the world origin,
 *  one world unit per cell. It is the base every Georeference field edit spreads
 *  over, so typing ONE number into an absent georef yields a COMPLETE record
 *  instead of a partial one (`GeoReference`'s three numbers are all required).
 *  Deliberately the same fallback `buildAscGrid` writes with no georef stored. */
const defaultGeoref = { xllcorner: 0, yllcorner: 0, cellSize: 1 } as const;

/**
 * Properties › Setup — "what is this model?". The order is the order of IMPACT:
 * the layer cards come first because they decide which graphs, which node
 * catalogue and which other tabs exist at all; then the grid's geometry; then
 * the feature extensions. Every card says what it UNLOCKS — that line is the
 * answer to "why can't I find node X".
 */
export function PropertiesSetupTab({ onOpenAgentsTab }: { onOpenAgentsTab: () => void }) {
  const { model, updateProperties, updateVariegatedCells, updateTopologyMode, updateOverseerConfig } = useModel();
  const { properties } = model;
  const topo = model.topologyMode ?? { gridCells: true, agents: false };
  const is3d = (properties.dimension ?? '2d') === '3d';
  const gisTools = properties.gisTools === true;
  const onlyGrid = topo.gridCells && !topo.agents;
  const onlyAgents = topo.agents && !topo.gridCells;
  const variegatedOn = !is3d && !!model.variegatedCells?.enabled;
  const overseer = model.overseerConfig;

  return (
    <>
      <Section id="setup.layers" title="Layers">
        {/* ≥1 layer must stay on (reducer-enforced; the only-checked one is also
            disabled in place so the last one can't be turned off). */}
        <ToggleCard
          title="Grid Cells"
          on={topo.gridCells}
          onChange={on => updateTopologyMode({ gridCells: on })}
          disabled={onlyGrid}
          disabledReason="At least one layer must stay enabled."
          line="The classic lattice cellular automaton — a W×H(×D) grid of cells, each running the Generation Step."
          unlocks={<>the <b>Cells</b> graph · the <b>Neighborhoods</b> panel · the lattice node catalogue · the grid engine + Variegated Cells</>}
        />
        <ToggleCard
          title="Bond-Graph Agents"
          on={topo.agents}
          onChange={on => updateTopologyMode({ agents: on })}
          disabled={onlyAgents}
          disabledReason="At least one layer must stay enabled."
          line="Off-lattice agents in continuous space: forces, bonds, growth and division, sharing the grid as a field."
          unlocks={<>the <b>Agents</b> graph (the pill above the canvas) · the <b>Agents</b> tab of this panel · Agent Attributes, Views and Sprites · the agent node catalogue</>}
        >
          <div className={styles.rowSplit}>
            <span className={`${styles.rowLabel} ${styles.rowLabelMuted}`}>Capabilities, population, motion and bonding physics</span>
            <LinkButton onClick={onOpenAgentsTab} title="Open the Agents tab of this panel">Open Agents tab ›</LinkButton>
          </div>
        </ToggleCard>
      </Section>

      {topo.gridCells && (
        <Section id="setup.grid" title="Grid">
          <div className={styles.fieldGroup}>
            <Field
              label="Dimension"
              title="2D = the classic flat lattice, drawn on the 2D canvas. 3D = a W×H×D voxel volume with an orbit camera + clip plane. Variegated Cells is 2D-only, so switching to 3D turns it off."
            >
              <Segmented
                ariaLabel="Dimension"
                value={is3d ? '3d' : '2d'}
                onChange={v => {
                  if (v === '3d') {
                    // Variegated Cells is 2D-only — force it off when going 3D.
                    if (model.variegatedCells?.enabled) updateVariegatedCells({ enabled: false });
                    updateProperties({ dimension: '3d', gridDepth: properties.gridDepth ?? 1 });
                  } else {
                    updateProperties({ dimension: '2d' });
                  }
                }}
                options={[
                  { value: '2d', label: '2D grid', title: 'A flat W×H lattice, rendered with the 2D canvas.' },
                  { value: '3d', label: '3D volume', title: 'A W×H×D voxel grid with a layer axis, orbit camera and clip plane. Variegated Cells is unavailable in 3D.' },
                ]}
              />
            </Field>
            <div className={styles.fieldRow}>
              <Field label="Width" title="Cells per row (columns). A change reinitialises the simulator.">
                <NumberField className={styles.numberInput} value={properties.gridWidth} min={1} integer onNumber={n => updateProperties({ gridWidth: n })} />
              </Field>
              <Field label="Height" title="Rows. A change reinitialises the simulator.">
                <NumberField className={styles.numberInput} value={properties.gridHeight} min={1} integer onNumber={n => updateProperties({ gridHeight: n })} />
              </Field>
              {is3d && (
                <Field label="Depth" title="Layers along the Z axis (3D only). A change reinitialises the simulator.">
                  <NumberField className={styles.numberInput} value={properties.gridDepth ?? 1} min={1} integer onNumber={n => updateProperties({ gridDepth: n })} />
                </Field>
              )}
            </div>
            <Field
              label="Boundary"
              title="What a cell sees past the grid edge. Torus wraps every axis (the edge neighbours the opposite edge); Constant reads a fixed boundary value per attribute (set on each cell attribute)."
            >
              <Segmented
                ariaLabel="Boundary treatment"
                value={properties.boundaryTreatment}
                onChange={v => updateProperties({ boundaryTreatment: v as BoundaryTreatment })}
                options={[
                  { value: 'torus', label: 'Torus', title: 'Wrap around on every axis — no edges. Required by the simulator’s infinity canvas.' },
                  { value: 'constant', label: 'Constant', title: 'Cells past the edge hold a fixed boundary value (per attribute, in the Attributes panel).' },
                ]}
              />
            </Field>
          </div>
        </Section>
      )}

      <Section id="setup.extensions" title="Extensions">
        {topo.gridCells && (
          <ToggleCard
            title="Variegated Cells"
            on={variegatedOn}
            onChange={on => updateVariegatedCells({ enabled: on })}
            disabled={is3d}
            disabledReason="Variegated Cells is 2D-only — the orientation / face geometry is square-lattice. Switch the grid to 2D to enable it."
            line="Directional interactions: a per-cell orientation (0–3 = 90° rotations) plus face-pattern labels, for chemistry / micelle / chiral models."
            unlocks={<>the <b>Variegated Cells</b> panel (V) on the left bar · the orientation, facing and face-label nodes · Table Map over face labels</>}
          >
            <div className={styles.rowSplit}>
              <span className={`${styles.rowLabel} ${styles.rowLabelMuted}`}>Face palettes and patterns are edited in their own panel</span>
              <LinkButton onClick={() => openModelerPanel('variegated')} title="Open the Variegated Cells panel">Open panel ›</LinkButton>
            </div>
          </ToggleCard>
        )}
        <ToggleCard
          title="Overseer"
          on={!!overseer?.enabled}
          onChange={on => updateOverseerConfig({ enabled: on })}
          line="Experiment orchestration around the simulation: seeded replicates, parameter sweeps, run-until-stop protocols, capture."
          unlocks={<>the <b>Overseer</b> graph (a third pill above the canvas) · the simulator’s <b>Experiments</b> panel · the Ov* node family</>}
        >
          <Field
            label="Per-run seed policy"
            title="An automatic Set Random Seed applied at each Reset Board, unless the graph already ran one this run. Fixed = every Reset re-seeds with the base seed; Sequential = base seed + reset count."
          >
            <select
              className={styles.selectInput}
              value={overseer?.seedPolicy ?? 'none'}
              onChange={e => updateOverseerConfig({ seedPolicy: e.target.value as 'none' | 'fixed' | 'sequential' })}
            >
              <option value="none">None (graph controls seeding)</option>
              <option value="fixed">Fixed (base seed every Reset)</option>
              <option value="sequential">Sequential (base seed + reset count)</option>
            </select>
          </Field>
          {(overseer?.seedPolicy === 'fixed' || overseer?.seedPolicy === 'sequential') && (
            <FieldRow label="Base seed" title="The seed the policy starts from.">
              <NumberField className={`${styles.numberInput} ${styles.numSmall}`} value={overseer?.baseSeed ?? 12345} integer onNumber={v => updateOverseerConfig({ baseSeed: v })} />
            </FieldRow>
          )}
        </ToggleCard>
        <ToggleCard
          title="Geographic tools (GIS)"
          on={gisTools}
          onChange={on => updateProperties({ gisTools: on })}
          line="The board as a map: a georeference, a backdrop image, and raster / vector imports. Turned on automatically by a geographic import."
          unlocks={<>the <b>Georeference</b> below · the <b>Backdrop map</b> (Info panel + simulator) · .asc / GeoTIFF / GeoJSON import and .asc export · the world-coordinate readout</>}
        >
          {/* Georeference — where the board sits in the real world. Written by the
              .asc / GeoTIFF imports from the file's own header, read back by the
              .asc export, and used by the simulator's world-coordinate readout.
              PRESENTATION + I/O ONLY: no compiler, worker or engine reads it. */}
          <div className={styles.fieldRow}>
            <Field label="X origin" title="World X of the LOWER-LEFT CORNER of the lower-left cell (the Esri xllcorner convention).">
              <NumberField className={styles.numberInput} value={properties.georef?.xllcorner} placeholder="—"
                onNumber={n => updateProperties({ georef: { ...defaultGeoref, ...properties.georef, xllcorner: n } })} />
            </Field>
            <Field label="Y origin" title="World Y of the LOWER-LEFT CORNER of the lower-left cell (the Esri yllcorner convention). Y grows UPWARD, so it belongs to the BOTTOM row.">
              <NumberField className={styles.numberInput} value={properties.georef?.yllcorner} placeholder="—"
                onNumber={n => updateProperties({ georef: { ...defaultGeoref, ...properties.georef, yllcorner: n } })} />
            </Field>
            <Field label="Cell size" title="World units per cell (square cells — the .asc format has no separate X/Y size).">
              <NumberField className={styles.numberInput} value={properties.georef?.cellSize} min={0} placeholder="—"
                onNumber={n => updateProperties({ georef: { ...defaultGeoref, ...properties.georef, cellSize: n } })} />
            </Field>
          </div>
          <div className={styles.fieldRow} style={{ alignItems: 'flex-end' }}>
            <Field label="CRS" title="Coordinate reference system, e.g. EPSG:32633. Metadata only — GenesisCA never reprojects; align upstream in a GIS.">
              <input
                className={styles.textInput}
                value={properties.georef?.crs ?? ''}
                placeholder="EPSG:… (optional)"
                onChange={e => updateProperties({ georef: { ...defaultGeoref, ...properties.georef, crs: e.target.value || undefined } })}
              />
            </Field>
            {properties.georef && (
              <button
                className={styles.deleteButton}
                style={{ flex: 'none', padding: '4px 10px' }}
                title="Drop the georeference — exports fall back to the neutral origin 0,0 / cell size 1."
                onClick={() => updateProperties({ georef: undefined })}
              >Clear</button>
            )}
          </div>
          <Hint>Where cell (0,0) sits in the real world. Nothing in the rule reads it.</Hint>
        </ToggleCard>
      </Section>
    </>
  );
}
