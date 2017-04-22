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
  kNumNodesTypes
};
// // TODO: test line break at names
static const char* NodeTypeNames[kNumNodesTypes] = { "Step",
                                                     "Get Model Attribute",
                                                     "Get Cell Attribute"};

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
  virtual const char* getInfo() const { return "This node mark the start of cell update rule.\nBasically defines the the control flux begin of processing."; }
  virtual void getDefaultTitleBarColors(ImU32& defaultTitleTextColorOut,ImU32& defaultTitleBgColorOut,float& defaultTitleBgColorGradientOut) const {
    // [Optional Override] customize Node Title Colors [default values: 0,0,-1.f => do not override == use default values from the Style()]
    defaultTitleTextColorOut = IM_COL32(0,0,0,255);defaultTitleBgColorOut = IM_COL32(220,80,0,255);defaultTitleBgColorGradientOut = 0.5f;
    }

public:
  // create:
  static ThisClass* Create(const ImVec2& pos) {
    // 1) allocation
   ThisClass* node = (ThisClass*)ImGui::MemAlloc(sizeof(ThisClass)); IM_PLACEMENT_NEW(node) ThisClass();

    node->init("Step", pos, NULL, "Do", TYPE);
    //node->setOpen(false);

    return node;
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
    defaultTitleTextColorOut = IM_COL32(220,220,220,255);defaultTitleBgColorOut = IM_COL32(0,0,75,255);defaultTitleBgColorGradientOut = 0.1f;
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

    // 4) set (or load) field values
    node->mSelectedAttrIndex = 0;

    return node;
  }

protected:
  virtual bool render(float nodeWidth){
    ImGui::Text("Attribute:");
    fields[0].render(nodeWidth);
    return false;
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
    defaultTitleTextColorOut = IM_COL32(220,220,220,255);defaultTitleBgColorOut = IM_COL32(0,0,75,255);defaultTitleBgColorGradientOut = 0.1f;
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

    // 4) set (or load) field values
    node->mSelectedAttrIndex = 0;

    return node;
  }

protected:
  virtual bool render(float nodeWidth){
    ImGui::Text("Attribute:");
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
    nge.addNode(ImGui::kStepNode, ImVec2(40, 50));
    nge.addNode(ImGui::kGetModelAttributeNode, ImVec2(40, 180));
    nge.addNode(ImGui::kGetCellAttributeNode, ImVec2(300, 180)); // optionally use e.g.: ImGui::ColorEnumUserNode::Cast(colorEnumUserNode1)->...;

//    nge.addLink(colorEnumUserNode1, 0, colorEnumUserNode2, 0);
//    nge.addLink(colorEnumUserNode1, 1, colorEnumUserNode2, 1);
//    nge.addLink(colorEnumUserNode2, 0, colorEnumUserNode3, 0);
//    nge.addLink(colorEnumUserNode2, 1, colorEnumUserNode3, 1);

  }
}

#endif // NODE_GRAPH_INSTANCE_H
