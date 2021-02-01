#include "model_properties_handler_widget.h"
#include "ui_model_properties_handler_widget.h"

#include "model_attr_init_value.h"
#include "model/attribute.h"
#include "model/model_properties.h"

#include <vector>


ModelPropertiesHandlerWidget::ModelPropertiesHandlerWidget(QWidget *parent) :
  QWidget(parent),
  ui(new Ui::ModelPropertiesHandlerWidget),
  m_is_loading(false) {

  ui->setupUi(this);

  // Connect Signals and Slots

  // Update model with model properties fields change
  connect(ui->txt_name,               SIGNAL(editingFinished()),  this, SLOT(SaveModelPropertiesModifications()));
  connect(ui->txt_author,             SIGNAL(editingFinished()),  this, SLOT(SaveModelPropertiesModifications()));
  connect(ui->txt_goal,               SIGNAL(textChanged()),      this, SLOT(SaveModelPropertiesModifications()));
  connect(ui->txt_description,        SIGNAL(textChanged()),      this, SLOT(SaveModelPropertiesModifications()));
  connect(ui->cb_boundary_treatment,  SIGNAL(activated(int)),     this, SLOT(SaveModelPropertiesModifications()));
}

ModelPropertiesHandlerWidget::~ModelPropertiesHandlerWidget() {
  delete ui;
}

void ModelPropertiesHandlerWidget::ConfigureCB() {
  for (int i = 0; i < cb_boundary_values.size(); ++i) {
    ui->cb_boundary_treatment->addItem(QString::fromStdString(cb_boundary_values[i]));
  }
}

void ModelPropertiesHandlerWidget::SyncUIWithModel() {
  ui->txt_name->blockSignals(true);
  ui->txt_author->blockSignals(true);
  ui->txt_goal->blockSignals(true);
  ui->txt_description->blockSignals(true);
  ui->cb_boundary_treatment->blockSignals(true);
  ui->lw_init_model_attributes->blockSignals(true);

  // Sync basic properties
  const ModelProperties* properties = m_ca_model->GetModelProperties();
  ui->txt_name->setText(QString::fromStdString(properties->m_name));
  ui->txt_author->setText(QString::fromStdString(properties->m_author));
  ui->txt_goal->setPlainText(QString::fromStdString(properties->m_goal));
  ui->txt_description->setPlainText(QString::fromStdString(properties->m_description));
  ui->cb_boundary_treatment->setCurrentText(QString::fromStdString(properties->m_boundary_treatment));

  // Clear previous list of model_attribute initialization values
  for(auto model_attr_pair : m_model_attributes_hash) {
    delete m_model_attributes_hash[model_attr_pair.first];
  }
  m_model_attributes_hash.clear();
  ui->lw_init_model_attributes->clear();

  // Sync model attribute initial values
  for(string attribute_name : m_ca_model->GetAttributesList()) {
      const Attribute* attribute = m_ca_model->GetAttribute(attribute_name);
      if(attribute->m_is_model_attribute) {
          this->AddModelAttributesInitItem(attribute->m_id_name);
          this->RefreshModelAttrInitValue(attribute->m_id_name, attribute->m_init_value);
      }
  }

  ui->txt_name->blockSignals(false);
  ui->txt_author->blockSignals(false);
  ui->txt_goal->blockSignals(false);
  ui->txt_description->blockSignals(false);
  ui->cb_boundary_treatment->blockSignals(false);
  ui->lw_init_model_attributes->blockSignals(false);
}

void ModelPropertiesHandlerWidget::set_m_ca_model(CAModel* model) {
    m_ca_model = model;
    SyncUIWithModel();
}

void ModelPropertiesHandlerWidget::AddModelAttributesInitItem(std::string id_name) {
  Attribute* added_attr = m_ca_model->GetAttribute(id_name);

  if(!added_attr->m_is_model_attribute)
    return;

  // Creates a new widget
  ModelAttrInitValue* new_model_attr_init_value = new ModelAttrInitValue();
  connect(new_model_attr_init_value, SIGNAL(InitValueChanged(std::string, std::string)), this, SLOT(RefreshModelAttrInitValue(std::string, std::string)));
  new_model_attr_init_value->SetAttrName(added_attr->m_id_name);
  new_model_attr_init_value->SetWidgetDetails(added_attr);

  // Creates a new listItem
  QListWidgetItem* new_item = new QListWidgetItem();

  // Append item to list of model attributes initialization, and set the widget
  ui->lw_init_model_attributes->addItem(new_item);
  ui->lw_init_model_attributes->setItemWidget(new_item, new_model_attr_init_value);
  new_item->setSizeHint(new_model_attr_init_value->size());

  // Refresh the hash attr_name->item
  m_model_attributes_hash[id_name] = new_item;
}

void ModelPropertiesHandlerWidget::DelModelAttributesInitItem(std::string id_name) {
  if(m_model_attributes_hash.count(id_name) > 0) {
    delete m_model_attributes_hash[id_name];
    m_model_attributes_hash.erase(id_name);
  }
}

void ModelPropertiesHandlerWidget::ChangeModelAttributesInitItem(std::string old_id_name, std::string new_id_name) {
  if(m_model_attributes_hash.count(old_id_name) > 0) {
    DelModelAttributesInitItem(old_id_name);
    AddModelAttributesInitItem(new_id_name);
  }
}

void ModelPropertiesHandlerWidget::SaveModelPropertiesModifications() {
  if(m_is_loading)
    return;

  m_ca_model->ModifyModelProperties(
        ui->txt_name->text().toStdString(), ui->txt_author->text().toStdString(),
        ui->txt_goal->toPlainText().toStdString(), ui->txt_description->toPlainText().toStdString(),
        ui->cb_boundary_treatment->currentText().toStdString());
    emit ModelPropertiesChanged();
}

void ModelPropertiesHandlerWidget::RefreshModelAttrInitValue(std::string id_name, std::string new_value) {
  m_ca_model->GetAttribute(id_name)->m_init_value = new_value;
}
