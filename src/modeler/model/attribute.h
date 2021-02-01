#ifndef ATTRIBUTE_H
#define ATTRIBUTE_H

#include <string>
#include <vector>
#include <algorithm>

static const std::vector<std::string> cb_attribute_type_values = {"Bool", "Integer", "Float"};//, "List", "User Defined"};
static const std::vector<std::string> attribute_type_cpp_equivalent = {"bool", "int", "float"};//, "List", "User Defined"};

struct Attribute {
  Attribute (std::string id_name, std::string type, std::string description,
             std::string init_value, bool is_model_attribute) {
    m_id_name = id_name;
    std::replace(m_id_name.begin(), m_id_name.end(), ' ', '_');

    m_type = type;
    m_description = description;

    m_init_value = init_value;
    m_is_model_attribute = is_model_attribute;
  }

  ~Attribute() {}

  // Common properties
  std::string m_id_name;
  std::string m_type;
  std::string m_description;

  // Model Attributes properties
  bool m_is_model_attribute;
  std::string m_init_value;
};

#endif // ATTRIBUTE_H
