#include "ca_modeler_manager.h"

CAModelerManager::CAModelerManager():
  m_ca_model(new CAModel) {
}

attribute_type CAModelerManager::AttrTypeFromStr(std::string string_type) {
  if(string_type == "Bool") {
    return attribute_type::kBool;

  } else if(string_type == "Numerical") {
    return attribute_type::kNumerical;

  } else if(string_type == "List") {
    return attribute_type::kList;

  } else if(string_type == "User Defined") {
    return attribute_type::kUserDefined;

  } else {
    printf("lascou");
  }
}

void CAModelerManager::AddCellAttribute(QListWidgetItem* corresponding_item) {
  // Create new attribute
  Attribute* new_attrubute = new Attribute;
  new_attrubute->m_name = corresponding_item->text().toStdString();

  // Append to ca_model, and refresh manager [item->attribute] hash
  m_ca_model->AppendCellAttribute(new_attrubute);
  m_cell_attributes.insert(corresponding_item, new_attrubute);
}

void CAModelerManager::RemoveCellAttribute(QListWidgetItem *target_item) {
  Attribute* target_attribute = m_cell_attributes.value(target_item);
  m_ca_model->RemoveCellAttribute(target_attribute);
  m_cell_attributes.remove(target_item);
}

void CAModelerManager::ModifyCellAttribute(QListWidgetItem* target_item,
                    const std::string &name, const std::string &type, const std::string &description,
                    int list_length, const std::string &list_type,
                    const QListWidget* user_defined_values) {
  Attribute* target_attrubute = m_cell_attributes.value(target_item);
  target_attrubute->m_name = name;
  target_attrubute->m_type = AttrTypeFromStr(type);
  target_attrubute->m_description = description;
  target_attrubute->m_list_length = list_length;
  target_attrubute->m_list_type = AttrTypeFromStr(list_type);

  std::vector<std::string> allowed_values;
  foreach(QListWidgetItem *item, user_defined_values)
    allowed_values.push_back(item->text());

  target_attrubute->m_user_defined_values = allowed_values;
}

