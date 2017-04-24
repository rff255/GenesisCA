#ifndef NODE_GRAPH_INSTANCE_H
#define NODE_GRAPH_INSTANCE_H

//#include <string.h>     //strcpy
#include <vector>
#include <string>
#include "imguinodegrapheditor.h"

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

// The interface change this, and call UpdateEnumNames
std::vector<std::string> gCellAttrNames;
std::vector<std::string> gModelAttrNames;
std::vector<std::string> gNeighborhoodNames;

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

  // Paste from vectors
  NGECellAttrNames.resize(gCellAttrNames.size());
  for(int i=0; i<gCellAttrNames.size(); ++i)
    strcpy(&NGECellAttrNames[i][0], gCellAttrNames[i].c_str());

  NGEModelAttrNames.resize(gModelAttrNames.size());
  for(int i=0; i<gModelAttrNames.size(); ++i)
    strcpy(&NGEModelAttrNames[i][0], gModelAttrNames[i].c_str());

  NGENeighborhoodNames.resize(gNeighborhoodNames.size());
  for(int i=0; i<gNeighborhoodNames.size(); ++i)
    strcpy(&NGENeighborhoodNames[i][0], gNeighborhoodNames[i].c_str());
}

// NODE DEFINITIONS ================================================================
namespace ImGui {
enum NodeTypes {
  kStepNode = 0,
  kGetModelAttributeNode,
  kGetCellAttributeNode,
  kGetNeighborsAttributeNode,
  kGetConstantNode,
  kGetRandomNumber,
  kStatementNode,
  kBooleanOperatorNode,
  kSetAttributeNode,
  kConditionalNode,
  kLoopNode,
  kSequenceNode,
  kArithmeticOperatorNode,
  kGroupStatementNode,
  kGroupOperatorNode,
  kGroupCountingNode,
  kNumNodesTypes
};

static const char* NodeTypeNames[kNumNodesTypes] = { "Step",
                                                     "Get Model Attribute",
                                                     "Get Cell Attribute",
                                                     "Get Neighbors Attribute",
                                                     "Get Constant",
                                                     "Get Random Number",
                                                     "Statement",
                                                     "Boolean Operator",
                                                     "Set Attribute",
                                                     "Conditional",
                                                     "Loop",
                                                     "Sequence",
                                                     "Arithmetic Operator",
                                                     "Group Statement",
                                                     "Group Operator",
                                                     "Group Counting"
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

  // Evaluate this node returning the code generated
  virtual string Eval(const NodeGraphEditor& nge, int indentLevel){
    // Begin with the parent eval (a comment indicating the node called)
    string code = Node::Eval(nge, indentLevel);

    // Define the actual level of indentation
    string ind = string(indentLevel*2, ' ');
    //-------------------------------------------------------------

    // Get the information about nodes and so on
    Node* outNode = nge.getOutputNodeForNodeAndSlot(this, 0);

    //-------------------------------------------------------------
    // Check if there is a node connected to it
    if (outNode) {
     code +=
         ind+ "void Step(){\n" +
         ind+ outNode->Eval(nge, indentLevel+1) +
         ind+ "}\n"
         ;
    }

    return code;
  }

protected:
  virtual bool render(float nodeWidth){
    ImGui::Text("Starts the control Flow");
    return false;
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

protected:
  virtual bool render(float nodeWidth){
    ImGui::Text("Attribute:");
    fields[0].render(nodeWidth);
    return false;
  }

  // Evaluate this node returning the code generated
  virtual string Eval(const NodeGraphEditor& nge, int indentLevel){
    // Begin with the parent eval (a comment indicating the node called)
    string code = Node::Eval(nge, indentLevel);

    // Define the actual level of indentation
    string ind = string(indentLevel*2, ' ');
    //-------------------------------------------------------------

    // Get the information about nodes and so on

    //-------------------------------------------------------------
    // Check if there is a valid attribute
    if (NGEModelAttrNames.size()>=mSelectedAttrIndex) {
      string varNewValue = "out_" +this->getNameOutSlot(0)+ "_" + std::to_string(this->mNodeId) + "_" + std::to_string(0);

      code += ind+ varNewValue + " = this->CAModel->attr_"+ NGEModelAttrNames[mSelectedAttrIndex] +";\n";
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

protected:
  virtual bool render(float nodeWidth){
    ImGui::Text("Attribute:");
    fields[0].render(nodeWidth);
    return false;
  }

  // Evaluate this node returning the code generated
  virtual string Eval(const NodeGraphEditor& nge, int indentLevel){
    // Begin with the parent eval (a comment indicating the node called)
    string code = Node::Eval(nge, indentLevel);

    // Define the actual level of indentation
    string ind = string(indentLevel*2, ' ');
    //-------------------------------------------------------------

    // Get the information about nodes and so on

    //-------------------------------------------------------------
    // Check if there is a valid attribute
    if (NGECellAttrNames.size()>=mSelectedAttrIndex) {
      string varNewValue = "out_" +this->getNameOutSlot(0)+ "_" + std::to_string(this->mNodeId) + "_" + std::to_string(0);

      code += ind+ varNewValue + " = this->attr_"+ NGECellAttrNames[mSelectedAttrIndex] +";\n";
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

protected:
  virtual bool render(float nodeWidth){
    ImGui::Text("Neighborhood:");
    fields[0].render(nodeWidth);
    ImGui::Text("Attribute:");
    fields[1].render(nodeWidth);
    return false;
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
  static const int TextBufferSize = 128;

  // Fields
  char mValue[TextBufferSize];

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
    //node->baseWidthOverride = 200.f;    // (optional) default base node width is 120.f;

    // 3) init fields ( this uses the node->fields variable; otherwise we should have overridden other virtual methods (to render and serialize) )
    node->fields.addFieldTextEdit(&node->mValue[0], TextBufferSize, "Value:", "Type the value you want for this constant", ImGuiInputTextFlags_EnterReturnsTrue);

    //4) Init values
    strcpy(node->mValue, "");

    return node;
  }

  // Evaluate this node returning the code generated
  virtual string Eval(const NodeGraphEditor& nge, int indentLevel){
    // Begin with the parent eval (a comment indicating the node called)
    string code = Node::Eval(nge, indentLevel);

    // Define the actual level of indentation
    string ind = string(indentLevel*2, ' ');
    //-------------------------------------------------------------

    // Get the information about nodes and so on

    //-------------------------------------------------------------
    // Check if there is a node connected to it
    string varConstant = "out_" +this->getNameOutSlot(0)+ "_" + std::to_string(this->mNodeId) + "_" + std::to_string(0);

    code += ind+ varConstant +" = " +mValue+ ";\n";

    return code;
  }

  // casts:
  inline static ThisClass* Cast(Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
  inline static const ThisClass* Cast(const Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
};

class GetRandomNumber : public Node
{
protected:
  typedef Node Base;  //Base Class
  typedef GetRandomNumber ThisClass;
  GetRandomNumber() : Base() {}
  static const int TYPE = kGetRandomNumber;

  // Fields
  bool  mIsInteger;

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

    node->init("Get Random Number", pos, NULL, "value", TYPE);

    node->mIsInteger = false;
    node->mFirstNumberI = 0;
    node->mSecondNumberI = 0;

    node->mFirstNumberF = 0.f;
    node->mSecondNumberF = 0.f;

    return node;
  }

protected:
  virtual bool render(float nodeWidth){
    ImGui::Checkbox("Integer", &mIsInteger);
    if(mIsInteger)
    {
      ImGui::Text("From:");
      ImGui::InputInt("##FromInt", &mFirstNumberI);
      ImGui::Text("To:");
      ImGui::InputInt("##ToInt:", &mSecondNumberI);
    }
    else
    {
      ImGui::Text("From:");
      ImGui::InputFloat("##FromFloat", &mFirstNumberF);
      ImGui::Text("To:");
      ImGui::InputFloat("##ToFloat", &mSecondNumberF);
    }
    return false;
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

protected:
  virtual bool render(float nodeWidth){
    ImGui::Text("Operation:");
    fields[0].render(nodeWidth);
    return false;
  }

  // casts:
  inline static ThisClass* Cast(Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
  inline static const ThisClass* Cast(const Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
};

class BooleanOperatorNode : public Node, public ITestEnum
{
protected:
  typedef Node Base;  //Base Class
  typedef BooleanOperatorNode ThisClass;
  BooleanOperatorNode() : Base() {}
  static const int TYPE = kBooleanOperatorNode;

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
    static const char* operations[7] = {"AND", "OR", "NOT", "NAND", "NOR", "XOR", "XNOR"};
    node->fields.addFieldEnum(&node->mSelectedOperationIndex, 7, operations, "", "select the boolean operator to be used");

    node->mSelectedOperationIndex = 0;

    return node;
  }

protected:
  virtual bool render(float nodeWidth){
    ImGui::Text("Operation:");
    fields[0].render(nodeWidth);
    return false;
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

protected:
  virtual bool render(float nodeWidth){
    ImGui::Text("Attribute:");
    fields[0].render(nodeWidth);
    return false;
  }

  // Evaluate this node returning the code generated
  virtual string Eval(const NodeGraphEditor& nge, int indentLevel){
    // Begin with the parent eval (a comment indicating the node called)
    string code = Node::Eval(nge, indentLevel);

    // Define the actual level of indentation
    string ind = string(indentLevel*2, ' ');
    //-------------------------------------------------------------

    // Get the information about nodes and so on
    int inValuePort;
    Node* inValue = nge.getInputNodeForNodeAndSlot(this, 1, &inValuePort);

    //-------------------------------------------------------------
    // Check if there is a node connected to it
    if (inValue && NGECellAttrNames.size()>=mSelectedAttrIndex) {  // Check if there is a valid attribute
      string varNewValue = "out_" +inValue->getNameOutSlot(inValuePort)+ "_" + std::to_string(inValue->mNodeId) + "_" + std::to_string(inValuePort);

      code +=
          inValue->Eval(nge, indentLevel) + // Here the variable out_portName_nodeID_port must be set
          ind+ "this->attr_"+ NGECellAttrNames[mSelectedAttrIndex] +" = " +varNewValue+ ";\n";
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

  // Evaluate this node returning the code generated
  virtual string Eval(const NodeGraphEditor& nge, int indentLevel){
    // Begin with the parent eval (a comment indicating the node called)
    string code = Node::Eval(nge, indentLevel);

    // Define the actual level of indentation
    string ind = string(indentLevel*2, ' ');
    //-------------------------------------------------------------

    // Get the information about nodes and so on
    int inIfPort;
    Node* inIf    = nge.getInputNodeForNodeAndSlot(this, 1, &inIfPort);
    Node* outThen = nge.getOutputNodeForNodeAndSlot(this, 0);
    Node* outElse = nge.getOutputNodeForNodeAndSlot(this, 1);

    //-------------------------------------------------------------
    // Check if there is a node connected to it
    if (inIf) {
      string varCondition = "out_" +inIf->getNameOutSlot(inIfPort)+ "_" + std::to_string(inIf->mNodeId) + "_" + std::to_string(inIfPort);

      code +=
          inIf->Eval(nge, indentLevel) + // Here the variable out_portName_nodeID_port must be set
          ind+ "if(" +varCondition+ "){\n";

      if(outThen) // If there is a link for THEN
        code += outThen->Eval(nge, indentLevel+1);

      code += ind+ "} else {\n";

      if(outElse) // If there is a link for ELSE
        code += outElse->Eval(nge, indentLevel+1);

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
  virtual string Eval(const NodeGraphEditor& nge, int indentLevel){
    // Begin with the parent eval (a comment indicating the node called)
    string code = Node::Eval(nge, indentLevel);

    // Define the actual level of indentation
    string ind = string(indentLevel*2, ' ');
    //-------------------------------------------------------------

    // Get the information about nodes and so on
    int inRepeatPort;
    Node* inRepeat = nge.getInputNodeForNodeAndSlot(this, 1, &inRepeatPort);
    Node* outDo    = nge.getOutputNodeForNodeAndSlot(this, 0);

    //-------------------------------------------------------------
    // Check if there is a node connected to it
    if (inRepeat) {
      string varRepeatNumber = "out_" +inRepeat->getNameOutSlot(inRepeatPort)+ "_" + std::to_string(inRepeat->mNodeId) + "_" + std::to_string(inRepeatPort);

      code +=
          inRepeat->Eval(nge, indentLevel) + // Here the variable out_portName_nodeID_port must be set
          ind+ "for(int i=0; i<" +varRepeatNumber+ ";++i){\n";

      if(outDo) // If there is a link for DO
        code += outDo->Eval(nge, indentLevel+1);

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
    node->mNumFlowPortsIn = 1;
    node->mNumFlowPortsOut = 2;

    return node;
  }

  // Evaluate this node returning the code generated
  virtual string Eval(const NodeGraphEditor& nge, int indentLevel){
    // Begin with the parent eval (a comment indicating the node called)
    string code = Node::Eval(nge, indentLevel);

    // Define the actual level of indentation
    string ind = string(indentLevel*2, ' ');
    //-------------------------------------------------------------

    // Get the information about nodes and so on
    Node* outFirst = nge.getOutputNodeForNodeAndSlot(this, 0);
    Node* outThen = nge.getOutputNodeForNodeAndSlot(this, 1);

    //-------------------------------------------------------------
    if (outFirst)    // If there is a link for FIRST
      code += outFirst->Eval(nge, indentLevel);


    if (outThen) {   // If there is a link for THEN
      if (outFirst)
        code += "\n";  // Extra breakline to increase readability
      code += outThen->Eval(nge, indentLevel);
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
    static const char* operations[8] = {"SUM", "SUB", "MUL", "MEAN", "POW", "SQRT", "MAX", "MIN"};
    node->fields.addFieldEnum(&node->mSelectedOperationIndex, 8, operations, "", "select the arithmetic operator to be used");

    node->mSelectedOperationIndex = 0;

    return node;
  }

protected:
  virtual bool render(float nodeWidth){
    ImGui::Text("Operation:");
    fields[0].render(nodeWidth);
    return false;
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

protected:
  virtual bool render(float nodeWidth){
    ImGui::Text("Assert operation:");
    fields[0].render(nodeWidth);
    return false;
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
  virtual const char* getInfo() const { return "This Node offers arithmetic and boolean operations for a list of elements. \nYou can mark the 'Boolean Type' option to switch for ooolean operations. \nBe aware of the types involved in the operations!"; }
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
    static const char* BoolOperations[5] = {"AND", "OR", "MAJORITY", "MONORITY", "PICK RANDOM"};
    node->fields.addFieldEnum(&node->mBoolOperIndex, 5, BoolOperations, "", "select the boolean operator to be used");

    static const char* ArithOperations[9] = {"SUM", "MUL", "MEAN", "MAX", "MIN", "MEDIAN", "STD", "VAR", "PICK RANDOM"};
    node->fields.addFieldEnum(&node->mArithOperIndex, 9, ArithOperations, "", "select the arithmetic operator to be used");

    node->mBooleanType = false;
    node->mArithOperIndex = 0;
    node->mBoolOperIndex = 0;

    return node;
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

protected:
  virtual bool render(float nodeWidth){
    ImGui::Text("Operation:");
    fields[0].render(nodeWidth);
    return false;
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
  case kGetRandomNumber: return GetRandomNumber::Create(pos);
  case kStatementNode: return StatementNode::Create(pos);
  case kBooleanOperatorNode: return BooleanOperatorNode::Create(pos);
  case kSetAttributeNode: return SetAttributeNode::Create(pos);
  case kConditionalNode: return ConditionalNode::Create(pos);
  case kLoopNode: return LoopNode::Create(pos);
  case kSequenceNode: return SequenceNode::Create(pos);
  case kArithmeticOperatorNode: return ArithmeticOperatorNode::Create(pos);
  case kGroupStatementNode: return GroupStatementNode::Create(pos);
  case kGroupOperatorNode: return GroupOperatorNode::Create(pos);
  case kGroupCountingNode: return GroupCountingNode::Create(pos);
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
  if (nge.isInited())	{
    // This adds entries to the "add node" context menu
    nge.registerNodeTypes(ImGui::NodeTypeNames, ImGui::kNumNodesTypes, ImGui::TestNodeFactory, NULL, -1); // last 2 args can be used to add only a subset of nodes (or to sort their order inside the context menu)
    nge.registerNodeTypeMaxAllowedInstances(ImGui::kStepNode, 1); // Here we set the max number of allowed instances of the node (1)

    // Optional: starting nodes and links (load from file instead):-----------
    nge.addNode(ImGui::kStepNode, ImVec2(-80, 110));
    nge.addNode(ImGui::kGetModelAttributeNode, ImVec2(20, 20));
    nge.addNode(ImGui::kGetCellAttributeNode, ImVec2(200, 20)); // optionally use e.g.: ImGui::ColorEnumUserNode::Cast(colorEnumUserNode1)->...;
    nge.addNode(ImGui::kGetNeighborsAttributeNode, ImVec2(400, 20));
    nge.addNode(ImGui::kGetConstantNode, ImVec2(20, 120));
    nge.addNode(ImGui::kStatementNode, ImVec2(200, 120));
    nge.addNode(ImGui::kBooleanOperatorNode, ImVec2(400, 120));
    nge.addNode(ImGui::kConditionalNode, ImVec2(20, 220));
    nge.addNode(ImGui::kSetAttributeNode, ImVec2(200, 220));
    nge.addNode(ImGui::kLoopNode, ImVec2(400, 220));
    nge.addNode(ImGui::kSequenceNode, ImVec2(20, 320));
    nge.addNode(ImGui::kGetRandomNumber, ImVec2(200, 320));
    nge.addNode(ImGui::kArithmeticOperatorNode, ImVec2(400, 320));
    nge.addNode(ImGui::kGroupStatementNode, ImVec2(20, 420));
    nge.addNode(ImGui::kGroupOperatorNode, ImVec2(200, 450));
    nge.addNode(ImGui::kGroupCountingNode, ImVec2(400, 420));

//    nge.addLink(colorEnumUserNode1, 0, colorEnumUserNode2, 0);
//    nge.addLink(colorEnumUserNode1, 1, colorEnumUserNode2, 1);
//    nge.addLink(colorEnumUserNode2, 0, colorEnumUserNode3, 0);
//    nge.addLink(colorEnumUserNode2, 1, colorEnumUserNode3, 1);

  }
}

#endif // NODE_GRAPH_INSTANCE_H
