#ifndef MODEL_PROPERTIES_H
#define MODEL_PROPERTIES_H

#include <string>
#include <vector>

static const std::vector<std::string> cb_boundary_values = {"Constant", "Torus"};

struct ModelProperties {
  // Presentation
  std::string m_name;
  std::string m_author;
  std::string m_goal;
  std::string m_description;

  // Structury
  std::string m_boundary_treatment;
};

#endif // MODEL_PROPERTIES_H
