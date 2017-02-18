#ifndef ATTRIBUTE_H
#define ATTRIBUTE_H

#include <string>
#include <vector>

static const std::vector<std::string> cb_attribute_type_values = {"Bool", "Integer", "Float", "List", "User Defined"};
static const std::vector<std::string> cb_attribute_list_type_values = {"Bool", "Integer", "Float", "User Defined"};

struct Attribute {
  Attribute (std::string id_name, std::string type, std::string description, int list_length,
             std::string list_type, std::vector<std::string>* user_defined_values,
             std::string init_value, bool is_model_attribute) {
    m_id_name = id_name;
    m_type = type;
    m_description = description;

    m_list_length = list_length;
    m_list_type   = list_type;

    m_user_defined_values = user_defined_values;

    m_init_value = init_value;
    m_is_model_attribute = is_model_attribute;
  }

  ~Attribute() { delete m_user_defined_values; }

  // Common properties
  std::string m_id_name;
  std::string m_type;
  std::string m_description;

  // List properties
  int         m_list_length;
  std::string m_list_type;

  // User Ddefined properties
  std::vector<std::string>* m_user_defined_values;

  // Model Attributes properties
  bool m_is_model_attribute;
  std::string m_init_value;
};

#endif // ATTRIBUTE_H
