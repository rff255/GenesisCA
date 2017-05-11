#ifndef CA_MODEL_H
#define CA_MODEL_H

#include "attribute.h"
#include "break_case.h"
#include "graph_node.h"
#include "model_properties.h"
#include "neighborhood.h"
#include "partition.h"
#include "mapping.h"
#include "update_rules_editor.h"

#include <unordered_map>
#include <string>
#include <vector>

using std::string;
using std::vector;

class CAModel {
public:
  CAModel();
  ~CAModel();

  // Model Properties
  void ModifyModelProperties(const string &name, const string &author, const string &goal, const string &description,
                             const string &topology, const string &boundary_treatment, bool is_fixed_size, int size_width, int size_height,
                             const string &cell_attribute_initialization, bool has_max_iterations, int max_iterations);
  ModelProperties* GetModelProperties() { return m_model_properties; }

  // Break Cases
  string           AddBreakCase(BreakCase* new_bc);
  bool             DelBreakCase(string id_name);
  string           ModifyBreakCase(string prev_id_name, BreakCase* modified_bc);
  BreakCase*       GetBreakCase(string id_name);

  // Attributes
  string           AddAttribute(Attribute* new_attr);
  bool             DelAttribute(string id_name);
  string           ModifyAttribute(string prev_id_name, Attribute* modified_attr);
  Attribute*       GetAttribute(string id_name);
  vector<string> GetAttributesList();
  vector<string> GetCellAttributesList();
  vector<string> GetModelAttributesList();

  // Neighborhoods
  string           AddNeighborhood(Neighborhood* new_neigh);
  bool             DelNeighborhood(string id_name);
  string           ModifyNeighborhood(string prev_id_name, Neighborhood* modified_neigh);
  Neighborhood*    GetNeighborhood(string id_name);
  vector<string> GetNeighborhoodList();

  // Mappings
  string           AddMapping(Mapping* new_attr);
  bool             DelMapping(string id_name);
  string           ModifyMapping(string prev_id_name, Mapping* modified_attr);
  Mapping*         GetMapping(string id_name);
  vector<string> GetMappingsList();
  vector<string> GetColAttrMappingsList();
  vector<string> GetAttrColMappingsList();

  // Nodes Graph Editor
  UpdateRulesEditor* GetGraphEditor() {return mGraphEditor;}

  string GenerateHCode();
  string GenerateCPPCode();

private:
  string GenerateCACellDeclaration();
  string GenerateCACellDefinition();
  string GenerateCAModelDeclaration();
  string GenerateCAModelDefinition();
  string GenerateTypedefList();
  string GenerateIncludesList();

  // The data model itself
  ModelProperties* m_model_properties;
  std::unordered_map<string, BreakCase*>    m_break_cases;
  std::unordered_map<string, Attribute*>    m_attributes;
  std::unordered_map<string, Neighborhood*> m_neighborhoods;
  std::unordered_map<string, Mapping*>      m_mappings;
  UpdateRulesEditor* mGraphEditor;  // The Editor instance
};

#endif // CA_MODEL_H
