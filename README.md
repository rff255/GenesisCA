# GenesisCA 
- IDE for modeling and simulation of Cellular Automata (CA)
- Focused on creation and evaluation of new CA models, by experimentation
- Based on Visual Programming Language (VPL) to define the rules
- First version will contain support to define CA models with:
  - **Cell attributes types:** [Bool, Integer, Float]  
	> Cell attributes define the informations each cell is holding.
  - **Model attributes types:** [Bool, Integer, Float] 
	> Model attributes define the parameters of CA model used on cell update rules that can be tuned when used the exported CA model.
  - **Neighborhood:** 
	> User is free to define the number of neighborhoods, and it's layout
  - **Rule definitions:** 
	> User design your own algorithm using VPL, to defines the way attributes updated, input colors are interpreted, and output colors are modified.
  - **Color input mapping:**
	> User can create mappings for define what to do with the cell attributes given a color. This can be used to allow image initializations, as well as interactions at simulation time.
  - **Color output mapping:**
	> User is able to creates different modes of visualization, mapping the cell attribute configurations into colors. This could be userful for debugging, presenting, or artistic purposes.
-------------
  
Some WIP images:
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
