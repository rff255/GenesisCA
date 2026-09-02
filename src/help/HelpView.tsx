import { useCallback, useMemo, useRef } from 'react';
import styles from './HelpView.module.css';
import type { CAModel, GraphNode } from '../model/types';
import { EMPTY_MODEL } from '../model/defaultModel';
import { FULL_AGENT_PROFILE } from '../model/agentCapabilities';
import {
  describeGenerationPipeline, describePipelineGroups, TEMPO_LABEL,
} from '../model/generationPipeline';
import {
  AGENT_NODE_MATRIX, WEBGPU_GRID_REJECTS, CAPACITY_LIMITS, NODE_COUNTS,
} from './capabilityMatrix.gen';

// --- C2 (P3) — the "what runs each generation" reference ---------------------
// DERIVED, never hand-written: the list below is produced by the SAME
// `describeGenerationPipeline` the Properties panel renders, over a synthetic
// model with every capability switched on (so the reference shows the FULL
// sequence, whereas a real model shows its own subset). A phase added to the
// engine description therefore appears here automatically — there is no
// duplicate table to fall out of sync.
const refNode = (id: string, nodeType: string): GraphNode =>
  ({ id, type: 'caNode', position: { x: 0, y: 0 }, data: { nodeType, config: {} } });

const REFERENCE_MODEL: CAModel = {
  ...EMPTY_MODEL,
  properties: { ...EMPTY_MODEL.properties, updateMode: 'synchronous' },
  topologyMode: { gridCells: true, agents: true },
  graphNodes: [refNode('s', 'step'), refNode('i', 'initEvent'), refNode('gi', 'gridInit')],
  agentGraphNodes: [
    refNode('b', 'behaviourStep'), refNode('ai', 'agentInit'), refNode('de', 'divisionEvent'),
    refNode('fb', 'formBond'), refNode('ka', 'killAgent'), refNode('da', 'divideAgent'),
  ],
  centerBased: {
    enabled: true, maxAgents: 1000, maxBonds: 8,
    worldWidth: 100, worldHeight: 100,
    autoBond: true, growthRate: 0.02, agentUpdateMode: 'sync',
    // The shipped everything-on profile, so a NEW capability appears in this
    // reference automatically instead of needing a hand-edit here.
    agentCapabilities: { ...FULL_AGENT_PROFILE, charge: 'on' },
  },
  sprites: [{ id: 'sp', name: 'ref', dataUrl: '', mimeType: 'image/png' }],
  indicators: [{ id: 'ind', name: 'ref', kind: 'linked', dataType: 'integer', defaultValue: '0', accumulationMode: 'per-generation', watched: false }],
  mappings: [refMapping('om')],
  agentMappings: [refMapping('aom')],
};

function refMapping(id: string) {
  return {
    id, name: 'ref', description: '', isAttributeToColor: true, linked: true,
    redDescription: '', greenDescription: '', blueDescription: '',
  };
}

function GenerationPipelineReference() {
  const phases = useMemo(() => describeGenerationPipeline(REFERENCE_MODEL), []);
  const groups = useMemo(() => describePipelineGroups(REFERENCE_MODEL), []);
  let lastGroup: string | undefined;
  return (
    <ol className={styles.list}>
      {phases.map(p => {
        const head = p.group && p.group !== lastGroup ? groups[p.group]?.title : null;
        lastGroup = p.group;
        return (
          <li key={p.id}>
            {head && <><em>{head} &mdash;</em>{' '}</>}
            <strong style={p.owner === 'graph' ? { color: '#e8a13a' } : undefined}>{p.title}</strong>
            {' '}<span style={{ opacity: 0.7 }}>({TEMPO_LABEL[p.tempo]}{p.owner === 'graph' ? ', your graph' : ''})</span>
          </li>
        );
      })}
    </ol>
  );
}

// --- C3 (P8) — the engine capability matrix ---------------------------------
// GENERATED, never hand-written. `capabilityMatrix.gen.ts` is emitted by
// `node scripts/gen-capability-docs.mjs` from the tables the engine enforces
// with — the node registry, AGENT_NODE_REQUIREMENT, each agent target's OWN
// supported-type set, the WebGPU grid gate (probed, not transcribed) and the
// capacity constants. `--check` fails when the committed module is stale, so a
// node added to the catalogue cannot leave this table behind.
//
// Before this, Help claimed "around 115 selectable node types (42 agent)" while
// NODES_REFERENCE.md claimed 150 / 53. Both were typed by hand.

/** Per-target support cell. `exempt` = outside the set but running anyway (an
 *  event root, a lowered node, or a by-design CPU root) — NOT a gap. */
function SupportCell({ status }: { status: 'yes' | 'exempt' | 'no' }) {
  if (status === 'yes') return <span style={{ color: '#5cbf7a' }} title="Compiles on this engine">&#10003;</span>;
  if (status === 'no') return <span style={{ color: '#e07070' }} title="Not ported to this engine — using it clamps the agent layer to a CPU engine">&#10007;</span>;
  return <span style={{ opacity: 0.6 }} title="Runs on this engine anyway — it is an entry-point root, is lowered to other nodes before compiling, or runs on the CPU by design on every engine">&mdash;</span>;
}

function CapabilityMatrixReference() {
  const rows = useMemo(
    () => [...AGENT_NODE_MATRIX].sort((a, b) => a.label.localeCompare(b.label)),
    [],
  );
  return (
    <table className={`${styles.table} ${styles.matrix}`}>
      <thead>
        <tr>
          <th>Agent node</th>
          <th>Needs capability</th>
          <th style={{ textAlign: 'center' }}>WASM</th>
          <th style={{ textAlign: 'center' }}>WebGPU</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(r => (
          <tr key={r.type}>
            <td>{r.label}</td>
            <td>{r.capabilityLabel ?? <span style={{ opacity: 0.55 }}>always available</span>}</td>
            <td style={{ textAlign: 'center' }}><SupportCell status={r.wasmStatus} /></td>
            <td style={{ textAlign: 'center' }}><SupportCell status={r.webgpuStatus} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function GridRejectReference() {
  return (
    <table className={styles.table}>
      <thead><tr><th>Node</th><th>Rejected when</th><th>Why</th></tr></thead>
      <tbody>
        {WEBGPU_GRID_REJECTS.map((r, i) => (
          <tr key={`${r.type}-${i}`}>
            <td>{r.label}</td>
            <td>{r.condition || <em>any configuration</em>}</td>
            <td>{r.reason}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CapacityLimitsReference() {
  return (
    <table className={styles.table}>
      <thead><tr><th>Limit</th><th>Value</th><th>What it bounds</th></tr></thead>
      <tbody>
        {CAPACITY_LIMITS.map(l => (
          <tr key={l.key}>
            <td>{l.label}</td>
            <td style={{ fontVariantNumeric: 'tabular-nums' }}>{l.value.toLocaleString()}</td>
            <td>{l.note}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const sections = [
  { id: 'intro', label: 'What is GenesisCA' },
  { id: 'fundamentals', label: 'The 6 Fundamentals' },
  { id: 'modeler', label: 'The Modeler' },
  { id: 'nodes', label: 'Node Types Reference' },
  { id: 'macros', label: 'The Macro System' },
  { id: '3dgridca', label: '3D Grid CA' },
  { id: 'agents', label: 'Bond-Graph Agents' },
  { id: 'overseer', label: 'The Overseer (Experiments)' },
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
            Once visited, the app works <strong>fully offline</strong> &mdash; and that
            includes <strong>every model in the Models Library</strong>. The interface, the
            simulation engine, the library list, previews, macros and all bundled{' '}
            <code>.gcaproj</code> files are downloaded up front on that first visit, so a
            model opens on a plane even if you have never opened it before. (The bundle is
            around 50&nbsp;MB, downloaded once.)
          </p>
          <p className={styles.p}>
            When a new version is published, GenesisCA shows a small{' '}
            <strong>&ldquo;A new version is available&rdquo;</strong> banner with{' '}
            <strong>Update</strong> and <strong>Later</strong>. Nothing reloads until you
            click Update, so an update can never interrupt a running simulation or discard
            an unsaved model &mdash; if you have unsaved changes the banner says so. Choose
            Later and the update simply applies the next time you open the app.
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
          <p className={styles.p}>
            In the <strong>standalone desktop build</strong> every save &mdash; projects and
            saved states, presets and macros, exported results, <strong>video recordings</strong>{' '}
            and <strong>screenshots</strong> alike &mdash; opens a real OS <em>Save As</em>{' '}
            dialog so you choose the folder and filename, instead of dropping the file into a
            Downloads folder. Cancelling that dialog writes nothing &mdash; for a screenshot or a
            recording you simply land back in the capture review, with the picture or clip still
            in hand, and can try again or discard it deliberately.
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

          <h3 className={styles.h3}>Starting a model &mdash; the archetype chooser</h3>
          <p className={styles.p}>
            <strong>File &rarr; New</strong> asks what you are building rather than always handing
            you an empty 2D grid. Each card <em>seeds</em> a coherent starting point &mdash;
            topology and dimension, the agent capability profile, <em>Engine: Auto</em>, and the
            reproducibility contract &mdash; and every field it sets stays editable afterwards in
            the panel it belongs to. These are seeds, not a wizard.
          </p>
          <ul className={styles.list}>
            <li><strong>Classic CA (2D)</strong> / <strong>3D CA</strong> &mdash; a lattice of
              cells; the 3D card starts a 50&times;50&times;50 volume.</li>
            <li><strong>Particle system</strong> &mdash; force-driven points with soft-sphere
              collision. Declares <em>Statistical</em>, so Auto may use the GPU agent engine.</li>
            <li><strong>Flocking</strong> &mdash; sensing + steering forces + facing (the Boids
              profile). Also <em>Statistical</em>.</li>
            <li><strong>Bonded tissue / morphogenesis</strong> &mdash; the full soft-body cell:
              bonded, growing, dividing tissue with auto-bond and a bond store.</li>
            <li><strong>Graph automaton (GRA)</strong> &mdash; nodes joined by bonds the rule
              rewrites, with the long-range charge that keeps a grown graph open. Its profile is a
              custom mix (the shape the shipped GRA samples use), so the preset picker reads
              <em> Custom</em>.</li>
            <li><strong>CA on agents</strong> &mdash; a fixed lattice of static agents running a
              totalistic rule by sensing.</li>
            <li><strong>Empty</strong> &mdash; a bare 2D grid with nothing seeded.</li>
          </ul>
          <p className={styles.p}>
            On an agents card the grid width/height are the <em>agent world</em>: the agent frame is
            the grid frame, one to one. If the current model has unsaved changes you are still asked
            to confirm first &mdash; and cancelling the chooser afterwards keeps your model.
          </p>

          <h3 className={styles.h3}>Info Panel (I)</h3>
          <p className={styles.p}>
            The model&apos;s presentation metadata, kept in its own tab separate from the
            model&apos;s behavior: <strong>Name</strong>, <strong>Rule Author</strong>,{' '}
            <strong>GenesisCA Project Author</strong>, <strong>Summary</strong>,{' '}
            <strong>Rule Description</strong>, an optional <strong>Creation date</strong>, tags,
            and an optional <strong>Thumbnail</strong>.
          </p>
          <ul className={styles.list}>
            <li><strong>Rule Author</strong> &mdash; originator of the rule/formalism/paper (domain expert/researcher).</li>
            <li><strong>GenesisCA Project Author</strong> &mdash; who built this particular GenesisCA project file.</li>
            <li><strong>Summary</strong> &mdash; a short blurb; this is what appears on the model&apos;s Models Library card.</li>
            <li><strong>Rule Description</strong> &mdash; a longer free-form field to elaborate on how the rule works and document anything else worth keeping. Not shown on Library cards.</li>
            <li><strong>Creation date</strong> (optional) &mdash; when the model was made, as a plain date you set yourself (a <strong>Today</strong> button fills in the current date, <strong>Clear</strong> removes it). It travels inside the <code>.gcaproj</code>, appears on the model&apos;s Models Library card next to its grid size, drives the library&apos;s <em>Newest</em> / <em>Oldest</em> sort, and shows in a standalone export&apos;s About panel. It is deliberately <em>authored</em> rather than taken from the file: a file&apos;s timestamp changes every time it is rebuilt, copied or checked out, so it would say nothing about the model. Leave it blank and no date is shown anywhere &mdash; the model just sorts last under Newest/Oldest.</li>
            <li><strong>Simulator Instructions</strong> &mdash; optional usage notes for the people RUNNING the model (how to interact, what to try, what to look for). When present, the Simulator shows an <strong>&#x24D8; Instructions</strong> pill at the canvas&apos;s top-left that opens them in a dismissible card (line breaks preserved); standalone <code>.html</code> exports show them in the viewer&apos;s About panel too.</li>
            <li><strong>Thumbnail</strong> (optional) &mdash; attach a PNG, JPEG, GIF or WebP image, <em>or a WebM video clip</em> (up to 2&nbsp;MB) &mdash; the Simulator records WebM, so a short recording makes a natural thumbnail. It travels inside the <code>.gcaproj</code> file. When the model is shipped as part of the Models Library, hovering its card shows a floating preview; animated GIFs / WebPs play natively, and a WebM clip plays on loop (muted, no controls). The one place a clip is skipped is the <code>og:image</code> social tag of a standalone export &mdash; link scrapers need an image &mdash; everything else (the panel preview, the Library popover, the exported viewer&apos;s About panel) plays it.</li>
          </ul>

          <h3 className={styles.h3}>Properties Panel (P)</h3>
          <p className={styles.p}>
            Configure the model&apos;s structure (grid width/height, boundary treatment:
            torus or constant), execution mode and compile target, optional{' '}
            <strong>End Conditions</strong> for the simulator, and the Indicators list.
          </p>
          <ul className={styles.list}>
            <li><strong>End Conditions</strong> (optional) &mdash; auto-pause the simulator when a max generation count is reached or when any indicator satisfies a configured comparison (==, !=, &gt;, &lt;, &ge;, &le;). Scalar indicators compare against their value directly. For <strong>linked-frequency</strong> indicators (which produce a map of category &rarr; count) pick the specific category to monitor; the comparison then applies to the count of that category (e.g. binary <em>alive</em> &mdash; category <code>true</code>, <code>&ge;</code>, <code>100</code> pauses when at least 100 cells are alive). Decimal-binned frequency indicators can&apos;t be used in end conditions because their bin boundaries depend on runtime data &mdash; switch the aggregation to Total instead. For conditions that need graph-level logic add a <strong>Stop Event</strong> node inside the update graph &mdash; its DO flow input pauses the simulation with a user-defined message.</li>
            <li><strong>Engine</strong> &mdash; which backend evolves the cells. <strong>Auto (recommended)</strong> is the default for new models: it picks the fastest engine <em>this</em> model can use and shows what it picked (&ldquo;Auto &rarr; WebGPU&rdquo;) with the reason, and it re-picks as you edit &mdash; so it never lands on an engine your rule can&rsquo;t run on. <strong>WebAssembly</strong> is exact and seedable (f64 on one shared seeded stream, bit-identical to the JS reference) and typically several times faster than JS on dense neighborhoods. <strong>WebGPU</strong> runs WGSL compute shaders on the GPU &mdash; best for very large grids and math-heavy per-cell work; it needs synchronous mode and a browser with WebGPU (Chrome 127+, Firefox 141+, Safari 17.4+), and its parity is <em>statistical</em> (f32 + a per-cell RNG), so a fixed seed does not reproduce a run exactly. Under <strong>Advanced</strong> sits <strong>Debug / Reference (JS)</strong> &mdash; the readable semantic reference the other two are verified against, and the always-runnable fallback, but the slowest: useful for stepping through a rule in devtools, not for running models. Agents have their own independent <strong>Agent Engine</strong> radio with the same four choices. Switching restarts the simulator (grid state is lost). All engines apply <em>value sinking</em>: per-cell value computations consumed only inside one switch case or if branch are emitted <em>inside</em> that branch, so cells in different states only pay for the work their branch needs &mdash; sparse type-dispatch models (e.g. Wireworld with mostly Empty cells) gain most. A side effect: if your model calls <em>Get Random</em> inside a branch, cells that don&rsquo;t enter that branch no longer advance the RNG &mdash; the same seed produces different output than older builds did.</li>
            <li><strong>WebGPU stop-check interval</strong> (advanced, WebGPU only) &mdash; Properties &rarr; Execution exposes an integer spinbox below the compile-target radio. It defaults to <code>1</code> &mdash; check the GPU stop flag after every step, exact stop-event timing. Higher values amortise the per-step <code>mapAsync</code> stall so big batches run faster, but a stop event firing at gen <em>n</em> may surface up to <em>K</em>&minus;1 generations later. The last step of every batch is always checked, so a stopped run never overshoots beyond the current play batch. JS and WASM ignore this setting.</li>
            <li><strong>Skip Isolated Empty Cells</strong> (opt-in large-grid optimization) &mdash; in a growth / accretion model, most cells are empty and far from the structure, yet every generation normally runs the full rule on all of them. Tick this and define what &ldquo;empty&rdquo; means (<strong>a cell attribute + the value</strong>) plus a <strong>processing range</strong> (a neighbourhood or a distance): only cells within the range of a non-empty cell run the Generation Step + colour pass &mdash; the growing <em>surface</em> &mdash; and the big precomputed neighbour tables are replaced by inline computation, so huge grids (the Accretor's 300&sup3; = 27M cells) load in seconds and step interactively. Results are <em>identical</em> to the full loop as long as your range covers the rule's neighbourhood reads (e.g. a radius-1 box for a Moore-neighbourhood rule) &mdash; that's your responsibility, which is why the feature is opt-in. Painting is never gated: brush any isolated cell and it activates from the next step. Synchronous CA-grid models only (async is incompatible by design); agent-topology models (whose field deposits happen outside the step) and glyph-drawing models keep the full loop, as does a constant-boundary model whose boundary value makes the empty-defining attribute non-empty (the always-non-empty boundary means no range could cover it); on the WebGPU target the feature is ignored and the full loop runs (same results, no speedup).</li>
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
            (binary, integer, decimal, tag, vector, color), a default value, and a description.
          </p>
          <ul className={styles.list}>
            <li><strong>Tag</strong> &mdash; An integer with named values (picklist). Define tag options in the editor, and use the Tag Constant node to reference them by name.</li>
            <li><strong>Vector</strong> (cell &amp; agent attributes) &mdash; a 2D or 3D direction stored as one named value (a flow field, a facing/orientation, an accumulated force) instead of hand-maintaining separate X/Y/Z scalars. A single <em>vector</em> port appears on Get/Set (Self) Attribute, <strong>Get/Set Neighbor Attr</strong> (read/write a neighbour&apos;s vector), <strong>Get Agent Attribute</strong> / a by-id <strong>Set Attribute</strong> (read/write another agent&apos;s vector), and <strong>Transfer Cell Attributes</strong>; wire it to Make Vector / Break Vector / Vector Op. Under the hood the vector is stored as its scalar float components, so it runs natively on all three compile targets. <strong>Local Variables</strong> can be vectors too (e.g. accumulate a force over neighbours with one variable). 3D vectors are offered only in a 3D model. (A few nodes have no single-vector shape &mdash; array-of-neighbours reads and Update Attribute&apos;s increment/max/&hellip; &mdash; read those via a scalar node + Break Vector; the modeler badges them.)</li>
            <li><strong>Color</strong> (model attributes only) &mdash; An RGBA color value. Accessed via Get Model Attribute with separate R, G, B and A output ports. Stored as <code>#rrggbb</code> (fully opaque) or <code>#rrggbbaa</code>; alpha is always available, defaulting to opaque. Adjustable live in the simulator.</li>
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
              WebGPU) across every node in the catalogue &mdash; including
              Aggregate median and GroupOperator random, which now run on the
              WebGPU grid too (the WebGPU grid sorts in a per-thread WGSL loop
              and draws from its per-cell RNG).
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
            <strong>Parametric shape</strong> &mdash; the block above the grid generates a named
            neighbourhood in one click, the 2D counterpart of the 3D parametric editor:
          </p>
          <ul className={styles.ul}>
            <li><strong>Moore</strong> (box, L&infin;) &mdash; radius 1 gives the classic 8
              surrounding cells.</li>
            <li><strong>von Neumann</strong> (diamond, L1) &mdash; radius 1 gives the 4 cardinal
              neighbours, radius 2 gives 12.</li>
            <li><strong>Disk</strong> (filled disc, L2) &mdash; every cell within the radius,
              rounded to the nearest cell.</li>
            <li><strong>Range-N</strong> &mdash; a radius plus a <em>metric</em> selector
              (L&infin; / L1 / L2), so one entry reproduces the box / diamond / disc families
              (Larger-than-Life style).</li>
            <li><strong>Ring</strong> &mdash; an annulus at a radius, with a width (MNCA-style
              rings without drawing two circles).</li>
          </ul>
          <p className={styles.p}>
            The hint under the button previews how many cells the current settings would
            generate. <strong>Generate shape</strong> replaces the current cells and clears any
            cell tags (a regenerated shape renumbers every cell, and tags are keyed by
            position in that list); the centre cell is a separate flag and is left untouched.
            The grid&apos;s margin grows automatically when a shape reaches past it, so nothing
            is ever generated outside the visible grid. Editing the grid by hand afterwards
            drops the stored shape &mdash; the summary then reads <em>custom</em> &mdash; so the
            remembered parameters can never disagree with the cells they claim to describe.
          </p>
          <p className={styles.p}>
            <strong>Drawing tools</strong> &mdash; the row of buttons above the grid speeds up
            hand-tuning and big neighborhoods (MNCA-style radii and rings):
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

          <h4 className={styles.h3}>Input Mapping Parameters (what the brush hands your graph)</h4>
          <p className={styles.p}>
            A Color-to-Attribute mapping used to have one fixed interface: three numbers
            called <code>R</code>, <code>G</code>, <code>B</code>, fed by a color picker.
            If your brush really meant &ldquo;<em>species = Predator, energy = 40, hungry =
            true</em>&rdquo;, you had to encode that in a color and decode it again in the
            graph. Now each input mapping declares its own <strong>parameters</strong>.
          </p>
          <ul className={styles.ul}>
            <li>
              In the Mappings panel, select a Color-to-Attribute mapping and edit its
              <strong> Parameters</strong> list. Each row is a <em>name</em> and a
              <em> type</em> &mdash; binary, integer, decimal, tag or color &mdash; plus
              optional details (min/max for numbers, the option list for a tag, a default).
              A description per parameter documents what the graph does with it.
            </li>
            <li>
              Every parameter becomes an <strong>output port</strong> on that mapping&rsquo;s
              Input Mapping event node, and one <strong>widget in the brush panel</strong>.
              A <em>color</em> parameter is three ports (<code>tint_r</code>,{' '}
              <code>tint_g</code>, <code>tint_b</code>) but a single swatch in the brush
              panel &mdash; the split is an engine detail.
            </li>
            <li>
              <strong>Nothing changes until you ask it to.</strong> A mapping you never
              touch keeps the classic R/G/B color brush, and its compiled rule is
              byte-for-byte what it was before parameters existed. The editor opens showing
              that default as one <em>Brush colour</em> row you can rename, retype or extend.
            </li>
            <li>
              <strong>Renaming a parameter never moves a wire.</strong> Deleting one (or
              retyping between color and a scalar, which changes how many ports it has)
              <em> removes</em> the wires that came out of the ports that no longer exist &mdash;
              they are dropped, never quietly re-aimed at a neighbouring value. A leftover
              wire in a hand-edited file is reported by name at compile time.
            </li>
            <li>
              <strong>Every parameter has a default</strong>, edited right under its type.
              That is what the brush row starts at before you touch it, what an untouched
              brush actually paints, and what an image import seeds a constant channel with
              &mdash; so a parameter that is usually &ldquo;1.0&rdquo; or &ldquo;alive&rdquo;
              should say so instead of making everyone dial it in. In the brush panel a
              row that differs from its default grows a small <code>⟳</code> to put it back.
            </li>
            <li>
              <strong>Give a number a range and its brush row becomes a slider.</strong> Set
              both <em>min</em> and <em>max</em> and the simulator shows a slider next to the
              number field, exactly like a bounded model attribute. Leave either blank and you
              get the plain number field. (The bounds shape the brush widget; they are not
              clamped by the engine.)
            </li>
            <li>
              <strong>A tag parameter carries the option INDEX.</strong> That is the whole
              payload &mdash; 0, 1, 2 &hellip; &mdash; on every compile target. So an
              <em> inline</em> option list is ad-hoc: it names the choices for <em>you</em>, in
              the brush panel, but nothing else in the model knows those names, and a
              Get&nbsp;Constant / Compare / Switch in the graph can only compare the number.
              If you want the names in the graph too, point the parameter at an existing
              <strong> tag attribute</strong> instead of listing options inline: the payload is
              the identical index, but now every tag-aware node can pick the option by name.
              The editor prints the live index map (<code>0=idle, 1=walk, …</code>) under an
              inline list so the mapping between the two is never a guess.
            </li>
            <li>
              <strong>Agents work the same way</strong> &mdash; and additionally choose a
              <strong> brush kind</strong>: an <em>Editor</em> brush runs the graph on every agent it
              covers, a <em>Spawner</em> brush runs it once where you click and hands it the brush
              position + radius so the graph can create agents itself.
            </li>
          </ul>

          <h4 className={styles.h3}>Transparency (alpha)</h4>
          <p className={styles.p}>
            Every color picker is <strong>RGBA</strong>. Click a color swatch and the popover
            offers the color plus an <strong>Alpha</strong> slider (0 = fully transparent,
            255 = opaque). The swatch itself is drawn over a checkerboard showing the real
            composite, so you can see transparency at a glance rather than reading a number.
          </p>
          <ul className={styles.ul}>
            <li>
              <strong>Alpha is optional everywhere.</strong> A color you never make
              transparent stays exactly as it was &mdash; it saves as <code>#rrggbb</code>,
              and the compiled rule is byte-for-byte what it was before alpha existed. Only a
              color you actually make translucent widens to <code>#rrggbbaa</code>.
            </li>
            <li>
              <strong>The A output port appears when you use it.</strong> Color Scale,
              Categorical Color and Color Constant show an <strong>A</strong> output only once
              a palette entry declares a non-opaque alpha. Set every entry back to 255 and the
              port goes away again. (Get Model Attribute always shows <strong>A</strong> for a
              color attribute &mdash; its alpha always exists.)
            </li>
            <li>
              <strong>What alpha does when rendered:</strong> in 2D it composites over
              whatever is behind the cell; in the <strong>3D</strong> view an
              alpha of <strong>0</strong> makes the cell vanish entirely (it is not drawn at
              all &mdash; the standard way to hide &ldquo;empty&rdquo; cells in a volume), and
              partial alpha blends when <em>Alpha blend</em> is enabled in the 3D View panel.
              Agents honour their color&rsquo;s alpha too.
            </li>
            <li>
              A <strong>Linked</strong> mapping wires alpha automatically once its palette has
              any; an all-opaque palette behaves exactly as before. In a hand-built pass, wire
              the <strong>A</strong> output into Set Cell Looks&rsquo; <strong>A</strong> input.
            </li>
          </ul>
          <p className={styles.p}>
            Note: the <em>Color&rarr;Attribute</em> (brush / image import) direction is still
            RGB &mdash; painting and image import ignore alpha for now.
          </p>

          <h3 className={styles.h3}>Indicators (Properties Panel)</h3>
          <p className={styles.p}>
            Indicators are quantitative variables that monitor CA evolution beyond visual
            feedback. They are defined in the <strong>Properties</strong> panel under the
            &quot;Indicators&quot; section &mdash; click an indicator in the list to edit it in a
            side panel (the same master-detail layout as Attributes, Neighborhoods, and Mappings).
            Select one and click <strong>Duplicate</strong> to clone it with a fresh id. Three kinds
            exist:
          </p>
          <ul className={styles.list}>
            <li><strong>Standalone</strong> &mdash; Typed scalar values (binary, integer, decimal,
            or tag) that can be read and written by graph nodes (Get Indicator, Set Indicator,
            Update Indicator). They act as accumulators inside the step loop.</li>
            <li><strong>Linked</strong> &mdash; Automatically computed from an existing cell
            attribute after each step. The aggregation mode depends on the attribute type:
            Binary and Tag support Frequency (count per value); Integer and Decimal support
            Total (sum) or Frequency.</li>
            <li><strong>Graph</strong> (Bond-Graph Agents only &mdash; the &quot;+ Graph&quot;
            button appears when the Agents topology is on) &mdash; a graph-global measurement of
            the agent population, computed by the worker after the structural phase so it always
            reports the SETTLED graph. Pick a <strong>Graph Metric</strong>: <em>Node count</em>
            (live agents), <em>Edge count</em> (distinct bonds, via the handshake lemma
            &Sigma;degree / 2), <em>Mean degree</em>, <em>Max degree</em>,
            <em>Degree histogram</em> (how many agents have each degree 0..Max Bonds &mdash;
            frequency-shaped, so it charts through the same Bars / Lines / Stack views a
            linked-frequency indicator uses) and <em>Connected components</em> (union-find; each
            isolated agent counts as one). Metrics are only computed when an indicator asks for
            them, and connected components &mdash; the only non-trivial one &mdash; costs about
            2&nbsp;ms at 20&nbsp;000 agents. Graph indicators are read-only (no node writes them)
            and are readable from the Overseer with <strong>Read Indicator</strong>, which is how
            a rule-space sweep measures what a rewriting rule actually did.</li>
          </ul>
          <p>
            <strong>Feeding a measurement back into a rule.</strong> <strong>Get Indicator</strong>
            reads any indicator whose value is a <em>single number</em> &mdash; standalone, a linked
            <em> Total</em>, or a scalar graph metric &mdash; on the Cells graph and the Agents graph
            alike, and on every compile target. So a rewriting rule can gate on its own
            measurement (&quot;stop dividing past N nodes&quot;, &quot;modulate by mean degree&quot;).
            Indicators with no single value &mdash; a frequency map, a degree histogram, a spatial
            curve &mdash; are still listed in the picker but <em>disabled</em>, with the reason shown,
            so it is always clear why one cannot be chosen. A computed value is read as of the
            <em> end of the previous generation</em> (the same one-step lag as neighbour density),
            and it is refreshed every generation &mdash; never once per frame &mdash; so the number a
            rule sees never depends on the Gens/Frame setting. <strong>Set Indicator</strong> and
            <strong> Update Indicator</strong> stay standalone-only: a linked or graph value is
            computed from the model, so writing it would just be overwritten next generation.
          </p>
          <ul className={styles.list}>
          </ul>
          <p className={styles.p}>
            Standalone and Linked indicators have an <strong>Accumulation Mode</strong>: &quot;Per
            Generation&quot; resets every step, while &quot;Accumulated&quot; keeps a running
            total across generations (reset on simulator reset). Graph indicators have none
            &mdash; they are an instantaneous measurement of the current graph, not a per-step
            quantity to sum.
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
            <strong>Y ticks</strong> (how many axis labels, 2&ndash;11), a{' '}
            <strong>Window</strong> (how many most-recent generations to show on the time
            axis &mdash; leave blank to show all stored history), and a color picker
            per series. Stored history is always bounded (capped at 5000 samples per series),
            so &quot;all&quot; can never grow without limit. With a fixed axis the chart stops
            re-scaling as values evolve, so
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
            rectangular) matrix. Each axis has an independent <em>key
            source</em> &mdash; <strong>Custom labels</strong> (an arbitrary set of
            row/column names you add, remove, and rename right on the definition page),
            a face-label palette, a tag attribute, or{' '}
            <strong>Single value (map)</strong> &mdash; so a table can be keyed by faces
            (e.g. analyte&nbsp;&times;&nbsp;CD faces), by cell type (e.g.
            empty/water/amphi), or by your own labels. Choosing <em>Single value</em> for one axis collapses the
            table into a 1-D <strong>map</strong>: a single column (or row) keyed
            only by the other axis&apos;s tag &mdash; no need to invent a throwaway
            single-option tag attribute. The cell <strong>value type</strong> is selectable
            (Binary / Integer / Decimal / Tag &mdash; Decimal by default), with a
            type-appropriate per-cell editor (Binary cells are checkboxes). A Tag value
            type takes its labels either from a manual list or from an existing tag
            attribute (like an axis can). A pure tag&times;tag table needs no faces, so it
            works even with Variegated Cells off. Live-tuneable in the simulator like any
            other model attribute (matrix shown directly under the attribute name).
          </p>
          <p className={styles.p}>
            A table can also be <strong>multi-axis</strong> (up to 6 axes) instead of just
            rows&nbsp;&times;&nbsp;columns &mdash; switch the <em>Axes mode</em> to Multi-axis
            and add one axis per index. A new axis kind, <strong>Integer range</strong>{' '}
            (min&hellip;max), is the natural fit for count-indexed rule tables. The Table
            Lookup node then shows one input per axis (labeled with your axis names), and the
            editor shows the table as 2-D slices with steppers for the outer axes. This is
            what makes rule-table CA families like the <strong>Accretor</strong> (a 3D
            accretion automaton whose rule is indexed by
            state&nbsp;&times;&nbsp;face/edge/corner neighbour counts) expressible. The{' '}
            <strong>Randomize</strong> block fills the whole table from a seed at a chosen
            density &mdash; the seed <em>is</em> the rule identity (same seed &rArr; same
            structure), so re-roll it to grow an entirely different form. For Decimal-valued
            tables the roll also takes a <strong>Min / Max range</strong> &mdash; signed
            ranges like &minus;1&hellip;1 make attraction/repulsion matrices (the{' '}
            <strong>Particle Life</strong> samples&rsquo; rules matrix). Integer- and
            Tag-valued tables likewise take a <strong>Min</strong> (and Integer a{' '}
            <strong>Max</strong>): rolled entries draw uniformly from Min&hellip;Max
            (Tag: Min is the lowest option <em>index</em> a rolled entry may take).
          </p>
          <p className={styles.p}>
            Decimal-valued tables open in a <strong>Matrix view</strong> built for play:
            each cell is a colour swatch (red&nbsp;=&nbsp;repel, cyan&nbsp;=&nbsp;attract,
            saturation&nbsp;=&nbsp;magnitude) &mdash; <strong>drag a cell horizontally</strong>{' '}
            to adjust it, click to select, Ctrl+click to multi-select, and use the slider
            below to edit the selection (or every cell at once when nothing is selected).
            Square tables add a <strong>Fill pattern</strong> menu (uniform or symmetric
            random, snake, rock&ndash;paper&ndash;scissors, chains, bipartite,
            hub&nbsp;&amp;&nbsp;spokes, shells, swirl, dimers, triad flocks) plus
            Zero&nbsp;/ Symmetrize&nbsp;/ Transpose&nbsp;/ Negate&nbsp;/ Mutate quick
            actions. A <em>#&nbsp;Values</em> toggle restores the classic number grid.
            Everything works live in the Simulator&rsquo;s left-panel Model Attributes
            section while the model runs. An axis (or a Tag value type) can also be keyed by
            an <strong>agent</strong> tag attribute &mdash; the Particle Life samples key
            all three of their tables (rules&nbsp;/ attractMin&nbsp;/ attractMax) by the
            agents&rsquo; <em>species</em> tag, with per-pair minimum and maximum radii just
            like the original.
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
              by a row index and a column index (or one index per axis for a multi-axis
              table) &rarr; decimal. (Indices come from face labels, tag reads, or neighbour
              counts, depending on the table&apos;s key sources.)</li>
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
            (not on a state restore). Useful for procedural initial state:
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

          <h3 className={styles.h3}>Grid Init Event Node</h3>
          <p className={styles.p}>
            The <strong>Grid Init Event</strong> is the <em>global</em>, free-form counterpart
            to the per-cell Init Event &mdash; it runs <strong>exactly once</strong> on Reset (and
            first load), the same way the <em>Agent Init Event</em> runs once to spawn agents.
            Because the per-cell Init Event runs for every cell, it can only answer &quot;should
            <em> this</em> cell be seeded?&quot;; the Grid Init Event instead lets you <strong>loop
            and write arbitrary cells</strong>, so you can express imperative seeding it can&apos;t
            &mdash; place N random seeds, draw a line or shape, or seed a box in the middle.
          </p>
          <p className={styles.p}>
            It outputs the grid dimensions &mdash; <code>width</code>, <code>height</code>, and
            (in 3D) <code>depth</code> &mdash; so your seeding stays grid-size-independent (seed
            the middle at <code>width/2</code>). Inside its <code>DO</code> chain, wire a
            <strong> Loop</strong> (or nested Loops) and use the new <strong>Set Cell (at
            Position)</strong> node to write a cell attribute at an absolute <code>X</code>,
            <code>Y</code> (and <code>Z</code> in 3D) position (out-of-range positions are
            skipped). A Local Variable makes a handy loop counter. It has <em>no current
            cell</em>, so Get Cell Attribute / Get Cell Position don&apos;t apply here &mdash;
            write with Set Cell (at Position). Singleton; runs on every compile target
            (WebAssembly / WebGPU / JS).
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
              type is binary / integer / decimal / tag / <strong>vector</strong>.</li>
            <li><strong>Vector variables</strong> &mdash; a scalar variable can hold a whole
              2D/3D <strong>vector</strong> (pick <em>Vector (2D)</em> / <em>Vector (3D)</em> in
              the variable&apos;s Data Type dropdown; the Initial Value row becomes one field per
              component). This is the natural shape for a per-cell / per-agent{' '}
              <em>accumulator</em> &mdash; sum a force over the neighbours into ONE variable
              instead of hand-maintaining <code>sumX</code> / <code>sumY</code> floats. Get / Set
              Variable then carry a single <em>vector</em> port, so they wire straight to{' '}
              <strong>Make Vector</strong> / <strong>Break Vector</strong> /{' '}
              <strong>Vector Op</strong>. Under the hood the variable is split into its scalar
              float components before compiling, so it runs natively on all three targets with no
              extra cost. <em>Vector (3D)</em> is offered only in a 3D model, and a vector is a
              scalar-only type &mdash; switching Kind to <em>array</em> resets it to Decimal
              (there are no arrays of vectors).</li>
            <li><strong>Get Variable</strong> &mdash; reads the current value (scalar &mdash;
              including a whole vector) or the underlying array (array variables &mdash; iterate
              it like any array source: Aggregate, Group Reduce, Get Array Element, For Each In
              Array).</li>
            <li><strong>Set Variable</strong> &mdash; assigns to a scalar variable (a vector
              variable takes a whole vector on one wire).</li>
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
            <li><strong>Copy / paste <em>between models</em></strong> &mdash; <kbd className={styles.kbd}>Ctrl+C</kbd> / <kbd className={styles.kbd}>Ctrl+X</kbd> / <kbd className={styles.kbd}>Ctrl+V</kbd> (and the menu items) work <strong>across browser tabs</strong>: copy a piece of graph in one tab and paste it into a different model open in another tab &mdash; no need to save and import a macro for a couple of nodes. Nodes, wires, groups, comments and reroutes all travel, and any <strong>macro</strong> in the selection brings its definition along (including macros nested inside it), imported into the target project as an independent copy. Nodes that referenced an attribute / neighborhood / mapping / indicator of the <em>source</em> model arrive with the usual amber <strong>!</strong> badge so you can point them at the matching element here &mdash; exactly like importing a macro. The two graphs stay separate: a selection copied on the Agents graph can only be pasted on an Agents graph, and the paste item says so. A very large selection (over ~2&nbsp;MB) stays within its own tab.</li>
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

          <h3 className={styles.h3}>Insert a Node Into a Wire (press and hold)</h3>
          <p className={styles.p}>
            <strong>Press and hold</strong> the left mouse button on a wire for about half
            a second and the <strong>Add Node</strong> menu opens right there, listing only
            the nodes that are <strong>compatible with that wire&rsquo;s source</strong>
            (plus <em>Reroute</em>). Pick one and it is <strong>spliced into the
            link</strong>: the source connects to the new node&rsquo;s first matching
            input, the original wire is removed, and &mdash; if the new node has an output
            the old consumer can accept &mdash; that output is wired straight on to it.
          </p>
          <p className={styles.p}>
            So a <em>Get Constant &rarr; Set Attribute</em> wire, held and given a
            <strong> Math</strong> node, becomes <em>Get Constant &rarr; Math &rarr; Set
            Attribute</em> in one gesture. On a <strong>flow</strong> wire the new
            node&rsquo;s <em>NEXT / DONE</em> continuation takes over the old target, so
            holding a flow link and picking <em>If / Then / Else</em> gives
            <em> Step &rarr; If &rarr; (DONE) &rarr; the old node</em>. If the chosen node
            has no output the old consumer can take, it is still inserted on the input side
            and the consumer is simply left unconnected. The whole splice is
            <strong> one undo step</strong>. A quick click still selects the wire, and
            moving the mouse before the half second is up cancels the hold.
          </p>

          <h3 className={styles.h3}>Reroute Points</h3>
          <p className={styles.p}>
            A <strong>reroute</strong> is a small movable dot you place on a wire to
            bend it around other nodes &mdash; and to fan one output out to many places
            without long crossing wires. To create one, <strong>press and hold</strong>
            a wire and pick <strong>&quot;Reroute&quot;</strong> (the first entry in the
            menu): the dot is dropped where you held, splitting the wire. Once placed, a
            reroute is an ordinary node &mdash; <strong>drag it to move it</strong>, and it
            moves along with a multi-selection just like any other node. You can also drag a
            wire off an output port, release on empty canvas, and pick
            <strong>&quot;Reroute&quot;</strong> from that menu.
          </p>
          <p className={styles.p}>
            A reroute always carries an <strong>output</strong>, so it has one input
            (the wire feeding it) and as many outputs as you like &mdash; drag from it to
            send the same value to several nodes. You can also chain reroutes
            (<em>wire &rarr; reroute &rarr; reroute &rarr; node</em>) to route around large
            areas. Reroutes are purely cosmetic: they have <strong>no effect</strong> on
            the simulation &mdash; a wire through a reroute behaves exactly like a direct
            connection. Deleting a reroute removes it and all of its links &mdash; to take
            one out while <em>keeping</em> the connection, use
            <strong> Dissolve</strong> instead: <strong>double-click the dot</strong> (or
            right-click it &rarr; <strong>Dissolve Reroute</strong>) and everything it fed
            is rewired straight to whatever was feeding it. In a chain, only the reroute
            you clicked goes, so the rest of the chain stays put.
            To clear several at once, <strong>select them and right-click &rarr;
            &quot;Dissolve Reroutes&quot;</strong> &mdash; they all go in one step (a single
            undo), each consumer landing on the nearest source that is <em>not</em> being
            dissolved, so dissolving a whole chain wires its end straight to the start. A
            mixed selection dissolves only the reroutes and leaves everything else alone.
            A new reroute is <strong>named after the port it relays</strong> (or, when placed
            on another reroute&rsquo;s wire, after that reroute&rsquo;s &mdash; possibly renamed
            &mdash; label), shown above the dot.
            <strong> Right-click a reroute &rarr; Rename</strong> to change it;
            clearing the name removes the label.
          </p>

          <h3 className={styles.h3}>Dissolve Node</h3>
          <p className={styles.p}>
            The same idea as dissolving a reroute, for an ordinary node:
            <strong> right-click a node &rarr; &quot;Dissolve Node&quot;</strong> removes it
            but <strong>keeps the connections</strong>. Everything it fed is rewired
            straight to whatever was feeding it, wherever the two ends can legally connect.
          </p>
          <ul className={styles.list}>
            <li>For a <strong>flow</strong> node this splices it out of the chain &mdash; the
              node before it runs the node after it. It is the exact inverse of holding a
              wire to insert a node into it.</li>
            <li>For a <strong>value</strong> node the consumer lands on the first input whose
              source it can accept &mdash; so dissolving a Math node in
              <em> Get Attribute &rarr; Math &rarr; Compare</em> leaves
              <em> Get Attribute &rarr; Compare</em>.</li>
            <li>A node with <strong>several outputs</strong> relinks all of them, so
              dissolving an <em>If / Then / Else</em> makes both branches (and its DONE
              chain) run unconditionally rather than leaving them orphaned.</li>
            <li>Where <strong>no legal pairing</strong> exists (the types don&rsquo;t match, or
              nothing was feeding the node) the consumer is simply left unwired &mdash;
              GenesisCA never invents a connection you could not have drawn yourself.</li>
            <li>Not offered for event roots (Generation Step, Behaviour Step&hellip;) or for a
              macro&rsquo;s own Input / Output nodes. <strong>Ctrl+Z</strong> restores the node
              and its original wiring in one step.</li>
          </ul>

          <h3 className={styles.h3}>Morph Into</h3>
          <p className={styles.p}>
            Picked the wrong node type, or outgrew it? <strong>Right-click a node &rarr;
            &quot;Morph into&quot;</strong> lists the types it can become. The node is
            converted <strong>in place</strong> &mdash; it keeps its position, its name and,
            wherever the ports still fit, its wires. Available conversions:
          </p>
          <ul className={styles.list}>
            <li><strong>Math &harr; Math Expression</strong> &mdash; turn a Math node into the
              equivalent formula (and back, when the formula is a single operation).</li>
            <li><strong>Compare &harr; Logical Expression</strong> &mdash; grow a comparison
              into a boolean formula you can extend with AND / OR / NOT.</li>
            <li><strong>Logic &rarr; Logical Expression</strong>, and
              <strong> Logical Expression &rarr; Logic</strong> when the formula is one
              AND / OR / XOR / NOT.</li>
            <li><strong>Math &harr; Compare</strong> &mdash; compute with the two operands
              instead of comparing them, or the reverse.</li>
            <li><strong>Math Expression &harr; Logical Expression</strong> &mdash; the two
              formula nodes are twins, so every port, name and the formula text carry over.</li>
          </ul>
          <p className={styles.p}>
            Two things worth knowing. An operand that is <strong>not wired</strong> is baked
            into the new formula as its value, so <em>Compare X &gt; 3</em> becomes the
            formula <code>a &gt; 3</code> on a node with a single input. And a wire that no
            longer fits the new node is <strong>dropped, never re-aimed</strong> at a
            different port &mdash; e.g. morphing Math into Compare narrows its output to a
            yes/no value, so a consumer that needs a number lets go. Some conversions are
            hidden when they would not be meaningful (a Compare set to <em>Neighbor Index</em>
            offers none). <strong>Ctrl+Z</strong> undoes a morph completely.
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
            current zoom). Each node is drawn in a faded version of its real colour, so you
            can read the shape of the graph at a glance — the white event roots, the category
            colours of the nodes, and your comments and groups as softer background blocks.
            The part you are currently looking at is outlined by a light rectangle; nothing
            is dimmed, so the whole map stays equally readable.
          </p>
        </section>

        {/* ============================================================ */}
        <section id="help-nodes" className={styles.section}>
          <h2 className={styles.h2}>Node Types Reference</h2>
          <p className={styles.p}>
            GenesisCA provides <strong>{NODE_COUNTS.selectable} selectable node types</strong>{' '}
            ({NODE_COUNTS.agent} of them agent nodes, {NODE_COUNTS.overseer} Overseer nodes)
            organized into the categories below.
            The palette only shows the ones available for your model &mdash; async-only and
            Variegated-Cells nodes are hidden until you enable those features.
            {' '}<em>(These counts are generated from the node registry itself, so they cannot
            drift &mdash; see &ldquo;Engine capability matrix&rdquo; below.)</em>
          </p>

          <h3 className={styles.h3}>
            <span className={styles.nodeCategory} style={{ background: '#2e7d32' }}>Event</span>
            Event Entry Points
          </h3>
          <table className={styles.table}>
            <thead><tr><th>Node</th><th>Description</th></tr></thead>
            <tbody>
              <tr><td>Generation Step</td><td>Entry point for per-generation cell update logic. Connect &quot;DO&quot; to start the flow chain. Singleton.</td></tr>
              <tr><td>Init Event</td><td>Runs once per cell on simulator <strong>Reset</strong> (after defaults, before the first color pass; not on a state restore). Outputs <code>x</code>, <code>y</code>, <code>maxX</code>, <code>maxY</code> (plus <code>z</code>, <code>maxZ</code> in 3D models). Singleton. Useful for procedural initial state (gradients, noise, random orientations).</td></tr>
              <tr><td>Grid Init Event</td><td>Runs <strong>once globally</strong> on Reset (and first load) &mdash; the free-form counterpart to the per-cell Init Event. Loop inside <code>DO</code> and write arbitrary cells with <strong>Set Cell (at Position)</strong> to seed procedurally (random seeds, shapes, a middle box). Outputs <code>width</code>, <code>height</code> (plus <code>depth</code> in 3D). Singleton; no current cell.</td></tr>
              <tr><td>Input Mapping (C&rarr;A)</td><td>Entry point for Color-to-Attribute mapping (brush/image import). Its value outputs are the <strong>parameters its mapping declares</strong> &mdash; one port per parameter (three for a <em>color</em> one). A mapping that declares none keeps the classic <code>R</code>, <code>G</code>, <code>B</code> outputs. See &ldquo;Input Mapping Parameters&rdquo; under Mappings.</td></tr>
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
              <tr><td>Assert Active Output Mapping</td><td>Runs its <strong>IF ACTIVE</strong> branch only while the chosen Attribute-to-Color mapping is the viewer currently selected in the simulator; <strong>DONE</strong> runs either way. Use it to fence off work that exists purely to be <em>looked at</em> &mdash; a smoothed field, a debug gradient, a per-cell statistic &mdash; so it costs nothing while you are viewing something else. Because IF ACTIVE is a real branch, the engine also <em>sinks</em> the values only that branch consumes inside the guard, so the computation itself is skipped, not just the write. Available on the Cells graph (all three engines).</td></tr>
              <tr><td>Sequence</td><td>Execute &quot;First&quot; then &quot;Then&quot; sequentially.</td></tr>
              <tr><td>Loop</td><td>Repeat &quot;Body&quot; a given number of times. The <strong>Index</strong> output carries the current iteration (0-based) &mdash; only valid inside the Body chain. A <strong>Range</strong> mode replaces Count with <strong>From</strong>/<strong>To</strong> inputs: Index then runs From..To <em>inclusive</em> (ascending; From &gt; To runs zero times) &mdash; the natural &quot;for i = n to m&quot; shape. Works on every graph (cells, agents, overseer) and every compile target.</td></tr>
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
              <tr><td>Get Cell Attribute</td><td>Read the current cell&apos;s attribute value (e.g., &quot;alive&quot;). Supports multiple attribute <strong>slots</strong> (&quot;+ Attribute&quot;): one node reads several attributes, each through its own output port &mdash; no need for a separate Get node per attribute.</td></tr>
              <tr><td>Get Cell Position</td><td>Outputs the current cell&apos;s grid coordinates &mdash; <strong>Row</strong>, <strong>Col</strong>, and (in 3D) <strong>Layer</strong>. A controlled, own-cell-only break of locality so a cell can behave by where it is: spatial gradients, region-specific rules, or a coordinate-aware Output Mapping. Works in every event.</td></tr>
              <tr><td>Get Grid Dimensions</td><td>Outputs the <strong>size of the world</strong> &mdash; <strong>Width</strong>, <strong>Height</strong>, and (in 3D) <strong>Depth</strong>. Use it to write a rule that doesn&apos;t care how big the grid is: seed the middle, normalise a coordinate to 0&ndash;1, or fade by distance from an edge &mdash; instead of typing the numbers in and having them go silently wrong the moment you resize the grid. Tick <strong>Output center</strong> to also get the grid centre directly (<strong>Center X/Y</strong> = &lfloor;size&divide;2&rfloor;, plus <strong>Center Z</strong> in 3D) with no hand-wired &divide;2 arithmetic. Works in every event, and on the <strong>Agents</strong> graph too (there it&apos;s called <strong>Get World Dimensions</strong> &mdash; the agent world <em>is</em> the cell grid, so it reports the same numbers).</td></tr>
              <tr><td>Get Generation</td><td>Outputs the <strong>current generation number</strong> (0-based &mdash; the first step after a Reset is 0). Use it to give a rule its own <strong>cadence</strong>: <code>Get Generation &rarr; Math (%) &rarr; Compare (==) &rarr; If/Then</code> runs a branch only every Nth generation. Works on the <strong>Cells</strong> graph and the <strong>Agents</strong> graph &mdash; both read one shared counter, so they always agree. In an <strong>Init event</strong> it reads 0 (Reset zeroes the counter before seeding); in a <strong>Division Event</strong> it reads the generation the division happened in. On the Agents graph, <strong>Periodic Step</strong> is this same gate as a ready-made event root.</td></tr>
              <tr><td>Get Model Attribute</td><td>Read a global model parameter. Supports multiple attribute slots (&quot;+ Attribute&quot;) &mdash; one node exposes several model parameters as separate output ports (a color parameter in a slot exposes its own R/G/B trio).</td></tr>
              <tr><td>Get Neighbors Attribute</td><td>Collect an attribute from all neighbors as an array.</td></tr>
              <tr><td>Get Neighbor Attr By Index</td><td>Read a cell attribute from ONE specific neighbor by index. Works in both sync and async modes.</td></tr>
              <tr><td>Get Neighbor Attr By Tag</td><td>Read a cell attribute from a specific neighbor identified by a named tag (defined in the Neighborhoods panel). The tag is resolved to an index at compile time.</td></tr>
              <tr><td>Get Neighbor Indexes By Tags</td><td>Select multiple neighborhood cells by their tag names and output an array of indices. Use with &quot;Get Neighbors Attr By Indexes&quot; for tag-based multi-neighbor access.</td></tr>
              <tr><td>Get Neighbors Attr By Indexes</td><td>Read attributes from a subset of neighbors specified by an array of indices.</td></tr>
              <tr><td>Get Constant</td><td>A fixed value: binary, integer, decimal, tag, orientation, or <em>face label</em> (the last only when Variegated Cells is enabled &mdash; emits the compile-time index of the named face label, with implicit <code>none</code> = 0).</td></tr>
              <tr><td>Get Random</td><td>Generate a random value &mdash; binary, integer, decimal, orientation, Options, a <strong>vector</strong>, or a <strong>color</strong>. <strong>Every parameter is an input port with an inline widget</strong>, so any of them can be driven by a wire (a model attribute, an expression, a neighbour read) instead of a fixed number. <em>Binary</em>: &quot;P&quot; (0&ndash;1) is the chance of producing 1 (default 0.5). <em>Integer</em> / <em>Decimal</em>: &quot;Min&quot; and &quot;Max&quot; give the interval (Decimal defaults to the historical [0, 1)). <em>Decimal</em> additionally picks a <strong>distribution</strong>: <strong>Uniform</strong> (Min/Max), <strong>Normal</strong> (Mean + Std Dev &mdash; a Gaussian bell, Box-Muller, which costs <strong>two</strong> RNG draws instead of one) or <strong>Exponential</strong> (Mean &mdash; non-negative waiting times with a long tail; Mean 0 degenerates to 0). <em>Options</em>: wire one or more values to the &quot;Options&quot; array input (multi-scalar OR a single array source like Filter Neighbors / Get All Neighbor Indexes / Get Neighbors Attribute) and the node picks one uniformly; the &quot;Fallback&quot; inline value is returned when the array is empty. <em>Vector</em> outputs X and Y (and a composite <strong>Vector</strong> port that wires straight into vector inputs): a direction chosen uniformly within &plusmn;<strong>Span&deg;</strong>/2 of a reference &mdash; either a compass <strong>Angle&deg;</strong> (0&deg; = north / up, 90&deg; = east, matching the sprite heading convention) or a wired <strong>Dir X / Dir Y</strong> direction (a zero direction falls back to north) &mdash; scaled to <strong>Norm</strong>. Span 360&deg; is &quot;any direction&quot;; span 0&deg; is exactly the reference. The vector is planar (XY) even in a 3D model, and it costs a single RNG draw however many of its outputs you wire. <em>Color</em> outputs R, G and B (and a composite <strong>Color</strong> port that wires straight into colour inputs): three independent uniform channels in 0&ndash;255, costing <strong>three</strong> RNG draws (one per channel, in the order R, G, B) however many outputs you wire. There is deliberately <strong>no random alpha</strong> &mdash; the composite Color port is fully opaque &mdash; because a random opacity is almost never what a rule wants; wire your own alpha through Make Color if you need one.</td></tr>
            </tbody>
          </table>

          <h3 className={styles.h3}>
            <span className={styles.nodeCategory} style={{ background: '#e65100' }}>Logic</span>
            Arithmetic &amp; Logic
          </h3>
          <table className={styles.table}>
            <thead><tr><th>Node</th><th>Description</th></tr></thead>
            <tbody>
              <tr><td>Arithmetic Operator (Math)</td><td>+, -, *, /, %, sqrt, pow, abs, negate (&minus;x), floor, ceil, round, max, min, mean, exp, log (natural), sin, cos, tan, tanh. Round is floor(x + 0.5) on every compile target (identical results on JS / WASM / WebGPU). The unary ops (sqrt, abs, negate, floor, ceil, round and the transcendentals) read only <strong>X</strong> &mdash; the <strong>Y</strong> input hides itself when you pick one.</td></tr>
              <tr><td>Math Expression</td><td>Type a math <strong>formula</strong> in a text field instead of wiring up many Math nodes &mdash; ideal for equation-heavy models. Operators <code>+ - * / % ^</code> and functions <code>sqrt abs floor ceil round min max pow mod exp log sin cos tan tanh</code> (<code>log</code> = natural log), plus the constants <code>pi</code> and <code>e</code>. Variables come from the input ports: add 1&ndash;8 ports with the <strong>+</strong> / <strong>&minus;</strong> buttons, give each a name, then reference those names in the formula (e.g. <em>u + Du*lap - u*v*v</em>). Those editors live behind the <strong>&#9656; Inputs</strong> row, collapsed by default (the names are set once and then read off the port labels) &mdash; click it to rename inputs or change how many there are. The node leads with a <strong>rendered math view</strong> of what you typed &mdash; division becomes a stacked fraction, <code>^</code> a superscript, <code>sqrt</code> a radical, <code>abs</code> vertical bars &mdash; with the parentheses re-derived from precedence rather than echoed, so <em>(a*b + c) / (d - e)</em> reads as a fraction with none at all. The text field itself sits below it behind a <strong>&#9656; Edit expression</strong> row, collapsed once the formula renders, so a finished node shows the maths rather than the source; while the formula is empty or does not parse the field stays open (with the error underneath) and there is nothing to collapse. A long formula scrolls sideways inside the node rather than stretching it, so <strong>drag the grip at the node&rsquo;s bottom-right corner to widen it</strong> until the whole equation fits &mdash; the width is remembered with the model, and a <strong>double-click on the grip</strong> shrinks the node back to fit its contents. Compiles on all three targets (JS, WASM, WebGPU).</td></tr>
              <tr><td>Proportion Map</td><td>Remap a value from one range to another: <em>output = outMin + curve(t) * (outMax - outMin)</em> with <em>t = (x - inMin) / (inMax - inMin)</em>. Has 5 inputs (X, In Min, In Max, Out Min, Out Max) plus a <strong>curve</strong> dropdown: Linear, Smoothstep, Ease-In Quadratic, Ease-Out Quadratic, Exponential, Logarithmic. Linear keeps un-clamped extrapolation; non-linear curves clamp t to [0, 1].</td></tr>
              <tr><td>Interpolate</td><td>Linear interpolation: output = min + t * (max - min). Inputs: T (0&ndash;1), Min, Max.</td></tr>
              <tr><td>Compare (Statement)</td><td>Comparison operators: ==, !=, &gt;, &lt;, &gt;=, &lt;=, <strong>Between</strong>, and <strong>Not Between</strong>. The between-family ops reveal a Y&#8322; input and two picklists for the lower (&gt;= or &gt;) and upper (&lt;= or &lt;) interval sides; <em>Not Between</em> fires when the value is outside the interval. A <strong>type selector</strong> (Numerical / Binary / Tag / Neighbor Index) swaps the inline operand widgets &mdash; pick <em>Tag</em> and a tag-attribute picker appears so you can compare against a tag option without a Get Constant node (non-numerical types are equality-only). Replaces the common Compare + Compare + AND chain.</td></tr>
              <tr><td>Logic Operator</td><td>AND, OR, XOR, NOT on binary values.</td></tr>
              <tr><td>Logical Expression</td><td>Type a boolean <strong>formula</strong> in a text field instead of wiring up a chain of Logic nodes &mdash; what <em>Math Expression</em> is to the <em>Math</em> node. Operators <code>NOT</code>, <code>AND</code>, <code>XOR</code>, <code>OR</code> (or the symbols <code>!</code>, <code>&amp;&amp;</code>, <code>^</code>, <code>||</code>), parentheses, and the literals <code>true</code>/<code>false</code> (<code>1</code>/<code>0</code> also work). It also does the <strong>comparisons</strong> &mdash; <code>&lt;</code> <code>&lt;=</code> <code>&gt;</code> <code>&gt;=</code> <code>==</code> <code>!=</code> (a bare <code>=</code> means <code>==</code>) &mdash; over numbers and input variables, so <em>Compare</em> and <em>Logic</em> collapse into one node: <em>n &gt; 2 AND NOT crowded</em>. Precedence is <strong>comparisons &gt; NOT &gt; AND &gt; XOR &gt; OR</strong>, all binary boolean operators are left-associative, and the operator words and literals are case-insensitive. Because comparisons bind tightest, <em>NOT n &gt; 2</em> reads as <em>NOT (n &gt; 2)</em> and <em>a &gt; 1 AND b &lt; 2</em> needs no parentheses. Comparisons do <strong>not chain</strong>: write <em>1 &lt;= n AND n &lt;= 5</em>, not <em>1 &lt;= n &lt;= 5</em> (which is a clear error, never a silent misreading). An input is <strong>dual-role</strong> &mdash; bare it is truthy-tested, inside a comparison it is its raw number &mdash; so the same port can be used both ways in one formula. What is still deliberately <em>out</em> is <strong>arithmetic</strong>: no <code>+ - * /</code>, no functions, not even negation (a <code>-</code> may only sign a number). Compute a value in a <em>Math Expression</em> node and wire it in (e.g. <em>Math Expression(energy / mass)</em> &rarr; an input named <em>ratio</em>, then <em>ratio &gt; 0.5 AND NOT crowded</em>). Variables come from the input ports exactly as on the Math Expression node: add 1&ndash;8 ports, name them, reference the names. The whole editor is the same &mdash; a <strong>rendered logic view</strong> as the node&rsquo;s face (<code>&not;</code> <code>&and;</code> <code>&oplus;</code> <code>&or;</code> plus the comparison glyphs <code>&lt;</code> <code>&le;</code> <code>&gt;</code> <code>&ge;</code> <code>=</code> <code>&ne;</code>, with parentheses re-derived from precedence rather than echoed &mdash; <em>(a AND NOT b) OR (b XOR c)</em> reads as <em>a &and; &not;b &or; b &oplus; c</em>, dropping brackets the precedence already implies, while <em>(a OR b) AND c</em> keeps the pair it genuinely needs), the text field behind a collapsed <strong>&#9656; Edit expression</strong> row, the input names behind <strong>&#9656; Inputs</strong>, and the corner grip to widen the node (double-click it to fit the contents again). An input read as a boolean is <strong>truthy-tested</strong> and the result is a 1/0 binary value, so a formula and the equivalent chain of Logic nodes behave identically &mdash; and a comparison behaves exactly like a <em>Compare</em> node wired to the same source (<code>==</code> and <code>!=</code> are exact, with no tolerance). Compiles on all three targets (JS, WASM, WebGPU), on the Cells and Agents graphs alike, and in the Overseer.</td></tr>
              <tr><td>Value Switch</td><td>Ternary value selector: outputs <em>If</em> when <em>Condition</em> is truthy, else <em>Else</em>. Pure value &mdash; no flow port, so it stays inline in the graph. Both inputs always evaluate; use a flow Conditional for short-circuit. Also works as a <em>conditional array selector</em>: wire two array producers (e.g. Filter Neighbors) into <em>If</em>/<em>Else</em> and the chosen array flows out of <em>Result</em> &mdash; handy for &ldquo;pick a random neighbour from set A or set B&rdquo;. The same is true of the <em>composite</em> types: wire two <em>vectors</em> (or two <em>colours</em>) into <em>If</em>/<em>Else</em> and <em>Result</em> is that vector/colour, selected component by component &mdash; so you can pick between two headings and feed the winner straight into a Vector attribute, Break Vector or Apply Force. Both branches must be the same shape: mixing a vector with a plain number has no meaning, so the editor will not let you wire it.</td></tr>
              <tr><td>Make Vector / Break Vector</td><td>Bundle X / Y / Z scalars into a single <strong>vector</strong> value, and split one back into components (the Unreal/Blender Make &amp; Break pattern). Pass a whole 2D/3D vector on one wire &mdash; the Z component appears only in a 3D model. Runs on all three compile targets (lowered to scalar math at compile time).</td></tr>
              <tr><td>Vector Op</td><td>Vectorial math on vectors: <strong>Add, Subtract, Scale</strong> (&times; a scalar), <strong>Dot, Cross, Length, Normalize, Distance, Negate, Lerp, Rotate</strong> and <strong>Rotate Around Axis</strong> &mdash; so you operate on whole vectors instead of touching each coordinate. <strong>Angles are in degrees</strong>; a positive angle turns from +X toward +Y, which reads as clockwise on screen (rows grow downward). <em>Rotate</em> spins the XY plane about the Z axis and leaves Z untouched, so it works in 2D and 3D models alike; <em>Rotate Around Axis</em> (Rodrigues) turns the vector around any axis you wire in and is offered only in 3D models &mdash; a zero-length axis degenerates to scaling by cos(angle). Runs on all three targets.</td></tr>
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
              <tr><td>Group Operator</td><td>Reduce an array: sum, product, max, min, mean, median, AND, OR, pick <em>random</em>, or <em>weighted random</em>. Min/max/random/weighted-random also output the picked <em>position</em>. <em>Weighted Random</em> treats the array as weights and returns the picked weight + index (empty/zero-sum &rarr; index &minus;1); always advances the RNG. Every op runs on all three grid targets (the WebGPU grid sorts median in a per-thread loop and picks random from its per-cell RNG &mdash; the random index differs cross-target by f32/RNG design).</td></tr>
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
              <tr><td>Set Attribute</td><td>Write a value to the current cell&apos;s attribute for the next generation. Supports multiple attribute <strong>slots</strong> (&quot;+ Attribute&quot;): one node writes several attributes, each with its own input port and type-adaptive inline widget, executed in slot order &mdash; no need to chain a Set node per attribute.</td></tr>
              <tr><td>Update Attribute</td><td>Modify the current cell&apos;s attribute in place: increment / decrement / max / min for numbers, toggle / or / and for binary, next / previous for tags. The unary operations (toggle, next, previous) need no Value input.</td></tr>
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
              <tr><td>Color Scale</td><td>Map an input <strong>T</strong> (0&ndash;1) to an RGB color via a multi-stop gradient. Edit the stops on a draggable gradient bar, or load a named palette preset (Viridis, Magma, Plasma, Inferno, Rainbow, Heat, Cool&rarr;Warm, Cividis, Grayscale). The <strong>curve</strong> dropdown controls the interpolation shape: Linear, Smoothstep, Ease-In Quadratic, Ease-Out Quadratic, Exponential, Logarithmic. Outputs R, G, B &mdash; plus <strong>A</strong> once any stop is given a non-opaque alpha (alpha interpolates on the same curve as the colour channels). T outside the stop range clamps to the nearest endpoint.</td></tr>
              <tr><td>Categorical Color</td><td>Map an integer <strong>Index</strong> to a flat RGB color from an editable N-entry palette &mdash; <em>discrete</em>, with no blending between entries (contrast Color Scale, which interpolates). Index <code>i</code> selects palette entry <code>i</code>; out-of-range indices use the default color. Outputs R, G, B &mdash; plus <strong>A</strong> once any entry (or the default) is given a non-opaque alpha. Used internally by Linked Output Mappings for tag attributes, and available as a node for hand-built graphs.</td></tr>
              <tr><td>Make Color / Break Color</td><td>Bundle R / G / B / A channels into a single <strong>color</strong> value, and split one back into channels (the Unreal/Blender Make &amp; Break pattern) &mdash; pass a whole colour on one wire. A defaults to 255 (opaque). Runs on all three targets.</td></tr>
            </tbody>
          </table>

          <h3 className={styles.h3}>
            Indicators
          </h3>
          <table className={styles.table}>
            <thead><tr><th>Node</th><th>Description</th></tr></thead>
            <tbody>
              <tr><td>Get Indicator</td><td>Read an indicator whose value is a single number — standalone, a linked Total, or a scalar graph metric (nodes / edges / mean degree / max degree / components). Frequency maps, degree histograms and spatial curves are listed but disabled: they have no single value. A computed value is read as of the end of the previous generation.</td></tr>
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
          <p className={styles.p}>
            Ports are detected <strong>one per connected group of crossing wires</strong>,
            not one per wire. If one outside node feeds several of the selected nodes you
            get <em>one</em> input, which fans out to all of them inside the macro; if one
            selected node feeds several outside nodes you get <em>one</em> output, which
            fans out outside. And because a <strong>flow</strong> input accepts several
            incoming wires, several outside flow wires arriving at the same selected node
            likewise become <em>one</em> input — both of them simply converge on it. So a
            macro shows only as many ports as there are distinct things crossing its
            boundary.
          </p>
          <p className={styles.p}>
            The one case that is deliberately <em>not</em> merged is a group where merging
            would create a wire you never drew — for example two outside flow nodes where
            only one of them reaches both selected nodes. There the ports stay separate, so
            the macro always computes exactly what the original graph did.
          </p>

          <h3 className={styles.h3}>Editing a Macro</h3>
          <p className={styles.p}>
            Double-click a Macro node to enter its subgraph. You&apos;ll see teal
            <strong> Macro Input</strong> and <strong>Macro Output</strong> boundary
            nodes. Add, remove, or rename ports on these to modify the macro&apos;s
            external interface. Use the breadcrumb bar at the top to navigate back &mdash;
            or press the browser/mouse <strong>Back</strong> button: while inside a macro
            it steps one macro level up instead of leaving GenesisCA.
          </p>

          <h3 className={styles.h3}>Explicit Parameters &mdash; the macro&apos;s own interface</h3>
          <p className={styles.p}>
            A macro node normally shows only its <em>ports</em>, so a setting buried inside
            the subgraph &mdash; a neighborhood, a threshold, an attribute pick &mdash; can
            only be changed by entering the macro and hunting for the node that owns it.
            <strong> Explicit Parameters</strong> promote a chosen internal setting to a
            named row on the <em>closed</em> macro node, so a macro reads as a component
            with knobs.
          </p>
          <ul className={styles.list}>
            <li>
              <strong>To promote one:</strong> enter the macro, and on the <strong>Macro
              Input</strong> boundary node use <strong>+ Parameter</strong>. The button arms
              <em> pick mode</em>: a translucent dashed button appears <em>directly on top
              of</em> every eligible setting, right where that node already draws it &mdash;
              click the one you want. A setting that is not on screen just then (a port
              driven by a wire, a collapsed formula editor, a widget hidden by the node&apos;s
              current mode) is listed instead, under <em>not shown on the node</em>. Press
              <kbd className={styles.kbd}>Esc</kbd> to cancel. Rename the row, or press
              <strong> &#9998;</strong> to re-bind it to a different setting, or
              <strong> x</strong> to remove it (nothing inside the macro is deleted; only
              the shortcut goes away).
            </li>
            <li>
              <strong>It is a remote control, not a copy.</strong> The row edits the
              parameter <em>where it lives</em>, so changing it on the closed instance and
              changing it inside the macro are the same edit &mdash; open the macro and
              you&apos;ll see the new value already there, and vice versa. Nothing is
              duplicated, so nothing can fall out of sync.
            </li>
            <li>
              <strong>What can be promoted:</strong> a node&apos;s inline port values, its
              plain settings (operations, counts, modes, checkboxes), its model-element
              pickers (attribute / neighborhood / mapping / indicator / variable / sprite /
              table / preset), and its <strong>whole multi-value editors</strong> &mdash;
              a Color Scale&apos;s <em>gradient</em>, a Categorical Color&apos;s
              <em> palette</em>, a Color Constant&apos;s <em>colour</em>. Promote one of
              those and the closed instance renders the <em>same editor</em> the node draws:
              drag its stops, add and delete colours, set transparency, apply a preset.
              A handful of settings are deliberately not offered &mdash; the ones whose
              in-node editor changes <em>several</em> things at once (picking a tag attribute
              also resets the value beside it, for instance), which a single-value shortcut
              could not do faithfully. For the same reason a multi-value editor is promoted
              <em> as a whole</em>, never one stop or one palette entry at a time.
            </li>
            <li>
              <strong>Reordering:</strong> every row in the parameter list &mdash; and every
              port row above it &mdash; has a <strong>&#8942;&#8942;</strong> grip. Drag to
              reorder. The parameter order is what the closed instance shows; the port order
              is the order of its handles, and reordering ports never touches a wire.
            </li>
            <li>
              <strong>Groups are separators.</strong> <strong>+ Group</strong> drops a named
              separator at the bottom of the parameter list; drag it up over the parameters
              it should contain. <em>Whatever sits under a separator, up to the next one,
              belongs to that group</em> &mdash; so you group a parameter by dragging it
              under the separator (or drag the separator up to capture it), and un-group it
              by dragging it above every separator. The <strong>+</strong> on a separator
              adds a new parameter straight into that group. Removing a separator
              (<strong>x</strong>) merges its parameters into the section above &mdash;
              nothing is deleted, and nothing moves.
            </li>
            <li>
              <strong>On the closed instance each group is a box you can collapse</strong>
              (click its header). That is a per-instance view setting: collapse a group on
              one copy and its linked copies stay as they were. Collapsed, the header shows
              how many parameters are hidden, plus a red <strong>!</strong> if one of them
              needs attention.
            </li>
            <li>
              <strong>Chaining:</strong> if your macro contains <em>another</em> macro, pick
              mode also offers that inner macro&apos;s own parameters, so an outer macro can
              re-expose an inner knob at the top level. Circular chains are detected and
              refused (the offending row shows as disabled rather than silently
              disappearing).
            </li>
            <li>
              <strong>If something breaks</strong> &mdash; the target node is deleted, the
              setting disappears, or the parameter gets wired inside the macro &mdash; the
              row stays visible but <em>disabled with the reason</em>, and genuinely broken
              rows raise the macro node&apos;s amber <strong>!</strong> badge. Nothing is
              silently dropped. While you have the macro <em>open for editing</em>, its rows
              on the instance are disabled too (edit them inside).
            </li>
            <li>
              Explicit Parameters travel with the macro: linked copies share them,
              independent copies and <code>.gcamacro</code> exports carry them (groups and
              chains included) into any other project.
            </li>
          </ul>

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

          <h3 className={styles.h3}>Moving nodes in and out of a macro</h3>
          <p className={styles.p}>
            You don&apos;t have to undo a macro to change what is inside it. Select the
            node (or nodes) you want to move &mdash; a small <strong>grip</strong> appears
            at the right of each selected node&apos;s header &mdash; then drag by that grip:
          </p>
          <ul className={styles.list}>
            <li><strong>Onto a Macro node</strong> &mdash; moves the whole selection <em>inside</em> that macro.</li>
            <li><strong>Onto a Macro Input or Macro Output node</strong>, while you are editing a macro &mdash; moves the selection <em>out</em> to the parent graph.</li>
          </ul>
          <p className={styles.p}>
            <strong>Every connection is preserved.</strong> A wire that now has to cross the
            boundary grows the macro a port and is re-wired through it; a port whose only
            reason to exist just moved across is removed and its wire re-made directly. Ports
            follow the same rule Create Macro does &mdash; <em>one port per connected group of
            crossing wires</em>, so a single value feeding several moved nodes creates one port
            that fans out, and several flow wires arriving at the same node converge on one
            port rather than making several identical ones. A crossing wire that a port the
            macro already has can carry simply joins that port. Valid drop targets outline themselves while
            you drag, the one under the cursor lights up, and <strong>Esc</strong> cancels.
          </p>
          <p className={styles.p}>
            Two limits worth knowing. <strong>Moving a node OUT is refused when the macro has
            linked copies</strong> &mdash; it would silently remove that computation from every
            other copy too; use the count badge&apos;s <strong>Make Independent Copy</strong>
            first. And moving a node <em>in</em> may remove a port, which drops the wires the
            other linked copies had into it (the on-screen message says how many). An
            <strong>Explicit Parameter</strong> pointing at a node that leaves a macro is
            removed with it, so the macro&apos;s interface stays honest. Boundary nodes and
            event roots (Generation Step, Behaviour Step&hellip;) never move. Because undo is
            per-graph, <strong>Ctrl+Z will not reverse a move across a boundary</strong> &mdash;
            it only undoes the half you are looking at.
          </p>

          <h3 className={styles.h3}>Undoing a Macro</h3>
          <p className={styles.p}>
            Right-click a Macro node and choose &quot;Undo Macro&quot; to inline its
            contents back into the parent graph. All restored nodes are automatically
            selected for easy repositioning.
          </p>

          <h3 className={styles.h3}>Exporting a Macro &mdash; what the file carries</h3>
          <p className={styles.p}>
            Right-click a Macro node and choose <strong>Export Macro&hellip;</strong> to save it
            as a <code>.gcamacro</code> file you can import into any other project. The nodes
            inside a macro reference <em>model elements</em> by id &mdash; an attribute, a
            neighborhood, a mapping, a local variable, an indicator, a sprite &mdash; and those
            ids only mean something in the model the macro came from. So the file carries the
            referenced definitions with it:
          </p>
          <ul className={styles.list}>
            <li><strong>Everything is embedded by default.</strong> The export dialog lists every
              referenced definition, grouped by kind, all checked. Uncheck one to leave it out;
              its reference will then dangle on import (an amber badge on the node, exactly as
              before this existed) and you re-point it by hand.</li>
            <li><strong>Definitions a definition needs come too.</strong> If an attribute is a
              sub-attribute, its parent rides along; a linked mapping brings the attribute it
              colors by; a lookup table brings its axis attributes and face palettes; a face
              pattern brings its palette. These appear <em>indented</em> under whatever pulled
              them in, and unchecking that requirer drops them too.</li>
            <li><strong>Sprites are the reason the checkboxes are there.</strong> A sprite is a
              whole image file (often megabytes), so its size is shown on the row &mdash; uncheck
              it for a lightweight rule-only macro.</li>
            <li><strong>Nested macros travel.</strong> If the macro instantiates another macro,
              that definition is written to the file too.</li>
            <li><strong>Presets cannot be carried</strong> (an Overseer <em>Load Preset</em> node
              names one). A preset embeds a whole simulation snapshot &mdash; export it separately
              as a <code>.gcapreset</code>. The dialog lists it under &quot;Cannot be carried.&quot;</li>
            <li><strong>&quot;Reference-free template&quot;</strong> unchecks everything at once,
              for a macro you deliberately want to arrive unwired.</li>
          </ul>
          <p className={styles.p}>
            A macro that references nothing skips the dialog entirely and writes exactly the file
            it always did. The file format is unchanged otherwise, so a macro exported from a newer
            build still imports into an older one &mdash; it simply ignores the extra definitions.
          </p>

          <h3 className={styles.h3}>Importing a Macro &mdash; Import as new / Remap / Discard</h3>
          <p className={styles.p}>
            Right-click the canvas and choose <strong>Import Macro&hellip;</strong> &mdash; or
            simply <strong>drop a <code>.gcamacro</code> anywhere on the window</strong> (which
            switches to the Modeler first if you were on another tab, and places the macro under
            the drop point when you were already there). Both routes run the same import. If the
            file carries definitions this model does not already have, a dialog asks what to do
            with each one:
          </p>
          <ul className={styles.list}>
            <li><strong>Import as new</strong> &mdash; create it here, with a fresh id (and a
              &quot;(imported)&quot; suffix if the name is already taken). Definitions that
              reference each other are kept consistent: a sub-attribute imported alongside its
              parent points at the <em>new</em> parent.</li>
            <li><strong>Remap to existing</strong> &mdash; point the macro at an element this model
              already has. Only <em>type-compatible</em> elements of the same kind are offered
              (a Binary attribute is never offered for a Tag one), and an exact
              <strong> name + type</strong> match is pre-selected as a suggestion &mdash; shown,
              never applied silently.</li>
            <li><strong>Discard</strong> &mdash; leave the reference pointing at nothing. That is
              exactly what happened before this feature existed: the node arrives with an amber
              <strong> !</strong> badge and you re-point it by hand. It is never a default, but it
              is always one click away.</li>
          </ul>
          <p className={styles.p}>
            <strong>References this model already has are never asked about</strong> &mdash; they
            are summarised as &quot;already present&quot;. So re-importing a macro into the model
            it came from opens no dialog at all and adds nothing, and an older <code>.gcamacro</code>
            that carries no definitions imports exactly as it always did.
          </p>
          <p className={styles.p}>
            Two things a remap cannot simply re-point, and what happens instead. A macro also
            stores values that only mean something <em>relative</em> to an element &mdash; a tag
            option index, a neighborhood tag name, an indicator category, a face label. Those are
            re-derived <strong>by name</strong>, so remapping onto an element whose tag options are
            in a different order still selects the right options. Where a name has{' '}
            <strong>no counterpart</strong> in the target it is <strong>left as it was and
            reported</strong>, never silently changed to something plausible &mdash; an
            out-of-range option shows as an unselected dropdown, and an unknown tag name is already
            badged. The dialog warns about each case before you import.
          </p>
          <p className={styles.p}>
            Definitions for a layer that is switched off &mdash; bond attributes with Bonds
            disabled, agent elements with Bond-Graph Agents off, face palettes with Variegated
            Cells off &mdash; are <strong>imported anyway and marked inert</strong>, with the
            setting to enable named on the row. Importing never turns a capability on for you.
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
            The two radios in Properties label themselves with the engine consequence, in the words
            of <em>principle 1</em>: <strong>Synchronous</strong> is the <em>parallel</em> mode and{' '}
            <strong>runs on all engines</strong>; <strong>Asynchronous</strong> is the{' '}
            <em>sequential</em> mode &mdash; a write is visible to a later cell in the <em>same</em>{' '}
            generation &mdash; so for the CA grid it is <strong>CPU engines only</strong>. The{' '}
            <em>agent</em> layer has its own, independent Update Mode radio, and its asynchronous
            consequence is narrower: an async agent model does run on WebGPU (Growing Tissue ships
            that way); what the parallel GPU cannot honour is a <em>cross-agent write</em>, whose
            landing order only the sequential CPU engines define.
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
            Three general-purpose node types are exclusive to asynchronous mode (plus three
            more in Variegated Cells models: Set Facing Orientation, Set Neighbor Orientation
            By Index, and Transfer Cell Attributes to Neighbor). Using them in synchronous
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
            A 2D model gets the same parametric generator (Moore / von&nbsp;Neumann / Disk /
            Range-N / Ring) above its grid editor &mdash; see <em>Neighborhoods Panel</em>
            above. Both dimensions share one shape generator, so a 2D shape is exactly the
            <code>dl = 0</code> slice of its 3D namesake.
          </p>
          <p className={styles.p}>
            The direct <em>NeighborIndex</em> node family (Get/Set Neighbor Attribute By
            Index, Neighbor Index From Offset, etc.) works in 3D too &mdash; in a 3D model
            the packed coordinate carries three axes (dr, dc, dl), and Neighbor Index From
            Offset / Break Down Neighbor Index expose a third <code>dl</code> (layer) port
            (see the NeighborIndex section above).
          </p>
          <h3 className={styles.h3}>The 3D Viewport</h3>
          <p className={styles.p}>
            3D models render in a WebGL2 voxel view: each live cell is a small cube
            (transparent cells are skipped). <strong>Middle-drag</strong> (or
            <strong>Alt+left-drag</strong>, or <strong>right-drag</strong>) to orbit/pan,
            <strong>scroll</strong> to zoom, and hold <strong>Shift</strong> while orbiting to
            pan &mdash; Blender-style, with Z up. <strong>Double right-click</strong> restores the
            default camera (the same thing the 3D View panel&rsquo;s <strong>Reset view</strong> button
            does); a right-<em>drag</em> still just pans.
            The <strong>corner gizmo</strong> behaves like
            Blender's: it lights up when you hover it (the ball under the cursor brightens and
            grows), <strong>clicking a ball</strong> snaps to that view &mdash; and clicking the
            ball of the axis you are <em>already</em> looking along flips to the opposite view
            &mdash; while <strong>dragging the widget orbits</strong> the camera. Positive tips are
            big and bright, negative ones small and dim; the gizmo is depth-sorted and labelled
            <strong>C / R / D</strong> (column / row / depth). Clicking <strong>D</strong> looks
            straight down the depth axis, so the volume reads <strong>exactly like the 2D CA</strong>
            &mdash; column increases to the right, row downward, depth into the screen.
            The <strong>numpad view keys are Blender's</strong>: <strong>7</strong> top,
            <strong>1</strong> front, <strong>3</strong> right, each with <strong>Ctrl</strong>
            (or <strong>Shift</strong>) for the opposite face; <strong>8 / 2</strong> and
            <strong>4 / 6</strong> orbit up / down / left / right by 15&deg;; <strong>9</strong>
            flips to the opposite view. They read the <em>physical</em> key, so the top-row digits
            work as well as the numpad (Blender's &ldquo;Emulate Numpad&rdquo;) &mdash; though on the
            top row <strong>Ctrl+1&hellip;9</strong> is a browser tab shortcut a page cannot
            intercept, which is why Shift is accepted as an equivalent. <strong>5</strong> is
            unbound (there is no orthographic camera), and Ctrl + 8/2/4/6 does not pan.
            <strong>Shift + left-click</strong> a cell to inspect it (the cell is
            <strong>highlighted in the volume</strong> while you hover its popup &mdash; there's no
            2D connector line); <strong>Shift + left-drag</strong> sweeps a single transient
            inspector across cells, so you can peek around the volume without pinning a popup per
            cell. <strong>Ctrl/Cmd + left-drag</strong> resizes the active brush, and
            <strong>Ctrl/Cmd + scroll</strong> cycles the Input Mapping (it no longer also zooms).
            The on-canvas <strong>3D View</strong> panel adds
            toggleable <strong>Axes / Grid / Bounds / the corner Gizmo</strong> (the Axes start at
            the <code>(0,0,0)</code> origin corner and grow toward +column / +row / +depth),
            <strong>Auto-orbit</strong> (+ a speed slider that spans negative&rarr;positive, so the
            camera can spin either way; 0 = stopped),
            <strong>Auto-zoom</strong> (the dolly companion to auto-orbit, and it works the
            same way: one slider spanning negative&rarr;positive, so the camera slowly pulls
            <em> out</em> (right of centre) or pushes <em>in</em> (left of centre); 0 = stopped.
            It stops at the zoom limit rather than travelling forever. Turn both on and start
            the camera in close for an unattended &ldquo;orbit and slowly pull out as the model
            grows&rdquo; recording; you can still wheel-zoom mid-flight and it simply carries on
            from there, and switching it off leaves the camera exactly where it is), a
            <strong>Clip interval</strong> (axis X/Y/Z or the camera view, with <em>two</em> handles
            &mdash; From and To &mdash; that cut from both sides, so you control exactly how thick a
            slab of the volume stays visible; clips voxels, agent spheres <em>and</em> bonds), an
            <strong>Alpha blend</strong> toggle for translucent cells, a
            <strong>Cell gaps</strong> toggle (the 3D analogue of the 2D gridlines: ON — the
            default — leaves a small gap between adjacent cells so the lattice reads; OFF renders
            cells flush against each other as one seamless solid volume), a
            <strong>Draw agents in front</strong> toggle (models with <em>both</em> layers — ON
            draws the agents over the CA-grid voxels regardless of depth, since the grid usually
            surrounds them; uncheck for normal depth occlusion between the two layers when the grid
            field is sparse; the axes / grid / bounds / brush plane always occlude normally either
            way. An agents-only model has no voxels to be in front of, so the toggle is not shown
            there &mdash; nor are <strong>Cell gaps</strong> and <strong>Occlusion</strong>, which
            are voxel-only), a
            <strong>Metaballs</strong> block (agent models — see below), a
            <strong>Background</strong> colour (off = transparent), a
            <strong>Lighting</strong> block, and
            <strong>Reset view</strong>. The left panel's <strong>Grid Dimensions</strong> gains
            a <strong>Depth</strong> field to resize the volume's layers. (Empty cells default to
            transparent, so an in-progress model doesn't fill the whole volume with voxels.)
          </p>
          <p className={styles.p}>
            <strong>Lighting</strong> shades the voxels (and agent spheres) with one directional
            key light plus an ambient fill. Drag the bright dot on the <strong>light ball</strong>
            to aim the light &mdash; the light comes <em>from</em> the dot's direction. The
            <strong> Ambient</strong> slider sets the base brightness reaching every face,
            <strong> Light</strong> sets the directional strength that shapes the volume, and
            <strong> Shine</strong> adds a white specular highlight (off by default).
            <strong> View</strong> anchors the light to the camera, so shading stays constant
            while you orbit (headlight style); <strong>World</strong> fixes it in the scene, so
            orbiting sweeps the lit side (sun style) &mdash; switching modes never jumps the
            current shading. The <em>default</em> is a <strong>View</strong>-anchored key light at
            the ball&rsquo;s far <strong>top-left</strong>, so a fresh 3D model is lit from above-left
            no matter which way you orbit. <strong>Reset</strong> restores that default light (your
            own saved lighting is kept until you press it). Two optional
            <strong> global lighting</strong> toggles make cells and agents shade each other
            instead of each surface being lit only on its own: <strong>Shadows</strong> casts real
            shadows (voxels and agents shadow each other) and <strong>Occlusion</strong> darkens
            the crevices of a packed voxel volume so it reads as one solid form. Each has a
            strength slider; both are off by default. They are a <strong>high-quality
            mode</strong>: on a 3D grid running the WebGPU compile target, the volume is
            normally drawn straight from the GPU inside the worker (nothing has to travel
            back to the page), but shadows and occlusion are computed by the page-side
            renderer &mdash; so switching either on (like <strong>Alpha blend</strong>)
            hands the frame back to it and costs real per-frame CPU work on large volumes.
            Switch them off and the fast path resumes automatically.
          </p>
          <p className={styles.p}>
            <strong>Metaballs</strong> (agent models, off by default) render the agent population
            as one <em>fused implicit surface</em> instead of discrete spheres &mdash; each agent
            contributes a field over <strong>Influence</strong> &times; its own radius, the fields
            sum, and the surface sits at the <strong>Threshold</strong> isovalue, so agents whose
            fields overlap merge into one organic blob (Blender-metaball semantics &mdash; the
            natural look for tissues and morphogenesis; agent colours blend smoothly across the
            fused surface). At the auto threshold (the <strong>&#10226;</strong> button) a lone
            agent renders at exactly its own radius; lower fattens/fuses, higher thins/separates.
            <strong> Detail</strong> sets the field resolution (voxels per cell). Metaballs are a
            pure <em>render</em> mode &mdash; picking, brushing, inspecting and the simulation
            itself still target the underlying agents, sprite-agents stay crisp billboards on
            top, and the blob receives cast shadows and respects the clip interval. The same
            preference also applies in <strong>2D</strong>, where nearby agent discs fuse via an
            approximate &ldquo;gooey&rdquo; blur-and-threshold filter (the 2D controls live in
            the right panel's agent section).
          </p>
          <p className={styles.p}>
            <strong>Painting in 3D</strong> uses an <strong>interaction plane</strong>: enable
            <strong>Brush plane</strong> in the 3D View panel and pick its axis + position. The
            plane shows its <strong>bounds and a grid</strong> so you can see exactly where it
            sits. It is <strong>drawn where it really is in the volume</strong> &mdash; cells (and
            agents) in front of the slice hide it, so you can tell at a glance whether the plane
            is behind or in front of what you are looking at. The <em>cursor</em> is the
            exception, and deliberately so: the hovered brush is a bounded
            <strong> wireframe outline of the brush shape</strong> (a circle / box / sphere, so
            even a large volumetric brush stays light) and stays visible <em>through</em> the
            volume, like a mouse pointer. A plain <strong>left-drag</strong> then ray-traces onto
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
            By default agents move only by the forces <em>your rule graph</em> applies
            (Apply Force / Set Velocity) &mdash; ideal for flocking, chemotaxis, or a
            grid-of-agents. Tick <strong>Use bonding physics</strong> (Properties &rarr;
            Bond-Graph Agents) to switch on the built-in center-based engine: agents then push
            each other apart (soft-sphere repulsion), can be joined by springs
            (<strong>bonds</strong>), <strong>grow</strong> toward a target size, and
            <strong> divide</strong> into a connected tissue &mdash; how you model
            <strong> morphogenesis</strong> (tissue that grows into shape). With it off, none of
            those automatic behaviours apply, so an agent model that has nothing to do with bonds
            stays clean.
          </p>
          <p className={styles.p}>
            Agents are <strong>additive</strong>: a model keeps its grid and gains the agents
            on top, so the two engines run side by side, in <strong>2D or 3D</strong> (a 3D model
            renders agents as shaded spheres with bond tubes in the voxel viewport). The grid CA
            is unaffected.
          </p>
          <p className={styles.p}>
            The agent engine&rsquo;s <strong>compile target</strong> and <strong>update mode</strong>
            are set in <strong>Properties &rarr; Bond-Graph Agents</strong>, <em>independently of
            the grid&rsquo;s</em> &mdash; so you can run a synchronous grid rule with asynchronous
            agents, and vice versa. <strong>Agent Engine</strong> (<strong>Auto</strong> by default &mdash; it picks the fastest engine this agent graph can use and shows which): <strong>JavaScript</strong>
            (full node coverage), <strong>WebAssembly</strong> (covers the <em>whole</em> agent-node
            catalogue with JS bit-parity &mdash; the only clamp is a Get Nearby Agents
            scratch-slot budget), or <strong>WebGPU</strong> (the whole agent-node
            catalogue runs on the GPU &mdash; Boids 2D/3D, flocking, chemotaxis via the field
            bridge, growing/dividing tissue, even Game of Life on agents; only a few
            order-dependent or glyph operations fall back to JS, and statistical &mdash; not
            bit-exact &mdash; parity applies as on the grid). <strong>Update Mode:</strong>
            <strong> Asynchronous</strong> (default &mdash; a <em>Set Attribute</em> aimed at a
            neighbour is immediately visible to a later agent this step) or <strong>Synchronous</strong>
            (every agent reads the previous step; attribute writes are swapped in at the step&rsquo;s
            end &mdash; simultaneous-update semantics, which is what a classic totalistic rule like
            Game of Life needs). <strong>All three agent targets honour it</strong>, each with a real
            double buffer: JS and WebAssembly keep two attribute buffers and swap, and WebGPU keeps
            two runs in the GPU array and folds the write run onto the read run once per generation.
            Positions are snapshot-integrated in both modes. Because writing <em>another</em> agent&rsquo;s attribute
            (or position/radius) would race that agent&rsquo;s own update under Synchronous mode,
            those cross-agent OVERWRITE writes are <strong>allowed only in Asynchronous mode</strong>
            (the agent form of the CA grid&rsquo;s &ldquo;a cell writes only itself&rdquo; rule) &mdash;
            except when the target is a freshly-created handle you&rsquo;re configuring at spawn time.
            <em>Apply Force To Agent</em> and <em>Kill Agent</em> are exempt, for the same reason:
            adding a force is commutative and setting a kill flag to 1 is idempotent, so neither
            depends on the order agents run in.
          </p>
          <h3 className={styles.h3}>Targeting &mdash; &ldquo;empty means me&rdquo;</h3>
          <p className={styles.p}>
            Every agent action can reach <em>any</em> agent. Most take an optional{' '}
            <strong>Agent</strong> input: leave it empty and the node acts on the agent being
            evaluated, or wire an id (from Get Nearby Agents, For Each Bond, Pick Random Agent,
            Get Self Handle&hellip;) and it acts on that one &mdash; exactly how <em>Get Velocity</em>
            has always read. That covers <strong>Set Attribute</strong> (write my own attribute, or
            a neighbour&rsquo;s), <strong>Kill Agent</strong> (apoptosis vs. predation),{' '}
            <strong>Set Velocity</strong>, <strong>Set Target Radius</strong>,{' '}
            <strong>Set Agent Sprite</strong>, <strong>Form Bond</strong>,{' '}
            <strong>Break Bond</strong> and the by-id <em>readers</em> &mdash;{' '}
            <strong>Get Attribute (by&nbsp;ID)</strong>, <strong>Get Position (by&nbsp;ID)</strong>{' '}
            and <strong>Get Radius (by&nbsp;ID)</strong>, which read <em>this</em> agent when their
            <code> Agent</code> input is empty. One comes as a pair instead &mdash; a self node plus
            an explicit &ldquo;(by ID)&rdquo; sibling: <em>Apply Force</em> /{' '}
            <em>Apply Force To Agent</em> (there the by-id node has no self meaning &mdash; use
            <em> Apply Force</em> for that). A handful are self-anchored by nature and say so: the
            field nodes act on the cells <em>under this agent</em>, and <em>Rewire Bond</em> /{' '}
            <em>Set Bond Attribute</em> act on a bond you are an endpoint of (the third-party form
            of a rewire is <em>Transfer Bond</em>).
          </p>
          <p className={styles.p}>
            Wiring an id has a consequence worth knowing: writing another agent&rsquo;s{' '}
            <em>velocity</em>, <em>target radius</em>, <em>position</em>, <em>radius</em> or{' '}
            <em>attribute</em> is an overwrite, so the last writer wins and the result depends on
            the order agents run in. Those are the writes restricted to Asynchronous mode and to
            the CPU engines. <em>Kill Agent</em> and <em>Apply Force To Agent</em> have no such
            restriction &mdash; prefer them when you want a rule that behaves identically on every
            engine.
          </p>
          <h3 className={styles.h3}>Auto &mdash; and why JS is not a peer</h3>
          <p className={styles.p}>
            The <strong>Engine</strong> radio (Properties &rarr; Execution, and its twin for agents) takes an
            <em>intent</em> rather than a backend: <strong>Auto</strong> means &ldquo;the fastest engine this model
            can use&rdquo;. It resolves to <strong>WebGPU</strong> when every gate for this model passes and
            <strong>WebAssembly</strong> otherwise &mdash; with one exception: a model that runs
            <strong>Overseer experiments</strong> resolves to a CPU engine, because <em>Set Random Seed</em> pins a
            run there and sweeps reproduce, which the GPU&rsquo;s per-thread RNG cannot offer. Auto always
            <em>displays</em> its pick and the reason, so the choice is never silent, and it re-picks as you edit.
            Picking an engine explicitly is never overridden: if a gate rejects it the model still runs (on the JS
            fallback) and the readout plus the simulator chip say so in amber.
          </p>
          <p className={styles.p}>
            <strong>Debug / Reference (JS)</strong> lives under <em>Advanced</em> because it is not a production
            choice &mdash; it is the <em>definition</em> of what your graph means. WebAssembly is verified
            bit-identical to it by a permanent parity harness, and WebGPU is statistically equivalent. That is also
            why <strong>Show Code always shows the JS source</strong>, whatever engine you run: reading your own rule
            should never require switching the engine you are debugging. The panel&rsquo;s header names the engine
            that is actually running, and the document around the source describes the model state and the driver
            the engine wraps it in &mdash; enough to port the model elsewhere.
          </p>
          <h3 className={styles.h3}>Engine compatibility &mdash; three principles</h3>
          <p className={styles.p}>
            Every &ldquo;X doesn&rsquo;t work on Y&rdquo; in GenesisCA follows from three sentences.
            <strong> Properties &rarr; Compatibility</strong> shows, for this model, which engines each
            layer (CA grid / agents) can use and why not the others &mdash; computed from the same
            checks the compilers enforce, so it can never drift from what actually happens.
          </p>
          <ol className={styles.list}>
            <li><strong>Sequential vs parallel.</strong> A rule is <em>sequential</em> when a write is
              visible to a later cell or agent in the <em>same</em> generation (asynchronous mode,
              neighbour writes, cross-agent overwrites, order-dependent indicator ops). The CPU
              engines run sequential <em>and</em> parallel rules; <strong>the GPU runs only parallel
              ones</strong>. Every hard block is this one sentence.</li>
            <li><strong>CPU is exact; GPU is statistical.</strong> JavaScript and WebAssembly use f64
              math and one shared seeded stream, so runs are bit-reproducible and <em>Set Random
              Seed</em> pins them (which is what Overseer sweeps, oracles and replays need). WebGPU
              uses f32 and a per-thread RNG &mdash; statistically equivalent, never bitwise.</li>
            <li><strong>Speed paths are eligibility, not correctness.</strong> GPU residency, sparse
              stepping, direct render and the GPU field bridge change milliseconds per generation,
              never results. A model that misses one computes exactly the same thing, just slower.</li>
          </ol>
          <p className={styles.p}>
            Each reason in the Compatibility block carries its class: <strong>S</strong> semantics
            (a blocker &mdash; principle 1), <strong>R</strong> reproducibility (a note &mdash;
            principle 2), <strong>F</strong> fast path (a note &mdash; principle 3), and
            <strong> C</strong> capacity (a resource limit, always stated <em>with its number</em>
            &mdash; every one of them is tabulated under &ldquo;Engine capability matrix&rdquo; below).
          </p>
          <p className={styles.p}>
            <strong>Copying the readout.</strong> Compatibility and Generation Pipeline are read-only
            reports you will often want to paste into a bug report or a chat. Their text is freely
            selectable, and each section header carries a <code>&#x29C9; Copy</code> button that
            renders the <em>whole</em> section as clean plain text &mdash; every engine verdict with
            its class-tagged reasons, or every pipeline phase with its owner, tempo and detail
            (inactive phases included, as &ldquo;off &mdash; needs X&rdquo;). The text is built from
            the same data the panel draws, so a pasted report always matches what you were looking at.
          </p>
          <p className={styles.p}>
            A common misreading this clears up: <em>bonds do not prevent WebGPU</em>. A bonded or
            graph-rewriting model runs on the WebGPU agent target perfectly well &mdash; it just
            forfeits <em>GPU residency</em> (class F), because applying a bond form/break/rewire or a
            division is serial data-structure surgery that happens on the CPU between generations,
            so each generation pays a round-trip instead of a whole frame running in one submit. At
            small populations WebAssembly is often faster for exactly that reason. Separately,
            <em> Graph Metrics &mdash; Growth Sweep</em> ships on WebAssembly because its
            Overseer sweep needs seed reproducibility (class R) &mdash; a different fact that used to look like the same one,
            and one you now declare directly (next section).
          </p>

          <h3 className={styles.h3}>Reproducibility: Exact or Statistical</h3>
          <p className={styles.p}>
            How much run-to-run variance your model tolerates is a property of the <em>model</em>,
            not of which radio button you pressed. Declare it in
            <strong> Properties &rarr; Execution &rarr; Reproducibility</strong>, and
            <strong> Auto</strong> becomes one sentence: <em>the fastest engine that satisfies this
            model&rsquo;s contract</em>.
          </p>
          <ul className={styles.list}>
            <li><strong>Exact</strong> (the default) &mdash; bit-reproducible trajectories. A fixed
              seed pins a run, so oracles, replays and differential comparisons hold. Auto keeps
              agents on a CPU engine.</li>
            <li><strong>Statistical</strong> &mdash; runs are draws from the same distribution;
              sweeps use N repeats and aggregates (<em>Collect Sample</em> &rarr; <em>Series
              Stat</em>: mean / std / ci95). Auto may use the GPU agent engine.</li>
          </ul>
          <p className={styles.p}>
            <strong>The guardrail</strong>: Statistical covers <em>stochastic variance around the
            same rule</em>. It never licenses answering a different question &mdash; a rule whose
            discrete decisions would change is not a candidate.
          </p>
          <p className={styles.p}>
            <strong>Why Exact still allows the GPU for the CA grid but not for agents.</strong> The
            two GPU layers seed their randomness differently. The <em>grid</em> gives every cell a
            PCG stream derived from one global seed, and <em>Set Random Seed</em> re-derives those
            streams &mdash; so a fixed seed <em>does</em> reproduce a grid run on this device (an
            Overseer sweep on the WebGPU grid reproduces press-to-press). The <em>agent</em> engine
            seeds its per-agent streams <em>once, when the GPU runtime is created</em>, and Set
            Random Seed never reaches them &mdash; so two presses of Run Experiment give different
            numbers. Exact therefore rules out the GPU agent engine and leaves the grid free. In both
            cases the GPU works in f32, so its numbers are never bit-identical to the CPU engines and
            may differ on another device: don&rsquo;t compare a GPU run against a CPU run.
          </p>
          <p className={styles.p}>
            Auto never picks an engine that breaks the contract. If you <em>explicitly</em> choose
            one that does &mdash; the WebGPU agent engine under Exact &mdash; nothing is overridden:
            it runs, and the Compatibility block plus the simulator&rsquo;s <code>&#x2699;</code>
            chip carry an amber note naming both ways out (switch the engine, or declare
            Statistical). Loading an older file infers the contract: <em>Statistical</em> if its
            agents already run on the GPU, otherwise <em>Exact</em>.
          </p>

          <h3 className={styles.h3}>What a seed actually pins</h3>
          <p className={styles.p}>
            Every simulation decision &mdash; your rule&rsquo;s <em>Get Random</em>, the engine&rsquo;s
            agent <strong>seed pattern</strong>, and the <strong>asynchronous visit order</strong>{' '}
            &mdash; draws from ONE seeded stream. So on the CPU engines,{' '}
            <em>Set Random Seed</em> followed by <strong>Reset</strong> reproduces a run exactly:
            the same starting layout, the same order the cells are visited, the same trajectory.
            (Both the agent <em>scatter</em> pattern and the async order used to sit outside that
            stream and could never be pinned; they now join it.)
          </p>
          <p className={styles.p}>
            Two things this deliberately does <em>not</em> do. A fresh session starts from a random
            seed, so a stochastic model still surprises you the first time &mdash; determinism is
            something you <em>ask for</em>. And <strong>Reset does not re-seed</strong>: the stream
            keeps advancing, so pressing Reset twice re-rolls (exactly as a per-cell{' '}
            <em>Get Random</em> in an Init Event has always done). To pin a run, set the seed and{' '}
            <em>then</em> Reset &mdash; which is what the Overseer&rsquo;s seed policy does for you.
          </p>

          <h3 className={styles.h3}>Nothing is resolved silently</h3>
          <p className={styles.p}>
            Wherever the engine resolves a value differently from what you wrote, the panel shows the
            resolved value <em>and the reason</em>. <strong>Time Step &Delta;t</strong> is
            auto-clamped for stability (&Delta;t &le; 0.2 / (Repulsion &mu; + Bond &lambda;)) &mdash;
            when the clamp bites, the effective number and &mu;<sub>eff</sub> are shown under the
            field. <strong>Capability rows</strong> that a dependency turned on are marked
            &ldquo;(required by &hellip;)&rdquo; naming what to switch off to release them. And the
            simulator&rsquo;s <code>&#x2699;</code> target chip turns amber whenever the engine is
            <em> not</em> running the target you asked for &mdash; hover it for the reason.
          </p>

          <h3 className={styles.h3}>Which fast paths actually engaged</h3>
          <p className={styles.p}>
            Compatibility answers <em>which engine can run this</em>; the Generation Pipeline answers{' '}
            <em>what a generation does</em>. Both describe what your model <em>asks for</em>. To see
            what the engine <em>actually did</em>, click the <code>&#x2699;</code> target chip in the
            simulator&rsquo;s bottom-right readout. The diagnostics popover reports, for the run in
            progress:
          </p>
          <ul className={styles.list}>
            <li><strong>Engine</strong> &mdash; the resolved engine per layer, and (in amber) any
              layer whose loop fell back at <em>runtime</em> rather than at compile time.</li>
            <li><strong>Fast paths</strong> &mdash; GPU residency, sparse stepping, the GPU field
              bridge, the agent neighbour index and direct render, each either <em>engaged</em> (with
              its number: batches, cells, generations, bins) or <em>off</em> followed by the{' '}
              <strong>first blocking reason</strong>. That reason comes from the same predicate the
              engine decided with, so it cannot drift.</li>
            <li><strong>Agent neighbour index</strong> is worth knowing about specifically. Agent
              neighbour queries run against a uniform spatial hash whose bin edge is the{' '}
              <em>largest</em> radius anything needs &mdash; interaction range &times; 2 &times;
              radius, Neighbour Query Radius, or the charge cutoff. If the world is under{' '}
              <strong>3 bins wide on any axis</strong> at that edge, the hash cannot be built (a
              wrapping stencil would count a neighbour twice), and every query falls back to
              comparing <em>all pairs</em> &mdash; correct, but quadratic. This row names that, and
              names the setting to lower. A 3D world is the usual case: a large Neighbour Query
              Radius easily exceeds a third of a shallow depth.</li>
            <li><strong>Events</strong> &mdash; every fallback since the model loaded: a failed WASM
              instantiate, a lost GPU device, a spatial hash that outgrew its reserve. These used to
              reach only a transient banner or the browser console; now they persist, so you can ask
              &ldquo;did anything degrade during that run?&rdquo; after the fact.</li>
          </ul>
          <p className={styles.p}>
            A fast path that is off is <em>never</em> an error &mdash; principle 3 again: it computes
            exactly the same thing, only slower. The popover is requested on demand and costs nothing
            while closed.
          </p>
          <p className={styles.p}>
            <strong>Hovering an agent model does not cost anything by itself.</strong> When the
            agent layer renders straight from the GPU, the page normally never sees the agent
            positions at all &mdash; which is where the speed comes from. Some things genuinely need
            them back on the page each frame, and those hand the frame back: an open inspector,
            recording, the vision-cone display, metaballs, being paused, and an{' '}
            <em>agent brush that highlights agents</em> &mdash; Remove, Move, Edit, Push, Pull,
            Glue and Cut all ring the agents they would touch, and Shift (or the{' '}
            <code>&#x24D8;</code> Inspect toggle) picks one. The default <strong>Add</strong> brush
            highlights nothing, so simply resting the cursor over the simulation in Add mode is free.
            And whatever the mode, if the cursor does not move for <strong>3 seconds</strong> the
            highlights are dropped and the fast path resumes on its own; the moment you move again
            they come straight back.
          </p>
          <p className={styles.p}>
            You do not have to open the popover to find out that something degraded. The first time
            the engine falls back at runtime it raises a <strong>one-time amber toast</strong> naming
            what happened, and the <code>&#x2699;</code> chip <em>stays</em> amber (with a{' '}
            <code>&#x26a0;</code>) for the rest of the session, its tooltip counting the fallbacks. A
            fallback repeating never re-toasts &mdash; one notice per distinct message. Note the
            deliberate split: a fallback is <em>not</em> a compile error (your model still runs, on a
            different engine or path), so it no longer paints the red error banner; and a
            <em> compile-time</em> restriction is a property of the model rather than an event, so it
            shows in the Compatibility readout and never toasts at all.
          </p>

          <h3 className={styles.h3}>Engine capability matrix</h3>
          <p className={styles.p}>
            Which agent nodes each engine compiles, and which capability reveals each node in the
            palette. <strong>This table is generated from the compilers&rsquo; own lookup tables</strong>{' '}
            (the node registry, the capability requirements, and each target&rsquo;s supported-type
            set), so it is definitionally in sync with what is enforced &mdash; a node added to the
            catalogue appears here automatically, and a build check fails if it does not.
          </p>
          <p className={styles.p}>
            <span style={{ color: '#5cbf7a' }}>&#10003;</span> compiles on that engine.{' '}
            <span style={{ color: '#e07070' }}>&#10007;</span> not ported &mdash; placing it in the
            behaviour graph clamps that layer to a CPU engine (the result is identical, the speed is
            not). <span style={{ opacity: 0.6 }}>&mdash;</span> runs there anyway: it is an
            entry-point root, it is rewritten into other nodes before compiling, or it runs on the
            CPU by design on <em>every</em> engine (the Division Event and Agent Init Event always do).
          </p>
          <CapabilityMatrixReference />
          <p className={styles.p}>
            Of {NODE_COUNTS.agent} agent nodes, {NODE_COUNTS.agentOnWasm} compile on WebAssembly and{' '}
            {NODE_COUNTS.agentOnWebgpu} on WebGPU; {NODE_COUNTS.agentGapsWasm} and{' '}
            {NODE_COUNTS.agentGapsWebgpu} respectively are genuine gaps, the rest being roots,
            lowered nodes, or the {NODE_COUNTS.agentCpuRoots} always-CPU roots.
          </p>

          <h4 className={styles.h4}>What the WebGPU CA grid rejects</h4>
          <p className={styles.p}>
            The grid engine&rsquo;s complete reject list &mdash; every one an instance of principle 1
            (the GPU runs parallel rules only). Asynchronous update mode is rejected at the model
            level for the same reason.
          </p>
          <GridRejectReference />

          <h4 className={styles.h4}>Capacity limits</h4>
          <p className={styles.p}>
            Class-C bounds, each with its actual number. Exceeding one never corrupts a result: the
            engine either clamps to a CPU path or rejects the excess with a notice.
          </p>
          <CapacityLimitsReference />

          <h3 className={styles.h3}>What runs each generation</h3>
          <p className={styles.p}>
            A CA-grid generation is easy to picture: <em>your Generation Step graph is the rule</em>,
            and the engine only double-buffers and runs the colour pass. An <strong>agent</strong>{' '}
            generation is a longer sequence, and only two or three of its phases are your graphs.
            <strong> Properties &rarr; Generation Pipeline</strong> lists it for <em>your</em> model:
            in execution order, with each phase marked as <em>your graph</em> or <em>the engine</em>,
            tagged with how often it runs, and showing the resolved numbers it reads (the actual
            &Delta;t, momentum, stiffnesses, iteration count). Phases that are off for your model stay
            visible, struck through, naming the capability that would switch them on &mdash; so
            &ldquo;is the engine doing something I didn&rsquo;t ask for?&rdquo; is answerable at a glance.
          </p>
          <p className={styles.p}>
            Every phase the engine can run, in execution order. No single model uses them all &mdash;
            some are mutually exclusive (soft-sphere <em>or</em> positional collision; a synchronous
            double-buffer swap <em>or</em> an asynchronous shuffle) &mdash; so your model will show a
            subset, with the rest struck through:
          </p>
          <GenerationPipelineReference />
          <p className={styles.p}>
            The <strong>tempo</strong> tag matters as much as the order. <em>Per generation</em> is the
            hot path &mdash; it runs once for every generation, so N times per rendered frame.
            <em> Per event</em> runs only when its event happens (your Division Event fires once per
            daughter, per division). <em>Per frame</em> is amortized by Gens/Frame, so the colour
            passes are orchestration rather than hot-path work. <em>Once per reset</em> is the cold
            path &mdash; a one-time seeding loop. Agents step <em>before</em> cells because that is the
            closed loop: an agent samples the field as of the previous cell step, deposits into it,
            and the cell rule then incorporates that deposit.
          </p>
          <p className={styles.p}>
            The panel is read-only and comes from the same resolvers the engine consults, so it
            cannot drift from what actually runs. It describes what the model <em>asks for</em>;
            whether a speed path engaged at runtime is a separate question (see the three principles
            above).
          </p>

          <h3 className={styles.h3}>Is the layout part of your rule, or just how it looks?</h3>
          <p className={styles.p}>
            The force / motion / layout phases above are the biggest block of engine behaviour you
            did not write. For many models they decide <em>only where things sit</em> &mdash; the
            emergent behaviour would be identical under any layout. GenesisCA works that out from
            your graphs and says so: those phases carry a{' '}
            <strong>presentation</strong> tag and the line{' '}
            <em>&ldquo;presentation only &mdash; does not affect your rule&rdquo;</em>, and{' '}
            <strong>Properties &rarr; Compatibility</strong> opens with{' '}
            <strong>Layout is presentation</strong>.
          </p>
          <p className={styles.p}>
            The test is <strong>dataflow</strong>, not &ldquo;does the graph contain a position
            node&rdquo;. Geometry is presentation as long as no path leads from a{' '}
            <em>geometry read</em> &mdash; positions, offsets, velocities, curvature, proximity
            queries (Get Nearby Agents, Get Agents In View, Sense Hemifield, Neighbour Density, a
            <em> nearby</em> Neighbour Census), field samples at the agent&rsquo;s location, a
            bond&rsquo;s current length &mdash; into <em>non-geometric state</em>: an attribute or
            indicator write, a Stop Event, a field deposit, or the condition/target of a structural
            verb. Geometry that feeds only <strong>Apply Force</strong>,{' '}
            <strong>Set Velocity</strong>, <strong>Set Agent Position / Radius</strong>,{' '}
            <strong>Set Target Radius</strong> or a colour keeps geometry in a closed loop and stays
            presentation &mdash; placing a newborn at the midpoint between two agents is the classic
            example. Two engine settings count as reading geometry with no wire to follow:{' '}
            <strong>Auto-bond</strong> (the engine bonds by distance, so the topology your rule reads
            was built from where agents sit) and a <strong>Divide Agent</strong> using the{' '}
            <em>tension</em> partition (geometry decides which bonds each daughter keeps).
          </p>
          <p className={styles.p}>
            <strong>Reading a position is a promotion, not a problem.</strong> A model that does it
            is fully supported and behaves exactly as before &mdash; it simply means the layout
            physics are <em>part of what your simulation computes</em> rather than how it looks, so
            the readout says <strong>Layout is part of your rule</strong> and shows you the exact
            path that made it so (e.g.{' '}
            <em>Get Nearby Agents &rarr; For Each In Array &rarr; Form Bond &middot; targetAgent</em>).
            Among the shipped samples, <em>Boids</em> and <em>Particle Life</em> are presentation
            (their sensing feeds only forces), while <em>SDCA</em> is not: it bonds agents chosen
            by a proximity query. The check is deliberately conservative
            &mdash; anything it cannot prove clean it treats as part of the rule.
          </p>

          <h3 className={styles.h3}>Enabling Agents</h3>
          <p className={styles.p}>
            In <strong>Properties &rarr; Execution &rarr; Topology</strong>, tick
            <strong> Bond-Graph Agents</strong> (alongside <strong>Grid Cells</strong> &mdash;
            at least one must stay on). A <strong>Bond-Graph Agents</strong> config block
            appears below, and a <strong>Cells / Agents</strong> tab strip appears above the
            graph canvas.
          </p>
          <h3 className={styles.h3}>Agent Capability Profiles (show only what you use)</h3>
          <p className={styles.p}>
            The agent engine is <strong>composed from opt-in capability modules</strong>, so a
            model shows only its paradigm&rsquo;s machinery instead of the whole morphogenesis
            toolkit. In <strong>Properties &rarr; Agent Capabilities</strong> pick a{' '}
            <strong>preset</strong> (Particle System, Boids, Vivarium, Morphogenesis, Social
            Network, CA-on-Agents) or toggle individual capabilities &mdash; <strong>Motion</strong>{' '}
            (Static / Velocity / Force), <strong>Body</strong>, <strong>Collision</strong>,{' '}
            <strong>Charge</strong>, <strong>Bonds</strong> (Data edges / Physics springs), <strong>Growth</strong>,{' '}
            <strong>Division</strong>, <strong>Lifespan</strong>, <strong>Population</strong>,{' '}
            <strong>Sensing</strong>, <strong>Orientation</strong>, and{' '}
            <strong>Field coupling</strong>. The palette, the <strong>Behaviour Step</strong>{' '}
            output ports, and the agent Edit/inspector panels then filter to what&rsquo;s enabled &mdash;
            a social-graph author never sees <code>radius</code>, <code>force</code>, or{' '}
            <strong>Divide Agent</strong>. Dependencies resolve automatically (enabling
            <strong> Collision</strong> auto-enables <strong>Body</strong>; <strong>Bonds =
            Physics</strong> needs <strong>Motion = Force</strong>), and a live{' '}
            <strong>per-agent footprint</strong> readout shows the memory cost of each choice.
            Existing models load with a tight, honest profile inferred from what their graph
            actually uses. The physics capabilities also drive the ENGINE: <strong>Collision</strong>{' '}
            is volume exclusion &mdash; <em>Soft-sphere</em> is a springy repulsion force (agents may
            transiently overlap) while <em>Positional</em> is a rigid no-overlap constraint (billiard
            balls; tune with <em>Positional iterations</em>) &mdash; <strong>Bonds = Physics</strong>{' '}
            makes bonds spring (Data bonds are force-free edges), and{' '}
            <strong>Growth</strong> runs the radius ramp &mdash; each independently of the legacy
            &ldquo;Use bonding physics&rdquo; master toggle. The profile also <strong>shrinks the
            per-agent memory the engine allocates</strong>: a capability that is off, and whose field
            no node reads, is simply <em>not allocated</em> &mdash; sprite state (36 B/agent), age,
            target radius and neighbour density all drop out, and the footprint readout shows what
            you saved. The gate is widened by ACTUAL USE, so a node you left on the canvas keeps its
            field; if a field really is gone, reading it yields 0 rather than breaking.
          </p>
          <h3 className={styles.h3}>Charge &mdash; the long-range force that keeps a graph readable</h3>
          <p className={styles.p}>
            Every other engine force is <em>short</em>-range: soft-sphere repulsion only pushes
            back once two agents are closer than their combined radii, and it turns to
            <em> attraction</em> past that. So if your bonds rest at, say, 5 units while contact
            distance is 1.8, an agent never resists anything until something is practically on top
            of it &mdash; and a graph that keeps growing collapses into an unreadable jammed blob.
            Widening <strong>Interaction range</strong> does <strong>not</strong> fix this: it
            widens the <em>search</em>, not the force.
          </p>
          <p className={styles.p}>
            <strong>Charge</strong> (Properties &rarr; Agent Capabilities, off by default) adds the
            missing long-range term &mdash; a repulsion between every pair inside a{' '}
            <strong>cutoff</strong>, falling off as <code>1/(1+d&sup2;)</code> and reaching exactly
            zero at the cutoff. Two knobs appear when you turn it on:
          </p>
          <ul className={styles.ul}>
            <li>
              <strong>Charge strength</strong> &mdash; negative repels (the layout-opening case),
              positive attracts. Default &minus;3.
            </li>
            <li>
              <strong>Charge cutoff</strong> &mdash; how far the force reaches. Defaults to{' '}
              <strong>8&times; your bond rest length</strong>; clear the field to restore that.
              Layout quality saturates around there, so a much larger cutoff mostly just{' '}
              <em>inflates</em> the whole structure while costing more per step.
            </li>
          </ul>
          <p className={styles.p}>
            Measured on a graph grown from K4 to 1200 nodes by triangle split: without charge{' '}
            <strong>99.2%</strong> of nodes had an unrelated node inside contact distance, and
            unrelated nodes sat ~16&times; closer than bonded partners. With charge at the default
            cutoff that drops to <strong>~0%</strong>, and because the layout is no longer maximally
            dense the simulation also runs <em>faster</em>. Charge needs{' '}
            <strong>Motion = Force</strong> and runs on all three agent targets (JS, WebAssembly,
            WebGPU) in both 2D and 3D.
          </p>
          <p className={styles.p}>
            <strong>Cost &mdash; keep the 3D cutoff tighter.</strong> The neighbour search sweeps a
            3&times;3 block of hash bins in 2D but a 3&times;3&times;3 <em>volume</em> in 3D, so at
            the same cutoff a 3D model examines several times as many candidates (measured on a
            uniform packing: ~124 candidates/agent in 2D at 4&times; rest vs ~813 in 3D). In 3D
            start around <strong>4&times;</strong> the bond rest length rather than 8&times;.
          </p>
          <p className={styles.p}>
            <strong>Strength is a cheaper lever than reach &mdash; try it before widening the
            cutoff.</strong> The hash bin edge <em>is</em> the cutoff, so doubling the reach
            quadruples the candidates every agent examines, while making <em>k</em> more negative
            costs nothing at all. Measured on a growing bonded graph: a
            4&times;-rest cutoff at <em>k</em> = &minus;10 gives the same layout quality as an
            8&times;-rest cutoff at the default &minus;3, and runs <strong>2.6&times; faster</strong>.
            If a structure still looks cramped, reach for the strength first.
          </p>
          <p className={styles.p}>
            <strong>Two things charge cannot fix, and both are worth checking first.</strong> If
            the <em>world</em> is too small the graph simply has nowhere to go &mdash; size it to
            your agent <em>cap</em>, roughly{' '}
            <code>side = sqrt(maxAgents &times; (bond rest &times; 1.45)&sup2;)</code>, since a
            charged layout settles at about 1.45&times; the rest length per link. And if the rule
            <em> rewrites</em> faster than the solver can untangle, no force helps: give the rule a{' '}
            <strong>Periodic Step</strong> (rewrite every Nth generation) or raise{' '}
            <strong>Layout iterations</strong> below.
          </p>
          <h3 className={styles.h3}>Charge range &mdash; Cutoff or Global (Barnes&ndash;Hut)</h3>
          <p className={styles.p}>
            <strong>Charge range</strong> (Properties &rarr; Bond-Graph Agents, inside the charge
            block) chooses <em>which law</em> the charge runs, not how fast it runs.{' '}
            <strong>Cutoff</strong> is the force described above: every pair inside{' '}
            <em>charge cutoff</em> repels, and nothing beyond it does.{' '}
            <strong>Global (Barnes&ndash;Hut)</strong> removes the cutoff entirely &mdash;{' '}
            <em>every</em> pair interacts, with distant groups approximated by their centre of mass
            when <code>extent&sup2; &lt; &theta;&sup2;&middot;d&sup2;</code>. Smaller{' '}
            <strong>&theta;</strong> is more exact and slower; the default 0.9 is the usual choice.
          </p>
          <p className={styles.p}>
            <strong>Why it matters: a cutoff cannot open a graph that outgrows it</strong>, however
            you tune it. Measured on a growing GRA blob in a world scaled to its population, with
            the same seed and the same number of relaxation ticks &mdash; nearest-non-bonded /
            bond length (higher is better) and the share of nodes with an unrelated node inside
            contact distance:
          </p>
          <ul className={styles.ul}>
            <li><strong>N = 2 500</strong> &mdash; cutoff 0.53 / 16.9 % overlap &rarr; global{' '}
              <strong>0.83 / 4.2 %</strong>, at <strong>0.61&times;</strong> the cost per tick</li>
            <li><strong>N = 5 000</strong> &mdash; cutoff 0.47 / 37.9 % &rarr; global{' '}
              <strong>0.82 / 4.9 %</strong>, at <strong>0.61&times;</strong></li>
            <li><strong>N = 20 000</strong> &mdash; cutoff 0.37 / 82.1 % &rarr; global{' '}
              <strong>0.81 / 4.4 %</strong>, at <strong>0.73&times;</strong></li>
          </ul>
          <p className={styles.p}>
            The shape is what counts: the cutoff law <em>degrades</em> as the graph grows while the
            global one holds flat. It is also <em>cheaper</em> here, because a wide cutoff forces a
            wide neighbour-search grid while the tree does not. For a small or sparse model the
            cutoff remains the simpler, perfectly good choice &mdash; and every shipped model keeps
            it.
          </p>
          <p className={styles.p}>
            <strong>Approximate is not the same as random.</strong> The tree is rebuilt from the
            positions with a canonical ordering, so the JS and WebAssembly engines produce{' '}
            <em>bit-identical</em> forces every run: a fixed seed still replays exactly and an
            Overseer sweep still reproduces. &theta; changes which law you run, not whether it
            repeats. (WebGPU is f32, so it is statistically equivalent &mdash; the same deal that
            target already offers.) One cost to know about: while Global is on, the GPU{' '}
            <em>residency</em> fast path is off, because the tree is rebuilt on the CPU each
            generation &mdash; the diagnostics popover says so.
          </p>
          <h3 className={styles.h3}>Layout iterations &mdash; more relaxation per generation</h3>
          <p className={styles.p}>
            <strong>Layout iterations</strong> (Properties &rarr; Bond-Graph Agents &rarr; Solver,
            default <strong>1</strong>) runs the force integrator that many times per generation.
            It is a solver setting, not rule logic &mdash; which is exactly why it is a knob here
            and <em>not</em> a node in your graph: how many times the solver iterates is numerical
            relaxation, the same category as Positional iterations. Everything that means one
            generation still happens once: agent <strong>age</strong> advances by one, the growth
            ramp advances by one step, and the structural phase (bond form / break / rewire,
            division, death) runs exactly once, after the last iteration.
          </p>
          <p className={styles.p}>
            It pairs with <strong>Periodic Step</strong> rather than replacing it. Raising layout
            iterations gives the layout more time <em>without</em> changing what a generation
            means &mdash; useful when your model counts generations (indicators, end conditions, an
            Overseer budget). A Periodic Step instead slows the <em>rule</em> down, which is what
            you want when the rule itself should tick more slowly than the physics. Relaxation
            passes per rule step = <em>period</em> &times; <em>layout iterations</em>; the shipped{' '}
            <strong>Growing Graphs</strong> hangs its whole rule off a Periodic Step, and{' '}
            <strong>SDCA</strong> &mdash; whose
            population is fixed, so there is no growth to outrun &mdash; uses 2 layout iterations
            instead.
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
            and universal nodes (math, conditionals, <strong>Get / Set Attribute</strong>,
            <strong> Set Cell Looks</strong>) in both. <em>Macros are shared</em> between the two
            graphs.
          </p>
          <h3 className={styles.h3}>Agent Attributes &amp; Variables (separate from the grid)</h3>
          <p className={styles.p}>
            Agents have their <strong>own state</strong>, distinct from the grid&rsquo;s. On the
            <strong> Agents</strong> tab the <strong>Attributes</strong> panel lists
            <strong> Agent Attributes</strong> (per-agent fields with their own +Add), and the
            <strong> Local Variables</strong> there are agent-scoped. On the Agents tab the
            universal <code>Get Attribute</code> / <code>Update Attribute</code> nodes display as
            <code> Get / Update Self Attribute</code> &mdash; they read and modify the
            agent&rsquo;s own attributes. <code>Set Attribute</code> grows an optional{' '}
            <code>Agent</code> input there: leave it empty to write the current agent, or wire an
            id to write <em>another</em> agent&rsquo;s attribute. <code>Get Agent Attribute</code>{' '}
            is the read-side by-id sibling (reads stay a separate node &mdash; a by-id read is
            impure, so it cannot share the own-read&rsquo;s caching/hoisting classification).
          </p>
          <p className={styles.p}>
            <strong>An empty <code>Agent</code> input means <em>this</em> agent.</strong> That is the
            convention across the whole optional-id family &mdash; <em>Get Attribute (by&nbsp;ID)</em>,{' '}
            <em>Get Position (by&nbsp;ID)</em>, <em>Get Radius (by&nbsp;ID)</em>,{' '}
            <em>Get Velocity</em>, <em>Set Attribute</em>, <em>Set Velocity</em>,{' '}
            <em>Set Target Radius</em>, <em>Kill Agent</em> and <em>Set Agent Sprite</em>. So on the
            Agents graph, where <em>Get Attribute (by&nbsp;ID)</em> reads simply as &ldquo;Get
            Attribute&rdquo;, dropping one in where <em>Get Self Attribute</em> was meant now does
            the sensible thing rather than silently reading 0. (The dedicated self nodes &mdash;{' '}
            <em>Get Self Attribute</em>, <em>Get Self Position</em>, <em>Get Radius</em> &mdash; are
            still there, and a self read through them is cheaper for the compiler to share and
            hoist.)
          </p>
          <p className={styles.p}>
            A handful of by-id nodes have <strong>no</strong> self meaning, so leaving their{' '}
            <code>Agent</code> input empty really is a silent no-op &mdash; and the modeler{' '}
            <strong>badges</strong> those: <em>Get Agent Offset</em> (an offset to yourself is
            always zero), <em>Set Agent Position</em>, <em>Set Agent Radius</em> and{' '}
            <em>Apply Force To Agent</em>. For the three writers an empty <code>Agent</code> writes
            nothing at all &mdash; they exist to configure a <em>Create Agent</em> handle, so
            defaulting them to self would quietly retarget an existing rule; each badge names the
            self-acting node (<em>Set Target Radius</em>, <em>Apply Force</em>) to use instead.
          </p>
          <p className={styles.p}>
            Agents sit <strong>above</strong> the CA: they can read and write grid cells (the field
            bridge below), but grid cells can <strong>never</strong> read agent state. To let agents
            touch a cell attribute, set its <strong>Agent access</strong> (in the cell attribute&rsquo;s
            editor) to <strong>Readable</strong> (field reads) or <strong>Readable &amp; writable</strong>
            (field reads + writes). Cell attributes with access <em>None</em> stay invisible to agents.
          </p>
          <h3 className={styles.h3}>Key Agent Nodes</h3>
          <ul className={styles.list}>
            <li><strong>Behaviour Step</strong> &mdash; the per-agent entry root (one per Agents
              graph). Outputs the agent's own <code>X</code> / <code>Y</code> (and
              <code> Z</code> in a 3D model) / <code>Radius</code> / <code>Area</code> /
              <code> Bond Degree</code> / <code>Age</code>. (Agents have <em>no built-in
              type</em> &mdash; describe an agent with your own Agent Attributes.)</li>
            <li><strong>Periodic Step</strong> &mdash; an entry root that runs its chain
              <strong> only every Nth generation</strong> (<code>generation % Period === Phase</code>).
              Unlike Behaviour Step you may place <strong>several</strong>: two at Period 2 with
              phases 0 and 1 alternate &mdash; states on even ticks, rewrites on odd &mdash; and
              three at 1 / 5 / 50 give a fast, a medium and a slow clock in one model. A plain
              Behaviour Step can sit alongside them; its chain still runs every generation.
              Outputs <strong>Step Index</strong> = &lfloor;generation &divide; Period&rfloor;, the
              rule-step counter. Why a root rather than wiring the modulo yourself: it gates the
              state update and the rewrite on the <em>same</em> tick, which is what keeps a
              periodic automaton faithful.</li>
            <li><strong>Get Self Position / Get Radius / Get Bond Degree / Neighbour Density</strong>
              &mdash; read the agent's geometry and its local crowding.{' '}
              <strong>Neighbour Density</strong> has two modes, decided by its optional
              <strong> Radius</strong> input. Leave it unwired (or 0) and it reads the ENGINE's own
              count: the agents inside the interaction cutoff{' '}
              <code>Interaction Range &times; (r<sub>i</sub> + r<sub>j</sub>)</code> &mdash; a{' '}
              <em>relative</em> range that scales with the pair's radii &mdash; counted for free by
              the force pass and therefore <em>one generation stale</em>. Wire a Radius (a model
              attribute makes it a live slider) or type one, and you get a <em>fresh</em> count,
              this generation, of the other agents within that <em>absolute</em> distance. Keep it
              &le; the model's <strong>Neighbour Query Radius</strong>: the spatial hash is sized to
              that, so a larger radius silently under-counts &mdash; the same rule Get Nearby Agents
              follows, because that is exactly what the node lowers to.</li>
            <li><strong>Get Self Handle</strong> &mdash; the current agent's own id. Pass it to the
              by-id nodes (Get Agent Attribute, a wired Set Attribute, Get Agent Position,
              Form/Break Bond) so a
              neighbour can reference back to you, or to compare a Get Nearby Agents id against
              self.</li>
            <li><strong>Set Target Radius</strong> &mdash; set the size the agent grows toward;
              the engine ramps the actual radius each step. A grown agent is what divides.</li>
            <li><strong>Form Bond / Break Bond / Rewire Bond / For Each Bond</strong> &mdash; create,
              remove or <em>move</em> a bond between two agents, or iterate this agent's bonds
              (exposing the partner, rest length, and current length) to act per-bond (e.g. break an
              over-stretched bond). <strong>Form Bond and Break Bond both take an optional
              &ldquo;Agent A&rdquo;</strong>: leave it unwired and it is this agent (the usual
              case), or wire it to bond &mdash; or cut &mdash; two <em>other</em> agents.
              <strong>Rewire Bond</strong> moves one bond from one partner to
              another <em>atomically</em> &mdash; see &ldquo;Rewiring the graph&rdquo; below. Bonds can
              also form <strong>automatically by distance</strong> (the Auto-bond option), the simplest
              path to a glued cluster.</li>
            <li><strong>Divide Agent</strong> &mdash; split the agent into two daughters along its
              <strong> tension axis</strong> (the net-stretch direction of its bonds), so a glued
              cluster cleaves along its mechanical axis. <strong>Partition</strong> says which bonds
              each daughter inherits &mdash; see &ldquo;Dividing: which daughter gets which
              bond?&rdquo; below &mdash; and, in a 3D model, <strong>Conserve</strong> says whether
              the daughter radii preserve area or volume. A
              <strong> Division Event</strong> root (optional) runs once per daughter so you can
              give them different attribute values (asymmetric inheritance) &mdash; see
              &ldquo;The Division Event: configuring the daughters&rdquo; below.</li>
            <li><strong>Kill Agent</strong> &mdash; remove an agent; all its bonds are broken
              safely. Leave <em>Agent</em> empty for apoptosis (kill yourself), or wire an id to
              <em>consume</em> a neighbour &mdash; predation. Unlike the by-id setters a wired kill
              works in <em>both</em> update modes and on <em>every</em> target, because setting a
              flag to 1 is idempotent: any number of predators electing the same prey, in any
              order, means the same thing.</li>
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
              Offset / Attribute / Radius / Get Velocity</strong>, bond to it, or steer from it.</li>
            <li><strong>Get Agents In View</strong> &mdash; the directional version: only the nearby
              agents inside a heading-relative <strong>vision cone</strong> (how FAR it sees is the
              node&apos;s <em>Radius</em> input &mdash; an inline number box on the port row, default 5;
              how WIDE is the <em>Half-angle°</em> config, plus a <em>Heading</em> source &mdash;
              the agent&apos;s Velocity, or a Wired direction). A
              still agent (zero heading) sees all around; 180° is the full omnidirectional radius. Ideal
              for predators/prey that only react to what's in front of them.</li>
            <li><strong>Sense Hemifield</strong> &mdash; the Braitenberg <strong>Left / Right</strong>
              sensor: it runs the same vision cone but splits it &mdash; which neighbours fall to the
              <em> left</em> of the heading versus the <em>right</em>. Steer by
              <em>Left &minus; Right</em> to turn toward (or away from) the crowded side &mdash;
              taxis and flocking asymmetry emerge from those two numbers alone. Same two knobs as
              above: the <em>Radius</em> input sets how far it senses, <em>Half-angle°</em> how wide
              (the 90° default is a 180° front hemisphere). Besides the two counts it also outputs
              the two <strong>id arrays</strong> &mdash; <em>Left Agents</em> and
              <em> Right Agents</em> &mdash; so you can <em>act</em> on a side, not merely measure
              it: feed one to <em>For Each In Array</em>, <em>Get Agents Attribute</em>,
              <em> Filter Agents</em> or <em>Aggregate</em> to push only the neighbours on your left,
              or read the average speed of the ones on your right. The arrays are exactly the set
              the counts count (a side&apos;s length always equals its count), and an array output
              you leave unwired costs nothing at all. The
              <em> Boids &mdash; Hemifield Vision</em> sample is built entirely from these counts.</li>
            <li><strong>Seeing the cones</strong> &mdash; when a model uses either FOV node, the
              Simulator&apos;s agent controls (2D) gain a <strong>Show vision</strong> selector that
              draws each node&apos;s sensing cone as a translucent wedge, with a faint
              <strong> dotted centre line</strong> along the heading so the <em>left</em> and
              <em> right</em> halves of the field (what Sense Hemifield counts) are readable at a
              glance &mdash; for the <em>inspected/edited/hovered</em> agent, or <em>all</em>
              agents (capped at 1500). The <em>Inspected</em> scope follows the open agent
              inspectors and, while the <strong>Edit</strong> brush is active, its edit target
              (the cone appears and disappears together with the dashed edit highlight).
              The wedge follows the agent&apos;s velocity heading (Facing/Wired heading sources are
              approximated by it), and a wired Radius input falls back to the model&apos;s Neighbour
              Query Radius. Each FOV node gets its own tint from an automatic palette, or you can
              pick one per node with its <strong>Cone color</strong> setting (a display-only config
              &mdash; no compile-target effect) so several cones on the same agent stay readable.</li>
            <li><strong>Facing / orientation</strong> &mdash; to have an agent look in a stored
              direction rather than along its velocity, give it a <strong>Vector agent attribute</strong>
              (e.g. &quot;facing&quot;), set the FOV node's Heading to <em>Wired</em>, and wire that
              attribute into the Heading inputs through <em>Get Self Attribute</em> &rarr;
              <em>Break Vector</em>. A stationary sentry can then still watch a fixed cone, and you can
              rotate the facing over time with a normal Set Attribute + Vector Op. (Storing facing as a
              vector avoids compass-angle trig entirely and runs on all three compile targets.)</li>
            <li><strong>Get Agent Offset</strong> &mdash; the <em>torus-shortest</em> displacement
              (dX, dY) and Distance from this agent to a neighbour. Use this (or <em>Get Agent
              Position</em> in its Relative mode) &mdash; not hand-subtracting two raw positions
              &mdash; for cohesion, separation, and "steer toward a neighbour" so the vectors stay
              correct across a wrapped (torus) boundary.</li>
            <li><strong>Get Agent Position</strong> &mdash; an agent's <em>(X, Y[, Z])</em>, with an
              <strong> Absolute / Relative</strong> mode. <em>Absolute</em> gives the raw position
              &mdash; of <em>this</em> agent when the <em>Agent</em> input is empty, or of any agent
              by id; <em>Relative</em> gives the torus-shortest vector from a
              <em> Reference</em> agent (which likewise defaults to <em>self</em> when left unwired,
              or can be any agent) &mdash; the wrap-correct way to read a vector to a neighbour, or
              between two agents.</li>
            <li><strong>Apply Force</strong> &mdash; add a force vector to the agent; the engine
              integrates the sum of all your Apply Force contributions (plus its built-in
              soft-sphere repulsion + bond springs when <em>Use bonding physics</em> is on). This
              is how you build <strong>boids</strong> (separation + alignment + cohesion),
              <strong> chemotaxis</strong> (force up a Field Gradient), or self-propulsion. With
              <strong> Momentum</strong> &gt; 0 the force changes velocity (flocking inertia). In a
              <strong> 3D</strong> model the position, force, and velocity nodes (Get/Set Agent
              Position, Apply Force, Set Velocity, Get Self Position) expose a <code>Z</code> axis.
              Apply Force also has a <strong>Vector input</strong> toggle that takes a single force
              vector (from Vector Op) instead of the X / Y / Z components. (Apply Force
              <em>accumulates</em> onto a buffer reset each step, so several Apply Force nodes sum.)</li>
            <li><strong>Apply Force To Agent</strong> &mdash; add a force to <em>another</em> agent by
              id (the cross-agent counterpart to Apply Force). This is the physically-correct way to
              author interactions: push a neighbour and, by Newton&rsquo;s 3rd law, feel the reaction;
              custom pairwise or Coulomb forces; springs you code yourself. Because forces
              <em>sum</em> (commutative), it&rsquo;s race-free in both update modes &mdash; unlike
              writing another agent&rsquo;s attribute. <strong>Apply Force To Agents</strong> is the
              broadcast sibling &mdash; push the same force onto <em>every</em> agent in an id array
              (a whole sensed group) at once.</li>
            <li><strong>Set Attribute</strong> (with its <em>Agent</em> input wired) &mdash; write an
              attribute on another agent by id (signal a neighbour). Leave that input empty and
              the very same node writes the current agent, so there is one verb, not two. And
              because Get Nearby Agents supplies a target,
              <strong> Form Bond</strong> is fully graph-driven &mdash; bond to compatible
              neighbours by their attributes/state. Both <em>Set Attribute</em> and the by-id
              <em>Get Agent Attribute</em> support multiple attribute <strong>slots</strong>
              (&quot;+ Attribute&quot;) sharing the one Agent id input &mdash; read or write several
              of a neighbour&apos;s attributes with a single node.</li>
          </ul>
          <h3 className={styles.h3}>Working with Sets of Agents</h3>
          <p className={styles.p}>
            The off-lattice analogues of the grid&rsquo;s neighbour-array nodes &mdash; build,
            filter, and reduce <strong>lists of agent ids</strong> (from Get Nearby Agents or
            Get Bonded Agents):
          </p>
          <ul className={styles.list}>
            <li><strong>Get Bonded Agents</strong> &mdash; this agent&rsquo;s bonded partners as an
              id list (the data sibling of <em>For Each Bond</em>).</li>
            <li><strong>Filter Agents / Join Agents</strong> &mdash; keep agents matching a predicate,
              or union/intersect two id lists (each outputs the result list + its count).</li>
            <li><strong>Pick Random Agent / Pick N Random Agents</strong> &mdash; sample one or N ids
              from a list.</li>
            <li><strong>Get Agents Attribute</strong> &mdash; gather one attribute over a whole id
              list into a value array (feed <strong>Aggregate</strong> / <strong>Group Counting</strong>
              to count or sum a neighbourhood &mdash; this is what makes a <em>totalistic</em> rule on
              agents possible). To WRITE across a whole list, feed that same list to
              <strong>Set Attribute</strong>&rsquo;s <em>Agent</em> input &mdash; it takes an id array
              as readily as a single id (see below). <strong>Set Velocity</strong> sets an
              agent&rsquo;s velocity directly &mdash; empty <em>Agent</em> = yourself, or wire an id
              for a knock-back (needs Momentum &gt; 0).</li>
            <li><strong>Set Attribute&rsquo;s <em>Agent</em> input has three modes</strong> &mdash;
              leave it <em>empty</em> to write your own attribute, wire a single <em>id</em> to write
              that agent&rsquo;s, or wire a whole <em>id array</em> (Get Nearby / Bonded / Filter
              Agents&hellip;) to write EVERY agent in it. Extra attribute slots ride the same
              <em>Agent</em> input, so one node can set several attributes on a whole group. A wired
              id is a cross-agent overwrite: it needs Asynchronous agents, and runs on the JS /
              WebAssembly agent engines.</li>
          </ul>
          <h3 className={styles.h3}>Graph-Rewriting Automata &mdash; census &rarr; table &rarr; verb</h3>
          <p className={styles.p}>
            A <strong>graph-rewriting automaton</strong> is an automaton whose <em>graph</em> is
            rewritten by local rules: nodes divide, die, bond, unbond and re-point their edges
            according to what they see around them. In the literature that idea usually arrives
            wrapped in category theory &mdash; gluing morphisms, pushouts, double-pushout rewriting.
            <strong> You will not meet any of that here.</strong>
          </p>
          <p className={styles.p}>
            The reason is a deliberate restriction: GenesisCA only does <strong>node-local</strong>
            rewriting. General graph rewriting has to <em>find</em> the pattern first (subgraph
            isomorphism &mdash; genuinely hard). A node-local rule&rsquo;s pattern is always
            &ldquo;this node and the ring of things bonded to it&rdquo;, which is not a search, it
            is a lookup. That collapses the whole authoring surface to three steps:
          </p>
          <ul className={styles.list}>
            <li><strong>Census</strong> &mdash; count the neighbours by state (the only thing a
              graph rule may legitimately read, see below).</li>
            <li><strong>Table</strong> &mdash; feed those counts and the node&rsquo;s own state into
              a <strong>Lookup Table</strong> whose value is a <em>tag</em>: Idle, Divide, Die,
              Bond, Unbond, Rewire&hellip; The rule is now <em>a table you can look at</em>, not a
              formula &mdash; and its <strong>Randomize</strong> button rolls a whole new automaton.</li>
            <li><strong>Verb</strong> &mdash; a <strong>Switch</strong> on that value runs the
              matching verb. Every verb is an ordinary agent node.</li>
          </ul>
          <p className={styles.p}>
            The <strong>GRA Rule Table</strong> default macro (Palette &rarr; Default Macros) is
            that chain pre-wired. And because the agent engine already lays agents out with
            springs and repulsion, you get a <strong>live force-directed drawing</strong> of the
            evolving graph for free &mdash; papers publish static snapshots of these things; here
            you can watch one and paint into it.
          </p>
          <p className={styles.p}>
            Two library models are the worked examples. <strong>Growing Graphs</strong> keeps a
            3-regular graph 3-regular while it grows: a split turns one node into three, and the
            whole rewrite lands in a single generation so the graph is <em>never</em> caught in a
            broken intermediate state. Its rule is two eight-cell tables you can re-roll, and it
            runs on a <em>Periodic Step</em>, so the generations in between are pure layout
            relaxation &mdash; which is why the growing graph stays readable instead of collapsing
            into a blob.{' '}
            <strong>SDCA &mdash; Couplers and Decouplers</strong> is the classic
            structurally-dynamic automaton: node values evolve over the links while the links
            themselves form and break according to those values, with a <em>hysteresis band</em>
            (couple above one threshold, decouple below a lower one) so edges do not chatter. Open
            either one and read its Instructions pill.
          </p>
          <p className={styles.p}>
            <strong>Growing Graphs</strong> is also the one to open first if you want to
            see how small a graph-rewriting automaton can be. It is a port of Alex Mordvintsev&rsquo;s
            demo of Paul Cousin&rsquo;s <em>binary cubic</em> automata: every node holds{' '}
            <em>one bit</em> and exactly three neighbours, and a single <em>16-bit integer</em>{' '}
            defines the whole automaton &mdash; the low byte says what a node becomes, the high byte
            says whether it splits, both indexed by <code>own bit &times; 4 + ON neighbours</code>.
            The two rule tables in the Attributes panel <em>are</em> that integer, cell for cell, and
            the demo&rsquo;s whole published catalogue ships as presets &mdash; its twelve named rules
            first, then the eleven further rules of its dropdown under their rule number. It also
            shows the pattern for reproducing a published initial condition exactly: two
            handle-indexed lookup tables and a bootstrap branch gated on bond degree 0 rebuild the
            reference&rsquo;s precise ten-node seed graph. Its second viewer, <em>Birth generation</em>,
            colours each node by when it was born, so the structure reads as its own growth history.
            Two sliders are there for looking rather than for the rule: <em>Max Generations</em>{' '}
            freezes the automaton at a generation you pick while the force layout keeps untangling
            (0 means unlimited, and raising it resumes exactly where it stopped), and{' '}
            <em>Node Radius</em> resizes every node live.
          </p>
          <p className={styles.p}>
            It is also where <strong>bond slot order</strong> stops being an implementation detail.
            A bond appends to both endpoints&rsquo; lists, so a node&rsquo;s slots are its edges in
            formation order &mdash; and a split keeps slot 0 and hands slots 1 and 2 to its two
            daughters, so that order decides which neighbour each daughter inherits and propagates
            into the shape forever. Three things follow, all visible in the model: the bootstrap
            forms its fifteen bonds in a <em>scripted</em> global order (each agent forms only its
            own <code>h+1</code> edge, and a chord is issued by its higher endpoint), which
            reproduces the reference&rsquo;s slot order for nine of the ten seeds &mdash; the tenth is
            provably impossible, because &ldquo;previous edge before next edge&rdquo; at every node
            of a cycle is a contradiction. The split&rsquo;s five queued operations are ordered so
            that <em>all four</em> adjacency rows it touches &mdash; the mother, both daughters and
            each displaced neighbour &mdash; come out in the reference&rsquo;s exact order. And the
            division priority is the agent&rsquo;s own <em>handle</em> rather than a random roll,
            which makes the drain deterministic and, since handles are allocated in order and
            nothing dies, reproduces the reference&rsquo;s own ascending index walk.
          </p>
          <p className={styles.p}>
            The two displaced neighbours are why <strong>Transfer Bond</strong> exists.{' '}
            <em>Rewire Bond</em> moves one of your own bonds to a new partner, but it does so by
            breaking and re-forming &mdash; and a break compacts the other agent&rsquo;s list by
            swapping its last entry into the freed slot, so the <em>other</em> agent&rsquo;s order is
            scrambled. Transfer Bond overwrites that slot where it stands, so the partner keeps its
            ordering and the bond keeps its rest length, stiffness and attributes (it is the same
            edge re-pointed, not a new one). With it, the port&rsquo;s graph on two of the published
            rules is now identical to the reference&rsquo;s <em>edge for edge, at the same node
            numbers</em>, and the reference&rsquo;s habit of concentrating splits into a few
            long-lived hubs &mdash; very visible in <em>meduza</em> &mdash; is reproduced exactly.
          </p>
          <p className={styles.p}>
            It is also the clearest example of <strong>fitting a sequential rule onto a parallel
            engine</strong>. The reference divides <em>every</em> flagged node within a tick, one
            after another, each reading the adjacency the previous splits left behind. GenesisCA&rsquo;s
            structural request queue drains in parallel, and two <em>adjacent</em> splitters would
            corrupt each other &mdash; so the model latches the flags in a state tick and then drains
            them over several <strong>division rounds</strong>, each round splitting a non-adjacent
            set and clearing its latch so the losers get their turn next round, against the
            adjacency the winners just rewrote. One reference tick is one state tick plus eight
            rounds. Because a latch is consumed exactly once and the drain finishes, every
            mutation-free published rule reproduces the reference node count <em>exactly</em>,
            cycle for cycle &mdash; including the rules a single-round drain could not follow at all.
          </p>
          <p className={styles.p}>
            Its <strong>layout</strong> is the reference&rsquo;s too, parameter for parameter &mdash;
            and that turned out to matter more than any single number. The long-range charge law{' '}
            <code>k&thinsp;&middot;&thinsp;(1/(1+d&sup2;) &minus; minC)</code> has a length scale
            baked into it (the knee sits at <code>d = 1</code>), so the <em>same</em> k means
            something completely different at a different bond rest length. What actually decides
            whether the springs or the charge win is the dimensionless{' '}
            <code>|k| / (&lambda;&thinsp;(1+rest&sup2;))</code>: the reference runs 0.0096, while an
            earlier version of this port ran a rest length of 5 with k = &minus;10, i.e. 0.70 &mdash;
            seventy-three times more charge-dominated. Its bonds sat about half again past their rest
            length and the graph read as permanently inflated. It now runs the reference&rsquo;s own
            scale (rest 25, stiffness 0.5, k = &minus;3 truncated at 2000, momentum 0.9, no collision,
            no speed cap, and an effective integration step of exactly 1).
          </p>
          <p className={styles.p}>
            One difference is left, and it is a <em>solver</em> difference rather than a force one.
            The reference sweeps its edge list twice per step, forward then backward, on{' '}
            <em>predicted</em> positions &mdash; a semi-implicit solve that is stiffer than the single
            accumulation a per-agent force pass can do, so its layout settles 13&ndash;25&thinsp;%
            tighter. Reduce the reference to the same single pass and the two agree to
            0.7&ndash;2.5&thinsp;% on bond length; a lone bonded pair settles at the identical
            distance to six decimals. It cannot be tuned away &mdash; raising the stiffness makes an
            explicit integrator diverge on a cubic graph, and adding passes changes nothing &mdash;
            and a sequential edge-list sweep is not something a parallel force pass can express. Since
            the difference is close to a uniform scale factor and the view is fitted anyway, what you
            can actually see (how densely non-neighbours pack, how the rings around a hub space out)
            agrees to within about a tenth.
          </p>
          <h3 className={styles.h3}>Neighbour Census &mdash; the input a graph rule reads</h3>
          <p className={styles.p}>
            A rule that runs on a <em>graph</em> cannot name its neighbours &mdash; there is no
            lattice ordering, and every agent may have a different number of them. So the only
            thing such a rule can legitimately read is an <strong>order-independent,
            degree-tolerant summary</strong>: how many neighbours are in each state.
            &ldquo;Two red, one blue, no green.&rdquo;
          </p>
          <p className={styles.p}>
            <strong>Neighbour Census</strong> is that summary as a single node. Point it at a
            <em> tag</em> or <em>binary</em> agent attribute and it grows{' '}
            <strong>one output port per state value</strong>, labelled with the option name, plus
            a <strong>Total</strong> (how many neighbours there are at all). Choose where the
            neighbours come from: <strong>Bonded neighbours</strong> (the bonded 1-ring &mdash; the
            graph proper) or <strong>Nearby agents</strong> (everything inside a radius). Without
            it you would wire <em>Get Bonded Agents &rarr; Get Agents Attribute &rarr; Count
            Matching</em> plus a constant <em>once for every state value</em>.
          </p>
          <p className={styles.p}>
            Two things worth knowing. Ports you don&rsquo;t connect cost <strong>nothing</strong>
            &mdash; only the counts you actually read are computed, so a five-state census used
            for one state is as cheap as one count. And <strong>Total</strong> is the natural
            &ldquo;do I have any neighbours at all?&rdquo; guard: an agent whose 1-ring is empty
            usually has no rule to apply, so gating the rule on <em>Total &gt; 0</em> leaves it
            untouched instead of treating it as surrounded by emptiness.
          </p>
          <p className={styles.p}>
            The typical shape is <strong>census &rarr; rule table &rarr; verb</strong>: feed the
            counts (and the agent&rsquo;s own state) into a tag-valued{' '}
            <strong>Lookup Table</strong>, then <strong>Switch</strong> on the value it returns to
            pick what to do &mdash; divide, die, bond, unbond, or nothing. The rule becomes a table
            you can look at and re-roll with <em>Randomize</em>. Drop the{' '}
            <strong>GRA Rule Table</strong> macro from the Palette to get that whole shape
            pre-wired. See the <em>Life on Bonds</em> sample for a worked example: Conway&rsquo;s
            Game of Life with each agent bonded to its eight neighbours, the rule read entirely
            through one census node.
          </p>
          <h3 className={styles.h3}>Measuring the graph &mdash; graph indicators + the sweep</h3>
          <p className={styles.p}>
            Rolling a rule is only half the research loop; the other half is <em>measuring what it
            did</em>. A <strong>Graph</strong> indicator (Properties &rarr; Indicators &rarr;
            &ldquo;+ Graph&rdquo;, shown once the Agents topology is on) reports a graph-global
            quantity every step: <em>node count</em>, <em>edge count</em>, <em>mean</em> and{' '}
            <em>max degree</em>, the <em>degree histogram</em>, and the number of{' '}
            <em>connected components</em> &mdash; so you can see at a glance whether a rule grows,
            dies, thickens, or fragments. They chart like any other indicator (scalars as
            sparklines, the histogram through the Bars / Lines / Stack views).
          </p>
          <p className={styles.p}>
            Because the <strong>Overseer</strong>&rsquo;s <strong>Read Indicator</strong> reads
            them, the whole rule-space search is expressible as a protocol:{' '}
            <em>Clear Series &rarr; For Each seed &#123; Randomize Table &rarr; Reset Board &rarr;
            Run &rarr; Collect(node count, edge count, mean degree, components) &rarr; Log &#125;</em>,
            then export the rule &rarr; outcome table as CSV. The{' '}
            <em>Graph Metrics &mdash; Growth Sweep</em> sample ships exactly that, together with a
            20-replicate measurement of the growth law. One practical note if you build your own:
            the seed policy re-seeds the shared random stream that the JS and WebAssembly agent
            targets use, so run sweeps on one of those rather than WebGPU (whose per-agent RNG is
            seeded once at creation). The <em>initial condition</em> itself is no longer a caveat
            &mdash; both seed patterns now draw from that same seeded stream, so a fixed seed pins
            the starting layout too.
          </p>
          <h3 className={styles.h3}>Bond Attributes &mdash; state that lives on the edge</h3>
          <p className={styles.p}>
            Agent attributes describe a <em>node</em>. <strong>Bond attributes</strong> describe an{' '}
            <em>edge</em>: a weight, a type, an age, a flag &mdash; anything that belongs to the
            connection between two agents rather than to either of them. Define them in the{' '}
            <strong>Bond Attributes</strong> section of the Attributes panel (Agents tab, visible
            once the Bonds capability is on). They can be Binary, Integer, Decimal or Tag.
          </p>
          <p className={styles.p}>
            <strong>Get Bond Attribute</strong> reads one by <em>partner id</em> &mdash; feed the
            Partner output of <em>For Each Bond</em>. If the two agents aren&rsquo;t bonded you get
            the attribute&rsquo;s default, never a broken value.{' '}
            <strong>Set Bond Attribute</strong> writes one the same way.
          </p>
          <p className={styles.p}>
            <strong>A bond is one thing, stored at both ends.</strong> So writing a bond attribute
            from <em>either</em> agent updates <em>both</em> sides &mdash; there is no &ldquo;my
            half&rdquo; of a bond. If you want a direction, store it as a <em>value</em>: keep an{' '}
            <em>owner</em> bond attribute and compare it against <strong>Get Self Handle</strong>.
            Don&rsquo;t try to write the two sides differently; the engine keeps them equal on
            purpose, and every rewriting rule depends on that.
          </p>
          <p className={styles.p}>
            A brand-new bond gets its values from <strong>Form Bond</strong>, which grows one input
            per bond attribute (labelled with its name) &mdash; that is where you seed a new
            edge&rsquo;s weight or type. A bond requested this generation doesn&rsquo;t exist until
            the end of the step, so Set Bond Attribute can only reach it from the next generation.
          </p>
          <p className={styles.p}>
            Bond attributes run on <strong>all three</strong> agent targets &mdash; Debug/JS,
            WebAssembly and WebGPU. One caveat is specific to WebGPU: because a bond is stored at
            both ends, writing one always touches the <em>partner&rsquo;s</em> storage, and on the
            GPU every agent is its own thread. So if <em>both</em> endpoints of a bond write the
            same attribute in the <em>same</em> step, which write lands is{' '}
            <strong>order-undefined</strong> there. Two ways to stay exact, and both are the natural
            way to write the rule anyway: write from <em>one side only</em> (the owner idiom above),
            or make the rule <em>symmetric</em>, so both endpoints compute the same value &mdash;
            which is what a link rule of the form &ldquo;new edge state from the old edge state and
            the two node states&rdquo; already is. Only a genuinely <em>asymmetric</em> write (the
            two endpoints computing different values) is affected, and that contradicts the
            both-ends-equal rule on every target.
          </p>
          <p className={styles.p}>
            <strong>One more thing worth knowing, on every target.</strong> Under{' '}
            <em>synchronous</em> agent update, <em>agent</em> attributes are double-buffered: every
            agent reads the previous generation, so the value rule is a true synchronous automaton.{' '}
            <strong>Bond attributes are not</strong> &mdash; they are single-buffered, so a link
            value written this generation <em>is</em> visible to a later agent in the same
            generation. For a symmetric link rule (the usual case) that is harmless: both endpoints
            compute the same number, so the two stored copies always agree; the only visible effect
            is that a running-average link rule is applied twice per generation, once from each end.
            The shipped <strong>SDCA</strong> sample says the same thing in its Rule Description.
          </p>
          <h3 className={styles.h3}>Rewiring the graph &mdash; several bond ops in ONE step</h3>
          <p className={styles.p}>
            Bond changes are <em>requests</em>: Form / Break / Rewire Bond do not edit the graph on the
            spot, they queue an op that the engine applies after the whole step, on the settled state.
            That is what makes them safe to issue while you are iterating your bonds &mdash; a
            <em> For Each Bond</em> loop always sees the bond list as it was at the start of the step.
          </p>
          <p className={styles.p}>
            Each agent has a <strong>queue</strong> of those requests, so it can issue{' '}
            <strong>several in one step</strong> &mdash; which is exactly what a graph rewrite needs
            (a triangle split, an edge swap or a pair annihilation is 2&ndash;5 edge changes at one
            node, and spreading them over several generations would break the very property the rule
            is meant to preserve). The depth is <em>Bond Requests / Agent / Step</em> in{' '}
            <strong>Model Properties &rarr; Bond-Graph Agents</strong> (default 8). Ops past the depth
            are <strong>rejected whole</strong> &mdash; never half-applied, never wrapped &mdash; and a
            notice tells you to raise it.
          </p>
          <p className={styles.p}>
            <strong>Rewire Bond</strong> is the graph-rewriting verb: give it a <em>From</em> partner
            and a <em>To</em> partner and it breaks one bond and forms the other as{' '}
            <strong>one indivisible operation</strong>. If the move cannot be completed &mdash; there
            is no bond to <em>From</em>, or <em>To</em> is gone, is this agent, or has a full bond
            list &mdash; then <strong>nothing at all</strong> happens: you never get the edge removed
            and its replacement missing. That is what lets a rule keep every node's degree exactly
            constant while the topology churns underneath it.
          </p>
          <p className={styles.p}>
            <strong>Form Bond names both ends of the bond.</strong> Its second id is
            <em> Agent A</em>, and it is optional: leave it unwired and it is <em>this</em> agent, so
            the node reads exactly as it always has &mdash; &ldquo;bond me to my Target&rdquo;. Wire
            it and you get &ldquo;bond A to my Target&rdquo; instead, which lets one node cover both
            shapes. Wiring <em>Get Self Handle</em> into it is the same thing as leaving it empty, so
            you can be explicit when a rule reads better that way. Everything else is unchanged: the
            request still travels on <em>your</em> queue, the two ids are just values it carries, and
            rest length 0 still means the contact distance of whichever pair ends up bonded.
          </p>
          <p className={styles.p}>
            <strong>Why naming both ends matters.</strong> A Form Bond with Agent A left at the
            default joins <em>you</em> to a target, so on its own it cannot make an edge between two
            agents that are both someone else &mdash; and the classic <strong>triangle split</strong>
            needs exactly that: it creates two new nodes and one of the three new edges joins those
            two newborns, neither of which is you, and neither of which runs its own rule until the
            next generation. Wire Agent A and the whole split fits in a single step, so the graph is
            never caught in a half-rewritten state. The same all-or-nothing rule applies either way:
            if an agent is gone, the pair is already bonded, or <em>either</em> one has a full bond
            list, nothing is formed.
          </p>
          <p className={styles.p}>
            <em>Older models:</em> this used to be a separate <strong>Form Bond Between</strong>
            node. It was retired once Form Bond&rsquo;s Agent A port made it a duplicate &mdash; a
            model that used it loads as a Form Bond with Agent A wired, and behaves identically.
          </p>
          <p className={styles.p}>
            <strong>Break Bond names both ends too.</strong> It has the same optional{' '}
            <em>Agent A</em>, with the same default: unwired it is this agent, so the node reads as
            it always has (&ldquo;unbond me from my Target&rdquo;); wire it and it{' '}
            <strong>cuts the bond between two other agents</strong>. That is the one edge change
            the other verbs cannot express &mdash; <em>Rewire</em> and <em>Transfer</em> both move
            an edge <em>you</em> are an endpoint of &mdash; so it is what lets a rule act as an
            editor of a graph it is merely observing (an arbiter severing a link between two
            neighbours, a rule pruning a triangle it detected). The same all-or-nothing rule
            applies: if there is no such bond, or either agent is gone, <strong>nothing at all</strong>{' '}
            happens &mdash; no other bond shifts, no degree changes.
          </p>
          <h3 className={styles.h3}>Dividing: which daughter gets which bond?</h3>
          <p className={styles.p}>
            When an agent divides, its bonds have to be shared out. By default that happens by
            <strong> geometry</strong> &mdash; each partner goes to whichever daughter it is nearer.
            That is right for tissue, but a graph-rewriting rule is <em>defined</em> by which edges
            end up where, and geometry is exactly the thing you cannot say. So <em>Divide Agent</em>
            offers a <strong>Partition</strong>:
          </p>
          <ul className={styles.list}>
            <li><strong>By tension axis</strong> &mdash; the geometric split (the default, unchanged).</li>
            <li><strong>Alternate A / B</strong> &mdash; bonds alternate between the daughters in
              slot order. Deterministic, needs no attribute; the quickest way to halve a hub.</li>
            <li><strong>By bond attribute</strong> &mdash; a <em>bond attribute</em> you name picks
              the daughter. A <strong>binary</strong> attribute sends <code>false</code> to A and
              <code> true</code> to B; a <strong>tag</strong> gets one A/B tick box per option (so
              the rule reads like what it means &mdash; &ldquo;daughter A takes the <em>apical</em>
              bonds&rdquo;); an <strong>integer / decimal</strong> compares against a threshold you
              set (below &rarr; A, at-or-above &rarr; B).</li>
          </ul>
          <p className={styles.p}>
            A second setting, <strong>A&ndash;B bond</strong>, decides whether the two daughters are
            bonded to each other: <em>when mother was bonded</em> (the default &mdash; a lone agent's
            daughters drift apart), <em>always</em> (keeps a rewritten graph connected through every
            split) or <em>never</em> (the deliberate &ldquo;split this node in two&rdquo; rewrite).
          </p>
          <p className={styles.p}>
            Whichever partition you pick, <strong>nothing is lost</strong>: every bond the mother
            had ends up on exactly one daughter, still carrying its own bond-attribute values, and
            division is still all-or-nothing &mdash; if a daughter's bond list would overflow, the
            whole division is skipped and the agent is left untouched. If the attribute you named is
            deleted, the node falls back to the tension axis <em>and</em> shows a warning badge, so a
            partition is never silently wrong.
          </p>
          <h3 className={styles.h3}>Dividing: how big are the daughters? (3D)</h3>
          <p className={styles.p}>
            A division shrinks the two daughters, and <em>Divide Agent</em>&apos;s{' '}
            <strong>Conserve</strong> setting says what that shrink preserves:
          </p>
          <ul className={styles.list}>
            <li><strong>Area</strong> (the default) &mdash; <code>rA&sup2; + rB&sup2; = r&sup2;</code>.
              At a symmetric split each daughter is <code>r/&radic;2 = 0.707&middot;r</code>. This is
              what GenesisCA has always done, in <em>both</em> dimensions.</li>
            <li><strong>Volume</strong> &mdash; <code>rA&sup3; + rB&sup3; = r&sup3;</code>, i.e.
              <code> r&middot;&#8731;f</code>. At a symmetric split each daughter is
              <code> 0.794&middot;r</code>, about 12 % larger.</li>
          </ul>
          <p className={styles.p}>
            It matters because the area split was applied in 3D too, where it is <em>not</em>
            volume-conserving: <strong>~29 % of the volume disappears at every symmetric 3D
            division</strong> (2&middot;(1/&radic;2)&sup3; = 0.707). The setting only appears in a
            <strong> 3D</strong> model &mdash; &ldquo;conserve r&sup3;&rdquo; is meaningless on a
            disc, and a 2D model always divides by area whatever the file says. <strong>Area stays
            the default</strong>, so no existing model changes.
          </p>
          <p className={styles.p}>
            To read the sizes back: <em>Behaviour Step</em> and <em>Division Event</em> expose{' '}
            <strong>Area</strong> and, in a 3D model, <strong>Volume</strong>.{' '}
            <strong>Area is the agent&apos;s extent in the model&apos;s own dimension</strong>
            &nbsp;&mdash; the disc area <code>&pi;r&sup2;</code> in 2D, the sphere&apos;s{' '}
            <em>surface</em> area <code>4&pi;r&sup2;</code> in 3D &mdash; and{' '}
            <strong>Volume</strong> is the enclosed <code>(4/3)&pi;r&sup3;</code>. There are no
            separate Get/Set Area nodes: an area is <em>Get Radius</em> plus one Math node, and
            setting one is a <em>Math Expression</em> (<code>sqrt(A/pi)</code>) into{' '}
            <em>Set Agent Radius</em>.
          </p>
          <h3 className={styles.h3}>The Division Event: configuring the daughters</h3>
          <p className={styles.p}>
            The <strong>Division Event</strong> is the moment to shape a newborn. It runs{' '}
            <em>once per daughter</em>, <strong>after</strong> the split has committed &mdash; so
            both daughters exist, both are alive, both ids are known, and the graph has settled.
            Every daughter starts with the mother&apos;s attributes <em>verbatim</em> (daughter A
            reuses the mother&apos;s slot; daughter B is a copy), so a <em>Get Self Attribute</em>
            here reads the inherited value and <em>Set Attribute</em> overwrites it.
          </p>
          <ul className={styles.list}>
            <li><strong>Daughter #</strong> &mdash; 0 for the reused mother slot, 1 for the new one.
              Branch on it for asymmetric inheritance (&ldquo;daughter 0 keeps 70 % of Q&rdquo;).</li>
            <li><strong>Sibling</strong> &mdash; the <em>other</em> daughter&apos;s agent id. Wire it
              into any by-id node and <strong>one</strong> invocation can configure{' '}
              <em>both</em> daughters (<em>Set Attribute</em> with its <em>Agent</em> wired to
              Sibling), or bond them to each other, or hand one a reference to the other.</li>
            <li><strong>Form / Break / Rewire / Transfer Bond</strong> are all valid here. A bond a
              Division Event asks for is applied <strong>in the same generation</strong>, right
              after every division event has run &mdash; so a daughter can be bonded to a{' '}
              <em>third party</em> the moment it is born, with no one-generation delay and no
              intermediate state that breaks the invariant your rule preserves. Every op is still
              all-or-nothing: if a bond cannot be formed (a full partner, a dead id), nothing is
              touched.</li>
            <li><strong>Area / Volume / Axis X-Y-Z</strong> &mdash; the daughter&apos;s size and the
              axis the engine actually split along.</li>
          </ul>
          <p className={styles.p}>
            <strong>Carrying context into the event.</strong> The Division Event cannot see the
            Behaviour Step&apos;s <em>Local Variables</em> &mdash; those are per-agent, per-step
            scratch and are gone by the time the split is applied. The bridge is an{' '}
            <strong>agent attribute</strong>: write your context into one immediately before{' '}
            <em>Divide Agent</em>, and <em>both</em> daughters inherit it verbatim for the event to
            read. That is also the answer for anything cheaper to carry than to re-derive.
          </p>
          <h3 className={styles.h3}>Spawning Agents (Create &rarr; Add, in either event)</h3>
          <p className={styles.p}>
            Beyond the <em>Seed Count</em> the engine lays down on Reset (set <em>Seed Pattern</em>
            {' '}to <strong>None</strong> if the graph should be the <em>only</em> source of agents),
            you spawn agents
            <strong> from the graph</strong> with one idiom that works in <strong>both</strong> the Agent
            Init Event <em>and</em> the Behaviour Step &mdash; just like <em>Set Attribute</em> works in
            both events. Build an agent with <strong>Create Agent</strong> (position / radius &rarr; an
            agent <em>handle</em>; the position takes a <em>Z</em> in a 3D model), set its initial state
            on the handle (<em>Set Attribute</em> with its <em>Agent</em> input on the handle,{' '}
            <em>Set Agent Position / Radius</em>), then
            commit it with <strong>Add Agent To World</strong>. Running past <em>Max Agents</em> returns
            a <code>-1</code> handle and the Set/Add no-op (it never wraps).
          </p>
          <p className={styles.p}>
            In the <strong>Agent Init Event</strong> (runs once, on load + Reset) loop over its
            <code> DO</code> chain to place an exact grid, a procedural pattern, or a randomised
            population. In the <strong>Behaviour Step</strong> the SAME nodes spawn <strong>during the
            run</strong> &mdash; e.g. a bird agent lays an egg agent: Create the egg at the bird&apos;s
            position, set the egg&apos;s species / energy on the handle, and Add it, with full control
            over the new instance. A mid-step newborn is fully configured the step it&apos;s created but
            starts running its <em>own</em> behaviour the <em>next</em> step.
          </p>
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
          <h3 className={styles.h3}>Colouring &amp; Exhibiting Agents (Agent Output Mappings)</h3>
          <p className={styles.p}>
            Agents have their <strong>own Attribute&rarr;Color views</strong>, separate from the
            grid&rsquo;s &mdash; each a different <em>view</em> of the population (colour-by-maturity,
            colour-by-state, &hellip;), switchable at run time. In the Simulator the viewer bar shows a
            <strong> Cells (A&rarr;C)</strong> row and an <strong>Agents (A&rarr;C)</strong> row when both
            layers have mappings &mdash; pick one tab from each. Each Agent Output Mapping has a
            <strong> Color pass</strong> setting (Mappings panel), exactly like the grid mappings:
          </p>
          <ul className={styles.list}>
            <li><strong>Linked</strong> &mdash; pick an agent attribute &rarr; a colour (a colour scale
              for numeric attributes, one colour per option for tags); the colour pass is generated
              for you.</li>
            <li><strong>Standalone</strong> &mdash; build the view by hand on the <strong>Agents</strong>
              graph: add an <strong>Agent Output Mapping (A&rarr;C)</strong> event node, pick the view,
              and wire whatever exhibition you like (Set Cell Looks for colour, <strong>Set Agent
              Sprite</strong> for an image, special-casing by Get Self Attribute / Get Velocity / &hellip;).
              The graph runs <em>after</em> the Behaviour / Division step, so it can read the agent&rsquo;s
              live state. (A Linked view with a Standalone graph runs the auto colour first as a
              background, then your graph on top.)</li>
          </ul>
          <p className={styles.p}>
            The <strong>Agent Output Mappings</strong> list works exactly like the CA-grid mapping
            lists above it: click a view to open its editor in the second panel, use
            <strong> + Add Agent View</strong> / <strong>Duplicate</strong> / <strong>Delete</strong>,
            and drag the <code>&#8942;&#8942;</code> handle to reorder &mdash; the order is the order of
            the tabs in the Simulator&rsquo;s <em>Agents</em> viewer row. A view&rsquo;s
            <strong> Description</strong> becomes that tab&rsquo;s tooltip. You can also
            <strong> drag a view row onto the Agents canvas</strong> to add an <strong>Agent Output
            Mapping (A&rarr;C)</strong> root or a <strong>Set Agent Looks</strong> node already pointed
            at it (drop it near a matching port and it wires itself up). Agent views only mean
            something on the Agents graph, so dropping one on the Cells canvas offers nothing.
          </p>
          <h3 className={styles.h3}>Agent Input Mappings (Colour &rarr; Attribute)</h3>
          <p className={styles.p}>
            The mirror image of the views above, and the agent twin of the CA grid&rsquo;s
            <em> Color &rarr; Attribute</em> mappings: an <strong>Agent Input Mapping</strong> is a graph
            that runs <em>once per agent you paint</em> with the Simulator&rsquo;s agent brush &mdash;
            each one appears as its own brush under the agent brush&rsquo;s
            <strong> User defined</strong> section. Add one with <strong>+ Add Agent Input</strong>, then build it on
            the Agents canvas: drop an <strong>Agent Input Mapping (C&rarr;A)</strong> event node, pick the
            mapping, and hang your logic off <code>DO</code>. The node&rsquo;s value outputs are the
            <strong> parameters the mapping declares</strong> (see &ldquo;Input Mapping Parameters&rdquo;
            under Mappings) &mdash; one widget per parameter in the brush panel, one port per parameter
            on the node &mdash; so a brush can hand an agent a species, an energy and a flag directly
            instead of a colour it has to decode. Declare none and you get the classic
            <code> R</code> / <code>G</code> / <code>B</code> brush colour (0&ndash;255). Either way you
            can compare, threshold or map the values onto anything the agent owns &mdash; Set Attribute,
            Set Agent Radius, Set Velocity, Kill Agent, &hellip;
          </p>
          <p className={styles.p}>
            <strong>Two brush kinds &mdash; Editor and Spawner.</strong> The editor&rsquo;s
            <strong> Brush kind</strong> row decides what painting with this mapping <em>does</em>.
            An <strong>Editor</strong> brush (the default, and what every existing mapping is) runs the
            graph <em>once per agent the footprint covers</em>, with that agent as <em>self</em> &mdash;
            it edits the agents you touch, and it may also <em>spawn</em> agents around them
            (Create Agent &rarr; set-by-handle &rarr; Add Agent To World) or <em>remove</em> them
            (Kill Agent, applied immediately &mdash; you do not have to press Play to see it).
            A <strong>Spawner</strong> brush runs the graph <em>once per click or drag step</em> with
            <em> no self at all</em>: instead its root gains <strong>Brush X</strong>,
            <strong> Brush Y</strong> (<strong>Brush Z</strong> in 3D) and <strong>Brush Radius</strong>
            outputs, and the graph creates the agents itself &mdash; loop N times, scatter them inside
            the radius however you like, set their attributes from the parameters. That is the shape an
            editor brush structurally cannot express: with nothing under the cursor an editor runs zero
            times, so &ldquo;click empty space to add agents this particular way&rdquo; has nowhere to
            hook. A spawner has no current agent, so per-agent readers (Get Self Position, Get Nearby
            Agents, &hellip;) are invalid there and carry a warning badge; the brush panel drops the
            shape row and shows a single <strong>Radius</strong> instead, because the graph &mdash; not
            the footprint &mdash; decides where the new agents land.
          </p>
          <p className={styles.p}>
            An input mapping is always a <em>standalone</em> graph (there is no palette to
            auto-generate &mdash; the graph <em>is</em> the mapping), so its editor shows a name, a
            description, its brush kind and its parameter list; the description becomes the tooltip on
            its tab in the brush. You can drag an
            input-mapping row onto the Agents canvas to add its root already pointed at it. It runs as a
            plain function on the CPU on every agent engine (JS, WebAssembly and WebGPU alike) &mdash;
            painting is a one-off gesture, not per-generation work, so there is nothing to gain from
            compiling it to a faster target.
          </p>
          <h3 className={styles.h3}>Agent Sprites</h3>
          <p className={styles.p}>
            An agent can be drawn as a <strong>static image, an animated GIF, an image
            sequence, or a sliced sprite sheet</strong> instead of a circle. Import sprites in
            the <strong>Mappings</strong> panel&rsquo;s <strong>Sprites</strong> section
            (PNG / JPEG / GIF / WebP; they travel inside the <code>.gcaproj</code>) &mdash; a
            single image/GIF, <strong>+&nbsp;Frame sequence</strong> (several images become one
            animation, in filename order), or <strong>+&nbsp;Sprite sheet</strong> (one grid
            image sliced into frames).
          </p>
          <p className={styles.p}>
            Importing a sheet opens the <strong>sprite-sheet dialog</strong>, where you set the
            grid (columns / rows and any margin / gap) <em>and</em> <strong>pick which cells are
            the animation, in which order</strong> &mdash; click a cell to add it as the next
            frame, click it again to remove it. Real sheets almost never hold just one animation
            (a walk cycle sits next to an idle pose, a door, a UI icon), so the frames are a
            <strong> selection</strong> over the grid rather than its first N cells. Because the
            sprite then holds exactly the frames you want, in your order, setting a
            <strong> speed</strong> on the <strong>Set Agent Sprite</strong> node is as simple as
            it is for an imported frame sequence &mdash; no skipping cells you did not ask for.
            The strip under the sheet is the sequence: <strong>&times;</strong> drops a frame,
            <strong> &#10697;</strong> repeats one (hold a pose longer), <strong>&#9666;&nbsp;&#9656;</strong>
            nudge it earlier or later, and <strong>Reverse</strong> / <strong>Ping-pong</strong>
            (0,1,2&nbsp;&rarr;&nbsp;0,1,2,1) build a cycle in one click. A live preview plays the
            selection as you build it. Shrinking the grid <em>drops</em> any frame that no longer
            exists (it is never silently re-pointed at another cell), and the dialog says how many
            went. Reopen it any time from <strong>Edit sheet grid&hellip;</strong> in the sprite&rsquo;s
            editor.
          </p>
          <p className={styles.p}>
            You do not have to align the grid by typing: the <strong>first cell</strong> is drawn as
            an orange rectangle you can <strong>drag to move the grid</strong> (it writes the margin)
            and whose <strong>corner resizes the cells</strong>. The number fields stay in sync both
            ways &mdash; drag and they follow, type and the rectangle moves. Clicking the first cell
            without dragging still adds/removes it from the animation, as any other cell.
          </p>
          <p className={styles.p}>
            The <strong>cell</strong> size is normally <em>derived</em> from the image, the margins
            and the gaps, so it changes with the column / row counts. Setting it (or dragging the
            corner) makes it <strong>explicit</strong>, which is what lets you grid a sheet that has
            <strong> dead space</strong> on the right or bottom &mdash; a case no combination of
            columns and rows can express, since the derived size always divides the <em>whole</em>
            image. <strong>&#8634;</strong> puts it back to the derived size; a cell that then hangs
            off the image edge simply decodes with transparent padding.
          </p>
          <p className={styles.p}>
            The library works like the mapping lists above it: each sprite is a
            <strong> row</strong> with its thumbnail, name and frame count &mdash; and every
            preview (the row, the editor image, the chroma-key picker) shows the sprite&rsquo;s
            <strong> first animation frame</strong>, so a sheet reads as the frame that plays
            first rather than as the whole grid image squeezed into a 24&nbsp;px box. It is the
            first frame of your <em>selection</em>, not necessarily the sheet&rsquo;s first cell,
            and
            <strong> clicking a row opens its editor in the second panel</strong>. There you
            set the <strong>size mode</strong> and size, whether the frames <strong>loop</strong>, the sheet grid + frame
            selection (via <strong>Edit sheet grid&hellip;</strong>), the <strong>crop</strong> (see
            below), <strong>Colorize by agent colour</strong> (see below), the
            <strong> rotation</strong> &mdash; the art&rsquo;s default facing on the compass dial,
            plus <strong>Orient to velocity</strong> so it auto-points along the agent&rsquo;s
            heading, plus a fixed offset &mdash; and <strong>remove a background colour</strong>
            (chroma-key a magenta / green screen to transparency, with a tolerance &mdash; pick
            the colour by clicking the sprite image directly). Use <strong>Duplicate</strong> to
            branch a variant off an existing sprite, <strong>Delete</strong> to remove one (any
            node pointing at it is cleared, not left dangling), and the <strong>&#8942;&#8942;</strong>
            handle to reorder the library. You can also <strong>drag a sprite row onto the Agents
            canvas</strong> to drop a <strong>Set Agent Sprite</strong> node already pointed at
            it.
          </p>
          <p className={styles.p}>
            <strong>How big is a sprite? Its <em>Size mode</em> decides.</strong> By default
            (<em>Relative to agent diameter</em>) the size is a <strong>multiplier of the
            agent&rsquo;s diameter</strong>, so the art tracks the body &mdash; the right thing for
            a boid whose sprite <em>is</em> the agent. Switch a sprite to
            <strong> Absolute (world units)</strong> and the size is a <strong>world-unit
            measurement and the agent&rsquo;s radius stops mattering entirely</strong> &mdash; the
            right thing when a rule drives the size through <strong>Set Agent Sprite &rarr;
            Scale</strong> and you want that number, and nothing else, to decide how big the
            picture is. Either way the number is the sprite&rsquo;s <strong>longest side</strong>
            (the other is shortened by the frame&rsquo;s aspect), and the mode is a property of the
            <em> sprite</em>, so the library&rsquo;s Size field and the node&rsquo;s Scale port always
            mean the same thing.
          </p>
          <p className={styles.p}>
            <strong>Colorize by agent colour.</strong> Tick it and the sprite&rsquo;s pixels are
            <strong> multiplied</strong> by the colour that agent already has, so <em>one</em> asset
            serves a whole coloured population instead of one asset per species. Draw the art in
            <strong> white or grey</strong> and it takes the agent&rsquo;s colour exactly; a black
            pixel stays black, and anything in between is shaded by it &mdash; which is what makes
            it work for a shaded sprite, not just a flat silhouette. Transparency is untouched, so
            the outline stays exactly as drawn. Left off (the default), the agent colour still
            scales the sprite&rsquo;s <em>opacity</em> exactly as it always did, and the art is drawn
            with its own colours. The colour comes from wherever it normally does &mdash;
            <strong> Set Cell Looks</strong> in the agent graph, or an
            <strong> Agent Output Mapping</strong>.
          </p>
          <p className={styles.p}>
            <strong>Crop.</strong> Downloaded art is usually padded, and that padding counts toward
            the drawn size just as much as the picture does &mdash; so a sprite can end up small and
            floating in an invisible box. <strong>Crop&hellip;</strong> opens a viewport where you
            drag a rectangle over the art (or type the numbers); <strong>Full image</strong> resets
            it and <strong>Clear</strong> removes it entirely. It applies to a plain image, an
            animated GIF/WebP and a <strong>frame sequence</strong> &mdash; the same rectangle on
            every frame, clamped to each one, so frames of different sizes are safe. A sprite
            <em> sheet</em> has no Crop row: its grid already does the cropping. Every preview (the
            row thumbnail, the editor image and the background-colour picker) shows the
            <strong> cropped</strong> frame, so you pick a chroma-key colour off the pixels the
            sprite actually draws.
          </p>
          <p className={styles.p}>
            To actually show a sprite, use that <strong>Set Agent Sprite</strong> node in an
            Agent Output Mapping graph (or the Behaviour graph). Playback is <strong>driven by your logic</strong>, not a transport &mdash; the node has
            independently-tickable options so you change only what you want:
          </p>
          <ul className={styles.list}>
            <li><strong>Change sprite</strong> &mdash; switch which sprite the agent uses (e.g. on a state
              change).</li>
            <li><strong>Set frame</strong> &mdash; jump to / reset a frame (e.g. <code>0</code> to restart
              the animation).</li>
            <li><strong>Set speed</strong> &mdash; the playback speed in frames per simulation step.
              <strong> Negative reverses</strong>; <code>0</code> holds. The engine advances the frame by
              the speed each step, so the animation only progresses while the sim runs &mdash; e.g.
              &ldquo;while moving, set speed&nbsp;=&nbsp;1 (walk plays); while idle, set speed&nbsp;=&nbsp;0&rdquo;.</li>
            <li><strong>Set rotation</strong> &mdash; the sprite&rsquo;s facing, either by an
              <em>angle</em> (compass degrees, 0&nbsp;=&nbsp;up) or by a <em>direction vector</em>
              (Dir&nbsp;X / Dir&nbsp;Y) the art aligns to. A vector lets even a <em>stationary</em>
              agent &ldquo;look at&rdquo; a target (feed it the offset toward the target). This is
              separate from the sprite&rsquo;s per-sprite <em>Orient to velocity</em> option.</li>
            <li><strong>Set scale</strong> &mdash; the per-agent size, overriding the sprite&rsquo;s
              own size (<code>0</code> = keep the sprite&rsquo;s). It is read through the sprite&rsquo;s
              <strong> Size mode</strong> (below), so it is either a multiple of the agent&rsquo;s
              diameter or an absolute world size &mdash; and either way it sets the sprite&rsquo;s
              longest side.</li>
            <li><strong>Set alpha</strong> &mdash; the agent colour&rsquo;s alpha byte (0&ndash;255);
              the sprite blit is multiplied by it, so this fades or hides the sprite per agent.
              It is the same alpha a colour pass writes &mdash; an Agent Output Mapping that sets
              the agent colour afterwards overrides it.</li>
          </ul>
          <p className={styles.p}>
            <strong>Which agent?</strong> Leave the node&rsquo;s <strong>Agent</strong> input
            unwired to act on the current agent &mdash; the normal use in an Agent Output Mapping
            or Behaviour graph (they run per-agent). Wire a <strong>Create Agent</strong> handle
            to target a spawned agent inside the <strong>Agent Init Event</strong>. (An unwired
            Set Agent Sprite placed directly in the Init Event does nothing &mdash; the Init Event
            runs once, not per-agent; for seed-painted agents put the node in an Output Mapping
            graph.)
          </p>
          <p className={styles.p}>
            <strong>Sprites and the engine.</strong> Set Agent Sprite runs on <strong>all three
            agent engines &mdash; JS, WebAssembly and WebGPU</strong>. The five per-agent sprite
            buffers live in the same shared agent memory as every other agent field on the CPU
            engines, and get their own runs in the GPU agent buffer, so a sprite-driving
            <strong> Behaviour</strong> graph compiles like any other setter and never clamps the
            model to a slower engine. In <strong>2D</strong> the sprites are also <em>drawn</em> on
            the GPU (a billboard pass alongside the disc pass), so a sprite model gets the same
            fast display path as any other; in <strong>3D</strong> they are drawn by the regular
            overlay.
            <br /><br />
            One fast path is unavailable: a sprite-writing Behaviour graph is not
            <strong> GPU-residency</strong> eligible, because the engine advances
            <em> frame&nbsp;+=&nbsp;speed</em> on the CPU once per generation and a resident batch
            runs a whole frame in a single GPU submit with no per-generation touch point. The model
            still runs on the GPU, one generation per dispatch. Putting the node in an
            <strong> Agent Output Mapping</strong> graph avoids even that &mdash; Output-Mapping
            passes are CPU-side on every agent target &mdash; and it is the natural home for it
            anyway: choosing how an agent <em>looks</em> is a presentation concern.
          </p>
          <p className={styles.p}>
            <strong>A note on speed.</strong> In <strong>2D</strong>, sprites are drawn on the GPU
            like everything else &mdash; a sprite model takes the same fast display path a plain
            disc model does, so a large sprite flock is no longer limited by the drawing. In
            <strong> 3D</strong> a sprite model still draws through the regular overlay, so there
            its frame cost is dominated by the <em>drawing</em> rather than the agent step, and
            switching engines will not move a small 3D sprite flock much.
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
              <strong> Max Bonds / Agent can be 0</strong> for a pure-force / charged-particle
              model (no bonds at all); turning on Use bonding physics bumps it to a default if
              it&rsquo;s still 0. Changing a ceiling re-initialises the engine. A generous
              <em> Max Agents</em> is cheap: memory is reserved for it, but the per-generation
              work &mdash; including the WebGPU target&rsquo;s CPU&harr;GPU transfers &mdash;
              tracks the LIVE population, not the ceiling.</li>
            <li><strong>Seeding</strong> &mdash; the <strong>Seed Count</strong> laid down on
              Reset, the <strong>Default Radius</strong> (also the radius the Add brush and{' '}
              <em>Create Agent</em> use), and the <strong>Seed Pattern</strong>:
              <em> Compact</em> (a centred blob &mdash; the tissue start), <em>Scatter</em>
              (uniformly random across the world &mdash; flocking / aggregation), or
              <strong> None</strong> for <strong>no automatic seeding at all</strong> &mdash; Reset
              leaves the world empty and the population comes entirely from your{' '}
              <em>Agent Init Event</em> and/or the <em>Add</em> brush. Under <em>None</em> the Seed
              Count is greyed out (it keeps its value, so switching back to a pattern restores it).
              Scatter draws its placement from the seeded random stream, so
              <em> Set Random Seed</em> + Reset reproduces it exactly; <em>None</em> draws nothing
              at all.</li>
            <li><strong>Motion mode</strong> (Properties &rarr; Agent Capabilities) &mdash; what the
              ENGINE is allowed to move. <strong>Force</strong> (the default) integrates
              <code>v = momentum&middot;v + (&Delta;t/&eta;)&middot;&Sigma;F</code> and then
              <code>x += v</code>. <strong>Velocity</strong> seeds <em>no</em> engine force and just
              advances <code>x += v</code>, so a <strong>Set Velocity</strong> genuinely coasts
              (under Force a momentum-0 model wipes it the same step). <strong>Static</strong> moves
              nothing at all &mdash; the force pass <em>and</em> the position commit are both
              skipped, so positions change only when your graph writes them with
              <strong>Set Agent Position</strong> (this is how <em>Ant Necrophoresis</em> walks its
              ants cell by cell). All three run on JS, WebAssembly and WebGPU.</li>
            <li><strong>Motion parameters</strong> (shown whenever motion is not Static &mdash; they
              govern how <em>your</em> forces
              integrate) &mdash; <strong>Momentum (friction)</strong>, <strong>Max Speed</strong>,
              <strong> Neighbour Query Radius</strong> (sizes the spatial hash so Get Nearby Agents
              within it stays fast), <strong>Time Step</strong> (auto-clamped for stability) and
              <strong> Drag</strong>.</li>
            <li><strong>&ldquo;My agents accelerate forever&rdquo; &mdash; lower Momentum. It IS the
              friction control.</strong> The integrator is
              <code>v &larr; momentum&middot;v + (&Delta;t/&eta;)&middot;&Sigma;F</code>, so any
              momentum below 1 decays the velocity geometrically and a constant force settles at the
              finite terminal speed <code>(&Delta;t/&eta;)&middot;F / (1 &minus; momentum)</code>.
              0 is fully overdamped (tissue); ~0.9 gives flocking inertia and is what
              <em> Boids &mdash; Flocking</em> uses with no friction node anywhere; 0.999 &mdash; the
              cap &mdash; is effectively frictionless (terminal speed 1000&times; the per-step force
              term), which is what &ldquo;infinite acceleration&rdquo; actually is.{' '}
              <em>Damping your own velocity in the graph is not a second mechanism.</em> The
              behaviour runs BEFORE the force pass, so a <strong>Get Velocity &rarr; &times;f &rarr;
              Set Velocity</strong> chain composes to
              <code>v &larr; (momentum&middot;f)&middot;v + (&Delta;t/&eta;)&middot;&Sigma;F</code>
              &mdash; exactly <code>momentum &times; f</code>; friction applied after the force add,
              <code>(v + kF)&middot;f</code>, is likewise <code>momentum = f</code> with
              <code> &eta;&prime; = &eta;/f</code>. The reason <em>Particle Life</em> nevertheless
              does it in the graph is purely authoring: a model attribute is a <em>live Simulator
              slider</em>, while Momentum lives in the Modeler&rsquo;s Properties panel (it is still
              live-tunable there &mdash; changing it needs no re-init).</li>
            <li><strong>Use bonding physics</strong> &mdash; the coarse legacy master toggle for the
              built-in engine, <strong>off by default</strong> when you enable Agents. Turn it on to
              reveal (and turn on together): <strong>Forces</strong> (the soft-sphere law:
              <strong> Repulsion</strong>, <strong>Adhesion</strong>, <strong>Interaction Range</strong>,
              <strong> Growth Rate</strong>) and <strong>Bonds</strong> (<strong>Auto-bond by
              distance</strong>, <strong>Bond Stiffness</strong>, and the <strong>Form / Break
              Distances</strong> &mdash; a hysteresis band so bonds don't flicker).{' '}
              <em>For finer control the <strong>Agent Capabilities</strong> section drives these
              individually and independently of this toggle: <strong>Collision</strong> runs the
              repulsion on its own (a pure gas), <strong>Bonds = Physics</strong> the springs, and
              <strong> Growth</strong> the radius ramp.</em> With both this toggle and the physics
              capabilities off, agents move only by your Apply Force / Set Velocity.</li>
          </ul>
          <p className={styles.p}>
            <strong>The Capability Profile is the authoritative source of engine physics.</strong>{' '}
            Every model gets one when it loads &mdash; an older file that predates the profile has one
            <em> inferred</em> from what it does (its physics flags plus a scan of the nodes its agent
            graph actually uses, so the inference can never hide a node you use), and saving bakes
            that profile into the file. The old <em>Use bonding physics</em> pair survives only as a
            fallback for a hand-edited file; if one ever reaches the engine, a notice says so and asks
            you to re-save. Adhesion is the exception worth knowing: it is still driven by that
            toggle alone, because no capability governs it yet.
          </p>
          <p className={styles.p}>
            In the Simulator, the <strong>Agents</strong> panel (docked in the right side panel)
            holds a <strong>Layers</strong> grid &mdash; independently <strong>Show</strong> (render)
            and <strong>Simulate</strong> (step) the <em>CA grid</em> and the <em>agents</em>, so you
            can freeze one layer and watch the other, or hide a layer to declutter (freezing agents
            also stops their cell-field deposits). Models whose <em>Bonds</em> capability isn&apos;t
            Off also get a <strong>Bonds</strong> row (Show only, 2D and 3D) to toggle the bond-link
            display &mdash; display-only, the bond physics keeps simulating. In 3D a bond is drawn
            from one agent&apos;s <em>surface</em> to the other&apos;s (not centre to centre) and is
            depth-sorted against the agent spheres at every zoom level, so agents in front of a bond
            always cover it. On a dense graph zoomed far out an agent can still shrink below one
            pixel while every bond line stays a pixel wide &mdash; if the mesh gets hard to read
            there, zoom in or untick <strong>Bonds</strong>. Alongside it sits the
            <strong> Agent Brush</strong>,
            which mirrors the CA-grid brush: a <em>shape</em> (square / circle / ring / line, with a
            size row and <span className={styles.kbd}>Ctrl</span>+drag resize) and a
            <strong> Single / Area</strong> scope (Single acts on exactly one agent; Area on the whole
            shape footprint), across modes
            <strong> Add</strong> (place agents &mdash; Single: one at the cursor; Area: fill the
            shape, with <em>Density</em> / <em>Drag step</em> and an <em>Add config</em> section for
            the new agents' initial attribute values <em>and their radius</em>),
            <strong>Remove</strong> (delete the nearest agent
            or all in the footprint), <strong>Move</strong> (drag one agent, or rigid-drag a whole
            footprint of agents; right-click cancels), <strong>Edit</strong> (overwrite chosen
            properties &mdash; agent attributes plus radius / velocity / position &mdash; on the
            clicked agent via <em>Apply</em>, or on every agent under the footprint; clicking an
            agent prefills the rows from its live state, rounded to the precision the engine
            actually carries, so a radius you set to <code>0.4</code> reads back as
            <code>0.4</code> rather than <code>0.4000000059604645</code>),
            <strong> Push</strong> / <strong>Pull</strong> (see below), and
            <strong> Glue</strong> / <strong>Cut</strong> (bond/unbond two clicked agents).
            Glue / Cut appear only on a model whose <strong>Bonds</strong> capability is on
            (Properties &rsaquo; Bond-Graph Agents) &mdash; without a bond store there is nothing for
            them to do, so they are left out rather than shown doing nothing. Each built-in action is
            an <strong>icon button</strong> (as are the shape buttons); hover one for its name and
            what it does &mdash; and the same glyph follows your cursor on the board, drawn just
            below the footprint, so the armed brush is readable without looking away.
          </p>
          <p className={styles.p}>
            <strong>Add: Density, Drag step, and the seed Radius.</strong> <em>Density</em> is a
            <strong> fraction of the densest possible packing</strong> at the radius the new agents
            will have: <code>1.0</code> lays them out like close-packed discs (spheres in 3D) just
            touching, <code>0.5</code> half as many. Concretely the count is
            <code> packing &times; area / (2&radic;3 &times; r&sup2;)</code> in 2D and
            <code> packing &times; volume / (4&radic;2 &times; r&sup3;)</code> in 3D, capped at 4000
            agents per stamp. Because it is defined against the agent&apos;s own size it means the
            same thing at every brush size and in every model &mdash; the same setting no longer
            gives a sparse dusting for small agents and an overlapping mass for large ones.
            The radius it uses is the <strong>Radius</strong> row in <em>Add config</em> when you
            tick it, and otherwise the model&apos;s own <em>Default Radius</em> (Properties &rsaquo;
            Bond-Graph Agents) &mdash; so ticking that row changes both how big the new agents are
            and, at the same Density, how many of them fit. <em>Drag step</em> is a different thing
            entirely: how far the cursor must travel, in world units, before a <em>drag</em> lays
            down the next stamp. A single click never uses it; lower values give a denser,
            continuous trail and higher ones separated dabs.
          </p>
          <p className={styles.p}>
            <strong>Built-in vs User defined.</strong> Those actions are the <strong>Built-in</strong>
            class &mdash; what the engine can do to any agent model. As soon as your model declares an
            <strong> Agent Input Mapping</strong>, a second class appears and the panel splits into two
            stacked sections: <strong>User defined</strong> first, listing one entry per input mapping,
            each a brush of its own (a <span className={styles.kbd}>&oplus;</span> marks a
            <em> Spawner</em>), then <strong>Built-in</strong> below it. Both are visible at once, and
            exactly one entry across the two is ever highlighted &mdash; the brush that will actually
            fire. A model with no input mapping shows no headers at all, since there would be only one
            class. Above both sits the shared <strong>Shape &amp; size</strong> block, because the
            geometry belongs to <em>the brush</em> whichever section armed it: a footprint brush (any
            built-in stamp, or an Editor mapping) gets the shape row and its size fields, a radius-only
            brush (Push / Pull, or a Spawner mapping) gets a single <em>Radius</em>, and Glue / Cut get
            neither &mdash; they are two-click picks with no extent.
            <span className={styles.kbd}>Alt</span>+scroll cycles through <em>everything</em> the two
            sections contain, built-ins and mappings alike, in the order you see them.
          </p>
          <p className={styles.p}>
            A <strong>user-defined</strong> brush is the agent counterpart of the CA grid&rsquo;s
            colour brush: instead of writing one fixed set of values (that is <em>Edit</em>), it runs
            your <strong>Agent Input Mapping</strong> graph, handing it that mapping&rsquo;s
            <strong> parameters</strong>. An <em>Editor</em> mapping runs on every agent you touch; a
            <em> Spawner</em> mapping runs once where you click and creates the agents itself. Select
            the entry and the panel below it shows one widget per parameter &mdash; or, for a mapping
            that declares none, the classic colour picker, where the graph decides what the colour
            <em>means</em> &mdash; &ldquo;redder than half &rarr; species A, else species B&rdquo;,
            &ldquo;brightness &rarr; energy&rdquo;, &ldquo;this hue &rarr; kill it&rdquo;. An Editor
            brush honours the same shape / Single-Area scope / Line tool as the other footprint modes
            (a Spawner takes the shared block&rsquo;s <em>Radius</em> instead, like Push/Pull), in 2D and 3D, on every
            agent engine, while playing or paused. Build the graph on the Agents canvas (see
            <em> Agent Input Mappings</em> under Mappings).
          </p>
          <p className={styles.p}>
            <strong>Push</strong> and <strong>Pull</strong> are a <em>physical</em> way to shove a
            running population around &mdash; the counterpart to Move, which translates a whole
            footprint rigidly. Hold the button and every agent inside a disc (2D) or ball (3D)
            around the cursor is displaced <em>radially</em>, away from it (Push) or toward it
            (Pull), with the magnitude falling off linearly from the centre to <em>zero at the
            rim</em>. They keep acting while the button is held even if the cursor never moves, and
            they work on <em>every</em> agent model (no bonds needed) on every agent engine, while
            playing or paused. A radial force needs a centre and a radius, so these two ignore the
            brush shape: the shared block shows a <em>Radius</em> (the disc) and the section below an
            <em> Intensity</em> in
            world units per second at the centre &mdash; frame-rate independent, so the same setting
            feels identical at 60 and 144&nbsp;Hz. Intensity runs from 0 to <strong>10000</strong>,
            which is four decades, so the vertical drag is <em>proportional</em> rather than linear:
            each 150&nbsp;px of travel multiplies (or divides) the strength by about
            <strong>&times;&nbsp;e</strong>, giving the same feel at 10 as at 1000, and a linear floor
            near zero so 0 is both reachable and escapable. Because the shape is fixed, both drag axes
            of <span className={styles.kbd}>Ctrl</span>+left-drag carry a real parameter in these two
            modes: <strong>drag sideways to change the Radius, up/down to change the Intensity</strong>
            (up = stronger), and both panel fields track the drag live. The cursor is a
            ring (solid for Push, dashed for Pull) with arrows showing the direction, and every
            agent the hold will move is ringed. <strong>The arrows also show the strength</strong>
            &mdash; they grow outward from the middle of the disc (and thicken, with bigger
            chevrons) as the Intensity rises, so each decade looks distinctly different; in 3D an
            inner circle shrinks the same way. Pull gathers agents down to a tiny ring around the
            centre (1% of the brush radius) rather than onto the exact centre point &mdash; each
            agent stops on its own angle of that ring, so a sustained pull can never stack agents
            onto one identical position (coincident agents feel identical forces and would lock
            in place). Push piles agents up just inside the rim (where the falloff reaches zero).
          </p>
          <p className={styles.p}>
            With the agent brush active, <span className={styles.kbd}>Ctrl+C</span> /
            <span className={styles.kbd}>Ctrl+X</span> <strong>copy / cut the agents under the
            brush footprint</strong> (positions relative to the cursor, radius, velocity, and all
            agent-attribute values; an empty footprint falls back to the hovered agent) and
            <span className={styles.kbd}> Ctrl+V</span> <strong>pastes</strong> them at the cursor
            (torus-wrapped; pasting past the agent capacity drops the excess with a notice).
            <strong> In 3D it works the same way, anchored on the brush plane</strong> &mdash; the
            cell under the brush-plane cursor is the anchor (so the plane has to be enabled and the
            cursor over a cell, otherwise the shortcut does nothing and says so), the footprint is
            the same solid region the 3D Remove / Edit brushes act on, and offsets are kept in all
            three axes so a paste on a different layer moves the whole cluster with it. A copy says
            how many agents it grabbed, since a 3D footprint is occluded. One clipboard serves both
            views: a 2D copy pasted in 3D lands flat on the anchor&apos;s plane, and a 3D copy
            pasted into a 2D model flattens. <strong>Bonds and sprite state do not travel</strong>
            &mdash; pasted agents arrive unbonded &mdash; and attributes the target model
            doesn&apos;t have are skipped.
            <span className={styles.kbd}>Shift</span>+click an agent to <strong>inspect</strong> it
            (a popover of its position, velocity, bond degree and attribute values). Agent
            inspectors work like the cell ones: <strong>several can be open at once</strong>, each is
            <strong> dragged by its header</strong>, closes with its &times; or <span className={styles.kbd}>Esc</span>,
            and offers <strong>Close all</strong>; dragging across agents before releasing re-targets
            the transient popover instead of pinning it. Every open inspector also <strong>rings its
            agent</strong> &mdash; a soft-white circle on the 2D overlay, a white ring in the 3D
            volume &mdash; and the ring <strong>follows that agent</strong> as it moves; the agent being
            followed by the camera gets a <strong>double accent ring</strong> instead. A pinned
            inspector&rsquo;s <span className={styles.kbd}>&#9678;</span> button turns on <strong>Follow
            mode</strong>: the camera then tracks that agent, in 2D and in 3D. The camera is
            <em> accelerated</em> toward the agent by a critically damped spring and <em>leads</em> it by
            the agent&rsquo;s own velocity, so it picks up smoothly, never overshoots, and <strong>catches
            up</strong> instead of trailing behind an agent travelling at a steady speed. Rapid jitter is
            absorbed by the spring rather than mirrored, and once the agent comes to rest the camera settles
            and stops moving entirely. On a torus it always takes the short way round the seam. One agent is
            followed at a time. Follow stops when you click{' '}
            <span className={styles.kbd}>&#9678;</span> again, close the popover, the agent dies, or you
            move the camera yourself by <strong>panning</strong> (or Reset view) &mdash; <em>zooming and
            3D orbiting do not stop it</em>, so you can zoom in on a followed agent and swing the 3D
            camera around it while it keeps being tracked.{' '}
            <strong>Bonds are selectable too</strong>: on a model that can hold bonds, an inspect
            click (<span className={styles.kbd}>Shift</span>+click, or the toolbar
            <span className={styles.kbd}>&#9432;</span> Inspect toggle) that lands on <em>no agent</em> but
            near a <strong>bond line</strong> opens a <strong>bond inspector</strong> — its two endpoint
            ids (click either to open that agent&rsquo;s inspector), the current length (torus-folded),
            the rest length, the spring stiffness (shown only when the model actually runs bond
            springs) and <strong>one row per bond attribute</strong>, with tag values shown by name.
            Those rows are <em>editable</em>: change a field and press <strong>Apply</strong>. Rows read
            the LIVE value until you touch them (a rule that rewrites a bond attribute every generation
            would otherwise fight your typing), and the write lands on <strong>both sides</strong> of
            the bond — a bond is one object stored twice, so the two copies always agree. The selected
            bond is stroked in the accent colour and the stroke follows its endpoints as they move; if
            the bond breaks, the popover says so and the stroke disappears. Agents win the click, so a
            bond whose line is hidden underneath two touching cells cannot be picked — read its values
            from either endpoint&rsquo;s agent inspector instead, which lists every bond with its
            attribute values. Bond selection is <strong>2D only</strong> for now. Loading
            a different model closes every open inspector (cell, agent and bond). The
            <strong> CA&nbsp;Grid</strong> brush target paints cells with the normal brush. In Area
            scope the agents the stroke will touch are <strong>highlighted</strong> (every mode
            except Add), a <strong>Show brush cursor</strong> checkbox toggles the brush overlay, and
            the cursor clears when the pointer leaves the canvas. All of the above work in the 3D
            voxel view too. For an <strong>agents-only</strong> model (or when you hide the CA&nbsp;Grid
            layer), the CA-grid controls disappear and a <strong>Background</strong> colour can fill
            the environment behind the agents.
            <strong> Clear all agents</strong> empties the population. The library ships ten agent samples: <strong>Morphogenesis &mdash; Growing Tissue</strong> (12 → ~1500 cells
            dividing along the tension axis), <strong>Morphogenesis &mdash; Differential
            Tissue</strong> (asymmetric division + a maturity gradient + contact inhibition = cell
            <em> specialization</em>), <strong>Morphogenesis &mdash; 3D Tissue</strong> (the same
            engine growing a connected tissue in a 3D volume), <strong>Boids &mdash; Flocking</strong> (separation +
            alignment + cohesion), <strong>Boids &mdash; Hemifield Vision</strong> (the Braitenberg
            variant: agents steer purely from left-vs-right agent COUNTS in three differently-coloured
            vision cones &mdash; try <em>Show vision = All</em>), <strong>Chemotaxis &mdash; Aggregation</strong> (secrete a
            chemical, the grid diffuses it, agents climb the gradient and aggregate),
            <strong> Game of Life on Agents</strong> (Conway&apos;s rule on a grid of agents &mdash;
            the genericity proof), <strong>Ant Necrophoresis</strong> (stigmergy: ants pile
            discrete corpses via the cell-field bridge, with the total exactly conserved), and the two <strong>Particle Life</strong>
            samples (2D / 3D) &mdash; load any to see the pipeline at work.
          </p>
          <p className={styles.p}>
            <strong>Saving agent state:</strong> agent positions, velocities, attributes,
            bonds and sprites are included in <strong>Export State</strong> (.gcastate) and in
            <strong> Save Project</strong> with the grid option enabled, and are restored on
            load &mdash; so a grown tissue or an aggregated flock resumes exactly where you
            left it.
          </p>
          <h3 className={styles.h3}>Performance</h3>
          <p className={styles.p}>
            Almost the entire cost of an agent generation is the <em>neighbour pair
            work</em>: it scales with <strong>N &times; local density &times; query
            radius&sup2;</strong>, not with N alone. Two practical consequences:
          </p>
          <ul className={styles.list}>
            <li><strong>Grow the world with the population.</strong> Doubling N in the
              same world doubles the density too, so each agent sees twice the
              neighbours &mdash; the cost <em>quadruples</em>. Scaling the world so
              density stays constant keeps the per-agent cost flat (50k agents in a
              large world can run faster than 10k crammed into a small one).</li>
            <li><strong>Keep radii tight.</strong> The <strong>Neighbour Query
              Radius</strong> (Properties &rarr; Bond-Graph Agents &rarr; Motion) sets the
              spatial-hash bin size for <em>every</em> neighbour pass &mdash; set it no
              larger than the biggest radius the model actually queries, and keep the
              wired Get Nearby Agents radii as small as the rule allows. Halving a
              radius quarters the candidate area.</li>
            <li><strong>Compile target:</strong> WebAssembly runs heavy per-agent rules
              2&ndash;5&times; faster than JS (bit-identically). The <strong>WebGPU</strong>{' '}
              agent target shines for <em>large populations</em>: eligible models (custom
              forces, async attributes, no bonds/division/field coupling &mdash; the
              Particle-Life / Boids class) run whole frames <em>resident on the GPU</em>,
              tens of times faster than the CPU at 50k+ agents. Models outside that
              class use the per-generation GPU path (see <em>Two GPU paths</em> below), where
              the CPU&harr;GPU transfer each generation can still make JS/WASM the faster
              choice at small populations. One exception: a
              field-coupled model (agents that read/write a cell field) whose grid is{' '}
              <em>also</em> on WebGPU and whose agent-accessible cell fields are all
              Decimal (float) bridges the field entirely GPU-side each step &mdash; no CPU
              field copy &mdash; roughly twice as fast as the CPU field bridge.</li>
            <li>The engine skips work it can prove is dead automatically &mdash; e.g. the
              built-in neighbour-density scan only runs when something actually reads it
              (a Neighbour Density node <em>with no Radius</em>, division, or engine physics), so a
              pure custom-force model &mdash; or one whose density nodes all carry their own Radius
              &mdash; pays nothing for it.</li>
            <li><strong>Direct agent render.</strong> For a model whose agents do
              <em>not</em> exchange a cell field with the grid (an agents-only model, or a
              2D grid+agents model whose agents never read or write a cell attribute) &mdash;
              with no bonds, no sprites and no metaballs, on <em>any</em> agent target (JS,
              WebAssembly, or WebGPU) &mdash; the worker renders the agents on the GPU
              into the canvas and the main thread just copies the finished frame. When the
              grid is present it draws normally underneath, with the agents composited on
              top (2D). While you simply watch it run, the browser does almost no per-frame
              work; the simulation only pays a small one-off cost the moment a feature (the
              agent brush, the inspector, recording, saving, or pausing) needs the live
              agent positions, and everything keeps working exactly as before. A model
              whose agents DO use a cell field (chemotaxis, stigmergy), or one that draws
              <em>bonds</em> (a tissue, a graph-rewriting rule), keeps the standard render
              &mdash; bond lines are drawn by the regular agent overlay, which this fast
              path replaces.</li>
            <li><strong>Glow.</strong> The <strong>Glow agents</strong> Graphics option
              (in the agent controls) gives every agent a <strong>solid core</strong> with
              a soft halo around it &mdash; <em>Size</em> is the extra halo radius in
              pixels, <em>Core</em> how far the solid colour reaches (it can also reach
              back <em>inwards</em>, below&nbsp;0),
              <em>Intensity</em> the halo&apos;s brightness, <em>Falloff</em> how fast it
              fades across the band outside the core. Overlapping halos are
              <em>added together at full precision first, and the total is compressed into
              displayable colour once</em> &mdash; the same approach a dedicated glow renderer
              uses, and the reason a dense cluster keeps a readable gradient and its hue
              instead of flattening into a hard-edged white patch. Because the sum is never
              clipped along the way, <em>Intensity</em> keeps meaning something well past 1:
              raising it brightens the whole halo rather than growing a flat, fully-saturated
              disc around each agent. A lone agent&apos;s halo is a smooth fade to nothing,
              and the brightest halos in a pile stay distinguishable from one another. The core is
              drawn <em>opaque</em>, so
              it is never washed out by a neighbour&apos;s halo nor dimmed by a low
              intensity: a dense cluster can glow as bright as you like while an isolated
              agent still reads as a crisp, true-coloured dot &mdash; you no longer have to
              choose between the two. At <em>Core&nbsp;0</em> (the default) the core is the
              agent&apos;s own disc and the halo sits entirely outside it; raise Core to grow
              a solid nucleus out into the halo band, or take it <em>below&nbsp;0</em> to
              shrink the solid part <em>inside</em> the disc &mdash; at <em>Core&nbsp;-1</em>
              there is no solid body left at all and each agent is pure glow, a soft light
              source rather than a lit dot. (The shrink applies to plain agent <em>discs</em>:
              a sprite&apos;s artwork and a fused metaball blob are their own layers and keep
              their full size, with the halo simply glowing behind them.) It works on
              <em>every</em> 2D agent
              model and every agent target: on the direct-render path the shader draws the
              halo and the core as two passes, and everywhere else (bonded graphs and
              tissues, metaballs, field-coupled models) the regular agent overlay
              draws the halo under the discs and bonds for the same result &mdash; both
              accumulate and compress the same way, so the two paths look the same. It is a
              per-agent drawing cost, so on very large populations expect a slower display
              (measured ~30&nbsp;ms per frame at 10&nbsp;000 agents on the overlay path); the
              simulation itself is unaffected.</li>
            <li><strong>Glow in 3D.</strong> The same option works in 3D, by a
              <em>different technique</em>: instead of a halo drawn around each agent it is a
              <strong>bloom</strong> &mdash; the agent layer is blurred and its light added back
              over the scene. That is deliberate. A flat halo pasted onto a lit sphere reads as a
              sticker, whereas a bloom picks up the <em>shading</em> &mdash; the highlight, the
              rim, the bright side of every sphere &mdash; which is what makes a glowing object
              look three-dimensional. The sliders carry over: <em>Size</em> is how far the light
              spills, <em>Intensity</em> how much is added, <em>Falloff</em> whether the spill is
              tight or wide, and <em>Core</em> how much of each agent&apos;s own body is held back
              from the bloom (at&nbsp;1 the bodies are left exactly as they render and only the
              surrounding spill is added). The 2D slider&apos;s sub-zero half has no meaning
              here &mdash; dissolving a solid disc is a 2D idea &mdash; so in 3D the slider
              simply starts at&nbsp;0. Brightness is compressed with the same curve the 2D
              glow uses, so <em>Intensity</em> means the same thing in both views. Only the agents
              bloom &mdash; a CA grid behind them is never blurred &mdash; and the effect can only
              ever <em>add</em> light, so nothing in the scene gets darker. Both 3D renderers draw
              the bloom &mdash; the main viewport one and the worker&apos;s fast path &mdash; so
              turning glow on costs you nothing in speed and looks identical either way.
              Screenshots and recordings include it.</li>
            <li><strong>Direct agent render &mdash; 3D.</strong> The same fast path works
              for <em>3D</em> agents-only models: while you just watch, the worker draws the
              agents as GPU spheres <em>and</em> the scene-anchored geometry (axes, floor grid,
              bounds box, brush plane) in one depth pass, so agents in front correctly hide
              them; the 3D viewport adds only the cursor-style overlays (brush outline, hovered
              cells, axis labels, gizmo) on top. It engages when there are no bonds to draw and
              <strong> Alpha blend</strong> is OFF (translucent spheres need the sorted
              3D path). The moment you interact, pause, or record, it seamlessly returns to
              the full 3D render &mdash; so cast shadows, ambient occlusion and translucent
              (alpha-blend) agents appear then; in the free-running fast path those are off
              (the spheres are opaque).</li>
          </ul>

          <h3 className={styles.h3}>Two GPU paths &mdash; and why a bonded model takes the slower one</h3>
          <p className={styles.p}>
            The WebGPU agent target has <strong>two</strong> paths, and which one your model
            gets is the biggest single performance fact about it:
          </p>
          <ul className={styles.list}>
            <li><strong>Resident</strong> &mdash; a whole Gens/Frame batch is sent to the GPU
              as <em>one</em> job and the CPU is not involved between generations at all; the
              results come back once per <em>frame</em>. This is the tens-of-times-faster
              path.</li>
            <li><strong>Per generation</strong> &mdash; the behaviour and force passes still
              run on the GPU, but each generation ends with a round-trip: the agent state is
              sent up, stepped, and read back. Everything that is not eligible for residency
              lands here.</li>
          </ul>
          <p className={styles.p}>
            Residency&rsquo;s whole value is that <em>nothing</em> happens on the CPU between
            generations &mdash; so any feature that needs the CPU there rules it out. The big
            one is <strong>bonds</strong>. Forming, breaking, rewiring, dividing and dying all
            happen in a <em>structural phase</em> that runs on the CPU on every compile
            target: the graph can only <em>request</em> those operations, and applying them is
            bookkeeping on a linked structure (reclaiming bond slots, splitting a dividing
            agent&rsquo;s bonds between its daughters, rewiring every partner), not the kind
            of uniform per-agent arithmetic a GPU runs well. So a model with a bond store, or
            with Divide / Form Bond / Break Bond / Rewire Bond / Kill Agent in its behaviour,
            takes the per-generation path by construction. The same is true of a field-coupled
            model, synchronous agent attributes, positional collision, agent spawning, Stop
            Events, and indicator accumulation.
          </p>
          <p className={styles.p}>
            <strong>This is not a defect to work around, and nothing is silently wrong</strong>
            &mdash; a graph-rewriting model is simply a different class of simulation from a
            flock. Two things that <em>do</em> help: the per-generation transfer now scales
            with your live population rather than the <em>Max Agents</em> ceiling (so a
            generous ceiling costs nothing), and at small populations the{' '}
            <strong>WebAssembly</strong> agent target is often faster still, because a CPU
            target has no round-trip at all. Try both &mdash; the target chip in the
            simulator&rsquo;s stats overlay shows which one is actually running.
          </p>
        </section>

        {/* ============================================================ */}
        <section id="help-overseer" className={styles.section}>
          <h2 className={styles.h2}>The Overseer (Experiment Orchestration)</h2>
          <p className={styles.p}>
            The <strong>Overseer</strong> is an opt-in third graph that automates whole
            experiments <em>around</em> the simulation. Where the Cells and Agents graphs
            define what happens <em>inside</em> a run, the Overseer graph is the
            experiment protocol: repeat seeded runs, sweep parameters, run until a Stop
            Event, read indicators, collect samples, aggregate statistics, and log or
            capture the results &mdash; so a <em>set of executions</em> becomes one
            reproducible, automated experiment (mean &plusmn; std across replicates, a
            sweep response curve) instead of one anecdotal run.
          </p>
          <p className={styles.p}>
            Enable it with <strong>Use Overseer</strong> in Model Properties &rarr;
            Execution. That reveals an <strong>Overseer</strong> tab in the Modeler&apos;s
            graph strip and an <strong>Overseer Experiments</strong> tab in the
            Simulator&apos;s right panel (alongside the Controls tab). With the checkbox
            off the feature is completely invisible.
          </p>
          <h3 className={styles.h3}>Building an experiment</h3>
          <p className={styles.p}>
            Start from the <strong>Experiment</strong> node (the root &mdash; it runs when
            you press <strong>Run Experiment</strong> on the Overseer Experiments tab) and chain
            the protocol from its DO port using the familiar flow nodes (Loop, If/Then,
            For Each In Array, Switch, Sequence) plus the Overseer actions:
          </p>
          <ul className={styles.ul}>
            <li><strong>Reset Board / Run Generations / Run Until Stop</strong> &mdash; drive
              the simulation (Run Until Stop ends on a Stop Event, an End Condition, or its
              safety cap, and outputs the generation it stopped at and why).</li>
            <li><strong>Set Random Seed</strong> + the per-run <strong>seed policy</strong>
              (Model Properties &rarr; Overseer) &mdash; make runs reproducible. The
              &quot;sequential&quot; policy re-seeds each Reset with base + run index, so
              replicates differ from each other but the whole batch reproduces exactly.</li>
            <li><strong>Set Model Attribute / Load Preset / Sweep Values</strong> &mdash; the
              parameter-sweep primitives (Sweep Values feeds For Each In Array; Set Model
              Attribute behaves like the simulator sliders &mdash; runtime-only, it never
              edits the model definition).</li>
            <li><strong>Read Indicator / Get Generation</strong> &mdash; measurements. The
              Overseer reads what indicators already compute (for a frequency indicator,
              pick the category to read); values are always the latest simulated state.</li>
            <li><strong>Collect Sample / Series Statistic / Clear Series</strong> &mdash; the
              statistics layer: append measurements to named series, then aggregate
              (mean, std, min, max, median, sum, count, 95% CI). Each scalar series is
              auto-rendered in the panel as a <strong>histogram</strong> of its
              distribution across the runs (with the mean marked) &mdash; toggle to a
              per-run sequence view.</li>
            <li><strong>Collect Spatial Sample</strong> &mdash; capture a <em>spatial</em>
              indicator&apos;s whole per-position curve (e.g. one solute of a chromatogram)
              as one replicate; the panel aggregates the replicates into a{' '}
              <strong>mean &plusmn; &sigma; chart</strong> &mdash; the statistically strong
              version of a single noisy spatial profile. Series sharing a Chart name overlay
              on one chart.</li>
            <li><strong>Log Message / Take Screenshot / Start &amp; Stop Recording /
              Stop Experiment</strong> &mdash; journal lines (with {'{value}'} and {'{gen}'}
              placeholders), captures, and an early exit. An experiment runs unattended, so its
              captures are written straight out &mdash; they skip the review dialog the buttons
              use, which would otherwise stall the sweep waiting for a click (and with it the
              pause that dialog takes, so a sweep never stops itself to capture).</li>
          </ul>
          <h3 className={styles.h3}>The Overseer Experiments tab</h3>
          <p className={styles.p}>
            <strong>Run Experiment</strong> executes the graph (the transport is disabled
            while it runs; <strong>Abort</strong> stops it within one step batch). The
            panel shows a live status line (run count, generation, elapsed), the scrolling
            <strong> Journal</strong>, a <strong>Series</strong> table with live statistics,
            a <strong>histogram</strong> per scalar series (the replicate-distribution
            figure), and any <strong>aggregate spatial charts</strong> (mean &plusmn;
            &sigma; curves from Collect Spatial Sample) &mdash; all exportable as
            <strong> CSV</strong>
            (long format) or <strong>JSON</strong> (journal + series + spatial aggregates).
            Results are runtime artifacts: they are never saved into the model file. The{' '}
            <strong>Chromatography</strong> sample ships a built-in experiment that
            reproduces the paper&apos;s ensemble chromatogram (Fig. 3) as a run-averaged
            mean &plusmn; &sigma; curve.
          </p>
          <p className={styles.p}>
            The Overseer is not a compile target &mdash; it orchestrates the worker from
            the main thread, so the CA itself keeps running on whichever compile target
            the model selects (JavaScript, WebAssembly, or WebGPU). Seeded experiments are
            bit-reproducible on JS and WASM (which share the RNG stream) and
            statistically reproducible on WebGPU (per-cell PCG &mdash; the documented
            target difference). See the <strong>GoL Replicate Statistics</strong> library
            sample for the canonical loop&nbsp;&rarr;&nbsp;collect&nbsp;&rarr;&nbsp;aggregate
            idiom.
          </p>
          <p className={styles.p}>
            <strong>What a sweep&rsquo;s numbers mean depends on the model&rsquo;s declared
            reproducibility contract</strong> (Properties &rarr; Execution &mdash; see
            &ldquo;Reproducibility: Exact or Statistical&rdquo; in the Bond-Graph Agents
            chapter), and the panel states it in one line above the Journal. Under
            <strong> Exact</strong> a seed pins each run, so two presses of Run Experiment
            produce identical numbers &mdash; unless a layer runs on the GPU, where the run is
            pinned on <em>this</em> device but its f32 numbers are engine- and
            device-specific and must not be compared against a CPU run. Under
            <strong> Statistical</strong> a single run is not a result: use repeats and
            aggregates (Collect Sample &rarr; Series Stat &mdash; mean / std / ci95), which
            is the more honest methodology for a stochastic model anyway. If the model
            declares Exact while an engine that cannot honour it is explicitly selected,
            the line turns amber and says so.
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
            The simulator has a <strong>bottom transport bar</strong> carrying only
            simulation <em>time</em>: save / load state (each also carrying its CSV
            sibling on hover or right-click), the two adjacent speed readouts
            (Target FPS, Gens/Frame), and playback (one Play/Pause button that
            alternates its icon, plus Step and Reset). Hover or
            click a speed readout to open a vertical slider popover
            (Esc, an outside click, or moving away closes it; the &infin; checkbox keeps
            its meaning, and grabbing the slider while &infin; is on unticks it).
            A high Gens/Frame no longer costs you the controls: the worker runs a
            batch in short time-budgeted chunks, so <strong>Pause and a lowered
            Gens/Frame take effect in about a tenth of a second</strong> however long
            the batch would have been, and the page keeps repainting throughout
            (before, a multi-second batch had to finish first, and on the WebGPU
            grid it could also stall the browser&apos;s compositor so the whole UI
            appeared frozen). The batch still reports one frame, so nothing about
            indicators, recording or experiments changes.
            Capture (screenshot / recording) is <em>output</em>, so it lives in its own
            cluster at the <strong>bottom-right of the canvas, under the stats
            readout</strong> &mdash; see &ldquo;Where the capture controls live&rdquo; below.
            There is also a <strong>top viewer bar</strong> for switching between visualization
            mappings, a collapsible <strong>left panel</strong> for settings (actions,
            grid dimensions, model attributes), and a collapsible <strong>right
            panel</strong> holding the brush settings (Input Mapping) above the
            Indicators. Hover over any mapping tab in either bar
            to see the mapping&apos;s description as a tooltip (matches the existing
            attribute / preset tooltips). When the model has indicators, a draggable
            divider sits between the brush area and the Indicators &mdash; drag it to give
            the indicators more room (double-click to reset it to fit-the-brush).
          </p>
          <p className={styles.p}>
            <strong>What you see is what this model can do.</strong> A control the current
            model / view could not act on is <em>not shown</em> &mdash; gridlines without a
            CA grid, the infinity canvas in 3D, agent Glue/Cut without bonds, agent
            outlines while Metaballs replaces the bodies, and so on. A control that is only
            <em>temporarily</em> unavailable stays visible but greyed out with the reason in
            its tooltip &mdash; the capture settings while a recording is running, the
            infinity canvas on a non-torus boundary, the WebM-only quality rows under GIF.
            So an enabled control always does something, and a greyed one always tells you
            what to change.
          </p>

          <h3 className={styles.h3}>Canvas Controls</h3>
          <ul className={styles.list}>
            <li><strong>Left-click drag</strong> &mdash; Paint with the brush tool.</li>
            <li><strong>Right-click drag</strong> &mdash; Pan the grid view.</li>
            <li><strong>Double right-click</strong> &mdash; Fit the view (the same thing the
              &#x2922; zoom button does; in 3D it restores the default orbit camera, like the
              3D View panel&rsquo;s <strong>Reset view</strong>). Two quick right-clicks in the
              same spot &mdash; a right-click <em>drag</em> still just pans.</li>
            <li><strong>Middle-click</strong> &mdash; Toggle autoscroll: the cursor becomes an anchor and the
              view continuously pans toward wherever you move the cursor, with speed proportional to the
              distance from the anchor. Click again (any button) or press <kbd className={styles.kbd}>Esc</kbd>
              to stop.</li>
            <li><strong>Scroll wheel</strong> &mdash; Zoom in/out.</li>
            <li><strong>Ctrl + left-click drag</strong> &mdash; Resize the brush. The dragged
              dimensions adapt to the active brush shape: Rectangle = width (horizontal) / height
              (vertical); Circle = radius; Ring = radius (horizontal) / band width (vertical);
              Line = thickness. With the agent brush in <strong>Push</strong> or <strong>Pull</strong>
              (which have no shape) the two axes carry that mode's two parameters instead:
              radius (horizontal) / intensity (vertical, up = stronger &mdash; by a fixed
              proportion per pixel, about &times;&nbsp;e per 150&nbsp;px, so the whole
              0&ndash;10000 range is controllable at any magnitude).</li>
            <li><strong>Zoom buttons</strong> (+/&minus;/fit/gridlines/axes/smooth scaling/infinity) &mdash; Bottom-left of the canvas.
              Each button is shown only where it can actually do something: the
              <strong>gridlines</strong> toggle needs a 2D model with a CA grid (in 3D its
              analogue is the 3D View panel&rsquo;s <strong>Cell gaps</strong>; an agents-only
              model has no grid to line), and <strong>&infin;</strong> is 2D-only because the
              voxel renderer draws the volume once and never tiles it.
              The <strong>&infin;</strong> button (only enabled on torus-boundary models) tiles the grid
              across the viewport so you can pan endlessly across the wrap seams; the brush wraps with it.
              The <strong>axes</strong> toggle (2D) marks the grid origin (cell 0,0) with the row/column
              growth directions &mdash; columns red toward the right, rows green toward the bottom,
              each axis spanning the full grid edge with an arrowhead and a <code>C&nbsp;(n)</code> /
              <code>R&nbsp;(n)</code> label carrying the dimension count &mdash; matching the 3D
              view&rsquo;s axis colours (whose axes likewise carry C/R/D letters + counts at the tips).
              Drawn on top of the agent layer so nothing covers it.
              The <strong>&#x224B; smooth grid scaling</strong> toggle interpolates the grid
              when it is scaled up instead of drawing hard-edged cells &mdash; <em>off</em> by default,
              because crisp cells are what a discrete CA should look like, but a real win for
              continuous-valued fields (Gray-Scott, MNCA) where the smoothed upscale reads as an
              actual field. It applies to the <em>cell</em> layer only (glyphs, gridlines and the
              brush cursor stay crisp), and a simulation-scope screenshot/recording follows it too.
              The button is hidden where the main thread doesn&rsquo;t do that upscale: in 3D
              (which already renders with hardware MSAA), on an agents-only model (no grid), and on
              a grid+agents model running the single-canvas WebGPU composite (whose grid layer is
              drawn in the worker at display resolution).</li>
            <li><strong>Agent bodies are always antialiased</strong> &mdash; there is no toggle,
              because there is nothing to switch off. A 2D agent disc gets a one-pixel coverage
              ramp on its contour on <em>every</em> path: the CPU overlay draws it with Canvas2D,
              and the GPU disc shader (used by the direct render and by the single-canvas composite)
              computes the same half-in/half-out coverage analytically from the screen-space
              derivative of the radius. Earlier builds ended the GPU silhouette with a hard
              cut, so a direct-render model (Particle Life, and every WebGPU grid+agents model)
              looked serrated while an overlay model looked smooth &mdash; that inconsistency is
              gone. Agent <em>outlines</em> are feathered the same way. In 3D the sphere impostors
              still have a hard silhouette on both the frame-mode and free-mode paths; a
              coverage fix there needs multisampling with alpha-to-coverage on both renderers at
              once (they must stay identical across the free/frame flip), so it is a separate
              change.</li>
            <li><strong>Compile-target chip</strong> &mdash; the top-left stats overlay shows which
              compile target is running (<code>&#x2699; WASM</code>, <code>WebGPU</code>, <code>JS</code>,
              plus <code>agents &hellip;</code> for agent models). If the selected WebGPU target fails to
              initialise on the device, the chip turns amber (<code>WebGPU&#x2717;</code>).</li>
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
            <li><strong>Reset</strong> &mdash; Back to the initial state. Normally that means{' '}
              <em>reseed from the rules</em>: defaults, then the model&apos;s Init Events. A model
              whose board is <em>data</em> (imported map layers, a hand-painted starting
              configuration) can declare that saved board as its initial state instead &mdash;{' '}
              <em>Properties &rarr; Execution &rarr; &ldquo;Reset restores saved board&rdquo;</em>,
              or the <em>Use as initial state</em> box in the Save dialog &mdash; and then Reset
              reseeds <em>and</em> applies that board on top. Whichever is the default,{' '}
              <strong>hover or right-click the Reset button</strong> to pick either action
              explicitly (the menu appears only when the model actually carries a board).</li>
            <li><strong>Recompile</strong> &mdash; Recompile the graph after editing in the modeler.</li>
          </ul>

          <h3 className={styles.h3}>Brush Tool</h3>
          <p className={styles.p}>
            Left-click on the canvas to paint cells. Open the right panel to configure
            brush color, shape, size, and input mapping. For a mapping that still uses the
            classic color brush, the color picker is accompanied by three{' '}
            <strong>R/G/B</strong> numeric inputs so you can set or read exact channel
            values. For a mapping that declares its own <strong>parameters</strong> (see
            &ldquo;Input Mapping Parameters&rdquo; under Mappings) the panel instead shows
            one widget per parameter &mdash; a number, a checkbox, a tag list or a color
            swatch &mdash; and the color popover is hidden, because there is no brush color
            for it to edit. Use <strong>Ctrl + left-click drag</strong> to
            resize the brush interactively; <strong>Ctrl + scroll wheel</strong> cycles
            through the available Input Mappings; <strong>Shift + right-click</strong>{' '}
            opens an in-page color picker at the cursor (with R/G/B inputs plus a
            &quot;Full picker&quot; row for the native OS color dialog). Use{' '}
            <strong>Open Image</strong> in the brush panel (or <strong>Ctrl+V</strong> a
            clipboard image) to import a picture as the starting grid state. On a 2D grid
            this opens a <strong>Map Image to Cells</strong> dialog: a pannable/zoomable
            source viewport on the left (<em>wheel</em> to zoom, <em>middle/right-drag</em>
            to pan, or the &minus;/+/Fit buttons) with two overlays &mdash; a <strong>blue
            included-area box</strong> (drag to move, corner to resize, empty space to
            redraw) and a small <strong>orange cell-reference square</strong> that sets both
            the sampling <em>cell size</em> and how the grid <em>aligns</em> to the image
            (drag it, corner to resize; &quot;Align to area&quot; snaps it to the area's
            corner) &mdash; and a gridified preview on the right. Choose average-vs-centre
            sampling, invert, binarize + threshold, the Colour&rarr;Attribute input mapping,
            and whether to <strong>resize the grid to fit</strong> or <strong>paste
            centered</strong> onto the current grid. Tick <strong>use manual input
            mapping</strong> to instead paint the binarized-true cells with chosen attribute
            values (like clicking the manual brush on each) &mdash; this path works even when
            the model has no Colour&rarr;Attribute mapping. (A 3D model keeps the classic
            1&nbsp;pixel&nbsp;=&nbsp;1&nbsp;cell import.)
          </p>
          <p className={styles.p}>
            If the chosen input mapping declares its own <strong>parameters</strong>, the
            dialog adds a table saying <em>where each parameter gets its value</em>: sampled
            from the pixel (<code>R</code>, <code>G</code>, <code>B</code>, <code>A</code>,
            or its <strong>luminance</strong> &mdash; all 0&ndash;255) or the same
            <strong> constant</strong> for every cell. It opens on a sensible default (a
            color parameter takes R/G/B; otherwise the first three parameters do; everything
            else is a constant seeded from your current brush value), and you can change any
            row. <em>Luminance</em> is the natural choice for a yes/no parameter, because
            <strong> binarize</strong> collapses each pixel to 0 or 255 by exactly that
            measure. Average / invert / binarize are pixel operations, so they still change
            what those sources read &mdash; they grey out only if you set <em>every</em>
            parameter to a constant, since then the image is not sampled at all. A mapping
            with no declared parameters keeps the classic behaviour: the pixel&rsquo;s R, G
            and B are handed straight to the graph.
          </p>
          <p className={styles.p}>
            <strong>Scope:</strong> image import writes <em>cells</em>. To populate an agent
            layer from data, use <strong>Import CSV</strong> (one row per agent) &mdash;
            spawning agents from an image is not supported yet.
          </p>
          <h3 className={styles.h3}>Import CSV</h3>
          <p className={styles.p}>
            <strong>Import CSV&hellip;</strong> brings tabular data into a running simulation.
            It lives on the transport bar&apos;s <strong>Import</strong> button &mdash;
            hover it (or right-click it) and pick <em>Import CSV / ASC&hellip;</em>; a plain click
            still imports a <code>.gcastate</code>. You can also just <strong>drop a .csv / .tsv
            / .asc file</strong> anywhere on the app. One dialog covers two flavours; a model with
            both layers gets a <strong>Target</strong> switch.
          </p>
          <ul className={styles.list}>
            <li>
              <strong>Agents</strong> &mdash; each CSV <em>row</em> is one agent. Every column
              gets a target: <em>ignore</em>, a position/velocity component (x/y/z, vx/vy/vz),
              <em> radius</em>, an agent attribute, or one component of a <em>vector</em>{' '}
              attribute (<code>facing.x</code>). With a header row the columns are auto-mapped
              by name (case- and punctuation-insensitive, so <code>Pos X</code>,{' '}
              <code>pos_x</code> and <code>x</code> all match) &mdash; always overridable.
              Choose <strong>Replace population</strong> (clears first) or{' '}
              <strong>Append</strong>. Positions outside the world wrap on a torus and clamp
              otherwise; rows beyond <em>Max Agents</em> are reported, not silently dropped.
            </li>
            <li>
              <strong>Grid</strong> &mdash; the CSV <em>is</em> the board: a <strong>line is a
              grid row</strong> (height) and a <strong>field is a grid column</strong> (width),
              so a 12&times;9 file gives a 9&nbsp;wide &times; 12&nbsp;tall grid. Every value
              goes into ONE chosen cell attribute. Either <strong>resize the grid to the
              CSV</strong> or <strong>keep the grid</strong> (the dimensions must then match
              exactly). In a 3D model a 2D table cannot fill a volume, so it writes one
              chosen <strong>Layer</strong>.
            </li>
          </ul>
          <p className={styles.p}>
            Values are read per attribute type: numbers for integer (rounded) and decimal;{' '}
            <code>1/0</code>, <code>true/false</code>, <code>yes/no</code> for binary; a tag&apos;s
            option <em>name</em> (case-insensitive) or its numeric index for tags. The
            delimiter (comma / semicolon / tab) and whether the first row is a header are
            auto-detected and overridable &mdash; note that <em>Grid</em> defaults to{' '}
            <strong>no header</strong>, since in a board every line is a row. Anything that
            will not parse falls back to that attribute&apos;s default and is{' '}
            <strong>counted and listed</strong> in the dialog before you import &mdash; an
            import never fails silently.
          </p>
          <p className={styles.p}>
            <strong>ASCII-art boards &mdash; the &quot;no delimiter&quot; mode.</strong> Most
            published CA patterns are written as plain character art (Life as{' '}
            <code>.</code>/<code>O</code>, Wireworld as <code>.</code>/<code>H</code>/
            <code>t</code>/<code>#</code>, a digit grid for a numeric attribute). Pick{' '}
            <strong>Delimiter &rarr; no delimiter</strong> and <em>every character becomes one
            cell</em>: a line of 40 characters is a 40-wide row. Quoting is off in this mode
            (a <code>&quot;</code>, a <code>,</code> and a <code>;</code> are ordinary cells)
            and whitespace is never trimmed, so a <strong>space is a real cell</strong> &mdash;
            the usual &quot;empty&quot; in ASCII art. A header row cannot exist here, so it is
            switched off. The mode is available for the <em>Grid</em> target only (one character
            per column is meaningless for agent position columns).
          </p>
          <p className={styles.p}>
            The dialog then lists every <strong>distinct character</strong> with how often it
            occurs and lets you say what value it stands for. The value is <strong>not limited
            to what fits in one character</strong> &mdash; a letter can carry a multi-digit or
            negative number (map <code>a</code> to <code>10</code>, or <code>b</code> to{' '}
            <code>-3</code>). Sensible starting points are filled in for you and every one is
            editable:
          </p>
          <ul className={styles.list}>
            <li><strong>Integer / decimal</strong> &mdash; the digits <code>0</code>&ndash;<code>9</code> stand for their own value.</li>
            <li><strong>Tag</strong> &mdash; a digit stands for that option&apos;s index (when in range), and a
              character matching the <em>first letter</em> of exactly <em>one</em> option stands for that
              option (<code>H</code>&rarr;Head, <code>t</code>&rarr;tail). Two options sharing an initial
              seed neither, so nothing is guessed.</li>
            <li><strong>Binary</strong> &mdash; the usual conventions: <code>1 # O o X x *</code> &rarr; true,{' '}
              <code>0 . - b</code> &rarr; false.</li>
          </ul>
          <p className={styles.p}>
            Any character you leave unmapped &mdash; <strong>including space</strong> &mdash; takes the
            attribute&apos;s default, and the summary line reports which characters those were and how
            many cells they covered. Short lines pad with the default and are counted too; a blank
            line in the middle of a board is kept as a row of default cells so the board&apos;s
            geometry can never silently shift.
          </p>
          <h3 className={styles.h3}>Using real map data &mdash; the workflow</h3>
          <p className={styles.p}>
            The geographic tools live behind one switch: <em>Properties &rarr; Structure &rarr;{' '}
            <strong>Geographic tools (GIS)</strong></em>. It is off for a normal model, so the
            georeference, the map backdrop and the GIS import/export items stay out of the way
            &mdash; and it turns itself <strong>on automatically</strong> the moment you import
            geographic data (a dropped <code>.asc</code> / <code>.tif</code> / <code>.geojson</code>{' '}
            always opens its dialog, gate or no gate). Turning it back off only hides those
            controls; a stored georeference or backdrop is kept.
          </p>
          <p className={styles.p}>
            A geographic model (forest fire, city growth, infection spread) is set up the same
            way the established simulators do it: the world is a <strong>stack of co-registered
            layers</strong> &mdash; one attribute per quantity &mdash; prepared <em>upstream</em>{' '}
            in a GIS and imported here. The whole pipeline:
          </p>
          <ul className={styles.list}>
            <li><strong>1. Get the data.</strong> Public sources ship ready-made layers:
              LANDFIRE (US fuel/canopy), WorldPop &amp; GPW (population), NLCD / Copernicus
              (land cover), any DEM for elevation, OpenStreetMap for rivers and roads.</li>
            <li><strong>2. QGIS (free) only if you must reproject.</strong> Cropping and
              resampling now happen <em>here</em> &mdash; a GeoTIFF import opens on a crop box
              you drag, and either format can be resampled onto the current grid &mdash; so the
              only jobs left for a GIS are <strong>reprojection</strong> (getting every layer of
              one model into the same CRS) and <strong>format conversion</strong> (a Shapefile
              into GeoJSON). GenesisCA <em>never reprojects</em>: like FARSITE, Cell2Fire and
              NetLogo it expects the layers of one model to share a projection and a grid, and
              it tells you when two of them disagree.</li>
            <li><strong>3. Import the layers.</strong> Rasters come in as{' '}
              <strong>.asc</strong> (several co-registered files in one session) or{' '}
              <strong>GeoTIFF</strong> (several bands in one file); vectors &mdash; rivers,
              roads, districts, ignition points &mdash; as <strong>GeoJSON</strong>, burned
              into attributes or turned into agents. Categorical layers land in{' '}
              <strong>tag attributes</strong> through the code&nbsp;&rarr;&nbsp;class maps in
              each dialog. The first import records the <strong>georeference</strong> on the
              model automatically &mdash; and a crop or a resample records the georeference of
              the piece you actually took, so the model still lines up with the source.</li>
            <li><strong>4. Make it look like a map.</strong> Export a rendered map of the same
              extent from QGIS and set it as the <strong>backdrop</strong> (Info panel); use
              semi-transparent Output-Mapping colours (the alpha port) so the map shows
              through, and the hover chip reads back real-world coordinates.</li>
            <li><strong>5. Simulate, then export the result</strong> as .asc or CSV &mdash;
              it drops straight back into QGIS at the same origin and cell size.</li>
          </ul>
          <p className={styles.p}>
            <strong>Two worked examples ship in the Models Library</strong> (tagged{' '}
            <em>geographic</em>), both built from open satellite data by the generator scripts in{' '}
            <code>scripts/</code>:
          </p>
          <ul className={styles.list}>
            <li><strong>Wildfire &mdash; Sierra Nevada.</strong> A 6.2 km square of the Lake Tahoe
              east shore: terrain from the <em>Copernicus DEM GLO-30</em>, fuel from{' '}
              <em>ESA WorldCover 2021</em>. A burning neighbour is weighted by the wind direction
              and by whether it lies downhill, so the fire runs up the Carson Range and stops dead
              at the lake. Per-fuel ignitability is a one-axis lookup table you can edit while it
              burns.</li>
            <li><strong>Urban Growth &mdash; Recife.</strong> The western growth frontier of
              Recife, Brazil: land use from ESA WorldCover, slope from the Copernicus DEM, and the
              major-road network from <em>OpenStreetMap</em>, rasterised with the same supercover
              walk the GeoJSON importer uses. Development spreads from the city edge, is pulled
              toward the roads and pushed off steep ground &mdash; the three classic SLEUTH
              pressures, each a live slider.</li>
          </ul>
          <p className={styles.p}>
            Both carry their layers <em>inside</em> the <code>.gcaproj</code>, so they open ready
            to run with no network &mdash; and <strong>Reset puts the landscape back</strong>.
            Imported data is not an Init Event, so a plain reseed would wipe it; both models
            therefore declare their saved board as their <em>initial state</em>
            (<em>Properties &rarr; Execution</em>), which makes Reset reseed and then apply that
            board on top. To reseed from the rules alone, hover or right-click the Reset button
            and pick <em>Reseed from rules</em>. <strong>Your own imports get this
            automatically</strong>: applying a <code>.asc</code> / GeoTIFF / GeoJSON import
            captures the resulting board as the model&apos;s initial state, so a fresh import
            survives Reset before you have saved anything.
          </p>
          <h3 className={styles.h3}>Real map data &mdash; Esri ASCII grid (.asc)</h3>
          <p className={styles.p}>
            The same dialog reads the <strong>Esri ASCII grid</strong> &mdash; the plain-text
            raster every GIS exports (in QGIS: right-click a layer &rarr;{' '}
            <em>Export &rarr; Save As&hellip;</em> &rarr; format <em>Arc/Info ASCII Grid</em>).
            It is the raster format NetLogo&apos;s GIS extension and Cell2Fire consume, so a
            terrain / land-cover / population layer clipped in a GIS drops straight into a
            GenesisCA board. Drop a <code>.asc</code> on the app (or pick it from{' '}
            <em>Import CSV / ASC&hellip;</em>) and the dialog <strong>reshapes itself</strong>:
            it reads the file&apos;s six-line header, so the delimiter and header-row controls
            disappear (the format defines both) and the <em>Grid</em> target is forced &mdash; a
            raster is a board, not a list of agents.
          </p>
          <ul className={styles.list}>
            <li>
              <strong>Several layers at once.</strong> Real models are a <em>stack</em> of
              co-registered rasters (fuel + elevation + slope&hellip;), so <strong>+ Add
              layer&hellip;</strong> takes more <code>.asc</code> files in the same session,
              each with its own target cell attribute. They must all be on the{' '}
              <strong>same grid</strong> (identical <code>ncols</code>/<code>nrows</code>) &mdash;
              a mismatched file is called out and blocks the import, exactly as every
              established tool does. Align them in your GIS first; GenesisCA never reprojects.
            </li>
            <li>
              <strong>NODATA.</strong> Cells carrying the file&apos;s <code>NODATA_value</code>
              take the attribute&apos;s default and are counted <em>separately</em> in the
              summary &mdash; &ldquo;outside the study area&rdquo; is a legitimate statement,
              not a parse failure.
            </li>
            <li>
              <strong>Categorical layers.</strong> A raster carries integer <em>codes</em>, not
              names (fuel model 102, land-cover class 42). Point the layer at a <em>tag</em>{' '}
              attribute and the code is read as the option <em>index</em>, which is exactly the
              convention the field uses.
            </li>
            <li>
              <strong>Grid size.</strong> <em>Resize the grid to the raster</em>, <em>keep the
              grid</em> (which needs an exact dimension match), or <em>resample onto the
              grid</em>. Resampling uses the same kernels the GeoTIFF importer does, so a{' '}
              <code>.asc</code> and a <code>.tif</code> over the same ground pick the same
              cells: <strong>nearest</strong> always, plus an <strong>Average</strong> box
              filter when a layer targets an <em>integer</em> or <em>decimal</em> attribute. A
              multi-layer session resamples every layer identically. There is no crop box here
              &mdash; an <code>.asc</code> is text, and in practice already the extent you cut.
            </li>
            <li>
              <strong>Georeference.</strong> The header&apos;s origin and cell size are stored on
              the model, so the matching export writes the board back <em>in the same place</em>.
              An <code>xllcenter</code>/<code>yllcenter</code> header is converted to the corner
              form on the way in; a resample scales the recorded cell size and leaves the corner
              put, since the same ground is covered by a different number of cells. Nothing in
              the engine reads it &mdash; it is presentation and file metadata only.
            </li>
          </ul>
          <h3 className={styles.h3}>Real map data &mdash; GeoTIFF (.tif)</h3>
          <p className={styles.p}>
            The sources you actually download ship <strong>GeoTIFF</strong>, not{' '}
            <code>.asc</code> &mdash; LANDFIRE fuel and terrain, WorldPop population, NLCD and
            Copernicus land cover. GenesisCA reads one directly, in the browser: drop a{' '}
            <code>.tif</code> on the app, or pick{' '}
            <em>Import GeoTIFF&hellip;</em> from the transport bar&apos;s <em>Import</em>{' '}
            menu. A GeoTIFF is always a board, so there is no Agents/Grid switch &mdash; you map{' '}
            <strong>each band</strong> to a cell attribute and import.
          </p>
          <ul className={styles.list}>
            <li>
              <strong>Bands &rarr; attributes.</strong> Every band the file carries gets a row
              with its sample type and a target attribute (or <em>ignore</em>), so a multi-band
              stack lands in several attributes in one pass &mdash; the GeoTIFF equivalent of
              the <code>.asc</code> layer stack, without needing separate files.
            </li>
            <li>
              <strong>Categorical codes.</strong> Point a band at a <em>tag</em> or{' '}
              <em>binary</em> attribute and the dialog lists its distinct values with counts and
              a dropdown each &mdash; the Cell2Fire code&rarr;fuel table, as UI. Codes that are
              already valid values are pre-filled; anything you leave unmapped takes the
              attribute default and is counted. A band with more than 64 distinct values is not
              categorical, so no table is offered.
            </li>
            <li>
              <strong>Crop.</strong> The dialog opens on a preview with a{' '}
              <strong>crop box</strong>: drag it to move, its corner to resize, or drag outside
              it to draw a new one &mdash; and the x / y / w / h fields take exact numbers. Only
              the box is read, so a source far bigger than one import can hold still opens: it
              simply starts on a centred, cap-sized window you then move to the area you want.
              A file with no overview that is too large to decode whole shows no thumbnail; set
              the crop numerically there.
            </li>
            <li>
              <strong>Grid size &amp; resampling.</strong> Either <em>resize the grid to the
              crop</em>, or <em>resample onto the grid</em> you already have.{' '}
              <strong>Nearest</strong> is the default and the ONLY method for a <em>tag</em> or{' '}
              <em>binary</em> target &mdash; averaging class codes would invent classes that do
              not exist, which is why <code>gdalwarp -r near</code> exists. For an{' '}
              <em>integer</em> or <em>decimal</em> band a per-band <strong>Average</strong>{' '}
              appears: a box filter over each destination cell, the honest choice for
              continuous data (elevation, population), with NODATA excluded from the mean.
            </li>
            <li>
              <strong>Georeference &amp; CRS.</strong> The file&apos;s origin and pixel size are
              read into the model&apos;s georeference, converted from GeoTIFF&apos;s{' '}
              <em>top-left</em> origin to the lower-left corner convention the rest of GenesisCA
              (and <code>.asc</code>) uses. A crop shifts the recorded corner to the piece you
              took, and a resample scales the recorded cell size &mdash; either way the model
              still sits exactly where the source said it does. The <code>EPSG:</code> code is recorded too, and if it
              differs from what the model already carries you are told &mdash; GenesisCA{' '}
              <em>never reprojects</em>. Align the layers in QGIS first.
            </li>
            <li>
              <strong>Size.</strong> A browser tab is not a GIS workstation, so the limits
              &mdash; 8192 on a side, 16 megapixels in total &mdash; apply to the{' '}
              <strong>crop</strong>, not to the file. Any raster opens; you choose which
              8192&nbsp;&times;&nbsp;2048-shaped piece of it to bring in. The GeoTIFF reader
              itself is downloaded only the first time you open one, so it costs nothing until
              you use it.
            </li>
          </ul>
          <h3 className={styles.h3}>Real map data &mdash; GeoJSON vectors (.geojson)</h3>
          <p className={styles.p}>
            Rasters cover the ground; <strong>vectors</strong> are the things ON it &mdash;
            lakes and exclusion zones and districts (polygons), rivers and roads (lines),
            towns and sensors and nests (points). <em>Import GeoJSON&hellip;</em> in the
            transport bar&apos;s <em>Import</em> menu reads them, and a dropped{' '}
            <code>.geojson</code> opens the same dialog. GeoJSON is plain JSON, so this needs no
            extra download at all. Export one from QGIS with{' '}
            <em>Right-click a layer &rarr; Export &rarr; Save Features As&hellip; &rarr; GeoJSON</em>.
          </p>
          <ul className={styles.list}>
            <li>
              <strong>Two things it can do.</strong> <em>Rasterise onto an attribute</em> burns
              the geometry into one cell attribute &mdash; a polygon fills every cell whose{' '}
              <em>centre</em> is inside it (holes subtract), a line takes every cell it passes
              through, a point marks its own cell. Or <em>create agents from points</em>: each
              point becomes one agent at that position, with the feature&apos;s properties
              auto-mapped to agent attributes by name, exactly like the CSV agent import. When
              the model has both layers a <strong>Target</strong> switch picks.
            </li>
            <li>
              <strong>Only the covered cells are written.</strong> This is the one place a map
              import does <em>not</em> replace the board: everything the geometry misses keeps
              its value, so you can lay a river over an existing landscape. Where features
              overlap, the last one wins.
            </li>
            <li>
              <strong>The value.</strong> <em>Fixed</em> burns one value you choose. <em>From
              property</em> lets each feature paint its OWN value &mdash; a landcover file&apos;s{' '}
              <code>class</code> straight onto a tag attribute, matched by NAME. A feature that
              simply does not carry the property takes the attribute default (it is counted, but
              not reported as an error &mdash; GeoJSON property sets are legitimately sparse); a
              property that IS there but cannot be read is listed before you import.
            </li>
            <li>
              <strong>Coordinates.</strong> With a <strong>georeference</strong> on the model
              (see below) the file&apos;s coordinates are read as <em>world</em> coordinates and
              placed through it, row flip included. Without one they are read as{' '}
              <em>grid cells</em> &mdash; x is the column, y is the row, no flip &mdash; which is
              what a hand-written test file wants. As everywhere else, GenesisCA never
              reprojects: the file must already be in the model&apos;s CRS.
            </li>
            <li>
              <strong>Line width</strong> is in cells. Width 1 is exactly the cells the line
              passes through; wider is a capsule with round ends, so it also reaches half the
              width past each endpoint. In 3D a flat vector layer writes ONE <strong>layer</strong>,
              which you pick. The preview shows the coverage on your grid before you import, so a
              file that misses the board is obvious rather than silent.
            </li>
            <li>
              <strong>A GeoJSON saved as <code>.json</code></strong> works from the menu item
              (the dialog checks what the file actually is and says so if it is not GeoJSON). A{' '}
              <code>.json</code> <em>dropped</em> on the window is still read as a GenesisCA
              project &mdash; a drop has no dialog in which to ask which you meant.
            </li>
            <li>
              <strong>Shapefiles</strong> are not read directly: convert to GeoJSON in QGIS
              first, which is the same &ldquo;prepare upstream&rdquo; rule the raster importers
              follow.
            </li>
          </ul>
          <h3 className={styles.h3}>Georeference &amp; the backdrop map</h3>
          <p className={styles.p}>
            Two presentation pieces turn a board into something that reads as a{' '}
            <em>map</em>. Neither is ever read by a rule &mdash; they are metadata and
            decoration, in the same spirit as the C8 &ldquo;presentational geometry&rdquo;
            doctrine.
          </p>
          <ul className={styles.list}>
            <li>
              <strong>Georeference</strong> (<em>Properties &rarr; Structure</em>) &mdash; where
              cell (0,0) sits in the real world: an <strong>X / Y origin</strong> and a{' '}
              <strong>cell size</strong>, plus an optional <strong>CRS</strong> string. An{' '}
              <code>.asc</code> import fills it from the file&apos;s own header and the{' '}
              <code>.asc</code> export writes it back, but you can also type it in for a board
              that arrived some other way. The convention is Esri&apos;s: the origin is the{' '}
              <em>lower-left corner</em> of the lower-left cell and Y grows <em>upward</em>,
              while grid row 0 is the <em>top</em> row. With one set, the simulator&apos;s
              hovered-cell readout gains a second line &mdash; the world coordinates of that
              cell&apos;s centre. <strong>Clear</strong> drops it; exports then fall back to the
              neutral origin 0,0 / cell size 1. GenesisCA never reprojects: align upstream in a
              GIS, exactly as every established tool expects.
            </li>
            <li>
              <strong>Backdrop map</strong> (<em>Info panel</em>) &mdash; a still image (PNG /
              JPEG / GIF / WebP, up to 4&nbsp;MB) drawn <em>under</em> the cells in the 2D
              simulator, stretched to the whole world rect so it lines up with the grid by
              construction (and tiled with it in infinity mode). This is SLEUTH&apos;s hillshade
              layer / QGIS&apos;s basemap: export a rendered map of the same extent from your
              GIS and drop it in. It travels inside the <code>.gcaproj</code>.
            </li>
            <li>
              <strong>Make the map visible.</strong> Where a cell is painted <em>fully opaque</em>
              the backdrop is hidden &mdash; which is correct, and the reason a map model gives
              its Output-Mapping colours some <em>alpha</em> (every colour node carries an{' '}
              <code>a</code> channel) or hides the CA Grid layer. Cells with alpha below 255
              blend over the map.
            </li>
            <li>
              <strong>Show + opacity</strong> live in the simulator&apos;s <em>Settings</em> panel
              (a <strong>Backdrop</strong> section, shown only when the model actually has one
              and only in 2D &mdash; the 3D view has its own background). They are per-user view
              settings, remembered across models, never written into the model. Both capture
              areas &mdash; <em>current view</em> and <em>simulation</em> &mdash; include the
              backdrop, so screenshots and recordings show the map too.
            </li>
          </ul>
          <h3 className={styles.h3}>Export CSV</h3>
          <p className={styles.p}>
            <strong>Export CSV&hellip;</strong> is the exact mirror of the import, and sits on
            the transport bar&apos;s <strong>Export</strong> button &mdash; hover it (or
            right-click it) and pick <em>Export CSV / ASC&hellip;</em>; a plain click still exports a{' '}
            <code>.gcastate</code>. It takes the running simulation out as a table for a
            spreadsheet, a plotting script or another tool. The same{' '}
            <strong>Target</strong> switch appears when the model has both layers; a model
            with only one layer simply exports that one. The values are read fresh from the
            engine at the moment you press the button, so what you get is what is on screen
            &mdash; including on a GPU-resident model that is not otherwise reporting its
            state back.
          </p>
          <ul className={styles.list}>
            <li>
              <strong>Agents</strong> &mdash; one row per live agent, with a header row:{' '}
              <code>x, y</code> (plus <code>z</code> in 3D), <code>vx, vy</code> (plus{' '}
              <code>vz</code>), <code>radius</code>, then every agent attribute by name (a{' '}
              <em>vector</em> attribute writes one column per component, <code>Facing.x</code>{' '}
              / <code>Facing.y</code>).
            </li>
            <li>
              <strong>Grid</strong> &mdash; ONE chosen cell attribute as a plain table, using
              the same convention the import reads: a <strong>line is a grid row</strong>, a{' '}
              <strong>field is a grid column</strong>, and no header row. In a 3D model you
              pick the <strong>Layer</strong> to write.
            </li>
            <li>
              <strong>Grid &rarr; Esri ASCII grid (.asc).</strong> The <strong>Format</strong>{' '}
              choice writes the board as the GIS raster instead: the six-line header (from the
              model&apos;s stored georeference, or the neutral origin 0,0 / cell size 1 when it
              has none) then whitespace-separated rows. Values are plain <em>numbers</em> &mdash;
              a tag writes its option <em>index</em> and a binary <code>0</code>/<code>1</code>,
              because <code>.asc</code> is a numeric raster and integer codes are how the field
              encodes classes. A non-finite value is written as the <code>NODATA</code> sentinel{' '}
              <code>-9999</code>. The delimiter choice is hidden here &mdash; the format defines
              it. Drop the file straight into QGIS.
            </li>
          </ul>
          <p className={styles.p}>
            Values are written in the form the import reads straight back: a tag as its option{' '}
            <em>name</em>, binary as <code>true</code>/<code>false</code>, numbers at full
            precision (so a position never loses a digit on the way out and back). Names
            containing a comma or a quote are quoted properly. Pick the{' '}
            <strong>delimiter</strong> (comma / semicolon / tab &mdash; tab saves a{' '}
            <code>.tsv</code>). The panel previews the first lines before you commit.
          </p>
          <p className={styles.p}>
            <strong>The round trip is the point:</strong> an exported file re-imports through{' '}
            <em>Import CSV</em> with its columns already mapped and every value intact &mdash;
            so you can export a population, edit it in a spreadsheet, and load it back. The same
            holds for <code>.asc</code>: import a raster, export it again, and the header and
            every value come back unchanged.
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
            mouse cursor), so the outline stays visible over any cell palette. Just outside its
            <strong> top-left corner</strong> sits a small <strong>icon of the active brush</strong>
            &mdash; the footprint shape for the CA-grid brush, the armed action for the agent brush
            &mdash; the same glyph as the button that armed it, on a dark chip so it reads over any
            palette. Toggle both with <strong>Show brush cursor</strong> in the brush panel.
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
          <p className={styles.p}>
            <strong>In 3D it works the same way, anchored on the brush plane.</strong> The
            cell under the <em>brush-plane cursor</em> is the anchor (so the brush plane
            has to be enabled and the cursor over a cell &mdash; otherwise the shortcut
            does nothing and says so), and what gets copied is exactly what the brush
            would paint there: a flat footprint on the plane, or the full solid when{' '}
            <strong>Volumetric Brush</strong> is on &mdash; a sphere, a spherical shell or
            a box. A copy tells you what it grabbed (<em>Copied 179 cells (7&times;7&times;7
            box)</em>), because unlike 2D a copied volume is invisible on screen. The
            region is remembered in <strong>absolute grid axes</strong> (layer / row /
            column), so changing the plane axis before pasting moves <em>where</em> it
            lands, never how it is oriented. Cells that fall outside the grid are read as
            the attribute default and clipped on paste, on every axis.
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
            <li><strong>Where the capture controls live</strong> &mdash; screenshot and recording are <em>output</em>, so they sit in their own cluster at the <strong>bottom-right of the canvas, directly beneath the stats readout</strong> &mdash; not on the transport bar, which is about simulation <em>time</em> (play / pause / step / reset / speed). The cluster is <code>&#128247;</code> (screenshot) &middot; <code>&#9210;</code> (record) &middot; a <strong>settings chip</strong> reading <code>format &middot; area &middot; quality</code> (e.g. <code>WebM &middot; sim &middot; Std</code>, with a trailing <code>&middot; +rings</code> / <code>&middot; +cursor</code> when the cursor overlays are being captured, and the <strong>resolution</strong> whenever it is not Auto). Hover or click the chip to open the capture settings; the rows above the dividing rule (<strong>capture area</strong>, <strong>cursor &amp; highlights</strong>) apply to screenshots <em>and</em> recordings, the ones below it are recording-only. Every choice there is a two-state switch. The popover itself is kept to labels and controls &mdash; <strong>hover a row for what the setting is, or an individual option for what that choice does</strong> &mdash; and a setting that does not apply is <em>greyed in place</em> rather than disappearing, with the reason as that row&rsquo;s tooltip (GIF has no quality / overload options; a 3D scene fills the frame so it has no separate area).</li>
            <li><strong>Capture area</strong> &mdash; the first row of the chip&apos;s popover, and the <em>one</em> setting that governs <strong>both screenshots and recordings</strong>: <strong>simulation</strong> (the whole grid / world framed to fit, independent of your zoom / pan) or <strong>current view</strong> (the display canvas exactly as shown, with your zoom / pan and any margins). Change it once and both capture buttons follow. In 3D the scene fills the frame, so the choice is greyed out with the reason. (It used to be two separate rows &mdash; one for screenshots, one for recordings &mdash; which asked the same question twice and let the two silently disagree.)</li>
            <li><strong>Review before saving</strong> &mdash; a screenshot or a finished recording is <em>shown to you first</em>: a dialog opens with the actual picture (or the clip, playing on a loop), its size in pixels, the file size, and for a recording the frame count and length. <strong>Nothing has been written yet</strong> at that point &mdash; <strong>Save&hellip;</strong> then opens the usual file dialog (a real OS <em>Save As</em> in the desktop build), <strong>Copy to clipboard</strong> is offered for a screenshot (a video cannot go on the clipboard as an image, so recordings do not show it), and <strong>Cancel</strong> or <kbd>Esc</kbd> throws the capture away. If you cancel the <em>file</em> dialog, you come straight back to the review with the capture still in hand &mdash; nothing is lost. Discarding a recording <em>is</em> final, though: the frames are gone by then, which is why the dialog says so. The <strong>simulation pauses</strong> for this &mdash; the world would otherwise keep moving behind a picture you are judging, and a native <em>Save As</em> can sit open for a while. For a <strong>recording</strong> the pause starts the moment you press <strong>stop</strong>, not when the dialog appears: encoding a clip is real work (a long GIF takes seconds), and running the world through it would only carry it past the clip you just captured. It <strong>resumes on its own</strong> when you close the dialog, so a capture never costs you your run &mdash; and if it was already paused when you captured, it stays paused.</li>
            <li><strong>Screenshot</strong> &mdash; <code>&#128247;</code> takes a PNG of the current frame in the capture area above and opens the review dialog for it. <strong>Hover the camera button, or right-click it</strong>, for the two dispositions: <strong>Save&hellip;</strong> (identical to just clicking it &mdash; review, then a file) and <strong>Copy</strong>, the deliberate one-step shortcut that skips the review entirely and puts the same PNG straight on the <strong>clipboard</strong> so you can paste it into a document, a chat or an image editor without going through the file system. Both take exactly the same picture. If the browser refuses the clipboard write &mdash; it needs a secure context and the window to be focused, and some embedded webviews block it outright &mdash; you get a toast saying so rather than a silent no-op; use Save in that case. A PNG <strong>keeps transparency</strong> &mdash; an agents-only model with no background colour saves with a see-through backdrop, so you can drop it straight onto any page or slide. <strong>Recordings</strong> are the opposite: video has no transparency, so each frame is composited onto black as it is captured &mdash; which is also what makes a soft <strong>Glow</strong> halo record with the same gentle falloff you see on screen instead of a hard, over-saturated blob.</li>
            <li><strong>Record</strong> &mdash; Click the red record button in the capture cluster, play the simulation, then click stop; the clip is encoded and shown in the review dialog above, where you Save it (or discard it). The <strong>capture area</strong> above applies (the same one screenshots use); the popover&apos;s recording-only rows below the rule choose the <strong>format</strong> &mdash; <strong>WebM</strong> (smaller files, no 256-colour limit; needs a browser with WebCodecs &mdash; recent Chrome / Edge / Firefox) or <strong>GIF</strong> (256 colours, 512&nbsp;px by default &mdash; see <strong>Resolution</strong>). Both areas work for every model type and compile target (2D grid, grid&nbsp;+&nbsp;agents, agents-only, 3D). <em>Note:</em> the simulation scope re-draws the whole grid from the engine each frame, so on a WebGPU model it asks the engine for the cell colours for the duration of the run &mdash; expect a somewhat lower frame rate than the current-view scope, which reads the already-rendered display. <em>Note:</em> the simulation scope draws agents as circles + bonds + <strong>sprites</strong> (and the glow halo when Glow is on), all from the same code the display uses &mdash; so sizes, frames, facing and alpha match what you see. <strong>Metaballs</strong> are the one exception (the fused blob is a screen-space filter over the whole display surface, not a per-agent draw): use the current-view scope for a WYSIWYG capture of those.</li>
            <li><strong>Long recordings</strong> &mdash; a <strong>WebM</strong> recording is encoded <em>as you record</em>, so only the compressed video accumulates rather than every raw frame: recordings can run many times longer before memory runs out, and Stop is a quick save instead of a long encode. Two consequences worth knowing. First, on a dense, fast-changing model the encoder is the slow part &mdash; the simulation will run slower while recording, and if it still cannot keep up the recorder <em>skips</em> frames rather than piling them up (see <strong>On overload</strong> below); any skipped frames are shown next to the REC counter (<code>REC 1200f &middot; 37 dropped</code>). Second, and most importantly, <strong>a WebM recording plays back in real time</strong>: every frame is stamped with the moment it was captured, so a 30-second recording is a 30-second video no matter how many frames the encoder managed. If it could only manage a few frames a second, you get a real-time video at a few frames a second &mdash; choppy, but the right length and the right speed. (Before this, files were timed at the FPS <em>setting</em> rather than the rate actually achieved, so a heavy model&apos;s 10-second recording came out as a &frac34;-second blur playing 13&times; too fast.) <strong>GIF</strong> keeps every frame in memory (its palette needs the raw pixels) and is limited to 256 colours &mdash; it remains a short-clip format; use WebM for anything long.</li>
            <li><strong>How a GIF is made smaller</strong> &mdash; a GIF recording is not simply every frame written out whole. First, a run of <strong>identical frames is written once</strong> with the delays added together: a paused, stalled or slowly-changing stretch collapses to a single frame (a 40-frame recording of a motionless board came out <strong>38&times;</strong> smaller). Second, where it helps, only the pixels that actually <strong>changed</strong> are written and the rest are marked &ldquo;keep what is already on screen&rdquo;; on a settled Game of Life at 300&times;300 that was <strong>1.3&times;</strong> smaller, and on a sparse board (about 1&nbsp;% of cells changing) <strong>6.9&times;</strong>. This is decided <em>per frame by measuring both ways and keeping the smaller</em> &mdash; when changes are scattered right across the frame the &ldquo;changed pixels only&rdquo; form is actually bigger, so it is not used, and such recordings come out the same size as before rather than worse. The picture is identical either way: this only changes how the frames are stored, never what they look like.</li>
            <li><strong>What happens when you press stop</strong> &mdash; a <strong>WebM</strong> recording was encoded as you went, so stopping is a quick flush. A <strong>GIF</strong> is encoded at that moment, all at once, and on a long recording that genuinely takes seconds &mdash; so a <strong>progress bar</strong> appears at the top of the window reading <code>Encoding GIF&hellip;</code> with the frame count (<code>74 / 160 frames</code>) and fills as it goes. The app stays responsive throughout; when the bar disappears the file is saved. The same bar is used for every other operation that can take a moment &mdash; resizing to a large grid, recompiling, loading a model, restoring a saved state, <strong>loading a preset that carries a board</strong> (on a large grid or a big population that restore is real work, and the bar stays up until the board has actually landed, even while the simulation is playing), importing an image or a CSV &mdash; so you always know what it is doing and that it has not frozen. Anything that finishes quickly never shows a bar at all &mdash; a <em>parameter-only</em> preset applies instantly, so it shows nothing.</li>
            <li><strong>Recording quality</strong> (WebM only) &mdash; <strong>Standard</strong> (the default) writes a keyframe every 30 frames: measured <strong>~6&times; smaller files and ~3&times; faster encoding</strong> on dense content, which also means the simulation runs closer to full speed while recording. The trade is that a player has to decode from the last keyframe, so scrubbing lands on 30-frame boundaries. <strong>Archival</strong> makes every frame a keyframe: each frame is independently decodable (ideal for frame-by-frame analysis and scrub-exact playback) and nothing from interframe prediction can bleed across previously-stable regions &mdash; at roughly 6&times; the file size and 3&times; the encoding time. A skipped frame is safe in <em>both</em> modes: frames are skipped before they reach the encoder, so the video simply pauses on the previous frame for that moment &mdash; it is never corrupted, and never sped up.</li>
            <li><strong>On overload</strong> (WebM only) &mdash; what gives when the encoder cannot keep up. <strong>Skip frames</strong> (the default) keeps the simulation at full speed and leaves the frames it could not encode out of the video &mdash; the video still runs the right length, it just holds on a frame where one was skipped, so heavy models come out choppy but real time. <strong>Never skip</strong> encodes every captured frame and instead holds the <em>simulation</em> back until the encoder catches up &mdash; the run gets slower (measured ~5&times; on a dense model) but the motion in the video is continuous. While it is waiting, the stats overlay says <code>&#9203; waiting for encoder</code>, so a deliberately slowed run is never mistaken for a freeze; if the encoder ever stalls outright the recording falls back to skipping and tells you. Format, area, quality and this setting are all <strong>fixed at the moment you press Record</strong> &mdash; while a recording runs, the chip greys out and keeps showing the configuration in force, and the record button becomes <code>&#9209; 128</code> (frames captured, plus any skipped and <code>&#9203;</code> while the simulation is being held back).</li>
            <li><strong>Cursor &amp; highlights</strong> &mdash; by default a capture contains only the simulation: the brush cursor and the coloured highlight rings live on overlay layers <em>above</em> the scene, so neither a screenshot nor a recording picks them up. Set this to <strong>Highlights</strong> to include the coloured rings (the hovered cell / agent, the Edit target, everything the area brush is about to affect, pinned inspect rings, a staged Glue&nbsp;/&nbsp;Cut anchor) or to <strong>All</strong> to include those <em>plus</em> the negative brush-cursor silhouette &mdash; which is what you want when recording a tutorial, where the viewer needs to see where you are pointing and what you are about to change. It applies to <strong>screenshots and recordings alike</strong>, but only in the <strong>current view</strong> area: the cursor is positioned by your live zoom / pan, so it has no meaningful place in the simulation framing &mdash; with the capture area set to Simulation the row greys out and says so. In 3D the brush outline, hovered cells and inspect rings are drawn <em>into</em> the scene, so every 3D capture already includes them and the row is greyed out there too. When it is on, the settings chip says so (<code>&middot; +rings</code> or <code>&middot; +cursor</code>).</li>
            <li><strong>Resolution</strong> &mdash; the long edge of a recorded frame, chosen in the capture popover. <strong>Auto</strong> keeps the defaults: 912&nbsp;px in 2D, 1280&nbsp;px in 3D, and 512&nbsp;px for a GIF. <strong>480 / 720 / 1080</strong> cap it explicitly, and <strong>Native</strong> means no rescaling at all &mdash; the view at its own pixel size, or, in the simulation area, <em>the grid at one pixel per cell</em>, which is how you get a pixel-exact recording of a small board (a 300&times;300 model records as a 300&times;300 file). Native is capped at 2048&nbsp;px so a HiDPI display or a huge grid cannot ask for an enormous frame, and a GIF is capped at 1024&nbsp;px whatever you pick, because it holds every frame in memory until you stop. <strong>Screenshots are not affected</strong> &mdash; they always keep the full display resolution. A WebM width may be lowered by a few pixels (480 records as 464, 1080 as 1072): that lands it on a size where the encoder can use full-resolution colour (4:4:4) instead of the subsampled mode, and the height follows the same scale so the aspect ratio is exact. The chip shows the choice whenever it is not Auto.</li>
            <li><strong>Show Code</strong> &mdash; a complete, self-describing <strong>reference document for your model</strong>, in three parts. <strong>1. Model definition</strong>: everything the rule runs <em>on</em> but does not contain &mdash; grid geometry and the flat index convention, one typed array per attribute with its default and boundary value, the neighbourhood offset lists, your model-attribute values, <em>the full contents of every lookup table</em>, the indicator slot order, stop events and end conditions, and (for agent models) the resolved physics: max bonds, the clamped time step, which forces are on and with what constants. <strong>2. Driver skeleton</strong>: the exact call order and buffer discipline the engine performs around your rule &mdash; how the neighbour tables are built, the synchronous double-buffer swap or the asynchronous visit-order shuffle, when the colour pass and indicators run, and for agents the whole per-generation phase order with the force formulas written out. Only the branches <em>your</em> model takes are shown. <strong>3. The compiled functions</strong> themselves, each with a table naming every argument. Together these are enough to <strong>reimplement the model in another language or engine</strong> &mdash; copy the whole thing as a starting point. It is always the <strong>JS reference source</strong>, whatever engine you run (see Compile Targets), and the header names the engine actually running. <strong>Copy</strong> puts the whole document on the clipboard.</li>
          </ul>

          <h3 className={styles.h3}>Export &amp; Import State</h3>
          <p className={styles.p}>
            The transport bar includes <strong>Export</strong> (floppy disk icon) and{' '}
            <strong>Import</strong> (folder icon) buttons at its left side &mdash; the
            simulation&rsquo;s OUT / IN pair. (&ldquo;Save/Load&rdquo; is reserved for the
            <em> project</em> under the <strong>File</strong> menu.) A plain click does the
            <code> .gcastate</code> action below; <strong>hovering</strong> a button (or
            right-clicking it) opens a small menu offering that same action plus its
            siblings &mdash; under <strong>Export</strong>: <em>Export CSV / ASC&hellip;</em>{' '}
            and <em>Export preset (.gcapreset)&hellip;</em>; under <strong>Import</strong>:{' '}
            <em>Import CSV / ASC&hellip;</em> and <em>Import preset (.gcapreset)&hellip;</em>{' '}
            (see &ldquo;Import CSV&rdquo; above and &ldquo;Model Presets&rdquo; below).
          </p>
          <ul className={styles.list}>
            <li><strong>Export state</strong> &mdash; Downloads a <code>.gcastate</code> file
              capturing the full simulation snapshot: current generation, all cell
              attribute values, model attribute values, colors, indicator state, and
              simulator settings (viewer, brush, FPS, gens/frame).</li>
            <li><strong>Import state</strong> &mdash; Opens a <code>.gcastate</code> file and
              restores the simulation to that exact point. The grid dimensions in the
              state file must match the current grid &mdash; resize first if needed.</li>
          </ul>
          <p className={styles.p}>
            This enables experiment repeatability: save a specific configuration, run the
            simulation, then reload the same starting point to try different parameters.
            Saving state also embeds it in the model, so the next <code>.gcaproj</code>{' '}
            save will include the simulation snapshot.
          </p>

          <h3 className={styles.h3}>Share as a standalone simulation</h3>
          <p className={styles.p}>
            <strong>File &rarr; Export standalone simulation&hellip;</strong> bundles the Simulator and
            one model into a <strong>single self-contained <code>.html</code> file</strong>.
            Anyone can open it in a browser &mdash; no install, no server, and it works offline
            straight from a downloaded file. It is the modern replacement for the old Genesis
            standalone <code>.exe</code> export.
          </p>
          <ul className={styles.list}>
            <li><strong>Everything travels in one file</strong> &mdash; the model graph,
              attributes, neighborhoods, mappings, sprites, thumbnail, and (optionally) the
              current board and the model&rsquo;s presets are all embedded. No sidecar folder.</li>
            <li><strong>Options</strong> &mdash; choose whether to include the current board
              state, the simulator controls, and the <strong>model presets</strong> (like Save
              Project). Large grids default to board-state-off to keep the file small; presets
              default on when the model has any, and the row is hidden when it has none. Leave
              presets off for a presentation of one fixed configuration &mdash; note that the
              recovered <code>.gcaproj</code> then carries none either.</li>
            <li><strong>Model info is shown</strong> &mdash; the standalone page has an
              <strong>ⓘ About</strong> panel displaying the name, rule author, project author,
              summary, rule description, tags, and thumbnail.</li>
            <li><strong>It stays editable</strong> &mdash; the exported <code>.html</code> also
              carries the full model, so you never lose the logic: click <strong>Download model
              (.gcaproj)</strong> in the About panel, or simply <strong>Load</strong> the
              <code>.html</code> back into GenesisCA to recover and edit it.</li>
          </ul>

          <h3 className={styles.h3}>Model Presets</h3>
          <p className={styles.p}>
            The left panel includes a <strong>Presets</strong> section (right above Model
            Attributes) for embedding named snapshots of model-attribute values in the
            project. This is useful for generic models whose emergent behavior depends
            heavily on parameter choices &mdash; e.g. an MNCA-style model can ship several
            "interesting" threshold sets as one-click configurations.
          </p>
          <p className={styles.p}>
            Three icon buttons sit to the right of the <strong>Presets</strong> title:{' '}
            <strong>add</strong> (<code>+</code>), <strong>import</strong>, and{' '}
            <strong>export</strong>. The same import/export are also on the transport
            bar&rsquo;s <strong>Import</strong> / <strong>Export</strong> menus.
          </p>
          <ul className={styles.list}>
            <li><strong>Add</strong> (<code>+</code>) &mdash; Captures the current
              model-attribute values as a new preset. Optionally embeds the
              <strong> board</strong> too (check "Include board state" in the dialog)
              &mdash; that means the cell grid <em> and </em>, on an agent model, the whole
              agent population: positions (including Z in 3D), velocities, agent attributes,
              bonds and bond attributes, and sprite state. On an agents-only model the board
              <em> is</em> the population. UI controls (brush, viewer, FPS) are <em> never </em>
              part of a preset.</li>
            <li><strong>Load</strong> &mdash; Restores the preset's model-attribute values
              (and the board, if included). Preset rows marked with <code>&#x25C9;</code>
              carry board data. If a board-carrying preset's dimensions don't match the
              current grid, you'll see a dimension-mismatch error &mdash; resize first.
              A <em>parameter-only</em> preset never touches the board: load one mid-run and
              the simulation keeps going with the new parameters applied live. Note that a
              board-carrying preset saved before GenesisCA captured agent populations holds
              no agents, so loading it re-seeds the agent layer from the model&rsquo;s Init
              Event &mdash; re-save it to capture the current population.</li>
            <li><strong>Export current as preset</strong> (title-bar export icon, or the
              transport bar&rsquo;s <em>Export &rarr; Export preset&hellip;</em>) &mdash;
              Downloads the <em>current</em> state straight to a <code>.gcapreset</code> file{' '}
              <em>without</em> adding it to the model&rsquo;s presets &mdash; the &ldquo;just
              save a file locally&rdquo; shortcut. (Each existing preset row&rsquo;s{' '}
              <strong>&hellip;</strong> menu also has an <strong>Export</strong> that downloads
              that saved preset.)</li>
            <li><strong>Import preset</strong> (title-bar import icon, or the transport
              bar&rsquo;s <em>Import &rarr; Import preset&hellip;</em>) &mdash; Loads a{' '}
              <code>.gcapreset</code> and appends it to this model&apos;s presets (with a fresh
              id). The embedded state travels verbatim &mdash; a grid-carrying preset behaves
              exactly as it did in the exporting project. NB a preset only makes sense on a
              model with matching attributes; loading one from an unrelated model applies
              whatever attribute ids happen to match. (You can also drag a <code>.gcapreset</code>{' '}
              file onto the app.)</li>
            <li><strong>Delete</strong> (&times;) &mdash; Removes the preset from the model
              (from the preset row&rsquo;s <strong>&hellip;</strong> menu).</li>
            <li><strong>Reorder</strong> &mdash; Drag the <code>&#x22EE;&#x22EE;</code> handle
              to reorder presets; the order is saved with the project.</li>
          </ul>
          <p className={styles.p}>
            Presets are stored inside the <code>.gcaproj</code> file. The Save Project
            dialog exposes an <strong>Include model presets</strong> checkbox &mdash; checked
            by default whenever the loaded model already has presets &mdash; so you can omit
            them from a given save if needed.
          </p>

          <h3 className={styles.h3}>Drag &amp; Drop</h3>
          <p className={styles.p}>
            You can <strong>drop files anywhere on the GenesisCA window</strong>:
            a <code>.gcaproj</code> (or an exported standalone <code>.html</code>) prompts to
            load the project (with the usual unsaved-changes confirmation);
            a <code>.gcastate</code> asks to replace the current simulation state;
            a <code>.gcapreset</code> is added to the model&apos;s presets;
            a <code>.gcamacro</code> is imported into the node graph (switching to the
            Modeler if you were on another tab, and opening the same import-resolution
            dialog the canvas&apos; <em>Import Macro&hellip;</em> menu item does when the
            file carries references); and an
            <strong> image</strong> (PNG/JPEG/BMP/WebP) opens the <strong>Map Image to
            Cells</strong> dialog, just like pasting one with Ctrl+V.
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

          <h3 className={styles.h3}>Global</h3>
          <table className={styles.table}>
            <thead><tr><th>Shortcut</th><th>Action</th></tr></thead>
            <tbody>
              <tr><td><kbd className={styles.kbd}>Ctrl</kbd>+<kbd className={styles.kbd}>S</kbd> (<kbd className={styles.kbd}>&#8984;</kbd>+<kbd className={styles.kbd}>S</kbd>)</td><td>Save project &mdash; opens the same Save dialog as <strong>File &#9662; &rarr; Save</strong>. Works from anywhere, including while typing in a field; the browser&rsquo;s own &ldquo;save page&rdquo; dialog is always suppressed. Does nothing extra if a File dialog is already open.</td></tr>
              <tr><td><kbd className={styles.kbd}>?</kbd></td><td>Show / hide the keyboard-shortcuts cheat sheet (not while typing in a field)</td></tr>
            </tbody>
          </table>

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
              <tr><td><kbd className={styles.kbd}>Ctrl</kbd>+<kbd className={styles.kbd}>C</kbd></td><td>Copy the cell attributes in the brush footprint (follows the brush shape). In 3D the anchor is the <strong>brush-plane cursor</strong> and a volumetric brush copies its whole solid</td></tr>
              <tr><td><kbd className={styles.kbd}>Ctrl</kbd>+<kbd className={styles.kbd}>V</kbd></td><td>Paste the clipboard shape, centred on the cursor (only the shape's cells; in 3D on the brush-plane cursor)</td></tr>
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
            <li><strong>simulationState</strong> (optional) &mdash; Embedded simulation snapshot. Clicking <strong>Save</strong> opens a small dialog with a last chance to correct the model&rsquo;s presentation fields &mdash; <em>Name</em>, <em>Rule Author</em> and <em>GenesisCA Project Author</em>, prefilled from the model and identical to the ones in the Modeler&rsquo;s Info panel. Anything you change there is <strong>written back to the model</strong>, not just into the file being written, and the default filename follows the edited name. A model must have a name, so Save stays disabled while that field is empty. Below the fields are the include-what checkboxes:
              <ul>
                <li><em>Include simulator controls</em> &mdash; playback speed, brush size/color, selected input/output mapping, runtime model-attribute values.</li>
                <li><em>Include board state</em> &mdash; full board snapshot: cell attributes, colors, and the agent population. (A saved board is a <em>starting configuration</em>, so the generation counter and indicator values are deliberately <strong>not</strong> stored &mdash; a loaded board always begins at generation 0.)</li>
                <li><em>Include model presets</em> &mdash; the saved parameter (and optional board) snapshots; checked by default whenever the model already has presets.</li>
              </ul>
              These two default to reflect the loaded model instead of following a program-wide last choice: when a model already carries an embedded snapshot they mirror it, and a fresh model (no embedded snapshot) defaults both on so evolving a board or tuning attributes and then saving still captures that work. Unchecking both still saves a valid <code>.gcaproj</code> &mdash; it just contains only the model definition.
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

          <h3 className={styles.h3}>Browsing the Models Library</h3>
          <p className={styles.p}>
            The <strong>Library</strong> tab has a toolbar for finding models:
            a <strong>search</strong> box (matches name, description, authors and tags), a
            <strong> category</strong> dropdown (every tag, with usage counts &mdash; clicking a
            tag chip on a card filters by it too), an <strong>All / 2D / 3D</strong> dimension
            filter, <strong>CA Grid / Agents</strong> topology filters (independent
            <em> toggles</em>, since a model can run both layers at once &mdash; each one
            requires that layer, and both together find the models that couple a grid with
            agents), a <strong>sort</strong> order (name, newest / oldest by each model&apos;s
            authored <strong>creation date</strong>, or largest grid &mdash; models with no
            creation date carry no date stamp and sort last either way), and a
            <strong> Group by category</strong> view
            that sections the cards by each model's primary tag. Your choices persist across
            sessions. Cards are uniform-sized and always show <strong>all of a model's
            tags</strong> (the tag rows wrap; the clipped description yields the space, since
            hovering reveals it anyway). Hovering opens a <strong>preview panel centered right
            on the card</strong>: the title + full description on the left (when too long for
            the panel it <strong>slowly auto-scrolls</strong>, holds, and loops) and the model's
            thumbnail on the right, side by side (an animated GIF/WebP or a WebM clip plays),
            with the model&apos;s <strong>tags along the bottom</strong> &mdash; clicks pass straight
            through the panel, so the card underneath stays clickable, and those tag chips are the
            one exception: they take the click and filter by that tag, exactly like the chips on the
            card the panel is covering. A model's mode shows as a coloured <strong>badge</strong> &mdash;
            <strong> 3D</strong> (amber) and <strong>Agents</strong> (green) &mdash; and each badge
            behaves like a tag: click it to filter, and it also appears in the category dropdown
            and as a grouping section (2D and CA-Grid, the defaults, stay unbadged). 3D models
            show their grid as W&times;H&times;D.
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
