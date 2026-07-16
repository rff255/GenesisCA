import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ModelProvider } from '../model/ModelContext';
import { parseModelJSON, EMBEDDED_MODEL_PLACEHOLDER } from '../model/fileOperations';
import type { CAModel } from '../model/types';
import { ViewerApp } from './ViewerApp';
import '../index.css';

/**
 * Presentation-viewer entry — the alternate app that ships inside an exported
 * standalone `.html`. It mounts ONLY the Simulator (no Modeler / navbar /
 * library) over a full in-memory ModelProvider, seeded from the model embedded
 * in the `#genesis-model` <script> placeholder. See docs/PLAN_PRESENTATION_EXPORT.md.
 */
function readEmbeddedModel(): { model: CAModel | null; error: string | null } {
  const el = document.getElementById('genesis-model');
  const raw = el?.textContent?.trim();
  if (!raw || raw === EMBEDDED_MODEL_PLACEHOLDER) {
    return { model: null, error: null }; // template opened without an injected model
  }
  try {
    return { model: parseModelJSON(raw), error: null };
  } catch (e) {
    return { model: null, error: e instanceof Error ? e.message : String(e) };
  }
}

const { model, error } = readEmbeddedModel();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ModelProvider>
      <ViewerApp model={model} error={error} />
    </ModelProvider>
  </StrictMode>,
);
