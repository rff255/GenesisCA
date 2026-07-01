# Plan — Agent Output-Mapping Graphs (standalone/linked) + Agent Sprites

Branch: `polish_agents`. Illustrated mockup: [PLAN_AGENT_OUTPUT_MAPPINGS_SPRITES.html](PLAN_AGENT_OUTPUT_MAPPINGS_SPRITES.html).

## Goal

Two coupled features, both layered on the existing agent platform:

1. **Authorable agent output-mapping graphs.** Today `model.agentMappings` are **linked-only** — the
   compiler synthesizes a `getCellAttribute → colorScale/categorical → setCellLooks` colour pass and the user
   can only pick an attribute → palette. Make them **Standalone _or_ Linked**, exactly like CA-grid output
   mappings: a graph (rooted at an **Agent Output Mapping (A→C)** event node) that runs **after the
   behaviour/division graphs** and defines whatever exhibition / alternative view the user wants. Standalone +
   Linked + override-after-background all mirror the cell side.

2. **Agent sprites.** An optional exhibition layer for agent output mappings: each agent can be drawn as a
   **static image or animated GIF/WebP** instead of a filled circle.

> **DESIGN CORRECTION (post-review — supersedes the simulator-transport wording below).** Sprite playback is
> **NOT a manual simulator transport** — it is **driven by the agent's logic** through the **Set Agent Sprite**
> node, which carries **independently-tickable facets**: *Change sprite* / *Set frame* / *Set speed* (speed in
> frames per simulation step; **negative = reverse**; 0 = hold). Tick only the facets you want to change (swap
> the sprite but keep the frame/speed; only change speed; reset to frame 0; …). The per-agent sprite state
> (slot + current frame + speed) is **persistent**; the **engine advances `frame += speed` each simulation
> step**, so the animation only progresses while the sim runs and the logic decides how (e.g. "while moving,
> speed = 1; while idle, speed = 0"; "on a state change, change sprite / reset frame"). The node lives in an
> Agent Output Mapping graph (reads the agent's behaviour-produced state) or the Behaviour graph. There is **no
> simulator playback panel** and **no playback rAF**. The simulator sprite buffers carry `spriteIds` (slot) +
> `spriteFrames` (current frame); the render floors + wraps (loop) / clamps (once, per the sprite's `loop`
> flag). The B-subsections below describing a simulator transport / `fps` / a frame-advance rAF are the
> ORIGINAL (superseded) plan — see the corrected behaviour here and in CLAUDE.md.

Both are **additive + gated** — every existing model (cell grid 2D/3D × JS/WASM/WebGPU, and the 8 agent
samples) stays byte-identical.

## Why this shape (the two load-bearing facts)

- **The agent colour pass is JS on every agent target.** `runAgentColorPass` evals the agent OM code string and
  runs it over `s.attrRead`/`s.colors` on the worker, regardless of whether the behaviour runs on JS/WASM/WebGPU
  ([CLAUDE.md, Agent Output Mappings]). So authoring standalone agent OM **graphs** needs **no per-target
  agent-OM emit** — it reuses the same JS `compileRoot` the linked synthesis already feeds. This is the same
  "all-target" posture the linked agent OM already ships.
- **Sprites are a display-pass concern.** The worker only computes a tiny per-agent `spriteId` (+ optional
  frame) in the JS OM pass — the *exact* analogue of the per-cell `glyphCodes` buffer. The decoded image frames
  live **only on the main thread** (the render side), so the worker never carries pixels and the per-target
  agent compilers are untouched.

## Part A — Standalone & Linked agent output-mapping graphs

### A1. `AgentOutputMappingNode` (new event root)
`src/modeler/vpl/nodes/AgentOutputMappingNode.ts`: `type: 'agentOutputMapping'`, `category: 'event'`,
`requirements: { bondGraph: true }`, one flow output `do`, `defaultConfig: { mappingId: '' }`, `compile: () => ''`
(root — compiler handles specially). The agent analogue of `OutputMappingNode`. Because it is `bondGraph`-only it
is auto-hidden on the Cells graph and (being an event root) offered on the Agents graph.

### A2. `injectAgentLinkedOutputMappings` (replaces `buildAgentColorPassGraphs`)
`src/modeler/vpl/compiler/agentLinkedOutputMappings.ts`: rewrite to **augment the agent graph** the way
`injectLinkedOutputMappings` augments the cell graph:
- For each **linked** agent mapping, synthesize `getCellAttribute(agentAttr) → colorScale|categoricalColor →
  setCellLooks` and root it at an `agentOutputMapping` node (synthetic id `__agentOM_<id>_*`).
- If the user **also** placed an `agentOutputMapping` node for the same id → insert a `sequence` (auto
  background `first`, user graph `then`) — override-after-background.
- Standalone mappings synthesize nothing (the user's `agentOutputMapping` root carries the whole pass).
Returns `{ nodes, edges }`. Reuses the shared `mkLinkedNode` / `buildColorScaleConfig` / `buildCategoricalConfig`
helpers from `linkedOutputMappings.ts`.

### A3. `compileAgentGraph` restructure
`src/modeler/vpl/compiler/compile.ts`: run `injectAgentLinkedOutputMappings` right after
`expandComposites` (before CSE + `buildAdjacency`), build adjacency **once** over the augmented graph, and
compile **every** `agentOutputMapping` root (user + synthesized) into a per-agent colour-pass fn — exactly the
existing per-agent loop wrapper (`for idx<highWater … colorIdx=idx*4`). Drop the separate per-graph adjacency
build. Pre-resolve passes (indicators, stop messages, `_isV_` viewer hoist, **sprite slots**) run over the
augmented nodes.

### A4. Mappings panel + reducer
`MappingsPanelContent.tsx`: add a **Color pass: Standalone / Linked** `<select>` to each Agent Output Mapping
(parallel to the cell one), with the same help text. `LinkedOutputEditor` shows only when `linked`. ModelContext
`ADD_AGENT_MAPPING` keeps seeding `linked: true` (the friendly default); the toggle writes `linked: false`.

### A5. CaNode config UI + validation
- `CaNode.tsx`: render an agent-mapping `<select>` for `agentOutputMapping.mappingId` (lists
  `model.agentMappings`), mirroring the `outputMapping` picker.
- `nodeValidation.ts`: `detectMissingConfig` case for `agentOutputMapping` (require a real `mappingId`); the
  existing `setCellLooks` case already accepts agent mapping ids (they're added to the hoist set).

### A6. Registry / availability
`registry.ts`: import + add to `ALL_NODES` (agent event-root section). It is **not** in `LATTICE_ONLY_TYPES`
(bondGraph hides it on cells). Event roots are already offered on the Agents graph.

## Part B — Agent sprites

### B1. Schema (`types.ts`) + migration
```ts
export interface SpriteAsset {
  id: string; name: string;
  dataUrl: string;          // original PNG/GIF/WebP file, base64 data URL (self-contained in .gcaproj)
  mimeType: string;
  scale?: number;           // size multiplier vs agent diameter (default 1)
  playback?: { mode: 'loop' | 'once' | 'manual'; fps?: number };  // default playback in the simulator
}
// CAModel.sprites?: SpriteAsset[]
```
Additive/optional → old files load unchanged. `LOAD_MODEL`/`createInitialState` seed `sprites: []` beside the
other additive guards.

### B2. Reducers + cascade (`ModelContext.tsx`)
`ADD_SPRITE` / `REMOVE_SPRITE` / `UPDATE_SPRITE`. On `REMOVE_SPRITE`, `patchAllNodes` clears `config.spriteId`
on any `setAgentSprite` node referencing it (scan `agentGraphNodes` + `macroDefs`), mirroring the
attribute/mapping cascades.

### B3. `SetAgentSpriteNode` (new output node)
`src/modeler/vpl/nodes/SetAgentSpriteNode.ts`: `type: 'setAgentSprite'`, `category: 'color'`,
`requirements: { bondGraph: true }`. Ports: `do`/`next` (flow), `frame` (optional integer value input — per-agent
frame override). Config `{ spriteId: '' }` (the asset id). `compile()` emits, in the JS agent loop:
`spriteIds[idx] = <slot>;` and, when `frame` is wired, `spriteFrames[idx] = (<frame>)|0;`. A **pre-resolve pass**
in `compileAgentGraph` maps `config.spriteId` (asset id) → a **1-based slot** into `model.sprites` (stored as
`config._spriteSlot`; 0 = unresolved → no-op), mirroring the variegated/tag pre-resolves. Since it writes only the
JS-OM-pass display buffers, it needs **no WASM/WebGPU emit**; a (mis)use in the *behaviour* graph on a WASM/WebGPU
agent target clamps that behaviour to JS (added to the agent reject sets) — the OM-graph usage (the intended one)
is unaffected because the gate only inspects behaviour-reachable nodes.

### B4. Per-agent buffers (`agentEngine.ts`)
- `AgentStore.spriteIds: Int32Array` (0 = none, ≥1 = 1-based sprite slot) + `spriteFrames: Int32Array`
  (−1 = use the sprite's global playback frame, ≥0 = explicit per-agent frame). Allocated as **standalone**
  typed arrays (never wasm-backed — the WASM/WebGPU modules don't touch them).
- `AgentRenderSnapshot` gains `spriteIds`/`spriteFrames`; `snapshotAgentsForRender` slices them **only when the
  model has sprites** (a `hasSprites` flag), else length-0 placeholders (the z/vz "A1" gate pattern → non-sprite
  agent models pay zero extra per-step alloc/transfer and are byte-identical).
- `buildAgentLoopParams`/`buildAgentLoopArgs` thread `spriteIds, spriteFrames` (right after
  `glyphCodes, glyphColors`) so the JS OM fn receives them. WASM/WebGPU ABIs untouched.

### B5. Worker (`sim.worker.ts`)
- `hasAgentSprites` flag from `(model.sprites?.length ?? 0) > 0`, shipped in `init`/`recompile`.
- `runAgentColorPass`: when `hasAgentSprites`, `s.spriteIds.fill(0); s.spriteFrames.fill(-1)` before the OM fn
  (so a viewer that sets no sprites shows circles + no stale ids), then run the fn (which writes them).
- `sendColors`/stepped: push `spriteIds`/`spriteFrames` buffers to `agentTransfers` when present.
- Sprites are **not** serialized in getState/loadState — `runAgentColorPass` regenerates them on load
  (like glyph codes for cells).

### B6. Main-thread sprite registry + render (`SimulatorView.tsx` + new `spriteRegistry.ts`)
- `src/simulator/spriteRegistry.ts`: `decodeSprite(dataUrl, mimeType) → { frames: ImageBitmap[], durations:
  number[] }` via **`ImageDecoder`** (WebCodecs — animated GIF/WebP/PNG natively, no dep) with a
  `createImageBitmap` single-frame fallback when `ImageDecoder` is unavailable. A registry keyed by sprite id
  caches decoded frames; rebuilt on `model.sprites` change (by id+dataUrl hash so unchanged sprites aren't
  re-decoded).
- **Playback state** (`Record<spriteId, { mode, frame, playing, fps }>`, seeded from each sprite's
  `playback`): a dedicated rAF advances frames at each sprite's fps (loop wraps; once stops at the last frame;
  manual only steps), **independent of the sim clock**, and requests a redraw when any frame changes (so sprites
  animate even while the sim is paused).
- `drawAgentsOverlay`: when `snap.spriteIds[i] > 0` and the sprite is decoded, resolve the frame
  (`spriteFrames[i] >= 0 ? spriteFrames[i] % n : playbackFrame[slot]`), `drawImage` the frame `ImageBitmap`
  centred at the agent, sized to `agentDiameter * sprite.scale` (aspect-preserved), with the RGBA alpha as
  `globalAlpha`. Else the existing filled circle. Bonds draw under sprites (unchanged). Recording/screenshot
  already capture the display canvas (agents drawn there) → sprites are captured for free.

### B7. UI
- **Sprite Library** (Mappings panel, a "Sprites" section): import button (accepts png/jpeg/gif/webp), per-sprite
  row (animated preview, name, size multiplier, default playback mode + fps, delete). ~4 MB/sprite cap with a
  warning. Drives `ADD/UPDATE/REMOVE_SPRITE`.
- **Sprite playback** (simulator, right-panel Agents section): for each in-use sprite — mode selector
  (Loop/Once/Manual), play/pause, ⏮/⏭ step, frame indicator, fps. Persisted in `genesisca_sim_settings`.
- `SetAgentSpriteNode` config UI in CaNode: a sprite `<select>` (lists `model.sprites`) + a small preview.

### B8. Persistence
Sprites travel inside `.gcaproj` as plain string `dataUrl` fields (the `stringifyCompact` path already preserves
strings). No sidecar, no new binary container. (Library thumbnail sidecar extraction is untouched.)

## All-target / 2D-3D matrix

| Concern | Outcome |
|---|---|
| Cell grid (JS/WASM/WebGPU, 2D/3D) | **byte-identical** — every change gated on `agentMappings`/`sprites`/`agents`. |
| Agent behaviour (JS/WASM/WebGPU) | unchanged; sprite buffers ride only the JS OM param list. |
| Agent OM pass | JS on every agent target (today's posture) — standalone graphs reuse it. |
| Set Agent Sprite in behaviour on WASM/WebGPU | clamps that behaviour to JS (reject-set); OM-graph use unaffected. |
| 3D agents | sprites are 2D-billboard only (agents render via the 2D overlay); 3D voxel/sphere sprites out of scope. |

## Out of scope (documented follow-ups)
Cell (grid) sprites; sprites in the 3D `gl3d` agent renderer; per-agent sprite **rotation**/tint (the node can
gain inputs later via the same buffer-add pattern); a "linked sprite mapping" (tag→sprite) convenience.

## Verification
- Dev harness `compileAll` on Game of Life + Life3D (3-target byte-identity) and the 8 agent samples
  (JS↔WASM bit-parity) — unchanged.
- `compileAgentGraph` on a standalone agent OM graph compiles a per-agent OM fn; linked still works;
  override-after-background sequences.
- In-browser: a Boids/agent model with an imported sprite renders animated sprites; Loop/Once/Manual + step
  work while the sim is paused; recording captures sprites; save/reload round-trips the sprite asset.
- `npx tsc -b` + `npm run build` clean.
