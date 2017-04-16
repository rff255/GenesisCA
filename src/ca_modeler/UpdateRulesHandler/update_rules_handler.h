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

private slots:
  void on_pbtn_open_node_graph_editor_released();

private:
  Ui::UpdateRulesHandler *ui;
};

#endif // UPDATE_RULES_HANDLER_H
