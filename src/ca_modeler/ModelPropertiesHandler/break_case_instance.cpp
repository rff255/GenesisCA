#include "break_case_instance.h"
#include "ui_break_case_instance.h"

BreakCaseInstance::BreakCaseInstance(QWidget *parent) :
  QWidget(parent),
  ui(new Ui::BreakCaseInstance),
  m_is_loading(true),
  m_is_updating_attr_options(true)
{
  ui->setupUi(this);

  // Configure Combo boxes
  ConfigureCB();

  // Connections
  connect(ui->txt_name,               SIGNAL(editingFinished()),    this, SLOT(SaveBCModifications()));
  //Does not need //connect(ui->cb_selected_attribute,  SIGNAL(activated(int)),       this, SLOT(SaveBCModifications()));
  connect(ui->cb_amount_cells,        SIGNAL(activated(int)),       this, SLOT(SaveBCModifications()));
  connect(ui->sb_amount_cells,        SIGNAL(valueChanged(int)),    this, SLOT(SaveBCModifications()));
  connect(ui->sb_integer_value,       SIGNAL(valueChanged(int)),    this, SLOT(SaveBCModifications()));
  connect(ui->sb_float_value,         SIGNAL(valueChanged(double)), this, SLOT(SaveBCModifications()));
  connect(ui->cb_integer_check,       SIGNAL(activated(int)),       this, SLOT(SaveBCModifications()));
  connect(ui->cb_float_check,         SIGNAL(activated(int)),       this, SLOT(SaveBCModifications()));
  connect(ui->cb_user_defined_value,  SIGNAL(activated(int)),       this, SLOT(SaveBCModifications()));
  connect(ui->check_value,            SIGNAL(toggled(bool)),        this, SLOT(SaveBCModifications()));
}

BreakCaseInstance::~BreakCaseInstance() {
  delete ui;
}

void BreakCaseInstance::ConfigureCB() {
  for (int i = 0; i < cb_break_case_amount_unit.size(); ++i)
    ui->cb_amount_cells->addItem(QString::fromStdString(cb_break_case_amount_unit[i]));

  for (int i = 0; i < cb_break_case_statements.size(); ++i) {
    ui->cb_integer_check->addItem(QString::fromStdString(cb_break_case_statements[i]));
    ui->cb_float_check->addItem(QString::fromStdString(cb_break_case_statements[i]));
  }
}

void BreakCaseInstance::SetupStatementType(BreakCase *break_case) {
  ui->txt_name->setText(QString::fromStdString(break_case->m_id_name));

  if(break_case->m_considered_attr == "") {
    ui->stk_statement_types->setCurrentWidget(ui->page_not_allowed);
    return;
  }

  std::string attr_type = m_ca_model->GetAttribute(break_case->m_considered_attr)->m_type;

  if (attr_type == "Bool") {
    ui->stk_statement_types->setCurrentWidget(ui->page_bool);
    if (break_case->m_statement_value != "")
      ui->check_value->setChecked(std::stoi(break_case->m_statement_value)==1);
  }

  else if (attr_type == "Integer") {
    ui->stk_statement_types->setCurrentWidget(ui->page_integer);
    if (break_case->m_statement_value != "") {
      ui->cb_integer_check->setCurrentText(QString::fromStdString(break_case->m_statement_type));
      ui->sb_integer_value->setValue(std::stoi(break_case->m_statement_value));
    }
  }

  else if (attr_type == "Float"){
    ui->stk_statement_types->setCurrentWidget(ui->page_float);
    if (break_case->m_statement_value != "") {
      ui->cb_float_check->setCurrentText(QString::fromStdString(break_case->m_statement_type));
      ui->sb_float_value->setValue(std::stof(break_case->m_statement_value));
    }
  }

  else if (attr_type == "List")
    ui->stk_statement_types->setCurrentWidget(ui->page_not_allowed);

  else if (attr_type == "User Defined") {
    ui->stk_statement_types->setCurrentWidget(ui->page_user_defined);
    std::vector<string>* user_defined_values = m_ca_model->GetAttribute(break_case->m_considered_attr)->m_user_defined_values;

    ui->cb_user_defined_value->clear();
    if(user_defined_values != nullptr)
      for (int i=0; i < user_defined_values->size(); ++i)
        ui->cb_user_defined_value->addItem(QString::fromStdString((*user_defined_values)[i]));

    if (break_case->m_statement_value != "")
      ui->cb_user_defined_value->setCurrentText(QString::fromStdString(break_case->m_statement_value));
  }
}

std::string BreakCaseInstance::GetStatementType() {
  QWidget* curr_page_type = ui->stk_statement_types->currentWidget();

  if (curr_page_type == ui->page_bool || curr_page_type == ui->page_not_allowed || curr_page_type == ui->page_user_defined) {
    return "";
  }

  else if (curr_page_type == ui->page_integer) {
    return ui->cb_integer_check->currentText().toStdString();
  }

  else if (curr_page_type == ui->page_float) {
    return ui->cb_float_check->currentText().toStdString();
  }

  else
    return "INVALID BREAK CASE PAGE";
}

std::string BreakCaseInstance::GetStatementValue() {
  QWidget* curr_page_type = ui->stk_statement_types->currentWidget();

  if (curr_page_type == ui->page_not_allowed) {
    return "";
  }

  else if (curr_page_type == ui->page_bool) {
    return std::to_string(ui->check_value->isChecked());
  }

  else if (curr_page_type == ui->page_integer) {
    return std::to_string(ui->sb_integer_value->value());
  }

  else if (curr_page_type == ui->page_float) {
    return std::to_string(ui->sb_float_value->value());
  }

  else if (curr_page_type == ui->page_user_defined) {
    return ui->cb_user_defined_value->currentText().toStdString();
  }

  else
    return "INVALID BREAK CASE PAGE";
}

void BreakCaseInstance::SetupWidget() {
  m_is_loading = true;

  ui->txt_name->setText(QString::fromStdString(m_break_case->m_id_name));

  // Add Attributes options
  m_is_updating_attr_options = true;
  std::vector<std::string> attributes = m_ca_model->GetAttributesList();
  ui->cb_selected_attribute->clear();
  for (int i = 0; i < attributes.size(); ++i)
    if(m_ca_model->GetAttribute(attributes[i])->m_is_model_attribute == false)
      ui->cb_selected_attribute->addItem(QString::fromStdString(attributes[i]));
  m_is_updating_attr_options = false;

  if(m_ca_model->GetAttribute(m_break_case->m_considered_attr) != nullptr) {
    ui->cb_selected_attribute->setCurrentText(QString::fromStdString(m_break_case->m_considered_attr));
    m_break_case->m_considered_attr = ui->cb_selected_attribute->currentText().toStdString();
  }
  else {
    ui->cb_selected_attribute->setCurrentText(ui->cb_selected_attribute->itemText(0));
    m_break_case->m_considered_attr = ui->cb_selected_attribute->currentText().toStdString();
  }

  ui->cb_amount_cells->setCurrentText(QString::fromStdString(m_break_case->m_ammount_unit));
  ui->sb_amount_cells->setValue(m_break_case->m_ammount);

  m_is_loading = false;

  SetupStatementType(m_break_case);

  SaveBCModifications();
}

void BreakCaseInstance::SaveBCModifications() {
  if(m_is_loading)
    return;

  BreakCase* modified_bc = new BreakCase(ui->txt_name->text().toStdString(), ui->cb_selected_attribute->currentText().toStdString(),
                                         ui->cb_amount_cells->currentText().toStdString(), ui->sb_amount_cells->value(),
                                         GetStatementType(), GetStatementValue());

  std::string old_id_name = m_break_case->m_id_name;
  std::string new_id_name = m_ca_model->ModifyBreakCase(m_break_case->m_id_name, modified_bc);
  ui->txt_name->setText(QString::fromStdString(new_id_name));
  m_break_case = m_ca_model->GetBreakCase(new_id_name);

  emit BreakCaseChanged(old_id_name, new_id_name);
}

void BreakCaseInstance::on_cb_selected_attribute_currentIndexChanged(const QString &arg1) {
  if(m_is_updating_attr_options)
    return;

  m_is_loading = true;

  m_break_case->m_considered_attr = arg1.toStdString();
  m_break_case->m_statement_value = "";
  SetupStatementType(m_break_case);

  m_is_loading = false;
  SaveBCModifications();
}
