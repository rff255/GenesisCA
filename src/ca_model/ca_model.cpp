#include "ca_model.h"

CAModel::CAModel() {
}

CAModel::~CAModel() {
}

string CAModel::AddAttribute(Attribute* new_attr) {
  string base_id_name = new_attr->m_id_name;
  int disambiguity_number = 1;
  while(m_attributes.count(new_attr->m_id_name) > 0) {
    new_attr->m_id_name = base_id_name + std::to_string(disambiguity_number);
    disambiguity_number++;
  }

  m_attributes[new_attr->m_id_name] = new_attr;
  return new_attr->m_id_name;
}

bool CAModel::DelAttribute(std::string id_name) {
  auto entry = m_attributes.find(id_name);

  if(entry == m_attributes.end())
    return false;

  delete m_attributes[id_name];
  m_attributes.erase(entry);

  return true;
}

std::string CAModel::ModifyAttribute(std::string prev_id_name, Attribute *modified_attr) {
  if(prev_id_name == modified_attr->m_id_name) {
    m_attributes[prev_id_name] = modified_attr;
    return prev_id_name;
  }

  else {
    DelAttribute(prev_id_name);
    return AddAttribute(modified_attr);
  }
}

Attribute *CAModel::GetAttribute(std::string id_name) {
  if(m_attributes.find(id_name) == m_attributes.end())
    return nullptr;
  else
    return m_attributes[id_name];
}

void CAModel::ModifyModelProperties(
    const std::string &name, const std::string &author, const std::string &goal,
    const std::string &description, const std::string &topology, const std::string &boundary_treatment,
    bool is_fixed_size, int size_width, int size_height, const std::string &cell_attribute_initialization,
    bool has_max_iterations, int max_iterations) {

//  m_model_properties->m_name = name;
//  m_model_properties->m_author = author;
//  m_model_properties->m_goal = goal;
//  m_model_properties->m_description = description;

//  m_model_properties->m_topology = topology;
//  m_model_properties->m_boundary_treatment = boundary_treatment;
//  m_model_properties->m_is_fixed_size = is_fixed_size;
//  m_model_properties->m_size_width = size_width;
//  m_model_properties->m_size_height = size_height;

//  m_model_properties->m_attributes_initialization = cell_attribute_initialization;
//  m_model_properties->m_has_max_iterations = has_max_iterations;
//  m_model_properties->m_max_iterations = max_iterations;
}
