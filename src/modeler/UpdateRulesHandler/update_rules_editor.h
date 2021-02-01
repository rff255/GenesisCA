#ifndef UPDATE_RULES_EDITOR_H
#define UPDATE_RULES_EDITOR_H

#include "imgui/imguinodegrapheditor.h"
#include "JSON_nlohmann/json.hpp"

#include <vector>
#include <string>

namespace serialization_tags{
const std::string kEditorSetup = "editor_setup";

const std::string kNodesList = "nodes";
const std::string kNodeId = "node_id";
const std::string kNodeType = "node_type";
const std::string kNodePos = "node_pos";
const std::string kNodeData = "node_data";
const std::string kNodeMetaData = "node_meta_data";

const std::string kLinksList = "links";
const std::string kLinkInNode = "link_in_node";
const std::string kLinkOutNode = "link_out_node";
const std::string kLinkInPort = "link_in_port";
const std::string kLinkOutPort = "link_out_port";
}

// This class is the interface to access the resources of node_graph_instance
class UpdateRulesEditor {
public:
  UpdateRulesEditor();
  ~UpdateRulesEditor(){}

  // Public interest methods
  void InitFromSerializedData(nlohmann::json rules_editor);
  nlohmann::json GetSerializedData();
  void Render() { mEditor.render(); } // Called to refresh graphicals
  std::string EvalGraphEditorStep();
  std::string EvalGraphEditorDefaultInit();
  std::string EvalGraphEditorInputColorNodes();

  void ClearScopeInformation(){mEditor.ClearScopeInformation();}

  void UpdateComboBoxes(std::vector<std::string> cellAttrNames,
                        std::vector<std::string> modelAttrNames,
                        std::vector<std::string> neighborhoodNames,
                        std::vector<std::string> colAttrMappingNames,
                        std::vector<std::string> attrColMappingNames,
                        std::vector<int>         neighborhoodSizes);

private:
  ImGui::NodeGraphEditor mEditor;

};

#endif // UPDATE_RULES_EDITOR_H
