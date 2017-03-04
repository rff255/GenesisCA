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
  void SetBreakCase(BreakCase* break_case) {m_break_case = break_case;}

  void ConfigureCB();
  std::string GetBCName() {return m_break_case->m_id_name;}
  void SetupStatementType(BreakCase *break_case);
  std::string GetStatementType();
  std::string GetStatementValue();
  void SetupWidget();

private slots:
  void SaveBCModifications();

  void on_cb_selected_attribute_currentIndexChanged(const QString &arg1);

signals:
  void BreakCaseChanged(std::string old_id_name, std::string new_id_name);

private:
  Ui::BreakCaseInstance *ui;

  CAModel*    m_ca_model;
  BreakCase*  m_break_case;
  QWidget*    m_curr_page;

  bool m_is_loading;
};

#endif // BREAK_CASE_INSTANCE_H
