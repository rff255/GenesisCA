/**
 * StyleReferenceView — kitchen-sink design system reference.
 *
 * Renders one of every UI building block used in the GenesisCA app, side by
 * side, so design-token changes can be iterated against a single
 * comprehensive view.
 *
 * Gated behind import.meta.env.DEV in App.tsx — only visible to developers
 * running `npm run dev`. Production builds (GitHub Pages) don't show the tab.
 */

import { useState } from 'react';
import { IndicatorSparkline } from '../simulator/IndicatorSparkline';
import { NodePreview } from '../modeler/panels/NodePreview';
import type { NodeTypeDef } from '../modeler/vpl/types';
import { useThemeTokens } from '../styles/useThemeTokens';
import styles from './StyleReferenceView.module.css';

// ---------------------------------------------------------------------------
// Token catalogues — names only. Values are read from getComputedStyle on
// the document root so the displayed hex always matches the active theme.
// ---------------------------------------------------------------------------

const COLOR_TOKEN_NAMES = [
  '--color-bg-app',
  '--color-bg-canvas',
  '--color-bg-panel',
  '--color-bg-elevated',
  '--color-bg-activitybar',
  '--color-border',
  '--color-border-muted',
  '--color-border-danger',
  '--color-text-primary',
  '--color-text-secondary',
  '--color-text-tertiary',
  '--color-text-muted',
  '--color-text-subtle',
  '--color-accent',
  '--color-accent-hover',
  '--color-danger',
  '--color-danger-hover',
  '--color-warning',
  '--color-success',
  '--color-info',
  '--color-channel-r',
  '--color-channel-g',
  '--color-channel-b',
  '--color-grid-active',
  '--color-grid-tagged',
  '--color-grid-center',
  '--scrollbar-thumb',
  '--scrollbar-thumb-hover',
  '--scrollbar-thumb-active',
] as const;

const SPACE_TOKENS = [
  { name: '--space-1', px: 2 },
  { name: '--space-2', px: 4 },
  { name: '--space-3', px: 6 },
  { name: '--space-4', px: 8 },
  { name: '--space-5', px: 10 },
  { name: '--space-6', px: 12 },
  { name: '--space-8', px: 16 },
  { name: '--space-10', px: 20 },
  { name: '--space-12', px: 24 },
  { name: '--space-16', px: 32 },
  { name: '--space-24', px: 48 },
];

const FONT_TOKENS = [
  { name: '--font-3xs', value: '0.6rem' },
  { name: '--font-2xs', value: '0.65rem' },
  { name: '--font-xs', value: '0.7rem' },
  { name: '--font-sm', value: '0.75rem' },
  { name: '--font-md', value: '0.8rem' },
  { name: '--font-base', value: '0.9rem' },
  { name: '--font-lg', value: '1.1rem' },
  { name: '--font-xl', value: '1.4rem' },
];

const RADIUS_TOKENS = [
  { name: '--radius-sm', value: '3px' },
  { name: '--radius-md', value: '4px' },
  { name: '--radius-lg', value: '6px' },
  { name: '--radius-xl', value: '8px' },
  { name: '--radius-pill', value: '12px' },
];

const SHADOW_TOKENS = [
  { name: '--shadow-sm', value: '0 2px 8px rgba(0,0,0,0.3)' },
  { name: '--shadow-md', value: '0 4px 16px rgba(0,0,0,0.4)' },
  { name: '--shadow-lg', value: '0 8px 32px rgba(0,0,0,0.6)' },
];

// Two minimal NodeTypeDefs for the preview-card showcase.
const DEMO_NODE_DEFS: NodeTypeDef[] = [
  {
    type: 'demo-getNeighborsAttribute',
    label: 'Get Neighbors Attribute',
    category: 'data',
    color: '#0d47a1',
    description: 'Read attribute values from all cells in a neighborhood',
    ports: [
      { id: 'attr', label: 'Attribute', kind: 'input', category: 'value', dataType: 'any' },
      { id: 'nb', label: 'Neighborhood', kind: 'input', category: 'value', dataType: 'any' },
      { id: 'values', label: 'Values', kind: 'output', category: 'value', dataType: 'any', isArray: true },
    ],
    defaultConfig: {},
    compile: () => '',
  },
  {
    type: 'demo-conditional',
    label: 'Conditional',
    category: 'flow',
    color: '#1b5e20',
    description: 'If/else branching on a binary condition',
    ports: [
      { id: 'in', label: '', kind: 'input', category: 'flow' },
      { id: 'cond', label: 'Condition', kind: 'input', category: 'value', dataType: 'bool' },
      { id: 'then', label: 'Then', kind: 'output', category: 'flow' },
      { id: 'else', label: 'Else', kind: 'output', category: 'flow' },
    ],
    defaultConfig: {},
    compile: () => '',
  },
];

// Sample sparkline data — sine wave with light noise.
const SPARKLINE_DATA = Array.from({ length: 60 }, (_, i) => {
  return 50 + 30 * Math.sin(i * 0.25) + (((i * 9301 + 49297) % 233280) / 233280 - 0.5) * 6;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function Section({
  title,
  caption,
  children,
}: {
  title: string;
  caption?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>{title}</h2>
        {caption && <span className={styles.sectionCaption}>{caption}</span>}
      </div>
      {children}
    </section>
  );
}

function UsedIn({ children }: { children: React.ReactNode }) {
  return <div className={styles.usedIn}>{children}</div>;
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export function StyleReferenceView() {
  const [textValue, setTextValue] = useState('Editable text');
  const [selectValue, setSelectValue] = useState('option-a');
  const [checked, setChecked] = useState(true);
  const [rangeValue, setRangeValue] = useState(50);
  const [numberValue, setNumberValue] = useState(42);
  const [segmentedValue, setSegmentedValue] = useState<'list' | 'visual'>('list');

  // Read live values for every colour token; re-runs on theme switch so
  // displayed hex matches the active theme.
  const colorValues = useThemeTokens(COLOR_TOKEN_NAMES);
  const colorTokens = COLOR_TOKEN_NAMES.map((name, i) => ({ name, value: colorValues[i] || '' }));

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        {/* ----- Page header ----- */}
        <div className={styles.pageHeader}>
          <h1 className={styles.pageTitle}>Style Reference</h1>
          <div className={styles.pageSubtitle}>
            A kitchen-sink view of every UI building block in GenesisCA. Iterate
            design tokens (in <code>src/styles/tokens.css</code>) against this
            page until the visual language is right; the rest of the app
            inherits via <code>var(--*)</code>.
          </div>
        </div>

        {/* ----- 1. Token swatches ----- */}
        <Section title="1. Tokens" caption="The atomic values everything else is built from.">
          <div className={styles.subsection}>
            <div className={styles.subsectionTitle}>Colours</div>
            <div className={styles.swatchGrid}>
              {colorTokens.map(t => (
                <div className={styles.swatchRow} key={t.name}>
                  <div className={styles.swatchChip} style={{ background: `var(${t.name})` }} />
                  <div className={styles.swatchInfo}>
                    <div className={styles.swatchName}>{t.name}</div>
                    <div className={styles.swatchValue}>{t.value}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className={styles.subsection}>
            <div className={styles.subsectionTitle}>Spacing</div>
            <div className={styles.flexCol}>
              {SPACE_TOKENS.map(t => (
                <div className={styles.spaceRow} key={t.name}>
                  <span className={styles.spaceName}>{t.name}</span>
                  <span className={styles.spaceValue}>{t.px}px</span>
                  <div className={styles.spaceBar} style={{ width: `${t.px * 4}px` }} />
                </div>
              ))}
            </div>
          </div>

          <div className={styles.subsection}>
            <div className={styles.subsectionTitle}>Type scale</div>
            <div className={styles.flexCol}>
              {FONT_TOKENS.map(t => (
                <div className={styles.typeRow} key={t.name}>
                  <span className={styles.typeName}>{t.name}</span>
                  <span className={styles.typeValue}>{t.value}</span>
                  <span className={styles.typeSample} style={{ fontSize: `var(${t.name})` }}>
                    The quick brown fox jumps over the lazy dog
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className={styles.subsection}>
            <div className={styles.subsectionTitle}>Radii</div>
            <div className={styles.radiusGrid}>
              {RADIUS_TOKENS.map(t => (
                <div className={styles.radiusItem} key={t.name}>
                  <div className={styles.radiusBox} style={{ borderRadius: `var(${t.name})` }} />
                  <span>{t.name}</span>
                  <span>{t.value}</span>
                </div>
              ))}
            </div>
          </div>

          <div className={styles.subsection}>
            <div className={styles.subsectionTitle}>Shadows</div>
            <div className={styles.shadowGrid}>
              {SHADOW_TOKENS.map(t => (
                <div
                  className={styles.shadowBox}
                  style={{ boxShadow: `var(${t.name})` }}
                  key={t.name}
                >
                  {t.name}
                </div>
              ))}
            </div>
          </div>
        </Section>

        {/* ----- 2. Buttons ----- */}
        <Section title="2. Buttons" caption="Default, hover, and active states for every button variant.">
          <div className={styles.subsection}>
            <div className={styles.subsectionTitle}>Nav buttons</div>
            <UsedIn>
              Used by the navbar tabs in <code>src/App.tsx</code>.
            </UsedIn>
            <div className={styles.demoNavBar}>
              <button className={styles.demoNavButton}>Default</button>
              <button className={`${styles.demoNavButton} ${styles.forceHoverNav}`}>Hover</button>
              <button className={`${styles.demoNavButton} ${styles.demoNavButtonActive}`}>
                Active
              </button>
            </div>
          </div>

          <div className={styles.subsection}>
            <div className={styles.subsectionTitle}>Add / Delete buttons</div>
            <UsedIn>
              Used by the modeler panels (Properties, Attributes, Mappings) —{' '}
              <code>src/modeler/panels/PanelContent.module.css</code>.
            </UsedIn>
            <div className={styles.flexRow}>
              <button className={styles.demoAddButton}>+ Add Attribute</button>
              <button className={`${styles.demoAddButton} ${styles.forceHoverAdd}`}>
                + Hovered
              </button>
              <button className={styles.demoDeleteButton}>Delete</button>
              <button className={`${styles.demoDeleteButton} ${styles.forceHoverDelete}`}>
                Hovered
              </button>
            </div>
          </div>

          <div className={styles.subsection}>
            <div className={styles.subsectionTitle}>Close button</div>
            <UsedIn>
              Used in <code>PanelShell</code> headers.
            </UsedIn>
            <div className={styles.flexRow}>
              <button className={styles.demoCloseButton}>×</button>
              <button className={`${styles.demoCloseButton} ${styles.forceHoverClose}`}>×</button>
            </div>
          </div>

          <div className={styles.subsection}>
            <div className={styles.subsectionTitle}>Activity bar (icon-only)</div>
            <UsedIn>
              Used by the modeler's left/right activity bars —{' '}
              <code>src/modeler/ActivityBar.module.css</code>.
            </UsedIn>
            <div className={styles.demoActivityBar}>
              <button className={styles.demoActivityButton}>P</button>
              <button className={`${styles.demoActivityButton} ${styles.demoActivityButtonActive}`}>
                A
              </button>
              <button className={styles.demoActivityButton}>N</button>
              <button className={styles.demoActivityButton}>M</button>
            </div>
          </div>
        </Section>

        {/* ----- 3. Form controls ----- */}
        <Section title="3. Form controls" caption="Inputs, selects, checkboxes, sliders.">
          <UsedIn>
            Used throughout the modeler panels —{' '}
            <code>src/modeler/panels/PanelContent.module.css</code>.
          </UsedIn>
          <div className={styles.grid2}>
            <div className={styles.subsection}>
              <label className={styles.demoFieldLabel}>Text input (default)</label>
              <input
                className={styles.demoInput}
                value={textValue}
                onChange={e => setTextValue(e.target.value)}
              />
            </div>
            <div className={styles.subsection}>
              <label className={styles.demoFieldLabel}>Text input (focused)</label>
              <input
                className={`${styles.demoInput} ${styles.demoInputFocused}`}
                defaultValue="Focused state"
              />
            </div>
            <div className={styles.subsection}>
              <label className={styles.demoFieldLabel}>Text input (disabled)</label>
              <input
                className={`${styles.demoInput} ${styles.demoInputDisabled}`}
                value="Disabled"
                disabled
                readOnly
              />
            </div>
            <div className={styles.subsection}>
              <label className={styles.demoFieldLabel}>Number input</label>
              <input
                type="number"
                className={styles.demoNumberInput}
                value={numberValue}
                onChange={e => setNumberValue(parseInt(e.target.value || '0', 10))}
              />
            </div>
            <div className={styles.subsection}>
              <label className={styles.demoFieldLabel}>Select</label>
              <select
                className={styles.demoSelect}
                value={selectValue}
                onChange={e => setSelectValue(e.target.value)}
              >
                <option value="option-a">Option A</option>
                <option value="option-b">Option B</option>
                <option value="option-c">Option C</option>
              </select>
            </div>
            <div className={styles.subsection}>
              <label className={styles.demoFieldLabel}>Checkbox</label>
              <label className={styles.demoCheckbox}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={e => setChecked(e.target.checked)}
                />
                Watch this attribute
              </label>
            </div>
            <div className={styles.subsection} style={{ gridColumn: 'span 2' }}>
              <label className={styles.demoFieldLabel}>Textarea</label>
              <textarea className={styles.demoTextarea} defaultValue="Multi-line description…" />
            </div>
            <div className={styles.subsection} style={{ gridColumn: 'span 2' }}>
              <label className={styles.demoFieldLabel}>Range slider — value: {rangeValue}</label>
              <input
                type="range"
                min={0}
                max={100}
                value={rangeValue}
                onChange={e => setRangeValue(parseInt(e.target.value, 10))}
                className={styles.demoRange}
              />
            </div>
          </div>
        </Section>

        {/* ----- 4. Panels & containers ----- */}
        <Section title="4. Panels & containers" caption="The chrome that holds everything else.">
          <div className={styles.grid3}>
            <div className={styles.subsection}>
              <div className={styles.subsectionTitle}>Panel shell</div>
              <UsedIn>
                <code>src/modeler/PanelShell.module.css</code>
              </UsedIn>
              <div className={styles.demoPanelShell}>
                <div className={styles.demoPanelHeader}>
                  <span className={styles.demoPanelTitle}>Properties</span>
                  <button className={styles.demoCloseButton}>×</button>
                </div>
                <div className={styles.demoPanelBody}>
                  Resizable panel body. Scrolls vertically when content overflows.
                </div>
              </div>
            </div>
            <div className={styles.subsection}>
              <div className={styles.subsectionTitle}>Popover</div>
              <UsedIn>
                Brush colour picker, context menu —{' '}
                <code>src/simulator/BrushColorPopover.module.css</code>
              </UsedIn>
              <div className={styles.demoPopover}>
                A floating box pinned to a trigger element. Has shadow and an
                accent-coloured border.
              </div>
            </div>
            <div className={styles.subsection}>
              <div className={styles.subsectionTitle}>Card</div>
              <UsedIn>
                Models Library cards, palette node previews —{' '}
                <code>src/library/ModelsLibrary.module.css</code>
              </UsedIn>
              <div className={styles.demoCard}>
                A neutral container for grouping related content. Same surface
                colour as panels but with subtler chrome.
              </div>
            </div>
          </div>
          <div className={styles.subsection}>
            <div className={styles.subsectionTitle}>Section title</div>
            <div className={styles.demoSectionTitle}>Section heading</div>
          </div>
        </Section>

        {/* ----- 5. Tabs & toggles ----- */}
        <Section title="5. Tabs & toggles" caption="Switching between modes within a panel or page.">
          <div className={styles.subsection}>
            <div className={styles.subsectionTitle}>Top-nav tabs (mock)</div>
            <UsedIn>
              <code>src/App.module.css</code>
            </UsedIn>
            <div className={styles.demoNavBar}>
              <button className={styles.demoNavButton}>Modeler</button>
              <button className={`${styles.demoNavButton} ${styles.demoNavButtonActive}`}>
                Simulator
              </button>
              <button className={styles.demoNavButton}>Help</button>
              <button className={styles.demoNavButton}>Library</button>
            </div>
          </div>

          <div className={styles.subsection}>
            <div className={styles.subsectionTitle}>Segmented toggle</div>
            <UsedIn>
              View mode switcher in the palette —{' '}
              <code>src/modeler/panels/PalettePanelContent.module.css</code>
            </UsedIn>
            <div className={styles.demoSegmented}>
              <button
                className={`${styles.demoSegmentedButton} ${
                  segmentedValue === 'list' ? styles.demoSegmentedButtonActive : ''
                }`}
                onClick={() => setSegmentedValue('list')}
              >
                List
              </button>
              <button
                className={`${styles.demoSegmentedButton} ${
                  segmentedValue === 'visual' ? styles.demoSegmentedButtonActive : ''
                }`}
                onClick={() => setSegmentedValue('visual')}
              >
                Visual
              </button>
            </div>
          </div>
        </Section>

        {/* ----- 6. Lists ----- */}
        <Section title="6. Lists" caption="Reorderable rows for attributes, neighborhoods, indicators.">
          <UsedIn>
            <code>src/modeler/panels/PanelContent.module.css</code> —{' '}
            <code>.list</code>, <code>.listItem</code>, <code>.dragHandle</code>.
          </UsedIn>
          <div className={styles.demoList} style={{ maxWidth: 380 }}>
            <div className={styles.demoListItem}>
              <span className={styles.demoListItemName}>alive</span>
              <span className={styles.demoListItemBadge}>BOOL</span>
              <span className={styles.demoDragHandle}>⋮⋮</span>
            </div>
            <div className={`${styles.demoListItem} ${styles.demoListItemSelected}`}>
              <span className={styles.demoListItemName}>energy</span>
              <span className={styles.demoListItemBadge}>FLOAT</span>
              <span className={styles.demoDragHandle}>⋮⋮</span>
            </div>
            <div className={`${styles.demoListItem} ${styles.demoDropBefore}`}>
              <span className={styles.demoListItemName}>species</span>
              <span className={styles.demoListItemBadge}>TAG</span>
              <span className={styles.demoDragHandle}>⋮⋮</span>
            </div>
            <div className={`${styles.demoListItem} ${styles.demoDropAfter}`}>
              <span className={styles.demoListItemName}>generation</span>
              <span className={styles.demoListItemBadge}>INT</span>
              <span className={styles.demoDragHandle}>⋮⋮</span>
            </div>
          </div>
        </Section>

        {/* ----- 7. Badges & chips ----- */}
        <Section title="7. Badges & chips">
          <div className={styles.flexRow}>
            <span className={styles.warningBadge}>!</span>
            <UsedIn>Validation warning on a node ({'<'}<code>CaNode</code>)</UsedIn>
          </div>
          <div className={styles.flexRow}>
            <span className={styles.typeBadge}>BOOL</span>
            <span className={styles.typeBadge}>FLOAT</span>
            <span className={styles.typeBadge}>TAG</span>
            <UsedIn>Attribute type tags (<code>.listItemBadge</code>)</UsedIn>
          </div>
          <div className={styles.flexRow}>
            <span style={{ fontSize: 'var(--font-lg)', fontWeight: 700, color: 'var(--color-accent)' }}>
              GenesisCA <span className={styles.versionBadge}>v1.11.0</span>
            </span>
            <UsedIn>Version badge in the navbar</UsedIn>
          </div>
          <div className={styles.flexRow}>
            <span className={`${styles.colorChip} ${styles.colorChipR}`}>R</span>
            <span className={`${styles.colorChip} ${styles.colorChipG}`}>G</span>
            <span className={`${styles.colorChip} ${styles.colorChipB}`}>B</span>
            <UsedIn>RGB channel chips in Color Mappings panel</UsedIn>
          </div>
        </Section>

        {/* ----- 8. Node-preview cards ----- */}
        <Section
          title="8. Node-preview cards"
          caption="Draggable cards in the palette's Visual mode."
        >
          <UsedIn>
            <code>src/modeler/panels/NodePreview.tsx</code> +{' '}
            <code>PalettePanelContent.module.css</code>
          </UsedIn>
          <div className={styles.flexRow}>
            {DEMO_NODE_DEFS.map(def => (
              <NodePreview key={def.type} def={def} onDragStart={() => {}} />
            ))}
          </div>
        </Section>

        {/* ----- 9. Splitters / resize handles ----- */}
        <Section
          title="9. Splitters & resize handles"
          caption="6px draggable strips between resizable regions."
        >
          <UsedIn>
            <code>PanelShell.module.css</code> — <code>.resizeHandle</code>
          </UsedIn>
          <div className={styles.demoSplitter} style={{ maxWidth: 380 }}>
            <div className={styles.demoSplitterPane}>Left pane</div>
            <div className={styles.demoSplitterHandle} />
            <div className={styles.demoSplitterPane}>Right pane</div>
          </div>
          <div className={styles.demoSplitter} style={{ maxWidth: 380 }}>
            <div className={styles.demoSplitterPane}>Left pane</div>
            <div className={`${styles.demoSplitterHandle} ${styles.demoSplitterHandleHovered}`} />
            <div className={styles.demoSplitterPane}>Right pane (hover state)</div>
          </div>
        </Section>

        {/* ----- 10. Sparkline / chart slot ----- */}
        <Section
          title="10. Charts"
          caption="Sparkline rendered with a sample series. Multiline / stacked variants exist but are skipped here."
        >
          <UsedIn>
            <code>src/simulator/IndicatorSparkline.tsx</code>
          </UsedIn>
          <div className={styles.sparklineFrame} style={{ maxWidth: 480 }}>
            <div className={styles.sparklineHeader}>
              <span className={styles.sparklineTitle}>Population</span>
              <span className={styles.sparklineValue}>
                {SPARKLINE_DATA[SPARKLINE_DATA.length - 1]!.toFixed(1)}
              </span>
            </div>
            <IndicatorSparkline data={SPARKLINE_DATA} generation={60} height={80} />
          </div>
        </Section>

        {/* ----- 11. Notifications ----- */}
        <Section title="11. Notifications" caption="Inline messages — info, warning, error.">
          <div className={`${styles.notice} ${styles.noticeInfo}`}>
            <strong>End condition reached:</strong> Population stayed below 5 for
            10 generations.
          </div>
          <div className={`${styles.notice} ${styles.noticeWarning}`}>
            <strong>Validation warning:</strong> Some nodes have missing
            configuration. Hover for details.
          </div>
          <div className={`${styles.notice} ${styles.noticeError}`}>
            <strong>Compile error:</strong> Async-only node used in synchronous
            update mode.
          </div>
        </Section>

        {/* ----- 12. Scrollbars ----- */}
        <Section
          title="12. Scrollbars"
          caption="Slim dark-theme scrollbars; thumb cyan when actively dragged."
        >
          <UsedIn>
            Global rules in <code>src/index.css</code>. Tokens:{' '}
            <code>--scrollbar-thumb</code>, <code>--scrollbar-thumb-hover</code>,{' '}
            <code>--scrollbar-thumb-active</code>.
          </UsedIn>
          <div className={styles.scrollbarDemoRow}>
            <div className={styles.scrollbarBox}>
              {Array.from({ length: 30 }).map((_, i) => (
                <div key={i}>Vertical scroll line {i + 1}</div>
              ))}
            </div>
            <div className={styles.scrollbarBox}>
              {Array.from({ length: 30 }).map((_, i) => (
                <div key={i}>Vertical scroll line {i + 1}</div>
              ))}
            </div>
          </div>
          <div className={styles.scrollbarHorizontalBox}>
            {Array.from({ length: 40 }).map((_, i) => (
              <span key={i} style={{ marginRight: 'var(--space-8)' }}>
                Horizontal scroll segment {i + 1}
              </span>
            ))}
          </div>
        </Section>

        {/* ----- 13. Decorations ----- */}
        <Section title="13. Decorations" caption="Dividers, separators, drop indicators.">
          <div className={styles.subsection}>
            <div className={styles.subsectionTitle}>Dividers</div>
            <hr className={styles.divider} />
            <div style={{ height: 8 }} />
            <hr className={styles.dividerMuted} />
          </div>
          <div className={styles.subsection}>
            <div className={styles.subsectionTitle}>Drop indicators</div>
            <UsedIn>
              The cyan inset shadow shown above/below a list row during drag.
            </UsedIn>
            <div className={styles.flexCol} style={{ maxWidth: 380 }}>
              <div className={`${styles.dropDemo} ${styles.demoDropBefore}`}>Drop before</div>
              <div className={`${styles.dropDemo} ${styles.demoDropAfter}`}>Drop after</div>
            </div>
          </div>
          <div className={styles.subsection}>
            <div className={styles.subsectionTitle}>Neighborhood grid</div>
            <UsedIn>
              <code>.gridCell</code> states in <code>PanelContent.module.css</code>
            </UsedIn>
            <div className={styles.demoGrid}>
              {Array.from({ length: 25 }).map((_, i) => {
                const r = Math.floor(i / 5);
                const c = i % 5;
                if (r === 2 && c === 2) {
                  return <div key={i} className={`${styles.demoGridCell} ${styles.demoGridCellCenter}`} />;
                }
                if ((r === 1 && c === 2) || (r === 3 && c === 2) || (r === 2 && c === 1) || (r === 2 && c === 3)) {
                  return <div key={i} className={`${styles.demoGridCell} ${styles.demoGridCellActive}`} />;
                }
                if (r === 0 && c === 0) {
                  return <div key={i} className={`${styles.demoGridCell} ${styles.demoGridCellTagged}`} />;
                }
                return <div key={i} className={`${styles.demoGridCell} ${styles.demoGridCellEmpty}`} />;
              })}
            </div>
          </div>
        </Section>
      </div>
    </div>
  );
}
