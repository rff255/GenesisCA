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

private slots:

private:
  Ui::ModelAttrInitValue *ui;
};

#endif // MODEL_ATTR_INIT_VALUE_H
