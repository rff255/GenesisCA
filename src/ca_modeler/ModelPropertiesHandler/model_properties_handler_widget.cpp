#include "model_properties_handler_widget.h"
#include "ui_model_properties_handler_widget.h"

#include "model_attr_init_value.h"
#include "break_case_instance.h"
#include "../../ca_model/attribute.h"
#include "../../ca_model/model_properties.h"

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

void ModelPropertiesHandlerWidget::RefreshBreakCaseHash(std::string old_id_name, std::string new_id_name) {
  if(old_id_name == new_id_name)
    return;

  m_break_cases_hash[new_id_name] = m_break_cases_hash[old_id_name];
  m_break_cases_hash.erase(old_id_name);
}

void ModelPropertiesHandlerWidget::RefreshBreakCasesOptions() {
  for (auto kv : m_break_cases_hash) {
    dynamic_cast<BreakCaseInstance*> (ui->lw_break_cases->itemWidget(kv.second))->SetupWidget();
  }
}

void ModelPropertiesHandlerWidget::on_pb_add_break_case_released() {
  BreakCase* new_bc = new BreakCase("New break case", "", cb_break_case_amount_unit[0], 0, "", "");
  std::string new_bc_name_id = m_ca_model->AddBreakCase(new_bc);

  // Creates a new widget
  BreakCaseInstance* new_break_case_instance = new BreakCaseInstance();
  new_break_case_instance->SetCAModel(m_ca_model);
  new_break_case_instance->SetBreakCase(new_bc);
  new_break_case_instance->SetupWidget();
  connect(new_break_case_instance, SIGNAL(BreakCaseChanged(std::string, std::string)), this, SLOT(RefreshBreakCaseHash(std::string, std::string)));

  // Creates a new listItem
  QListWidgetItem* new_item = new QListWidgetItem();

  // Append item to list of model attributes initialization, and set the widget
  ui->lw_break_cases->addItem(new_item);
  ui->lw_break_cases->setItemWidget(new_item, new_break_case_instance);
  new_item->setSizeHint(new_break_case_instance->size());

  // Refresh the hash item->model_attr
  m_break_cases_hash[new_bc_name_id] = new_item;


  //emit BreakCaseAdded(name_id); // TODO: ADD SIGNAL TO BREAKCASE MANIPULATION
}

void ModelPropertiesHandlerWidget::on_pb_delete_break_case_released() {
  QListWidgetItem* curr_bc_item = ui->lw_break_cases->currentItem();
  if(curr_bc_item == nullptr)
    return;

  BreakCaseInstance* curr_bc_widget = dynamic_cast<BreakCaseInstance*>(ui->lw_break_cases->itemWidget(curr_bc_item));
  std::string bc_name = curr_bc_widget->GetBCName();
  m_ca_model->DelBreakCase(bc_name);
  m_break_cases_hash.erase(bc_name);
  delete curr_bc_item;
}
