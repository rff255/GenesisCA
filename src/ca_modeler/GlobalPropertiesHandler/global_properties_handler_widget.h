#ifndef GLOBAL_PROPERTIES_HANDLER_WIDGET_H
#define GLOBAL_PROPERTIES_HANDLER_WIDGET_H

#include "../ca_modeler_manager.h"

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

  void set_m_modeler_manager(CAModelerManager* modeler_manager) {m_modeler_manager = modeler_manager;}

public slots:
  void RefreshModelAttributesInitList();

private:
  Ui::GlobalPropertiesHandlerWidget *ui;
  CAModelerManager* m_modeler_manager;

  QHash<QListWidgetItem*, Attribute*>    m_model_attributes_hash;
};

#endif // GLOBAL_PROPERTIES_HANDLER_WIDGET_H
