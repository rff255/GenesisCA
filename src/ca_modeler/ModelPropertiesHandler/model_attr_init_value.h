#ifndef MODEL_ATTR_INIT_VALUE_H
#define MODEL_ATTR_INIT_VALUE_H

#include "../../ca_model/attribute.h"

#include <QWidget>

#include <string>

namespace Ui {
class ModelAttrInitValue;
}

class ModelAttrInitValue : public QWidget
{
  Q_OBJECT

public:
  explicit ModelAttrInitValue(QWidget *parent = 0);
  ~ModelAttrInitValue();

  void SetAttrName(std::string new_name);
  void SetWidgetDetails(Attribute* corresponding_attribute);

  std::string GetAttrName();
  std::string GetInitValue();

private slots:
  void EmitValueChanged();

signals:
  void InitValueChanged(std::string name_id, std::string new_value);

private:
  Ui::ModelAttrInitValue *ui;

  QWidget* m_curr_page;
};

#endif // MODEL_ATTR_INIT_VALUE_H
