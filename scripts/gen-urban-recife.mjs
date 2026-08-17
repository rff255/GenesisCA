#!/usr/bin/env node
/**
 * Generates `public/models/Urban Growth - Recife.gcaproj` — a SLEUTH-style
 * urbanisation CA running on a REAL 6.2 km square of the western growth
 * frontier of Recife, Brazil, built from three open geographic sources.
 *
 *   Terrain    Copernicus DEM GLO-30 (ESA/Airbus, 1 arc-second)
 *              copernicus-dem-30m.s3.amazonaws.com — tile S09/W035
 *   Land cover ESA WorldCover 2021 v200 (10 m, 11 classes)
 *              esa-worldcover.s3.eu-central-1.amazonaws.com — tile S09W036
 *   Roads      OpenStreetMap via Overpass — motorway / trunk / primary /
 *              secondary / tertiary ways, `out geom;` → GeoJSON LineStrings
 *              rasterised with GenesisCA's own `lineCells` supercover walk
 *
 *   Window     west -34.98°, south -8.06°   (EPSG:4326)
 *              200 × 200 cells of 1 arc-second (1/3600°)
 *              → the Camaragibe / Jaboatão frontier west of central Recife:
 *                about half built-up, half still forest and open ground, with
 *                the Atlantic-forest hills behind it.
 *
 * THE RULE — the three classic SLEUTH pressures, each a live slider:
 *
 *     P = baseRate · suitability[landUse]
 *                  · (urbanNeighbours / 8)                     ← edge growth
 *                  · (1 + roadWeight · exp(−roadDist/roadReach)) ← road pull
 *                  ÷ (1 + slopeResist · slope/20)               ← slope resistance
 *
 * `suitability` is a one-axis LOOKUP TABLE keyed by the land-use class, so the
 * user can protect the forest (set Vegetation to 0) without touching the graph.
 * `roadDist` is a multi-source BFS from the rasterised OSM network, computed
 * once in this script; `slope` is Horn's 3×3 gradient over the DEM in percent.
 *
 * THE LANDSCAPE LIVES IN THE FILE, and Reset CLEARS it (this model has no Init
 * Events to re-seed from) — hence the shipped "Restore landscape" preset. See
 * `properties.instructions`.
 *
 *   node scripts/gen-urban-recife.mjs
 *
 * Raw source windows + the Overpass response are cached under
 * `scripts/geodata-cache/` (gitignored), so a re-run is offline-stable.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readCogWindow, overpass, waysToLineStrings, windowGeoref, metresPerDegree, terrain,
  distanceField, encodePNG, pngDataUrl, downscaleRGB, upsampleBilinear,
  idFactory, graphBuilder, exprConfig, EXPR_PORTS, gridStateBlock, loadTsModule,
} from './geodataLib.mjs';
import { resampleNearest, resampleAverage } from '../src/simulator/rasterResample.ts';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'models', 'Urban Growth - Recife.gcaproj');

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------
const N = 200;
const CELL = 1 / 3600;
const WEST = -34.98, SOUTH = -8.06;
const WIN = windowGeoref(WEST, SOUTH, CELL, N, N);
const DEM_URL = 'https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_S09_00_W035_00_DEM/Copernicus_DSM_COG_10_S09_00_W035_00_DEM.tif';
const WC_URL = 'https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_S09W036_Map.tif';
const ROAD_CLASSES = 'motorway|trunk|primary|secondary|tertiary';

// ---------------------------------------------------------------------------
// Land-use classes
// ---------------------------------------------------------------------------
const LAND = ['Water', 'Vegetation', 'Open', 'Urban', 'Road'];
const L_WATER = 0, L_VEG = 1, L_OPEN = 2, L_URBAN = 3, L_ROAD = 4;
const WC_TO_LAND = {
  10: L_VEG,    // tree cover
  20: L_VEG,    // shrubland
  30: L_OPEN,   // grassland
  40: L_OPEN,   // cropland
  50: L_URBAN,  // built-up
  60: L_OPEN,   // bare / sparse vegetation
  70: L_OPEN,   // snow and ice (absent here)
  80: L_WATER,  // permanent water
  90: L_WATER,  // herbaceous wetland
  95: L_VEG,    // mangroves
  100: L_OPEN,  // moss and lichen
};
/** Developable suitability per class — the shipped Lookup Table contents.
 *  Water cannot be built on, Urban and Road are already developed. */
const SUITABILITY = [0.0, 0.9, 1.0, 0.0, 0.0];

const ROAD_DIST_CAP = 60;   // cells; beyond this the road pull is negligible anyway
const SLOPE_CAP = 100;      // percent

const LAND_BASE_RGB = [
  [40, 84, 122],   // Water      — estuary blue
  [46, 82, 44],    // Vegetation — Atlantic forest
  [150, 146, 106], // Open       — cleared ground
  [176, 130, 112], // Urban      — terracotta rooftops
  [228, 222, 210], // Road       — pale asphalt
];

// ---------------------------------------------------------------------------
// 1. Fetch + resample
// ---------------------------------------------------------------------------
console.log(`Urban Growth — Recife: window ${WIN.west}..${WIN.east}, ${WIN.south}..${WIN.north} (${N}x${N} @ ${CELL}°)`);

const demWin = await readCogWindow({
  url: DEM_URL, key: `recife-dem-${WEST}_${SOUTH}_${N}`,
  west: WIN.west, south: WIN.south, east: WIN.east, north: WIN.north, dtype: 'f32',
});
const wcWin = await readCogWindow({
  url: WC_URL, key: `recife-wc-${WEST}_${SOUTH}_${N}`,
  west: WIN.west, south: WIN.south, east: WIN.east, north: WIN.north, dtype: 'u8',
});
const osm = await overpass(
  `recife-roads-${WEST}_${SOUTH}_${N}`,
  `[out:json][timeout:90];way[highway~"^(${ROAD_CLASSES})$"](${WIN.south},${WIN.west},${WIN.north},${WIN.east});out geom;`,
);
const roadLines = waysToLineStrings(osm);
console.log(`  DEM ${demWin.w}x${demWin.h}, WorldCover ${wcWin.w}x${wcWin.h}, OSM ${roadLines.length} road ways`);

const elevF = resampleAverage(demWin.values, demWin.w, demWin.h, N, N);
const wcF = resampleNearest(wcWin.values, wcWin.w, wcWin.h, N, N);

const elevation = new Float64Array(N * N);
const landUse = new Int32Array(N * N);
for (let i = 0; i < N * N; i++) {
  const e = elevF[i];
  elevation[i] = Number.isFinite(e) ? e : 0;
  landUse[i] = WC_TO_LAND[wcF[i] | 0] ?? L_OPEN;
}

// ---------------------------------------------------------------------------
// 2. Roads → cells (GenesisCA's own supercover rasteriser) → landUse + roadDist
// ---------------------------------------------------------------------------
const GJ = await loadTsModule('src/simulator/geojsonImport.ts', 'geojson');
/** Burn every road line into a boolean mask on a `w × h` grid covering the
 *  window, using the SAME transform + supercover walk the app's GeoJSON
 *  importer uses (so what this script bakes is exactly what a user would get by
 *  importing the same file). */
function burnRoads(w, h) {
  const t = GJ.makeCellTransform({ xllcorner: WIN.west, yllcorner: WIN.south, cellSize: (N * CELL) / w }, h, 'world');
  const mask = new Uint8Array(w * h);
  for (const line of roadLines) {
    const path = line.coords.map(([lon, lat]) => GJ.toCellSpace(t, lon, lat));
    GJ.lineCells(path, 1, w, h, (c, r) => { mask[r * w + c] = 1; });
  }
  return mask;
}
const roadMask = burnRoads(N, N);
let roadCells = 0;
for (let i = 0; i < N * N; i++) if (roadMask[i]) { landUse[i] = L_ROAD; roadCells++; }

const roadDist32 = distanceField(N, N, (i) => roadMask[i] === 1, ROAD_DIST_CAP);
const roadDist = Int32Array.from(roadDist32);

// ---------------------------------------------------------------------------
// 3. Terrain → slope (percent) + the hillshade for the backdrop
// ---------------------------------------------------------------------------
const midLat = WIN.south + (N * CELL) / 2;
const { perLat, perLon } = metresPerDegree(midLat);
const MX = CELL * perLon, MY = CELL * perLat;
const { shade, slopePct } = terrain(elevation, N, N, MX, MY);
const slope = new Int32Array(N * N);
for (let i = 0; i < N * N; i++) slope[i] = Math.min(SLOPE_CAP, Math.max(0, Math.round(slopePct[i])));

{
  const hist = {};
  for (const v of landUse) hist[LAND[v]] = (hist[LAND[v]] || 0) + 1;
  let eMin = Infinity, eMax = -Infinity, sMax = 0;
  for (const v of elevation) { if (v < eMin) eMin = v; if (v > eMax) eMax = v; }
  for (const v of slope) if (v > sMax) sMax = v;
  console.log('  land use ' + Object.entries(hist).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${(100 * v / (N * N)).toFixed(1)}%`).join(', '));
  console.log(`  roads ${roadCells} cells; elevation ${eMin.toFixed(0)}..${eMax.toFixed(0)} m; slope 0..${sMax}%`);
}

// ---------------------------------------------------------------------------
// 4. Backdrop + thumbnail (land cover x hillshade, roads drawn on top)
// ---------------------------------------------------------------------------
const BD = N * 3;   // the land cover's native 10 m resolution
const bdCover = resampleNearest(wcWin.values, wcWin.w, wcWin.h, BD, BD);
// Quantise the shade to 48 levels: invisible on screen, but it collapses the
// hillshade's continuous ramp into a handful of runs, which is most of the
// backdrop PNG's size.
const bdShade = upsampleBilinear(shade, N, N, BD, BD).map(v => Math.round(v * 48) / 48);
const bdRoads = burnRoads(BD, BD);
const backdropRGB = new Uint8Array(BD * BD * 3);
for (let i = 0; i < BD * BD; i++) {
  const cls = bdRoads[i] ? L_ROAD : (WC_TO_LAND[bdCover[i] | 0] ?? L_OPEN);
  const base = LAND_BASE_RGB[cls];
  const k = cls === L_WATER ? 0.85 + 0.30 * bdShade[i] : 0.35 + 1.00 * bdShade[i];
  for (let c = 0; c < 3; c++) backdropRGB[i * 3 + c] = Math.max(0, Math.min(255, Math.round(base[c] * k)));
}
const backdropUrl = pngDataUrl(BD, BD, backdropRGB);
const thumbRGB = downscaleRGB(backdropRGB, BD, BD, 256, 256);
const thumbUrl = pngDataUrl(256, 256, thumbRGB);
console.log(`  backdrop ${BD}x${BD} ${(encodePNG(BD, BD, backdropRGB).length / 1024).toFixed(0)} KB, thumbnail ${(encodePNG(256, 256, thumbRGB).length / 1024).toFixed(0)} KB`);

// ---------------------------------------------------------------------------
// 5. The rule graph
// ---------------------------------------------------------------------------
const newId = idFactory('ur');
const G = graphBuilder(newId);
const { node, vEdge, fEdge } = G;

const NBR = 'moore8';
const step = node('step', {}, 0, 0, 'Urbanisation');

const myLand = node('getCellAttribute', { attributeId: 'landUse' }, 0, 2);
const myRoadDist = node('getCellAttribute', { attributeId: 'roadDist' }, 0, 3);
const mySlope = node('getCellAttribute', { attributeId: 'slope' }, 0, 4);

const mBase = node('getModelAttribute', { attributeId: 'baseRate', isColorAttr: false }, 0, 6);
const mRoadW = node('getModelAttribute', { attributeId: 'roadWeight', isColorAttr: false }, 0, 7);
const mRoadR = node('getModelAttribute', { attributeId: 'roadReach', isColorAttr: false }, 0, 8);
const mSlopeR = node('getModelAttribute', { attributeId: 'slopeResist', isColorAttr: false }, 0, 9);

// Urban and Road neighbours are counted SEPARATELY, and that separation is
// load-bearing. Counting them together ("developed neighbours") made every
// road-adjacent cell eligible to grow whatever `Road attraction` was set to —
// measured in the real worker, turning the slider to 0 then left the new
// development just as road-hugging (mean distance to road 5.9 cells vs 5.5),
// i.e. the slider did nothing the user could see. Counting them apart lets ONE
// slider own the whole road mechanism: at 0 a road neither seeds growth nor
// pulls it, and the network drops out of the rule entirely.
//
// The compare threshold is a wired Get Constant, not an inline widget: Group
// Counting's `Compare To` port carries no inline widget, so a `_port_compare`
// config key would be silently ignored and the count would fall back to "> 0".
const nbrLand = node('getNeighborsAttribute', { neighborhoodId: NBR, attributeId: 'landUse' }, 1, 11, 'Neighbours’ land use');
const urbanConst = node('getConstant', { constType: 'tag', tagAttributeId: 'landUse', constValue: String(L_URBAN) }, 1, 12, 'Urban');
const roadConst = node('getConstant', { constType: 'tag', tagAttributeId: 'landUse', constValue: String(L_ROAD) }, 1, 14, 'Road');
const nUrban = node('groupCounting', { operation: 'equals' }, 2, 11, 'Urban neighbours');
vEdge(nbrLand, 'values', nUrban, 'values');
vEdge(urbanConst, 'value', nUrban, 'compare');
const nRoad = node('groupCounting', { operation: 'equals' }, 2, 13, 'Road neighbours');
vEdge(nbrLand, 'values', nRoad, 'values');
vEdge(roadConst, 'value', nRoad, 'compare');

const suit = node('lookupInteraction', { tableId: 'suit' }, 1, 2, 'Developable?');
vEdge(myLand, 'value', suit, 'axis_0');

// edge = (urbanNeighbours + roadAttraction/4 * roadNeighbours) / 8 — a road
// beside you is worth a quarter of an urban neighbour per unit of attraction,
// which is what lets a new highway seed a satellite town in open country.
const edgePressure = node(
  'expression',
  exprConfig('(nUrban + rw * 0.25 * nRoad) / 8', ['nUrban', 'rw', 'nRoad']),
  3, 11, 'Edge pressure',
);
vEdge(nUrban, 'count', edgePressure, EXPR_PORTS[0]);
vEdge(mRoadW, 'value', edgePressure, EXPR_PORTS[1]);
vEdge(nRoad, 'count', edgePressure, EXPR_PORTS[2]);

// P = base * suit * edge * (1 + roadWeight*exp(-roadDist/roadReach)) / (1 + slopeResist*slope/20)
const pUrbanise = node(
  'expression',
  exprConfig(
    'base * suit * edge * (1 + rw * exp(-rd / rr)) / (1 + sr * slope / 20)',
    ['base', 'suit', 'edge', 'rw', 'rd', 'rr', 'sr', 'slope'],
  ),
  4, 6, 'P(urbanise this step)',
);
vEdge(mBase, 'value', pUrbanise, EXPR_PORTS[0]);
vEdge(suit, 'value', pUrbanise, EXPR_PORTS[1]);
vEdge(edgePressure, 'result', pUrbanise, EXPR_PORTS[2]);
vEdge(mRoadW, 'value', pUrbanise, EXPR_PORTS[3]);
vEdge(myRoadDist, 'value', pUrbanise, EXPR_PORTS[4]);
vEdge(mRoadR, 'value', pUrbanise, EXPR_PORTS[5]);
vEdge(mSlopeR, 'value', pUrbanise, EXPR_PORTS[6]);
vEdge(mySlope, 'value', pUrbanise, EXPR_PORTS[7]);

const roll = node('getRandom', { randomType: 'float', _port_min: '0', _port_max: '1' }, 3, 9);
const grows = node('statement', { operation: '<', compareType: 'numerical' }, 4, 7);
vEdge(roll, 'value', grows, 'x');
vEdge(pUrbanise, 'result', grows, 'y');

const developable = node('statement', { operation: '>', compareType: 'numerical', _port_y: '0' }, 2, 2, 'Can be built on?');
vEdge(suit, 'value', developable, 'x');
const gateDevelopable = node('conditional', {}, 5, 2, 'Developable?');
fEdge(step, 'do', gateDevelopable, 'check');
vEdge(developable, 'result', gateDevelopable, 'condition');
const gateGrow = node('conditional', {}, 6, 2, 'Urbanises?');
fEdge(gateDevelopable, 'then', gateGrow, 'check');
vEdge(grows, 'result', gateGrow, 'condition');
const setUrban = node('setAttribute', { attributeId: 'landUse', _port_value: String(L_URBAN) }, 7, 2);
fEdge(gateGrow, 'then', setUrban, 'do');

// --- the planning brush -----------------------------------------------------
const im = node('inputColor', { mappingId: 'paintLand' }, 0, 20, 'Planning brush');
const imSet = node('setAttribute', { attributeId: 'landUse' }, 1, 20);
fEdge(im, 'do', imSet, 'do');
vEdge(im, 'lu', imSet, 'value');

// ---------------------------------------------------------------------------
// 6. Model parts
// ---------------------------------------------------------------------------
const attributes = [
  {
    id: 'landUse', name: 'Land use', type: 'tag',
    description: 'Reclassified from ESA WorldCover 2021 (10 m): tree cover / shrubland / mangrove → Vegetation, grassland / cropland / bare → Open, built-up → Urban, water / wetland → Water. Cells crossed by an OpenStreetMap major road are overwritten as Road.',
    isModelAttribute: false, defaultValue: '0', boundaryValue: '0', tagOptions: LAND,
  },
  {
    id: 'roadDist', name: 'Distance to road', type: 'integer',
    description: `Cells to the nearest OpenStreetMap major road (motorway / trunk / primary / secondary / tertiary), by 8-connected breadth-first search over the rasterised network, capped at ${ROAD_DIST_CAP}. Static — the rule reads it, nothing writes it.`,
    isModelAttribute: false, defaultValue: String(ROAD_DIST_CAP), boundaryValue: String(ROAD_DIST_CAP),
  },
  {
    id: 'slope', name: 'Slope', type: 'integer',
    description: 'Ground slope in percent (rise / run x 100), from Horn’s 3x3 gradient over the Copernicus DEM GLO-30. Steep ground resists development.',
    isModelAttribute: false, defaultValue: '0', boundaryValue: '0',
  },
  {
    id: 'suit', name: 'Developable suitability', type: 'lookupTable',
    description: 'Per-land-use weight on the urbanisation probability, and the model’s exclusion layer: 0 means "never builds". Water is 0 by geography; Urban and Road are 0 because they are already developed. Set Vegetation to 0 to protect the Atlantic forest and watch growth divert onto open ground.',
    isModelAttribute: true, defaultValue: '0',
    axes: [{ name: 'Land use', source: { kind: 'tagAttribute', attributeId: 'landUse' } }],
    valueType: 'float',
    tableData: SUITABILITY.slice(),
  },
  {
    id: 'baseRate', name: 'Growth rate', type: 'float',
    description: 'Global multiplier on every urbanisation probability — how fast the city grows per step.',
    isModelAttribute: true, defaultValue: '0.06', hasBounds: true, min: 0, max: 0.5,
  },
  {
    id: 'roadWeight', name: 'Road attraction', type: 'float',
    description: 'How much more likely development is right beside a road. 0 removes the road network from the rule entirely (compare the resulting shape against the default).',
    isModelAttribute: true, defaultValue: '2', hasBounds: true, min: 0, max: 4,
  },
  {
    id: 'roadReach', name: 'Road reach', type: 'float',
    description: 'Decay length of the road pull, in cells (~30 m each): the attraction falls off as exp(-distance / reach).',
    isModelAttribute: true, defaultValue: '6', hasBounds: true, min: 1, max: 30,
  },
  {
    id: 'slopeResist', name: 'Slope resistance', type: 'float',
    description: 'How strongly steep ground resists development. At 1 a 20 % slope halves the probability; 0 makes the terrain irrelevant.',
    isModelAttribute: true, defaultValue: '1.2', hasBounds: true, min: 0, max: 4,
  },
];

const neighborhoods = [{
  id: NBR, name: 'Moore (8)',
  description: 'The eight surrounding cells — the edge-growth term counts how many of them are already developed (Urban or Road).',
  coords: [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]],
  margin: 1, includeCentralCell: false,
}];

const mappings = [
  {
    id: 'cityOnMap', name: 'City on the map', isAttributeToColor: true,
    description: 'Only the built environment is drawn — water, forest and open ground are fully transparent, so the satellite-derived basemap reads through and the city grows over the real landscape.',
    redDescription: 'By land use', greenDescription: 'By land use', blueDescription: 'By land use',
    linked: true, linkedAttributeId: 'landUse',
    linkedColors: {
      tag: [
        { r: 0, g: 0, b: 0, a: 0 },          // Water      — invisible
        { r: 0, g: 0, b: 0, a: 0 },          // Vegetation — invisible
        { r: 0, g: 0, b: 0, a: 0 },          // Open       — invisible
        { r: 240, g: 96, b: 72, a: 235 },    // Urban      — hot terracotta
        { r: 250, g: 244, b: 232, a: 255 },  // Road       — pale asphalt
      ],
    },
  },
  {
    id: 'landUseMap', name: 'Land use', isAttributeToColor: true,
    description: 'The full classification: Water, Vegetation, Open, Urban, Road.',
    redDescription: 'By land use', greenDescription: 'By land use', blueDescription: 'By land use',
    linked: true, linkedAttributeId: 'landUse',
    linkedColors: { tag: LAND_BASE_RGB.map(([r, g, b]) => ({ r, g, b })) },
  },
  {
    id: 'roadDistMap', name: 'Distance to road', isAttributeToColor: true,
    description: 'The road-pull field: bright on the network, fading out over `Road reach` cells.',
    redDescription: 'By distance', greenDescription: 'By distance', blueDescription: 'By distance',
    linked: true, linkedAttributeId: 'roadDist', linkedMin: 0, linkedMax: 30,
    linkedColors: {
      gradient: [
        { position: 0, r: 255, g: 244, b: 214 },
        { position: 0.35, r: 232, g: 150, b: 74 },
        { position: 1, r: 34, g: 38, b: 58 },
      ],
    },
  },
  {
    id: 'slopeMap', name: 'Slope', isAttributeToColor: true,
    description: 'Ground slope in percent — the resistance layer.',
    redDescription: 'By slope', greenDescription: 'By slope', blueDescription: 'By slope',
    linked: true, linkedAttributeId: 'slope', linkedMin: 0, linkedMax: 35,
    linkedColors: {
      gradient: [
        { position: 0, r: 28, g: 46, b: 44 },
        { position: 0.5, r: 116, g: 156, b: 108 },
        { position: 1, r: 246, g: 236, b: 200 },
      ],
    },
  },
  {
    id: 'paintLand', name: 'Planning brush', isAttributeToColor: false,
    description: 'Paint a land-use class: draw a new road corridor, zone a park (Vegetation), or seed a satellite town (Urban).',
    redDescription: '', greenDescription: '', blueDescription: '',
    parameters: [{
      key: 'lu', name: 'Paint class', type: 'tag',
      description: 'The land-use class the brush writes.',
      tagAttributeId: 'landUse', defaultValue: String(L_URBAN),
    }],
  },
];

const indicators = [{
  id: 'built', name: 'Built-up cells', kind: 'linked', dataType: 'tag',
  defaultValue: '0', accumulationMode: 'per-generation', watched: true,
  linkedAttributeId: 'landUse', linkedAggregation: 'frequency',
  trackedValues: ['Urban'],
}];

// ---------------------------------------------------------------------------
// 7. Board + presets
// ---------------------------------------------------------------------------
// The default viewer is "City on the map": Urban/Road opaque, everything else
// transparent. Shipping the buffer the app itself would write makes the very
// first frame right on every compile target, before any colour pass has run.
const colors = new Uint8Array(N * N * 4);
{
  const pal = mappings[0].linkedColors.tag;
  for (let i = 0; i < N * N; i++) {
    const c = pal[landUse[i]];
    colors[i * 4] = c.r; colors[i * 4 + 1] = c.g; colors[i * 4 + 2] = c.b;
    colors[i * 4 + 3] = c.a ?? 255;
  }
}

const board = gridStateBlock({
  width: N, height: N, boundaryTreatment: 'constant',
  layers: {
    landUse: { type: 'int32', data: landUse },
    roadDist: { type: 'int32', data: roadDist },
    slope: { type: 'int32', data: slope },
  },
  colors,
});

const DEFAULT_ATTRS = { baseRate: 0.06, roadWeight: 2, roadReach: 6, slopeResist: 1.2 };
const paramPreset = (name, description, attrs) => ({
  id: `urpreset_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
  name, description,
  state: {
    schemaVersion: 2, boundaryTreatment: 'constant',
    gridWidth: N, gridHeight: N, gridDepth: 1,
    modelAttrs: { ...DEFAULT_ATTRS, ...attrs },
  },
  createdAt: Date.UTC(2026, 7, 17),
});

const presets = [
  {
    id: 'urpreset_restore_landscape',
    name: 'Restore landscape',
    description: 'The imported Recife landscape (land use + road distance + slope) as it stands today. Load this after a Reset — Reset re-seeds the grid from the model’s Init Events, which clears imported data.',
    state: { ...board, modelAttrs: { ...DEFAULT_ATTRS } },
    createdAt: Date.UTC(2026, 7, 17),
  },
  paramPreset('Road-led sprawl', 'Strong road attraction with a long reach and little regard for terrain — ribbon development races out along the highways.', { roadWeight: 4, roadReach: 14, slopeResist: 0.3, baseRate: 0.09 }),
  paramPreset('Compact infill', 'The road network barely matters; growth thickens the existing urban edge instead of leaping ahead of it.', { roadWeight: 0, roadReach: 6, slopeResist: 1.5, baseRate: 0.09 }),
  paramPreset('Terrain-constrained', 'Steep ground is nearly unbuildable, so the city is pushed along the valleys.', { roadWeight: 1.5, roadReach: 8, slopeResist: 4, baseRate: 0.12 }),
];

// ---------------------------------------------------------------------------
// 8. Assemble + write
// ---------------------------------------------------------------------------
const model = {
  schemaVersion: 2,
  properties: {
    createdDate: '2026-08-17',
    name: 'Urban Growth - Recife',
    author: 'ESA WorldCover 2021 + Copernicus DEM GLO-30 + OpenStreetMap contributors',
    modelAuthor: 'Rodrigo F. Figueiredo',
    description:
      'A SLEUTH-style urbanisation CA on a real 6.2 km square of the western growth frontier of Recife, Brazil. '
      + 'Land use comes from ESA WorldCover, the road network from OpenStreetMap, and the slope layer from the '
      + 'Copernicus DEM. Development spreads from the existing urban edge, is pulled toward the roads and pushed '
      + 'away from steep ground — three live sliders and one editable suitability table.',
    ruleDescription:
      'GEOGRAPHY. The board is a 200 x 200 window of the EPSG:4326 graticule, west -34.98 deg, south -8.06 deg, one '
      + 'arc-second (1/3600 deg) per cell — about 30.6 m each way at this latitude. Land use is ESA WorldCover 2021 '
      + '(10 m) reclassified into five classes and resampled NEAREST; the OpenStreetMap major-road network '
      + '(motorway / trunk / primary / secondary / tertiary) is rasterised with the same supercover walk the app\'s '
      + 'own GeoJSON importer uses and burned in as the Road class; `Distance to road` is a multi-source '
      + 'breadth-first search from those cells; `Slope` is Horn\'s 3x3 gradient over the Copernicus DEM, in percent.\n\n'
      + 'THE RULE. A cell whose suitability is above zero (Vegetation or Open) urbanises with probability\n'
      + '    P = growthRate x suitability[landUse]\n'
      + '        x ((urbanNeighbours + roadAttraction/4 x roadNeighbours) / 8)  <- edge growth\n'
      + '        x (1 + roadAttraction x exp(-roadDist / roadReach))            <- road pull\n'
      + '        / (1 + slopeResistance x slope / 20)                           <- slope resistance\n'
      + 'computed by two Expression nodes. Urban and Road neighbours are counted SEPARATELY so that ONE slider owns '
      + 'the whole road mechanism: at Road attraction 0 a road neither seeds growth nor pulls it and the network '
      + 'leaves the rule entirely, while above 0 a road beside a cell is worth a quarter of an urban neighbour per '
      + 'unit of attraction — which is what lets a new highway seed a satellite town in open country.\n\n'
      + 'The suitability table is the model\'s EXCLUSION LAYER: setting Vegetation to 0 protects the Atlantic forest '
      + 'and diverts growth onto open ground, without touching the graph. Setting Road attraction to 0 removes the '
      + 'OSM network from the rule entirely — run both and compare the shapes.',
    instructions:
      'THE LANDSCAPE IS IMPORTED DATA, NOT A SEEDED PATTERN. It ships inside the file, so the model opens ready to '
      + 'run — but Reset re-seeds the grid from the model\'s own Init Events, and this model has none, so RESET '
      + 'CLEARS THE LANDSCAPE. To get it back, load the "Restore landscape" preset (Presets, in the left panel) or '
      + 'simply re-open the model.\n\n'
      + 'WHAT YOU SEE: the default viewer draws ONLY the built environment (roads pale, city red) over the '
      + 'satellite-derived basemap, so new development is obvious against the forest. Switch to Land use, Distance '
      + 'to road or Slope to inspect the three source layers.\n\n'
      + 'THINGS TO TRY: press Play and watch which side of the frontier fills in first; drive "Road attraction" to 0 '
      + 'mid-run and see the growth front stop chasing the highways; set the Vegetation row of the "Developable '
      + 'suitability" table (Attributes) to 0 to protect the forest; use the Planning brush to draw a new road '
      + 'corridor into open country and watch a satellite town form along it.\n\n'
      + 'Road geometry (c) OpenStreetMap contributors, ODbL.',
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
    tags: ['geographic', 'urban growth', 'real data', 'SLEUTH', 'OpenStreetMap', 'Recife'],
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
  simulationState: { ...board, modelAttrs: { ...DEFAULT_ATTRS }, activeViewer: 'cityOnMap' },
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(model, null, 2) + '\n', 'utf-8');
console.log(
  `Wrote ${OUT}\n  ${G.nodes.length} nodes, ${G.edges.length} edges, grid ${N}x${N}, `
  + `${presets.length} presets, file ${(JSON.stringify(model).length / 1024).toFixed(0)} KB`,
);
