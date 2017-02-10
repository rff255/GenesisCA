#include "ca_model.h"

CAModel::CAModel():
m_model_properties(new ModelProperties) {

}

CAModel::~CAModel() {
  delete m_model_properties;
}

void CAModel::ModifyModelProperties(
    const std::string &name, const std::string &author, const std::string &goal,
    const std::string &description, const std::string &topology, const std::string &boundary_treatment,
    bool is_fixed_size, int size_width, int size_height, const std::string &cell_attribute_initialization,
    bool has_max_iterations, int max_iterations) {

  m_model_properties->m_name = name;
  m_model_properties->m_author = author;
  m_model_properties->m_goal = goal;
  m_model_properties->m_description = description;

  m_model_properties->m_topology = topology;
  m_model_properties->m_boundary_treatment = boundary_treatment;
  m_model_properties->m_is_fixed_size = is_fixed_size;
  m_model_properties->m_size_width = size_width;
  m_model_properties->m_size_height = size_height;

  m_model_properties->m_cell_attributes_initialization = cell_attribute_initialization;
  m_model_properties->m_has_max_iterations = has_max_iterations;
  m_model_properties->m_max_iterations = max_iterations;
}
