#include "ca_modeler_manager.h"

CAModelerManager::CAModelerManager():
  m_ca_model(new CAModel) {
}

void CAModelerManager::AddAttribute(QListWidgetItem* corresponding_item, bool isCellAttribute) {
  // Create new attribute
  Attribute* new_attrubute = new Attribute;
  new_attrubute->m_name = corresponding_item->text().toStdString();
  new_attrubute->m_type = cb_attribute_type_values[0];
  new_attrubute->m_description = "";
  new_attrubute->m_list_length = 0;
  new_attrubute->m_list_type = cb_attribute_list_type_values[0];

  // Append to ca_model, and refresh manager [item->attribute] hash
  if (isCellAttribute)
    m_ca_model->AppendCellAttribute(new_attrubute);
  else {
    m_ca_model->AppendModelAttribute(new_attrubute);
  }

  m_attributes_hash.insert(corresponding_item, new_attrubute);
}

void CAModelerManager::RemoveAttribute(QListWidgetItem *target_item, bool isCellAttribute) {
  Attribute* target_attribute = m_attributes_hash.value(target_item);
  if (isCellAttribute)
    m_ca_model->RemoveCellAttribute(target_attribute);
  else
    m_ca_model->RemoveModelAttribute(target_attribute);

  m_attributes_hash.remove(target_item);
}

void CAModelerManager::ModifyAttribute(QListWidgetItem* target_item,
                    const std::string &name, const std::string &type, const std::string &description,
                    int list_length, const std::string &list_type,
                    const QListWidget* user_defined_values) {
  Attribute* target_attrubute = m_attributes_hash.value(target_item);
  target_attrubute->m_name = name;
  target_attrubute->m_type = type;
  target_attrubute->m_description = description;
  target_attrubute->m_list_length = list_length;
  target_attrubute->m_list_type = list_type;

  target_attrubute->m_user_defined_values.clear();
  for(int i = 0; i < user_defined_values->count(); ++i) {
      QListWidgetItem* item = user_defined_values->item(i);
      target_attrubute->m_user_defined_values.push_back(item->text().toStdString());
  }
}

