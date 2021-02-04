#include "update_rules_editor.h"

#include "nodes_editor/imguinodegrapheditor.h"
#include "UpdateRulesHandler/node_graph_instance.h"
#include "JSON_nlohmann/json.hpp"

#include <vector>
#include <string>

using json = nlohmann::json;

UpdateRulesEditor::UpdateRulesEditor(){
  mEditor = ImGui::NodeGraphEditor();
  mEditor.show_node_copy_paste_buttons = false;
  mEditor.show_style_editor = false;
  mEditor.show_top_pane = true;

  InitNGE(mEditor);
}

void UpdateRulesEditor::InitFromSerializedData(json rules_editor) {
  // Restore editor setup
  // TODO()

  // Restore Nodes
  json nodes_list = rules_editor[serialization_tags::kNodesList];
  std::unordered_map<int, int> old_to_new_node_id;
  for (auto& node_json : nodes_list) {
    const int node_old_id = node_json[serialization_tags::kNodeId];
    const int node_type = node_json[serialization_tags::kNodeType];
    const float node_pos[2] = {node_json[serialization_tags::kNodePos][0],
                              node_json[serialization_tags::kNodePos][1]};
    const string node_data = node_json[serialization_tags::kNodeData];
    const json node_meta_data = node_json[serialization_tags::kNodeMetaData];

    auto new_node = mEditor.addNode(node_type, ImVec2(node_pos[0], node_pos[1]));
    if(node_data.size()>0) new_node->SetupFromSerializedData(node_data);
    if(node_meta_data.size()>0) new_node->SetupFromSerializedMetaData(node_meta_data);

    const int new_id = new_node->mNodeId;
    old_to_new_node_id[node_old_id] = new_id;
  }

  // Restore Links
  json links_list = rules_editor[serialization_tags::kLinksList];
  for (auto& link_json : links_list) {
    const int in_node_id_old = link_json[serialization_tags::kLinkInNode];
    const int out_node_id_old = link_json[serialization_tags::kLinkOutNode];
    const int in_port =  link_json[serialization_tags::kLinkInPort];
    const int out_port =  link_json[serialization_tags::kLinkOutPort];

    const int in_node_id_new = old_to_new_node_id[in_node_id_old];
    const int out_node_id_new = old_to_new_node_id[out_node_id_old];

    mEditor.addLink(mEditor.getNodeById(in_node_id_new), in_port,
                    mEditor.getNodeById(out_node_id_new), out_port);
  }

  // Restore Nodes model configuration

}


json UpdateRulesEditor::GetSerializedData() {
  // Json = {
  //         {kEditorSetup:{}},
  //         {kNodesList:['Node', 'Node', ...]},
  //         {kLinksList:['Link', 'Link', 'Link', ...]}
  //        }
  // 'Node' = {<kNodeId>:1, <kNodeType>: 2, <kNodePos>:[200,500]}
  // 'Link' = {<kLinkInNode>:1, <kLinkOutNode>:2, <kLinkInPort>:0, <kLinkOutPort>:0}

  // Get editor options
  json editor_setup;
  // TODO(): Pan, zoom, style, selected nodes, and so on..

  // Get nodes data
  json nodes_list;
  for(int i=0; i<mEditor.getNumNodes(); ++i) {
    const ImGui::Node* node = mEditor.getNode(i);

    const int node_id = node->mNodeId;
    const int node_type = node->getType();
    const float node_pos[2] = {node->GetPos().x, node->GetPos().y};
    const string node_data = node->GetSerializedData();
    const json node_meta_data = node->GetSerializedMetaData();

    nodes_list.push_back({{serialization_tags::kNodeId, node_id},
                         {serialization_tags::kNodeType, node_type},
                         {serialization_tags::kNodePos, node_pos},
                         {serialization_tags::kNodeData, node_data},
                         {serialization_tags::kNodeMetaData, node_meta_data}});
  }

  // Get links data
  json links_list;
  for (int i=0; i<mEditor.getNumLinks();++i) {
    const ImGui::NodeLink* link = mEditor.getLink(i);
    const int in_node_id = link->InputNode->mNodeId;
    const int out_node_id = link->OutputNode->mNodeId;
    const int in_port = link->InputSlot;
    const int out_port = link->OutputSlot;

    links_list.push_back({{serialization_tags::kLinkInNode, in_node_id},
                          {serialization_tags::kLinkOutNode, out_node_id},
                          {serialization_tags::kLinkInPort, in_port},
                          {serialization_tags::kLinkOutPort, out_port},
                         });
  }

  // Join everything
  json data = {{serialization_tags::kEditorSetup, editor_setup},
               {serialization_tags::kNodesList, nodes_list},
               {serialization_tags::kLinksList, links_list}};

  return data;
}

std::string UpdateRulesEditor::EvalGraphEditorStep() {
  // Get the step node, for initiate the code generation
  ImVector<ImGui::Node*> stepNodes = ImVector<ImGui::Node*>(); // There is only one step node, but the function is generic
  mEditor.getAllNodesOfType(ImGui::NodeTypes::kStepNode, &stepNodes);

  // By calling the step Eval(), all the reachable nodes will be also called recursively
  if(stepNodes.size() > 0)
    return stepNodes[0]->Eval(mEditor, 0);
  return "void CACell::Step(){}\n";
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
                                         std::vector<std::string> attrColMappingNames,
                                         std::vector<int> neighborhoodSizes) {
  gCellAttrNames     = cellAttrNames;
  gModelAttrNames    = modelAttrNames;
  gNeighborhoodNames = neighborhoodNames;
  gColAttrMappingsNames = colAttrMappingNames;
  gAttrColMappingsNames = attrColMappingNames;
  gNeighborhoodSizes    = neighborhoodSizes;

  UpdateEnumNames();
}

void UpdateModelAttrNames(std::vector<std::string> names) {
  gModelAttrNames = names;
}

void UpdateNeighborhoodNames(std::vector<std::string> names) {
  gNeighborhoodNames = names;
}


