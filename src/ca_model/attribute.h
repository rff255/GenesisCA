#ifndef ATTRIBUTE_H
#define ATTRIBUTE_H

#include <string>
#include <vector>

static const std::vector<std::string> cb_attribute_type_values = {"Bool", "Integer", "Float", "List", "User Defined"};
static const std::vector<std::string> cb_attribute_list_type_values = {"Bool", "Integer", "Float", "User Defined"};

struct Attribute {
  // Common properties
  std::string m_name;
  std::string m_type;
  std::string m_description;

  // List properties
  int         m_list_length;
  std::string m_list_type;

  // User Ddefined properties
  std::vector<std::string> m_user_defined_values;
};

#endif // ATTRIBUTE_H
