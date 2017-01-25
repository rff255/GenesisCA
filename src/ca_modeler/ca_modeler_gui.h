#ifndef CA_MODELER_GUI_H
#define CA_MODELER_GUI_H

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

private:
    Ui::CAModelerGUI *ui;
};

#endif // CA_MODELER_GUI_H
