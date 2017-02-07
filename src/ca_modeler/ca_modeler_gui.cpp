#include "ca_modeler_gui.h"
#include "ui_ca_modeler_gui.h"
#include "attribute_handler_widget.h"

CAModelerGUI::CAModelerGUI(QWidget *parent) :
  QMainWindow(parent),
  ui(new Ui::CAModelerGUI),
  m_modeler_manager(new CAModelerManager()) {
    ui->setupUi(this);

    // Setup widgets
    SetupWidgets();

    // Pass manager reference to promoted widgets
    PassManager();

    // Connect Signals and Slots
    // Attribute change results in refresh general properties attr model initialize list
    connect(ui->wgt_attribute_handler, SIGNAL(AttributeChanged()), ui->wgt_global_properties_handler, SLOT(RefreshModelAttributesInitList()));
}

CAModelerGUI::~CAModelerGUI() {
  delete ui;
  delete m_modeler_manager;
}

void CAModelerGUI::SetupWidgets() {
  // Attributes tab
  ui->wgt_attribute_handler->ConfigureCB();
  ui->wgt_attribute_handler->ResetAttributesProperties();
}

void CAModelerGUI::PassManager() {
  ui->wgt_attribute_handler->set_m_modeler_manager(m_modeler_manager);
  ui->wgt_global_properties_handler->set_m_modeler_manager(m_modeler_manager);
}

// Slots:

void CAModelerGUI::on_act_quit_triggered() {
  // TODO(figueiredo): check for unsaved changes and open dialog asking for confirmation
  QApplication::quit();
}
