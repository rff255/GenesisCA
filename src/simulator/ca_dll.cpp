#include "ca_dll.h"

#include <algorithm>
#include <math.h>
#include <random>
#include <time.h>
#include <vector>
#include <string>

using std::vector;
using std::string;
using std::pair;

#define CAINDEX1C(i, j) ((i)*(CAWidth) + (j))
#define CAINDEX3C(i, j) ((i)*(CAWidth)*3 + (j*3))
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

// ### Cell Definitions
void CACell::CopyPrevCellConfig(){
  ATTR_died_alone = prevCell->ATTR_died_alone;
  ATTR_Trail_Intensity = prevCell->ATTR_Trail_Intensity;
  ATTR_Alive = prevCell->ATTR_Alive;
  prevCell->GetViewerAlive_with_trails(VIEWER_Alive_with_trails);
}

void CACell::DefaultInit(){}

// Code of node _BRUSH Set Alive_16
void CACell::InputColor_Set_Alive(int red, int green, int blue){
  int out_r_16_1 = red;
  int out_g_16_2 = green;
  int out_b_16_3 = blue;
  typedef int out_r_16_1_TYPE;
  typedef int out_g_16_2_TYPE;
  typedef int out_b_16_3_TYPE;
  // Code of node _Set Alive_8
  // Code of node _Random (Brush Probability)_23
  bool out_value_23_0 = rand() < this->CAModel->ATTR_BRUSH_PROBABILITY * ((double)RAND_MAX + 1.0);
  typedef bool out_value_23_0_TYPE;
  this->ATTR_Alive = out_value_23_0;
}

// Code of node ___Step___4
void CACell::Step(){
  CopyPrevCellConfig();
  // Code of node _Is Alive?_1
  // Code of node _Current Alive state_35
  Alive_TYPE out_value_35_0 = this->ATTR_Alive;
  typedef Alive_TYPE out_value_35_0_TYPE;
  if(out_value_35_0){
      // Code of node _Must Die?_18
    // Code of node _>3 OR <2_10
    // Code of node _< 2_12
    // Code of node _Number of Alive Neighbors_9
    // Code of node _Neighbors_15
    Alive_TYPE out_values_15_0[8];
    for(int n=0; n<8; ++n)
      out_values_15_0[n] = this->NEIGHBORS_Moore[n]->ATTR_Alive;
    typedef Alive_TYPE* out_values_15_0_TYPE;
    typedef Alive_TYPE out_values_15_0_ELEMENT_TYPE;
    int out_values_15_0_SIZE = 8;
    // Code of node _true_19
    bool out_value_19_0 = true;
    typedef bool out_value_19_0_TYPE;
    int out_result_9_0 = 0;
    for(out_values_15_0_ELEMENT_TYPE elem: out_values_15_0) {
      if(elem == out_value_19_0)
        out_result_9_0++;
    }
    typedef int out_result_9_0_TYPE;
    // Code of node _2  _14
    int out_value_14_0 = 2;
    typedef int out_value_14_0_TYPE;
    bool out_assert_12_0 = (out_result_9_0 < out_value_14_0);
    typedef bool out_assert_12_0_TYPE; 
    // Code of node _> 3_13
    // Code of node _3  _22
    int out_value_22_0 = 3;
    typedef int out_value_22_0_TYPE;
    bool out_assert_13_0 = (out_result_9_0 > out_value_22_0);
    typedef bool out_assert_13_0_TYPE; 
    bool out_result_10_0 = (out_assert_12_0 || out_assert_13_0);
    typedef bool out_result_10_0_TYPE; 
    if(out_result_10_0){
          // Code of node _Alive = false_11
      // Code of node _false_6
      bool out_value_6_0 = false;
      typedef bool out_value_6_0_TYPE;
      this->ATTR_Alive = out_value_6_0;
          // Code of node _Trail = Max_38
      // Code of node _Trail Length_25
      Trail_Length_TYPE out_value_25_0 = this->CAModel->ATTR_Trail_Length;
      typedef Trail_Length_TYPE out_value_25_0_TYPE;
      this->ATTR_Trail_Intensity = out_value_25_0;
          // Code of node _Set Attribute_41
      this->ATTR_died_alone = out_assert_12_0;
    } else {
    }
      // Code of node _VIEW Alive White_24
    this->VIEWER_Alive_with_trails[0] = 255;
    this->VIEWER_Alive_with_trails[1] = 255;
    this->VIEWER_Alive_with_trails[2] = 255;
  } else {
      // Code of node _Must Be Born?_29
    // Code of node _= 3_17
    // Code of node _Number of Alive Neighbors_9
    // Code of node _Neighbors_15
    Alive_TYPE out_values_15_0[8];
    for(int n=0; n<8; ++n)
      out_values_15_0[n] = this->NEIGHBORS_Moore[n]->ATTR_Alive;
    typedef Alive_TYPE* out_values_15_0_TYPE;
    typedef Alive_TYPE out_values_15_0_ELEMENT_TYPE;
    int out_values_15_0_SIZE = 8;
    // Code of node _true_19
    bool out_value_19_0 = true;
    typedef bool out_value_19_0_TYPE;
    int out_result_9_0 = 0;
    for(out_values_15_0_ELEMENT_TYPE elem: out_values_15_0) {
      if(elem == out_value_19_0)
        out_result_9_0++;
    }
    typedef int out_result_9_0_TYPE;
    // Code of node _3  _22
    int out_value_22_0 = 3;
    typedef int out_value_22_0_TYPE;
    bool out_assert_17_0 = (out_result_9_0 == out_value_22_0);
    typedef bool out_assert_17_0_TYPE; 
    if(out_assert_17_0){
          // Code of node _Alive = true_40
      // Code of node _true_7
      bool out_value_7_0 = true;
      typedef bool out_value_7_0_TYPE;
      this->ATTR_Alive = out_value_7_0;
    } else {
    }
      // Code of node _Fading Trail?_2
    // Code of node _> 0_30
    // Code of node _Current Trail_27
    Trail_Intensity_TYPE out_value_27_0 = this->ATTR_Trail_Intensity;
    typedef Trail_Intensity_TYPE out_value_27_0_TYPE;
    // Code of node _0  _28
    int out_value_28_0 = 0;
    typedef int out_value_28_0_TYPE;
    bool out_assert_30_0 = (out_value_27_0 > out_value_28_0);
    typedef bool out_assert_30_0_TYPE; 
    if(out_assert_30_0){
          // Code of node _Trail = Trail-1_20
      // Code of node _Trail-1_31
      // Code of node _1  _37
      int out_value_37_0 = 1;
      typedef int out_value_37_0_TYPE;
      out_value_27_0_TYPE out_result_31_0 = (out_value_27_0 - out_value_37_0);
      typedef out_value_27_0_TYPE out_result_31_0_TYPE; 
      this->ATTR_Trail_Intensity = out_result_31_0;
          // Code of node _Conditional_42
      // Code of node _Get Cell Attribute_39
      died_alone_TYPE out_value_39_0 = this->ATTR_died_alone;
      typedef died_alone_TYPE out_value_39_0_TYPE;
      if(out_value_39_0){
              // Code of node _Set Color Viewer_43
        this->VIEWER_Alive_with_trails[0] = 0;
        this->VIEWER_Alive_with_trails[1] = 0;
        this->VIEWER_Alive_with_trails[2] = 0;
        // Code of node _Trail color component strength_0
        // Code of node _Max_component/Trail_Length_33
        // Code of node _Trail Max Color component_21
        // Code of node _Trail Intensity Factor_34
        Trail_Intensity_Factor_TYPE out_value_34_0 = this->CAModel->ATTR_Trail_Intensity_Factor;
        typedef Trail_Intensity_Factor_TYPE out_value_34_0_TYPE;
        // Code of node _255_36
        int out_value_36_0 = 255;
        typedef int out_value_36_0_TYPE;
        out_value_34_0_TYPE out_result_21_0 = (out_value_34_0 * out_value_36_0);
        typedef out_value_34_0_TYPE out_result_21_0_TYPE; 
        // Code of node _Trail Length_5
        Trail_Length_TYPE out_value_5_0 = this->CAModel->ATTR_Trail_Length;
        typedef Trail_Length_TYPE out_value_5_0_TYPE;
        out_result_21_0_TYPE out_result_33_0 = (out_result_21_0 / out_value_5_0);
        typedef out_result_21_0_TYPE out_result_33_0_TYPE; 
        out_result_31_0_TYPE out_result_0_0 = (out_result_31_0 * out_result_33_0);
        typedef out_result_31_0_TYPE out_result_0_0_TYPE; 
        this->VIEWER_Alive_with_trails[0] = static_cast<int>(out_result_0_0);
        // Code of node _0  _26
        int out_value_26_0 = 0;
        typedef int out_value_26_0_TYPE;
        this->VIEWER_Alive_with_trails[1] = static_cast<int>(out_value_26_0);
        this->VIEWER_Alive_with_trails[2] = static_cast<int>(out_value_26_0);
      } else {
              // Code of node _VIEW Alive Trail_32
        // Code of node _Trail color component strength_0
        // Code of node _Max_component/Trail_Length_33
        // Code of node _Trail Max Color component_21
        // Code of node _Trail Intensity Factor_34
        Trail_Intensity_Factor_TYPE out_value_34_0 = this->CAModel->ATTR_Trail_Intensity_Factor;
        typedef Trail_Intensity_Factor_TYPE out_value_34_0_TYPE;
        // Code of node _255_36
        int out_value_36_0 = 255;
        typedef int out_value_36_0_TYPE;
        out_value_34_0_TYPE out_result_21_0 = (out_value_34_0 * out_value_36_0);
        typedef out_value_34_0_TYPE out_result_21_0_TYPE; 
        // Code of node _Trail Length_5
        Trail_Length_TYPE out_value_5_0 = this->CAModel->ATTR_Trail_Length;
        typedef Trail_Length_TYPE out_value_5_0_TYPE;
        out_result_21_0_TYPE out_result_33_0 = (out_result_21_0 / out_value_5_0);
        typedef out_result_21_0_TYPE out_result_33_0_TYPE; 
        out_result_31_0_TYPE out_result_0_0 = (out_result_31_0 * out_result_33_0);
        typedef out_result_31_0_TYPE out_result_0_0_TYPE; 
        this->VIEWER_Alive_with_trails[0] = static_cast<int>(out_result_0_0);
        this->VIEWER_Alive_with_trails[1] = static_cast<int>(out_result_0_0);
        // Code of node _0  _26
        int out_value_26_0 = 0;
        typedef int out_value_26_0_TYPE;
        this->VIEWER_Alive_with_trails[2] = static_cast<int>(out_value_26_0);
      }
    } else {
          // Code of node _VIEW Alive black_3
      this->VIEWER_Alive_with_trails[0] = 0;
      this->VIEWER_Alive_with_trails[1] = 0;
      this->VIEWER_Alive_with_trails[2] = 0;
    }
  }
}

// ### Model Definitions
CAModel::CAModel() {
  std::srand(time(NULL));
  this->name = "Game of Life";
  this->author = "John Conway";
  this->goal = "Explore emergent behaviors on simple CAs";
  this->description = "";
  this->boundaryType = "Torus";

  this->ATTR_Trail_Intensity_Factor = 0.700000;
  this->ATTR_BRUSH_PROBABILITY = 0.500000;
  this->ATTR_Trail_Length = 80;

  // Moore
  this->NEIGHBORHOOD_Moore.push_back(pair<int,int>(-1, -1));
  this->NEIGHBORHOOD_Moore.push_back(pair<int,int>(-1, 0));
  this->NEIGHBORHOOD_Moore.push_back(pair<int,int>(-1, 1));
  this->NEIGHBORHOOD_Moore.push_back(pair<int,int>(0, -1));
  this->NEIGHBORHOOD_Moore.push_back(pair<int,int>(0, 1));
  this->NEIGHBORHOOD_Moore.push_back(pair<int,int>(1, -1));
  this->NEIGHBORHOOD_Moore.push_back(pair<int,int>(1, 0));
  this->NEIGHBORHOOD_Moore.push_back(pair<int,int>(1, 1));

  this->defaultCell = new CACell();
  this->defaultCell->CAModel = this;
  this->defaultCell->DefaultInit();
  CAWidth = 0;
  CAHeight = 0;
}

CAModel::~CAModel() {
  delete this->defaultCell;
  for (int i = 0; i < CAHeight; ++i){
    delete [] currBoard[i];
    delete [] prevBoard[i];
  }
  delete [] currBoard;
  delete [] prevBoard;
}
void CAModel::Init(int width, int height) {
  CAWidth  = width;
  CAHeight = height;
  // First allocate the boards cells
  this->currBoard = new CACell**[CAHeight];
  for (int i = 0; i < CAHeight; ++i)
      currBoard[i] = new CACell*[CAWidth];

  this->prevBoard = new CACell**[CAHeight];
  for (int i = 0; i < CAHeight; ++i)
      prevBoard[i] = new CACell*[CAWidth];

  // Then create each cell
  for (int i = 0; i < CAHeight; ++i)
    for (int j = 0; j < CAWidth; ++j) {
      currBoard[i][j] = new CACell();
      prevBoard[i][j] = new CACell();
    }

  // Finally, compute the neighborhood references for each cell, and call the default init
  PreComputeNeighbors();
  for (int i = 0; i < CAHeight; ++i)
    for (int j = 0; j < CAWidth; ++j) {
      currBoard[i][j]->DefaultInit();
      prevBoard[i][j]->DefaultInit();
    }
}

void CAModel::Getdied_alone(died_alone_TYPE* outValues) {
  for (int i = 0; i < CAHeight; ++i)
    for (int j = 0; j < CAWidth; ++j) {
      outValues[CAINDEX1C(i, j)] = prevBoard[i][j]->Getdied_alone();
    }
}
void CAModel::GetTrail_Intensity(Trail_Intensity_TYPE* outValues) {
  for (int i = 0; i < CAHeight; ++i)
    for (int j = 0; j < CAWidth; ++j) {
      outValues[CAINDEX1C(i, j)] = prevBoard[i][j]->GetTrail_Intensity();
    }
}
void CAModel::GetAlive(Alive_TYPE* outValues) {
  for (int i = 0; i < CAHeight; ++i)
    for (int j = 0; j < CAWidth; ++j) {
      outValues[CAINDEX1C(i, j)] = prevBoard[i][j]->GetAlive();
    }
}

void CAModel::Setdied_alone(died_alone_TYPE* values) {
  for (int i = 0; i < CAHeight; ++i)
    for (int j = 0; j < CAWidth; ++j) {
      currBoard[i][j]->Setdied_alone(values[CAINDEX1C(i, j)]);
      prevBoard[i][j]->Setdied_alone(values[CAINDEX1C(i, j)]);
    }
}
void CAModel::SetTrail_Intensity(Trail_Intensity_TYPE* values) {
  for (int i = 0; i < CAHeight; ++i)
    for (int j = 0; j < CAWidth; ++j) {
      currBoard[i][j]->SetTrail_Intensity(values[CAINDEX1C(i, j)]);
      prevBoard[i][j]->SetTrail_Intensity(values[CAINDEX1C(i, j)]);
    }
}
void CAModel::SetAlive(Alive_TYPE* values) {
  for (int i = 0; i < CAHeight; ++i)
    for (int j = 0; j < CAWidth; ++j) {
      currBoard[i][j]->SetAlive(values[CAINDEX1C(i, j)]);
      prevBoard[i][j]->SetAlive(values[CAINDEX1C(i, j)]);
    }
}

Trail_Intensity_Factor_TYPE CAModel::GetTrail_Intensity_Factor() {
  return this->ATTR_Trail_Intensity_Factor;
}
BRUSH_PROBABILITY_TYPE CAModel::GetBRUSH_PROBABILITY() {
  return this->ATTR_BRUSH_PROBABILITY;
}
Trail_Length_TYPE CAModel::GetTrail_Length() {
  return this->ATTR_Trail_Length;
}

void CAModel::SetTrail_Intensity_Factor(Trail_Intensity_Factor_TYPE value) {
  this->ATTR_Trail_Intensity_Factor = value;
}
void CAModel::SetBRUSH_PROBABILITY(BRUSH_PROBABILITY_TYPE value) {
  this->ATTR_BRUSH_PROBABILITY = value;
}
void CAModel::SetTrail_Length(Trail_Length_TYPE value) {
  this->ATTR_Trail_Length = value;
}

void CAModel::GetViewerAlive_with_trails(int* outValues) {
  for (int i = 0; i < CAHeight; ++i)
    for (int j = 0; j < CAWidth; ++j)
      prevBoard[i][j]->GetViewerAlive_with_trails(&outValues[CAINDEX3C(i,j)]);
}

void CAModel::LoadColorCellSet_Alive(int row, int col, int red, int green, int blue) {
  currBoard[row][col]->InputColor_Set_Alive(red, green, blue);
  prevBoard[row][col]->InputColor_Set_Alive(red, green, blue);
}

void CAModel::LoadColorImageSet_Alive(int* rgbMatrix) {
  for (int i = 0; i < CAHeight; ++i)
    for (int j = 0; j < CAWidth; ++j) {
      currBoard[i][j]->InputColor_Set_Alive(rgbMatrix[CAINDEX3C(i, j)+0], rgbMatrix[CAINDEX3C(i, j)+1], rgbMatrix[CAINDEX3C(i, j)+2]);
      prevBoard[i][j]->InputColor_Set_Alive(rgbMatrix[CAINDEX3C(i, j)+0], rgbMatrix[CAINDEX3C(i, j)+1], rgbMatrix[CAINDEX3C(i, j)+2]);
    }
}

void CAModel::Clear() {
  for (int i = 0; i < CAHeight; ++i)
    for (int j = 0; j < CAWidth; ++j) {
      currBoard[i][j]->Clear();
      prevBoard[i][j]->Clear();
      currBoard[i][j]->DefaultInit();
      prevBoard[i][j]->DefaultInit();
    }
}

void CAModel::PreComputeNeighbors() {
  for (int i = 0; i < CAHeight; ++i)
    for (int j = 0; j < CAWidth; ++j) {
      currBoard[i][j]->prevCell = prevBoard[i][j];
      prevBoard[i][j]->prevCell = currBoard[i][j];
      currBoard[i][j]->CAModel  = this;
      prevBoard[i][j]->CAModel  = this;

      // Moore user-defined neighborhood
      for(int n=0; n < NEIGHBORHOOD_Moore.size(); ++n) {
         int rowIndex = (i + NEIGHBORHOOD_Moore[n].first);
         int colIndex = (j + NEIGHBORHOOD_Moore[n].second);
         // Border treatment
         if(rowIndex < 0 || rowIndex >= CAHeight || colIndex < 0 || colIndex >= CAWidth) {
           if(this->boundaryType == "Torus") {
             rowIndex = rowIndex<0 ? CAHeight+rowIndex%CAHeight : rowIndex%CAHeight;
             colIndex = colIndex<0 ? CAWidth+colIndex%CAWidth : colIndex%CAWidth;
             currBoard[i][j]->NEIGHBORS_Moore.push_back(prevBoard[rowIndex][colIndex]);
             prevBoard[i][j]->NEIGHBORS_Moore.push_back(currBoard[rowIndex][colIndex]);
           } else {
             prevBoard[i][j]->NEIGHBORS_Moore.push_back(this->defaultCell);
             currBoard[i][j]->NEIGHBORS_Moore.push_back(this->defaultCell);
           }
         } else {
           currBoard[i][j]->NEIGHBORS_Moore.push_back(prevBoard[rowIndex][colIndex]);
           prevBoard[i][j]->NEIGHBORS_Moore.push_back(currBoard[rowIndex][colIndex]);
         }
      }
    }
}

vector<string> CAModel::GetModelAttributeNames(){
  vector<string> modelAttrNames;
  modelAttrNames.push_back("Trail_Intensity_Factor");
  modelAttrNames.push_back("BRUSH_PROBABILITY");
  modelAttrNames.push_back("Trail_Length");
  
return modelAttrNames;
}

vector<string> CAModel::GetInputMappingNames(){
  vector<string> inputMappingNames;
  inputMappingNames.push_back("Set_Alive");
  
return inputMappingNames;
}

vector<string> CAModel::GetOutputMappingNames(){
  vector<string> outputMappingNames;
  outputMappingNames.push_back("Alive_with_trails");
  
return outputMappingNames;
}


string CAModel::GetModelAttributeByName(string attribute){
  if(attribute == "Trail_Intensity_Factor")
    return std::to_string(this->ATTR_Trail_Intensity_Factor);
  if(attribute == "BRUSH_PROBABILITY")
    return std::to_string(this->ATTR_BRUSH_PROBABILITY);
  if(attribute == "Trail_Length")
    return std::to_string(this->ATTR_Trail_Length);
  return "";
}

bool CAModel::SetModelAttributeByName(string attrName, string value){
  if(attrName == "Trail_Intensity_Factor"){
    this->ATTR_Trail_Intensity_Factor = std::stof(value);
    return true;
  }
  if(attrName == "BRUSH_PROBABILITY"){
    this->ATTR_BRUSH_PROBABILITY = std::stof(value);
    return true;
  }
  if(attrName == "Trail_Length"){
    this->ATTR_Trail_Length = std::stoi(value);
    return true;
  }
  return false;
}

bool CAModel::GetViewerByName(string viewerName, int* rgbMatrix){
  if(viewerName == "Alive_with_trails"){
    GetViewerAlive_with_trails(rgbMatrix);
    return true;
  }
  return false;
}

bool CAModel::LoadColorImageByName(string initColorName, int* rgbMatrix){
  if(initColorName == "Set_Alive"){
    LoadColorImageSet_Alive(rgbMatrix);
    return true;
  }
  return false;
}

bool CAModel::LoadColorCellByName(string initColorName, int row, int col, int r, int g, int b){
  if(initColorName == "Set_Alive"){
    LoadColorCellSet_Alive(row, col, r, g, b);
    return true;
  }
  return false;
}

void CAModel::StepForth() {
  for (int i = 0; i < CAHeight; ++i)
    for (int j = 0; j < CAWidth; ++j) {
      currBoard[i][j]->Step();
    }

  // Switch the boards -just like the double buffer opengl drawing
  std::swap(currBoard, prevBoard);
}

void CAModel::StepBy(int num){
  for(int i=0; i<num; ++i)
    StepForth();
}

void CAModel::StepToEnd() {
  while(true)
    StepForth();
}

}  // namespace_Genesis
#undef CAINDEX1C
#undef CAINDEX3C
