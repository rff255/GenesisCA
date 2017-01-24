#include "ca_modeler.h"
#include <QApplication>

int main(int argc, char *argv[])
{
    QApplication a(argc, argv);
    CAModeler w;
    w.show();

    return a.exec();
}
