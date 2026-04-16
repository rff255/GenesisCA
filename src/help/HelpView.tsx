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
            Configure the model&apos;s presentation (name, author, description), structure
            (grid width/height, boundary treatment: torus or constant), and execution
            parameters (max iterations).
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
          </ul>

          <h3 className={styles.h3}>Neighborhoods Panel (N)</h3>
          <p className={styles.p}>
            Define spatial neighborhoods &mdash; the set of relative cell positions a cell
            can &quot;see.&quot; Common patterns include Moore (8 surrounding cells) and
            Von Neumann (4 cardinal neighbors). Use the interactive grid to toggle neighbor
            positions. Each neighborhood has its own margin setting (up to 20) that controls
            the grid editor size. Use the <strong>Duplicate</strong> button to clone an
            existing neighborhood for quick variations.
          </p>

          <h3 className={styles.h3}>Mappings Panel (M)</h3>
          <p className={styles.p}>
            <strong>Attribute-to-Color</strong> mappings define how cell state is
            visualized (e.g., alive cells are blue). <strong>Color-to-Attribute</strong>
            mappings define how user interactions (brush painting, image imports) translate
            colors into cell state changes.
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

          <h3 className={styles.h3}>The Graph Editor</h3>
          <p className={styles.p}>
            The central area is a node-based visual programming editor. You connect nodes
            to define what each cell computes per generation. The graph is compiled into
            optimized JavaScript that runs 25+ million times per generation at large grid
            sizes.
          </p>
          <p className={styles.p}>
            <strong>Value ports</strong> (blue circles) carry data. <strong>Flow
            ports</strong> (green circles) control execution order.
          </p>

          <h3 className={styles.h3}>Canvas Controls</h3>
          <ul className={styles.list}>
            <li><strong>Right-click drag</strong> &mdash; Pan the canvas.</li>
            <li><strong>Scroll wheel</strong> &mdash; Zoom in/out.</li>
            <li><strong>Left-click drag</strong> (on empty area) &mdash; Box select nodes.</li>
            <li><strong>Left-click drag</strong> (on node) &mdash; Move node.</li>
            <li><strong>Ctrl + click</strong> &mdash; Add/remove from selection.</li>
            <li><strong>Right-click</strong> (on canvas) &mdash; Context menu: Paste, Add Comment, Add Node submenu. Hover over any Add Node entry to see a short description of what it does.</li>
            <li><strong>Right-click</strong> (on node) &mdash; Node options: Rename, Duplicate, Copy, Cut, Delete. Macros also show Enter Macro and Undo Macro.</li>
            <li><strong>Right-click</strong> (on selection) &mdash; Selection options: Duplicate, Copy, Cut, Paste, Create Macro, Create Group.</li>
            <li><strong>Right-click</strong> (on group) &mdash; Group options: Rename, Undo Group, Delete.</li>
            <li><strong>Drag from Palette</strong> &mdash; Drop a node or macro from the right-side Palette tab onto the canvas to add it at the drop position.</li>
          </ul>

          <h3 className={styles.h3}>Palette &amp; Node Explorer</h3>
          <p className={styles.p}>
            Open the right sidebar icons:
          </p>
          <ul className={styles.list}>
            <li><strong>Palette</strong> &mdash; Browse all node types (grouped by category) plus
              default macros shipped with the app (from <code>public/macros/*.gcamacro</code>) and
              the current project's macros. Drag any item onto the canvas to add it.</li>
            <li><strong>Node Explorer</strong> (<kbd className={styles.kbd}>Ctrl</kbd>+<kbd className={styles.kbd}>F</kbd>) &mdash; Search and jump to nodes
              already placed in your graph.</li>
          </ul>

          <h3 className={styles.h3}>Incomplete Node Warnings</h3>
          <p className={styles.p}>
            Nodes with required parameters that are not yet set (e.g., a <em>Set Attribute</em>
            node without an attribute selected) show a small amber <strong>!</strong> badge in their
            top-right corner. Hover it to see exactly what needs configuration.
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
        </section>

        {/* ============================================================ */}
        <section id="help-nodes" className={styles.section}>
          <h2 className={styles.h2}>Node Types Reference</h2>
          <p className={styles.p}>
            GenesisCA provides 36 node types organized into categories:
          </p>

          <h3 className={styles.h3}>
            <span className={styles.nodeCategory} style={{ background: '#2e7d32' }}>Event</span>
            Event Entry Points
          </h3>
          <table className={styles.table}>
            <thead><tr><th>Node</th><th>Description</th></tr></thead>
            <tbody>
              <tr><td>Generation Step</td><td>Entry point for per-generation cell update logic. Connect &quot;DO&quot; to start the flow chain.</td></tr>
              <tr><td>Input Mapping (C&rarr;A)</td><td>Entry point for Color-to-Attribute mapping (brush/image import). Outputs R, G, B values.</td></tr>
              <tr><td>Output Mapping (A&rarr;C)</td><td>Entry point for Attribute-to-Color visualization. Runs as a separate sequential pass after the Generation Step, ensuring colors reflect the final cell state.</td></tr>
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
              <tr><td>Get Constant</td><td>A fixed value (bool, integer, or float).</td></tr>
              <tr><td>Get Random</td><td>Generate a random value (bool, integer, or float). In Bool mode, an input port &quot;P&quot; (probability 0&ndash;1) controls the chance of producing 1 (default 0.5 = 50%).</td></tr>
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
              <tr><td>Proportion Map</td><td>Remap a value from one range to another: output = outMin + (x - inMin) * (outMax - outMin) / (inMax - inMin). Has 5 inputs: X, In Min, In Max, Out Min, Out Max.</td></tr>
              <tr><td>Interpolate</td><td>Linear interpolation: output = min + t * (max - min). Inputs: T (0&ndash;1), Min, Max.</td></tr>
              <tr><td>Compare (Statement)</td><td>Comparison operators: ==, !=, &gt;, &lt;, &gt;=, &lt;=.</td></tr>
              <tr><td>Logic Operator</td><td>AND, OR, XOR, NOT on boolean values.</td></tr>
            </tbody>
          </table>

          <h3 className={styles.h3}>
            <span className={styles.nodeCategory} style={{ background: '#6a1b9a' }}>Aggregation</span>
            Neighbor Aggregation
          </h3>
          <table className={styles.table}>
            <thead><tr><th>Node</th><th>Description</th></tr></thead>
            <tbody>
              <tr><td>Group Counting</td><td>Count neighbors matching a condition (equals, not equals, greater, lesser).</td></tr>
              <tr><td>Group Statement</td><td>Check if all/none/any neighbors satisfy a condition.</td></tr>
              <tr><td>Group Operator</td><td>Sum, multiply, max, min, mean, AND, OR, or pick random from neighbor values.</td></tr>
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
              <tr><td>Get Color Constant</td><td>Output fixed R, G, B values.</td></tr>
              <tr><td>Color Interpolate</td><td>Linearly interpolate between two colors. Inputs: interpolation point T (0&ndash;1), From R/G/B, To R/G/B. Outputs: R, G, B. Includes color picker widgets for &quot;Color From&quot; and &quot;Color To&quot; when the per-channel ports are not connected.</td></tr>
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
            Two node types are exclusive to asynchronous mode. Using them in synchronous
            mode will produce a compiler error.
          </p>
          <ul className={styles.ul}>
            <li><strong>Set Neighborhood Attribute</strong> &mdash; Sets a cell attribute for all cells in a
              selected neighborhood.</li>
            <li><strong>Set Neighbor Attr By Index</strong> &mdash; Sets a cell attribute for one specific
              neighbor (by index 0..N&minus;1).</li>
          </ul>
          <p className={styles.p}>
            <strong>Get Neighbor Attr By Index</strong> is a read-only node that works in both
            sync and async modes, and is typically used alongside the async-only write nodes.
          </p>
          <p className={styles.p}>
            <strong>Typical movement pattern:</strong> pick a random neighbor index &rarr;
            read that neighbor&apos;s attribute (Get Neighbor Attr By Index) &rarr;
            if empty, set that neighbor (Set Neighbor Attr By Index) and clear self
            (Set Attribute).
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
            panel</strong> for brush settings.
          </p>

          <h3 className={styles.h3}>Canvas Controls</h3>
          <ul className={styles.list}>
            <li><strong>Left-click drag</strong> &mdash; Paint with the brush tool.</li>
            <li><strong>Right-click drag</strong> &mdash; Pan the grid view.</li>
            <li><strong>Scroll wheel</strong> &mdash; Zoom in/out.</li>
            <li><strong>Ctrl + left-click drag</strong> &mdash; Resize brush (horizontal = width, vertical = height).</li>
            <li><strong>Zoom buttons</strong> (+/&minus;/fit) &mdash; Bottom-left of the canvas.</li>
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
            <li><strong>Record GIF</strong> &mdash; Click the red record button in the transport bar, play the simulation, then click stop to encode and download an animated GIF.</li>
            <li><strong>Show Code</strong> &mdash; View the compiled JavaScript function.</li>
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
              <tr><td><kbd className={styles.kbd}>Ctrl</kbd>+<kbd className={styles.kbd}>C</kbd></td><td>Copy cell attributes under the brush</td></tr>
              <tr><td><kbd className={styles.kbd}>Ctrl</kbd>+<kbd className={styles.kbd}>V</kbd></td><td>Paste clipboard, top-left aligned to the brush rectangle</td></tr>
              <tr><td><kbd className={styles.kbd}>Ctrl</kbd>+<kbd className={styles.kbd}>X</kbd></td><td>Copy, then reset the source region to default attribute values</td></tr>
              <tr><td><kbd className={styles.kbd}>Space</kbd></td><td>Step (one generation; pauses if running)</td></tr>
              <tr><td><kbd className={styles.kbd}>Enter</kbd></td><td>Play / Pause</td></tr>
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
