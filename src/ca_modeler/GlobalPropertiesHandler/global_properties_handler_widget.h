#ifndef GLOBAL_PROPERTIES_HANDLER_WIDGET_H
#define GLOBAL_PROPERTIES_HANDLER_WIDGET_H

#include <QWidget>

namespace Ui {
class GlobalPropertiesHandlerWidget;
}

class GlobalPropertiesHandlerWidget : public QWidget
{
  Q_OBJECT

public:
  explicit GlobalPropertiesHandlerWidget(QWidget *parent = 0);
  ~GlobalPropertiesHandlerWidget();

private:
  Ui::GlobalPropertiesHandlerWidget *ui;
};

#endif // GLOBAL_PROPERTIES_HANDLER_WIDGET_H
