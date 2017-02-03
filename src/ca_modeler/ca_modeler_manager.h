#ifndef CA_MODELER_MANAGER_H
#define CA_MODELER_MANAGER_H

#include "../ca_model/ca_model.h"
#include "../ca_model/attribute.h"
#include <vector>
#include <string>

#include "QListWidgetItem"
#include "QHash"

class CAModelerManager
{

public:
  CAModelerManager();

  // Attributes
  void AddAttribute(QListWidgetItem* corresponding_item, bool isCellAttribute);
  void RemoveAttribute(QListWidgetItem* target_item, bool isCellAttribute);
  void ModifyAttribute(QListWidgetItem* target_item,
                      const std::string &name, const std::string &type, const std::string &description,
                      int list_length, const std::string &list_type,
                      const QListWidget *user_defined_values);
  Attribute* GetAttribute(QListWidgetItem* target_item) {
    return m_attributes_hash.value(target_item);
  }

private:
  CAModel *m_ca_model;

  QHash<QListWidgetItem*, Attribute*>    m_attributes_hash;
  QHash<QListWidgetItem*, Attribute*>    m_model_attributes;
  QHash<QListWidgetItem*, Neighborhood*> m_neighborhoods;
  QHash<QListWidgetItem*, Partition*>    m_partitions;
  QHash<QListWidgetItem*, GraphNode*>    m_update_rules;
  QHash<QListWidgetItem*, GraphNode*>    m_mappings;
};

#endif // CA_MODELER_MANAGER_H
