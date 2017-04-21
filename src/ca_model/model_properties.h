#ifndef MODEL_PROPERTIES_H
#define MODEL_PROPERTIES_H

#include "break_case.h"

#include <string>
#include <vector>

static const std::vector<std::string> cb_topology_values = {"Squares", "Triangles", "Hexagons"};
static const std::vector<std::string> cb_boundary_values = {"Constant", "Torus"};

struct ModelProperties {
  // Presentation
  std::string m_name;
  std::string m_author;
  std::string m_goal;
  std::string m_description;

  // Structury
  std::string m_topology;
  std::string m_boundary_treatment;
  bool        m_is_fixed_size;
  int         m_size_width;
  int         m_size_height;

  // Execution
  std::string            m_cell_attributes_initialization;
  bool                   m_has_max_iterations;
  int                    m_max_iterations;
  std::vector<BreakCase> m_break_cases;


};

#endif // MODEL_PROPERTIES_H
