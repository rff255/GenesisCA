#ifndef ATTRIBUTE_H
#define ATTRIBUTE_H

#include <string>
#include <vector>

enum attribute_type {
  kBool,
  kNumerical,
  kList,
  kUserDefined
};

struct Attribute {
  // Common properties
  std::string     m_name;
  attribute_type  m_type;
  std::string     m_description;

  // List properties
  int             m_list_length;
  attribute_type  m_list_type;

  // User Ddefined properties
  std::vector<std::string> m_user_defined_values;
};

#endif // ATTRIBUTE_H
