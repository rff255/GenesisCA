# INVESTIGATION — Social networks: how SNA defines/stores graphs, and how GenesisCA could

**Status: research / brainstorm only — no code, no decisions.** (2026-09-05)

The brainstorm this answers, verbatim:

> (brainstorm) Investigate options and best practices/common usage of social network
> analysis ways to define the graphs and edge attributes. How is it commonly
> defined/stored? so that we can investigate how can GenesisCA also provide that, so
> we can model and simulate social network models on GenesisCA without having to
> manually define things.

**The one-line answer.** GenesisCA already *is* a graph-rewriting engine — agents are
nodes, bonds are edges, bond attributes are edge attributes, and `Rewire Bond` is a
primitive most SNA toolkits do not have. What is missing is not the simulation tier: it
is **the file seam** (nothing in the app can create a bond from data — verified), a
**generator** for the four canonical random-graph families, a handful of **measurements**,
and one **structural ceiling** (`maxBonds`) that a scale-free graph walks straight into.

> Companion: [INVESTIGATION_SOCIAL_NETWORKS.html](INVESTIGATION_SOCIAL_NETWORKS.html) —
> format comparison, the file → agents + bonds mapping diagram, the directed-edge idiom,
> and the model→capability coverage matrix.
>
> Closest precedents: [INVESTIGATION_GEOSPATIAL_IO.md](INVESTIGATION_GEOSPATIAL_IO.md)
> (an I/O-format survey that led to shipped importers — the same shape as this) and
> [INVESTIGATION_GRAPH_CA.md](INVESTIGATION_GRAPH_CA.md) (the *lattice*-side graph mode,
> which reached the opposite conclusion for a different substrate; §3.6 below reconciles
> them).

---

## 0. Honesty notes

Written across two sessions. The first had no web access and wrote the format sketches
from memory; the second (2026-09-05) verified the flagged facts against the current sources.
What is now **confirmed** vs still **from memory**:

- **NetworkX node-link JSON — CONFIRMED, and the caveat in §1.7 was right.** The `link`
  keyword was deprecated in NetworkX **3.4** in favour of `edges`, the deprecation expired in
  **3.6**, and the *default serialization key* flipped from `"links"` to `"edges"` in 3.6.
  Files written by every NetworkX before 3.6 say `links`; files from 3.6 onward say `edges`.
  **An importer must accept both keys** — now a verified requirement, not a hedge.
- **§1.10 dataset table — PARTLY confirmed.** Zachary karate club max degree **17** and the
  SNAP ego-Facebook max degree **1 045** are confirmed. **ca-GrQc is contested**: sources
  quote max degree **81** *and* **162** (SNAP's own page does not state it — the discrepancy
  is almost certainly the raw file's duplicated reciprocal rows vs the deduplicated
  undirected graph); the table keeps 81 and flags it. Les Misérables (36), Dolphins (12),
  Football (12) remain unverified from-memory values. The *argument* the table supports —
  max ≫ mean, widening with size — does not depend on any single figure.
- **UCINET DL keyword casing** in §1.6 is still from memory (UCINET is case-insensitive, so
  the casing cannot make a parser wrong, only a sketch look odd).
- **All measured numbers in §3.4 and §3.1** were produced by Node scratch scripts against
  the real data shape (see §3.4's preamble); they are not estimates.
- **Codebase claims** were verified firsthand (two parallel source surveys + direct reads).
  The load-bearing ones are called out inline as **[verified]**.

## 1. How SNA practitioners define and store graphs today

### 1.1 The two-table convention — the thing everything else is a dialect of

Under every format below sits the same idea: **a node table and an edge table**.

```
nodes.csv                          edges.csv
Id,Label,Group                     Source,Target,Type,Weight
1,Alice,A                          1,2,Undirected,3
2,Bob,A                            2,3,Undirected,1
3,Carol,B                          1,3,Undirected,7
```

That is literally Gephi's CSV import vocabulary — its edge table's reserved columns are
`Source`, `Target`, `Type` (the literal strings `Directed` / `Undirected`), `Id`,
`Label`, `Weight`, `timeset`; the node table's are `Id`, `Label`, plus anything else as a
typed column. Any extra column becomes a user attribute. **This is the single most useful
fact for GenesisCA**: it is the CSV agent importer's exact shape, one table down.

### 1.2 Edge list (CSV / TSV) — the lingua franca

```
# SNAP style: '#' comments, tab-separated, integer ids
# FromNodeId	ToNodeId
0	1
0	2
2	3
```
```
# weighted, NetworkX read_weighted_edgelist
alice bob 0.8
bob carol 0.2
```

No node table at all — the node set is whatever appears in a column, so isolated nodes
are inexpressible. Attributes are positional or absent. **This is what the overwhelming
majority of published datasets ship as** (SNAP, KONECT `out.<name>`, Network Repository
`.edges`), so it is the format an importer *must* accept even though it is the least
expressive.

### 1.3 Adjacency matrix / adjacency list

```
,Alice,Bob,Carol        Alice Bob Carol
Alice,0,3,7             Bob Carol
Bob,3,0,1               Carol
Carol,7,1,0
```

Matrix: dense CSV, or a numpy `.npy`, or Matrix Market `.mtx` (Network Repository's
choice). O(N²) — fine for the classic small datasets, useless past a few thousand nodes.
Symmetric ⇒ undirected by convention; asymmetric ⇒ directed. The matrix form is what
UCINET and older sociometry tooling are built around, and it is the natural shape for a
**valued/signed** network (a cell can be −1).

Adjacency list (NetworkX `read_adjlist`): first token is the node, the rest are its
neighbours. Compact, no attributes, no weights.

### 1.4 GraphML — the typed XML standard

```xml
<?xml version="1.0" encoding="UTF-8"?>
<graphml xmlns="http://graphml.graphdrawing.org/xmlns">
  <key id="d0" for="node" attr.name="group"  attr.type="string"/>
  <key id="d1" for="edge" attr.name="weight" attr.type="double">
    <default>1.0</default>
  </key>
  <graph id="G" edgedefault="undirected">
    <node id="n0"><data key="d0">A</data></node>
    <node id="n1"><data key="d0">B</data></node>
    <edge source="n0" target="n1"><data key="d1">3.0</data></edge>
    <edge source="n1" target="n0" directed="true"/>   <!-- per-edge override -->
  </graph>
</graphml>
```

The richest of the widely-supported formats and the best *import target*: it declares
attribute **types** up front (`boolean` / `int` / `long` / `float` / `double` / `string`)
with optional defaults, states directedness once (`edgedefault`) with a per-edge override,
and supports self-loops and parallel edges. Written by NetworkX, igraph, Gephi, yEd,
Cytoscape. yEd/`<data>` extensions carry geometry in a private namespace — which is where
an imported **layout** would come from.

### 1.5 GEXF — Gephi's format, and the only common one that is dynamic

```xml
<gexf xmlns="http://www.gexf.net/1.2draft"
      xmlns:viz="http://www.gexf.net/1.2draft/viz" version="1.2">
  <graph mode="dynamic" defaultedgetype="directed" timeformat="integer">
    <attributes class="node">
      <attribute id="0" title="opinion" type="float"/>
    </attributes>
    <nodes>
      <node id="0" label="Alice" start="0" end="120">
        <attvalues><attvalue for="0" value="0.7" start="0" end="40"/></attvalues>
        <viz:position x="15.7" y="-40.0" z="0.0"/>
        <viz:size value="2.5"/>
        <viz:color r="239" g="173" b="66"/>
      </node>
    </nodes>
    <edges>
      <edge id="0" source="0" target="1" weight="2.0" start="10" end="90"/>
    </edges>
  </graph>
</gexf>
```

Two things GraphML does not have: **time intervals** (`start`/`end`, or explicit
`<spells>`, on nodes, edges *and* individual attribute values) and a **visual namespace**
carrying position/size/colour. So a GEXF export from Gephi is the one common file that
already contains a good layout — and the one that can express a temporal network.

### 1.6 GML, Pajek, UCINET DL, DOT

**GML** (Graph Modelling Language — unrelated to the geography GML). Bracketed
key-value, human-readable, and the format Mark Newman's canonical dataset page
distributes (karate, dolphins, lesmis, football, polbooks):
```
graph [
  directed 0
  node [ id 1 label "Alice" club "Mr. Hi" ]
  node [ id 2 label "Bob"   club "Officer" ]
  edge [ source 1 target 2 weight 3 ]
]
```

**Pajek `.net`** — the format that makes the directed/undirected distinction *structural*
rather than an attribute:
```
*Vertices 3
   1 "Alice" 0.1000 0.2000 0.5000
   2 "Bob"
   3 "Carol"
*Edges                 <- UNDIRECTED
   1 2 3.0
*Arcs                  <- DIRECTED
   2 3 1.0
```
Vertex lines optionally carry `x y z` in `[0,1]`. `*Edgeslist` / `*Arcslist` are
adjacency-list variants; `*Matrix` an adjacency matrix. Pajek keeps node attributes in
*separate* files — `.clu` (a partition, one integer per line) and `.vec` (a vector, one
float per line) — which is the two-table convention taken to its logical end.

**UCINET DL** — the social-sciences workhorse; matrix-first:
```
DL N=3
FORMAT = FULLMATRIX
LABELS:
Alice,Bob,Carol
DATA:
0 3 7
3 0 1
7 1 0
```
*(Keyword casing from memory; UCINET is case-insensitive here. `FORMAT` also takes
`EDGELIST1` / `NODELIST1`, and `NM=` declares multiple stacked relations — the native way
UCINET stores a **multi-relational** network.)*

**DOT** (Graphviz) — a *drawing* language that happens to encode a graph:
```
graph  G { a -- b [weight=3]; }      // undirected
digraph D { a -> b [label="follows"]; }  // directed
```
Weakly typed (every attribute is a string), no schema. Fine as an export target, poor as
an import one.

### 1.7 JSON — node-link and Cytoscape

**node-link** (NetworkX `node_link_data`, and what D3's force layout eats):
```json
{
  "directed": false, "multigraph": false, "graph": {},
  "nodes": [ {"id": "alice", "group": "A"}, {"id": "bob", "group": "A"} ],
  "links": [ {"source": "alice", "target": "bob", "weight": 3} ]
}
```
✅ **Verified (see §0):** NetworkX deprecated the `link` keyword in **3.4** and flipped the
default serialization key from `"links"` to `"edges"` in **3.6** — so real files exist with
either key. **An importer must accept both keys unconditionally.**

**Cytoscape.js**:
```json
{ "elements": {
  "nodes": [ { "data": { "id": "a", "name": "Alice" }, "position": { "x": 100, "y": 200 } } ],
  "edges": [ { "data": { "id": "e1", "source": "a", "target": "b", "weight": 3 } } ] } }
```
Also accepts a flat array of elements. (Cytoscape *desktop* has its own aspect-oriented
CX/CX2 JSON — different, much more complex, lower priority.) JSON Graph Format (JGF)
exists as a spec but has little real adoption.

### 1.8 What each format actually supports

| Format | Directed | Typed attrs | Weights | Multi-edge | Self-loop | Time | Layout | In practice |
|---|---|---|---|---|---|---|---|---|
| Edge list CSV/TSV | by convention | no | 3rd column | yes | yes | a `t` column | no | **the default for published datasets** |
| Node+edge CSV pair | `Type` column | untyped strings | `Weight` | via id | yes | `timeset` | via columns | **Gephi's import; the practitioner's spreadsheet** |
| Adjacency matrix | asymmetry | no | cell value | no | diagonal | no | no | small/classic, UCINET-era |
| **GraphML** | `edgedefault` + per-edge | **yes, declared** | as an attr | yes | yes | no | vendor ext | **the best interchange target** |
| **GEXF** | `defaultedgetype` | yes, declared | `weight` attr | yes | yes | **yes, intervals** | **yes, `viz:`** | Gephi round-trip; the only dynamic one |
| GML | `directed 0/1` | untyped | as an attr | yes | yes | no | via attrs | Newman's dataset corpus |
| Pajek `.net` | `*Edges` vs `*Arcs` | separate files | 3rd number | yes | yes | no | vertex coords | classic SNA, still taught |
| UCINET DL | matrix asymmetry | separate/stacked | cell value | via `NM=` | diagonal | no | no | social-sciences legacy |
| DOT | `graph`/`digraph` | strings | attr | yes | yes | no | that's its job | drawing, not analysis |
| node-link JSON | `"directed"` | JSON types | `weight` | `"multigraph"` | yes | no | via node fields | **web / D3 / NetworkX** |
| Cytoscape JSON | `data` fields | JSON types | `weight` | yes | yes | no | `position` | web viz |

### 1.9 The attribute vocabulary that is effectively standard

Not a spec — a convention so consistent that auto-mapping on these names will hit most
real files:

| Edge | Node |
|---|---|
| **`weight`** — the one universal edge attribute; NetworkX, igraph and Gephi all special-case it | `id`, `label`, `name` |
| `type` / `kind` / `relation` — the relation in a multi-relational network | `group`, `community`, `club`, `modularity_class` (Gephi writes the last one) |
| `sign` (+1/−1) in signed/balance-theory networks | `x`, `y`, `size`, `color` (viz) |
| `timestamp` / `start` / `end` | `degree`, `betweenness`, `pagerank`, `eigencentrality`, `closeness`, `clustering` — **computed** columns Gephi writes back into the node table |

That last row matters for the export side: the practitioner's loop is *simulate → compute
metrics → write them onto the nodes → export → plot/inspect elsewhere*.

### 1.10 The corpus, and the number that decides everything for GenesisCA

| Dataset | N | E | mean deg | **max deg** |
|---|---|---|---|---|
| Florentine families | 15 | 20 | 2.7 | 6 |
| Zachary karate club | 34 | 78 | 4.6 | 17 |
| Dolphins | 62 | 159 | 5.1 | 12 |
| Les Misérables | 77 | 254 | 6.6 | 36 |
| Football (Girvan–Newman) | 115 | 613 | 10.7 | 12 |
| ca-GrQc (arXiv collab) | 5 242 | 14 496 | 5.5 | 81 (some sources: 162 — see §0) |
| Facebook ego (SNAP combined) | 4 039 | 88 234 | 43.7 | ≈1 045 |

*(N/E confirmed; karate 17 and Facebook 1 045 confirmed; ca-GrQc contested; the rest from
memory — see §0.)* The shape to notice: **max
degree runs 3–24× the mean**, and the gap widens with size. §3.1 shows why that single
number, not the edge count, is GenesisCA's binding constraint.

---

## 2. What people actually simulate on those graphs

### 2.1 Generators (the "I have no data, make me a graph" half)

| Family | Definition |
|---|---|
| **Erdős–Rényi** `G(n,p)` / `G(n,m)` | each pair independently with prob `p` / exactly `m` random pairs |
| **Watts–Strogatz** `(n,k,p)` | ring lattice, each node to its `k` nearest each side, then rewire each edge with prob `p` |
| **Barabási–Albert** `(n,m)` | grow one node at a time, attach `m` edges with probability ∝ target degree |
| **Stochastic block model** | assign each node a block; edge prob from a block×block matrix |
| **Configuration model** | given a degree sequence, match half-edges at random |
| **Random geometric** `(n,r)` | scatter in space, connect pairs within radius `r` |
| Chung–Lu, LFR, Kleinberg | expected-degree, planted-community benchmark, navigable small-world |

### 2.2 Dynamics

- **Contagion / diffusion** — SI, SIS, SIR, SEIR on networks; **independent cascade**
  (each newly-active node tries each neighbour *once* with prob `p`); **linear threshold**
  (activate when the weighted active fraction crosses a per-node threshold); **complex
  contagion** (needs *k* distinct active neighbours, not one); bootstrap percolation.
- **Opinion** — voter model (copy a random neighbour), DeGroot (repeated weighted
  averaging), **Deffuant–Weisbuch** (pick a random neighbour; if `|xᵢ−xⱼ| < ε`, both move
  toward each other), Hegselmann–Krause (average over neighbours *inside* the confidence
  bound), Axelrod cultural dissemination, Sznajd, majority rule, Friedkin–Johnsen.
- **Adaptive / coevolving** — the topology changes *because of* the states: **Holme–Newman
  rewire-on-disagreement**, adaptive voter, adaptive SIS (rewire away from infected
  neighbours). This is the family GenesisCA is structurally best at.
- **Games** — prisoner's dilemma / snowdrift / public goods on graphs, with imitate-best
  or Fermi update.
- **Other** — Schelling on a network, Watts 2002 threshold cascades, k-core pruning,
  percolation, Kuramoto oscillators, Ising/Potts on graphs, random walks.

### 2.3 Measurements

Degree distribution · density · clustering (global transitivity vs mean local) · path
lengths (average, diameter) · centralities (degree, closeness, betweenness, eigenvector,
PageRank, Katz, harmonic) · community detection + modularity (Louvain, Leiden, label
propagation, Girvan–Newman) · assortativity · components · k-cores · rich club · motifs ·
reciprocity (directed).

### 2.4 Coverage — what GenesisCA can express *today*

**[verified]** against the shipped node catalogue and the GRA section.

| Model | Expressible now? | How / what blocks it |
|---|---|---|
| **SI / SIS / SIR** | ✅ **today** | `Neighbour Census` (`source: 'bonded'`) over an `infected` bool + `Get Random`. Structurally the shipped `Life on Bonds`, different rule. |
| **Voter model** | ✅ **today** | `Get Bonded Agents → Pick Random Agent → Get Attribute (by ID) → Set Attribute` |
| **DeGroot averaging** | ✅ **today** | `Get Bonded Agents → Get Agents Attribute → Aggregate(average)` |
| **Linear threshold / Watts cascade** | ✅ **today** | census count ÷ `Get Bond Degree` → `Compare ≥ θ` |
| **Complex contagion (k-threshold)** | ✅ **today** | the same, with a raw count |
| **Independent cascade** | ✅ **today** | needs per-edge "already tried" state ⇒ a **bool bond attribute** — the canonical demonstration of why bond attributes exist |
| **PD / snowdrift, imitate-best** | ✅ **today** | `Get Agents Attribute → groupOperator.max` (its `position` output is the argmax) → `Get Attribute (by ID)` |
| **Ising / Potts / Kuramoto** | ✅ **today** | `For Each Bond → Get Attribute (by ID) → Expression → Local Variable` accumulate |
| **Deffuant (pairwise)** | ✅ with a documented constraint | writes the *other* agent ⇒ **async agent mode only**, and the WebGPU agent target rejects a wired cross-agent overwrite (documented gate) |
| **Hegselmann–Krause** | ⚠️ via `For Each Bond` | `Filter Agents` compares against a **constant**, not against self, so a bounded-confidence filter is a loop, not a filter |
| **Holme–Newman adaptive rewire** | ✅✅ **today, natively** | **`Rewire Bond` is an atomic primitive** — most SNA toolkits make you delete-then-add |
| **Axelrod culture** | ⚠️ partial | F features per agent ⇒ F separate agent attributes (fine for small F); there is no per-agent array attribute |
| **Random geometric graph** | ✅✅ **today, for free** | scatter + engine **auto-bond by distance** *is* an RGG |
| **ER / WS / BA / SBM** | ⚠️ expressible, awkward | see §3.3 — the pieces exist; the ergonomics do not |
| **Import a real network** | ❌ **nothing** | §3.1 — the headline gap |
| **Centralities / communities** | ❌ | §3.4 |
| **Temporal edge playback** | ❌ | §3.5 |

Two honest superlatives, both structural rather than flattering:

1. **The adaptive-network family is GenesisCA's home turf.** Coevolving state-and-topology
   models are awkward in NetworkX (you rebuild the graph each step) and awkward in NetLogo
   (link agents, manual bookkeeping). GenesisCA has an atomic per-agent structural request
   queue with `Form / Break / Rewire / Transfer / Form Between / Break Between`, invariants
   checked by a harness, and a force layout that keeps up. That is a genuinely unusual
   combination and it is already shipped.
2. **Everything *static*-analysis-shaped is absent.** No centrality, no communities, no
   paths. Which is fine — those are analysis, not simulation — but it is exactly what an
   SNA user opens first.

---

## 3. Gap analysis, subsystem by subsystem

### 3.1 IMPORT — a graph as agents + bonds

**The seam does not exist. [verified]** A `grep` for `bond` across `csvImport.ts`,
`geojsonImport.ts`, `geotiffImport.ts` and all three import dialogs returns **zero
matches**. The agent-import payload is:

```ts
// src/simulator/csvImport.ts
export interface CsvAgentSpec {
  x: number; y: number; z?: number;
  radius?: number; vx?: number; vy?: number; vz?: number;
  sets: Array<{ attrId: string; value: number }>;
}
// src/simulator/engine/sim.worker.ts — the handler calls only
//   allocAgentSlot / initAgentSlot / applyAgentSets. It never touches a bond array.
interface PasteAgentsMsg { type: 'pasteAgents'; agents: […]; torus?: boolean; activeViewer: string }
```

The only bond-creating worker messages are **single-pair and manual** — `formBond {a,b}`
and `breakBond {a,b}`, both sent solely by the Glue/Cut brush. `formBondBatch` was removed
(commit `1eb43f8`) and **does not exist anywhere in `src/`**. `readAgents` returns no bond
data either, which is why the documented agent clipboard "arrives unbonded".

So an import needs a genuinely new payload. Everything *below* it is ready:

```ts
// src/simulator/engine/agentEngine.ts — already exactly the right shape
export function formBond(
  store: AgentStore, a: number, b: number, L: number, lambda: number,
  typeLabel = 0, attrValues?: ArrayLike<number> | null,
): boolean
```
`attrValues` is indexed in `store.bondAttrSpecs` order and falls back per-entry to the
attribute default. It writes **both** slots identically (invariant I2) and rejects
atomically on: self, negative id, dead endpoint, **duplicate pair**, or **either** side at
capacity.

#### The mapping

| File concept | GenesisCA |
|---|---|
| node row | one agent (`allocAgentSlot` + `initAgentSlot`) |
| node attribute column | an **agent attribute** (`sets[]`, pre-encoded numeric — the existing discipline) |
| node `x`,`y` | agent position, or a force layout (§3.1.5) |
| edge row | one **bond** (`formBond`) |
| edge `weight` | a **float bond attribute** |
| edge `type`/`relation` | a **tag bond attribute** |
| arc direction | a **bond attribute** — §3.6 |
| edge id / label | dropped (a bond has no id; `bondTypeLabel` is an integer class) |

#### ⚠️ The five hard constraints, in the order they will bite

**(1) `maxBonds` is a HARD per-node degree cap, and the store is ELLPACK.** The bond store
is `maxAgents × maxBonds` **rectangular** (ragged only in that `bondCount[i] ≤ maxBonds`).
Per slot the built-ins cost **28 bytes** — `bondPartner`+`bondPartnerEpoch`+`bondTypeLabel`
(3×i32) + `bondRestLength`+`bondStiffness` (2×f64) — plus 4 B per bool/int/tag bond
attribute and 8 B per float one. So the store is sized by the **hub** and wasted on
everyone else. Measured this session:

| Graph | N | E | mean deg | **max deg** | store @ `maxBonds` = max deg | ideal (2E slots) | waste |
|---|---|---|---|---|---|---|---|
| BA `m=3` | 1 000 | 2 994 | 6.0 | 117 | 3.3 MB | 168 KB | **19×** |
| BA `m=3` | 10 000 | 29 994 | 6.0 | 341 | 95.5 MB | 1.7 MB | **57×** |
| BA `m=3` | **100 000** | 299 994 | 6.0 | **1 140** | **3.19 GB** | 16.8 MB | **190×** |
| Zachary karate | 34 | 78 | 4.6 | 17 | 16 KB | 4 KB | 3.7× |
| Les Misérables | 77 | 254 | 6.6 | 36 | 78 KB | 14 KB | 5.5× |
| ca-GrQc | 5 242 | 14 496 | 5.5 | 81 | 11.9 MB | 812 KB | 15× |
| Facebook ego | 4 039 | 88 234 | 43.7 | ≈1 045 | **118 MB** (152 MB with one float weight) | 4.9 MB | **24×**, 95.8 % of slots never used |

**This is the ELLPACK-vs-scale-free hazard [INVESTIGATION_GRAPH_CA.md](INVESTIGATION_GRAPH_CA.md)
§2.8 already called out — "Avoid plain ELLPACK (max-degree padding) for scale-free graphs
— prohibitive waste on a single hub" — arriving from the other direction.** The honest
scope statement:

> **GenesisCA can hold graphs bounded by `maxAgents × maxDegree`, not by edge count.**
> The classic SNA corpus (≤10³ nodes, max degree ≤10²) is comfortable. A mid-size
> collaboration network (10³–10⁴ nodes, max degree ~10²) costs tens of MB. A hub-heavy
> ego network or a 10⁵-node scale-free graph is **out of reach** without a storage change.

The importer must therefore **compute the max degree before it does anything**, and either
raise `maxBonds` (a structural change ⇒ full worker reinit) or refuse with the exact
number. Silently truncating a hub is the one outcome that must never happen.

**(2) Duplicate pairs are refused — so multigraphs cannot round-trip.** `formBond` returns
false on `hasBond(a,b)`. Parallel edges must be **merged** (summing/maxing `weight`, or
keeping the first) with the count reported, or the import must refuse. Same mechanism
means a **reciprocal arc pair `a→b` + `b→a` is one bond**, which is what forces the
direction encoding in §3.6.

**(3) Self-loops are refused** (`a === b`). Report and drop.

**(4) The node-id → slot-id mapping is only knowable inside the paste loop.** `pasteAgents`
allocates with `allocAgentSlot()` in sequence and there is no reply carrying the ids. So
the bond list cannot be a *second* message keyed on file ids — either the agents and bonds
travel **together** (recommended: an optional `bonds` member on `pasteAgents`, positional
into `msg.agents`), or `pasteAgents` must start replying with its allocations.

**(5) The Bonds capability gates everything.** `resolveMaxBonds(cfg)` returns **0** when
the profile says `bonds: 'off'`, which collapses the bond store to zero bytes *and* makes
`bondAttrsOf(model)` return `[]`. An import into a bonds-off model must set
`agentCapabilities.bonds` to at least `'data'` (the `socialGraph` preset's value) — the
`gisTools` auto-enable is the precedent for doing this as part of a successful import.

#### 3.1.5 Layout

Two sources, offer both:
- **From the file** — GEXF `viz:position`, Pajek vertex `x y z`, Cytoscape `position`,
  GraphML vendor extensions, or plain `x`/`y` node columns. Rescale into the agent world
  (which *is* the grid frame 1:1) exactly as the GeoJSON importer's affine does.
- **Force-directed** — the shipped GRA layout: global **charge** (Barnes–Hut,
  `chargeRange: 'global'`, θ=0.9) + bond **springs**, with `layoutIterations` for
  relaxation. `Growing Graphs` and `SDCA` both demonstrate it at 10⁴ nodes. Requires
  `motion: 'force'`, which the `socialGraph` preset (`static`) does **not** have — so
  "import with layout" implies a different capability profile than "import as data".

**Recommendation:** default to file positions when present; otherwise scatter + let the
force layout settle (and say so in the dialog, because the first frame will look like a
hairball for a second or two).

### 3.2 EXPORT

The state already round-trips: `serializeAgentStore` writes `bondCount` / `bondPartner` /
`bondPartnerEpoch` / `bondRestLength` / `bondStiffness` / `bondTypeLabel` and a per-id
`bondAttrs` record **[verified]** — so **an imported graph survives in the `.gcaproj` via
the embedded board**, and `resetRestoresBoard` (already shipped for the GIS samples) makes
it survive Reset. *The import is a one-time act; the graph then travels with the model.*
That is a significant and under-appreciated piece of the puzzle.

For interchange, ranked by value/effort:

1. **Edge list CSV + node table CSV** — two files, or one dialog writing both. Mirrors the
   shipped CSV export (`agentExportColumns` / `buildAgentCsv` already write the node
   table; the edge table needs `snapshotBonds`, which exists and returns flat `[a,b]`
   pairs with `b > a`). **Highest value: it is what every other tool reads**, and with
   computed metrics as node columns it closes the practitioner's loop (§1.9).
2. **node-link JSON** — one file, keeps types, feeds D3/NetworkX/Cytoscape directly.
3. **GraphML** — the "proper" answer; typed, one file, universally read. More code than
   JSON for the same reach.
4. GEXF / GML / Pajek — only on demand.

### 3.3 GENERATORS

**The pieces exist; the ergonomics do not.** What is expressible as a behaviour-graph
idiom today:

| Generator | Expressible? | The mechanism, and what it costs |
|---|---|---|
| **Random geometric** | ✅ **free** | scatter + engine auto-bond by distance — already a shipped mechanism |
| **Watts–Strogatz** | ✅ clean | ring: `Form Bond` with `targetAgent = (Get Self Handle + j) mod N`. Rewire: **the `Rewire Bond` verb, literally** |
| **Erdős–Rényi** | ⚠️ works, costs | needs "every other agent" — `Get Nearby Agents` with a world-spanning radius, which **degrades to all-pairs O(N²)** (documented) — then `For Each In Array → Get Random → Form Bond` |
| **Barabási–Albert** | ⚠️ works, one trick | preferential attachment = `groupOperator.weightedRandom` over a degree weight array. There is no "gather the degrees of these agents" node, so **mirror `Get Bond Degree` into an agent attribute each step**, then `Get Agents Attribute` gathers it. `weightedRandom`'s `position` output indexes back into the id array |
| **Stochastic block model** | ✅ **elegant** | the block×block probability matrix **is** a 2-axis tag×tag **lookup table** — editable in the shipped matrix-play widget, exactly like Particle Life's interaction matrix |
| **Configuration model** | ❌ | half-edge matching is a global pass; no per-agent formulation |

Three ceilings to state plainly:

- **The structural request queue caps ops per agent per generation** at
  `resolveBondRequestDepth` (default **8**, max **64**), with an overflow bucket that is
  applied by nobody. A node needing degree 100 in one generation cannot get it.
- **`Form Bond` is invalid in the Agent Init Event** (the queue is loop-only in that ABI),
  so generation happens on the **first behaviour step**, gated on a flag — precisely the
  idiom `Growing Graphs` already uses for its 10-node bootstrap (`gated on bond degree 0
  so it runs exactly once`).
- **The all-pairs enumeration is O(N²) per generation.** Acceptable as a one-shot
  bootstrap at N≈10³; not at 10⁴.

**Recommendation: put the generators in the IMPORTER, not the rule graph.** A "Generate"
tab of the network dialog that produces the same `{agents, bonds}` payload is seeded,
deterministic, O(E) rather than O(N²), unconstrained by the queue depth, and reuses the
whole import pipeline including the capacity check. Ship the *rule-graph* versions as
`.gcamacro` files (the "GRA Rule Table" macro is the precedent) for people who want the
generation to be part of the model — WS and SBM especially, which are genuinely pretty as
graphs.

### 3.4 MEASUREMENTS

Measured this session with Node scratch scripts over the **real store shape**
(`highWater` / `maxBonds` / `alive` / `bondCount` / `bondPartner`, stride `maxBonds`) —
i.e. the same view `computeGraphMetrics` consumes. Best of 3 runs, Node 22.20:

| Metric | BA 10k (E≈29k) | BA 100k (E≈295k) | WS 10k | WS 100k | Verdict |
|---|---|---|---|---|---|
| degree pass (E / mean / max / histogram) — **shipped** | 0.04 ms | 0.22 ms | 0.04 ms | 0.21 ms | free, per-generation |
| `componentCount` (union-find) — **shipped** | 1.5 ms | 16 ms | 1.3 ms | 8.3 ms | cheap, per-generation |
| **mean local clustering** + triangles | 23 ms | 200 ms | 8.1 ms | 60 ms | **per-generation to ~10k; batch beyond** |
| **PageRank** (20 power iterations) | 10 ms | 158 ms | 6.1 ms | 72 ms | batch tempo |
| one BFS (the unit of every path metric) | 0.58 ms | 14 ms | 0.37 ms | 7.7 ms | — |
| **closeness** (all-pairs BFS) | **≈5.8 s** | **≈24 min** | ≈3.7 s | ≈13 min | on-demand only, ≤10k |
| **betweenness** (Brandes, extrapolated from 50 sources) | **≈21 s** | **≈49 min** | ≈11 s | ≈30 min | on-demand only, ≤10k |

**The hub effect is visible and worth carrying into the design:** at the *same* N and E,
clustering costs **3× more** on the scale-free graph than on the small-world one (23 vs
8.1 ms at 10k; 200 vs 60 ms at 100k), because the per-node inner loop is O(d²) and one hub
dominates. Any new metric with a d² term must be costed on a scale-free graph, not a
regular one.

So, three tiers:

- **Per-generation graph indicators** (extend `graphMetrics.ts` — CPU-side by design,
  like the six shipped ones): `density`, `largestComponentSize` / giant-component
  fraction, `isolatedCount`, **assortativity** (one O(E) pass), **k-core / max core
  number** (O(E) peeling), `reciprocity` (directed; needs §3.6). All O(N+E), all
  effectively free next to the degree pass.
- **Batch/frame tempo**: mean local clustering + triangles, PageRank, eigenvector
  centrality. These want an explicit cadence, not the per-generation indicator path.
- **On-demand analysis actions, never indicators**: closeness, betweenness, diameter,
  average path length, community detection (Louvain/label propagation). The natural home
  is the **Overseer** — an `ovComputeGraphMetric`-shaped action that runs once and writes
  a series — or a "compute now" button in the panel. Nothing that takes 21 seconds may sit
  on the generation loop.

#### Per-AGENT metrics — write them into an agent attribute, do **not** add a node

Colouring a network by PageRank or by community is *the* canonical SNA picture, and it
needs the value per agent. Two designs:

- **A per-agent metric NODE** — would need all three agent targets (JS/WASM/WebGPU) per
  the all-target rule. And it does not even work: PageRank, betweenness and community are
  **global, iterative** quantities, not local computations. A node cannot express them.
- **✅ A worker-computed pass writing a designated agent attribute**, on a cadence. The
  rule then reads it with an ordinary `Get Self Attribute`; a viewer colours by it with an
  ordinary Agent Output Mapping; the Overseer reads it as an ordinary indicator. **Zero
  per-target emit, zero new node, zero compiler change** — the write is into
  `attrRead`/`attrWrite`, exactly like `applyAgentSets`.

That asymmetry is the whole architectural point of this section: **global metrics belong in
the worker, not in the node graph.**

### 3.5 DYNAMIC / TEMPORAL edges

GEXF spells it as intervals; research datasets ship it as a timestamped edge list
(`source,target,t`, sometimes `+1/-1` for add/remove). Playback means: at generation `g`,
apply the edge events whose timestamp maps to `g`. GenesisCA has **no per-step driver
stream** — the same gap [INVESTIGATION_GEOSPATIAL_IO.md](INVESTIGATION_GEOSPATIAL_IO.md)
§5 flagged for weather (`Cell2Fire`'s `Weathers.csv`). The honest v1 answer is the same
too: **out of scope, and it is one shared feature** — a "driver series" (a table indexed
by generation, applied by the worker) would serve weather *and* temporal edges *and*
scripted parameter sweeps. Until then, an Overseer protocol can do it coarsely
(`ovRunGenerations` → apply the next batch), and a static import can carry `t` as a float
bond attribute so a *rule* can gate on it.

### 3.6 DIRECTEDNESS — keep D2, use the attribute idiom

**Decision D2 (GRA P2): a bond is ONE object stored TWICE.** `formBond`/`addBondSlot`
write both slots with the same values; `setBondFields` writes both; invariant **I2**
(checked by `verify-graph-rewrite.mjs`) requires every per-slot field to agree in both
rows. An asymmetric bond attribute is therefore not merely discouraged — it is
*unrepresentable without breaking a machine-checked invariant*.

**Should D2 be revisited?**

*For:* directed networks are half of SNA — follower graphs, citation, trust, food webs.
Asymmetric *weights* (a trusts b 0.9, b trusts a 0.2) are a real modelling need, not a
formatting one.

*Against:* (1) I2 is a harness-checked contract the whole GRA milestone rests on; (2)
`addBondSlot` writes both sides from one `attrValues` array — asymmetry needs a second
parameter set threaded through **every** mirror: the WASM and WebGPU emitters,
`moveBondSlot`'s compaction field list, `serializeAgentStore`, `setBondFields`,
`drainAgentBondRequests`; (3) the physics reads `restLength`/`stiffness` from the *local*
slot, and an asymmetric spring is unphysical; (4) **the attribute idiom is fully
expressive at a cost of one bond attribute.**

**Recommendation: keep D2.** The idiom, stated once:

> **Store the pair, and index it by which end you are.** Both slots hold the *same*
> value(s); a rule decodes its own view with `Get Self Handle` and the partner id.

Three concrete encodings, in increasing power, all I2-clean:

| Need | Encoding | The rule reads it as |
|---|---|---|
| a simple arc (the 95 % case) | ONE **integer** bond attribute `source` = the tail agent's id | `outgoing = (Get Bond Attribute(source) == Get Self Handle)` — one Compare |
| reciprocal arcs preserved | TWO **bool** attributes `arcLoHi` / `arcHiLo`, relative to `min(a,b)`/`max(a,b)` | `outgoing = (self < partner) ? arcLoHi : arcHiLo` — a Compare + a Value Switch |
| asymmetric weights | TWO **float** attributes `wLoHi` / `wHiLo`, same convention | the same Value Switch |

*(The `min/max` convention rather than a raw bitmask is deliberate: GenesisCA's Math node
has no bitwise operators, so a two-attribute form costs one Compare where a packed mask
would cost modular arithmetic.)*

**The importer's job**, then: read `edgedefault` / `*Edges` vs `*Arcs` / `"directed"` /
`Type`, and offer a **Directedness** control — *Undirected* (no extra attribute),
*Directed → `source`* (reciprocal arcs **merge**, count reported), *Directed → arc pair*
(reciprocity preserved, 8 B/slot). Export mirrors it. And the convention must be written
down once, in Help, or every model will invent its own.

### 3.7 UI

Almost everything is already there:

| Need | Status |
|---|---|
| Import entry beside CSV / GeoJSON | **new** — one menu item + one hidden input + one `genesis-open-network-file` drop event (the shipped pattern, four times over) |
| Add-edge / cut-edge brush | ✅ **shipped** — the agent brush's **Glue** / **Cut** modes (gated on `resolveMaxBonds > 0`) |
| Inspect an edge | ✅ **shipped** — `InspectBondPopover`: endpoints, length, rest length, stiffness, **every bond attribute**, editable |
| Inspect a node | ✅ **shipped** — `InspectAgentPopover`, multi + draggable + Follow |
| A "social graph" paradigm | ✅ **shipped** — `AGENT_PRESETS.socialGraph` = `static` / no body / `bonds: 'data'` / charge off |
| Colour by a node attribute | ✅ **shipped** — Agent Output Mappings (linked, or a graph) |
| Graph measurements panel | ✅ **shipped** — Graph indicators + charts + Overseer CSV export |
| Force layout | ✅ **shipped** — global charge + springs + `layoutIterations` |

So the UI work is *one dialog*. The rest is a matter of pointing existing controls at a
new kind of file.

---

## 4. Recommendation + phased plan

**Ship N1 and N2. Defer the rest until a real model asks.**

### N1 — Network import (agents + bonds) ★ the whole unlock

One new pure module + one dialog + one additive worker field. Formats, in priority order:
**edge list CSV / TSV** (with an optional node table), **node-link JSON**, **GraphML**.
`GEXF` and `Pajek` are cheap follow-ons once the mapping layer exists; GML/DL/DOT on
demand.

| Subsystem | Change | Notes |
|---|---|---|
| **schema** | *(none required)* | `bondAttributes` already exists; directedness is an attribute convention (§3.6). Optionally `ModelProperties.networkMeta?` for provenance — cosmetic |
| **fileOperations** | *(none)* | the graph rides `simulationState` — `serializeAgentStore` already round-trips bonds **and** `bondAttrs` **[verified]** |
| **pure core** | **new `src/simulator/networkImport.ts`** | sibling of `csvImport` / `geojsonImport` / `geotiffImport`; DOM- and dependency-free; parsers + the id→index map + the capacity/dedupe/self-loop analysis + `buildNetwork()` returning `{agents, bonds, report}` |
| **worker** | **`pasteAgents` gains `bonds?: Array<{a,b,restLength?,stiffness?,attrs?}>`** — indices **positional into `msg.agents`** | Additive; the handler already holds the allocation map. Bonus: closes the documented "pasted agents arrive unbonded" gap for the **clipboard** too. `pasteAgents` is already in `AGENT_GPU_DEFER_TYPES` |
| **engine** | *(none)* | `formBond(store,a,b,L,λ,typeLabel,attrValues)` is already the exact seam |
| **UI** | **new `NetworkImportDialog.tsx`** + a transport-bar menu item + a hidden input + `genesis-open-network-file` | mirrors `CsvImportDialog`: auto-map by column name (`normaliseName` + a `weight`/`type`/`sign`/`timestamp` alias table extending `GEOM_ALIASES`), a live report, a preview |
| **capabilities** | the import **raises `bonds` to `'data'`** and **`maxBonds` to the measured max degree** when needed | both are structural ⇒ a full worker reinit, exactly like a dimension change. The `gisTools` auto-enable is the precedent |
| **indicators** | *(none in N1)* | |
| **docs** | Help recipe ("Import a social network"), README feature line, this doc's §3.6 convention | no `NODES_REFERENCE` change — **no node is added** |
| **harness** | **new `scripts/test-network-import.mjs`** | parser tables by value; then **I1–I4 asserted after a real import** (`Σdeg = 2E`, both slots agree, no dangling, no over-capacity); a round trip (import → export → re-import → identical edge set); the dedupe/self-loop/over-capacity refusals |

**ALL-TARGET DELIVERY:** an import is a **worker mutation of the CPU store**, so it is
**compile-target-agnostic by construction** — exactly like `pasteAgents`, `paintManual`
and `importGridValues`. No compiler file is opened; `check-compile-identity` is unchanged
by construction. *This is the same argument the GIS importers shipped under.*

**The dialog's non-negotiables**, all learned from the constraints above:
- Report **N, E, mean degree, MAX DEGREE** before applying, and state the resulting
  `maxAgents`/`maxBonds` and the store size in MB.
- **Refuse loudly** rather than truncate a hub. `maxBonds` is a hard cap; a silently
  clipped hub is the worst possible outcome.
- Report merged parallel edges, dropped self-loops, and merged reciprocal arcs — counts
  plus the first few, the shipped `CsvIssue` discipline.
- Offer **Directedness** (§3.6) and **Layout** (file positions vs force) explicitly.

### N2 — Generators + the measurement tier

- **Generate tab** on the same dialog: **ER `G(n,p)`**, **WS `(n,k,p)`**, **BA `(n,m)`**,
  **SBM** (block×block matrix), **RGG** — seeded, deterministic, producing the identical
  `{agents, bonds}` payload. §3.3 argues this beats a `seedPattern` sibling or an engine
  change, and sidesteps the O(N²)/queue-depth ceilings entirely.
- **Cheap graph indicators**: density, largest-component fraction, isolated count,
  assortativity, max core number. All O(N+E) — free next to the shipped degree pass.
- **A worker-computed per-agent metric pass** (degree / local clustering / PageRank / core
  number / component id) writing a **designated agent attribute** on a cadence. §3.4:
  **not a node** — global iterative metrics are not local computations, and this needs no
  per-target emit.
- **Export**: edge list CSV + node table CSV (with the computed metrics as columns) —
  §1.9's practitioner loop. node-link JSON next.

### N3+ — deferred, with the reason

| Deferred | Why |
|---|---|
| Betweenness / closeness / diameter | ≈21 s / ≈6 s at 10k **[measured]**; on-demand only, and that needs an analysis-action concept the app does not have |
| Community detection (Louvain) | heavier than PageRank and stateful; the same on-demand home |
| Temporal edge playback | needs the shared "driver series" feature (§3.5) — one design serving weather *and* temporal networks |
| Multigraph / parallel edges | `formBond` refuses duplicates by design; would need a different store |
| **CSR bond store** (the real fix for scale-free) | a cross-target engine change touching every bond mirror — its own milestone, and only worth it when someone actually needs 10⁵ nodes |
| Asymmetric bonds (breaking D2) | §3.6 — the attribute idiom is fully expressive at a fraction of the blast radius |
| GEXF / GML / Pajek / DL / DOT import | cheap once N1's mapping layer exists; add on demand |

### Sample models to ship with it

1. **Contagion on a real network** — SIR over an imported edge list, infected-count
   indicator as the epidemic curve, seeded by the agent brush. The demo of the whole
   feature. *(Use whatever canonical edge list the author exports —
   `nx.karate_club_graph()` or Newman's `.gml` corpus is a one-liner. I have deliberately
   **not** transcribed the karate-club edge list from memory: one wrong edge in a shipped
   fixture is worse than no fixture.)*
2. **Adaptive voter / Deffuant with rewire-on-disagreement** — the model that shows the
   thing GenesisCA is uniquely good at: **`Rewire Bond` as a primitive**. Opinion as a
   float agent attribute, bounded confidence, rewire away on disagreement; watch the graph
   fragment into echo chambers and the component count climb — **on the shipped
   `componentCount` indicator, live**.
3. **BA growth coloured by PageRank** — generated in-app, growing one node per generation
   via the shipped unified spawning, with the worker-computed PageRank pass colouring
   nodes through an Agent Output Mapping. Demonstrates N2 end to end.

---

## 5. Risks / open questions

- **The `maxBonds` ceiling is the feature's real boundary** (§3.1). It should be stated in
  Help, shown in the dialog, and never worked around silently. If users routinely hit it,
  that is the signal for the CSR milestone — not before.
- **`socialGraph`'s profile is `motion: 'static'`, so it has no force layout.** "Import
  with layout" and "import as data" want different capability profiles. The dialog should
  say which one it is setting.
- **Directedness will be reinvented per-model unless §3.6's convention is written down
  once** and used by the importer, the exporter and the sample models identically.
- **A hub makes any d²-shaped metric 3× more expensive [measured]** — cost new metrics on
  a scale-free graph, never on a lattice or a ring.
- **`.gcaproj` weight**: an imported graph becomes `simulationState` (base64). A 10k-node
  graph at `maxBonds` 341 is ~95 MB of bond store before compression — the existing
  "include board state" checkbox discipline matters more here than anywhere else.
- **Node identity across a save/load** is the *slot id*, not the file id. Anything that
  wants to re-join external node metadata later needs the original id kept as an agent
  attribute — the importer should offer that as a column mapping, and probably default it
  on.
- **Where does an "analysis action" live?** Betweenness, communities and diameter do not
  fit the indicator model (per-generation) or the node model (local). The Overseer is the
  closest existing home. That is a genuine design question this investigation does not
  settle.

---

## 6. Sources

Written from domain knowledge; the format sketches were then spot-checked with web access
in a second session (§0 records exactly what was confirmed). The primary literature behind
§2 (Erdős–Rényi 1959/60; Watts & Strogatz 1998; Barabási & Albert 1999; Holland, Laskey &
Leinhardt 1983 for SBM; Granovetter 1978 and Watts 2002 for thresholds; Kempe, Kleinberg &
Tardos 2003 for IC/LT; Deffuant et al. 2000; Hegselmann & Krause 2002; Axelrod 1997; Holme
& Newman 2006; Castellano, Fortunato & Loreto, *Rev. Mod. Phys.* 2009 for the opinion
survey; Pastor-Satorras et al., *Rev. Mod. Phys.* 2015 for epidemics on networks; Brandes
2001 for betweenness; Blondel et al. 2008 for Louvain; Newman 2003 for the structure
survey) is standard and easy to verify; **the format specifications (GraphML, GEXF,
Pajek, UCINET DL, DOT) should still be checked against their current specs before any of
§1's sketches is turned into a parser** — only the node-link JSON one has been.

Verified online (2026-09-05): the NetworkX `node_link_data` reference pages for 3.1 / 3.6.1
and the `networkx/networkx` issue #8611 thread (the `links`→`edges` history); the SNAP
`ca-GrQc` and `ego-Facebook` dataset pages (N, E, and Facebook's max degree); the Zachary
karate club figures (max degree 17).

Measured numbers in §3.1 and §3.4 were produced by two Node scratch scripts (a metric-cost
benchmark and an ELLPACK/capacity calculation) run against the real `GraphMetricView` data
shape; they are reproducible from the tables' parameters.

In-repo cross-references: [INVESTIGATION_GRAPH_CA.md](INVESTIGATION_GRAPH_CA.md) §2.8
(CSR vs ELLPACK, the hub/load-balancing problem, and why a *lattice*-side graph mode
reached a different conclusion), [IMPACT_MAP_GRAPH_REWRITING_AGENTS.md](IMPACT_MAP_GRAPH_REWRITING_AGENTS.md)
§5 (invariants I1–I7), [INVESTIGATION_GEOSPATIAL_IO.md](INVESTIGATION_GEOSPATIAL_IO.md)
(the importer precedent this plan copies), `CLAUDE.md`'s "Graph-Rewriting Automata
(GRA)", "Bond-Graph Agents", "Agent Capability Profiles" and "CSV Import" sections, and the
sibling brainstorm [INVESTIGATION_NEURAL_NETWORKS.md](INVESTIGATION_NEURAL_NETWORKS.md)
(whose "standalone network as agents + bonds" shape is exactly this document's import
target, and whose Graph-NCA section reuses §3.6's directed-edge idiom).
