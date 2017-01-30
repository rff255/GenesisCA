#include "ca_modeler_gui.h"
#include "ui_ca_modeler_gui.h"

CAModelerGUI::CAModelerGUI(QWidget *parent) :
  QMainWindow(parent),
  ui(new Ui::CAModelerGUI),
  m_modeler_manager(new CAModelerManager()) {
    ui->setupUi(this);
}

CAModelerGUI::~CAModelerGUI() {
  delete ui;
  delete m_modeler_manager;
}

void CAModelerGUI::LoadAttributesProperties(QListWidgetItem* curr_item) {
  Attribute* curr_attribute = m_modeler_manager->GetAttribute(curr_item);

  ui->txt_attribute_name->setText(QString::fromStdString(curr_attribute->m_name));
  ui->cb_attribute_type->setCurrentIndex(curr_attribute->m_type);  // TODO(figueiredo): Define combo_box values from enum values
  ui->txt_attribute_description->setPlainText(QString::fromStdString(curr_attribute->m_description));
  ui->sb_list_length->setValue(curr_attribute->m_list_length);
  ui->cb_list_type->setCurrentIndex(curr_attribute->m_list_type);

  ui->lw_allowed_values->clear();
  for (int i=0; i < curr_attribute->m_user_defined_values.size(); ++i) {
    ui->lw_allowed_values->addItem(QString::fromStdString(curr_attribute->m_user_defined_values[i]));
  }
}

void CAModelerGUI::on_act_quit_triggered() {
  // TODO(figueiredo): check for unsaved changes and open dialog asking for confirmation
  QApplication::quit();
}

void CAModelerGUI::on_cb_attribute_type_currentIndexChanged(const QString &arg1) {
  std::string option = arg1.toStdString();

  if(option == "List") {
    ui->gb_list_properties->setEnabled(true);
    bool user_defined = (ui->cb_list_type->currentText().toStdString() == "User Defined");
    ui->gb_user_defined_properties->setEnabled(user_defined);

  } else if (option == "User Defined"){
    ui->gb_list_properties->setEnabled(false);
    ui->gb_user_defined_properties->setEnabled(true);

  } else {
    ui->gb_list_properties->setEnabled(false);
    ui->gb_user_defined_properties->setEnabled(false);
  }
}

void CAModelerGUI::on_cb_list_type_currentIndexChanged(const QString &arg1) {
  std::string option = arg1.toStdString();

  if (option == "User Defined"){
    ui->gb_user_defined_properties->setEnabled(true);

  } else {
    ui->gb_user_defined_properties->setEnabled(false);
  }
}

void CAModelerGUI::on_pb_add_cell_attribute_released()
{
  ui->lw_cell_attributes->addItem("New cell attribute");
  QListWidgetItem* new_item = ui->lw_cell_attributes->item(ui->lw_cell_attributes->count() - 1);
  m_modeler_manager->AddAttribute(new_item, true);
}

void CAModelerGUI::on_pb_add_model_attribute_released()
{
  ui->lw_model_attributes->addItem("New model attribute");
  QListWidgetItem* new_item = ui->lw_model_attributes->item(ui->lw_model_attributes->count() - 1);
  m_modeler_manager->AddAttribute(new_item, false);
}

void CAModelerGUI::on_pb_delete_cell_attribute_released()
{
  QListWidgetItem* curr_item = ui->lw_cell_attributes->currentItem();
  if(curr_item) {
    m_modeler_manager->RemoveAttribute(curr_item, true);
    delete curr_item;
  }
}

void CAModelerGUI::on_pb_delete_model_attribute_released()
{
  QListWidgetItem* curr_item = ui->lw_model_attributes->currentItem();
  if(curr_item) {
    m_modeler_manager->RemoveAttribute(curr_item, false);
    delete curr_item;
  }
}

void CAModelerGUI::on_pb_atribute_save_modifications_released()
{
  QListWidgetItem* curr_item = m_curr_lw_attribute->currentItem();
  if(curr_item) {
    curr_item->setText(ui->txt_attribute_name->text());
    m_modeler_manager->ModifyAttribute(curr_item,
                                       ui->txt_attribute_name->text().toStdString(),
                                       ui->cb_attribute_type->currentText().toStdString(),
                                       ui->txt_attribute_description->toPlainText().toStdString(),
                                       ui->sb_list_length->value(),
                                       ui->cb_list_type->currentText().toStdString(),
                                       ui->lw_allowed_values);

  }
}

void CAModelerGUI::on_lw_cell_attributes_itemClicked(QListWidgetItem *item)
{
  m_curr_lw_attribute = ui->lw_cell_attributes;
  LoadAttributesProperties(item);
}

void CAModelerGUI::on_lw_model_attributes_itemClicked(QListWidgetItem *item)
{
  m_curr_lw_attribute = ui->lw_model_attributes;
  LoadAttributesProperties(item);
}
