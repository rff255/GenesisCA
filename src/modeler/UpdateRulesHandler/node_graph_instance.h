#ifndef NODE_GRAPH_INSTANCE_H
#define NODE_GRAPH_INSTANCE_H

#include <vector>
#include <string>
#include "nodes_editor/imguinodegrapheditor.h"

#include "JSON_nlohmann/json.hpp"

using json = nlohmann::json;

// ############
// #--Warning
// #--This file contains the definitions of Update Rules Editor,
// #-- but the instantiable class is UpdateRulesEditor (at update_rules_editor.h)
// ############

using std::string;

class ITestEnum {
public:
  virtual int& getSelectedItem() = 0;
  virtual ~ITestEnum() {}
};

#ifndef IM_PLACEMENT_NEW
struct ImPlacementNewDummy {};
inline void* operator new(size_t, ImPlacementNewDummy, void* ptr){ return ptr; }
inline void operator delete(void*, ImPlacementNewDummy, void*) {}
#define IM_PLACEMENT_NEW(_PTR)  new(ImPlacementNewDummy(), _PTR)
#endif //IM_PLACEMENT_NEW


// MY DATA STRUCTURE ===============================================================
#define MAX_ENUM_NAME_LENGTH    84                                 // in bytes
typedef ImVector<char[MAX_ENUM_NAME_LENGTH]> TestEnumNamesType;    // so that it works without STL (std::vector<std::string> will be easier to implement)
TestEnumNamesType NGECellAttrNames;
TestEnumNamesType NGEModelAttrNames;
TestEnumNamesType NGENeighborhoodNames;
TestEnumNamesType NGEColAttrMappingNames;
TestEnumNamesType NGEAttrColMappingNames;

// The interface change this, and call UpdateEnumNames
std::vector<std::string> gCellAttrNames;
std::vector<std::string> gModelAttrNames;
std::vector<std::string> gNeighborhoodNames;
std::vector<std::string> gColAttrMappingsNames;
std::vector<std::string> gAttrColMappingsNames;
std::vector<int>         gNeighborhoodSizes;

// Some style options
namespace ImGui {
struct MainStyleOpts {
  // Data providers
  ImColor TitleTextColorOut_DATA = ImColor(0,0,0,255);
  ImColor TitleBgColorOut_DATA   = ImColor(180,0,0,255);
  float   TitleBgColorGradientOut_DATA = 0.1f;

  // Data operators
  ImColor TitleTextColorOut_OPERATE = ImColor(20,20,20,255);
  ImColor TitleBgColorOut_OPERATE   = ImColor(180,180,0,255);
  float   TitleBgColorGradientOut_OPERATE = 0.1f;

  // Control Flow
  ImColor TitleTextColorOut_FLOW = ImColor(200,200,200,255);
  ImColor TitleBgColorOut_FLOW   = ImColor(0,75,0,255);
  float   TitleBgColorGradientOut_FLOW = 0.1f;

  // Logic
  ImColor TitleTextColorOut_LOGIC = ImColor(200,200,200,255);
  ImColor TitleBgColorOut_LOGIC   = ImColor(0,0,75,255);
  float   TitleBgColorGradientOut_LOGIC = 0.1f;
};
}
static ImGui::MainStyleOpts gMainStyle;

void UpdateEnumNames(){
  // Clear current contents
  NGECellAttrNames.clear();
  NGEModelAttrNames.clear();
  NGENeighborhoodNames.clear();
  NGEColAttrMappingNames.clear();
  NGEAttrColMappingNames.clear();

  // Paste from vectors
  //--Cell Attributes
  NGECellAttrNames.resize(gCellAttrNames.size());
  for(int i=0; i<gCellAttrNames.size(); ++i)
    strcpy(&NGECellAttrNames[i][0], gCellAttrNames[i].c_str());

  //--Model Attributes
  NGEModelAttrNames.resize(gModelAttrNames.size());
  for(int i=0; i<gModelAttrNames.size(); ++i)
    strcpy(&NGEModelAttrNames[i][0], gModelAttrNames[i].c_str());

  //--Neighborhoods
  NGENeighborhoodNames.resize(gNeighborhoodNames.size());
  for(int i=0; i<gNeighborhoodNames.size(); ++i)
    strcpy(&NGENeighborhoodNames[i][0], gNeighborhoodNames[i].c_str());

  //--Color_Attribute Mappings
  NGEColAttrMappingNames.resize(gColAttrMappingsNames.size());
  for(int i=0; i<gColAttrMappingsNames.size(); ++i)
    strcpy(&NGEColAttrMappingNames[i][0], gColAttrMappingsNames[i].c_str());

  //--Attribute_Color Mappings
  NGEAttrColMappingNames.resize(gAttrColMappingsNames.size());
  for(int i=0; i<gAttrColMappingsNames.size(); ++i)
    strcpy(&NGEAttrColMappingNames[i][0], gAttrColMappingsNames[i].c_str());
}

bool MustValidate(string nodeHighestScope, string scopeStack){
  std::size_t found = scopeStack.find(nodeHighestScope);
  if(nodeHighestScope == "")
    return true;
  else if (found!=std::string::npos)
    return false;
  else
    return true;
}

// NODE DEFINITIONS ================================================================
namespace ImGui {
enum NodeTypes {
  kStepNode = 0,
  kGetModelAttributeNode,
  kGetCellAttributeNode,
  kGetNeighborsAttributeNode,
  kGetConstantNode,
  kGetRandomNode,
  kStatementNode,
  kLogicOperatorNode,
  kSetAttributeNode,
  kConditionalNode,
  kLoopNode,
  kSequenceNode,
  kArithmeticOperatorNode,
  kGroupStatementNode,
  kGroupOperatorNode,
  kGroupCountingNode,
  kInputColorNode,
  kSetColorViewerNode,
  kDefaultInitializationNode,
  kGetColorViewerNode,
  kGetColorConstantNode,
  kNumNodesTypes
};

static const char* NodeTypeNames[kNumNodesTypes] = {"CONTROL   | Step",
                                                    "DATA      | Get Model Attribute",
                                                    "DATA      | Get Cell Attribute",
                                                    "DATA      | Get Neighbors Attribute",
                                                    "DATA      | Get Constant",
                                                    "DATA      | Get Random",
                                                    "LOGIC     | Statement",
                                                    "OPERATION | Logic Operator",
                                                    "CONTROL   | Set Attribute",
                                                    "CONTROL   | Conditional",
                                                    "CONTROL   | Loop",
                                                    "CONTROL   | Sequence",
                                                    "OPERATION | Arithmetic Operator",
                                                    "LOGIC     | Group Statement",
                                                    "OPERATION | Group Operator",
                                                    "OPERATION | Group Counting",
                                                    "CONTROL   | Init by Color",
                                                    "CONTROL   | Set color viewer",
                                                    "CONTROL   | Default Initialization",
                                                    "DATA      | Get color viewer",
                                                    "DATA      | Get Color Constant"
                                                   };

static bool GetTextFromEnumIndex(void* data, int value, const char** pTxt) {
  if (!pTxt || !data) return false;
  const TestEnumNamesType& vec = *((const TestEnumNamesType*)data);
  *pTxt = (value >= 0 && value<vec.size()) ? vec[value] : "UNKNOWN";
  return true;
}
static int GetNumEnumItems(void* data) {
  if (!data) return 0;
  const TestEnumNamesType& vec = *((const TestEnumNamesType*)data);
  return vec.size();
}

class StepNode : public Node
{
protected:
  typedef Node Base;  //Base Class
  typedef StepNode ThisClass;
  StepNode() : Base() {}
  static const int TYPE = kStepNode;

  virtual const char* getTooltip() const { return "This node mark the start of cell update rule."; }
  virtual const char* getInfo() const { return "This node mark the start of cell update rule.\nBasically defines the the control flow begin of processing."; }
  virtual void getDefaultTitleBarColors(ImU32& defaultTitleTextColorOut,ImU32& defaultTitleBgColorOut,float& defaultTitleBgColorGradientOut) const {
    // [Optional Override] customize Node Title Colors [default values: 0,0,-1.f => do not override == use default values from the Style()]
    defaultTitleTextColorOut = gMainStyle.TitleTextColorOut_FLOW;defaultTitleBgColorOut = gMainStyle.TitleBgColorOut_FLOW;defaultTitleBgColorGradientOut = gMainStyle.TitleBgColorGradientOut_FLOW;
    }

public:
  // create:
  static ThisClass* Create(const ImVec2& pos) {
    // 1) allocation
   ThisClass* node = (ThisClass*)ImGui::MemAlloc(sizeof(ThisClass)); IM_PLACEMENT_NEW(node) ThisClass();

    node->init("__Step__", pos, NULL, "DO", TYPE);
    node->setOpen(false);
    node->mNumFlowPortsOut = 1;

    return node;
  }

protected:
  virtual bool render(float nodeWidth){
    ImGui::Text("Starts the control Flow");
    return false;
  }

  // Evaluate this node returning the code generated
  virtual string Eval(const NodeGraphEditor& nge, int indentLevel, int evalPort = 0, string scope = ""){
    // Begin with the parent eval (a comment indicating the node called)
    string code = Node::Eval(nge, indentLevel);

    // Define the actual level of indentation
    string ind = string(indentLevel*2, ' ');
    this->mScope = "S"+std::to_string(this->mNodeId)+"S";
    //-------------------------------------------------------------

    // Get the information about nodes and so on
    ImVector<Node*> outputNodes = ImVector<Node*>();
    nge.getOutputNodesForNodeAndSlot(this, 0, outputNodes);

    //-------------------------------------------------------------
    // Check if there is a node connected to it
    code += ind+ "void CACell::Step(){\n";
    code += ind+ "  CopyPrevCellConfig();\n";
      if (outputNodes.size() > 0)
        for(Node* outNode:outputNodes)
          code += ind+ outNode->Eval(nge, indentLevel+1, 0, this->mScope);
    code += ind+ "}\n";

    return code;
  }

  // casts:
  inline static ThisClass* Cast(Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
  inline static const ThisClass* Cast(const Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
};

class GetModelAttributeNode : public Node, public ITestEnum
{
protected:
  typedef Node Base;  //Base Class
  typedef GetModelAttributeNode ThisClass;
  GetModelAttributeNode() : Base() {}
  static const int TYPE = kGetModelAttributeNode;

  int mSelectedAttrIndex;       // field

  virtual const char* getTooltip() const { return "This Node returns the value of the selected Model Attribute."; }
  virtual const char* getInfo() const { return "This Node returns the value of the selected Model Attribute for the current cell.\n Be aware of the types involved in the operations."; }
  virtual void getDefaultTitleBarColors(ImU32& defaultTitleTextColorOut,ImU32& defaultTitleBgColorOut,float& defaultTitleBgColorGradientOut) const {
    // [Optional Override] customize Node Title Colors [default values: 0,0,-1.f => do not override == use default values from the Style()]
    defaultTitleTextColorOut = gMainStyle.TitleTextColorOut_DATA;defaultTitleBgColorOut = gMainStyle.TitleBgColorOut_DATA;defaultTitleBgColorGradientOut = gMainStyle.TitleBgColorGradientOut_DATA;
    }

public:
  int& getSelectedItem() { return mSelectedAttrIndex; }  // ITestEnum

  // create:
  static ThisClass* Create(const ImVec2& pos) {
    ThisClass* node = (ThisClass*)ImGui::MemAlloc(sizeof(ThisClass)); IM_PLACEMENT_NEW(node) ThisClass();

    // 2) main init
    node->init("Get Model Attribute", pos, NULL, "value", TYPE);

    // 3) init fields ( this uses the node->fields variable; otherwise we should have overridden other virtual methods (to render and serialize) )
    node->fields.addFieldEnum(&node->mSelectedAttrIndex, &GetNumEnumItems, &GetTextFromEnumIndex, "", "select which attribute must be considered", &NGEModelAttrNames);

    node->mSelectedAttrIndex = 0;

    return node;
  }

  string GetSerializedData() const override {
    json data = {{"mSelectedAttrIndex", mSelectedAttrIndex}};
    return data.dump();
  }

  void SetupFromSerializedData(string serialized_data) override {
    json data = json::parse(serialized_data);
    mSelectedAttrIndex = data["mSelectedAttrIndex"];
  }

protected:
  virtual bool render(float nodeWidth){
    ImGui::Text("Attribute:");
    fields[0].render(nodeWidth);
    return false;
  }

  // Evaluate this node returning the code generated
  virtual string Eval(const NodeGraphEditor& nge, int indentLevel, int evalPort = 0, string scope = ""){
    // Begin with the parent eval (a comment indicating the node called)
    string code = Node::Eval(nge, indentLevel);

    // Define the actual level of indentation
    string ind = string(indentLevel*2, ' ');
    mScope = scope;
    //-------------------------------------------------------------

    // Get the information about nodes and so on

    //-------------------------------------------------------------
    /*
     attrName+"_TYPE" outValueName = this->CAModel->attrName;
     typedef attrName+"_TYPE" outValueName+ "_TYPE";
     */

    // Check if there is a valid attribute
    if (NGEModelAttrNames.size()>0 && NGEModelAttrNames.size()>mSelectedAttrIndex) {
      string attrName     = string(NGEModelAttrNames[mSelectedAttrIndex]);
      string outValueName = "out_" + this->getNameOutSlot(0)+ "_" + std::to_string(this->mNodeId) +"_0";

      code += ind+ attrName +"_TYPE "+ outValueName +" = this->CAModel->ATTR_"+ attrName +";\n";
      code += ind+ "typedef "+ attrName+"_TYPE " + outValueName + "_TYPE;\n";
    }

    return code;
  }

  // casts:
  inline static ThisClass* Cast(Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
  inline static const ThisClass* Cast(const Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
};

class GetCellAttributeNode : public Node, public ITestEnum
{
protected:
  typedef Node Base;  //Base Class
  typedef GetCellAttributeNode ThisClass;
  GetCellAttributeNode() : Base() {}
  static const int TYPE = kGetCellAttributeNode;

  int mSelectedAttrIndex;       // field

  virtual const char* getTooltip() const { return "This Node returns the value of the selected Cell Attribute."; }
  virtual const char* getInfo() const { return "This Node returns the value of the selected Attribute for the current cell\n Be aware of the types involved in the operations!"; }
  virtual void getDefaultTitleBarColors(ImU32& defaultTitleTextColorOut,ImU32& defaultTitleBgColorOut,float& defaultTitleBgColorGradientOut) const {
    // [Optional Override] customize Node Title Colors [default values: 0,0,-1.f => do not override == use default values from the Style()]
    defaultTitleTextColorOut = gMainStyle.TitleTextColorOut_DATA;defaultTitleBgColorOut = gMainStyle.TitleBgColorOut_DATA;defaultTitleBgColorGradientOut = gMainStyle.TitleBgColorGradientOut_DATA;
    }

public:

  int& getSelectedItem() { return mSelectedAttrIndex; }  // ITestEnum

  // create:
  static ThisClass* Create(const ImVec2& pos) {
    // 1) allocation
    // MANDATORY (NodeGraphEditor::~NodeGraphEditor() will delete these with ImGui::MemFree(...))
    // MANDATORY even with blank ctrs. Reason: ImVector does not call ctrs/dctrs on items.
    ThisClass* node = (ThisClass*)ImGui::MemAlloc(sizeof(ThisClass)); IM_PLACEMENT_NEW(node) ThisClass();

    // 2) main init
    node->init("Get Cell Attribute", pos, NULL, "value", TYPE);

    // 3) init fields ( this uses the node->fields variable; otherwise we should have overridden other virtual methods (to render and serialize) )
    node->fields.addFieldEnum(&node->mSelectedAttrIndex, &GetNumEnumItems, &GetTextFromEnumIndex, "", "select which attribute must be considered", &NGECellAttrNames);

    node->mSelectedAttrIndex = 0;

    return node;
  }

  string GetSerializedData() const override {
    json data = {{"mSelectedAttrIndex", mSelectedAttrIndex}};
    return data.dump();
  }

  void SetupFromSerializedData(string serialized_data) override {
    json data = json::parse(serialized_data);
    mSelectedAttrIndex = data["mSelectedAttrIndex"];
  }

protected:
  virtual bool render(float nodeWidth){
    ImGui::Text("Attribute:");
    fields[0].render(nodeWidth);
    return false;
  }

  // Evaluate this node returning the code generated
  virtual string Eval(const NodeGraphEditor& nge, int indentLevel, int evalPort = 0, string scope = ""){
    // Begin with the parent eval (a comment indicating the node called)
    string code = Node::Eval(nge, indentLevel);

    // Define the actual level of indentation
    string ind = string(indentLevel*2, ' ');
    mScope = scope;
    //-------------------------------------------------------------

    // Get the information about nodes and so on

    //-------------------------------------------------------------
    /*
     attrName+"_TYPE" outValueName = this->attrName;
     typedef attrName+"_TYPE" outValueName+ "_TYPE";
     */

    // Check if there is a valid attribute
    if (NGECellAttrNames.size()>0 && NGECellAttrNames.size()>mSelectedAttrIndex) {
      string attrName     = string(NGECellAttrNames[mSelectedAttrIndex]);
      string outValueName = "out_" + this->getNameOutSlot(0)+ "_" + std::to_string(this->mNodeId) +"_0";

      code += ind+ attrName +"_TYPE "+ outValueName +" = this->ATTR_"+ attrName +";\n";
      code += ind+ "typedef "+ attrName+"_TYPE " + outValueName + "_TYPE;\n";
    }

    return code;
  }

  // casts:
  inline static ThisClass* Cast(Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
  inline static const ThisClass* Cast(const Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
};

class GetNeighborsAttributeNode : public Node, public ITestEnum
{
protected:
  typedef Node Base;  //Base Class
  typedef GetNeighborsAttributeNode ThisClass;
  GetNeighborsAttributeNode() : Base() {}
  static const int TYPE = kGetNeighborsAttributeNode;

  // Fields
  int mSelectedNeighborhoodIndex;
  int mSelectedAttrIndex;

  virtual const char* getTooltip() const { return "This Node returns the set of values from attribute neighbors."; }
  virtual const char* getInfo() const { return "This Node returns the set of values from attribute neighbors.\n Remember: it returns the list of values, thus, if the neighborhood has size > 0, the set must be merged before use it in a binary operator \nBe aware of the types involved in the operations!"; }
  virtual void getDefaultTitleBarColors(ImU32& defaultTitleTextColorOut,ImU32& defaultTitleBgColorOut,float& defaultTitleBgColorGradientOut) const {
    // [Optional Override] customize Node Title Colors [default values: 0,0,-1.f => do not override == use default values from the Style()]
    defaultTitleTextColorOut = gMainStyle.TitleTextColorOut_DATA;defaultTitleBgColorOut = gMainStyle.TitleBgColorOut_DATA;defaultTitleBgColorGradientOut = gMainStyle.TitleBgColorGradientOut_DATA;
    }

public:

  int& getSelectedItem() { return mSelectedAttrIndex; }  // ITestEnum

  // create:
  static ThisClass* Create(const ImVec2& pos) {
    ThisClass* node = (ThisClass*)ImGui::MemAlloc(sizeof(ThisClass)); IM_PLACEMENT_NEW(node) ThisClass();

    node->init("Get Neighbors Attribute", pos, NULL, "values", TYPE);

    // 3) init fields ( this uses the node->fields variable; otherwise we should have overridden other virtual methods (to render and serialize) )
    node->fields.addFieldEnum(&node->mSelectedNeighborhoodIndex, &GetNumEnumItems, &GetTextFromEnumIndex, "", "select which neighborhood must be considered", &NGENeighborhoodNames);
    node->fields.addFieldEnum(&node->mSelectedAttrIndex, &GetNumEnumItems, &GetTextFromEnumIndex, "", "select which attribute must be considered", &NGECellAttrNames);

    return node;
  }

  string GetSerializedData() const override {
    json data = {{"mSelectedNeighborhoodIndex", mSelectedNeighborhoodIndex},
                {"mSelectedAttrIndex", mSelectedAttrIndex}};
    return data.dump();
  }

  void SetupFromSerializedData(string serialized_data) override {
    json data = json::parse(serialized_data);
    mSelectedNeighborhoodIndex = data["mSelectedNeighborhoodIndex"];
    mSelectedAttrIndex = data["mSelectedAttrIndex"];
  }

protected:
  virtual bool render(float nodeWidth){
    ImGui::Text("Neighborhood:");
    fields[0].render(nodeWidth);
    ImGui::Text("Attribute:");
    fields[1].render(nodeWidth);
    return false;
  }

  // Evaluate this node returning the code generated
  virtual string Eval(const NodeGraphEditor& nge, int indentLevel, int evalPort = 0, string scope = ""){
    // Begin with the parent eval (a comment indicating the node called)
    string code = Node::Eval(nge, indentLevel);

    // Define the actual level of indentation
    string ind = string(indentLevel*2, ' ');
    mScope = scope;
    //-------------------------------------------------------------

    // Get the information about nodes and so on
    //-------------------------------------------------------------
    /*
     vector<attrName+"_TYPE"> outValuesName;
     for(auto attr: this->neighName)
      outValuesName.push_back(attr->attrName)

     typedef attrName+"_TYPE" outValuesName+ "_TYPE";
     */

    // Check if there is a node connected to value port
    if (NGECellAttrNames.size() > 0 && NGECellAttrNames.size() > mSelectedAttrIndex &&
        NGENeighborhoodNames.size() > 0 && NGENeighborhoodNames.size() > mSelectedNeighborhoodIndex) {
      string attrName      = string(NGECellAttrNames[mSelectedAttrIndex]);
      string neighName     = string(NGENeighborhoodNames[mSelectedNeighborhoodIndex]);
      string outValuesName = "out_" + this->getNameOutSlot(0)+ "_" + std::to_string(this->mNodeId) +"_0";

      code += ind+ attrName+"_TYPE " + outValuesName +"["+std::to_string(gNeighborhoodSizes[mSelectedNeighborhoodIndex])+"];\n";
      code += ind+ "for(int n=0; n<"+std::to_string(gNeighborhoodSizes[mSelectedNeighborhoodIndex])+"; ++n)\n";
      code += ind+ "  "+ outValuesName +"[n] = this->NEIGHBORS_"+neighName+"[n]->ATTR_"+ attrName+";\n";

      code += ind+ "typedef " + attrName+"_TYPE* " + outValuesName + "_TYPE;\n";
      code += ind+ "typedef "+ attrName+"_TYPE " + outValuesName + "_ELEMENT_TYPE;\n";
      code += ind+ "int "+ outValuesName+"_SIZE = "+std::to_string(gNeighborhoodSizes[mSelectedNeighborhoodIndex])+";\n";

    }

    return code;
  }

  // casts:
  inline static ThisClass* Cast(Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
  inline static const ThisClass* Cast(const Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
};

class GetConstant : public Node
{
protected:
  typedef Node Base;  //Base Class
  typedef GetConstant ThisClass;
  GetConstant() : Base() {}
  static const int TYPE = kGetConstantNode;
  int mValueType = 1;
  int mBoolValue = true;
  int mIntValue = 0;
  float mFloatValue = .0;
  static const int TextBufferSize = 128;

  virtual const char* getTooltip() const { return "This Node returns a constant value given by user"; }
  virtual const char* getInfo() const { return "This Node returns a constant value given by user.\nBe aware of the types involved in the operations!"; }
  virtual void getDefaultTitleBarColors(ImU32& defaultTitleTextColorOut,ImU32& defaultTitleBgColorOut,float& defaultTitleBgColorGradientOut) const {
    // [Optional Override] customize Node Title Colors [default values: 0,0,-1.f => do not override == use default values from the Style()]
    defaultTitleTextColorOut = gMainStyle.TitleTextColorOut_DATA;defaultTitleBgColorOut = gMainStyle.TitleBgColorOut_DATA;defaultTitleBgColorGradientOut = gMainStyle.TitleBgColorGradientOut_DATA;
    }

public:

  // create:
  static ThisClass* Create(const ImVec2& pos) {
    ThisClass* node = (ThisClass*)ImGui::MemAlloc(sizeof(ThisClass)); IM_PLACEMENT_NEW(node) ThisClass();

    node->init("Get Constant", pos, NULL, "value", TYPE);

    return node;
  }

  string GetSerializedData() const override {
    json data = {{"mValueType", mValueType},
                {"mBoolValue", mBoolValue},
                {"mIntValue", mIntValue},
                {"mFloatValue", mFloatValue}};
    return data.dump();
  }

  void SetupFromSerializedData(string serialized_data) override {
    json data = json::parse(serialized_data);
    mValueType = data["mValueType"];

    if(data.contains("mBoolValue")) {  // Back-compatibility check
    mBoolValue = data["mBoolValue"];
    mIntValue = data["mIntValue"];
    mFloatValue = data["mFloatValue"];

    } else {
      auto deprecated_value = data["mValue"];
      auto str_deprecated_value = string(deprecated_value);
      mBoolValue = deprecated_value == "true" ? true : false;
      mIntValue = !str_deprecated_value.empty() && std::all_of(str_deprecated_value.begin(), str_deprecated_value.end(), ::isdigit) ?
                    std::stoi(str_deprecated_value) : 0;
      mFloatValue = 0;
    }
  }

protected:

  virtual bool render(float nodeWidth){
    ImGui::RadioButton("Bool", &mValueType, 0); ImGui::SameLine();
    ImGui::RadioButton("Int", &mValueType, 1); ImGui::SameLine();
    ImGui::RadioButton("Float", &mValueType, 2);

    if(mValueType == 0) { // Bool
      ImGui::RadioButton("False", &mBoolValue, 0); ImGui::SameLine();
      ImGui::RadioButton("True", &mBoolValue, 1);
    } else if(mValueType == 1) {
      ImGui::InputInt("Value", &mIntValue);
    } else if(mValueType == 2) {
      ImGui::InputFloat("Value", &mFloatValue);
    }
    return false;
  }

  // Evaluate this node returning the code generated
  virtual string Eval(const NodeGraphEditor& nge, int indentLevel, int evalPort = 0, string scope = ""){
    // Begin with the parent eval (a comment indicating the node called)
    string code = Node::Eval(nge, indentLevel);

    // Define the actual level of indentation
    string ind = string(indentLevel*2, ' ');
    mScope = scope;
    //-------------------------------------------------------------

    // Get the information about nodes and so on

    //-------------------------------------------------------------
    /*
     outValueNameType outValueName = mValue;

     typedef outValueNameType outValueName+ "_TYPE;"
     */

    // Check if there is a node connected to it
    string outValueName = "out_" +this->getNameOutSlot(0)+ "_" + std::to_string(this->mNodeId) + "_0";
    string outValueNameType;
    string outValue;
    if(mValueType == 0) {
      outValueNameType = "bool ";
      outValue = mBoolValue ? "true" : "false";
    }
    else if (mValueType == 1) {
      outValueNameType = "int ";
      outValue = std::to_string(mIntValue);
    }
    else if (mValueType == 2) {
      outValueNameType = "float ";
      outValue = std::to_string(mFloatValue);
    }

    code += ind+ outValueNameType+ outValueName +" = " +outValue+ ";\n";
    code += ind+ "typedef "+ outValueNameType + outValueName+ "_TYPE;\n";  // Actually this is temporary. The correct is offer different Get Constant Nodes for each type

    return code;
  }

  // casts:
  inline static ThisClass* Cast(Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
  inline static const ThisClass* Cast(const Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
};

class GetRandomNode : public Node
{
protected:
  typedef Node Base;  //Base Class
  typedef GetRandomNode ThisClass;
  GetRandomNode() : Base() {}
  static const int TYPE = kGetRandomNode;

  int  mValueType;
  bool mUseModelAttr;
  int mSelectedAttrIndex;
  float mProbability;

  int mFirstNumberI;
  int mSecondNumberI;

  float mFirstNumberF;
  float mSecondNumberF;

  virtual const char* getTooltip() const { return "This Node returns a random number in the selected interval."; }
  virtual const char* getInfo() const { return "This Node returns a random number in the selected interval. \nIt can be integer or decimal, according to checkbox state. \nBe aware of the types involved in the operations!"; }
  virtual void getDefaultTitleBarColors(ImU32& defaultTitleTextColorOut,ImU32& defaultTitleBgColorOut,float& defaultTitleBgColorGradientOut) const {
    // [Optional Override] customize Node Title Colors [default values: 0,0,-1.f => do not override == use default values from the Style()]
    defaultTitleTextColorOut = gMainStyle.TitleTextColorOut_DATA;defaultTitleBgColorOut = gMainStyle.TitleBgColorOut_DATA;defaultTitleBgColorGradientOut = gMainStyle.TitleBgColorGradientOut_DATA;
    }

public:

  // create:
  static ThisClass* Create(const ImVec2& pos) {
    ThisClass* node = (ThisClass*)ImGui::MemAlloc(sizeof(ThisClass)); IM_PLACEMENT_NEW(node) ThisClass();

    node->init("Get Random", pos, NULL, "value", TYPE);

    node->fields.addFieldEnum(&node->mSelectedAttrIndex, &GetNumEnumItems, &GetTextFromEnumIndex, "", "select which attribute must be considered", &NGEModelAttrNames);

    node->mProbability = 0;
    node->mValueType = 0;
    node->mUseModelAttr = false;
    node->mSelectedAttrIndex = 0;

    node->mFirstNumberI = 0;
    node->mSecondNumberI = 0;

    node->mFirstNumberF = 0.f;
    node->mSecondNumberF = 0.f;

    return node;
  }

  string GetSerializedData() const override {
    json data = {{"mProbability", mProbability},
                 {"mValueType", mValueType},
                 {"mUseModelAttr", mUseModelAttr},
                 {"mSelectedAttrIndex", mSelectedAttrIndex},
                 {"mFirstNumberI", mFirstNumberI},
                 {"mSecondNumberI", mSecondNumberI},
                 {"mFirstNumberF", mFirstNumberF},
                 {"mSecondNumberF", mSecondNumberF}};
    return data.dump();
  }

  void SetupFromSerializedData(string serialized_data) override {
    json data = json::parse(serialized_data);
    mProbability = data["mProbability"];
    mValueType = data["mValueType"];
    mUseModelAttr = data["mUseModelAttr"];
    mSelectedAttrIndex = data["mSelectedAttrIndex"];
    mFirstNumberI = data["mFirstNumberI"];
    mSecondNumberI = data["mSecondNumberI"];
    mFirstNumberF = data["mFirstNumberF"];
    mSecondNumberF = data["mSecondNumberF"];
  }

protected:
  virtual bool render(float nodeWidth){
    ImGui::RadioButton("Bool", &mValueType, 0); ImGui::SameLine();
    ImGui::RadioButton("Int", &mValueType, 1); ImGui::SameLine();
    ImGui::RadioButton("Float", &mValueType, 2);
    if(mValueType == 0) { // Bool
      ImGui::Checkbox("Use model attr", &mUseModelAttr);
      ImGui::Text("Probability:");
      if(mUseModelAttr)
        fields[0].render(nodeWidth);
      else
        ImGui::SliderFloat("##Probability", &mProbability, 0.0f, 1.0f, "%.2f");
    } else if(mValueType == 1) {
      ImGui::Text("From:");
      ImGui::InputInt("##FromInt", &mFirstNumberI);
      ImGui::Text("To:");
      ImGui::InputInt("##ToInt:", &mSecondNumberI);
    } else {
      ImGui::Text("From:");
      ImGui::InputFloat("##FromFloat", &mFirstNumberF);
      ImGui::Text("To:");
      ImGui::InputFloat("##ToFloat", &mSecondNumberF);
    }
    return false;
  }

  // Evaluate this node returning the code generated
  virtual string Eval(const NodeGraphEditor& nge, int indentLevel, int evalPort = 0, string scope = ""){
    // Begin with the parent eval (a comment indicating the node called)
    string code = Node::Eval(nge, indentLevel);

    // Define the actual level of indentation
    string ind = string(indentLevel*2, ' ');
    mScope = scope;
    //-------------------------------------------------------------

    // Get the information about nodes and so on
    //-------------------------------------------------------------
    /*
      std::srand(time(NULL));
      if(BOOL) {
        bool outValueName = rand() <
        if(USEMODELATTR)
          probability * ((double)RAND_MAX + 1.0);
        else
          mProbability * ((double)RAND_MAX + 1.0);

        typedef bool outValuesName+ "_TYPE;\n";

      } else if(INTEGER) {
        int min = mFirstNumberI;
        int max = mSecondNumberI;
        int outValueName = rand()%(max-min + 1) + min;
        typedef int outValuesName+ "_TYPE;\n";

      } else {
        float min = mFirstNumberF;
        float max = mSecondNumberF;
        float outValueName = min + static_cast <float> (rand()) /( static_cast <float> (RAND_MAX/(max-min)));
        typedef float outValuesName+ "_TYPE;\n";
      }
     */

    // Check if there is a node connected to value port
    string outValueName = "out_" + this->getNameOutSlot(0)+ "_" + std::to_string(this->mNodeId) +"_0";

    if(mValueType == 0) {  // BOOL
      code += ind+ "bool "+ outValueName +" = rand() < ";
      if(mUseModelAttr) {
        string attrName     = string(NGEModelAttrNames[mSelectedAttrIndex]);
        if (NGEModelAttrNames.size()>0 && NGEModelAttrNames.size()>mSelectedAttrIndex)
          code += "this->CAModel->ATTR_"+ attrName + " * ((double)RAND_MAX + 1.0);\n";
        else
          code += "0 * ((double)RAND_MAX + 1.0);\n";

      }else
          code += std::to_string(mProbability)+ " * ((double)RAND_MAX + 1.0);\n";

      code += ind+ "typedef bool "+ outValueName+ "_TYPE;\n";
    } else if(mValueType == 1){  // INTEGER
      code += ind+ "std::random_device rd_"+std::to_string(this->mNodeId)+";\n";
      code += ind+ "std::mt19937 gen_"+std::to_string(this->mNodeId)+"(rd_"+std::to_string(this->mNodeId)+"());\n";
      code += ind+ "std::uniform_int_distribution<> distr_"+std::to_string(this->mNodeId)+"("+std::to_string(mFirstNumberI)+", "+std::to_string(mSecondNumberI)+");\n";
      code +=
      ind+ "int " +outValueName+ " = distr_"+std::to_string(this->mNodeId)+"(gen_"+std::to_string(this->mNodeId)+");\n" +
      ind+ "typedef int " +outValueName+ "_TYPE;\n";

    } else {  // FLOAT
      code += ind+ "std::srand(time(NULL));\n";
      code +=
      ind+ "float " + outValueName+ " = "+std::to_string(mFirstNumberF)+" + static_cast <float> (rand()) /( static_cast <float> (RAND_MAX/("+std::to_string(mSecondNumberF)+"-"+std::to_string(mFirstNumberF)+")));\n" +
      ind+ "typedef float " +outValueName+ "_TYPE;\n";
    }

    return code;
  }

  // casts:
  inline static ThisClass* Cast(Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
  inline static const ThisClass* Cast(const Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
};

class StatementNode : public Node, public ITestEnum
{
protected:
  typedef Node Base;  //Base Class
  typedef StatementNode ThisClass;
  StatementNode() : Base() {}
  static const int TYPE = kStatementNode;

  int mSelectedOperationIndex;       // field

  virtual const char* getTooltip() const { return "This Node compares the two inputs (X,Y) of any type and returns an assertion (boolean)."; }
  virtual const char* getInfo() const { return "This Node compares the two inputs of any type and returns an assertion (boolean).\n Be aware of the types involved in the operations!"; }
  virtual void getDefaultTitleBarColors(ImU32& defaultTitleTextColorOut,ImU32& defaultTitleBgColorOut,float& defaultTitleBgColorGradientOut) const {
    // [Optional Override] customize Node Title Colors [default values: 0,0,-1.f => do not override == use default values from the Style()]
    defaultTitleTextColorOut = gMainStyle.TitleTextColorOut_LOGIC;defaultTitleBgColorOut = gMainStyle.TitleBgColorOut_LOGIC;defaultTitleBgColorGradientOut = gMainStyle.TitleBgColorGradientOut_LOGIC;
    }

public:
  int& getSelectedItem() { return mSelectedOperationIndex; }  // ITestEnum

  // create:
  static ThisClass* Create(const ImVec2& pos) {
    ThisClass* node = (ThisClass*)ImGui::MemAlloc(sizeof(ThisClass)); IM_PLACEMENT_NEW(node) ThisClass();

    // 2) main init
    node->init("Statement", pos, "X;Y", "assert", TYPE);

    // 3) init fields ( this uses the node->fields variable; otherwise we should have overridden other virtual methods (to render and serialize) )
    static const char* operations[6] = {"==", "!=", ">", "<", ">=", "<="};
    node->fields.addFieldEnum(&node->mSelectedOperationIndex, 6, operations, "", "select the binary operation to be asserted");

    node->mSelectedOperationIndex = 0;
    return node;
  }

  string GetSerializedData() const override {
    json data = {{"mSelectedOperationIndex", mSelectedOperationIndex}};
    return data.dump();
  }

  void SetupFromSerializedData(string serialized_data) override {
    json data = json::parse(serialized_data);
    mSelectedOperationIndex = data["mSelectedOperationIndex"];
  }

protected:
  virtual bool render(float nodeWidth){
    ImGui::Text("Operation:");
    fields[0].render(nodeWidth);
    return false;
  }

  // Evaluate this node returning the code generated
  virtual string Eval(const NodeGraphEditor& nge, int indentLevel, int evalPort = 0, string scope = ""){
    // Begin with the parent eval (a comment indicating the node called)
    string code = Node::Eval(nge, indentLevel);

    // Define the actual level of indentation
    string ind = string(indentLevel*2, ' ');
    this->mScope = scope;
    //-------------------------------------------------------------

    // Get the information about nodes and so on
    int inXPort;
    int inYPort;
    Node* inX = nge.getInputNodeForNodeAndSlot(this, 0, &inXPort);
    Node* inY = nge.getInputNodeForNodeAndSlot(this, 1, &inYPort);
    //-------------------------------------------------------------
    /*
     Eval(inX);
     Eval(inY);
     bool outValueName = (varInX + this->operation[mSelectedOperationIndex] + varInY);

     typedef bool + outValueName+ "_TYPE";
     */

    // Check if there is two nodes connected to value ports
    if (inX && inY) {
      string varInX = "out_" +inX->getNameOutSlot(inXPort)+ "_" + std::to_string(inX->mNodeId) + "_" + std::to_string(inXPort);
      string varInY = "out_" +inY->getNameOutSlot(inYPort)+ "_" + std::to_string(inY->mNodeId) + "_" + std::to_string(inYPort);
      string outValueName = "out_" + this->getNameOutSlot(0)+ "_" + std::to_string(this->mNodeId) +"_0";
      static const char* operations[6] = {" == ", " != ", " > ", " < ", " >= ", " <= "};

      if(MustValidate(inX->mScope, scope))
        code += inX->Eval(nge, indentLevel, inXPort, scope);
      if(MustValidate(inY->mScope, scope))
        code += inY->Eval(nge, indentLevel, inYPort, scope);

      code += ind+ "bool "+ outValueName +" = ("+ varInX +string(operations[mSelectedOperationIndex])+ varInY + ");\n";
      code += ind+ "typedef bool " + outValueName+ "_TYPE; \n";
    }

    return code;
  }

  // casts:
  inline static ThisClass* Cast(Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
  inline static const ThisClass* Cast(const Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
};

class LogicOperatorNode : public Node, public ITestEnum
{
protected:
  typedef Node Base;  //Base Class
  typedef LogicOperatorNode ThisClass;
  LogicOperatorNode() : Base() {}
  static const int TYPE = kLogicOperatorNode;

  int mSelectedOperationIndex;       // field

  virtual const char* getTooltip() const { return "This Node offers boolean operations between boolean inputs."; }
  virtual const char* getInfo() const { return "This Node offers boolean operations between boolean inputs.\n Be aware of the types involved in the operations!"; }
  virtual void getDefaultTitleBarColors(ImU32& defaultTitleTextColorOut,ImU32& defaultTitleBgColorOut,float& defaultTitleBgColorGradientOut) const {
    // [Optional Override] customize Node Title Colors [default values: 0,0,-1.f => do not override == use default values from the Style()]
    defaultTitleTextColorOut = gMainStyle.TitleTextColorOut_OPERATE;defaultTitleBgColorOut = gMainStyle.TitleBgColorOut_OPERATE;defaultTitleBgColorGradientOut = gMainStyle.TitleBgColorGradientOut_OPERATE;
    }

public:

  int& getSelectedItem() { return mSelectedOperationIndex; }  // ITestEnum

  // create:
  static ThisClass* Create(const ImVec2& pos) {
    ThisClass* node = (ThisClass*)ImGui::MemAlloc(sizeof(ThisClass)); IM_PLACEMENT_NEW(node) ThisClass();

    // 2) main init
    node->init("Logic Operator", pos, "A;B", "result", TYPE);

    // 3) init fields ( this uses the node->fields variable; otherwise we should have overridden other virtual methods (to render and serialize) )
    static const char* operations[4] = {"AND", "OR", "XOR", "NOT"};
    node->fields.addFieldEnum(&node->mSelectedOperationIndex, 4, operations, "", "select the boolean operator to be used");

    node->mSelectedOperationIndex = 0;

    return node;
  }

  string GetSerializedData() const override {
    json data = {{"mSelectedOperationIndex", mSelectedOperationIndex}};
    return data.dump();
  }

  void SetupFromSerializedData(string serialized_data) override {
    json data = json::parse(serialized_data);
    mSelectedOperationIndex = data["mSelectedOperationIndex"];
  }


protected:
  virtual bool render(float nodeWidth){
    ImGui::Text("Operation:");
    fields[0].render(nodeWidth);
    return false;
  }

  // Evaluate this node returning the code generated
  virtual string Eval(const NodeGraphEditor& nge, int indentLevel, int evalPort = 0, string scope = ""){
    // Begin with the parent eval (a comment indicating the node called)
    string code = Node::Eval(nge, indentLevel);

    // Define the actual level of indentation
    string ind = string(indentLevel*2, ' ');
    mScope = scope;
    //-------------------------------------------------------------

    // Get the information about nodes and so on
    int inXPort;
    int inYPort;
    Node* inX = nge.getInputNodeForNodeAndSlot(this, 0, &inXPort);
    Node* inY = nge.getInputNodeForNodeAndSlot(this, 1, &inYPort);
    //-------------------------------------------------------------
    /*
     Eval(inX);
     Eval(inY);
     bool outValueName = (varInX + this->operation[mSelectedOperationIndex] + varInY);

     typedef bool + outValueName+ "_TYPE";
     */

    if (inX) {
      string varInX = "out_" +inX->getNameOutSlot(inXPort)+ "_" + std::to_string(inX->mNodeId) + "_" + std::to_string(inXPort);
      string outValueName = "out_" + this->getNameOutSlot(0)+ "_" + std::to_string(this->mNodeId) +"_0";
      static const char* operations[4] = {" && ", " || ", " ^ ", "!"};

      // For NOT case
      if(mSelectedOperationIndex == 3){
        if(MustValidate(inX->mScope, scope))
          code += inX->Eval(nge, indentLevel, inXPort, scope);
        code += ind+ "bool "+ outValueName +" = (!"+ varInX +");\n";
        code += ind+ "typedef bool " + outValueName+ "_TYPE; \n";

      // For AND, OR and XOR
      }else if(inY) {
        string varInY = "out_" +inY->getNameOutSlot(inYPort)+ "_" + std::to_string(inY->mNodeId) + "_" + std::to_string(inYPort);
        if(MustValidate(inX->mScope, scope))
          code += inX->Eval(nge, indentLevel, inXPort, scope);
        if(MustValidate(inY->mScope, scope))
          code+= inY->Eval(nge, indentLevel, inYPort, scope);

        code += ind+ "bool "+ outValueName +" = ("+ varInX +string(operations[mSelectedOperationIndex])+ varInY + ");\n";
        code += ind+ "typedef bool " + outValueName+ "_TYPE; \n";
      }
    }

    return code;
  }


  // casts:
  inline static ThisClass* Cast(Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
  inline static const ThisClass* Cast(const Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
};

class SetAttributeNode : public Node, public ITestEnum
{
protected:
  typedef Node Base;  //Base Class
  typedef SetAttributeNode ThisClass;
  SetAttributeNode() : Base() {}
  static const int TYPE = kSetAttributeNode;

  int mSelectedAttrIndex;       // field

  virtual const char* getTooltip() const { return "This Node set the value of the selected attribute for the next generation."; }
  virtual const char* getInfo() const { return "This Node set the value of the selected attribute for the next generation. \nRemember: the Model Attributes are immutable, for it represents the parameters of the cellular automata model. \n Be aware of the types involved in the operations!"; }
  virtual void getDefaultTitleBarColors(ImU32& defaultTitleTextColorOut,ImU32& defaultTitleBgColorOut,float& defaultTitleBgColorGradientOut) const {
    // [Optional Override] customize Node Title Colors [default values: 0,0,-1.f => do not override == use default values from the Style()]
    defaultTitleTextColorOut = gMainStyle.TitleTextColorOut_FLOW;defaultTitleBgColorOut = gMainStyle.TitleBgColorOut_FLOW;defaultTitleBgColorGradientOut = gMainStyle.TitleBgColorGradientOut_FLOW;
    }

public:

  int& getSelectedItem() { return mSelectedAttrIndex; }  // ITestEnum

  // create:
  static ThisClass* Create(const ImVec2& pos) {
    ThisClass* node = (ThisClass*)ImGui::MemAlloc(sizeof(ThisClass)); IM_PLACEMENT_NEW(node) ThisClass();

    // 2) main init
    node->init("Set Attribute", pos, "DO;value", NULL, TYPE);

    // 3) init fields ( this uses the node->fields variable; otherwise we should have overridden other virtual methods (to render and serialize) )
    node->fields.addFieldEnum(&node->mSelectedAttrIndex, &GetNumEnumItems, &GetTextFromEnumIndex, "", "select which attribute will be changed", &NGECellAttrNames);

    node->mNumFlowPortsIn = 1;
    node->mSelectedAttrIndex = 0;
    return node;
  }

  string GetSerializedData() const override {
    json data = {{"mSelectedAttrIndex", mSelectedAttrIndex}};
    return data.dump();
  }

  void SetupFromSerializedData(string serialized_data) override {
    json data = json::parse(serialized_data);
    mSelectedAttrIndex = data["mSelectedAttrIndex"];
  }

protected:
  virtual bool render(float nodeWidth){
    ImGui::Text("Attribute:");
    fields[0].render(nodeWidth);
    return false;
  }

  // Evaluate this node returning the code generated
  virtual string Eval(const NodeGraphEditor& nge, int indentLevel, int evalPort = 0, string scope = ""){
    // Begin with the parent eval (a comment indicating the node called)
    string code = Node::Eval(nge, indentLevel);

    // Define the actual level of indentation
    string ind = string(indentLevel*2, ' ');
    mScope = scope;
    //-------------------------------------------------------------

    // Get the information about nodes and so on
    int inValuePort;
    Node* inValue = nge.getInputNodeForNodeAndSlot(this, 1, &inValuePort);

    //-------------------------------------------------------------
    // Check if there is a node connected to it
    if (inValue && NGECellAttrNames.size()>=mSelectedAttrIndex) {  // Check if there is a valid attribute
      string varNewValue = "out_" +inValue->getNameOutSlot(inValuePort)+ "_" + std::to_string(inValue->mNodeId) + "_" + std::to_string(inValuePort);

      if(MustValidate(inValue->mScope, scope))
        code += inValue->Eval(nge, indentLevel, inValuePort, scope); // Here the variable out_portName_nodeID_port must be set
      code += ind+ "this->ATTR_"+ NGECellAttrNames[mSelectedAttrIndex] +" = " +varNewValue+ ";\n";
    }

    return code;
  }

  // casts:
  inline static ThisClass* Cast(Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
  inline static const ThisClass* Cast(const Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
};

class ConditionalNode : public Node
{
protected:
  typedef Node Base;  //Base Class
  typedef ConditionalNode ThisClass;
  ConditionalNode() : Base() {}
  static const int TYPE = kConditionalNode;
  static const int TextBufferSize = 128;

  // Fields
  char mExplanation[TextBufferSize];

  virtual const char* getTooltip() const { return "This Node directs the control flow into two possible branchs."; }
  virtual const char* getInfo() const { return "This Node directs the control flow into two possible branchs. \nIf the boolean passed is TRUE, the first branch (THEN) is choosen; if FALSE, will be the second (ELSE). \n The value passed must be a boolean!"; }
  virtual void getDefaultTitleBarColors(ImU32& defaultTitleTextColorOut,ImU32& defaultTitleBgColorOut,float& defaultTitleBgColorGradientOut) const {
    // [Optional Override] customize Node Title Colors [default values: 0,0,-1.f => do not override == use default values from the Style()]
    defaultTitleTextColorOut = gMainStyle.TitleTextColorOut_FLOW;defaultTitleBgColorOut = gMainStyle.TitleBgColorOut_FLOW;defaultTitleBgColorGradientOut = gMainStyle.TitleBgColorGradientOut_FLOW;
    }

public:

  // create:
  static ThisClass* Create(const ImVec2& pos) {
    ThisClass* node = (ThisClass*)ImGui::MemAlloc(sizeof(ThisClass)); IM_PLACEMENT_NEW(node) ThisClass();

    // 2) main init
    node->init("Conditional", pos, "CHECK;IF", "THEN;ELSE", TYPE);

    node->fields.addFieldTextWrapped(&node->mExplanation[0],TextBufferSize, " ");

    // 4) set (or load) field values
    node->mNumFlowPortsIn = 1;
    node->mNumFlowPortsOut = 2;
    static const char* txtWrapped = "\\Condition";
    strncpy(node->mExplanation,txtWrapped,TextBufferSize);

    return node;
  }

protected:
  // Evaluate this node returning the code generated
  virtual string Eval(const NodeGraphEditor& nge, int indentLevel, int evalPort = 0, string scope = ""){
    // Begin with the parent eval (a comment indicating the node called)
    string code = Node::Eval(nge, indentLevel);

    // Define the actual level of indentation
    string ind = string(indentLevel*2, ' ');
    mScope = scope;
    //-------------------------------------------------------------

    // Get the information about nodes and so on
    int inIfPort;
    Node* inIf    = nge.getInputNodeForNodeAndSlot(this, 1, &inIfPort);
    ImVector<Node*> outputThenNodes = ImVector<Node*>();
    nge.getOutputNodesForNodeAndSlot(this, 0, outputThenNodes);
    ImVector<Node*> outputElseNodes = ImVector<Node*>();
    nge.getOutputNodesForNodeAndSlot(this, 1, outputElseNodes);
    //-------------------------------------------------------------
    // Check if there is a node connected to it
    if (inIf) {
      string varCondition = "out_" +inIf->getNameOutSlot(inIfPort)+ "_" + std::to_string(inIf->mNodeId) + "_" + std::to_string(inIfPort);

      if(MustValidate(inIf->mScope, scope))
        code += inIf->Eval(nge, indentLevel, inIfPort, scope); // Here the variable out_portName_nodeID_port must be set

      code += ind+ "if(" +varCondition+ "){\n";

      if (outputThenNodes.size() > 0) // If there is a link for THEN
        for(Node* outThen:outputThenNodes)
          code += ind+ outThen->Eval(nge, indentLevel+1, 0, this->mScope + "S"+std::to_string(this->mNodeId)+"_THEN_S");

      code += ind+ "} else {\n";

      if (outputElseNodes.size() > 0) // If there is a link for ELSE
        for(Node* outElse:outputElseNodes)
          code += ind+ outElse->Eval(nge, indentLevel+1, 0, this->mScope + "S"+std::to_string(this->mNodeId)+"_ELSE_S");

      code += ind+ "}\n";
    }

    return code;
  }

  // casts:
  inline static ThisClass* Cast(Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
  inline static const ThisClass* Cast(const Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
};

class LoopNode : public Node
{
protected:
  typedef Node Base;  //Base Class
  typedef LoopNode ThisClass;
  LoopNode() : Base() {}
  static const int TYPE = kLoopNode;
  static const int TextBufferSize = 128;

  // Fields
  char mExplanation[TextBufferSize];

  virtual const char* getTooltip() const { return "This Node Put the subsequent Do in a loop."; }
  virtual const char* getInfo() const { return "This Node Put the subsequent Do in a loop. The number of repetitions must be a positive integer. \n"; }
  virtual void getDefaultTitleBarColors(ImU32& defaultTitleTextColorOut,ImU32& defaultTitleBgColorOut,float& defaultTitleBgColorGradientOut) const {
    // [Optional Override] customize Node Title Colors [default values: 0,0,-1.f => do not override == use default values from the Style()]
    defaultTitleTextColorOut = gMainStyle.TitleTextColorOut_FLOW;defaultTitleBgColorOut = gMainStyle.TitleBgColorOut_FLOW;defaultTitleBgColorGradientOut = gMainStyle.TitleBgColorGradientOut_FLOW;
    }

public:

  // create:
  static ThisClass* Create(const ImVec2& pos) {
    ThisClass* node = (ThisClass*)ImGui::MemAlloc(sizeof(ThisClass)); IM_PLACEMENT_NEW(node) ThisClass();

    // 2) main init
    node->init("Loop", pos, "DO;times", "DO", TYPE);

    node->fields.addFieldTextWrapped(&node->mExplanation[0],TextBufferSize, " ");

    // 4) set (or load) field values
    node->mNumFlowPortsIn = 1;
    node->mNumFlowPortsOut = 1;
    static const char* txtWrapped = "\\Repeat Number";
    strncpy(node->mExplanation,txtWrapped,TextBufferSize);

    return node;
  }

  // Evaluate this node returning the code generated
  virtual string Eval(const NodeGraphEditor& nge, int indentLevel, int evalPort = 0, string scope = ""){
    // Begin with the parent eval (a comment indicating the node called)
    string code = Node::Eval(nge, indentLevel);

    // Define the actual level of indentation
    string ind = string(indentLevel*2, ' ');
    mScope = scope;
    //-------------------------------------------------------------

    // Get the information about nodes and so on
    int inRepeatPort;
    Node* inRepeat = nge.getInputNodeForNodeAndSlot(this, 1, &inRepeatPort);
    ImVector<Node*> outputNodes = ImVector<Node*>();
    nge.getOutputNodesForNodeAndSlot(this, 0, outputNodes);

    //-------------------------------------------------------------
    // Check if there is a node connected to it
    if (inRepeat) {
      string varRepeatNumber = "out_" +inRepeat->getNameOutSlot(inRepeatPort)+ "_" + std::to_string(inRepeat->mNodeId) + "_" + std::to_string(inRepeatPort);

      if(MustValidate(inRepeat->mScope, scope))
        code += inRepeat->Eval(nge, indentLevel, inRepeatPort, scope); // Here the variable out_portName_nodeID_port must be set

      code += ind+ "for(int i=0; i<" +varRepeatNumber+ ";++i){\n";

      if(outputNodes.size()>0) // If there is a link for DO
        for(Node* outDo:outputNodes)
            code += ind+ outDo->Eval(nge, indentLevel+1, 0, this->mScope + "S"+std::to_string(this->mNodeId)+"_DO_S");

      code += ind+ "}\n";
    }

    return code;
  }

  // casts:
  inline static ThisClass* Cast(Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
  inline static const ThisClass* Cast(const Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
};

class SequenceNode : public Node
{
protected:
  typedef Node Base;  //Base Class
  typedef SequenceNode ThisClass;
  SequenceNode() : Base() {}
  static const int TYPE = kSequenceNode;

  virtual const char* getTooltip() const { return "This Node split the control flow into two sequenced branchs."; }
  virtual const char* getInfo() const { return "This Node split the control flow into two sequenced branchs.\n"; }
  virtual void getDefaultTitleBarColors(ImU32& defaultTitleTextColorOut,ImU32& defaultTitleBgColorOut,float& defaultTitleBgColorGradientOut) const {
    // [Optional Override] customize Node Title Colors [default values: 0,0,-1.f => do not override == use default values from the Style()]
    defaultTitleTextColorOut = gMainStyle.TitleTextColorOut_FLOW;defaultTitleBgColorOut = gMainStyle.TitleBgColorOut_FLOW;defaultTitleBgColorGradientOut = gMainStyle.TitleBgColorGradientOut_FLOW;
    }

public:

  // create:
  static ThisClass* Create(const ImVec2& pos) {
    ThisClass* node = (ThisClass*)ImGui::MemAlloc(sizeof(ThisClass)); IM_PLACEMENT_NEW(node) ThisClass();

    // 2) main init
    node->init("Sequence", pos, "DO", "FIRST;THEN", TYPE);

    // 4) set (or load) field values
    node->setOpen(false);
    node->mNumFlowPortsIn = 1;
    node->mNumFlowPortsOut = 2;

    return node;
  }

protected:
  // Evaluate this node returning the code generated
  virtual string Eval(const NodeGraphEditor& nge, int indentLevel, int evalPort = 0, string scope = ""){
    // Begin with the parent eval (a comment indicating the node called)
    string code = Node::Eval(nge, indentLevel);

    // Define the actual level of indentation
    string ind = string(indentLevel*2, ' ');
    mScope = scope;
    //-------------------------------------------------------------

    // Get the information about nodes and so on
    ImVector<Node*> outputFirstNodes = ImVector<Node*>();
    nge.getOutputNodesForNodeAndSlot(this, 0, outputFirstNodes);
    ImVector<Node*> outputThenNodes = ImVector<Node*>();
    nge.getOutputNodesForNodeAndSlot(this, 1, outputThenNodes);

    //-------------------------------------------------------------
    if (outputFirstNodes.size()>0)    // If there is a link for FIRST
      for(Node* outFirst:outputFirstNodes)
        code += ind+ outFirst->Eval(nge, indentLevel, 0, scope);

    if (outputThenNodes.size()>0){    // If there is a link for FIRST
      if (outputFirstNodes.size()>0)
        code += "\n";  // Extra breakline to increase readability
      for(Node* outThen:outputThenNodes)
        code += ind+ outThen->Eval(nge, indentLevel, 0, scope);
    }

    return code;
  }

protected:
  virtual bool render(float nodeWidth){
    ImGui::Text("Do the FIRST branch \nand the THEN after");
    return false;
  }

  // casts:
  inline static ThisClass* Cast(Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
  inline static const ThisClass* Cast(const Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
};

class ArithmeticOperatorNode : public Node, public ITestEnum
{
protected:
  typedef Node Base;  //Base Class
  typedef ArithmeticOperatorNode ThisClass;
  ArithmeticOperatorNode() : Base() {}
  static const int TYPE = kArithmeticOperatorNode;

  int mSelectedOperationIndex;       // field

  virtual const char* getTooltip() const { return "This Node offers arithmetic operations between two inputs."; }
  virtual const char* getInfo() const { return "This Node offers arithmetic operations between two inputs.\n Be aware of the types involved in the operations!"; }
  virtual void getDefaultTitleBarColors(ImU32& defaultTitleTextColorOut,ImU32& defaultTitleBgColorOut,float& defaultTitleBgColorGradientOut) const {
    // [Optional Override] customize Node Title Colors [default values: 0,0,-1.f => do not override == use default values from the Style()]
    defaultTitleTextColorOut = gMainStyle.TitleTextColorOut_OPERATE;defaultTitleBgColorOut = gMainStyle.TitleBgColorOut_OPERATE;defaultTitleBgColorGradientOut = gMainStyle.TitleBgColorGradientOut_OPERATE;
    }

public:

  int& getSelectedItem() { return mSelectedOperationIndex; }  // ITestEnum

  // create:
  static ThisClass* Create(const ImVec2& pos) {
    ThisClass* node = (ThisClass*)ImGui::MemAlloc(sizeof(ThisClass)); IM_PLACEMENT_NEW(node) ThisClass();

    // 2) main init
    node->init("Arithmetic Operator", pos, "X;Y", "result", TYPE);

    // 3) init fields ( this uses the node->fields variable; otherwise we should have overridden other virtual methods (to render and serialize) )
    static const char* operations[9] = {"SUM", "SUB", "MUL", "DIV", "SQRT", "POW", "MAX", "MIN", "MEAN"};
    node->fields.addFieldEnum(&node->mSelectedOperationIndex, 9, operations, "", "select the arithmetic operator to be used");

    node->mSelectedOperationIndex = 0;

    return node;
  }

  string GetSerializedData() const override {
    json data = {{"mSelectedOperationIndex", mSelectedOperationIndex}};
    return data.dump();
  }

  void SetupFromSerializedData(string serialized_data) override {
    json data = json::parse(serialized_data);
    mSelectedOperationIndex = data["mSelectedOperationIndex"];
  }

protected:
  virtual bool render(float nodeWidth){
    ImGui::Text("Operation:");
    fields[0].render(nodeWidth);
    return false;
  }

  // Evaluate this node returning the code generated
  virtual string Eval(const NodeGraphEditor& nge, int indentLevel, int evalPort = 0, string scope = ""){
    // Begin with the parent eval (a comment indicating the node called)
    string code = Node::Eval(nge, indentLevel);

    // Define the actual level of indentation
    string ind = string(indentLevel*2, ' ');
    mScope = scope;
    //-------------------------------------------------------------

    // Get the information about nodes and so on
    int inXPort;
    int inYPort;
    Node* inX = nge.getInputNodeForNodeAndSlot(this, 0, &inXPort);
    Node* inY = nge.getInputNodeForNodeAndSlot(this, 1, &inYPort);
    //-------------------------------------------------------------
    /*
     Eval(inX);
     Eval(inY);
     varInX+"_TYPE" outValueName = (varInX + this->operation[mSelectedOperationIndex] + varInY);

     typedef varInX+"_TYPE" + outValueName+ "_TYPE";
     */

    if (inX && inY) {
      string varInX = "out_" +inX->getNameOutSlot(inXPort)+ "_" + std::to_string(inX->mNodeId) + "_" + std::to_string(inXPort);
      string varInY = "out_" +inY->getNameOutSlot(inYPort)+ "_" + std::to_string(inY->mNodeId) + "_" + std::to_string(inYPort);
      string outValueName = "out_" + this->getNameOutSlot(0)+ "_" + std::to_string(this->mNodeId) +"_0";
      static const char* operations[9] = {" + ", " - ", " * ", " / ", "sqrt", "pow", "max", "min", "MEAN"};

      if(MustValidate(inX->mScope, scope))
        code += inX->Eval(nge, indentLevel, inXPort, scope);
      if(MustValidate(inY->mScope, scope))
        code += inY->Eval(nge, indentLevel, inYPort, scope);

      code += ind+ varInX+ "_TYPE " +outValueName+ " = ";  // Part of declaration

      // For SUM, SUB, MUL, DIV
      if(mSelectedOperationIndex < 4)
        code += "(" + varInX +string(operations[mSelectedOperationIndex])+ varInY + ");\n";

      // For SQRT
      else if(mSelectedOperationIndex == 4)
        code += "std::sqrt("+ varInX +");\n";

      // For POW, MAX, MIN
      else if(mSelectedOperationIndex < 8)
        code += "std::"+ string(operations[mSelectedOperationIndex]) +"(" + varInX +", "+ varInY + ");\n";

      // For MEAN
      else
        code += "(" + varInX +" + "+ varInY + ")/2;\n";

      code += ind+ "typedef "+ varInX+ "_TYPE " + outValueName+ "_TYPE; \n";
    }

    return code;
  }

  // casts:
  inline static ThisClass* Cast(Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
  inline static const ThisClass* Cast(const Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
};

class GroupStatementNode : public Node, public ITestEnum
{
protected:
  typedef Node Base;  //Base Class
  typedef GroupStatementNode ThisClass;
  GroupStatementNode() : Base() {}
  static const int TYPE = kGroupStatementNode;

  int mSelectedOperationIndex;       // field

  virtual const char* getTooltip() const { return "This Node assert something about the list of values and returns the boolean."; }
  virtual const char* getInfo() const { return "This Node assert something about the list of values and returns the boolean.\n The first input is the list, and the second is a parameter of the assertion.\n Be aware of the types involved in the operations!"; }
  virtual void getDefaultTitleBarColors(ImU32& defaultTitleTextColorOut,ImU32& defaultTitleBgColorOut,float& defaultTitleBgColorGradientOut) const {
    // [Optional Override] customize Node Title Colors [default values: 0,0,-1.f => do not override == use default values from the Style()]
    defaultTitleTextColorOut = gMainStyle.TitleTextColorOut_LOGIC;defaultTitleBgColorOut = gMainStyle.TitleBgColorOut_LOGIC;defaultTitleBgColorGradientOut = gMainStyle.TitleBgColorGradientOut_LOGIC;
    }

public:

  int& getSelectedItem() { return mSelectedOperationIndex; }  // ITestEnum

  // create:
  static ThisClass* Create(const ImVec2& pos) {
    ThisClass* node = (ThisClass*)ImGui::MemAlloc(sizeof(ThisClass)); IM_PLACEMENT_NEW(node) ThisClass();

    // 2) main init
    node->init("Group Statement", pos, "values;X", "assert", TYPE);

    // 3) init fields ( this uses the node->fields variable; otherwise we should have overridden other virtual methods (to render and serialize) )
    static const char* operations[7] = {"ALL IS", "NONE IS", "HAS A", "ALL GREATER THAN", "ALL LESSER THAN", "ANY GREATER THAN", "ANY LESSER THAN"};
    node->fields.addFieldEnum(&node->mSelectedOperationIndex, 7, operations, "", "select the assertion operation");

    node->mSelectedOperationIndex = 0;
    return node;
  }

  string GetSerializedData() const override {
    json data = {{"mSelectedOperationIndex", mSelectedOperationIndex}};
    return data.dump();
  }

  void SetupFromSerializedData(string serialized_data) override {
    json data = json::parse(serialized_data);
    mSelectedOperationIndex = data["mSelectedOperationIndex"];
  }

protected:
  virtual bool render(float nodeWidth){
    ImGui::Text("Assert operation:");
    fields[0].render(nodeWidth);
    return false;
  }

  // Evaluate this node returning the code generated
  virtual string Eval(const NodeGraphEditor& nge, int indentLevel, int evalPort = 0, string scope = ""){
    // Begin with the parent eval (a comment indicating the node called)
    string code = Node::Eval(nge, indentLevel);

    // Define the actual level of indentation
    string ind = string(indentLevel*2, ' ');
    mScope = scope;
    //-------------------------------------------------------------

    // Get the information about nodes and so on
    int inValuesPort;
    int inXPort;
    Node* inValues = nge.getInputNodeForNodeAndSlot(this, 0, &inValuesPort);
    Node* inX = nge.getInputNodeForNodeAndSlot(this, 1, &inXPort);
    //-------------------------------------------------------------
    /*
     Eval(inValues);
     Eval(inX);
     int numEquals;
     int numGreater;
     int numLesser;
     bool outValueName;
     for(inValues+"_ELEMENT_TYPE" elem: varInValues) {
       if(elem == varInX)
         numEquals++;
       else if(elem > varInX)
         numGreater++;
       else
         numLesser++;
     }
     outValueName =
     // Different analyse for each operation
     // ALL IS
     (numEquals == varInValues->size());

     // None is
     (numEquals == 0);

     ...

     typedef bool + outValueName+ "_TYPE";
     */

    if (inValues && inX) {
      string varInValues  = "out_" +inValues->getNameOutSlot(inValuesPort)+ "_" + std::to_string(inValues->mNodeId) + "_" + std::to_string(inValuesPort);
      string varInX       = "out_" +inX->getNameOutSlot(inXPort)+ "_" + std::to_string(inX->mNodeId) + "_" + std::to_string(inXPort);
      string outValueName = "out_" + this->getNameOutSlot(0)+ "_" + std::to_string(this->mNodeId) +"_0";
      //static const char* operations[7] = {"ALL IS", "NONE IS", "HAS A", "ALL GREATER THAN", "ALL LESSER THAN", "ANY GREATER THAN", "ANY LESSER THAN"};

      string numEquals  = "numEquals_"  + std::to_string(this->mNodeId);
      string numGreater = "numGreater_" + std::to_string(this->mNodeId);
      string numLesser  = "numLesser_"  + std::to_string(this->mNodeId);

      if(MustValidate(inValues->mScope, scope))
        code += inValues->Eval(nge, indentLevel, inValuesPort, scope);
      if(MustValidate(inX->mScope, scope))
        code += inX->Eval(nge, indentLevel, inXPort, scope);

      code += ind+ "int "+numEquals+" = 0;\n" +
          ind+ "int "+numGreater+" = 0;\n" +
          ind+ "int "+numLesser+" = 0;\n"  +
          ind+ "bool "+ outValueName+ ";\n" +
          ind+ "for("+ varInValues+"_ELEMENT_TYPE "+ "elem: "+ varInValues+ ") {\n" +
          ind+ "  if(elem == "+ varInX +")\n" +
          ind+ "    "+numEquals+"++;\n" +
          ind+ "  else if(elem > "+ varInX +")\n" +
          ind+ "    "+numGreater+"++;\n" +
          ind+ "  else\n" +
          ind+ "    "+numLesser+"++;\n" +
          ind+ "  "+ outValueName+ " = ";

      // Different analyse for each operation
      switch (this->mSelectedOperationIndex) {
      case 0: code += "("+numEquals+" == "+ varInValues +"_SIZE);\n";  break; // ALL IS
      case 1: code += "("+numEquals+" == 0);\n";                          break; // NONE IS
      case 2: code += "("+numEquals+" > 0);\n";                           break; // HAS A
      case 3: code += "("+numGreater+" == "+ varInValues +"_SIZE);\n"; break; // ALL GREATER THAN
      case 4: code += "("+numLesser+" == "+ varInValues +"_SIZE);\n";  break; // ALL LESSER THAN
      case 5: code += "("+numGreater+" > 0);\n";                          break; // ANY GREATER THAN
      case 6: code += "("+numLesser+" > 0);\n";                           break; // ANY LESSER THAN

      default:
        code += ind+ "false;\n";                                        // Whatever
      }
      code += ind+ "}\n";
      code += ind+ "typedef bool "+ outValueName+ "_TYPE;\n";
    }

    return code;
  }

  // casts:
  inline static ThisClass* Cast(Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
  inline static const ThisClass* Cast(const Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
};

class GroupOperatorNode : public Node, public ITestEnum
{
protected:
  typedef Node Base;  //Base Class
  typedef GroupOperatorNode ThisClass;
  GroupOperatorNode() : Base() {}
  static const int TYPE = kGroupOperatorNode;

  bool mBooleanType;
  int mArithOperIndex;       // field
  int mBoolOperIndex;

  virtual const char* getTooltip() const { return "This Node offers arithmetic and boolean operations for a list of elements."; }
  virtual const char* getInfo() const { return "This Node offers arithmetic and boolean operations for a list of elements. \nYou can mark the 'Boolean Type' option to switch for boolean operations. \nBe aware of the types involved in the operations!"; }
  virtual void getDefaultTitleBarColors(ImU32& defaultTitleTextColorOut,ImU32& defaultTitleBgColorOut,float& defaultTitleBgColorGradientOut) const {
    // [Optional Override] customize Node Title Colors [default values: 0,0,-1.f => do not override == use default values from the Style()]
    defaultTitleTextColorOut = gMainStyle.TitleTextColorOut_OPERATE;defaultTitleBgColorOut = gMainStyle.TitleBgColorOut_OPERATE;defaultTitleBgColorGradientOut = gMainStyle.TitleBgColorGradientOut_OPERATE;
    }

public:

  int& getSelectedItem() { return mArithOperIndex; }  // ITestEnum

  // create:
  static ThisClass* Create(const ImVec2& pos) {
    ThisClass* node = (ThisClass*)ImGui::MemAlloc(sizeof(ThisClass)); IM_PLACEMENT_NEW(node) ThisClass();

    // 2) main init
    node->init("Group Operator", pos, "values", "result", TYPE);

    // 3) init fields ( this uses the node->fields variable; otherwise we should have overridden other virtual methods (to render and serialize) )
    static const char* BoolOperations[5] = {"AND", "OR", "NAND", "NOR", "PICK RANDOM"};
    node->fields.addFieldEnum(&node->mBoolOperIndex, 5, BoolOperations, "", "select the boolean operator to be used");

    static const char* ArithOperations[7] = {"SUM", "MUL", "MAX", "MIN", "MEAN", "MEDIAN", "PICK RANDOM"};
    node->fields.addFieldEnum(&node->mArithOperIndex, 7, ArithOperations, "", "select the arithmetic operator to be used");

    node->mBooleanType = false;
    node->mArithOperIndex = 0;
    node->mBoolOperIndex = 0;

    return node;
  }

  string GetSerializedData() const override {
    json data = {{"mBooleanType", mBooleanType},
                {"mArithOperIndex", mArithOperIndex},
                {"mBoolOperIndex", mBoolOperIndex}};
    return data.dump();
  }

  void SetupFromSerializedData(string serialized_data) override {
    json data = json::parse(serialized_data);
    mBooleanType = data["mBooleanType"];
    mArithOperIndex = data["mArithOperIndex"];
    mBoolOperIndex = data["mBoolOperIndex"];
  }

protected:
  virtual bool render(float nodeWidth){
    ImGui::Checkbox("Boolean Type", &mBooleanType);
    ImGui::Text("Operator:");
    if(mBooleanType)
      fields[0].render(nodeWidth);
    else
      fields[1].render(nodeWidth);
    return false;
  }

  // Evaluate this node returning the code generated
  virtual string Eval(const NodeGraphEditor& nge, int indentLevel, int evalPort = 0, string scope = ""){
    // Begin with the parent eval (a comment indicating the node called)
    string code = Node::Eval(nge, indentLevel);

    // Define the actual level of indentation
    string ind = string(indentLevel*2, ' ');
    mScope = scope;
    //-------------------------------------------------------------

    // Get the information about nodes and so on
    int inValuesPort;
    Node* inValues = nge.getInputNodeForNodeAndSlot(this, 0, &inValuesPort);
    //-------------------------------------------------------------
    /*
     Eval(inValues);
     if(mBooleanType) {
       if(this->mBoolOperIndex < 2)
         bool result  = varInValues[0];
       else
         bool result = !varInValues[0];

       if(mBoolOperIndex < 5) // AND, OR, NAND, NOR
          for(varInValues+"_ELEMENT_TYPE" elem: varInValues) {
            switch (this->mBoolOperIndex) {
            case 0: return = return && elem ;\n";  break; // AND
            case 1: return = return || elem ;\n";  break; // OR
            case 2: return = return && !elem ;\n";  break; // NAND
            case 3: return = return || !elem ;\n";  break; // NOR
          }
       else // PICK RANDOM
        return = inValues[(rand() % inValues->size())]; // PICK RANDOM
     } else {

     }

     typedef varInValues+"_ELEMENT_TYPE" + outValueName+ "_TYPE";
     */

    if (inValues) {
      string varInValues  = "out_" +inValues->getNameOutSlot(inValuesPort)+ "_" + std::to_string(inValues->mNodeId) + "_" + std::to_string(inValuesPort);
      string outValueName = "out_" + this->getNameOutSlot(0)+ "_" + std::to_string(this->mNodeId) +"_0";
      //static const char* BoolOperations[5] = {"AND", "OR", "NAND", "NOR", "PICK RANDOM"};
      //static const char* ArithOperations[7] = {"SUM", "MUL", "MAX", "MIN", "MEAN", "MEDIAN", "PICK RANDOM"};

      if(MustValidate(inValues->mScope, scope))
        code += inValues->Eval(nge, indentLevel, inValuesPort, scope);
      if(mBooleanType) {  // Boolean Operation
        if(this->mBoolOperIndex < 2)
          code += ind+ varInValues+"_ELEMENT_TYPE "+ outValueName + " = "+ varInValues+"[0];\n";
        else
          code += ind+ varInValues+"_ELEMENT_TYPE "+ outValueName + " = !"+ varInValues+"[0];\n";

        if(mBoolOperIndex < 4) {  // AND, OR, NAND, NOR
          code+= ind+ "for("+ varInValues+"_ELEMENT_TYPE elem: "+ varInValues+")\n";
          switch (this->mBoolOperIndex) {
            case 0: code += ind+ "  "+ outValueName +" = "+ outValueName +" && elem;\n";  break; // AND
            case 1: code += ind+ "  "+ outValueName +" = "+ outValueName +" || elem;\n";  break; // OR
            case 2: code += ind+ "  "+ outValueName +" = "+ outValueName +" && !elem;\n"; break; // NAND
            case 3: code += ind+ "  "+ outValueName +" = "+ outValueName +" || !elem;\n"; break; // NOR
            default: code += ind+ "  "+ outValueName +" = false;\n";
          }
        } else // PICK RANDOM
          code+= ind+ outValueName +" = "+ varInValues + "[rand() % ("+ varInValues+ "_SIZE)];\n"; // PICK RANDOM

      } else {  // Arithmetic Operation
        if(mArithOperIndex == 0 || mArithOperIndex == 4) // SUM or MEAN
          code += ind+ varInValues+"_ELEMENT_TYPE "+ outValueName +" = 0;\n";

        if(mArithOperIndex == 1) // MUL
          code += ind+ varInValues+"_ELEMENT_TYPE "+ outValueName +" = 1;\n";

        if(mArithOperIndex == 2 || mArithOperIndex == 3) // MAX or MIN
          code += ind+ varInValues+"_ELEMENT_TYPE "+ outValueName +" = "+ varInValues +"[0];\n";

        // SUM, MUL, MAX, MIN, MEAN
        if(mArithOperIndex < 5) {
          code+= ind+ "for("+ varInValues+"_ELEMENT_TYPE elem: "+ varInValues+")\n";
          switch (this->mArithOperIndex) {
            case 0: code += ind+ "  "+ outValueName +" = "+ outValueName +" + elem;\n";  break; // SUM
            case 1: code += ind+ "  "+ outValueName +" = "+ outValueName +" * elem;\n";  break; // MUL
            case 2: code += ind+ "  "+ outValueName +" = std::max<float>("+ outValueName +", elem);\n"; break; // MAX
            case 3: code += ind+ "  "+ outValueName +" = std::min("+ outValueName +", elem);\n"; break; // MIN
            case 4: code += ind+ "  "+ outValueName +" = "+ outValueName +" + elem;\n"; break; // MEAN
            default: code += ind+ "  "+ outValueName +" = 0;\n"; // Whatever, should be never reached
          }
          if(mArithOperIndex == 4)  // Finish MEAN
            code += ind+ outValueName +" = "+ outValueName +"/"+ varInValues +"_SIZE;\n";

        // MEDIAN
        } else if(mArithOperIndex == 5) {
          string sizeLocalVar = "size_" + std::to_string(this->mNodeId);
          code += ind+ "int "+sizeLocalVar+" = " + varInValues+ "_SIZE;\n";
          code += ind+ "sort("+ varInValues+ ".begin(), "+ varInValues+ ".end());\n";
          code += ind+ "if(("+sizeLocalVar+" % 2) == 0){\n"+
                  ind+ "  "+ outValueName+ " = ("+ varInValues+ "["+sizeLocalVar+"/2-1] + "+ varInValues+ "["+sizeLocalVar+"/2])/2;\n";
          code += ind+ "} else {\n" +
                  ind+ "  "+ outValueName+ " = "+ varInValues+ "["+sizeLocalVar+"/2];\n";
          code += ind+ "}\n";

        // PICK RANDOM
        } else
          code+= ind+ outValueName +" = "+ varInValues + "[rand() % ("+ varInValues+ "_SIZE)];\n"; // PICK RANDOM
      }

      code+= ind+ "typedef "+ varInValues+"_ELEMENT_TYPE " + outValueName+ "_TYPE;\n";

      return code;
    }
  }

  // casts:
  inline static ThisClass* Cast(Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
  inline static const ThisClass* Cast(const Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
};

class GroupCountingNode : public Node, public ITestEnum
{
protected:
  typedef Node Base;  //Base Class
  typedef GroupCountingNode ThisClass;
  GroupCountingNode() : Base() {}
  static const int TYPE = kGroupCountingNode;

  int mSelectedOperationIndex;       // field

  virtual const char* getTooltip() const { return "This Node offers different ways of counting numerical elements in a list."; }
  virtual const char* getInfo() const { return "This Node offers different ways of counting numerical elements in a list. \nBe aware of the types involved in the operations!"; }
  virtual void getDefaultTitleBarColors(ImU32& defaultTitleTextColorOut,ImU32& defaultTitleBgColorOut,float& defaultTitleBgColorGradientOut) const {
    // [Optional Override] customize Node Title Colors [default values: 0,0,-1.f => do not override == use default values from the Style()]
    defaultTitleTextColorOut = gMainStyle.TitleTextColorOut_OPERATE;defaultTitleBgColorOut = gMainStyle.TitleBgColorOut_OPERATE;defaultTitleBgColorGradientOut = gMainStyle.TitleBgColorGradientOut_OPERATE;
    }

public:

  int& getSelectedItem() { return mSelectedOperationIndex; }  // ITestEnum

  // create:
  static ThisClass* Create(const ImVec2& pos) {
    ThisClass* node = (ThisClass*)ImGui::MemAlloc(sizeof(ThisClass)); IM_PLACEMENT_NEW(node) ThisClass();

    // 2) main init
    node->init("Group Counting", pos, "values;X", "result", TYPE);

    // 3) init fields ( this uses the node->fields variable; otherwise we should have overridden other virtual methods (to render and serialize) )
    static const char* operations[4] = {"EQUALS TO", "UNLIKE TO", "GREATER THAN", "LESSER THAN"};
    node->fields.addFieldEnum(&node->mSelectedOperationIndex, 4, operations, "", "select the operator to be used");

    node->mSelectedOperationIndex = 0;

    return node;
  }

  string GetSerializedData() const override {
    json data = {{"mSelectedOperationIndex", mSelectedOperationIndex}};
    return data.dump();
  }

  void SetupFromSerializedData(string serialized_data) override {
    json data = json::parse(serialized_data);
    mSelectedOperationIndex = data["mSelectedOperationIndex"];
  }


protected:
  virtual bool render(float nodeWidth){
    ImGui::Text("Operation:");
    fields[0].render(nodeWidth);
    return false;
  }

  // Evaluate this node returning the code generated
  virtual string Eval(const NodeGraphEditor& nge, int indentLevel, int evalPort = 0, string scope = ""){
    // Begin with the parent eval (a comment indicating the node called)
    string code = Node::Eval(nge, indentLevel);

    // Define the actual level of indentation
    string ind = string(indentLevel*2, ' ');
    mScope = scope;
    //-------------------------------------------------------------

    // Get the information about nodes and so on
    int inValuesPort;
    int inXPort;
    Node* inValues = nge.getInputNodeForNodeAndSlot(this, 0, &inValuesPort);
    Node* inX = nge.getInputNodeForNodeAndSlot(this, 1, &inXPort);
    //-------------------------------------------------------------
    /*
     Eval(inValues);
     Eval(inX);
     int outValueName;
     for(inValues+"_ELEMENT_TYPE" elem: varInValues) {
       // Different analyse for each operation
       if(elem operations[mSelectedOperationIndex] varInX)
         outValueName++;
     }

     typedef int + outValueName+ "_TYPE";
     */

    if (inValues && inX) {
      string varInValues  = "out_" +inValues->getNameOutSlot(inValuesPort)+ "_" + std::to_string(inValues->mNodeId) + "_" + std::to_string(inValuesPort);
      string varInX       = "out_" +inX->getNameOutSlot(inXPort)+ "_" + std::to_string(inX->mNodeId) + "_" + std::to_string(inXPort);
      string outValueName = "out_" + this->getNameOutSlot(0)+ "_" + std::to_string(this->mNodeId) +"_0";
      static const char* operations[4] = {" == ", " != ", " > ", " < "};

      if(MustValidate(inValues->mScope, scope))
        code += inValues->Eval(nge, indentLevel, inValuesPort, scope);
      if(MustValidate(inX->mScope, scope))
      code += inX->Eval(nge, indentLevel, inXPort, scope);

      code += ind+ "int "+ outValueName+ " = 0;\n" +
          ind+ "for("+ varInValues+"_ELEMENT_TYPE "+ "elem: "+ varInValues+ ") {\n" +
          ind+ "  if(elem"+ string(operations[mSelectedOperationIndex]) + varInX +")\n" +
          ind+ "    "+ outValueName +"++;\n";
      code += ind+ "}\n";
      code += ind+ "typedef int "+ outValueName+ "_TYPE;\n";
    }

    return code;
  }

  // casts:
  inline static ThisClass* Cast(Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
  inline static const ThisClass* Cast(const Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
};

class InputColorNode : public Node
{
protected:
  typedef Node Base;  //Base Class
  typedef InputColorNode ThisClass;
  InputColorNode() : Base() {}
  static const int TYPE = kInputColorNode;

  int mSelectedMapping;
  bool mIsProcessing;

  virtual const char* getTooltip() const { return "This node mark the start of the control when a color is used as input to the cell."; }
  virtual const char* getInfo() const { return "This node mark the start of the control when a color is used as input to the cell. \n It allow an intialization by image of CA. Where what each color represents is up to user.\n Be aware of the types of data. The output is three integers."; }
  virtual void getDefaultTitleBarColors(ImU32& defaultTitleTextColorOut,ImU32& defaultTitleBgColorOut,float& defaultTitleBgColorGradientOut) const {
    // [Optional Override] customize Node Title Colors [default values: 0,0,-1.f => do not override == use default values from the Style()]
    defaultTitleTextColorOut = gMainStyle.TitleTextColorOut_FLOW;defaultTitleBgColorOut = gMainStyle.TitleBgColorOut_FLOW;defaultTitleBgColorGradientOut = gMainStyle.TitleBgColorGradientOut_FLOW;
    }

public:
  // create:
  static ThisClass* Create(const ImVec2& pos) {
    // 1) allocation
   ThisClass* node = (ThisClass*)ImGui::MemAlloc(sizeof(ThisClass)); IM_PLACEMENT_NEW(node) ThisClass();

    node->init("Input Color", pos, NULL, "DO;r;g;b", TYPE);

    // 3) init fields ( this uses the node->fields variable; otherwise we should have overridden other virtual methods (to render and serialize) )
    node->fields.addFieldEnum(&node->mSelectedMapping, &GetNumEnumItems, &GetTextFromEnumIndex, "", "select which mapping must be considered", &NGEColAttrMappingNames);

    node->mSelectedMapping = 0;
    node->mIsProcessing = false;

    node->mNumFlowPortsOut = 1;

    return node;
  }

  string GetSerializedData() const override {
    json data = {{"mSelectedMapping", mSelectedMapping},};
    return data.dump();
  }

  void SetupFromSerializedData(string serialized_data) override {
    json data = json::parse(serialized_data);
    mSelectedMapping = data["mSelectedMapping"];
  }

protected:
  virtual bool render(float nodeWidth){
    ImGui::Text("Mapping:");
    fields[0].render(nodeWidth);
    ImGui::Text("Inputted colors /");
    return false;
  }

  // Evaluate this node returning the code generated
  virtual string Eval(const NodeGraphEditor& nge, int indentLevel, int evalPort = 0, string scope = ""){
    // Begin with the parent eval (a comment indicating the node called)
    string code = Node::Eval(nge, indentLevel);

    // Define the actual level of indentation
    string ind = string(indentLevel*2, ' ');
    this->mScope = "S"+std::to_string(this->mNodeId)+"S";
    //-------------------------------------------------------------

    // Get the information about nodes and so on
    ImVector<Node*> outputNodes = ImVector<Node*>();
    nge.getOutputNodesForNodeAndSlot(this, 0, outputNodes);

    //-------------------------------------------------------------
    // Check if there is a output node linked at, and a valid mapping selected
    if(!this->mIsProcessing) {
      if (outputNodes.size() > 0 && NGEColAttrMappingNames.size()>0 && NGEColAttrMappingNames.size()>mSelectedMapping) {
        this->mIsProcessing = true;
        string outRName = "out_" + this->getNameOutSlot(1)+ "_" + std::to_string(this->mNodeId) +"_1";
        string outGName = "out_" + this->getNameOutSlot(2)+ "_" + std::to_string(this->mNodeId) +"_2";
        string outBName = "out_" + this->getNameOutSlot(3)+ "_" + std::to_string(this->mNodeId) +"_3";

        code += ind+ "void CACell::InputColor_"+ string(NGEColAttrMappingNames[mSelectedMapping]) +"(int red, int green, int blue){\n";
        code += ind+ "  int "+ outRName +" = red;\n";
        code += ind+ "  int "+ outGName +" = green;\n";
        code += ind+ "  int "+ outBName +" = blue;\n";

        code += ind+ "  typedef int " + outRName + "_TYPE;\n";
        code += ind+ "  typedef int " + outGName + "_TYPE;\n";
        code += ind+ "  typedef int " + outBName + "_TYPE;\n";

        for(Node* outNode:outputNodes)
          code += ind+ outNode->Eval(nge, indentLevel+1, 0, this->mScope);
        code += ind+ "}\n";
        this->mIsProcessing = false;
      }
    } else {
      return "";
    }
    //-------------------------------------------------------------
    return code;
  }

  // casts:
  inline static ThisClass* Cast(Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
  inline static const ThisClass* Cast(const Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
};

class SetColorViewerNode : public Node
{
protected:
  typedef Node Base;  //Base Class
  typedef SetColorViewerNode ThisClass;
  SetColorViewerNode() : Base() {}
  static const int TYPE = kSetColorViewerNode;

  bool mUseDefaultColor;
  int mSelectedMapping;
  ImVec4 mDefaultColor;

  virtual const char* getTooltip() const { return "This node set the color of the cell for a specified mapping."; }
  virtual const char* getInfo() const { return "This node set the color of the cell for a specified mapping. \nIt allow the user to create different forms of visualization of the CA execution. \n Be aware of the types of data. The output is three integers."; }
  virtual void getDefaultTitleBarColors(ImU32& defaultTitleTextColorOut,ImU32& defaultTitleBgColorOut,float& defaultTitleBgColorGradientOut) const {
    // [Optional Override] customize Node Title Colors [default values: 0,0,-1.f => do not override == use default values from the Style()]
    defaultTitleTextColorOut = gMainStyle.TitleTextColorOut_FLOW;defaultTitleBgColorOut = gMainStyle.TitleBgColorOut_FLOW;defaultTitleBgColorGradientOut = gMainStyle.TitleBgColorGradientOut_FLOW;
    }

public:
  // create:
  static ThisClass* Create(const ImVec2& pos) {
    // 1) allocation
   ThisClass* node = (ThisClass*)ImGui::MemAlloc(sizeof(ThisClass)); IM_PLACEMENT_NEW(node) ThisClass();

    node->init("Set Color Viewer", pos, "DO;r;g;b", NULL, TYPE);

    // 3) init fields ( this uses the node->fields variable; otherwise we should have overridden other virtual methods (to render and serialize) )
    node->fields.addFieldEnum(&node->mSelectedMapping, &GetNumEnumItems, &GetTextFromEnumIndex, "", "select which mapping must be considered", &NGEAttrColMappingNames);
    node->fields.addFieldColor(&node->mDefaultColor.x,false,"","Select the default channel values");

    node->mSelectedMapping = 0;
    node->mUseDefaultColor = true;

    node->mNumFlowPortsIn = 1;

    return node;
  }

  string GetSerializedData() const override {
    json data = {{"mSelectedMapping", mSelectedMapping},
                 {"mUseDefaultColor", mUseDefaultColor},
                 {"mDefaultColor", {mDefaultColor.x, mDefaultColor.y, mDefaultColor.z}}
                };
    return data.dump();
  }

  void SetupFromSerializedData(string serialized_data) override {
    json data = json::parse(serialized_data);
    mSelectedMapping = data["mSelectedMapping"];
    mUseDefaultColor = data["mUseDefaultColor"];
    mDefaultColor.x = data["mDefaultColor"][0];
    mDefaultColor.y = data["mDefaultColor"][1];
    mDefaultColor.z = data["mDefaultColor"][2];
  }

protected:
  virtual bool render(float nodeWidth){
    ImGui::Text("Mapping:");
    fields[0].render(nodeWidth);
    ImGui::Checkbox("Use default color", &mUseDefaultColor);
    if(mUseDefaultColor) {
      ImGui::Text("Default values:");
      fields[1].render(nodeWidth);
    }
    return false;
  }

  // Evaluate this node returning the code generated
  virtual string Eval(const NodeGraphEditor& nge, int indentLevel, int evalPort = 0, string scope = ""){
    // Begin with the parent eval (a comment indicating the node called)
    string code = Node::Eval(nge, indentLevel);

    // Define the actual level of indentation
    string ind = string(indentLevel*2, ' ');
    mScope = scope;
    //-------------------------------------------------------------

    // Get the information about nodes and so on
    int inRPort;
    int inGPort;
    int inBPort;
    Node* inR = nge.getInputNodeForNodeAndSlot(this, 1, &inRPort);
    Node* inG = nge.getInputNodeForNodeAndSlot(this, 2, &inGPort);
    Node* inB = nge.getInputNodeForNodeAndSlot(this, 3, &inBPort);
    //-------------------------------------------------------------
    // Check if there is a node connected to it
    // Set to default colors values

    if(NGEAttrColMappingNames.size() > 0 && NGEAttrColMappingNames.size() > mSelectedMapping){
      if(mUseDefaultColor) {
        code += ind+ "this->VIEWER_"+ string(NGEAttrColMappingNames[mSelectedMapping]) +"[0] = " +std::to_string(static_cast<int>(mDefaultColor.x*255))+ ";\n";
        code += ind+ "this->VIEWER_"+ string(NGEAttrColMappingNames[mSelectedMapping]) +"[1] = " +std::to_string(static_cast<int>(mDefaultColor.y*255))+ ";\n";
        code += ind+ "this->VIEWER_"+ string(NGEAttrColMappingNames[mSelectedMapping]) +"[2] = " +std::to_string(static_cast<int>(mDefaultColor.z*255))+ ";\n";
      }

      // Has a node linked at R port
      if (inR) {
        //string toBePrinted = "scopesR = " + inR->mScope+ ", " + scope;
        //qDebug(toBePrinted.c_str());
        string varInR = "out_" +inR->getNameOutSlot(inRPort)+ "_" + std::to_string(inR->mNodeId) + "_" + std::to_string(inRPort);
        if(MustValidate(inR->mScope, scope))
          code += inR->Eval(nge, indentLevel, inRPort, scope);
        code += ind+ "this->VIEWER_"+ string(NGEAttrColMappingNames[mSelectedMapping]) +"[0] = static_cast<int>(" +varInR+ ");\n";
      }

      if (inG) {
        string varInG = "out_" +inG->getNameOutSlot(inGPort)+ "_" + std::to_string(inG->mNodeId) + "_" + std::to_string(inGPort);
        if(MustValidate(inG->mScope, scope))
          code += inG->Eval(nge, indentLevel, inGPort, scope);
        code += ind+ "this->VIEWER_"+ string(NGEAttrColMappingNames[mSelectedMapping]) +"[1] = static_cast<int>(" +varInG+ ");\n";
      }

      if (inB) {
        string varInB = "out_" +inB->getNameOutSlot(inBPort)+ "_" + std::to_string(inB->mNodeId) + "_" + std::to_string(inBPort);
        if(MustValidate(inB->mScope, scope))
          code += inB->Eval(nge, indentLevel, inBPort, scope);
        code += ind+ "this->VIEWER_"+ string(NGEAttrColMappingNames[mSelectedMapping]) +"[2] = static_cast<int>(" +varInB+ ");\n";
      }
    }
    return code;
  }

  // casts:
  inline static ThisClass* Cast(Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
  inline static const ThisClass* Cast(const Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
};

class DefaultInitializationNode : public Node
{
protected:
  typedef Node Base;  //Base Class
  typedef DefaultInitializationNode ThisClass;
  DefaultInitializationNode() : Base() {}
  static const int TYPE = kDefaultInitializationNode;

  virtual const char* getTooltip() const { return "This node mark the start of cell default initialization (called before first step)."; }
  virtual const char* getInfo() const { return "This node mark the start of cell default initialization (called before first step).\nBasically defines the the control flow begin of init processing."; }
  virtual void getDefaultTitleBarColors(ImU32& defaultTitleTextColorOut,ImU32& defaultTitleBgColorOut,float& defaultTitleBgColorGradientOut) const {
    // [Optional Override] customize Node Title Colors [default values: 0,0,-1.f => do not override == use default values from the Style()]
    defaultTitleTextColorOut = gMainStyle.TitleTextColorOut_FLOW;defaultTitleBgColorOut = gMainStyle.TitleBgColorOut_FLOW;defaultTitleBgColorGradientOut = gMainStyle.TitleBgColorGradientOut_FLOW;
    }

public:
  // create:
  static ThisClass* Create(const ImVec2& pos) {
    // 1) allocation
   ThisClass* node = (ThisClass*)ImGui::MemAlloc(sizeof(ThisClass)); IM_PLACEMENT_NEW(node) ThisClass();

    node->init("Default Initialization", pos, NULL, "DO", TYPE);
    node->setOpen(false);
    node->mNumFlowPortsOut = 1;

    return node;
  }

protected:
  virtual bool render(float nodeWidth){
    ImGui::Text("Starts the control Flow");
    return false;
  }

  // Evaluate this node returning the code generated
  virtual string Eval(const NodeGraphEditor& nge, int indentLevel, int evalPort = 0, string scope = ""){
    // Begin with the parent eval (a comment indicating the node called)
    string code = Node::Eval(nge, indentLevel);

    // Define the actual level of indentation
    string ind = string(indentLevel*2, ' ');
    mScope = "S"+std::to_string(this->mNodeId)+"S";
    //-------------------------------------------------------------

    // Get the information about nodes and so on
    ImVector<Node*> outputNodes = ImVector<Node*>();
    nge.getOutputNodesForNodeAndSlot(this, 0, outputNodes);

    //-------------------------------------------------------------
    // Check if there is a node connected to it
    code += ind+ "void CACell::DefaultInit(){\n";
      if (outputNodes.size() > 0)
        for(Node* outNode:outputNodes)
          code += ind+ outNode->Eval(nge, indentLevel+1, 0, this->mScope);
    code += ind+ "}\n";

    return code;
  }

  // casts:
  inline static ThisClass* Cast(Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
  inline static const ThisClass* Cast(const Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
};

class GetColorViewerNode : public Node
{
protected:
  typedef Node Base;  //Base Class
  typedef GetColorViewerNode ThisClass;
  GetColorViewerNode() : Base() {}
  static const int TYPE = kGetColorViewerNode;

  int mSelectedMapping;

  virtual const char* getTooltip() const { return "Returns the current colors of the selected attribute color mapping i.e. the viewer mode."; }
  virtual const char* getInfo() const { return "Returns the current colors of the selected attribute color mapping i.e. the viewer mode. \n Could be used to change the current color acoordingly to previous color, or channel...\n Be aware of the types of data. The output is three integers."; }
  virtual void getDefaultTitleBarColors(ImU32& defaultTitleTextColorOut,ImU32& defaultTitleBgColorOut,float& defaultTitleBgColorGradientOut) const {
    // [Optional Override] customize Node Title Colors [default values: 0,0,-1.f => do not override == use default values from the Style()]
    defaultTitleTextColorOut = gMainStyle.TitleTextColorOut_DATA;defaultTitleBgColorOut = gMainStyle.TitleBgColorOut_DATA;defaultTitleBgColorGradientOut = gMainStyle.TitleBgColorGradientOut_DATA;
    }

public:
  // create:
  static ThisClass* Create(const ImVec2& pos) {
    // 1) allocation
   ThisClass* node = (ThisClass*)ImGui::MemAlloc(sizeof(ThisClass)); IM_PLACEMENT_NEW(node) ThisClass();

    node->init("Get Color Viewer", pos, NULL, "r;g;b", TYPE);

    // 3) init fields ( this uses the node->fields variable; otherwise we should have overridden other virtual methods (to render and serialize) )
    node->fields.addFieldEnum(&node->mSelectedMapping, &GetNumEnumItems, &GetTextFromEnumIndex, "", "select which mapping must be considered", &NGEAttrColMappingNames);

    node->mSelectedMapping = 0;

    return node;
  }

  string GetSerializedData() const override {
    json data = {{"mSelectedMapping", mSelectedMapping},};
    return data.dump();
  }

  void SetupFromSerializedData(string serialized_data) override {
    json data = json::parse(serialized_data);
    mSelectedMapping = data["mSelectedMapping"];
  }

protected:
  virtual bool render(float nodeWidth){
    ImGui::Text("Mapping:");
    fields[0].render(nodeWidth);
    ImGui::Text("Retrieved colors /");
    return false;
  }

  // Evaluate this node returning the code generated
  virtual string Eval(const NodeGraphEditor& nge, int indentLevel, int evalPort = 0, string scope = ""){
    // Begin with the parent eval (a comment indicating the node called)
    string code = Node::Eval(nge, indentLevel);

    // Define the actual level of indentation
    string ind = string(indentLevel*2, ' ');
    mScope = scope;
    //-------------------------------------------------------------

    // Get the information about nodes and so on

    //-------------------------------------------------------------
    /*
     */

    // Check if there is a valid attribute
    if (NGEAttrColMappingNames.size()>0 && NGEAttrColMappingNames.size()>mSelectedMapping) {
      string viewerName = string(NGEAttrColMappingNames[mSelectedMapping]);
      string outRName = "out_" + this->getNameOutSlot(0)+ "_" + std::to_string(this->mNodeId) +"_0";
      code += ind+ "int "+ outRName +" = this->VIEWER_"+ viewerName +"[0];\n";
      code += ind+ "typedef int " + outRName + "_TYPE;\n";

      string outGName = "out_" + this->getNameOutSlot(1)+ "_" + std::to_string(this->mNodeId) +"_1";
      code += ind+ "int "+ outGName +" = this->VIEWER_"+ viewerName +"[1];\n";
      code += ind+ "typedef int " + outGName + "_TYPE;\n";

      string outBName = "out_" + this->getNameOutSlot(2)+ "_" + std::to_string(this->mNodeId) +"_2";
      code += ind+ "int "+ outBName +" = this->VIEWER_"+ viewerName +"[2];\n";
      code += ind+ "typedef int " + outBName + "_TYPE;\n";
    }

    return code;
  }

  // casts:
  inline static ThisClass* Cast(Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
  inline static const ThisClass* Cast(const Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
};

class GetColorConstantNode : public Node
{
protected:
  typedef Node Base;  //Base Class
  typedef GetColorConstantNode ThisClass;
  GetColorConstantNode() : Base() {}
  static const int TYPE = kGetColorConstantNode;

  ImVec4 mChosenColor;

  virtual const char* getTooltip() const { return "This node returns the three color channels of a selected color."; }
  virtual const char* getInfo() const { return "This node returns the three color channels of a selected color. \nIt could be used to set more easily the color for a given cell configuration. \n Be aware of the types of data. The output is three integers."; }
  virtual void getDefaultTitleBarColors(ImU32& defaultTitleTextColorOut,ImU32& defaultTitleBgColorOut,float& defaultTitleBgColorGradientOut) const {
    // [Optional Override] customize Node Title Colors [default values: 0,0,-1.f => do not override == use default values from the Style()]
    defaultTitleTextColorOut = gMainStyle.TitleTextColorOut_DATA;defaultTitleBgColorOut = gMainStyle.TitleBgColorOut_DATA;defaultTitleBgColorGradientOut = gMainStyle.TitleBgColorGradientOut_DATA;
    }

public:
  // create:
  static ThisClass* Create(const ImVec2& pos) {
    // 1) allocation
   ThisClass* node = (ThisClass*)ImGui::MemAlloc(sizeof(ThisClass)); IM_PLACEMENT_NEW(node) ThisClass();

    node->init("Get Color Constant", pos, NULL, "r;g;b", TYPE);

    // 3) init fields ( this uses the node->fields variable; otherwise we should have overridden other virtual methods (to render and serialize) )
    node->fields.addFieldColor(&node->mChosenColor.x,false,"","Select the desired color");

    return node;
  }

  string GetSerializedData() const override {
    json data = {{"mChosenColor", {mChosenColor.x, mChosenColor.y, mChosenColor.z}}};
    return data.dump();
  }

  void SetupFromSerializedData(string serialized_data) override {
    json data = json::parse(serialized_data);
    mChosenColor.x = data["mChosenColor"][0];
    mChosenColor.y = data["mChosenColor"][1];
    mChosenColor.z = data["mChosenColor"][2];
  }

protected:
  virtual bool render(float nodeWidth){
    ImGui::Text("Color:");
    fields[0].render(nodeWidth);
    return false;
  }

  // Evaluate this node returning the code generated
  virtual string Eval(const NodeGraphEditor& nge, int indentLevel, int evalPort = 0, string scope = ""){
    // Begin with the parent eval (a comment indicating the node called)
    string code = Node::Eval(nge, indentLevel);

    // Define the actual level of indentation
    string ind = string(indentLevel*2, ' ');
    mScope = scope;
    //-------------------------------------------------------------

    // Get the information about nodes and so on

    //-------------------------------------------------------------
    /*
     */
    if(evalPort == 0) {
      string outRName = "out_" + this->getNameOutSlot(0)+ "_" + std::to_string(this->mNodeId) +"_0";
      code += ind+ "int "+ outRName +" = "+ std::to_string(static_cast<int>(mChosenColor.x*255)) +";\n";
      code += ind+ "typedef int " + outRName + "_TYPE;\n";

    } else if(evalPort == 1) {
      string outGName = "out_" + this->getNameOutSlot(1)+ "_" + std::to_string(this->mNodeId) +"_1";
      code += ind+ "int "+ outGName +" = "+ std::to_string(static_cast<int>(mChosenColor.y*255)) +";\n";
      code += ind+ "typedef int " + outGName + "_TYPE;\n";

    } else {
      string outBName = "out_" + this->getNameOutSlot(2)+ "_" + std::to_string(this->mNodeId) +"_2";
      code += ind+ "int "+ outBName +" = "+ std::to_string(static_cast<int>(mChosenColor.z*255)) +";\n";
      code += ind+ "typedef int " + outBName + "_TYPE;\n";
    }

    return code;
  }

  // casts:
  inline static ThisClass* Cast(Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
  inline static const ThisClass* Cast(const Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
};
//------- End of nodes classes-------

static Node* TestNodeFactory(int nt, const ImVec2& pos) {
  switch (nt) {
  case kStepNode: return StepNode::Create(pos);
  case kGetModelAttributeNode: return GetModelAttributeNode::Create(pos);
  case kGetCellAttributeNode: return GetCellAttributeNode::Create(pos);
  case kGetNeighborsAttributeNode: return GetNeighborsAttributeNode::Create(pos);
  case kGetConstantNode: return GetConstant::Create(pos);
  case kGetRandomNode: return GetRandomNode::Create(pos);
  case kStatementNode: return StatementNode::Create(pos);
  case kLogicOperatorNode: return LogicOperatorNode::Create(pos);
  case kSetAttributeNode: return SetAttributeNode::Create(pos);
  case kConditionalNode: return ConditionalNode::Create(pos);
  case kLoopNode: return LoopNode::Create(pos);
  case kSequenceNode: return SequenceNode::Create(pos);
  case kArithmeticOperatorNode: return ArithmeticOperatorNode::Create(pos);
  case kGroupStatementNode: return GroupStatementNode::Create(pos);
  case kGroupOperatorNode: return GroupOperatorNode::Create(pos);
  case kGroupCountingNode: return GroupCountingNode::Create(pos);
  case kInputColorNode: return InputColorNode::Create(pos);
  case kSetColorViewerNode: return SetColorViewerNode::Create(pos);
  case kDefaultInitializationNode: return DefaultInitializationNode::Create(pos);
  case kGetColorViewerNode: return GetColorViewerNode::Create(pos);
  case kGetColorConstantNode: return GetColorConstantNode::Create(pos);

  default:
    IM_ASSERT(true);    // Missing node type creation
    return NULL;
  }
  return NULL;
}

} // namespace ImGui
// END NODE DEFINITIONS ============================================================

// Mandatory methods
void InitNGE(ImGui::NodeGraphEditor &nge) {
  if (!nge.isInited())	{
    // This adds entries to the "add node" context menu
    nge.registerNodeTypes(ImGui::NodeTypeNames, ImGui::kNumNodesTypes, ImGui::TestNodeFactory, NULL, -1); // last 2 args can be used to add only a subset of nodes (or to sort their order inside the context menu)
    nge.registerNodeTypeMaxAllowedInstances(ImGui::kStepNode, 1); // Here we set the max number of allowed instances of the node (1)
    nge.registerNodeTypeMaxAllowedInstances(ImGui::kDefaultInitializationNode, 1);
  }
}

#endif // NODE_GRAPH_INSTANCE_H
