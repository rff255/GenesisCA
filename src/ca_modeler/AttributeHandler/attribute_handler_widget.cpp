#include "attribute_handler_widget.h"
#include "ui_attribute_handler_widget.h"

AttributeHandlerWidget::AttributeHandlerWidget(QWidget *parent) :
  QWidget(parent),
  ui(new Ui::AttributeHandlerWidget),
  m_is_loading(true) {

  ui->setupUi(this);

  // Initialize control members
  m_curr_lw_attribute = ui->lw_cell_attributes;

  // Setup widgets
  SetupWidgets();

  // Connect Signals and Slots
  connect(ui->txt_attribute_name,         SIGNAL(editingFinished()),                  this, SLOT(SaveAttributeModifications()));
  connect(ui->cb_attribute_type,          SIGNAL(activated(int)),                     this, SLOT(SaveAttributeModifications()));
  connect(ui->txt_attribute_description,  SIGNAL(textChanged()),                      this, SLOT(SaveAttributeModifications()));
  connect(ui->sb_list_length,             SIGNAL(valueChanged(int)),                  this, SLOT(SaveAttributeModifications()));
  connect(ui->cb_list_type,               SIGNAL(activated(int)),                     this, SLOT(SaveAttributeModifications()));
  connect(ui->lw_allowed_values->model(), SIGNAL(rowsInserted(QModelIndex,int,int)),  this, SLOT(SaveAttributeModifications()));
  connect(ui->lw_allowed_values->model(), SIGNAL(rowsRemoved(QModelIndex,int,int)),   this, SLOT(SaveAttributeModifications()));
}

AttributeHandlerWidget::~AttributeHandlerWidget()
{
  delete ui;
}

void AttributeHandlerWidget::SetupWidgets() {
  ResetAttributesProperties();
}

void AttributeHandlerWidget::LoadAttributesProperties(QListWidgetItem* curr_item) {
  m_is_loading = true;

  const Attribute* curr_attribute = m_ca_model->GetCellAttribute(curr_item->text().toStdString());

  ui->txt_attribute_name->setText(QString::fromStdString(curr_attribute->m_id_name));

  ui->cb_attribute_type->setCurrentIndex(ui->cb_attribute_type->findText(QString::fromStdString(curr_attribute->m_type)));
  ui->txt_attribute_description->setPlainText(QString::fromStdString(curr_attribute->m_description));
  ui->sb_list_length->setValue(curr_attribute->m_list_length);
  ui->cb_list_type->setCurrentIndex(ui->cb_list_type->findText(QString::fromStdString(curr_attribute->m_list_type)));

  ui->lw_allowed_values->clear();
  for (int i=0; i < curr_attribute->m_user_defined_values.size(); ++i) {
    ui->lw_allowed_values->addItem(QString::fromStdString(curr_attribute->m_user_defined_values[i]));
  }

  ui->fr_attributes_properties->setEnabled(true);
  m_is_loading = false;
}

void AttributeHandlerWidget::SaveAttributeModifications()
{
//  if(m_is_loading)
//    return;

//  QListWidgetItem* curr_item = m_curr_lw_attribute->currentItem();
//  if(curr_item) {
//    curr_item->setText(ui->txt_attribute_name->text());

//    Attribute* target_attrubute = m_attributes_hash.value(curr_item);
//    target_attrubute->m_name = ui->txt_attribute_name->text().toStdString();
//    target_attrubute->m_type = ui->cb_attribute_type->currentText().toStdString();
//    target_attrubute->m_description = ui->txt_attribute_description->toPlainText().toStdString();
//    target_attrubute->m_list_length = ui->sb_list_length->value();
//    target_attrubute->m_list_type = ui->cb_list_type->currentText().toStdString();

//    target_attrubute->m_user_defined_values.clear();
//    for(int i = 0; i < ui->lw_allowed_values->count(); ++i) {
//        QListWidgetItem* item = ui->lw_allowed_values->item(i);
//        target_attrubute->m_user_defined_values.push_back(item->text().toStdString());
//    }

//    emit AttributeChanged();
//  }
}

void AttributeHandlerWidget::ResetAttributesProperties() {
  ui->lw_cell_attributes->clearSelection();
  ui->lw_model_attributes->clearSelection();

  ui->txt_attribute_name->setText(QString::fromStdString(""));
  ui->cb_attribute_type->setCurrentIndex(0);
  ui->txt_attribute_description->setPlainText(QString::fromStdString(""));
  ui->sb_list_length->setValue(0);
  ui->cb_list_type->setCurrentIndex(0);
  ui->lw_allowed_values->clear();

  ui->fr_attributes_properties->setEnabled(false);
}

void AttributeHandlerWidget::ConfigureCB() {
  for (int i = 0; i < cb_attribute_type_values.size(); ++i) {
    ui->cb_attribute_type->addItem(QString::fromStdString(cb_attribute_type_values[i]));
  }

  for (int i = 0; i < cb_attribute_list_type_values.size(); ++i) {
    ui->cb_list_type->addItem(QString::fromStdString(cb_attribute_list_type_values[i]));
  }
}

void AttributeHandlerWidget::on_cb_attribute_type_currentIndexChanged(const QString &arg1) {
  std::string option = arg1.toStdString();

  if(option == "List") {
    ui->gb_list_properties->setEnabled(true);

    if(ui->cb_list_type->currentText().toStdString() == "User Defined")
      ui->gb_user_defined_properties->setEnabled(true);
    else {
      ui->gb_user_defined_properties->setEnabled(false);
      ui->lw_allowed_values->clear();
    }

  } else if (option == "User Defined"){
    ui->gb_list_properties->setEnabled(false);
    ui->gb_user_defined_properties->setEnabled(true);

  } else {
    ui->gb_list_properties->setEnabled(false);
    ui->gb_user_defined_properties->setEnabled(false);
    ui->lw_allowed_values->clear();
  }
}

void AttributeHandlerWidget::on_cb_list_type_currentIndexChanged(const QString &arg1) {
  std::string option = arg1.toStdString();

  if (option == "User Defined"){
    ui->gb_user_defined_properties->setEnabled(true);

  } else if (ui->cb_attribute_type->currentText().toStdString() != "User Defined"){
    ui->gb_user_defined_properties->setEnabled(false);
  }
}

void AttributeHandlerWidget::on_pb_add_cell_attribute_released() {
  std::string name_id = m_ca_model->AddCellAttribute(new Attribute("New cell attribute",
                                                                   cb_attribute_type_values[0], "", 0,
                                                                   cb_attribute_list_type_values[0],
                                                                   std::vector<string>(), ""));
  ui->lw_cell_attributes->addItem(QString::fromStdString(name_id));
  ui->lw_cell_attributes->setCurrentRow(ui->lw_cell_attributes->count()-1);

  //emit AttributeChanged();
}

void AttributeHandlerWidget::on_pb_add_model_attribute_released() {

}

void AttributeHandlerWidget::on_pb_delete_cell_attribute_released()
{
  QListWidgetItem* curr_item = ui->lw_cell_attributes->currentItem();
  if(curr_item) {
    m_ca_model->DelCellAttribute(curr_item->text().toStdString());
    ResetAttributesProperties();
    emit AttributeChanged();
  }
}

void AttributeHandlerWidget::on_pb_delete_model_attribute_released()
{
//  QListWidgetItem* curr_item = ui->lw_model_attributes->currentItem();
//  if(curr_item) {
//    m_modeler_manager->RemoveAttribute(curr_item, false);
//    delete curr_item;
//    ResetAttributesProperties();

//    emit AttributeChanged();
//  }
}

void AttributeHandlerWidget::on_pb_add_value_released()
{
  QString new_value = ui->txt_new_allowed_value->text();
  if(new_value.toStdString() != "") {
    ui->lw_allowed_values->addItem(new_value);
    ui->txt_new_allowed_value->setText(QString::fromStdString(""));
  }
}

void AttributeHandlerWidget::on_pb_remove_value_released()
{
  QListWidgetItem* curr_item_value = ui->lw_allowed_values->currentItem();
  if(curr_item_value) {
    delete curr_item_value;
  }
}

void AttributeHandlerWidget::on_lw_cell_attributes_itemSelectionChanged()
{
//  QListWidgetItem *curr_item = ui->lw_cell_attributes->currentItem();
//  if (curr_item){
//    m_curr_lw_attribute = ui->lw_cell_attributes;
//    ui->lw_model_attributes->clearSelection();
//    LoadAttributesProperties(curr_item);
//  }
}

void AttributeHandlerWidget::on_lw_model_attributes_itemSelectionChanged()
{
  QListWidgetItem *curr_item = ui->lw_model_attributes->currentItem();
  if (curr_item) {
    m_curr_lw_attribute = ui->lw_model_attributes;
    ui->lw_cell_attributes->clearSelection();
    LoadAttributesProperties(curr_item);
  }
}
