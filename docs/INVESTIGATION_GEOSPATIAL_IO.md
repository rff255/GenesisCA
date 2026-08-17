# INVESTIGATION — Geospatial I/O: how map-based simulation models load/save their world, and how GenesisCA could

**Status: research / brainstorm only — no code, no decisions.** (2026-08-16)

The question: models grounded in geography — forest fire spread, urban growth, epidemic
spread, hydrology, land-use change — need an INITIAL STATE built from real-world map
data (terrain, fuel/tree cover, rivers, roads, population) plus a recognisable map
BACKDROP. How does the established tooling do this, and what is the natural way to bring
the same workflow into GenesisCA?

---

## 1. How the established models actually do it (survey)

### 1.1 Wildfire — FARSITE / FlamMap / Cell2Fire / Prometheus

The canonical pattern of the whole field lives here:

- **FARSITE / FlamMap** consume a **Landscape file (`.lcp`)** — literally a multi-band
  raster bundle: five REQUIRED co-registered bands (elevation, slope, aspect, **fuel
  model**, canopy cover) + optional crown/surface-fuel bands (canopy height, canopy base
  height, bulk density, duff, woody debris). All bands are int16, same grid, same
  extent — one file IS the layer stack. GDAL has a driver for it.
- **LANDFIRE** (the US national program) exists precisely to feed these models: it
  distributes ready-made, mutually co-registered layers for the whole country —
  historically as `.lcp`, since 2024 as **GeoTIFF** landscape files. The practitioner
  workflow is: download LANDFIRE → crop/align in a GIS (ArcGIS/QGIS) → feed the
  simulator.
- **Cell2Fire** (the modern open-source cellular fire model — the closest cousin to
  GenesisCA architecturally) takes **one Esri ASCII grid (`.asc`) or GeoTIFF per layer**
  (`fuels.asc`, `elevation.asc`, …) plus a `Weathers.csv` time series, and a small CSV
  translating **integer grid codes → fuel types** (Scott & Burgan / Canadian FBP /
  KITRAL, per country). i.e. the layer stack again, but as loose text files + a
  code-to-class lookup table.
- **Prometheus** (Canadian) likewise: gridded FBP fuel codes + weather stream.

**Takeaways:** (a) the world is a *stack of co-registered single-attribute rasters*;
(b) categorical layers are *integer-coded classes with a separate code→name table*;
(c) alignment/projection is done **before** the simulator, in a GIS — the simulator
itself refuses or ignores misaligned data; (d) time-varying drivers (weather) come as a
separate CSV, not as rasters.

### 1.2 Urban growth — SLEUTH

SLEUTH's name IS its input list: **S**lope, **L**and use, **E**xclusion, **U**rban,
**T**ransportation, **H**illshade — six layers, all required as same-size **grayscale
GIF images** whose pixel VALUES encode the classes. The hillshade layer exists purely
as the display backdrop. So a 30-year-old, still-widely-used model does exactly what
GenesisCA's image import already does: images as value-coded data layers, plus one
image that is only presentation.

### 1.3 Epidemic / population models

- Raster-based spatial models initialise from **gridded population datasets** —
  **WorldPop** and **GPW/LandScan** GeoTIFFs are the standard sources; the population
  raster becomes the susceptible-count layer, seeds are placed at coordinates
  (points or small Gaussians).
- Metapopulation models (GLEaM) instead aggregate the same population rasters into a
  subpopulation **network** + mobility fluxes — i.e. even the network models start from
  the raster.

### 1.4 General-purpose ABM platforms (the closest analogues to GenesisCA)

- **NetLogo GIS extension** — the single best reference for scope. It loads exactly
  THREE formats: **Esri ASCII grid** (raster), **Esri shapefile** and **GeoJSON**
  (vector). The core primitive is `gis:apply-raster` — copy a raster's values onto a
  **patch variable** (= a GenesisCA cell attribute), after declaring one affine
  transformation between GIS space and world space. Vector data is used either to
  rasterize onto patches or to spawn turtles (= agents). That tiny surface covers the
  overwhelming majority of published NetLogo GIS models.
- **GAMA** — richer: shapefiles / OSM / grids / images load directly, and its signature
  move is *agentification*: `create species from: shapefile` turns each vector feature
  into an agent with the feature's attributes. Roads become road agents, buildings
  become building agents.
- Repast (geography projection) and MASON (GeoMason) follow the same two-track raster
  (→ grid values) / vector (→ agents or rasterised) split.

### 1.5 The format landscape (2026)

| Kind | Format | Notes |
|---|---|---|
| Raster interchange | **Esri ASCII grid (`.asc`)** | Plain text: 6-line header (`ncols nrows xllcorner yllcorner cellsize NODATA_value`) + whitespace-separated rows. Exported by every GIS. NetLogo/Cell2Fire's raster format. Trivial to parse. |
| Raster standard | **GeoTIFF / COG** | THE raster format. Multi-band, typed, georeferenced. **geotiff.js** is a mature, pure-JS, dependency-free browser parser (used by OpenLayers, MapLibre COG protocol, etc.); Cloud-Optimized GeoTIFF adds HTTP range-request streaming so a browser can read a slice of a huge remote file. |
| Vector | **GeoJSON** | The web-native vector format; trivial JSON. Shapefile is the legacy sibling (zip of 4 files, needs a parser). |
| Heavy artillery | **gdal3.js** (GDAL→WASM) | 100+ formats + reprojection entirely client-side, but a multi-MB WASM payload — the "if we ever truly need it" option. |
| Basemaps | XYZ raster tiles / static map images | Presentation only. Every desktop tool (QGIS) and web map does backdrop this way. |

---

## 2. The universal pattern

Every surveyed system converges on the same five ideas:

1. **The world is a stack of co-registered single-attribute rasters.** One raster per
   quantity (elevation, fuel class, population…), all on the same grid.
   *GenesisCA's Structure-of-Arrays cell storage — one typed array per attribute — is
   literally this data structure already. The missing piece is only I/O.*
2. **Categorical layers are integer codes + a code→class table.** Fuel model 102,
   NLCD class 42 → "evergreen forest". *GenesisCA tag attributes + the CSV importer's
   value maps are this.*
3. **NODATA / mask**: cells outside the study area carry a sentinel and are excluded.
   *Maps to a bool mask attribute (+ synergises with Skip Isolated Empty Cells).*
4. **Vector data is either rasterised onto the grid or turned into agents.** Rivers →
   burned into a `water` layer; hospitals/ignition points → agents/seeds.
5. **Alignment happens upstream, in a GIS.** No simulator in the survey reprojects.
   The universal contract is "give me layers already on my grid" — FARSITE via the
   monolithic LCP, Cell2Fire/NetLogo by trusting the headers, SLEUTH by demanding
   same-size images. In-browser reprojection is a nice-to-have nobody actually ships.

Plus one presentation idea: **the backdrop is not data** — SLEUTH's hillshade layer,
QGIS's basemap tiles. It is drawn under the state, never read by the rule.

---

## 3. What GenesisCA already has (the gap is smaller than it looks)

| Established practice | GenesisCA today |
|---|---|
| Co-registered raster stack | SoA cell attributes — exact match, minus file I/O |
| Value-coded categorical layers | Tag attributes; CSV import's char/value maps; lookup tables keyed by tag |
| Image-as-data (SLEUTH) | "Map Image to Cells" dialog (region box, cell-size reference, binarize, manual-brush values) |
| Grid-of-values text import | CSV import, grid flavour (line=row, field=col, per-type decode, `none` delimiter for char boards) |
| Points → agents | CSV import, agent flavour (auto-mapped columns → per-agent attributes) |
| Weather/driver time series | Model attributes (live-tunable) + Overseer protocols; no per-step driver stream yet |
| Named initial states | Presets / `.gcastate` |
| Backdrop | `bg2d` solid colour only — no image underlay yet |
| Georeference metadata | none |

So the honest description: **GenesisCA is already an untyped, un-georeferenced version
of the standard architecture.** The additions are import/export adapters, a small
georeference record, and a backdrop image.

---

## 4. Proposal — tiers, cheapest first

### Tier 0 — document the workflow (zero code)
QGIS (free) exports any raster as `.asc` or as a rendered PNG; `.asc` minus its header
is whitespace-separated CSV. So *today's* pipeline is: QGIS → clip/align → export →
GenesisCA CSV/image import. A Help-tab recipe ("Using real map data") makes the
existing machinery discoverable for exactly this use.

### Tier 1 — Esri ASCII grid (`.asc`) import/export ★ best value/effort
Extend the CSV import core (`csvImport.ts` is pure + already has the dialog, the value
maps, the resize/keep-grid paths, the worker message):
- Detect the 6-line header (`ncols/nrows/xllcorner/yllcorner/cellsize/NODATA_value`,
  case-insensitive; `xllcenter` variant) → strip it, parse the body with the existing
  whitespace/space delimiter path.
- `NODATA_value` cells → the attribute default (counted, like every other miss) — or,
  optionally, into a designated bool mask attribute.
- Record `cellsize`/origin into the georeference block (Tier 3) when present.
- **Multi-file → multi-attribute**: accept several `.asc` files in one dialog session
  (they must agree on ncols/nrows — the FARSITE co-registration contract, checked and
  reported loudly), each mapped to a cell attribute. This one dialog reproduces the
  Cell2Fire/NetLogo workflow wholesale.
- Export mirror: attribute (+ layer in 3D) → `.asc` with the stored georef header.
  Round-trip is the acceptance criterion, as with CSV.

This makes GenesisCA directly consumable from every GIS on earth with no new
dependency and no projection machinery (the contract is the universal one: pre-align
upstream).

### Tier 2 — GeoTIFF import (geotiff.js)
The real-world sources (LANDFIRE, WorldPop, NLCD, Copernicus) ship GeoTIFF, and asking
users to convert each band to `.asc` is friction. `geotiff.js` is pure JS, browser-first,
tree-shakeable, no WASM — a defensible dependency for a 100%-client-side app.
- One dialog: pick file → list bands (name/type/size/nodata) → map each band to a cell
  attribute (nearest-neighbour resample to the model grid, or "resize grid to raster").
  **SHIPPED, then extended**: the dialog also carries a **crop box** and an **Average**
  resample — see "in-app crop + resample" below.
- Categorical bands get the CSV char-map treatment: distinct values listed with counts,
  each mappable to a tag option / value (the Cell2Fire code→fuel table, as UI).
- Reads the embedded georeference (origin, pixel size, CRS string) into Tier 3's block.
- COG range-request streaming is a free future upgrade of the same library (import a
  window of a country-scale raster without downloading it) — not v1. **Half of that
  arrived without it**: `readRasters({ window })` bounds geotiff.js's tile loop AND its
  allocation, so a country-scale raster already in memory is croppable; what streaming
  would add is not having to DOWNLOAD it whole.
- Deliberately **no reprojection**: if the CRS differs from the model's, say so and
  point at QGIS (state of the art does the same).

### Tier 3 — georeference block + basemap underlay
- `ModelProperties.georef?: { originX, originY, cellSize, crs?: string }` — additive,
  written by Tier 1/2 imports, consumed by exports and the underlay. Cell (0,0) ↔
  world coordinate; nothing in the engine reads it (presentation + I/O only, like C8's
  "presentational geometry" doctrine).
- **Backdrop image**: a user-supplied image (their QGIS/hillshade/satellite export)
  drawn UNDER the grid in 2D with an opacity slider, aligned by the same region/anchor
  machinery the image-import dialog already has (or trivially, stretched to the world
  rect). Stored like the thumbnail (data URL, size-capped) so it travels in the
  `.gcaproj`. This is SLEUTH's hillshade layer / QGIS's basemap — the single highest
  "feels like a real map model" win per line of code. (Live XYZ tile fetching is
  deliberately out: offline-first, CSP'd presentation export, and attribution
  obligations. A static image the user exports once is the honest version.)
- Optional polish: cursor/status readout shows world coordinates next to cell coords.

### Tier 4 — GeoJSON vector import  **[SHIPPED — see CLAUDE.md “GeoJSON vector import”]**
Two consumers, mirroring NetLogo/GAMA:
- **Rasterise onto attributes**: polygons (lakes, exclusion zones, districts) →
  point-in-polygon fill; lines (rivers, roads) → Bresenham with a width — writing a
  chosen value into a chosen attribute. Pure geometry, no dependency (GeoJSON is JSON).
- **Points → agents**: each point feature → one agent at the projected cell position,
  feature properties auto-mapped to agent attributes by name (the CSV agent importer's
  exact column logic, reused).
- Shapefile support = "convert to GeoJSON in QGIS" (Tier 0 doctrine), unless demand
  justifies a parser later.

### In-app crop + resample — MOVED IN (was assumed to be QGIS's job)
Tier 0's workflow said "crop/align in a GIS". **Cropping and resampling are not
inherently GIS work**, and both now happen in the import dialogs:
- **Crop** (GeoTIFF): a draggable box on a decoded preview + exact x/y/w/h fields. The
  size caps moved from the SOURCE to the WINDOW, so a source far larger than one import
  can hold now opens on a centred cap-sized box instead of an error. The preview comes
  from a reduced-resolution **overview** IFD when the file carries one (a COG), else the
  main image when it fits the decode budget; with neither, the crop is set numerically.
- **Resample**: `average` (a NODATA-aware box filter) joins `nearest` for **numeric**
  targets on both the GeoTIFF and `.asc` paths — categorical targets stay nearest-only,
  enforced in the pure builder, not just hidden in the UI.
- The georeference follows: a crop shifts the recorded corner (with the top-left →
  lower-left row flip), a resample scales the recorded cell size.
- **What is left for a GIS: REPROJECTION and format conversion.** That boundary is now
  the honest one, and it is what the docs say.

### Tier 5 — explicitly NOT proposed (and why)
- **In-browser reprojection / gdal3.js**: multi-MB WASM, and the surveyed field
  uniformly pre-aligns upstream. Revisit only on real demand.
- **NetCDF/Zarr time-cubes** (weather streams): the established need is real
  (Cell2Fire's `Weathers.csv`), but GenesisCA's model attributes + the Overseer
  (`ovSetModelAttribute` per epoch, or a future per-step driver table) cover the
  simulation-side half; a CSV weather stream is already importable. A first-class
  "driver series" concept is its own investigation.
- **Live web basemaps (XYZ/MapLibre)**: conflicts with offline-first + the standalone
  export's strict CSP; static image underlay wins.

---

## 5. Sample models this unlocks (each a library card + a doc recipe)

1. **Forest fire on real terrain** — LANDFIRE (or Copernicus fuel map) crop: fuel-class
   tag layer + elevation + a moisture model attribute; slope-directed spread rule;
   hillshade underlay; ignition via brush. The classic demo of the whole feature.
2. **SIR on a population raster** — WorldPop clip → `population` (integer) layer;
   density-scaled infection CA; seed by brush; the frequency indicator IS the epi curve.
3. **Urban growth, SLEUTH-flavoured** — slope + exclusion + roads layers, growth rule
   with the four SLEUTH growth types as model attributes.

---

## 6. Risks / open questions

- **Grid-size ceilings**: a LANDFIRE county crop at 30 m is easily 3000×4000 — within
  the engine's range but users will try whole states. The import dialog should show the
  resulting cell count and steer to resampling (the image dialog's cell-size reference
  box already is a resampler UI).
- **`.gcaproj` weight**: an imported board becomes `simulationState` (base64) — a
  3000×4000 float layer ≈ 90 MB embedded. Likely fine to save layers into the state as
  today, but the backdrop image + several layers argue for the existing "include board
  state" checkbox discipline, not new machinery.
- **Value semantics**: elevation as float attr vs. the engine's f32-on-WebGPU — fine
  (same stance as everything else), but document that exact integer codes should be
  int/tag attributes.
- **3D**: `.asc`/GeoTIFF are 2D; a DEM could optionally EXTRUDE into the 3D grid
  (terrain voxels) — cute, defer.
- **Agent world georef**: agents share the grid frame 1:1, so Tier 3's georef covers
  them for free (GeoJSON points → agent x/y needs only the same affine).

## 7. Recommendation

Tier 1 (+ the Tier 3 georef record it wants) is a small, high-leverage extension of the
existing CSV import that instantly makes GenesisCA interoperable with the entire GIS
ecosystem by the same contract FARSITE/Cell2Fire/NetLogo use. Tier 3's backdrop image is
the visible half. Tier 2 (geotiff.js) is the one new dependency worth debating. Tier 4
completes the NetLogo-parity story. Everything else stays out until demand shows up.

---

## Sources

- GDAL LCP driver (FARSITE landscape format): https://gdal.org/en/stable/drivers/raster/lcp.html
- LANDFIRE landscape files (LCP → GeoTIFF): https://www.landfire.gov/fuel/landscape
- IFTDSS LCP documentation: https://iftdss.firenet.gov/firenetHelp/help/pageHelp/content/20-landscapes/lcpinfo.htm
- Cell2Fire (paper + repo): https://arxiv.org/pdf/1905.09317 · https://github.com/humnetlab/Cell2Fire
- Cell2Fire on real landscapes (Sci Rep 2025): https://www.nature.com/articles/s41598-025-05706-6
- SLEUTH input layers (case studies): https://pmc.ncbi.nlm.nih.gov/articles/PMC6837527/ · https://www.nature.com/articles/s41597-019-0048-z
- NetLogo GIS extension manual: https://ccl.northwestern.edu/netlogo/docs/gis.html
- GAMA data importation (GIS/OSM/grid): https://gama-platform.org/wiki/LuneraysFlu_step3 · https://github.com/gama-platform/gama/wiki/Data-Importation-Raster-Images-and-shapefile-Import
- GLEaM (gridded population → metapopulation): https://pmc.ncbi.nlm.nih.gov/articles/PMC3056392/
- WorldPop/satellite-derived epi modeling: https://www.nature.com/articles/s41598-021-86124-2
- geotiff.js: https://geotiffjs.github.io/ · COG: https://cogeo.org/ · MapLibre COG protocol: https://github.com/geomatico/maplibre-cog-protocol
- gdal3.js (GDAL→WASM): https://gdal3.js.org/
