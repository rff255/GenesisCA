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
  mEditor.show_top_pane = false;

  InitNGE(mEditor);
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


