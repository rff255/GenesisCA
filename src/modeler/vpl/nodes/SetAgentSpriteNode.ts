import type { NodeTypeDef } from '../types';
import { agentRootHasSelf, agentRootRelaxesGuard } from '../types';

/** Set Agent Sprite — the agent-logic controller for the optional sprite
 *  exhibition layer. The per-agent sprite state is PERSISTENT (a sprite slot, a
 *  current frame, a playback speed in frames per simulation step, a facing
 *  ROTATION, and a size SCALE); the engine advances `frame += speed` every step
 *  (negative speed = reverse), and the RENDER blits the floored frame (wrapped/
 *  clamped by the sprite's loop flag), rotated + scaled per agent. This node SETS
 *  any independently-chosen subset of that state, so the exhibition is driven by
 *  the agent's logic.
 *
 *  TARGET: leave `Agent` unwired to act on the CURRENT agent (in an Agent Output
 *  Mapping / Behaviour graph, which run per-agent) — the typical use. Wire a
 *  Create Agent handle (or any agent id) to target that agent instead — this is
 *  how you set a sprite at spawn time inside the Agent Init Event (which is NOT a
 *  per-agent loop, so an unwired Set Agent Sprite there has no current agent to
 *  act on and is a no-op).
 *
 *  TICKABLE facets (config flags): `setSprite` (which sprite), `setFrame` (jump/
 *  reset the `Frame` input), `setSpeed` (the `Speed` input, may be negative),
 *  `setRotation` (the facing — either an `Rotation` ANGLE in compass degrees
 *  [0 = up, clockwise], or a `Dir X`/`Dir Y` VECTOR the art aligns to via atan2,
 *  so a static agent can "look at" a target), `setScale` (the `Scale` SIZE — read
 *  through the sprite asset's own SIZE MODE: a MULTIPLIER of the agent's diameter
 *  by default, or — with the asset set to Absolute — the size in WORLD UNITS, in
 *  which case the agent's radius does not enter at all. Either way it is the
 *  sprite's LONGEST side, and 0 means "use the asset's own size"), `setAlpha`
 *  (the agent colour's ALPHA byte, 0–255 — the sprite
 *  render multiplies the blit by it, so this fades/hides the sprite; it is the
 *  same alpha a Set Cell Looks / Agent Output Mapping writes, so a colour pass
 *  that writes the agent colour afterwards overrides it). Unticked facets are
 *  left untouched.
 *
 *  Writes the per-agent display buffers `spriteIds`/`spriteFrames`/`spriteSpeeds`/
 *  `spriteRotations`/`spriteScales` (+ the agent colour's A byte for the alpha
 *  facet). Those five live in the SHARED agent memory on the CPU engines (the
 *  sprite block in `computeAgentMemoryLayout`) and in their own `agentF32` runs on
 *  the GPU (`AGENT_GPU_SPRITE_FIELDS`), both reserved only when the C9 `sprites`
 *  gate is on — so this node EMITS ON ALL THREE AGENT TARGETS and never clamps a
 *  model to a slower engine.
 *
 *  The one fast path it forfeits is GPU RESIDENCY: the engine ticks
 *  `frame += speed` on the CPU once per generation, and a resident batch runs a
 *  whole frame in one submit with no per-generation touch point. An Agent OUTPUT
 *  MAPPING graph avoids even that (OM passes are CPU-side on every agent target)
 *  and is the natural home for it anyway. `requirements.bondGraph` → Agents tab. */
export const SetAgentSpriteNode: NodeTypeDef = {
  type: 'setAgentSprite',
  label: 'Set Agent Sprite',
  agentLabel: 'Set Sprite',
  description: 'Control the agent’s sprite exhibition: change the sprite, set the frame, playback speed (frames/step; negative = reverse), rotation (an angle or a direction vector to align to), and size. Scale is read through the sprite asset’s Size mode — a multiple of the agent diameter, or (Absolute) a world-unit size that ignores the agent’s radius; 0 = use the asset’s own size. Tick only the facets you want to change. Leave Agent unwired for the current agent (Output Mapping / Behaviour graph), or wire a Create Agent handle to target a spawned agent in the Init Event.',
  category: 'color',
  color: '#8e24aa',
  requirements: { bondGraph: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
    { id: 'agentId', label: 'Agent', kind: 'input', category: 'value', dataType: 'integer' },
    { id: 'frame', label: 'Frame', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
    { id: 'speed', label: 'Speed', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '1' },
    { id: 'rotation', label: 'Rotation°', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
    { id: 'dirX', label: 'Dir X', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
    { id: 'dirY', label: 'Dir Y', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '0' },
    { id: 'scale', label: 'Scale', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '1' },
    { id: 'alpha', label: 'Alpha', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '255' },
  ],
  defaultConfig: { spriteId: '', setSprite: true, setFrame: false, setSpeed: false, setRotation: false, rotationMode: 'angle', setScale: false, setAlpha: false },
  // Each facet's input(s) only matter when the facet is ticked; the rotation mode
  // picks between the angle input and the vector inputs.
  hiddenPorts: (config) => {
    const hidden: string[] = [];
    if (!config.setFrame) hidden.push('frame');
    if (!config.setSpeed) hidden.push('speed');
    const rotOn = !!config.setRotation;
    const vectorMode = config.rotationMode === 'vector';
    if (!rotOn || vectorMode) hidden.push('rotation');
    if (!rotOn || !vectorMode) { hidden.push('dirX'); hidden.push('dirY'); }
    if (!config.setScale) hidden.push('scale');
    if (!config.setAlpha) hidden.push('alpha');
    return hidden;
  },
  compile: (_nodeId, config, inputs, _boundary, ctx) => {
    // A root with NO self (`init` / `spawner`) has no `idx`, so an UNWIRED node
    // there degrades to a no-op instead of emitting a reference that throws.
    const isInit = !agentRootHasSelf(ctx?.agentRoot);
    // Unified spawning: a Created agent is staged (alive=0) until Add To World in
    // Init AND Behaviour, so a wired-handle write relaxes the guard in either root.
    const staged = agentRootRelaxesGuard(ctx?.agentRoot);
    const wired = !!inputs['agentId'];
    // Target the wired agent id, else the current-loop agent (idx). The Init Event
    // has no per-agent loop, so an unwired node there is a safe no-op (no crash).
    if (isInit && !wired) return '';
    const target = wired ? `((${inputs['agentId']}) | 0)` : 'idx';
    const guard = wired
      ? (staged ? `_t >= 0 && _t < _agentMaxAgents` : `_t >= 0 && _t < highWater && _alive[_t]`)
      : null;

    // C9 SAFETY CATCH: with the sprite block gated off there are no
    // `spriteIds`/`spriteFrames`/… params (36 B/agent reclaimed), so every sprite
    // facet is dropped. The gate is usage-widened ON THIS NODE, so an off gate
    // means the model has no sprite assets AND no Set Agent Sprite — the ALPHA
    // facet writes `colors`, which is always allocated, so it survives.
    const noSprites = !!ctx?.agentGates && !ctx.agentGates.sprites;
    const body: string[] = [];
    if (!noSprites && config.setSprite !== false) body.push(`spriteIds[_t] = ${Number(config._spriteSlot) || 0};`);
    if (!noSprites && config.setFrame) body.push(`spriteFrames[_t] = (${inputs['frame'] || '0'});`);
    if (!noSprites && config.setSpeed) body.push(`spriteSpeeds[_t] = (${inputs['speed'] || '0'});`);
    if (!noSprites && config.setRotation) {
      if (config.rotationMode === 'vector') {
        // Align the art to a direction vector (compass degrees, 0 = up/north,
        // clockwise); leave the rotation unchanged for a zero vector.
        body.push(`{ const _dx = (${inputs['dirX'] || '0'}), _dy = (${inputs['dirY'] || '0'}); if (_dx !== 0 || _dy !== 0) spriteRotations[_t] = Math.atan2(_dx, -_dy) * 180 / Math.PI; }`);
      } else {
        body.push(`spriteRotations[_t] = (${inputs['rotation'] || '0'});`);
      }
    }
    if (!noSprites && config.setScale) body.push(`spriteScales[_t] = (${inputs['scale'] || '1'});`);
    // Alpha = the agent colour's A byte (colors is Uint8ClampedArray → clamps).
    if (config.setAlpha) body.push(`colors[_t * 4 + 3] = (${inputs['alpha'] || '255'});`);
    if (body.length === 0) return '';
    const inner = body.join(' ');
    return guard
      ? `{ const _t = ${target}; if (${guard}) { ${inner} } }\n`
      : `{ const _t = ${target}; ${inner} }\n`;
  },
};
