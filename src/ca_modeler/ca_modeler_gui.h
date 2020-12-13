#ifndef CA_MODELER_GUI_H
#define CA_MODELER_GUI_H

#include "../ca_model/ca_model.h"

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

  void SetupWidgets();
  void PassModel();

public slots:

private slots:
  void on_act_open_triggered();
  void on_act_saveas_triggered();
  void on_act_quit_triggered();

  void on_act_run_triggered();
  void on_act_generate_standalone_viewer_triggered();
  void on_act_export_c_code_triggered();
  void on_act_export_dll_triggered();

private:
  void ExportCodeFiles();

  Ui::CAModelerGUI *ui;
  CAModel *m_ca_model;

};

#endif // CA_MODELER_GUI_H
