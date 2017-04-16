#include "update_rules_handler.h"
#include "ui_update_rules_handler.h"

UpdateRulesHandler::UpdateRulesHandler(QWidget *parent) :
  QWidget(parent),
  ui(new Ui::UpdateRulesHandler)
{
  ui->setupUi(this);
}

UpdateRulesHandler::~UpdateRulesHandler()
{
  delete ui;
}
