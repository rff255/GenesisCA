#include "ca_model.h"

CAModel::CAModel():
m_model_properties(new ModelProperties()) {
}

CAModel::~CAModel() {
  delete m_model_properties;
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

std::vector<std::string> CAModel::GetAtributesList() {
  std::vector<std::string> attr_id_name_list;
  for(auto kv : m_attributes)
      attr_id_name_list.push_back(kv.first);

  return attr_id_name_list;
}

std::string CAModel::AddBreakCase(BreakCase *new_bc) {
  string base_id_name = new_bc->m_id_name;
  int disambiguity_number = 1;
  while(m_break_cases.count(new_bc->m_id_name) > 0) {
    new_bc->m_id_name = base_id_name + std::to_string(disambiguity_number);
    disambiguity_number++;
  }

  m_break_cases[new_bc->m_id_name] = new_bc;
  return new_bc->m_id_name;
}

bool CAModel::DelBreakCase(std::string id_name) {
  auto entry = m_break_cases.find(id_name);

  if(entry == m_break_cases.end())
    return false;

  delete m_break_cases[id_name];
  m_break_cases.erase(entry);

  return true;
}

std::string CAModel::ModifyBreakCase(std::string prev_id_name, BreakCase *modified_bc) {
  if(prev_id_name == modified_bc->m_id_name) {
    m_break_cases[prev_id_name] = modified_bc;
    return prev_id_name;
  }

  else {
    DelBreakCase(prev_id_name);
    return AddBreakCase(modified_bc);
  }
}

BreakCase *CAModel::GetBreakCase(std::string id_name) {
  if(m_break_cases.find(id_name) == m_break_cases.end())
    return nullptr;
  else
    return m_break_cases[id_name];
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

  // TODO(figueiredo): add Break cases into scheme
}

string CAModel::AddNeighborhood(Neighborhood* new_neigh) {
  string base_id_name = new_neigh->m_id_name;
  int disambiguity_number = 1;
  while(m_neighborhoods.count(new_neigh->m_id_name) > 0) {
    new_neigh->m_id_name = base_id_name + std::to_string(disambiguity_number);
    disambiguity_number++;
  }

  m_neighborhoods[new_neigh->m_id_name] = new_neigh;
  return new_neigh->m_id_name;
}

bool CAModel::DelNeighborhood(std::string id_name) {
  auto entry = m_neighborhoods.find(id_name);

  if(entry == m_neighborhoods.end())
    return false;

  delete m_neighborhoods[id_name];
  m_neighborhoods.erase(entry);

  return true;
}

std::string CAModel::ModifyNeighborhood(std::string prev_id_name, Neighborhood* modified_neigh) {
  if(prev_id_name == modified_neigh->m_id_name) {
    m_neighborhoods[prev_id_name] = modified_neigh;
    return prev_id_name;
  }

  else {
    DelNeighborhood(prev_id_name);
    return AddNeighborhood(modified_neigh);
  }
}

Neighborhood *CAModel::GetNeighborhood(std::string id_name) {
  if(m_neighborhoods.find(id_name) == m_neighborhoods.end())
    return nullptr;
  else
    return m_neighborhoods[id_name];
}
