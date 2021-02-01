#ifndef COLOR_MAPPINGS_HANDLER_widget_H
#define COLOR_MAPPINGS_HANDLER_widget_H

#include <QWidget>
#include <QListWidgetItem>

#include "model/ca_model.h"

namespace Ui {
class ColorMappingsHandlerWidget;
}

class ColorMappingsHandlerWidget : public QWidget
{
  Q_OBJECT

public:
  explicit ColorMappingsHandlerWidget(QWidget *parent = 0);
  ~ColorMappingsHandlerWidget();

  void SetupWidgets();
  void ResetMappingsProperties();

  void SyncUIWithModel() ;
  void set_m_ca_model(CAModel* model);
private:
  void LoadMappingsProperties(QListWidgetItem* curr_item);

public slots:

private slots:

  void SaveMappingModifications();

  void on_pb_add_col_attr_mapping_released();

  void on_pb_del_col_attr_mapping_released();

  void on_pb_add_attr_col_mapping_released();

  void on_pb_del_attr_col_mapping_released();

  void on_lw_col_attr_mappings_itemSelectionChanged();

  void on_lw_attr_col_mappings_itemSelectionChanged();

signals:
  void MappingAdded(std::string id_name);
  void MappingRemoved(std::string id_name);
  void MappingChanged(std::string old_id_name, std::string new_id_name);
  void MappingListChanged();

private:
  Ui::ColorMappingsHandlerWidget *ui;
  CAModel* m_ca_model;

  // Control members
  QListWidget* m_curr_lw_mapping;
  bool m_is_loading;
};


#endif // COLOR_MAPPINGS_HANDLER_widget_H
