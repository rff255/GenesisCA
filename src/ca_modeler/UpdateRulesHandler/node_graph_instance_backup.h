#ifndef NODE_GRAPH_INSTANCE_H
#define NODE_GRAPH_INSTANCE_H

//#include <string.h>     //strcpy
#include <vector>
#include <string>
#include "imguinodegrapheditor.h"

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
#define MAX_ENUM_NAME_LENGTH    84                                  // in bytes
typedef ImVector<char[MAX_ENUM_NAME_LENGTH]> TestEnumNamesType;    // so that it works without STL (std::vector<std::string> will be easier to implement)
TestEnumNamesType TestEnumNames;
//std::vector<std::string> TestEnumNames;
int TestEnumNamesInsert(const char* name) {
  if (!name) return -1;
  const int len = strlen(name);
  if (len <= 0 || len + 1 >= MAX_ENUM_NAME_LENGTH) return -1;

  // We want to add the item in a sorted way. First we must calculate "itemPlacement"
  int itemPlacement = TestEnumNames.size();
  //int itemPlacement = 0, comp = 0;
  //for (int i = 0, iSz = TestEnumNames.size(); i<iSz; i++) {
  //  comp = strcmp(name, &TestEnumNames[i][0]);
  //  if (comp>0) ++itemPlacement;
  //  else if (comp == 0) return -1;    // already present
  //}

  // Here we insert "name" at "itemPlacement"
  TestEnumNames.resize(TestEnumNames.size() + 1);
  for (int i = TestEnumNames.size() - 1; i>itemPlacement; --i) strcpy(&TestEnumNames[i][0], &TestEnumNames[i - 1][0]);
  strcpy(&TestEnumNames[itemPlacement][0], name);

  return itemPlacement;
}
bool TestEnumNamesDelete(int itemIndex) {
  // We must delete the item
  int size = TestEnumNames.size();
  for (int i = itemIndex; i<size - 1; i++) {
    strcpy(&TestEnumNames[i][0], &TestEnumNames[i + 1][0]);
  }
  --size; TestEnumNames.resize(size);
  return true;
}

void TestEnumNamesClear() {
  TestEnumNames.clear();
}

// NODE DEFINITIONS ================================================================
namespace ImGui {
enum TestNodeTypes {
  TNT_CUSTOM_ENUM_EDITOR_NODE = 0,
  TNT_CUSTOM_ENUM_USER_NODE,
  TNT_COUNT
};
static const char* TestNodeTypeNames[TNT_COUNT] = { "Custom Enum Editor", "Custom Enum User" };
class CustomEnumEditorNode : public Node {
protected:
  typedef Node Base;  //Base Class
  typedef CustomEnumEditorNode ThisClass;
  CustomEnumEditorNode() : Base() {}
  static const int TYPE = TNT_CUSTOM_ENUM_EDITOR_NODE;

  int selectedEnumIndex;       // field
  char buf[MAX_ENUM_NAME_LENGTH];

public:

  virtual const char* getTooltip() const { return "CustomEnumEditorNode tooltip."; }
  virtual const char* getInfo() const { return "CustomEnumEditorNode info.\n\nThis is supposed to display some info about this node."; }
  /*virtual void getDefaultTitleBarColors(ImU32& defaultTitleTextColorOut,ImU32& defaultTitleBgColorOut,float& defaultTitleBgColorGradientOut) const {
    // [Optional Override] customize Node Title Colors [default values: 0,0,-1.f => do not override == use default values from the Style()]
    defaultTitleTextColorOut = IM_COL32(220,220,220,255);defaultTitleBgColorOut = IM_COL32(0,75,0,255);defaultTitleBgColorGradientOut = -1.f;
    }*/

  // create:
  static ThisClass* Create(const ImVec2& pos) {
    // 1) allocation
    // MANDATORY (NodeGraphEditor::~NodeGraphEditor() will delete these with ImGui::MemFree(...))
    // MANDATORY even with blank ctrs. Reason: ImVector does not call ctrs/dctrs on items.
    ThisClass* node = (ThisClass*)ImGui::MemAlloc(sizeof(ThisClass)); IM_PLACEMENT_NEW(node) ThisClass();

    // 2) main init
    node->init("CustomEnumEditorNode", pos, "", "", TYPE);

    // 3) init fields ( this uses the node->fields variable; otherwise we should have overridden other virtual methods (to render and serialize) )
    node->fields.addFieldEnum(&node->selectedEnumIndex, &CustomEnumEditorNode::GetNumEnumItems, &CustomEnumEditorNode::GetTextFromEnumIndex, "###CustomEnumEditor", NULL, &TestEnumNames);

    // 4) set (or load) field values
    node->selectedEnumIndex = 0;
    node->buf[0] = '\0';

    return node;
  }

protected:
  virtual bool render(float nodeWidth);

public:

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

  // casts:
  inline static ThisClass* Cast(Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
  inline static const ThisClass* Cast(const Node* n) { return Node::Cast<ThisClass>(n, TYPE); }

};
class ColorEnumUserNode : public Node, public ITestEnum
{
protected:
  typedef Node Base;  //Base Class
  typedef ColorEnumUserNode ThisClass;
  ColorEnumUserNode() : Base() {}
  static const int TYPE = TNT_CUSTOM_ENUM_USER_NODE;

  int selectedEnumIndex;       // field

  virtual const char* getTooltip() const { return "ColorEnumUserNode tooltip."; }
  virtual const char* getInfo() const { return "ColorEnumUserNode info.\n\nThis is supposed to display some info about this node."; }
  /*virtual void getDefaultTitleBarColors(ImU32& defaultTitleTextColorOut,ImU32& defaultTitleBgColorOut,float& defaultTitleBgColorGradientOut) const {
    // [Optional Override] customize Node Title Colors [default values: 0,0,-1.f => do not override == use default values from the Style()]
    defaultTitleTextColorOut = IM_COL32(220,220,220,255);defaultTitleBgColorOut = IM_COL32(0,75,0,255);defaultTitleBgColorGradientOut = -1.f;
    }*/

public:

  int& getSelectedItem() { return selectedEnumIndex; }  // ITestEnum
  friend class CustomEnumEditorNode;

  // create:
  static ThisClass* Create(const ImVec2& pos) {
    // 1) allocation
    // MANDATORY (NodeGraphEditor::~NodeGraphEditor() will delete these with ImGui::MemFree(...))
    // MANDATORY even with blank ctrs. Reason: ImVector does not call ctrs/dctrs on items.
    ThisClass* node = (ThisClass*)ImGui::MemAlloc(sizeof(ThisClass)); IM_PLACEMENT_NEW(node) ThisClass();

    // 2) main init
    node->init("ColorEnumUserNode", pos, "in_a;in_b", "out_a;out_b", TYPE);

    // 3) init fields ( this uses the node->fields variable; otherwise we should have overridden other virtual methods (to render and serialize) )
    node->fields.addFieldEnum(&node->selectedEnumIndex, &CustomEnumEditorNode::GetNumEnumItems, &CustomEnumEditorNode::GetTextFromEnumIndex, "Selection", "select your favourite", &TestEnumNames);

    // 4) set (or load) field values
    node->selectedEnumIndex = 0;

    return node;
  }


  // casts:
  inline static ThisClass* Cast(Node* n) { return Node::Cast<ThisClass>(n, TYPE); }
  inline static const ThisClass* Cast(const Node* n) { return Node::Cast<ThisClass>(n, TYPE); }


};

bool CustomEnumEditorNode::render(float nodeWidth) // should return "true" if the node has been edited and its values modified (to fire "edited callbacks")
{
  bool nodeEdited = false;
  if (ImGui::InputText("New item", buf, MAX_ENUM_NAME_LENGTH, ImGuiInputTextFlags_EnterReturnsTrue)) {
    if (strlen(buf)>0)  {
      const int itemIndex = TestEnumNamesInsert(buf);
      if (itemIndex >= 0)  {
        buf[0] = '\0';
        selectedEnumIndex = itemIndex;
        nodeEdited = true;
        //Now we must correct all the "selectedItem>=itemPlacement" in all the NodeGraphEditor
        ImGui::NodeGraphEditor& nge = getNodeGraphEditor();
        for (int i = 0, iSz = nge.getNumNodes(); i < iSz; i++)    {
          ITestEnum* n = dynamic_cast<ITestEnum*>(nge.getNode(i));
          if (n)  {
            int& selectedIndexEnum = n->getSelectedItem();
            if (selectedIndexEnum >= itemIndex) ++selectedIndexEnum;
          }
        }
      }
    }
  }
  fields[0].render(nodeWidth);
  if (TestEnumNames.size()>0) {
    ImGui::SameLine();
    if (ImGui::SmallButton("x") && TestEnumNamesDelete(selectedEnumIndex)) {
      nodeEdited = true;

      //Now we must correct all the "selectedItem>=selectedEnumIndex" in all the NodeGraphEditor
      ImGui::NodeGraphEditor& nge = getNodeGraphEditor();
      for (int i = 0, iSz = nge.getNumNodes(); i<iSz; i++)    {
        ITestEnum* n = dynamic_cast<ITestEnum*>(nge.getNode(i));
        if (n)  {
          int& selectedIndexEnum = n->getSelectedItem();
          if (selectedIndexEnum >= selectedEnumIndex) --selectedIndexEnum;
        }
      }
      if (--selectedEnumIndex<0) selectedEnumIndex = 0;
    }
  }
  return nodeEdited;
}

static Node* TestNodeFactory(int nt, const ImVec2& pos) {
  switch (nt) {
  case TNT_CUSTOM_ENUM_EDITOR_NODE: return CustomEnumEditorNode::Create(pos);
  case TNT_CUSTOM_ENUM_USER_NODE: return ColorEnumUserNode::Create(pos);
  default:
    IM_ASSERT(true);    // Missing node type creation
    return NULL;
  }
  return NULL;
}

} // namespace ImGui
// END NODE DEFINITIONS ============================================================

const char* TestEnumNamesSavePath = "testEnumNames.txt";

ImGui::NodeGraphEditor nge;
// Mandatory methods
void InitNGE() {
  if (nge.isInited())	{
    // We should load "TestEnumNames" from a file here. Instead we do:
#       if (defined(IMGUIHELPER_H_) && !defined(NO_IMGUIHELPER_SERIALIZATION) && !defined(NO_IMGUIHELPER_SERIALIZATION_LOAD))
    TestEnumNamesLoad(TestEnumNamesSavePath);
#       endif
    if (TestEnumNames.size() == 0)    {
      // Starting items (sorted alphabetically)
      TestEnumNames.resize(3);
      strcpy(&TestEnumNames[0][0], "APPLE");
      strcpy(&TestEnumNames[1][0], "LEMON");
      strcpy(&TestEnumNames[2][0], "ORANGE");
    }

    // This adds entries to the "add node" context menu
    nge.registerNodeTypes(ImGui::TestNodeTypeNames, ImGui::TNT_COUNT, ImGui::TestNodeFactory, NULL, -1); // last 2 args can be used to add only a subset of nodes (or to sort their order inside the context menu)
    nge.registerNodeTypeMaxAllowedInstances(ImGui::TNT_CUSTOM_ENUM_EDITOR_NODE, 1); // Here we set the max number of allowed instances of the node (1)

    // Optional: starting nodes and links (load from file instead):-----------
    nge.addNode(ImGui::TNT_CUSTOM_ENUM_EDITOR_NODE, ImVec2(40, 50));
    ImGui::Node* colorEnumUserNode1 = nge.addNode(ImGui::TNT_CUSTOM_ENUM_USER_NODE, ImVec2(40, 180));
    ImGui::Node* colorEnumUserNode2 = nge.addNode(ImGui::TNT_CUSTOM_ENUM_USER_NODE, ImVec2(300, 180)); // optionally use e.g.: ImGui::ColorEnumUserNode::Cast(colorEnumUserNode1)->...;
    ImGui::Node* colorEnumUserNode3 = nge.addNode(ImGui::TNT_CUSTOM_ENUM_USER_NODE, ImVec2(550, 180));

    nge.addLink(colorEnumUserNode1, 0, colorEnumUserNode2, 0);
    nge.addLink(colorEnumUserNode1, 1, colorEnumUserNode2, 1);
    nge.addLink(colorEnumUserNode2, 0, colorEnumUserNode3, 0);
    nge.addLink(colorEnumUserNode2, 1, colorEnumUserNode3, 1);
    //-------------------------------------------------------------------------------
    //nge.load("nodeGraphEditor.nge");  // Please note than if the saved graph has nodes out of our active subset, they will be displayed as usual (it's not clear what should be done in this case: hope that's good enough, it's a user's mistake).
    //-------------------------------------------------------------------------------
    nge.show_style_editor = true;
    nge.show_load_save_buttons = true;
    // optional load the style (for all the editors: better call it in InitGL()):
    //NodeGraphEditor::Style::Load(NodeGraphEditor::GetStyle(),"nodeGraphEditor.style");
    //--------------------------------------------------------------------------------
  }
}

#endif // NODE_GRAPH_INSTANCE_H
