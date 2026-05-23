import { useCallback, useRef } from 'react';
import styles from './HelpView.module.css';

const sections = [
  { id: 'intro', label: 'What is GenesisCA' },
  { id: 'fundamentals', label: 'The 6 Fundamentals' },
  { id: 'modeler', label: 'The Modeler' },
  { id: 'nodes', label: 'Node Types Reference' },
  { id: 'macros', label: 'The Macro System' },
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
            100% in your browser &mdash; no server, no installation, no sign-up.
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
              attributes (bool, integer, float) whose values at a given generation form
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

          <h3 className={styles.h3}>Properties Panel (P)</h3>
          <p className={styles.p}>
            Configure the model&apos;s presentation (name, <strong>Rule Author</strong>,
            <strong>GenesisCA Project Author</strong>, description), structure (grid
            width/height, boundary treatment: torus or constant), execution mode, and
            optional <strong>End Conditions</strong> for the simulator.
          </p>
          <ul className={styles.list}>
            <li><strong>Rule Author</strong> &mdash; originator of the CA rule (domain expert/researcher).</li>
            <li><strong>GenesisCA Project Author</strong> &mdash; who built this particular GenesisCA project file.</li>
            <li><strong>Thumbnail</strong> (optional) &mdash; attach a PNG, JPEG, GIF, or WebP image (up to 2&nbsp;MB). It travels inside the <code>.gcaproj</code> file. When the model is shipped as part of the Models Library, hovering its card shows a floating preview; animated GIFs / WebPs play natively.</li>
            <li><strong>End Conditions</strong> (optional) &mdash; auto-pause the simulator when a max generation count is reached or when any indicator satisfies a configured comparison (==, !=, &gt;, &lt;, &ge;, &le;). Scalar indicators compare against their value directly. For <strong>linked-frequency</strong> indicators (which produce a map of category &rarr; count) pick the specific category to monitor; the comparison then applies to the count of that category (e.g. bool <em>alive</em> &mdash; category <code>true</code>, <code>&ge;</code>, <code>100</code> pauses when at least 100 cells are alive). Float-binned frequency indicators can&apos;t be used in end conditions because their bin boundaries depend on runtime data &mdash; switch the aggregation to Total instead. For conditions that need graph-level logic add a <strong>Stop Event</strong> node inside the update graph &mdash; its DO flow input pauses the simulation with a user-defined message.</li>
            <li><strong>Compile Target</strong> &mdash; choose the runtime backend the simulator uses to evolve cells. <strong>WebAssembly</strong> is the default and is recommended for most models &mdash; typically several times faster than JS on dense neighborhoods, full node coverage. <strong>WebGPU</strong> runs WGSL compute shaders on the GPU and is best for very large grids and math-heavy per-cell work; it requires synchronous mode and a browser with WebGPU support (Chrome 127+, Firefox 141+, Safari 17.4+). <strong>Debug / Reference (JS)</strong> compiles the graph to a plain JavaScript function &mdash; slower than WASM, but its source is readable in Show Code and useful for prototyping or verifying parity. Targets are mutually exclusive; switching restarts the simulator (grid state is lost). All three apply <em>value sinking</em>: per-cell value computations that are only consumed inside one switch case or if branch get emitted <em>inside</em> that branch, so cells in different states only pay for the work their branch needs. Sparse type-dispatch models (e.g. Wireworld with mostly Empty cells) get the biggest speedup from this. A side effect: if your model calls <em>Get Random</em> inside a branch, cells that don't enter that branch no longer advance the RNG &mdash; same seed will produce different output than older builds did.</li>
            <li><strong>WebGPU stop-check interval</strong> (advanced, WebGPU only) &mdash; Properties &rarr; Execution exposes an integer spinbox below the compile-target radio. It defaults to <code>1</code> &mdash; check the GPU stop flag after every step, exact stop-event timing. Higher values amortise the per-step <code>mapAsync</code> stall so big batches run faster, but a stop event firing at gen <em>n</em> may surface up to <em>K</em>&minus;1 generations later. The last step of every batch is always checked, so a stopped run never overshoots beyond the current play batch. JS and WASM ignore this setting.</li>
          </ul>

          <p className={styles.p}>
            <strong>Simulation state loading</strong> &mdash; Loading a saved state (either from an embedded project snapshot or a standalone <code>.gcastate</code> file) restores the grid <em>configuration</em> only: cell attributes, colors, model-attribute values, and simulator UI controls. The generation counter always resets to 0 and indicators re-initialise to their defaults. This way you can build a starting configuration over many generations, save it, and always start fresh from that state without inheriting the generation count you spent getting there.
          </p>

          <p className={styles.p}>
            <strong>Editing list items.</strong> In the Attributes, Local Variables,
            Neighborhoods, and Mappings panels, selecting an item from the list opens its
            editor in a <strong>second panel</strong> beside the list &mdash; so you never scroll past a
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
            (bool, integer, float, tag, color), a default value, and a description.
          </p>
          <ul className={styles.list}>
            <li><strong>Tag</strong> &mdash; An integer with named values (picklist). Define tag options in the editor, and use the Tag Constant node to reference them by name.</li>
            <li><strong>Color</strong> (model attributes only) &mdash; An RGB color value. Accessed via Get Model Attribute with separate R, G, B output ports. Adjustable live in the simulator.</li>
            <li><strong>Boundary Value</strong> (cell attributes only, constant boundary) &mdash; the value held by out-of-grid cells. Shown next to Default Value only when the model&apos;s boundary treatment is <em>constant</em>. Leave blank to inherit the default.</li>
            <li>
              <strong>Sub-attribute</strong> (cell attributes only) &mdash; a cell
              attribute marked as &quot;only well-defined&quot; on cells whose
              parent attribute (a Tag or Bool cell attribute) is in a chosen
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
            neighborhood has its own margin setting (up to 20) that controls the grid editor
            size. Use the <strong>Duplicate</strong> button to clone an existing neighborhood
            for quick variations.
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
              graph (an Output Mapping event node feeding Set Color Viewer). This is the
              classic behavior.
            </li>
            <li>
              <strong>Linked</strong> &mdash; pick a cell attribute and GenesisCA
              auto-generates the color pass for you, no graph required:
              <strong> bool</strong> &rarr; two colors (default black/white),
              <strong> float</strong> and <strong>integer</strong> &rarr; a color scale
              spanning a user-set min/max &mdash; choose a palette preset (Viridis, Magma,
              Rainbow, Heat, Cividis, …) or customize the stops with the same gradient
              editor used by the Color Scale node, and <strong>tag</strong> &rarr; one
              distinct color per option. Every palette is fully recolorable; the min/max
              fields appear for float and integer attributes.
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
            &quot;Indicators&quot; section. Two kinds exist:
          </p>
          <ul className={styles.list}>
            <li><strong>Standalone</strong> &mdash; Typed scalar values (bool, integer, float,
            or tag) that can be read and written by graph nodes (Get Indicator, Set Indicator,
            Update Indicator). They act as accumulators inside the step loop.</li>
            <li><strong>Linked</strong> &mdash; Automatically computed from an existing cell
            attribute after each step. The aggregation mode depends on the attribute type:
            Bool and Tag support Frequency (count per value); Integer and Float support
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
            <strong>Track Categories.</strong> For Bool or Tag frequency indicators you can
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
            rectangular) matrix of float values. Each axis has an independent <em>key
            source</em> &mdash; a face-label palette, a tag attribute, or{' '}
            <strong>Single value (map)</strong> &mdash; so a table can be keyed by faces
            (e.g. analyte&nbsp;&times;&nbsp;CD faces) or by cell type (e.g.
            empty/water/amphi). Choosing <em>Single value</em> for one axis collapses the
            table into a 1-D <strong>map</strong>: a single column (or row) of floats keyed
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
            from the palette otherwise). All run on JS, WASM, and WebGPU &mdash; only the two
            async-only writers below are unavailable on WebGPU (which is synchronous-only):
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
              by a row index and a column index &rarr; float. (Indices come from face labels
              or tag reads, depending on the table&apos;s key sources.)</li>
            <li><strong>Table Map</strong> &mdash; vectorised Table Lookup over two parallel
              index arrays &rarr; float array (pair with Aggregate&nbsp;&times;&nbsp;product
              for a break-probability product).</li>
            <li><strong>Move Self To Neighbor</strong> &mdash; atomic move into a vacant
              neighbour (push per-attribute payloads + optionally orientation, then clear
              self to defaults). Async-only; the chemistry move-into-empty idiom.</li>
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
            <strong> Local Variables</strong> panel (name, kind, data type, length, initial
            value).
          </p>
          <ul className={styles.list}>
            <li><strong>Lifetime</strong> &mdash; per-cell, per-step. Each cell starts with a
              fresh copy reset to the initial value; nothing carries across cells or across
              generations. Treat it as scratch for one cell&apos;s computation.</li>
            <li><strong>Kinds</strong> &mdash; <em>scalar</em> (a single value) or
              <em>array</em> (fixed length, all elements reset to the initial value). Data
              type is bool / integer / float / tag.</li>
            <li><strong>Get Variable</strong> &mdash; reads the current value (scalar) or the
              underlying array (array variables &mdash; iterate it like any array source:
              Aggregate, Group Reduce, Array Element, For Each In Array).</li>
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
            ports</strong> (green circles) control execution order.
          </p>

          <h3 className={styles.h3}>Canvas Controls</h3>
          <ul className={styles.list}>
            <li><strong>Right-click drag</strong> &mdash; Pan the canvas (works anywhere, including over edges, nodes, and group bodies).</li>
            <li><strong>Scroll wheel</strong> &mdash; Zoom in/out.</li>
            <li><strong>Left-click drag</strong> (on empty area) &mdash; Box select nodes.</li>
            <li><strong>Left-click drag</strong> (on node) &mdash; Move node.</li>
            <li><strong>Ctrl + click</strong> &mdash; Add/remove from selection.</li>
            <li><strong>Right-click</strong> (on canvas) &mdash; Context menu: Paste, Add Comment, Add Node submenu. Hover over any Add Node entry to see a short description of what it does. The menu closes as soon as you press or start dragging anywhere outside it (e.g. to box-select or pan).</li>
            <li><strong>Right-click</strong> (on node) &mdash; Node options: Rename, Duplicate, Copy, Cut, Delete. On macros, Duplicate expands into a submenu (<strong>Duplicate Independent</strong> / <strong>Duplicate Linked</strong>), and they also show Enter Macro, Export Macro, and Undo Macro &mdash; plus a count badge for making linked copies independent.</li>
            <li><strong>Right-click</strong> (on selection) &mdash; Selection options: Duplicate, Copy, Cut, Paste, Create Macro, Create Group, <strong>Align</strong> (horizontally: left/center/right; vertically: top/center/bottom) and <strong>Distribute</strong> (horizontally/vertically &mdash; keeps the leftmost/topmost in place and evens out the gaps).</li>
            <li><strong>Right-click</strong> (on group) &mdash; Group options: Rename, Undo Group, Delete.</li>
            <li><strong>Drag from Palette</strong> &mdash; Drop a node or macro from the right-side Palette tab onto the canvas to add it at the drop position.</li>
            <li><strong>Drag from a panel</strong> (Attributes, Neighborhoods, Mappings, Indicators) &mdash; Drop a model element onto the canvas to spawn a menu of related nodes pre-configured with that element. Drop directly onto a compatible port to auto-connect: when only one node type would fit, it is created and wired without a menu. The new node is positioned so its connecting port aligns with the target.</li>
          </ul>

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
            a collapsed node, it temporarily expands to reveal its ports.
          </p>

          <h3 className={styles.h3}>Comment Nodes</h3>
          <p className={styles.p}>
            Add free-floating comments to document parts of the graph via the right-click
            <strong> Add Comment</strong> action. When a comment is selected you can drag
            its corner to resize it (the size persists across saves) and click the color
            swatch in the top-right corner to change its background color.
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
              <tr><td>Conditional</td><td>If/else branching based on a boolean condition.</td></tr>
              <tr><td>Sequence</td><td>Execute &quot;First&quot; then &quot;Then&quot; sequentially.</td></tr>
              <tr><td>Loop</td><td>Repeat &quot;Body&quot; a given number of times.</td></tr>
              <tr><td>Switch</td><td>Route flow to multiple cases. Two modes: <strong>By Conditions</strong> (wire boolean inputs per case) or <strong>By Value</strong> (compare a value against per-case thresholds with ==, !=, &gt;, &lt;, &gt;=, &lt;= operators, or match tag options). A &quot;First match only&quot; toggle controls whether only the first matching case fires or all matches execute.</td></tr>
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
              <tr><td>Get Model Attribute</td><td>Read a global model parameter.</td></tr>
              <tr><td>Get Neighbors Attribute</td><td>Collect an attribute from all neighbors as an array.</td></tr>
              <tr><td>Get Neighbor Attr By Index</td><td>Read a cell attribute from ONE specific neighbor by index. Works in both sync and async modes.</td></tr>
              <tr><td>Get Neighbor Attr By Tag</td><td>Read a cell attribute from a specific neighbor identified by a named tag (defined in the Neighborhoods panel). The tag is resolved to an index at compile time.</td></tr>
              <tr><td>Get Neighbor Indexes By Tags</td><td>Select multiple neighborhood cells by their tag names and output an array of indices. Use with &quot;Get Neighbors Attr By Indexes&quot; for tag-based multi-neighbor access.</td></tr>
              <tr><td>Get Neighbors Attr By Indexes</td><td>Read attributes from a subset of neighbors specified by an array of indices.</td></tr>
              <tr><td>Get Constant</td><td>A fixed value: bool, integer, float, tag, orientation, or <em>face label</em> (the last only when Variegated Cells is enabled &mdash; emits the compile-time index of the named face label, with implicit <code>none</code> = 0).</td></tr>
              <tr><td>Get Random</td><td>Generate a random value (bool, integer, float, or Options). In Bool mode, an input port &quot;P&quot; (probability 0&ndash;1) controls the chance of producing 1 (default 0.5 = 50%). In Options mode, wire one or more values to the &quot;Options&quot; array input (multi-scalar OR a single array source like Filter Neighbors / Get All Neighbor Indexes / Get Neighbors Attribute) and the node picks one uniformly; the &quot;Fallback&quot; inline value is returned when the array is empty.</td></tr>
            </tbody>
          </table>

          <h3 className={styles.h3}>
            <span className={styles.nodeCategory} style={{ background: '#e65100' }}>Logic</span>
            Arithmetic &amp; Logic
          </h3>
          <table className={styles.table}>
            <thead><tr><th>Node</th><th>Description</th></tr></thead>
            <tbody>
              <tr><td>Arithmetic Operator (Math)</td><td>+, -, *, /, %, sqrt, pow, abs, max, min, mean.</td></tr>
              <tr><td>Expression</td><td>Type a math <strong>formula</strong> in a text field instead of wiring up many Math nodes &mdash; ideal for equation-heavy models. Operators <code>+ - * / % ^</code> and functions <code>sqrt abs floor ceil round min max pow mod</code>, plus the constants <code>pi</code> and <code>e</code>. Variables come from the input ports: add 1&ndash;8 ports with the <strong>+</strong> / <strong>&minus;</strong> buttons, give each a name, then reference those names in the formula (e.g. <em>u + Du*lap - u*v*v</em>). Compiles on all three targets (JS, WASM, WebGPU).</td></tr>
              <tr><td>Proportion Map</td><td>Remap a value from one range to another: <em>output = outMin + curve(t) * (outMax - outMin)</em> with <em>t = (x - inMin) / (inMax - inMin)</em>. Has 5 inputs (X, In Min, In Max, Out Min, Out Max) plus a <strong>curve</strong> dropdown: Linear, Smoothstep, Ease-In Quadratic, Ease-Out Quadratic, Exponential, Logarithmic. Linear keeps un-clamped extrapolation; non-linear curves clamp t to [0, 1].</td></tr>
              <tr><td>Interpolate</td><td>Linear interpolation: output = min + t * (max - min). Inputs: T (0&ndash;1), Min, Max.</td></tr>
              <tr><td>Compare (Statement)</td><td>Comparison operators: ==, !=, &gt;, &lt;, &gt;=, &lt;=, <strong>Between</strong>, and <strong>Not Between</strong>. The between-family ops reveal a Y&#8322; input and two picklists for the lower (&gt;= or &gt;) and upper (&lt;= or &lt;) interval sides; <em>Not Between</em> fires when the value is outside the interval. Replaces the common Compare + Compare + AND chain.</td></tr>
              <tr><td>Logic Operator</td><td>AND, OR, XOR, NOT on boolean values.</td></tr>
              <tr><td>Value Switch</td><td>Ternary value selector: outputs <em>If</em> when <em>Condition</em> is truthy, else <em>Else</em>. Pure value &mdash; no flow port, so it stays inline in the graph. Both inputs always evaluate; use a flow Conditional for short-circuit.</td></tr>
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
              <tr><td>Set Color Viewer</td><td>Write RGB values for an Attribute-to-Color visualization.</td></tr>
              <tr><td>Set Cell Glyph</td><td>Overlay a Unicode character on the current cell when the named Output Mapping is active. Inputs: <strong>Glyph</strong> (Unicode codepoint, with an inline text picker), <strong>R/G/B</strong> for glyph colour. Cells with glyph=0 render no character. Glyphs only paint when the cell is at least 6 screen pixels (configurable via <code>genesisca_sim_settings.glyphMinPx</code>) — they hide gracefully at small zooms.</td></tr>
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
            (dRow, dCol) offset to a neighbor cell. The runtime representation is a packed i32:
            dRow in the upper 16 bits, dCol in the lower 16 bits, both sign-extended on decode.
            An NI is <strong>position-only</strong> &mdash; it does not belong to any specific
            neighborhood, so wires through filter / pick / iterate / set chains without ever needing
            a "which neighborhood is this from?" question.
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
              pair. dr and dc are input ports with inline number widgets, so they can be either
              typed or wired from any computation (e.g. a model attribute encoding direction).</li>
            <li><strong>Neighbor Index (from Tag)</strong> &mdash; build a NI from a tag name in the
              neighborhood&apos;s tags map. Compile-time-resolved.</li>
            <li><strong>Flip Neighbor Index</strong> &mdash; mirror a NI horizontally (negate dCol),
              vertically (negate dRow), or both (180&deg; rotation). Pure bit math; no neighborhood
              needed.</li>
            <li><strong>Break Down Neighbor Index</strong> &mdash; inverse of <em>Neighbor Index
              (from Offset)</em>. Unpacks a NI into its two integer outputs <em>dr</em> and
              <em>dc</em>, for per-axis arithmetic on computed NIs (e.g. inspecting the direction
              returned by Pick Random Neighbor).</li>
            <li><strong>Array Element</strong> / <strong>Array Length</strong> &mdash; generic indexed
              access and size for any array (NI[] or otherwise). Pair Array Element with the
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
            a typed array (any kind: bool[], int[], float[], tag[], NeighborIndex[]) and runs the
            BODY flow for each, exposing the current <em>Element</em> and its 0-based
            <em> Index</em> via output ports. Useful for &ldquo;iterate matching neighbors and
            apply different ops&rdquo; patterns &mdash; and the <em>Index</em> lets the body
            address parallel arrays by slot (e.g. <em>Array Element(otherArray, index)</em> or
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
            panel</strong> for brush settings. Hover over any mapping tab in either bar
            to see the mapping&apos;s description as a tooltip (matches the existing
            attribute / preset tooltips).
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
            <li><strong>Ctrl + left-click drag</strong> &mdash; Resize brush (horizontal = width, vertical = height).</li>
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
            brush color, width/height, and input mapping. The color picker is accompanied
            by three <strong>R/G/B</strong> numeric inputs so you can set or read exact
            channel values &mdash; useful when your Input Mapping logic depends on
            specific channel numbers. A brush cursor rectangle shows which cells will be
            affected (toggle in the brush panel). Use <strong>Ctrl + left-click drag</strong> to
            resize the brush interactively; <strong>Ctrl + scroll wheel</strong> cycles
            through the available Input Mappings; <strong>Shift + right-click</strong>{' '}
            opens an in-page color picker at the cursor (with R/G/B inputs plus a
            &quot;Full picker&quot; row for the native OS color dialog). Use{' '}
            <strong>Open Image</strong> in the brush panel to import a PNG/BMP/JPG as
            the starting grid state.
          </p>

          <h3 className={styles.h3}>Manual Brush</h3>
          <p className={styles.p}>
            The brush mapping strip always shows a special <strong>Manual</strong> tab on
            the right, even when the model has no Color&rarr;Attribute input mappings.
            Selecting it swaps the color picker for a per-attribute panel: one row per
            cell attribute, each with a <strong>Set</strong> checkbox and a
            type-appropriate value widget (bool dropdown, integer/float number input, or
            tag dropdown). When you paint, every cell under the brush has each checked
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
            <kbd className={styles.kbd}>C</kbd> to copy all cell attributes inside the
            current brush rectangle. Move the cursor and press{' '}
            <kbd className={styles.kbd}>Ctrl</kbd>+<kbd className={styles.kbd}>V</kbd> to
            paste &mdash; the clipboard keeps its copy-time width and height, and its
            top-left aligns with the top-left of the current brush rectangle so the
            brush outline shows exactly where the paste will land.{' '}
            <kbd className={styles.kbd}>Ctrl</kbd>+<kbd className={styles.kbd}>X</kbd>{' '}
            copies and then resets the source region to each attribute&apos;s default
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
              <tr><td><kbd className={styles.kbd}>Ctrl</kbd>+<kbd className={styles.kbd}>F</kbd></td><td>Open Node Explorer (search &amp; focus)</td></tr>
              <tr><td><kbd className={styles.kbd}>F</kbd></td><td>Toggle fullscreen graph (collapses both side panels; press again to restore)</td></tr>
              <tr><td><kbd className={styles.kbd}>Esc</kbd></td><td>Close Node Explorer (if open; first press clears the search field)</td></tr>
              <tr><td>Double-click (node)</td><td>Collapse / expand node</td></tr>
              <tr><td>Double-click (macro)</td><td>Enter macro subgraph</td></tr>
              <tr><td>Double-click (edge)</td><td>Delete edge</td></tr>
              <tr><td>Right-click (canvas)</td><td>Context menu: Paste, Add Comment, Add Node</td></tr>
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
              <tr><td><kbd className={styles.kbd}>Ctrl</kbd>+<kbd className={styles.kbd}>C</kbd></td><td>Copy cell attributes under the brush</td></tr>
              <tr><td><kbd className={styles.kbd}>Ctrl</kbd>+<kbd className={styles.kbd}>V</kbd></td><td>Paste clipboard, top-left aligned to the brush rectangle</td></tr>
              <tr><td><kbd className={styles.kbd}>Ctrl</kbd>+<kbd className={styles.kbd}>X</kbd></td><td>Copy, then reset the source region to default attribute values</td></tr>
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
            <strong>Library</strong> tab.
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
