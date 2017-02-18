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

  // Attributes
  string           AddAttribute(Attribute* new_attr);
  bool             DelAttribute(string id_name);
  string           ModifyAttribute(string id_name, Attribute* modified_attr);
  Attribute*       GetAttribute(string id_name);

private:
  std::unordered_map<string, Attribute*> m_attributes;
};

#endif // CA_MODEL_H
