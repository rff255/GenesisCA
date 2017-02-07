#include "global_properties_handler_widget.h"
#include "ui_global_properties_handler_widget.h"

#include "model_attr_init_value.h"
#include "../../ca_model/attribute.h"

#include <vector>


GlobalPropertiesHandlerWidget::GlobalPropertiesHandlerWidget(QWidget *parent) :
  QWidget(parent),
  ui(new Ui::GlobalPropertiesHandlerWidget)
{
  ui->setupUi(this);

  // Connect Signals and Slots
}

GlobalPropertiesHandlerWidget::~GlobalPropertiesHandlerWidget()
{
  delete ui;
}

void GlobalPropertiesHandlerWidget::RefreshModelAttributesInitList() {
  std::vector<Attribute*> attributes_list = m_modeler_manager->GetModelAttributeList();
  ui->lw_init_model_attributes->clear();

  m_model_attributes_hash.clear();
  for (int i=0; i<attributes_list.size(); ++i) {
    // Creates a new widget
    ModelAttrInitValue* new_model_attr_init_value = new ModelAttrInitValue();
    new_model_attr_init_value->SetAttrName(attributes_list[i]->m_name);
    new_model_attr_init_value->SetWidgetDetails(attributes_list[i]);

    // Creates a new listItem
    QListWidgetItem* new_item = new QListWidgetItem();

    // Append item to list of model attributes initialization, and set the widget
    ui->lw_init_model_attributes->addItem(new_item);
    ui->lw_init_model_attributes->setItemWidget(new_item, new_model_attr_init_value);
    new_item->setSizeHint(new_model_attr_init_value->size());

    // Refresh the hash item->model_attr
    m_model_attributes_hash.insert(new_item, attributes_list[i]);
  }
}
