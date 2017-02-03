#include "global_properties_handler_widget.h"
#include "ui_global_properties_handler_widget.h"

GlobalPropertiesHandlerWidget::GlobalPropertiesHandlerWidget(QWidget *parent) :
  QWidget(parent),
  ui(new Ui::GlobalPropertiesHandlerWidget)
{
  ui->setupUi(this);
}

GlobalPropertiesHandlerWidget::~GlobalPropertiesHandlerWidget()
{
  delete ui;
}
