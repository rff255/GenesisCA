#include "ca_modeler_gui.h"
#include <QApplication>

int main(int argc, char *argv[])
{
    QApplication a(argc, argv);
    CAModelerGUI w;
    w.show();
    return a.exec();
}
