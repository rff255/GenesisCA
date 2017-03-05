#include "vicinity_handler_widget.h"
#include "ui_vicinity_handler_widget.h"

#include <QMessageBox>

VicinityHandlerWidget::VicinityHandlerWidget(QWidget *parent) :
  QWidget(parent),
  ui(new Ui::VicinityHandlerWidget)
{
  ui->setupUi(this);
}

VicinityHandlerWidget::~VicinityHandlerWidget()
{
  delete ui;
}

void VicinityHandlerWidget::on_pb_add_tag_released() {
  QMessageBox msgBox;
  msgBox.setText("Select a valid neighbor.");
  msgBox.exec();
}
