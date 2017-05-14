#include "update_rules_editor.h"

#include "imguinodegrapheditor.h"
#include "node_graph_instance.h"

#include <vector>
#include <string>

UpdateRulesEditor::UpdateRulesEditor(){
  mEditor = ImGui::NodeGraphEditor();
}

void UpdateRulesEditor::Init(){
  mEditor.show_node_copy_paste_buttons = false;
  mEditor.show_style_editor = false;
  mEditor.show_top_pane = true;

  InitNGE(mEditor);
}

std::string UpdateRulesEditor::EvalGraphEditorStep() {
  // Get the step node, for initiate the code generation
  ImVector<ImGui::Node*> stepNodes = ImVector<ImGui::Node*>(); // There is only one step node, but the function is generic
  mEditor.getAllNodesOfType(ImGui::NodeTypes::kStepNode, &stepNodes);

  // By calling the step Eval(), all the reachable nodes will be also called recursively
  if(stepNodes.size() > 0)
    return stepNodes[0]->Eval(mEditor, 0);
  return "\n";
}

std::string UpdateRulesEditor::EvalGraphEditorDefaultInit()
{
  // Get the DefaultInit node, for initiate the code generation
  ImVector<ImGui::Node*> defaultInitNodes = ImVector<ImGui::Node*>(); // There is only one default initialization node at most, but the function is generic
  mEditor.getAllNodesOfType(ImGui::NodeTypes::kDefaultInitializationNode, &defaultInitNodes);

  // By calling the step Eval(), all the reachable nodes will be also called recursively
  if(defaultInitNodes.size() > 0)
    return defaultInitNodes[0]->Eval(mEditor, 0);
  else { // No default has been defined. The function does nothing.
    return "void CACell::DefaultInit(){}\n";
  }
}

std::string UpdateRulesEditor::EvalGraphEditorInputColorNodes()
{
  // Get the InputColor nodes, for initiate the code generation
  ImVector<ImGui::Node*> InputColorNodes = ImVector<ImGui::Node*>();
  mEditor.getAllNodesOfType(ImGui::NodeTypes::kInputColorNode, &InputColorNodes);

  std::string inputColorNodesCode = "";
  // By calling the step Eval(), all the reachable nodes will be also called recursively
  for(auto node: InputColorNodes)
    inputColorNodesCode += node->Eval(mEditor, 0);

  return inputColorNodesCode;
}

void UpdateRulesEditor::UpdateComboBoxes(std::vector<std::string> cellAttrNames,
                                         std::vector<std::string> modelAttrNames,
                                         std::vector<std::string> neighborhoodNames,
                                         std::vector<std::string> colAttrMappingNames,
                                         std::vector<std::string> attrColMappingNames) {
  gCellAttrNames     = cellAttrNames;
  gModelAttrNames    = modelAttrNames;
  gNeighborhoodNames = neighborhoodNames;
  gColAttrMappingsNames = colAttrMappingNames;
  gAttrColMappingsNames = attrColMappingNames;

  UpdateEnumNames();
}

void UpdateModelAttrNames(std::vector<std::string> names) {
  gModelAttrNames = names;
}

void UpdateNeighborhoodNames(std::vector<std::string> names) {
  gNeighborhoodNames = names;
}


