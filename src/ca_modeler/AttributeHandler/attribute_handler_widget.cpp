#include "attribute_handler_widget.h"
#include "ui_attribute_handler_widget.h"

AttributeHandlerWidget::AttributeHandlerWidget(QWidget *parent) :
  QWidget(parent),
  ui(new Ui::AttributeHandlerWidget)
{
  ui->setupUi(this);
}

AttributeHandlerWidget::~AttributeHandlerWidget()
{
  delete ui;
}
