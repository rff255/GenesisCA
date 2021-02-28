#include "ui_ca_modeler_gui.h"

#include "ca_modeler_gui.h"
#include "AttributeHandler/attribute_handler_widget.h"
#include "VicinityHandler/vicinity_handler_widget.h"

#include "JSON_nlohmann/json.hpp"

#include <QTemporaryDir>
#include <QMessageBox>
#include <QFileDialog>
#include <QCloseEvent>
#include <QDebug>
#include <QDir>

#include <fstream>
#include <stdlib.h>

const QString kBaseWindowTitle = "GenesisCA";

namespace serialization_tags{
const std::string kCompilerPath = "compiler_path";
const std::string kCompilerPathCacheFilename = "LastCompilerUsed";
}

using json = nlohmann::json;
CAModelerGUI::CAModelerGUI(QWidget *parent) :
  QMainWindow(parent),
  ui(new Ui::CAModelerGUI),
  m_ca_model(new CAModel()) {
    ui->setupUi(this);
    this->UpdateWindowTitle();

    // Fetch last used compiler path (if any)
    string compiler_path_cache = QCoreApplication::applicationDirPath().toStdString() + "/" + serialization_tags::kCompilerPathCacheFilename;
    std::ifstream stream(compiler_path_cache);
    if (stream.is_open()) {
      json deserialized_data;
      stream >> deserialized_data;
      stream.close();

      m_compiler_file_path = deserialized_data[serialization_tags::kCompilerPath];
    }

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
      stream >> deserialized_data;
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
  QTemporaryDir out_dir;
  if (!out_dir.isValid()) {
    QMessageBox::warning(this, "Run Failed", "Unable to create temporary folder in order to run compiled CA model. Please try again.");
    return;
  }

  string output = out_dir.path().toStdString() + "/" + "StandaloneApplication.exe";
  bool successfully_exported = this->ExportStandaloneApplication(output);
  if(successfully_exported) {
    // Run generated standalone Application
    system(output.c_str());
  }
}

void CAModelerGUI::on_act_select_gcc_compiler_triggered() {
  GetSelectedCompilerPath(true);
}

void CAModelerGUI::on_act_generate_standalone_viewer_triggered()
{
  QFileDialog save_as(this, tr("Export Standalone Application..."), "");
  save_as.setFileMode(QFileDialog::AnyFile);
  save_as.setAcceptMode(QFileDialog::AcceptSave);
  save_as.setDefaultSuffix(".exe");

  if(save_as.exec()) {
    string output = save_as.selectedFiles().first().toStdString();
    bool successfully_exported = this->ExportStandaloneApplication(output);
    if(successfully_exported) {
      QMessageBox::information(this, "Standalone Application Successfully Exported!  ", "Hurray!.");
    }
  }

}

void CAModelerGUI::on_act_about_genesis_triggered()
{
  QMessageBox::about(this, "About GenesisCA", "<h1>GenesisCA</h1><br>"
                     "<b>Author:</b> Rodrigo F. Figueiredo, in honor of professor Clylton Galamba.<br><br>"
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

string CAModelerGUI::GetSelectedCompilerPath(bool force_popup) {
  if(force_popup || m_compiler_file_path == "") {
    QFileDialog open(this, tr("Select g++ compiler (usually C:/Qt/Qt[ver]/Tools/mingw[ver]/bin)"), "", tr("G++ compiler (g++.exe)"));
    open.setFileMode(QFileDialog::ExistingFile);
    open.setAcceptMode(QFileDialog::AcceptOpen);

    if(open.exec()) {
      m_compiler_file_path = open.selectedFiles().first().toStdString();
      // Save selected compiler path on file for further reference.
      string compiler_path_cache = QCoreApplication::applicationDirPath().toStdString() + "/" + serialization_tags::kCompilerPathCacheFilename;
      std::ofstream stream(compiler_path_cache);
      if (stream.is_open()) {
        json serialized_data;
        serialized_data[serialization_tags::kCompilerPath] = m_compiler_file_path;
        stream << serialized_data << std::endl;
        stream.close();
      }

      return m_compiler_file_path;
    } else {  // Canceled
      return "";
    }
  }
  return m_compiler_file_path;
}

bool CAModelerGUI::ExportStandaloneApplication(std::string output) {
  // Get the "working directory" where (the party begins) files are generated and compiled
  std::string SAfolder = QApplication::applicationDirPath().toStdString() + "/StandaloneApplication/";

  // Compile .h file from CA model.
  std::ofstream hDllFile;
  hDllFile.open ((SAfolder + "ca_dll.h").c_str());
  hDllFile << m_ca_model->GenerateHDLLCode();
  hDllFile.close();

  // Compile .cpp file from CA model.
  std::ofstream cppDllFile;
  cppDllFile.open ((SAfolder + "ca_dll.cpp").c_str());
  cppDllFile << m_ca_model->GenerateCPPDLLCode();
  cppDllFile.close();

  // Get gcc path in order to compile Cellular Automata generated code of the model.
  QString gcc_path = QString::fromStdString(GetSelectedCompilerPath(false));
  if(gcc_path != "") {
    QString output_standalone_file_path = QString::fromStdString(output);
    QString SAfolder_quote = QString::fromStdString(SAfolder);
    QString SAfolder_cpp = QString::fromStdString(SAfolder + "*.cpp");
    QString SAfolder_imgui_cpp = QString::fromStdString(SAfolder + "imgui/*.cpp");
    QString SAfolder_glfw = QString::fromStdString(SAfolder + "glfw/");

    // TODO: Fix command not working if there are whitespaces.
    // Compile binary standalone application from C++ generated files.
    QString command = gcc_path + " -o " + output_standalone_file_path + " " + SAfolder_cpp + " " + SAfolder_imgui_cpp +
                     " -I " + SAfolder_quote + " -L " + SAfolder_glfw + " -lglfw3 -lopengl32 -lgdi32 -static-libgcc -static-libstdc++ -static -lstdc++ -lwinpthread -lpthread -O2";
    qDebug() << "Compile command: " << command;
    system(command.toStdString().c_str());

    // Check if application was successfully compiled and warn user otherwise.
    if(QFile(output_standalone_file_path).exists()) {
      return true;
    } else {
      QMessageBox::warning(this, "Unable to compile", "It was not able to compile using the selected g++ compiler."
                           " Please try another option (notice that the distribution must include glfw and gdi libs).");
    }
  } else {
    return false;  // Canceled
  }

  return true;
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

  string simplified_name = m_ca_model->GetModelProperties()->m_name;
  std::replace(simplified_name.begin(), simplified_name.end(), ' ', '_');

  // To overwrite
  if (QFile::exists((OutputPath.toStdString()+simplified_name+".h").c_str()))
      QFile::remove((OutputPath.toStdString()+simplified_name+".h").c_str());

  if (QFile::exists((OutputPath.toStdString()+simplified_name+".cpp").c_str()))
      QFile::remove((OutputPath.toStdString()+simplified_name+".cpp").c_str());

  // H file
  std::ofstream hFile;
  hFile.open ((SAfolder + simplified_name +".h").c_str());
  hFile << m_ca_model->GenerateHCode(simplified_name);
  hFile.close();

  // CPP file
  std::ofstream cppFile;
  cppFile.open ((SAfolder + simplified_name +".cpp").c_str());
  cppFile << m_ca_model->GenerateCPPCode(simplified_name);
  cppFile.close();

  // Get the useful files
  QFile::copy(QString((SAfolder+ simplified_name+".h").c_str()), QString((OutputPath.toStdString()+"/"+simplified_name+".h").c_str()));
  QFile::copy(QString((SAfolder+ simplified_name+".cpp").c_str()), QString((OutputPath.toStdString()+"/"+simplified_name+".cpp").c_str()));

  // Clear unnecessary files
  QFile::remove(QString((SAfolder+simplified_name+".h").c_str()));
  QFile::remove(QString((SAfolder+simplified_name+".cpp").c_str()));

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
