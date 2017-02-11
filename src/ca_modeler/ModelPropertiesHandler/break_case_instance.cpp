#include "break_case_instance.h"
#include "ui_break_case_instance.h"

BreakCaseInstance::BreakCaseInstance(QWidget *parent) :
  QWidget(parent),
  ui(new Ui::BreakCaseInstance)
{
  ui->setupUi(this);
}

BreakCaseInstance::~BreakCaseInstance()
{
  delete ui;
}
