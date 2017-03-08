#include "vicinity_handler_widget.h"
#include "ui_vicinity_handler_widget.h"

#include <QMessageBox>
#include <QToolButton>

VicinityHandlerWidget::VicinityHandlerWidget(QWidget *parent) :
  QWidget(parent),
  ui(new Ui::VicinityHandlerWidget),
  m_is_loading(true) {
  ui->setupUi(this);
  SetupNeighborLayout();

  // Connections
  connect(ui->txt_neighborhood_name, SIGNAL(editingFinished()), this, SLOT(SaveNeighborhoodModification()));
  connect(ui->txt_description, SIGNAL(textChanged()), this, SLOT(SaveNeighborhoodModification()));
  connect(this, SIGNAL(LayoutChanged()), this, SLOT(SaveNeighborhoodModification()));
}

VicinityHandlerWidget::~VicinityHandlerWidget() {
  delete ui;
}

void VicinityHandlerWidget::SetupNeighborLayout() {
  int span = 2*m_neighbors_margin_size + 1;

  for(int i=0; i<span; ++i) {
    for (int j=0; j<span; ++j) {
      QToolButton* btn_neighbor = new QToolButton(this);
     // btn_neighbor->setText(QString::fromStdString(std::to_string(i-neighbors_margin_size) + "," + std::to_string(j-neighbors_margin_size)));
      btn_neighbor->setCheckable(true);

      btn_neighbor->setStyleSheet(QString::fromStdString("QToolButton:hover { \
                                                         border-top: 1px solid grey; \
                                                         border-left: 1px solid grey; \
                                                         border-right: 1px solid grey; \
                                                         border-bottom: 1px solid grey; \
                                                         border-style: solid; \
                                                         border-radius: 10;}"

                                                         "QToolButton:pressed { \
                                                         border-width: 1px; \
                                                         border-top: 1px solid grey; \
                                                         border-left: 1px solid grey; \
                                                         border-right: 1px solid grey; \
                                                         border-bottom: 1px solid grey; \
                                                         border-style: solid; \
                                                         border-radius: 10;}"

                                                         "QToolButton:checked {background-color: rgb(50, 50, 150); \
                                                         border-width: 1px; \
                                                         border-top: 1px solid grey; \
                                                         border-left: 1px solid grey; \
                                                         border-right: 1px solid grey; \
                                                         border-bottom: 1px solid grey; \
                                                         border-style: solid; \
                                                         border-radius: 10;}"));

      connect(btn_neighbor, SIGNAL(toggled(bool)), this, SIGNAL(LayoutChanged()));
      ui->grid_layout->addWidget(btn_neighbor, i, j);
    }
  }

  QToolButton* central_cell = dynamic_cast<QToolButton*> (ui->grid_layout->itemAtPosition(m_neighbors_margin_size, m_neighbors_margin_size)->widget());
  central_cell->setStyleSheet(QString::fromStdString("background-color: rgb(187, 187, 187); \
                                                     border-width: 1px; \
                                                     border-top: 1px solid grey; \
                                                     border-left: 1px solid grey; \
                                                     border-right: 1px solid grey; \
                                                     border-bottom: 1px solid grey; \
                                                     border-style: solid; \
                                                     border-radius: 10;"));
                                                     central_cell->setEnabled(false);
  ResetNeighborhood();
}

void VicinityHandlerWidget::ResetNeighborhood() {
  m_is_loading = true;
  // Properties
  ui->txt_neighborhood_name->clear();
  ui->txt_description->clear();

  // Board
  int span = 2*m_neighbors_margin_size + 1;
  for(int i=0; i<span; ++i)
    for (int j=0; j<span; ++j)
      dynamic_cast<QToolButton*>(ui->grid_layout->itemAtPosition(i, j)->widget())->setChecked(false);

  m_is_loading = false;

  ui->gb_vicinity_layout->setEnabled(false);
  ui->gb_vicinity_details->setEnabled(false);
}

void VicinityHandlerWidget::LoadNeighborhood(QListWidgetItem *curr_item) {
  if(curr_item == nullptr)
    return;

  ResetNeighborhood();

  m_is_loading = true;

  // Properties
  ui->txt_neighborhood_name->setText(curr_item->text());
  ui->txt_description->setPlainText(QString::fromStdString(m_ca_model->GetNeighborhood(curr_item->text().toStdString())->m_description));

  // Board
  std::vector<std::pair<int,int>>* neighbor_coords = m_ca_model->GetNeighborhood(curr_item->text().toStdString())->m_neighbor_coords;
  if(neighbor_coords != nullptr)
    for(int i=0; i<neighbor_coords->size(); ++i)
      dynamic_cast<QToolButton*>(ui->grid_layout->itemAtPosition((*neighbor_coords)[i].first + m_neighbors_margin_size, (*neighbor_coords)[i].second + m_neighbors_margin_size)->widget())->setChecked(true);
  m_is_loading = false;

  ui->gb_vicinity_layout->setEnabled(true);
  ui->gb_vicinity_details->setEnabled(true);
}

void VicinityHandlerWidget::SaveNeighborhoodModification() {
  if(m_is_loading)
    return;

  QListWidgetItem* curr_item = ui->lw_neighborhoods->currentItem();
  if(curr_item == nullptr)
    return;

  std::vector<std::pair<int,int>>* curr_neighbor_coords = GetCurrentNeighborhood();
  Neighborhood* modified_neighborhood = new Neighborhood(ui->txt_neighborhood_name->text().toStdString(),
                                                         ui->txt_description->toPlainText().toStdString(),
                                                         curr_neighbor_coords);

  string saved_neigh_id_name = m_ca_model->ModifyNeighborhood(curr_item->text().toStdString(), modified_neighborhood);
  ui->txt_neighborhood_name->setText(QString::fromStdString(saved_neigh_id_name));

  //emit NeighborhoodChanged(curr_item->text().toStdString(), saved_neigh_id_name);

  curr_item->setText(QString::fromStdString(saved_neigh_id_name));
}

void VicinityHandlerWidget::on_pb_add_tag_released() {
  QMessageBox msgBox;
  msgBox.setText("Select a valid neighbor.");
  msgBox.exec();
}

std::vector<std::pair<int, int>>* VicinityHandlerWidget::GetCurrentNeighborhood() {
  std::vector<std::pair<int, int>>* neighbor_coords = new std::vector<std::pair<int,int>>();

  int span = 2*m_neighbors_margin_size + 1;
  for(int i=0; i<span; ++i) {
    for (int j=0; j<span; ++j) {
      if(dynamic_cast<QToolButton*>(ui->grid_layout->itemAtPosition(i, j)->widget())->isChecked())
        neighbor_coords->push_back(std::pair<int,int>(i-m_neighbors_margin_size, j-m_neighbors_margin_size));
    }
  }

  return neighbor_coords;
}

void VicinityHandlerWidget::on_pb_add_neighborhood_released() {
  std::string name_id = m_ca_model->AddNeighborhood(new Neighborhood("New neighborhood", "", nullptr));
  ui->lw_neighborhoods->addItem(QString::fromStdString(name_id));
  ui->lw_neighborhoods->setCurrentRow(ui->lw_neighborhoods->count()-1);

  //emit NeighborhoodAdded(name_id);
}

void VicinityHandlerWidget::on_pb_delete_neighborhood_released() {
  QListWidgetItem* curr_item = ui->lw_neighborhoods->currentItem();
  if(curr_item) {
    std::string id_name = curr_item->text().toStdString();
    m_ca_model->DelNeighborhood(id_name);
    delete curr_item;
    ResetNeighborhood();
    LoadNeighborhood(ui->lw_neighborhoods->currentItem());
    //emit AttributeRemoved(id_name);
  }
}

void VicinityHandlerWidget::on_lw_neighborhoods_itemSelectionChanged() {
  QListWidgetItem *curr_item = ui->lw_neighborhoods->currentItem();
  if (curr_item)
    LoadNeighborhood(curr_item);
}
