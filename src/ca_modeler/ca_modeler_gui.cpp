#include "ca_modeler_gui.h"
#include "ui_ca_modeler_gui.h"

CAModelerGUI::CAModelerGUI(QWidget *parent) :
    QMainWindow(parent),
    ui(new Ui::CAModelerGUI)
{
    ui->setupUi(this);
}

CAModelerGUI::~CAModelerGUI()
{
    delete ui;
}
