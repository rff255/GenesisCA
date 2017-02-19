#ifndef BREAK_CASE_INSTANCE_H
#define BREAK_CASE_INSTANCE_H

#include <QWidget>

#include "../../ca_model/break_case.h"
#include "../../ca_model/ca_model.h"

namespace Ui {
class BreakCaseInstance;
}

class BreakCaseInstance : public QWidget {
  Q_OBJECT

public:
  explicit BreakCaseInstance(QWidget *parent = 0);
  ~BreakCaseInstance();

  void SetCAModel(CAModel* ca_model) {m_ca_model = ca_model;}

  void ConfigureCB();
  void SetBCName(std::string new_name);
  void SetStatementType(BreakCase *break_case);
  void SetupWidget(BreakCase* break_case);

  std::string GetBCName();

private slots:
  void SaveBCModifications();

  void on_cb_selected_attribute_currentIndexChanged(const QString &arg1);

private:
  Ui::BreakCaseInstance *ui;

  CAModel*    m_ca_model;
  BreakCase*  m_break_case;
  QWidget*    m_curr_page;
};

#endif // BREAK_CASE_INSTANCE_H
