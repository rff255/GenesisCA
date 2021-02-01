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

  typedef Bool state_TYPE;
  typedef Float prob_TYPE;

  // ### Cell Definitions
  void CACell::CopyPrevCellConfig(){
    ATTR_state = prevCell->ATTR_state;
    prevCell->GetViewerdefault_exhibition(VIEWER_default_exhibition);
  }

  // Code of node _Default Initialization_15
  void CACell::DefaultInit(){
    //CopyPrevCellConfig();
    // Code of node _Set Attribute_17
    // Code of node _Get Constant_18
    bool out_value_18_0 = false;
    typedef bool out_value_18_0_TYPE;
    this->ATTR_state = out_value_18_0;
  }

  // Code of node _Input Color_20
  void CACell::InputColor_default(int red, int green, int blue){
    int out_r_20_1 = red;
    int out_g_20_2 = green;
    int out_b_20_3 = blue;
    typedef int out_r_20_1_TYPE;
    typedef int out_g_20_2_TYPE;
    typedef int out_b_20_3_TYPE;
    // Code of node _Set Attribute_22
    // Code of node _Statement_25
    // Code of node _zero_27
    int out_value_27_0 = 0;
    typedef int out_value_27_0_TYPE;
    bool out_assert_25_0 = (out_r_20_1 > out_value_27_0);
    typedef bool out_assert_25_0_TYPE;
    this->ATTR_state = out_assert_25_0;
  }

  // Code of node ___Step___0
  void CACell::Step(){
    CopyPrevCellConfig();
    // Code of node _Sequence_9
    // Code of node _Conditional_5
    // Code of node _Get Random_3
    bool out_value_3_0 = rand() < this->CAModel->ATTR_prob * ((double)RAND_MAX + 1.0);
    typedef bool out_value_3_0_TYPE;
    if (out_value_3_0){
      // Code of node _Set Attribute_1
      // Code of node _Logic Operator_4
      // Code of node _Get Cell Attribute_2
      state_TYPE out_value_2_0 = this->ATTR_state;
      typedef state_TYPE out_value_2_0_TYPE;
      bool out_result_4_0 = (!out_value_2_0);
      typedef bool out_result_4_0_TYPE;
      this->ATTR_state = out_result_4_0;
    }
    else {
    }

    // Code of node _Conditional_12
    // Code of node _Get Cell Attribute_11
    state_TYPE out_value_11_0 = this->ATTR_state;
    typedef state_TYPE out_value_11_0_TYPE;
    if (out_value_11_0){
      // Code of node _Set Color Viewer_8
      this->VIEWER_default_exhibition[0] = 0;
      this->VIEWER_default_exhibition[1] = 0;
      this->VIEWER_default_exhibition[2] = 0;
    }
    else {
      // Code of node _Set Color Viewer_14
      this->VIEWER_default_exhibition[0] = 127;
      this->VIEWER_default_exhibition[1] = 177;
      this->VIEWER_default_exhibition[2] = 132;
    }
  }

  // ### Model Definitions
  CAModel::CAModel() {
    std::srand(time(NULL));
    this->name = "asd";
    this->author = "asd";
    this->goal = "";
    this->description = "";
    this->boundaryType = "Constant";

    this->ATTR_prob = 0.010000;

    // moore
    this->NEIGHBORHOOD_moore.push_back(pair<int, int>(-1, -1));
    this->NEIGHBORHOOD_moore.push_back(pair<int, int>(-1, 0));
    this->NEIGHBORHOOD_moore.push_back(pair<int, int>(-1, 1));
    this->NEIGHBORHOOD_moore.push_back(pair<int, int>(0, -1));
    this->NEIGHBORHOOD_moore.push_back(pair<int, int>(0, 1));
    this->NEIGHBORHOOD_moore.push_back(pair<int, int>(1, -1));
    this->NEIGHBORHOOD_moore.push_back(pair<int, int>(1, 0));
    this->NEIGHBORHOOD_moore.push_back(pair<int, int>(1, 1));

    this->defaultCell = new CACell();
    this->defaultCell->CAModel = this;
    this->defaultCell->DefaultInit();
    CAWidth = 0;
    CAHeight = 0;
  }

  CAModel::~CAModel() {
    delete this->defaultCell;
    for (int i = 0; i < CAHeight; ++i){
      delete[] currBoard[i];
      delete[] prevBoard[i];
    }
    delete[] currBoard;
    delete[] prevBoard;
  }
  void CAModel::Init(int width, int height) {
    CAWidth = width;
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

  void CAModel::Getstate(state_TYPE* outValues) {
    for (int i = 0; i < CAHeight; ++i)
    for (int j = 0; j < CAWidth; ++j) {
      outValues[CAINDEX1C(i, j)] = prevBoard[i][j]->Getstate();
    }
  }

  void CAModel::Setstate(state_TYPE* values) {
    for (int i = 0; i < CAHeight; ++i)
    for (int j = 0; j < CAWidth; ++j) {
      currBoard[i][j]->Setstate(values[CAINDEX1C(i, j)]);
      prevBoard[i][j]->Setstate(values[CAINDEX1C(i, j)]);
    }
  }

  prob_TYPE CAModel::Getprob() {
    return this->ATTR_prob;
  }

  void CAModel::Setprob(prob_TYPE value) {
    this->ATTR_prob = value;
  }

  void CAModel::GetViewerdefault_exhibition(int* outValues) {
    for (int i = 0; i < CAHeight; ++i)
    for (int j = 0; j < CAWidth; ++j)
      prevBoard[i][j]->GetViewerdefault_exhibition(&outValues[CAINDEX3C(i, j)]);
  }

  void CAModel::LoadColorCelldefault(int row, int col, int red, int green, int blue) {
    currBoard[row][col]->InputColor_default(red, green, blue);
    prevBoard[row][col]->InputColor_default(red, green, blue);
  }

  void CAModel::LoadColorImagedefault(int* rgbMatrix) {
    for (int i = 0; i < CAHeight; ++i)
    for (int j = 0; j < CAWidth; ++j) {
      currBoard[i][j]->InputColor_default(rgbMatrix[CAINDEX3C(i, j) + 0], rgbMatrix[CAINDEX3C(i, j) + 1], rgbMatrix[CAINDEX3C(i, j) + 2]);
      prevBoard[i][j]->InputColor_default(rgbMatrix[CAINDEX3C(i, j) + 0], rgbMatrix[CAINDEX3C(i, j) + 1], rgbMatrix[CAINDEX3C(i, j) + 2]);
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
      currBoard[i][j]->CAModel = this;
      prevBoard[i][j]->CAModel = this;

      // moore user-defined neighborhood
      for (int n = 0; n < NEIGHBORHOOD_moore.size(); ++n) {
        int rowIndex = (i + NEIGHBORHOOD_moore[n].first);
        int colIndex = (j + NEIGHBORHOOD_moore[n].second);
        // Border treatment
        if (rowIndex < 0 || rowIndex >= CAHeight || colIndex < 0 || colIndex >= CAWidth) {
          if (this->boundaryType == "Torus") {
            rowIndex = rowIndex<0 ? CAHeight + rowIndex%CAHeight : rowIndex%CAHeight;
            colIndex = colIndex<0 ? CAWidth + colIndex%CAWidth : colIndex%CAWidth;
            currBoard[i][j]->NEIGHBORS_moore.push_back(prevBoard[rowIndex][colIndex]);
            prevBoard[i][j]->NEIGHBORS_moore.push_back(currBoard[rowIndex][colIndex]);
          }
          else {
            prevBoard[i][j]->NEIGHBORS_moore.push_back(this->defaultCell);
            currBoard[i][j]->NEIGHBORS_moore.push_back(this->defaultCell);
          }
        }
        else {
          currBoard[i][j]->NEIGHBORS_moore.push_back(prevBoard[rowIndex][colIndex]);
          prevBoard[i][j]->NEIGHBORS_moore.push_back(currBoard[rowIndex][colIndex]);
        }
      }
    }
  }

  vector<string> CAModel::GetModelAttributeNames(){
    vector<string> modelAttrNames;
    modelAttrNames.push_back("prob");

    return modelAttrNames;
  }

  vector<string> CAModel::GetInputMappingNames(){
    vector<string> inputMappingNames;
    inputMappingNames.push_back("default");

    return inputMappingNames;
  }

  vector<string> CAModel::GetOutputMappingNames(){
    vector<string> outputMappingNames;
    outputMappingNames.push_back("default_exhibition");

    return outputMappingNames;
  }


  string CAModel::GetModelAttributeByName(string attribute){
    if (attribute == "prob")
      return std::to_string(this->ATTR_prob);
    return "";
  }

  bool CAModel::SetModelAttributeByName(string attrName, string value){
    if (attrName == "prob"){
      this->ATTR_prob = std::stof(value);
      return true;
    }
    return false;
  }

  bool CAModel::GetViewerByName(string viewerName, int* rgbMatrix){
    if (viewerName == "default_exhibition"){
      GetViewerdefault_exhibition(rgbMatrix);
      return true;
    }
    return false;
  }

  bool CAModel::LoadColorImageByName(string initColorName, int* rgbMatrix){
    if (initColorName == "default"){
      LoadColorImagedefault(rgbMatrix);
      return true;
    }
    return false;
  }

  bool CAModel::LoadColorCellByName(string initColorName, int row, int col, int r, int g, int b){
    if (initColorName == "default"){
      LoadColorCelldefault(row, col, r, g, b);
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
    for (int i = 0; i<num; ++i)
      StepForth();
  }

  void CAModel::StepToEnd() {
    while (true)
      StepForth();
  }
}  // namespace_Genesis
#undef CAINDEX1C
#undef CAINDEX3C
