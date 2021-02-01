#ifndef ATTRIBUTE_HANDLER_WIDGET_H
#define ATTRIBUTE_HANDLER_WIDGET_H

#include <QWidget>
#include <QListWidgetItem>

#include "model/ca_model.h"

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
  void SyncUIWithModel();
  void set_m_ca_model(CAModel* model);

private:
  void LoadAttributesProperties(QListWidgetItem* curr_item);

public slots:

private slots:

  void SaveAttributeModifications();

  void on_pb_add_cell_attribute_released();

  void on_pb_delete_cell_attribute_released();

  void on_pb_add_model_attribute_released();

  void on_pb_delete_model_attribute_released();

  void on_lw_cell_attributes_itemSelectionChanged();

  void on_lw_model_attributes_itemSelectionChanged();

signals:
  void AttributeAdded(std::string id_name);
  void AttributeRemoved(std::string id_name);
  void AttributeChanged(std::string old_id_name, std::string new_id_name);
  void AttributeListChanged();

private:
  Ui::AttributeHandlerWidget *ui;
  CAModel* m_ca_model;

  // Control members
  QListWidget* m_curr_lw_attribute;
  bool m_is_loading;
};

#endif // ATTRIBUTE_HANDLER_WIDGET_H
