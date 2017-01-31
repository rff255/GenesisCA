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

  void SetupWidgets();
  void PassManager();

public slots:

private slots:
  void on_act_quit_triggered();

private:
  Ui::CAModelerGUI *ui;
  CAModelerManager *m_modeler_manager;

};

#endif // CA_MODELER_GUI_H
