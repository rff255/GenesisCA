#ifndef CA_MODELER_GUI_H
#define CA_MODELER_GUI_H

#include "model/ca_model.h"

#include <QMainWindow>

#include <string>

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

  protected:
   // Called whenever the application is about to close. May be ignored.
   void closeEvent(QCloseEvent* event) override;

public slots:

private slots:
  void on_act_new_triggered();
  void on_act_open_triggered();
  void on_act_saveas_triggered();
  void on_act_quit_triggered();

  void on_act_run_triggered();
  void on_act_generate_standalone_viewer_triggered();
  void on_act_export_c_code_triggered();
  void on_act_export_dll_triggered();


  void on_act_about_genesis_triggered();

  void on_act_save_triggered();

  private:
  void ExportCodeFiles();
  void UpdateWindowTitle();

  Ui::CAModelerGUI *ui;
  CAModel *m_ca_model;

  std::string m_project_file_path = "";
};

#endif // CA_MODELER_GUI_H
