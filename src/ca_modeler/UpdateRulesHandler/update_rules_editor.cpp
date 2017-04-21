#include "update_rules_editor.h"

#include "imguinodegrapheditor.h"
#include "node_graph_instance.h"

UpdateRulesEditor::UpdateRulesEditor(){
  mEditor = ImGui::NodeGraphEditor();
}

void UpdateRulesEditor::Init(){
  InitNGE(mEditor);
}

void UpdateRulesEditor::Render()
{
  mEditor.render();
}

