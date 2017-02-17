#include "model_attr_init_value.h"
#include "ui_model_attr_init_value.h"

ModelAttrInitValue::ModelAttrInitValue(QWidget *parent) :
  QWidget(parent),
  ui(new Ui::ModelAttrInitValue)
{
  ui->setupUi(this);

  // Connect Signals and Slots

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

  if (attr_type == "Bool") {
    ui->stk_type_pages->setCurrentWidget(ui->page_bool);

  } else if (attr_type == "Integer") {
    ui->stk_type_pages->setCurrentWidget(ui->page_integer);

  } else if (attr_type == "Float") {
    ui->stk_type_pages->setCurrentWidget(ui->page_float);

  } else if (attr_type == "List") {
    ui->stk_type_pages->setCurrentWidget(ui->page_list);

  } else if (attr_type == "User Defined") {
    ui->stk_type_pages->setCurrentWidget(ui->page_user_defined);

    // Add allowed values
//    ui->cb_value->clear();
//    for (int i=0; i < corresponding_attribute->m_user_defined_values->size(); ++i) {
//      ui->cb_value->addItem(QString::fromStdString(corresponding_attribute->m_user_defined_values[i]));
//    }
//    ui->cb_value->setCurrentIndex(0);
  }
}
