// Presentation Export — assemble a single self-contained standalone .html from
// the pre-built viewer template + a serialized model. See
// docs/PLAN_PRESENTATION_EXPORT.md. The heavy lifting (worker, compilers,
// SimulatorView) lives in the template; this module just injects the model.
import { serializeModel } from '../model/fileOperations';
import type { CAModel } from '../model/types';

/** The sentinel the viewer template ships with in its <script id="genesis-model">. */
const MODEL_PLACEHOLDER_RE =
  /(<script[^>]*id=["']genesis-model["'][^>]*>)[\s\S]*?(<\/script>)/;

/**
 * Escape a JSON string for safe embedding inside an HTML <script> element's
 * raw text. JSON structure has no `<`, so escaping `<` (→ <) can only
 * touch string values and prevents a stray `</script>` / `<!--` from closing
 * the tag; U+2028/U+2029 are escaped defensively. All three are valid inside a
 * JSON string and round-trip through JSON.parse.
 */
export function escapeForScriptTag(json: string): string {
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  return json
    .split('<').join('\\u003c')
    .split(LS).join('\\u2028')
    .split(PS).join('\\u2029');
}

/** Inject a model into the viewer template, targeting the model <script>
 *  specifically (the sentinel also appears as a bundled JS constant). */
export function assemblePresentationHtml(template: string, model: CAModel): string {
  if (!MODEL_PLACEHOLDER_RE.test(template)) {
    throw new Error(
      'The viewer template has no model placeholder — rebuild it with `npm run build:viewer`.',
    );
  }
  const json = escapeForScriptTag(serializeModel(model));
  // Use a replacer function so `$` sequences in the JSON aren't interpreted.
  return template.replace(MODEL_PLACEHOLDER_RE, (_m, open, close) => open + json + close);
}

/** Fetch the shipped, fully-inlined viewer template (precached → offline-safe). */
export async function fetchViewerTemplate(): Promise<string> {
  const url = `${import.meta.env.BASE_URL}viewer-template.html`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Couldn't load the viewer template (HTTP ${res.status}). Run \`npm run build:viewer\` to produce it.`,
    );
  }
  return res.text();
}

/** `.html` filename derived from the model name (mirrors modelFilename). */
export function presentationFilename(model: CAModel): string {
  const base = model.properties.name
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
  return `${base || 'model'}.html`;
}

/** Build the standalone HTML string (template + injected model). */
export async function buildPresentationHtml(model: CAModel): Promise<string> {
  const template = await fetchViewerTemplate();
  return assemblePresentationHtml(template, model);
}
