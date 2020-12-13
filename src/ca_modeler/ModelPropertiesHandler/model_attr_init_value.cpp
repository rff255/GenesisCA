#include "model_attr_init_value.h"
#include "ui_model_attr_init_value.h"

ModelAttrInitValue::ModelAttrInitValue(QWidget *parent) :
  QWidget(parent),
  ui(new Ui::ModelAttrInitValue)
{
  ui->setupUi(this);

  // Connect Signals and Slots
  connect(ui->check_value, SIGNAL(toggled(bool)), this, SLOT(EmitValueChanged()));
  connect(ui->sb_value,    SIGNAL(valueChanged(int)), this, SLOT(EmitValueChanged()));
  connect(ui->dsb_value,   SIGNAL(valueChanged(double)), this, SLOT(EmitValueChanged()));
  connect(ui->cb_value,    SIGNAL(currentIndexChanged(int)), this, SLOT(EmitValueChanged()));
}

ModelAttrInitValue::~ModelAttrInitValue()
{
  delete ui;
}

void ModelAttrInitValue::SetAttrName(std::string new_name) {
  ui->lbl_name->setText(QString::fromStdString(new_name));
}

void ModelAttrInitValue::SetWidgetDetails(Attribute* corresponding_attribute) {
  std::string attr_type = corresponding_attribute->m_type;
  std::string init_value = corresponding_attribute->m_init_value;

  if (attr_type == "Bool") {
    ui->stk_type_pages->setCurrentWidget(ui->page_bool);
    ui->check_value->setChecked(init_value == "true");
  }

  else if (attr_type == "Integer") {
    ui->stk_type_pages->setCurrentWidget(ui->page_integer);
    ui->sb_value->setValue(std::atoi(init_value.c_str()));
  }

  else if (attr_type == "Float") {
    ui->stk_type_pages->setCurrentWidget(ui->page_float);
    ui->dsb_value->setValue(std::atof(init_value.c_str()));
  }

  m_curr_page = ui->stk_type_pages->currentWidget();
  EmitValueChanged();
}

std::string ModelAttrInitValue::GetAttrName()
{
   return ui->lbl_name->text().toStdString();
}

std::string ModelAttrInitValue::GetInitValue() {
  if(ui->stk_type_pages->currentWidget() == ui->page_bool)
    return std::to_string(ui->check_value->isChecked());

  else if(ui->stk_type_pages->currentWidget() == ui->page_integer)
    return std::to_string(ui->sb_value->value());

  else if(ui->stk_type_pages->currentWidget() == ui->page_float)
    return std::to_string((float) ui->dsb_value->value());

  else if(ui->stk_type_pages->currentWidget() == ui->page_user_defined)
    return ui->cb_value->currentText().toStdString();
  else
    return "GetInitValue is wrong";
}

void ModelAttrInitValue::EmitValueChanged() {
  emit InitValueChanged(ui->lbl_name->text().toStdString(), GetInitValue());
}
