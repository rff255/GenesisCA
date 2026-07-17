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

/** Escape text for safe embedding inside an HTML attribute / text node. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Thumbnails above this size are NOT duplicated into og:image — the data URL
 *  already travels inside the model JSON, and big ones would bloat the file
 *  for a tag most scrapers ignore anyway (data-URL og:image support is rare). */
const OG_THUMBNAIL_MAX_CHARS = 300_000;

/**
 * Social link-preview tags for the exported presentation (Open Graph + Twitter
 * card), built from the model's presentation metadata so a HOSTED copy of the
 * exported .html shows the model's name/description (and, where the platform
 * supports data-URL images, its thumbnail) when the link is shared. NB: OG
 * previews only appear when the file is served over http(s) — a raw file
 * attachment gets no scrape — and most scrapers require an absolute-URL image,
 * so the data-URL thumbnail is best-effort.
 */
function buildSocialMetaTags(model: CAModel): string {
  const p = model.properties;
  const title = `${p.name || 'GenesisCA Model'} — GenesisCA`;
  const desc = (p.description || '').trim()
    || 'An interactive cellular automata / agent-based simulation built with GenesisCA. Open this file in any browser to run it.';
  const lines: string[] = [
    `<meta name="description" content="${escapeHtml(desc)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="GenesisCA" />`,
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:description" content="${escapeHtml(desc)}" />`,
    `<meta name="twitter:card" content="summary" />`,
    `<meta name="twitter:title" content="${escapeHtml(title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(desc)}" />`,
  ];
  const author = [p.author, p.modelAuthor].filter(Boolean).join(', ');
  if (author) lines.push(`<meta name="author" content="${escapeHtml(author)}" />`);
  const thumb = p.thumbnail;
  if (thumb && thumb.startsWith('data:image/') && thumb.length <= OG_THUMBNAIL_MAX_CHARS) {
    lines.push(`<meta property="og:image" content="${escapeHtml(thumb)}" />`);
    lines.push(`<meta name="twitter:image" content="${escapeHtml(thumb)}" />`);
  }
  return lines.map(l => '    ' + l).join('\n');
}

const TITLE_RE = /<title>[\s\S]*?<\/title>/;
const HEAD_OPEN_RE = /<head([^>]*)>/;
const DOCTYPE_RE = /^\s*<!doctype html>/i;

/** Make text safe inside an HTML comment: `--` is invalid in comments and
 *  `-->` would terminate the banner early — replace with an en dash. */
function commentSafe(s: string): string {
  return s.replace(/-{2,}/g, '–');
}

/** Wrap text to `width`-char lines (word boundaries), capped at `maxLines`. */
function wrapLines(text: string, width: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let line = '';
  for (const w of words) {
    if (line && line.length + 1 + w.length > width) {
      out.push(line);
      if (out.length === maxLines) { out[maxLines - 1] += ' …'; return out; }
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) out.push(line);
  return out;
}

/**
 * A human-readable comment banner placed at the VERY TOP of the exported file
 * (right after the doctype). Messaging apps never OG-scrape file ATTACHMENTS —
 * but some (Discord, Slack) preview an attached text file's FIRST LINES as raw
 * text, which for a single-file bundle is minified code soup. This banner makes
 * that snippet read as the model's name + summary + "open in a browser" hint
 * instead. (Real rich previews with a thumbnail need the file HOSTED at a URL —
 * then the injected og:/twitter: tags take over.)
 */
function buildAttachmentBanner(model: CAModel): string {
  const p = model.properties;
  const name = commentSafe(p.name || 'GenesisCA Model');
  const desc = commentSafe((p.description || '').trim());
  const author = commentSafe([p.author, p.modelAuthor].filter(Boolean).join(', '));
  const lines: string[] = [
    '',
    '  ============================================================',
    `  ${name} — an interactive GenesisCA simulation`,
    '  ============================================================',
  ];
  for (const l of wrapLines(desc, 60, 4)) lines.push(`  ${l}`);
  if (author) lines.push(`  By: ${author}`);
  lines.push('');
  lines.push('  HOW TO RUN: save this file and open it in any web browser');
  lines.push('  (double-click it) — no install, works offline.');
  lines.push('');
  lines.push('  Built with GenesisCA — https://genesisca.online');
  lines.push('');
  return `<!--\n${lines.join('\n')}\n-->`;
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
  let html = template.replace(MODEL_PLACEHOLDER_RE, (_m, open, close) => open + json + close);
  // Personalize the tab title + inject the social link-preview tags right after
  // <head>. Replacer functions throughout so `$` in model text is literal.
  const name = model.properties.name || 'GenesisCA Model';
  html = html.replace(TITLE_RE, () => `<title>${escapeHtml(name)} — GenesisCA</title>`);
  const meta = buildSocialMetaTags(model);
  html = html.replace(HEAD_OPEN_RE, (m) => `${m}\n${meta}`);
  // Attachment banner FIRST in the file (after the doctype) so raw-text
  // attachment previews (Discord/Slack show the first lines) read as the
  // model's name/summary instead of minified code. Valid HTML: comments may
  // sit between the doctype and <html>. If the doctype ever goes missing from
  // the template, prepend the banner (browsers tolerate a comment before it).
  const banner = buildAttachmentBanner(model);
  if (DOCTYPE_RE.test(html)) {
    html = html.replace(DOCTYPE_RE, (m) => `${m}\n${banner}`);
  } else {
    html = `${banner}\n${html}`;
  }
  return html;
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
