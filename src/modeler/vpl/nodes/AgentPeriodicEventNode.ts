import type { NodeTypeDef } from '../types';
import { is3dModelLike } from '../compiler/niCodec';

/** Population Periodic Event — a GLOBAL, once-per-firing-generation root for the
 *  AGENT layer. The periodic sibling of the Agent Init Event, and the global
 *  counterpart of the per-agent **Agent Periodic Step**.
 *
 *  ## Global, NOT per agent — and the label is deliberately first-word-distinct
 *  It runs EXACTLY ONCE on a generation where `generation % Period === Phase`,
 *  with NO `self`: the per-agent readers (Get Self Position / Get Nearby Agents /
 *  the self writers …) don't apply, exactly as in the Agent Init Event. The name
 *  starts with a different word from "Agent Periodic Step" precisely so the two
 *  can never be confused in a palette or a search result — the ORIGINAL "Periodic
 *  Step" read as global and was not.
 *
 *  ## What it is for
 *  Population-level events: spawn a batch of agents on a schedule (the same
 *  **Create Agent → set-by-handle → Add Agent To World** idiom the Agent Init
 *  Event uses — it shares that ABI exactly), retire agents by id, sweep an
 *  attribute, or read an indicator and fire a **Stop Event**.
 *
 *  Several are allowed per graph (each with its own cadence); a period of 1 fires
 *  every generation.
 *
 *  ## When it runs — and why a newborn behaves the SAME generation
 *  At the TOP of the generation, BEFORE the per-agent behaviour and before the
 *  cell step. That ordering is what makes a spawn immediately alive: the agent
 *  loop captures its bound AFTER this runs, so a newborn is inside it and
 *  behaves + integrates THIS generation — exactly like an Agent-Init-Event
 *  agent, and UNLIKE a Behaviour-Step spawn (which lands past a bound that was
 *  already captured, so it waits for the next generation).
 *
 *  ## How it runs — one JS function in the worker, on every compile target
 *  JS-on-CPU on JS, WASM and WebGPU alike, the documented posture the Agent Init
 *  Event and the Division Event already have: the WASM / WebGPU BEHAVIOUR
 *  compilers never see this root, so there is no per-target emit and no gate to
 *  widen. It DOES block the GPU-resident batch (a resident batch encodes N
 *  generations into one submit with no CPU touch point between them, which is
 *  precisely what a per-generation event needs) — a class-F cost, never an error.
 *
 *  Value-outs expose the agent world bounds (which ARE the grid frame, 1:1) plus
 *  `stepIndex` = ⌊generation / Period⌋ and `seedIndexBase` = the population's
 *  `highWater` before this firing (so a spawn loop can index its own newborns).
 *
 *  compile() returns '' — the compiler emits the once-per-firing function. */
export const AgentPeriodicEventNode: NodeTypeDef = {
  type: 'agentPeriodic',
  label: 'Population Periodic Event',
  description: 'Runs ONCE GLOBALLY (not per agent, no self) every Nth generation — spawn agents with Create Agent → Add Agent To World, sweep the population, or read an indicator and fire a Stop Event. Outputs the world size + Step Index = ⌊generation / Period⌋. For a rule that runs FOR EVERY agent on those generations use Agent Periodic Step instead.',
  category: 'event',
  // Event roots are white (the CA-grid standard: Behaviour Step / Agent Init).
  color: '#ffffff',
  requirements: { bondGraph: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'output', category: 'flow' },
    { id: 'worldWidth', label: 'World Width', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'worldHeight', label: 'World Height', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'worldDepth', label: 'World Depth', kind: 'output', category: 'value', dataType: 'float' },
    { id: 'stepIndex', label: 'Step Index', kind: 'output', category: 'value', dataType: 'integer' },
    { id: 'seedIndexBase', label: 'Seed Index Base', kind: 'output', category: 'value', dataType: 'integer' },
  ],
  // `worldDepth` exists only in a 3D model (mirrors the Agent Init Event).
  hiddenPorts: (_config, model) => (is3dModelLike(model) ? [] : ['worldDepth']),
  defaultConfig: { period: 10, phase: 0 },
  compile: () => '',  // root node — the compiler emits the once-per-firing function
};
