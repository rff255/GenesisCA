#include "attribute_handler_widget.h"
#include "ui_attribute_handler_widget.h"

// TODO(rodrigo.figueiredo): There is a unknow bug on cell attribute manipulation, renaming, and changing focus, or selected attr. I dont know
// but it discards the changes made on the attribute name/type/description.

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

  // Emit generic signal AttributeListChanged
  connect(this, SIGNAL(AttributeAdded(std::string)),                this, SIGNAL(AttributeListChanged()));
  connect(this, SIGNAL(AttributeRemoved(std::string)),              this, SIGNAL(AttributeListChanged()));
  connect(this, SIGNAL(AttributeChanged(std::string,std::string)),  this, SIGNAL(AttributeListChanged()));
}

AttributeHandlerWidget::~AttributeHandlerWidget()
{
  delete ui;
}

void AttributeHandlerWidget::SetupWidgets() {
  ResetAttributesProperties();
}

void AttributeHandlerWidget::LoadAttributesProperties(QListWidgetItem* curr_item) {
  if (curr_item == nullptr)
    return;

  m_is_loading = true;

  const Attribute* curr_attribute = m_ca_model->GetAttribute(curr_item->text().toStdString());

  ui->txt_attribute_name->setText(QString::fromStdString(curr_attribute->m_id_name));

  ui->cb_attribute_type->setCurrentIndex(ui->cb_attribute_type->findText(QString::fromStdString(curr_attribute->m_type)));
  ui->txt_attribute_description->setPlainText(QString::fromStdString(curr_attribute->m_description));

  ui->fr_attributes_properties->setEnabled(true);
  m_is_loading = false;
}

void AttributeHandlerWidget::SaveAttributeModifications() {
  if(m_is_loading)
    return;

  QListWidgetItem* curr_item = m_curr_lw_attribute->currentItem();
  if(curr_item) {

    // For model attributes
    bool is_model_attr = (m_curr_lw_attribute == ui->lw_model_attributes);

    Attribute* modified_attr = new Attribute(
                                 ui->txt_attribute_name->text().toStdString(),
                                 ui->cb_attribute_type->currentText().toStdString(),
                                 ui->txt_attribute_description->toPlainText().toStdString(),
                                 "",
                                 is_model_attr);

    string saved_attr_id_name = m_ca_model->ModifyAttribute(curr_item->text().toStdString(), modified_attr);
    ui->txt_attribute_name->setText(QString::fromStdString(saved_attr_id_name));

    emit AttributeChanged(curr_item->text().toStdString(), saved_attr_id_name);

    curr_item->setText(QString::fromStdString(saved_attr_id_name));

  }
}

void AttributeHandlerWidget::ResetAttributesProperties() {
  m_is_loading = true;

  ui->txt_attribute_name->setText(QString::fromStdString(""));
  ui->cb_attribute_type->setCurrentIndex(0);
  ui->txt_attribute_description->setPlainText(QString::fromStdString(""));

  ui->fr_attributes_properties->setEnabled(false);

  m_is_loading = false;
}

void AttributeHandlerWidget::ConfigureCB() {
  for (int i = 0; i < cb_attribute_type_values.size(); ++i)
    ui->cb_attribute_type->addItem(QString::fromStdString(cb_attribute_type_values[i]));
}

void AttributeHandlerWidget::SyncUIWithModel() {
  this->ResetAttributesProperties();

  // Sync list of attributes
  ui->lw_model_attributes->blockSignals(true);
  ui->lw_cell_attributes->blockSignals(true);
  ui->lw_model_attributes->clear();
  ui->lw_cell_attributes->clear();
  for(string attribute_name : m_ca_model->GetAttributesList()) {
    const Attribute* attribute = m_ca_model->GetAttribute(attribute_name);
    if(attribute->m_is_model_attribute) {
      ui->lw_model_attributes->addItem(QString::fromStdString(attribute_name));
    } else {
      ui->lw_cell_attributes->addItem(QString::fromStdString(attribute_name));
    }
  }
  ui->lw_model_attributes->blockSignals(false);
  ui->lw_cell_attributes->blockSignals(false);
}

void AttributeHandlerWidget::set_m_ca_model(CAModel* model) {
  m_ca_model = model;
  this->SyncUIWithModel();
}

void AttributeHandlerWidget::on_pb_add_cell_attribute_released() {
  std::string name_id = m_ca_model->AddAttribute(new Attribute("New cell attribute",
                                                               cb_attribute_type_values[0], "", "", false));
  ui->lw_cell_attributes->addItem(QString::fromStdString(name_id));
  ui->lw_cell_attributes->setCurrentRow(ui->lw_cell_attributes->count()-1);

  emit AttributeAdded(name_id);
}

void AttributeHandlerWidget::on_pb_add_model_attribute_released() {
  std::string name_id = m_ca_model->AddAttribute(new Attribute("New model attribute",
                                                               cb_attribute_type_values[0], "", "", true));
  ui->lw_model_attributes->addItem(QString::fromStdString(name_id));
  ui->lw_model_attributes->setCurrentRow(ui->lw_model_attributes->count()-1);

  emit AttributeAdded(name_id);
}

void AttributeHandlerWidget::on_pb_delete_cell_attribute_released() {
  QListWidgetItem* curr_item = ui->lw_cell_attributes->currentItem();
  if(curr_item) {
    std::string id_name = curr_item->text().toStdString();
    m_ca_model->DelAttribute(id_name);
    delete curr_item;
    ResetAttributesProperties();
    LoadAttributesProperties(ui->lw_cell_attributes->currentItem());
    emit AttributeRemoved(id_name);
  }
}

void AttributeHandlerWidget::on_pb_delete_model_attribute_released()
{
  QListWidgetItem* curr_item = ui->lw_model_attributes->currentItem();
  if(curr_item) {
    std::string id_name = curr_item->text().toStdString();
    m_ca_model->DelAttribute(id_name);
    delete curr_item;
    ResetAttributesProperties();
    LoadAttributesProperties(ui->lw_model_attributes->currentItem());
    emit AttributeRemoved(id_name);
  }
}

void AttributeHandlerWidget::on_lw_cell_attributes_itemSelectionChanged() {
  QListWidgetItem *curr_item = ui->lw_cell_attributes->currentItem();
  if (curr_item){
    m_curr_lw_attribute = ui->lw_cell_attributes;
    ui->lw_model_attributes->clearSelection();
    ui->lw_model_attributes->setCurrentItem(nullptr);
    LoadAttributesProperties(curr_item);
  }
}

void AttributeHandlerWidget::on_lw_model_attributes_itemSelectionChanged() {
  QListWidgetItem *curr_item = ui->lw_model_attributes->currentItem();
  if (curr_item) {
    m_curr_lw_attribute = ui->lw_model_attributes;
    ui->lw_cell_attributes->clearSelection();
    ui->lw_cell_attributes->setCurrentItem(nullptr);
    LoadAttributesProperties(curr_item);
  }
}
