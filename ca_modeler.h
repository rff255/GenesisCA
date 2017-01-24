#ifndef CA_MODELER_H
#define CA_MODELER_H

#include <QMainWindow>

namespace Ui {
class CAModeler;
}

class CAModeler : public QMainWindow
{
    Q_OBJECT

public:
    explicit CAModeler(QWidget *parent = 0);
    ~CAModeler();

private:
    Ui::CAModeler *ui;
};

#endif // CA_MODELER_H
