#ifndef ATTRIBUTE_HANDLER_WIDGET_H
#define ATTRIBUTE_HANDLER_WIDGET_H

#include <QWidget>

namespace Ui {
class AttributeHandlerWidget;
}

class AttributeHandlerWidget : public QWidget
{
  Q_OBJECT

public:
  explicit AttributeHandlerWidget(QWidget *parent = 0);
  ~AttributeHandlerWidget();

private:
  Ui::AttributeHandlerWidget *ui;
};

#endif // ATTRIBUTE_HANDLER_WIDGET_H
