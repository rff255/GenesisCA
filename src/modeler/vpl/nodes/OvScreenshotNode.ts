import type { NodeTypeDef } from '../types';

/** Overseer capture — take a screenshot of the simulation view (the same PNG
 *  the transport-bar camera button produces, downloaded with the label in the
 *  filename) and journal the moment. Only meaningful on the watched (visible)
 *  run. */
export const OvScreenshotNode: NodeTypeDef = {
  type: 'ovScreenshot',
  label: 'Take Screenshot',
  description: 'Captures a PNG of the simulation view (like the transport camera button) as a protocol step — e.g. one screenshot per run at elution.',
  category: 'output',
  color: '#546e7a',
  requirements: { overseer: true },
  ports: [
    { id: 'do', label: 'DO', kind: 'input', category: 'flow' },
    { id: 'next', label: 'NEXT', kind: 'output', category: 'flow' },
  ],
  defaultConfig: { label: 'capture' },
  compile: () => '', // Action — the overseer compiler emits `await O.screenshot(label)`
};
