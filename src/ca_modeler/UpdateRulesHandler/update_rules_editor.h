#ifndef UPDATE_RULES_EDITOR_H
#define UPDATE_RULES_EDITOR_H

#include "../imgui/imguinodegrapheditor.h"

#include <vector>
#include <string>


// This class is the interface to acess the resources of node_graph_instance
class UpdateRulesEditor {
public:
  UpdateRulesEditor();
  ~UpdateRulesEditor(){}

  // Public interest methods
  void Init();// Called once to setup the initial configuration of editor
  void Render() { mEditor.render(); } // Called to refresh graphicals
  std::string EvalGraphEditor();

  void UpdateComboBoxes(std::vector<std::string> cellAttrNames,
                        std::vector<std::string> modelAttrNames,
                        std::vector<std::string> neighborhoodNames);

private:
  ImGui::NodeGraphEditor mEditor;
};

#endif // UPDATE_RULES_EDITOR_H
