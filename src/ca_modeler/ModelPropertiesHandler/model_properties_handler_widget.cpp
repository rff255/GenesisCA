#include "model_properties_handler_widget.h"
#include "ui_model_properties_handler_widget.h"

#include "model_attr_init_value.h"
#include "../../ca_model/attribute.h"
#include "../../ca_model/model_properties.h"

#include <vector>


ModelPropertiesHandlerWidget::ModelPropertiesHandlerWidget(QWidget *parent) :
  QWidget(parent),
  ui(new Ui::ModelPropertiesHandlerWidget),
  m_is_loading(false) {

  ui->setupUi(this);

  // Connect Signals and Slots
  connect(ui->txt_name,               SIGNAL(editingFinished()),  this, SLOT(SaveModelPropertiesModifications()));
  connect(ui->txt_author,             SIGNAL(editingFinished()),  this, SLOT(SaveModelPropertiesModifications()));
  connect(ui->txt_goal,               SIGNAL(textChanged()),      this, SLOT(SaveModelPropertiesModifications()));
  connect(ui->txt_description,        SIGNAL(textChanged()),      this, SLOT(SaveModelPropertiesModifications()));
  connect(ui->cb_topology,            SIGNAL(activated(int)),     this, SLOT(SaveModelPropertiesModifications()));
  connect(ui->cb_boundary_treatment,  SIGNAL(activated(int)),     this, SLOT(SaveModelPropertiesModifications()));
  connect(ui->gb_fixed_size,          SIGNAL(toggled(bool)),      this, SLOT(SaveModelPropertiesModifications()));
  connect(ui->sb_width,               SIGNAL(valueChanged(int)),  this, SLOT(SaveModelPropertiesModifications()));
  connect(ui->sb_height,              SIGNAL(valueChanged(int)),  this, SLOT(SaveModelPropertiesModifications()));
  connect(ui->cb_cell_attr_init,      SIGNAL(activated(int)),     this, SLOT(SaveModelPropertiesModifications()));
  connect(ui->gb_max_iterations,      SIGNAL(toggled(bool)),      this, SLOT(SaveModelPropertiesModifications()));
  connect(ui->sb_max_iterations,      SIGNAL(valueChanged(int)),  this, SLOT(SaveModelPropertiesModifications()));
}

ModelPropertiesHandlerWidget::~ModelPropertiesHandlerWidget() {
  delete ui;
}

void ModelPropertiesHandlerWidget::ConfigureCB() {
  for (int i = 0; i < cb_topology_values.size(); ++i) {
    ui->cb_topology->addItem(QString::fromStdString(cb_topology_values[i]));
  }

  for (int i = 0; i < cb_boundary_values.size(); ++i) {
    ui->cb_boundary_treatment->addItem(QString::fromStdString(cb_boundary_values[i]));
  }
}

void ModelPropertiesHandlerWidget::AddModelAttributesInitItem(std::string id_name) {
  Attribute* added_attr = m_ca_model->GetAttribute(id_name);

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

  // Refresh the hash item->model_attr
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
        ui->cb_topology->currentText().toStdString(), ui->cb_boundary_treatment->currentText().toStdString(),
        ui->gb_fixed_size->isEnabled(), ui->sb_width->value(), ui->sb_height->value(),
        ui->cb_cell_attr_init->currentText().toStdString(),
        ui->gb_max_iterations->isEnabled(), ui->sb_max_iterations->value());
  // TODO(figueiredo): add Break cases into scheme

    emit ModelPropertiesChanged();
}

void ModelPropertiesHandlerWidget::RefreshModelAttrInitValue(std::string id_name, std::string new_value) {
  m_ca_model->GetAttribute(id_name)->m_init_value = new_value;
}
