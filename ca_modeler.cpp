#include "ca_modeler.h"
#include "ui_ca_modeler.h"

CAModeler::CAModeler(QWidget *parent) :
    QMainWindow(parent),
    ui(new Ui::CAModeler)
{
    ui->setupUi(this);
}

CAModeler::~CAModeler()
{
    delete ui;
}
