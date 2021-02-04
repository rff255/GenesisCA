#pragma once

#include <algorithm>
#include <math.h>
#include <random>
#include <time.h>
#include <vector>
#include <string>

using std::vector;
using std::string;
using std::pair;

namespace Genesis {

// Typedefs mapping attribute types into C++ types
typedef bool Bool;
typedef int Integer;
typedef float Float;

typedef Bool died_alone_TYPE;
typedef Integer Trail_Intensity_TYPE;
typedef Float Trail_Intensity_Factor_TYPE;
typedef Float BRUSH_PROBABILITY_TYPE;
typedef Bool Alive_TYPE;
typedef Integer Trail_Length_TYPE;

class CACell;
class CAModel;
// Cell Declaration
class CACell {
 public:
CACell(){
  Clear();
}
~CACell(){}
void Clear(){
  ATTR_died_alone = 0;
  ATTR_Trail_Intensity = 0;
  ATTR_Alive = 0;
  VIEWER_Alive_with_trails[0] = 0;
  VIEWER_Alive_with_trails[1] = 0;
  VIEWER_Alive_with_trails[2] = 0;
}
void CopyPrevCellConfig();
void DefaultInit();
void InputColor_Set_Alive(int red, int green, int blue);
void Step();

died_alone_TYPE Getdied_alone() {return this->ATTR_died_alone;}
Trail_Intensity_TYPE GetTrail_Intensity() {return this->ATTR_Trail_Intensity;}
Alive_TYPE GetAlive() {return this->ATTR_Alive;}
void GetViewerAlive_with_trails(int* outColor) {outColor[0] = VIEWER_Alive_with_trails[0]; outColor[1] = VIEWER_Alive_with_trails[1]; outColor[2] = VIEWER_Alive_with_trails[2];}
void Setdied_alone(died_alone_TYPE val) {this->ATTR_died_alone = val;}
void SetTrail_Intensity(Trail_Intensity_TYPE val) {this->ATTR_Trail_Intensity = val;}
void SetAlive(Alive_TYPE val) {this->ATTR_Alive = val;}

CACell* prevCell;
CAModel* CAModel;
died_alone_TYPE ATTR_died_alone;
Trail_Intensity_TYPE ATTR_Trail_Intensity;
Alive_TYPE ATTR_Alive;
vector<CACell*> NEIGHBORS_Moore;
int VIEWER_Alive_with_trails[3];
};

// Model Declaration
class CAModel {
 public:
  CAModel();
  ~CAModel();

  // Init (defines the dimensions of grid, allocate memory and initiate the cells)
  void Init(int width, int height);

  // Get for each Cell Attribute
  void Getdied_alone(died_alone_TYPE* outValues);
  void GetTrail_Intensity(Trail_Intensity_TYPE* outValues);
  void GetAlive(Alive_TYPE* outValues);

  // Set for each Cell Attribute
  void Setdied_alone(died_alone_TYPE* values);
  void SetTrail_Intensity(Trail_Intensity_TYPE* values);
  void SetAlive(Alive_TYPE* values);

  // Get for each Model Attribute
  Trail_Intensity_Factor_TYPE GetTrail_Intensity_Factor();
  BRUSH_PROBABILITY_TYPE GetBRUSH_PROBABILITY();
  Trail_Length_TYPE GetTrail_Length();

  // Set for each Model Attribute
  void SetTrail_Intensity_Factor(Trail_Intensity_Factor_TYPE value);
  void SetBRUSH_PROBABILITY(BRUSH_PROBABILITY_TYPE value);
  void SetTrail_Length(Trail_Length_TYPE value);

  // Get for each Viewer
  void GetViewerAlive_with_trails(int* outValues);

  // Load color in one cell for each input color mapping
  void LoadColorCellSet_Alive(int row, int col, int red, int green, int blue);

  // Load color image for each input color mapping
  void LoadColorImageSet_Alive(int* rgbMatrix);

  // Clear
  void Clear();

  // Precompute the neighbors references of each cell
  void PreComputeNeighbors();
  void StepForth(); // One iteration
  void StepBy(int num); // @num iterations
  void StepToEnd(); // Until reach the end
  vector<string> GetModelAttributeNames();
  vector<string> GetInputMappingNames();
  vector<string> GetOutputMappingNames();
  string GetModelAttributeByName(string attrName);
  bool SetModelAttributeByName(string attrName, string value);
  bool GetViewerByName(string viewerName, int* rgbMatrix);
  bool LoadColorImageByName(string initColorName, int* rgbMatrix);
  bool LoadColorCellByName(string initColorName, int row, int col, int r, int g, int b);

  // Simulation variables
  CACell*** currBoard;
  CACell*** prevBoard;
  CACell* defaultCell;
  int CAWidth;
  int CAHeight;

  // Model Properties
  string name;
  string author;
  string goal;
  string description;
  string boundaryType;

  // Model Attributes
  Trail_Intensity_Factor_TYPE ATTR_Trail_Intensity_Factor;
  BRUSH_PROBABILITY_TYPE ATTR_BRUSH_PROBABILITY;
  Trail_Length_TYPE ATTR_Trail_Length;

  // Neighborhood types
  vector<pair<int,int>> NEIGHBORHOOD_Moore;
};

}  // namespace_Genesis
