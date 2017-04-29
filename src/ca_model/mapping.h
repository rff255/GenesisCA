#ifndef MAPPING_H
#define MAPPING_H

#include <string>

struct Mapping {
  Mapping (std::string id_name, std::string description, std::string red_description, std::string green_description, std::string blue_description, bool is_attr_color) {
    m_id_name           = id_name;
    std::replace(m_id_name.begin(), m_id_name.end(), ' ', '_');

    m_description       = description;
    m_red_description   = red_description;
    m_green_description = green_description;
    m_blue_description  = blue_description;

    m_is_attr_color     = is_attr_color;
  }

  std::string m_id_name;
  std::string m_description;
  bool        m_is_attr_color;
  std::string m_red_description;
  std::string m_green_description;
  std::string m_blue_description;
};

#endif // MAPPING_H
