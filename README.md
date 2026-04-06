## What GenesisCA Is

GenesisCA is an IDE for modeling and simulating Cellular Automata (CA). It uses a Visual Programming Language (VPL) — a node-based graph editor — so users can design arbitrarily complex CA models without writing code. The goals are **accessibility** (no programming required) and **performance** (grids up to 5000×5000+).

---

## The GenesisCA Model Definition

### Six Fundamentals

Every GenesisCA model satisfies these theoretical properties:

1. Cells have unlimited computing power
2. Cells have N internal attributes (of multiple data types), whose snapshot of values at a given generation is called its "state"
3. Cells are limited to only access (read) the states of cells in one of the neighborhoods defined in the CA model
4. Cells can only make changes to itself, never to the environment around (other cells)
5. Space and Time are discrete (cells arranged in n-dimensional grid)
6. All cells update their states simultaneously (synchronously) each passing generation

### Simulation Essentials (Color Mappings)

Beyond the six fundamentals, two types of mappings enable visualization and interaction:

1. **Attribute-Color Mappings** — N ways to map cell state → colors (for visualization)
2. **Color-Attribute Mappings** — N ways to map colors → cell state (for user interaction and image-based initialization)

### Model Structure

A complete GenesisCA model definition consists of:

1. **Model Properties**
   - 1.1. Presentation (Name, Author, Goal, Description...)
   - 1.2. Structure (Topology, Boundary Treatment, Grid Size...)
   - 1.3. Execution
     - 1.3.1. Initial Configuration (Attribute Initialization Mapping, Default Attribute Values)
     - 1.3.2. Stop Conditions (Max of Iterations, Break Cases)

2. **Attributes** — each has a name, type (bool, integer, float, list, tag), description, and type-specific properties (integer range, list size, tag options...)
   - 2.1. Cell Attributes (per-cell state)
   - 2.2. Model Attributes (global read-only parameters that all cells can access but not write; can be changed during simulation externally)

3. **Neighborhoods** — a list of neighborhoods, each being a list of N indexes relative to the central cell, a name, a description, and optionally tags for specific indexes (for easy reference in Update Rules)

4. **Color Mappings** — each mapping has a Name, Description, per-channel descriptions (R, G, B)
   - 4.1. Color-Attribute Mappings (input: for initialization and real-time interaction)
   - 4.2. Attribute-Color Mappings (output: for visualization modes)

5. **Update Rules** — a node graph defining what each cell computes per generation. The graph handles multiple event types:
   - Each Attribute Initialization Mapping event
   - New generation (the main update step)
   - Each Color-to-Attribute interaction event
   - When/how to update each Attribute-to-Color mapping

---

## Repository Context

This repository originally contained a Qt/C++ desktop application built in 2017 as an undergrad final project (Universidade Federal de Pernambuco). **The current work is a complete rewrite.** The legacy Qt/C++ code has been preserved in the `legacy_qt_cpp_solution` branch, frozen as historical reference — a qmake project with `src/modeler` and `src/simulator` subdirectories, DearImGui-based node editor, and C++ code generation for model export.

The old implementation in `legacy_qt_cpp_solution` serves as architectural reference. Key file for understanding the old compilation approach: `src/modeler/UpdateRulesHandler/node_graph_instance.h` — each node had an `Eval()` method that emitted C++ code snippets, stitched together into `.h`/`.cpp` files, then compiled to `.dll`/`.exe`. The new version follows the same pattern but targets JavaScript instead of C++.

-------------
  
Some **LEGACY** WIP images (of the application in `legacy_qt_cpp_solution`):
-------------

  The current set of nodes:
![genesis all new nodes](https://cloud.githubusercontent.com/assets/9446331/25600631/03727424-2ebc-11e7-804f-ee7f1b2d8906.PNG)

Following The current state of the main tabs.

-**Model Properties**:
![globalpropertiestab_example](https://cloud.githubusercontent.com/assets/9446331/25601003/fbef34a0-2ebe-11e7-8f26-15c910000457.PNG)

-**Attributes** (Cell and Model):
![attributestab_example](https://cloud.githubusercontent.com/assets/9446331/25601066/9620aaae-2ebf-11e7-8f6e-43b5a711ea42.PNG)

-**Vicinities** (for now, only centered neighborhoods, no partitions):
![vicinitiestab_example](https://cloud.githubusercontent.com/assets/9446331/25601069/9ab87b14-2ebf-11e7-89bc-3dab321e89d0.PNG)

-**Mappings** - behavior defined on graph editor (Input, for allow load the configuration of the cells from an image or interact during execution; and Output, for visualizing and debugging purposes):
![mappingstab_example](https://cloud.githubusercontent.com/assets/9446331/25601071/a339f268-2ebf-11e7-99ce-edb0352e8426.PNG)

-Example of update rule graph (classical _Game of Life_):
![gol on genesis](https://cloud.githubusercontent.com/assets/9446331/25601100/e3d2aedc-2ebf-11e7-9964-355b21733ced.PNG)
