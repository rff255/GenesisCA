# PLAN — Agent Metaballs (implicit-surface rendering for 3D agents)

**Status:** proposed / not started. Written as a HANDOFF: everything a fresh session needs.
**Illustrated mockup:** [PLAN_AGENT_METABALLS.html](PLAN_AGENT_METABALLS.html) (panel UI, before/after, the field math, the pass pipeline).
**Branch to build on:** `sim_agent_fixes` (or a fresh branch off it). The 3D global-lighting work it leans on landed in `6eb6d28`.

---

## 1. Goal

3D agents currently render as **discrete camera-facing sphere impostors** — a tissue of 500 touching cells reads as a bag of marbles, not as tissue. Render the agent population instead as a **metaball / implicit surface**: a scalar field summed from every agent, with the surface at an isovalue, so agents that are close **fuse smoothly** into one organic blob. This is the natural visual language for morphogenesis and biological models.

Semantics follow Blender's metaballs (per the user's reference): each element contributes a falloff over an influence **radius**; the surface is the isosurface where the summed field crosses a **threshold**; overlapping elements bulge toward each other and merge.

**Non-goal:** replacing the agent *engine*. This is purely a RENDER mode. Agents remain spheres logically — picking, brushing, inspecting, bonds, physics, and the compilers are all untouched.

---

## 2. Chosen approach — bake a density field into a 3D texture, then raymarch it

Three routes were considered:

| Route | Verdict |
|---|---|
| **Marching cubes → mesh** (what Blender does) | Most faithful, worst fit. Polygonising a ~128³ grid in JS **every step** and re-uploading a dynamic vertex buffer is expensive, and WebGL2 has **no compute or geometry shaders**, so a GPU implementation needs transform-feedback gymnastics. **Rejected.** |
| **Bake the scalar field into a 3D texture + raymarch it** | **CHOSEN.** A true implicit surface: view-independent, correct silhouettes, real threshold semantics, negative influence trivially supported. The bake is cheap (each agent touches a small neighbourhood); the raymarch is per-pixel, **independent of agent count**. |
| **Screen-space depth smoothing** (the classic real-time fluid trick: render sphere depth → bilateral blur → rebuild normals) | Cheapest and reuses the impostor pass almost untouched, but it is a screen-space *approximation*: merging becomes view-dependent, silhouettes soften wrongly, and "influence" degenerates into a blur radius rather than a real threshold. **Keep as a fallback** only if the raymarch proves too slow. |

### Why it fits this renderer

- **The agent world IS the cell grid.** Agent `x/y/z` are in cell coordinates 1:1 with the voxel lattice, so there is already a natural 3D frame to evaluate the field on.
- **The sphere impostors already write `gl_FragDepth`** (`SPHERE_FS`). A raymarched surface writes it the same way and therefore depth-interleaves with voxels / bonds / the clip plane with **zero pipeline restructure**.
- **The lighting added in `6eb6d28` drops straight in.** The field gradient gives the surface normal, which feeds the existing `uAmbient/uDiffuse/uSpecular` + `shadowFactor()` unchanged → the blob **receives cast shadows on day one**.
- **Agents already carry a per-agent colour** (Agent Output Mappings → `snap.colors`). If the field stores density-weighted colour, agent colours **blend smoothly across the fused tissue** — for Morphogenesis's maturity gradient this is arguably better than discrete spheres.

---

## 3. The math

### 3.1 Falloff

For agent *i* at centre **cᵢ** (cell coords) with agent radius *rᵢ*:

```
Rᵢ = influence · rᵢ                  // influence radius (the "Influence" slider)
d  = |p − cᵢ|                        // torus-shortest when the world is a torus
t  = 1 − (d / Rᵢ)²                   // 0 at the influence edge, 1 at the centre
wᵢ(p) = t³   if d < Rᵢ, else 0       // Wyvill-style soft-object falloff (C¹, cheap)
```

`w(0) = 1`, `w(R) = 0`, smooth. This is the standard cheap metaball kernel — prefer it over an exponential (no `exp` in the inner loop).

### 3.2 Field + surface

```
f(p) = Σᵢ wᵢ(p)                      // scalar field (density)
surface := { p : f(p) = T }          // T = the Threshold slider (the isovalue)
```

Because the fields **sum**, two agents whose influence radii overlap push `f` above `T` in the gap between them → the surface bridges → they fuse. That is the whole trick.

### 3.3 The Influence ↔ Threshold relation (important for good defaults)

For an **isolated** agent, the surface sits where `(1 − (d/R)²)³ = T`, i.e.

```
d_surface = R · sqrt(1 − T^(1/3))  =  influence · r · sqrt(1 − T^(1/3))
```

If you want a lone agent to render at **exactly its own sphere radius** `r` (so switching Metaballs on doesn't resize isolated agents), then:

```
T = (1 − 1/influence²)³
```

e.g. influence 1.6 → **T ≈ 0.226**. Use that as the **default threshold**, and let the Threshold slider deviate from it (lower ⇒ fatter/more fused, higher ⇒ thinner/more separated). Put this relation in the tooltip.

### 3.4 Colour

Store the **density-weighted, pre-normalised** colour so the shader never has to divide by a saturating sum:

```
per voxel:   wsum = Σ wᵢ ,  csum = Σ wᵢ · colourᵢ
texture RGB = clamp(csum / max(wsum, ε))     // already in [0,1] → RGBA8-safe
texture A   = clamp(wsum / F_MAX)            // F_MAX = 2.0 (see below)
shader:      density = A · F_MAX ,  colour = RGB
```

### 3.5 Texture format — RGBA8 (recommended) vs RGBA16F

Use **RGBA8** with `F_MAX = 2.0`. Rationale: the surface always sits at `T < 1` (a single agent peaks at `f = 1`), so 8 bits over `[0, 2]` gives ~0.008 density resolution — far finer than the field's change across one voxel (~0.1–0.5). Hardware **trilinear filtering interpolates between quantised samples**, and 2–3 bisection refinement steps in the march remove the rest. RGBA8 is universally filterable, cheap to upload (`Uint8Array`), and needs no extension.

*If banding appears:* upgrade to `RGBA16F` + `HALF_FLOAT` (filterable in core WebGL2 — note `RGBA32F` linear filtering would need `OES_texture_float_linear`, so do **not** use 32F). This is a one-line format change plus a float→half packing step.

---

## 4. The field volume — bake the agents' BOUNDING BOX, not the world

**Do not bake the whole world.** Clearing + packing a full-world field every step is the dominant cost and it scales with the *world*, not the agent cloud. Instead:

```
bbox = AABB over alive, non-sprite agents, expanded by maxᵢ(Rᵢ) + 1 voxel
fieldMin/fieldMax  = bbox in WORLD (Z-up) coords          → uniforms
FW,FH,FD = ceil(bboxSizeInCells · resolution)             → capped (see below)
```

- `resolution` = field voxels per cell (the "Resolution" slider; 1 or 2, maybe 4).
- **Cap** the total voxels (e.g. `FW·FH·FD ≤ 256³`); if exceeded, reduce the effective resolution and log/expose it.
- **Torus worlds:** if `boundaryTreatment === 'torus'`, agents can wrap and the bbox may be meaningless. **v1: fall back to the full-world field when torus** (and wrap distances in the bake). Document it.

This makes cost proportional to the agent cloud — a 200-agent blob in a 60×60×40 world bakes a tiny field.

---

## 5. Renderer changes — `src/simulator/render/gl3d.ts`

### 5.1 New public type + default (export alongside `Light3D`)

```ts
export interface Metaballs3D {
  enabled: boolean;
  influence: number;   // 1.0 .. 3.0   — falloff radius as a multiple of the agent radius
  threshold: number;   // 0.02 .. 0.9  — the isovalue
  resolution: number;  // 1 | 2 | 4    — field voxels per cell
}
export const DEFAULT_METABALLS3D: Readonly<Metaballs3D> = Object.freeze({
  enabled: false, influence: 1.6, threshold: 0.226, resolution: 2,
});
```

### 5.2 New fields on `Gl3DRenderer`

```ts
private metaballs: Metaballs3D = { ...DEFAULT_METABALLS3D };
private metaProg: WebGLProgram;              // compiled in the constructor
private metaTex: WebGLTexture | null = null; // TEXTURE_3D, RGBA8, LINEAR, CLAMP_TO_EDGE ×3
private metaFW = 0; private metaFH = 0; private metaFD = 0;
private metaMin: [number, number, number] = [0, 0, 0];   // world AABB of the field
private metaMax: [number, number, number] = [0, 0, 0];
private metaDirty = true;                    // params or snapshot changed → re-bake
private metaWsum: Float32Array = new Float32Array(0);   // CPU scratch
private metaCsum: Float32Array = new Float32Array(0);
private metaBytes: Uint8Array = new Uint8Array(0);
private static readonly META_TEX_UNIT = 2;   // 0 = sprite atlas, 1 = shadow map
private static readonly META_F_MAX = 2.0;
```

### 5.3 New methods

- **`setMetaballs(cfg: Metaballs3D): void`** — store; set `metaDirty = true` if `enabled/influence/resolution` changed (threshold is a shader uniform only → no re-bake).
- **`private bakeMetaballField(snap: AgentSnapshot3D, torus: boolean): void`** — the CPU splat (see 5.4). Called from `uploadAgents` (which already runs only when the snapshot identity changed) **and** whenever `metaDirty` is set. Guard: skip if `!metaballs.enabled`.
- **`private renderMetaballs(): void`** — the raymarch pass (see 5.6).
- `dispose()` — `gl.deleteProgram(this.metaProg)`, `gl.deleteTexture(this.metaTex)`.

### 5.4 The bake (CPU splat)

Runs over the snapshot the renderer is already given. **Exclude sprite-agents** — they carry a **NEGATIVE radius** as the sprite flag (see `uploadAgents` / `SPHERE_VS`'s `vSkip`), and they draw as billboards.

```
1. Collect alive, non-sprite agents (radius > 0). If none → metaFW=0, skip the pass.
2. Compute maxR = max(influence · rᵢ). Build the cell-space AABB, expand by maxR + 1/res.
   (torus → use the full world instead.)
3. FW/FH/FD = ceil(size · resolution), capped.
4. metaMin/metaMax = the AABB corners mapped to WORLD (Z-up):
        world = (col − hx, hy − row, hz − layer),  hx=(W−1)/2, hy=(H−1)/2, hz=(D−1)/2
   NB: because row/layer are NEGATED, the world AABB's min/max swap on Y and Z.
   Safest: map all 8 corners and take component-wise min/max.
5. wsum.fill(0); csum.fill(0)   (sized FW·FH·FD and 3×that; grow as needed)
6. For each agent: loop the voxel box within R, compute d in CELL units,
        t = 1 − (d/R)²;  if (t > 0) { w = t*t*t; wsum[k] += w; csum[3k..] += w·colour }
   colour = snap.colors[slot*4 .. +2] / 255
7. Pack RGBA8:  A = clamp(wsum/F_MAX)·255 ; RGB = clamp(csum/max(wsum,1e-6))·255
8. (Re)allocate TEXTURE_3D if FW/FH/FD changed (texImage3D), else texSubImage3D.
   LINEAR min/mag, CLAMP_TO_EDGE on S/T/R.
9. metaDirty = false
```

**Indexing:** field voxel `(fx,fy,fz)` ↔ cell coords `bboxMinCell + (fx,fy,fz)/resolution`.

### 5.5 Shaders

`META_VS` — a **fullscreen quad** (reuse the existing static `quadBuf`, the unit quad already bound at attrib 0 on `sphereVao`/`spriteVao`; give the metaball pass its own tiny VAO over `quadBuf` to keep divisors clean). Emit NDC directly and pass the NDC through:

```glsl
#version 300 es
precision highp float;
layout(location=0) in vec2 aCorner;   // unit quad [-1,1]
out vec2 vNdc;
void main() { vNdc = aCorner; gl_Position = vec4(aCorner, 0.0, 1.0); }
```

`META_FS` — reconstruct the world ray from `uInvMVP` (the renderer already has `mat4Invert` + `unproject`, used by `pickOnPlane`), intersect the field AABB, march, refine, shade. Splice `${SHADOW_GLSL}` right after `precision` so `shadowFactor()` is available (same pattern as `FS` / `SPHERE_FS`).

```glsl
#version 300 es
precision highp float;
${SHADOW_GLSL}
precision highp sampler3D;
in vec2 vNdc;
uniform mat4 uMVP;         // for gl_FragDepth
uniform mat4 uInvMVP;      // NDC → world ray
uniform sampler3D uField;
uniform vec3 uFieldMin;    // world AABB of the field
uniform vec3 uFieldMax;
uniform float uThreshold;  // T
uniform float uFMax;       // density scale (2.0)
uniform float uStepWorld;  // march step in world units (≈ 0.5 / resolution)
uniform int   uMaxSteps;
// lighting (same names as FS/SPHERE_FS)
uniform vec3 uLightDir; uniform float uAmbient; uniform float uDiffuse;
uniform float uSpecular; uniform vec3 uViewDir;
// clip (same names)
uniform int uClipEnabled; uniform int uClipAxis; uniform float uClipLo;
uniform float uClipHi; uniform vec3 uClipForward;
out vec4 outColor;

vec4 sampleField(vec3 p) {                       // p in world
  vec3 uvw = (p - uFieldMin) / (uFieldMax - uFieldMin);
  return texture(uField, uvw);
}
float density(vec3 p) { return sampleField(p).a * uFMax; }

bool clipped(vec3 p) {
  if (uClipEnabled == 0) return false;
  float w = uClipAxis==0?p.x : uClipAxis==1?p.y : uClipAxis==2?p.z : dot(p, uClipForward);
  return (w < uClipLo || w > uClipHi);
}

void main() {
  // 1. world ray from the NDC (near → far)
  vec4 pn = uInvMVP * vec4(vNdc, -1.0, 1.0);
  vec4 pf = uInvMVP * vec4(vNdc,  1.0, 1.0);
  vec3 ro = pn.xyz / pn.w;
  vec3 rd = normalize(pf.xyz / pf.w - ro);

  // 2. ray ∩ field AABB (slab test)
  vec3 inv = 1.0 / rd;
  vec3 t0 = (uFieldMin - ro) * inv, t1 = (uFieldMax - ro) * inv;
  vec3 tmin = min(t0, t1), tmax = max(t0, t1);
  float tn = max(max(tmin.x, tmin.y), tmin.z);
  float tf = min(min(tmax.x, tmax.y), tmax.z);
  tn = max(tn, 0.0);
  if (tn >= tf) discard;                       // ray misses the field

  // 3. march for the first crossing of the threshold (clipped space = empty)
  float t = tn, prevT = tn, prevD = 0.0;
  bool hit = false;
  for (int i = 0; i < 512; i++) {
    if (i >= uMaxSteps || t > tf) break;
    vec3 p = ro + rd * t;
    float d = clipped(p) ? 0.0 : density(p);
    if (d >= uThreshold) { hit = true; break; }
    prevT = t; prevD = d;
    t += uStepWorld;
  }
  if (!hit) discard;

  // 4. bisection refine between prevT (below) and t (above)
  float lo = prevT, hi = min(t, tf);
  for (int i = 0; i < 4; i++) {
    float m = 0.5 * (lo + hi);
    vec3 p = ro + rd * m;
    float d = clipped(p) ? 0.0 : density(p);
    if (d >= uThreshold) hi = m; else lo = m;
  }
  vec3 hitP = ro + rd * hi;

  // 5. normal from the field gradient (central differences); grad points INWARD
  float e = uStepWorld;
  vec3 g = vec3(
    density(hitP + vec3(e,0,0)) - density(hitP - vec3(e,0,0)),
    density(hitP + vec3(0,e,0)) - density(hitP - vec3(0,e,0)),
    density(hitP + vec3(0,0,e)) - density(hitP - vec3(0,0,e)));
  vec3 N = normalize(-g);
  if (dot(g, g) < 1e-12) N = -rd;              // degenerate → face the camera

  // 6. shade with the SAME model as FS / SPHERE_FS (+ cast shadows)
  vec3 base = sampleField(hitP).rgb;
  float ndl = max(0.0, dot(N, uLightDir));
  float sh  = shadowFactor(hitP, ndl);
  float lum = uAmbient + uDiffuse * ndl * sh;
  vec3 col  = base * lum;
  if (uSpecular > 0.0) {
    vec3 H = normalize(uLightDir + uViewDir);
    col += uSpecular * pow(max(0.0, dot(N, H)), 32.0) * sh;
  }

  // 7. depth — SAME formula as SPHERE_FS so it interleaves with voxels/bonds
  vec4 clip = uMVP * vec4(hitP, 1.0);
  gl_FragDepth = (clip.z / clip.w) * 0.5 + 0.5;
  outColor = vec4(col, 1.0);
}
```

> `sampler3D` needs `precision highp sampler3D;` — the same class of error that bit `sampler2DShadow` (`'No precision specified'`). Declare it.

### 5.6 `renderMetaballs()` + wiring into `render()`

In `render()`, inside the existing `if (this.viz.agents) { if (agentInstanceCount > 0 || bondVerts.length > 0) { … } }` block, **swap the sphere pass for the metaball pass** when enabled:

```ts
if (this.viz.bonds) this.renderBonds();
if (this.metaballs.enabled && this.metaFW > 0) this.renderMetaballs();
else this.renderAgents();          // sphere impostors (unchanged)
this.renderSprites();              // ALWAYS — sprite-agents are excluded from the field
```

`renderMetaballs()`:
```ts
gl.useProgram(this.metaProg);
gl.bindVertexArray(this.metaVao);
gl.disable(gl.BLEND); gl.depthMask(true); gl.enable(gl.DEPTH_TEST);
// uniforms: uMVP, uInvMVP, uFieldMin/Max, uThreshold, uFMax, uStepWorld, uMaxSteps
this.setLightUniforms(gl, this.metaProg);   // light + shadow map + shadow uniforms
this.setClipUniforms(gl, this.metaProg);
gl.activeTexture(gl.TEXTURE0 + Gl3DRenderer.META_TEX_UNIT);   // AFTER setLightUniforms
gl.bindTexture(gl.TEXTURE_3D, this.metaTex);                  //   (it resets to TEXTURE0)
gl.uniform1i(gl.getUniformLocation(this.metaProg, 'uField'), Gl3DRenderer.META_TEX_UNIT);
gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
gl.activeTexture(gl.TEXTURE0);
gl.bindVertexArray(null);
```

`uInvMVP` = `mat4Invert(this.mvp)` (helper exists). `uStepWorld ≈ 0.5 / resolution` cells; `uMaxSteps = min(512, ceil(diag(field) / uStepWorld))`.

---

## 6. SimulatorView changes — `src/simulator/SimulatorView.tsx`

Mirror **exactly** how `light3d` is wired (it is the closest precedent — read it first):

1. **State + persistence.** `const [metaballs3d, setMetaballs3d] = useState<Metaballs3D>(() => sanitizeMetaballs3d(saved.current.metaballs3d));` declared **with the other persisted view options ABOVE the settings-persist effect** (declaring it in the 3D-controls block below TDZ-crashes the persist dep array — this bit `light3d`). Add `metaballs3d` to the persisted object and its dep array. Add `sanitizeMetaballs3d` next to `sanitizeLight3d` (clamp every field, fall back to `DEFAULT_METABALLS3D`).
2. **Ref + effect.** `const metaballs3dRef = useRef<Metaballs3D>({ ...DEFAULT_METABALLS3D });`
   ```ts
   const prevMetaRef = useRef(metaballs3d);
   useEffect(() => {
     metaballs3dRef.current = metaballs3d;
     const p = prevMetaRef.current;
     // enabled / influence / resolution change ⇒ the BAKED field is stale → force a re-bake
     if (p.enabled !== metaballs3d.enabled || p.influence !== metaballs3d.influence
         || p.resolution !== metaballs3d.resolution) {
       lastUploadedAgentSnapRef.current = null;   // forces uploadAgents + the bake next draw
     }
     prevMetaRef.current = metaballs3d;
     draw();
   }, [metaballs3d, draw]);
   ```
   (This is the same trick as `prevAoRef` for the occupancy AO — the field is BAKED at upload time, so a param change must invalidate it. `threshold` is a pure shader uniform → a redraw suffices.)
3. **draw() 3D branch.** Call `r.setMetaballs(metaballs3dRef.current)` **before** the agent upload block (so the bake sees fresh params), next to `r.setLight(...)` / `r.setCellGaps(...)`.
4. **UI.** In the 3D View panel, add an **Agents** sub-block, gated on `isAgentModel` (like the existing agent-only controls):
   - `Metaballs` checkbox.
   - `Influence` slider `1.0 … 3.0` (disabled/dimmed when off).
   - `Threshold` slider `0.02 … 0.9` (dimmed when off).
   - `Resolution` — a 3-button segmented control (1× / 2× / 4×) or a slider.
   - Reuse the `row` / `grid2` / `tbtn` style helpers already defined in that block.

---

## 7. What it must NOT break (verified integration points)

| Feature | Requirement |
|---|---|
| **Picking / brushing / inspect** | `pickAgent()` uses the **sphere pick FBO** over `sphereVao`. Metaballs must **not** stop `uploadAgents` from filling `agentInstBuf` — clicking the blob still selects the nearest agent via its sphere. Do not touch `agentInstOrder` / `instanceToSlot`. |
| **Cast shadows** | `renderShadowMap()` already draws the **sphere** casters; the union of spheres is a very good approximation of the blob → **keep it as-is**. The metaball FS just calls `shadowFactor(hitP, ndl)` and *receives* shadows. |
| **Sprite agents** | Carry a **NEGATIVE radius** as the sprite flag. **Exclude from the field** (`radius > 0` filter) and keep drawing `renderSprites()` unconditionally. |
| **Bonds** | Drawn before the agents; they end up inside the blob and are depth-hidden. The Show-bonds toggle still governs. No change. |
| **Clip plane** | The FS treats clipped space as density 0 (`clipped()` → 0) so the blob is cut open. v1 = an *open* cut (you see the hollow interior). A *capped* cut (shade the cut plane with the clip normal) is a nice PR5 polish. |
| **`agentsInFront`** | The depth-clear trick runs *before* the agent block; the metaball pass writes `gl_FragDepth` so it behaves exactly like the spheres. No change. |
| **Alpha blend (agents)** | v1 = opaque metaball surface; `sortAgentsBackToFront()` is only needed by the sphere path. A translucent blob (front-to-back accumulation) is a possible follow-up. |
| **Occupancy AO** | Voxel-only; unaffected. The metaball surface can get its own AO from the field (PR5). |
| **2D** | Untouched — this is a `gl3d.ts`-only render mode. |
| **Compilers / worker / schema** | **Zero impact.** No `.gcaproj` change (see §9 open decision 2). |

---

## 8. Gotchas the implementer WILL hit (learned in this renderer)

1. **Z-up remap must match EXACTLY**: `world = (ax − hx, hy − ay, hz − az)` with `hx=(W−1)/2, hy=(H−1)/2, hz=(D−1)/2` — row and layer are **negated** (`SPHERE_VS`, `pushCellCube`). Get it wrong and the blob is mirrored/offset from the spheres. Map all 8 AABB corners and take a component-wise min/max rather than assuming min→min.
2. **`gl_FragDepth` formula must be identical to `SPHERE_FS`**: `(uMVP * vec4(p,1)).z / w * 0.5 + 0.5`. Any deviation and the blob z-fights the voxels.
3. **Sampler precision.** `precision highp sampler3D;` is REQUIRED in GLSL ES 3.00 (the exact class of error that failed the first `sampler2DShadow` build: `'No precision specified'`).
4. **Texture units are taken**: 0 = sprite atlas, 1 = shadow map. Use **2**. And `setLightUniforms()` **resets `activeTexture` to TEXTURE0 at its end** — bind the field texture *after* calling it.
5. **`metaDirty` must be honoured on param change**, not just snapshot change — otherwise moving the Influence slider does nothing until the next sim step (this is exactly the bug the occupancy AO's `prevAoRef` re-upload trigger exists to prevent).
6. **Trilinear filtering is essential** (`LINEAR` min+mag) — `NEAREST` gives a blocky, stair-stepped isosurface. `CLAMP_TO_EDGE` on all three axes so the march doesn't wrap at the field edge.
7. **Empty agent set** (`metaFW === 0`) → skip the pass entirely (don't bind a null 3D texture).
8. **Re-allocate the 3D texture** (`texImage3D`) when FW/FH/FD change; otherwise `texSubImage3D`.
9. The `draw()` agent-upload gate is `snap !== lastUploadedAgentSnapRef.current` — the bake must ride that gate (camera-only frames must NOT re-bake, exactly like the voxel-colours gate).

---

## 9. Open decisions (confirm before/while building)

1. **Influence only, or Influence + Threshold?** Recommendation: **both** (they are genuinely different knobs, and Blender exposes both). Ship the threshold defaulted from influence via §3.3 so it "just works" out of the box.
2. **Per-user setting or per-model?** Every other 3D-view setting (`light3d`, `alpha3d`, `cellGaps3d`, `bg3d`) is **per-user** in `genesisca_sim_settings`. Recommendation: **per-user for v1** (no schema change, no migration). Note the counter-argument: a Morphogenesis model arguably *wants* metaballs saved with it — that would need a `CAModel` field + migration, and is a clean follow-up.
3. **RGBA8 vs RGBA16F field** — recommendation RGBA8 + `F_MAX = 2.0` + bisection (see §3.5); upgrade only if banding shows.
4. **Negative influence** (per-agent "carve", Blender's Negative flag) — deferrable. Would map to an agent attribute; trivial in the bake (subtract instead of add).
5. **2D metaballs** — out of scope (a very different canvas-side trick).

---

## 10. Suggested PR breakdown

| PR | Content |
|---|---|
| **PR1 — renderer core** | `Metaballs3D` type + default, the 3D texture, the CPU bake, `META_VS`/`META_FS`, `renderMetaballs()`, wired into `render()`. Hardcode the params. Verify a blob renders and that raising `influence` fuses neighbours. |
| **PR2 — integration** | Clip plane, cast shadows, specular, `agentsInFront`, sprite exclusion, pick unaffected, empty/edge cases, `dispose()`. |
| **PR3 — UI + persistence** | Toggle + Influence + Threshold + Resolution in the 3D View panel; `sanitizeMetaballs3d`; the `prevMetaRef` re-bake trigger. |
| **PR4 — perf** | Bbox-restricted field, re-bake gating, voxel cap / resolution clamp, torus fallback. Measure on Morphogenesis — 3D Tissue at 1500+ agents and on a 2000-agent Boids. |
| **PR5 — polish + docs** | Field-derived AO, capped clip cut, optional translucency. Update `CLAUDE.md`, `src/help/HelpView.tsx`, `README.md`. |

---

## 11. Verification recipe

**Screenshots time out on the 3D WebGL page** — verify with `readPixels` through the DEV hooks (`window.__sim3dRenderer()`, `window.__sim3dRedraw()`), exactly as the global-lighting work was verified.

1. **Shaders compile / renderer inits** — no `[gl3d] init failed` in the console.
2. **Off = exact baseline.** Metaballs off → lit-pixel count + mean luminance identical to today's sphere render.
3. **The blob renders.** Load *Morphogenesis — 3D Tissue*, seed a dense cluster (post a `seedAgents` message with ~200 agents in a small ball — the pattern used to verify agent shadows), enable Metaballs → lit pixels > 0.
4. **Fusion is real.** Sweep Influence 1.0 → 2.5: lit-pixel count should **increase monotonically** (the surface expands and bridges the gaps). Optionally count connected components of the lit mask and confirm it **drops**.
5. **Threshold shrinks.** Raising Threshold reduces lit pixels monotonically.
6. **Isolated agent matches its sphere.** With the §3.3 default threshold, a single agent's metaball silhouette ≈ its sphere silhouette (compare lit-pixel counts within a few %).
7. **Shadows.** With Shadows on, the blob's mean luminance drops and scales with the strength slider.
8. **Clip.** Dragging the clip interval cuts the blob.
9. **Pick still works.** `pickAgent` at the blob returns a valid, correct slot (the sphere pick is unchanged).
10. **Sprites still draw** on a sprite model.
11. **Perf.** Time `bakeMetaballField` + the frame at 1500 agents / resolution 2; confirm the bake is skipped on camera-only frames.
12. `npx tsc -p tsconfig.app.json --noEmit` + `npm run build` clean.

---

## 12. Reference

Blender metaballs (per the user's link — `projects.blender.org` / `docs.blender.org` both 403 to automated fetch, so this is from knowledge; **confirm against the manual before finalising the UI copy**):

- **Per metaball object:** *Resolution* (viewport / render — the evaluation-grid size for polygonisation) and *Influence Threshold* (the isovalue).
- **Per element:** *Radius* (extent of influence — the green circle), *Stiffness* (how steeply the field falls off — the red circle), *Negative* (subtracts from the field), *Hide*, and the element type (Ball / Capsule / Plane / Ellipsoid / Cube).
- The surface is the isosurface of the **summed** field, which is why nearby elements bulge toward each other and fuse.

**Mapping to GenesisCA:** the per-element *Radius* is **already** the agent's own `radius` — a real, graph-authorable agent property (Set Target Radius / the Body capability). So a cell that grows fuses more, straight from the rule graph. Our *Influence* slider is the global multiplier on it (Blender's Stiffness analogue), and *Threshold* is Blender's Influence Threshold. Only Ball elements are needed.
