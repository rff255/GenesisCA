#ifndef BREAK_CASE_INSTANCE_H
#define BREAK_CASE_INSTANCE_H

#include <QWidget>

namespace Ui {
class BreakCaseInstance;
}

class BreakCaseInstance : public QWidget
{
  Q_OBJECT

public:
  explicit BreakCaseInstance(QWidget *parent = 0);
  ~BreakCaseInstance();

private:
  Ui::BreakCaseInstance *ui;
};

#endif // BREAK_CASE_INSTANCE_H
