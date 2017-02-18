#ifndef MODEL_PROPERTIES_HANDLER_WIDGET_H
#define MODEL_PROPERTIES_HANDLER_WIDGET_H

#include "../../ca_model/ca_model.h"
#include "../../ca_model/model_properties.h"

#include <unordered_map>
#include <string>

#include <QListWidgetItem>

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

  void set_m_ca_model(CAModel* model) {m_ca_model = model;}

public slots:
  void AddModelAttributesInitItem(std::string id_name);
  void DelModelAttributesInitItem(std::string id_name);
  void ChangeModelAttributesInitItem(std::string old_id_name, std::string new_id_name);

private slots:
  void SaveModelPropertiesModifications();
  void RefreshModelAttrInitValue(std::string id_name, std::string new_value);

  void on_pb_add_break_case_released();

signals:
  void ModelPropertiesChanged();

private:
  Ui::ModelPropertiesHandlerWidget *ui;
  CAModel* m_ca_model;

  std::unordered_map <std::string, QListWidgetItem*> m_model_attributes_hash;

  // Control members
  bool m_is_loading;
};

#endif // MODEL_PROPERTIES_HANDLER_WIDGET_H
