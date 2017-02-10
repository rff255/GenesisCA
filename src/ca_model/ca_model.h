#ifndef CA_MODEL_H
#define CA_MODEL_H

#include "model_properties.h"
#include "graph_node.h"
#include "attribute.h"
#include "neighborhood.h"
#include "partition.h"
#include "break_case.h"

#include <algorithm>
#include <string>
#include <vector>

class CAModel {
public:
  CAModel();
  ~CAModel();

  // Attributes
  // - cell attributes
  void AppendCellAttribute(Attribute* new_attribute) { m_cell_attributes.push_back(new_attribute); }
  void RemoveCellAttribute(Attribute* target_attribute) {
    auto target_ite = std::find(m_cell_attributes.begin(), m_cell_attributes.end(), target_attribute);
    delete *target_ite;
    m_cell_attributes.erase(target_ite);
  }
  // - model attributes
  void AppendModelAttribute(Attribute* new_attribute) { m_model_attributes.push_back(new_attribute); }
  void RemoveModelAttribute(Attribute* target_attribute) {
    auto target_ite = std::find(m_model_attributes.begin(), m_model_attributes.end(), target_attribute);
    delete *target_ite;
    m_model_attributes.erase(target_ite);
  }

  const std::vector<Attribute*> get_m_model_attributes() {return m_model_attributes;}

  // Model Properties
  void ModifyModelProperties(const std::string &name, const std::string &author, const std::string &goal, const std::string &description,
                             const std::string &topology, const std::string &boundary_treatment, bool is_fixed_size, int size_width, int size_height,
                             const std::string &cell_attribute_initialization, bool has_max_iterations, int max_iterations);

private:
  ModelProperties*           m_model_properties;
  std::vector<Attribute*>    m_cell_attributes;
  std::vector<Attribute*>    m_model_attributes;
  std::vector<Neighborhood*> m_neighborhoods;
  std::vector<Partition*>    m_partitions;
  std::vector<GraphNode*>    m_update_rules;
  std::vector<GraphNode*>    m_mappings;

};

#endif // CA_MODEL_H
