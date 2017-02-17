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

  // Attributes
  // - cell attributes
  string AddCellAttribute(Attribute* new_attr);
  bool DelCellAttribute(string id_name);
  string ModifyCellAttribute(string id_name, Attribute* modified_attr);
  const Attribute *GetCellAttribute(string id_name);

  // - model attributes

  // Model Properties
  void ModifyModelProperties(const string &name, const string &author, const string &goal, const string &description,
                             const string &topology, const string &boundary_treatment, bool is_fixed_size, int size_width, int size_height,
                             const string &cell_attribute_initialization, bool has_max_iterations, int max_iterations);

private:
  std::unordered_map<string, Attribute*> m_cell_attributes;
};

#endif // CA_MODEL_H
