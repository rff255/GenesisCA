#pragma once

#define CA_DLL
#ifdef CA_DLL
#define CA_DLL_API __declspec(dllexport)
#else
#define CA_DLL_API __declspec(dllimport)
#endif

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

  typedef Bool state_TYPE;
  typedef Float prob_TYPE;

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
      ATTR_state = 0;
      VIEWER_default_exhibition[0] = 0;
      VIEWER_default_exhibition[1] = 0;
      VIEWER_default_exhibition[2] = 0;
    }
    void CopyPrevCellConfig();
    void DefaultInit();
    void InputColor_default(int red, int green, int blue);
    void Step();

    state_TYPE Getstate() { return this->ATTR_state; }
    void GetViewerdefault_exhibition(int* outColor) { outColor[0] = VIEWER_default_exhibition[0]; outColor[1] = VIEWER_default_exhibition[1]; outColor[2] = VIEWER_default_exhibition[2]; }
    void Setstate(state_TYPE val) { this->ATTR_state = val; }

    CACell* prevCell;
    CAModel* CAModel;
    state_TYPE ATTR_state;
    vector<CACell*> NEIGHBORS_moore;
    int VIEWER_default_exhibition[3];
  };

  // Model Declaration
  class CAModel {
  public:
    CAModel();
    ~CAModel();

    // Init (defines the dimensions of grid, allocate memory and initiate the cells)
    void Init(int width, int height);

    // Get for each Cell Attribute
    void Getstate(state_TYPE* outValues);

    // Set for each Cell Attribute
    void Setstate(state_TYPE* values);

    // Get for each Model Attribute
    prob_TYPE Getprob();

    // Set for each Model Attribute
    void Setprob(prob_TYPE value);

    // Get for each Viewer
    void GetViewerdefault_exhibition(int* outValues);

    // Load color in one cell for each input color mapping
    void LoadColorCelldefault(int row, int col, int red, int green, int blue);

    // Load color image for each input color mapping
    void LoadColorImagedefault(int* rgbMatrix);

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
    prob_TYPE ATTR_prob;

    // Neighborhood types
    vector<pair<int, int>> NEIGHBORHOOD_moore;
  };
}  // namespace_Genesis
