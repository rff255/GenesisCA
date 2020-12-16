#include "ca_modeler_gui.h"
#include "ui_ca_modeler_gui.h"
#include "attribute_handler_widget.h"
#include "vicinity_handler_widget.h"

#include "../JSON_nlohmann/json.hpp"

#include <QMessageBox>
#include <QFileDialog>
#include <QCloseEvent>
#include <QDebug>
#include <QDir>

#include <fstream>
#include <stdlib.h>

const QString kBaseWindowTitle = "GenesisCA";

using json = nlohmann::json;
CAModelerGUI::CAModelerGUI(QWidget *parent) :
  QMainWindow(parent),
  ui(new Ui::CAModelerGUI),
  m_ca_model(new CAModel()) {
    ui->setupUi(this);
    this->UpdateWindowTitle();

    // Setup widgets
    SetupWidgets();

    // Pass model reference to promoted widgets
    PassModel();

    // Connect Signals and Slots
    // Attribute change results in refresh model properties
    connect(ui->wgt_attribute_handler, SIGNAL(AttributeAdded(std::string)), ui->wgt_model_properties_handler, SLOT(AddModelAttributesInitItem(std::string)));
    connect(ui->wgt_attribute_handler, SIGNAL(AttributeRemoved(std::string)), ui->wgt_model_properties_handler, SLOT(DelModelAttributesInitItem(std::string)));
    connect(ui->wgt_attribute_handler, SIGNAL(AttributeChanged(std::string, std::string)), ui->wgt_model_properties_handler, SLOT(ChangeModelAttributesInitItem(std::string,std::string)));

    // Update GraphEditor after list of attributes change
    connect(ui->wgt_attribute_handler,      SIGNAL(AttributeListChanged()),    ui->wgt_update_rules_handler, SLOT(UpdateEditorComboBoxes()));
    connect(ui->wgt_vicinities_handler,     SIGNAL(NeighborhoodListChanged()), ui->wgt_update_rules_handler, SLOT(UpdateEditorComboBoxes()));
    connect(ui->wgt_color_mappings_handler, SIGNAL(MappingListChanged()),      ui->wgt_update_rules_handler, SLOT(UpdateEditorComboBoxes()));
}

CAModelerGUI::~CAModelerGUI() {
  delete ui;
}

void CAModelerGUI::SetupWidgets() {
  // Attributes tab
  ui->wgt_attribute_handler->ConfigureCB();

  // Model Properties tab
  ui->wgt_model_properties_handler->ConfigureCB();
}

void CAModelerGUI::PassModel() {
  ui->wgt_model_properties_handler->set_m_ca_model(m_ca_model);
  ui->wgt_attribute_handler->set_m_ca_model(m_ca_model);
  ui->wgt_vicinities_handler->set_m_ca_model(m_ca_model);
  ui->wgt_update_rules_handler->set_m_ca_model(m_ca_model);
  ui->wgt_color_mappings_handler->set_m_ca_model(m_ca_model);
}

void CAModelerGUI::closeEvent(QCloseEvent* event) {
  // TODO(figueiredo): check for unsaved changes and open dialog asking for confirmation
  QMessageBox msg_box(QMessageBox::Question, "Save Before Quit?", "Do you want to save before quit?",
                      QMessageBox::Yes | QMessageBox::No | QMessageBox::Cancel);

  msg_box.setButtonText(QMessageBox::Yes, "Save and Quit");
  msg_box.setButtonText(QMessageBox::No, "Quit");

  auto reply = msg_box.exec();
  if (reply == QMessageBox::Yes) {
    this->on_act_save_triggered();
    event->accept();
  } else if (reply == QMessageBox::No) {
    event->accept();
  } else {
    event->ignore();
  }
}

// Slots:
void CAModelerGUI::on_act_new_triggered() {
  // TODO(): Check for unsaved changes and warn of possible data loss.
  auto reply = QMessageBox::question(this, "Create New Project", "Are you sure you want to discard any unsaved changes?");
  if(reply == QMessageBox::No) return;

  // Reset ca model.
  auto old_ca_model = m_ca_model;
  m_ca_model = new CAModel();
  this->PassModel();
  delete old_ca_model;

  m_project_file_path = "";
  this->UpdateWindowTitle();
}

void CAModelerGUI::on_act_open_triggered() {
  // TODO(): Check for unsaved changes and warn of possible data loss.
  auto reply = QMessageBox::question(this, "Open Project", "Are you sure you want to discard any unsaved changes?");
  if(reply == QMessageBox::No) return;

  QFileDialog open(this, tr("Open..."), "", tr("GenesisCA Project (*.gcaproj)"));
  open.setFileMode(QFileDialog::ExistingFile);
  open.setAcceptMode(QFileDialog::AcceptOpen);

  json deserialized_data;
  if(open.exec()) {
    QString filename = open.selectedFiles().first();

    std::ifstream stream(filename.toStdString());
    if (stream.is_open()) {
      deserialized_data << stream;
      stream.close();

      // Replace current model by the deserialized one.
      auto old_ca_model = m_ca_model;
      m_ca_model = new CAModel();
      m_ca_model->InitFromSerializedData(deserialized_data);
      this->PassModel();
      delete old_ca_model;

      m_project_file_path = filename.toStdString();
      this->UpdateWindowTitle();

      QMessageBox::information(this, "Project Open", "Project successfully opened.");
    } else {
      QMessageBox::warning(this, "Unable to Open", "It was not possible to open the selected file.");
    }
  }
}

void CAModelerGUI::on_act_saveas_triggered() {
  QFileDialog save_as(this, tr("Save As..."), "", tr("GenesisCA Project (*.gcaproj)"));
  save_as.setFileMode(QFileDialog::AnyFile);
  save_as.setAcceptMode(QFileDialog::AcceptSave);
  save_as.setDefaultSuffix(".gcaproj");

  if(save_as.exec()) {
    QString filename = save_as.selectedFiles().first();

    std::ofstream stream(filename.toStdString());
    if (stream.is_open()) {
      stream << m_ca_model->GetSerializedData().dump() << std::endl;
      stream.close();

      m_project_file_path = filename.toStdString();
      this->UpdateWindowTitle();
      QMessageBox::information(this, "Project Saved", "Project successfully saved.");
    } else {
      QMessageBox::warning(this, "Unable to Save As", "It was not possible to save to the selected file/directory."
                           " Please try another name/directory.");
    }
  }
}

void CAModelerGUI::on_act_quit_triggered() {
  this->close();  // Triggers CAModelerGUI::closeEvent.
}

void CAModelerGUI::on_act_export_c_code_triggered()
{
  ExportCodeFiles();
}

void CAModelerGUI::on_act_run_triggered()
{
  // Get the "working directory" where (the party begins) files are generated and compiled
  std::string SAfolder = QApplication::applicationDirPath().toStdString() + "/StandaloneApplication/";

  // Get the "run directory" where will be created the .exe
  std::string runPath = QApplication::applicationDirPath().toStdString() + "/StandaloneApplication/runDir";
  QDir runDir(QApplication::applicationDirPath() + "/StandaloneApplication/runDir");
  if (!runDir.exists()) {
      runDir.mkpath(".");
  } else {
    // H DLL file
    std::ofstream hDllFile;
    hDllFile.open ((SAfolder + "ca_dll.h").c_str());
    hDllFile << m_ca_model->GenerateHDLLCode();
    hDllFile.close();

    // CPP DLL file
    std::ofstream cppDllFile;
    cppDllFile.open ((SAfolder + "ca_dll.cpp").c_str());
    cppDllFile << m_ca_model->GenerateCPPDLLCode();
    cppDllFile.close();
  }

  // Generate standalone application
  system(("cl /GL /O2 /Oi /I "+SAfolder+" "+SAfolder+"*.cpp glfw3dll.lib opengl32.lib "+" /link /LTCG /OPT:REF /OPT:ICF /OUT:"+SAfolder+"/StandaloneApplication.exe /incremental:no /LIBPATH:"+ SAfolder).c_str());

  // To overwrite
  if (QFile::exists((runPath +"/StandaloneApplication.exe").c_str()))
      QFile::remove((runPath +"/StandaloneApplication.exe").c_str());

  if (QFile::exists((runPath +"/glfw3.dll").c_str()))
      QFile::remove((runPath +"/glfw3.dll").c_str());

  // Get the useful files
  QFile::copy(QString((SAfolder+"StandaloneApplication.exe").c_str()), QString((runPath +"/StandaloneApplication.exe").c_str()));
  QFile::copy(QString((SAfolder+"glfw3.dll").c_str()), QString((runPath +"/glfw3.dll").c_str()));

  // Clear unnecessary files
  QFile::remove(QString((SAfolder+"StandaloneApplication.exe").c_str()));
  QFile::remove(QString((SAfolder+"StandaloneApplication.exp").c_str()));
  QFile::remove(QString((SAfolder+"StandaloneApplication.lib").c_str()));

  // Run generated standalone Application
  system((runPath +"/StandaloneApplication.exe").c_str());
}

void CAModelerGUI::on_act_generate_standalone_viewer_triggered()
{
  // Select a directory to export
  QString OutputPath = QFileDialog::getExistingDirectory (this, "Export Standalone Application Directory");
  if ( OutputPath.isNull())
  {
    QMessageBox::information(this, "Invalid Path", "Model not exported. Select a valid path.");
    return;
  }

  // Get the "working directory" where (the party begins) files are generated and compiled
  std::string SAfolder = QApplication::applicationDirPath().toStdString() + "/StandaloneApplication/";
  // H DLL file
  std::ofstream hDllFile;
  hDllFile.open ((SAfolder + "ca_dll.h").c_str());
  hDllFile << m_ca_model->GenerateHDLLCode();
  hDllFile.close();

  // CPP DLL file
  std::ofstream cppDllFile;
  cppDllFile.open ((SAfolder + "ca_dll.cpp").c_str());
  cppDllFile << m_ca_model->GenerateCPPDLLCode();
  cppDllFile.close();

  // Generate standalone application
  system(("cl /GL /O2 /Oi /I "+SAfolder+" "+SAfolder+"*.cpp glfw3dll.lib opengl32.lib "+" /link /LTCG /OPT:REF /OPT:ICF /OUT:"+SAfolder+"/StandaloneApplication.exe /incremental:no /LIBPATH:"+ SAfolder).c_str());

  // To overwrite
  if (QFile::exists((OutputPath.toStdString()+"/StandaloneApplication.exe").c_str()))
      QFile::remove((OutputPath.toStdString()+"/StandaloneApplication.exe").c_str());

  if (QFile::exists((OutputPath.toStdString()+"/glfw3.dll").c_str()))
      QFile::remove((OutputPath.toStdString()+"/glfw3.dll").c_str());

  // Get the useful files
  QFile::copy(QString((SAfolder+"StandaloneApplication.exe").c_str()), QString((OutputPath.toStdString()+"/StandaloneApplication.exe").c_str()));
  QFile::copy(QString((SAfolder+"glfw3.dll").c_str()), QString((OutputPath.toStdString()+"/glfw3.dll").c_str()));

  // Clear unnecessary files
  QFile::remove(QString((SAfolder+"StandaloneApplication.exe").c_str()));
  QFile::remove(QString((SAfolder+"StandaloneApplication.exp").c_str()));
  QFile::remove(QString((SAfolder+"StandaloneApplication.lib").c_str()));

  QMessageBox::information(this, "Standalone Application Successfully Exported!  ", "Hurray!.");
}

void CAModelerGUI::on_act_export_dll_triggered()
{
  // Select a directory to export
  QString OutputPath = QFileDialog::getExistingDirectory (this, "Export DLL Directory");
  if ( OutputPath.isNull())
  {
    QMessageBox::information(this, "Invalid Path", "DLL not exported. Select a valid path.");
    return;
  }

  // Get the "working directory" where (the party begins) files are generated and compiled
  std::string SAfolder = QApplication::applicationDirPath().toStdString() + "/StandaloneApplication/";

  // H DLL file
  std::ofstream hDllFile;
  hDllFile.open ((SAfolder + "ca_dll.h").c_str());
  hDllFile << m_ca_model->GenerateHDLLCode();
  hDllFile.close();

  // CPP DLL file
  std::ofstream cppDllFile;
  cppDllFile.open ((SAfolder + "ca_dll.cpp").c_str());
  cppDllFile << m_ca_model->GenerateCPPDLLCode();
  cppDllFile.close();

  // To overwrite
  if (QFile::exists((OutputPath.toStdString()+"/ca_dll.dll").c_str()))
      QFile::remove((OutputPath.toStdString()+"/ca_dll.dll").c_str());

  // Generate model DLL
  system(("cl /DCA_DLL "+SAfolder+"/ca_dll.cpp /LD /Fo"+OutputPath.toStdString()+"/ca_dll.dll").c_str());

  // Clear unnecessary files
  QFile::remove(QString((SAfolder + "ca_dll.h").c_str()));
  QFile::remove(QString((SAfolder + "ca_dll.cpp").c_str()));

  QMessageBox::information(this, "DLL Successfully Exported!  ", "Hurray!.");
}

void CAModelerGUI::on_act_about_genesis_triggered()
{
  QMessageBox::about(this, "About GenesisCA", "<h1>GenesisCA</h1><br>"
                     "<b>Author:</b> Rodrigo F. Figueiredo, in honor of professor Clylton.<br><br>"
                     "<b>Creation Date:</b> Winter of 2017<br><br>"
                     "<b>Description:</b> GenesisCA is an open source platform for creation and simulation of Cellular Automata (CA)."
                     " It allows the creation of rich models, with cells able to hold multiple internal attributes of different types; capability"
                     " to define multiple visualizations of the evolution; interactions with the cells during simulation; and the freedom to specify update rules"
                     " as complex as needed. All without the need to write a single line of code.<br><br>"
                     "<b>Goal:</b> Empower users from any field of expertise (or students) with the tool needed to easily manufacture sophisticated"
                     " rules and visualizations, using only their creativity and the insights gathered throughout their experiments. Ultimately the"
                     " goal is to spread the knowledge about CAs, complex systems and the amazing emergent behaviors they are capable of manifesting.<br><br>"
                     "<b>More information:</b> (and source code) <a href=\"https://www.github.com/rff255/GenesisCA\">github.com/rff255/GenesisCA</a>");
}

void CAModelerGUI::on_act_save_triggered() {
  if(m_project_file_path == "") {
    this->on_act_saveas_triggered();
  } else {
    std::ofstream stream(m_project_file_path);
    if (stream.is_open()) {
      stream << m_ca_model->GetSerializedData().dump() << std::endl;
      stream.close();

      QMessageBox::information(this, "Project Saved", "Project successfully saved.");
    } else {
      QMessageBox::warning(this, "Unable to Save", "It was not possible to save to the selected file/directory."
                           " Please try another name/directory.");
    }
  }
}


void CAModelerGUI::ExportCodeFiles() {
  // Get the "working directory" where files are compiled
  QString OutputPath = QFileDialog::getExistingDirectory (this, "Export Code Directory");
  if ( OutputPath.isNull())
  {
    QMessageBox::information(this, "Invalid Path", "Code not exported. Select a valid path.");
    return;
  }

  // Get the "working directory" where files are generated
  std::string SAfolder = QApplication::applicationDirPath().toStdString() + "/StandaloneApplication/";
  QDir dir(QApplication::applicationDirPath() + "SAfolder");
  if (!dir.exists()) {
      dir.mkpath(".");
  }

  std::string modelName = "ca_"+m_ca_model->GetModelProperties()->m_name;

  // To overwrite
  if (QFile::exists((OutputPath.toStdString()+modelName+".h").c_str()))
      QFile::remove((OutputPath.toStdString()+modelName+".h").c_str());

  if (QFile::exists((OutputPath.toStdString()+modelName+".cpp").c_str()))
      QFile::remove((OutputPath.toStdString()+modelName+".cpp").c_str());

  // H file
  std::ofstream hFile;
  hFile.open ((SAfolder + modelName +".h").c_str());
  hFile << m_ca_model->GenerateHCode();
  hFile.close();

  // CPP file
  std::ofstream cppFile;
  cppFile.open ((SAfolder + modelName +".cpp").c_str());
  cppFile << m_ca_model->GenerateCPPCode();
  cppFile.close();

  // Get the useful files
  QFile::copy(QString((SAfolder+ modelName+".h").c_str()), QString((OutputPath.toStdString()+"/"+modelName+".h").c_str()));
  QFile::copy(QString((SAfolder+ modelName+".cpp").c_str()), QString((OutputPath.toStdString()+"/"+modelName+".cpp").c_str()));

  // Clear unnecessary files
  QFile::remove(QString((SAfolder+modelName+".h").c_str()));
  QFile::remove(QString((SAfolder+modelName+".cpp").c_str()));

  QMessageBox::information(this, "Code Successfully Exported!  ", "Nothing to say.");
}

void CAModelerGUI::UpdateWindowTitle() {
  if(m_project_file_path == "") {
    this->setWindowTitle(kBaseWindowTitle + " - NEW PROJECT");
  } else {
    const QString project_path = QString::fromStdString(m_project_file_path);
    const QString project_file_name = QFileInfo(project_path).baseName();
    // TODO(): Add unsaved "*" when there are unsaved changes.
    const QString unsaved_mark = "";
    this->setWindowTitle(kBaseWindowTitle + " - "+project_file_name+" ("+project_path+ ") "+ unsaved_mark);
  }
}
