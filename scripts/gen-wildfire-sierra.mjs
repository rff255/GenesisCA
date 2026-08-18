#!/usr/bin/env node
/**
 * Generates `public/models/Wildfire - Sierra Nevada.gcaproj` — a fire-spread CA
 * running on a REAL 6.2 km × 6.2 km piece of the Lake Tahoe east shore, built
 * from open geographic data.
 *
 *   Terrain    Copernicus DEM GLO-30 (ESA/Airbus, 1 arc-second)
 *              copernicus-dem-30m.s3.amazonaws.com — tile N39/W120
 *   Land cover ESA WorldCover 2021 v200 (10 m, 11 classes)
 *              esa-worldcover.s3.eu-central-1.amazonaws.com — tile N39W120
 *
 *   Window     west  -119.935°, south 39.145°   (EPSG:4326)
 *              200 × 200 cells of 1 arc-second (1/3600°)
 *              → Lake Tahoe's east shore, Marlette Lake, and the Carson Range
 *                crest up to Snow Valley Peak. Elevation 1896–2806 m; land
 *                cover 72 % forest / 15 % water / 11 % grass.
 *
 * THE RULE. An Unburned cell with a flammable fuel ignites with probability
 *
 *     P = spreadRate · ignite[fuel] · drive · 0.35
 *
 * where `ignite` is a one-axis LOOKUP TABLE keyed by the fuel class (the
 * classic code→class table, user-editable live) and `drive` is the sum of one
 * term per burning neighbour:
 *
 *     term_d = burning_d · (1/dist_d) · windWeight_d · slopeFactor_d
 *
 *   · WIND. Fire travelling FROM a neighbour at (dr, dc) moves in the compass
 *     direction (−dc east, +dr north). Its weight is
 *         1 + windE·(−dc/dist) + windN·(dr/dist)
 *     so a west neighbour is boosted by an east wind, a south neighbour by a
 *     north wind, and the diagonals get the √2-projected mix. The eight
 *     coefficients are COMPILE-TIME constants baked into two Expression nodes.
 *   · SLOPE. Fire runs uphill: each neighbour contributes
 *         max(0, 1 + slopeBoost · clamp((myElev − nbrElev)/15 m, −1, 1))
 *     read from the DEM. This is why the elevation layer is here.
 *
 * A Burning cell counts `burnDuration` steps down and becomes Burned (which is
 * terminal — the fire cannot re-enter). Water and bare rock have ignite = 0, so
 * Lake Tahoe and the ridge scree are natural firebreaks.
 *
 * THE LANDSCAPE LIVES IN THE FILE. The fuel + elevation layers ride the model's
 * embedded `simulationState`, so the model opens with the real landscape and
 * needs no network at load time. A Reset would normally re-seed from the (empty)
 * Init Events and therefore CLEAR them, so the model sets
 * `properties.resetRestoresBoard: true`: Reset reseeds and then applies that
 * board on top, and the ■ button's own menu still offers a from-rules reset.
 * (This REPLACED a "Restore landscape" preset the user had to know to load.)
 *
 *   node scripts/gen-wildfire-sierra.mjs
 *
 * Raw source windows are cached under `scripts/geodata-cache/` (gitignored), so
 * a re-run is offline-stable. Delete that directory to re-fetch.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readCogWindow, windowGeoref, metresPerDegree, terrain,
  encodePNG, pngDataUrl, downscaleRGB, upsampleBilinear, toBase64,
  idFactory, graphBuilder, exprConfig, EXPR_PORTS, gridStateBlock, ROOT,
} from './geodataLib.mjs';
import { resampleNearest, resampleAverage } from '../src/simulator/rasterResample.ts';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'models', 'Wildfire - Sierra Nevada.gcaproj');

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------
const N = 200;                     // grid is N × N
const CELL = 1 / 3600;             // 1 arc-second — the DEM's own resolution
const WEST = -119.935, SOUTH = 39.145;
const WIN = windowGeoref(WEST, SOUTH, CELL, N, N);
const DEM_URL = 'https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N39_00_W120_00_DEM/Copernicus_DSM_COG_10_N39_00_W120_00_DEM.tif';
const WC_URL = 'https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_N39W120_Map.tif';

// ---------------------------------------------------------------------------
// Fuel classes — WorldCover code → fuel tag
// ---------------------------------------------------------------------------
const FUEL = ['Water', 'Barren', 'Grass', 'Shrub', 'Forest', 'Urban'];
const F_WATER = 0, F_BARREN = 1, F_GRASS = 2, F_SHRUB = 3, F_FOREST = 4, F_URBAN = 5;
/** ESA WorldCover 2021 v200 class codes → our fuel model. */
const WC_TO_FUEL = {
  10: F_FOREST,  // tree cover
  20: F_SHRUB,   // shrubland
  30: F_GRASS,   // grassland
  40: F_GRASS,   // cropland — burns like cured grass
  50: F_URBAN,   // built-up
  60: F_BARREN,  // bare / sparse vegetation
  70: F_BARREN,  // snow and ice
  80: F_WATER,   // permanent water
  90: F_WATER,   // herbaceous wetland
  95: F_FOREST,  // mangroves (absent here, mapped for completeness)
  100: F_GRASS,  // moss and lichen
};
/** Per-fuel ignition probability — the shipped Lookup Table contents. */
const IGNITE = [0.0, 0.0, 0.78, 0.60, 0.45, 0.12];

const STATE = ['Unburned', 'Burning', 'Burned'];
const S_UNBURNED = 0, S_BURNING = 1, S_BURNED = 2;

// Terrain-map colours for the hillshaded backdrop (deliberately NOT the ESA
// palette, which is a classification key rather than a basemap).
const FUEL_BASE_RGB = [
  [42, 95, 143],   // Water   — lake blue
  [169, 158, 140], // Barren  — scree
  [154, 168, 95],  // Grass   — dry meadow
  [110, 123, 70],  // Shrub   — sage
  [51, 88, 47],    // Forest  — conifer
  [138, 128, 121], // Urban   — grey
];

// ---------------------------------------------------------------------------
// 1. Fetch + resample the two rasters onto the model grid
// ---------------------------------------------------------------------------
console.log(`Wildfire — Sierra Nevada: window ${WIN.west}..${WIN.east}, ${WIN.south}..${WIN.north} (${N}x${N} @ ${CELL}°)`);

const demWin = await readCogWindow({
  url: DEM_URL, key: `tahoe-dem-${WEST}_${SOUTH}_${N}`,
  west: WIN.west, south: WIN.south, east: WIN.east, north: WIN.north, dtype: 'f32',
});
const wcWin = await readCogWindow({
  url: WC_URL, key: `tahoe-wc-${WEST}_${SOUTH}_${N}`,
  west: WIN.west, south: WIN.south, east: WIN.east, north: WIN.north, dtype: 'u8',
});
console.log(`  DEM window ${demWin.w}x${demWin.h}, WorldCover window ${wcWin.w}x${wcWin.h}`);

// Elevation: CONTINUOUS → box average (gdalwarp -r average). Land cover:
// CATEGORICAL → nearest, always (averaging class codes invents classes).
const elevF = resampleAverage(demWin.values, demWin.w, demWin.h, N, N);
const wcF = resampleNearest(wcWin.values, wcWin.w, wcWin.h, N, N);

const elevation = new Int32Array(N * N);
const fuel = new Int32Array(N * N);
for (let i = 0; i < N * N; i++) {
  const e = elevF[i];
  elevation[i] = Number.isFinite(e) ? Math.round(e) : 0;
  fuel[i] = WC_TO_FUEL[wcF[i] | 0] ?? F_BARREN;
}
{
  let mn = Infinity, mx = -Infinity;
  for (const v of elevation) { if (v < mn) mn = v; if (v > mx) mx = v; }
  const hist = {};
  for (const v of fuel) hist[FUEL[v]] = (hist[FUEL[v]] || 0) + 1;
  console.log(`  elevation ${mn}..${mx} m; fuel ` +
    Object.entries(hist).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(100 * v / (N * N)).toFixed(1)}%`).join(', '));
  var ELEV_MIN = mn, ELEV_MAX = mx;
}

// ---------------------------------------------------------------------------
// 2. Hillshade + the tinted backdrop / thumbnail
// ---------------------------------------------------------------------------
const midLat = WIN.south + (N * CELL) / 2;
const { perLat, perLon } = metresPerDegree(midLat);
const MX = CELL * perLon, MY = CELL * perLat;   // metres per cell, E-W and N-S
const { shade } = terrain(elevation, N, N, MX, MY);

// The backdrop is drawn at the LAND COVER's native 10 m resolution (3x the model
// grid), so the basemap stays crisp when the user zooms past one screen pixel per
// cell. The hillshade is computed from the DEM at its own resolution and lifted
// bilinearly — upsampling the shade adds no information but avoids the blocky
// look nearest would give.
const BD = N * 3;
const bdCover = resampleNearest(wcWin.values, wcWin.w, wcWin.h, BD, BD);
// Quantise the shade to 48 levels: invisible on screen, but it collapses the
// hillshade's continuous ramp into a handful of runs, which is most of the
// backdrop PNG's size.
const bdShade = upsampleBilinear(shade, N, N, BD, BD).map(v => Math.round(v * 48) / 48);
const backdropRGB = new Uint8Array(BD * BD * 3);
for (let i = 0; i < BD * BD; i++) {
  const f = WC_TO_FUEL[bdCover[i] | 0] ?? F_BARREN;
  const base = FUEL_BASE_RGB[f];
  // Water is flat: shade it only weakly so the lake reads as a lake.
  const k = f === F_WATER ? 0.85 + 0.30 * bdShade[i] : 0.30 + 1.05 * bdShade[i];
  for (let c = 0; c < 3; c++) backdropRGB[i * 3 + c] = Math.max(0, Math.min(255, Math.round(base[c] * k)));
}
const backdropUrl = pngDataUrl(BD, BD, backdropRGB);
const thumbRGB = downscaleRGB(backdropRGB, BD, BD, 256, 256);
const thumbUrl = pngDataUrl(256, 256, thumbRGB);
console.log(`  backdrop ${BD}x${BD} ${(encodePNG(BD, BD, backdropRGB).length / 1024).toFixed(0)} KB, thumbnail ${(encodePNG(256, 256, thumbRGB).length / 1024).toFixed(0)} KB`);

// ---------------------------------------------------------------------------
// 3. The rule graph
// ---------------------------------------------------------------------------
const newId = idFactory('wf');
const G = graphBuilder(newId);
const { node, vEdge, fEdge } = G;

const NBR = 'moore';
/** The 8 Moore neighbours, in the neighbourhood's own coord order, each tagged
 *  with the compass direction it lies in. `dr` grows SOUTHWARD (row 0 is the
 *  northernmost row — the Esri row flip), `dc` grows EAST. */
const DIRS = [
  { tag: 'NW', dr: -1, dc: -1 }, { tag: 'N', dr: -1, dc: 0 }, { tag: 'NE', dr: -1, dc: 1 },
  { tag: 'W', dr: 0, dc: -1 }, { tag: 'E', dr: 0, dc: 1 },
  { tag: 'SW', dr: 1, dc: -1 }, { tag: 'S', dr: 1, dc: 0 }, { tag: 'SE', dr: 1, dc: 1 },
];

const step = node('step', {}, 0, 0, 'Fire spread');

// --- cell-top reads ---------------------------------------------------------
const myState = node('getCellAttribute', { attributeId: 'state' }, 0, 2);
const myFuel = node('getCellAttribute', { attributeId: 'fuel' }, 0, 3);
const myElev = node('getCellAttribute', { attributeId: 'elevation' }, 0, 4);
const myTimer = node('getCellAttribute', { attributeId: 'burnTimer' }, 0, 5);

// --- live parameters --------------------------------------------------------
const mSpread = node('getModelAttribute', { attributeId: 'spreadRate', isColorAttr: false }, 0, 7);
const mWindE = node('getModelAttribute', { attributeId: 'windE', isColorAttr: false }, 0, 8);
const mWindN = node('getModelAttribute', { attributeId: 'windN', isColorAttr: false }, 0, 9);
const mSlope = node('getModelAttribute', { attributeId: 'slopeBoost', isColorAttr: false }, 0, 10);
const mBurnDur = node('getModelAttribute', { attributeId: 'burnDuration', isColorAttr: false }, 0, 11);

// --- one row per compass direction -----------------------------------------
// term_d = burning_d · slopeFactor_d   (the 1/dist and the wind weight are
// folded into the two Expression nodes below, where they are constants).
const SLOPE_SCALE = 15;   // metres of rise at which the uphill boost saturates
// Normalisation on the summed drive. CALIBRATED, not arbitrary: measured in the
// real worker, the fire percolates only above roughly `rate x fuelP x drive x
// 0.38`; at 0.35 the shipped defaults sat just BELOW threshold and a freshly
// lit fire fizzled out after ~100 cells. At 0.45 the default settings give a
// fire that keeps running (about 1400 cells by generation 100 on forest), and
// the Spread rate slider still crosses the threshold on the way down — which is
// itself worth discovering.
const DRIVE_NORM = 0.45;
const kByTag = {};
DIRS.forEach((d, i) => {
  const row = 14 + i * 2;
  const nbrState = node('getNeighborAttributeByTag', { neighborhoodId: NBR, attributeId: 'state', tagName: d.tag }, 1, row, `${d.tag}: state`);
  const isBurning = node('statement', { operation: '==', compareType: 'tag', tagAttributeId: 'state', _port_y: String(S_BURNING) }, 2, row);
  vEdge(nbrState, 'value', isBurning, 'x');
  const nbrElev = node('getNeighborAttributeByTag', { neighborhoodId: NBR, attributeId: 'elevation', tagName: d.tag }, 1, row + 1, `${d.tag}: elevation`);
  const k = node(
    'expression',
    exprConfig(`burning * max(0, 1 + boost * max(-1, min(1, (myElev - nbrElev) / ${SLOPE_SCALE})))`,
      ['burning', 'boost', 'myElev', 'nbrElev']),
    3, row, `${d.tag} drive`,
  );
  vEdge(isBurning, 'result', k, EXPR_PORTS[0]);
  vEdge(mSlope, 'value', k, EXPR_PORTS[1]);
  vEdge(myElev, 'value', k, EXPR_PORTS[2]);
  vEdge(nbrElev, 'value', k, EXPR_PORTS[3]);
  kByTag[d.tag] = k;
});

// --- wind-weighted sum ------------------------------------------------------
// Cardinal neighbours (distance 1). Weight = 1 + windE·(−dc) + windN·dr.
const D = (1 / Math.SQRT2).toFixed(4);   // 0.7071 — the diagonal projection
const cardinal = node(
  'expression',
  exprConfig('s*(1 + wn) + n*(1 - wn) + w*(1 + we) + e*(1 - we)', ['n', 's', 'e', 'w', 'we', 'wn']),
  4, 15, 'Cardinal drive (wind-weighted)',
);
vEdge(kByTag.N, 'result', cardinal, EXPR_PORTS[0]);
vEdge(kByTag.S, 'result', cardinal, EXPR_PORTS[1]);
vEdge(kByTag.E, 'result', cardinal, EXPR_PORTS[2]);
vEdge(kByTag.W, 'result', cardinal, EXPR_PORTS[3]);
vEdge(mWindE, 'value', cardinal, EXPR_PORTS[4]);
vEdge(mWindN, 'value', cardinal, EXPR_PORTS[5]);

// Diagonal neighbours (distance √2): the 1/dist factor and the √2-projected
// wind components are the same constant D.
const diagonal = node(
  'expression',
  exprConfig(
    `${D}*( sw*(1 + ${D}*(we + wn)) + ne*(1 - ${D}*(we + wn)) + nw*(1 + ${D}*(we - wn)) + se*(1 - ${D}*(we - wn)) )`,
    ['nw', 'ne', 'sw', 'se', 'we', 'wn'],
  ),
  4, 21, 'Diagonal drive (wind-weighted)',
);
vEdge(kByTag.NW, 'result', diagonal, EXPR_PORTS[0]);
vEdge(kByTag.NE, 'result', diagonal, EXPR_PORTS[1]);
vEdge(kByTag.SW, 'result', diagonal, EXPR_PORTS[2]);
vEdge(kByTag.SE, 'result', diagonal, EXPR_PORTS[3]);
vEdge(mWindE, 'value', diagonal, EXPR_PORTS[4]);
vEdge(mWindN, 'value', diagonal, EXPR_PORTS[5]);

const drive = node('arithmeticOperator', { operation: '+' }, 5, 18, 'Total drive');
vEdge(cardinal, 'result', drive, 'x');
vEdge(diagonal, 'result', drive, 'y');

// --- ignition probability ---------------------------------------------------
const fuelP = node('lookupInteraction', { tableId: 'ignite' }, 1, 3, 'Fuel ignitability');
vEdge(myFuel, 'value', fuelP, 'axis_0');
const pIgnite = node(
  'expression',
  exprConfig(`rate * fuelP * drive * ${DRIVE_NORM}`, ['rate', 'fuelP', 'drive']),
  6, 18, 'P(ignite this step)',
);
vEdge(mSpread, 'value', pIgnite, EXPR_PORTS[0]);
vEdge(fuelP, 'value', pIgnite, EXPR_PORTS[1]);
vEdge(drive, 'result', pIgnite, EXPR_PORTS[2]);

const roll = node('getRandom', { randomType: 'float', _port_min: '0', _port_max: '1' }, 6, 20);
const ignites = node('statement', { operation: '<', compareType: 'numerical' }, 7, 19);
vEdge(roll, 'value', ignites, 'x');
vEdge(pIgnite, 'result', ignites, 'y');

// --- state machine ----------------------------------------------------------
const isUnburned = node('statement', { operation: '==', compareType: 'tag', tagAttributeId: 'state', _port_y: String(S_UNBURNED) }, 1, 2);
vEdge(myState, 'value', isUnburned, 'x');
const gateUnburned = node('conditional', {}, 8, 2, 'Unburned?');
fEdge(step, 'do', gateUnburned, 'check');
vEdge(isUnburned, 'result', gateUnburned, 'condition');
const gateIgnite = node('conditional', {}, 9, 2, 'Catches fire?');
fEdge(gateUnburned, 'then', gateIgnite, 'check');
vEdge(ignites, 'result', gateIgnite, 'condition');
const setBurning = node('setAttribute', { attributeId: 'state', _port_value: String(S_BURNING) }, 10, 2);
fEdge(gateIgnite, 'then', setBurning, 'do');
const setTimer = node('setAttribute', { attributeId: 'burnTimer' }, 11, 2);
fEdge(setBurning, 'next', setTimer, 'do');
vEdge(mBurnDur, 'value', setTimer, 'value');

const isBurning = node('statement', { operation: '==', compareType: 'tag', tagAttributeId: 'state', _port_y: String(S_BURNING) }, 1, 6);
vEdge(myState, 'value', isBurning, 'x');
const gateBurning = node('conditional', {}, 8, 6, 'Burning?');
fEdge(gateUnburned, 'next', gateBurning, 'check');
vEdge(isBurning, 'result', gateBurning, 'condition');
const nextTimer = node('arithmeticOperator', { operation: '-', _port_y: '1' }, 2, 6, 'Burn timer − 1');
vEdge(myTimer, 'value', nextTimer, 'x');
const tickTimer = node('setAttribute', { attributeId: 'burnTimer' }, 9, 6);
fEdge(gateBurning, 'then', tickTimer, 'do');
vEdge(nextTimer, 'result', tickTimer, 'value');
const burnedOut = node('statement', { operation: '<=', compareType: 'numerical', _port_y: '0' }, 3, 6);
vEdge(nextTimer, 'result', burnedOut, 'x');
const gateBurnedOut = node('conditional', {}, 10, 6, 'Fuel exhausted?');
fEdge(tickTimer, 'next', gateBurnedOut, 'check');
vEdge(burnedOut, 'result', gateBurnedOut, 'condition');
const setBurned = node('setAttribute', { attributeId: 'state', _port_value: String(S_BURNED) }, 11, 6);
fEdge(gateBurnedOut, 'then', setBurned, 'do');

// --- the ignition brush (a Color→Attribute mapping with ONE tag parameter) ---
const im = node('inputColor', { mappingId: 'paintFire' }, 0, 34, 'Fire brush');
const imFuel = node('getCellAttribute', { attributeId: 'fuel' }, 0, 36);
const imP = node('lookupInteraction', { tableId: 'ignite' }, 1, 36);
vEdge(imFuel, 'value', imP, 'axis_0');
const imFlammable = node('statement', { operation: '>', compareType: 'numerical', _port_y: '0' }, 2, 36, 'Fuel can burn?');
vEdge(imP, 'value', imFlammable, 'x');
const imGate = node('conditional', {}, 3, 34);
fEdge(im, 'do', imGate, 'check');
vEdge(imFlammable, 'result', imGate, 'condition');
const imSetState = node('setAttribute', { attributeId: 'state' }, 4, 34);
fEdge(imGate, 'then', imSetState, 'do');
vEdge(im, 'st', imSetState, 'value');
const imDur = node('getModelAttribute', { attributeId: 'burnDuration', isColorAttr: false }, 4, 36);
const imSetTimer = node('setAttribute', { attributeId: 'burnTimer' }, 5, 34);
fEdge(imSetState, 'next', imSetTimer, 'do');
vEdge(imDur, 'value', imSetTimer, 'value');

// ---------------------------------------------------------------------------
// 4. Model parts
// ---------------------------------------------------------------------------
const attributes = [
  {
    id: 'fuel', name: 'Fuel', type: 'tag',
    description: 'Fuel class, reclassified from ESA WorldCover 2021 (10 m): tree cover → Forest, shrubland → Shrub, grassland/cropland → Grass, built-up → Urban, bare/snow → Barren, water/wetland → Water. Drives the ignition probability through the `Fuel ignitability` lookup table.',
    isModelAttribute: false, defaultValue: '0', boundaryValue: '0', tagOptions: FUEL,
  },
  {
    id: 'elevation', name: 'Elevation', type: 'integer',
    description: 'Ground elevation in metres above sea level, from the Copernicus DEM GLO-30 (1 arc-second), box-averaged onto the model grid. Read by the spread rule so fire runs uphill.',
    isModelAttribute: false, defaultValue: '0', boundaryValue: '0',
  },
  {
    id: 'state', name: 'Fire state', type: 'tag',
    description: 'Unburned → Burning → Burned. Burned is terminal: the fire cannot re-enter ground it has already consumed.',
    isModelAttribute: false, defaultValue: '0', boundaryValue: '0', tagOptions: STATE,
  },
  {
    id: 'burnTimer', name: 'Burn timer', type: 'integer',
    description: 'Steps of fuel left in a Burning cell. Set to `Burn duration` on ignition and counted down each step; at zero the cell becomes Burned.',
    isModelAttribute: false, defaultValue: '0', boundaryValue: '0',
  },
  // --- live parameters ---
  {
    id: 'ignite', name: 'Fuel ignitability', type: 'lookupTable',
    description: 'Per-fuel-class probability weight — the classic code→class table a GIS user brings with a landcover raster. Water and Barren are 0, so the lake and the scree are firebreaks. Edit any row live to change what burns.',
    isModelAttribute: true, defaultValue: '0',
    axes: [{ name: 'Fuel', source: { kind: 'tagAttribute', attributeId: 'fuel' } }],
    valueType: 'float',
    tableData: IGNITE.slice(),
  },
  {
    id: 'spreadRate', name: 'Spread rate', type: 'float',
    description: 'Global multiplier on every ignition probability. 0 freezes the fire; 1 makes it run.',
    isModelAttribute: true, defaultValue: '0.7', hasBounds: true, min: 0, max: 1,
  },
  {
    id: 'windE', name: 'Wind → East', type: 'float',
    description: 'Eastward wind component. Positive pushes the fire east (a west neighbour ignites you more easily); negative pushes it west.',
    isModelAttribute: true, defaultValue: '0.6', hasBounds: true, min: -1, max: 1,
  },
  {
    id: 'windN', name: 'Wind → North', type: 'float',
    description: 'Northward wind component. Positive pushes the fire north (up the map), negative south.',
    isModelAttribute: true, defaultValue: '0', hasBounds: true, min: -1, max: 1,
  },
  {
    id: 'slopeBoost', name: 'Slope boost', type: 'float',
    description: 'How strongly the terrain matters. At 1 a full uphill step doubles that neighbour\'s contribution and a full downhill step cancels it; 0 makes the fire ignore the DEM entirely.',
    isModelAttribute: true, defaultValue: '1', hasBounds: true, min: 0, max: 2,
  },
  {
    id: 'burnDuration', name: 'Burn duration', type: 'integer',
    description: 'How many steps a cell stays Burning (and can therefore ignite its neighbours) before it is consumed.',
    isModelAttribute: true, defaultValue: '6', hasBounds: true, min: 1, max: 20,
  },
];

const neighborhoods = [{
  id: NBR, name: 'Moore (8, compass-tagged)',
  description: 'The eight surrounding cells, each tagged with its compass direction so the wind and slope terms can weight them individually. Row grows southward (row 0 is the northernmost), so N is dr = −1.',
  coords: DIRS.map(d => [d.dr, d.dc]),
  tags: Object.fromEntries(DIRS.map((d, i) => [i, d.tag])),
  margin: 1, includeCentralCell: false,
}];

const mappings = [
  {
    id: 'fireOnMap', name: 'Fire on the map', isAttributeToColor: true,
    description: 'Only the fire is drawn — Unburned cells are fully transparent, so the hillshaded terrain backdrop reads through and the fire spreads over the real landscape.',
    redDescription: 'By fire state', greenDescription: 'By fire state', blueDescription: 'By fire state',
    linked: true, linkedAttributeId: 'state',
    linkedColors: {
      tag: [
        { r: 0, g: 0, b: 0, a: 0 },        // Unburned — invisible (backdrop shows)
        { r: 255, g: 132, b: 32, a: 255 }, // Burning  — flame
        { r: 32, g: 26, b: 24, a: 220 },   // Burned   — char, slightly translucent
      ],
    },
  },
  {
    id: 'fuelMap', name: 'Fuel map', isAttributeToColor: true,
    description: 'The reclassified ESA WorldCover fuel model: what each cell is made of.',
    redDescription: 'By fuel class', greenDescription: 'By fuel class', blueDescription: 'By fuel class',
    linked: true, linkedAttributeId: 'fuel',
    linkedColors: { tag: FUEL_BASE_RGB.map(([r, g, b]) => ({ r, g, b })) },
  },
  {
    id: 'elevationMap', name: 'Elevation', isAttributeToColor: true,
    description: `Copernicus DEM GLO-30 elevation, ${ELEV_MIN} m (lake) to ${ELEV_MAX} m (Carson Range crest).`,
    redDescription: 'By elevation', greenDescription: 'By elevation', blueDescription: 'By elevation',
    linked: true, linkedAttributeId: 'elevation', linkedMin: ELEV_MIN, linkedMax: ELEV_MAX,
    linkedColors: {
      gradient: [
        { position: 0, r: 30, g: 62, b: 96 },
        { position: 0.18, r: 46, g: 104, b: 78 },
        { position: 0.45, r: 148, g: 154, b: 92 },
        { position: 0.75, r: 176, g: 137, b: 96 },
        { position: 1, r: 242, g: 242, b: 240 },
      ],
    },
  },
  {
    id: 'paintFire', name: 'Fire brush', isAttributeToColor: false,
    description: 'Paint a fire state onto the landscape. Cells whose fuel cannot burn (water, bare rock) are left alone.',
    redDescription: '', greenDescription: '', blueDescription: '',
    parameters: [{
      key: 'st', name: 'Paint state', type: 'tag',
      description: 'Which fire state the brush writes. Burning starts a fire; Unburned erases one.',
      tagAttributeId: 'state', defaultValue: String(S_BURNING),
    }],
  },
];

const indicators = [{
  id: 'burnArea', name: 'Fire (cells burning / burned)', kind: 'linked', dataType: 'tag',
  defaultValue: '0', accumulationMode: 'per-generation', watched: true,
  linkedAttributeId: 'state', linkedAggregation: 'frequency',
  trackedValues: ['Burning', 'Burned'],
}];

// ---------------------------------------------------------------------------
// 5. The embedded landscape (board) + the presets
// ---------------------------------------------------------------------------
// The first viewer is the default one, so the initial colours are its palette
// applied to the all-Unburned board: fully transparent. Shipping the buffer the
// app itself would write means the very first frame is right on EVERY compile
// target, before any colour pass has run.
const colors = new Uint8Array(N * N * 4);   // Unburned → rgba(0,0,0,0)

const boardLayers = {
  fuel: { type: 'int32', data: fuel },
  elevation: { type: 'int32', data: elevation },
  // `state` / `burnTimer` are deliberately ABSENT: the worker's loadState skips
  // an attribute the payload does not carry, so they keep their defaults
  // (Unburned / 0) — which is exactly the starting configuration, at no cost.
};
const board = gridStateBlock({ width: N, height: N, layers: boardLayers, colors, boundaryTreatment: 'constant' });

const DEFAULT_ATTRS = {
  spreadRate: 0.7, windE: 0.6, windN: 0, slopeBoost: 1, burnDuration: 6,
};
const paramPreset = (name, description, attrs) => ({
  id: `wfpreset_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
  name, description,
  state: {
    schemaVersion: 2, boundaryTreatment: 'constant',
    gridWidth: N, gridHeight: N, gridDepth: 1,
    modelAttrs: { ...DEFAULT_ATTRS, ...attrs },
  },
  createdAt: Date.UTC(2026, 7, 17),
});

// No "Restore landscape" preset: `resetRestoresBoard` makes Reset itself put the
// landscape back, so the board only needs to ship ONCE (in `simulationState`).
const presets = [
  paramPreset('Calm air', 'No wind — the fire spreads as a slope-driven ellipse.', { windE: 0, windN: 0 }),
  paramPreset('Strong west wind', 'A hard westerly: the fire runs east, up the Carson Range.', { windE: 0.95, windN: 0.1, spreadRate: 0.9 }),
  paramPreset('South wind, no slope', 'Wind from the south with the terrain switched off — compare the shape against Calm air to see exactly what the DEM contributes.', { windE: 0, windN: 0.9, slopeBoost: 0 }),
];

// ---------------------------------------------------------------------------
// 6. Assemble + write
// ---------------------------------------------------------------------------
const model = {
  schemaVersion: 2,
  properties: {
    createdDate: '2026-08-17',
    name: 'Wildfire - Sierra Nevada',
    author: 'Copernicus DEM GLO-30 (ESA/Airbus) + ESA WorldCover 2021 v200',
    modelAuthor: 'Rodrigo F. Figueiredo',
    description:
      'Fire spread over a real 6.2 km square of the Lake Tahoe east shore, built from open satellite data: '
      + 'terrain from the Copernicus DEM GLO-30 and fuel from ESA WorldCover 2021. Ignition probability comes from '
      + 'a per-fuel lookup table; a burning neighbour is weighted by the wind direction and by whether it lies '
      + 'downhill, so the fire runs up the Carson Range and stops at Lake Tahoe. Paint a fire anywhere and drive '
      + 'the wind live.',
    ruleDescription:
      'GEOGRAPHY. The board is a 200 x 200 window of the EPSG:4326 graticule, west -119.935 deg, south 39.145 deg, '
      + 'one arc-second (1/3600 deg) per cell — about 24 m east-west and 31 m north-south at this latitude, so cells '
      + 'are square in DEGREES rather than in metres. Elevation is the Copernicus DEM GLO-30 box-averaged onto that '
      + 'grid (it is natively 1 arc-second, so this is close to a straight copy); fuel is ESA WorldCover 2021 at 10 m '
      + 'reclassified into six classes and resampled NEAREST, because averaging class codes invents classes that do '
      + 'not exist.\n\n'
      + 'THE RULE. An Unburned cell ignites with probability P = spreadRate x ignite[fuel] x drive x 0.35, where '
      + 'drive sums one term per neighbour:\n'
      + '    term = burning x (1/distance) x windWeight x slopeFactor\n'
      + 'WIND: fire arriving from a neighbour at offset (dr, dc) travels in the compass direction (-dc east, +dr '
      + 'north), so its weight is 1 + windE x (-dc/dist) + windN x (dr/dist). The eight coefficients are compile-time '
      + 'constants inside two Expression nodes — one for the four cardinal neighbours, one for the four diagonals '
      + '(whose 1/sqrt(2) distance factor and projected wind components are the same constant).\n'
      + 'SLOPE: each neighbour also carries max(0, 1 + slopeBoost x clamp((myElevation - itsElevation)/15 m, -1, 1)), '
      + 'so fire accelerates uphill and stalls downhill. Set Slope boost to 0 and re-run to see the DEM\'s '
      + 'contribution disappear.\n\n'
      + 'A Burning cell counts Burn duration steps down and becomes Burned, which is terminal. Water and Barren have '
      + 'ignitability 0, so Lake Tahoe, Marlette Lake and the ridge scree are firebreaks that emerge from the data '
      + 'rather than from the rule.',
    instructions:
      'THE LANDSCAPE IS IMPORTED DATA, NOT A SEEDED PATTERN. It ships inside the file, so the model opens ready to '
      + 'run — and RESET PUTS IT BACK: this model declares its saved board as its initial state, so Reset clears the '
      + 'fire and restores the fuel + elevation layers. To reseed from the rules alone instead (an empty landscape), '
      + 'hover or right-click the Reset button and pick "Reseed from rules".\n\n'
      + 'TO START A FIRE: pick the "Fire brush" tab in the brush panel and click on forest or grass. The brush only '
      + 'writes where the fuel can burn, so clicking the lake does nothing. Set its "Paint state" to Unburned to '
      + 'erase a fire, or to Burned to draw a firebreak the fire cannot cross.\n\n'
      + 'THINGS TO TRY: drive "Wind -> East" from -1 to +1 while it burns and watch the plume swing round; set '
      + '"Slope boost" to 0 to switch the terrain off; edit a row of the "Fuel ignitability" table (Attributes) to '
      + 'make forest fire-resistant; switch the viewer to Fuel map or Elevation to see the source layers.\n\n'
      + 'The hillshaded basemap under the cells is the same DEM, tinted by land cover. It is drawn by the Backdrop '
      + 'map (Properties -> Structure) and can be turned off there.',
    // The board IS this model's initial state (imported data no Init Event can
    // regenerate), so Reset restores it instead of wiping it.
    resetRestoresBoard: true,
    gisTools: true,
    georef: WIN.georef,
    backdrop: { dataUrl: backdropUrl },
    thumbnail: thumbUrl,
    topology: '2d-grid',
    boundaryTreatment: 'constant',
    updateMode: 'synchronous',
    asyncScheme: 'random-order',
    gridWidth: N,
    gridHeight: N,
    maxIterations: 100000,
    tags: ['geographic', 'wildfire', 'real data', 'terrain', 'lookup-table', 'Sierra Nevada'],
    // Library policy: WebGPU wherever the compile gates accept it. This model is
    // synchronous with no async-only nodes, so they do.
    engine: 'webgpu',
    reproducibility: 'statistical',
    useWasm: false,
    useWebGPU: true,
  },
  attributes,
  neighborhoods,
  mappings,
  indicators,
  graphNodes: G.nodes,
  graphEdges: G.edges,
  macroDefs: [],
  topologyMode: { gridCells: true, agents: false },
  presets,
  simulationState: { ...board, modelAttrs: { ...DEFAULT_ATTRS }, activeViewer: 'fireOnMap' },
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(model, null, 2) + '\n', 'utf-8');
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log(
  `Wrote ${OUT}\n  ${G.nodes.length} nodes, ${G.edges.length} edges, grid ${N}x${N}, `
  + `${presets.length} presets, file ${kb(JSON.stringify(model).length)}`,
);
