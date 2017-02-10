#ifndef ATTRIBUTE_HANDLER_WIDGET_H
#define ATTRIBUTE_HANDLER_WIDGET_H

#include <QWidget>

#include "../ca_modeler_manager.h"

namespace Ui {
class AttributeHandlerWidget;
}

class AttributeHandlerWidget : public QWidget
{
  Q_OBJECT

public:
  explicit AttributeHandlerWidget(QWidget *parent = 0);
  ~AttributeHandlerWidget();

  void SetupWidgets();
  void ConfigureCB();
  void ResetAttributesProperties();

  void set_m_modeler_manager(CAModelerManager* modeler_manager) {m_modeler_manager = modeler_manager;}

private:
  void LoadAttributesProperties(QListWidgetItem* curr_item);

public slots:

private slots:

  void SaveAttributeModifications();

  void on_cb_attribute_type_currentIndexChanged(const QString &arg1);

  void on_cb_list_type_currentIndexChanged(const QString &arg1);

  void on_pb_add_cell_attribute_released();

  void on_pb_delete_cell_attribute_released();

  void on_pb_add_model_attribute_released();

  void on_pb_delete_model_attribute_released();

  void on_pb_add_value_released();

  void on_pb_remove_value_released();

  void on_lw_cell_attributes_itemSelectionChanged();

  void on_lw_model_attributes_itemSelectionChanged();

signals:
  void AttributeChanged();

private:
  Ui::AttributeHandlerWidget *ui;
  CAModelerManager* m_modeler_manager;

  // Control members
  QListWidget* m_curr_lw_attribute;
  bool m_is_loading;
};

#endif // ATTRIBUTE_HANDLER_WIDGET_H
