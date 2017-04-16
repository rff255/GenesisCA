#ifndef UPDATE_RULES_HANDLER_H
#define UPDATE_RULES_HANDLER_H

#include <QWidget>

namespace Ui {
class UpdateRulesHandler;
}

class UpdateRulesHandler : public QWidget
{
  Q_OBJECT

public:
  explicit UpdateRulesHandler(QWidget *parent = 0);
  ~UpdateRulesHandler();

private:
  Ui::UpdateRulesHandler *ui;
};

#endif // UPDATE_RULES_HANDLER_H
