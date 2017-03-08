#ifndef VICINITY_HANDLER_WIDGET_H
#define VICINITY_HANDLER_WIDGET_H

#include "../../ca_model/ca_model.h"
#include "../../ca_model/neighborhood.h"

#include <vector>

#include <qDebug>
#include <QWidget>
#include <QListWidgetItem>

namespace Ui {
class VicinityHandlerWidget;
}

class VicinityHandlerWidget : public QWidget
{
  Q_OBJECT

public:
  explicit VicinityHandlerWidget(QWidget *parent = 0);
  ~VicinityHandlerWidget();
  void SetupNeighborLayout();
  void ResetNeighborhood();
  void LoadNeighborhood(QListWidgetItem* curr_item);

  void set_m_ca_model(CAModel* model) {m_ca_model = model;}

private slots:
  void SaveNeighborhoodModification();
  std::vector<std::pair<int, int>>* GetCurrentNeighborhood();

  void on_pb_add_tag_released();

  void on_pb_add_neighborhood_released();

  void on_pb_delete_neighborhood_released();

  void on_lw_neighborhoods_itemSelectionChanged();

signals:
  void LayoutChanged();

private:
  Ui::VicinityHandlerWidget *ui;
  CAModel* m_ca_model;

  static const int m_neighbors_margin_size = 7;
  bool m_is_loading;
};

#endif // VICINITY_HANDLER_WIDGET_H
