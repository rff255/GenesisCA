import { useCallback, useRef } from 'react';
import styles from './HelpView.module.css';

const sections = [
  { id: 'intro', label: 'What is GenesisCA' },
  { id: 'fundamentals', label: 'The 6 Fundamentals' },
  { id: 'modeler', label: 'The Modeler' },
  { id: 'nodes', label: 'Node Types Reference' },
  { id: 'macros', label: 'The Macro System' },
  { id: '3dgridca', label: '3D Grid CA' },
  { id: 'agents', label: 'Bond-Graph Agents' },
  { id: 'simulator', label: 'The Simulator' },
  { id: 'shortcuts', label: 'Keyboard Shortcuts' },
  { id: 'fileformat', label: 'File Format' },
];

export function HelpView() {
  const contentRef = useRef<HTMLDivElement>(null);

  const scrollTo = useCallback((id: string) => {
    const el = document.getElementById(`help-${id}`);
    if (el) el.scrollIntoView({ behavior: 'smooth' });
  }, []);

  return (
    <div className={styles.helpLayout}>
      <nav className={styles.toc}>
        <div className={styles.tocTitle}>Contents</div>
        {sections.map(s => (
          <button key={s.id} className={styles.tocItem} onClick={() => scrollTo(s.id)}>
            {s.label}
          </button>
        ))}
      </nav>

      <div className={styles.content} ref={contentRef}>
        {/* ============================================================ */}
        <section id="help-intro" className={styles.section}>
          <h1 className={styles.h1}>GenesisCA</h1>
          <p className={styles.subtitle}>An IDE for Modeling and Simulating Cellular Automata</p>
          <p className={styles.p}>
            GenesisCA is a browser-based Integrated Development Environment for designing
            and simulating Cellular Automata (CA). It uses a Visual Programming Language
            (VPL) &mdash; a node-based graph editor &mdash; so you can create arbitrarily complex
            CA models without writing code.
          </p>
          <p className={styles.p}>
            The goals are <strong>accessibility</strong> (no programming required) and{' '}
            <strong>performance</strong> (grids up to 5000x5000 cells). Everything runs
            100% in your browser &mdash; no server and no sign-up &mdash; and it can be{' '}
            <strong>installed to run offline</strong> (see below).
          </p>
          <p className={styles.p}>
            Originally created as an undergraduate final project at the Universidade Federal
            de Pernambuco (UFPE, Brazil) in 2017, the application has been rewritten from
            scratch as a modern web application.
          </p>
          <p className={styles.p}>
            The source code is available on{' '}
            <a
              href="https://github.com/rff255/GenesisCA"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: '#4cc9f0' }}
            >
              GitHub
            </a>.
          </p>
        </section>

        {/* ============================================================ */}
        <section id="help-install" className={styles.section}>
          <h2 className={styles.h2}>Installing &amp; Working Offline</h2>
          <p className={styles.p}>
            GenesisCA is an installable <strong>Progressive Web App</strong>. In Chrome or
            Edge, click the navbar <strong>&#x2913; Install</strong> button (it appears when
            your browser offers installation) to add GenesisCA as a standalone desktop app
            &mdash; its own window and icon, no browser tabs or address bar.
          </p>
          <p className={styles.p}>
            Once visited, the app works <strong>fully offline</strong>: the interface, the
            Models Library list and previews, and the simulation engine are cached locally,
            so you can keep modeling and simulating with no connection. Library models are
            cached the first time you open them, and new versions are applied automatically
            the next time you open the app.
          </p>
          <p className={styles.p}>
            Your projects are never uploaded &mdash; saving still downloads a local
            .gcaproj / .gcastate file to your computer as before. Installing also asks the
            browser for <strong>durable storage</strong> so the offline cache isn&rsquo;t
            evicted under disk pressure. (Installing does not raise the memory ceiling for
            very large grids &mdash; and neither does the standalone desktop build downloadable
            from the project&rsquo;s Releases page: it wraps the same browser engine, so the limit
            is the same. It exists for offline / portable use, not more memory.)
          </p>
        </section>

        {/* ============================================================ */}
        <section id="help-fundamentals" className={styles.section}>
          <h2 className={styles.h2}>The 6 Fundamentals of GenesisCA Cellular Automata</h2>
          <p className={styles.p}>
            Every GenesisCA model is built on these theoretical properties:
          </p>
          <ol className={styles.list}>
            <li>
              <strong>Unlimited computing power</strong> &mdash; Each cell can perform
              any computation on its local data.
            </li>
            <li>
              <strong>N internal attributes</strong> &mdash; Each cell has multiple
              attributes (binary, integer, decimal) whose values at a given generation form
              its &quot;state.&quot;
            </li>
            <li>
              <strong>Neighborhood-limited access</strong> &mdash; A cell can only read
              the states of cells within a defined neighborhood (e.g., Moore, Von Neumann,
              or custom patterns).
            </li>
            <li>
              <strong>Writability</strong> &mdash; In synchronous (classic) mode, a cell
              can only modify its own attributes. In asynchronous mode, cells can also
              directly modify the attributes of neighboring cells, enabling movement
              and mass-conservation rules.
            </li>
            <li>
              <strong>Discrete space and time</strong> &mdash; Cells are arranged in a
              grid, and time advances in discrete generations.
            </li>
            <li>
              <strong>Synchronicity</strong> &mdash; The model can be either synchronous
              (all cells update simultaneously each generation &mdash; classic CA) or
              asynchronous (cells update sequentially, enabling number-conserving models).
              See the <em>Asynchronous Mode</em> section below for details.
            </li>
          </ol>
        </section>

        {/* ============================================================ */}
        <section id="help-modeler" className={styles.section}>
          <h2 className={styles.h2}>The Modeler</h2>
          <p className={styles.p}>
            The Modeler is where you design your CA model. It has a left sidebar with
            four panels, controlled by the activity bar icons (P, A, N, M), and a central
            area for the Visual Programming graph editor.
          </p>

          <h3 className={styles.h3}>Info Panel (I)</h3>
          <p className={styles.p}>
            The model&apos;s presentation metadata, kept in its own tab separate from the
            model&apos;s behavior: <strong>Name</strong>, <strong>Rule Author</strong>,{' '}
            <strong>GenesisCA Project Author</strong>, <strong>Summary</strong>,{' '}
            <strong>Rule Description</strong>, tags, and an optional <strong>Thumbnail</strong>.
          </p>
          <ul className={styles.list}>
            <li><strong>Rule Author</strong> &mdash; originator of the CA rule (domain expert/researcher).</li>
            <li><strong>GenesisCA Project Author</strong> &mdash; who built this particular GenesisCA project file.</li>
            <li><strong>Summary</strong> &mdash; a short blurb; this is what appears on the model&apos;s Models Library card.</li>
            <li><strong>Rule Description</strong> &mdash; a longer free-form field to elaborate on how the rule works and document anything else worth keeping. Not shown on Library cards.</li>
            <li><strong>Thumbnail</strong> (optional) &mdash; attach a PNG, JPEG, GIF, or WebP image (up to 2&nbsp;MB). It travels inside the <code>.gcaproj</code> file. When the model is shipped as part of the Models Library, hovering its card shows a floating preview; animated GIFs / WebPs play natively.</li>
          </ul>

          <h3 className={styles.h3}>Properties Panel (P)</h3>
          <p className={styles.p}>
            Configure the model&apos;s structure (grid width/height, boundary treatment:
            torus or constant), execution mode and compile target, optional{' '}
            <strong>End Conditions</strong> for the simulator, and the Indicators list.
          </p>
          <ul className={styles.list}>
            <li><strong>End Conditions</strong> (optional) &mdash; auto-pause the simulator when a max generation count is reached or when any indicator satisfies a configured comparison (==, !=, &gt;, &lt;, &ge;, &le;). Scalar indicators compare against their value directly. For <strong>linked-frequency</strong> indicators (which produce a map of category &rarr; count) pick the specific category to monitor; the comparison then applies to the count of that category (e.g. binary <em>alive</em> &mdash; category <code>true</code>, <code>&ge;</code>, <code>100</code> pauses when at least 100 cells are alive). Decimal-binned frequency indicators can&apos;t be used in end conditions because their bin boundaries depend on runtime data &mdash; switch the aggregation to Total instead. For conditions that need graph-level logic add a <strong>Stop Event</strong> node inside the update graph &mdash; its DO flow input pauses the simulation with a user-defined message.</li>
            <li><strong>Compile Target</strong> &mdash; choose the runtime backend the simulator uses to evolve cells. <strong>WebAssembly</strong> is the default and is recommended for most models &mdash; typically several times faster than JS on dense neighborhoods, full node coverage. <strong>WebGPU</strong> runs WGSL compute shaders on the GPU and is best for very large grids and math-heavy per-cell work; it requires synchronous mode and a browser with WebGPU support (Chrome 127+, Firefox 141+, Safari 17.4+). <strong>Debug / Reference (JS)</strong> compiles the graph to a plain JavaScript function &mdash; slower than WASM, but its source is readable in Show Code and useful for prototyping or verifying parity. Targets are mutually exclusive; switching restarts the simulator (grid state is lost). All three apply <em>value sinking</em>: per-cell value computations that are only consumed inside one switch case or if branch get emitted <em>inside</em> that branch, so cells in different states only pay for the work their branch needs. Sparse type-dispatch models (e.g. Wireworld with mostly Empty cells) get the biggest speedup from this. A side effect: if your model calls <em>Get Random</em> inside a branch, cells that don't enter that branch no longer advance the RNG &mdash; same seed will produce different output than older builds did.</li>
            <li><strong>WebGPU stop-check interval</strong> (advanced, WebGPU only) &mdash; Properties &rarr; Execution exposes an integer spinbox below the compile-target radio. It defaults to <code>1</code> &mdash; check the GPU stop flag after every step, exact stop-event timing. Higher values amortise the per-step <code>mapAsync</code> stall so big batches run faster, but a stop event firing at gen <em>n</em> may surface up to <em>K</em>&minus;1 generations later. The last step of every batch is always checked, so a stopped run never overshoots beyond the current play batch. JS and WASM ignore this setting.</li>
          </ul>

          <p className={styles.p}>
            <strong>Simulation state loading</strong> &mdash; Loading a saved state (either from an embedded project snapshot or a standalone <code>.gcastate</code> file) restores the grid <em>configuration</em> only: cell attributes, colors, model-attribute values, and simulator UI controls. The generation counter always resets to 0 and indicators re-initialise to their defaults. This way you can build a starting configuration over many generations, save it, and always start fresh from that state without inheriting the generation count you spent getting there.
          </p>

          <p className={styles.p}>
            <strong>Editing list items.</strong> In the Attributes (including its Local
            Variables section), Neighborhoods, and Mappings panels, selecting an item from
            the list opens its editor in a <strong>second panel</strong> beside the list &mdash; so you never scroll past a
            long list to reach the fields you are editing. Switch between items by clicking
            them in the list; close the editor with its &lsaquo; tab (this just clears the
            selection &mdash; it does not delete the item). Each panel remembers its own
            selection as you switch tabs.
          </p>

          <h3 className={styles.h3}>Attributes Panel (A)</h3>
          <p className={styles.p}>
            Define the data each cell carries. <strong>Cell Attributes</strong> are
            per-cell (e.g., &quot;alive&quot;, &quot;age&quot;).{' '}
            <strong>Model Attributes</strong> are global parameters all cells can read
            but not write (e.g., &quot;birth threshold&quot;). Each attribute has a type
            (binary, integer, decimal, tag, color), a default value, and a description.
          </p>
          <ul className={styles.list}>
            <li><strong>Tag</strong> &mdash; An integer with named values (picklist). Define tag options in the editor, and use the Tag Constant node to reference them by name.</li>
            <li><strong>Color</strong> (model attributes only) &mdash; An RGB color value. Accessed via Get Model Attribute with separate R, G, B output ports. Adjustable live in the simulator.</li>
            <li><strong>Boundary Value</strong> (cell attributes only, constant boundary) &mdash; the value held by out-of-grid cells. Shown next to Default Value only when the model&apos;s boundary treatment is <em>constant</em>. Leave blank to inherit the default.</li>
            <li>
              <strong>Sub-attribute</strong> (cell attributes only) &mdash; a cell
              attribute marked as &quot;only well-defined&quot; on cells whose
              parent attribute (a Tag or Binary cell attribute) is in a chosen
              set of values. For example, a <em>charge</em> attribute might be
              defined only on cells whose <em>state</em> is Wire / Pulsar /
              Switch. Reads on non-matching cells return the configured{' '}
              <strong>Undefined Value</strong>; in iteration contexts (Get
              Neighbors Attribute, Filter Neighbors, Aggregate, linked
              indicators) non-matching cells are <em>excluded entirely</em>{' '}
              &mdash; so &quot;count head-charges around me&quot; becomes one
              node instead of a manual filter-by-state chain. Writes proceed
              regardless of parent value, but storage at non-matching indices
              is invisible (reads always go through the parent-check guard).
              The compiler injects the guards automatically; no graph changes
              are needed. Supported on all three compile targets (JS, WASM,
              WebGPU) across every node in the catalogue. The only edge cases
              are Aggregate median and GroupOperator random on WebGPU &mdash;
              not because of sub-attributes, but because WebGPU doesn&apos;t
              implement those two ops at all; the worker falls back to JS for
              models that use them.
            </li>
          </ul>

          <h3 className={styles.h3}>Neighborhoods Panel (N)</h3>
          <p className={styles.p}>
            Define spatial neighborhoods &mdash; the set of relative cell positions a cell
            can &quot;see.&quot; Common patterns include Moore (8 surrounding cells) and
            Von Neumann (4 cardinal neighbors). Use the interactive grid to toggle neighbor
            positions; click the centre cell to include the cell itself in the neighborhood,
            so neighbor-iterating nodes count the cell among its own neighbors. Each
            neighborhood has its own margin setting (up to 50) that controls the grid editor
            size. Use the <strong>Duplicate</strong> button to clone an existing neighborhood
            for quick variations.
          </p>
          <p className={styles.p}>
            <strong>Drawing tools</strong> &mdash; the row of buttons above the grid speeds up
            big neighborhoods (MNCA-style radii and rings):
          </p>
          <ul className={styles.ul}>
            <li><strong>Point</strong> &mdash; the classic one-click-per-cell edit.</li>
            <li><strong>Circle</strong> &mdash; click the center cell, then a cell at the
              circle&apos;s edge: every cell within that distance (a filled disc) is edited.</li>
            <li><strong>Ring</strong> &mdash; click the center, then a cell at the inner
              radius, then one at the outer radius: cells between the two distances are edited.</li>
            <li><strong>Line</strong> &mdash; click two endpoints: every cell along the
              straight path between them is edited.</li>
          </ul>
          <p className={styles.p}>
            The second row fine-tunes what an edit does and how it repeats:
          </p>
          <ul className={styles.ul}>
            <li><strong>Mark / Unmark / Toggle</strong> &mdash; covered cells become active /
              become inactive / flip. Toggle is the classic behaviour (e.g. punch a hole in a
              disc by drawing a smaller circle inside it); Mark and Unmark are safe for
              repeated passes over mixed areas.</li>
            <li><strong>Symmetry (&harr;&nbsp;H / &varr;&nbsp;V / &#x2921;&nbsp;D / &#x2922;&nbsp;D2)</strong> &mdash;
              independent mirror toggles: every edit (any tool, including Point) also applies
              to its left&harr;right, top&harr;bottom, main-diagonal, and anti-diagonal mirror
              images. Combine them freely &mdash; any three together give the full 8-fold symmetry
              typical of MNCA neighborhoods, so you only ever draw one octant.</li>
          </ul>
          <p className={styles.p}>
            The cells an edit would touch preview live under the cursor, color-coded by
            outcome: cells that would <em>activate</em> show an accent tint, cells that
            would <em>deactivate</em> dim with a warm outline, and covered-but-unchanged
            cells show a faint outline &mdash; readable over both filled and empty cells.
            Shape anchor cells show a dashed outline; <strong>right-click cancels</strong> an
            in-progress shape. The centre cell is permanently ringed in the centre colour but
            otherwise fills like any other cell &mdash; covering it drives the
            include-central-cell flag according to the current mode.
          </p>

          <h3 className={styles.h3}>Mappings Panel (M)</h3>
          <p className={styles.p}>
            <strong>Attribute-to-Color</strong> mappings define how cell state is
            visualized (e.g., alive cells are blue). <strong>Color-to-Attribute</strong>
            mappings define how user interactions (brush painting, image imports) translate
            colors into cell state changes.
          </p>
          <h4 className={styles.h3}>Linked Output Mappings</h4>
          <p className={styles.p}>
            Each Attribute-to-Color mapping has a <strong>Color pass</strong> mode:
          </p>
          <ul className={styles.ul}>
            <li>
              <strong>Standalone</strong> &mdash; you build the color pass by hand in the
              graph (an Output Mapping event node feeding Set Cell Looks). This is the
              classic behavior.
            </li>
            <li>
              <strong>Linked</strong> &mdash; pick a cell attribute and GenesisCA
              auto-generates the color pass for you, no graph required:
              <strong> binary</strong> &rarr; two colors (default black/white),
              <strong> decimal</strong> and <strong>integer</strong> &rarr; a color scale
              spanning a user-set min/max &mdash; choose a palette preset (Viridis, Magma,
              Rainbow, Heat, Cividis, …) or customize the stops with the same gradient
              editor used by the Color Scale node, and <strong>tag</strong> &rarr; one
              distinct color per option. Every palette is fully recolorable; the min/max
              fields appear for decimal and integer attributes.
            </li>
          </ul>
          <p className={styles.p}>
            A Linked mapping is selectable as a simulator viewer immediately, with no nodes
            placed. If you <em>also</em> add an Output Mapping node for a linked mapping, the
            auto pass runs <strong>first</strong> as a background that colors every cell, then
            your graph runs and overrides only the cells it paints &mdash; useful for
            highlighting special cells or adding glyphs on top of an automatic gradient. The
            auto pass uses the same Color Scale (gradients) and Categorical Color (tags) nodes
            you can build by hand, and is lockstepped across the JS, WASM, and WebGPU
            compilers. Show Code displays the synthesized color-pass function.
          </p>

          <h3 className={styles.h3}>Indicators (Properties Panel)</h3>
          <p className={styles.p}>
            Indicators are quantitative variables that monitor CA evolution beyond visual
            feedback. They are defined in the <strong>Properties</strong> panel under the
            &quot;Indicators&quot; section &mdash; click an indicator in the list to edit it in a
            side panel (the same master-detail layout as Attributes, Neighborhoods, and Mappings).
            Two kinds exist:
          </p>
          <ul className={styles.list}>
            <li><strong>Standalone</strong> &mdash; Typed scalar values (binary, integer, decimal,
            or tag) that can be read and written by graph nodes (Get Indicator, Set Indicator,
            Update Indicator). They act as accumulators inside the step loop.</li>
            <li><strong>Linked</strong> &mdash; Automatically computed from an existing cell
            attribute after each step. The aggregation mode depends on the attribute type:
            Binary and Tag support Frequency (count per value); Integer and Decimal support
            Total (sum) or Frequency.</li>
          </ul>
          <p className={styles.p}>
            Each indicator has an <strong>Accumulation Mode</strong>: &quot;Per
            Generation&quot; resets every step, while &quot;Accumulated&quot; keeps a running
            total across generations (reset on simulator reset).
          </p>
          <p className={styles.p}>
            In the Simulator, the <strong>eye icon</strong> on linked indicators toggles
            whether the aggregation is computed. Unwatching a linked indicator removes its
            computation from the step loop, saving performance. For <strong>Accumulated</strong>
            linked indicators, unwatching means those generations are skipped in the running
            total. Standalone indicator eye icons are always active (disabled) because their
            computation is part of the user-defined update graph and cannot be separated.
          </p>
          <p className={styles.p}>
            Linked-frequency indicators (one line per category value) offer three
            visualisations &mdash; <strong>Bars</strong> (horizontal bar chart of the
            current generation), <strong>Lines</strong> (one coloured line per category
            showing each category&apos;s count over time), and <strong>Stack</strong>
            (filled areas stacked on top of each other). A small viz button in the
            indicator header cycles through the three; the preference is stored per
            indicator and persists across sessions.
          </p>
          <p className={styles.p}>
            In the <strong>Lines</strong>, <strong>Stack</strong>, and spatial{' '}
            (rows/columns chromatogram) views you can <strong>click a legend entry</strong>{' '}
            to hide that series (it dims and is struck through); click it again to bring it
            back. This is a per-session view
            toggle &mdash; handy when one dominant category flattens the rest &mdash; and
            is separate from <em>Track Categories</em> (which permanently changes what the
            indicator computes).
          </p>
          <p className={styles.p}>
            <strong>Track Categories.</strong> For Binary or Tag frequency indicators you can
            pick <em>which</em> category values to chart (a checklist in the indicator&apos;s
            settings). Leave everything checked to track all categories (the default), or
            choose a subset so a dominant category doesn&apos;t flatten the rest on the shared
            Y-axis &mdash; e.g. a cell-type chromatogram can chart just the two solutes and
            ignore the solvent / stationary phase. The choice applies to both the
            generation-axis and spatial (chromatogram) charts.
          </p>
          <p className={styles.p}>
            <strong>Spatial X-axis (chromatogram).</strong> A linked indicator&apos;s
            <strong> X Axis</strong> can be set to <strong>Rows</strong> or
            <strong> Columns</strong> instead of <strong>Generation</strong>. It then plots
            value <em>per grid position</em> &mdash; a live spatial histogram &mdash; rather
            than over time, drawing one curve per series (e.g. one curve per species for a
            tag attribute). This reproduces the chromatogram plots common in chemistry papers
            (cell population vs column position). Choose a <strong>Bin Mode</strong>:
            <strong> Slices</strong> divides the axis into a fixed number of equal bands
            (relative &mdash; survives grid resize), or <strong>Absolute</strong> uses a fixed
            number of rows/columns per band. The chart updates every step and is read from the
            current generation directly (it is not accumulated into a time history). Spatial
            indicators can&apos;t drive end conditions and have no Bars/Lines/Stack toggle
            (they are a single chart kind).
          </p>
          <p className={styles.p}>
            <strong>Chart settings (gear).</strong> Every indicator chart has a small
            <strong> &#9881;</strong> button in its header opening a popover with: fixed{' '}
            <strong>Y min</strong> / <strong>Y max</strong> (leave blank for the default
            dynamic scale that follows the data &mdash; each bound is independent),{' '}
            <strong>Y ticks</strong> (how many axis labels, 2&ndash;11), and a color picker
            per series. With a fixed axis the chart stops re-scaling as values evolve, so
            two runs are visually comparable; out-of-window samples are clipped. Changes made
            here are <em>simulator-side overrides</em>: they persist across sessions on your
            machine and are saved into the project only when you save with{' '}
            <strong>Simulator controls</strong> ticked. The same settings can be set as{' '}
            <em>model defaults</em> in the Modeler (Properties &rarr; Indicators &rarr;{' '}
            <strong>Chart Settings</strong>) &mdash; those travel with the <code>.gcaproj</code>{' '}
            always; the gear&apos;s overrides win where both are set, and{' '}
            <strong>Reset to model defaults</strong> clears the override layer.
          </p>

          <h3 className={styles.h3}>Variegated Cells &mdash; Directional Interactions (V)</h3>
          <p className={styles.p}>
            Opt-in feature for chemistry CA models where interactions depend on
            <em> which face of one cell meets which face of the other</em>. Examples: water
            molecules (H, lone pair, H, lone pair), amphiphiles (hydrophobic vs hydrophilic
            faces), chiral enantiomers. Enable via the <strong>Use Variegated Cells
            (Directional Interactions)</strong> checkbox in <strong>Properties &rsaquo;
            Execution</strong>. Models without this feature behave identically to before.
          </p>
          <p className={styles.p}>
            When enabled, the engine auto-allocates a per-cell <strong>orientation</strong>
            (0&ndash;3 = 0&deg;/90&deg;/180&deg;/270&deg; clockwise rotation), and the
            <strong> Variegated Cells</strong> panel (V) on the left sidebar lets you define:
          </p>
          <ul className={styles.list}>
            <li><strong>Variegation Source</strong> &mdash; a Tag cell attribute whose
              values identify cell &ldquo;species&rdquo; (e.g. Water, Amphiphile, Empty).</li>
            <li><strong>Face Label Palette</strong> &mdash; the labels you can place on
              cell faces (e.g. H, LP, X, Y). The implicit <em>none</em> label is reserved
              for unassigned slots and non-variegated neighbors.</li>
            <li><strong>Face Patterns</strong> &mdash; named 8-slot layouts
              (N/NE/E/SE/S/SW/W/NW). Edges-only mode disables the four corner slots.
              Assign a pattern to each tag option in the Attributes panel.</li>
          </ul>
          <p className={styles.p}>
            The <strong>Lookup Table</strong> model-attribute type stores a (possibly
            rectangular) matrix of decimal values. Each axis has an independent <em>key
            source</em> &mdash; a face-label palette, a tag attribute, or{' '}
            <strong>Single value (map)</strong> &mdash; so a table can be keyed by faces
            (e.g. analyte&nbsp;&times;&nbsp;CD faces) or by cell type (e.g.
            empty/water/amphi). Choosing <em>Single value</em> for one axis collapses the
            table into a 1-D <strong>map</strong>: a single column (or row) of decimal values keyed
            only by the other axis&apos;s tag &mdash; no need to invent a throwaway
            single-option tag attribute. A pure tag&times;tag table needs no faces, so it
            works even with Variegated Cells off. Live-tuneable in the simulator like any
            other model attribute (matrix shown directly under the attribute name).
          </p>
          <p className={styles.p}>
            You can define multiple face-label <strong>palettes</strong> in the Variegated
            Cells panel; each face pattern draws its slot labels from one palette.
          </p>
          <p className={styles.p}>
            Several new node types become available when Variegated Cells is enabled (hidden
            from the palette otherwise). All run on JS, WASM, and WebGPU &mdash; only the
            async-only nodes below (the two orientation writers and Transfer Cell Attributes to
            Neighbor) are unavailable on WebGPU (which is synchronous-only):
          </p>
          <ul className={styles.list}>
            <li><strong>Get Orientation</strong> / <strong>Set Orientation</strong> &mdash;
              read / write the current cell&apos;s orientation (0&ndash;3; the setter wraps
              via <code>&amp; 3</code>).</li>
            <li><strong>Get Facing Orientation</strong> &mdash; reads the orientation of the
              neighbour touching this cell in a fixed direction (N/E/S/W/diagonals); does not
              use a neighborhood.</li>
            <li><strong>Get Neighbor Orientation By Index</strong> &mdash; reads a
              neighbor&apos;s orientation by NeighborIndex (read-only, works in sync + async).</li>
            <li><strong>Set Facing Orientation</strong> / <strong>Set Neighbor Orientation
              By Index</strong> &mdash; write a neighbour&apos;s orientation. <em>Async-only</em>
              (sync mode would have the post-step copy overwrite the write).</li>
            <li><strong>Get Facing Labels</strong> &mdash; resolves the two face labels
              touching at a 1-step encounter in a fixed direction, accounting for both
              cells&apos; orientations and face patterns. Outputs <em>My Face</em> and
              <em>Their Face</em>; pipe these into Table Lookup.</li>
            <li><strong>Get All Facing Labels</strong> &mdash; two parallel arrays of face
              labels at each neighbour encounter (8-slot Moore, or 4-slot cardinal with
              &quot;Cardinals only&quot;). Pair with Aggregate or For Each In Array.</li>
            <li><strong>Table Lookup</strong> &mdash; indexes a Lookup Table model attribute
              by a row index and a column index &rarr; decimal. (Indices come from face labels
              or tag reads, depending on the table&apos;s key sources.)</li>
            <li><strong>Table Map</strong> &mdash; vectorised Table Lookup over two parallel
              index arrays &rarr; decimal array (pair with Aggregate&nbsp;&times;&nbsp;product
              for a break-probability product).</li>
            <li><strong>Transfer Cell Attributes to Neighbor</strong> &mdash; copy/move/swap
              the current values of chosen cell attributes (and optionally orientation)
              between this cell and a target neighbour. Operation: Copy&nbsp;To, Copy&nbsp;From,
              or Swap; for the copy operations the source cell can be left untouched or reset
              to defaults. Async-only; the chemistry move-into-empty idiom is Copy&nbsp;To +
              Defaults.</li>
          </ul>
          <p className={styles.p}>
            For procedural initial-state setup, see <strong>Init Event</strong> below.
          </p>

          <h3 className={styles.h3}>Init Event Node</h3>
          <p className={styles.p}>
            New event entry-point that runs <em>once per cell on simulator Reset only</em>
            (not on Randomize, not on Load State). Useful for procedural initial state:
            gradients, deterministic noise, ID-encoded debug values. With Variegated Cells
            enabled, the typical pattern is to wire <code>GetRandom(int, 0, 3)</code> into
            <code>SetOrientation</code> so each cell starts with a random rotation.
          </p>
          <p className={styles.p}>
            Init Event is a <strong>singleton</strong> (one per model, like the Generation
            Step) and outputs the current cell&apos;s coordinates: <code>x</code>,
            <code>y</code>, <code>maxX</code> (= W&minus;1), <code>maxY</code> (= H&minus;1).
            Trigger downstream initialization via its <code>DO</code> flow port.
          </p>

          <h3 className={styles.h3}>Local Variables</h3>
          <p className={styles.p}>
            <strong>Local Variables</strong> are per-cell mutable scratch storage you
            reference by name across the graph. They let you write rules as imperative
            pseudocode &mdash; &quot;for each direction <em>d</em>, set
            <code>weights[d] = compute(d)</code>; then sample by weights&quot; &mdash; instead
            of unrolling the same dataflow once per case. Define them in the
            <strong> Attributes</strong> panel&apos;s Local Variables section (name, kind,
            data type, length, initial value).
          </p>
          <ul className={styles.list}>
            <li><strong>Lifetime</strong> &mdash; per-cell, per-step. Each cell starts with a
              fresh copy reset to the initial value; nothing carries across cells or across
              generations. Treat it as scratch for one cell&apos;s computation.</li>
            <li><strong>Kinds</strong> &mdash; <em>scalar</em> (a single value) or
              <em>array</em> (fixed length, all elements reset to the initial value). Data
              type is binary / integer / decimal / tag.</li>
            <li><strong>Get Variable</strong> &mdash; reads the current value (scalar) or the
              underlying array (array variables &mdash; iterate it like any array source:
              Aggregate, Group Reduce, Get Array Element, For Each In Array).</li>
            <li><strong>Set Variable</strong> &mdash; assigns to a scalar variable.</li>
            <li><strong>Set Array Element</strong> &mdash; writes <code>variable[index] =
              value</code> into an array variable (out-of-range writes are silently skipped).</li>
          </ul>
          <p className={styles.p}>
            Local Variables run on all three compile targets (JS, WASM, WebGPU). The typical
            pattern pairs them with <strong>For Each In Array</strong>: loop over the
            neighbour directions, write a per-direction <code>weights[index]</code>, then
            after the loop reduce with Aggregate and sample with Group Reduce&apos;s
            <em> Weighted Random</em> op.
          </p>

          <h3 className={styles.h3}>The Graph Editor</h3>
          <p className={styles.p}>
            The central area is a node-based visual programming editor. You connect nodes
            to define what each cell computes per generation. The graph is compiled to one
            of three targets &mdash; WebAssembly (default), WebGPU, or JavaScript &mdash;
            and runs 25+ million times per generation at large grid sizes.
          </p>
          <p className={styles.p}>
            <strong>Value ports</strong> (blue circles) carry data. <strong>Flow
            ports</strong> (green right-pointing triangles, Unreal-blueprint style)
            control execution order &mdash; they point in the direction execution
            flows. Each node's main execution-in and execution-out pins sit at the
            centre of its header (a horizontal through-line); branch flow pins
            (THEN/ELSE/BODY/CASE&hellip;) and data ports hang in the body below.
          </p>

          <h3 className={styles.h3}>Canvas Controls</h3>
          <ul className={styles.list}>
            <li><strong>Right-click drag</strong> &mdash; Pan the canvas (works anywhere, including over edges, nodes, and group bodies).</li>
            <li><strong>Scroll wheel</strong> &mdash; Zoom in/out.</li>
            <li><strong>Left-click drag</strong> (on empty area) &mdash; Box select nodes.</li>
            <li><strong>Left-click drag</strong> (on node) &mdash; Move node.</li>
            <li><strong>Ctrl + left-click drag</strong> (on node, comment, or group) &mdash; <strong>Align while dragging</strong>. Hold <kbd className={styles.kbd}>Ctrl</kbd> (or <kbd className={styles.kbd}>Cmd</kbd>) and the moving element snaps so its edges or center line up with nearby nodes, with dashed guide lines showing the match (PowerPoint-style). Works for a single node, a multi-selection (the selection's outer box aligns), and groups. While held it overrides snap-to-grid; release <kbd className={styles.kbd}>Ctrl</kbd> for free movement.</li>
            <li><strong>Ctrl + click</strong> &mdash; Add/remove from selection.</li>
            <li><strong>Right-click</strong> (on canvas) &mdash; Opens the add-node menu: the actions (Paste, Add Comment, Add Group, Import Macro&hellip;) on top, then a <strong>focused search box</strong> and a category-grouped node list. Type to filter, move the highlighted entry with <kbd className={styles.kbd}>&uarr;</kbd>/<kbd className={styles.kbd}>&darr;</kbd>, and press <kbd className={styles.kbd}>Enter</kbd> to add it at the click position. It's the same menu <kbd className={styles.kbd}>Space</kbd> opens at the cursor. The menu closes as soon as you press or start dragging anywhere outside it (e.g. to box-select or pan).</li>
            <li><strong>Right-click</strong> (on node) &mdash; Node options: Rename, Duplicate, Copy, Cut, Delete. On macros, Duplicate expands into a submenu (<strong>Duplicate Independent</strong> / <strong>Duplicate Linked</strong>), and they also show Enter Macro, Export Macro, and Undo Macro &mdash; plus a count badge for making linked copies independent.</li>
            <li><strong>Right-click</strong> (on selection) &mdash; Selection options: Duplicate, Copy, Cut, Paste, Create Macro, Create Group, <strong>Align</strong> (horizontally: left/center/right; vertically: top/center/bottom) and <strong>Distribute</strong> (horizontally/vertically &mdash; keeps the leftmost/topmost in place and evens out the gaps).</li>
            <li><strong>Right-click</strong> (on group) &mdash; Group options: Rename, Undo Group, Delete.</li>
            <li><strong>Drag from Palette</strong> &mdash; Drop a node or macro from the right-side Palette tab onto the canvas to add it at the drop position.</li>
            <li><strong>Drag from a panel</strong> (Attributes, Local Variables, Neighborhoods, Mappings, Indicators) &mdash; Drop a model element onto the canvas to spawn a menu of related nodes pre-configured with that element. Drop directly onto a compatible port to auto-connect: when only one node type would fit, it is created and wired without a menu. The new node is positioned so its connecting port aligns with the target.</li>
            <li><strong>Drag a wire onto empty canvas</strong> &mdash; Drag from any port and release on the background to open a menu of nodes that can connect there. The menu has a <strong>focused search box</strong>: type to filter the compatible list, move the highlighted entry with <kbd className={styles.kbd}>&uarr;</kbd>/<kbd className={styles.kbd}>&darr;</kbd>, and press <kbd className={styles.kbd}>Enter</kbd> to add the highlighted node at the release point and auto-wire it. So you can drag a port, type a few keywords, and hit Enter without ever touching the mouse again. (Dragging from an output also offers <strong>Reroute</strong> as the first entry.) <kbd className={styles.kbd}>Esc</kbd> dismisses.</li>
          </ul>

          <h3 className={styles.h3}>Chaining Actions (NEXT / DONE)</h3>
          <p className={styles.p}>
            Every action node (Set Attribute, Set Variable, Set Cell Looks, &hellip;) has a
            pass-through <strong>NEXT</strong> flow output, so executions chain
            Blueprints-style &mdash; <em>Set A &rarr; Set B &rarr; Set C</em> reads
            left-to-right instead of fanning three wires out of one DO port (which still
            works; order is then the wiring order). A chained node runs immediately after
            the previous one. Flow-control nodes (If, Loop, For Each, Switch) have a{' '}
            <strong>DONE</strong> output instead, which fires after the whole construct
            completes &mdash; after either branch of an If (or none), after all Loop /
            For&nbsp;Each iterations, after the matching Switch case(s). Chaining has zero
            runtime cost: it compiles to exactly the same code as the equivalent fan-out.
            Sequence keeps its numbered THEN pins and has no DONE.
          </p>

          <h3 className={styles.h3}>Palette &amp; Node Explorer</h3>
          <p className={styles.p}>
            Open the right sidebar icons:
          </p>
          <ul className={styles.list}>
            <li><strong>Palette</strong> &mdash; Browse all node types (grouped by category) plus
              default macros shipped with the app (from <code>public/macros/*.gcamacro</code>) and
              the current project's macros. Drag any item onto the canvas to add it.
              The panel splits vertically into two independently-scrolling sections &mdash;
              <strong>Nodes</strong> on top, <strong>Macros</strong> on the bottom &mdash;
              with a draggable horizontal splitter between them. A <strong>List / Visual</strong>
              toggle in the header switches the renderer between a compact text list and
              draggable mini node previews that mirror the node visuals; both modes drag
              identically. Both the split position and the view mode are remembered across sessions.</li>
            <li><strong>Quick add</strong> (<kbd className={styles.kbd}>Space</kbd>) &mdash; Press
              Space over the canvas to open the add-node menu <em>right at the cursor</em> with its
              search focused (the same menu as a blank-canvas right-click, and the same searchable
              list you get by dragging a wire onto empty canvas). Type to filter, move the
              highlighted item with <kbd className={styles.kbd}>&uarr;</kbd>/<kbd className={styles.kbd}>&darr;</kbd>,
              then press <kbd className={styles.kbd}>Enter</kbd> to add it where the cursor was.
              There is always one highlighted item (the best name match for what you typed), so
              <em> Space &rarr; type &rarr; Enter</em> adds the obvious pick without touching the
              arrow keys. <kbd className={styles.kbd}>Esc</kbd> closes the menu. (This no longer
              opens the Palette panel &mdash; open that from the right sidebar when you want to browse.)</li>
            <li><strong>Node Explorer</strong> (<kbd className={styles.kbd}>Ctrl</kbd>+<kbd className={styles.kbd}>F</kbd>) &mdash; Search and jump to nodes
              already placed in your graph.</li>
          </ul>

          <h3 className={styles.h3}>Incomplete Node Warnings</h3>
          <p className={styles.p}>
            Nodes with required parameters that are not yet set (e.g., a <em>Set Attribute</em>
            node without an attribute selected) show a small amber <strong>!</strong> badge in their
            top-right corner. Hover it to see exactly what needs configuration.
          </p>
          <p className={styles.p}>
            <strong>Macro instances bubble up internal warnings:</strong> if any node inside the
            macro (or inside a nested macro) has a configuration warning, the macro instance
            itself also shows the badge with a tooltip like &quot;3 internal warnings (expand
            macro to see)&quot;. This makes misconfigured internals visible without having to
            open the macro first.
          </p>

          <h3 className={styles.h3}>Node Collapse &amp; Expand</h3>
          <p className={styles.p}>
            <strong>Double-click</strong> any non-macro node to collapse it into a compact
            form showing only its title (or value for constants). Double-click again to expand.
            Edges remain connected to collapsed nodes. When dragging a new connection near
            a collapsed node that has more than one compatible port, it temporarily expands
            so you can pick which port to land on; if only one port could accept the wire it
            stays compact and the connection drops straight onto it.
          </p>

          <h3 className={styles.h3}>Comment Nodes</h3>
          <p className={styles.p}>
            Add free-floating comments to document parts of the graph via the right-click
            <strong> Add Comment</strong> action. When a comment is selected you can drag
            its corner to resize it (the size persists across saves) and click the color
            swatch in the top-right corner to change its background color.
          </p>

          <h3 className={styles.h3}>Reroute Points</h3>
          <p className={styles.p}>
            A <strong>reroute</strong> is a small movable dot you place on a wire to
            bend it around other nodes &mdash; and to fan one output out to many places
            without long crossing wires. To create one, <strong>press and hold</strong>
            the left mouse button on a wire for about half a second: a reroute appears and
            then follows your cursor until you release. Once placed, a reroute is an
            ordinary node &mdash; <strong>drag it to move it</strong>, and it moves along
            with a multi-selection just like any other node. You can also drag a wire off
            an output port, release on empty canvas, and pick
            <strong>&quot;Reroute&quot;</strong> from the menu.
          </p>
          <p className={styles.p}>
            A reroute always carries an <strong>output</strong>, so it has one input
            (the wire feeding it) and as many outputs as you like &mdash; drag from it to
            send the same value to several nodes. You can also chain reroutes
            (<em>wire &rarr; reroute &rarr; reroute &rarr; node</em>) to route around large
            areas. Reroutes are purely cosmetic: they have <strong>no effect</strong> on
            the simulation &mdash; a wire through a reroute behaves exactly like a direct
            connection. Deleting a reroute removes it and all of its links.
          </p>

          <h3 className={styles.h3}>Inline Port Widgets</h3>
          <p className={styles.p}>
            Input ports on many nodes (Math, Compare, Logic, Loop, Set Attribute, Set Color
            Viewer) have small inline value editors that appear to the left of the port when
            it is not connected. This lets you set constant values directly without needing
            a separate Constant node. When you connect a wire to the port, the inline widget
            disappears and the connected value takes over.
          </p>

          <h3 className={styles.h3}>Groups</h3>
          <p className={styles.p}>
            Select 2+ nodes and right-click &rarr; &quot;Create Group&quot; to visually
            organize them. Groups have a draggable header with a label and color picker.
            Right-click a group and choose &quot;Undo Group&quot; to dissolve it (all
            contained nodes are selected for easy repositioning).
          </p>
          <ul className={styles.list}>
            <li><strong>Drag the header strip</strong> to move the whole group (with its
              contents).</li>
            <li><strong>Drag on the body</strong> to box-select the inner nodes (without
              moving the group); <strong>click the body</strong> to select the group itself.</li>
            <li>A selected group <strong>stays behind</strong> its contained nodes (it does
              not pop to the front), so you can keep clicking the nodes and links inside it.</li>
            <li><strong>Right-click-drag the body</strong> pans the canvas, just like
              empty space.</li>
            <li>Box-select supports modifiers: <strong>Shift</strong> adds to the current
              selection, <strong>Ctrl/Cmd</strong> removes from it, no modifier replaces it.</li>
            <li><strong>Double-click the header label</strong> to rename it inline.</li>
          </ul>
          <p className={styles.p}>
            The graph <strong>minimap</strong> (bottom-right) is interactive: drag to pan,
            scroll to zoom, and click anywhere to jump the viewport to that spot (keeping the
            current zoom).
          </p>
        </section>

        {/* ============================================================ */}
        <section id="help-nodes" className={styles.section}>
          <h2 className={styles.h2}>Node Types Reference</h2>
          <p className={styles.p}>
            GenesisCA provides around 70 node types organized into the categories below.
            The palette only shows the ones available for your model &mdash; async-only and
            Variegated-Cells nodes are hidden until you enable those features.
          </p>

          <h3 className={styles.h3}>
            <span className={styles.nodeCategory} style={{ background: '#2e7d32' }}>Event</span>
            Event Entry Points
          </h3>
          <table className={styles.table}>
            <thead><tr><th>Node</th><th>Description</th></tr></thead>
            <tbody>
              <tr><td>Generation Step</td><td>Entry point for per-generation cell update logic. Connect &quot;DO&quot; to start the flow chain. Singleton.</td></tr>
              <tr><td>Init Event</td><td>Runs once per cell on simulator <strong>Reset</strong> (after defaults, before the first color pass; not on Randomize or Load State). Outputs <code>x</code>, <code>y</code>, <code>maxX</code>, <code>maxY</code>. Singleton. Useful for procedural initial state (gradients, noise, random orientations).</td></tr>
              <tr><td>Input Mapping (C&rarr;A)</td><td>Entry point for Color-to-Attribute mapping (brush/image import). Outputs R, G, B values.</td></tr>
              <tr><td>Output Mapping (A&rarr;C)</td><td>Entry point for Attribute-to-Color visualization. Runs as a separate sequential pass after the Generation Step, ensuring colors reflect the final cell state. A mapping can instead be marked <strong>Linked</strong> in the Mappings panel (pick an attribute and the color pass is auto-generated &mdash; see &ldquo;Linked Output Mappings&rdquo; below); if you also add this node for a linked mapping, the auto pass runs first as a background and your graph overrides the cells it paints.</td></tr>
              <tr><td>Stop Event</td><td>Terminates the simulation run with a user-defined message when its DO flow input fires. Use for end conditions that need graph-level logic (complex spatial patterns, multi-attribute combinations). The text widget on the node body holds the message. First triggered stop in a step wins.</td></tr>
            </tbody>
          </table>

          <h3 className={styles.h3}>
            <span className={styles.nodeCategory} style={{ background: '#1b5e20' }}>Flow</span>
            Control Flow
          </h3>
          <table className={styles.table}>
            <thead><tr><th>Node</th><th>Description</th></tr></thead>
            <tbody>
              <tr><td>Conditional</td><td>If/else branching based on a binary (true/false) condition.</td></tr>
              <tr><td>Sequence</td><td>Execute &quot;First&quot; then &quot;Then&quot; sequentially.</td></tr>
              <tr><td>Loop</td><td>Repeat &quot;Body&quot; a given number of times.</td></tr>
              <tr><td>Switch</td><td>Route flow to multiple cases. Two modes: <strong>By Conditions</strong> (wire binary inputs per case) or <strong>By Value</strong> (compare a value against per-case thresholds with ==, !=, &gt;, &lt;, &gt;=, &lt;= operators, or match tag options). The By Value type can be Integer, Decimal, Tag, or <strong>Neighbor Index</strong> &mdash; for Neighbor Index each case takes a wired NI value and matching is equality. A &quot;First match only&quot; toggle controls whether only the first matching case fires or all matches execute.</td></tr>
            </tbody>
          </table>

          <h3 className={styles.h3}>
            <span className={styles.nodeCategory} style={{ background: '#0d47a1' }}>Data</span>
            Data Sources
          </h3>
          <table className={styles.table}>
            <thead><tr><th>Node</th><th>Description</th></tr></thead>
            <tbody>
              <tr><td>Get Cell Attribute</td><td>Read the current cell&apos;s attribute value (e.g., &quot;alive&quot;).</td></tr>
              <tr><td>Get Cell Position</td><td>Outputs the current cell&apos;s grid coordinates &mdash; <strong>Row</strong>, <strong>Col</strong>, and (in 3D) <strong>Layer</strong>. A controlled, own-cell-only break of locality so a cell can behave by where it is: spatial gradients, region-specific rules, or a coordinate-aware Output Mapping. Works in every event.</td></tr>
              <tr><td>Get Model Attribute</td><td>Read a global model parameter.</td></tr>
              <tr><td>Get Neighbors Attribute</td><td>Collect an attribute from all neighbors as an array.</td></tr>
              <tr><td>Get Neighbor Attr By Index</td><td>Read a cell attribute from ONE specific neighbor by index. Works in both sync and async modes.</td></tr>
              <tr><td>Get Neighbor Attr By Tag</td><td>Read a cell attribute from a specific neighbor identified by a named tag (defined in the Neighborhoods panel). The tag is resolved to an index at compile time.</td></tr>
              <tr><td>Get Neighbor Indexes By Tags</td><td>Select multiple neighborhood cells by their tag names and output an array of indices. Use with &quot;Get Neighbors Attr By Indexes&quot; for tag-based multi-neighbor access.</td></tr>
              <tr><td>Get Neighbors Attr By Indexes</td><td>Read attributes from a subset of neighbors specified by an array of indices.</td></tr>
              <tr><td>Get Constant</td><td>A fixed value: binary, integer, decimal, tag, orientation, or <em>face label</em> (the last only when Variegated Cells is enabled &mdash; emits the compile-time index of the named face label, with implicit <code>none</code> = 0).</td></tr>
              <tr><td>Get Random</td><td>Generate a random value (binary, integer, decimal, or Options). In Binary mode, an input port &quot;P&quot; (probability 0&ndash;1) controls the chance of producing 1 (default 0.5 = 50%). In Options mode, wire one or more values to the &quot;Options&quot; array input (multi-scalar OR a single array source like Filter Neighbors / Get All Neighbor Indexes / Get Neighbors Attribute) and the node picks one uniformly; the &quot;Fallback&quot; inline value is returned when the array is empty.</td></tr>
            </tbody>
          </table>

          <h3 className={styles.h3}>
            <span className={styles.nodeCategory} style={{ background: '#e65100' }}>Logic</span>
            Arithmetic &amp; Logic
          </h3>
          <table className={styles.table}>
            <thead><tr><th>Node</th><th>Description</th></tr></thead>
            <tbody>
              <tr><td>Arithmetic Operator (Math)</td><td>+, -, *, /, %, sqrt, pow, abs, max, min, mean, exp, log (natural), sin, cos, tan, tanh.</td></tr>
              <tr><td>Expression</td><td>Type a math <strong>formula</strong> in a text field instead of wiring up many Math nodes &mdash; ideal for equation-heavy models. Operators <code>+ - * / % ^</code> and functions <code>sqrt abs floor ceil round min max pow mod exp log sin cos tan tanh</code> (<code>log</code> = natural log), plus the constants <code>pi</code> and <code>e</code>. Variables come from the input ports: add 1&ndash;8 ports with the <strong>+</strong> / <strong>&minus;</strong> buttons, give each a name, then reference those names in the formula (e.g. <em>u + Du*lap - u*v*v</em>). Compiles on all three targets (JS, WASM, WebGPU).</td></tr>
              <tr><td>Proportion Map</td><td>Remap a value from one range to another: <em>output = outMin + curve(t) * (outMax - outMin)</em> with <em>t = (x - inMin) / (inMax - inMin)</em>. Has 5 inputs (X, In Min, In Max, Out Min, Out Max) plus a <strong>curve</strong> dropdown: Linear, Smoothstep, Ease-In Quadratic, Ease-Out Quadratic, Exponential, Logarithmic. Linear keeps un-clamped extrapolation; non-linear curves clamp t to [0, 1].</td></tr>
              <tr><td>Interpolate</td><td>Linear interpolation: output = min + t * (max - min). Inputs: T (0&ndash;1), Min, Max.</td></tr>
              <tr><td>Compare (Statement)</td><td>Comparison operators: ==, !=, &gt;, &lt;, &gt;=, &lt;=, <strong>Between</strong>, and <strong>Not Between</strong>. The between-family ops reveal a Y&#8322; input and two picklists for the lower (&gt;= or &gt;) and upper (&lt;= or &lt;) interval sides; <em>Not Between</em> fires when the value is outside the interval. A <strong>type selector</strong> (Numerical / Binary / Tag / Neighbor Index) swaps the inline operand widgets &mdash; pick <em>Tag</em> and a tag-attribute picker appears so you can compare against a tag option without a Get Constant node (non-numerical types are equality-only). Replaces the common Compare + Compare + AND chain.</td></tr>
              <tr><td>Logic Operator</td><td>AND, OR, XOR, NOT on binary values.</td></tr>
              <tr><td>Value Switch</td><td>Ternary value selector: outputs <em>If</em> when <em>Condition</em> is truthy, else <em>Else</em>. Pure value &mdash; no flow port, so it stays inline in the graph. Both inputs always evaluate; use a flow Conditional for short-circuit. Also works as a <em>conditional array selector</em>: wire two array producers (e.g. Filter Neighbors) into <em>If</em>/<em>Else</em> and the chosen array flows out of <em>Result</em> &mdash; handy for &ldquo;pick a random neighbour from set A or set B&rdquo;.</td></tr>
            </tbody>
          </table>

          <h3 className={styles.h3}>
            <span className={styles.nodeCategory} style={{ background: '#6a1b9a' }}>Aggregation</span>
            Neighbor Aggregation
          </h3>
          <table className={styles.table}>
            <thead><tr><th>Node</th><th>Description</th></tr></thead>
            <tbody>
              <tr><td>Group Counting</td><td>Count neighbors matching a condition (equals, not equals, greater, lesser). Also supports <strong>Between</strong> and <strong>Not Between</strong> for interval counts &mdash; reveals a Compare High input and two picklists for the interval sides; <em>Not Between</em> counts elements outside the interval.</td></tr>
              <tr><td>Group Statement</td><td>Check if all/none/any neighbors satisfy a condition.</td></tr>
              <tr><td>Group Operator</td><td>Reduce an array: sum, product, max, min, mean, median, AND, OR, pick <em>random</em>, or <em>weighted random</em>. Min/max/random/weighted-random also output the picked <em>position</em>. <em>Weighted Random</em> treats the array as weights and returns the picked weight + index (empty/zero-sum &rarr; index &minus;1); always advances the RNG. (Median and uniform random are JS/WASM-only &mdash; rejected on WebGPU.)</td></tr>
              <tr><td>Aggregate</td><td>Accepts multiple value connections on a single input port. Operations: Sum, Product, Max, Min, Average, Median. Use to combine values from different sources without needing arrays.</td></tr>
            </tbody>
          </table>

          <h3 className={styles.h3}>
            <span className={styles.nodeCategory} style={{ background: '#b71c1c' }}>Output</span>
            Output
          </h3>
          <table className={styles.table}>
            <thead><tr><th>Node</th><th>Description</th></tr></thead>
            <tbody>
              <tr><td>Set Attribute</td><td>Write a value to the current cell&apos;s attribute for the next generation.</td></tr>
              <tr><td>Set Neighborhood Attribute</td><td><strong>(Async only)</strong> Set a cell attribute for ALL cells in a neighborhood to a given value.</td></tr>
              <tr><td>Set Neighbor Attr By Index</td><td><strong>(Async only)</strong> Set a cell attribute for ONE specific neighbor (by index 0..N&minus;1) to a given value.</td></tr>
              <tr><td>Mark Cell Updated</td><td><strong>(Async only)</strong> Mark a neighbor cell (by NeighborIndex) as already-updated for the rest of this generation, so the async scheduler skips it on subsequent visits. Accepts a single NI or an NI array (loops). Lets &quot;movement&quot; rules (gas particles, chemistry CA) guarantee a piece of state only moves once per step, even if it would otherwise land on a cell that comes later in the random update order.</td></tr>
            </tbody>
          </table>

          <h3 className={styles.h3}>
            <span className={styles.nodeCategory} style={{ background: '#00695c' }}>Color</span>
            Color I/O
          </h3>
          <table className={styles.table}>
            <thead><tr><th>Node</th><th>Description</th></tr></thead>
            <tbody>
              <tr><td>Set Cell Looks</td><td>Sets the current cell&apos;s appearance for an Attribute-to-Color visualization. <strong>Plain mode</strong>: write R/G/B for a flat cell color. <strong>Use glyph</strong>: overlay a Unicode character (with an inline glyph picker) in its own glyph color, plus an optional <strong>background color</strong> (shown at every zoom, behind the glyph) and an optional <strong>glyph color when zoomed out</strong> (paints each glyphed cell with its glyph color once cells are too small to draw the character &mdash; configurable via <code>genesisca_sim_settings.glyphMinPx</code>, default 6 px). Cells with glyph=0 render no character. Pick a specific mapping, or choose <strong>Current Simulator Selected</strong> to write to whichever viewer is active. (Merges the former Set Color Viewer + Set Cell Glyph.)</td></tr>
              <tr><td>Get Color Constant</td><td>Output fixed R, G, B values.</td></tr>
              <tr><td>Color Interpolate</td><td>Interpolate between two colors. Inputs: interpolation point T (0&ndash;1), From R/G/B, To R/G/B. Outputs: R, G, B. The <strong>curve</strong> dropdown controls the interpolation shape: Linear, Smoothstep, Ease-In Quadratic, Ease-Out Quadratic, Exponential, Logarithmic. Includes color picker widgets for &quot;Color From&quot; and &quot;Color To&quot; when the per-channel ports are not connected.</td></tr>
              <tr><td>Categorical Color</td><td>Map an integer <strong>Index</strong> to a flat RGB color from an editable N-entry palette &mdash; <em>discrete</em>, with no blending between entries (contrast Color Scale, which interpolates). Index <code>i</code> selects palette entry <code>i</code>; out-of-range indices use the default color. Outputs R, G, B. Used internally by Linked Output Mappings for tag attributes, and available as a node for hand-built graphs.</td></tr>
            </tbody>
          </table>

          <h3 className={styles.h3}>
            Indicators
          </h3>
          <table className={styles.table}>
            <thead><tr><th>Node</th><th>Description</th></tr></thead>
            <tbody>
              <tr><td>Get Indicator</td><td>Read the current value of a standalone indicator.</td></tr>
              <tr><td>Set Indicator</td><td>Set a standalone indicator to a specific value.</td></tr>
              <tr><td>Update Indicator</td><td>Modify a standalone indicator based on its current value and an input (increment, decrement, max, min, toggle, OR, AND, next, previous).</td></tr>
            </tbody>
          </table>
        </section>

        {/* ============================================================ */}
        <section id="help-macros" className={styles.section}>
          <h2 className={styles.h2}>The Macro System</h2>
          <p className={styles.p}>
            Macros let you encapsulate a group of nodes into a reusable subgraph.
          </p>

          <h3 className={styles.h3}>Creating a Macro</h3>
          <ol className={styles.list}>
            <li>Select 2+ nodes by dragging a box or Ctrl+clicking.</li>
            <li>Right-click the selection and choose &quot;Create Macro.&quot;</li>
            <li>The selected nodes are replaced by a single Macro node with automatically detected input/output ports.</li>
          </ol>

          <h3 className={styles.h3}>Editing a Macro</h3>
          <p className={styles.p}>
            Double-click a Macro node to enter its subgraph. You&apos;ll see teal
            <strong> Macro Input</strong> and <strong>Macro Output</strong> boundary
            nodes. Add, remove, or rename ports on these to modify the macro&apos;s
            external interface. Use the breadcrumb bar at the top to navigate back.
          </p>

          <h3 className={styles.h3}>Linked vs Independent Copies</h3>
          <p className={styles.p}>
            A macro can be reused as a <strong>linked</strong> (mirror) copy or an
            <strong> independent</strong> copy. Linked copies share one definition &mdash;
            editing the internals of any instance updates <em>all</em> of them, like a
            reusable &quot;black box.&quot; Independent copies each own their definition,
            so you can change one without affecting the others.
          </p>
          <ul className={styles.list}>
            <li>Dragging a macro from the Palette&apos;s <strong>Project Macros</strong> section, or right-clicking a Macro node and choosing <strong>Duplicate &rarr; Duplicate Linked</strong>, creates a <em>linked</em> copy.</li>
            <li><strong>Duplicate &rarr; Duplicate Independent</strong> (and copy/paste) creates an <em>independent</em> copy.</li>
            <li>When 2+ instances share a definition, a small <strong>count badge</strong> appears at the left of each Macro node&apos;s header. Click it and choose <strong>Make Independent Copy</strong> to break the link for that one instance &mdash; it gets its own definition you can edit and rename freely. (Inspired by Blender&apos;s linked-datablock user count.)</li>
          </ul>

          <h3 className={styles.h3}>Undoing a Macro</h3>
          <p className={styles.p}>
            Right-click a Macro node and choose &quot;Undo Macro&quot; to inline its
            contents back into the parent graph. All restored nodes are automatically
            selected for easy repositioning.
          </p>
        </section>

        {/* ============================================================ */}
        <section id="help-async" className={styles.section}>
          <h2 className={styles.h2}>Asynchronous Mode</h2>
          <p className={styles.p}>
            As described in the <em>Synchronicity</em> fundamental, GenesisCA supports
            both synchronous (classic) and asynchronous update modes.
          </p>
          <p className={styles.p}>
            <strong>Asynchronous mode</strong> (set in Model Properties &gt; Execution) updates
            cells one at a time using a single buffer, so each cell sees previous
            updates within the same generation. Combined with the expanded <em>Writability</em> rules
            (cells can modify neighbor attributes directly), this enables <em>number-conserving</em> models
            where elements move across the grid without being created or destroyed.
          </p>
          <p className={styles.p}>
            Because async mode uses a single buffer, a rule that <em>writes</em> a cell attribute and
            then <em>reads</em> the same attribute later in the same cell&apos;s logic (for example via a
            <em> Sequence</em> &mdash; decide a value, then test it) observes the value it just wrote, not the
            value from the start of the generation. (In synchronous mode all reads see the previous
            generation&apos;s state regardless, since reads and writes use separate buffers.)
          </p>

          <h3 className={styles.h3}>Update Schemes</h3>
          <ul className={styles.ul}>
            <li><strong>Random Order</strong> &mdash; Every cell updates exactly once per generation in a
              random permutation (Fisher-Yates shuffle).</li>
            <li><strong>Random Independent</strong> &mdash; N random cell picks with replacement per generation.
              Some cells may update 0 or 2+ times.</li>
            <li><strong>Cyclic</strong> &mdash; A fixed random order decided at initialization, reused every
              generation. Fastest option with zero per-step shuffle cost.</li>
          </ul>

          <h3 className={styles.h3}>Async-Only Nodes</h3>
          <p className={styles.p}>
            Three node types are exclusive to asynchronous mode. Using them in synchronous
            mode will produce a compiler error.
          </p>
          <ul className={styles.ul}>
            <li><strong>Set Neighborhood Attribute</strong> &mdash; Sets a cell attribute for all cells in a
              selected neighborhood.</li>
            <li><strong>Set Neighbor Attr By Index</strong> &mdash; Sets a cell attribute for one specific
              neighbor (by NeighborIndex).</li>
            <li><strong>Mark Cell Updated</strong> &mdash; Marks a neighbor cell (by NeighborIndex) as
              already-updated for the rest of this generation. The scheduler tests this flag at
              the top of each cell iteration and skips the body when set. Use it after &ldquo;moving&rdquo;
              state into a neighbor so that neighbor doesn&apos;t get another turn in the same step
              (without it, a gas particle could chain-move across the whole grid in one generation
              if it picked the same direction as the random update order).</li>
          </ul>
          <p className={styles.p}>
            <strong>Get Neighbor Attr By Index</strong> is a read-only node that works in both
            sync and async modes, and is typically used alongside the async-only write nodes.
          </p>
          <p className={styles.p}>
            <strong>Canonical movement pattern</strong> (mass-conservation, particle-style rules):
          </p>
          <ol className={styles.list}>
            <li><strong>Get All Neighbor Indexes</strong> with the chosen neighborhood &rarr;
              produces an NI[] of every slot.</li>
            <li><strong>Filter Neighbors</strong> with that NI[] wired into <em>Indexes</em> &rarr;
              keeps the slots where the chosen attribute equals &ldquo;empty&rdquo;.</li>
            <li><strong>Pick Random Neighbor</strong> &rarr; pick one slot at random from the
              filtered list. Returns <em>INVALID_NI</em> (0x80000000) on empty.</li>
            <li>If the picked slot is not <em>INVALID_NI</em>, <strong>Set Neighbor Attr By Index</strong>
              on that slot to mark it occupied AND <strong>Set Attribute</strong> on self to clear
              the current cell. Then <strong>Mark Cell Updated</strong> with the same NI to prevent
              the destination cell from running its own rule later in this generation.</li>
          </ol>

          <h3 className={styles.h3}>NeighborIndex Type</h3>
          <p className={styles.p}>
            <strong>NeighborIndex</strong> (NI) is a typed handle that carries a relative
            offset to a neighbor cell &mdash; (dRow, dCol) on a 2D grid, or (dRow, dCol, dLayer)
            on a 3D volume. The runtime representation is a packed i32: in 2D, dRow in the upper
            16 bits and dCol in the lower 16; in 3D, three sign-extended 10-bit fields
            (dRow, dCol, dLayer, &plusmn;511 each). The compiler picks the codec automatically per
            model, so the same graph works in either dimension. An NI is
            <strong>position-only</strong> &mdash; it does not belong to any specific neighborhood,
            so wires through filter / pick / iterate / set chains without ever needing a "which
            neighborhood is this from?" question.
          </p>
          <p className={styles.p}>
            The "no neighbor" sentinel is <code>INVALID_NI = 0x80000000</code> (i32 min). Producers
            that may yield no result (e.g. <em>Pick Random Neighbor</em> on an empty array) return
            this value; consumers (<em>Set Neighbor Attr By Index</em>, <em>Get Neighbor Attr By
            Index</em>) ignore it.
          </p>
          <p className={styles.p}>
            NeighborIndex ports are <strong>amber-coloured</strong> in the editor (versus cyan for
            generic value ports). The connection validator blocks wiring a non-NI integer source
            into an NI port; if you connect an aggregation output that produces list-positions
            (<em>Count Matching</em>&apos;s <em>Positions</em>, <em>Group Reduce</em>&apos;s <em>Position</em>),
            you&apos;ll see a warning badge on the target node.
          </p>
          <p className={styles.p}>
            Nodes that operate on NeighborIndex:
          </p>
          <ul className={styles.ul}>
            <li><strong>Get All Neighbor Indexes</strong> &mdash; the bootstrap. Returns the full
              NI[] (one packed offset per slot) of a chosen neighborhood. Use it to start a filter /
              iterate / pick chain without needing tags.</li>
            <li><strong>Filter Neighbors</strong> &mdash; narrow an NI[] by an attribute predicate.
              Just an attribute and an operator &mdash; no neighborhood needed (the NIs carry their
              own offsets). The Indexes input is required. Exposes both <em>Result</em> (NI[]) and
              <em>Count</em> (int) outputs so downstream rules don&apos;t need a separate <em>Array
              Length</em> node when they care about &ldquo;how many neighbors matched&rdquo;.</li>
            <li><strong>Join Neighbors</strong> &mdash; intersection / union of two NI[]s. Also
              exposes <em>Result</em> (NI[]) and <em>Count</em> (int), mirroring Filter Neighbors.</li>
            <li><strong>Pick Random Neighbor</strong> &mdash; pick one element from a NI[] at random.
              Returns <em>INVALID_NI</em> on empty.</li>
            <li><strong>Pick N Random Neighbors</strong> &mdash; pick N distinct elements without
              replacement (partial Fisher-Yates).</li>
            <li><strong>Neighbor Index (from Offset)</strong> &mdash; build a NI from a (dRow, dCol)
              pair, plus a <em>dLayer</em> port in 3D models. dr/dc/dl are input ports with inline
              number widgets, so they can be either typed or wired from any computation (e.g. a
              model attribute encoding direction).</li>
            <li><strong>Neighbor Index (from Tag)</strong> &mdash; build a NI from a tag name in the
              neighborhood&apos;s tags map. Compile-time-resolved.</li>
            <li><strong>Flip Neighbor Index</strong> &mdash; mirror a NI horizontally (negate dCol),
              vertically (negate dRow), or both (180&deg; rotation). Pure bit math; no neighborhood
              needed.</li>
            <li><strong>Break Down Neighbor Index</strong> &mdash; inverse of <em>Neighbor Index
              (from Offset)</em>. Unpacks a NI into its integer outputs <em>dr</em> and <em>dc</em>
              (plus <em>dl</em> in 3D), for per-axis arithmetic on computed NIs (e.g. inspecting the
              direction returned by Pick Random Neighbor).</li>
            <li><strong>Get Array Element</strong> / <strong>Array Length</strong> &mdash; generic indexed
              access and size for any array (NI[] or otherwise). Pair Get Array Element with the
              <em>Position(s)</em> outputs of Count Matching / Group Reduce to recover the NI of the
              matching neighbor when reducing an aligned values[] from <em>Get Neighbors Attr By
              Indexes</em>.</li>
          </ul>
          <p className={styles.p}>
            NeighborIndex can also be a <strong>cell or model attribute type</strong>. The
            attribute editor exposes a clickable cell grid (with an optional &ldquo;hint
            neighborhood&rdquo; that highlights its slots) for picking the default direction.
            Without a hint, the editor falls back to two number inputs (dr + dc). The stored
            value is the same packed (dr, dc) i32 used by the rest of the system &mdash; usable
            anywhere a NI is expected.
          </p>

          <h3 className={styles.h3}>For Each In Array</h3>
          <p className={styles.p}>
            <strong>For Each In Array</strong> is a flow node that iterates over each element of
            a typed array (any kind: binary[], integer[], decimal[], tag[], NeighborIndex[]) and runs the
            BODY flow for each, exposing the current <em>Element</em> and its 0-based
            <em> Index</em> via output ports. Useful for &ldquo;iterate matching neighbors and
            apply different ops&rdquo; patterns &mdash; and the <em>Index</em> lets the body
            address parallel arrays by slot (e.g. <em>Get Array Element(otherArray, index)</em> or
            <em> Set Array Element(weights, index, &hellip;)</em> into a Local Variable).
          </p>
          <p className={styles.p}>
            Both patterns work: body <em>flow</em> nodes can consume <em>Element</em> / <em>Index</em>
            directly via input ports (e.g. <em>Set Neighbor Attr By Index</em> with index = element),
            and body <em> value</em> chains that depend on them (e.g. wiring element through a Math
            node before the action) compile correctly because element/index-dependent expressions
            emit inside the loop block where those variables are in scope. Available on JS, WASM,
            and WebGPU.
          </p>
        </section>

        {/* ============================================================ */}
        <section id="help-3dgridca" className={styles.section}>
          <h2 className={styles.h2}>3D Grid CA</h2>
          <p className={styles.p}>
            GenesisCA models are 2D by default &mdash; a flat <code>W&times;H</code> grid.
            Flipping <strong>Dimension</strong> to <strong>3D</strong> in
            Properties&nbsp;&rarr;&nbsp;Structure turns the lattice into a
            <code>W&times;H&times;D</code> <strong>volume</strong> (a Grid&nbsp;Depth field
            appears). Everything you already know carries over: attributes, the rule
            graph, indicators, and all three compile targets (JavaScript / WebAssembly /
            WebGPU). A 2D model is unaffected &mdash; it compiles exactly as before.
          </p>
          <h3 className={styles.h3}>3D Neighbourhoods</h3>
          <p className={styles.p}>
            In a 3D model the Neighborhoods panel offers two editors:
          </p>
          <ul className={styles.list}>
            <li><strong>Parametric (primary)</strong> &mdash; pick a named shape
              (Moore box, von&nbsp;Neumann diamond, Ball/sphere, Range-N, Shell, or a
              planar Ring/Disk) and a radius; a metric selector (L&infin; / L1 / L2)
              reproduces the box / diamond / sphere families. Click <em>Generate shape</em>
              to materialize the 3D offsets.</li>
            <li><strong>Slice editor</strong> &mdash; step through the Z layers and
              toggle individual <code>(row, col)</code> cells at each layer, with three
              axis-plane mirrors (H / V / L) and right-click per-cell tags, for hand-tuned
              shapes.</li>
          </ul>
          <p className={styles.p}>
            The direct <em>NeighborIndex</em> node family (Get/Set Neighbor Attribute By
            Index, etc.) is hidden in 3D &mdash; its packed coordinate carries only two
            axes. Use <strong>Get Neighbors Attribute</strong> or <strong>Get Neighbor
            Attribute by Tag</strong> instead (both work in any dimension).
          </p>
          <h3 className={styles.h3}>The 3D Viewport</h3>
          <p className={styles.p}>
            3D models render in a WebGL2 voxel view: each live cell is a small cube
            (transparent cells are skipped). <strong>Middle-drag</strong> (or
            <strong>Alt+left-drag</strong>, or <strong>right-drag</strong>) to orbit/pan,
            <strong>scroll</strong> to zoom, and hold <strong>Shift</strong> while orbiting to
            pan &mdash; Blender-style, with Z up. Click the <strong>corner gizmo</strong>'s
            coloured axis tips to snap to a view; the gizmo is depth-sorted and labelled
            <strong>C / R / D</strong> (column / row / depth). Clicking <strong>D</strong> looks
            straight down the depth axis, so the volume reads <strong>exactly like the 2D CA</strong>
            &mdash; column increases to the right, row downward, depth into the screen.
            <strong>Shift + left-click</strong> a cell to inspect it (the cell is
            <strong>highlighted in the volume</strong> while you hover its popup &mdash; there's no
            2D connector line); <strong>Shift + left-drag</strong> sweeps a single transient
            inspector across cells, so you can peek around the volume without pinning a popup per
            cell. <strong>Ctrl/Cmd + left-drag</strong> resizes the active brush, and
            <strong>Ctrl/Cmd + scroll</strong> cycles the Input Mapping (it no longer also zooms).
            The on-canvas <strong>3D View</strong> panel adds
            toggleable <strong>Axes / Grid / Bounds / the corner Gizmo</strong> (the Axes start at
            the <code>(0,0,0)</code> origin corner and grow toward +column / +row / +depth),
            <strong>Auto-orbit</strong> (+ speed), a
            <strong>Clip plane</strong> (axis X/Y/Z or the camera view, slid to cut away the
            front and see inside &mdash; the primary way to look into a dense volume), an
            <strong>Alpha blend</strong> toggle for translucent cells, a
            <strong>Background</strong> colour (off = transparent), and
            <strong>Reset view</strong>. The left panel's <strong>Grid Dimensions</strong> gains
            a <strong>Depth</strong> field to resize the volume's layers. (Empty cells default to
            transparent, so an in-progress model doesn't fill the whole volume with voxels.)
          </p>
          <p className={styles.p}>
            <strong>Painting in 3D</strong> uses an <strong>interaction plane</strong>: enable
            <strong>Brush plane</strong> in the 3D View panel and pick its axis + position. The
            plane shows its <strong>bounds and a grid</strong> so you can see exactly where it
            sits, and the hovered cells are outlined by a <strong>cube cursor matching the full
            brush footprint</strong>. A plain <strong>left-drag</strong> then ray-traces onto
            that slice and stamps the current brush <strong>shape and size</strong> (Rectangle /
            Circle / Ring) flat in the plane &mdash; exactly like the 2D brush, including drag
            interpolation and torus wrap. The <strong>Line</strong> tool takes two clicks on the
            plane (first sets an anchor, second draws the segment). A top-down view of the Z
            plane paints just like a 2D CA. Tick <strong>Volumetric Brush</strong> to make the
            shape a 3D solid instead of a flat footprint &mdash; a Circle becomes a sphere, a Ring
            a spherical shell, a Rectangle a box (with its own <strong>Depth</strong> field for the
            number of layers), and a Line a tube &mdash; so one stroke paints through the depth.
          </p>
          <h3 className={styles.h3}>Transparency &amp; Indicators</h3>
          <ul className={styles.list}>
            <li><strong>Authorable alpha</strong> &mdash; the <strong>Set Cell Looks</strong>
              node gained an <code>A</code> (alpha) input (default 255 = opaque). Drive it
              from a cell attribute so dead/empty cells become transparent and the
              renderer skips them &mdash; that's how you see structure inside the volume.</li>
            <li><strong>Layers indicator axis</strong> &mdash; a linked indicator's X-axis
              can be set to <strong>Layers</strong> (the Z sibling of Rows/Columns),
              plotting value per Z-position bin.</li>
          </ul>
          <p className={styles.p}>
            Saving a 3D model (<code>.gcaproj</code>) or a state snapshot
            (<code>.gcastate</code>) round-trips the full volume and the depth.
            <em>Variegated Cells</em> is 2D-only and is disabled in 3D, but all three compile
            targets work in 3D &mdash; JavaScript, WebAssembly, and WebGPU (under WebGPU the GPU
            runs the simulation and the voxel renderer reads the colours back each step).
          </p>
        </section>

        {/* ============================================================ */}
        <section id="help-agents" className={styles.section}>
          <h2 className={styles.h2}>Bond-Graph Agents (Floating Cells)</h2>
          <p className={styles.p}>
            Every model so far is a <em>lattice</em> CA: cells sit on a fixed grid.
            <strong> Bond-Graph Agents</strong> add a second kind of cell that
            <strong> floats in continuous space</strong> &mdash; an off-lattice "agent"
            with an <code>(x, y)</code> position, a radius, and bonds to other agents.
            Agents push each other apart (soft-sphere repulsion), can be joined by springs
            (<strong>bonds</strong>), <strong>grow</strong> toward a target size, and
            <strong> divide</strong> into a connected tissue. It's how you model
            <strong> morphogenesis</strong> &mdash; tissue that grows into shape &mdash;
            rather than a pattern on a fixed grid.
          </p>
          <p className={styles.p}>
            Agents are <strong>additive</strong>: a model keeps its grid and gains the agents
            on top, so the two engines run side by side. This release runs the agent engine on
            the <strong>JavaScript (Debug / Reference)</strong> compile target (an agents model
            selects it automatically) and is <strong>2D</strong>; the grid CA is unaffected.
          </p>
          <h3 className={styles.h3}>Enabling Agents</h3>
          <p className={styles.p}>
            In <strong>Properties &rarr; Execution &rarr; Topology</strong>, tick
            <strong> Bond-Graph Agents</strong> (alongside <strong>Grid Cells</strong> &mdash;
            at least one must stay on). A <strong>Bond-Graph Agents</strong> config block
            appears below, and a <strong>Cells / Agents</strong> tab strip appears above the
            graph canvas.
          </p>
          <h3 className={styles.h3}>The Two-Graph Workflow (Cells vs Agents)</h3>
          <p className={styles.p}>
            With Agents on you author <strong>two rule graphs</strong> behind the same editor,
            switched by the <strong>Cells / Agents</strong> tabs:
          </p>
          <ul className={styles.list}>
            <li><strong>Cells</strong> &mdash; the familiar grid CA (the per-cell
              <code> Generation Step</code>, neighbourhoods, color mappings).</li>
            <li><strong>Agents</strong> &mdash; the per-agent behaviour, rooted at a
              <strong> Behaviour Step</strong> node that runs once per agent each generation.</li>
          </ul>
          <p className={styles.p}>
            The palette adapts to the active tab: agent nodes show only on
            <strong> Agents</strong>, grid/neighbourhood nodes only on <strong>Cells</strong>,
            and universal nodes (math, conditionals, <strong>Get / Set Attribute</strong> over
            the shared attributes, <strong>Set Cell Looks</strong>) in both. The cell attributes
            <strong> double as agent attributes</strong> &mdash; the same <code>Get Cell
            Attribute</code> / <code>Set Attribute</code> nodes read and write an agent's own
            state on the Agents tab. <em>Macros are shared</em> between the two graphs.
          </p>
          <h3 className={styles.h3}>Key Agent Nodes</h3>
          <ul className={styles.list}>
            <li><strong>Behaviour Step</strong> &mdash; the per-agent entry root (one per Agents
              graph). Outputs the agent's own <code>X</code> / <code>Y</code> /
              <code> Radius</code> / <code>Area</code> / <code>Bond Degree</code> /
              <code> Age</code> / <code>Type</code>.</li>
            <li><strong>Get Self Position / Get Radius / Get Bond Degree / Neighbour Density</strong>
              &mdash; read the agent's geometry and its local crowding (how many other agents are
              within interaction range).</li>
            <li><strong>Set Target Radius</strong> &mdash; set the size the agent grows toward;
              the engine ramps the actual radius each step. A grown agent is what divides.</li>
            <li><strong>Form Bond / Break Bond / For Each Bond</strong> &mdash; create or remove a
              spring between two agents, or iterate this agent's bonds (exposing the partner,
              rest length, and current length) to act per-bond (e.g. break an over-stretched
              bond). Bonds can also form <strong>automatically by distance</strong> (the
              Auto-bond option), the simplest path to a glued cluster.</li>
            <li><strong>Divide Agent</strong> &mdash; split the agent into two daughters along its
              <strong> tension axis</strong> (the net-stretch direction of its bonds), so a glued
              cluster cleaves along its mechanical axis. Each bond is handed to the nearer
              daughter and a daughter&ndash;daughter bond keeps the tissue connected. A
              <strong> Division Event</strong> root (optional) runs once per daughter so you can
              give them different attribute values (asymmetric inheritance).</li>
            <li><strong>Kill Agent</strong> &mdash; remove the agent (apoptosis); all its bonds
              are broken safely.</li>
            <li><strong>Get Velocity / Get Curvature</strong> &mdash; the agent's current velocity
              (for flocking), and its local membrane curvature (0 = flat/interior, →1 = a convex
              edge or tip &mdash; for curvature-dependent behaviour).</li>
          </ul>
          <h3 className={styles.h3}>Sensing Other Agents &amp; Authoring Forces (Flocking)</h3>
          <p className={styles.p}>
            Agents sense their neighbours and the rule graph <strong>authors the forces</strong> &mdash;
            the off-lattice analogue of reading neighbours on the grid:
          </p>
          <ul className={styles.list}>
            <li><strong>Get Nearby Agents</strong> &mdash; the list of other agents within a
              radius (the agent analogue of <em>Get All Neighbor Indexes</em>). Iterate it with
              <strong> For Each In Array</strong>, then read each with <strong>Get Agent Position /
              Attribute / Radius / Get Velocity</strong>, bond to it, or steer from it.</li>
            <li><strong>Apply Force</strong> &mdash; add a force vector to the agent; the engine
              integrates the sum of all your Apply Force contributions (plus its built-in
              soft-sphere repulsion + bond springs, unless <em>Custom forces only</em> is set). This
              is how you build <strong>boids</strong> (separation + alignment + cohesion),
              <strong> chemotaxis</strong> (force up a Field Gradient), or self-propulsion. With
              <strong> Momentum</strong> &gt; 0 the force changes velocity (flocking inertia).</li>
            <li><strong>Set Agent Attribute</strong> &mdash; write an attribute on another agent by
              id (signal a neighbour). And because Get Nearby Agents now supplies a target,
              <strong> Form Bond</strong> is fully graph-driven &mdash; bond to compatible
              neighbours by type/state.</li>
          </ul>
          <h3 className={styles.h3}>The Cell CA as a Morphogen Field (Closed Feedback)</h3>
          <p className={styles.p}>
            The two engines close a loop: <strong>every grid cell attribute doubles as a
            diffusible "field"</strong> the agents both sense and shape. There is no separate
            field system &mdash; it's just the grid CA.
          </p>
          <ul className={styles.list}>
            <li><strong>Agents deposit</strong> into the field &mdash;
              <strong> Secrete To Field</strong> adds (or, with a negative rate, consumes) a
              value at the agent's position; <strong>Affect Cells Under</strong> writes a cell
              attribute over a radius (set / add / max / &hellip;).</li>
            <li><strong>The grid CA diffuses</strong> it &mdash; an ordinary cell rule spreads the
              deposited morphogen across the lattice.</li>
            <li><strong>Agents sense</strong> the result &mdash; <strong>Sample Field</strong>
              reads the field at the agent's continuous position, <strong>Field Gradient</strong>
              gives its direction (for chemotaxis, or to steer a division axis), and
              <strong> Read Cells Under</strong> aggregates it over a disc.</li>
          </ul>
          <p className={styles.p}>
            So agents secrete morphogens, the grid diffuses them, and agents respond &mdash; the
            basis of stigmergy, chemotaxis, and hypoxia-driven branching.
          </p>
          <h3 className={styles.h3}>The Config Panel</h3>
          <p className={styles.p}>
            The <strong>Bond-Graph Agents</strong> block (Properties, shown when Agents is on)
            controls:
          </p>
          <ul className={styles.list}>
            <li><strong>Capacity</strong> &mdash; <strong>Max Agents</strong> and
              <strong> Max Bonds / Agent</strong>. These are over-allocated ceilings; running
              past them <strong>rejects</strong> the new agent/bond (it never wraps or corrupts).
              Changing a ceiling re-initialises the engine.</li>
            <li><strong>Seeding</strong> &mdash; the <strong>Seed Count</strong> laid down on
              Reset (0 = seed by hand), the <strong>Default Radius</strong>, and the
              <strong> Seed Pattern</strong> (a compact centred blob for tissue, or scattered
              across the world for flocking / aggregation).</li>
            <li><strong>Forces</strong> &mdash; the soft-sphere law: <strong>Repulsion</strong>
              (volume exclusion), <strong>Adhesion</strong> (free-agent stickiness),
              <strong> Interaction Range</strong>, <strong>Drag</strong>,
              <strong> Time Step</strong> (auto-clamped for stability),
              <strong> Growth Rate</strong>, plus the flocking knobs &mdash;
              <strong> Momentum</strong> (velocity persistence: 0 = overdamped tissue, ~0.9 =
              flocking inertia), <strong>Max Speed</strong>, <strong>Custom forces only</strong>
              (skip the engine soft-sphere), and <strong>Neighbour Query Radius</strong>.</li>
            <li><strong>Bonds</strong> &mdash; <strong>Auto-bond by distance</strong> (on/off),
              <strong> Bond Stiffness</strong>, and the <strong>Form / Break Distances</strong>
              (a hysteresis band so bonds don't flicker).</li>
          </ul>
          <p className={styles.p}>
            In the Simulator, the <strong>Agent Brush</strong> overlay (top-left) lets you
            <strong> Seed</strong> / <strong>Kill</strong> agents, <strong>Glue</strong> /
            <strong> Cut</strong> bonds between two clicked agents, <strong>Paint Field</strong>
            (the normal cell brush), and <strong>Clear all agents</strong>. The library ships four
            samples: <strong>Morphogenesis &mdash; Growing Tissue</strong> (12 → ~1500 cells
            dividing along the tension axis), <strong>Morphogenesis &mdash; Differential
            Tissue</strong> (asymmetric division + a maturity gradient + contact inhibition = cell
            <em> specialization</em>), <strong>Boids &mdash; Flocking</strong> (separation +
            alignment + cohesion), and <strong>Chemotaxis &mdash; Aggregation</strong> (secrete a
            chemical, the grid diffuses it, agents climb the gradient and aggregate) &mdash; load
            any to see the pipeline at work.
          </p>
        </section>

        {/* ============================================================ */}
        <section id="help-simulator" className={styles.section}>
          <h2 className={styles.h2}>The Simulator</h2>
          <p className={styles.p}>
            The Simulator runs your compiled model and visualizes the results in real time.
          </p>

          <h3 className={styles.h3}>Layout</h3>
          <p className={styles.p}>
            The simulator has a <strong>bottom transport bar</strong> with playback
            controls (Play/Pause/Step/Reset) and speed sliders (Target FPS, Gens/Frame),
            a <strong>top viewer bar</strong> for switching between visualization
            mappings, a collapsible <strong>left panel</strong> for settings (actions,
            grid dimensions, model attributes), and a collapsible <strong>right
            panel</strong> holding the brush settings (Input Mapping) above the
            Indicators. Hover over any mapping tab in either bar
            to see the mapping&apos;s description as a tooltip (matches the existing
            attribute / preset tooltips). When the model has indicators, a draggable
            divider sits between the brush area and the Indicators &mdash; drag it to give
            the indicators more room (double-click to reset it to fit-the-brush).
          </p>

          <h3 className={styles.h3}>Canvas Controls</h3>
          <ul className={styles.list}>
            <li><strong>Left-click drag</strong> &mdash; Paint with the brush tool.</li>
            <li><strong>Right-click drag</strong> &mdash; Pan the grid view.</li>
            <li><strong>Middle-click</strong> &mdash; Toggle autoscroll: the cursor becomes an anchor and the
              view continuously pans toward wherever you move the cursor, with speed proportional to the
              distance from the anchor. Click again (any button) or press <kbd className={styles.kbd}>Esc</kbd>
              to stop.</li>
            <li><strong>Scroll wheel</strong> &mdash; Zoom in/out.</li>
            <li><strong>Ctrl + left-click drag</strong> &mdash; Resize the brush. The dragged
              dimensions adapt to the active brush shape: Rectangle = width (horizontal) / height
              (vertical); Circle = radius; Ring = radius (horizontal) / band width (vertical);
              Line = thickness.</li>
            <li><strong>Zoom buttons</strong> (+/&minus;/fit/gridlines/infinity) &mdash; Bottom-left of the canvas.
              The <strong>&infin;</strong> button (only enabled on torus-boundary models) tiles the grid
              across the viewport so you can pan endlessly across the wrap seams; the brush wraps with it.</li>
            <li><strong>Hover coordinates</strong> &mdash; the top-left stats overlay shows the
              cell currently under the cursor as <code>Cell (col, row)</code>. When the brush
              is larger than 1&times;1, the chip switches to{' '}
              <code>Cells (x0,y0) &rarr; (x1,y1)</code> showing the brush footprint
              (end-inclusive indices).</li>
          </ul>

          <h3 className={styles.h3}>Playback</h3>
          <ul className={styles.list}>
            <li><strong>Play / Pause</strong> &mdash; Start or stop continuous simulation.</li>
            <li><strong>Step</strong> &mdash; Advance one generation (also pauses if running).</li>
            <li><strong>Reset</strong> &mdash; Clear the grid back to initial state.</li>
            <li><strong>Randomize</strong> &mdash; Fill the grid with random values.</li>
            <li><strong>Recompile</strong> &mdash; Recompile the graph after editing in the modeler.</li>
          </ul>

          <h3 className={styles.h3}>Brush Tool</h3>
          <p className={styles.p}>
            Left-click on the canvas to paint cells. Open the right panel to configure
            brush color, shape, size, and input mapping. The color picker is accompanied
            by three <strong>R/G/B</strong> numeric inputs so you can set or read exact
            channel values &mdash; useful when your Input Mapping logic depends on
            specific channel numbers. Use <strong>Ctrl + left-click drag</strong> to
            resize the brush interactively; <strong>Ctrl + scroll wheel</strong> cycles
            through the available Input Mappings; <strong>Shift + right-click</strong>{' '}
            opens an in-page color picker at the cursor (with R/G/B inputs plus a
            &quot;Full picker&quot; row for the native OS color dialog). Use{' '}
            <strong>Open Image</strong> in the brush panel to import a PNG/BMP/JPG as
            the starting grid state.
          </p>
          <p className={styles.p}>
            <strong>Brush shapes.</strong> Pick a stamp shape in the brush panel:
          </p>
          <ul className={styles.list}>
            <li><strong>Rectangle</strong> &mdash; a W&times;H block (the classic brush).</li>
            <li><strong>Circle</strong> &mdash; a filled disc of the given <em>radius</em>.</li>
            <li><strong>Ring</strong> &mdash; an annulus at the given <em>radius</em> and band <em>width</em>.</li>
            <li><strong>Line</strong> &mdash; click <em>two</em> points on the board to draw a
              segment of the chosen <em>thickness</em>. The first click stages a start anchor
              (nothing is painted yet); the second click commits the line. Press{' '}
              <kbd className={styles.kbd}>Esc</kbd> or right-click to cancel a staged anchor.</li>
          </ul>
          <p className={styles.p}>
            A brush cursor traces the exact cells the stamp will affect. It is drawn as a
            photographic <em>negative</em> of whatever colors are behind it (like the Windows
            mouse cursor), so the outline stays visible over any cell palette. Toggle it with
            <strong> Show brush cursor</strong> in the brush panel.
          </p>

          <h3 className={styles.h3}>Manual Brush</h3>
          <p className={styles.p}>
            The brush mapping strip always shows a special <strong>Manual</strong> tab on
            the right, even when the model has no Color&rarr;Attribute input mappings.
            Selecting it swaps the color picker for a per-attribute panel: one row per
            cell attribute, each with a <strong>Set</strong> checkbox and a
            type-appropriate value widget (binary dropdown, integer/decimal number input,
            tag dropdown, or &mdash; for a neighbor-index attribute &mdash; the same clickable
            offset-grid picker used in the Model Attributes panel). When you paint, every cell under the brush has each checked
            attribute overwritten with its chosen value; unchecked attributes are skipped
            so you keep fine control over what gets touched. Configuration persists
            per-model name in localStorage, separate from saved projects.
          </p>
          <p className={styles.p}>
            <strong>Sub-attribute behaviour:</strong> when you mark a sub-attribute
            (e.g. <em>charge</em> under <em>cellType</em>) as Set, the worker checks each
            painted cell&apos;s effective parent value &mdash; the brush&apos;s parent
            value if the parent is also being Set, otherwise the cell&apos;s current
            value &mdash; and only writes the sub-attribute where the parent is in the
            schema-declared <code>parentValues</code>. This mirrors the schema&apos;s
            iteration semantics: &ldquo;paint <em>charge=2</em> on every Wire cell under
            this stroke&rdquo; works naturally without first wiring a filter graph.
          </p>

          <h3 className={styles.h3}>Copy, Paste, Cut (Cell Regions)</h3>
          <p className={styles.p}>
            With the cursor over the grid, press <kbd className={styles.kbd}>Ctrl</kbd>+
            <kbd className={styles.kbd}>C</kbd> to copy the cell attributes inside the
            current <strong>brush footprint</strong> &mdash; the copy follows the brush
            shape, so a Circle copies a disc and a Ring an annulus, not just a rectangle.
            Move the cursor and press{' '}
            <kbd className={styles.kbd}>Ctrl</kbd>+<kbd className={styles.kbd}>V</kbd> to
            paste &mdash; the clipboard keeps its copy-time shape and re-centres on the
            cursor, stamping only the shape&apos;s cells and leaving the surrounding cells
            untouched (so a pasted circle drops a disc, not a square).{' '}
            <kbd className={styles.kbd}>Ctrl</kbd>+<kbd className={styles.kbd}>X</kbd>{' '}
            copies and then resets the source shape to each attribute&apos;s default
            value. Out-of-grid cells are silently skipped.
          </p>

          <h3 className={styles.h3}>Viewer</h3>
          <p className={styles.p}>
            The top bar shows available Attribute-to-Color mappings as clickable tabs.
            Click a tab to switch the visualization mode.
          </p>

          <h3 className={styles.h3}>Settings (Left Panel)</h3>
          <ul className={styles.list}>
            <li><strong>Grid Dimensions</strong> &mdash; Override the model&apos;s default size. Click &quot;Apply&quot; to reinitialize.</li>
            <li><strong>Model Attributes</strong> &mdash; Adjust global parameters in real time without recompiling.</li>
            <li><strong>Screenshot</strong> &mdash; Save the current view as a PNG image (matches display resolution with zoom/pan).</li>
            <li><strong>Record</strong> &mdash; Click the red record button in the transport bar, play the simulation, then click stop to encode and download. Use the format dropdown next to the button to choose <strong>WebM</strong> (default; native grid resolution, smaller files, no 256-colour limit) or <strong>GIF</strong> (256 colours, max 512&nbsp;px). WebM requires a browser with WebCodecs support (recent Chrome / Edge / Firefox); if unavailable the dropdown disables it and falls back to GIF.</li>
            <li><strong>Show Code</strong> &mdash; View the compiled artefact for the currently-selected target. JS shows the compiled JavaScript function; WebGPU shows the WGSL shader source; WebAssembly is binary and shows a placeholder &mdash; switch to JS to inspect a readable form.</li>
          </ul>

          <h3 className={styles.h3}>Save &amp; Load State</h3>
          <p className={styles.p}>
            The transport bar includes <strong>Save State</strong> (floppy disk icon) and{' '}
            <strong>Load State</strong> (folder icon) buttons at its left side.
          </p>
          <ul className={styles.list}>
            <li><strong>Save State</strong> &mdash; Downloads a <code>.gcastate</code> file
              capturing the full simulation snapshot: current generation, all cell
              attribute values, model attribute values, colors, indicator state, and
              simulator settings (viewer, brush, FPS, gens/frame).</li>
            <li><strong>Load State</strong> &mdash; Opens a <code>.gcastate</code> file and
              restores the simulation to that exact point. The grid dimensions in the
              state file must match the current grid &mdash; resize first if needed.</li>
          </ul>
          <p className={styles.p}>
            This enables experiment repeatability: save a specific configuration, run the
            simulation, then reload the same starting point to try different parameters.
            Saving state also embeds it in the model, so the next <code>.gcaproj</code>{' '}
            save will include the simulation snapshot.
          </p>

          <h3 className={styles.h3}>Model Presets</h3>
          <p className={styles.p}>
            The left panel includes a <strong>Presets</strong> section (right above Model
            Attributes) for embedding named snapshots of model-attribute values in the
            project. This is useful for generic models whose emergent behavior depends
            heavily on parameter choices &mdash; e.g. an MNCA-style model can ship several
            "interesting" threshold sets as one-click configurations.
          </p>
          <ul className={styles.list}>
            <li><strong>Save current as preset</strong> &mdash; Captures the current
              model-attribute values. Optionally embeds the cell grid too (check "Include
              cell grid state" in the dialog). UI controls (brush, viewer, FPS) are
              <em> never </em> part of a preset.</li>
            <li><strong>Load</strong> &mdash; Restores the preset's model-attribute values
              (and grid, if included). Preset rows marked with <code>&#x25C9;</code> include
              grid data. If a grid-carrying preset's dimensions don't match the current
              grid, you'll see a dimension-mismatch error &mdash; resize first.</li>
            <li><strong>Delete</strong> (&times;) &mdash; Removes the preset from the model.</li>
          </ul>
          <p className={styles.p}>
            Presets are stored inside the <code>.gcaproj</code> file. The Save Project
            dialog exposes an <strong>Include model presets</strong> checkbox (default on)
            so you can omit them from a given save if needed.
          </p>

          <p className={styles.p}>
            All simulator settings (speed, brush, viewer) are automatically saved and
            restored between sessions.
          </p>
        </section>

        {/* ============================================================ */}
        <section id="help-shortcuts" className={styles.section}>
          <h2 className={styles.h2}>Keyboard Shortcuts</h2>
          <p className={styles.p}>
            Press <kbd className={styles.kbd}>?</kbd> anywhere (or the navbar
            <strong> ?</strong> button) for a quick on-screen cheat sheet, and
            <kbd className={styles.kbd}>F</kbd> (or the <strong>&#x26F6;</strong>
            button on the canvas) to maximize the canvas by hiding the side panels.
          </p>

          <h3 className={styles.h3}>Graph Editor (Modeler)</h3>
          <table className={styles.table}>
            <thead><tr><th>Shortcut</th><th>Action</th></tr></thead>
            <tbody>
              <tr><td><kbd className={styles.kbd}>Ctrl</kbd>+<kbd className={styles.kbd}>Z</kbd></td><td>Undo</td></tr>
              <tr><td><kbd className={styles.kbd}>Ctrl</kbd>+<kbd className={styles.kbd}>Shift</kbd>+<kbd className={styles.kbd}>Z</kbd></td><td>Redo</td></tr>
              <tr><td><kbd className={styles.kbd}>Ctrl</kbd>+<kbd className={styles.kbd}>Y</kbd></td><td>Redo (alternative)</td></tr>
              <tr><td><kbd className={styles.kbd}>Ctrl</kbd>+<kbd className={styles.kbd}>C</kbd></td><td>Copy selected nodes</td></tr>
              <tr><td><kbd className={styles.kbd}>Ctrl</kbd>+<kbd className={styles.kbd}>V</kbd></td><td>Paste (at viewport center)</td></tr>
              <tr><td><kbd className={styles.kbd}>Ctrl</kbd>+<kbd className={styles.kbd}>X</kbd></td><td>Cut selected nodes</td></tr>
              <tr><td><kbd className={styles.kbd}>Ctrl</kbd>+<kbd className={styles.kbd}>D</kbd></td><td>Duplicate selected nodes</td></tr>
              <tr><td><kbd className={styles.kbd}>Delete</kbd> / <kbd className={styles.kbd}>Backspace</kbd></td><td>Delete selected nodes</td></tr>
              <tr><td>Right-click drag</td><td>Pan the canvas</td></tr>
              <tr><td>Scroll wheel</td><td>Zoom in/out</td></tr>
              <tr><td><kbd className={styles.kbd}>Ctrl</kbd> + left-click drag (node)</td><td>Align while dragging: snap the moving node(s) to nearby edges/centers with dashed guide lines (overrides snap-to-grid while held)</td></tr>
              <tr><td><kbd className={styles.kbd}>Ctrl</kbd>+<kbd className={styles.kbd}>F</kbd></td><td>Open Node Explorer (search &amp; focus)</td></tr>
              <tr><td><kbd className={styles.kbd}>Space</kbd></td><td>Quick add: open the add-node menu at the cursor with search focused; type, <kbd className={styles.kbd}>&uarr;</kbd>/<kbd className={styles.kbd}>&darr;</kbd> to pick, <kbd className={styles.kbd}>Enter</kbd> adds at the cursor position</td></tr>
              <tr><td><kbd className={styles.kbd}>F</kbd></td><td>Toggle fullscreen graph (collapses both side panels; press again to restore)</td></tr>
              <tr><td><kbd className={styles.kbd}>Esc</kbd></td><td>Close Node Explorer (if open; first press clears the search field)</td></tr>
              <tr><td>Double-click (node)</td><td>Collapse / expand node</td></tr>
              <tr><td>Double-click (macro)</td><td>Enter macro subgraph</td></tr>
              <tr><td>Double-click (edge)</td><td>Delete edge</td></tr>
              <tr><td>Right-click (canvas)</td><td>Add-node menu: Paste / Add Comment / Add Group / Import Macro + searchable node list</td></tr>
              <tr><td>Right-click (node)</td><td>Rename, Duplicate, Copy, Cut, Delete</td></tr>
              <tr><td>Right-click (selection)</td><td>Duplicate, Copy, Cut, Create Macro/Group</td></tr>
            </tbody>
          </table>

          <h3 className={styles.h3}>Simulator</h3>
          <table className={styles.table}>
            <thead><tr><th>Input</th><th>Action</th></tr></thead>
            <tbody>
              <tr><td>Left-click drag</td><td>Paint with brush tool</td></tr>
              <tr><td>Right-click drag</td><td>Pan the grid view</td></tr>
              <tr><td>Scroll wheel</td><td>Zoom in/out</td></tr>
              <tr><td><kbd className={styles.kbd}>Ctrl</kbd> + left-click drag</td><td>Resize brush (horizontal = W, vertical = H)</td></tr>
              <tr><td><kbd className={styles.kbd}>Ctrl</kbd> + scroll wheel</td><td>Cycle through Input Mappings</td></tr>
              <tr><td><kbd className={styles.kbd}>Shift</kbd> + right-click</td><td>Open in-page brush color picker at the cursor</td></tr>
              <tr><td><kbd className={styles.kbd}>Shift</kbd> + left-click</td><td>Open Inspect Cell popup: shows the cell's coordinates, all cell-attribute values (sub-attributes flagged as <em>undefined</em> when their parent doesn't match), and the live RGB of the active viewer. Popups are draggable, can stay open while you paint / play / step, and you can open multiple at once to compare cells. Hovering a popup highlights its cell on the grid; <kbd className={styles.kbd}>Esc</kbd> on the focused popup closes it.</td></tr>
              <tr><td><kbd className={styles.kbd}>Shift</kbd> + left-click drag</td><td>Sweep inspect: a single transient Inspect Cell popup follows the cursor cell while you drag, recycling instead of pinning a new popup per cell. Release on a different cell discards the popup; release without moving pins it (same as a plain <kbd className={styles.kbd}>Shift</kbd>+click). Useful for quickly peeking at attribute values across a region without cluttering the canvas.</td></tr>
              <tr><td><kbd className={styles.kbd}>Ctrl</kbd>+<kbd className={styles.kbd}>C</kbd></td><td>Copy the cell attributes in the brush footprint (follows the brush shape)</td></tr>
              <tr><td><kbd className={styles.kbd}>Ctrl</kbd>+<kbd className={styles.kbd}>V</kbd></td><td>Paste the clipboard shape, centred on the cursor (only the shape's cells)</td></tr>
              <tr><td><kbd className={styles.kbd}>Ctrl</kbd>+<kbd className={styles.kbd}>X</kbd></td><td>Copy, then reset the source shape to default attribute values</td></tr>
              <tr><td><kbd className={styles.kbd}>Space</kbd></td><td>Step (one generation; pauses if running)</td></tr>
              <tr><td><kbd className={styles.kbd}>Enter</kbd></td><td>Play / Pause</td></tr>
              <tr><td><kbd className={styles.kbd}>F</kbd></td><td>Toggle fullscreen canvas (collapses both side panels; press again to restore)</td></tr>
              <tr><td><kbd className={styles.kbd}>Esc</kbd></td><td>Reset</td></tr>
            </tbody>
          </table>
        </section>

        {/* ============================================================ */}
        <section id="help-fileformat" className={styles.section}>
          <h2 className={styles.h2}>File Format</h2>
          <p className={styles.p}>
            GenesisCA models are saved as <code>.gcaproj</code> files &mdash;
            human-readable JSON containing:
          </p>
          <ul className={styles.list}>
            <li><strong>schemaVersion</strong> &mdash; Version number for future migration support.</li>
            <li><strong>properties</strong> &mdash; Model metadata and structure (grid size, boundary, etc.).</li>
            <li><strong>attributes</strong> &mdash; All cell and model attribute definitions.</li>
            <li><strong>neighborhoods</strong> &mdash; Named neighborhood patterns with coordinate offsets.</li>
            <li><strong>mappings</strong> &mdash; Color mapping definitions for visualization and interaction.</li>
            <li><strong>graphNodes / graphEdges</strong> &mdash; The VPL node graph (positions, connections, config).</li>
            <li><strong>macroDefs</strong> &mdash; Macro subgraph definitions.</li>
            <li><strong>simulationState</strong> (optional) &mdash; Embedded simulation snapshot. Clicking <strong>Save</strong> opens a small dialog with two checkboxes:
              <ul>
                <li><em>Include simulator controls</em> &mdash; playback speed, brush size/color, selected input/output mapping, runtime model-attribute values.</li>
                <li><em>Include board state</em> &mdash; full cell grid snapshot: attributes, generation counter, indicator values, colors.</li>
              </ul>
              Both are checked by default. Unchecking both still saves a valid <code>.gcaproj</code> &mdash; it just contains only the model definition. Your last choices are remembered across sessions.
            </li>
          </ul>
          <p className={styles.p}>
            Use <strong>Save</strong> to download a <code>.gcaproj</code> file, and{' '}
            <strong>Load</strong> to import one. You can also load models from the{' '}
            <strong>Library</strong> tab. Loading a project (by file or from the Library)
            takes you straight to the <strong>Simulator</strong> tab and shows a brief
            confirmation that the model loaded. The top bar then shows the project name
            with the source file name in parentheses &mdash; handy when you keep several
            versions of the same project in different files.
          </p>

          <h3 className={styles.h3}>State Files (.gcastate)</h3>
          <p className={styles.p}>
            State files are standalone snapshots of the simulation at a specific
            generation. They contain all cell attribute arrays (base64-encoded typed
            arrays), model attribute values, indicator state, color buffer, and
            simulator UI settings. Use these to save and restore specific
            configurations for reproducible experiments.
          </p>
        </section>
      </div>
    </div>
  );
}
