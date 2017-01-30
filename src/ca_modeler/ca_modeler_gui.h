#ifndef CA_MODELER_GUI_H
#define CA_MODELER_GUI_H

#include "ca_modeler_manager.h"

#include <QMainWindow>

namespace Ui {
class CAModelerGUI;
}

class CAModelerGUI : public QMainWindow
{
  Q_OBJECT

public:
  explicit CAModelerGUI(QWidget *parent = 0);
  ~CAModelerGUI();

  void LoadAttributesProperties(QListWidgetItem* curr_item);

public slots:

private slots:
  void on_act_quit_triggered();

  void on_cb_attribute_type_currentIndexChanged(const QString &arg1);

  void on_cb_list_type_currentIndexChanged(const QString &arg1);

  void on_pb_add_cell_attribute_released();

  void on_pb_delete_cell_attribute_released();

  void on_pb_atribute_save_modifications_released();

  void on_lw_cell_attributes_itemClicked(QListWidgetItem *item);

private:
  Ui::CAModelerGUI *ui;
  CAModelerManager *m_modeler_manager;
};

#endif // CA_MODELER_GUI_H
