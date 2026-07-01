import type { NodeTypeDef } from '../types';

/** Set Agent Sprite — the agent-logic controller for the optional sprite
 *  exhibition layer. The per-agent sprite state is PERSISTENT (a sprite slot, a
 *  current frame, and a playback speed in frames per simulation step); the engine
 *  advances `frame += speed` every step (negative speed = reverse), and the
 *  RENDER blits the floored frame (wrapped/clamped by the sprite's loop flag).
 *  This node SETS any independently-chosen subset of that state, so playback is
 *  driven by the agent's logic — e.g. "while moving, set speed = 1 (walk plays);
 *  while idle, set speed = 0 (hold)", "on a state change, change which sprite",
 *  or "reset to frame 0".
 *
 *  TICKABLE options (config flags): `setSprite` (change which sprite), `setFrame`
 *  (jump to / reset the frame — the `Frame` input), `setSpeed` (set the playback
 *  speed — the `Speed` input, may be negative). Unticked facets are left
 *  untouched (so you can swap the sprite while keeping the frame/speed, or only
 *  change the speed, etc.).
 *
 *  Use it in an Agent Output Mapping graph (the exhibition layer; reads the
 *  agent's behaviour-produced state) or directly in the Behaviour/Division graph.
 *  It writes the JS-engine per-agent display buffers (`spriteIds` / `spriteFrames`
 *  / `spriteSpeeds`) so it has no WASM/WebGPU emit; the engine frame-advance is
 *  JS on every agent target. Placed in the BEHAVIOUR graph on a WASM/WebGPU agent
 *  target it clamps that behaviour to JS (it isn't in the agent WASM/WebGPU
 *  supported sets); the Output-Mapping usage is unaffected (the gate inspects only
 *  behaviour-reachable nodes). `requirements.bondGraph` → Agents sub-tab only. */
export const SetAgentSpriteNode: NodeTypeDef = {
  type: 'setAgentSprite',
  label: 'Set Agent Sprite',
  description: 'Control the agent’s sprite exhibition: change the sprite, set the frame, and/or set the playback speed (frames/step; negative = reverse). Tick only the facets you want to change. Use in an Agent Output Mapping graph.',
  category: 'color',
  color: '#8e24aa',
  requirements: { bondGraph: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
    { id: 'frame', label: 'Frame', kind: 'input', category: 'value', dataType: 'integer', inlineWidget: 'number', defaultValue: '0' },
    { id: 'speed', label: 'Speed', kind: 'input', category: 'value', dataType: 'float', inlineWidget: 'number', defaultValue: '1' },
  ],
  defaultConfig: { spriteId: '', setSprite: true, setFrame: false, setSpeed: false },
  // The Frame / Speed inputs only matter when their facet is ticked.
  hiddenPorts: (config) => {
    const hidden: string[] = [];
    if (!config.setFrame) hidden.push('frame');
    if (!config.setSpeed) hidden.push('speed');
    return hidden;
  },
  compile: (_nodeId, config, inputs) => {
    const lines: string[] = [];
    // Change which sprite (1-based slot pre-resolved into _spriteSlot; 0 = none/clear).
    if (config.setSprite !== false) {
      lines.push(`spriteIds[idx] = ${Number(config._spriteSlot) || 0};`);
    }
    // Jump to / reset the current frame.
    if (config.setFrame) {
      lines.push(`spriteFrames[idx] = (${inputs['frame'] || '0'});`);
    }
    // Set the playback speed (frames per step; negative = reverse; 0 = hold).
    if (config.setSpeed) {
      lines.push(`spriteSpeeds[idx] = (${inputs['speed'] || '0'});`);
    }
    return lines.length ? lines.join('\n') + '\n' : '';
  },
};
