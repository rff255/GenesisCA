#include "break_case_instance.h"
#include "ui_break_case_instance.h"

BreakCaseInstance::BreakCaseInstance(QWidget *parent) :
  QWidget(parent),
  ui(new Ui::BreakCaseInstance) {
  ui->setupUi(this);

  // Configure Combo boxes
  ConfigureCB();
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

void BreakCaseInstance::SetBCName(std::string new_name) {
  ui->txt_name->setText(QString::fromStdString(new_name));
}

void BreakCaseInstance::SetStatementType(BreakCase *break_case) {
  if(break_case->m_considered_attr == "") {
    ui->stk_statement_types->setCurrentWidget(ui->page_not_allowed);
    return;
  }

  std::string attr_type = m_ca_model->GetAttribute(break_case->m_considered_attr)->m_type;

  if (attr_type == "Bool") {
    ui->stk_statement_types->setCurrentWidget(ui->page_bool);
    ui->check_value->setChecked(std::stoi(break_case->m_statement_value)==1);
  }

  else if (attr_type == "Integer") {
    ui->stk_statement_types->setCurrentWidget(ui->page_integer);
    ui->cb_integer_check->setCurrentText(QString::fromStdString(break_case->m_statement_type));
    ui->sb_integer_value->setValue(std::stoi(break_case->m_statement_value));
  }

  else if (attr_type == "Float"){
    ui->stk_statement_types->setCurrentWidget(ui->page_float);
    ui->cb_float_check->setCurrentText(QString::fromStdString(break_case->m_statement_type));
    ui->sb_float_value->setValue(std::stof(break_case->m_statement_value));
  }

  else if (attr_type == "List")
    ui->stk_statement_types->setCurrentWidget(ui->page_not_allowed);

  else if (attr_type == "User Defined") {
    ui->stk_statement_types->setCurrentWidget(ui->page_user_defined);
    ui->cb_user_defined_value->setCurrentText(QString::fromStdString(break_case->m_statement_value));
  }
}

void BreakCaseInstance::SetupWidget(BreakCase *break_case) {
  m_break_case = break_case;
  ui->txt_name->setText(QString::fromStdString(break_case->m_id_name));

  // Add Attributes to allow selection
  std::vector<std::string> attributes = m_ca_model->GetAtributesList();
  for (int i = 0; i < attributes.size(); ++i)
    ui->cb_selected_attribute->addItem(QString::fromStdString(attributes[i]));

  ui->cb_selected_attribute->setCurrentText(QString::fromStdString(break_case->m_considered_attr));
  ui->cb_amount_cells->setCurrentText(QString::fromStdString(break_case->m_ammount_unit));
  ui->sb_amount_cells->setValue(break_case->m_ammount);

  SetStatementType(break_case);
}

void BreakCaseInstance::SaveBCModifications() {

}

void BreakCaseInstance::on_cb_selected_attribute_currentIndexChanged(const QString &arg1) {

}
