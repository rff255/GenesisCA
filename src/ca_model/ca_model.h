#ifndef CA_MODEL_H
#define CA_MODEL_H

#include "attribute.h"
#include "break_case.h"
#include "graph_node.h"
#include "model_properties.h"
#include "neighborhood.h"
#include "partition.h"

#include <unordered_map>
#include <string>
#include <vector>

using std::string;

class CAModel {
public:
  CAModel();
  ~CAModel();

  // Model Properties
  void ModifyModelProperties(const string &name, const string &author, const string &goal, const string &description,
                             const string &topology, const string &boundary_treatment, bool is_fixed_size, int size_width, int size_height,
                             const string &cell_attribute_initialization, bool has_max_iterations, int max_iterations);
  ModelProperties* GetGlobalProperties() { return m_model_properties; }

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
  std::vector<std::string> GetAtributesList();
  std::vector<std::string> GetCellAtributesList();
  std::vector<std::string> GetModelAtributesList();

  // Neighborhoods
  string           AddNeighborhood(Neighborhood* new_neigh);
  bool             DelNeighborhood(string id_name);
  string           ModifyNeighborhood(string prev_id_name, Neighborhood* modified_neigh);
  Neighborhood*    GetNeighborhood(string id_name);
  std::vector<std::string> GetNeighborhoodList();

private:
  ModelProperties* m_model_properties;
  std::unordered_map<string, BreakCase*>    m_break_cases;
  std::unordered_map<string, Attribute*>    m_attributes;
  std::unordered_map<string, Neighborhood*> m_neighborhoods;
};

#endif // CA_MODEL_H
