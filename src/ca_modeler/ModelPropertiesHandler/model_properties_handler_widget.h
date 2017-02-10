#ifndef MODEL_PROPERTIES_HANDLER_WIDGET_H
#define MODEL_PROPERTIES_HANDLER_WIDGET_H

#include "../ca_modeler_manager.h"
#include "../../ca_model/model_properties.h"

#include <QWidget>

namespace Ui {
class ModelPropertiesHandlerWidget;
}

class ModelPropertiesHandlerWidget : public QWidget
{
  Q_OBJECT

public:
  explicit ModelPropertiesHandlerWidget(QWidget *parent = 0);
  ~ModelPropertiesHandlerWidget();

  void ConfigureCB();

  void set_m_modeler_manager(CAModelerManager* modeler_manager) {m_modeler_manager = modeler_manager;}

public slots:
  void RefreshModelAttributesInitList();

private slots:
  void SaveModelPropertiesModifications();

signals:
  void ModelPropertiesChanged();

private:
  Ui::ModelPropertiesHandlerWidget *ui;
  CAModelerManager* m_modeler_manager;

  QHash<QListWidgetItem*, Attribute*>    m_model_attributes_hash;

  // Control members
  bool m_is_loading;
};

#endif // MODEL_PROPERTIES_HANDLER_WIDGET_H
