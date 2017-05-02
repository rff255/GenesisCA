#include "ca_modeler_gui.h"
#include "ui_ca_modeler_gui.h"
#include "attribute_handler_widget.h"
#include "vicinity_handler_widget.h"

#include <QDebug>

CAModelerGUI::CAModelerGUI(QWidget *parent) :
  QMainWindow(parent),
  ui(new Ui::CAModelerGUI),
  m_ca_model(new CAModel()) {
    ui->setupUi(this);

    // Setup widgets
    SetupWidgets();

    // Pass model reference to promoted widgets
    PassModel();

    // Connect Signals and Slots
    // Attribute change results in refresh model properties
    connect(ui->wgt_attribute_handler, SIGNAL(AttributeAdded(std::string)), ui->wgt_model_properties_handler, SLOT(AddModelAttributesInitItem(std::string)));
    connect(ui->wgt_attribute_handler, SIGNAL(AttributeRemoved(std::string)), ui->wgt_model_properties_handler, SLOT(DelModelAttributesInitItem(std::string)));
    connect(ui->wgt_attribute_handler, SIGNAL(AttributeChanged(std::string, std::string)), ui->wgt_model_properties_handler, SLOT(ChangeModelAttributesInitItem(std::string,std::string)));

    // Update BreakCases options after attributes change
    connect(ui->wgt_attribute_handler, SIGNAL(AttributeListChanged()),     ui->wgt_model_properties_handler, SLOT(RefreshBreakCasesOptions()));

    // Update GraphEditor after list of attributes change
    connect(ui->wgt_attribute_handler,      SIGNAL(AttributeListChanged()),    ui->wgt_update_rules_handler, SLOT(UpdateEditorComboBoxes()));
    connect(ui->wgt_vicinities_handler,     SIGNAL(NeighborhoodListChanged()), ui->wgt_update_rules_handler, SLOT(UpdateEditorComboBoxes()));
    connect(ui->wgt_color_mappings_handler, SIGNAL(MappingListChanged()),      ui->wgt_update_rules_handler, SLOT(UpdateEditorComboBoxes()));
}

CAModelerGUI::~CAModelerGUI() {
  delete ui;
}

void CAModelerGUI::SetupWidgets() {
  // Attributes tab
  ui->wgt_attribute_handler->ConfigureCB();

  // Model Properties tab
  ui->wgt_model_properties_handler->ConfigureCB();
}

void CAModelerGUI::PassModel() {
  ui->wgt_attribute_handler->set_m_ca_model(m_ca_model);
  ui->wgt_model_properties_handler->set_m_ca_model(m_ca_model);
  ui->wgt_vicinities_handler->set_m_ca_model(m_ca_model);
  ui->wgt_update_rules_handler->set_m_ca_model(m_ca_model);
  ui->wgt_color_mappings_handler->set_m_ca_model(m_ca_model);
}

// Slots:

void CAModelerGUI::on_act_quit_triggered() {
  // TODO(figueiredo): check for unsaved changes and open dialog asking for confirmation
  QApplication::quit();
}

void CAModelerGUI::on_act_export_c_code_triggered()
{
  std::string toBePrinted = "//#### Generated Header: ####\n" +
                            m_ca_model->GenerateHCode() +
                            "//#### Generated Implementation: ####\n" +
                            m_ca_model->GenerateCPPCode() +
                            "//####\n";

  qDebug(toBePrinted.c_str());
}
