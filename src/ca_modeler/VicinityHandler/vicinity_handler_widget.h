#ifndef VICINITY_HANDLER_WIDGET_H
#define VICINITY_HANDLER_WIDGET_H

#include <QWidget>

namespace Ui {
class VicinityHandlerWidget;
}

class VicinityHandlerWidget : public QWidget
{
  Q_OBJECT

public:
  explicit VicinityHandlerWidget(QWidget *parent = 0);
  ~VicinityHandlerWidget();

private slots:
  void on_pb_add_tag_released();

private:
  Ui::VicinityHandlerWidget *ui;
};

#endif // VICINITY_HANDLER_WIDGET_H
