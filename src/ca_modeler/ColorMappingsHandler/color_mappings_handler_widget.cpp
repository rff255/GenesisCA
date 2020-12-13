#include "color_mappings_handler_widget.h"
#include "ui_color_mappings_handler_widget.h"

ColorMappingsHandlerWidget::ColorMappingsHandlerWidget(QWidget *parent) :
  QWidget(parent),
  ui(new Ui::ColorMappingsHandlerWidget)
{
  ui->setupUi(this);

  // Initialize control members
  m_curr_lw_mapping = ui->lw_col_attr_mappings;

  // Setup widgets
  SetupWidgets();

  // Connect Signals and Slots
  connect(ui->txt_name,              SIGNAL(editingFinished()), this, SLOT(SaveMappingModifications()));
  connect(ui->txt_description,       SIGNAL(textChanged()),     this, SLOT(SaveMappingModifications()));
  connect(ui->txt_red_description,   SIGNAL(textChanged()),     this, SLOT(SaveMappingModifications()));
  connect(ui->txt_green_description, SIGNAL(textChanged()),     this, SLOT(SaveMappingModifications()));
  connect(ui->txt_blue_description,  SIGNAL(textChanged()),     this, SLOT(SaveMappingModifications()));

  // Emit generic signal AttributeListChanged
  connect(this, SIGNAL(MappingAdded(std::string)),                this, SIGNAL(MappingListChanged()));
  connect(this, SIGNAL(MappingRemoved(std::string)),              this, SIGNAL(MappingListChanged()));
  connect(this, SIGNAL(MappingChanged(std::string,std::string)),  this, SIGNAL(MappingListChanged()));
}

ColorMappingsHandlerWidget::~ColorMappingsHandlerWidget()
{
  delete ui;
}

void ColorMappingsHandlerWidget::SetupWidgets()
{
  ResetMappingsProperties();
}

void ColorMappingsHandlerWidget::ResetMappingsProperties()
{
  m_is_loading = true;

  ui->txt_name->setText(QString::fromStdString(""));
  ui->txt_description->setPlainText(QString::fromStdString(""));
  ui->txt_red_description->setPlainText(QString::fromStdString(""));
  ui->txt_green_description->setPlainText(QString::fromStdString(""));
  ui->txt_blue_description->setPlainText(QString::fromStdString(""));

  m_is_loading = false;
}

void ColorMappingsHandlerWidget::SyncUIWithModel() {
  this->ResetMappingsProperties();
  // Sync attributes-to-color and color-to-attribute mapping lists
  ui->lw_attr_col_mappings->blockSignals(true);
  ui->lw_col_attr_mappings->blockSignals(true);
  ui->lw_attr_col_mappings->clear();
  ui->lw_col_attr_mappings->clear();
  for (string color_mapping : m_ca_model->GetMappingsList()) {
    if(m_ca_model->GetMapping(color_mapping)->m_is_attr_color) {
      ui->lw_attr_col_mappings->addItem(QString::fromStdString(color_mapping));
    } else {
      ui->lw_col_attr_mappings->addItem(QString::fromStdString(color_mapping));
    }
  }
  ui->lw_attr_col_mappings->blockSignals(false);
  ui->lw_col_attr_mappings->blockSignals(false);
}

void ColorMappingsHandlerWidget::set_m_ca_model(CAModel* model) {
  m_ca_model = model;
  this->SyncUIWithModel();
}

void ColorMappingsHandlerWidget::LoadMappingsProperties(QListWidgetItem *curr_item)
{
  if (curr_item == nullptr)
    return;

  m_is_loading = true;

  const Mapping* curr_mapping = m_ca_model->GetMapping(curr_item->text().toStdString());

  ui->txt_name->setText(QString::fromStdString(curr_mapping->m_id_name));
  ui->txt_description->setPlainText(QString::fromStdString(curr_mapping->m_description));
  ui->txt_red_description->setPlainText(QString::fromStdString(curr_mapping->m_red_description));
  ui->txt_green_description->setPlainText(QString::fromStdString(curr_mapping->m_green_description));
  ui->txt_blue_description->setPlainText(QString::fromStdString(curr_mapping->m_blue_description));

  m_is_loading = false;
}

void ColorMappingsHandlerWidget::SaveMappingModifications()
{
  if(m_is_loading)
    return;

  QListWidgetItem* curr_item = m_curr_lw_mapping->currentItem();
  if(curr_item) {
    // For attrCol mappings
    bool m_is_attr_color = false;
    if(m_curr_lw_mapping == ui->lw_attr_col_mappings)
      m_is_attr_color = true;

    Mapping* modified_map = new Mapping(
                                 ui->txt_name->text().toStdString(),
                                 ui->txt_description->toPlainText().toStdString(),
                                 ui->txt_red_description->toPlainText().toStdString(),
                                 ui->txt_green_description->toPlainText().toStdString(),
                                 ui->txt_blue_description->toPlainText().toStdString(),
                                 m_is_attr_color);

    string saved_map_id_name = m_ca_model->ModifyMapping(curr_item->text().toStdString(), modified_map);
    ui->txt_name->setText(QString::fromStdString(saved_map_id_name));

    emit MappingChanged(curr_item->text().toStdString(), saved_map_id_name);

    curr_item->setText(QString::fromStdString(saved_map_id_name));

  }
}

void ColorMappingsHandlerWidget::on_pb_add_col_attr_mapping_released()
{
  std::string name_id = m_ca_model->AddMapping(new Mapping("New color_attribute Mapping",
                                                           "", "", "", "",
                                                           false));
  ui->lw_col_attr_mappings->addItem(QString::fromStdString(name_id));
  ui->lw_col_attr_mappings->setCurrentRow(ui->lw_col_attr_mappings->count()-1);

  emit MappingAdded(name_id);
}

void ColorMappingsHandlerWidget::on_pb_del_col_attr_mapping_released()
{
  QListWidgetItem* curr_item = ui->lw_col_attr_mappings->currentItem();
  if(curr_item) {
    std::string id_name = curr_item->text().toStdString();
    m_ca_model->DelMapping(id_name);
    delete curr_item;
    ResetMappingsProperties();
    LoadMappingsProperties(ui->lw_col_attr_mappings->currentItem());
    emit MappingRemoved(id_name);
  }
}

void ColorMappingsHandlerWidget::on_pb_add_attr_col_mapping_released()
{
  std::string name_id = m_ca_model->AddMapping(new Mapping("New attribute_color Mapping",
                                                           "", "", "", "",
                                                           true));
  ui->lw_attr_col_mappings->addItem(QString::fromStdString(name_id));
  ui->lw_attr_col_mappings->setCurrentRow(ui->lw_attr_col_mappings->count()-1);

  emit MappingAdded(name_id);
}

void ColorMappingsHandlerWidget::on_pb_del_attr_col_mapping_released()
{
  QListWidgetItem* curr_item = ui->lw_attr_col_mappings->currentItem();
  if(curr_item) {
    std::string id_name = curr_item->text().toStdString();
    m_ca_model->DelMapping(id_name);
    delete curr_item;
    ResetMappingsProperties();
    LoadMappingsProperties(ui->lw_attr_col_mappings->currentItem());
    emit MappingRemoved(id_name);
  }
}

void ColorMappingsHandlerWidget::on_lw_col_attr_mappings_itemSelectionChanged()
{
  QListWidgetItem *curr_item = ui->lw_col_attr_mappings->currentItem();
  if (curr_item){
    m_curr_lw_mapping = ui->lw_col_attr_mappings;
    ui->lw_attr_col_mappings->clearSelection();
    ui->lw_attr_col_mappings->setCurrentItem(nullptr);
    LoadMappingsProperties(curr_item);
  }
}

void ColorMappingsHandlerWidget::on_lw_attr_col_mappings_itemSelectionChanged()
{
  QListWidgetItem *curr_item = ui->lw_attr_col_mappings->currentItem();
  if (curr_item){
    m_curr_lw_mapping = ui->lw_attr_col_mappings;
    ui->lw_col_attr_mappings->clearSelection();
    ui->lw_col_attr_mappings->setCurrentItem(nullptr);
    LoadMappingsProperties(curr_item);
  }
}
