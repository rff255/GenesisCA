#ifndef UPDATE_RULES_EDITOR_H
#define UPDATE_RULES_EDITOR_H

#include "../imgui/imguinodegrapheditor.h"

// This class is the interface to acess the resources of node_graph_instance
class UpdateRulesEditor {
public:
  UpdateRulesEditor();
  ~UpdateRulesEditor(){}

  // Public interest methods
  void Init();   // Called once to setup the initial configuration of editor
  void Render(); // Called to refresh graphicals

private:
  ImGui::NodeGraphEditor mEditor;
};

#endif // UPDATE_RULES_EDITOR_H
