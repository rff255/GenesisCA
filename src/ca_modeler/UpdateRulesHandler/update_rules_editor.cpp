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
  mEditor.show_style_editor = true;
  mEditor.show_top_pane = true;

  InitNGE(mEditor);
}

std::string UpdateRulesEditor::EvalGraphEditor() {
  // Get the step node, for initiate the code generation
  ImVector<ImGui::Node*> stepNodes = ImVector<ImGui::Node*>(); // There is only one step node, but the function is generic
  mEditor.getAllNodesOfType(ImGui::NodeTypes::kStepNode, &stepNodes);

  // By calling the step Eval(), all the reachable nodes will be also called recursively
  return stepNodes[0]->Eval(mEditor, 0);
}

void UpdateRulesEditor::UpdateComboBoxes(std::vector<std::string> cellAttrNames,
                                         std::vector<std::string> modelAttrNames,
                                         std::vector<std::string> neighborhoodNames) {
  gCellAttrNames     = cellAttrNames;
  gModelAttrNames    = modelAttrNames;
  gNeighborhoodNames = neighborhoodNames;

  UpdateEnumNames();
}

void UpdateModelAttrNames(std::vector<std::string> names) {
  gModelAttrNames = names;
}

void UpdateNeighborhoodNames(std::vector<std::string> names) {
  gNeighborhoodNames = names;
}


